import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      /verify-runtime-closure: [1-9][0-9]* agent presets and [1-9][0-9]* workspace packages form a closed runtime dependency graph\./,
    )
  })

  it('rejects a deploy root that supplies only the public CLI', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-runtime-closure-negative-'))
    const manifestPath = join(directory, 'package.json')
    await writeFile(manifestPath, JSON.stringify({
      name: '@deepseek-ai/dsh-runtime-closure-negative',
      private: true,
      dependencies: { '@deepseek-ai/dsh': 'workspace:^' },
    }))

    try {
      const result = spawnSync(process.execPath, [
        tsxCli,
        'scripts/verify-runtime-closure.ts',
        '--manifest',
        manifestPath,
      ], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      })
      const output = `${result.stdout}${result.stderr}`

      expect(result.error).toBeUndefined()
      expect(result.status, output).not.toBe(0)
      expect(output).toContain('preset plugins or required workspace peers are missing')
    } finally {
      await rm(directory, { recursive: true })
    }
  })
})
