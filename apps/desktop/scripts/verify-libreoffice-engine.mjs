/** Verifies the staged office engine against the digests its own package publishes. */

import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { libreOfficeEnginePackage } from './stage-libreoffice-kit.mjs'

/** Files the engine package publishes outside its digest manifest. */
const UNRECORDED_ENGINE_FILES = new Set(['package.json', 'prebuilds.json'])

/**
 * Hashes one file with SHA-256.
 * @param path Absolute file path.
 * @returns Lower-case hexadecimal digest.
 */
async function fileDigest(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/** Lists repository-style relative paths of every regular file below one directory. */
async function listRelativeFiles(directory, prefix = '') {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) files.push(...await listRelativeFiles(join(directory, entry.name), relative))
    else if (entry.isFile()) files.push(relative)
  }
  return files.sort()
}

/**
 * Resolves the staged engine directory for one packaged application target.
 * @param resourcesDirectory Staged `resources/libreoffice` directory.
 * @param platform Application platform.
 * @param arch Application architecture.
 * @returns Absolute engine package directory.
 * @throws when the target has no supported engine package.
 */
export function stagedEngineDirectory(resourcesDirectory, platform, arch) {
  const enginePackage = libreOfficeEnginePackage(platform, arch)
  if (enginePackage === undefined) {
    throw new Error(`Unsupported office engine target: ${platform}-${arch}; expected darwin-arm64 or win32-x64`)
  }
  return join(resourcesDirectory, 'node_modules', ...enginePackage.split('/'))
}

/**
 * Checks every file the staged engine package publishes against its recorded
 * digest. The engine ships a 32-bit TWAIN helper beside its x64 and arm64
 * images, so the payload's integrity is the verifiable relationship here
 * rather than one architecture for every PE or Mach-O file.
 *
 * @param engineDirectory Staged engine package directory.
 * @returns Verified file count and byte total.
 * @throws when the manifest is incompatible, a recorded file is missing, changed, or unrecorded.
 */
export async function verifyStagedLibreOfficeEngine(engineDirectory) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(engineDirectory, 'prebuilds.json'), 'utf8'))
  } catch (error) {
    throw new Error(`Staged office engine manifest is unreadable: ${engineDirectory}`, { cause: error })
  }
  if (manifest.schemaVersion !== 1 || manifest.status !== 'built'
    || typeof manifest.files !== 'object' || manifest.files === null) {
    throw new Error(`Staged office engine manifest is incompatible: ${engineDirectory}`)
  }
  const recorded = Object.entries(manifest.files).sort(([left], [right]) => left.localeCompare(right))
  let bytes = 0
  for (const [relative, digest] of recorded) {
    const path = join(engineDirectory, relative)
    let contents
    try {
      contents = await readFile(path)
    } catch (error) {
      throw new Error(`Staged office engine file is missing: ${relative}`, { cause: error })
    }
    bytes += contents.byteLength
    const actual = createHash('sha256').update(contents).digest('hex')
    if (actual !== digest) throw new Error(`Staged office engine file changed: ${relative}`)
  }
  for (const relative of await listRelativeFiles(engineDirectory)) {
    if (UNRECORDED_ENGINE_FILES.has(relative)) continue
    if (!Object.hasOwn(manifest.files, relative)) {
      throw new Error(`Staged office engine contains an unrecorded file: ${relative}`)
    }
  }
  return { files: recorded.length, bytes }
}
