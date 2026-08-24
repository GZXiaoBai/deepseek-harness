import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const { createTauriPackagePlan, createTauriSigningEnvironment } = await import(
  pathToFileURL(join(import.meta.dirname, '../scripts/package-tauri.mjs')).href,
) as {
  createTauriPackagePlan: (input: {
    repoRoot: string
    platform: string
    arch: string
    signedUpdates?: boolean
  }) => {
    rustTarget: string
    releaseDirectory: string
    installerName?: string
    dmgName?: string
    buildArguments: string[]
  }
  createTauriSigningEnvironment: (environment: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
}

describe('Tauri package plan', () => {
  const repoRoot = resolve(import.meta.dirname, '../../..')

  it('builds only the native Windows x64 target and keeps compatible artifact names', () => {
    expect(createTauriPackagePlan({ repoRoot, platform: 'win32', arch: 'x64' })).toMatchObject({
      rustTarget: 'x86_64-pc-windows-msvc',
      releaseDirectory: join(repoRoot, 'apps/desktop/release-tauri'),
      installerName: 'DeepSeek Harness Setup 0.1.1-rc.2-x64.exe',
      buildArguments: [
        'build',
        '--config',
        'src-tauri/tauri.windows.conf.json',
        '--target',
        'x86_64-pc-windows-msvc',
      ],
    })
  })

  it('builds only the native Apple Silicon target and a compatible DMG name', () => {
    expect(createTauriPackagePlan({ repoRoot, platform: 'darwin', arch: 'arm64' })).toMatchObject({
      rustTarget: 'aarch64-apple-darwin',
      releaseDirectory: join(repoRoot, 'apps/desktop/release-tauri'),
      dmgName: 'DeepSeek Harness-0.1.1-rc.2-arm64.dmg',
      buildArguments: [
        'build',
        '--config',
        'src-tauri/tauri.macos.conf.json',
        '--target',
        'aarch64-apple-darwin',
      ],
    })
  })

  it('creates signed updater artifacts only when a release key is explicitly available', () => {
    const unsigned = createTauriPackagePlan({ repoRoot, platform: 'darwin', arch: 'arm64' })
    const signed = createTauriPackagePlan({
      repoRoot,
      platform: 'darwin',
      arch: 'arm64',
      signedUpdates: true,
    })
    expect(unsigned.buildArguments).not.toContain('src-tauri/tauri.updater.conf.json')
    expect(signed.buildArguments).toEqual([
      'build',
      '--config',
      'src-tauri/tauri.macos.conf.json',
      '--config',
      'src-tauri/tauri.updater.conf.json',
      '--target',
      'aarch64-apple-darwin',
    ])
  })

  it('loads an explicitly configured private-key path for Tauri without changing direct keys', async () => {
    expect(createTauriSigningEnvironment({
      TAURI_SIGNING_PRIVATE_KEY: 'direct-key',
      TAURI_SIGNING_PRIVATE_KEY_PATH: '/unused',
    })).toEqual({})
    expect(createTauriSigningEnvironment({})).toEqual({})
    const directory = await mkdtemp(join(tmpdir(), 'dsh-tauri-signing-'))
    try {
      const keyPath = join(directory, 'updater.key')
      await writeFile(keyPath, 'private-key-content\n')
      expect(createTauriSigningEnvironment({ TAURI_SIGNING_PRIVATE_KEY_PATH: keyPath })).toEqual({
        TAURI_SIGNING_PRIVATE_KEY: 'private-key-content\n',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    ['darwin', 'x64'],
    ['win32', 'arm64'],
    ['linux', 'x64'],
  ])('rejects unsupported target %s-%s', (platform, arch) => {
    expect(() => createTauriPackagePlan({ repoRoot, platform, arch })).toThrow(
      /expected darwin-arm64 or win32-x64/,
    )
  })
})
