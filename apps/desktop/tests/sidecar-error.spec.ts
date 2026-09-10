import { describe, expect, it } from 'vitest'
import { formatSidecarError } from '../src/sidecar-error.ts'

describe('desktop sidecar error formatting', () => {
  it('retains nested aggregate and cause diagnostics', () => {
    const leaf = new Error('plugin package is absent')
    const nested = new AggregateError([leaf], 'loader entries failed')
    const outer = new Error('profile failed', { cause: nested })

    expect(formatSidecarError(outer)).toContain('profile failed')
    expect(formatSidecarError(outer)).toContain('loader entries failed')
    expect(formatSidecarError(outer)).toContain('plugin package is absent')
  })

  it('formats non-error rejections without pretending they have stacks', () => {
    expect(formatSidecarError({ code: 'broken' })).toBe('{"code":"broken"}')
  })
})
