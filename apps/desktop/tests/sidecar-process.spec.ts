import { describe, expect, it } from 'vitest'
import { selectDesktopProcess } from '../src/sidecar-process.ts'

describe('desktop executable process routing', () => {
  it('runs the UI host only without a private child selector', () => {
    expect(selectDesktopProcess({}, ['sidecar'], undefined)).toEqual({ kind: 'desktop' })
  })

  it('routes PTC children without interpreting their frame limit as a desktop argument', () => {
    expect(selectDesktopProcess({ DSH_PTC_RUNTIME_NODE: '1' }, ['sidecar', 'entry', '1048576'], undefined))
      .toEqual({ kind: 'ptc' })
  })

  it('preserves the subprocess provider selection for its runner', () => {
    expect(selectDesktopProcess({ DSH_SUBPROCESS_RUNNER: 'native' }, ['sidecar'], undefined))
      .toEqual({ kind: 'runner', selection: 'native' })
  })

  it('prioritizes the Windows ACL bootstrap over its nested PTC child selector', () => {
    expect(selectDesktopProcess({ DSH_PTC_RUNTIME_NODE: '1' }, ['sidecar', 'entry', 'C:\\acl.js'], 'C:\\acl.js'))
      .toEqual({ kind: 'acl' })
    expect(selectDesktopProcess({}, ['sidecar', 'entry', 'C:\\other.js'], 'C:\\acl.js'))
      .toEqual({ kind: 'desktop' })
  })
})
