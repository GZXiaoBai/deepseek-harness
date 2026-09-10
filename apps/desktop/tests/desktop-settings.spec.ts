import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_DESKTOP_SETTINGS,
  loadDesktopSettings,
  sanitizeDesktopSettings,
  saveDesktopSettings,
} from '../src/desktop-settings.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async directory => rm(directory, { force: true, recursive: true })))
})

describe('desktop settings', () => {
  it('sanitizes every updater field against defaults', () => {
    expect(sanitizeDesktopSettings(undefined)).toEqual(DEFAULT_DESKTOP_SETTINGS)
    expect(sanitizeDesktopSettings({ updater: { repository: 42 } })).toEqual(DEFAULT_DESKTOP_SETTINGS)
    expect(sanitizeDesktopSettings({
      updater: { repository: 'not-a-repo', channel: 'bogus', autoUpdate: 'yes' },
    })).toEqual(DEFAULT_DESKTOP_SETTINGS)
  })

  it('accepts valid persisted preferences', () => {
    expect(sanitizeDesktopSettings({
      updater: { repository: 'owner/repo', channel: 'prerelease', autoUpdate: false },
    })).toEqual({
      updater: { repository: 'owner/repo', channel: 'prerelease', autoUpdate: false },
    })
  })

  it('round-trips settings through the settings file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-settings-'))
    directories.push(directory)
    const settingsPath = join(directory, 'desktop-settings.json')
    const settings = sanitizeDesktopSettings({
      updater: { repository: 'owner/repo', channel: 'stable', autoUpdate: false },
    })

    await saveDesktopSettings(settingsPath, settings)
    await expect(loadDesktopSettings(settingsPath)).resolves.toEqual(settings)
    await expect(readFile(settingsPath, 'utf8')).resolves.toContain('"autoUpdate": false')
  })

  it('returns defaults for a missing settings file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-settings-'))
    directories.push(directory)

    await expect(loadDesktopSettings(join(directory, 'missing.json'))).resolves.toEqual(DEFAULT_DESKTOP_SETTINGS)
  })

  it('returns defaults for a malformed settings file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-settings-'))
    directories.push(directory)
    const settingsPath = join(directory, 'desktop-settings.json')
    await writeFile(settingsPath, '{not json')

    await expect(loadDesktopSettings(settingsPath)).resolves.toEqual(DEFAULT_DESKTOP_SETTINGS)
  })
})
