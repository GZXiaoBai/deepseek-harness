import type { Readable, Writable } from 'node:stream'
import {
  parseDesktopSidecarCommand,
  serializeDesktopSidecarEvent,
  type DesktopSidecarEvent,
} from './sidecar-protocol.ts'

interface PendingDirectoryPicker {
  resolve: (path: string | null) => void
  reject: (error: Error) => void
  signal: AbortSignal
  onAbort: () => void
}

/** Streams and lifecycle operation owned by a desktop sidecar process. */
export interface DesktopSidecarChannelOptions {
  input: Readable
  output: Writable
  dispose: () => Promise<void>
  now?: () => number
}

/**
 * Owns framed native-shell commands and sidecar events over process stdio.
 * Ordinary plugin output may share stdout because every control frame carries
 * the exact protocol prefix.
 */
export class DesktopSidecarChannel {
  readonly #input: Readable
  readonly #output: Writable
  readonly #dispose: () => Promise<void>
  readonly #now: () => number
  readonly #startedAt: number
  readonly #pendingPickers = new Map<string, PendingDirectoryPicker>()
  readonly #stopped = Promise.withResolvers<void>()
  #nextPickerId = 1
  #buffer = ''
  #started = false
  #shutdown: Promise<void> | undefined
  readonly #onData = (chunk: string): void => { this.#acceptChunk(chunk) }
  readonly #onEnd = (): void => {
    this.#rejectPending(new Error('native shell command channel closed'))
    void this.#beginShutdown()
  }
  readonly #onError = (error: unknown): void => {
    this.#rejectPending(asError(error, 'native shell command channel failed'))
    void this.#beginShutdown()
  }

  /** Resolves after the application tree is disposed and `stopped` is emitted. */
  readonly stopped = this.#stopped.promise

  /**
   * Creates one protocol channel around the sidecar's owned stdio streams.
   *
   * @param options Command input, event output, and whole-tree disposer.
   */
  constructor(options: DesktopSidecarChannelOptions) {
    this.#input = options.input
    this.#output = options.output
    this.#dispose = () => options.dispose()
    this.#now = options.now ?? (() => Date.now())
    this.#startedAt = this.#now()
  }

  /** Installs the stdin line reader once. */
  start(): void {
    if (this.#started) return
    this.#started = true
    this.#input.setEncoding('utf8')
    this.#input.on('data', this.#onData)
    this.#input.once('end', this.#onEnd)
    this.#input.once('error', this.#onError)
  }

  /** Releases the owned input stream after the sidecar lifecycle settles. */
  close(): void {
    if (!this.#started) return
    this.#started = false
    this.#input.off('data', this.#onData)
    this.#input.off('end', this.#onEnd)
    this.#input.off('error', this.#onError)
    this.#input.pause()
  }

  /**
   * Requests one native directory chooser from the Tauri parent process.
   *
   * @param title Optional native dialog title.
   * @param signal Caller lifetime; abort removes the corresponding pending request.
   * @returns The selected absolute path, or `null` when the operator cancels.
   */
  pickDirectory(title: string | undefined, signal: AbortSignal): Promise<string | null> {
    if (signal.aborted) return Promise.reject(asError(signal.reason, 'directory picker aborted'))
    if (this.#shutdown !== undefined) return Promise.reject(new Error('desktop sidecar is shutting down'))

    const requestId = `picker-${this.#nextPickerId++}`
    const result = Promise.withResolvers<string | null>()
    const pending: PendingDirectoryPicker = {
      resolve: result.resolve,
      reject: result.reject,
      signal,
      onAbort: () => {
        if (!this.#pendingPickers.delete(requestId)) return
        result.reject(asError(signal.reason, 'directory picker aborted'))
      },
    }
    this.#pendingPickers.set(requestId, pending)
    signal.addEventListener('abort', pending.onAbort, { once: true })
    this.emit({
      type: 'directory-picker-request',
      requestId,
      ...(title === undefined ? {} : { title }),
    })
    return result.promise
  }

  /**
   * Writes one versioned event to the native parent.
   *
   * @param event Validated protocol event.
   */
  emit(event: DesktopSidecarEvent): void {
    this.#output.write(serializeDesktopSidecarEvent(event))
  }

  #acceptChunk(chunk: string): void {
    this.#buffer += chunk
    for (let newline = this.#buffer.indexOf('\n'); newline !== -1; newline = this.#buffer.indexOf('\n')) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, '')
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line === '') continue
      try {
        this.#acceptLine(line)
      } catch (error) {
        void this.fail(asError(error, 'invalid native shell command'))
      }
    }
  }

  #acceptLine(line: string): void {
    const command = parseDesktopSidecarCommand(line)
    switch (command.type) {
      case 'shutdown':
        void this.#beginShutdown()
        return
      case 'directory-picker-result': {
        const pending = this.#pendingPickers.get(command.requestId)
        if (pending === undefined) {
          throw new Error(`directory picker result has no pending request: ${command.requestId}`)
        }
        this.#pendingPickers.delete(command.requestId)
        pending.signal.removeEventListener('abort', pending.onAbort)
        pending.resolve(command.path)
      }
    }
  }

  #beginShutdown(): Promise<void> {
    this.#shutdown ??= (async () => {
      this.#rejectPending(new Error('desktop sidecar is shutting down'))
      this.emit({ type: 'phase', phase: 'shutdown-started', elapsedMs: this.#elapsedMs() })
      await this.#dispose()
      this.emit({ type: 'stopped' })
      this.#stopped.resolve()
    })().catch((error: unknown) => {
      const failure = asError(error, 'desktop sidecar shutdown failed')
      this.#stopped.reject(failure)
      throw failure
    })
    void this.#shutdown.catch(() => {})
    return this.#shutdown
  }

  /**
   * Reports an unrecoverable sidecar failure and completes bounded teardown.
   *
   * @param error Root failure retained for the native shell and desktop log.
   */
  async fail(error: Error): Promise<void> {
    this.emit({ type: 'fatal', message: error.message })
    await this.#beginShutdown()
  }

  #rejectPending(error: Error): void {
    for (const [requestId, pending] of this.#pendingPickers) {
      this.#pendingPickers.delete(requestId)
      pending.signal.removeEventListener('abort', pending.onAbort)
      pending.reject(error)
    }
  }

  #elapsedMs(): number {
    return Math.max(0, this.#now() - this.#startedAt)
  }
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback)
}
