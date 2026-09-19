import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopLoaderInternalProxy,
  createPackagedSpecifierResolver,
} from '../src/sidecar-loader.ts'

describe('desktop Cordis loader integration', () => {
  it('resolves packaged roots and subpaths while leaving external plugins on disk', () => {
    const resolveModule = vi.fn((specifier: string) => `file:///snapshot/node_modules/${specifier}/index.js`)
    const resolve = createPackagedSpecifierResolver(
      ['@deepseek-ai/cordis', '@deepseek-ai/dsh-web-app'],
      resolveModule,
    )

    expect(resolve('@deepseek-ai/dsh-web-app/startup'))
      .toBe('file:///snapshot/node_modules/@deepseek-ai/dsh-web-app/startup/index.js')
    expect(resolve('@deepseek-ai/cordis')).toBe('file:///snapshot/node_modules/@deepseek-ai/cordis/index.js')
    expect(resolve('@personal/plugin')).toBeUndefined()
    expect(resolve('./local.js')).toBeUndefined()
  })

  it('rewrites Node 24 internal import and resolve requests without losing method receivers', async () => {
    const calls: unknown[][] = []
    const internal = {
      version: 'v2',
      marker: 41,
      async import(specifier: string, parentURL: string): Promise<number> {
        calls.push(['import', specifier, parentURL, this.marker])
        return this.marker
      },
      resolveSync(parentURL: string, request: { specifier: string; attributes?: object }) {
        calls.push(['resolveSync', parentURL, request, this.marker])
        return { format: 'module', url: request.specifier }
      },
    }
    const proxy = createDesktopLoaderInternalProxy(internal, specifier => (
      specifier === '@deepseek-ai/dsh-web-app/startup' ? 'file:///snapshot/web-startup.js' : undefined
    ))

    await expect(proxy.import('@deepseek-ai/dsh-web-app/startup', 'file:///profile/')).resolves.toBe(41)
    expect(proxy.resolveSync('file:///profile/', { specifier: '@personal/plugin' })).toEqual({
      format: 'module',
      url: '@personal/plugin',
    })
    expect(calls).toEqual([
      ['import', 'file:///snapshot/web-startup.js', 'file:///profile/', 41],
      ['resolveSync', 'file:///profile/', { specifier: '@personal/plugin' }, 41],
    ])
  })
})
