import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const tauriRoot = join(import.meta.dirname, '../src-tauri')

async function readJson(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(tauriRoot, name), 'utf8')) as Record<string, unknown>
}

describe('Tauri desktop configuration', () => {
  it('ships only the startup document and an app-owned sidecar to the native shell', async () => {
    const config = await readJson('tauri.conf.json')

    expect(config).toMatchObject({
      productName: 'DeepSeek Harness',
      version: '0.1.0-rc.8',
      identifier: 'ai.deepseek.harness',
      build: { frontendDist: '../static' },
      app: {
        windows: [{
          label: 'main',
          create: false,
          title: 'DeepSeek Harness',
          url: 'startup.html',
          minWidth: 900,
          minHeight: 600,
        }],
      },
      bundle: {
        active: true,
        externalBin: ['binaries/dsh-desktop-sidecar'],
      },
    })
    expect(JSON.stringify(config)).not.toMatch(/devUrl|beforeDevCommand|shell:allow|fs:allow/i)
    const plugins = config.plugins as Record<string, unknown>
    const updater = plugins.updater as Record<string, unknown>
    expect(updater.endpoints).toEqual([
      'https://github.com/GZXiaoBai/deepseek-harness/releases/latest/download/latest.json',
    ])
    expect(updater.pubkey).toMatch(/^[A-Za-z0-9+/=]+$/)
  })

  it('enables updater artifacts only through the release-only config overlay', async () => {
    const config = await readJson('tauri.updater.conf.json')
    expect(config).toEqual({
      $schema: 'https://schema.tauri.app/config/2',
      bundle: { createUpdaterArtifacts: true },
    })
  })

  it('uses an unelevated current-user NSIS and the Windows 11 system WebView2 runtime', async () => {
    const config = await readJson('tauri.windows.conf.json')

    expect(config).toMatchObject({
      bundle: {
        targets: ['nsis'],
        windows: {
          webviewInstallMode: { type: 'skip' },
          nsis: {
            installMode: 'currentUser',
            installerHooks: 'windows/installer-hooks.nsh',
            installerIcon: '../build/icon.ico',
            languages: ['English', 'SimpChinese'],
          },
        },
      },
    })
    expect(JSON.stringify(config)).not.toMatch(/certificate|thumbprint|timestampUrl|perMachine/i)

    const hooks = await readFile(join(tauriRoot, 'windows/installer-hooks.nsh'), 'utf8')
    expect(hooks).toMatch(/!macro NSIS_HOOK_PREINSTALL[\s\S]*StrCpy \$NoShortcutMode 1/)
    expect(hooks).toMatch(
      /!macro NSIS_HOOK_POSTINSTALL[\s\S]*Call CreateOrUpdateStartMenuShortcut[\s\S]*StrCpy \$NoShortcutMode 1/,
    )
    expect(hooks).not.toMatch(/CreateOrUpdateDesktopShortcut|CreateShortcut "\$DESKTOP/)
  })

  it('builds only an Apple Silicon macOS 14 App and DMG with ad-hoc hardened signing', async () => {
    const config = await readJson('tauri.macos.conf.json')

    expect(config).toMatchObject({
      bundle: {
        targets: ['app', 'dmg'],
        macOS: {
          minimumSystemVersion: '14.0',
          signingIdentity: '-',
          hardenedRuntime: true,
        },
      },
    })
  })
})
