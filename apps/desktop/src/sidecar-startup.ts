import { parseHarnessUrl } from './harness-url.ts'
import type { DesktopSidecarEvent } from './sidecar-protocol.ts'

/** Profile invocation fields required by the desktop sidecar. */
export interface DesktopSidecarProfileOptions<TEnvironment> {
  environment: TEnvironment
  profile: 'web'
  moduleFallback: 'resolver'
  bareModuleBaseUrl: string
  shippedPresetRoot: string
  patchFiles: readonly string[]
  args: readonly string[]
}

/**
 * Builds the fixed Web-profile invocation for a desktop-owned local server.
 *
 * @param environment Frozen launch environment passed through to Harness.
 * @param patchPath App-owned patch replacing the native directory provider.
 * @param bareModuleBaseUrl VFS URL used by Cordis for in-box bare plugins.
 * @param shippedPresetRoot VFS directory containing the built-in Agent presets.
 * @returns Sidecar Web profile options with no default-browser handoff.
 */
export function buildDesktopSidecarProfileOptions<TEnvironment>(
  environment: TEnvironment,
  patchPath: string,
  bareModuleBaseUrl: string,
  shippedPresetRoot: string,
): DesktopSidecarProfileOptions<TEnvironment> {
  return {
    environment,
    profile: 'web',
    moduleFallback: 'resolver',
    bareModuleBaseUrl,
    shippedPresetRoot,
    patchFiles: [patchPath],
    args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
  }
}

/**
 * Converts the existing Web readiness line into the versioned sidecar events.
 *
 * @param line One complete ordinary Harness output line.
 * @param elapsedMs Milliseconds since sidecar process startup.
 * @returns Ordered readiness events, or an empty list for plugin output.
 */
export function desktopSidecarReadyEvents(
  line: string,
  elapsedMs = 0,
): readonly DesktopSidecarEvent[] {
  const url = parseHarnessUrl(line)
  if (url === undefined) return []
  return [
    { type: 'phase', phase: 'plugin-tree-ready', elapsedMs },
    { type: 'phase', phase: 'http-ready', elapsedMs },
    { type: 'ready', url: url.href },
  ]
}
