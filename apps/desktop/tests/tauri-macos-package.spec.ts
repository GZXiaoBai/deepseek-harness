import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const { createTauriMacosVerifyPlan } = await import(
  pathToFileURL(join(import.meta.dirname, '../scripts/verify-tauri-macos.mjs')).href,
) as {
  createTauriMacosVerifyPlan: (input: { desktopRoot: string; platform: string; arch: string }) => {
    releaseDirectory: string
    app: string
    executable: string
  }
}

describe('Tauri macOS package verification plan', () => {
  const desktopRoot = resolve(import.meta.dirname, '..')

  it('targets the collected Apple Silicon application', () => {
    expect(createTauriMacosVerifyPlan({ desktopRoot, platform: 'darwin', arch: 'arm64' })).toEqual({
      releaseDirectory: join(desktopRoot, 'release-tauri'),
      app: join(desktopRoot, 'release-tauri/DeepSeek Harness.app'),
      executable: join(desktopRoot, 'release-tauri/DeepSeek Harness.app/Contents/MacOS/deepseek-harness-desktop'),
    })
  })

  it('rejects unsupported hosts', () => {
    expect(() => createTauriMacosVerifyPlan({ desktopRoot, platform: 'darwin', arch: 'x64' }))
      .toThrow(/expected darwin-arm64/)
  })
})
