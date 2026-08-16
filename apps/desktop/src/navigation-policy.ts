/** The action the desktop shell should take for a navigation request. */
export type NavigationDecision = 'allow' | 'external' | 'deny'

const HTTP_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * Classifies a navigation target against the trusted harness origin.
 *
 * @param target The fully parsed URL requested by the web view.
 * @param harnessOrigin The configured HTTP loopback origin of the harness web app.
 * @returns Whether the target is same-origin, should open externally, or must be denied.
 */
export function classifyNavigation(target: URL, harnessOrigin: string): NavigationDecision {
  if (!HTTP_PROTOCOLS.has(target.protocol) || target.username !== '' || target.password !== '') {
    return 'deny'
  }

  let origin: URL
  try {
    origin = new URL(harnessOrigin)
  } catch {
    return 'deny'
  }

  if (
    origin.protocol !== 'http:'
    || origin.hostname !== '127.0.0.1'
    || origin.port === ''
    || origin.username !== ''
    || origin.password !== ''
  ) {
    return 'deny'
  }

  const port = Number(origin.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return 'deny'
  }

  return target.origin === origin.origin ? 'allow' : 'external'
}
