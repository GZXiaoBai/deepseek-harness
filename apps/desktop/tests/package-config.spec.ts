import { cp, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
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
  createPackagePlan(input: { repoRoot: string; platform: NodeJS.Platform; arch: string }): PackagePlan
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
}

interface AfterPackPlan {
  desktopRoot: string
  sourceRuntime: string
  appPath: string
  destinationRuntime: string
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
}

describe('desktop package configuration', () => {
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

  it.each([
    ['linux', 'arm64'],
    ['darwin', 'x64'],
    ['win32', 'x64'],
  ] as const)('rejects packaging on %s-%s', async (platform, arch) => {
    const packageModule = await loadPackageModule()

    expect(() => packageModule.createPackagePlan({ repoRoot: '/checkout', platform, arch }))
      .toThrow(`Unsupported desktop packaging target: ${platform}-${arch}; expected darwin-arm64`)
  })

  it('runs only the deterministic icon, staging, runtime verification, and arm64 builder commands', async () => {
    const packageModule = await loadPackageModule()
    const plan = packageModule.createPackagePlan({ repoRoot: '/checkout', platform: 'darwin', arch: 'arm64' })

    expect(plan).toEqual({
      repoRoot: '/checkout',
      releaseDirectory: '/checkout/apps/desktop/release',
      commands: [
        {
          executable: process.execPath,
          args: ['/checkout/apps/desktop/scripts/build-icon.mjs'],
          cwd: '/checkout',
        },
        {
          executable: process.execPath,
          args: ['/checkout/apps/desktop/scripts/stage-runtime.mjs'],
          cwd: '/checkout',
        },
        {
          executable: process.execPath,
          args: ['/checkout/apps/desktop/scripts/verify-runtime.mjs'],
          cwd: '/checkout',
        },
        {
          executable: 'pnpm',
          args: [
            'exec',
            'electron-builder',
            '--config',
            '/checkout/apps/desktop/electron-builder.yml',
            '--mac',
            '--arm64',
            '--publish',
            'never',
          ],
          cwd: '/checkout/apps/desktop',
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
    })).toThrow(`Unsupported Desktop afterPack target: ${electronPlatformName}-${String(arch)}; expected darwin-arm64`)
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

    expect(plan).toEqual({ desktopRoot: desktopDirectory, sourceRuntime, appPath, destinationRuntime })
    await afterPackModule.copyRuntimeForPackage(plan)

    await expect(readFile(join(destinationRuntime, 'stale.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readlink(join(destinationRuntime, 'node_modules/@deepseek-ai/dsh'))).toBe(sourceLink)
    expect(await realpath(join(destinationRuntime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')))
      .toMatch(`${destinationRuntime}/node_modules/.pnpm/`)
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
