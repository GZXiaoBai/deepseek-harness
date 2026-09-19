import { describe, expect, it } from 'vitest'
import { buildChildEnvironment } from '../src/login-path.ts'

describe('buildChildEnvironment', () => {
  it('replaces only PATH and enables Electron Node mode', async () => {
    await expect(buildChildEnvironment(
      { HOME: '/Users/test', SECRET: 'unchanged', PATH: '/usr/bin' },
      async () => '/opt/homebrew/bin:/usr/bin',
    )).resolves.toMatchObject({
      HOME: '/Users/test',
      SECRET: 'unchanged',
      PATH: '/opt/homebrew/bin:/usr/bin',
      ELECTRON_RUN_AS_NODE: '1',
    })
  })
})
