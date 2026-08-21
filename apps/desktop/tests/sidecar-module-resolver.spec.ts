import type { ResolveHookContext } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  createDesktopModuleMappings,
  createDesktopModuleResolveHook,
  createDesktopPackageJsonMappings,
  resolveDesktopShippedPresetRoot,
} from '../src/sidecar-module-resolver.ts'
import { isPackagedDesktopSidecar } from '../src/sidecar-packaged-modules.ts'

describe('desktop sidecar module resolver', () => {
  it('recognizes an injected roster even when runtime SEA markers are absent', () => {
    expect(isPackagedDesktopSidecar(199, false, false)).toBe(true)
    expect(isPackagedDesktopSidecar(1, true, false)).toBe(true)
    expect(isPackagedDesktopSidecar(1, false, true)).toBe(true)
    expect(isPackagedDesktopSidecar(1, false, false)).toBe(false)
  })

  it('maps every packaged dependency from the sidecar installation anchor', () => {
    const mappings = createDesktopModuleMappings(
      ['@deepseek-ai/cordis', '@deepseek-ai/dsh-compaction'],
      specifier => `file:///snapshot/node_modules/${specifier}/lib/index.js`,
      new Map([['@deepseek-ai/dsh-desktop/sidecar-directory-picker', 'file:///snapshot/desktop-picker.js']]),
    )

    expect([...mappings]).toEqual([
      ['@deepseek-ai/cordis', 'file:///snapshot/node_modules/@deepseek-ai/cordis/lib/index.js'],
      ['@deepseek-ai/dsh-compaction', 'file:///snapshot/node_modules/@deepseek-ai/dsh-compaction/lib/index.js'],
      ['@deepseek-ai/dsh-desktop/sidecar-directory-picker', 'file:///snapshot/desktop-picker.js'],
    ])
  })

  it('maps package manifests through direct Node exports and the SEA package-root fallback', () => {
    const resolveModule = (specifier: string): string => {
      if (specifier === '@deepseek-ai/cordis/package.json') {
        return 'file:///snapshot/node_modules/@deepseek-ai/cordis/package.json'
      }
      if (specifier === '@deepseek-ai/dsh-client-runtime/package.json') {
        throw new Error('dynamic package manifest is absent from the SEA resolver table')
      }
      return `file:///snapshot/node_modules/${specifier}/lib/index.js`
    }

    expect([...createDesktopPackageJsonMappings([
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-runtime',
    ], resolveModule)]).toEqual([
      ['@deepseek-ai/cordis', '/snapshot/node_modules/@deepseek-ai/cordis/package.json'],
      ['@deepseek-ai/dsh-client-runtime', '/snapshot/node_modules/@deepseek-ai/dsh-client-runtime/package.json'],
    ])
  })

  it('anchors shipped Agent presets at the packaged CLI manifest instead of the SEA entry URL', () => {
    const manifests = new Map([
      ['@deepseek-ai/dsh', '/snapshot/node_modules/@deepseek-ai/dsh/package.json'],
    ])

    expect(resolveDesktopShippedPresetRoot(manifests))
      .toBe('/snapshot/node_modules/@deepseek-ai/dsh/config/agent-presets')
    expect(() => resolveDesktopShippedPresetRoot(new Map()))
      .toThrow('packaged @deepseek-ai/dsh manifest')
  })

  it('maps only exact packaged singleton peers and lets private plugin dependencies resolve from disk', () => {
    const calls: Array<[string, string | undefined]> = []
    const resolve = createDesktopModuleResolveHook(new Map([
      ['@deepseek-ai/cordis', 'file:///snapshot/runtime/cordis.js'],
      ['@deepseek-ai/dsh-host-directory-picker', 'file:///snapshot/runtime/directory-picker.js'],
    ]))
    const nextResolve = (specifier: string, context: Partial<ResolveHookContext> = {}) => {
      calls.push([specifier, context.parentURL])
      return { url: new URL(specifier, context.parentURL ?? 'file:///').href }
    }

    const context = {
      conditions: [],
      importAttributes: {},
      parentURL: 'file:///profiles/plugin/index.js',
    }
    expect(resolve('@deepseek-ai/cordis', context, nextResolve))
      .toEqual({ url: 'file:///snapshot/runtime/cordis.js', shortCircuit: true })
    expect(resolve('./private-dependency.js', context, nextResolve))
      .toEqual({ url: 'file:///profiles/plugin/private-dependency.js' })
    expect(calls).toEqual([['./private-dependency.js', 'file:///profiles/plugin/index.js']])
  })

  it('rejects non-absolute and wildcard-like mappings before installing a process hook', () => {
    expect(() => createDesktopModuleResolveHook(new Map([
      ['@deepseek-ai/cordis', './cordis.js'],
    ]))).toThrow('absolute URL')
    expect(() => createDesktopModuleResolveHook(new Map([
      ['@deepseek-ai/cordis/', 'file:///snapshot/cordis.js'],
    ]))).toThrow('exact package specifier')
  })
})
