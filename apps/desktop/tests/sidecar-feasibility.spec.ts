import { describe, expect, it } from 'vitest'
import { createPtyProbeEnvironment } from '../src/sidecar-feasibility.ts'

describe('desktop sidecar feasibility probe', () => {
  it('supplies the Windows process environment needed by CreateProcessW without leaking unrelated values', () => {
    expect(createPtyProbeEnvironment('win32', {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      DSH_PRIVATE: 'not-forwarded',
    })).toEqual({
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
    })
  })

  it('keeps the Unix probe environment empty', () => {
    expect(createPtyProbeEnvironment('darwin', { PATH: '/usr/bin' })).toEqual({})
  })
})
