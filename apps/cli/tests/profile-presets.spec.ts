/** Preset configuration survives CLI composition and embedded-host overrides. */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initProfile, PROFILE_PATCH_FILENAME, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProfile } from '../src/profile-boot.ts'

const fixture = new URL('./fixtures/preset-config-recorder.mjs', import.meta.url).href
const signalEvents = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'] as const
const processEvents: EventEmitter = process
let home: string
let previousHome: string | undefined
let run: Awaited<ReturnType<typeof runProfile>> | undefined
let listeners: Map<string, ReturnType<EventEmitter['listeners']>>

beforeEach(() => {
  previousHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'dsh-cli-preset-config-'))
  process.env.DSH_HOME = home
  listeners = new Map(signalEvents.map(event => [event, processEvents.listeners(event)]))
})

afterEach(async () => {
  await run?.ctx.fiber.dispose()
  run = undefined
  for (const event of signalEvents) {
    for (const listener of processEvents.listeners(event)) {
      if (!listeners.get(event)?.includes(listener)) {
        processEvents.removeListener(event, listener as (...args: unknown[]) => void)
      }
    }
  }
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

function writePresetPatch(defaultId: string, roots: { path: string; trust: string }[], name = fixture): string {
  const profileDir = resolveProfileDir('preset-config', home)
  const record = join(home, 'observed.json')
  writeFileSync(join(profileDir, PROFILE_PATCH_FILENAME), JSON.stringify([{
    insert: [{ id: 'agent-presets', name, config: { default: defaultId, roots, record } }],
  }]))
  return record
}

describe('profile preset configuration', () => {
  it('preserves configured preset roots in an ordinary CLI launch', async () => {
    initProfile(resolveProfileDir('preset-config', home), [], 'startup')
    const roots = [{ path: join(home, 'custom-presets'), trust: 'user' }]
    const record = writePresetPatch('custom', roots)

    run = await runProfile({
      environment: createLaunchEnvironmentSnapshot([]), profile: 'preset-config', patchFiles: [], args: [],
      resolutionMode: 'runtime',
    })

    expect(JSON.parse(readFileSync(record, 'utf8'))).toMatchObject({ default: 'custom', roots })
  })

  it('retains embedded paths while reloading the latest preset configuration', async () => {
    initProfile(resolveProfileDir('preset-config', home), [], 'live')
    const record = writePresetPatch('first', [])
    const shippedPresetRoot = join(home, 'embedded-presets')
    const bareModuleBaseUrl = new URL('./fixtures/', import.meta.url).href
    const resolvedPackages = ['embedded-package']

    run = await runProfile({
      environment: createLaunchEnvironmentSnapshot([]), profile: 'preset-config', patchFiles: [], args: [],
      moduleFallback: 'resolver', shippedPresetRoot, bareModuleBaseUrl, bareModulePackages: resolvedPackages,
    })
    const embedded = {
      roots: [{ path: shippedPresetRoot, trust: 'system' }],
      harnessBase: bareModuleBaseUrl, resolvedPackages,
    }
    expect(JSON.parse(readFileSync(record, 'utf8'))).toMatchObject({ default: 'first', ...embedded })

    writePresetPatch('second', [{ path: join(home, 'user-presets'), trust: 'user' }])

    await expect.poll((): unknown => JSON.parse(readFileSync(record, 'utf8')), { timeout: 5_000 })
      .toMatchObject({ default: 'second', ...embedded })
  }, 10_000)

  it('loads a profile-installed bare plugin while the host supplies embedded packages', async () => {
    const profileDir = resolveProfileDir('preset-config', home)
    initProfile(profileDir, [], 'startup')
    const pluginDir = join(profileDir, 'node_modules', 'external-preset-recorder')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({
      name: 'external-preset-recorder', type: 'module', exports: './index.mjs',
    }))
    copyFileSync(new URL(fixture), join(pluginDir, 'index.mjs'))
    const record = writePresetPatch('external', [], 'external-preset-recorder')

    run = await runProfile({
      environment: createLaunchEnvironmentSnapshot([]), profile: 'preset-config', patchFiles: [], args: [],
      moduleFallback: 'resolver', shippedPresetRoot: join(home, 'embedded-presets'),
      bareModuleBaseUrl: new URL('./fixtures/', import.meta.url).href,
      bareModulePackages: ['embedded-package'],
    })

    expect(existsSync(record)).toBe(true)
    expect(JSON.parse(readFileSync(record, 'utf8'))).toMatchObject({ default: 'external' })
  })
})
