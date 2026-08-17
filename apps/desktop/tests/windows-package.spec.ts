import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

interface WindowsVerifyPlan {
  releaseDirectory: string
  unpackedDirectory: string
  unpackedExecutable: string
}

interface WindowsPackageVerifier {
  resolvePowerShellExecutable?: (environment: NodeJS.ProcessEnv) => string
  createWindowsVerifyPlan?: (input: { desktopRoot: string; platform: NodeJS.Platform; arch: string }) => WindowsVerifyPlan
  findNsisInstaller?: (releaseDirectory: string) => Promise<string>
  validateWindowsAppLayout?: (appDirectory: string) => Promise<{
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
    const root = await mkdtemp(join(tmpdir(), 'dsh-windows-layout-'))
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
})

async function createWindowsApp(appDirectory: string): Promise<string> {
  const resources = join(appDirectory, 'resources')
  const runtime = join(resources, 'runtime')
  const scope = join(runtime, 'node_modules/@deepseek-ai')
  const dsh = join(scope, 'dsh')
  const webApp = join(scope, 'dsh-web-app')
  const frontend = join(scope, 'dsh-web-frontend')
  const nestedPe = join(runtime, 'node_modules/native/addon.node')
  await mkdir(join(dsh, 'lib'), { recursive: true })
  await mkdir(webApp, { recursive: true })
  await mkdir(join(frontend, 'dist'), { recursive: true })
  await mkdir(dirname(nestedPe), { recursive: true })
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop-runtime' }))
  await writeFile(join(dsh, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    dependencies: { '@deepseek-ai/dsh-web-app': 'workspace:^' },
  }))
  await writeFile(join(dsh, 'lib/bin.js'), '')
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
