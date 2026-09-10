import { describe, expect, it, vi } from 'vitest'
import { createWin32DialogPost } from '../src/win32-dialog-protocol.ts'
import type { Win32DialogWorkerMessage } from '../src/win32-dialog-worker.ts'

describe('Win32 dialog worker protocol', () => {
  it('keeps IPC connected after showing until the terminal result flushes', () => {
    const callbacks: Array<() => void> = []
    const messages: Win32DialogWorkerMessage[] = []
    const disconnect = vi.fn()
    const post = createWin32DialogPost({
      send: (message, callback) => {
        messages.push(message)
        if (callback !== undefined) callbacks.push(callback)
      },
      connected: () => true,
      disconnect,
    })

    post({ kind: 'showing', threadId: 42 })
    expect(messages).toEqual([{ kind: 'showing', threadId: 42 }])
    expect(callbacks).toHaveLength(0)
    expect(disconnect).not.toHaveBeenCalled()

    post({ kind: 'done', path: 'C:\\workspace' })
    expect(callbacks).toHaveLength(1)
    callbacks[0]?.()
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('disconnects after a terminal error flushes', () => {
    let callback: (() => void) | undefined
    const disconnect = vi.fn()
    const post = createWin32DialogPost({
      send: (_message, onFlushed) => { callback = onFlushed },
      connected: () => true,
      disconnect,
    })

    post({ kind: 'error', message: 'COM failed' })
    callback?.()

    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('does not disconnect again when the parent closes before a terminal flush', () => {
    let callback: (() => void) | undefined
    const disconnect = vi.fn()
    const post = createWin32DialogPost({
      send: (_message, onFlushed) => { callback = onFlushed },
      connected: () => false,
      disconnect,
    })

    post({ kind: 'done', path: null })
    callback?.()

    expect(disconnect).not.toHaveBeenCalled()
  })
})
