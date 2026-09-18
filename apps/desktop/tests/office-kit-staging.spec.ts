import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const staging = await import(
  pathToFileURL(join(import.meta.dirname, '../scripts/stage-libreoffice-kit.mjs')).href,
) as {
  LIBREOFFICE_KIT_PACKAGE: string
  STAGED_REAL_PACKAGES_FILENAME: string
  libreOfficeEnginePackage(platform: NodeJS.Platform, arch: string): string | undefined
  resolveLibreOfficeClosure(stagedRoot: string, platform: NodeJS.Platform, arch: string): Promise<string[]>
  stageLibreOfficeKit(options: {
    stagedRoot: string
    resourcesDirectory: string
    platform: NodeJS.Platform
    arch: string
  }): Promise<{ resourcesDirectory: string; packages: Record<string, { directory: string; entry: string }> }>
  pruneLibreOfficeStagedPackages(stagedRoot: string, platform: NodeJS.Platform, arch: string): Promise<string[]>
}

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function stagedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-staging-'))
  roots.push(root)
  return root
}

async function writeStagedPackage(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = { 'lib/index.js': 'export const value = 1\n' },
): Promise<string> {
  const directory = join(root, 'node_modules', ...name.split('/'))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name, version: '0.0.1', ...manifest })}\n`)
  for (const [relative, contents] of Object.entries(files)) {
    await mkdir(join(directory, relative, '..'), { recursive: true })
    await writeFile(join(directory, relative), contents)
  }
  return directory
}

describe('desktop office kit staging', () => {
  it('names the engine package for each supported packaging target', () => {
    expect(staging.libreOfficeEnginePackage('darwin', 'arm64')).toBe('@deepseek-ai/libreoffice-kit-darwin-arm64')
    expect(staging.libreOfficeEnginePackage('win32', 'x64')).toBe('@deepseek-ai/libreoffice-kit-win32-x64')
    expect(staging.libreOfficeEnginePackage('linux', 'x64')).toBeUndefined()
    expect(staging.libreOfficeEnginePackage('darwin', 'x64')).toBeUndefined()
  })

  it('collects the kit, its engine, and every installed production dependency', async () => {
    const root = await stagedRoot()
    await writeStagedPackage(root, staging.LIBREOFFICE_KIT_PACKAGE, {
      main: 'lib/index.js',
      dependencies: { fflate: '0.0.1' },
      optionalDependencies: { fontkit: '0.0.1', '@deepseek-ai/libreoffice-kit-linux-x64': '0.0.1' },
    })
    await writeStagedPackage(root, '@deepseek-ai/libreoffice-kit-darwin-arm64', {})
    await writeStagedPackage(root, 'fflate', { dependencies: { saxes: '0.0.1' } })
    await writeStagedPackage(root, 'fontkit', {})
    await writeStagedPackage(root, 'saxes', {})

    await expect(staging.resolveLibreOfficeClosure(root, 'darwin', 'arm64')).resolves.toEqual([
      '@deepseek-ai/libreoffice-kit',
      '@deepseek-ai/libreoffice-kit-darwin-arm64',
      'fflate',
      'fontkit',
      'saxes',
    ])
  })

  it('fails loud when the platform engine or the kit is not staged', async () => {
    const root = await stagedRoot()
    await writeStagedPackage(root, staging.LIBREOFFICE_KIT_PACKAGE, { main: 'lib/index.js' })

    await expect(staging.resolveLibreOfficeClosure(root, 'darwin', 'arm64'))
      .rejects.toThrow('Staged office engine is missing: @deepseek-ai/libreoffice-kit-darwin-arm64')
    await expect(staging.resolveLibreOfficeClosure(root, 'linux', 'x64'))
      .rejects.toThrow('Unsupported office conversion target: linux-x64')
  })

  it('copies the closure beside the executable and records its entry points', async () => {
    const root = await stagedRoot()
    const resources = join(root, 'resources', 'libreoffice')
    await writeStagedPackage(root, staging.LIBREOFFICE_KIT_PACKAGE, {
      main: 'lib/index.js',
      dependencies: { fflate: '0.0.1' },
    })
    await writeStagedPackage(root, '@deepseek-ai/libreoffice-kit-darwin-arm64', {}, {
      'bin/libreoffice-kit': '#!/bin/sh\n',
      'prebuilds.json': '{"engine":{"kind":"native"}}\n',
    })
    await writeStagedPackage(root, 'fflate', {})

    const staged = await staging.stageLibreOfficeKit({
      stagedRoot: root,
      resourcesDirectory: resources,
      platform: 'darwin',
      arch: 'arm64',
    })

    expect(staged.packages).toEqual({
      '@deepseek-ai/libreoffice-kit': {
        directory: 'node_modules/@deepseek-ai/libreoffice-kit/',
        entry: 'node_modules/@deepseek-ai/libreoffice-kit/lib/index.js',
      },
    })
    const manifest = JSON.parse(await readFile(
      join(resources, staging.STAGED_REAL_PACKAGES_FILENAME),
      'utf8',
    )) as { schemaVersion: number; packages: Record<string, { entry: string }> }
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.packages['@deepseek-ai/libreoffice-kit']?.entry)
      .toBe('node_modules/@deepseek-ai/libreoffice-kit/lib/index.js')
    await expect(readFile(
      join(resources, 'node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64/package.json'),
      'utf8',
    )).resolves.toContain('@deepseek-ai/libreoffice-kit-darwin-arm64')
    await expect(readFile(join(resources, 'node_modules/fflate/package.json'), 'utf8')).resolves.toContain('fflate')
  })

  it('removes the kit and engine from the staged runtime but keeps their dependencies', async () => {
    const root = await stagedRoot()
    await writeStagedPackage(root, staging.LIBREOFFICE_KIT_PACKAGE, { main: 'lib/index.js' })
    await writeStagedPackage(root, '@deepseek-ai/libreoffice-kit-darwin-arm64', {})
    await writeStagedPackage(root, 'fflate', {})

    await expect(staging.pruneLibreOfficeStagedPackages(root, 'darwin', 'arm64')).resolves.toEqual([
      '@deepseek-ai/libreoffice-kit',
      '@deepseek-ai/libreoffice-kit-darwin-arm64',
    ])
    await expect(readFile(join(root, 'node_modules/fflate/package.json'), 'utf8')).resolves.toContain('fflate')
    await expect(readFile(join(root, 'node_modules/@deepseek-ai/libreoffice-kit/package.json'), 'utf8'))
      .rejects.toThrow()
  })
})
