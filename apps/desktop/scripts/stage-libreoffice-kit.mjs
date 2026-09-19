/** Stages the office-conversion kit and its platform engine as ordinary resources beside the sidecar. */

import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const SIDECAR_RESOURCES_DIRECTORY = 'apps/desktop/src-tauri/resources'

/** Kit API package the Harness office provider imports. */
export const LIBREOFFICE_KIT_PACKAGE = '@deepseek-ai/libreoffice-kit'

/** Manifest naming every staged real-filesystem package inside the resources directory. */
export const STAGED_REAL_PACKAGES_FILENAME = 'staged-packages.json'

/**
 * Resolves the platform engine package installed beside the kit API.
 * @param platform Host platform of the packaged application.
 * @param arch Host architecture of the packaged application.
 * @returns Engine package name, or `undefined` for an unsupported target.
 */
export function libreOfficeEnginePackage(platform, arch) {
  if (platform === 'darwin' && arch === 'arm64') return `${LIBREOFFICE_KIT_PACKAGE}-darwin-arm64`
  if (platform === 'win32' && arch === 'x64') return `${LIBREOFFICE_KIT_PACKAGE}-win32-x64`
  return undefined
}

/**
 * Resolves one installed package directory inside a staged flat node_modules tree.
 * @param stagedRoot Staged runtime root holding node_modules.
 * @param packageName Package name, scoped or bare.
 * @returns Absolute package directory.
 */
export function stagedPackageDirectory(stagedRoot, packageName) {
  return join(stagedRoot, 'node_modules', ...packageName.split('/'))
}

async function packageManifest(directory) {
  return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
}

/**
 * Collects the kit API, its engine, and every installed production dependency between them.
 * @param stagedRoot Staged runtime root holding node_modules.
 * @param platform Host platform of the packaged application.
 * @param arch Host architecture of the packaged application.
 * @returns Sorted package names that ship on the real filesystem.
 * @throws when the target is unsupported or the kit or engine package is not staged.
 */
export async function resolveLibreOfficeClosure(stagedRoot, platform, arch) {
  const enginePackage = libreOfficeEnginePackage(platform, arch)
  if (enginePackage === undefined) {
    throw new Error(`Unsupported office conversion target: ${platform}-${arch}; expected darwin-arm64 or win32-x64`)
  }
  const closure = new Set()
  // The engine is listed among the kit's optional dependencies, so an
  // installation that omits it must still fail the staging step.
  const queue = [LIBREOFFICE_KIT_PACKAGE, enginePackage]
  while (queue.length > 0) {
    const packageName = queue.shift()
    if (closure.has(packageName)) continue
    const directory = stagedPackageDirectory(stagedRoot, packageName)
    let manifest
    try {
      manifest = await packageManifest(directory)
    } catch (error) {
      if (packageName === enginePackage) {
        throw new Error(`Staged office engine is missing: ${enginePackage}`, { cause: error })
      }
      if (packageName === LIBREOFFICE_KIT_PACKAGE) {
        throw new Error(`Staged office kit is missing: ${LIBREOFFICE_KIT_PACKAGE}`, { cause: error })
      }
      // A missing optional dependency means this host never installs that package.
      continue
    }
    closure.add(packageName)
    const dependents = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    }
    for (const dependency of Object.keys(dependents).sort()) queue.push(dependency)
  }
  return [...closure].sort()
}

/**
 * Copies the office kit closure into the application resources directory and
 * records the entry points the sidecar maps onto the real filesystem.
 * @param {{ stagedRoot: string, resourcesDirectory?: string, platform: NodeJS.Platform, arch: string }} options Staging inputs.
 * @returns {{ resourcesDirectory: string, packages: Record<string, { directory: string, entry: string }> }} Staged layout facts.
 */
export async function stageLibreOfficeKit(options) {
  const resourcesDirectory = options.resourcesDirectory
    ?? join(REPOSITORY_ROOT, SIDECAR_RESOURCES_DIRECTORY, 'libreoffice')
  const closure = await resolveLibreOfficeClosure(options.stagedRoot, options.platform, options.arch)
  await rm(resourcesDirectory, { recursive: true, force: true })
  await mkdir(resourcesDirectory, { recursive: true })
  for (const packageName of closure) {
    const source = stagedPackageDirectory(options.stagedRoot, packageName)
    const destination = join(resourcesDirectory, 'node_modules', ...packageName.split('/'))
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, { recursive: true, dereference: true, force: true })
  }
  const stagedRequire = createRequire(join(options.stagedRoot, 'package.json'))
  const directory = `node_modules/${LIBREOFFICE_KIT_PACKAGE}/`
  const entryWithinPackage = relative(
    await realpath(stagedPackageDirectory(options.stagedRoot, LIBREOFFICE_KIT_PACKAGE)),
    await realpath(stagedRequire.resolve(LIBREOFFICE_KIT_PACKAGE)),
  ).split(sep).join('/')
  const packages = { [LIBREOFFICE_KIT_PACKAGE]: { directory, entry: `${directory}${entryWithinPackage}` } }
  await writeFile(
    join(resourcesDirectory, STAGED_REAL_PACKAGES_FILENAME),
    `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`,
  )
  return { resourcesDirectory, packages }
}

/**
 * Removes the kit and engine packages from the staged runtime so the packaged
 * executable does not embed a second copy of the platform engine.
 * @param stagedRoot Staged runtime root holding node_modules.
 * @param platform Host platform of the packaged application.
 * @param arch Host architecture of the packaged application.
 * @returns Sorted package names removed from the staged runtime.
 */
export async function pruneLibreOfficeStagedPackages(stagedRoot, platform, arch) {
  const enginePackage = libreOfficeEnginePackage(platform, arch)
  if (enginePackage === undefined) return []
  const scopeDirectory = join(stagedRoot, 'node_modules', '@deepseek-ai')
  const installed = await readdir(scopeDirectory).catch(() => [])
  const removed = []
  for (const name of [LIBREOFFICE_KIT_PACKAGE, enginePackage]) {
    if (!installed.includes(name.split('/')[1])) continue
    await rm(stagedPackageDirectory(stagedRoot, name), { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

const isMain = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) {
  const [stagedRoot] = process.argv.slice(2)
  if (stagedRoot === undefined) {
    throw new Error('Usage: stage-libreoffice-kit.mjs <staged-runtime-root>')
  }
  const staged = await stageLibreOfficeKit({ stagedRoot, platform: process.platform, arch: process.arch })
  console.log(`desktop office kit: ${staged.resourcesDirectory}`)
}
