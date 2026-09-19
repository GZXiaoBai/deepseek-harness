import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const MINIMUM_WIDTH = 900
const MINIMUM_HEIGHT = 600

/** Persisted position and size of the desktop BrowserWindow. */
export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
}

/** Connected-display rectangle used to reject inaccessible saved positions. */
export interface DisplayBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Initial desktop window size when no usable persisted state exists. */
export const defaultWindowBounds: WindowBounds = {
  width: 1100,
  height: 720,
}

/**
 * Validates persisted window state against minimum dimensions and connected displays.
 *
 * @param persisted Parsed persisted value from the desktop state file.
 * @param displays Current connected-display rectangles.
 * @returns The usable persisted bounds or the default window size.
 */
export function sanitizeWindowBounds(persisted: unknown, displays: readonly DisplayBounds[]): WindowBounds {
  if (!isRecord(persisted)) return { ...defaultWindowBounds }

  const { x, y, width, height } = persisted
  if (
    !isInteger(width)
    || !isInteger(height)
    || width < MINIMUM_WIDTH
    || height < MINIMUM_HEIGHT
  ) {
    return { ...defaultWindowBounds }
  }

  const hasX = x !== undefined
  const hasY = y !== undefined
  if (hasX !== hasY) return { ...defaultWindowBounds }
  if (!hasX && !hasY) return { width, height }
  if (!isInteger(x) || !isInteger(y)) return { ...defaultWindowBounds }

  const bounds = { x, y, width, height }
  return displays.some(display => rectanglesOverlap(bounds, display))
    ? bounds
    : { ...defaultWindowBounds }
}

/**
 * Loads and sanitizes the desktop window state.
 *
 * @param path Absolute state-document path below Electron userData.
 * @param displays Current connected-display rectangles.
 * @returns Restorable bounds or the default window size.
 */
export async function loadWindowBounds(path: string, displays: readonly DisplayBounds[]): Promise<WindowBounds> {
  try {
    const persisted: unknown = JSON.parse(await readFile(path, 'utf8'))
    return sanitizeWindowBounds(persisted, displays)
  } catch {
    // Missing, unreadable, and malformed state all have the same safe default.
    return { ...defaultWindowBounds }
  }
}

/**
 * Persists the latest desktop window bounds below Electron userData.
 *
 * @param path Absolute state-document path.
 * @param bounds Current BrowserWindow bounds.
 */
export async function saveWindowBounds(path: string, bounds: WindowBounds): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(bounds)}\n`, 'utf8')
}

function rectanglesOverlap(left: Required<WindowBounds>, right: DisplayBounds): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
