import { Worker } from 'node:worker_threads'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import DirectoryPicker from '@deepseek-ai/dsh-host-directory-picker'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node'

/** Result emitted by the real SEA feasibility probe. */
export interface DesktopSidecarFeasibilityResult {
  nodePty: boolean
  workerThread: boolean
  koffi: boolean
  externalPlugin: boolean
  ptcProcess: boolean
}

const WINDOWS_PTY_ENVIRONMENT_KEYS = [
  'ComSpec',
  'Path',
  'PATHEXT',
  'SystemDrive',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
] as const

/** Returns the minimal inherited environment required by Windows CreateProcessW. */
export function createPtyProbeEnvironment(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (platform !== 'win32') return {}
  const selected: NodeJS.ProcessEnv = {}
  for (const key of WINDOWS_PTY_ENVIRONMENT_KEYS) {
    const value = environment[key]
    if (value !== undefined) selected[key] = value
  }
  return selected
}

/** Appends one PTY output chunk and reports whether the real probe marker is complete. */
export function appendPtyProbeOutput(
  output: string,
  data: string,
): { output: string; complete: boolean } {
  const combined = output + data
  return { output: combined, complete: combined.includes('DSH_PTY_OK') }
}

/** Exercises native modules, VFS workers, and a disk plugin from inside the SEA. */
export async function runDesktopSidecarFeasibilityProbe(
  externalPluginPath: string,
): Promise<DesktopSidecarFeasibilityResult> {
  const [nodePty, workerThread, koffi, externalPlugin, ptcProcess] = await Promise.all([
    probeNodePty(),
    probeWorkerThread(),
    probeKoffi(),
    probeExternalPlugin(externalPluginPath),
    probePtcProcess(),
  ])
  return { nodePty, workerThread, koffi, externalPlugin, ptcProcess }
}

/**
 * Executes a real TypeScript child with a host binding and waits for its disposal.
 * @returns True after the child returns 42 and its process has exited.
 */
export async function probePtcProcess(): Promise<boolean> {
  const ctx = new Context()
  let childPid: number
  try {
    await ctx.plugin(SessionProjections)
    await ctx.plugin(FileSystem)
    await ctx.plugin(Subprocess)
    await ctx.plugin(Sandbox, {})
    await ctx.plugin(SandboxPolicy, { mode: 'read-only' })
    await ctx.plugin(NodePtcRuntime, {})
    const result = await ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({
      program: 'const answer: number = await tools.double(21); return { answer, pid: process.pid };',
      timeoutMs: 10_000,
      bindings: [{
        global: 'tools',
        functions: {
          double: (value) => {
            if (typeof value !== 'number') throw new Error('PTC probe binding requires a number')
            return Promise.resolve(value * 2)
          },
        },
      }],
    }))
    const value = result.value
    if (result.error !== undefined || value === null || typeof value !== 'object' || Array.isArray(value)
      || value.answer !== 42 || typeof value.pid !== 'number' || value.pid === process.pid) {
      throw new Error(`Desktop PTC process probe failed: ${JSON.stringify(result)}`)
    }
    childPid = value.pid
  } finally {
    await ctx.fiber.dispose()
  }
  try {
    process.kill(childPid, 0)
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true
    throw error
  }
  throw new Error(`Desktop PTC process probe left child ${childPid} running`)
}

async function probeNodePty(): Promise<boolean> {
  const pty = await import('node-pty')
  const environment = createPtyProbeEnvironment(process.platform, process.env)
  const executable = process.platform === 'win32'
    ? environment.ComSpec ?? 'cmd.exe'
    : '/bin/sh'
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'echo DSH_PTY_OK']
    : ['-lc', 'printf DSH_PTY_OK']
  return await new Promise<boolean>((resolve, reject) => {
    const terminal = pty.spawn(executable, args, {
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: environment,
    })
    let output = ''
    let settled = false
    terminal.onData((data) => {
      const state = appendPtyProbeOutput(output, data)
      output = state.output
      if (!state.complete || settled) return
      settled = true
      try {
        terminal.kill()
      } catch (error) {
        reject(new Error(`node-pty probe cleanup failed: ${String(error)}`))
        return
      }
      resolve(true)
    })
    terminal.onExit(({ exitCode }) => {
      if (settled) return
      settled = true
      if (exitCode === 0 && output.includes('DSH_PTY_OK')) resolve(true)
      else reject(new Error(`node-pty probe failed with exit ${exitCode}: ${output}`))
    })
  })
}

async function probeWorkerThread(): Promise<boolean> {
  const entry = fileURLToPath(new URL('../sidecar/feasibility-worker.cjs', import.meta.url))
  return await new Promise<boolean>((resolve, reject) => {
    const worker = new Worker(entry, { env: {}, execArgv: [] })
    worker.once('message', (message: unknown) => {
      void worker.terminate()
      resolve(
        message !== null
          && typeof message === 'object'
          && Reflect.get(message, 'workerThread') === true,
      )
    })
    worker.once('error', reject)
  })
}

async function probeKoffi(): Promise<boolean> {
  const koffi = (await import('koffi')).default
  const libraryPath = process.platform === 'win32' ? 'kernel32.dll' : '/usr/lib/libSystem.B.dylib'
  const symbol = process.platform === 'win32' ? 'GetCurrentProcessId' : 'getpid'
  const library = koffi.load(libraryPath)
  try {
    const getProcessId = library.func(`uint32 ${symbol}()`) as () => number
    return getProcessId() === process.pid
  } finally {
    library.unload()
  }
}

async function probeExternalPlugin(externalPluginPath: string): Promise<boolean> {
  const plugin = await import(pathToFileURL(externalPluginPath).href) as object
  const probe: unknown = Reflect.get(plugin, 'probeDesktopPeers')
  if (typeof probe !== 'function') throw new Error('external feasibility plugin has no probeDesktopPeers export')
  const runProbe = probe as (
    this: void,
    context: typeof Context,
    directoryPicker: typeof DirectoryPicker,
  ) => Promise<unknown>
  return await runProbe(Context, DirectoryPicker) === true
}
