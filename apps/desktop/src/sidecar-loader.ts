/** Resolves a configured plugin specifier to its packaged VFS URL. */
export type DesktopPackagedSpecifierResolver = (specifier: string) => string | undefined

/**
 * Creates a resolver for every subpath owned by an embedded package.
 *
 * @param packageNames Exact package roots embedded in the sidecar VFS.
 * @param resolveModule Resolver anchored at the sidecar entry URL.
 * @returns A resolver that leaves relative, built-in, and external names untouched.
 */
export function createPackagedSpecifierResolver(
  packageNames: readonly string[],
  resolveModule: (specifier: string) => string,
): DesktopPackagedSpecifierResolver {
  const packaged = new Set(packageNames)
  return (specifier) => {
    const packageName = packageNameFromSpecifier(specifier)
    if (packageName === undefined || !packaged.has(packageName)) return undefined
    return resolveModule(specifier)
  }
}

/**
 * Wraps Cordis' Node-internal loader so configured in-box plugins resolve in VFS.
 * Unknown specifiers and all loader state continue through the original object.
 *
 * @param internal Node internal loader object captured by Cordis.
 * @param resolveSpecifier Packaged-subpath resolver owned by the sidecar.
 * @returns A receiver-preserving proxy suitable for `ctx.loader.internal`.
 */
export function createDesktopLoaderInternalProxy<T extends object>(
  internal: T,
  resolveSpecifier: DesktopPackagedSpecifierResolver,
): T {
  return new Proxy(internal, {
    get(target, property): unknown {
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      const callable = value as (this: unknown, ...args: unknown[]) => unknown
      if (property === 'import' || property === 'resolve' || property === 'getModuleJobForImport') {
        return (...args: unknown[]): unknown => Reflect.apply(
          callable,
          target,
          rewriteFirstSpecifier(args, resolveSpecifier),
        )
      }
      if (property === 'resolveSync') {
        return (...args: unknown[]): unknown => Reflect.apply(
          callable,
          target,
          Reflect.get(target, 'version', target) === 'v2'
            ? rewriteNode24Request(args, resolveSpecifier)
            : rewriteFirstSpecifier(args, resolveSpecifier),
        )
      }
      if (property === 'getOrCreateModuleJob') {
        return (...args: unknown[]): unknown => Reflect.apply(
          callable,
          target,
          rewriteNode24Request(args, resolveSpecifier),
        )
      }
      return (...args: unknown[]): unknown => Reflect.apply(callable, target, args)
    },
  })
}

function rewriteFirstSpecifier(
  args: readonly unknown[],
  resolveSpecifier: DesktopPackagedSpecifierResolver,
): unknown[] {
  if (typeof args[0] !== 'string') return [...args]
  return [resolveSpecifier(args[0]) ?? args[0], ...args.slice(1)]
}

function rewriteNode24Request(
  args: readonly unknown[],
  resolveSpecifier: DesktopPackagedSpecifierResolver,
): unknown[] {
  const request = args[1]
  if (request === null || typeof request !== 'object') return [...args]
  const specifier: unknown = Reflect.get(request, 'specifier')
  if (typeof specifier !== 'string') return [...args]
  const resolved = resolveSpecifier(specifier)
  if (resolved === undefined) return [...args]
  return [args[0], { ...request, specifier: resolved }, ...args.slice(2)]
}

function packageNameFromSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes('://')) return undefined
  const segments = specifier.split('/')
  if (specifier.startsWith('@')) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : undefined
  }
  return segments[0] === '' ? undefined : segments[0]
}
