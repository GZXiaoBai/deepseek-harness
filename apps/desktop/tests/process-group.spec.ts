import { pathToFileURL } from 'node:url'
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
}

const moduleUrl = pathToFileURL(`${import.meta.dirname}/../scripts/process-group.mjs`).href

async function loadProcessGroup(): Promise<ProcessGroupModule> {
  return await import(moduleUrl) as ProcessGroupModule
}

describe('owned process-group cleanup', () => {
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
})
