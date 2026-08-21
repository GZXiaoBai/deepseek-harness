import { describe, expect, it } from 'vitest'
import {
  buildDesktopSidecarProfileOptions,
  desktopSidecarReadyEvents,
} from '../src/sidecar-startup.ts'

describe('desktop sidecar startup', () => {
  it('boots only the loopback dynamic-port Web profile without browser handoff', () => {
    const environment = { PATH: '/usr/bin' }

    expect(buildDesktopSidecarProfileOptions(
      environment,
      '/app/desktop.patch.yml',
      'file:///snapshot/desktop/sidecar-bin.js',
    )).toEqual({
      environment,
      profile: 'web',
      moduleFallback: 'resolver',
      bareModuleBaseUrl: 'file:///snapshot/desktop/sidecar-bin.js',
      patchFiles: ['/app/desktop.patch.yml'],
      args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
    })
  })

  it('turns only the complete Harness loopback line into ordered ready events', () => {
    expect(desktopSidecarReadyEvents('plugin output')).toEqual([])
    expect(desktopSidecarReadyEvents('prefix dsh web: http://127.0.0.1:43127')).toEqual([])
    expect(desktopSidecarReadyEvents('dsh web: http://127.0.0.1:43127', 912)).toEqual([
      { type: 'phase', phase: 'plugin-tree-ready', elapsedMs: 912 },
      { type: 'phase', phase: 'http-ready', elapsedMs: 912 },
      { type: 'ready', url: 'http://127.0.0.1:43127/' },
    ])
  })
})
