import { spawn } from 'node:child_process'
import { access, lstat, mkdir, mkdtemp, opendir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { requireHarnessBoot, requireHarnessFunctionality } from './harness-boot-audit.mjs'

export {
  requireHarnessFunctionality,
  validateHarnessAgentPresetResponse,
  validateHarnessBootHtml,
} from './harness-boot-audit.mjs'

const DESKTOP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const MAX_APP_FILES = 500
const MAX_APP_BYTES = 250 * 1024 * 1024
const MAX_PAGE_LOAD_MS = 10_000
const STARTUP_TIMEOUT_MS = 20_000
const SMOKE_EXIT_AFTER_READY_MS = 6_000

/** Resolves the host-native macOS acceptance paths. */
export function createTauriMacosVerifyPlan(input) {
  if (input.platform !== 'darwin' || input.arch !== 'arm64') {
    throw new Error(`Unsupported Tauri macOS verification target: ${input.platform}-${input.arch}; expected darwin-arm64`)
  }
  const releaseDirectory = resolve(input.desktopRoot, 'release-tauri')
  const app = join(releaseDirectory, 'DeepSeek Harness.app')
  return {
    releaseDirectory,
    app,
    executable: join(app, 'Contents/MacOS/deepseek-harness-desktop'),
    smokeExitAfterReadyMs: SMOKE_EXIT_AFTER_READY_MS,
  }
}

/** Runs packaged Tauri App and DMG acceptance on Apple Silicon. */
export async function verifyTauriMacosPackage() {
  const plan = createTauriMacosVerifyPlan({
    desktopRoot: DESKTOP_ROOT,
    platform: process.platform,
    arch: process.arch,
  })
  await access(plan.executable)
  const dmgs = (await readdir(plan.releaseDirectory)).filter(name => name.endsWith('-arm64.dmg'))
  if (dmgs.length !== 1) throw new Error(`Expected exactly one arm64 DMG, found ${dmgs.length}`)
  const payload = await summarizeAndAudit(plan.app)
  if (payload.files > MAX_APP_FILES) throw new Error(`App file count exceeded ${MAX_APP_FILES}: ${payload.files}`)
  if (payload.bytes > MAX_APP_BYTES) throw new Error(`App size exceeded ${MAX_APP_BYTES}: ${payload.bytes}`)
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', plan.app])
  const details = await run('codesign', ['-dv', '--verbose=4', plan.app])
  if (!details.stderr.includes('Signature=adhoc') || !/flags=.*runtime/.test(details.stderr)) {
    throw new Error('macOS App is not ad-hoc signed with Hardened Runtime')
  }
  const performance = await verifyLaunch(plan.executable, plan.smokeExitAfterReadyMs)
  const stats = {
    appFiles: payload.files,
    appBytes: payload.bytes,
    dmgBytes: (await stat(join(plan.releaseDirectory, dmgs[0]))).size,
    pageLoadedMs: performance.pageLoadedMs,
    shutdownMs: performance.shutdownMs,
    forcedTerminationCount: performance.forcedTerminationCount,
  }
  await writeFile(join(plan.releaseDirectory, 'verify-stats.json'), `${JSON.stringify(stats, null, 2)}\n`)
  process.stdout.write(`Tauri macOS package verification passed: ${JSON.stringify(stats)}\n`)
}

async function summarizeAndAudit(root) {
  let files = 0
  let bytes = 0
  for await (const path of walk(root)) {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) throw new Error(`Packaged App contains a symlink: ${path}`)
    if (!metadata.isFile()) continue
    files += 1
    bytes += metadata.size
    const result = await run('file', ['-b', path])
    if (result.stdout.includes('Mach-O') && !result.stdout.includes('arm64')) {
      throw new Error(`Packaged Mach-O is not arm64: ${path}: ${result.stdout.trim()}`)
    }
  }
  return { files, bytes }
}

async function verifyLaunch(executable, smokeExitAfterReadyMs) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tauri-macos-'))
  const userData = join(root, '用户 数据')
  const child = spawn(executable, [], {
    cwd: tmpdir(),
    env: {
      ...sanitizedEnvironment(),
      DSH_DESKTOP_USER_DATA_DIR: userData,
      DSH_DESKTOP_SMOKE_EXIT_AFTER_READY_MS: String(smokeExitAfterReadyMs),
    },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  try {
    const boot = verifyHarnessBoot(userData)
    const [result] = await Promise.all([
      waitForExit(child, STARTUP_TIMEOUT_MS),
      boot,
    ])
    if (result.code !== 0 || result.signal !== null) {
      throw new Error(`Packaged App exited with ${result.signal ?? `code ${result.code}`}: ${stderr.trim()}`)
    }
    await access(join(userData, 'Harness/profiles/web/cordis.yml'))
    const performance = JSON.parse(await readFile(join(userData, 'Logs/desktop-performance.json'), 'utf8'))
    if (!Number.isInteger(performance.pageLoadedMs) || performance.pageLoadedMs > MAX_PAGE_LOAD_MS) {
      throw new Error(`Desktop page load exceeded ${MAX_PAGE_LOAD_MS}ms: ${performance.pageLoadedMs}`)
    }
    if (!Number.isInteger(performance.shutdownMs) || performance.forcedTerminationCount !== 0) {
      throw new Error(`Desktop shutdown required forced termination: ${JSON.stringify(performance)}`)
    }
    return performance
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
}

async function verifyHarnessBoot(userData) {
  const logPath = join(userData, 'Logs/desktop.log')
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  let readyUrl
  while (Date.now() < deadline) {
    try {
      const log = await readFile(logPath, 'utf8')
      const matches = [...log.matchAll(/"type":"ready","url":"(http:\/\/127\.0\.0\.1:\d+\/)"/g)]
      readyUrl = matches.at(-1)?.[1]
      if (readyUrl !== undefined) break
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  if (readyUrl === undefined) throw new Error('Packaged App did not report a strict ready URL')
  await requireHarnessBoot(readyUrl, STARTUP_TIMEOUT_MS)
  const workspacePath = join(userData, '验证 工作区')
  await mkdir(workspacePath, { recursive: true })
  await requireHarnessFunctionality(readyUrl, workspacePath, STARTUP_TIMEOUT_MS)
}

async function* walk(directory) {
  const entries = await opendir(directory)
  for await (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else yield path
  }
}

async function waitForExit(child, timeoutMs) {
  return await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => rejectExit(new Error('Packaged App did not close')), timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timeout)
      rejectExit(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      resolveExit({ code, signal })
    })
  })
}

async function run(executable, args) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
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

const isMain = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) await verifyTauriMacosPackage()
