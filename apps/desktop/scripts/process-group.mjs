const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000

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
    if (!signalOwnedGroup(options, signalProcess, 'SIGKILL')) {
      await options.exit
      return
    }
    while (!await waitForOwnedGroupExit(options, signalProcess, shutdownTimeoutMs)) {
      if (!signalOwnedGroup(options, signalProcess, 'SIGKILL')) break
    }
  }
  await options.exit
}

/** @param {TerminationOptions} options @param {(pid: number, signal: NodeJS.Signals | 0) => void} signalProcess @param {NodeJS.Signals} signal */
function signalOwnedGroup(options, signalProcess, signal) {
  try {
    signalProcess(-options.processGroupId, signal)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM' && !isLeaderAlive(options, signalProcess)) return false
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
  if (options.leaderExited()) return false
  try {
    signalProcess(-options.processGroupId, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM' && !isLeaderAlive(options, signalProcess)) return false
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
