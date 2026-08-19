import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { UpdaterPreferences } from './updater.ts'

/** Complete persisted desktop application preferences. */
export interface DesktopSettings {
  updater: UpdaterPreferences
}

/** Preferences used before any persisted settings exist. */
export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  updater: {
    repository: 'GZXiaoBai/deepseek-harness',
    channel: 'stable',
    autoUpdate: true,
  },
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/**
 * Validates persisted settings, falling back field-by-field to defaults.
 *
 * @param persisted Parsed persisted value from the desktop settings file.
 * @returns Usable settings with every field valid.
 */
export function sanitizeDesktopSettings(persisted: unknown): DesktopSettings {
  if (!isRecord(persisted)) return structuredClone(DEFAULT_DESKTOP_SETTINGS)
  const updater = isRecord(persisted.updater) ? persisted.updater : {}
  const repository = typeof updater.repository === 'string' && REPOSITORY_PATTERN.test(updater.repository)
    ? updater.repository
    : DEFAULT_DESKTOP_SETTINGS.updater.repository
  const channel = updater.channel === 'prerelease' ? 'prerelease' : 'stable'
  const autoUpdate = typeof updater.autoUpdate === 'boolean'
    ? updater.autoUpdate
    : DEFAULT_DESKTOP_SETTINGS.updater.autoUpdate
  return { updater: { repository, channel, autoUpdate } }
}

/**
 * Loads desktop settings from disk, tolerating a missing or malformed file.
 *
 * @param settingsPath Settings file path below the user-data directory.
 * @returns Sanitized settings; a missing file yields defaults.
 */
export async function loadDesktopSettings(settingsPath: string): Promise<DesktopSettings> {
  try {
    return sanitizeDesktopSettings(JSON.parse(await readFile(settingsPath, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // A malformed settings file must not break startup; defaults apply.
    }
    return structuredClone(DEFAULT_DESKTOP_SETTINGS)
  }
}

/**
 * Persists desktop settings atomically below the user-data directory.
 *
 * @param settingsPath Settings file path below the user-data directory.
 * @param settings Settings to persist.
 * @returns Resolves after the settings file is committed.
 */
export async function saveDesktopSettings(settingsPath: string, settings: DesktopSettings): Promise<void> {
  await mkdir(dirname(settingsPath), { recursive: true })
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
}

/** @param value Unknown value. @returns Whether the value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
