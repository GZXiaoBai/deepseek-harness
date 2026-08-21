import type { ResolveHookContext } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  createDesktopModuleMappings,
  createDesktopModuleResolveHook,
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
