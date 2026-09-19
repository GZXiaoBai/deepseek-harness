import { describe, expect, it } from 'vitest'
import {
  appendPtyProbeOutput,
  createPtyProbeEnvironment,
  probePtcProcess,
} from '../src/sidecar-feasibility.ts'

describe('desktop sidecar feasibility probe', () => {
  it('executes a TypeScript binding in a real child process and joins it before success', async () => {
    await expect(probePtcProcess()).resolves.toBe(true)
  })

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

  it('completes as soon as the ConPTY marker arrives across output chunks', () => {
    const first = appendPtyProbeOutput('', 'DSH_PTY_')
    expect(first).toEqual({ output: 'DSH_PTY_', complete: false })
    expect(appendPtyProbeOutput(first.output, 'OK\r\n')).toEqual({
      output: 'DSH_PTY_OK\r\n',
      complete: true,
    })
  })
})
