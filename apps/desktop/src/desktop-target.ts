/** Desktop operating-system and architecture combinations shipped by this application. */
export type DesktopTarget =
  | Readonly<{ platform: 'darwin'; arch: 'arm64' }>
  | Readonly<{ platform: 'win32'; arch: 'x64' }>

/**
 * Resolves a host pair to one supported native Desktop target.
 *
 * @param platform Node operating-system identifier.
 * @param arch Node CPU architecture identifier.
 * @returns The supported native Desktop target.
 */
export function resolveDesktopTarget(platform: string, arch: string): DesktopTarget {
  if (platform === 'darwin' && arch === 'arm64') return { platform, arch }
  if (platform === 'win32' && arch === 'x64') return { platform, arch }
  throw new Error(`Unsupported desktop target: ${platform}-${arch}; expected darwin-arm64 or win32-x64`)
}
