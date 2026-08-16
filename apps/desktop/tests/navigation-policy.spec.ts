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
    ['a non-URL origin', 'not an origin'],
    ['an unterminated IPv6 origin', 'http://[::1'],
    ['a file origin', 'file:///tmp'],
  ])('denies %s instead of trusting a malformed harness origin', (_case, origin) => {
    expect(classifyNavigation(new URL('http://127.0.0.1:43127/session'), origin)).toBe('deny')
  })
})
