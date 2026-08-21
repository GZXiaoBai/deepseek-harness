import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const { createTauriUpdateManifest, writeTauriUpdateManifest } = await import(
  pathToFileURL(join(import.meta.dirname, '../scripts/create-tauri-update-manifest.mjs')).href,
) as {
  createTauriUpdateManifest: (input: {
    tag: string
    version: string
    notes: string
    pubDate: string
    windows: { artifactName: string; signature: string }
    macos: { artifactName: string; signature: string }
  }) => unknown
  writeTauriUpdateManifest: (input: {
    releaseDirectory: string
    tag: string
    version: string
    notes?: string
    pubDate?: string
  }) => Promise<string>
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Tauri update manifest', () => {
  it('maps signed native artifacts to exact updater platform keys', () => {
    expect(createTauriUpdateManifest({
      tag: 'desktop-v0.1.1-rc.1',
      version: '0.1.1-rc.1',
      notes: 'Release notes',
      pubDate: '2026-08-21T00:00:00.000Z',
      windows: { artifactName: 'DeepSeek Harness Setup 0.1.1-rc.1-x64.exe', signature: 'win-sig\n' },
      macos: { artifactName: 'DeepSeek Harness.app.tar.gz', signature: 'mac-sig\n' },
    })).toEqual({
      version: '0.1.1-rc.1',
      notes: 'Release notes',
      pub_date: '2026-08-21T00:00:00.000Z',
      platforms: {
        'windows-x86_64': {
          signature: 'win-sig',
          url: 'https://github.com/GZXiaoBai/deepseek-harness/releases/download/desktop-v0.1.1-rc.1/DeepSeek%20Harness%20Setup%200.1.1-rc.1-x64.exe',
        },
        'darwin-aarch64': {
          signature: 'mac-sig',
          url: 'https://github.com/GZXiaoBai/deepseek-harness/releases/download/desktop-v0.1.1-rc.1/DeepSeek%20Harness.app.tar.gz',
        },
      },
    })
  })

  it('rejects a tag that cannot update the packaged version', () => {
    expect(() => createTauriUpdateManifest({
      tag: 'desktop-v0.2.0',
      version: '0.1.0',
      notes: '',
      pubDate: '2026-08-21T00:00:00.000Z',
      windows: { artifactName: 'app.exe', signature: 'sig' },
      macos: { artifactName: 'app.tar.gz', signature: 'sig' },
    })).toThrow(/does not match version/)
  })

  it('writes signatures from the collected release artifacts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-update-manifest-'))
    temporaryDirectories.push(directory)
    await mkdir(directory, { recursive: true })
    await Promise.all([
      writeFile(join(directory, 'DeepSeek Harness Setup 0.1.1-rc.1-x64.exe'), ''),
      writeFile(join(directory, 'DeepSeek Harness Setup 0.1.1-rc.1-x64.exe.sig'), 'win-signature\n'),
      writeFile(join(directory, 'DeepSeek Harness.app.tar.gz'), ''),
      writeFile(join(directory, 'DeepSeek Harness.app.tar.gz.sig'), 'mac-signature\n'),
    ])
    const output = await writeTauriUpdateManifest({
      releaseDirectory: directory,
      tag: 'desktop-v0.1.1-rc.1',
      version: '0.1.1-rc.1',
      pubDate: '2026-08-21T00:00:00.000Z',
    })
    const manifest = JSON.parse(await readFile(output, 'utf8')) as unknown as {
      platforms: Record<string, { signature: string }>
    }
    expect(manifest.platforms['windows-x86_64']?.signature).toBe('win-signature')
    expect(manifest.platforms['darwin-aarch64']?.signature).toBe('mac-signature')
  })
})
