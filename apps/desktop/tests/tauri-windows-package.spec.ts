import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  parseTauriDesktopLifecycle: (text: string) => { pid: number; startCount: number; url: URL }
  validatePerformanceStats: <T>(value: T, pageLoadLimitMs: number) => T
}

const {
  createTauriWindowsInstallPaths,
  createTauriWindowsVerifyPlan,
  findTauriNsisInstaller,
  parseTauriDesktopLifecycle,
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
    const installer = join(directory, 'DeepSeek Harness Setup 0.1.0-rc.8-x64.exe')
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
      '3\tsidecar-stdout\tDSH_DESKTOP/1 {"type":"ready","url":"http://127.0.0.1:43210/"}',
    ].join('\n')
    expect(parseTauriDesktopLifecycle(log)).toEqual({ pid: 1234, startCount: 1, url: new URL('http://127.0.0.1:43210/') })
    expect(() => parseTauriDesktopLifecycle(log.replace('127.0.0.1', 'localhost'))).toThrow(/strict loopback/)
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
