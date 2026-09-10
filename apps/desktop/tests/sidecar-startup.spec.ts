import { fileURLToPath } from 'node:url'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'
import {
  buildDesktopSidecarProfileOptions,
  desktopSidecarReadyEvents,
} from '../src/sidecar-startup.ts'

describe('desktop sidecar startup', () => {
  it('replaces the adaptive picker with the desktop provider and native client surface', () => {
    const webPatch = fileURLToPath(new URL(
      '../../../packages/bundle/web-app/cordis.patch.yml',
      import.meta.url,
    ))
    const desktopPatch = fileURLToPath(new URL('../sidecar/cordis.patch.yml', import.meta.url))
    const entries = composeEntries([
      loadOverlayPatches('desktop-test', webPatch),
      loadOverlayPatches('desktop-test', desktopPatch),
    ])

    expect(entries.filter(entry => entry.id === 'directory-picker')).toEqual([
      expect.objectContaining({
        name: '@deepseek-ai/dsh-host-directory-picker-auto',
        disabled: true,
      }),
    ])
    expect(entries.filter(entry => entry.id === 'desktop-directory-picker')).toEqual([
      expect.objectContaining({
        name: '@deepseek-ai/dsh-desktop/sidecar-directory-picker',
      }),
    ])
    expect(entries.filter(entry => entry.id === 'desktop-directory-picker-surface')).toEqual([
      expect.objectContaining({
        name: '@deepseek-ai/dsh-client-ui-directory-picker-native',
      }),
    ])
  })

  it('boots only the loopback dynamic-port Web profile without browser handoff', () => {
    const environment = { PATH: '/usr/bin' }

    expect(buildDesktopSidecarProfileOptions(
      environment,
      '/app/desktop.patch.yml',
      'file:///snapshot/desktop/sidecar-bin.js',
      '/snapshot/node_modules/@deepseek-ai/dsh/config/agent-presets',
      ['@deepseek-ai/dsh-persona'],
    )).toEqual({
      environment,
      profile: 'web',
      moduleFallback: 'resolver',
      bareModuleBaseUrl: 'file:///snapshot/desktop/sidecar-bin.js',
      bareModulePackages: ['@deepseek-ai/dsh-persona'],
      shippedPresetRoot: '/snapshot/node_modules/@deepseek-ai/dsh/config/agent-presets',
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
