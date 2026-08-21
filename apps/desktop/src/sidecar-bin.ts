#!/usr/bin/env node

import { fileURLToPath } from 'node:url'
import { isSea } from 'node:sea'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { DesktopSidecarChannel } from './sidecar-channel.ts'
import { installDesktopSidecarChannel } from './sidecar-directory-picker.ts'
import { formatSidecarError } from './sidecar-error.ts'
import { createDesktopLoaderInternalProxy, createPackagedSpecifierResolver } from './sidecar-loader.ts'
import { createDesktopModuleMappings, installDesktopModuleResolver } from './sidecar-module-resolver.ts'
import { isPackagedDesktopSidecar, PACKAGED_DESKTOP_MODULES } from './sidecar-packaged-modules.ts'
import { buildDesktopSidecarProfileOptions, desktopSidecarReadyEvents } from './sidecar-startup.ts'

const startedAt = Date.now()
const packagedDependencies = isPackagedDesktopSidecar(
  PACKAGED_DESKTOP_MODULES.length,
  isSea(),
  Reflect.has(process, 'pkg'),
)
  ? PACKAGED_DESKTOP_MODULES
  : ['@deepseek-ai/cordis', '@deepseek-ai/dsh-host-directory-picker']
const resolvePackagedSpecifier = createPackagedSpecifierResolver(
  packagedDependencies,
  specifier => import.meta.resolve(specifier),
)
const moduleHooks = installDesktopModuleResolver(createDesktopModuleMappings(
  packagedDependencies,
  specifier => import.meta.resolve(specifier),
  new Map([[
    '@deepseek-ai/dsh-desktop/sidecar-directory-picker',
    new URL('./sidecar-directory-picker.js', import.meta.url).href,
  ]]),
))

const feasibilityIndex = process.argv.indexOf('--desktop-feasibility-probe')
if (feasibilityIndex >= 0) {
  try {
    const externalPluginPath = process.argv[feasibilityIndex + 1]
    if (externalPluginPath === undefined) {
      throw new Error('--desktop-feasibility-probe requires a plugin path')
    }
    const { runDesktopSidecarFeasibilityProbe } = await import('./sidecar-feasibility.ts')
    console.log(`DSH_DESKTOP_PROBE/1 ${JSON.stringify(
      await runDesktopSidecarFeasibilityProbe(externalPluginPath),
    )}`)
  } finally {
    moduleHooks.deregister()
  }
} else {
  await runDesktopSidecar()
}

async function runDesktopSidecar(): Promise<void> {
  let profileRun: ReturnType<typeof runProfile> | undefined
  const channel = new DesktopSidecarChannel({
    input: process.stdin,
    output: process.stdout,
    dispose: async () => {
    // `runProfile` disposes its partial Cordis context before rejecting; the
    // outer startup failure remains the fatal event and must not block stopped.
      const profile = await profileRun?.catch(() => undefined)
      await profile?.shutdown.shutdown(0)
    },
  })
  channel.start()
  const uninstallDirectoryPicker = installDesktopSidecarChannel(channel)
  channel.emit({ type: 'phase', phase: 'sidecar-started', elapsedMs: 0 })

  const originalLog = console.log.bind(console)
  let announcedReady = false
  console.log = (...values: unknown[]): void => {
    originalLog(...values)
    if (announcedReady || values.length !== 1 || typeof values[0] !== 'string') return
    const events = desktopSidecarReadyEvents(values[0], Date.now() - startedAt)
    if (events.length === 0) return
    announcedReady = true
    for (const event of events) channel.emit(event)
  }

  try {
    const patchPath = fileURLToPath(new URL('../sidecar/cordis.patch.yml', import.meta.url))
    profileRun = runProfile({
      ...buildDesktopSidecarProfileOptions(loadLayeredEnv('dsh'), patchPath, import.meta.url),
      prepareHost: (ctx) => {
        const internal = ctx.loader.internal
        if (internal === undefined) throw new Error('desktop sidecar requires the Node internal module loader')
        ctx.loader.internal = createDesktopLoaderInternalProxy(internal, resolvePackagedSpecifier)
      },
    })
    await profileRun
    await channel.stopped
  } catch (error) {
    await channel.fail(new Error(formatSidecarError(error)))
    process.exitCode = 1
  } finally {
    console.log = originalLog
    uninstallDirectoryPicker()
    moduleHooks.deregister()
    channel.close()
  }
}
