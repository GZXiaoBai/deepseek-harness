import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import * as harnessProcessModule from '../src/harness-process.ts'
import { DesktopLogger } from '../src/desktop-logger.ts'
import { HarnessProcessController, type HarnessProcessOptions, type HarnessProcessSpawner } from '../src/harness-process.ts'

const fixturePath = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url))
const userDataDirectories: string[] = []
const processGroups: number[] = []
const posixIt = process.platform === 'win32' ? it.skip : it
const nativeShutdownTimeoutMs = process.platform === 'win32' ? 250 : 25

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
  spawns: Array<{ executable: string; args: readonly string[]; options: import('node:child_process').SpawnOptions }>
}

async function createController(
  modes: string[],
  overrides: Partial<HarnessProcessOptions> = {},
): Promise<ControllerSetup> {
  const userData = await mkdtemp(join(tmpdir(), 'dsh-desktop-test-'))
  userDataDirectories.push(userData)
  const kills: Array<[number, NodeJS.Signals]> = []
  const children: ChildProcess[] = []
  const spawns: ControllerSetup['spawns'] = []
  let spawnCount = 0
  const spawnProcess: HarnessProcessSpawner = (command, args, options) => {
    spawns.push({ executable: command, args, options })
    const mode = modes[spawnCount++]
    if (mode === undefined) throw new Error('Expected a fixture mode for every spawned child')
    const child = spawn(command, [...args, '--mode', mode], options)
    children.push(child)
    if (child.pid !== undefined && options.detached === true) processGroups.push(child.pid)
    return child
  }

  return {
    controller: new HarnessProcessController({
      target: process.platform === 'win32'
        ? { platform: 'win32', arch: 'x64' }
        : { platform: 'darwin', arch: 'arm64' },
      executable: process.execPath,
      cliPath: fixturePath,
      cwd: process.cwd(),
      dshHome: join(userData, 'harness'),
      env: process.env,
      logger: new DesktopLogger(userData),
      shutdownTimeoutMs: nativeShutdownTimeoutMs,
      spawnProcess,
      killProcessGroup: (pid, signal) => {
        kills.push([pid, signal])
        process.kill(pid, signal)
      },
      terminateWindowsProcessTree: async (pid) => {
        process.kill(pid, 'SIGKILL')
      },
      ...overrides,
    }),
    kills,
    children,
    spawns,
  }
}

describe('HarnessProcessController', () => {
  it('accepts only the shipped macOS and Windows desktop targets', () => {
    const resolveTarget = Reflect.get(harnessProcessModule, 'resolveDesktopTarget') as
      | ((platform: string, arch: string) => { platform: string; arch: string })
      | undefined

    expect(resolveTarget).toBeTypeOf('function')
    expect(resolveTarget?.('darwin', 'arm64')).toEqual({ platform: 'darwin', arch: 'arm64' })
    expect(resolveTarget?.('win32', 'x64')).toEqual({ platform: 'win32', arch: 'x64' })
    expect(() => resolveTarget?.('darwin', 'x64')).toThrow('darwin-x64')
    expect(() => resolveTarget?.('linux', 'x64')).toThrow('linux-x64')
  })

  it('invokes taskkill shell-free for exactly the owned Windows process tree', async () => {
    const terminate = Reflect.get(harnessProcessModule, 'terminateWindowsProcessTree') as
      | ((pid: number, run: (...args: unknown[]) => Promise<{ exitCode: number; stderr: string }>) => Promise<void>)
      | undefined
    const calls: unknown[][] = []

    expect(terminate).toBeTypeOf('function')
    await terminate?.(4242, async (...args) => {
      calls.push(args)
      return { exitCode: 0, stderr: '' }
    })

    expect(calls).toEqual([[
      'taskkill.exe',
      ['/PID', '4242', '/T', '/F'],
      { shell: false, windowsHide: true },
    ]])
  })

  it('adds exposed internals only to an Electron Node-mode backend child', async () => {
    const electron = await createController(['internals-ready'], {
      executable: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })

    await expect(electron.controller.start()).resolves.toMatchObject({ hostname: '127.0.0.1' })
    expect(electron.spawns[0]).toMatchObject({
      executable: process.execPath,
      args: [
        '--expose-internals',
        fixturePath,
        'web',
        '--host',
        '127.0.0.1',
        '--port',
        '0',
      ],
    })
    await electron.controller.stop()

    const plainNode = await createController(['normal'])
    await plainNode.controller.start()
    expect(plainNode.spawns[0]?.args).toEqual([
      fixturePath,
      'web',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ])
    await plainNode.controller.stop()
  })

  it('waits for a delayed strict URL before accepting the harness as ready', async () => {
    const { controller } = await createController(['delayed-ready'])
    const startedAt = Date.now()

    const url = await controller.start()
    expect(url.href).toMatch(/^http:\/\/127\.0\.0\.1:/)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(45)

    await controller.stop()
  })

  it('records the owned backend pid for standalone lifecycle verification', async () => {
    const { controller, children } = await createController(['normal'])

    await controller.start()
    const entries = (await readFile(join(userDataDirectories[0]!, 'Logs', 'desktop.log'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { event: string; pid?: number })

    expect(entries).toContainEqual(expect.objectContaining({
      event: 'harness-starting',
      pid: children[0]?.pid,
    }))
    await controller.stop()
  })

  it('times out when the child does not emit a strict harness URL', async () => {
    const { controller, kills } = await createController(['non-matching-output'], { startupTimeoutMs: 500 })

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
    if (process.platform !== 'win32') {
      expect(kills.map(([pid]) => pid).every(pid => pid < 0)).toBe(true)
      expect(kills.map(([, signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
    }
  })

  it('preserves the startup timeout when it aborts a pending health check', async () => {
    const healthCheckStarted = Promise.withResolvers<undefined>()
    const { controller } = await createController(['normal'], {
      startupTimeoutMs: 500,
      healthCheck: async (_url, signal) => {
        healthCheckStarted.resolve(undefined)
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('health check aborted'))
          }, { once: true })
        })
      },
    })

    const starting = controller.start()
    const expectedTimeout = expect(starting).rejects.toThrow('Harness startup timed out after 500ms')
    await healthCheckStarted.promise
    await expectedTimeout
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

  posixIt('stops a ready process group with SIGTERM and tolerates a repeated stop', async () => {
    const { controller, kills, children } = await createController(['normal'])

    await controller.start()
    const pid = children[0]?.pid
    await controller.stop()
    await controller.stop()

    expect(kills).toEqual([[-pid!, 'SIGTERM']])
  })

  posixIt('escalates an uncooperative process group to SIGKILL', async () => {
    const { controller, kills, children } = await createController(['ignore-term'])

    await controller.start()
    const pid = children[0]?.pid
    await controller.stop()

    expect(kills).toEqual([[-pid!, 'SIGTERM'], [-pid!, 'SIGKILL']])
  })

  it('owns a Windows backend without a detached console and terminates its process tree', async () => {
    const terminated: number[] = []
    const { controller, children, spawns } = await createController(['normal'], {
      target: { platform: 'win32', arch: 'x64' },
      terminateWindowsProcessTree: async (pid) => {
        terminated.push(pid)
        process.kill(pid, 'SIGKILL')
      },
    })

    await controller.start()
    await controller.stop()

    expect(spawns[0]?.options).toMatchObject({
      detached: false,
      windowsHide: true,
      shell: false,
    })
    expect(terminated).toEqual([children[0]?.pid])
  })

  it('retains Windows process-tree ownership after taskkill fails', async () => {
    let rejectTermination = true
    const { controller } = await createController(['normal'], {
      target: { platform: 'win32', arch: 'x64' },
      terminateWindowsProcessTree: async (pid) => {
        if (rejectTermination) throw new Error('taskkill failed with access denied')
        process.kill(pid, 'SIGKILL')
      },
    })

    await controller.start()
    await expect(controller.stop()).rejects.toThrow('taskkill failed with access denied')
    await expect(controller.start()).rejects.toThrow('already starting or ready')

    rejectTermination = false
    await expect(controller.stop()).resolves.toBeUndefined()
  })

  it('reports Windows cleanup failure even when the root exits during taskkill', async () => {
    const { controller, children } = await createController(['normal'], {
      target: { platform: 'win32', arch: 'x64' },
      terminateWindowsProcessTree: async (pid) => {
        process.kill(pid, 'SIGKILL')
        await new Promise(resolve => setTimeout(resolve, 5))
        throw new Error('taskkill failed with access denied')
      },
    })

    await controller.start()
    const childExit = new Promise<void>((resolveExit) => {
      children[0]?.once('exit', () => { resolveExit() })
    })
    await expect(controller.stop()).rejects.toThrow('taskkill failed with access denied')
    await childExit
    await expect(controller.stop()).resolves.toBeUndefined()
  })

  posixIt('reaps an ignoring descendant after its leader exits on SIGTERM before allowing retry', async () => {
    const { controller, kills, children } = await createController(['leader-with-ignoring-descendant', 'normal'])

    await controller.start()
    const pid = children[0]?.pid
    await controller.stop()

    expect(kills).toEqual([[-pid!, 'SIGTERM'], [-pid!, 'SIGKILL']])
    await expect(controller.start()).resolves.toMatchObject({ hostname: '127.0.0.1' })
    await controller.stop()
  })

  posixIt('retains a live process group after a signal failure until a later stop establishes cleanup', async () => {
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
    const throwingLogger = { log: () => { throw new Error('disk unavailable') } }
    const { controller, children } = await createController(['normal', 'exit-later'], { logger: throwingLogger })
    const exit = Promise.withResolvers<Error>()
    controller.onUnexpectedExit((error) => {
      exit.resolve(error)
    })

    await expect(controller.start()).resolves.toMatchObject({ hostname: '127.0.0.1' })
    await expect(controller.stop()).resolves.toBeUndefined()
    expect(children[0]?.exitCode ?? children[0]?.signalCode).not.toBeNull()

    await expect(controller.start()).resolves.toMatchObject({ hostname: '127.0.0.1' })
    expect((await exit.promise).message).toContain('exited unexpectedly')
  })

  it('reports an unexpected runtime exit after readiness', async () => {
    const { controller } = await createController(['exit-later'])
    const exit = Promise.withResolvers<Error>()
    controller.onUnexpectedExit((error) => {
      exit.resolve(error)
    })

    await controller.start()

    expect((await exit.promise).message).toContain('exited unexpectedly')
  })

  it('writes line-delimited safe child output metadata to the desktop log', async () => {
    const { controller } = await createController(['non-matching-output'], { startupTimeoutMs: 500 })

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
