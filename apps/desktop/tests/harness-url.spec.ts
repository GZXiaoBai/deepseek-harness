import { describe, expect, it } from 'vitest'
import { parseHarnessUrl } from '../src/harness-url.ts'

describe('parseHarnessUrl', () => {
  it('normalizes a valid dynamic loopback port into a harness URL', () => {
    expect(parseHarnessUrl('dsh web: http://127.0.0.1:43127')?.href)
      .toBe('http://127.0.0.1:43127/')
  })

  it.each([
    ['localhost hostname', 'dsh web: http://localhost:43127'],
    ['IPv6 loopback', 'dsh web: http://[::1]:43127'],
    ['credentials', 'dsh web: http://user:pass@127.0.0.1:43127'],
    ['path', 'dsh web: http://127.0.0.1:43127/app'],
    ['fragment', 'dsh web: http://127.0.0.1:43127/#app'],
    ['port zero', 'dsh web: http://127.0.0.1:0'],
    ['port above 65535', 'dsh web: http://127.0.0.1:65536'],
  ])('rejects %s instead of widening the accepted URL format', (_case, line) => {
    expect(parseHarnessUrl(line)).toBeUndefined()
  })

  it('rejects output that merely contains a harness URL instead of matching the full line', () => {
    expect(parseHarnessUrl('child output dsh web: http://127.0.0.1:43127')).toBeUndefined()
    expect(parseHarnessUrl('dsh web: http://127.0.0.1:43127 trailing output')).toBeUndefined()
  })
})
