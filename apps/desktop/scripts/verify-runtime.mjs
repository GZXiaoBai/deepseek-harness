import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRuntimeSymlinksContained, resolveCliEntryPath, resolveWebFrontendIndex } from './stage-runtime.mjs'
import { terminateOwnedProcessGroup } from './process-group.mjs'

const STARTUP_TIMEOUT_MS = 15_000
const runtimeDirectory = fileURLToPath(new URL('../.runtime/', import.meta.url))
const require = createRequire(import.meta.url)
const electronExecutable = require('electron')

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error(`Unsupported desktop runtime verification target: ${process.platform}-${process.arch}; expected darwin-arm64`)
}

const cliEntryPath = await resolveCliEntryPath(runtimeDirectory)
await resolveWebFrontendIndex(runtimeDirectory)
await assertRuntimeSymlinksContained(runtimeDirectory)

const dshHome = await mkdtemp(join(tmpdir(), 'dsh-desktop-runtime-'))
try {
  await runNativeSmoke(dshHome)
  await runVersion(dshHome)
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
const terminal = pty.spawn('/bin/sh', ['-lc', 'printf dsh-native-pty-ok'], {
  name: 'xterm-256color', cols: 80, rows: 24, cwd: ${JSON.stringify(runtimeDirectory)}, env: process.env,
})
let output = ''
terminal.onData(chunk => { output += chunk })
terminal.onExit(({ exitCode }) => {
  if (exitCode !== 0) throw new Error('node-pty exited with code ' + String(exitCode))
  if (!output.includes('dsh-native-pty-ok')) throw new Error('node-pty did not return probe output')
  console.log('Electron native modules: node-pty exercised; koffi loaded')
})
`
  const result = await runToExit(['-e', script], dshHome)
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  if (result.code !== 0 || !result.stdout.includes('Electron native modules: node-pty exercised; koffi loaded')) {
    throw new Error(`Staged native-module smoke failed with exit code ${String(result.code)}`)
  }
}

/** @param {string} dshHome */
async function runVersion(dshHome) {
  const result = await runToExit([cliEntryPath, '--version'], dshHome)
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
    detached: true,
    env: runtimeEnvironment(dshHome),
    stdio: ['ignore', 'pipe', 'pipe'],
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
    await terminateOwnedProcessGroup({
      processGroupId,
      leaderPid: processGroupId,
      exit,
      leaderExited: () => child.exitCode !== null || child.signalCode !== null,
    })
    if (url !== undefined) await requireClosedPort(url)
  }
}

/** @param {URL} url */
async function requireClosedPort(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_000) })
  } catch (connectionError) {
    void connectionError
    return
  }
  throw new Error(`Owned Web process group stopped but its port remains open: ${url.href}`)
}

/** @param {readonly string[]} args @param {string} dshHome */
async function runToExit(args, dshHome) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(electronExecutable, args, {
      cwd: runtimeDirectory,
      env: runtimeEnvironment(dshHome),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (signal !== null) {
        rejectRun(new Error(`Staged CLI exited with signal ${signal}`))
        return
      }
      resolveRun({ code, stdout, stderr })
    })
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
