/** Reads the real-filesystem packages the packaged shell stages beside the sidecar. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DesktopRealPackage, DesktopRealPackages } from './sidecar-module-resolver.ts'

/** Environment variable naming the staged office resources, set by the desktop shell. */
export const DESKTOP_REAL_PACKAGES_ROOT_ENV = 'DSH_DESKTOP_REAL_PACKAGES_ROOT'

/** Manifest written beside the staged packages by the sidecar build. */
export const STAGED_REAL_PACKAGES_FILENAME = 'staged-packages.json'

interface StagedRealPackagesManifest {
  schemaVersion?: unknown
  packages?: unknown
}

function readPackageEntry(root: string, value: unknown): DesktopRealPackage {
  if (typeof value !== 'object' || value === null) {
    throw new Error('desktop real package entry must be an object')
  }
  const { directory, entry } = value as { directory?: unknown; entry?: unknown }
  if (typeof directory !== 'string' || typeof entry !== 'string') {
    throw new Error('desktop real package entry requires string directory and entry paths')
  }
  return {
    entry: pathToFileURL(join(root, entry)).href,
    directory: pathToFileURL(join(root, directory)).href,
  }
}

/**
 * Reads the packages staged beneath one resource root. An absent or empty root
 * yields no mappings, so development runs keep the embedded runtime alone.
 *
 * @param root Absolute resources directory, or `undefined` when the shell staged none.
 * @returns Package name to real entry and directory URLs.
 */
export function readDesktopRealPackages(root: string | undefined): DesktopRealPackages {
  const packages = new Map<string, DesktopRealPackage>()
  if (root === undefined || root.trim() === '') return packages
  const manifestPath = join(root, STAGED_REAL_PACKAGES_FILENAME)
  let manifest: StagedRealPackagesManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as StagedRealPackagesManifest
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return packages
    throw new Error(`desktop real package manifest is unreadable: ${manifestPath}`, { cause: error })
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error(`desktop real package manifest has an unsupported schemaVersion: ${manifestPath}`)
  }
  if (typeof manifest.packages !== 'object' || manifest.packages === null) {
    throw new Error(`desktop real package manifest declares no packages: ${manifestPath}`)
  }
  for (const [name, value] of Object.entries(manifest.packages)) {
    packages.set(name, readPackageEntry(root, value))
  }
  return packages
}
