import { spawn } from 'node:child_process'
import { lstat, rm, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/**
 * @typedef {object} PackageCommand
 * @property {string} executable Command executable.
 * @property {readonly string[]} args Command arguments.
 * @property {string} cwd Command working directory.
 * @property {Readonly<Record<string, string>>} [environment] Fixed environment overrides.
 */

/**
 * @typedef {object} PackagePlan
 * @property {string} repoRoot Absolute repository root.
 * @property {string} releaseDirectory Exact Electron Builder output directory.
 * @property {readonly PackageCommand[]} commands Ordered packaging commands.
 */

/**
 * Creates the fixed local Apple Silicon packaging plan.
 *
 * @param {{ repoRoot: string, platform: NodeJS.Platform, arch: string }} input Host and checkout facts.
 * @returns {PackagePlan} Deterministic packaging paths and commands.
 */
export function createPackagePlan(input) {
  if (input.platform !== 'darwin' || input.arch !== 'arm64') {
    throw new Error(`Unsupported desktop packaging target: ${input.platform}-${input.arch}; expected darwin-arm64`)
  }

  const repoRoot = resolve(input.repoRoot)
  const desktopDirectory = join(repoRoot, 'apps/desktop')
  return {
    repoRoot,
    releaseDirectory: join(desktopDirectory, 'release'),
    commands: [
      {
        executable: process.execPath,
        args: [join(desktopDirectory, 'scripts/build-icon.mjs')],
        cwd: repoRoot,
      },
      {
        executable: process.execPath,
        args: [join(desktopDirectory, 'scripts/stage-runtime.mjs')],
        cwd: repoRoot,
      },
      {
        executable: process.execPath,
        args: [join(desktopDirectory, 'scripts/verify-runtime.mjs')],
        cwd: repoRoot,
      },
      {
        executable: 'pnpm',
        args: [
          'exec',
          'electron-builder',
          '--config',
          join(desktopDirectory, 'electron-builder.yml'),
          '--mac',
          '--arm64',
          '--publish',
          'never',
        ],
        cwd: desktopDirectory,
        environment: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
      },
    ],
  }
}

/**
 * Removes stale outputs and executes the fixed packaging sequence.
 *
 * @param {PackagePlan} plan Paths and commands returned by {@link createPackagePlan}.
 * @param {{ runCommand?: (command: PackageCommand) => Promise<void> }} [options] Injectable command runner.
 * @returns {Promise<void>} Resolves after Electron Builder finishes.
 */
export async function executePackagePlan(plan, options = {}) {
  validatePackagePlan(plan)
  await removeReleaseDirectory(plan.releaseDirectory)
  const runCommand = options.runCommand ?? runPackageCommand
  for (const command of plan.commands) await runCommand(command)
}

/** @param {PackagePlan} plan */
function validatePackagePlan(plan) {
  const expected = join(resolve(plan.repoRoot), 'apps/desktop/release')
  if (!isAbsolute(plan.releaseDirectory) || plan.releaseDirectory !== expected) {
    throw new Error(`Refusing to remove unexpected release directory: ${plan.releaseDirectory}`)
  }
}

/** @param {string} releaseDirectory */
async function removeReleaseDirectory(releaseDirectory) {
  let entry
  try {
    entry = await lstat(releaseDirectory)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }

  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    await unlink(releaseDirectory)
    return
  }
  await rm(releaseDirectory, { recursive: true })
}

/** @param {PackageCommand} command */
async function runPackageCommand(command) {
  await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: { ...process.env, ...command.environment },
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
  await executePackagePlan(createPackagePlan({
    repoRoot: REPOSITORY_ROOT,
    platform: process.platform,
    arch: process.arch,
  }))
}
