import { Worker } from 'node:worker_threads'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import DirectoryPicker from '@deepseek-ai/dsh-host-directory-picker'

/** Result emitted by the real SEA feasibility probe. */
export interface DesktopSidecarFeasibilityResult {
  nodePty: boolean
  workerThread: boolean
  koffi: boolean
  externalPlugin: boolean
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
  const [nodePty, workerThread, koffi, externalPlugin] = await Promise.all([
    probeNodePty(),
    probeWorkerThread(),
    probeKoffi(),
    probeExternalPlugin(externalPluginPath),
  ])
  return { nodePty, workerThread, koffi, externalPlugin }
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
  const plugin = await import(pathToFileURL(externalPluginPath).href) as unknown as object
  const probe: unknown = Reflect.get(plugin, 'probeDesktopPeers')
  if (typeof probe !== 'function') throw new Error('external feasibility plugin has no probeDesktopPeers export')
  const runProbe = probe as (
    this: void,
    context: typeof Context,
    directoryPicker: typeof DirectoryPicker,
  ) => Promise<unknown>
  return await runProbe(Context, DirectoryPicker) === true
}
