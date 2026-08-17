import { pathToFileURL } from 'node:url'
import { createServer } from 'node:net'
import { describe, expect, it, vi } from 'vitest'

interface ProcessGroupModule {
  terminateOwnedProcessGroup: (options: {
    processGroupId: number
    leaderPid: number
    exit: Promise<unknown>
    leaderExited: () => boolean
    signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => void
    shutdownTimeoutMs?: number
  }) => Promise<void>
  requireClosedTcpPort: (url: URL, options?: {
    timeoutMs?: number
    retryMs?: number
    connectTimeoutMs?: number
  }) => Promise<void>
  terminateOwnedWindowsProcessTree: (options: {
    leaderPid: number
    exit: Promise<unknown>
    leaderExited: () => boolean
    runTaskkill?: (
      executable: string,
      args: readonly string[],
      options: { shell: false; windowsHide: true },
    ) => Promise<{ exitCode: number; stderr: string }>
  }) => Promise<void>
}

const moduleUrl = pathToFileURL(`${import.meta.dirname}/../scripts/process-group.mjs`).href

async function loadProcessGroup(): Promise<ProcessGroupModule> {
  return await import(moduleUrl) as ProcessGroupModule
}

describe('owned process-group cleanup', () => {
  it('detects an open TCP server that never returns an HTTP response', async () => {
    const server = createServer(() => {})
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP address')
    const { requireClosedTcpPort } = await loadProcessGroup()

    try {
      await expect(requireClosedTcpPort(new URL(`http://127.0.0.1:${String(address.port)}`), {
        timeoutMs: 30,
        retryMs: 5,
        connectTimeoutMs: 10,
      })).rejects.toThrow('remains open')
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error === undefined) resolveClose()
          else rejectClose(error)
        })
      })
    }
  })

  it('does not signal an already-exited leader or mask the primary lifecycle result', async () => {
    const signalProcess = vi.fn(() => { throw new Error('must not signal') })
    const { terminateOwnedProcessGroup } = await loadProcessGroup()

    await expect(terminateOwnedProcessGroup({
      processGroupId: 41,
      leaderPid: 41,
      exit: Promise.resolve({ code: 1, signal: null }),
      leaderExited: () => true,
      signalProcess,
    })).resolves.toBeUndefined()
    expect(signalProcess).not.toHaveBeenCalled()
  })

  it('treats EPERM as a non-owned group only after the leader is gone', async () => {
    const signalProcess = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      if (pid < 0 && signal === 'SIGTERM') throw Object.assign(new Error('not owned'), { code: 'EPERM' })
      if (pid > 0 && signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    })
    const { terminateOwnedProcessGroup } = await loadProcessGroup()

    await expect(terminateOwnedProcessGroup({
      processGroupId: 42,
      leaderPid: 42,
      exit: Promise.resolve({ code: 1, signal: null }),
      leaderExited: () => false,
      signalProcess,
    })).resolves.toBeUndefined()
  })

  it('surfaces EPERM while the owned leader is still alive', async () => {
    const signalProcess = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      if (pid < 0 && signal === 'SIGTERM') throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
    })
    const { terminateOwnedProcessGroup } = await loadProcessGroup()

    await expect(terminateOwnedProcessGroup({
      processGroupId: 43,
      leaderPid: 43,
      exit: Promise.resolve({ code: null, signal: 'SIGTERM' }),
      leaderExited: () => false,
      signalProcess,
    })).rejects.toThrow('permission denied')
  })

  it('kills a surviving descendant after the signaled leader exits', async () => {
    let leaderExited = false
    let descendantAlive = true
    const signals: Array<NodeJS.Signals | 0> = []
    const signalProcess = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      if (pid > 0 && signal === 0) {
        if (leaderExited) throw Object.assign(new Error('leader gone'), { code: 'ESRCH' })
        return
      }
      if (pid !== -44) throw new Error(`unexpected pid ${String(pid)}`)
      signals.push(signal)
      if (signal === 'SIGTERM') {
        leaderExited = true
        return
      }
      if (signal === 'SIGKILL') {
        descendantAlive = false
        return
      }
      if (signal === 0 && !descendantAlive) {
        throw Object.assign(new Error('group gone'), { code: 'ESRCH' })
      }
    })
    const { terminateOwnedProcessGroup } = await loadProcessGroup()

    await terminateOwnedProcessGroup({
      processGroupId: 44,
      leaderPid: 44,
      exit: Promise.resolve({ code: 0, signal: null }),
      leaderExited: () => leaderExited,
      signalProcess,
      shutdownTimeoutMs: 0,
    })

    expect(signals).toContain('SIGKILL')
    expect(descendantAlive).toBe(false)
  })

  it('terminates the exact owned Windows process tree without a shell', async () => {
    let exited = false
    const calls: unknown[][] = []
    const { terminateOwnedWindowsProcessTree } = await loadProcessGroup()

    await terminateOwnedWindowsProcessTree({
      leaderPid: 45,
      exit: Promise.resolve().then(() => { exited = true }),
      leaderExited: () => exited,
      runTaskkill: async (...args) => {
        calls.push(args)
        return { exitCode: 0, stderr: '' }
      },
    })

    expect(calls).toEqual([[
      'taskkill.exe',
      ['/PID', '45', '/T', '/F'],
      { shell: false, windowsHide: true },
    ]])
  })

  it('surfaces taskkill failure while the owned Windows leader remains alive', async () => {
    const { terminateOwnedWindowsProcessTree } = await loadProcessGroup()

    await expect(terminateOwnedWindowsProcessTree({
      leaderPid: 46,
      exit: new Promise(() => {}),
      leaderExited: () => false,
      runTaskkill: async () => ({ exitCode: 5, stderr: 'Access is denied.' }),
    })).rejects.toThrow('taskkill.exe exited with code 5: Access is denied.')
  })

  it('does not mask a taskkill cleanup failure when the Windows leader exits during the command', async () => {
    let exited = false
    const { terminateOwnedWindowsProcessTree } = await loadProcessGroup()

    await expect(terminateOwnedWindowsProcessTree({
      leaderPid: 47,
      exit: Promise.resolve(),
      leaderExited: () => exited,
      runTaskkill: async () => {
        exited = true
        return { exitCode: 5, stderr: 'Access is denied.' }
      },
    })).rejects.toThrow('taskkill.exe exited with code 5: Access is denied.')
  })

  it('does not invoke taskkill after the owned Windows leader was already observed as exited', async () => {
    const runTaskkill = vi.fn(async () => ({ exitCode: 128, stderr: 'not found' }))
    const { terminateOwnedWindowsProcessTree } = await loadProcessGroup()

    await expect(terminateOwnedWindowsProcessTree({
      leaderPid: 48,
      exit: Promise.resolve(),
      leaderExited: () => true,
      runTaskkill,
    })).resolves.toBeUndefined()
    expect(runTaskkill).not.toHaveBeenCalled()
  })
})
