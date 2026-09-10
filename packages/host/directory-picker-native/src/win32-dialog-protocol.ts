/**
 * IPC send lifecycle for the Win32 folder-dialog child process. Progress
 * notices keep the channel open; terminal outcomes disconnect only after
 * Node confirms that the message has flushed to the parent.
 */

import type { Win32DialogWorkerMessage } from './win32-dialog-worker.ts'

/** Child-process IPC operations required by the dialog protocol. */
export interface Win32DialogChannel {
  /**
   * Send one worker message.
   * @param message Protocol message to enqueue.
   * @param callback Optional notification after Node flushes the message.
   */
  send(message: Win32DialogWorkerMessage, callback?: () => void): void
  /** @returns whether the IPC channel remains connected. */
  connected(): boolean
  /** Close the IPC channel after a terminal message flushes. */
  disconnect(): void
}

/**
 * Creates the worker's protocol sender.
 * @param channel Live child-process IPC operations.
 * @returns A sender that preserves progress delivery through the terminal outcome.
 */
export function createWin32DialogPost(
  channel: Win32DialogChannel,
): (message: Win32DialogWorkerMessage) => void {
  return (message) => {
    if (message.kind === 'showing') {
      channel.send(message)
      return
    }
    channel.send(message, () => {
      if (channel.connected()) channel.disconnect()
    })
  }
}
