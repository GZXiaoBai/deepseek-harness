import { describe, expect, it } from 'vitest'
import { classifyNavigation } from '../src/navigation-policy.ts'

const harnessOrigin = 'http://127.0.0.1:43127'

describe('classifyNavigation', () => {
  it('allows an HTTP target with the normalized harness origin', () => {
    expect(classifyNavigation(new URL('http://127.0.0.1:43127/session'), harnessOrigin))
      .toBe('allow')
  })

  it.each([
    ['another HTTP origin', 'http://127.0.0.1:43128/session'],
    ['an HTTPS origin', 'https://127.0.0.1:43127/session'],
    ['another host', 'http://localhost:43127/session'],
  ])('marks %s as external', (_case, href) => {
    expect(classifyNavigation(new URL(href), harnessOrigin)).toBe('external')
  })

  it.each([
    ['a file URL', 'file:///tmp/session'],
    ['a data URL', 'data:text/html,session'],
    ['a JavaScript URL', 'javascript:alert(1)'],
    ['a custom-scheme URL', 'my-app://session'],
    ['an HTTP URL with credentials', 'http://user:pass@127.0.0.1:43127/session'],
  ])('denies %s before comparing origins', (_case, href) => {
    expect(classifyNavigation(new URL(href), harnessOrigin)).toBe('deny')
  })

  it('denies credentials in the configured harness origin', () => {
    expect(classifyNavigation(new URL('http://127.0.0.1:43127/session'), 'http://user:pass@127.0.0.1:43127'))
      .toBe('deny')
  })

  it.each([
    ['a remote HTTP origin', 'http://example.test:43127', 'http://example.test:43127/session'],
    ['a remote HTTPS origin', 'https://example.test:43127', 'https://example.test:43127/session'],
    ['a loopback HTTPS origin', 'https://127.0.0.1:43127', 'https://127.0.0.1:43127/session'],
    ['a harness origin with no port', 'http://127.0.0.1', 'http://127.0.0.1:43127/session'],
    ['a harness origin with an invalid port', 'http://127.0.0.1:not-a-port', 'http://127.0.0.1:43127/session'],
    ['a harness origin with port zero', 'http://127.0.0.1:0', 'http://127.0.0.1:43127/session'],
    ['a harness origin with an out-of-range port', 'http://127.0.0.1:65536', 'http://127.0.0.1:43127/session'],
  ])('denies %s rather than allowing an unconfirmed trusted origin', (_case, origin, target) => {
    expect(classifyNavigation(new URL(target), origin)).toBe('deny')
  })

  it.each([
    ['a non-URL origin', 'not an origin'],
    ['an unterminated IPv6 origin', 'http://[::1'],
    ['a file origin', 'file:///tmp'],
  ])('denies %s instead of trusting a malformed harness origin', (_case, origin) => {
    expect(classifyNavigation(new URL('http://127.0.0.1:43127/session'), origin)).toBe('deny')
  })
})
