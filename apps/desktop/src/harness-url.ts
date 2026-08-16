/**
 * Parses the loopback URL line emitted by the desktop harness child.
 *
 * @param line One complete child-process output line.
 * @returns The normalized harness URL, or `undefined` for any other output.
 */
export function parseHarnessUrl(line: string): URL | undefined {
  const match = /^dsh web: http:\/\/127\.0\.0\.1:([0-9]+)$/.exec(line)
  if (match === null) return undefined

  const port = Number(match[1])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined

  return new URL(`http://127.0.0.1:${port}`)
}
