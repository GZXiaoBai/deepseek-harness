import { spawn, type ChildProcess } from 'node:child_process'
import { DesktopLogger } from './desktop-logger.ts'
import { parseHarnessUrl } from './harness-url.ts'

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000

/** Dependencies and paths required to run the bundled Harness web server. */
export interface HarnessProcessOptions {
  executable: string
  cliPath: string
  dshHome: string
  cwd: string
  env: NodeJS.ProcessEnv
  startupTimeoutMs?: number
  shutdownTimeoutMs?: number
  spawnProcess?: typeof spawn
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void
  healthCheck?: (url: URL, signal: AbortSignal) => Promise<void>
  logger: DesktopLogger
}

type HarnessProcessState = 'idle' | 'starting' | 'ready' | 'stopping'

interface RunningHarness {
  child: ChildProcess
  start: Promise<URL>
  resolveStart: (url: URL) => void
  rejectStart: (error: Error) => void
  abortController: AbortController
  expectedStop: boolean
  healthCheckStarted: boolean
  startSettled: boolean
  startupTimer: ReturnType<typeof setTimeout> | undefined
  stop: Promise<void> | undefined
  startFailure: Error | undefined
}

/**
 * Starts and reaps the detached local Harness process owned by the desktop app.
 *
 * The controller only signals the negative process-group id created for its own
 * detached child, and does not manage children inherited from another controller.
 */
export class HarnessProcessController {
  readonly #options: Required<Pick<HarnessProcessOptions, 'startupTimeoutMs' | 'shutdownTimeoutMs'>> & HarnessProcessOptions
  readonly #spawnProcess: typeof spawn
  readonly #killProcessGroup: (pid: number, signal: NodeJS.Signals) => void
  readonly #healthCheck: (url: URL, signal: AbortSignal) => Promise<void>
  readonly #unexpectedExitListeners = new Set<(error: Error) => void>()
  #state: HarnessProcessState = 'idle'
  #current: RunningHarness | undefined

  /**
   * Creates a controller with injectable operating-system and HTTP operations.
   *
   * @param options Process paths, environment, and lifecycle dependencies.
   */
  constructor(options: HarnessProcessOptions) {
    this.#options = {
      ...options,
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    }
    this.#spawnProcess = options.spawnProcess ?? spawn
    this.#killProcessGroup = options.killProcessGroup ?? ((pid, signal) => process.kill(pid, signal))
    this.#healthCheck = options.healthCheck ?? checkHarnessHealth
  }

  /**
   * Starts the Harness child and resolves only after its loopback server answers a health request.
   *
   * @returns The verified local Harness URL.
   */
  start(): Promise<URL> {
    if (this.#state !== 'idle') {
      return Promise.reject(new Error('Harness process is already starting or ready'))
    }

    const args = [this.#options.cliPath, 'web', '--host', '127.0.0.1', '--port', '0']
    let child: ChildProcess
    try {
      child = this.#spawnProcess(this.#options.executable, args, {
        cwd: this.#options.cwd,
        detached: true,
        env: { ...this.#options.env, DSH_HOME: this.#options.dshHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      return Promise.reject(asError(error, 'Unable to start Harness process'))
    }

    const starting = Promise.withResolvers<URL>()
    const run: RunningHarness = {
      child,
      start: starting.promise,
      resolveStart: starting.resolve,
      rejectStart: starting.reject,
      abortController: new AbortController(),
      expectedStop: false,
      healthCheckStarted: false,
      startSettled: false,
      startupTimer: undefined,
      stop: undefined,
      startFailure: undefined,
    }
    this.#current = run
    this.#state = 'starting'
    this.#log('harness-starting')

    child.once('error', error => this.#failStart(run, asError(error, 'Unable to start Harness process')))
    child.once('exit', (code, signal) => this.#handleExit(run, code, signal))
    this.#readLines(run, 'stdout', child.stdout)
    this.#readLines(run, 'stderr', child.stderr)
    run.startupTimer = setTimeout(() => {
      this.#failStart(run, new Error(`Harness startup timed out after ${this.#options.startupTimeoutMs}ms`))
    }, this.#options.startupTimeoutMs)

    return run.start
  }

  /**
   * Reaps the currently owned process group, if one exists.
   *
   * @returns A promise that resolves once the owned process group has disappeared.
   */
  stop(): Promise<void> {
    if (this.#current === undefined) return Promise.resolve()

    if (this.#state === 'starting') {
      this.#failStart(this.#current, new Error('Harness startup was stopped'))
    } else {
      this.#beginStop(this.#current)
    }

    return this.#current.stop ?? Promise.resolve()
  }

  /**
   * Subscribes to failures after a previously ready Harness exits.
   *
   * @param listener Callback invoked for an unexpected owned-process exit.
   * @returns A function that removes the listener.
   */
  onUnexpectedExit(listener: (error: Error) => void): () => void {
    this.#unexpectedExitListeners.add(listener)
    return () => this.#unexpectedExitListeners.delete(listener)
  }

  #readLines(run: RunningHarness, stream: 'stdout' | 'stderr', output: NodeJS.ReadableStream | null): void {
    if (output === null) return

    let buffered = ''
    output.setEncoding('utf8')
    output.on('data', (chunk: string) => {
      buffered += chunk
      let newline = buffered.indexOf('\n')
      while (newline !== -1) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        this.#handleOutputLine(run, stream, line)
        newline = buffered.indexOf('\n')
      }
    })
  }

  #handleOutputLine(run: RunningHarness, stream: 'stdout' | 'stderr', line: string): void {
    this.#log('harness-output', { stream, text: line })
    if (stream !== 'stdout' || this.#current !== run || this.#state !== 'starting' || run.healthCheckStarted) return

    const url = parseHarnessUrl(line)
    if (url === undefined) return

    run.healthCheckStarted = true
    void this.#checkReadiness(run, url)
  }

  async #checkReadiness(run: RunningHarness, url: URL): Promise<void> {
    try {
      await this.#healthCheck(url, run.abortController.signal)
    } catch (error) {
      this.#failStart(run, asError(error, 'Harness health check failed'))
      return
    }

    if (this.#current !== run || this.#state !== 'starting') return

    this.#settleStart(run, url)
    this.#state = 'ready'
    this.#log('harness-ready', { url: url.href })
  }

  #handleExit(run: RunningHarness, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#current !== run || run.expectedStop) return

    const error = new Error(describeExit('Harness process exited before readiness', code, signal))
    if (this.#state === 'starting') {
      this.#failStart(run, error)
      return
    }

    if (this.#state === 'ready') {
      this.#log('harness-unexpected-exit', { code, signal })
      this.#notifyUnexpectedExit(new Error(describeExit('Harness process exited unexpectedly', code, signal)))
      this.#beginStop(run)
    }
  }

  #failStart(run: RunningHarness, error: Error): void {
    if (this.#current !== run || run.startSettled) return

    run.startFailure ??= error
    this.#log('harness-start-failed', { message: error.message })
    this.#beginStop(run)
  }

  #beginStop(run: RunningHarness): void {
    if (run.stop !== undefined) return

    run.expectedStop = true
    this.#state = 'stopping'
    clearTimeout(run.startupTimer)
    run.abortController.abort()
    this.#log('harness-stopping')
    const stop = this.#terminate(run).then(
      () => {
        if (this.#current === run) {
          this.#current = undefined
          this.#state = 'idle'
        }
        if (run.startFailure !== undefined) this.#settleStart(run, run.startFailure)
        this.#log('harness-stopped')
      },
      (error: unknown) => {
        const stopError = asError(error, 'Unable to stop Harness process')
        if (run.startFailure !== undefined) this.#settleStart(run, run.startFailure)
        this.#log('harness-stop-failed', { message: stopError.message })
        run.stop = undefined
        throw stopError
      },
    )
    run.stop = stop
    void stop.catch(() => {})
  }

  async #terminate(run: RunningHarness): Promise<void> {
    if (!this.#isProcessGroupAlive(run)) return

    this.#signalGroup(run, 'SIGTERM')
    if (await this.#waitForProcessGroupExit(run, this.#options.shutdownTimeoutMs)) return

    this.#signalGroup(run, 'SIGKILL')
    while (!await this.#waitForProcessGroupExit(run, this.#options.shutdownTimeoutMs)) {
      this.#signalGroup(run, 'SIGKILL')
    }
  }

  #signalGroup(run: RunningHarness, signal: NodeJS.Signals): void {
    const { pid } = run.child
    if (pid === undefined) return

    try {
      this.#killProcessGroup(-pid, signal)
      this.#log('harness-signal', { pid: -pid, signal })
    } catch (error) {
      const systemError = error as NodeJS.ErrnoException
      if (systemError.code !== 'ESRCH') throw error
    }
  }

  #isProcessGroupAlive(run: RunningHarness): boolean {
    const { pid } = run.child
    if (pid === undefined) return false

    try {
      process.kill(-pid, 0)
      return true
    } catch (error) {
      const systemError = error as NodeJS.ErrnoException
      if (systemError.code === 'ESRCH') return false
      if (systemError.code === 'EPERM') return true
      throw error
    }
  }

  async #waitForProcessGroupExit(run: RunningHarness, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.#isProcessGroupAlive(run)) {
      if (Date.now() >= deadline) return false
      await delay(5)
    }
    return true
  }

  #settleStart(run: RunningHarness, result: Error | URL): void {
    if (run.startSettled) return

    run.startSettled = true
    clearTimeout(run.startupTimer)
    if (result instanceof Error) {
      run.rejectStart(result)
    } else {
      run.resolveStart(result)
    }
  }

  #notifyUnexpectedExit(error: Error): void {
    for (const listener of this.#unexpectedExitListeners) {
      try {
        listener(error)
      } catch {
        this.#log('harness-unexpected-exit-listener-failed')
      }
    }
  }

  #log(event: string, metadata: Record<string, string | number | boolean | null> = {}): void {
    try {
      this.#options.logger.log(event, metadata)
    } catch {
      // Logging is observational and must not interrupt child-process ownership.
    }
  }
}

/**
 * Verifies that the child-reported loopback URL serves a successful HTTP response.
 *
 * @param url Strict loopback URL parsed from child stdout.
 * @param signal Cancellation signal for startup shutdown.
 */
async function checkHarnessHealth(url: URL, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`Harness health check returned HTTP ${response.status}`)
}

/**
 * Converts an unknown thrown value into a useful lifecycle error.
 *
 * @param error Unknown failure value.
 * @param fallback Message used when the value is not an Error.
 * @returns The normalized error.
 */
function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback)
}

/**
 * Formats an owned child-process exit for lifecycle consumers.
 *
 * @param prefix Human-readable lifecycle phase.
 * @param code Child process exit code.
 * @param signal Child process terminating signal.
 * @returns A concise error message for the observed termination.
 */
function describeExit(prefix: string, code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) return `${prefix} from ${signal}`
  return `${prefix} with code ${code ?? 'unknown'}`
}

/**
 * Waits for a promise only until a bounded duration elapses.
 *
 * @param promise Completion signal to await.
 * @param timeoutMs Maximum wait duration in milliseconds.
 * @returns Whether the completion signal settled before the timeout.
 */
async function delay(timeoutMs: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, timeoutMs))
}
