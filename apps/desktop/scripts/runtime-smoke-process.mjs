import { spawn } from 'node:child_process'
import { terminateOwnedWindowsProcessTree } from './process-group.mjs'

/**
 * @typedef {{ code: number | null; signal: NodeJS.Signals | null }} ProcessExit
 * @typedef {{ child: import('node:child_process').ChildProcess; exit: Promise<ProcessExit> }} TerminationOptions
 */

/**
 * Run one Electron Node-mode smoke with a hard lifetime bound.
 *
 * @param {{
 *   executable: string
 *   args: readonly string[]
 *   cwd: string
 *   environment: NodeJS.ProcessEnv
 *   platform: NodeJS.Platform
 *   label: string
 *   timeoutMs: number
 *   terminateChild?: (options: TerminationOptions) => Promise<void>
 * }} options
 */
export async function runRuntimeSmokeProcess(options) {
  const child = spawn(options.executable, options.args, {
    cwd: options.cwd,
    env: options.environment,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(options.platform === 'win32' ? { windowsHide: true } : {}),
  })
  if (child.stdout === null || child.stderr === null) {
    throw new Error(`${options.label} did not create piped output streams`)
  }

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })

  /** @type {(value: ProcessExit) => void} */
  let resolveExit
  const exit = new Promise((resolve) => { resolveExit = resolve })

  return await new Promise((resolveRun, rejectRun) => {
    let settled = false
    let timingOut = false
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }

    child.once('error', (error) => finish(() => rejectRun(error)))
    child.once('exit', (code, signal) => {
      resolveExit({ code, signal })
      if (timingOut) return
      if (signal !== null) {
        finish(() => rejectRun(new Error(`${options.label} exited with signal ${signal}`)))
        return
      }
      finish(() => resolveRun({ code, stdout, stderr }))
    })

    const timer = setTimeout(() => {
      timingOut = true
      void terminateAfterTimeout({ child, exit }, options)
        .then(() => finish(() => rejectRun(new Error(
          `${options.label} did not exit within ${String(options.timeoutMs)}ms`,
        ))))
        .catch(error => finish(() => rejectRun(new AggregateError(
          [new Error(`${options.label} did not exit within ${String(options.timeoutMs)}ms`), error],
          `${options.label} timed out and cleanup failed`,
        ))))
    }, options.timeoutMs)
  })
}

/**
 * @param {TerminationOptions} termination
 * @param {{
 *   platform: NodeJS.Platform
 *   terminateChild?: (options: TerminationOptions) => Promise<void>
 * }} options
 */
async function terminateAfterTimeout(termination, options) {
  if (options.terminateChild !== undefined) {
    await options.terminateChild(termination)
    return
  }
  if (options.platform === 'win32') {
    const leaderPid = termination.child.pid
    if (leaderPid === undefined) throw new Error('Timed-out runtime smoke has no process ID')
    await terminateOwnedWindowsProcessTree({
      leaderPid,
      exit: termination.exit,
      leaderExited: () => termination.child.exitCode !== null || termination.child.signalCode !== null,
    })
    return
  }
  if (!termination.child.kill('SIGKILL')) {
    throw new Error('Timed-out runtime smoke could not be terminated')
  }
  await termination.exit
}
