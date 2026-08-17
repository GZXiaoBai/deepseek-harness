import { spawn } from 'node:child_process'
import { connect } from 'node:net'

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
const DEFAULT_PORT_CLOSE_TIMEOUT_MS = 1_000
const DEFAULT_PORT_RETRY_MS = 25
const DEFAULT_CONNECT_TIMEOUT_MS = 250

/**
 * @typedef {object} TerminationOptions
 * @property {number} processGroupId Owned detached process-group id.
 * @property {number} leaderPid Owned child leader pid.
 * @property {Promise<unknown>} exit Child exit completion.
 * @property {() => boolean} leaderExited Whether Node has observed the child exit.
 * @property {(pid: number, signal: NodeJS.Signals | 0) => void} [signalProcess] Signal/probe operation.
 * @property {number} [shutdownTimeoutMs] Grace period before SIGKILL.
 */

/**
 * Terminates one owned process group without signaling a reused group after its leader exits.
 *
 * @param {TerminationOptions} options Owned process facts and injectable OS operations.
 * @returns {Promise<void>} Resolves after the child exits and its owned group is gone.
 */
export async function terminateOwnedProcessGroup(options) {
  const signalProcess = options.signalProcess ?? process.kill
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  if (options.leaderExited()) {
    await options.exit
    return
  }

  if (!signalOwnedGroup(options, signalProcess, 'SIGTERM')) {
    await options.exit
    return
  }
  if (!await waitForOwnedGroupExit(options, signalProcess, shutdownTimeoutMs)) {
    if (!signalOwnedGroup(options, signalProcess, 'SIGKILL', true)) {
      await options.exit
      return
    }
    while (!await waitForOwnedGroupExit(options, signalProcess, shutdownTimeoutMs)) {
      if (!signalOwnedGroup(options, signalProcess, 'SIGKILL', true)) break
    }
  }
  await options.exit
}

/**
 * Terminates one owned Windows process tree and waits for its leader exit.
 *
 * @param {{ leaderPid: number, exit: Promise<unknown>, leaderExited: () => boolean, runTaskkill?: typeof runTaskkill }} options Owned Windows process facts.
 * @returns {Promise<void>} Resolves after taskkill succeeds and the leader exit is observed.
 */
export async function terminateOwnedWindowsProcessTree(options) {
  if (options.leaderExited()) {
    await options.exit
    return
  }
  const result = await (options.runTaskkill ?? runTaskkill)(
    'taskkill.exe',
    ['/PID', String(options.leaderPid), '/T', '/F'],
    { shell: false, windowsHide: true },
  )
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim()
    throw new Error(`taskkill.exe exited with code ${String(result.exitCode)}${detail === '' ? '' : `: ${detail}`}`)
  }
  await options.exit
}

/**
 * Requires a loopback TCP port to refuse connections within a bounded interval.
 *
 * @param {URL} url Server URL with an explicit TCP port.
 * @param {{ timeoutMs?: number, retryMs?: number, connectTimeoutMs?: number }} [options] Probe timing.
 * @returns {Promise<void>} Resolves only after the port refuses a TCP connection.
 */
export async function requireClosedTcpPort(url, options = {}) {
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Closed-port verification requires an explicit TCP port: ${url.href}`)
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_PORT_CLOSE_TIMEOUT_MS
  const retryMs = options.retryMs ?? DEFAULT_PORT_RETRY_MS
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs

  while (await tcpPortAcceptsConnections(url.hostname, port, connectTimeoutMs)) {
    if (Date.now() >= deadline) throw new Error(`Owned Web process group stopped but its port remains open: ${url.href}`)
    await new Promise(resolveRetry => setTimeout(resolveRetry, retryMs))
  }
}

/** @param {string} host @param {number} port @param {number} timeoutMs */
async function tcpPortAcceptsConnections(host, port, timeoutMs) {
  return await new Promise((resolveProbe, rejectProbe) => {
    const socket = connect({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      rejectProbe(new Error(`TCP close probe timed out for ${host}:${String(port)}`))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolveProbe(true)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      socket.destroy()
      if (error.code === 'ECONNREFUSED') {
        resolveProbe(false)
        return
      }
      rejectProbe(error)
    })
  })
}

/** @param {string} executable @param {readonly string[]} args @param {{ shell: false, windowsHide: true }} options */
async function runTaskkill(executable, args, options) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { ...options, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', rejectRun)
    child.once('exit', code => resolveRun({ exitCode: code ?? 1, stderr }))
  })
}

/** @param {TerminationOptions} options @param {(pid: number, signal: NodeJS.Signals | 0) => void} signalProcess @param {NodeJS.Signals} signal @param {boolean} [ownershipEstablished] */
function signalOwnedGroup(options, signalProcess, signal, ownershipEstablished = false) {
  try {
    signalProcess(-options.processGroupId, signal)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM' && !ownershipEstablished && !isLeaderAlive(options, signalProcess)) return false
    throw error
  }
}

/** @param {TerminationOptions} options @param {(pid: number, signal: NodeJS.Signals | 0) => void} signalProcess @param {number} timeoutMs */
async function waitForOwnedGroupExit(options, signalProcess, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (isOwnedGroupAlive(options, signalProcess)) {
    if (Date.now() >= deadline) return false
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  return true
}

/** @param {TerminationOptions} options @param {(pid: number, signal: NodeJS.Signals | 0) => void} signalProcess */
function isOwnedGroupAlive(options, signalProcess) {
  try {
    signalProcess(-options.processGroupId, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

/** @param {TerminationOptions} options @param {(pid: number, signal: NodeJS.Signals | 0) => void} signalProcess */
function isLeaderAlive(options, signalProcess) {
  if (options.leaderExited()) return false
  try {
    signalProcess(options.leaderPid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    throw error
  }
}
