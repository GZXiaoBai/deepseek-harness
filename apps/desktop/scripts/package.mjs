import { spawn } from 'node:child_process'
import { lstat, rm, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export { createWindowsIco } from './icon-format.mjs'

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
 * Creates the fixed host-native Desktop packaging plan.
 *
 * @param {{ repoRoot: string, platform: NodeJS.Platform, arch: string, pnpmEntrypoint?: string }} input Host and checkout facts.
 * @returns {PackagePlan} Deterministic packaging paths and commands.
 */
export function createPackagePlan(input) {
  const target = resolvePackageTarget(input.platform, input.arch)

  const repoRoot = resolve(input.repoRoot)
  const desktopDirectory = join(repoRoot, 'apps/desktop')
  const pnpm = resolvePnpmInvocation(target, input.pnpmEntrypoint)
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
        executable: pnpm.executable,
        args: [
          ...pnpm.prefixArgs,
          'exec',
          'electron-builder',
          '--config',
          join(desktopDirectory, 'electron-builder.yml'),
          target.platform === 'win32' ? '--win' : '--mac',
          target.arch === 'x64' ? '--x64' : '--arm64',
          '--publish',
          'never',
        ],
        cwd: desktopDirectory,
        environment: target.platform === 'win32'
          ? {
              CSC_IDENTITY_AUTO_DISCOVERY: 'false',
              CSC_KEY_PASSWORD: '',
              CSC_LINK: '',
              WIN_CSC_KEY_PASSWORD: '',
              WIN_CSC_LINK: '',
            }
          : { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
      },
    ],
  }
}

/** @param {NodeJS.Platform} platform @param {string} arch */
function resolvePackageTarget(platform, arch) {
  if (platform === 'darwin' && arch === 'arm64') return { platform, arch }
  if (platform === 'win32' && arch === 'x64') return { platform, arch }
  throw new Error(`Unsupported desktop packaging target: ${platform}-${arch}; expected darwin-arm64 or win32-x64`)
}

/** @param {{ platform: 'darwin' | 'win32' }} target @param {string | undefined} pnpmEntrypoint */
function resolvePnpmInvocation(target, pnpmEntrypoint) {
  if (target.platform === 'darwin') return { executable: 'pnpm', prefixArgs: [] }
  if (pnpmEntrypoint === undefined || pnpmEntrypoint === '') {
    throw new Error('Windows desktop packaging requires npm_execpath; invoke it through a pnpm package script')
  }
  return { executable: process.execPath, prefixArgs: [pnpmEntrypoint] }
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
    pnpmEntrypoint: process.env.npm_execpath,
  }))
}
