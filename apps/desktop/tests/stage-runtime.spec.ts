import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

interface StageCommand {
  executable: string
  args: readonly string[]
  cwd: string
}

interface StagePlan {
  readonly runtimeDirectory: string
  readonly deployCommand: StageCommand
  readonly rebuildCommand: StageCommand
}

interface StageRuntimeModule {
  createStagePlan: (input: {
    repoRoot: string
    platform: NodeJS.Platform
    arch: string
    electronVersion: string
    pnpmEntrypoint?: string
  }) => StagePlan
  executeStagePlan: (
    plan: StagePlan,
    options: {
      runCommand(command: StageCommand): Promise<void>
      auditRuntime?: (runtimeDirectory: string) => Promise<void>
    },
  ) => Promise<void>
  validateNodePtyPrebuild: (
    runtimeDirectory: string,
    target: Readonly<{ platform: 'darwin'; arch: 'arm64' } | { platform: 'win32'; arch: 'x64' }>,
  ) => Promise<void>
  resolveNodePtyIgnoredRelativePath: (runtimeDirectory: string) => Promise<string>
  ensureConptyReleaseAssets: (runtimeDirectory: string) => Promise<void>
  assertRuntimeContainsNoLinks: (runtimeDirectory: string) => Promise<void>
  auditX64Pe: (runtimeDirectory: string) => Promise<readonly string[]>
}

const stageScriptUrl = pathToFileURL(join(import.meta.dirname, '../scripts/stage-runtime.mjs')).href
const directories: string[] = []
const macIt = process.platform === 'darwin' ? it : it.skip

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async directory => rm(directory, { force: true, recursive: true })))
})

async function loadStageRuntime(): Promise<StageRuntimeModule> {
  return await import(stageScriptUrl) as StageRuntimeModule
}

async function makeRepository(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'dsh-stage-runtime-'))
  directories.push(repoRoot)
  await mkdir(join(repoRoot, 'apps/desktop'), { recursive: true })
  await mkdir(join(repoRoot, 'packages/subprocess/subprocess-local'), { recursive: true })
  return repoRoot
}

async function createRuntimeClosure(
  runtimeDirectory: string,
  options: { cli?: boolean; frontend?: boolean } = {},
): Promise<string> {
  await mkdir(runtimeDirectory, { recursive: true })
  await writeFile(join(runtimeDirectory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop-runtime' }))
  const dsh = join(
    runtimeDirectory,
    'node_modules/.pnpm/@deepseek-ai+dsh@file++++checkout+with%20space/node_modules/@deepseek-ai/dsh',
  )
  await mkdir(join(dsh, 'lib'), { recursive: true })
  await writeFile(join(dsh, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    dependencies: { '@deepseek-ai/dsh-web-app': 'workspace:^' },
  }))
  if (options.cli !== false) await writeFile(join(dsh, 'lib/bin.js'), '')
  const rootScope = join(runtimeDirectory, 'node_modules/@deepseek-ai')
  await mkdir(rootScope, { recursive: true })
  await symlink(dsh, join(rootScope, 'dsh'))
  if (options.frontend !== false) await createWebClosure(runtimeDirectory, dsh)
  return await createNativeClosure(runtimeDirectory, dsh)
}

async function createNativeClosure(runtimeDirectory: string, dsh: string): Promise<string> {
  const virtualStore = join(runtimeDirectory, 'node_modules/.pnpm')
  const base = join(
    virtualStore,
    '@deepseek-ai+dsh-base@file++++checkout+with%20space/node_modules/@deepseek-ai/dsh-base',
  )
  const subprocessLocal = join(
    virtualStore,
    '@deepseek-ai+dsh-subprocess-local@file++++checkout+with%20space/node_modules/@deepseek-ai/dsh-subprocess-local',
  )
  const nodePty = join(virtualStore, 'node-pty@1.1.0/node_modules/node-pty')
  await mkdir(base, { recursive: true })
  await writeFile(join(base, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-base',
    dependencies: { '@deepseek-ai/dsh-subprocess-local': 'workspace:^' },
  }))
  await symlink(base, join(dirname(dsh), 'dsh-base'))
  await mkdir(join(subprocessLocal, 'scripts'), { recursive: true })
  await writeFile(join(subprocessLocal, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-subprocess-local',
    dependencies: { 'node-pty': '1.1.0' },
  }))
  await symlink(subprocessLocal, join(dirname(base), 'dsh-subprocess-local'))
  await mkdir(join(nodePty, 'prebuilds/darwin-arm64'), { recursive: true })
  await mkdir(join(nodePty, 'prebuilds/darwin-x64'), { recursive: true })
  await mkdir(join(nodePty, 'prebuilds/win32-arm64'), { recursive: true })
  await mkdir(join(nodePty, 'prebuilds/win32-x64/conpty'), { recursive: true })
  await mkdir(join(nodePty, 'third_party/conpty/1.23.251008001/win10-arm64'), { recursive: true })
  await mkdir(join(nodePty, 'third_party/conpty/1.23.251008001/win10-x64'), { recursive: true })
  await writeFile(join(nodePty, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0' }))
  await writeFile(join(nodePty, 'prebuilds/darwin-arm64/pty.node'), 'arm64 pty')
  await writeFile(join(nodePty, 'prebuilds/darwin-arm64/spawn-helper'), 'arm64 helper')
  await writeFile(join(nodePty, 'prebuilds/darwin-x64/pty.node'), 'x64 pty')
  await writeFile(join(nodePty, 'prebuilds/darwin-x64/spawn-helper'), 'x64 helper')
  await writeFile(join(nodePty, 'prebuilds/win32-arm64/pty.node'), 'arm64 windows pty')
  await writeFile(join(nodePty, 'prebuilds/win32-x64/pty.node'), 'x64 windows pty')
  await writeFile(join(nodePty, 'prebuilds/win32-x64/conpty.node'), 'x64 conpty')
  await writeFile(join(nodePty, 'prebuilds/win32-x64/conpty_console_list.node'), 'x64 console list')
  await writeFile(join(nodePty, 'prebuilds/win32-x64/conpty/conpty.dll'), 'x64 conpty dll')
  await writeFile(join(nodePty, 'prebuilds/win32-x64/conpty/OpenConsole.exe'), 'x64 console')
  await writeFile(join(nodePty, 'prebuilds/win32-x64/winpty.dll'), 'x64 winpty dll')
  await writeFile(join(nodePty, 'prebuilds/win32-x64/winpty-agent.exe'), 'x64 winpty agent')
  await writeFile(join(nodePty, 'third_party/conpty/1.23.251008001/win10-arm64/conpty.dll'), 'arm64 build conpty dll')
  await writeFile(join(nodePty, 'third_party/conpty/1.23.251008001/win10-arm64/OpenConsole.exe'), 'arm64 build console')
  await writeFile(join(nodePty, 'third_party/conpty/1.23.251008001/win10-x64/conpty.dll'), 'x64 build conpty dll')
  await writeFile(join(nodePty, 'third_party/conpty/1.23.251008001/win10-x64/OpenConsole.exe'), 'x64 build console')
  await symlink(nodePty, join(dirname(dirname(subprocessLocal)), 'node-pty'))
  const repairScript = join(subprocessLocal, 'scripts/ensure-spawn-helper.mjs')
  await writeFile(repairScript, '')
  return repairScript
}

async function createWebClosure(runtimeDirectory: string, dsh: string): Promise<void> {
  const virtualStore = join(runtimeDirectory, 'node_modules/.pnpm')
  const webApp = join(
    virtualStore,
    '@deepseek-ai+dsh-web-app@file++++checkout+with%20space/node_modules/@deepseek-ai/dsh-web-app',
  )
  const webFrontend = join(
    virtualStore,
    '@deepseek-ai+dsh-web-frontend@file++++checkout+with%20space/node_modules/@deepseek-ai/dsh-web-frontend',
  )
  await mkdir(webApp, { recursive: true })
  await writeFile(join(webApp, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-web-app',
    dependencies: { '@deepseek-ai/dsh-web-frontend': 'workspace:^' },
  }))
  const webDist = join(webFrontend, 'dist')
  await mkdir(webDist, { recursive: true })
  await writeFile(join(webDist, 'index.html'), '<!doctype html>')
  await writeFile(join(webFrontend, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-web-frontend',
    exports: { './dist/*': './dist/*', './package.json': './package.json' },
  }))
  const webAppDependencies = dirname(webApp)
  await mkdir(webAppDependencies, { recursive: true })
  await symlink(webFrontend, join(webAppDependencies, 'dsh-web-frontend'))
  await symlink(webApp, join(dirname(dsh), 'dsh-web-app'))
}

function nodePtyPrebuild(
  runtimeDirectory: string,
  architecture: 'darwin-arm64' | 'darwin-x64' | 'win32-arm64' | 'win32-x64',
): string {
  return join(runtimeDirectory, 'node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/prebuilds', architecture)
}

function nodePtyConptyBuildAsset(runtimeDirectory: string, architecture: 'win10-arm64' | 'win10-x64'): string {
  return join(
    runtimeDirectory,
    'node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/third_party/conpty/1.23.251008001',
    architecture,
  )
}

function peFixture(machine: number): Buffer {
  const bytes = Buffer.alloc(0x90)
  bytes.write('MZ', 0, 'ascii')
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.write('PE\0\0', 0x80, 'binary')
  bytes.writeUInt16LE(machine, 0x84)
  return bytes
}

describe('desktop runtime staging', () => {
  it.each([
    ['linux', 'arm64'],
    ['darwin', 'x64'],
    ['win32', 'arm64'],
  ] as const)('rejects the unsupported %s-%s target', async (platform, arch) => {
    const { createStagePlan } = await loadStageRuntime()

    expect(() => createStagePlan({
      repoRoot: '/checkout',
      platform,
      arch,
      electronVersion: '43.4.0',
    })).toThrow(`Unsupported desktop staging target: ${platform}-${arch}; expected darwin-arm64 or win32-x64`)
  })

  it('builds a shell-free hoisted Windows x64 deployment plan', async () => {
    const { createStagePlan } = await loadStageRuntime()
    const pnpmEntrypoint = '/pnpm.cjs'

    const plan = createStagePlan({
      repoRoot: 'C:\\checkout',
      platform: 'win32',
      arch: 'x64',
      electronVersion: '43.4.0',
      pnpmEntrypoint,
    })

    expect(plan.deployCommand).toEqual({
      executable: process.execPath,
      args: [
        pnpmEntrypoint,
        '--config.inject-workspace-packages=true',
        '--config.node-linker=hoisted',
        '--ignore-scripts',
        '--frozen-lockfile',
        '--filter',
        '@deepseek-ai/dsh-desktop-runtime',
        '--prod',
        'deploy',
        plan.runtimeDirectory,
      ],
      cwd: plan.deployCommand.cwd,
    })
    expect(plan.rebuildCommand).toEqual({
      executable: process.execPath,
      args: [
        pnpmEntrypoint,
        'exec',
        'electron-rebuild',
        '--module-dir',
        plan.runtimeDirectory,
        '--platform',
        'win32',
        '--arch',
        'x64',
        '--version',
        '43.4.0',
      ],
      cwd: plan.rebuildCommand.cwd,
    })
  })

  it('orders closure verification, script-free deploy, the one staged permission repair, and Electron rebuild', async () => {
    const repoRoot = await makeRepository()
    const runtimeDirectory = join(repoRoot, 'apps/desktop/.runtime')
    const repairScript = join(
      runtimeDirectory,
      'node_modules/.pnpm/@deepseek-ai+dsh-subprocess-local@file++++checkout+with%20space/node_modules/@deepseek-ai/dsh-subprocess-local/scripts/ensure-spawn-helper.mjs',
    )
    const { createStagePlan, executeStagePlan } = await loadStageRuntime()
    const plan = createStagePlan({ repoRoot, platform: 'darwin', arch: 'arm64', electronVersion: '43.4.0' })
    const commands: StageCommand[] = []

    await executeStagePlan(plan, {
      auditRuntime: async () => {},
      runCommand: async (command) => {
        commands.push(command)
        if (command.args.includes('deploy')) await createRuntimeClosure(runtimeDirectory)
      },
    })

    expect(commands).toEqual([
      {
        executable: 'pnpm',
        args: [
          'exec',
          'tsx',
          'scripts/verify-runtime-closure.ts',
          '--manifest',
          'apps/desktop/runtime/package.json',
        ],
        cwd: repoRoot,
      },
      {
        executable: 'pnpm',
        args: [
          '--config.inject-workspace-packages=true',
          '--ignore-scripts',
          '--frozen-lockfile',
          '--filter',
          '@deepseek-ai/dsh-desktop-runtime',
          '--prod',
          'deploy',
          runtimeDirectory,
        ],
        cwd: repoRoot,
      },
      {
        executable: process.execPath,
        args: [repairScript],
        cwd: runtimeDirectory,
      },
      {
        executable: 'pnpm',
        args: [
          'exec',
          'electron-rebuild',
          '--module-dir',
          runtimeDirectory,
          '--arch',
          'arm64',
          '--version',
          '43.4.0',
        ],
        cwd: repoRoot,
      },
    ])
    expect(commands.flatMap(command => command.args).join(' ')).not.toContain('dangerously-allow-all-builds')
    expect(commands.some(command => command.executable === 'pnpm' && command.args.includes('run'))).toBe(false)
  })

  it('validates the darwin-arm64 prebuild files without pruning any prebuild', async () => {
    const repoRoot = await makeRepository()
    const runtimeDirectory = join(repoRoot, 'apps/desktop/.runtime')
    await createRuntimeClosure(runtimeDirectory)
    const { validateNodePtyPrebuild } = await loadStageRuntime()

    await expect(validateNodePtyPrebuild(runtimeDirectory, { platform: 'darwin', arch: 'arm64' })).resolves.toBeUndefined()

    await expect(readFile(join(nodePtyPrebuild(runtimeDirectory, 'darwin-arm64'), 'pty.node'), 'utf8')).resolves.toBe('arm64 pty')
    await expect(readFile(join(nodePtyPrebuild(runtimeDirectory, 'darwin-arm64'), 'spawn-helper'), 'utf8')).resolves.toBe('arm64 helper')
    await expect(readFile(join(nodePtyPrebuild(runtimeDirectory, 'darwin-x64'), 'pty.node'), 'utf8')).resolves.toBe('x64 pty')
    await expect(readFile(join(nodePtyPrebuild(runtimeDirectory, 'win32-x64'), 'conpty.node'), 'utf8')).resolves.toBe('x64 conpty')
  })

  it('rejects a node-pty darwin-arm64 prebuild missing its pty.node', async () => {
    const repoRoot = await makeRepository()
    const runtimeDirectory = join(repoRoot, 'apps/desktop/.runtime')
    await createRuntimeClosure(runtimeDirectory)
    await rm(join(nodePtyPrebuild(runtimeDirectory, 'darwin-arm64'), 'pty.node'))
    const { validateNodePtyPrebuild } = await loadStageRuntime()

    await expect(validateNodePtyPrebuild(runtimeDirectory, { platform: 'darwin', arch: 'arm64' })).rejects.toThrow(
      'Staged node-pty darwin-arm64 pty.node is missing',
    )
  })

  it('rejects a symlinked node-pty prebuild directory', async () => {
    const repoRoot = await makeRepository()
    const runtimeDirectory = join(repoRoot, 'apps/desktop/.runtime')
    await createRuntimeClosure(runtimeDirectory)
    const externalDirectory = await mkdtemp(join(tmpdir(), 'dsh-node-pty-external-'))
    directories.push(externalDirectory)
    const marker = join(externalDirectory, 'keep.txt')
    await writeFile(marker, 'keep')
    const arm64Prebuild = nodePtyPrebuild(runtimeDirectory, 'darwin-arm64')
    await rm(arm64Prebuild, { recursive: true })
    await symlink(externalDirectory, arm64Prebuild)
    const { validateNodePtyPrebuild } = await loadStageRuntime()

    await expect(validateNodePtyPrebuild(runtimeDirectory, { platform: 'darwin', arch: 'arm64' })).rejects.toThrow(
      'Staged node-pty darwin-arm64 prebuild must be an ordinary internal directory:',
    )
    await expect(readFile(marker, 'utf8')).resolves.toBe('keep')
  })

  it('validates the Windows x64 ConPTY prebuild files without pruning any prebuild', async () => {
    const repoRoot = await makeRepository()
    const runtimeDirectory = join(repoRoot, 'apps/desktop/.runtime')
    await createRuntimeClosure(runtimeDirectory)
    const { validateNodePtyPrebuild } = await loadStageRuntime()

    await expect(validateNodePtyPrebuild(runtimeDirectory, { platform: 'win32', arch: 'x64' })).resolves.toBeUndefined()

    await expect(readFile(join(nodePtyPrebuild(runtimeDirectory, 'win32-x64'), 'conpty.node'), 'utf8'))
      .resolves.toBe('x64 conpty')
    await expect(readFile(join(nodePtyConptyBuildAsset(runtimeDirectory, 'win10-x64'), 'conpty.dll'), 'utf8'))
      .resolves.toBe('x64 build conpty dll')
    await expect(readFile(join(nodePtyPrebuild(runtimeDirectory, 'win32-arm64'), 'pty.node'), 'utf8'))
      .resolves.toBe('arm64 windows pty')
    await expect(readFile(join(nodePtyPrebuild(runtimeDirectory, 'darwin-x64'), 'pty.node'), 'utf8')).resolves.toBe('x64 pty')
    await expect(readFile(join(nodePtyConptyBuildAsset(runtimeDirectory, 'win10-arm64'), 'conpty.dll'), 'utf8'))
      .resolves.toBe('arm64 build conpty dll')
  })

  it('rejects a node-pty win32-x64 prebuild missing its conpty.node', async () => {
    const repoRoot = await makeRepository()
    const runtimeDirectory = join(repoRoot, 'apps/desktop/.runtime')
    await createRuntimeClosure(runtimeDirectory)
    await rm(join(nodePtyPrebuild(runtimeDirectory, 'win32-x64'), 'conpty.node'))
    const { validateNodePtyPrebuild } = await loadStageRuntime()

    await expect(validateNodePtyPrebuild(runtimeDirectory, { platform: 'win32', arch: 'x64' })).rejects.toThrow(
      'Staged node-pty win32-x64 file is missing: conpty.node',
    )
  })

  it('resolves the node-pty package directory relative to the canonical runtime root', async () => {
    const repoRoot = await makeRepository()
    const runtimeDirectory = join(repoRoot, 'apps/desktop/.runtime')
    await createRuntimeClosure(runtimeDirectory)
    const { resolveNodePtyIgnoredRelativePath } = await loadStageRuntime()

    await expect(resolveNodePtyIgnoredRelativePath(runtimeDirectory)).resolves.toMatch(
      /^node_modules[\\/]\.pnpm[\\/]node-pty@[^\\/]+[\\/]node_modules[\\/]node-pty$/,
    )
  })

  it('rejects any link in a Windows runtime that would require Developer Mode', async () => {
    const repoRoot = await makeRepository()
    const runtimeDirectory = join(repoRoot, 'apps/desktop/.runtime')
    await mkdir(join(runtimeDirectory, 'node_modules'), { recursive: true })
    await writeFile(join(runtimeDirectory, 'package.json'), '{}')
    await symlink(join(runtimeDirectory, 'package.json'), join(runtimeDirectory, 'node_modules/package-link'))
    const { assertRuntimeContainsNoLinks } = await loadStageRuntime()

    await expect(assertRuntimeContainsNoLinks(runtimeDirectory)).rejects.toThrow(
      `Windows runtime contains a filesystem link: ${join(runtimeDirectory, 'node_modules/package-link')}`,
    )
  })

  it('rejects a linked Windows runtime root before traversing its contents', async () => {
    const repoRoot = await makeRepository()
    const externalRuntime = await mkdtemp(join(tmpdir(), 'dsh-windows-runtime-root-'))
    directories.push(externalRuntime)
    const runtimeDirectory = join(repoRoot, 'apps/desktop/.runtime')
    await symlink(externalRuntime, runtimeDirectory)
    const { assertRuntimeContainsNoLinks } = await loadStageRuntime()

    await expect(assertRuntimeContainsNoLinks(runtimeDirectory)).rejects.toThrow(
      `Windows runtime contains a filesystem link: ${runtimeDirectory}`,
    )
  })

  it('rejects an x86 PE hidden anywhere in the Windows runtime', async () => {
    const repoRoot = await realpath(await makeRepository())
    const runtimeDirectory = join(repoRoot, 'apps/desktop/.runtime')
    const x86Binary = join(runtimeDirectory, 'node_modules/native/hidden.data')
    await mkdir(dirname(x86Binary), { recursive: true })
    await writeFile(x86Binary, peFixture(0x014c))
    const stageModule = await loadStageRuntime()

    expect(stageModule.auditX64Pe).toBeTypeOf('function')
    await expect(stageModule.auditX64Pe(runtimeDirectory)).rejects.toThrow(
      `Windows x64 artifact contains a non-x64 PE file: ${x86Binary} (0x014c)`,
    )
  })

  it('returns every x64 PE while ignoring ordinary files', async () => {
    const repoRoot = await realpath(await makeRepository())
    const runtimeDirectory = join(repoRoot, 'apps/desktop/.runtime')
    const x64Executable = join(runtimeDirectory, 'DeepSeek Harness.exe')
    const x64Addon = join(runtimeDirectory, 'node_modules/native/pty.node')
    await mkdir(dirname(x64Addon), { recursive: true })
    await writeFile(x64Executable, peFixture(0x8664))
    await writeFile(x64Addon, peFixture(0x8664))
    await writeFile(join(runtimeDirectory, 'package.json'), '{}')
    const stageModule = await loadStageRuntime()

    expect(stageModule.auditX64Pe).toBeTypeOf('function')
    await expect(stageModule.auditX64Pe(runtimeDirectory)).resolves.toEqual([x64Executable, x64Addon])
  })

  it('removes only the deterministic runtime directory and executes the exact deploy and rebuild plans', async () => {
    const repoRoot = await makeRepository()
    const runtimeDirectory = join(repoRoot, 'apps/desktop/.runtime')
    const sibling = join(repoRoot, 'apps/desktop/keep.txt')
    await mkdir(runtimeDirectory)
    await writeFile(join(runtimeDirectory, 'stale.txt'), 'stale')
    await writeFile(sibling, 'keep')
    const { createStagePlan, executeStagePlan } = await loadStageRuntime()
    const plan = createStagePlan({ repoRoot, platform: 'darwin', arch: 'arm64', electronVersion: '43.4.0' })
    const commands: StageCommand[] = []

    await executeStagePlan(plan, {
      auditRuntime: async () => {},
      runCommand: async (command) => {
        commands.push(command)
        if (command.args.includes('deploy')) await createRuntimeClosure(runtimeDirectory)
      },
    })

    expect(plan.runtimeDirectory).toBe(runtimeDirectory)
    expect(commands).toHaveLength(4)
    expect(commands[3]).toEqual({
      executable: 'pnpm',
      args: [
        'exec',
        'electron-rebuild',
        '--module-dir',
        runtimeDirectory,
        '--arch',
        'arm64',
        '--version',
        '43.4.0',
      ],
      cwd: repoRoot,
    })
    await expect(readFile(sibling, 'utf8')).resolves.toBe('keep')
    await expect(readFile(join(runtimeDirectory, 'stale.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails staging when deploy omits the CLI entry point', async () => {
    const repoRoot = await makeRepository()
    const runtimeDirectory = join(repoRoot, 'apps/desktop/.runtime')
    const { createStagePlan, executeStagePlan } = await loadStageRuntime()
    const plan = createStagePlan({ repoRoot, platform: 'darwin', arch: 'arm64', electronVersion: '43.4.0' })

    await expect(executeStagePlan(plan, {
      runCommand: async (command) => {
        if (command.args.includes('deploy')) {
          await createRuntimeClosure(runtimeDirectory, { cli: false })
        }
      },
    })).rejects.toThrow('Staged CLI entry point is missing from the @deepseek-ai/dsh dependency closure')
  })

  it('fails staging when deploy omits the built Web frontend closure', async () => {
    const repoRoot = await makeRepository()
    const runtimeDirectory = join(repoRoot, 'apps/desktop/.runtime')
    const { createStagePlan, executeStagePlan } = await loadStageRuntime()
    const plan = createStagePlan({ repoRoot, platform: 'darwin', arch: 'arm64', electronVersion: '43.4.0' })

    await expect(executeStagePlan(plan, {
      runCommand: async (command) => {
        if (command.args.includes('deploy')) {
          await createRuntimeClosure(runtimeDirectory, { frontend: false })
        }
      },
    })).rejects.toThrow('Staged Web frontend is missing')
  })

  it('fails staging when a deployed symlink resolves into the repository checkout', async () => {
    const repoRoot = await makeRepository()
    const runtimeDirectory = join(repoRoot, 'apps/desktop/.runtime')
    const checkoutFile = join(repoRoot, 'workspace-package.js')
    await writeFile(checkoutFile, '')
    const { createStagePlan, executeStagePlan } = await loadStageRuntime()
    const plan = createStagePlan({ repoRoot, platform: 'darwin', arch: 'arm64', electronVersion: '43.4.0' })

    await expect(executeStagePlan(plan, {
      runCommand: async (command) => {
        if (!command.args.includes('deploy')) return
        await createRuntimeClosure(runtimeDirectory)
        const link = join(runtimeDirectory, 'node_modules/workspace-package')
        await mkdir(dirname(link), { recursive: true })
        await symlink(checkoutFile, link)
      },
    })).rejects.toThrow(`Staged symlink resolves outside the runtime: ${join(runtimeDirectory, 'node_modules/workspace-package')}`)
  })

  macIt('allows internal pnpm links whose directory names contain encoded checkout paths', async () => {
    const repoRoot = await makeRepository()
    const runtimeDirectory = join(repoRoot, 'apps/desktop/.runtime')
    const { createStagePlan, executeStagePlan } = await loadStageRuntime()
    const plan = createStagePlan({ repoRoot, platform: 'darwin', arch: 'arm64', electronVersion: '43.4.0' })

    await expect(executeStagePlan(plan, {
      runCommand: async (command) => {
        if (command.args.includes('deploy')) await createRuntimeClosure(runtimeDirectory)
      },
    })).resolves.toBeUndefined()
  })

  it('rejects any staged symlink whose real target is outside the runtime', async () => {
    const repoRoot = await makeRepository()
    const runtimeDirectory = join(repoRoot, 'apps/desktop/.runtime')
    const externalDirectory = await mkdtemp(join(tmpdir(), 'dsh-stage-external-'))
    directories.push(externalDirectory)
    const externalFile = join(externalDirectory, 'dependency.js')
    await writeFile(externalFile, '')
    const { createStagePlan, executeStagePlan } = await loadStageRuntime()
    const plan = createStagePlan({ repoRoot, platform: 'darwin', arch: 'arm64', electronVersion: '43.4.0' })

    await expect(executeStagePlan(plan, {
      runCommand: async (command) => {
        if (!command.args.includes('deploy')) return
        await createRuntimeClosure(runtimeDirectory)
        await symlink(externalFile, join(runtimeDirectory, 'node_modules/external-dependency'))
      },
    })).rejects.toThrow(`Staged symlink resolves outside the runtime: ${join(runtimeDirectory, 'node_modules/external-dependency')}`)
  })

  it('rejects an external repair-script symlink before executing staged code', async () => {
    const repoRoot = await makeRepository()
    const runtimeDirectory = join(repoRoot, 'apps/desktop/.runtime')
    const externalDirectory = await mkdtemp(join(tmpdir(), 'dsh-stage-repair-external-'))
    directories.push(externalDirectory)
    const externalScript = join(externalDirectory, 'ensure-spawn-helper.mjs')
    await writeFile(externalScript, '')
    const { createStagePlan, executeStagePlan } = await loadStageRuntime()
    const plan = createStagePlan({ repoRoot, platform: 'darwin', arch: 'arm64', electronVersion: '43.4.0' })
    let repairExecuted = false

    await expect(executeStagePlan(plan, {
      runCommand: async (command) => {
        if (command.args.includes('deploy')) {
          const repairScript = await createRuntimeClosure(runtimeDirectory)
          await rm(repairScript)
          await symlink(externalScript, repairScript)
          return
        }
        if (command.executable === process.execPath) repairExecuted = true
      },
    })).rejects.toThrow('Staged symlink resolves outside the runtime')
    expect(repairExecuted).toBe(false)
  })

  it('mirrors the ConPTY assets beside a rebuilt win32 conpty.node', async () => {
    const runtimeDirectory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-stage-conpty-')))
    directories.push(runtimeDirectory)
    const dsh = join(runtimeDirectory, 'node_modules/@deepseek-ai/dsh')
    const base = join(dsh, 'node_modules/@deepseek-ai/dsh-base')
    const subprocess = join(base, 'node_modules/@deepseek-ai/dsh-subprocess-local')
    const nodePtyRoot = join(subprocess, 'node_modules/node-pty')
    const release = join(nodePtyRoot, 'build/Release')
    const prebuild = join(nodePtyRoot, 'prebuilds/win32-x64')
    await mkdir(join(release, 'conpty'), { recursive: true })
    await mkdir(join(prebuild, 'conpty'), { recursive: true })
    await writeFile(join(runtimeDirectory, 'package.json'), JSON.stringify({ name: 'runtime', dependencies: { '@deepseek-ai/dsh': '*' } }))
    await writeFile(join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', dependencies: { '@deepseek-ai/dsh-base': '*' } }))
    await writeFile(join(base, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', dependencies: { '@deepseek-ai/dsh-subprocess-local': '*' } }))
    await writeFile(join(subprocess, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-subprocess-local', dependencies: { 'node-pty': '*' } }))
    await writeFile(join(nodePtyRoot, 'package.json'), JSON.stringify({ name: 'node-pty' }))
    await writeFile(join(release, 'conpty.node'), 'binary')
    await writeFile(join(prebuild, 'conpty/conpty.dll'), 'dll')
    await writeFile(join(prebuild, 'conpty/OpenConsole.exe'), 'exe')

    const { ensureConptyReleaseAssets } = await loadStageRuntime()
    await ensureConptyReleaseAssets(runtimeDirectory)

    await expect(readFile(join(release, 'conpty/conpty.dll'), 'utf8')).resolves.toBe('dll')
    await expect(readFile(join(release, 'conpty/OpenConsole.exe'), 'utf8')).resolves.toBe('exe')
  })
})
