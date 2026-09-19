import { readFileSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const RELEASE_ORIGIN = 'https://github.com/GZXiaoBai/deepseek-harness/releases/download'

/**
 * Creates the static Tauri updater manifest for one desktop release.
 *
 * @param {{ tag: string, version: string, notes: string, pubDate: string, windows: { artifactName: string, signature: string }, macos: { artifactName: string, signature: string } }} input Release artifacts and metadata.
 * @returns {{ version: string, notes: string, pub_date: string, platforms: Record<string, { signature: string, url: string }> }} Tauri updater manifest.
 */
export function createTauriUpdateManifest(input) {
  if (input.tag !== `desktop-v${input.version}`) {
    throw new Error(`Desktop release tag ${input.tag} does not match version ${input.version}`)
  }
  const releaseUrl = `${RELEASE_ORIGIN}/${encodeURIComponent(input.tag)}`
  return {
    version: input.version,
    notes: input.notes,
    pub_date: input.pubDate,
    platforms: {
      'windows-x86_64': {
        signature: input.windows.signature.trim(),
        url: `${releaseUrl}/${encodeURIComponent(input.windows.artifactName)}`,
      },
      'darwin-aarch64': {
        signature: input.macos.signature.trim(),
        url: `${releaseUrl}/${encodeURIComponent(input.macos.artifactName)}`,
      },
    },
  }
}

/**
 * Finds signed updater artifacts and writes latest.json in a collected release directory.
 *
 * @param {{ releaseDirectory: string, tag: string, version: string, notes?: string, pubDate?: string }} input Release directory and metadata.
 * @returns {Promise<string>} Absolute latest.json path.
 */
export async function writeTauriUpdateManifest(input) {
  const releaseDirectory = resolve(input.releaseDirectory)
  const names = await readdir(releaseDirectory)
  const windowsArtifact = findExactlyOne(names, name => name.endsWith('-x64.exe'))
  const macosArtifact = findExactlyOne(names, name => name.endsWith('.app.tar.gz'))
  const manifest = createTauriUpdateManifest({
    tag: input.tag,
    version: input.version,
    notes: input.notes ?? `DeepSeek Harness desktop ${input.version}`,
    pubDate: input.pubDate ?? new Date().toISOString(),
    windows: {
      artifactName: windowsArtifact,
      signature: readFileSync(join(releaseDirectory, `${windowsArtifact}.sig`), 'utf8'),
    },
    macos: {
      artifactName: macosArtifact,
      signature: readFileSync(join(releaseDirectory, `${macosArtifact}.sig`), 'utf8'),
    },
  })
  const output = join(releaseDirectory, 'latest.json')
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`)
  return output
}

function findExactlyOne(names, predicate) {
  const matches = names.filter(predicate)
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one matching release artifact, found ${matches.length}`)
  }
  return basename(matches[0])
}

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error('Usage: create-tauri-update-manifest --release-directory DIR --tag TAG --version VERSION')
    }
    values.set(flag, value)
  }
  const releaseDirectory = values.get('--release-directory')
  const tag = values.get('--tag')
  const version = values.get('--version')
  if (releaseDirectory === undefined || tag === undefined || version === undefined) {
    throw new Error('Usage: create-tauri-update-manifest --release-directory DIR --tag TAG --version VERSION')
  }
  return { releaseDirectory, tag, version }
}

const isMain = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  const output = await writeTauriUpdateManifest(parseArguments(process.argv.slice(2)))
  process.stdout.write(`${output}\n`)
}
