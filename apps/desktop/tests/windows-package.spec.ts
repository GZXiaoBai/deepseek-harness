import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface WindowsVerifyPlan {
  releaseDirectory: string
  unpackedDirectory: string
  unpackedExecutable: string
}

interface WindowsPackageVerifier {
  resolvePowerShellExecutable?: (environment: NodeJS.ProcessEnv) => string
  createWindowsVerifyPlan?: (input: { desktopRoot: string; platform: NodeJS.Platform; arch: string }) => WindowsVerifyPlan
  findNsisInstaller?: (releaseDirectory: string) => Promise<string>
  validateWindowsAppLayout?: (
    appDirectory: string,
    options?: { expectedNonX64Pe?: Readonly<Record<string, number>> },
  ) => Promise<{
    executable: string
    runtime: string
    peFiles: readonly string[]
  }>
  createWindowsInstallPaths?: (input: {
    localAppData: string
    appData: string
    desktopDirectory: string
  }) => {
    programsDirectory: string
    startMenuShortcut: string
    desktopShortcut: string
    userData: string
  }
  createInstalledWindowsPaths?: (input: {
    programsDirectory: string
    shortcutTarget: string
  }) => {
    installDirectory: string
    executable: string
    uninstaller: string
  }
  waitForWindowsUninstallCleanup?: (paths: readonly string[], timeoutMs: number) => Promise<void>
  observeWin32DialogWorker?: (
    worker: EventEmitter & { kill: () => boolean },
    closeThreadWindows: (threadId: number) => Promise<void>,
  ) => Promise<void>
  closeWin32DialogThread?: (
    threadId: number,
    loadKoffi: () => Promise<unknown>,
    retry?: { attempts: number; delay: () => Promise<void> },
  ) => Promise<void>
  runPackagedWin32DialogCloser?: (
    threadId: number,
    koffiEntry: string,
    internals: { executable: string; script: string; run: (...args: unknown[]) => Promise<unknown> },
  ) => Promise<void>
}

const verifierUrl = pathToFileURL(join(import.meta.dirname, '../scripts/verify-windows-package.mjs')).href
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async directory => rm(directory, { force: true, recursive: true })))
})

async function loadVerifier(): Promise<WindowsPackageVerifier> {
  try {
    return await import(verifierUrl) as WindowsPackageVerifier
  } catch {
    return {}
  }
}

describe('Windows Desktop package verification', () => {
  it('uses the requested PowerShell host while retaining the Windows inbox default', async () => {
    const verifier = await loadVerifier()
    expect(verifier.resolvePowerShellExecutable).toBeTypeOf('function')

    expect(verifier.resolvePowerShellExecutable?.({})).toBe('powershell.exe')
    expect(verifier.resolvePowerShellExecutable?.({ DSH_POWERSHELL_EXECUTABLE: 'pwsh.exe' })).toBe('pwsh.exe')
  })

  it('resolves only the native Windows x64 unpacked artifact', async () => {
    const verifier = await loadVerifier()
    expect(verifier.createWindowsVerifyPlan).toBeTypeOf('function')

    expect(verifier.createWindowsVerifyPlan?.({
      desktopRoot: 'C:\\checkout\\apps\\desktop',
      platform: 'win32',
      arch: 'x64',
    })).toEqual({
      releaseDirectory: win32.join('C:\\checkout\\apps\\desktop', 'release'),
      unpackedDirectory: win32.join('C:\\checkout\\apps\\desktop', 'release', 'win-unpacked'),
      unpackedExecutable: win32.join('C:\\checkout\\apps\\desktop', 'release', 'win-unpacked', 'DeepSeek Harness.exe'),
    })
    expect(() => verifier.createWindowsVerifyPlan?.({
      desktopRoot: 'C:\\checkout\\apps\\desktop',
      platform: 'win32',
      arch: 'arm64',
    })).toThrow('Unsupported Windows desktop package verification target: win32-arm64')
  })

  it('requires exactly one x64 NSIS installer from a clean release directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-windows-installer-'))
    directories.push(root)
    const verifier = await loadVerifier()
    expect(verifier.findNsisInstaller).toBeTypeOf('function')

    await expect(verifier.findNsisInstaller?.(root)).rejects.toThrow('Expected exactly one Windows NSIS installer, found 0')
    const installer = join(root, 'DeepSeek Harness Setup 0.1.0-rc.5-x64.exe')
    await writeFile(installer, '')
    await expect(verifier.findNsisInstaller?.(root)).resolves.toBe(installer)
    await writeFile(join(root, 'DeepSeek Harness Setup stale-x64.exe'), '')
    await expect(verifier.findNsisInstaller?.(root)).rejects.toThrow('Expected exactly one Windows NSIS installer, found 2')
  })

  it('validates ordinary runtime anchors and every x64 PE in the unpacked app', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-windows-layout-')))
    directories.push(root)
    const appDirectory = join(root, 'win-unpacked')
    const nestedPe = await createWindowsApp(appDirectory)
    const verifier = await loadVerifier()
    expect(verifier.validateWindowsAppLayout).toBeTypeOf('function')

    await expect(verifier.validateWindowsAppLayout?.(appDirectory)).resolves.toEqual({
      executable: join(appDirectory, 'DeepSeek Harness.exe'),
      runtime: join(appDirectory, 'resources/runtime'),
      peFiles: [join(appDirectory, 'DeepSeek Harness.exe'), nestedPe].sort(),
    })
  }, 30_000)

  it('rejects a Windows runtime root link before reading packaged dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-windows-runtime-link-'))
    directories.push(root)
    const appDirectory = join(root, 'win-unpacked')
    const externalRuntime = join(root, 'external-runtime')
    await createWindowsApp(appDirectory)
    await mkdir(externalRuntime)
    await rm(join(appDirectory, 'resources/runtime'), { recursive: true })
    await symlink(externalRuntime, join(appDirectory, 'resources/runtime'))
    const verifier = await loadVerifier()
    expect(verifier.validateWindowsAppLayout).toBeTypeOf('function')

    await expect(verifier.validateWindowsAppLayout?.(appDirectory)).rejects.toThrow(
      `Packaged Windows runtime must be an ordinary directory: ${join(appDirectory, 'resources/runtime')}`,
    )
  })

  it('rejects a link anywhere in the packaged Windows application', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-windows-app-link-'))
    directories.push(root)
    const appDirectory = join(root, 'win-unpacked')
    await createWindowsApp(appDirectory)
    const external = join(root, 'outside.txt')
    await writeFile(external, 'outside')
    const linkedPath = join(appDirectory, 'resources/linked.txt')
    await symlink(external, linkedPath)
    const verifier = await loadVerifier()

    await expect(verifier.validateWindowsAppLayout?.(appDirectory)).rejects.toThrow(
      `Packaged Windows application contains a filesystem link: ${linkedPath}`,
    )
  })

  it('rejects the updater elevation helper from the personal Windows package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-windows-elevate-'))
    directories.push(root)
    const appDirectory = join(root, 'win-unpacked')
    await createWindowsApp(appDirectory)
    const elevateHelper = join(appDirectory, 'resources/elevate.exe')
    await writeFile(elevateHelper, peFixture(0x8664))
    const verifier = await loadVerifier()

    await expect(verifier.validateWindowsAppLayout?.(appDirectory)).rejects.toThrow(
      `Packaged Windows application contains the forbidden elevation helper: ${elevateHelper}`,
    )
  })

  it('permits only the exact expected x86 NSIS uninstaller in an installed x64 application', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-windows-installed-layout-')))
    directories.push(root)
    const appDirectory = join(root, 'installed')
    const nestedPe = await createWindowsApp(appDirectory)
    const uninstaller = join(appDirectory, 'Uninstall DeepSeek Harness.exe')
    await writeFile(uninstaller, peFixture(0x014c))
    const verifier = await loadVerifier()

    await expect(verifier.validateWindowsAppLayout?.(appDirectory, {
      expectedNonX64Pe: { [uninstaller]: 0x014c },
    })).resolves.toEqual({
      executable: join(appDirectory, 'DeepSeek Harness.exe'),
      runtime: join(appDirectory, 'resources/runtime'),
      peFiles: [join(appDirectory, 'DeepSeek Harness.exe'), nestedPe].sort(),
    })
  }, 30_000)

  it('rejects any additional x86 PE beside the exact NSIS uninstaller exception', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-windows-installed-rogue-pe-')))
    directories.push(root)
    const appDirectory = join(root, 'installed')
    await createWindowsApp(appDirectory)
    const uninstaller = join(appDirectory, 'Uninstall DeepSeek Harness.exe')
    const rogue = join(appDirectory, 'resources/rogue.exe')
    await writeFile(uninstaller, peFixture(0x014c))
    await writeFile(rogue, peFixture(0x014c))
    const verifier = await loadVerifier()

    await expect(verifier.validateWindowsAppLayout?.(appDirectory, {
      expectedNonX64Pe: { [uninstaller]: 0x014c },
    })).rejects.toThrow(`Windows x64 artifact contains a non-x64 PE file: ${rogue} (0x014c)`)
  })

  it('rejects a declared NSIS exception when its reviewed machine type changes', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-windows-changed-uninstaller-')))
    directories.push(root)
    const appDirectory = join(root, 'installed')
    await createWindowsApp(appDirectory)
    const uninstaller = join(appDirectory, 'Uninstall DeepSeek Harness.exe')
    await writeFile(uninstaller, peFixture(0x8664))
    const verifier = await loadVerifier()

    await expect(verifier.validateWindowsAppLayout?.(appDirectory, {
      expectedNonX64Pe: { [uninstaller]: 0x014c },
    })).rejects.toThrow(
      `Expected reviewed non-x64 PE file was missing or changed: ${uninstaller} (0x014c)`,
    )
  })

  it('derives the per-user install, shortcut, and preserved data paths', async () => {
    const verifier = await loadVerifier()
    expect(verifier.createWindowsInstallPaths).toBeTypeOf('function')

    expect(verifier.createWindowsInstallPaths?.({
      localAppData: 'C:\\Users\\me\\AppData\\Local',
      appData: 'C:\\Users\\me\\AppData\\Roaming',
      desktopDirectory: 'C:\\Users\\me\\Desktop',
    })).toEqual({
      programsDirectory: 'C:\\Users\\me\\AppData\\Local\\Programs',
      startMenuShortcut: 'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\DeepSeek Harness.lnk',
      desktopShortcut: 'C:\\Users\\me\\Desktop\\DeepSeek Harness.lnk',
      userData: 'C:\\Users\\me\\AppData\\Roaming\\DeepSeek Harness',
    })
  })

  it('derives the actual per-user install directory from the Start Menu shortcut target', async () => {
    const verifier = await loadVerifier()
    expect(verifier.createInstalledWindowsPaths).toBeTypeOf('function')

    expect(verifier.createInstalledWindowsPaths?.({
      programsDirectory: 'C:\\Users\\me\\AppData\\Local\\Programs',
      shortcutTarget: 'C:\\Users\\me\\AppData\\Local\\Programs\\@deepseek-aidsh-desktop\\DeepSeek Harness.exe',
    })).toEqual({
      installDirectory: 'C:\\Users\\me\\AppData\\Local\\Programs\\@deepseek-aidsh-desktop',
      executable: 'C:\\Users\\me\\AppData\\Local\\Programs\\@deepseek-aidsh-desktop\\DeepSeek Harness.exe',
      uninstaller: 'C:\\Users\\me\\AppData\\Local\\Programs\\@deepseek-aidsh-desktop\\Uninstall DeepSeek Harness.exe',
    })
  })

  it('rejects a shortcut target outside the current-user Programs directory', async () => {
    const verifier = await loadVerifier()

    expect(() => verifier.createInstalledWindowsPaths?.({
      programsDirectory: 'C:\\Users\\me\\AppData\\Local\\Programs',
      shortcutTarget: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
    })).toThrow('NSIS shortcut target is outside the current-user Programs directory')
  })

  it('rejects a shortcut target with the wrong application executable', async () => {
    const verifier = await loadVerifier()

    expect(() => verifier.createInstalledWindowsPaths?.({
      programsDirectory: 'C:\\Users\\me\\AppData\\Local\\Programs',
      shortcutTarget: 'C:\\Users\\me\\AppData\\Local\\Programs\\DeepSeek Harness\\other.exe',
    })).toThrow('NSIS shortcut target does not name DeepSeek Harness.exe')
  })

  it('waits for every asynchronously removed NSIS path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-windows-uninstall-cleanup-'))
    directories.push(root)
    const installDirectory = join(root, 'application')
    const shortcut = join(root, 'DeepSeek Harness.lnk')
    await mkdir(installDirectory)
    await writeFile(shortcut, 'shortcut')
    const verifier = await loadVerifier()
    expect(verifier.waitForWindowsUninstallCleanup).toBeTypeOf('function')

    const cleanup = verifier.waitForWindowsUninstallCleanup?.([installDirectory, shortcut], 1_000)
    await rm(installDirectory, { recursive: true })
    await new Promise(resolve => setTimeout(resolve, 100))
    await rm(shortcut)

    await expect(cleanup).resolves.toBeUndefined()
  })

  it('rejects an NSIS path that remains after the cleanup deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-windows-uninstall-residue-'))
    directories.push(root)
    const shortcut = join(root, 'DeepSeek Harness.lnk')
    await writeFile(shortcut, 'shortcut')
    const verifier = await loadVerifier()
    expect(verifier.waitForWindowsUninstallCleanup).toBeTypeOf('function')

    await expect(verifier.waitForWindowsUninstallCleanup?.([shortcut], 20)).rejects.toThrow(
      `Windows uninstall did not remove: ${shortcut}`,
    )
  })

  it('accepts a packaged dialog worker only after its terminal cancel result', async () => {
    const verifier = await loadVerifier()
    expect(verifier.observeWin32DialogWorker).toBeTypeOf('function')
    const worker = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) })
    const closeThreadWindows = vi.fn(async () => undefined)

    const observed = verifier.observeWin32DialogWorker?.(worker, closeThreadWindows)
    worker.emit('message', { kind: 'showing', threadId: 42 })
    await vi.waitFor(() => { expect(closeThreadWindows).toHaveBeenCalledWith(42) })
    worker.emit('message', { kind: 'done', path: null })
    worker.emit('exit', 0, null)

    await expect(observed).resolves.toBeUndefined()
    expect(worker.kill).not.toHaveBeenCalled()
  })

  it('rejects a packaged dialog worker that exits without a terminal result', async () => {
    const verifier = await loadVerifier()
    expect(verifier.observeWin32DialogWorker).toBeTypeOf('function')
    const worker = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) })

    const observed = verifier.observeWin32DialogWorker?.(worker, async () => undefined)
    worker.emit('exit', 0, null)

    await expect(observed).rejects.toThrow('Packaged Win32 dialog worker exited before reporting a terminal result')
  })

  it('closes the packaged dialog through the same Win32 calls as production', async () => {
    const verifier = await loadVerifier()
    expect(verifier.closeWin32DialogThread).toBeTypeOf('function')
    const posted = vi.fn()
    const unregistered = vi.fn()
    const callback = { invoke: (_window: unknown) => 1 }
    const enumWindows = vi.fn((_threadId: number, registered: typeof callback) => {
      registered.invoke({ handle: 7 })
      return 1
    })
    const koffi = fakeKoffi(enumWindows, posted, callback, unregistered)

    await verifier.closeWin32DialogThread?.(42, async () => koffi, {
      attempts: 2,
      delay: async () => undefined,
    })

    expect(enumWindows).toHaveBeenCalledTimes(2)
    expect(posted).toHaveBeenCalledTimes(2)
    expect(posted).toHaveBeenCalledWith({ handle: 7 }, 0x10, 0, 0)
    expect(unregistered).toHaveBeenCalledWith(callback)
  })

  it('retries native enumeration when the dialog window races its progress notice', async () => {
    const verifier = await loadVerifier()
    expect(verifier.closeWin32DialogThread).toBeTypeOf('function')
    const posted = vi.fn()
    const callback = { invoke: (_window: unknown) => 1 }
    let enumeration = 0
    const enumWindows = vi.fn((_threadId: number, registered: typeof callback) => {
      enumeration += 1
      if (enumeration === 2) registered.invoke({ handle: 9 })
      return 1
    })
    const koffi = fakeKoffi(enumWindows, posted, callback, vi.fn())
    const delay = vi.fn(async () => undefined)

    await verifier.closeWin32DialogThread?.(43, async () => koffi, { attempts: 2, delay })

    expect(enumWindows).toHaveBeenCalledTimes(2)
    expect(delay).toHaveBeenCalledOnce()
    expect(posted).toHaveBeenCalledWith({ handle: 9 }, 0x10, 0, 0)
  })

  it('rejects native dialog closure when the worker thread never creates a window', async () => {
    const verifier = await loadVerifier()
    expect(verifier.closeWin32DialogThread).toBeTypeOf('function')
    const enumWindows = vi.fn(() => 1)
    const koffi = fakeKoffi(enumWindows, vi.fn(), { invoke: () => 1 }, vi.fn())

    await expect(verifier.closeWin32DialogThread?.(45, async () => koffi, {
      attempts: 1,
      delay: async () => undefined,
    })).rejects.toThrow('did not create a window for thread 45')
  })

  it('runs packaged native dialog closure in a process that releases koffi before cleanup', async () => {
    const verifier = await loadVerifier()
    expect(verifier.runPackagedWin32DialogCloser).toBeTypeOf('function')
    const run = vi.fn(async () => ({ code: 0, signal: null }))

    await verifier.runPackagedWin32DialogCloser?.(44, 'C:\runtime\koffi\index.js', {
      executable: 'C:\node.exe',
      script: 'C:\verify\close-win32-dialog.mjs',
      run,
    })

    expect(run).toHaveBeenCalledWith(
      'C:\node.exe',
      ['C:\verify\close-win32-dialog.mjs', 'C:\runtime\koffi\index.js', '44'],
      { windowsHide: true },
    )
  })
})

function fakeKoffi(
  enumWindows: (threadId: number, callback: { invoke: (window: unknown) => number }, lparam: number) => number,
  postMessage: (...args: unknown[]) => unknown,
  callback: { invoke: (window: unknown) => number },
  unregister: (callback: unknown) => unknown,
): unknown {
  return {
    load: () => ({
      func: (_convention: string, name: string) => name === 'EnumThreadWindows' ? enumWindows : postMessage,
    }),
    proto: () => ({ kind: 'prototype' }),
    pointer: (value: unknown) => value,
    register: (handler: (window: unknown) => number) => {
      callback.invoke = handler
      return callback
    },
    unregister,
  }
}

async function createWindowsApp(appDirectory: string): Promise<string> {
  const resources = join(appDirectory, 'resources')
  const runtime = join(resources, 'runtime')
  const scope = join(runtime, 'node_modules/@deepseek-ai')
  const dsh = join(scope, 'dsh')
  const base = join(scope, 'dsh-base')
  const subprocess = join(scope, 'dsh-subprocess-local')
  const webApp = join(scope, 'dsh-web-app')
  const frontend = join(scope, 'dsh-web-frontend')
  const nodePty = join(runtime, 'node_modules/node-pty')
  const nestedPe = join(runtime, 'node_modules/native/addon.node')
  await mkdir(join(dsh, 'lib'), { recursive: true })
  await mkdir(base, { recursive: true })
  await mkdir(subprocess, { recursive: true })
  await mkdir(webApp, { recursive: true })
  await mkdir(join(frontend, 'dist'), { recursive: true })
  await mkdir(join(nodePty, 'prebuilds/win32-x64'), { recursive: true })
  await mkdir(dirname(nestedPe), { recursive: true })
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop-runtime' }))
  await writeFile(join(dsh, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    dependencies: {
      '@deepseek-ai/dsh-base': 'workspace:^',
      '@deepseek-ai/dsh-web-app': 'workspace:^',
    },
  }))
  await writeFile(join(dsh, 'lib/bin.js'), '')
  await writeFile(join(base, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-base',
    dependencies: { '@deepseek-ai/dsh-subprocess-local': 'workspace:^' },
  }))
  await writeFile(join(subprocess, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-subprocess-local',
    dependencies: { 'node-pty': '1.2.0-beta.15' },
  }))
  await writeFile(join(nodePty, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.2.0-beta.15' }))
  await writeFile(join(webApp, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-web-app',
    dependencies: { '@deepseek-ai/dsh-web-frontend': 'workspace:^' },
  }))
  await writeFile(join(frontend, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-web-frontend',
    exports: { './dist/*': './dist/*' },
  }))
  await writeFile(join(frontend, 'dist/index.html'), '<title>DeepSeek Harness</title>')
  await writeFile(join(resources, 'app.asar'), 'asar')
  await writeFile(join(appDirectory, 'DeepSeek Harness.exe'), peFixture(0x8664))
  await writeFile(nestedPe, peFixture(0x8664))
  return nestedPe
}

function peFixture(machine: number): Buffer {
  const bytes = Buffer.alloc(0x90)
  bytes.write('MZ', 0, 'ascii')
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.write('PE\0\0', 0x80, 'binary')
  bytes.writeUInt16LE(machine, 0x84)
  return bytes
}
