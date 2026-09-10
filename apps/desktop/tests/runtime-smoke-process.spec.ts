import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

interface RuntimeSmokeProcessModule {
  runRuntimeSmokeProcess: (options: {
    executable: string
    args: readonly string[]
    cwd: string
    environment: NodeJS.ProcessEnv
    platform: NodeJS.Platform
    label: string
    timeoutMs: number
    terminateChild?: (options: {
      child: import('node:child_process').ChildProcess
      exit: Promise<unknown>
    }) => Promise<void>
  }) => Promise<{ code: number | null; stdout: string; stderr: string }>
}

const moduleUrl = pathToFileURL(`${import.meta.dirname}/../scripts/runtime-smoke-process.mjs`).href

async function loadRuntimeSmokeProcess(): Promise<RuntimeSmokeProcessModule> {
  return await import(moduleUrl) as RuntimeSmokeProcessModule
}

describe('runtime smoke child process', () => {
  it('captures a successful bounded smoke process', async () => {
    const { runRuntimeSmokeProcess } = await loadRuntimeSmokeProcess()

    await expect(runRuntimeSmokeProcess({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("runtime-smoke-ok")'],
      cwd: import.meta.dirname,
      environment: process.env,
      platform: process.platform,
      label: 'test runtime smoke',
      timeoutMs: 1_000,
    })).resolves.toMatchObject({ code: 0, stdout: 'runtime-smoke-ok', stderr: '' })
  })

  it('terminates and identifies a smoke process that does not exit', async () => {
    const { runRuntimeSmokeProcess } = await loadRuntimeSmokeProcess()
    const terminateChild = vi.fn(async ({ child, exit }: {
      child: import('node:child_process').ChildProcess
      exit: Promise<unknown>
    }) => {
      child.kill('SIGKILL')
      await exit
    })

    await expect(runRuntimeSmokeProcess({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1_000)'],
      cwd: import.meta.dirname,
      environment: process.env,
      platform: process.platform,
      label: 'stuck native smoke',
      timeoutMs: 50,
      terminateChild,
    })).rejects.toThrow('stuck native smoke did not exit within 50ms')
    expect(terminateChild).toHaveBeenCalledOnce()
  })
})
