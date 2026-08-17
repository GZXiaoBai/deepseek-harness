import { spawn } from 'node:child_process'
import { lstat, opendir, realpath, rm, stat, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { auditArm64MachO } from './macho-audit.mjs'

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
 * @property {StageCommand} verifyClosureCommand Runtime dependency closure command.
 * @property {StageCommand} deployCommand Production dependency deployment command.
 * @property {StageCommand} rebuildCommand Electron native-module rebuild command.
 */

/**
 * Creates the fixed Apple Silicon staging paths and subprocess arguments.
 *
 * @param {{ repoRoot: string, platform: NodeJS.Platform, arch: string, electronVersion: string }} input Target facts.
 * @returns {StagePlan} Deterministic staging plan.
 */
export function createStagePlan(input) {
  if (input.platform !== 'darwin' || input.arch !== 'arm64') {
    throw new Error(`Unsupported desktop staging target: ${input.platform}-${input.arch}; expected darwin-arm64`)
  }

  const repoRoot = resolve(input.repoRoot)
  const runtimeDirectory = join(repoRoot, 'apps/desktop/.runtime')
  return {
    runtimeDirectory,
    repoRoot,
    verifyClosureCommand: {
      executable: 'pnpm',
      args: [
        'exec',
        'tsx',
        'scripts/verify-runtime-closure.ts',
        '--manifest',
        'apps/desktop/runtime/package.json',
      ],
      cwd: repoRoot,
    },
    deployCommand: {
      executable: 'pnpm',
      args: [
        '--config.inject-workspace-packages=true',
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
      executable: 'pnpm',
      args: [
        'exec',
        'electron-rebuild',
        '--module-dir',
        runtimeDirectory,
        '--arch',
        'arm64',
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
  await pruneUnsupportedNodePtyPrebuild(plan.runtimeDirectory)
  const repairScript = await findRepairScript(plan.runtimeDirectory)
  await runCommand({
    executable: process.execPath,
    args: [repairScript],
    cwd: plan.runtimeDirectory,
  })
  await assertRuntimeSymlinksContained(plan.runtimeDirectory)
  await runCommand(plan.rebuildCommand)
  await resolveCliEntryPath(plan.runtimeDirectory)
  await resolveWebFrontendIndex(plan.runtimeDirectory)
  await assertRuntimeSymlinksContained(plan.runtimeDirectory)
  await (options.auditRuntime ?? auditArm64MachO)(plan.runtimeDirectory)
}

/**
 * Removes the dormant Intel node-pty prebuild from an Apple Silicon runtime.
 *
 * @param {string} runtimeDirectory Deployed Desktop runtime package root.
 * @returns {Promise<void>} Resolves after removing only the contained darwin-x64 directory.
 */
export async function pruneUnsupportedNodePtyPrebuild(runtimeDirectory) {
  const canonicalRuntimeDirectory = await realpath(runtimeDirectory)
  let nodePtyPackage
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
    nodePtyPackage = await resolveInternalPackage(
      createRequire(subprocessPackage),
      'node-pty/package.json',
      canonicalRuntimeDirectory,
    )
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
    throw new Error('Staged node-pty package is missing from the runtime dependency closure')
  }

  const nodePtyDirectory = dirname(nodePtyPackage)
  const prebuildsDirectory = join(nodePtyDirectory, 'prebuilds')
  const arm64Directory = join(prebuildsDirectory, 'darwin-arm64')
  const x64Directory = join(prebuildsDirectory, 'darwin-x64')
  await requireOrdinaryInternalDirectory(
    prebuildsDirectory,
    canonicalRuntimeDirectory,
    `Staged node-pty prebuilds must be an ordinary internal directory: ${prebuildsDirectory}`,
  )
  await requireOrdinaryInternalDirectory(
    arm64Directory,
    canonicalRuntimeDirectory,
    `Staged node-pty darwin-arm64 prebuild must be an ordinary internal directory: ${arm64Directory}`,
  )
  await requireOrdinaryFile(join(arm64Directory, 'pty.node'), 'Staged node-pty darwin-arm64 pty.node is missing')
  await requireOrdinaryFile(join(arm64Directory, 'spawn-helper'), 'Staged node-pty darwin-arm64 spawn-helper is missing')
  await requireOrdinaryInternalDirectory(
    x64Directory,
    canonicalRuntimeDirectory,
    `Staged node-pty darwin-x64 prebuild must be an ordinary internal directory: ${x64Directory}`,
  )
  await rm(x64Directory, { recursive: true })
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

/** @param {string} parent @param {string} candidate */
function contains(parent, candidate) {
  const fromParent = relative(parent, candidate)
  return fromParent === '' || (!fromParent.startsWith(`..${sep}`) && fromParent !== '..' && !isAbsolute(fromParent))
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
  })
  await executeStagePlan(plan)
}
