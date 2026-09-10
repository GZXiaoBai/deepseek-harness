/**
 * Formats a sidecar startup or shutdown failure without dropping nested
 * AggregateError members or Error causes.
 *
 * @param value Rejected value crossing the sidecar lifecycle boundary.
 * @returns Complete diagnostic text suitable for the fatal protocol event and log.
 */
export function formatSidecarError(value: unknown): string {
  const seen = new Set<unknown>()
  const format = (current: unknown): string => {
    if (current instanceof Error) {
      if (seen.has(current)) return '[circular error]'
      seen.add(current)
      const sections = [current.stack ?? `${current.name}: ${current.message}`]
      if (current.cause !== undefined) sections.push(`Caused by: ${format(current.cause)}`)
      if (current instanceof AggregateError) {
        for (const member of current.errors) sections.push(`Aggregate member: ${format(member)}`)
      }
      return sections.join('\n')
    }
    if (typeof current === 'string') return current
    try {
      return JSON.stringify(current)
    } catch {
      return String(current)
    }
  }
  return format(value)
}
