import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Values that may be safely included in a desktop log entry. */
export type DesktopLogValue = boolean | number | string | null

/** Destination for safe scalar desktop lifecycle log entries. */
export interface DesktopLogSink {
  /**
   * Records one lifecycle event with safe scalar metadata.
   *
   * @param event A stable event name owned by the desktop application.
   * @param metadata Safe scalar fields associated with the event.
   */
  log(event: string, metadata?: Record<string, DesktopLogValue>): void
}

/** Newline-delimited log writer for desktop lifecycle events. */
export class DesktopLogger implements DesktopLogSink {
  readonly #path: string

  /**
   * Creates a logger below the application's user-data directory.
   *
   * @param userDataPath Electron's per-user application-data directory.
   */
  constructor(userDataPath: string) {
    const logDirectory = join(userDataPath, 'Logs')
    mkdirSync(logDirectory, { recursive: true })
    this.#path = join(logDirectory, 'desktop.log')
  }

  /**
   * Appends a lifecycle entry without reading process configuration or user data.
   *
   * @param event A stable event name owned by the desktop application.
   * @param metadata Safe scalar fields associated with the event.
   */
  log(event: string, metadata: Record<string, DesktopLogValue> = {}): void {
    appendFileSync(this.#path, `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...metadata })}\n`)
  }
}
