import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createNativeSidecarBuildPath, createSidecarBuildPlan } from './build-sidecar.mjs'

const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const PROBE_PREFIX = 'DSH_DESKTOP_PROBE/1 '

/** Returns a stable probe cwd outside the removable external-plugin fixture. */
export function createFeasibilityProbeCwd(executable) {
  return dirname(executable)
}

/**
 * Returns the disk-only plugin fixture used to prove peer sharing and lifecycle.
 *
 * @returns {ReadonlyMap<string, string>} Relative file names and contents.
 */
export function createFeasibilityFixtureFiles() {
  return new Map([
    ['package.json', '{"type":"module"}\n'],
    ['node_modules/dsh-private-fixture/package.json', JSON.stringify({
      name: 'dsh-private-fixture',
      version: '1.0.0',
      type: 'module',
      exports: './index.mjs',
    }) + '\n'],
    ['node_modules/dsh-private-fixture/index.mjs', 'export const privateValue = "disk-private-dependency"\n'],
    ['index.mjs', `
import { Context } from '@deepseek-ai/cordis'
import DirectoryPicker from '@deepseek-ai/dsh-host-directory-picker'
import { privateValue } from 'dsh-private-fixture'

export async function probeDesktopPeers(expectedContext, expectedDirectoryPicker) {
  let disposed = false
  const ctx = new Context()
  const fiber = await ctx.plugin({
    name: 'desktop-external-fixture',
    apply(inner) {
      inner.provide('desktopFixture', { call: () => privateValue })
      inner.effect(() => () => { disposed = true })
    },
  })
  const service = Reflect.get(ctx, 'desktopFixture')
  const called = service?.call()
  await fiber.dispose()
  const removed = Reflect.get(ctx, 'desktopFixture') === undefined
  await ctx.fiber.dispose()
  return Context === expectedContext
    && DirectoryPicker === expectedDirectoryPicker
    && called === 'disk-private-dependency'
    && disposed
    && removed
}
`.trimStart()],
  ])
}

/**
 * Runs the host-native packaged sidecar against a real external disk plugin.
 *
 * @param {{ repoRoot?: string, platform?: NodeJS.Platform, arch?: string }} input Host overrides for tests.
 * @returns {Promise<void>} Resolves only when every feasibility capability passes.
 */
export async function verifyDesktopSidecarFeasibility(input = {}) {
  const repoRoot = resolve(input.repoRoot ?? REPOSITORY_ROOT)
  const plan = createSidecarBuildPlan({
    repoRoot,
    platform: input.platform ?? process.platform,
    arch: input.arch ?? process.arch,
  })
  const fixture = await mkdtemp(join(tmpdir(), 'dsh-desktop-plugin-'))
  try {
    for (const [relativePath, contents] of createFeasibilityFixtureFiles()) {
      const path = join(fixture, relativePath)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, contents)
    }
    const helperPath = process.platform === 'darwin'
      ? createNativeSidecarBuildPath(plan.outputPath, plan.rustTarget, 'spawn-helper', false)
      : undefined
    const result = await runProbe(plan.outputPath, join(fixture, 'index.mjs'), helperPath)
    for (const capability of ['nodePty', 'workerThread', 'koffi', 'externalPlugin']) {
      if (result[capability] !== true) {
        throw new Error(`Desktop sidecar feasibility failed: ${capability}`)
      }
    }
    console.log(`desktop sidecar feasibility: ${JSON.stringify(result)}`)
  } finally {
    await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

async function runProbe(executable, pluginPath, spawnHelperPath) {
  return await new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(executable, ['--desktop-feasibility-probe', pluginPath], {
      cwd: createFeasibilityProbeCwd(executable),
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        ...(spawnHelperPath === undefined ? {} : { DSH_NODE_PTY_SPAWN_HELPER: spawnHelperPath }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      rejectProbe(new Error(`Desktop sidecar feasibility timed out. stdout=${stdout} stderr=${stderr}`))
    }, 30_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.once('error', (error) => {
      clearTimeout(timeout)
      rejectProbe(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      const probeLines = stdout.split(/\r?\n/).filter(line => line.startsWith(PROBE_PREFIX))
      if (code !== 0 || probeLines.length !== 1) {
        rejectProbe(new Error(
          `Desktop sidecar feasibility exited with ${signal ?? String(code)}. stdout=${stdout} stderr=${stderr}`,
        ))
        return
      }
      try {
        resolveProbe(JSON.parse(probeLines[0].slice(PROBE_PREFIX.length)))
      } catch (error) {
        rejectProbe(new Error(`Invalid desktop sidecar feasibility result: ${String(error)}`))
      }
    })
  })
}

const isMain = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) await verifyDesktopSidecarFeasibility()
