import { registerHooks, type ModuleHooks, type ResolveHookSync } from 'node:module'

/** Exact package-to-VFS URL mappings installed before the desktop profile loads. */
export type DesktopModuleMappings = ReadonlyMap<string, string>

/** One package installed on the real filesystem beside the packaged executable. */
export interface DesktopRealPackage {
  /** Absolute `file:` URL of the package entry module. */
  entry: string
  /** Absolute `file:` URL of the package directory, ending in `/`. */
  directory: string
}

/** Real-filesystem packages that ordinary disk resolution serves ahead of the embedded runtime. */
export type DesktopRealPackages = ReadonlyMap<string, DesktopRealPackage>

/**
 * Resolves the packaged runtime dependency names before the hook is installed.
 * The resulting exact URLs let disk-loaded plugins share every in-box package
 * instance while their own dependencies continue through normal disk lookup.
 *
 * @param packageNames Bare dependency names from the packaged runtime manifest.
 * @param resolveModule Resolver anchored inside the packaged sidecar.
 * @param additionalMappings Exact subpath providers owned by Desktop.
 * @returns Stable insertion-ordered mappings for the resolver hook.
 */
export function createDesktopModuleMappings(
  packageNames: readonly string[],
  resolveModule: (specifier: string) => string,
  additionalMappings: DesktopModuleMappings = new Map(),
): DesktopModuleMappings {
  const mappings = new Map<string, string>()
  for (const packageName of packageNames) mappings.set(packageName, resolveModule(packageName))
  for (const [specifier, target] of additionalMappings) mappings.set(specifier, target)
  return mappings
}

/**
 * Builds the synchronous resolver that preserves packaged singleton peers.
 * Unmapped imports continue through Node's normal resolver, which lets an
 * external plugin load its private dependencies from its profile directory.
 *
 * @param mappings Exact bare specifiers mapped to their packaged module URLs.
 * @param realPackages Packages installed beside the executable that the embedded runtime must not shadow.
 * @returns A Node synchronous resolve hook.
 */
export function createDesktopModuleResolveHook(
  mappings: DesktopModuleMappings,
  realPackages: DesktopRealPackages = new Map(),
): ResolveHookSync {
  const validated = new Map<string, string>()
  for (const [specifier, target] of mappings) {
    if (specifier === '' || specifier.endsWith('/') || specifier.includes('*')) {
      throw new Error(`desktop module resolver requires an exact package specifier: ${JSON.stringify(specifier)}`)
    }
    let parsed: URL
    try {
      parsed = new URL(target)
    } catch {
      throw new Error(`desktop module resolver target must be an absolute URL: ${JSON.stringify(target)}`)
    }
    if (parsed.protocol === '') {
      throw new Error(`desktop module resolver target must be an absolute URL: ${JSON.stringify(target)}`)
    }
    validated.set(specifier, parsed.href)
  }
  const real = new Map<string, DesktopRealPackage>()
  for (const [packageName, packageUrl] of realPackages) {
    if (packageName === '' || packageName.endsWith('/') || packageName.includes('*')) {
      throw new Error(`desktop module resolver requires an exact package name: ${JSON.stringify(packageName)}`)
    }
    const directory = new URL(packageUrl.directory)
    if (directory.protocol !== 'file:' || !directory.href.endsWith('/')) {
      throw new Error(`desktop real package directory must be an absolute directory URL: ${JSON.stringify(packageUrl.directory)}`)
    }
    const entry = new URL(packageUrl.entry)
    if (entry.protocol !== 'file:') {
      throw new Error(`desktop real package entry must be an absolute file URL: ${JSON.stringify(packageUrl.entry)}`)
    }
    real.set(packageName, { entry: entry.href, directory: directory.href })
  }

  return (specifier, context, nextResolve) => {
    const target = validated.get(specifier)
    if (target !== undefined) return { url: target, shortCircuit: true }
    for (const [packageName, packageUrl] of real) {
      if (specifier === packageName) return { url: packageUrl.entry, shortCircuit: true }
      if (specifier.startsWith(`${packageName}/`)) {
        const subpath = specifier.slice(packageName.length + 1)
        return { url: new URL(subpath, packageUrl.directory).href, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  }
}

/**
 * Installs the desktop resolver in the current Node process.
 *
 * @param mappings Exact singleton and desktop-provider mappings.
 * @param realPackages Packages installed beside the executable that the embedded runtime must not shadow.
 * @returns Hook handle whose `deregister()` removes this resolver.
 */
export function installDesktopModuleResolver(
  mappings: DesktopModuleMappings,
  realPackages: DesktopRealPackages = new Map(),
): ModuleHooks {
  return registerHooks({ resolve: createDesktopModuleResolveHook(mappings, realPackages) })
}
