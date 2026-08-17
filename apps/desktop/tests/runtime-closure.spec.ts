import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const tsxCli = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url))

describe('Desktop runtime dependency closure', () => {
  it('supplies every required workspace peer in the CLI and Web graph', () => {
    const result = spawnSync(process.execPath, [
      tsxCli,
      'scripts/verify-runtime-closure.ts',
      '--manifest',
      'apps/desktop/runtime/package.json',
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    })
    const output = `${result.stdout}${result.stderr}`

    expect(result.error).toBeUndefined()
    expect(result.status, output).toBe(0)
    expect(result.stdout).toMatch(
      /@deepseek-ai\/dsh-desktop-runtime: [1-9][0-9]* workspace packages form a closed runtime dependency graph\./,
    )
  })
})
