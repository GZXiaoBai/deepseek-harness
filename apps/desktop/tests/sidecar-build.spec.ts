import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const buildModule = await import(pathToFileURL(join(import.meta.dirname, '../scripts/build-sidecar.mjs')).href) as {
  createSidecarBuildPlan(input: { repoRoot: string; platform: NodeJS.Platform; arch: string }): {
    stagingDirectory: string
    outputPath: string
    pkgTarget: string
    rustTarget: string
    executableSuffix: string
  }
  createSidecarDeployArgs(stagingDirectory: string): string[]
  createPnpmCommand(environment: NodeJS.ProcessEnv, nodePath: string): {
    executable: string
    argsPrefix: string[]
  }
  createPackagedModuleList(manifest: { dependencies?: Record<string, string> }): string[]
  createSidecarVerifyCommand(repoRoot: string, nodePath: string): { executable: string; args: string[] }
  injectPackagedModuleRoster(source: string, packageNames: readonly string[]): string
  shouldPruneStagedRuntimePath(relativePath: string, directory: boolean): boolean
  SIDECAR_ASSET_GLOBS: readonly string[]
  createNativeSidecarBuildPath(
    outputPath: string,
    rustTarget: string,
    kind: 'rg' | 'spawn-helper',
    windows: boolean,
  ): string
}
const feasibilityModule = await import(
  pathToFileURL(join(import.meta.dirname, '../scripts/verify-sidecar-feasibility.mjs')).href,
) as {
  createFeasibilityFixtureFiles(): ReadonlyMap<string, string>
}

describe('desktop SEA sidecar build', () => {
  it('runs pnpm through Node instead of a Windows command shim or shell', () => {
    expect(buildModule.createPnpmCommand({ npm_execpath: 'C:/pnpm/bin/pnpm.cjs' }, 'C:/node.exe'))
      .toEqual({ executable: 'C:/node.exe', argsPrefix: ['C:/pnpm/bin/pnpm.cjs'] })
    expect(() => buildModule.createPnpmCommand({}, '/node')).toThrow('npm_execpath')
  })

  it('runs the closure verifier without asking pnpm to reconcile the workspace install', () => {
    expect(buildModule.createSidecarVerifyCommand('/repo', '/node')).toEqual({
      executable: '/node',
      args: [
        join('/repo', 'node_modules/tsx/dist/cli.mjs'),
        'scripts/verify-runtime-closure.ts',
        '--manifest',
        'apps/desktop/runtime/package.json',
      ],
    })
  })

  it('injects the complete staged package roster into the compiled sidecar', () => {
    const source = 'const packages = ["__DSH_DESKTOP_MODULE_ROSTER__"];\n'

    expect(buildModule.injectPackagedModuleRoster(source, ['@deepseek-ai/z', '@deepseek-ai/a']))
      .toBe('const packages = ["@deepseek-ai/a","@deepseek-ai/z"];\n')
    expect(() => buildModule.injectPackagedModuleRoster('const packages = [];\n', []))
      .toThrow('module roster marker')
  })

  it('serializes a deterministic list of packaged module names for the VFS resolver', () => {
    expect(buildModule.createPackagedModuleList({ dependencies: {
      zebra: '1',
      alpha: '1',
      '@deepseek-ai/dsh-web-frontend': 'workspace:^',
    } }))
      .toEqual(['alpha', 'zebra'])
  })

  it('allows workspace patches that the minimal sidecar closure does not consume', () => {
    expect(buildModule.createSidecarDeployArgs('/tmp/sidecar')).toContain(
      '--config.allow-unused-patches=true',
    )
  })

  it('embeds native addons together with their platform dynamic libraries', () => {
    expect(buildModule.SIDECAR_ASSET_GLOBS).toEqual(expect.arrayContaining([
      'node_modules/**/*.node',
      'node_modules/**/*.dylib',
      'node_modules/**/*.dll',
      'node_modules/**/*.so',
      'node_modules/**/*.so.*',
    ]))
  })

  it('probes a real disk plugin with packaged peers, a private dependency, and disposal', () => {
    const fixture = feasibilityModule.createFeasibilityFixtureFiles()
    expect(fixture.get('index.mjs')).toContain("from '@deepseek-ai/cordis'")
    expect(fixture.get('index.mjs')).toContain("from '@deepseek-ai/dsh-host-directory-picker'")
    expect(fixture.get('index.mjs')).toContain("from 'dsh-private-fixture'")
    expect(fixture.get('index.mjs')).toContain('await fiber.dispose()')
    expect(fixture.get('node_modules/dsh-private-fixture/package.json')).toContain('dsh-private-fixture')
  })

  it.each([
    ['node_modules/pkg/test', true],
    ['node_modules/pkg/__tests__', true],
    ['node_modules/pkg/docs', true],
    ['node_modules/pkg/examples', true],
    ['node_modules/pkg/index.test.js', false],
    ['node_modules/pkg/lib/index.js.map', false],
    ['node_modules/pkg/src/index.ts', false],
    ['node_modules/pkg/eslint.config.mjs', false],
    ['node_modules/@deepseek-ai/dsh-desktop/lib/main.js', false],
    ['node_modules/.pnpm', true],
  ] as const)('prunes sidecar development path %s', (path, directory) => {
    expect(buildModule.shouldPruneStagedRuntimePath(path, directory)).toBe(true)
  })

  it.each([
    ['node_modules/pkg/lib/index.js', false],
    ['node_modules/pkg/package.json', false],
    ['node_modules/pkg/assets/config.json', false],
    ['node_modules/pkg/src/runtime.js', false],
    ['node_modules/yaml/dist/doc/Document.js', false],
    ['node_modules/@deepseek-ai/dsh-skill-badge/assets/dsh-badge.md', false],
    ['node_modules/@deepseek-ai/dsh-workflow-worker-thread/lib/worker.ts', true],
    ['node_modules/@deepseek-ai/dsh-sandbox-windows-acl/src/runner.ts', true],
  ] as const)('retains sidecar runtime path %s', (path, directory) => {
    expect(buildModule.shouldPruneStagedRuntimePath(path, directory)).toBe(false)
  })

  it('maps macOS Apple Silicon to the Node 24 SEA and Tauri sidecar filename', () => {
    const root = resolve('/checkout')

    expect(buildModule.createSidecarBuildPlan({ repoRoot: root, platform: 'darwin', arch: 'arm64' }))
      .toEqual({
        stagingDirectory: join(root, 'apps/desktop/.sidecar-runtime'),
        outputPath: join(
          root,
          'apps/desktop/src-tauri/binaries/dsh-desktop-sidecar-aarch64-apple-darwin',
        ),
        pkgTarget: 'node24-macos-arm64',
        rustTarget: 'aarch64-apple-darwin',
        executableSuffix: '',
      })
  })

  it('names helper inputs so Tauri strips the target before placing them beside the SEA', () => {
    const output = join('/repo', 'binaries', 'dsh-desktop-sidecar-aarch64-apple-darwin')
    expect(buildModule.createNativeSidecarBuildPath(
      output,
      'aarch64-apple-darwin',
      'rg',
      false,
    )).toBe(join('/repo', 'binaries', 'dsh-desktop-sidecar-rg-aarch64-apple-darwin'))
    expect(buildModule.createNativeSidecarBuildPath(
      join('C:/repo', 'binaries', 'dsh-desktop-sidecar-x86_64-pc-windows-msvc.exe'),
      'x86_64-pc-windows-msvc',
      'rg',
      true,
    )).toBe(join('C:/repo', 'binaries', 'dsh-desktop-sidecar-rg-x86_64-pc-windows-msvc.exe'))
  })

  it('maps Windows x64 to the Node 24 SEA and .exe sidecar filename', () => {
    const root = resolve('C:/checkout')
    const plan = buildModule.createSidecarBuildPlan({ repoRoot: root, platform: 'win32', arch: 'x64' })

    expect(plan.pkgTarget).toBe('node24-win-x64')
    expect(plan.rustTarget).toBe('x86_64-pc-windows-msvc')
    expect(plan.outputPath).toBe(join(
      root,
      'apps/desktop/src-tauri/binaries/dsh-desktop-sidecar-x86_64-pc-windows-msvc.exe',
    ))
  })

  it.each([
    ['darwin', 'x64'],
    ['win32', 'arm64'],
    ['linux', 'x64'],
  ] as const)('rejects unsupported host target %s-%s', (platform, arch) => {
    expect(() => buildModule.createSidecarBuildPlan({ repoRoot: '/checkout', platform, arch }))
      .toThrow(`Unsupported desktop sidecar target: ${platform}-${arch}`)
  })
})
