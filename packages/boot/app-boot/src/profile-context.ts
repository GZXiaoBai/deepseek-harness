/** Launcher-owned profile locations and composition inputs. */
import { join } from 'node:path'
import { composeEntries, loadProfileDirectory, PROFILE_PATCH_FILENAME, type Profile } from './profile.ts'
import { loadOptionalPatches } from './index.ts'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/** Application-owned package manager executable; environment applies only to package operations. */
export interface ProfilePnpmInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** Current profile facts; scheduling and mutation belong to their callers. */
export interface ProfileContext {
  readonly name: string
  /** Packaged applications supply their bundled runtime instead of a PATH executable. */
  readonly packageManager?: ProfilePnpmInvocation
  readonly dir: string
  readonly patchPath: string
  readonly installAnchor: string
  readonly cwd: string
  readonly home: string
  /** Bundle packages used to start this process, before any persisted edits. */
  readonly startedBundles: readonly string[]
  /** Parsed command-line overlays, applied above profile and home patches. */
  readonly overlays: readonly PatchOptions[]
  /** Launch-time DSH_TELEMETRY_DISABLED value; any non-empty value opts out. */
  readonly telemetryDisabledEnv: string | undefined
  /** Embedded preset root; omitted by ordinary CLI launches, which keep the profile's own roots. */
  readonly shippedPresetRoot?: string
  /** Host-owned base URL used to resolve bare packages in a closed runtime. */
  readonly bareModuleBaseUrl?: string
  /** Bare packages provided by the closed runtime's host resolver. */
  readonly bareModulePackages?: readonly string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present only in a profile launched by dsh. */
    profileContext: ProfileContext
  }
}

const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/**
 * Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. A composition without the telemetry row
 * exports nothing, so the switch is then trivially satisfied and no patch is
 * generated — custom profiles need not mount telemetry to run with the
 * switch set.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the telemetry row.
 * @returns the disable patch, or `undefined` when no hard-disable patch is required.
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/** Read current bundle and user layers with the launch-time overlays.
 * @param binName Diagnostic prefix for malformed or missing configuration.
 * @param context Data supplied by the profile launcher.
 * @param initialProfile Already loaded startup profile; omitted reads the current files.
 * @returns Detached ordered patches; this function does not update the Loader.
 */
export function readProfilePatches(binName: string, context: ProfileContext, initialProfile?: Profile): PatchOptions[] {
  const profile = initialProfile ?? loadProfileDirectory(binName, context.dir, context.installAnchor, { userLayer: false })
  const patches = structuredClone([
    ...profile.layers.flatMap(layer => layer.patches),
    ...(initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath) ?? []),
    ...(loadOptionalPatches(binName, join(context.home, PROFILE_PATCH_FILENAME)) ?? []),
    ...context.overlays,
  ])
  const telemetryPatch = resolveTelemetryPatch(context.telemetryDisabledEnv,
    composeEntries([patches]).some(row => row.id === TELEMETRY_ROW_ID))
  if (telemetryPatch !== undefined) patches.push(telemetryPatch)
  return withHostPresetOptions(patches, context)
}

/**
 * Apply the launcher's embedded-host paths to the current preset row, keeping
 * every reloadable user field from the profile layers underneath. Recomposition
 * calls this too, so a profile operation cannot drop the embedded paths.
 * @param patches - composed profile patches, in application order.
 * @param context - launcher facts naming the embedded preset root and host resolver.
 * @returns The same patches, plus the preset override when the host supplies one.
 */
function withHostPresetOptions(patches: PatchOptions[], context: ProfileContext): PatchOptions[] {
  if (context.shippedPresetRoot === undefined) return patches
  const preset = composeEntries([patches]).find(row => row.id === 'agent-presets')
  if (preset === undefined) return patches
  return [...patches, {
    id: 'agent-presets',
    config: {
      ...(preset.config ?? {}) as Record<string, unknown>,
      roots: [{ path: context.shippedPresetRoot, trust: 'system' }],
      ...(context.bareModuleBaseUrl === undefined ? {} : { harnessBase: context.bareModuleBaseUrl }),
      ...context.bareModulePackages === undefined || context.bareModulePackages.length === 0
        ? {} : { resolvedPackages: [...context.bareModulePackages] },
    },
  }]
}
