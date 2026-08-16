/** The action the desktop shell should take for a navigation request. */
export type NavigationDecision = 'allow' | 'external' | 'deny'

const HTTP_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * Classifies a navigation target against the trusted harness origin.
 *
 * @param target The fully parsed URL requested by the web view.
 * @param harnessOrigin The configured HTTP(S) origin of the harness web app.
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

  if (!HTTP_PROTOCOLS.has(origin.protocol) || origin.username !== '' || origin.password !== '') {
    return 'deny'
  }

  return target.origin === origin.origin ? 'allow' : 'external'
}
