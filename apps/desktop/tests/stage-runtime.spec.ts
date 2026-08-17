import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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
}

interface StageRuntimeModule {
  createStagePlan: (input: {
    repoRoot: string
    platform: NodeJS.Platform
    arch: string
    electronVersion: string
  }) => StagePlan
  executeStagePlan: (
    plan: StagePlan,
    options: {
      runCommand(command: StageCommand): Promise<void>
    },
  ) => Promise<void>
}

const stageScriptUrl = pathToFileURL(join(import.meta.dirname, '../scripts/stage-runtime.mjs')).href
const directories: string[] = []

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
): Promise<void> {
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
  const nativePrebuild = join(runtimeDirectory, 'node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/prebuilds/darwin-arm64')
  await mkdir(nativePrebuild, { recursive: true })
  await writeFile(join(nativePrebuild, 'pty.node'), '')
  await createRepairScript(runtimeDirectory)
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

async function createRepairScript(runtimeDirectory: string): Promise<string> {
  const repairScript = join(
    runtimeDirectory,
    'node_modules/.pnpm/staged-subprocess-local/node_modules/@deepseek-ai/dsh-subprocess-local/scripts/ensure-spawn-helper.mjs',
  )
  await mkdir(dirname(repairScript), { recursive: true })
  await writeFile(repairScript, '')
  return repairScript
}

describe('desktop runtime staging', () => {
  it.each([
    ['linux', 'arm64'],
    ['darwin', 'x64'],
    ['win32', 'x64'],
  ] as const)('rejects the unsupported %s-%s target', async (platform, arch) => {
    const { createStagePlan } = await loadStageRuntime()

    expect(() => createStagePlan({
      repoRoot: '/checkout',
      platform,
      arch,
      electronVersion: '43.4.0',
    })).toThrow(`Unsupported desktop staging target: ${platform}-${arch}; expected darwin-arm64`)
  })

  it('orders closure verification, script-free deploy, the one staged permission repair, and Electron rebuild', async () => {
    const repoRoot = await makeRepository()
    const runtimeDirectory = join(repoRoot, 'apps/desktop/.runtime')
    const repairScript = join(
      runtimeDirectory,
      'node_modules/.pnpm/staged-subprocess-local/node_modules/@deepseek-ai/dsh-subprocess-local/scripts/ensure-spawn-helper.mjs',
    )
    const { createStagePlan, executeStagePlan } = await loadStageRuntime()
    const plan = createStagePlan({ repoRoot, platform: 'darwin', arch: 'arm64', electronVersion: '43.4.0' })
    const commands: StageCommand[] = []

    await executeStagePlan(plan, {
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

  it('allows internal pnpm links whose directory names contain encoded checkout paths', async () => {
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
})
