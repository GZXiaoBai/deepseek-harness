import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopLogger } from '../src/desktop-logger.ts'
import { HarnessProcessController, type HarnessProcessOptions } from '../src/harness-process.ts'

const fixturePath = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url))
const userDataDirectories: string[] = []
const processGroups: number[] = []

afterEach(async () => {
  for (const pid of processGroups.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  await Promise.all(userDataDirectories.splice(0).map(async directory => rm(directory, { force: true, recursive: true })))
})

interface ControllerSetup {
  controller: HarnessProcessController
  kills: Array<[number, NodeJS.Signals]>
  children: ChildProcess[]
}

async function createController(
  modes: string[],
  overrides: Partial<HarnessProcessOptions> = {},
): Promise<ControllerSetup> {
  const userData = await mkdtemp(join(tmpdir(), 'dsh-desktop-test-'))
  userDataDirectories.push(userData)
  const kills: Array<[number, NodeJS.Signals]> = []
  const children: ChildProcess[] = []
  let spawnCount = 0
  const spawnProcess = ((command: string, args: readonly string[], options: SpawnOptions) => {
    const mode = modes[spawnCount++]
    const child = spawn(command, [...args, '--mode', mode], options)
    children.push(child)
    if (child.pid !== undefined) processGroups.push(child.pid)
    return child
  }) as typeof spawn

  return {
    controller: new HarnessProcessController({
      executable: process.execPath,
      cliPath: fixturePath,
      cwd: process.cwd(),
      dshHome: join(userData, 'harness'),
      env: process.env,
      logger: new DesktopLogger(userData),
      shutdownTimeoutMs: 25,
      spawnProcess,
      killProcessGroup: (pid, signal) => {
        kills.push([pid, signal])
        process.kill(pid, signal)
      },
      ...overrides,
    }),
    kills,
    children,
  }
}

describe('HarnessProcessController', () => {
  it('waits for a delayed strict URL before accepting the harness as ready', async () => {
    const { controller } = await createController(['delayed-ready'])
    const startedAt = Date.now()

    await expect(controller.start()).resolves.toMatchObject({ href: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/) })
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(45)

    await controller.stop()
  })

  it('times out when the child does not emit a strict harness URL', async () => {
    const { controller, kills } = await createController(['non-matching-output'], { startupTimeoutMs: 100 })

    await expect(controller.start()).rejects.toThrow('timed out')
    expect(kills.map(([pid]) => pid).every(pid => pid < 0)).toBe(true)
  })

  it('rejects when the child exits before readiness', async () => {
    const { controller } = await createController(['early-exit'])

    await expect(controller.start()).rejects.toThrow('exited before readiness')
  })

  it('rejects and reaps the child when the health check fails', async () => {
    const { controller, children, kills } = await createController(['ignore-term'], {
      healthCheck: async () => { throw new Error('health check refused the URL') },
    })

    await expect(controller.start()).rejects.toThrow('health check refused the URL')
    expect(children[0]?.exitCode ?? children[0]?.signalCode).not.toBeNull()
    expect(kills.map(([pid]) => pid).every(pid => pid < 0)).toBe(true)
    expect(kills.map(([, signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('preserves the startup timeout when it aborts a pending health check', async () => {
    const healthCheckStarted = Promise.withResolvers<undefined>()
    const { controller } = await createController(['normal'], {
      startupTimeoutMs: 100,
      healthCheck: async (_url, signal) => {
        healthCheckStarted.resolve()
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('health check aborted')), { once: true })
        })
      },
    })

    const starting = controller.start()
    await healthCheckStarted.promise

    await expect(starting).rejects.toThrow('Harness startup timed out after 100ms')
  })

  it('does not let retry start until a failed attempt has reaped its process group', async () => {
    let healthAttempts = 0
    const { controller, children, kills } = await createController(['ignore-term', 'normal'], {
      healthCheck: async () => {
        healthAttempts += 1
        if (healthAttempts === 1) throw new Error('first readiness check failed')
      },
    })

    await expect(controller.start()).rejects.toThrow('first readiness check failed')
    expect(children[0]?.exitCode ?? children[0]?.signalCode).not.toBeNull()

    await expect(controller.start()).resolves.toMatchObject({ hostname: '127.0.0.1' })
    expect(children[1]?.pid).not.toBe(children[0]?.pid)
    expect(kills.map(([pid]) => pid).every(pid => pid < 0)).toBe(true)

    await controller.stop()
  })

  it('rejects a duplicate start while an existing child is starting', async () => {
    const { controller } = await createController(['delayed-ready'])
    const starting = controller.start()

    await expect(controller.start()).rejects.toThrow('already starting or ready')
    await controller.stop()
    await expect(starting).rejects.toThrow('stopped')
  })

  it('stops a ready process group with SIGTERM and tolerates a repeated stop', async () => {
    const { controller, kills, children } = await createController(['normal'])

    await controller.start()
    const pid = children[0]?.pid
    await controller.stop()
    await controller.stop()

    expect(kills).toEqual([[-pid!, 'SIGTERM']])
  })

  it('escalates an uncooperative process group to SIGKILL', async () => {
    const { controller, kills, children } = await createController(['ignore-term'])

    await controller.start()
    const pid = children[0]?.pid
    await controller.stop()

    expect(kills).toEqual([[-pid!, 'SIGTERM'], [-pid!, 'SIGKILL']])
  })

  it('reaps an ignoring descendant after its leader exits on SIGTERM before allowing retry', async () => {
    const { controller, kills, children } = await createController(['leader-with-ignoring-descendant', 'normal'])

    await controller.start()
    const pid = children[0]?.pid
    await controller.stop()

    expect(kills).toEqual([[-pid!, 'SIGTERM'], [-pid!, 'SIGKILL']])
    await expect(controller.start()).resolves.toMatchObject({ hostname: '127.0.0.1' })
    await controller.stop()
  })

  it('retains a live process group after a signal failure until a later stop establishes cleanup', async () => {
    let rejectSignals = true
    const { controller } = await createController(['normal', 'normal'], {
      killProcessGroup: (pid, signal) => {
        if (rejectSignals) throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
        process.kill(pid, signal)
      },
    })

    await controller.start()
    await expect(controller.stop()).rejects.toThrow('permission denied')
    await expect(controller.start()).rejects.toThrow('already starting or ready')

    rejectSignals = false
    await expect(controller.stop()).resolves.toBeUndefined()
  })

  it('contains logger failures while starting, stopping, and reporting an unexpected exit', async () => {
    const throwingLogger = { log: () => { throw new Error('disk unavailable') } } as DesktopLogger
    const { controller, children } = await createController(['normal', 'exit-later'], { logger: throwingLogger })
    const exit = Promise.withResolvers<Error>()
    controller.onUnexpectedExit(error => exit.resolve(error))

    await expect(controller.start()).resolves.toMatchObject({ hostname: '127.0.0.1' })
    await expect(controller.stop()).resolves.toBeUndefined()
    expect(children[0]?.exitCode ?? children[0]?.signalCode).not.toBeNull()

    await expect(controller.start()).resolves.toMatchObject({ hostname: '127.0.0.1' })
    await expect(exit.promise).resolves.toMatchObject({ message: expect.stringContaining('exited unexpectedly') })
  })

  it('reports an unexpected runtime exit after readiness', async () => {
    const { controller } = await createController(['exit-later'])
    const exit = Promise.withResolvers<Error>()
    controller.onUnexpectedExit(error => exit.resolve(error))

    await controller.start()

    await expect(exit.promise).resolves.toMatchObject({ message: expect.stringContaining('exited unexpectedly') })
  })

  it('writes line-delimited safe child output metadata to the desktop log', async () => {
    const { controller } = await createController(['non-matching-output'], { startupTimeoutMs: 100 })

    await expect(controller.start()).rejects.toThrow('timed out')
    const entries = (await readFile(join(userDataDirectories[0]!, 'Logs', 'desktop.log'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { event: string; text?: string })

    expect(entries).toContainEqual(expect.objectContaining({
      event: 'harness-output',
      text: 'Listening on a different format',
    }))
  })
})
