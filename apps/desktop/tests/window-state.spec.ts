import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultWindowBounds,
  loadWindowBounds,
  saveWindowBounds,
  sanitizeWindowBounds,
} from '../src/window-state.ts'

const directories: string[] = []
const displays = [
  { x: 0, y: 0, width: 1512, height: 982 },
  { x: 1512, y: 0, width: 1920, height: 1080 },
]

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async directory => rm(directory, { force: true, recursive: true })))
})

async function temporaryStatePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-desktop-window-state-'))
  directories.push(directory)
  return join(directory, 'window-state.json')
}

describe('window state', () => {
  it.each([
    ['a width below the supported minimum', { x: 10, y: 10, width: 899, height: 720 }],
    ['a height below the supported minimum', { x: 10, y: 10, width: 1100, height: 599 }],
    ['a non-numeric coordinate', { x: '10', y: 10, width: 1100, height: 720 }],
    ['a partial persisted position', { x: 10, width: 1100, height: 720 }],
  ])('uses the default bounds for %s', (_case, persisted) => {
    expect(sanitizeWindowBounds(persisted, displays)).toEqual(defaultWindowBounds)
  })

  it('uses the default bounds when the persisted window is completely outside every display', () => {
    expect(sanitizeWindowBounds({ x: 4000, y: 1200, width: 1100, height: 720 }, displays))
      .toEqual(defaultWindowBounds)
  })

  it('retains a supported window that overlaps a connected display', () => {
    expect(sanitizeWindowBounds({ x: 1400, y: 900, width: 1100, height: 720 }, displays)).toEqual({
      x: 1400,
      y: 900,
      width: 1100,
      height: 720,
    })
  })

  it('loads the default bounds when the persisted document is malformed', async () => {
    const path = await temporaryStatePath()
    await writeFile(path, '{not json')

    await expect(loadWindowBounds(path, displays)).resolves.toEqual(defaultWindowBounds)
  })

  it('persists bounds that can be restored by a later launch', async () => {
    const path = await temporaryStatePath()
    const bounds = { x: 1800, y: 120, width: 1200, height: 800 }

    await saveWindowBounds(path, bounds)

    await expect(loadWindowBounds(path, displays)).resolves.toEqual(bounds)
    await expect(readFile(path, 'utf8')).resolves.toBe('{"x":1800,"y":120,"width":1200,"height":800}\n')
  })
})
