import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_REAL_PACKAGES_ROOT_ENV,
  STAGED_REAL_PACKAGES_FILENAME,
  readDesktopRealPackages,
} from '../src/sidecar-real-packages.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function resourceRoot(manifest?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-real-packages-'))
  roots.push(root)
  if (manifest !== undefined) await writeFile(join(root, STAGED_REAL_PACKAGES_FILENAME), manifest)
  return root
}

describe('desktop real packages', () => {
  it('names the environment variable the desktop shell sets', () => {
    expect(DESKTOP_REAL_PACKAGES_ROOT_ENV).toBe('DSH_DESKTOP_REAL_PACKAGES_ROOT')
  })

  it('maps no packages when the shell staged none', async () => {
    expect(readDesktopRealPackages(undefined).size).toBe(0)
    expect(readDesktopRealPackages('   ').size).toBe(0)
    expect(readDesktopRealPackages(await resourceRoot()).size).toBe(0)
  })

  it('reads the staged entry and directory as absolute file URLs', async () => {
    const root = await resourceRoot(JSON.stringify({
      schemaVersion: 1,
      packages: {
        '@deepseek-ai/libreoffice-kit': {
          directory: 'node_modules/@deepseek-ai/libreoffice-kit/',
          entry: 'node_modules/@deepseek-ai/libreoffice-kit/lib/index.js',
        },
      },
    }))

    const packages = readDesktopRealPackages(root)
    expect(packages.get('@deepseek-ai/libreoffice-kit')).toEqual({
      entry: pathToFileURL(join(root, 'node_modules/@deepseek-ai/libreoffice-kit/lib/index.js')).href,
      directory: pathToFileURL(join(root, 'node_modules/@deepseek-ai/libreoffice-kit/')).href,
    })
  })

  it('rejects an unreadable or unsupported manifest', async () => {
    await expect(async () => readDesktopRealPackages(await resourceRoot('not json')))
      .rejects.toThrow('desktop real package manifest is unreadable')
    await expect(async () => readDesktopRealPackages(await resourceRoot('{"schemaVersion":2,"packages":{}}')))
      .rejects.toThrow('unsupported schemaVersion')
    await expect(async () => readDesktopRealPackages(await resourceRoot('{"schemaVersion":1,"packages":null}')))
      .rejects.toThrow('declares no packages')
    await expect(async () => readDesktopRealPackages(await resourceRoot(
      '{"schemaVersion":1,"packages":{"probe":{"directory":1,"entry":"a.js"}}}',
    ))).rejects.toThrow('requires string directory and entry paths')
  })
})
