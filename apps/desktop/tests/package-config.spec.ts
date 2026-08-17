import { chmod, cp, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const desktopRoot = join(import.meta.dirname, '..')
const packageScriptUrl = pathToFileURL(join(desktopRoot, 'scripts/package.mjs')).href
const verifyPackageScriptUrl = pathToFileURL(join(desktopRoot, 'scripts/verify-package.mjs')).href
const afterPackScriptUrl = pathToFileURL(join(desktopRoot, 'scripts/after-pack.mjs')).href
const concurrencyProbe = join(import.meta.dirname, 'fixtures/osx-sign-concurrency.cjs')
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async directory => rm(directory, { force: true, recursive: true })))
})

interface PackageCommand {
  executable: string
  args: readonly string[]
  cwd: string
  environment?: Readonly<Record<string, string>>
}

interface PackagePlan {
  repoRoot: string
  releaseDirectory: string
  commands: readonly PackageCommand[]
}

interface PackageModule {
  createPackagePlan(input: { repoRoot: string; platform: NodeJS.Platform; arch: string; pnpmEntrypoint?: string }): PackagePlan
  executePackagePlan(plan: PackagePlan, options: { runCommand(command: PackageCommand): Promise<void> }): Promise<void>
}

interface VerifyPackageModule {
  createVerifyPlan(input: { desktopRoot: string; platform: NodeJS.Platform; arch: string }): {
    appPath: string
    releaseDirectory: string
  }
  findDmg(releaseDirectory: string): Promise<string>
  readLifecycleSnapshot(logPath: string): Promise<{ backendPid: number; url: URL; startCount: number }>
  createStandaloneDataPaths(temporaryRoot: string): {
    userData: string
    harnessData: string
    logPath: string
    singletonSocket: string
  }
  validateAppBundleLayout(appPath: string): Promise<unknown>
  verifyAppCodeSignatures(appPath: string, machOFiles: readonly string[], options: {
    runCommand(executable: string, args: readonly string[], options?: { input?: string }): Promise<{
      code: number
      signal: null
      stdout: string
      stderr: string
    }>
  }): Promise<readonly string[]>
  copyAndVerifyStandaloneApp(sourceApp: string, copiedApp: string, options?: {
    copyApp(source: string, destination: string): Promise<void>
  }): Promise<void>
}

interface AfterPackPlan {
  desktopRoot: string
  sourceRuntime: string
  appPath: string
  destinationRuntime: string
  target?: { platform: 'darwin'; arch: 'arm64' } | { platform: 'win32'; arch: 'x64' }
}

interface AfterPackModule {
  createAfterPackPlan(input: {
    desktopRoot: string
    electronPlatformName: string
    arch: number
    appOutDir: string
  }): AfterPackPlan
  copyRuntimeForPackage(plan: AfterPackPlan, options?: {
    copyRuntime(source: string, destination: string): Promise<void>
  }): Promise<void>
}

async function loadPackageModule(): Promise<PackageModule> {
  return await import(packageScriptUrl) as PackageModule
}

async function loadVerifyPackageModule(): Promise<VerifyPackageModule> {
  return await import(verifyPackageScriptUrl) as VerifyPackageModule
}

async function loadAfterPackModule(): Promise<AfterPackModule> {
  return await import(afterPackScriptUrl) as AfterPackModule
}

interface BuilderConfig {
  appId?: string
  productName?: string
  asar?: boolean
  files?: string[]
  extraResources?: Array<{ from?: string; to?: string }>
  afterPack?: string
  publish?: unknown
  mac?: {
    target?: Array<{ target?: string; arch?: string[] }>
    minimumSystemVersion?: string
    identity?: string
    hardenedRuntime?: boolean
    entitlements?: string
    entitlementsInherit?: string
    notarize?: unknown
  }
  win?: {
    icon?: string
    target?: Array<{ target?: string; arch?: string[] }>
  }
  nsis?: {
    artifactName?: string
    oneClick?: boolean
    perMachine?: boolean
    allowElevation?: boolean
    createStartMenuShortcut?: boolean
    createDesktopShortcut?: boolean
    runAfterFinish?: boolean
    deleteAppDataOnUninstall?: boolean
    packElevateHelper?: boolean
  }
}

describe('desktop package configuration', () => {
  it('wraps the generated 256px PNG as a Windows icon image', async () => {
    const packageModule = await import(packageScriptUrl) as Record<string, unknown>
    const createWindowsIco = Reflect.get(packageModule, 'createWindowsIco') as
      | ((png: Buffer) => Buffer)
      | undefined
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42])

    expect(createWindowsIco).toBeTypeOf('function')
    const icon = createWindowsIco?.(png)

    expect(icon?.readUInt16LE(0)).toBe(0)
    expect(icon?.readUInt16LE(2)).toBe(1)
    expect(icon?.readUInt16LE(4)).toBe(1)
    expect(icon?.subarray(6, 8)).toEqual(Buffer.from([0, 0]))
    expect(icon?.readUInt16LE(10)).toBe(1)
    expect(icon?.readUInt16LE(12)).toBe(32)
    expect(icon?.readUInt32LE(14)).toBe(png.length)
    expect(icon?.readUInt32LE(18)).toBe(22)
    expect(icon?.subarray(22)).toEqual(png)
  })

  it('builds only a private arm64 App and DMG with the staged runtime', async () => {
    const config = parse(await readFile(join(desktopRoot, 'electron-builder.yml'), 'utf8')) as BuilderConfig

    expect(config).toMatchObject({
      appId: 'ai.deepseek.harness',
      productName: 'DeepSeek Harness',
      asar: true,
      files: ['lib/*.js', 'static/**'],
      afterPack: 'scripts/after-pack.mjs',
      publish: null,
      mac: {
        target: [
          { target: 'dmg', arch: ['arm64'] },
          { target: 'dir', arch: ['arm64'] },
        ],
        minimumSystemVersion: '14.0',
        identity: '-',
        hardenedRuntime: true,
        entitlements: 'build/entitlements.mac.plist',
        entitlementsInherit: 'build/entitlements.mac.plist',
        notarize: false,
      },
    })
    expect(config.extraResources).toBeUndefined()
    expect(JSON.stringify(config)).not.toMatch(/updat|notarytool|developer id/i)
  })

  it('grants only the native-code entitlements required by the Electron runtime', async () => {
    const entitlements = await readFile(join(desktopRoot, 'build/entitlements.mac.plist'), 'utf8')
    const enabledKeys = [...entitlements.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map(match => match[1])

    expect(enabledKeys).toEqual([
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.disable-library-validation',
    ])
  })

  it('builds an unsigned one-click per-user Windows x64 NSIS installer', async () => {
    const config = parse(await readFile(join(desktopRoot, 'electron-builder.yml'), 'utf8')) as BuilderConfig

    expect(config).toMatchObject({
      win: {
        icon: 'build/icon.ico',
        target: [
          { target: 'nsis', arch: ['x64'] },
          { target: 'dir', arch: ['x64'] },
        ],
      },
      nsis: {
        artifactName: 'DeepSeek Harness Setup ${version}-${arch}.${ext}',
        oneClick: true,
        perMachine: false,
        allowElevation: false,
        createStartMenuShortcut: true,
        createDesktopShortcut: false,
        runAfterFinish: false,
        deleteAppDataOnUninstall: false,
        packElevateHelper: false,
      },
    })
    expect(JSON.stringify(config.win)).not.toMatch(/certificate|sign/i)
  })

  it.each([
    ['linux', 'arm64'],
    ['darwin', 'x64'],
    ['win32', 'arm64'],
  ] as const)('rejects packaging on %s-%s', async (platform, arch) => {
    const packageModule = await loadPackageModule()

    expect(() => packageModule.createPackagePlan({ repoRoot: '/checkout', platform, arch }))
      .toThrow(`Unsupported desktop packaging target: ${platform}-${arch}; expected darwin-arm64 or win32-x64`)
  })

  it('runs the native Windows icon, staging, runtime verification, and unsigned x64 builder commands', async () => {
    const packageModule = await loadPackageModule()
    const pnpmEntrypoint = '/pnpm.cjs'
    const checkoutRoot = resolve('/checkout')
    const checkoutDesktop = join(checkoutRoot, 'apps/desktop')
    const plan = packageModule.createPackagePlan({
      repoRoot: '/checkout',
      platform: 'win32',
      arch: 'x64',
      pnpmEntrypoint,
    })

    expect(plan.commands).toEqual([
      {
        executable: process.execPath,
        args: [join(checkoutDesktop, 'scripts/build-icon.mjs')],
        cwd: checkoutRoot,
      },
      {
        executable: process.execPath,
        args: [join(checkoutDesktop, 'scripts/stage-runtime.mjs')],
        cwd: checkoutRoot,
      },
      {
        executable: process.execPath,
        args: [join(checkoutDesktop, 'scripts/verify-runtime.mjs')],
        cwd: checkoutRoot,
      },
      {
        executable: process.execPath,
        args: [
          pnpmEntrypoint,
          'exec',
          'electron-builder',
          '--config',
          join(checkoutDesktop, 'electron-builder.yml'),
          '--win',
          '--x64',
          '--publish',
          'never',
        ],
        cwd: checkoutDesktop,
        environment: {
          CSC_IDENTITY_AUTO_DISCOVERY: 'false',
          CSC_KEY_PASSWORD: '',
          CSC_LINK: '',
          WIN_CSC_KEY_PASSWORD: '',
          WIN_CSC_LINK: '',
        },
      },
    ])
  })

  it('runs only the deterministic icon, staging, runtime verification, and arm64 builder commands', async () => {
    const packageModule = await loadPackageModule()
    const checkoutRoot = resolve('/checkout')
    const checkoutDesktop = join(checkoutRoot, 'apps/desktop')
    const plan = packageModule.createPackagePlan({ repoRoot: '/checkout', platform: 'darwin', arch: 'arm64' })

    expect(plan).toEqual({
      repoRoot: checkoutRoot,
      releaseDirectory: join(checkoutDesktop, 'release'),
      commands: [
        {
          executable: process.execPath,
          args: [join(checkoutDesktop, 'scripts/build-icon.mjs')],
          cwd: checkoutRoot,
        },
        {
          executable: process.execPath,
          args: [join(checkoutDesktop, 'scripts/stage-runtime.mjs')],
          cwd: checkoutRoot,
        },
        {
          executable: process.execPath,
          args: [join(checkoutDesktop, 'scripts/verify-runtime.mjs')],
          cwd: checkoutRoot,
        },
        {
          executable: 'pnpm',
          args: [
            'exec',
            'electron-builder',
            '--config',
            join(checkoutDesktop, 'electron-builder.yml'),
            '--mac',
            '--arm64',
            '--publish',
            'never',
          ],
          cwd: checkoutDesktop,
          environment: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
        },
      ],
    })
    const commandText = plan.commands.flatMap(command => [command.executable, ...command.args]).join(' ')
    expect(commandText).not.toMatch(/security|find-identity|notarytool/)
  })

  it('cleans only the fixed release directory before executing the plan in order', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'dsh-package-plan-'))
    directories.push(repoRoot)
    const desktopDirectory = join(repoRoot, 'apps/desktop')
    const releaseDirectory = join(desktopDirectory, 'release')
    const sibling = join(desktopDirectory, 'keep.txt')
    await mkdir(releaseDirectory, { recursive: true })
    await writeFile(join(releaseDirectory, 'stale.dmg'), 'stale')
    await writeFile(sibling, 'keep')
    const packageModule = await loadPackageModule()
    const plan = packageModule.createPackagePlan({ repoRoot, platform: 'darwin', arch: 'arm64' })
    const commands: PackageCommand[] = []

    await packageModule.executePackagePlan(plan, { runCommand: async (command) => { commands.push(command) } })

    expect(commands).toEqual(plan.commands)
    await expect(readFile(join(releaseDirectory, 'stale.dmg'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(sibling, 'utf8')).resolves.toBe('keep')
  })

  it('locates exactly one built DMG and the fixed arm64 App bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-package-output-'))
    directories.push(root)
    const releaseDirectory = join(root, 'release')
    await mkdir(releaseDirectory)
    const verifyModule = await loadVerifyPackageModule()
    const plan = verifyModule.createVerifyPlan({ desktopRoot: root, platform: 'darwin', arch: 'arm64' })

    expect(plan).toEqual({
      appPath: join(releaseDirectory, 'mac-arm64/DeepSeek Harness.app'),
      releaseDirectory,
    })
    await expect(verifyModule.findDmg(releaseDirectory)).rejects.toThrow('Expected exactly one DMG, found 0')
    await writeFile(join(releaseDirectory, 'DeepSeek Harness-0.1.0-arm64.dmg'), '')
    await expect(verifyModule.findDmg(releaseDirectory)).resolves.toBe(join(releaseDirectory, 'DeepSeek Harness-0.1.0-arm64.dmg'))
    await writeFile(join(releaseDirectory, 'stale.dmg'), '')
    await expect(verifyModule.findDmg(releaseDirectory)).rejects.toThrow('Expected exactly one DMG, found 2')
  })

  it('extracts the backend pid and strict loopback URL from lifecycle logs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-package-log-'))
    directories.push(root)
    const logPath = join(root, 'desktop.log')
    await writeFile(logPath, [
      JSON.stringify({ event: 'harness-starting', pid: 4242 }),
      JSON.stringify({ event: 'harness-ready', url: 'http://127.0.0.1:43210/' }),
      '',
    ].join('\n'))
    const verifyModule = await loadVerifyPackageModule()

    await expect(verifyModule.readLifecycleSnapshot(logPath)).resolves.toEqual({
      backendPid: 4242,
      url: new URL('http://127.0.0.1:43210/'),
      startCount: 1,
    })
    await writeFile(logPath, `${JSON.stringify({ event: 'harness-ready', url: 'https://example.com/' })}\n`)
    await expect(verifyModule.readLifecycleSnapshot(logPath)).rejects.toThrow('missing a valid owned backend pid')
  })

  it('expects packaged Harness data below userData while keeping Desktop logs and Electron singleton state outside it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-package-data-paths-'))
    directories.push(root)
    const verifyModule = await loadVerifyPackageModule()

    const paths = verifyModule.createStandaloneDataPaths(root)

    expect(paths).toEqual({
      userData: join(root, 'user-data'),
      harnessData: join(root, 'user-data/Harness'),
      logPath: join(root, 'user-data/Logs/desktop.log'),
      singletonSocket: join(root, 'user-data/SingletonSocket'),
    })
    expect(relative(paths.harnessData, paths.singletonSocket)).toMatch(/^\.\./)
    expect(relative(paths.harnessData, paths.logPath)).toMatch(/^\.\./)
  })

  it('rejects a symlink App root even when it targets the release App', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-package-app-link-'))
    directories.push(root)
    const releaseApp = join(root, 'release/mac-arm64/DeepSeek Harness.app')
    const linkedApp = join(root, 'standalone/DeepSeek Harness.app')
    await createMinimalAppBundle(releaseApp)
    await mkdir(join(root, 'standalone'))
    await symlink(releaseApp, linkedApp)
    const verifyModule = await loadVerifyPackageModule()

    await expect(verifyModule.validateAppBundleLayout(linkedApp)).rejects.toThrow(
      `Packaged App bundle must be an ordinary directory: ${linkedApp}`,
    )
  })

  it('rejects a runtime root symlink to the checkout runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-package-runtime-link-'))
    directories.push(root)
    const appPath = join(root, 'release/mac-arm64/DeepSeek Harness.app')
    const checkoutRuntime = join(root, 'checkout/apps/desktop/.runtime')
    await createMinimalAppBundle(appPath, { omitRuntime: true })
    await mkdir(checkoutRuntime, { recursive: true })
    await symlink(checkoutRuntime, join(appPath, 'Contents/Resources/runtime'))
    const verifyModule = await loadVerifyPackageModule()

    await expect(verifyModule.validateAppBundleLayout(appPath)).rejects.toThrow(
      `Packaged Harness runtime must be an ordinary directory: ${join(appPath, 'Contents/Resources/runtime')}`,
    )
  })

  it('revalidates the copied standalone App before launch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-package-copied-link-'))
    directories.push(root)
    const sourceApp = join(root, 'release/mac-arm64/DeepSeek Harness.app')
    const copiedApp = join(root, 'outside/DeepSeek Harness.app')
    const checkoutRuntime = join(root, 'checkout/apps/desktop/.runtime')
    await createMinimalAppBundle(sourceApp)
    await mkdir(checkoutRuntime, { recursive: true })
    const verifyModule = await loadVerifyPackageModule()

    await expect(verifyModule.copyAndVerifyStandaloneApp(sourceApp, copiedApp, {
      copyApp: async (source, destination) => {
        await cp(source, destination, { recursive: true, verbatimSymlinks: true })
        await rm(join(destination, 'Contents/Resources/runtime'), { recursive: true })
        await symlink(checkoutRuntime, join(destination, 'Contents/Resources/runtime'))
      },
    })).rejects.toThrow(
      `Packaged Harness runtime must be an ordinary directory: ${join(copiedApp, 'Contents/Resources/runtime')}`,
    )
  })

  it('rejects an unsigned nested Mach-O even when the outer App signature verifies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-package-unsigned-nested-'))
    directories.push(root)
    const appPath = join(root, 'DeepSeek Harness.app')
    const nestedBinary = join(appPath, 'Contents/Resources/runtime/addon.node')
    await mkdir(join(appPath, 'Contents/Resources/runtime'), { recursive: true })
    await writeFile(nestedBinary, 'fixture')
    const actualNestedBinary = await realpath(nestedBinary)
    const commands: string[] = []
    const verifyModule = await loadVerifyPackageModule()

    await expect(verifyModule.verifyAppCodeSignatures(appPath, [nestedBinary], {
      runCommand: async (executable, args) => {
        commands.push(`${executable} ${args.join(' ')}`)
        if (args.includes('--verify') && args.at(-1) === actualNestedBinary) throw new Error('nested code object is not signed at all')
        if (executable === '/usr/bin/plutil') {
          return commandResult(JSON.stringify(Object.fromEntries(APPROVED_ENTITLEMENTS.map(key => [key, true]))))
        }
        return commandResult(args.includes('-dvvv') ? approvedSignatureDetails() : '')
      },
    })).rejects.toThrow('nested code object is not signed at all')
    expect(commands[0]).toBe(`/usr/bin/codesign --verify --deep --strict ${appPath}`)
    expect(commands).toContain(`/usr/bin/codesign --verify --strict ${actualNestedBinary}`)
  })

  it('rejects unexpected nested Mach-O entitlements', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-package-nested-entitlement-'))
    directories.push(root)
    const appPath = join(root, 'DeepSeek Harness.app')
    const nestedBinary = join(appPath, 'Contents/Resources/runtime/addon.node')
    await mkdir(join(appPath, 'Contents/Resources/runtime'), { recursive: true })
    await writeFile(nestedBinary, 'fixture')
    const actualNestedBinary = await realpath(nestedBinary)
    const verifyModule = await loadVerifyPackageModule()

    await expect(verifyModule.verifyAppCodeSignatures(appPath, [nestedBinary], {
      runCommand: async (executable, args, options) => {
        if (executable === '/usr/bin/plutil') {
          const unexpected = options?.input?.includes('com.apple.security.get-task-allow') === true
          return commandResult(JSON.stringify(unexpected
            ? { 'com.apple.security.get-task-allow': true }
            : Object.fromEntries(APPROVED_ENTITLEMENTS.map(key => [key, true]))))
        }
        if (args.includes('-dvvv')) {
          return commandResult(approvedSignatureDetails(
            args.at(-1) === actualNestedBinary ? ['com.apple.security.get-task-allow'] : APPROVED_ENTITLEMENTS,
          ))
        }
        return commandResult('')
      },
    })).rejects.toThrow(
      `Unexpected nested Mach-O entitlements for ${actualNestedBinary}: {"com.apple.security.get-task-allow":true}`,
    )
  })

  it.each([
    ['linux', 3],
    ['darwin', 1],
  ] as const)('rejects the afterPack runtime copy for %s arch %s', async (electronPlatformName, arch) => {
    const afterPackModule = await loadAfterPackModule()

    expect(() => afterPackModule.createAfterPackPlan({
      desktopRoot: '/checkout/apps/desktop',
      electronPlatformName,
      arch,
      appOutDir: '/checkout/apps/desktop/release/mac-arm64',
    })).toThrow(
      `Unsupported Desktop afterPack target: ${electronPlatformName}-${String(arch)}; expected darwin-arm64 or win32-x64`,
    )
  })

  it('copies the runtime to the exact App resource path and preserves contained relative pnpm links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-after-pack-'))
    directories.push(root)
    const desktopDirectory = join(root, 'apps/desktop')
    const sourceRuntime = join(desktopDirectory, '.runtime')
    const appOutDir = join(desktopDirectory, 'release/mac-arm64')
    const appPath = join(appOutDir, 'DeepSeek Harness.app')
    const destinationRuntime = join(appPath, 'Contents/Resources/runtime')
    const sourceLink = await createHookRuntime(sourceRuntime)
    await mkdir(destinationRuntime, { recursive: true })
    await writeFile(join(destinationRuntime, 'stale.txt'), 'stale')
    const afterPackModule = await loadAfterPackModule()
    const plan = afterPackModule.createAfterPackPlan({
      desktopRoot: desktopDirectory,
      electronPlatformName: 'darwin',
      arch: 3,
      appOutDir,
    })

    expect(plan).toEqual({
      desktopRoot: desktopDirectory,
      sourceRuntime,
      appPath,
      destinationRuntime,
      target: { platform: 'darwin', arch: 'arm64' },
    })
    await afterPackModule.copyRuntimeForPackage(plan)

    await expect(readFile(join(destinationRuntime, 'stale.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readlink(join(destinationRuntime, 'node_modules/@deepseek-ai/dsh'))).toBe(sourceLink)
    expect(await realpath(join(destinationRuntime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')))
      .toMatch(`${destinationRuntime}/node_modules/.pnpm/`)
  })

  it('copies a link-free runtime into the exact Windows unpacked resources directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-after-pack-windows-'))
    directories.push(root)
    const desktopDirectory = join(root, 'apps/desktop')
    const sourceRuntime = join(desktopDirectory, '.runtime')
    const appOutDir = join(desktopDirectory, 'release/win-unpacked')
    const destinationRuntime = join(appOutDir, 'resources/runtime')
    await createHoistedHookRuntime(sourceRuntime)
    await mkdir(appOutDir, { recursive: true })
    const afterPackModule = await loadAfterPackModule()

    const plan = afterPackModule.createAfterPackPlan({
      desktopRoot: desktopDirectory,
      electronPlatformName: 'win32',
      arch: 1,
      appOutDir,
    })

    expect(plan).toEqual({
      desktopRoot: desktopDirectory,
      sourceRuntime,
      appPath: appOutDir,
      destinationRuntime,
      target: { platform: 'win32', arch: 'x64' },
    })
    await afterPackModule.copyRuntimeForPackage(plan)
    await expect(readFile(join(destinationRuntime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'utf8'))
      .resolves.toBe('')
  })

  it('rejects an escaping source symlink before replacing the packaged runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-after-pack-external-'))
    directories.push(root)
    const desktopDirectory = join(root, 'apps/desktop')
    const sourceRuntime = join(desktopDirectory, '.runtime')
    const appOutDir = join(desktopDirectory, 'release/mac-arm64')
    const destinationRuntime = join(appOutDir, 'DeepSeek Harness.app/Contents/Resources/runtime')
    await createHookRuntime(sourceRuntime)
    await writeFile(join(root, 'outside'), 'outside')
    await symlink(join(root, 'outside'), join(sourceRuntime, 'external'))
    await mkdir(destinationRuntime, { recursive: true })
    await writeFile(join(destinationRuntime, 'keep.txt'), 'keep')
    const afterPackModule = await loadAfterPackModule()
    const plan = afterPackModule.createAfterPackPlan({
      desktopRoot: desktopDirectory,
      electronPlatformName: 'darwin',
      arch: 3,
      appOutDir,
    })

    await expect(afterPackModule.copyRuntimeForPackage(plan)).rejects.toThrow('Staged symlink resolves outside the runtime')
    await expect(readFile(join(destinationRuntime, 'keep.txt'), 'utf8')).resolves.toBe('keep')
  })

  it('rejects a packaged runtime whose copied CLI anchor or symlink containment is invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-after-pack-invalid-copy-'))
    directories.push(root)
    const desktopDirectory = join(root, 'apps/desktop')
    const sourceRuntime = join(desktopDirectory, '.runtime')
    const appOutDir = join(desktopDirectory, 'release/mac-arm64')
    await createHookRuntime(sourceRuntime)
    await mkdir(join(appOutDir, 'DeepSeek Harness.app/Contents/Resources'), { recursive: true })
    const afterPackModule = await loadAfterPackModule()
    const plan = afterPackModule.createAfterPackPlan({
      desktopRoot: desktopDirectory,
      electronPlatformName: 'darwin',
      arch: 3,
      appOutDir,
    })

    await expect(afterPackModule.copyRuntimeForPackage(plan, {
      copyRuntime: async (source, destination) => {
        await cp(source, destination, { recursive: true, verbatimSymlinks: true })
        await rm(join(destination, 'node_modules/.pnpm/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'))
      },
    })).rejects.toThrow('Staged CLI entry point is missing')

    await writeFile(join(root, 'outside'), 'outside')
    await expect(afterPackModule.copyRuntimeForPackage(plan, {
      copyRuntime: async (source, destination) => {
        await cp(source, destination, { recursive: true, verbatimSymlinks: true })
        await symlink(join(root, 'outside'), join(destination, 'copied-external'))
      },
    })).rejects.toThrow('Staged symlink resolves outside the runtime')
  })

  it('bounds osx-sign binary inspection without changing walk result order', async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), 'dsh-osx-sign-walk-'))
    directories.push(fixtureDirectory)
    await Promise.all(Array.from({ length: 128 }, async (_, index) => {
      await writeFile(join(fixtureDirectory, `${String(index).padStart(3, '0')}.bin`), 'probe')
    }))
    const electronBuilderEntry = createRequire(import.meta.url).resolve('electron-builder')

    const result = await runProbe(electronBuilderEntry, fixtureDirectory)

    expect(result.orderPreserved).toBe(true)
    expect(result.result).toHaveLength(128)
    expect(result.maxActive).toBeLessThanOrEqual(32)
  })
})

async function runProbe(electronBuilderEntry: string, fixtureDirectory: string): Promise<{
  maxActive: number
  orderPreserved: boolean
  result: string[]
}> {
  return await new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(process.execPath, [concurrencyProbe, electronBuilderEntry, fixtureDirectory], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', rejectProbe)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveProbe(JSON.parse(stdout) as { maxActive: number; orderPreserved: boolean; result: string[] })
        return
      }
      rejectProbe(new Error(`osx-sign probe failed (${signal ?? String(code)}): ${stderr}`))
    })
  })
}

async function createHookRuntime(runtimeDirectory: string): Promise<string> {
  await mkdir(runtimeDirectory, { recursive: true })
  await writeFile(join(runtimeDirectory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop-runtime' }))
  const dsh = join(runtimeDirectory, 'node_modules/.pnpm/dsh/node_modules/@deepseek-ai/dsh')
  await mkdir(join(dsh, 'lib'), { recursive: true })
  await writeFile(join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
  await writeFile(join(dsh, 'lib/bin.js'), '')
  const webApp = join(runtimeDirectory, 'node_modules/.pnpm/web-app/node_modules/@deepseek-ai/dsh-web-app')
  const frontend = join(runtimeDirectory, 'node_modules/.pnpm/frontend/node_modules/@deepseek-ai/dsh-web-frontend')
  await mkdir(webApp, { recursive: true })
  await writeFile(join(webApp, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-web-app' }))
  await mkdir(join(frontend, 'dist'), { recursive: true })
  await writeFile(join(frontend, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-web-frontend',
    exports: { './dist/*': './dist/*' },
  }))
  await writeFile(join(frontend, 'dist/index.html'), '<title>DeepSeek Harness</title>')
  await mkdir(join(runtimeDirectory, 'node_modules/@deepseek-ai'), { recursive: true })
  const dshLink = '../.pnpm/dsh/node_modules/@deepseek-ai/dsh'
  await symlink(dshLink, join(runtimeDirectory, 'node_modules/@deepseek-ai/dsh'))
  await symlink('../../../web-app/node_modules/@deepseek-ai/dsh-web-app', join(dirname(dsh), 'dsh-web-app'))
  await symlink('../../../frontend/node_modules/@deepseek-ai/dsh-web-frontend', join(dirname(webApp), 'dsh-web-frontend'))
  return dshLink
}

async function createHoistedHookRuntime(runtimeDirectory: string): Promise<void> {
  await mkdir(runtimeDirectory, { recursive: true })
  await writeFile(join(runtimeDirectory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop-runtime' }))
  const scope = join(runtimeDirectory, 'node_modules/@deepseek-ai')
  const dsh = join(scope, 'dsh')
  const webApp = join(scope, 'dsh-web-app')
  const frontend = join(scope, 'dsh-web-frontend')
  await mkdir(join(dsh, 'lib'), { recursive: true })
  await mkdir(webApp, { recursive: true })
  await mkdir(join(frontend, 'dist'), { recursive: true })
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
}

const APPROVED_ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation',
] as const

function approvedSignatureDetails(entitlements: readonly string[] = APPROVED_ENTITLEMENTS): string {
  const entries = entitlements.map(key => `<key>${key}</key><true/>`).join('')
  return [
    'Signature=adhoc',
    'CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+2 location=embedded',
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${entries}</dict></plist>`,
  ].join('\n')
}

function commandResult(stdout: string): {
  code: number
  signal: null
  stdout: string
  stderr: string
} {
  return { code: 0, signal: null, stdout, stderr: '' }
}

async function createMinimalAppBundle(appPath: string, options: { omitRuntime?: boolean } = {}): Promise<void> {
  const executable = join(appPath, 'Contents/MacOS/DeepSeek Harness')
  const resources = join(appPath, 'Contents/Resources')
  await mkdir(join(appPath, 'Contents/MacOS'), { recursive: true })
  await mkdir(resources, { recursive: true })
  if (options.omitRuntime !== true) await mkdir(join(resources, 'runtime'))
  await writeFile(executable, 'executable')
  await chmod(executable, 0o755)
  await writeFile(join(resources, 'app.asar'), 'asar')
  await writeFile(join(appPath, 'Contents/Info.plist'), 'plist')
}
