import { cp, lstat, mkdir, realpath, rm, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRuntimeSymlinksContained, resolveCliEntryPath, resolveWebFrontendIndex } from './stage-runtime.mjs'

const ARM64_ARCH = 3
const PRODUCT_NAME = 'DeepSeek Harness'
const DESKTOP_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * @typedef {object} AfterPackPlan
 * @property {string} desktopRoot Absolute Desktop package directory.
 * @property {string} sourceRuntime Verified staged runtime directory.
 * @property {string} appPath Electron Builder App bundle path.
 * @property {string} destinationRuntime Runtime path below the App resources directory.
 */

/**
 * Creates the fixed arm64 runtime-copy paths used by Electron Builder's afterPack hook.
 *
 * @param {{ desktopRoot: string, electronPlatformName: string, arch: number, appOutDir: string }} input Builder context.
 * @returns {AfterPackPlan} Validated source and destination paths.
 */
export function createAfterPackPlan(input) {
  if (input.electronPlatformName !== 'darwin' || input.arch !== ARM64_ARCH) {
    throw new Error(
      `Unsupported Desktop afterPack target: ${input.electronPlatformName}-${String(input.arch)}; expected darwin-arm64`,
    )
  }
  const desktopRoot = resolve(input.desktopRoot)
  const appOutDir = resolve(input.appOutDir)
  const expectedAppOutDir = join(desktopRoot, 'release/mac-arm64')
  if (appOutDir !== expectedAppOutDir) {
    throw new Error(`Unexpected Desktop afterPack output directory: ${appOutDir}`)
  }
  const appPath = join(appOutDir, `${PRODUCT_NAME}.app`)
  return {
    desktopRoot,
    sourceRuntime: join(desktopRoot, '.runtime'),
    appPath,
    destinationRuntime: join(appPath, 'Contents/Resources/runtime'),
  }
}

/**
 * Copies one contained staged runtime into the exact unsigned App bundle.
 *
 * @param {AfterPackPlan} plan Fixed paths returned by {@link createAfterPackPlan}.
 * @param {{ copyRuntime?: (source: string, destination: string) => Promise<void> }} [options] Injectable copier.
 * @returns {Promise<void>} Resolves after packaged anchors and symlinks pass validation.
 */
export async function copyRuntimeForPackage(plan, options = {}) {
  validatePlanPaths(plan)
  await assertRuntimeSymlinksContained(plan.sourceRuntime)
  await resolveCliEntryPath(plan.sourceRuntime)
  await resolveWebFrontendIndex(plan.sourceRuntime)

  await removeDestinationRuntime(plan.destinationRuntime)
  await mkdir(dirname(plan.destinationRuntime), { recursive: true })
  await (options.copyRuntime ?? copyRuntimeDirectory)(plan.sourceRuntime, plan.destinationRuntime)

  const canonicalApp = await realpath(plan.appPath)
  const canonicalRuntime = await realpath(plan.destinationRuntime)
  if (!contains(canonicalApp, canonicalRuntime)) {
    throw new Error(`Packaged runtime resolves outside the App bundle: ${canonicalRuntime}`)
  }
  await assertRuntimeSymlinksContained(plan.destinationRuntime)
  await resolveCliEntryPath(plan.destinationRuntime)
  await resolveWebFrontendIndex(plan.destinationRuntime)
}

/** @param {string} source @param {string} destination */
async function copyRuntimeDirectory(source, destination) {
  await cp(source, destination, {
    dereference: false,
    preserveTimestamps: true,
    recursive: true,
    verbatimSymlinks: true,
  })
}

/** @param {AfterPackPlan} plan */
function validatePlanPaths(plan) {
  const desktopRoot = resolve(plan.desktopRoot)
  const expectedSource = join(desktopRoot, '.runtime')
  const expectedApp = join(desktopRoot, 'release/mac-arm64', `${PRODUCT_NAME}.app`)
  const expectedDestination = join(expectedApp, 'Contents/Resources/runtime')
  if (
    !isAbsolute(plan.sourceRuntime)
    || plan.sourceRuntime !== expectedSource
    || plan.appPath !== expectedApp
    || plan.destinationRuntime !== expectedDestination
  ) {
    throw new Error(`Refusing unexpected Desktop afterPack paths: ${JSON.stringify(plan)}`)
  }
}

/** @param {string} destinationRuntime */
async function removeDestinationRuntime(destinationRuntime) {
  let entry
  try {
    entry = await lstat(destinationRuntime)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    await unlink(destinationRuntime)
    return
  }
  await rm(destinationRuntime, { recursive: true })
}

/** @param {string} parent @param {string} candidate */
function contains(parent, candidate) {
  const fromParent = relative(parent, candidate)
  return fromParent === '' || (!fromParent.startsWith(`..${sep}`) && fromParent !== '..' && !isAbsolute(fromParent))
}

/**
 * Copies the verified runtime after normal resources and before Electron fuses and signing.
 *
 * @param {{ electronPlatformName: string, arch: number, appOutDir: string }} context Electron Builder afterPack context.
 * @returns {Promise<void>} Resolves after the packaged runtime passes containment checks.
 */
export default async function afterPack(context) {
  await copyRuntimeForPackage(createAfterPackPlan({
    desktopRoot: DESKTOP_ROOT,
    electronPlatformName: context.electronPlatformName,
    arch: context.arch,
    appOutDir: context.appOutDir,
  }))
}
