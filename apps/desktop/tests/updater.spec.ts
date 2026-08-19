import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DesktopUpdater, compareSemver, findUpdate, macInstallScript, parseReleaseTag, selectUpdateAsset, verifyArtifactChecksum } from '../src/updater.ts'
import type { GitHubRelease, ReleaseAsset, UpdaterRuntimeOps } from '../src/updater.ts'

/** @param content Fixture bytes. @returns Real SHA-256 digest of the content. */
function realDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async directory => rm(directory, { force: true, recursive: true })))
})

describe('semantic version comparison', () => {
  it.each([
    ['0.1.0-rc.5', '0.1.0', -1],
    ['0.1.0', '0.1.0-rc.5', 1],
    ['0.1.0', '0.1.0', 0],
    ['0.1.0-rc.2', '0.1.0-rc.10', -1],
    ['0.1.0-rc.5', '0.1.0-rc.5', 0],
    ['0.2.0', '0.1.99', 1],
    ['1.0.0', '0.9.9', 1],
    ['0.1.0-alpha', '0.1.0-beta', -1],
    ['0.1.0-rc.5+build.7', '0.1.0-rc.5', 0],
  ] as const)('orders %s vs %s', (left, right, expected) => {
    expect(compareSemver(left, right)).toBe(expected)
  })

  it('rejects unparseable versions', () => {
    expect(() => compareSemver('latest', '0.1.0')).toThrow('Invalid semantic version')
  })
})

describe('release tag parsing', () => {
  it('strips the desktop prefix and keeps the version', () => {
    expect(parseReleaseTag('desktop-v0.1.0-rc.5')).toBe('0.1.0-rc.5')
    expect(parseReleaseTag('v0.1.0')).toBe('0.1.0')
  })

  it('rejects unrelated tags', () => {
    expect(() => parseReleaseTag('docs-weekly')).toThrow('Unrecognized desktop release tag')
  })
})

describe('update asset selection', () => {
  const assets: ReleaseAsset[] = [
    { name: 'DeepSeek Harness Setup 0.1.0-rc.5-x64.exe', browser_download_url: 'https://example.com/setup.exe' },
    { name: 'DeepSeek Harness-0.1.0-rc.5-arm64.dmg', browser_download_url: 'https://example.com/app.dmg' },
    { name: 'checksums.txt', browser_download_url: 'https://example.com/checksums.txt' },
  ]

  it('selects the NSIS installer on Windows', () => {
    expect(selectUpdateAsset(assets, 'win32')?.name).toBe('DeepSeek Harness Setup 0.1.0-rc.5-x64.exe')
  })

  it('selects the arm64 DMG on macOS', () => {
    expect(selectUpdateAsset(assets, 'darwin')?.name).toBe('DeepSeek Harness-0.1.0-rc.5-arm64.dmg')
  })

  it('returns null when no platform asset exists', () => {
    expect(selectUpdateAsset([{ name: 'checksums.txt', browser_download_url: 'x' }], 'win32')).toBeNull()
  })
})

describe('update discovery', () => {
  const releases: GitHubRelease[] = [
    {
      tag_name: 'desktop-v0.1.0-rc.6',
      prerelease: true,
      published_at: '2026-08-20T00:00:00Z',
      body: 'rc6',
      assets: [{ name: 'DeepSeek Harness Setup 0.1.0-rc.6-x64.exe', browser_download_url: 'https://example.com/rc6.exe' }],
    },
    {
      tag_name: 'desktop-v0.1.0',
      prerelease: false,
      published_at: '2026-08-19T00:00:00Z',
      body: 'stable',
      assets: [{ name: 'DeepSeek Harness Setup 0.1.0-x64.exe', browser_download_url: 'https://example.com/stable.exe' }],
    },
  ]

  it('finds a newer stable release on the stable channel', async () => {
    const update = await findUpdate('owner/repo', 'stable', '0.1.0-rc.5', 'win32', async () => releases)

    expect(update).toMatchObject({
      version: '0.1.0',
      tagName: 'desktop-v0.1.0',
      assetName: 'DeepSeek Harness Setup 0.1.0-x64.exe',
    })
  })

  it('includes prereleases on the prerelease channel', async () => {
    const rcOnly: GitHubRelease[] = [{
      tag_name: 'desktop-v0.1.0-rc.6',
      prerelease: true,
      published_at: '2026-08-20T00:00:00Z',
      body: 'rc6',
      assets: [{ name: 'DeepSeek Harness Setup 0.1.0-rc.6-x64.exe', browser_download_url: 'https://example.com/rc6.exe' }],
    }]
    const update = await findUpdate('owner/repo', 'prerelease', '0.1.0-rc.5', 'win32', async () => rcOnly)

    expect(update?.version).toBe('0.1.0-rc.6')
  })

  it('returns null when already current', async () => {
    await expect(findUpdate('owner/repo', 'stable', '0.1.0', 'win32', async () => releases)).resolves.toBeNull()
  })

  it('rejects an invalid repository', async () => {
    await expect(findUpdate('norepo', 'stable', '0.1.0', 'win32', async () => releases)).rejects.toThrow(
      'Invalid update repository',
    )
  })
})

describe('artifact checksum verification', () => {
  it('matches the combined checksum file line', async () => {
    const digest = realDigest('data')
    const assets: ReleaseAsset[] = [{ name: 'checksums.txt', browser_download_url: 'https://example.com/checksums.txt' }]
    const fetchText = async () => `${digest}  app.exe\n`

    await expect(verifyArtifactChecksum('/tmp/app.exe', 'app.exe', assets, fetchText, async () => Buffer.from('data'))).resolves.toBe(digest)
  })

  it('matches the per-asset checksum file', async () => {
    const digest = realDigest('data')
    const assets: ReleaseAsset[] = [{ name: 'app.exe.sha256', browser_download_url: 'https://example.com/app.exe.sha256' }]
    const fetchText = async () => digest

    await expect(verifyArtifactChecksum('/tmp/app.exe', 'app.exe', assets, fetchText, async () => Buffer.from('data'))).resolves.toBe(digest)
  })

  it('rejects a digest mismatch', async () => {
    const assets: ReleaseAsset[] = [{ name: 'app.exe.sha256', browser_download_url: 'https://example.com/app.exe.sha256' }]

    await expect(verifyArtifactChecksum('/tmp/app.exe', 'app.exe', assets, async () => 'c'.repeat(64), async () => Buffer.from('data')))
      .rejects.toThrow('Update artifact checksum mismatch')
  })

  it('fails when no checksum asset exists', async () => {
    await expect(verifyArtifactChecksum('/tmp/app.exe', 'app.exe', [], async () => '', async () => Buffer.from('data')))
      .rejects.toThrow('No checksum asset found')
  })
})

describe('desktop updater lifecycle', () => {
  function releaseFixture(tag: string, version: string, prerelease = false): GitHubRelease {
    return {
      tag_name: tag,
      prerelease,
      published_at: '2026-08-20T00:00:00Z',
      body: '',
      assets: [
        { name: `DeepSeek Harness Setup ${version}-x64.exe`, browser_download_url: `https://example.com/${version}.exe` },
        { name: 'checksums.txt', browser_download_url: 'https://example.com/checksums.txt' },
      ],
    }
  }

  async function createUpdater(overrides: Partial<UpdaterRuntimeOps> = {}): Promise<{
    updater: DesktopUpdater
    ops: Record<string, ReturnType<typeof vi.fn>>
    downloadDirectory: string
  }> {
    const downloadDirectory = await mkdtemp(join(tmpdir(), 'dsh-updater-'))
    directories.push(downloadDirectory)
    const calls: Record<string, ReturnType<typeof vi.fn>> = {
      fetchJson: vi.fn(async (url: string) => {
        if (url.includes('/releases/tags/')) return releaseFixture('desktop-v0.2.0', '0.2.0')
        return [releaseFixture('desktop-v0.2.0', '0.2.0')]
      }),
      fetchText: vi.fn(async () => `${realDigest('e'.repeat(64))}  DeepSeek Harness Setup 0.2.0-x64.exe\n`),
      download: vi.fn(async () => {
        await writeFile(join(downloadDirectory, 'DeepSeek Harness Setup 0.2.0-x64.exe'), Buffer.from('e'.repeat(64)))
      }),
      readFile: vi.fn(async () => Buffer.from('e'.repeat(64))),
      unlink: vi.fn(async () => {}),
      dialog: vi.fn()
        .mockResolvedValueOnce('Download & Install')
        .mockResolvedValueOnce('Update Now'),
      spawnDetached: vi.fn(),
      runShellScript: vi.fn(async () => ({ ok: true, detail: '' })),
      quit: vi.fn(),
    }
    const updater = new DesktopUpdater({
      currentVersion: '0.1.0',
      platform: 'win32',
      preferences: { repository: 'owner/repo', channel: 'stable', autoUpdate: true },
      ops: { ...calls, ...overrides } as UpdaterRuntimeOps,
      logger: { log: vi.fn() },
    })
    return { updater, ops: calls, downloadDirectory }
  }

  it('reports up to date when no newer release exists', async () => {
    const { updater, ops } = await createUpdater()
    ops.fetchJson.mockResolvedValue([releaseFixture('desktop-v0.1.0', '0.1.0')])

    await expect(updater.check()).resolves.toEqual({ kind: 'up-to-date' })
  })

  it('downloads, verifies, and applies a Windows update after confirmation', async () => {
    const { updater, ops, downloadDirectory } = await createUpdater()
    const result = await updater.check()
    expect(result.kind).toBe('available')
    if (result.kind !== 'available') return

    const installed = await updater.install(result.update, downloadDirectory)

    expect(installed).toBe(true)
    expect(ops.download).toHaveBeenCalledWith('https://example.com/0.2.0.exe', join(downloadDirectory, 'DeepSeek Harness Setup 0.2.0-x64.exe'))
    expect(ops.spawnDetached).toHaveBeenCalledWith(join(downloadDirectory, 'DeepSeek Harness Setup 0.2.0-x64.exe'), ['/S'])
    expect(ops.quit).toHaveBeenCalled()
  })

  it('does not download when the user declines', async () => {
    const { updater, ops, downloadDirectory } = await createUpdater({ dialog: vi.fn(async () => 'Later') })
    const result = await updater.check()
    if (result.kind !== 'available') throw new Error('expected an update')

    await expect(updater.install(result.update, downloadDirectory)).resolves.toBe(false)
    expect(ops.download).not.toHaveBeenCalled()
  })

  it('refuses to install when the checksum does not match', async () => {
    const { updater, ops, downloadDirectory } = await createUpdater({
      readFile: vi.fn(async () => Buffer.from('wrong-content')),
    })
    const result = await updater.check()
    if (result.kind !== 'available') throw new Error('expected an update')

    await expect(updater.install(result.update, downloadDirectory)).rejects.toThrow('Update artifact checksum mismatch')
    expect(ops.spawnDetached).not.toHaveBeenCalled()
    expect(ops.unlink).toHaveBeenCalled()
  })
})

describe('macOS install script', () => {
  it('waits for the quitting app, installs, strips quarantine, and relaunches', () => {
    const script = macInstallScript('/tmp/DeepSeek Harness-0.2.0-arm64.dmg')

    expect(script).toContain('while pgrep -x "DeepSeek Harness" >/dev/null 2>&1; do sleep 1; done')
    expect(script).toContain('hdiutil attach -nobrowse -quiet')
    expect(script).toContain('ditto "$APP" "/Applications/DeepSeek Harness.app"')
    expect(script).toContain('xattr -dr com.apple.quarantine "/Applications/DeepSeek Harness.app"')
    expect(script).toContain('open "/Applications/DeepSeek Harness.app"')
  })
})
