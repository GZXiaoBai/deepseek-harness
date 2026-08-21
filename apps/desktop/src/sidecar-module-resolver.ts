import { registerHooks, type ModuleHooks, type ResolveHookSync } from 'node:module'

/** Exact package-to-VFS URL mappings installed before the desktop profile loads. */
export type DesktopModuleMappings = ReadonlyMap<string, string>

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
 * @returns A Node synchronous resolve hook.
 */
export function createDesktopModuleResolveHook(mappings: DesktopModuleMappings): ResolveHookSync {
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

  return (specifier, context, nextResolve) => {
    const target = validated.get(specifier)
    if (target !== undefined) return { url: target, shortCircuit: true }
    return nextResolve(specifier, context)
  }
}

/**
 * Installs the desktop resolver in the current Node process.
 *
 * @param mappings Exact singleton and desktop-provider mappings.
 * @returns Hook handle whose `deregister()` removes this resolver.
 */
export function installDesktopModuleResolver(mappings: DesktopModuleMappings): ModuleHooks {
  return registerHooks({ resolve: createDesktopModuleResolveHook(mappings) })
}
