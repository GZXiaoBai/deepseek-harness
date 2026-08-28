import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildDesktopSidecar, createPnpmCommand } from './build-sidecar.mjs'
import { verifyDesktopSidecarFeasibility } from './verify-sidecar-feasibility.mjs'

const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const DESKTOP_ROOT = join(REPOSITORY_ROOT, 'apps/desktop')

/**
 * Creates the host-native Tauri package paths and arguments.
 *
 * @param {{ repoRoot: string, platform: NodeJS.Platform, arch: string, signedUpdates?: boolean }} input Host facts.
 * @returns {{ desktopRoot: string, releaseDirectory: string, rustTarget: string, installerName?: string, dmgName?: string, sourceBuildArguments: string[], buildArguments: string[] }} Native package plan.
 */
export function createTauriPackagePlan(input) {
  const repoRoot = resolve(input.repoRoot)
  const desktopRoot = join(repoRoot, 'apps/desktop')
  const manifest = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8'))
  const version = manifest.version
  const releaseDirectory = join(desktopRoot, 'release-tauri')
  const updaterArguments = input.signedUpdates === true
    ? ['--config', 'src-tauri/tauri.updater.conf.json']
    : []
  const sourceBuildArguments = ['--filter', '@deepseek-ai/dsh-desktop', 'run', 'build']
  if (input.platform === 'win32' && input.arch === 'x64') {
    const rustTarget = 'x86_64-pc-windows-msvc'
    return {
      desktopRoot,
      releaseDirectory,
      rustTarget,
      sourceBuildArguments,
      installerName: `DeepSeek Harness Setup ${version}-x64.exe`,
      buildArguments: [
        'build', '--config', 'src-tauri/tauri.windows.conf.json', ...updaterArguments, '--target', rustTarget,
      ],
    }
  }
  if (input.platform === 'darwin' && input.arch === 'arm64') {
    const rustTarget = 'aarch64-apple-darwin'
    return {
      desktopRoot,
      releaseDirectory,
      rustTarget,
      sourceBuildArguments,
      dmgName: `DeepSeek Harness-${version}-arm64.dmg`,
      buildArguments: [
        'build', '--config', 'src-tauri/tauri.macos.conf.json', ...updaterArguments, '--target', rustTarget,
      ],
    }
  }
  throw new Error(
    `Unsupported Tauri desktop packaging target: ${input.platform}-${input.arch}; expected darwin-arm64 or win32-x64`,
  )
}

/**
 * Normalizes an optional private-key path to the environment read by Tauri CLI.
 *
 * @param {NodeJS.ProcessEnv} environment Parent process environment.
 * @returns {NodeJS.ProcessEnv} Additional signing environment without logging key material.
 */
export function createTauriSigningEnvironment(environment) {
  if (environment.TAURI_SIGNING_PRIVATE_KEY?.trim()) return {}
  const keyPath = environment.TAURI_SIGNING_PRIVATE_KEY_PATH?.trim()
  if (!keyPath) return {}
  return { TAURI_SIGNING_PRIVATE_KEY: readFileSync(resolve(keyPath), 'utf8') }
}

/**
 * Builds and collects one host-native Tauri package without touching Electron artifacts.
 *
 * @param {ReturnType<typeof createTauriPackagePlan>} plan Native package plan.
 * @returns {Promise<void>} Resolves after the package artifacts have been collected.
 */
export async function packageTauriDesktop(plan, signingEnvironment = {}) {
  const pnpm = createPnpmCommand(process.env, process.execPath)
  await run(pnpm.executable, [...pnpm.argsPrefix, ...plan.sourceBuildArguments], REPOSITORY_ROOT)
  await rm(plan.releaseDirectory, { recursive: true, force: true })
  await mkdir(plan.releaseDirectory, { recursive: true })
  await run(process.execPath, [join(plan.desktopRoot, 'scripts/build-icon.mjs')], REPOSITORY_ROOT)
  await buildDesktopSidecar()
  await verifyDesktopSidecarFeasibility({ repoRoot: REPOSITORY_ROOT })
  // pnpm's legacy production deploy marks the shared workspace installation as
  // production-only. Restore the frozen developer graph before invoking Tauri.
  await run(
    pnpm.executable,
    [...pnpm.argsPrefix, 'install', '--frozen-lockfile'],
    REPOSITORY_ROOT,
  )
  await run(
    process.execPath,
    [join(plan.desktopRoot, 'node_modules/@tauri-apps/cli/tauri.js'), ...plan.buildArguments],
    plan.desktopRoot,
    { CARGO_BUILD_JOBS: '1', ...signingEnvironment },
  )
  await collectArtifacts(plan)
}

async function collectArtifacts(plan) {
  const targetRelease = join(plan.desktopRoot, 'src-tauri/target', plan.rustTarget, 'release')
  if (plan.installerName !== undefined) {
    const nsisDirectory = join(targetRelease, 'bundle/nsis')
    const installers = (await readdir(nsisDirectory))
      .filter(name => name.toLowerCase().endsWith('.exe'))
    if (installers.length !== 1) {
      throw new Error(`Expected one Tauri NSIS installer, found ${installers.length}`)
    }
    await cp(join(nsisDirectory, installers[0]), join(plan.releaseDirectory, plan.installerName))
    const unpacked = join(plan.releaseDirectory, 'win-unpacked')
    await mkdir(unpacked, { recursive: true })
    for (const name of [
      'deepseek-harness-desktop.exe',
      'dsh-desktop-sidecar.exe',
      'dsh-desktop-sidecar-rg.exe',
    ]) {
      await cp(join(targetRelease, name), join(unpacked, name === 'deepseek-harness-desktop.exe'
        ? 'DeepSeek Harness.exe'
        : name))
    }
    const signature = `${join(nsisDirectory, installers[0])}.sig`
    try {
      await cp(signature, `${join(plan.releaseDirectory, plan.installerName)}.sig`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return
  }

  const appSource = join(targetRelease, 'bundle/macos/DeepSeek Harness.app')
  await cp(appSource, join(plan.releaseDirectory, 'DeepSeek Harness.app'), { recursive: true })
  const dmgDirectory = join(targetRelease, 'bundle/dmg')
  const dmgs = (await readdir(dmgDirectory)).filter(name => name.toLowerCase().endsWith('.dmg'))
  if (dmgs.length !== 1) throw new Error(`Expected one Tauri DMG, found ${dmgs.length}`)
  await cp(join(dmgDirectory, dmgs[0]), join(plan.releaseDirectory, plan.dmgName))
  const updaterDirectory = join(targetRelease, 'bundle/macos')
  for (const name of await readdir(updaterDirectory)) {
    if (!name.endsWith('.tar.gz') && !name.endsWith('.tar.gz.sig')) continue
    await cp(join(updaterDirectory, name), join(plan.releaseDirectory, basename(name)))
  }
}

async function run(executable, args, cwd, environment = {}) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, CI: 'true', ...environment },
    })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`${executable} failed with ${signal ?? `exit code ${String(code)}`}`))
    })
  })
}

const isMain = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  const signingEnvironment = createTauriSigningEnvironment(process.env)
  await packageTauriDesktop(createTauriPackagePlan({
    repoRoot: REPOSITORY_ROOT,
    platform: process.platform,
    arch: process.arch,
    signedUpdates: Boolean(
      process.env.TAURI_SIGNING_PRIVATE_KEY?.trim()
      || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH?.trim(),
    ),
  }), signingEnvironment)
}
