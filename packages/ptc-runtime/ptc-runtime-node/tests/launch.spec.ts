import { isSea } from 'node:sea'
import { expect, it, onTestFinished, vi } from 'vitest'
import { bootstrapArgs } from '../src/launch.ts'

vi.mock('node:sea', () => ({ isSea: vi.fn(() => false) }))

it('uses an explicit installed bootstrap without pretending it maps the host file', () => {
  const fs = { processPathFromHostPath: () => { throw new Error('must not map') } }
  expect(bootstrapArgs(fs, { bootstrapPath: '/remote/process.js' }, 2048)).toEqual(['/remote/process.js', '2048'])
})

it('fails when the execution world cannot read the source bootstrap', () => {
  const fs = { processPathFromHostPath: () => undefined }
  expect(() => bootstrapArgs(fs, {}, 2048)).toThrow('unavailable in the subprocess execution world')
})

it('selects the private packaged bootstrap through the existing executable', () => {
  const prior = Object.getOwnPropertyDescriptor(process, 'pkg')
  try {
    Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
    const fs = { processPathFromHostPath: () => { throw new Error('pkg does not expose a host bootstrap file') } }
    expect(bootstrapArgs(fs, {}, 2048)).toEqual(['2048'])
  } finally {
    if (prior === undefined) Reflect.deleteProperty(process, 'pkg')
    else Object.defineProperty(process, 'pkg', prior)
  }
})

it('selects the private bootstrap in a Node SEA without a pkg marker', () => {
  vi.mocked(isSea).mockReturnValue(true)
  onTestFinished(() => { vi.mocked(isSea).mockReturnValue(false) })
  const fs = { processPathFromHostPath: () => undefined }
  expect(bootstrapArgs(fs, {}, 2048)).toEqual(['2048'])
})
