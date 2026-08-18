import { spawn } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, opendir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertRuntimeContainsNoLinks,
  resolveCliEntryPath,
  resolveWebFrontendIndex,
} from './stage-runtime.mjs'
import { auditX64Pe } from './pe-audit.mjs'
import { requireClosedTcpPort, terminateOwnedWindowsProcessTree } from './process-group.mjs'

const PRODUCT_NAME = 'DeepSeek Harness'
const STARTUP_TIMEOUT_MS = 90_000
const SHUTDOWN_TIMEOUT_MS = 15_000
const DESKTOP_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Creates the fixed artifact paths for native Windows x64 package verification.
 *
 * @param {{ desktopRoot: string, platform: NodeJS.Platform, arch: string }} input Host and Desktop paths.
 * @returns {{ releaseDirectory: string, unpackedDirectory: string, unpackedExecutable: string }} Windows build paths.
 */
export function createWindowsVerifyPlan(input) {
  if (input.platform !== 'win32' || input.arch !== 'x64') {
    throw new Error(
      `Unsupported Windows desktop package verification target: ${input.platform}-${input.arch}; expected win32-x64`,
    )
  }
  const desktopRoot = win32.resolve(input.desktopRoot)
  const releaseDirectory = win32.join(desktopRoot, 'release')
  const unpackedDirectory = win32.join(releaseDirectory, 'win-unpacked')
  return {
    releaseDirectory,
    unpackedDirectory,
    unpackedExecutable: win32.join(unpackedDirectory, `${PRODUCT_NAME}.exe`),
  }
}

/**
 * Resolves the sole Windows x64 NSIS installer from a clean release directory.
 *
 * @param {string} releaseDirectory Electron Builder output directory.
 * @returns {Promise<string>} Absolute installer path.
 */
export async function findNsisInstaller(releaseDirectory) {
  const entries = await readdir(releaseDirectory, { withFileTypes: true })
  const installers = entries
    .filter(entry => entry.isFile()
      && extname(entry.name).toLowerCase() === '.exe'
      && /^DeepSeek Harness Setup .+-x64\.exe$/.test(entry.name))
    .map(entry => join(releaseDirectory, entry.name))
    .sort()
  if (installers.length !== 1) {
    throw new Error(`Expected exactly one Windows NSIS installer, found ${String(installers.length)}`)
  }
  return installers[0]
}

/**
 * Validates ordinary Windows application roots, runtime anchors, filesystem links, and PE architectures.
 *
 * @param {string} appDirectory Unpacked or installed Electron application directory.
 * @param {{ expectedNonX64Pe?: Readonly<Record<string, number>> }} [options] Exact reviewed packaging-tool exceptions.
 * @returns {Promise<{ executable: string, runtime: string, peFiles: readonly string[] }>} Validated paths and PE inventory.
 */
export async function validateWindowsAppLayout(appDirectory, options = {}) {
  await requireOrdinaryDirectory(appDirectory, 'Packaged Windows application must be an ordinary directory')
  const resources = join(appDirectory, 'resources')
  const runtime = join(resources, 'runtime')
  const executable = join(appDirectory, `${PRODUCT_NAME}.exe`)
  const appAsar = join(resources, 'app.asar')
  await requireOrdinaryDirectory(resources, 'Packaged Windows resources must be an ordinary directory')
  await requireOrdinaryDirectory(runtime, 'Packaged Windows runtime must be an ordinary directory')
  await requireOrdinaryFile(executable, 'Packaged Windows executable must be an ordinary file')
  await requireOrdinaryFile(appAsar, 'Packaged Windows Electron app.asar must be an ordinary file')
  await requireMissing(
    join(resources, 'elevate.exe'),
    'Packaged Windows application contains the forbidden elevation helper',
  )

  const canonicalApp = await realpath(appDirectory)
  await requireCanonicalDescendant(canonicalApp, resources, 'Packaged Windows resources')
  await requireCanonicalDescendant(canonicalApp, runtime, 'Packaged Windows runtime')
  await requireCanonicalDescendant(canonicalApp, executable, 'Packaged Windows executable')
  await requireCanonicalDescendant(canonicalApp, appAsar, 'Packaged Windows Electron app.asar')
  await assertRuntimeContainsNoLinks(appDirectory, 'Packaged Windows application')
  if (process.platform === 'win32') await requireNoWindowsReparsePoints(appDirectory)
  await resolveCliEntryPath(runtime)
  await resolveWebFrontendIndex(runtime)
  const peFiles = await auditX64Pe(appDirectory, options)
  if (peFiles.length === 0) throw new Error('Packaged Windows application contains no PE binaries')
  return { executable, runtime, peFiles }
}

/**
 * Derives the per-user installation, shortcut, and application-data paths used by NSIS acceptance.
 *
 * @param {{ localAppData: string, appData: string, desktopDirectory: string }} input Windows user directories.
 * @returns {{ programsDirectory: string, startMenuShortcut: string, desktopShortcut: string, userData: string }} Installed paths.
 */
export function createWindowsInstallPaths(input) {
  return {
    programsDirectory: win32.join(input.localAppData, 'Programs'),
    startMenuShortcut: win32.join(
      input.appData,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      `${PRODUCT_NAME}.lnk`,
    ),
    desktopShortcut: win32.join(input.desktopDirectory, `${PRODUCT_NAME}.lnk`),
    userData: win32.join(input.appData, PRODUCT_NAME),
  }
}

/**
 * Resolves the actual NSIS install directory from its Start Menu target.
 * The silent acceptance install keeps Electron Builder's per-user default directory.
 *
 * @param {{ programsDirectory: string, shortcutTarget: string }} input Trusted per-user root and shortcut target.
 * @returns {{ installDirectory: string, executable: string, uninstaller: string }} Validated installed paths.
 */
export function createInstalledWindowsPaths(input) {
  const programsDirectory = win32.resolve(input.programsDirectory)
  const executable = win32.resolve(input.shortcutTarget)
  if (win32.basename(executable).toLowerCase() !== `${PRODUCT_NAME}.exe`.toLowerCase()) {
    throw new Error(`NSIS shortcut target does not name ${PRODUCT_NAME}.exe: ${executable}`)
  }
  const installDirectory = win32.dirname(executable)
  const fromPrograms = win32.relative(programsDirectory, installDirectory)
  if (
    installDirectory === programsDirectory
    || fromPrograms === '..'
    || fromPrograms.startsWith(`..${win32.sep}`)
    || win32.isAbsolute(fromPrograms)
  ) {
    throw new Error(
      `NSIS shortcut target is outside the current-user Programs directory: ${executable}`,
    )
  }
  return {
    installDirectory,
    executable,
    uninstaller: win32.join(installDirectory, `Uninstall ${PRODUCT_NAME}.exe`),
  }
}

/** Runs the complete unpacked and per-user NSIS acceptance on native Windows x64. */
export async function verifyWindowsPackage() {
  const plan = createWindowsVerifyPlan({ desktopRoot: DESKTOP_ROOT, platform: process.platform, arch: process.arch })
  const installer = await findNsisInstaller(plan.releaseDirectory)
  const unpacked = await validateWindowsAppLayout(plan.unpackedDirectory)
  await requireUnsigned(unpacked.executable)
  await requireUnsigned(installer)
  const unpackedStats = await summarizeTree(plan.unpackedDirectory)
  const installerBytes = (await stat(installer)).size
  await verifyStandaloneWindowsLaunch(plan.unpackedDirectory)
  const installMs = await verifyInstalledWindowsPackage(installer)
  const stats = { installerBytes, appFiles: unpackedStats.files, appBytes: unpackedStats.bytes, installMs }
  await writeFile(join(plan.releaseDirectory, 'verify-stats.json'), `${JSON.stringify(stats)}\n`)
  console.log(`Windows package stats: ${JSON.stringify(stats)}`)
  console.log(`Windows unpacked package verification passed: ${plan.unpackedDirectory}`)
  console.log(`Windows NSIS verification passed: ${installer}`)
}

/** @param {string} sourceDirectory */
async function verifyStandaloneWindowsLaunch(sourceDirectory) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-desktop-windows-standalone-'))
  const copiedDirectory = join(temporaryRoot, 'DeepSeek Harness')
  const userData = join(temporaryRoot, 'user-data')
  try {
    await cp(sourceDirectory, copiedDirectory, { recursive: true, verbatimSymlinks: true })
    const layout = await validateWindowsAppLayout(copiedDirectory)
    await requireUnsigned(layout.executable)
    await verifyPackagedWin32DialogWorker(layout)
    await verifyWindowsLaunch(layout.executable, userData, temporaryRoot)
  } finally {
    await rm(temporaryRoot, { recursive: true })
  }
}

/**
 * Runs the silent per-user NSIS acceptance and returns the install duration.
 *
 * @param {string} installer NSIS installer path.
 * @returns {Promise<number>} Silent install duration in milliseconds.
 */
async function verifyInstalledWindowsPackage(installer) {
  const localAppData = requiredEnvironment('LOCALAPPDATA')
  const appData = requiredEnvironment('APPDATA')
  const desktopDirectory = (await runPowerShell(
    '[Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop)',
  )).stdout.trim()
  const paths = createWindowsInstallPaths({ localAppData, appData, desktopDirectory })
  const acceptanceRoot = await mkdtemp(join(tmpdir(), 'dsh-desktop-windows-installed-'))
  const userData = join(acceptanceRoot, 'user-data')
  const preservationMarker = join(paths.userData, `desktop-installer-preserve-${process.pid}.txt`)
  let installed = false
  let installedPaths
  try {
    await requireMissing(paths.startMenuShortcut, 'Refusing to replace a pre-existing per-user installation')
    const installStarted = Date.now()
    await run(installer, ['/S'], { windowsHide: true })
    const installMs = Date.now() - installStarted
    installed = true
    await requireOrdinaryFile(paths.startMenuShortcut, 'NSIS did not create the Start Menu shortcut')
    await requireOrdinaryFile(paths.desktopShortcut, 'NSIS did not create the Desktop shortcut')
    installedPaths = createInstalledWindowsPaths({
      programsDirectory: paths.programsDirectory,
      shortcutTarget: await readWindowsShortcutTarget(paths.startMenuShortcut),
    })
    await requireOrdinaryFile(installedPaths.uninstaller, 'NSIS uninstaller is missing')
    const layout = await validateWindowsAppLayout(installedPaths.installDirectory, {
      expectedNonX64Pe: { [installedPaths.uninstaller]: 0x014c },
    })
    await requireUnsigned(layout.executable)
    await requireUnsigned(installedPaths.uninstaller)
    await verifyPackagedWin32DialogWorker(layout)
    await verifyWindowsLaunch(layout.executable, userData, acceptanceRoot)

    await mkdir(paths.userData, { recursive: true })
    await writeFile(preservationMarker, 'preserve')
    await run(installedPaths.uninstaller, ['/S'], { windowsHide: true })
    installed = false
    await waitForWindowsUninstallCleanup([
      installedPaths.installDirectory,
      paths.startMenuShortcut,
      paths.desktopShortcut,
    ], SHUTDOWN_TIMEOUT_MS)
    await requireOrdinaryFile(preservationMarker, 'NSIS uninstall removed preserved application data')
    return installMs
  } finally {
    if (installed && installedPaths !== undefined) {
      try {
        await run(installedPaths.uninstaller, ['/S'], { windowsHide: true })
      } catch {
        // The acceptance error remains primary; a stale CI installation is visible on the next fail-fast run.
      }
    }
    try {
      await rm(preservationMarker)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await rm(acceptanceRoot, { recursive: true })
  }
}

/**
 * Counts regular files and their total bytes in one directory tree.
 *
 * @param {string} directory Tree root.
 * @returns {Promise<{ files: number, bytes: number }>} File count and byte total.
 */
export async function summarizeTree(directory) {
  let files = 0
  let bytes = 0
  for await (const path of walkRegularFiles(directory)) {
    const entry = await lstat(path)
    if (!entry.isSymbolicLink()) {
      files += 1
      bytes += entry.size
    }
  }
  return { files, bytes }
}

/** @param {string} directory */
async function* walkRegularFiles(directory) {
  const entries = await opendir(directory)
  for await (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      yield* walkRegularFiles(path)
    } else {
      yield path
    }
  }
}

/** @param {string} shortcut */
async function readWindowsShortcutTarget(shortcut) {
  const result = await runPowerShell(
    '(New-Object -ComObject WScript.Shell).CreateShortcut($env:DSH_VERIFY_SHORTCUT).TargetPath',
    { DSH_VERIFY_SHORTCUT: shortcut },
  )
  const target = result.stdout.trim()
  if (target === '') throw new Error(`NSIS Start Menu shortcut has no target: ${shortcut}`)
  return target
}

/**
 * Observes one packaged Win32 dialog worker through its progress and terminal messages.
 *
 * @param {import('node:child_process').ChildProcess} worker Spawned packaged dialog child.
 * @param {(threadId: number) => Promise<void>} closeThreadWindows Closes the dialog during acceptance.
 * @returns {Promise<void>} Resolves only after the auto-close produces a terminal cancellation.
 */
export async function observeWin32DialogWorker(worker, closeThreadWindows) {
  return await new Promise((resolveWorker, rejectWorker) => {
    let settled = false
    const settle = (outcome) => {
      if (settled) return
      settled = true
      outcome()
    }
    worker.on('message', (message) => {
      if (message === null || typeof message !== 'object' || typeof message.kind !== 'string') {
        settle(() => rejectWorker(new Error('Packaged Win32 dialog worker reported an invalid IPC message')))
        return
      }
      if (message.kind === 'showing') {
        if (!Number.isInteger(message.threadId) || message.threadId < 1) {
          settle(() => rejectWorker(new Error('Packaged Win32 dialog worker reported an invalid thread id')))
          return
        }
        void closeThreadWindows(message.threadId).catch((error) => {
          settle(() => rejectWorker(new Error(`Unable to close packaged Win32 folder dialog: ${errorMessage(error)}`)))
        })
        return
      }
      if (message.kind === 'done') {
        if (message.path !== null) {
          settle(() => rejectWorker(new Error('Packaged Win32 dialog worker returned a path during auto-close')))
          return
        }
        settle(resolveWorker)
        return
      }
      if (message.kind === 'error' && typeof message.message === 'string') {
        settle(() => rejectWorker(new Error(`Packaged Win32 dialog worker failed: ${message.message}`)))
        return
      }
      settle(() => rejectWorker(new Error('Packaged Win32 dialog worker reported an invalid IPC message')))
    })
    worker.on('error', (error) => {
      settle(() => rejectWorker(error))
    })
    worker.on('exit', () => {
      settle(() => rejectWorker(new Error('Packaged Win32 dialog worker exited before reporting a terminal result')))
    })
  })
}

/** @param {{ executable: string, runtime: string }} layout */
async function verifyPackagedWin32DialogWorker(layout) {
  const runtimeRequire = createRequire(join(layout.runtime, 'package.json'))
  const workerPath = runtimeRequire.resolve('@deepseek-ai/dsh-host-directory-picker-native/worker')
  await requireCanonicalDescendant(await realpath(layout.runtime), workerPath, 'Packaged Win32 dialog worker')
  const environment = {
    ...isolatedEnvironment(),
    DSH_DIALOG_TITLE: 'DeepSeek Harness packaged folder-dialog verification',
    ELECTRON_RUN_AS_NODE: '1',
  }
  const worker = spawn(layout.executable, [workerPath], {
    cwd: layout.runtime,
    env: environment,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })
  const exit = new Promise((resolveExit) => {
    worker.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  let stderr = ''
  worker.stderr?.setEncoding('utf8')
  worker.stderr?.on('data', chunk => { stderr += chunk })
  const timeout = setTimeout(() => { worker.kill() }, SHUTDOWN_TIMEOUT_MS)
  try {
    await observeWin32DialogWorker(worker, async (threadId) => {
      await closeWin32DialogThread(threadId, async () => runtimeRequire('koffi'))
    })
    const result = await exit
    if (result.code !== 0 || result.signal !== null) {
      throw new Error(`Packaged Win32 dialog worker did not exit cleanly (${describeExit(result)}): ${stderr.trim()}`)
    }
  } finally {
    clearTimeout(timeout)
    if (worker.exitCode === null && worker.signalCode === null) worker.kill()
  }
}

/**
 * Closes the packaged dialog through the same user32 operations as the production driver.
 * @param {number} threadId Native worker thread that owns the dialog.
 * @param {() => Promise<any>} loadKoffi Loads koffi from the packaged runtime.
 * @param {{ attempts: number, delay: () => Promise<void> }} [retry] Window-creation race policy.
 */
export async function closeWin32DialogThread(
  threadId,
  loadKoffi,
  retry = { attempts: 40, delay: async () => { await delay(50) } },
) {
  const loaded = await loadKoffi()
  const koffi = loaded.default ?? loaded
  const user32 = koffi.load('user32.dll')
  const enumThreadWindows = user32.func('__stdcall', 'EnumThreadWindows', 'int', ['uint32', 'void *', 'intptr'])
  const postMessageW = user32.func('__stdcall', 'PostMessageW', 'int', ['void *', 'uint32', 'uintptr', 'intptr'])
  const protoEnumProc = koffi.proto('int __stdcall DshVerifyEnumThreadWndProc(void *hwnd, intptr lparam)')
  let posted = 0
  const callback = koffi.register((window) => {
    posted += 1
    postMessageW(window, 0x10, 0, 0)
    return 1
  }, koffi.pointer(protoEnumProc))
  try {
    for (let attempt = 0; attempt < retry.attempts; attempt += 1) {
      posted = 0
      enumThreadWindows(threadId, callback, 0)
      if (posted > 0) return
      if (attempt + 1 < retry.attempts) await retry.delay()
    }
  } finally {
    koffi.unregister(callback)
  }
  throw new Error(`Packaged Win32 folder dialog did not create a window for thread ${String(threadId)}`)
}

/** @param {string} executable @param {string} userData @param {string} cwd */
async function verifyWindowsLaunch(executable, userData, cwd) {
  await mkdir(userData, { recursive: true })
  const environment = isolatedEnvironment()
  let primary
  let backendPid
  let readyUrl
  try {
    primary = launchApp(executable, userData, cwd, environment)
    const primaryExit = observeExit(primary)
    const initial = await waitForLifecycle(join(userData, 'Logs/desktop.log'), STARTUP_TIMEOUT_MS)
    backendPid = initial.backendPid
    readyUrl = initial.url
    requireProcessAlive(backendPid)
    await requireHarnessPage(readyUrl)
    await requireSeparatedHarnessData(userData)

    const second = launchApp(executable, userData, cwd, environment)
    const secondResult = await waitForExit(
      observeExit(second),
      STARTUP_TIMEOUT_MS,
      'Second Windows App instance did not hand off and exit',
    )
    if (secondResult.code !== 0 || secondResult.signal !== null) {
      throw new Error(`Second Windows App instance failed during handoff (${describeExit(secondResult)})`)
    }
    const afterSecond = await readLifecycleSnapshot(join(userData, 'Logs/desktop.log'))
    if (afterSecond.startCount !== initial.startCount || afterSecond.backendPid !== backendPid) {
      throw new Error('Second Windows App instance started a replacement Harness backend')
    }

    await closeMainWindow(primary.pid)
    const primaryResult = await waitForExit(primaryExit, SHUTDOWN_TIMEOUT_MS, 'Primary Windows App did not close')
    if (primaryResult.code !== 0 || primaryResult.signal !== null) {
      throw new Error(`Primary Windows App did not quit cleanly (${describeExit(primaryResult)})`)
    }
    await requireProcessGone(backendPid, SHUTDOWN_TIMEOUT_MS)
    await requireClosedTcpPort(readyUrl, { timeoutMs: 5_000 })
    primary = undefined
  } finally {
    if (primary?.pid !== undefined) {
      const exit = observeExit(primary)
      try {
        await terminateOwnedWindowsProcessTree({
          leaderPid: primary.pid,
          exit,
          leaderExited: () => primary.exitCode !== null || primary.signalCode !== null,
        })
      } catch {
        // The launch failure remains primary; closed-port verification below still detects a leaked backend.
      }
    }
    if (backendPid !== undefined) await requireProcessGone(backendPid, SHUTDOWN_TIMEOUT_MS)
    if (readyUrl !== undefined) await requireClosedTcpPort(readyUrl, { timeoutMs: 5_000 })
  }
}

/** @param {string} executable @param {string} userData @param {string} cwd @param {NodeJS.ProcessEnv} env */
function launchApp(executable, userData, cwd, env) {
  const child = spawn(executable, [`--user-data-dir=${userData}`], {
    cwd,
    detached: false,
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  if (child.pid === undefined) throw new Error('Packaged Windows App did not create an owned process')
  child.stdout?.on('data', chunk => process.stdout.write(chunk))
  child.stderr?.on('data', chunk => process.stderr.write(chunk))
  return child
}

/** @param {number} pid */
async function closeMainWindow(pid) {
  const script = [
    `$process = Get-Process -Id ${String(pid)} -ErrorAction Stop`,
    'if (-not $process.CloseMainWindow()) { throw "Windows App has no closeable main window" }',
  ].join('; ')
  await runPowerShell(script)
}

/** @param {string} path */
async function requireUnsigned(path) {
  const result = await runPowerShell('(Get-AuthenticodeSignature -LiteralPath $env:DSH_VERIFY_PATH).Status', {
    DSH_VERIFY_PATH: path,
  })
  if (result.stdout.trim() !== 'NotSigned') {
    throw new Error(`Expected an unsigned personal Windows artifact: ${path} (${result.stdout.trim()})`)
  }
}

/** @param {string} root */
async function requireNoWindowsReparsePoints(root) {
  const script = [
    '$root = Get-Item -LiteralPath $env:DSH_VERIFY_PATH -Force',
    '$reparse = [IO.FileAttributes]::ReparsePoint',
    'if (($root.Attributes -band $reparse) -ne 0) { throw "Reparse point: $($root.FullName)" }',
    '$pending = [Collections.Generic.Stack[IO.DirectoryInfo]]::new()',
    '$pending.Push([IO.DirectoryInfo]$root)',
    'while ($pending.Count -gt 0) {',
    '  $directory = $pending.Pop()',
    '  foreach ($item in $directory.EnumerateFileSystemInfos()) {',
    '    if (($item.Attributes -band $reparse) -ne 0) { throw "Reparse point: $($item.FullName)" }',
    '    if ($item -is [IO.DirectoryInfo]) { $pending.Push([IO.DirectoryInfo]$item) }',
    '  }',
    '}',
  ].join('\n')
  try {
    await runPowerShell(script, { DSH_VERIFY_PATH: root })
  } catch (error) {
    throw new Error(`Packaged Windows application contains a reparse point: ${errorMessage(error)}`)
  }
}

/** @param {string} logPath */
async function readLifecycleSnapshot(logPath) {
  const entries = (await readFile(logPath, 'utf8'))
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line))
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
  throw new Error(`Packaged Windows App did not become ready within ${String(timeoutMs)}ms: ${errorMessage(lastError)}`)
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
  const port = Number(url.port)
  if (
    url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
  ) return undefined
  return url
}

/** @param {URL} url */
async function requireHarnessPage(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS) })
  if (response.status !== 200) throw new Error(`Packaged Web UI returned HTTP ${String(response.status)} for ${url.href}`)
  const html = await response.text()
  if (!/<title>\s*DeepSeek Harness\s*<\/title>/.test(html)) {
    throw new Error(`Packaged Web UI returned the wrong title for ${url.href}`)
  }
}

/** @param {string} userData */
async function requireSeparatedHarnessData(userData) {
  await requireOrdinaryDirectory(join(userData, 'Harness'), 'Packaged Harness data directory is missing')
  await requireOrdinaryFile(
    join(userData, 'Harness/profiles/web/cordis.yml'),
    'Packaged Harness profile was not initialized',
  )
  await requireMissing(join(userData, 'profiles'), 'Harness profile data leaked into the Electron userData root')
}

/** @param {number} pid */
function requireProcessAlive(pid) {
  process.kill(pid, 0)
}

/** @param {number} pid @param {number} timeoutMs */
async function requireProcessGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    if (Date.now() >= deadline) throw new Error(`Owned Windows process remains alive: ${String(pid)}`)
    await delay(50)
  }
}

/** @param {import('node:child_process').ChildProcess} child */
function observeExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
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

/** @param {string} path @param {number} timeoutMs */
async function waitForMissing(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      await lstat(path)
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    if (Date.now() >= deadline) throw new Error(`Windows uninstall did not remove: ${path}`)
    await delay(50)
  }
}

/**
 * Waits for the NSIS temporary uninstaller process to remove every installed path.
 * The uninstaller executable can return before its child removes shortcuts.
 *
 * @param {readonly string[]} paths Installation and shortcut paths that must disappear.
 * @param {number} timeoutMs Maximum cleanup wait for each concurrently observed path.
 */
export async function waitForWindowsUninstallCleanup(paths, timeoutMs) {
  await Promise.all(paths.map(async path => await waitForMissing(path, timeoutMs)))
}

/** @param {string} path @param {string} message */
async function requireOrdinaryFile(path, message) {
  try {
    const entry = await lstat(path)
    if (!entry.isSymbolicLink() && entry.isFile()) return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  throw new Error(`${message}: ${path}`)
}

/** @param {string} path @param {string} message */
async function requireOrdinaryDirectory(path, message) {
  try {
    const entry = await lstat(path)
    if (!entry.isSymbolicLink() && entry.isDirectory()) return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  throw new Error(`${message}: ${path}`)
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

/** @param {string} canonicalParent @param {string} candidate @param {string} label */
async function requireCanonicalDescendant(canonicalParent, candidate, label) {
  const canonicalCandidate = await realpath(candidate)
  const fromParent = relative(canonicalParent, canonicalCandidate)
  if (
    canonicalCandidate === canonicalParent
    || fromParent === '..'
    || fromParent.startsWith(`..${sep}`)
    || isAbsolute(fromParent)
  ) {
    throw new Error(`${label} resolves outside its packaged parent: ${candidate} -> ${canonicalCandidate}`)
  }
  return canonicalCandidate
}

/** @param {string} script @param {NodeJS.ProcessEnv} [environment] */
async function runPowerShell(script, environment = {}) {
  return await run(resolvePowerShellExecutable(process.env), ['-NoProfile', '-NonInteractive', '-Command', script], {
    environment,
    windowsHide: true,
  })
}

/** @param {NodeJS.ProcessEnv} environment */
export function resolvePowerShellExecutable(environment) {
  const executable = environment.DSH_POWERSHELL_EXECUTABLE?.trim()
  return executable === undefined || executable === '' ? 'powershell.exe' : executable
}

/** @param {string} executable @param {readonly string[]} args @param {{ environment?: NodeJS.ProcessEnv, windowsHide?: boolean }} [options] */
async function run(executable, args, options = {}) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      env: { ...process.env, ...options.environment },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: options.windowsHide ?? false,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) {
        resolveRun({ code, signal, stdout, stderr })
        return
      }
      rejectRun(new Error(`${executable} ${args.join(' ')} failed (${describeExit({ code, signal })}): ${stderr.trim()}`))
    })
  })
}

function isolatedEnvironment() {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/(?:KEY|SECRET|TOKEN|PASSWORD)/i.test(name)),
  )
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_NO_ASAR
  return environment
}

/** @param {string} name */
function requiredEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`Windows package verification requires ${name}`)
  return value
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
