import { spawn } from 'node:child_process'
import { copyFile, lstat, mkdir, opendir, realpath, rm, stat, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { auditArm64MachO } from './macho-audit.mjs'
import { auditX64Pe } from './pe-audit.mjs'

const ELECTRON_VERSION = '43.4.0'
const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const REPAIR_SCRIPT_SUFFIX = join(
  'node_modules',
  '@deepseek-ai',
  'dsh-subprocess-local',
  'scripts',
  'ensure-spawn-helper.mjs',
)

/**
 * @typedef {object} StageCommand
 * @property {string} executable Command executable.
 * @property {readonly string[]} args Command arguments.
 * @property {string} cwd Command working directory.
 */

/**
 * @typedef {object} StagePlan
 * @property {string} runtimeDirectory Absolute deployment directory.
 * @property {string} repoRoot Absolute repository root.
 * @property {{ platform: 'darwin', arch: 'arm64' } | { platform: 'win32', arch: 'x64' }} target Native target.
 * @property {StageCommand} verifyClosureCommand Runtime dependency closure command.
 * @property {StageCommand} deployCommand Production dependency deployment command.
 * @property {StageCommand} rebuildCommand Electron native-module rebuild command.
 */

/**
 * Creates the fixed native Desktop staging paths and subprocess arguments.
 *
 * @param {{ repoRoot: string, platform: NodeJS.Platform, arch: string, electronVersion: string, pnpmEntrypoint?: string }} input Target facts.
 * @returns {StagePlan} Deterministic staging plan.
 */
export function createStagePlan(input) {
  const target = resolveStageTarget(input.platform, input.arch)

  const repoRoot = resolve(input.repoRoot)
  const runtimeDirectory = join(repoRoot, 'apps/desktop/.runtime')
  const pnpm = resolvePnpmInvocation(target, input.pnpmEntrypoint)
  return {
    runtimeDirectory,
    repoRoot,
    target,
    verifyClosureCommand: {
      executable: pnpm.executable,
      args: [
        ...pnpm.prefixArgs,
        'exec',
        'tsx',
        'scripts/verify-runtime-closure.ts',
        '--manifest',
        'apps/desktop/runtime/package.json',
      ],
      cwd: repoRoot,
    },
    deployCommand: {
      executable: pnpm.executable,
      args: [
        ...pnpm.prefixArgs,
        '--config.inject-workspace-packages=true',
        ...(target.platform === 'win32' ? ['--config.node-linker=hoisted'] : []),
        '--ignore-scripts',
        '--frozen-lockfile',
        '--filter',
        '@deepseek-ai/dsh-desktop-runtime',
        '--prod',
        'deploy',
        runtimeDirectory,
      ],
      cwd: repoRoot,
    },
    rebuildCommand: {
      executable: pnpm.executable,
      args: [
        ...pnpm.prefixArgs,
        'exec',
        'electron-rebuild',
        '--module-dir',
        runtimeDirectory,
        ...(target.platform === 'win32' ? ['--platform', 'win32'] : []),
        '--arch',
        target.arch,
        '--version',
        input.electronVersion,
      ],
      cwd: repoRoot,
    },
  }
}

/**
 * Executes a staging plan and validates its deployable runtime closure.
 *
 * @param {StagePlan} plan Fixed paths and commands returned by {@link createStagePlan}.
 * @param {{ runCommand?: (command: StageCommand) => Promise<void>, auditRuntime?: (runtimeDirectory: string) => Promise<unknown> }} [options] Injectable staging operations.
 * @returns {Promise<void>} Resolves after the staged closure passes validation.
 */
export async function executeStagePlan(plan, options = {}) {
  validateRuntimeTarget(plan)
  const runCommand = options.runCommand ?? runStageCommand
  await runCommand(plan.verifyClosureCommand)
  await removeRuntimeDirectory(plan.runtimeDirectory)
  await runCommand(plan.deployCommand)
  await assertRuntimeSymlinksContained(plan.runtimeDirectory)
  if (plan.target.platform === 'win32') await assertRuntimeContainsNoLinks(plan.runtimeDirectory)
  await validateNodePtyPrebuild(plan.runtimeDirectory, plan.target)
  const repairScript = await findRepairScript(plan.runtimeDirectory)
  await runCommand({
    executable: process.execPath,
    args: [repairScript],
    cwd: plan.runtimeDirectory,
  })
  await assertRuntimeSymlinksContained(plan.runtimeDirectory)
  if (plan.target.platform === 'win32') await assertRuntimeContainsNoLinks(plan.runtimeDirectory)
  await runCommand(plan.rebuildCommand)
  if (plan.target.platform === 'win32') await ensureConptyReleaseAssets(plan.runtimeDirectory)
  await resolveCliEntryPath(plan.runtimeDirectory)
  await resolveWebFrontendIndex(plan.runtimeDirectory)
  await assertRuntimeSymlinksContained(plan.runtimeDirectory)
  if (plan.target.platform === 'win32') await assertRuntimeContainsNoLinks(plan.runtimeDirectory)
  const nodePtyIgnored = await resolveNodePtyIgnoredRelativePath(plan.runtimeDirectory)
  const auditRuntime = options.auditRuntime ?? (
    plan.target.platform === 'win32'
      ? root => auditX64Pe(root, { ignoredRelativePaths: [nodePtyIgnored] })
      : root => auditArm64MachO(root, { ignoredRelativePaths: [nodePtyIgnored] })
  )
  await auditRuntime(plan.runtimeDirectory)
}

/**
 * Copies the ConPTY runtime assets beside the rebuilt win32 conpty.node.
 *
 * electron-rebuild compiles conpty.node into `build/Release` but the package's
 * post-install step (disabled during staging) is what places conpty.dll and
 * OpenConsole.exe there; the C++ loader resolves them relative to the loaded
 * module. The win32 prebuild directory already carries the pair, so staging
 * mirrors them into the release directory.
 *
 * @param {string} runtimeDirectory Deployed Desktop runtime package root.
 * @returns {Promise<void>} Resolves after the assets are in place.
 */
export async function ensureConptyReleaseAssets(runtimeDirectory) {
  const canonicalRuntimeDirectory = await realpath(runtimeDirectory)
  const nodePtyPackage = await resolveNodePtyPackage(runtimeDirectory, canonicalRuntimeDirectory)
  const releaseDirectory = join(dirname(nodePtyPackage), 'build/Release')
  const prebuildDirectory = join(dirname(nodePtyPackage), 'prebuilds/win32-x64')
  const releaseConpty = join(releaseDirectory, 'conpty')
  await mkdir(releaseConpty, { recursive: true })
  for (const asset of ['conpty.dll', 'OpenConsole.exe']) {
    await copyFile(join(prebuildDirectory, 'conpty', asset), join(releaseConpty, asset))
  }
}

/** @param {string} runtimeDirectory @param {string} canonicalRuntimeDirectory */
async function resolveNodePtyPackage(runtimeDirectory, canonicalRuntimeDirectory) {
  try {
    const runtimeRequire = createRequire(join(runtimeDirectory, 'package.json'))
    const dshPackage = await resolveInternalPackage(
      runtimeRequire,
      '@deepseek-ai/dsh/package.json',
      canonicalRuntimeDirectory,
    )
    const basePackage = await resolveInternalPackage(
      createRequire(dshPackage),
      '@deepseek-ai/dsh-base/package.json',
      canonicalRuntimeDirectory,
    )
    const subprocessPackage = await resolveInternalPackage(
      createRequire(basePackage),
      '@deepseek-ai/dsh-subprocess-local/package.json',
      canonicalRuntimeDirectory,
    )
    return await resolveInternalPackage(
      createRequire(subprocessPackage),
      'node-pty/package.json',
      canonicalRuntimeDirectory,
    )
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
    throw new Error('Staged node-pty package is missing from the runtime dependency closure')
  }
}

/**
 * Validates the node-pty prebuilds required by the native Desktop target.
 *
 * The staged closure ships every published node-pty prebuild; this check only
 * asserts that the target platform's runtime files are present and ordinary,
 * so a packaging regression fails staging instead of the installed app.
 *
 * @param {string} runtimeDirectory Deployed Desktop runtime package root.
 * @param {{ platform: 'darwin', arch: 'arm64' } | { platform: 'win32', arch: 'x64' }} target Native target.
 * @returns {Promise<void>} Resolves after validating the retained prebuild.
 */
export async function validateNodePtyPrebuild(runtimeDirectory, target) {
  const canonicalRuntimeDirectory = await realpath(runtimeDirectory)
  const nodePtyPackage = await resolveNodePtyPackage(runtimeDirectory, canonicalRuntimeDirectory)

  const nodePtyDirectory = dirname(nodePtyPackage)
  const prebuildsDirectory = join(nodePtyDirectory, 'prebuilds')
  await requireOrdinaryInternalDirectory(
    prebuildsDirectory,
    canonicalRuntimeDirectory,
    `Staged node-pty prebuilds must be an ordinary internal directory: ${prebuildsDirectory}`,
  )
  if (target.platform === 'darwin') {
    const arm64Directory = join(prebuildsDirectory, 'darwin-arm64')
    await requireOrdinaryInternalDirectory(
      arm64Directory,
      canonicalRuntimeDirectory,
      `Staged node-pty darwin-arm64 prebuild must be an ordinary internal directory: ${arm64Directory}`,
    )
    await requireOrdinaryFile(join(arm64Directory, 'pty.node'), 'Staged node-pty darwin-arm64 pty.node is missing')
    await requireOrdinaryFile(join(arm64Directory, 'spawn-helper'), 'Staged node-pty darwin-arm64 spawn-helper is missing')
    return
  }

  const retainedDirectory = join(prebuildsDirectory, 'win32-x64')
  await requireOrdinaryInternalDirectory(
    retainedDirectory,
    canonicalRuntimeDirectory,
    `Staged node-pty win32-x64 prebuild must be an ordinary internal directory: ${retainedDirectory}`,
  )
  // node-pty 1.2-beta ships a ConPTY-only Windows runtime: winpty is gone and
  // the win32 prebuilds carry conpty.node plus the ConPTY assets, no pty.node.
  for (const relativePath of [
    'conpty.node',
    'conpty_console_list.node',
    'conpty/conpty.dll',
    'conpty/OpenConsole.exe',
  ]) {
    await requireOrdinaryFile(
      join(retainedDirectory, relativePath),
      `Staged node-pty win32-x64 file is missing: ${relativePath}`,
    )
  }
}

/**
 * Resolves the node-pty package directory as a canonical root-relative path.
 *
 * node-pty ships prebuilds for every platform in one package, so the
 * architecture audits exclude its directory while `validateNodePtyPrebuild`
 * keeps the target platform's files under review.
 *
 * @param {string} runtimeDirectory Deployed Desktop runtime package root.
 * @returns {Promise<string>} Canonical root-relative path of the node-pty package directory.
 */
export async function resolveNodePtyIgnoredRelativePath(runtimeDirectory) {
  const canonicalRuntimeDirectory = await realpath(runtimeDirectory)
  const nodePtyPackage = await resolveNodePtyPackage(runtimeDirectory, canonicalRuntimeDirectory)
  return relative(canonicalRuntimeDirectory, dirname(nodePtyPackage))
}

/** @param {NodeJS.Require} packageRequire @param {string} specifier @param {string} canonicalRuntimeDirectory */
async function resolveInternalPackage(packageRequire, specifier, canonicalRuntimeDirectory) {
  const packagePath = packageRequire.resolve(specifier)
  const entry = await lstat(packagePath)
  const canonicalPath = await realpath(packagePath)
  if (entry.isSymbolicLink() || !entry.isFile() || !contains(canonicalRuntimeDirectory, canonicalPath)) {
    throw new Error(`Staged package manifest must be a regular internal file: ${packagePath}`)
  }
  return canonicalPath
}

/** @param {string} path @param {string} canonicalRuntimeDirectory @param {string} message */
async function requireOrdinaryInternalDirectory(path, canonicalRuntimeDirectory, message) {
  try {
    const entry = await lstat(path)
    if (!entry.isSymbolicLink() && entry.isDirectory() && contains(canonicalRuntimeDirectory, await realpath(path))) return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  throw new Error(message)
}

/** @param {string} path @param {string} message */
async function requireOrdinaryFile(path, message) {
  try {
    const entry = await lstat(path)
    if (!entry.isSymbolicLink() && entry.isFile()) return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  throw new Error(message)
}

/**
 * Resolves the CLI entry from the private runtime root's dsh dependency.
 *
 * @param {string} runtimeDirectory Deployed Desktop runtime package root.
 * @returns {Promise<string>} Absolute staged CLI entry path.
 */
export async function resolveCliEntryPath(runtimeDirectory) {
  try {
    const canonicalRuntimeDirectory = await realpath(runtimeDirectory)
    const runtimeRequire = createRequire(join(runtimeDirectory, 'package.json'))
    const dshPackage = runtimeRequire.resolve('@deepseek-ai/dsh/package.json')
    if (!contains(canonicalRuntimeDirectory, await realpath(dshPackage))) throw missingCliEntry()
    const cliEntryPath = join(dirname(dshPackage), 'lib/bin.js')
    await requireFile(cliEntryPath, 'Staged CLI entry point is missing from the @deepseek-ai/dsh dependency closure')
    return cliEntryPath
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
    throw missingCliEntry()
  }
}

function missingCliEntry() {
  return new Error('Staged CLI entry point is missing from the @deepseek-ai/dsh dependency closure')
}

/**
 * Resolves the frontend from the staged Web bundle's declared dependency context.
 *
 * @param {string} runtimeDirectory Deployed CLI package root.
 * @returns {Promise<string>} Absolute staged frontend index path.
 */
export async function resolveWebFrontendIndex(runtimeDirectory) {
  try {
    const canonicalRuntimeDirectory = await realpath(runtimeDirectory)
    const runtimeRequire = createRequire(join(runtimeDirectory, 'package.json'))
    const dshPackage = runtimeRequire.resolve('@deepseek-ai/dsh/package.json')
    if (!contains(canonicalRuntimeDirectory, await realpath(dshPackage))) {
      throw missingWebFrontend()
    }
    const dshRequire = createRequire(dshPackage)
    const webAppPackage = dshRequire.resolve('@deepseek-ai/dsh-web-app/package.json')
    if (!contains(canonicalRuntimeDirectory, await realpath(webAppPackage))) {
      throw missingWebFrontend()
    }
    const webAppRequire = createRequire(webAppPackage)
    const indexPath = webAppRequire.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
    if (!contains(canonicalRuntimeDirectory, await realpath(indexPath))) {
      throw missingWebFrontend()
    }
    await requireFile(indexPath, `Staged Web frontend is missing: ${indexPath}`)
    return indexPath
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
    throw missingWebFrontend()
  }
}

function missingWebFrontend() {
  return new Error('Staged Web frontend is missing from the @deepseek-ai/dsh-web-app dependency closure')
}

/** @param {string} runtimeDirectory */
async function findRepairScript(runtimeDirectory) {
  const canonicalRuntimeDirectory = await realpath(runtimeDirectory)
  const matches = []
  for await (const path of walk(runtimeDirectory)) {
    if (!path.endsWith(REPAIR_SCRIPT_SUFFIX)) continue
    const entry = await lstat(path)
    const canonicalPath = await realpath(path)
    if (entry.isSymbolicLink() || !entry.isFile() || !contains(canonicalRuntimeDirectory, canonicalPath)) {
      throw new Error(`Staged subprocess permission repair must be a regular internal file: ${path}`)
    }
    matches.push(path)
  }
  if (matches.length !== 1) {
    throw new Error(`Expected one staged subprocess permission repair script, found ${String(matches.length)}`)
  }
  return matches[0]
}

/** @param {StagePlan} plan */
function validateRuntimeTarget(plan) {
  const expected = join(resolve(plan.repoRoot), 'apps/desktop/.runtime')
  if (plan.runtimeDirectory !== expected || !isAbsolute(plan.runtimeDirectory)) {
    throw new Error(`Refusing to stage unexpected runtime directory: ${plan.runtimeDirectory}`)
  }
}

/** @param {string} runtimeDirectory */
async function removeRuntimeDirectory(runtimeDirectory) {
  let entry
  try {
    entry = await lstat(runtimeDirectory)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }

  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    await unlink(runtimeDirectory)
    return
  }
  await rm(runtimeDirectory, { recursive: true })
}

/** @param {string} path @param {string} message */
async function requireFile(path, message) {
  try {
    if ((await stat(path)).isFile()) return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  throw new Error(message)
}

/**
 * Requires every deployed symlink to resolve inside the staged runtime.
 *
 * @param {string} runtimeDirectory Deployed CLI package root.
 * @returns {Promise<void>} Resolves when all symlink targets are contained.
 */
export async function assertRuntimeSymlinksContained(runtimeDirectory) {
  const canonicalRuntimeDirectory = await realpath(runtimeDirectory)
  for await (const path of walk(runtimeDirectory)) {
    const entry = await lstat(path)
    if (!entry.isSymbolicLink()) continue
    const target = await realpath(path)
    if (!contains(canonicalRuntimeDirectory, target)) {
      throw new Error(`Staged symlink resolves outside the runtime: ${path} -> ${target}`)
    }
  }
}

/**
 * Rejects every filesystem link from the Windows runtime shipped to end users.
 *
 * @param {string} runtimeDirectory Windows tree root.
 * @param {string} [label] Human-readable tree label for failures.
 * @returns {Promise<void>} Resolves when every entry is an ordinary file or directory.
 */
export async function assertRuntimeContainsNoLinks(runtimeDirectory, label = 'Windows runtime') {
  if ((await lstat(runtimeDirectory)).isSymbolicLink()) {
    throw new Error(`${label} contains a filesystem link: ${runtimeDirectory}`)
  }
  for await (const path of walk(runtimeDirectory)) {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`${label} contains a filesystem link: ${path}`)
    }
  }
}

export { auditX64Pe }

/** @param {string} parent @param {string} candidate */
function contains(parent, candidate) {
  const fromParent = relative(parent, candidate)
  return fromParent === '' || (!fromParent.startsWith(`..${sep}`) && fromParent !== '..' && !isAbsolute(fromParent))
}

/** @param {NodeJS.Platform} platform @param {string} arch */
function resolveStageTarget(platform, arch) {
  if (platform === 'darwin' && arch === 'arm64') return { platform, arch }
  if (platform === 'win32' && arch === 'x64') return { platform, arch }
  throw new Error(`Unsupported desktop staging target: ${platform}-${arch}; expected darwin-arm64 or win32-x64`)
}

/** @param {{ platform: 'darwin' | 'win32' }} target @param {string | undefined} pnpmEntrypoint */
function resolvePnpmInvocation(target, pnpmEntrypoint) {
  if (target.platform === 'darwin') return { executable: 'pnpm', prefixArgs: [] }
  if (pnpmEntrypoint === undefined || pnpmEntrypoint === '') {
    throw new Error('Windows desktop staging requires npm_execpath; invoke it through a pnpm package script')
  }
  return { executable: process.execPath, prefixArgs: [pnpmEntrypoint] }
}

/** @param {string} directory */
async function* walk(directory) {
  const entries = await opendir(directory)
  for await (const entry of entries) {
    const path = join(directory, entry.name)
    yield path
    if (entry.isDirectory()) yield* walk(path)
  }
}

/** @param {StageCommand} command */
async function runStageCommand(command) {
  await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      stdio: 'inherit',
    })
    child.once('error', rejectCommand)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveCommand()
        return
      }
      rejectCommand(new Error(
        `${command.executable} ${command.args.join(' ')} failed with ${signal === null ? `exit code ${String(code)}` : `signal ${signal}`}`,
      ))
    })
  })
}

const isMain = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  const plan = createStagePlan({
    repoRoot: REPOSITORY_ROOT,
    platform: process.platform,
    arch: process.arch,
    electronVersion: ELECTRON_VERSION,
    pnpmEntrypoint: process.env.npm_execpath,
  })
  await executeStagePlan(plan)
}
