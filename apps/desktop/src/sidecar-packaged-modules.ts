/** Marker replaced with the staged runtime's exact package roster before SEA assembly. */
export const PACKAGED_DESKTOP_MODULES = ['__DSH_DESKTOP_MODULE_ROSTER__'] as const

/**
 * Detects the closed packaged runtime across Node SEA and legacy pkg builds.
 *
 * @param packagedModuleCount Number of entries after the build-time roster injection.
 * @param sea Whether Node reports a single-executable application.
 * @param legacyPkg Whether the historical `process.pkg` marker exists.
 * @returns Whether the complete embedded module roster must be installed.
 */
export function isPackagedDesktopSidecar(
  packagedModuleCount: number,
  sea: boolean,
  legacyPkg: boolean,
): boolean {
  return packagedModuleCount > 1 || sea || legacyPkg
}
