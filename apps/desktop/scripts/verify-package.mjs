import { spawn } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertRuntimeSymlinksContained, resolveCliEntryPath, resolveWebFrontendIndex } from './stage-runtime.mjs'
import { auditArm64MachO } from './macho-audit.mjs'
import { requireClosedTcpPort } from './process-group.mjs'

const PRODUCT_NAME = 'DeepSeek Harness'
const STARTUP_TIMEOUT_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 15_000
const EXPECTED_ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation',
]
const DESKTOP_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Creates the fixed artifact paths for Apple Silicon package verification.
 *
 * @param {{ desktopRoot: string, platform: NodeJS.Platform, arch: string }} input Host and Desktop paths.
 * @returns {{ appPath: string, releaseDirectory: string }} Paths to the unpacked App and release directory.
 */
export function createVerifyPlan(input) {
  if (input.platform !== 'darwin' || input.arch !== 'arm64') {
    throw new Error(`Unsupported desktop package verification target: ${input.platform}-${input.arch}; expected darwin-arm64`)
  }
  const desktopRoot = resolve(input.desktopRoot)
  const releaseDirectory = join(desktopRoot, 'release')
  return {
    appPath: join(releaseDirectory, 'mac-arm64', `${PRODUCT_NAME}.app`),
    releaseDirectory,
  }
}

/**
 * Resolves the sole DMG from a clean release directory.
 *
 * @param {string} releaseDirectory Electron Builder output directory.
 * @returns {Promise<string>} Absolute DMG path.
 */
export async function findDmg(releaseDirectory) {
  const entries = await readdir(releaseDirectory, { withFileTypes: true })
  const dmgs = entries
    .filter(entry => entry.isFile() && extname(entry.name).toLowerCase() === '.dmg')
    .map(entry => join(releaseDirectory, entry.name))
    .sort()
  if (dmgs.length !== 1) throw new Error(`Expected exactly one DMG, found ${String(dmgs.length)}`)
  return dmgs[0]
}

/**
 * Reads the latest owned backend identity and ready URL from the desktop log.
 *
 * @param {string} logPath Desktop newline-delimited JSON log.
 * @returns {Promise<{ backendPid: number, url: URL, startCount: number }>} Verified lifecycle snapshot.
 */
export async function readLifecycleSnapshot(logPath) {
  const entries = (await readFile(logPath, 'utf8'))
    .split('\n')
    .filter(line => line !== '')
    .map((line) => JSON.parse(line))
  const starts = entries.filter(entry => entry?.event === 'harness-starting')
  const lastStart = starts.at(-1)
  if (!Number.isInteger(lastStart?.pid) || lastStart.pid < 1) {
    throw new Error('Desktop log is missing a valid owned backend pid')
  }
  const ready = entries.findLast(entry => entry?.event === 'harness-ready')
  const url = parseReadyUrl(ready?.url)
  if (url === undefined) throw new Error('Desktop log is missing a strict loopback ready URL')
  return { backendPid: lastStart.pid, url, startCount: starts.length }
}

/**
 * Creates the isolated data paths exercised by a standalone packaged launch.
 *
 * @param {string} temporaryRoot Outside-repository acceptance root.
 * @returns {{ userData: string, harnessData: string, logPath: string, singletonSocket: string }} Fixed Electron and Harness paths.
 */
export function createStandaloneDataPaths(temporaryRoot) {
  const userData = join(resolve(temporaryRoot), 'user-data')
  return {
    userData,
    harnessData: join(userData, 'Harness'),
    logPath: join(userData, 'Logs/desktop.log'),
    singletonSocket: join(userData, 'SingletonSocket'),
  }
}

/** @param {unknown} rawUrl */
function parseReadyUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return undefined
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return undefined
  }
  if (
    url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
    || !validPort(url.port)
  ) return undefined
  return url
}

/** @param {string} rawPort */
function validPort(rawPort) {
  const port = Number(rawPort)
  return Number.isInteger(port) && port >= 1 && port <= 65_535
}

async function verifyPackage() {
  const plan = createVerifyPlan({ desktopRoot: DESKTOP_ROOT, platform: process.platform, arch: process.arch })
  const dmgPath = await findDmg(plan.releaseDirectory)
  await verifyAppBundle(plan.appPath)
  await verifyStandaloneLaunch(plan.appPath)
  await verifyMountedDmg(dmgPath)
  console.log(`Standalone package verification passed: ${plan.appPath}`)
  console.log(`Mounted DMG verification passed: ${dmgPath}`)
}

/** @param {string} appPath */
async function verifyAppBundle(appPath) {
  await requireDirectory(appPath, 'Packaged App bundle is missing')
  const executable = join(appPath, 'Contents/MacOS', PRODUCT_NAME)
  const resources = join(appPath, 'Contents/Resources')
  const runtime = join(resources, 'runtime')
  const infoPlist = join(appPath, 'Contents/Info.plist')
  await requireExecutable(executable)
  await requireFile(join(resources, 'app.asar'), 'Packaged Electron app.asar is missing')
  await requireDirectory(runtime, 'Packaged Harness runtime is missing')
  await resolveCliEntryPath(runtime)
  await resolveWebFrontendIndex(runtime)
  await assertRuntimeSymlinksContained(runtime)

  const plist = JSON.parse((await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', infoPlist])).stdout)
  if (plist.CFBundleIdentifier !== 'ai.deepseek.harness') throw new Error(`Unexpected bundle identifier: ${String(plist.CFBundleIdentifier)}`)
  if (plist.CFBundleExecutable !== PRODUCT_NAME) throw new Error(`Unexpected bundle executable: ${String(plist.CFBundleExecutable)}`)
  if (plist.LSMinimumSystemVersion !== '14.0') throw new Error(`Unexpected minimum macOS version: ${String(plist.LSMinimumSystemVersion)}`)

  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
  const signature = await run('/usr/bin/codesign', ['-dvvv', '--entitlements', ':-', appPath])
  const signatureText = `${signature.stdout}\n${signature.stderr}`
  if (!/Signature=adhoc/.test(signatureText) || !/flags=.*\bruntime\b/.test(signatureText)) {
    throw new Error('App signature is not ad-hoc signed with Hardened Runtime')
  }
  const actualEntitlements = [...signatureText.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map(match => match[1])
  if (JSON.stringify(actualEntitlements) !== JSON.stringify(EXPECTED_ENTITLEMENTS)) {
    throw new Error(`Unexpected App entitlements: ${JSON.stringify(actualEntitlements)}`)
  }

  const machOFiles = await auditArm64MachO(appPath)
  if (machOFiles.length === 0) throw new Error('Packaged App contains no Mach-O binaries')

  const gatekeeper = await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath], { allowFailure: true })
  if (gatekeeper.code !== 0) console.log('Gatekeeper rejected the expected ad-hoc, non-notarized personal build.')
}

/** @param {string} appPath */
async function verifyStandaloneLaunch(appPath) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-desktop-standalone-'))
  const copiedApp = join(temporaryRoot, `${PRODUCT_NAME}.app`)
  const dataPaths = createStandaloneDataPaths(temporaryRoot)
  const { userData } = dataPaths
  const isolatedHome = join(temporaryRoot, 'home')
  let primary
  let backendPid
  let readyUrl
  try {
    await mkdir(userData)
    await mkdir(isolatedHome)
    await cp(appPath, copiedApp, { recursive: true, verbatimSymlinks: true })
    const executable = join(copiedApp, 'Contents/MacOS', PRODUCT_NAME)
    const environment = isolatedEnvironment(isolatedHome)
    primary = launchApp(executable, userData, temporaryRoot, environment)
    const primaryExit = observeExit(primary)
    const initial = await waitForLifecycle(dataPaths.logPath, STARTUP_TIMEOUT_MS)
    backendPid = initial.backendPid
    readyUrl = initial.url
    requireProcessGroupAlive(backendPid)
    await requireHarnessPage(readyUrl)
    await requireSeparatedHarnessData(dataPaths)

    const second = launchApp(executable, userData, temporaryRoot, environment)
    const secondExit = await waitForExit(observeExit(second), STARTUP_TIMEOUT_MS, 'Second App instance did not hand off and exit')
    if (secondExit.code !== 0 || secondExit.signal !== null) {
      throw new Error(`Second App instance failed during handoff (${describeExit(secondExit)})`)
    }
    const afterSecond = await readLifecycleSnapshot(dataPaths.logPath)
    if (afterSecond.startCount !== initial.startCount || afterSecond.backendPid !== backendPid) {
      throw new Error('Second App instance started a replacement Harness backend')
    }
    requireProcessGroupAlive(backendPid)

    process.kill(primary.pid, 'SIGTERM')
    const primaryResult = await waitForExit(primaryExit, SHUTDOWN_TIMEOUT_MS, 'Primary App did not finish graceful shutdown')
    if (primaryResult.code !== 0 || primaryResult.signal !== null) {
      throw new Error(`Primary App did not quit cleanly (${describeExit(primaryResult)})`)
    }
    await requireProcessGroupGone(backendPid, SHUTDOWN_TIMEOUT_MS)
    await requireClosedTcpPort(readyUrl, { timeoutMs: 5_000 })
    primary = undefined
  } finally {
    await emergencyCleanup(primary, backendPid)
    if (readyUrl !== undefined) await requireClosedTcpPort(readyUrl, { timeoutMs: 5_000 })
    await rm(temporaryRoot, { recursive: true })
  }
}

/** @param {{ userData: string, harnessData: string, logPath: string, singletonSocket: string }} paths */
async function requireSeparatedHarnessData(paths) {
  await requireDirectory(paths.harnessData, 'Packaged Harness data directory is missing')
  await requireFile(join(paths.harnessData, 'profiles/web/cordis.yml'), 'Packaged Harness profile was not initialized')
  const singletonEntry = await lstat(paths.singletonSocket)
  if (!singletonEntry.isSymbolicLink()) {
    throw new Error(`Electron singleton socket is not the expected userData symlink: ${paths.singletonSocket}`)
  }
  if (contains(paths.harnessData, paths.singletonSocket)) {
    throw new Error(`Electron singleton socket overlaps the Harness data directory: ${paths.singletonSocket}`)
  }
  await requireMissing(join(paths.userData, 'profiles'), 'Harness profile data leaked into the Electron userData root')
}

/** @param {string} path @param {string} message */
async function requireMissing(path, message) {
  try {
    await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw new Error(`${message}: ${path}`)
}

/** @param {string} parent @param {string} candidate */
function contains(parent, candidate) {
  const fromParent = relative(parent, candidate)
  return fromParent === '' || (!fromParent.startsWith(`..${sep}`) && fromParent !== '..' && !isAbsolute(fromParent))
}

/** @param {string} dmgPath */
async function verifyMountedDmg(dmgPath) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-desktop-dmg-'))
  const mountPoint = join(temporaryRoot, 'mounted')
  let mounted = false
  try {
    await mkdir(mountPoint)
    await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath])
    mounted = true
    await verifyAppBundle(join(mountPoint, `${PRODUCT_NAME}.app`))
  } finally {
    if (mounted) await run('/usr/bin/hdiutil', ['detach', mountPoint])
    await rm(temporaryRoot, { recursive: true })
  }
}

/** @param {string} executable @param {string} userData @param {string} cwd @param {NodeJS.ProcessEnv} env */
function launchApp(executable, userData, cwd, env) {
  const child = spawn(executable, [`--user-data-dir=${userData}`], {
    cwd,
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (child.pid === undefined) throw new Error('Packaged App did not create an owned process group')
  child.stdout?.on('data', chunk => process.stdout.write(chunk))
  child.stderr?.on('data', chunk => process.stderr.write(chunk))
  return child
}

/** @param {string} isolatedHome */
function isolatedEnvironment(isolatedHome) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:KEY|SECRET|TOKEN|PASSWORD)/i.test(name)))
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_NO_ASAR
  return { ...environment, HOME: isolatedHome }
}

/** @param {string} logPath @param {number} timeoutMs */
async function waitForLifecycle(logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      return await readLifecycleSnapshot(logPath)
    } catch (error) {
      lastError = error
      await delay(50)
    }
  }
  throw new Error(`Packaged App did not become ready within ${String(timeoutMs)}ms: ${errorMessage(lastError)}`)
}

/** @param {URL} url */
async function requireHarnessPage(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS) })
  if (response.status !== 200) throw new Error(`Packaged Web UI returned HTTP ${String(response.status)} for ${url.href}`)
  const html = await response.text()
  if (!/<title>\s*DeepSeek Harness\s*<\/title>/.test(html)) throw new Error(`Packaged Web UI returned the wrong title for ${url.href}`)
}

/** @param {import('node:child_process').ChildProcess} child */
function observeExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  return new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
}

/** @param {Promise<{ code: number | null, signal: NodeJS.Signals | null }>} exit @param {number} timeoutMs @param {string} message */
async function waitForExit(exit, timeoutMs, message) {
  const timeout = Promise.withResolvers()
  const timer = setTimeout(() => timeout.reject(new Error(message)), timeoutMs)
  try {
    return await Promise.race([exit, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

/** @param {number} processGroupId */
function requireProcessGroupAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0)
  } catch (error) {
    if (error.code === 'ESRCH') throw new Error(`Owned Harness process group disappeared early: ${String(processGroupId)}`)
    if (error.code !== 'EPERM') throw error
  }
}

/** @param {number} processGroupId @param {number} timeoutMs */
async function requireProcessGroupGone(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (isProcessGroupAlive(processGroupId)) {
    if (Date.now() >= deadline) throw new Error(`Owned Harness process group remains after App quit: ${String(processGroupId)}`)
    await delay(25)
  }
}

/** @param {number} processGroupId */
function isProcessGroupAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    throw error
  }
}

/** @param {import('node:child_process').ChildProcess | undefined} primary @param {number | undefined} backendPid */
async function emergencyCleanup(primary, backendPid) {
  if (primary?.pid !== undefined && primary.exitCode === null && primary.signalCode === null) {
    try {
      process.kill(primary.pid, 'SIGTERM')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
    try {
      await waitForExit(observeExit(primary), 2_000, 'Emergency App shutdown timed out')
    } catch {
      try {
        process.kill(-primary.pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
  }
  if (backendPid !== undefined && isProcessGroupAlive(backendPid)) {
    try {
      process.kill(-backendPid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
    await requireProcessGroupGone(backendPid, 5_000)
  }
}

/** @param {string} path @param {string} message */
async function requireFile(path, message) {
  try {
    if ((await stat(path)).isFile()) return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  throw new Error(`${message}: ${path}`)
}

/** @param {string} path @param {string} message */
async function requireDirectory(path, message) {
  try {
    if ((await stat(path)).isDirectory()) return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  throw new Error(`${message}: ${path}`)
}

/** @param {string} path */
async function requireExecutable(path) {
  await requireFile(path, 'Packaged App executable is missing')
  const entry = await stat(path)
  if ((entry.mode & 0o111) === 0) throw new Error(`Packaged App executable is not executable: ${path}`)
}

/** @param {string} executable @param {readonly string[]} args @param {{ allowFailure?: boolean }} [options] */
async function run(executable, args, options = {}) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      const result = { code, signal, stdout, stderr }
      if (signal === null && (code === 0 || options.allowFailure === true)) {
        resolveRun(result)
        return
      }
      rejectRun(new Error(`${executable} ${args.join(' ')} failed (${describeExit(result)}): ${stderr.trim()}`))
    })
  })
}

/** @param {{ code: number | null, signal: NodeJS.Signals | null }} result */
function describeExit(result) {
  return result.signal === null ? `exit code ${String(result.code)}` : `signal ${result.signal}`
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {number} timeoutMs */
async function delay(timeoutMs) {
  await new Promise(resolveDelay => setTimeout(resolveDelay, timeoutMs))
}

const isMain = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (isMain) await verifyPackage()
