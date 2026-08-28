import { spawn } from 'node:child_process'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve, win32 } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseDesktopReadyUrl, requireHarnessBoot, requireHarnessFunctionality } from './harness-boot-audit.mjs'
import { auditX64Pe } from './pe-audit.mjs'

const PRODUCT_NAME = 'DeepSeek Harness'
const DESKTOP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const STARTUP_TIMEOUT_MS = 20_000
const SHUTDOWN_TIMEOUT_MS = 15_000
const MAX_APP_FILES = 500
const MAX_APP_BYTES = 250 * 1024 * 1024
const MAX_CI_PAGE_LOAD_MS = 10_000
const MAX_CI_INSTALL_MS = 60_000
const SMOKE_EXIT_AFTER_HIDE_MS = 1_500

/** Resolves the native Tauri Windows acceptance paths. */
export function createTauriWindowsVerifyPlan(input) {
  if (input.platform !== 'win32' || input.arch !== 'x64') {
    throw new Error(`Unsupported Tauri Windows verification target: ${input.platform}-${input.arch}; expected win32-x64`)
  }
  const releaseDirectory = win32.join(win32.resolve(input.desktopRoot), 'release-tauri')
  const unpackedDirectory = win32.join(releaseDirectory, 'win-unpacked')
  return {
    releaseDirectory,
    unpackedDirectory,
    unpackedExecutable: win32.join(unpackedDirectory, `${PRODUCT_NAME}.exe`),
  }
}

/** Finds the sole compatibly named Tauri NSIS installer. */
export async function findTauriNsisInstaller(releaseDirectory) {
  const installers = (await readdir(releaseDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && extname(entry.name).toLowerCase() === '.exe')
    .map(entry => join(releaseDirectory, entry.name))
    .sort()
  if (installers.length !== 1) throw new Error(`Expected exactly one Tauri NSIS installer, found ${installers.length}`)
  if (!/^DeepSeek Harness Setup .+-x64\.exe$/.test(basename(installers[0]))) {
    throw new Error(`Unexpected Tauri NSIS installer name: ${basename(installers[0])}`)
  }
  return installers[0]
}

/** Derives shortcut and legacy user-data locations owned by current-user installation. */
export function createTauriWindowsInstallPaths(input) {
  return {
    startMenuShortcut: win32.join(input.appData, 'Microsoft/Windows/Start Menu/Programs', `${PRODUCT_NAME}.lnk`),
    desktopShortcut: win32.join(input.desktopDirectory, `${PRODUCT_NAME}.lnk`),
    userData: win32.join(input.appData, PRODUCT_NAME),
  }
}

/** Parses the owned process and strict ready URL from the Tauri desktop log. */
export function parseTauriDesktopLifecycle(text) {
  const starts = [...text.matchAll(/\tdesktop\tsidecar spawned pid=(\d+)(?:\r?$)/gm)]
  const pid = Number(starts.at(-1)?.[1])
  if (!Number.isInteger(pid) || pid < 1) throw new Error('Tauri desktop log is missing a sidecar pid')
  const url = parseDesktopReadyUrl(text)
  if (url === undefined) {
    throw new Error('Tauri desktop log is missing a strict loopback ready URL')
  }
  return { pid, startCount: starts.length, url }
}

function parseTauriSidecarFrames(text) {
  return text.split(/\r?\n/).flatMap((line) => {
    const marker = '\tsidecar-stdout\tDSH_DESKTOP/1 '
    const offset = line.indexOf(marker)
    if (offset < 0) return []
    try {
      return [JSON.parse(line.slice(offset + marker.length))]
    } catch {
      return []
    }
  })
}

/** Returns request ids emitted through the versioned desktop directory-picker protocol. */
export function parseTauriDirectoryPickerRequests(text) {
  return parseTauriSidecarFrames(text)
    .filter(frame => frame?.type === 'directory-picker-request' && typeof frame.requestId === 'string')
    .map(frame => frame.requestId)
}

/** Validates the complete native-process-to-page performance record. */
export function validatePerformanceStats(value, pageLoadLimitMs) {
  const fields = [
    'processStartMs',
    'sidecarSpawnMs',
    'pluginTreeReadyMs',
    'httpReadyMs',
    'pageLoadedMs',
    'shutdownMs',
    'forcedTerminationCount',
  ]
  for (const field of fields) {
    if (!Number.isInteger(value?.[field]) || value[field] < 0) {
      throw new Error(`Invalid desktop performance field: ${field}`)
    }
  }
  if (value.pageLoadedMs > pageLoadLimitMs) {
    throw new Error(
      `Desktop page load exceeded ${pageLoadLimitMs}ms: ${value.pageLoadedMs}ms; stats=${JSON.stringify(value)}`,
    )
  }
  if (value.forcedTerminationCount !== 0) {
    throw new Error(`Desktop required forced termination ${value.forcedTerminationCount} time(s)`)
  }
  return value
}

/** Runs unpacked and installed Tauri acceptance on native Windows x64. */
export async function verifyTauriWindowsPackage() {
  const plan = createTauriWindowsVerifyPlan({ desktopRoot: DESKTOP_ROOT, platform: process.platform, arch: process.arch })
  const installer = await findTauriNsisInstaller(plan.releaseDirectory)
  const unpackedStats = await validateAppPayload(plan.unpackedDirectory, plan.unpackedExecutable)
  await requireUnsigned(plan.unpackedExecutable)
  await requireUnsigned(installer)
  const unpackedStartup = await verifyLaunch(plan.unpackedExecutable, plan.unpackedDirectory)
  const installed = await verifyInstalled(installer)
  const stats = {
    installerBytes: (await stat(installer)).size,
    appFiles: unpackedStats.files,
    appBytes: unpackedStats.bytes,
    unpackedPageLoadedMs: unpackedStartup.pageLoadedMs,
    ...installed,
  }
  await writeFile(join(plan.releaseDirectory, 'verify-stats.json'), `${JSON.stringify(stats, null, 2)}\n`)
  console.log(`Tauri Windows package verification passed: ${JSON.stringify(stats)}`)
}

async function validateAppPayload(directory, executable, uninstaller) {
  await requireDirectory(directory, 'Tauri application directory is missing')
  await requireFile(executable, 'Tauri application executable is missing')
  for (const helper of ['dsh-desktop-sidecar.exe', 'dsh-desktop-sidecar-rg.exe']) {
    await requireFile(join(directory, helper), `Tauri sidecar helper is missing: ${helper}`)
  }
  await requireNoReparsePoints(directory)
  const expectedNonX64Pe = uninstaller === undefined ? {} : { [uninstaller]: 0x014c }
  const peFiles = await auditX64Pe(directory, { expectedNonX64Pe })
  if (peFiles.length < 3) throw new Error(`Expected at least three x64 PE payloads, found ${peFiles.length}`)
  const summary = await summarizeTree(directory)
  if (summary.files > MAX_APP_FILES) throw new Error(`Installed file count exceeded ${MAX_APP_FILES}: ${summary.files}`)
  if (summary.bytes > MAX_APP_BYTES) throw new Error(`Installed size exceeded ${MAX_APP_BYTES}: ${summary.bytes}`)
  return summary
}

async function verifyLaunch(executable, cwd) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tauri-windows-launch-'))
  const userData = join(root, '用户 数据')
  await mkdir(userData, { recursive: true })
  let primary
  let lifecycle
  try {
    primary = launch(executable, cwd, userData)
    const primaryOutput = captureOutput(primary)
    const primaryExit = observeExit(primary)
    lifecycle = await waitForTauriLifecycleOrExit(
      waitForLifecycle(userData),
      primaryExit,
      primaryOutput,
    )
    await requirePage(lifecycle.url, userData)
    await requireFile(join(userData, 'Harness/profiles/web/cordis.yml'), 'Packaged Web profile was not initialized')
    const initialStats = await waitForPerformance(userData, false)
    if (initialStats.pageLoadedMs > MAX_CI_PAGE_LOAD_MS) {
      throw new Error(
        `Desktop page load exceeded ${MAX_CI_PAGE_LOAD_MS}ms: ${initialStats.pageLoadedMs}ms; stats=${JSON.stringify(initialStats)}`,
      )
    }

    await requireNativeDirectoryPicker(lifecycle.url, userData, primary.pid)

    const second = launch(executable, cwd, userData)
    const secondResult = await waitForExit(observeExit(second), STARTUP_TIMEOUT_MS, 'Second Tauri instance did not exit')
    if (secondResult.code !== 0) throw new Error(`Second Tauri instance exited with ${secondResult.code}`)
    const afterSecond = parseTauriDesktopLifecycle(await readFile(join(userData, 'Logs/desktop.log'), 'utf8'))
    if (afterSecond.startCount !== lifecycle.startCount || afterSecond.pid !== lifecycle.pid) {
      throw new Error('Second Tauri instance created another sidecar')
    }

    await closeMainWindow(primary.pid)
    await new Promise(resolveDelay => setTimeout(resolveDelay, 200))
    requireProcessAlive(primary.pid, 'Windows close request exited the Tauri application instead of hiding it')
    requireProcessAlive(lifecycle.pid, 'Windows close request stopped the sidecar instead of hiding to tray')
    const hiddenPage = await fetch(lifecycle.url, { signal: AbortSignal.timeout(500) })
    if (!hiddenPage.ok) throw new Error(`Hidden Tauri application returned HTTP ${hiddenPage.status}`)
    await waitForExit(primaryExit, SHUTDOWN_TIMEOUT_MS, 'Tauri application did not close')
    primary = undefined
    await requireProcessGone(lifecycle.pid)
    await requireClosedPort(lifecycle.url)
    return await waitForPerformance(userData, true)
  } finally {
    if (primary?.pid !== undefined) await taskkill(primary.pid)
    if (lifecycle?.pid !== undefined) await requireProcessGone(lifecycle.pid).catch(() => taskkill(lifecycle.pid))
    await rm(root, { recursive: true, force: true })
  }
}

async function verifyInstalled(installer) {
  const appData = requiredEnvironment('APPDATA')
  const localAppData = requiredEnvironment('LOCALAPPDATA')
  const desktopDirectory = (await powershell('[Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop)')).stdout.trim()
  const paths = createTauriWindowsInstallPaths({ appData, desktopDirectory })
  await requireMissing(paths.startMenuShortcut, 'Refusing to replace an existing Tauri installation')
  const started = Date.now()
  await run(installer, ['/S'])
  const installMs = Date.now() - started
  if (installMs > MAX_CI_INSTALL_MS) throw new Error(`Tauri install exceeded ${MAX_CI_INSTALL_MS}ms: ${installMs}ms`)
  await requireFile(paths.startMenuShortcut, 'Tauri NSIS did not create the Start Menu shortcut')
  await requireMissing(paths.desktopShortcut, 'Tauri NSIS unexpectedly created a Desktop shortcut')
  const executable = (await powershell(
    '(New-Object -ComObject WScript.Shell).CreateShortcut($env:DSH_SHORTCUT).TargetPath',
    { DSH_SHORTCUT: paths.startMenuShortcut },
  )).stdout.trim()
  const installDirectory = dirname(executable)
  const fromLocal = win32.relative(win32.resolve(localAppData), win32.resolve(installDirectory))
  if (fromLocal === '..' || fromLocal.startsWith(`..${win32.sep}`) || win32.isAbsolute(fromLocal)) {
    throw new Error(`Tauri current-user install escaped LOCALAPPDATA: ${installDirectory}`)
  }
  const uninstaller = await findUninstaller(installDirectory)
  await validateAppPayload(installDirectory, executable, uninstaller)
  await requireUnsigned(executable)
  const performance = await verifyLaunch(executable, installDirectory)
  await mkdir(paths.userData, { recursive: true })
  const marker = join(paths.userData, `preserve-${process.pid}.txt`)
  await writeFile(marker, 'preserve')
  const uninstallStarted = Date.now()
  await run(uninstaller, ['/S'])
  await waitForMissing(installDirectory)
  await waitForMissing(paths.startMenuShortcut)
  await requireMissing(paths.desktopShortcut, 'Desktop shortcut remained after uninstall')
  await requireFile(marker, 'Tauri NSIS removed Harness user data')
  await rm(marker, { force: true })
  return { installMs, uninstallMs: Date.now() - uninstallStarted, installedPageLoadedMs: performance.pageLoadedMs }
}

function launch(executable, cwd, userData) {
  const child = spawn(executable, [], {
    cwd,
    env: {
      ...sanitizedEnvironment(),
      DSH_DESKTOP_USER_DATA_DIR: userData,
      DSH_DESKTOP_SMOKE_EXIT_AFTER_HIDE_MS: String(SMOKE_EXIT_AFTER_HIDE_MS),
    },
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (child.pid === undefined) throw new Error('Tauri application did not create a process')
  return child
}

/** Rejects with native process output when the Tauri shell exits before sidecar readiness. */
export async function waitForTauriLifecycleOrExit(lifecycle, exit, output) {
  return await Promise.race([
    lifecycle,
    exit.then((result) => {
      const captured = output()
      const status = result.signal ?? `exit code ${result.code}`
      throw new Error(
        `Tauri application exited before sidecar readiness with ${status}`
        + `\nstdout:\n${captured.stdout.trim() || '<empty>'}`
        + `\nstderr:\n${captured.stderr.trim() || '<empty>'}`,
      )
    }),
  ])
}

function captureOutput(child) {
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  return () => ({ stdout, stderr })
}

async function waitForLifecycle(userData) {
  const path = join(userData, 'Logs/desktop.log')
  return await waitFor(async () => parseTauriDesktopLifecycle(await readFile(path, 'utf8')), 'Tauri sidecar did not become ready')
}

async function waitForPerformance(userData, complete) {
  const path = join(userData, 'Logs/desktop-performance.json')
  return await waitFor(async () => {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (!Number.isInteger(value.pageLoadedMs) || complete && !Number.isInteger(value.shutdownMs)) throw new Error('incomplete')
    return complete ? validatePerformanceStats(value, MAX_CI_PAGE_LOAD_MS) : value
  }, 'Tauri performance record did not become complete')
}

async function waitFor(operation, label) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  let lastError
  while (Date.now() < deadline) {
    try { return await operation() } catch (error) { lastError = error }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
  }
  throw new Error(`${label}: ${String(lastError)}`)
}

async function requirePage(url, userData) {
  const session = await requireHarnessBoot(url, STARTUP_TIMEOUT_MS)
  const workspacePath = join(userData, '验证 工作区')
  await mkdir(workspacePath, { recursive: true })
  await requireHarnessFunctionality(session.url, workspacePath, STARTUP_TIMEOUT_MS, session.fetch)
}

async function requireNativeDirectoryPicker(url, userData, desktopPid) {
  const rpcId = 'desktop-verify-host.pickDirectory'
  const response = fetch(new URL('/api/host.pickDirectory', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'host.pickDirectory', payload: {} }),
    signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
  }).then(async (value) => {
    if (!value.ok) throw new Error(`Harness host.pickDirectory returned HTTP ${value.status}`)
    return await value.json()
  })
  const requestObserved = waitFor(async () => {
    const log = await readFile(join(userData, 'Logs/desktop.log'), 'utf8')
    const requests = parseTauriDirectoryPickerRequests(log)
    if (requests.length === 0) throw new Error('no desktop directory-picker request')
    return requests.at(-1)
  }, 'Tauri sidecar did not delegate directory picking to its native parent')
  await Promise.race([
    requestObserved,
    response.then((envelope) => {
      throw new Error(`host.pickDirectory returned before the desktop protocol request: ${JSON.stringify(envelope)}`)
    }),
  ])
  await closeNativeFolderDialog(desktopPid)
  const envelope = await response
  if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId
    || envelope.result?.ok !== true || envelope.result.value?.path !== null) {
    throw new Error(`Tauri native folder dialog did not report cancellation: ${JSON.stringify(envelope)}`)
  }
}

async function summarizeTree(directory) {
  let files = 0
  let bytes = 0
  for await (const path of walk(directory)) {
    const value = await stat(path)
    files += 1
    bytes += value.size
  }
  return { files, bytes }
}

async function* walk(directory) {
  const entries = await opendir(directory)
  for await (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile()) yield path
  }
}

async function requireNoReparsePoints(root) {
  const script = [
    '$pending = [Collections.Generic.Stack[IO.DirectoryInfo]]::new()',
    '$pending.Push([IO.DirectoryInfo](Get-Item -LiteralPath $env:DSH_PATH -Force))',
    'while ($pending.Count -gt 0) {',
    ' $directory = $pending.Pop()',
    ' foreach ($item in $directory.EnumerateFileSystemInfos()) {',
    '  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point: $($item.FullName)" }',
    '  if ($item -is [IO.DirectoryInfo]) { $pending.Push($item) }',
    ' }',
    '}',
  ].join('\n')
  await powershell(script, { DSH_PATH: root })
}

async function requireUnsigned(path) {
  const result = await powershell('(Get-AuthenticodeSignature -LiteralPath $env:DSH_PATH).Status', { DSH_PATH: path })
  if (result.stdout.trim() !== 'NotSigned') throw new Error(`Expected NotSigned: ${path}`)
}

async function closeMainWindow(pid) {
  await powershell(`$p = Get-Process -Id ${pid} -ErrorAction Stop; if (-not $p.CloseMainWindow()) { throw 'No closeable window' }`)
}

async function closeNativeFolderDialog(pid) {
  const script = [
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public static class DshWindows {',
    '  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);',
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);',
    '  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);',
    '}',
    '"@',
    '$target = [uint32]$env:DSH_PID',
    '$closed = 0',
    '[DshWindows]::EnumWindows({ param($hwnd, $unused)',
    '  [uint32]$owner = 0',
    '  [void][DshWindows]::GetWindowThreadProcessId($hwnd, [ref]$owner)',
    '  if ($owner -ne $target) { return $true }',
    '  $title = [Text.StringBuilder]::new(512)',
    '  [void][DshWindows]::GetWindowText($hwnd, $title, $title.Capacity)',
    '  if ($title.ToString() -eq "Select workspace folder") {',
    '    [void][DshWindows]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)',
    '    $script:closed += 1',
    '  }',
    '  return $true',
    '}, [IntPtr]::Zero)',
    'if ($closed -ne 1) { throw "Expected one native folder dialog, closed $closed" }',
  ].join('\n')
  await waitFor(
    async () => await powershell(script, { DSH_PID: String(pid) }),
    'Tauri native folder dialog did not open',
  )
}

function requireProcessAlive(pid, message) {
  try {
    process.kill(pid, 0)
  } catch {
    throw new Error(message)
  }
}

async function findUninstaller(directory) {
  const names = (await readdir(directory)).filter(name => /uninstall.*\.exe$/i.test(name))
  if (names.length !== 1) throw new Error(`Expected one Tauri uninstaller, found ${names.length}`)
  return join(directory, names[0])
}

function observeExit(child) {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  return new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
}

async function waitForExit(exit, timeoutMs, message) {
  let timer
  try {
    return await Promise.race([
      exit,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function requireProcessGone(pid) {
  await waitFor(async () => {
    try { process.kill(pid, 0) } catch (error) {
      if (error.code === 'ESRCH') return true
      throw error
    }
    throw new Error(`process ${pid} remains alive`)
  }, `Owned sidecar ${pid} remains alive`)
}

async function requireClosedPort(url) {
  await waitFor(async () => {
    try { await fetch(url, { signal: AbortSignal.timeout(250) }) } catch { return true }
    throw new Error(`port ${url.port} remains open`)
  }, `Owned port ${url.port} remains open`)
}

async function taskkill(pid) {
  await run('taskkill.exe', ['/PID', String(pid), '/T', '/F']).catch(() => {})
}

async function waitForMissing(path) {
  await waitFor(async () => {
    try { await lstat(path) } catch (error) {
      if (error.code === 'ENOENT') return true
      throw error
    }
    throw new Error(`${path} remains present`)
  }, `Uninstall did not remove ${path}`)
}

async function requireFile(path, message) {
  try {
    if ((await lstat(path)).isFile()) return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  throw new Error(`${message}: ${path}`)
}

async function requireDirectory(path, message) {
  try {
    if ((await lstat(path)).isDirectory()) return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  throw new Error(`${message}: ${path}`)
}

async function requireMissing(path, message) {
  try { await lstat(path) } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw new Error(`${message}: ${path}`)
}

async function powershell(script, environment = {}) {
  return await run(process.env.DSH_POWERSHELL_EXECUTABLE ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], environment)
}

async function run(executable, args, environment = {}) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      env: { ...process.env, ...environment }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) resolveRun({ stdout, stderr })
      else rejectRun(new Error(`${executable} failed with ${signal ?? `exit code ${code}`}: ${stderr.trim()}`))
    })
  })
}

function sanitizedEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:KEY|SECRET|TOKEN|PASSWORD)/i.test(name)))
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`Missing environment: ${name}`)
  return value
}

const isMain = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) await verifyTauriWindowsPackage()
