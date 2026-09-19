/**
 * URL validation and content-type classification for the local HTTP(S) fetch
 * provider — the pure, network-free half. The provider's `fetch()` composes
 * these with transport (redirect following, byte caps, decoding).
 *
 * @module @deepseek-ai/dsh-web-fetch-http/policy
 */

import { WebError } from '@deepseek-ai/dsh-web'
import ipaddr from 'ipaddr.js'

/** Maximum accepted request URL length enforced by the public fetch provider. */
export const WEB_FETCH_MAX_URL_LENGTH = 2048

/**
 * Pools a deployment's resolver interception may use: RFC 2544 benchmarking
 * (`198.18.0.0/15`, the common fake-IP default) and reserved class E
 * (`240.0.0.0/4`). Both are unroutable on the public internet and never name a
 * local service, so accepting an answer inside them cannot reach loopback,
 * private, link-local, or carrier-grade-NAT destinations.
 */
export const RESOLVER_INTERCEPTION_POOLS = ['198.18.0.0/15', '240.0.0.0/4'] as const

/** One parsed IPv4 network: its network address and prefix length. */
export type Ipv4Range = [ipaddr.IPv4, number]

/** The body kinds this provider decodes. */
export type FetchableKind = 'html' | 'text'

/**
 * Parse a request URL and enforce network-independent transport restrictions:
 * HTTP(S) only and no embedded credentials. The provider applies this before
 * resolving a destination.
 *
 * @param input - the raw URL string from the fetch request.
 * @returns the parsed `URL`.
 */
export function parseFetchUrl(input: string): URL {
  let url: URL
  try {
    url = new URL(input)
  } catch (error: unknown) {
    throw new WebError(`invalid URL: ${input}`, 'WEB_INVALID_URL', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL')
  }
  return url
}

/**
 * Validate a request URL against the provider's complete pre-network policy:
 * bounded length plus the restrictions enforced by {@link parseFetchUrl}.
 * Public-address resolution and connection pinning run after this check.
 *
 * @param input - the raw URL string from the fetch request.
 * @returns the parsed `URL`.
 */
export function validateFetchUrl(input: string): URL {
  if (input.length > WEB_FETCH_MAX_URL_LENGTH) {
    throw new WebError(`URL exceeds the maximum length of ${WEB_FETCH_MAX_URL_LENGTH}`, 'WEB_INVALID_URL')
  }
  return parseFetchUrl(input)
}

/**
 * Parse the deployment's declared resolver-interception ranges. Each entry must
 * be an IPv4 CIDR wholly inside {@link RESOLVER_INTERCEPTION_POOLS}: a fake-IP
 * pool is the only reason an intercepted answer is acceptable, and a private or
 * loopback range would let the declaration itself reach services the address
 * policy exists to keep out of reach.
 *
 * @param values - configured CIDR strings, empty when the deployment intercepts nothing.
 * @returns The parsed ranges in declaration order, without duplicates.
 * @throws when an entry is not an IPv4 CIDR inside an accepted pool.
 */
export function parseResolverInterceptionRanges(values: readonly string[]): Ipv4Range[] {
  const pools = RESOLVER_INTERCEPTION_POOLS.map(pool => ipaddr.IPv4.parseCIDR(pool))
  const ranges: Ipv4Range[] = []
  const seen = new Set<string>()
  for (const value of values) {
    let range: [ipaddr.IPv4, number]
    try {
      range = ipaddr.IPv4.parseCIDR(value)
    } catch (error: unknown) {
      throw new Error(`resolverInterceptionRanges entry ${JSON.stringify(value)} is not an IPv4 CIDR`, { cause: error })
    }
    const [address, prefixLength] = range
    const contained = pools.some(([poolAddress, poolPrefixLength]) => (
      prefixLength >= poolPrefixLength && address.match([poolAddress, poolPrefixLength])
    ))
    if (!contained) {
      throw new Error(
        `resolverInterceptionRanges entry ${JSON.stringify(value)} is outside the accepted pools `
        + RESOLVER_INTERCEPTION_POOLS.join(', '),
      )
    }
    const key = `${address.toString()}/${String(prefixLength)}`
    if (seen.has(key)) continue
    seen.add(key)
    ranges.push(range)
  }
  return ranges
}

/**
 * Whether one IPv4 address falls inside a declared interception range.
 *
 * @param address - parsed IPv4 destination.
 * @param ranges - declared interception ranges; empty when none is declared.
 * @returns true when the deployment's resolver is expected to have placed it.
 */
export function isWithinResolverInterceptionRange(
  address: ipaddr.IPv4,
  ranges: readonly Ipv4Range[],
): boolean {
  return ranges.some(range => address.match(range))
}

/**
 * Two URLs are same-origin when scheme, hostname, and port match. A redirect
 * that crosses origins is refused so each new origin requires a fresh tool call
 * and public-address validation.
 *
 * @param a - one of the two URLs to compare.
 * @param b - the other URL to compare.
 * @returns true when `a` and `b` share scheme, hostname, and port.
 */
export function isSameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
}

/**
 * Classify a response `Content-Type` into a decodable body kind, or `undefined`
 * for an unsupported (e.g. binary) type. `text/html` and `application/xhtml+xml`
 * are `html`; other `text/*` plus a few structured text types are `text`.
 *
 * @param contentType - the raw `Content-Type` header, or `null` when the
 *   response carries none (unsupported).
 * @returns the decodable kind, or `undefined` for an unsupported type.
 */
export function classifyContentType(contentType: string | null): FetchableKind | undefined {
  const mime = (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase()
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime.startsWith('text/')) return 'text'
  if (mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')) return 'text'
  return undefined
}

/**
 * Extract the `charset` parameter from a response `Content-Type`, lower-cased,
 * or `undefined` when absent. The provider feeds this label to `TextDecoder`
 * so a non-UTF-8 response is decoded with its declared encoding rather than
 * silently mangled into replacement characters.
 *
 * @param contentType - the raw `Content-Type` header, or `null` when the
 *   response carries none.
 * @returns the lower-cased charset label, or `undefined` when none is declared.
 */
export function parseCharset(contentType: string | null): string | undefined {
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '')
  return match?.[1]?.trim().toLowerCase()
}

/**
 * Build a `TextDecoder` for the declared charset, falling back to UTF-8 when
 * none is declared. Throws {@link WebError} `WEB_UNSUPPORTED_CONTENT_TYPE` when
 * the label is present but not a charset `TextDecoder` recognizes — better to
 * fail loudly than return mojibake.
 *
 * @param charset - the declared charset label (from {@link parseCharset}), or
 *   `undefined` to default to UTF-8.
 * @returns a decoder for the declared (or defaulted) encoding.
 */
export function decoderForCharset(charset: string | undefined): TextDecoder {
  if (charset === undefined) return new TextDecoder('utf-8')
  try {
    return new TextDecoder(charset)
  } catch (error: unknown) {
    throw new WebError(`unsupported charset "${charset}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE', { cause: error })
  }
}
