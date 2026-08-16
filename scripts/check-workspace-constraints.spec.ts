import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const tsxCli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url))
const fixtureDirectories: string[] = []

afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function runConstraints() {
  return spawnSync(process.execPath, [tsxCli, 'scripts/check-workspace-constraints.ts'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
}

describe('workspace constraints', () => {
  it('allows the reviewed desktop publication payload', () => {
    const directory = join(repositoryRoot, 'apps', `desktop-policy-${randomUUID()}`)
    fixtureDirectories.push(directory)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), `${JSON.stringify({
      name: '@deepseek-ai/dsh-desktop',
      version: '0.1.0-rc.5',
      publishConfig: { access: 'public' },
      repository: {
        type: 'git',
        url: 'git+https://github.com/deepseek-ai/deepseek-harness.git',
        directory: `apps/${basename(directory)}`,
      },
      type: 'module',
      main: 'lib/main.js',
      files: ['lib/*.js', 'static', 'build'],
    }, null, 2)}\n`)

    const result = runConstraints()
    const output = `${result.stdout}${result.stderr}`

    expect(result.error).toBeUndefined()
    expect(result.status, output).toBe(0)
  })
})
