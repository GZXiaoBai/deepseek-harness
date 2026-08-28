import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const verifier = await import(
  pathToFileURL(join(import.meta.dirname, '../scripts/verify-tauri-windows.mjs')).href,
) as {
  createTauriWindowsInstallPaths: (input: { appData: string; desktopDirectory: string }) => Record<string, string>
  createTauriWindowsVerifyPlan: (input: { desktopRoot: string; platform: string; arch: string }) => Record<string, string>
  findTauriNsisInstaller: (releaseDirectory: string) => Promise<string>
  parseTauriDirectoryPickerRequests: (text: string) => string[]
  parseTauriDesktopLifecycle: (text: string) => { pid: number; startCount: number; url: URL }
  requireNativeDirectoryPicker: (
    url: URL,
    userData: string,
    desktopPid: number,
    fetchImpl?: typeof fetch,
    closeDialog?: (pid: number) => Promise<void>,
  ) => Promise<void>
  waitForTauriLifecycleOrExit: <T>(
    lifecycle: Promise<T>,
    exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
    output: () => { stdout: string; stderr: string },
  ) => Promise<T>
  validatePerformanceStats: <T>(value: T, pageLoadLimitMs: number) => T
}

const {
  createTauriWindowsInstallPaths,
  createTauriWindowsVerifyPlan,
  findTauriNsisInstaller,
  parseTauriDirectoryPickerRequests,
  parseTauriDesktopLifecycle,
  requireNativeDirectoryPicker,
  waitForTauriLifecycleOrExit,
  validatePerformanceStats,
} = verifier

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async path => rm(path, { recursive: true, force: true })))
})

describe('Tauri Windows package verification', () => {
  it('accepts only the native x64 Tauri output', () => {
    expect(createTauriWindowsVerifyPlan({
      desktopRoot: 'C:\\checkout\\apps\\desktop', platform: 'win32', arch: 'x64',
    })).toEqual({
      releaseDirectory: win32.join('C:\\checkout\\apps\\desktop', 'release-tauri'),
      unpackedDirectory: win32.join('C:\\checkout\\apps\\desktop', 'release-tauri', 'win-unpacked'),
      unpackedExecutable: win32.join('C:\\checkout\\apps\\desktop', 'release-tauri', 'win-unpacked', 'DeepSeek Harness.exe'),
    })
    expect(() => createTauriWindowsVerifyPlan({
      desktopRoot: 'C:\\checkout\\apps\\desktop', platform: 'win32', arch: 'arm64',
    })).toThrow(/expected win32-x64/)
  })

  it('requires exactly one compatibly named installer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-tauri-nsis-'))
    directories.push(directory)
    await expect(findTauriNsisInstaller(directory)).rejects.toThrow(/found 0/)
    const installer = join(directory, 'DeepSeek Harness Setup 0.1.1-rc.1-x64.exe')
    await writeFile(installer, '')
    await expect(findTauriNsisInstaller(directory)).resolves.toBe(installer)
    await writeFile(join(directory, 'stale.exe'), '')
    await expect(findTauriNsisInstaller(directory)).rejects.toThrow(/found 2/)
  })

  it('derives current-user shortcuts and preserved application data', () => {
    expect(createTauriWindowsInstallPaths({
      appData: 'C:\\Users\\me\\AppData\\Roaming',
      desktopDirectory: 'C:\\Users\\me\\Desktop',
    })).toEqual({
      startMenuShortcut: win32.join('C:\\Users\\me\\AppData\\Roaming', 'Microsoft/Windows/Start Menu/Programs/DeepSeek Harness.lnk'),
      desktopShortcut: win32.join('C:\\Users\\me\\Desktop', 'DeepSeek Harness.lnk'),
      userData: win32.join('C:\\Users\\me\\AppData\\Roaming', 'DeepSeek Harness'),
    })
  })

  it('parses only strict sidecar lifecycle frames from the tab-separated desktop log', () => {
    const log = [
      '1\tdesktop\tsidecar spawned pid=1234',
      '2\tsidecar-stdout\tplugin noise',
      '3\tsidecar-stdout\tDSH_DESKTOP/1 {"type":"ready","url":"http://127.0.0.1:43210/?token=abc_123-XYZ"}',
    ].join('\n')
    expect(parseTauriDesktopLifecycle(log)).toEqual({
      pid: 1234,
      startCount: 1,
      url: new URL('http://127.0.0.1:43210/?token=abc_123-XYZ'),
    })
    expect(() => parseTauriDesktopLifecycle(log.replace('127.0.0.1', 'localhost'))).toThrow(/strict loopback/)
    expect(() => parseTauriDesktopLifecycle(log.replace('abc_123-XYZ', 'one&next=two'))).toThrow(/strict loopback/)
  })

  it('finds only versioned desktop directory-picker requests', () => {
    const log = [
      '1\tsidecar-stdout\tplugin directory-picker-request noise',
      '2\tsidecar-stdout\tDSH_DESKTOP/1 {"type":"directory-picker-request","requestId":"picker-1"}',
      '3\tsidecar-stdout\tDSH_DESKTOP/1 {"type":"directory-picker-result","requestId":"picker-1","path":null}',
    ].join('\n')
    expect(parseTauriDirectoryPickerRequests(log)).toEqual(['picker-1'])
  })

  it('requires the boot session cookie on the native directory-picker probe', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'dsh-tauri-picker-'))
    directories.push(userData)
    await mkdir(join(userData, 'Logs'), { recursive: true })
    await writeFile(
      join(userData, 'Logs/desktop.log'),
      '1\tsidecar-stdout\tDSH_DESKTOP/1 {"type":"directory-picker-request","requestId":"picker-1"}\n',
    )
    const seen: Array<{ url: string; cookie: string | null; body: unknown }> = []
    const waitForLogRequest = async () => {
      const logPath = join(userData, 'Logs/desktop.log')
      for (let waited = 0; waited < 2_000; waited += 10) {
        const requests = parseTauriDirectoryPickerRequests(await readFile(logPath, 'utf8'))
        if (requests.length > 0) return
        await new Promise(resolveDelay => setTimeout(resolveDelay, 10))
      }
      throw new Error('test stub never observed the desktop directory-picker request')
    }
    const rejectingFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      seen.push({ url, cookie: headers.get('cookie'), body: JSON.parse(String(init?.body)) })
      if (headers.get('cookie') === null) return new Response('dsh web authentication required', { status: 401 })
      /* The real Host holds the RPC until the native parent reports the dialog result, so the
         stub answers strictly after the delegation frame it observed is on record. */
      await waitForLogRequest()
      await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
      return Response.json({
        type: 'server-response',
        rpcId: 'desktop-verify-host.pickDirectory',
        result: { ok: true, value: { path: null } },
      })
    }
    const bootFetch: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('cookie', 'dsh-auth-session=signed')
      return rejectingFetch(input, { ...init, headers })
    }
    const probe = (fetchImpl: typeof fetch) => requireNativeDirectoryPicker(
      new URL('http://127.0.0.1:43127/'),
      userData,
      process.pid,
      fetchImpl,
      async () => {},
    )

    await probe(bootFetch)
    expect(seen).toEqual([{
      url: 'http://127.0.0.1:43127/api/host.pickDirectory',
      cookie: 'dsh-auth-session=signed',
      body: {
        type: 'client-request',
        rpcId: 'desktop-verify-host.pickDirectory',
        method: 'host.pickDirectory',
        payload: {},
      },
    }])
    await expect(probe(rejectingFetch)).rejects.toThrow(/HTTP 401/)
  })

  it('reports process output when the native shell exits before creating its log', async () => {
    const lifecycle = new Promise<never>(() => {})
    await expect(waitForTauriLifecycleOrExit(
      lifecycle,
      Promise.resolve({ code: 101, signal: null }),
      () => ({ stdout: 'native stdout', stderr: 'webview startup failed' }),
    )).rejects.toThrow(/exit code 101[\s\S]*native stdout[\s\S]*webview startup failed/)
  })

  it('enforces the CI page-ready threshold and graceful exit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-tauri-performance-'))
    directories.push(directory)
    await mkdir(join(directory, 'Logs'))
    const stats = {
      processStartMs: 0,
      sidecarSpawnMs: 5,
      pluginTreeReadyMs: 900,
      httpReadyMs: 950,
      pageLoadedMs: 1100,
      shutdownMs: 1200,
      forcedTerminationCount: 0,
    }
    expect(validatePerformanceStats(stats, 10_000)).toEqual(stats)
    expect(() => validatePerformanceStats({ ...stats, pageLoadedMs: 10_001 }, 10_000)).toThrow(
      /page load[\s\S]*"httpReadyMs":950/,
    )
    expect(() => validatePerformanceStats({ ...stats, forcedTerminationCount: 1 }, 10_000)).toThrow(/forced termination/)
  })
})
