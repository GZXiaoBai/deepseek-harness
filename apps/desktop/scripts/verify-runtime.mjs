import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertRuntimeContainsNoLinks,
  assertRuntimeSymlinksContained,
  resolveCliEntryPath,
  resolveNodePtyIgnoredRelativePath,
  resolveWebFrontendIndex,
} from './stage-runtime.mjs'
import { auditX64Pe } from './pe-audit.mjs'
import { requireClosedTcpPort, terminateOwnedProcessGroup, terminateOwnedWindowsProcessTree } from './process-group.mjs'
import { runRuntimeSmokeProcess } from './runtime-smoke-process.mjs'

// Windows Defender and first-run filesystem warmup can push the first Web
// startup past the macOS deadline, so the staged runtime smoke gets its own.
const STARTUP_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 15_000
const runtimeDirectory = fileURLToPath(new URL('../.runtime/', import.meta.url))
const require = createRequire(import.meta.url)
const electronExecutable = require('electron')

const target = resolveRuntimeTarget(process.platform, process.arch)

const cliEntryPath = await resolveCliEntryPath(runtimeDirectory)
await resolveWebFrontendIndex(runtimeDirectory)
await assertRuntimeSymlinksContained(runtimeDirectory)
if (target.platform === 'win32') {
  await assertRuntimeContainsNoLinks(runtimeDirectory)
  const nodePtyIgnored = await resolveNodePtyIgnoredRelativePath(runtimeDirectory)
  await auditX64Pe(runtimeDirectory, { ignoredRelativePaths: [nodePtyIgnored] })
}

const dshHome = await mkdtemp(join(tmpdir(), 'dsh-desktop-runtime-'))
try {
  console.log('Verifying staged Electron native modules...')
  await runNativeSmoke(dshHome)
  console.log('Verifying staged CLI version...')
  await runVersion(dshHome)
  console.log('Verifying staged Web runtime...')
  await runWebSmoke(dshHome)
} finally {
  await rm(dshHome, { recursive: true })
}

console.log('Standalone Electron runtime verification passed.')

/** @param {string} dshHome */
async function runNativeSmoke(dshHome) {
  const runtimePackage = join(runtimeDirectory, 'package.json')
const script = `
const { createRequire } = require('node:module')
const { realpathSync } = require('node:fs')
const { isAbsolute, relative } = require('node:path')
const runtimeDirectory = realpathSync(${JSON.stringify(runtimeDirectory)})
const requireStagedPath = path => {
  const target = realpathSync(path)
  const fromRuntime = relative(runtimeDirectory, target)
  if (fromRuntime === '..' || fromRuntime.startsWith('../') || isAbsolute(fromRuntime)) {
    throw new Error('Native dependency resolved outside staged runtime: ' + target)
  }
  return path
}
const runtimeRequire = createRequire(${JSON.stringify(runtimePackage)})
const dshPackage = requireStagedPath(runtimeRequire.resolve('@deepseek-ai/dsh/package.json'))
const dshRequire = createRequire(dshPackage)
const basePackage = requireStagedPath(dshRequire.resolve('@deepseek-ai/dsh-base/package.json'))
const baseRequire = createRequire(basePackage)
const subprocessPackage = requireStagedPath(baseRequire.resolve('@deepseek-ai/dsh-subprocess-local/package.json'))
const subprocessRequire = createRequire(subprocessPackage)
requireStagedPath(subprocessRequire.resolve('node-pty'))
const pty = subprocessRequire('node-pty')
const webAppPackage = requireStagedPath(dshRequire.resolve('@deepseek-ai/dsh-web-app/package.json'))
const webAppRequire = createRequire(webAppPackage)
const directoryPickerPackage = requireStagedPath(webAppRequire.resolve('@deepseek-ai/dsh-host-directory-picker-native/package.json'))
const directoryPickerRequire = createRequire(directoryPickerPackage)
requireStagedPath(directoryPickerRequire.resolve('koffi'))
const koffi = directoryPickerRequire('koffi')
if (koffi.sizeof('void *') !== 8) throw new Error('Unexpected koffi pointer size')
if (process.platform === 'win32') {
  const kernel32 = koffi.load('kernel32.dll')
  const getCurrentThreadId = kernel32.func('__stdcall', 'GetCurrentThreadId', 'uint32', [])
  if (!Number.isInteger(getCurrentThreadId()) || getCurrentThreadId() < 1) {
    throw new Error('koffi could not call kernel32 GetCurrentThreadId')
  }
}
const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh'
const shellArgs = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'echo dsh-native-pty-ok']
  : ['-lc', 'printf dsh-native-pty-ok']
const terminal = pty.spawn(shell, shellArgs, {
  name: 'xterm-256color', cols: 80, rows: 24, cwd: ${JSON.stringify(runtimeDirectory)}, env: process.env,
})
let output = ''
terminal.onData(chunk => { output += chunk })
const probeTimer = setTimeout(() => {
  terminal.kill()
  process.stderr.write('node-pty did not exit within 10000ms\\n', () => process.exit(1))
}, 10000)
terminal.onExit(({ exitCode }) => {
  clearTimeout(probeTimer)
  if (exitCode !== 0) {
    process.stderr.write('node-pty exited with code ' + String(exitCode) + '\\n', () => process.exit(1))
    return
  }
  if (!output.includes('dsh-native-pty-ok')) {
    process.stderr.write('node-pty did not return probe output\\n', () => process.exit(1))
    return
  }
  process.stdout.write('Electron native modules: node-pty exercised; koffi loaded\\n', () => process.exit(0))
})
`
  const result = await runToExit(['-e', script], dshHome, 'Electron native-module smoke')
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  if (result.code !== 0 || !result.stdout.includes('Electron native modules: node-pty exercised; koffi loaded')) {
    throw new Error(`Staged native-module smoke failed with exit code ${String(result.code)}`)
  }
}

/** @param {string} dshHome */
async function runVersion(dshHome) {
  const result = await runToExit([cliEntryPath, '--version'], dshHome, 'Staged CLI --version')
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  if (result.code !== 0) {
    throw new Error(`Staged CLI --version failed with exit code ${String(result.code)}`)
  }
}

/** @param {string} dshHome */
async function runWebSmoke(dshHome) {
  const child = spawn(electronExecutable, ['--expose-internals', cliEntryPath, 'web', '--host', '127.0.0.1', '--port', '0'], {
    cwd: runtimeDirectory,
    detached: target.platform === 'darwin',
    env: runtimeEnvironment(dshHome),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(target.platform === 'win32' ? { windowsHide: true } : {}),
  })
  if (child.pid === undefined || child.stdout === null || child.stderr === null) {
    throw new Error('Electron did not create the owned Web process group')
  }

  const processGroupId = child.pid
  const exit = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  let settled = false
  const urlReady = Promise.withResolvers()
  const startupTimer = setTimeout(() => {
    if (!settled) urlReady.reject(new Error(`Staged Web runtime did not emit a URL within ${STARTUP_TIMEOUT_MS}ms`))
  }, STARTUP_TIMEOUT_MS)
  let buffered = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk)
    buffered += chunk
    let newline = buffered.indexOf('\n')
    while (newline !== -1) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      const url = parseHarnessUrl(line)
      if (url !== undefined && !settled) {
        settled = true
        clearTimeout(startupTimer)
        urlReady.resolve(url)
      }
      newline = buffered.indexOf('\n')
    }
  })
  child.stderr.on('data', chunk => process.stderr.write(chunk))
  void exit.then((result) => {
    if (!settled) {
      settled = true
      clearTimeout(startupTimer)
      urlReady.reject(new Error(
        `Staged Web runtime exited before readiness (${describeExit(result.code, result.signal)})`,
      ))
    }
  })

  let url
  try {
    url = await urlReady.promise
    const response = await fetch(url, { signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS) })
    if (response.status !== 200) {
      throw new Error(`Staged Web runtime returned HTTP ${String(response.status)} for ${url.href}`)
    }
    const html = await response.text()
    if (!/<title>\s*DeepSeek Harness\s*<\/title>/.test(html)) {
      throw new Error(`Staged Web runtime returned the wrong page title for ${url.href}`)
    }
  } finally {
    if (target.platform === 'win32') {
      await terminateOwnedWindowsProcessTree({
        leaderPid: processGroupId,
        exit,
        leaderExited: () => child.exitCode !== null || child.signalCode !== null,
      })
    } else {
      await terminateOwnedProcessGroup({
        processGroupId,
        leaderPid: processGroupId,
        exit,
        leaderExited: () => child.exitCode !== null || child.signalCode !== null,
      })
    }
    if (url !== undefined) await requireClosedTcpPort(url)
  }
}

/** @param {readonly string[]} args @param {string} dshHome @param {string} label */
async function runToExit(args, dshHome, label) {
  return await runRuntimeSmokeProcess({
    executable: electronExecutable,
    args,
    cwd: runtimeDirectory,
    environment: runtimeEnvironment(dshHome),
    platform: target.platform,
    label,
    timeoutMs: STARTUP_TIMEOUT_MS,
  })
}

/** @param {string} dshHome */
function runtimeEnvironment(dshHome) {
  return {
    ...process.env,
    DSH_HOME: dshHome,
    ELECTRON_RUN_AS_NODE: '1',
  }
}

/** @param {string} line */
function parseHarnessUrl(line) {
  const match = /^dsh web: http:\/\/127\.0\.0\.1:([0-9]+)$/.exec(line)
  if (match === null) return undefined
  const port = Number(match[1])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return new URL(`http://127.0.0.1:${port}`)
}

/** @param {number | null} code @param {NodeJS.Signals | null} signal */
function describeExit(code, signal) {
  return signal === null ? `exit code ${String(code)}` : `signal ${signal}`
}

/** @param {NodeJS.Platform} platform @param {string} arch */
function resolveRuntimeTarget(platform, arch) {
  if (platform === 'darwin' && arch === 'arm64') return { platform, arch }
  if (platform === 'win32' && arch === 'x64') return { platform, arch }
  throw new Error(`Unsupported desktop runtime verification target: ${platform}-${arch}; expected darwin-arm64 or win32-x64`)
}
