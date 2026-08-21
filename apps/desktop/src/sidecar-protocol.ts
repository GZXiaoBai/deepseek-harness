const PROTOCOL_PREFIX = 'DSH_DESKTOP/1 '

/** Ordered sidecar startup and shutdown milestones reported to the native shell. */
export type DesktopSidecarPhase =
  | 'sidecar-started'
  | 'plugin-tree-ready'
  | 'http-ready'
  | 'shutdown-started'

/** Timing values measured from native application process startup. */
export interface DesktopPerformanceStats {
  processStartMs: number
  sidecarSpawnMs: number | null
  pluginTreeReadyMs: number | null
  httpReadyMs: number | null
  pageLoadedMs: number | null
  shutdownMs: number | null
  forcedTerminationCount: number
}

/** Versioned messages written by the Harness sidecar to stdout. */
export type DesktopSidecarEvent =
  | Readonly<{ type: 'phase'; phase: DesktopSidecarPhase; elapsedMs: number }>
  | Readonly<{ type: 'ready'; url: string }>
  | Readonly<{ type: 'fatal'; message: string }>
  | Readonly<{ type: 'stopped' }>
  | Readonly<{ type: 'directory-picker-request'; requestId: string; title?: string }>

/** Versioned messages written by the native shell to sidecar stdin. */
export type DesktopSidecarCommand =
  | Readonly<{ type: 'shutdown' }>
  | Readonly<{ type: 'directory-picker-result'; requestId: string; path: string | null }>

/**
 * Parses one sidecar stdout line while leaving ordinary plugin output untouched.
 *
 * @param line Complete UTF-8 stdout line without its newline delimiter.
 * @returns A validated control event, or `undefined` for ordinary process output.
 */
export function parseDesktopSidecarEvent(line: string): DesktopSidecarEvent | undefined {
  if (!line.startsWith(PROTOCOL_PREFIX)) return undefined

  const value = parsePayload(line)
  const record = requireRecord(value, 'event')
  const type = requireString(record.type, 'event type')

  switch (type) {
    case 'phase': {
      const phase = requirePhase(record.phase)
      const elapsedMs = requireNonNegativeFiniteNumber(record.elapsedMs, 'phase elapsedMs')
      return { type, phase, elapsedMs }
    }
    case 'ready': {
      const url = requireString(record.url, 'ready URL')
      if (!isStrictLoopbackUrl(url)) throw new Error('DSH_DESKTOP/1 invalid ready URL')
      return { type, url }
    }
    case 'fatal':
      return { type, message: requireNonEmptyString(record.message, 'fatal message') }
    case 'stopped':
      return { type }
    case 'directory-picker-request': {
      const requestId = requireRequestId(record.requestId)
      if (record.title === undefined) return { type, requestId }
      return { type, requestId, title: requireNonEmptyString(record.title, 'directory picker title') }
    }
    default:
      throw new Error(`DSH_DESKTOP/1 unknown event type: ${JSON.stringify(type)}`)
  }
}

/**
 * Parses one native-shell stdin frame for the sidecar command dispatcher.
 *
 * @param line Complete UTF-8 stdin line without its newline delimiter.
 * @returns The validated command carried by the frame.
 */
export function parseDesktopSidecarCommand(line: string): DesktopSidecarCommand {
  if (!line.startsWith(PROTOCOL_PREFIX)) {
    throw new Error('DSH_DESKTOP/1 missing protocol prefix')
  }
  const record = requireRecord(parsePayload(line), 'command')
  const type = requireString(record.type, 'command type')
  switch (type) {
    case 'shutdown':
      return { type }
    case 'directory-picker-result': {
      const requestId = requireRequestId(record.requestId)
      if (record.path === null) return { type, requestId, path: null }
      return {
        type,
        requestId,
        path: requireNonEmptyString(record.path, 'directory picker path'),
      }
    }
    default:
      throw new Error(`DSH_DESKTOP/1 unknown command type: ${JSON.stringify(type)}`)
  }
}

/**
 * Serializes one validated sidecar event as a single stdout frame.
 *
 * @param event Event destined for the native desktop shell.
 * @returns One prefixed JSON line including its newline delimiter.
 */
export function serializeDesktopSidecarEvent(event: DesktopSidecarEvent): string {
  const line = `${PROTOCOL_PREFIX}${JSON.stringify(event)}`
  parseDesktopSidecarEvent(line)
  return `${line}\n`
}

/**
 * Serializes one validated native-shell command as a single stdin frame.
 *
 * @param command Command destined for the owned sidecar process.
 * @returns One prefixed JSON line including its newline delimiter.
 */
export function serializeDesktopSidecarCommand(command: DesktopSidecarCommand): string {
  switch (command.type) {
    case 'shutdown':
      return `${PROTOCOL_PREFIX}${JSON.stringify(command)}\n`
    case 'directory-picker-result': {
      requireRequestId(command.requestId)
      if (command.path !== null) requireNonEmptyString(command.path, 'directory picker path')
      return `${PROTOCOL_PREFIX}${JSON.stringify(command)}\n`
    }
  }
}

function parsePayload(line: string): unknown {
  try {
    return JSON.parse(line.slice(PROTOCOL_PREFIX.length))
  } catch {
    throw new Error('DSH_DESKTOP/1 invalid JSON')
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`DSH_DESKTOP/1 invalid ${label}`)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`DSH_DESKTOP/1 invalid ${label}`)
  return value
}

function requireNonEmptyString(value: unknown, label: string): string {
  const string = requireString(value, label)
  if (string.trim() === '') throw new Error(`DSH_DESKTOP/1 invalid ${label}`)
  return string
}

function requireNonNegativeFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`DSH_DESKTOP/1 invalid ${label}`)
  }
  return value
}

function requireRequestId(value: unknown): string {
  const requestId = requireNonEmptyString(value, 'request id')
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(requestId)) {
    throw new Error('DSH_DESKTOP/1 invalid request id')
  }
  return requestId
}

function requirePhase(value: unknown): DesktopSidecarPhase {
  switch (value) {
    case 'sidecar-started':
    case 'plugin-tree-ready':
    case 'http-ready':
    case 'shutdown-started':
      return value
    default:
      throw new Error(`DSH_DESKTOP/1 invalid phase: ${JSON.stringify(value)}`)
  }
}

function isStrictLoopbackUrl(value: string): boolean {
  const match = /^http:\/\/127\.0\.0\.1:([0-9]+)\/$/.exec(value)
  if (match === null) return false
  const port = Number(match[1])
  return Number.isInteger(port) && port >= 1 && port <= 65_535
}
