import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { DesktopLogSink } from './desktop-logger.ts'
import { resolveDesktopTarget, type DesktopTarget } from './desktop-target.ts'
import { parseHarnessUrl } from './harness-url.ts'

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const WINDOWS_DEFAULT_STARTUP_TIMEOUT_MS = 60_000
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 10_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000

/**
 * Resolves the default backend startup deadline for one native Desktop target.
 *
 * Windows first launches pay Defender and filesystem-warmup costs that can
 * exceed the macOS deadline before the Web server emits its URL line.
 *
 * @param target Native Desktop target being launched.
 * @returns Default startup timeout in milliseconds.
 */
export function defaultHarnessStartupTimeout(target: DesktopTarget): number {
  return target.platform === 'win32' ? WINDOWS_DEFAULT_STARTUP_TIMEOUT_MS : DEFAULT_STARTUP_TIMEOUT_MS
}

/** Child-process operation used by the controller's fixed argument form. */
export type HarnessProcessSpawner = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

/** Shell-free taskkill command operation used by Windows process-tree cleanup. */
export type WindowsTaskkillRunner = (
  executable: string,
  args: readonly string[],
  options: Readonly<{ shell: false; windowsHide: true }>,
) => Promise<Readonly<{ exitCode: number; stderr: string }>>

/** Terminates one Windows process id and every descendant owned beneath it. */
export type WindowsProcessTreeTerminator = (pid: number) => Promise<void>

/** Dependencies and paths required to run the bundled Harness web server. */
export interface HarnessProcessOptions {
  target: DesktopTarget
  executable: string
  cliPath: string
  dshHome: string
  cwd: string
  env: NodeJS.ProcessEnv
  startupTimeoutMs?: number
  healthCheckTimeoutMs?: number
  shutdownTimeoutMs?: number
  spawnProcess?: HarnessProcessSpawner
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void
  terminateWindowsProcessTree?: WindowsProcessTreeTerminator
  healthCheck?: (url: URL, signal: AbortSignal) => Promise<void>
  logger: DesktopLogSink
}

export { resolveDesktopTarget }

/**
 * Runs taskkill against one owned Windows process tree without a command shell.
 *
 * @param pid Positive root process id returned by the owned child spawn.
 * @param runCommand Injectable command boundary used by focused tests.
 */
export async function terminateWindowsProcessTree(
  pid: number,
  runCommand: WindowsTaskkillRunner = runTaskkillCommand,
): Promise<void> {
  const result = await runCommand(
    'taskkill.exe',
    ['/PID', String(pid), '/T', '/F'],
    { shell: false, windowsHide: true },
  )
  if (result.exitCode === 0) return

  const detail = result.stderr.trim()
  throw new Error(`taskkill.exe exited with code ${result.exitCode}${detail === '' ? '' : `: ${detail}`}`)
}

/**
 * Builds the fixed Harness Web argv, exposing Node internals only for Electron's Node mode.
 *
 * @param cliPath Harness CLI entry path.
 * @param environment Backend child environment.
 * @returns Backend-only process arguments.
 */
export function buildHarnessBackendArgs(cliPath: string, environment: NodeJS.ProcessEnv): string[] {
  const args = [cliPath, 'web', '--host', '127.0.0.1', '--port', '0']
  return environment.ELECTRON_RUN_AS_NODE === '1' ? ['--expose-internals', ...args] : args
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
  readonly #options: Required<Pick<HarnessProcessOptions, 'startupTimeoutMs' | 'healthCheckTimeoutMs' | 'shutdownTimeoutMs'>> & HarnessProcessOptions
  readonly #spawnProcess: HarnessProcessSpawner
  readonly #killProcessGroup: (pid: number, signal: NodeJS.Signals) => void
  readonly #terminateWindowsProcessTree: WindowsProcessTreeTerminator
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
      startupTimeoutMs: options.startupTimeoutMs ?? defaultHarnessStartupTimeout(options.target),
      healthCheckTimeoutMs: options.healthCheckTimeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    }
    this.#spawnProcess = options.spawnProcess ?? spawn
    this.#killProcessGroup = options.killProcessGroup ?? ((pid, signal) => process.kill(pid, signal))
    this.#terminateWindowsProcessTree = options.terminateWindowsProcessTree ?? terminateWindowsProcessTree
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

    const args = buildHarnessBackendArgs(this.#options.cliPath, this.#options.env)
    let child: ChildProcess
    try {
      const windowsTarget = this.#options.target.platform === 'win32'
      child = this.#spawnProcess(this.#options.executable, args, {
        cwd: this.#options.cwd,
        detached: !windowsTarget,
        env: { ...this.#options.env, DSH_HOME: this.#options.dshHome },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(windowsTarget ? { windowsHide: true } : {}),
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
    this.#log('harness-starting', { pid: child.pid ?? null })

    child.once('error', (error) => {
      this.#failStart(run, asError(error, 'Unable to start Harness process'))
    })
    child.once('exit', (code, signal) => {
      this.#handleExit(run, code, signal)
    })
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

    // The startup deadline bounds how long the child may take to emit its URL.
    // Once the URL exists the health request gets a separate deadline, so a
    // child that becomes ready just before the startup limit is not aborted.
    clearTimeout(run.startupTimer)
    run.healthCheckStarted = true
    run.startupTimer = setTimeout(() => {
      this.#failStart(run, new Error(`Harness health check timed out after ${this.#options.healthCheckTimeoutMs}ms`))
    }, this.#options.healthCheckTimeoutMs)
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
    if (this.#options.target.platform === 'win32') {
      await this.#terminateWindows(run)
      return
    }

    if (!this.#isProcessGroupAlive(run)) return

    this.#signalGroup(run, 'SIGTERM')
    if (await this.#waitForProcessGroupExit(run, this.#options.shutdownTimeoutMs)) return

    this.#signalGroup(run, 'SIGKILL')
    while (!await this.#waitForProcessGroupExit(run, this.#options.shutdownTimeoutMs)) {
      this.#signalGroup(run, 'SIGKILL')
    }
  }

  async #terminateWindows(run: RunningHarness): Promise<void> {
    const { pid } = run.child
    if (pid === undefined || !this.#isChildAlive(run)) return

    await this.#terminateWindowsProcessTree(pid)

    const deadline = Date.now() + this.#options.shutdownTimeoutMs
    while (this.#isChildAlive(run)) {
      if (Date.now() >= deadline) {
        throw new Error(`Windows Harness process tree did not exit after ${this.#options.shutdownTimeoutMs}ms`)
      }
      await delay(5)
    }
  }

  #isChildAlive(run: RunningHarness): boolean {
    return run.child.exitCode === null && run.child.signalCode === null
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

async function runTaskkillCommand(
  executable: string,
  args: readonly string[],
  options: Readonly<{ shell: false; windowsHide: true }>,
): Promise<Readonly<{ exitCode: number; stderr: string }>> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      ...options,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      resolve({ exitCode: code ?? 1, stderr })
    })
  })
}
