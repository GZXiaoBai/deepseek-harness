import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const engine = await import(
  pathToFileURL(join(import.meta.dirname, '../scripts/verify-libreoffice-engine.mjs')).href,
) as {
  stagedEngineDirectory(resourcesDirectory: string, platform: NodeJS.Platform, arch: string): string
  verifyStagedLibreOfficeEngine(engineDirectory: string): Promise<{ files: number; bytes: number }>
}

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function digest(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

/** Writes one staged engine package with a manifest sealing the named files. */
async function stagedEngine(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-engine-'))
  roots.push(root)
  const directory = join(root, 'node_modules', '@deepseek-ai', 'libreoffice-kit-darwin-arm64')
  await mkdir(join(directory, 'program'), { recursive: true })
  for (const [relative, contents] of Object.entries(files)) {
    await mkdir(join(directory, relative, '..'), { recursive: true })
    await writeFile(join(directory, relative), contents)
  }
  await writeFile(join(directory, 'package.json'), '{"name":"@deepseek-ai/libreoffice-kit-darwin-arm64"}\n')
  await writeFile(join(directory, 'prebuilds.json'), JSON.stringify({
    schemaVersion: 1,
    status: 'built',
    files: Object.fromEntries(Object.entries(files).map(([relative, contents]) => [relative, digest(contents)])),
  }))
  return directory
}

describe('staged office engine verification', () => {
  it('resolves the engine package of each supported target', () => {
    expect(engine.stagedEngineDirectory('/app/resources/libreoffice', 'darwin', 'arm64'))
      .toBe('/app/resources/libreoffice/node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64')
    expect(engine.stagedEngineDirectory('/app/resources/libreoffice', 'win32', 'x64'))
      .toBe('/app/resources/libreoffice/node_modules/@deepseek-ai/libreoffice-kit-win32-x64')
    expect(() => engine.stagedEngineDirectory('/app/resources/libreoffice', 'linux', 'x64'))
      .toThrow('Unsupported office engine target: linux-x64')
  })

  it('accepts a package whose files match their recorded digests', async () => {
    const directory = await stagedEngine({
      'bin/libreoffice-kit': 'launcher\n',
      'program/libmergedlo.so': 'engine\n',
    })

    await expect(engine.verifyStagedLibreOfficeEngine(directory)).resolves.toEqual({
      files: 2,
      bytes: 'launcher\n'.length + 'engine\n'.length,
    })
  })

  it('rejects a changed, missing, or unrecorded engine file', async () => {
    const changed = await stagedEngine({ 'program/libmergedlo.so': 'engine\n' })
    await writeFile(join(changed, 'program/libmergedlo.so'), 'tampered\n')
    await expect(engine.verifyStagedLibreOfficeEngine(changed))
      .rejects.toThrow('Staged office engine file changed: program/libmergedlo.so')

    const missing = await stagedEngine({ 'program/libmergedlo.so': 'engine\n' })
    await rm(join(missing, 'program/libmergedlo.so'))
    await expect(engine.verifyStagedLibreOfficeEngine(missing))
      .rejects.toThrow('Staged office engine file is missing: program/libmergedlo.so')

    const unrecorded = await stagedEngine({ 'program/libmergedlo.so': 'engine\n' })
    await writeFile(join(unrecorded, 'program/extra.dll'), 'extra\n')
    await expect(engine.verifyStagedLibreOfficeEngine(unrecorded))
      .rejects.toThrow('Staged office engine contains an unrecorded file: program/extra.dll')
  })

  it('rejects an incompatible or unreadable manifest', async () => {
    const incompatible = await stagedEngine({ 'program/libmergedlo.so': 'engine\n' })
    await writeFile(join(incompatible, 'prebuilds.json'), JSON.stringify({ schemaVersion: 2, status: 'built', files: {} }))
    await expect(engine.verifyStagedLibreOfficeEngine(incompatible))
      .rejects.toThrow('Staged office engine manifest is incompatible')

    const unreadable = await stagedEngine({ 'program/libmergedlo.so': 'engine\n' })
    await rm(join(unreadable, 'prebuilds.json'))
    await expect(engine.verifyStagedLibreOfficeEngine(unreadable))
      .rejects.toThrow('Staged office engine manifest is unreadable')
  })
})
