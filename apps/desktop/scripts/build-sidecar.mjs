import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const PKG_SPEC = '@yao-pkg/pkg@6.21.0'
const ENTRY_BIN = 'node_modules/@deepseek-ai/dsh-desktop/lib/sidecar-bin.js'
const PACKAGED_MODULE_ROSTER_MARKER = '["__DSH_DESKTOP_MODULE_ROSTER__"]'
const NON_IMPORTABLE_PACKAGES = new Set([
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-desktop',
  '@deepseek-ai/dsh-web-frontend',
])
export const SIDECAR_ASSET_GLOBS = [
  'package.json',
  'node_modules/**/*.js',
  'node_modules/**/*.cjs',
  'node_modules/**/*.mjs',
  'node_modules/**/package.json',
  'node_modules/**/*.json',
  'node_modules/**/*.yml',
  'node_modules/**/*.yaml',
  'node_modules/**/*.node',
  'node_modules/**/*.dylib',
  'node_modules/**/*.dll',
  'node_modules/**/*.so',
  'node_modules/**/*.so.*',
  'node_modules/**/*.wasm',
  'node_modules/@deepseek-ai/dsh-desktop/sidecar/**/*',
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/**/*',
]

/**
 * Resolves one supported native host into pkg and Tauri target names.
 *
 * @param {{ repoRoot: string, platform: NodeJS.Platform, arch: string }} input Host facts.
 * @returns {{ stagingDirectory: string, outputPath: string, pkgTarget: string, rustTarget: string, executableSuffix: string }} Fixed build paths.
 */
export function createSidecarBuildPlan(input) {
  let pkgTarget
  let rustTarget
  let executableSuffix
  if (input.platform === 'darwin' && input.arch === 'arm64') {
    pkgTarget = 'node24-macos-arm64'
    rustTarget = 'aarch64-apple-darwin'
    executableSuffix = ''
  } else if (input.platform === 'win32' && input.arch === 'x64') {
    pkgTarget = 'node24-win-x64'
    rustTarget = 'x86_64-pc-windows-msvc'
    executableSuffix = '.exe'
  } else {
    throw new Error(`Unsupported desktop sidecar target: ${input.platform}-${input.arch}`)
  }

  const repoRoot = resolve(input.repoRoot)
  return {
    stagingDirectory: join(repoRoot, 'apps/desktop/.sidecar-runtime'),
    outputPath: join(
      repoRoot,
      `apps/desktop/src-tauri/binaries/dsh-desktop-sidecar-${rustTarget}${executableSuffix}`,
    ),
    pkgTarget,
    rustTarget,
    executableSuffix,
  }
}

/** Returns the legacy deploy arguments for the minimal SEA runtime closure. */
export function createSidecarDeployArgs(stagingDirectory) {
  return [
    '--filter',
    '@deepseek-ai/dsh-desktop-runtime',
    'deploy',
    '--legacy',
    '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    // The workspace also patches Electron's macOS signer, which is intentionally
    // absent from the sidecar-only production closure.
    '--config.allow-unused-patches=true',
    stagingDirectory,
  ]
}

/** Returns the sorted exact package names the VFS resolver must own. */
export function createPackagedModuleList(manifest) {
  return Object.keys(manifest.dependencies ?? {})
    .filter(packageName => !NON_IMPORTABLE_PACKAGES.has(packageName))
    .sort()
}

/** Replaces the compiled roster marker with exact, sorted staged package names. */
export function injectPackagedModuleRoster(source, packageNames) {
  if (!source.includes(PACKAGED_MODULE_ROSTER_MARKER)) {
    throw new Error('Desktop sidecar module roster marker is missing from the compiled entry')
  }
  return source.replace(PACKAGED_MODULE_ROSTER_MARKER, JSON.stringify([...packageNames].sort()))
}

const DEVELOPMENT_DIRECTORIES = new Set([
  '.circleci',
  '.github',
  '.pnpm',
  '__tests__',
  'bench',
  'benchmark',
  'benchmarks',
  'coverage',
  'doc',
  'docs',
  'example',
  'examples',
  'test',
  'tests',
])

/** Returns whether a deployed path is forbidden from the production SEA. */
export function shouldPruneStagedRuntimePath(relativePath, directory) {
  const normalized = relativePath.replaceAll('\\', '/')
  const segments = normalized.split('/')
  const name = segments.at(-1) ?? ''
  if (segments.includes('.pnpm')) return true
  const nodeModulesIndex = segments.lastIndexOf('node_modules')
  const packageOffset = segments[nodeModulesIndex + 1]?.startsWith('@') ? 3 : 2
  const withinPackage = segments.slice(nodeModulesIndex + packageOffset)
  if (directory) return withinPackage.length === 1 && DEVELOPMENT_DIRECTORIES.has(name)
  if (normalized === 'node_modules/@deepseek-ai/dsh-desktop/lib/main.js') return true
  if (/\.(?:map|d\.ts|d\.mts|d\.cts)$/i.test(name)) return true
  if (/\.(?:ts|tsx|mts|cts)$/i.test(name)) return true
  if (/^(?:README|CHANGELOG|CONTRIBUTING)(?:\.[^.]+)?\.md$/i.test(name)) return true
  if (/(?:^|\.)(?:spec|test)\.[cm]?js$/i.test(name)) return true
  return /^(?:eslint|prettier|rollup|tsdown|vite|vitest|webpack)\.config\.[cm]?js$/i.test(name)
    || /^tsconfig(?:\.[^.]+)?\.json$/i.test(name)
    || /^\.(?:eslint|prettier)rc(?:\..+)?$/i.test(name)
}

/** Returns a verifier command that cannot mutate the workspace dependency mode. */
export function createSidecarVerifyCommand(repoRoot, nodePath) {
  return {
    executable: nodePath,
    args: [
      join(repoRoot, 'node_modules/tsx/dist/cli.mjs'),
      'scripts/verify-runtime-closure.ts',
      '--manifest',
      'apps/desktop/runtime/package.json',
    ],
  }
}

/** Returns a target-suffixed helper input whose installed name matches `process.execPath` suffix lookup. */
export function createNativeSidecarBuildPath(outputPath, rustTarget, kind, windows) {
  return join(
    dirname(outputPath),
    `dsh-desktop-sidecar-${kind}-${rustTarget}${windows ? '.exe' : ''}`,
  )
}

/** Builds the host-native Node 24 SEA and its required native helper files. */
export async function buildDesktopSidecar() {
  const plan = createSidecarBuildPlan({
    repoRoot: REPOSITORY_ROOT,
    platform: process.platform,
    arch: process.arch,
  })
  const verify = createSidecarVerifyCommand(REPOSITORY_ROOT, process.execPath)
  await run('verify runtime closure', verify.executable, verify.args)
  await rm(plan.stagingDirectory, { recursive: true, force: true })
  await run('deploy sidecar closure', 'pnpm', createSidecarDeployArgs(plan.stagingDirectory))
  await restoreLegacyHoists(plan.stagingDirectory)
  await materializeStagedLinks(plan.stagingDirectory)
  await pruneNodePtyPrebuilds(plan.stagingDirectory, process.platform, process.arch)
  await pruneStagedRuntime(plan.stagingDirectory)
  await injectPkgConfig(plan.stagingDirectory)
  await mkdir(dirname(plan.outputPath), { recursive: true })
  await run('build Node 24 SEA', 'pnpm', [
    'dlx',
    PKG_SPEC,
    plan.stagingDirectory,
    '--sea',
    '--targets',
    plan.pkgTarget,
    '--output',
    plan.outputPath,
  ])
  if (!existsSync(plan.outputPath)) throw new Error(`Desktop sidecar output is missing: ${plan.outputPath}`)
  await chmod(plan.outputPath, 0o755)
  await copyNativeSidecars(plan.stagingDirectory, plan, process.platform, process.arch)
  console.log(`desktop sidecar: ${plan.outputPath}`)
  return plan
}

async function restoreLegacyHoists(stagingDirectory) {
  const manifest = JSON.parse(await readFile(join(stagingDirectory, 'package.json'), 'utf8'))
  const sourceNodeModules = join(REPOSITORY_ROOT, 'apps/desktop/runtime/node_modules')
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(stagingDirectory, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(sourceNodeModules, dependency)
    if (!existsSync(source)) throw new Error(`Deployed sidecar dependency is missing: ${dependency}`)
    await mkdir(dirname(destination), { recursive: true })
    const nestedNodeModules = join(source, 'node_modules')
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(`${nestedNodeModules}${sep}`),
    })
  }
}

async function materializeStagedLinks(stagingDirectory) {
  const nodeModules = join(stagingDirectory, 'node_modules')
  let link = await findSymlink(nodeModules)
  while (link !== undefined) {
    const segments = link.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
    } else {
      const source = await realpath(link)
      const nestedNodeModules = join(source, 'node_modules')
      await rm(link, { recursive: true, force: true })
      await cp(source, link, {
        recursive: true,
        dereference: true,
        filter: path => path !== nestedNodeModules && !path.startsWith(`${nestedNodeModules}${sep}`),
      })
    }
    link = await findSymlink(nodeModules)
  }
}

async function findSymlink(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if ((await lstat(path)).isSymbolicLink()) return path
    if (entry.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

async function pruneNodePtyPrebuilds(stagingDirectory, platform, arch) {
  const runtimeRequire = createRequire(join(stagingDirectory, 'package.json'))
  const nodePtyManifest = runtimeRequire.resolve('node-pty/package.json')
  const prebuilds = join(dirname(nodePtyManifest), 'prebuilds')
  const retained = platform === 'darwin' ? `darwin-${arch}` : `win32-${arch}`
  for (const entry of await readdir(prebuilds, { withFileTypes: true })) {
    if (entry.name !== retained) await rm(join(prebuilds, entry.name), { recursive: true, force: true })
  }
}

async function pruneStagedRuntime(stagingDirectory) {
  await visit(stagingDirectory)

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const pathFromRoot = relative(stagingDirectory, path)
      if (shouldPruneStagedRuntimePath(pathFromRoot, entry.isDirectory())) {
        await rm(path, { recursive: true, force: true })
      } else if (entry.isDirectory()) {
        await visit(path)
      }
    }
  }
}

async function injectPkgConfig(stagingDirectory) {
  const manifestPath = join(stagingDirectory, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (!existsSync(join(stagingDirectory, ENTRY_BIN))) {
    throw new Error(`Desktop sidecar entry is missing: ${join(stagingDirectory, ENTRY_BIN)}`)
  }
  const entryPath = join(stagingDirectory, ENTRY_BIN)
  const packagedModules = await discoverPackagedModules(stagingDirectory)
  await writeFile(entryPath, injectPackagedModuleRoster(await readFile(entryPath, 'utf8'), packagedModules))
  await writeFile(manifestPath, `${JSON.stringify({
    ...manifest,
    bin: ENTRY_BIN,
    pkg: { assets: SIDECAR_ASSET_GLOBS },
  }, null, 2)}\n`)
}

async function discoverPackagedModules(stagingDirectory) {
  const scopeDirectory = join(stagingDirectory, 'node_modules', '@deepseek-ai')
  return (await readdir(scopeDirectory, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => `@deepseek-ai/${entry.name}`)
    .filter(packageName => !NON_IMPORTABLE_PACKAGES.has(packageName))
    .sort()
}

async function copyNativeSidecars(stagingDirectory, plan, platform, arch) {
  const runtimeRequire = createRequire(join(stagingDirectory, 'package.json'))
  const rgPackage = platform === 'darwin'
    ? `@vscode/ripgrep-darwin-${arch}`
    : `@vscode/ripgrep-win32-${arch}`
  const rgManifest = runtimeRequire.resolve(`${rgPackage}/package.json`)
  const rgName = platform === 'win32' ? 'rg.exe' : 'rg'
  const rgSource = join(dirname(rgManifest), 'bin', rgName)
  await copyFile(
    rgSource,
    createNativeSidecarBuildPath(plan.outputPath, plan.rustTarget, 'rg', platform === 'win32'),
  )
  if (platform !== 'darwin') return

  const nodePtyManifest = runtimeRequire.resolve('node-pty/package.json')
  const helper = join(dirname(nodePtyManifest), 'prebuilds', `darwin-${arch}`, 'spawn-helper')
  const helperOutput = createNativeSidecarBuildPath(plan.outputPath, plan.rustTarget, 'spawn-helper', false)
  await copyFile(helper, helperOutput)
  await chmod(helperOutput, 0o755)
}

async function run(label, executable, args) {
  console.log(`desktop sidecar: ${label}`)
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd: REPOSITORY_ROOT,
      stdio: 'inherit',
      env: { ...process.env, CI: 'true' },
    })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`${label} failed with ${signal ?? `exit code ${String(code)}`}`))
    })
  })
}

const isMain = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) await buildDesktopSidecar()
