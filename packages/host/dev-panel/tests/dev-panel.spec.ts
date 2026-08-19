import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { confineToWorkspace, listFiles, readWorkspaceFile, runGit } from '@deepseek-ai/dsh-host-dev-panel'
import type { DevPanelShell } from '@deepseek-ai/dsh-host-dev-panel'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async directory => rm(directory, { force: true, recursive: true })))
})

async function makeWorkspace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-dev-panel-')))
  directories.push(root)
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'index.ts'), 'export const ok = true\n')
  await writeFile(join(root, 'README.md'), '# Workspace\n')
  return root
}

describe('workspace path confinement', () => {
  it('accepts the root and contained descendants', async () => {
    const root = await makeWorkspace()

    await expect(confineToWorkspace(root, '.')).resolves.toBe(root)
    await expect(confineToWorkspace(root, 'src/index.ts')).resolves.toBe(join(root, 'src/index.ts'))
  })

  it('rejects absolute paths and parent escapes', async () => {
    const root = await makeWorkspace()

    await expect(confineToWorkspace(root, '/etc/passwd')).rejects.toThrow('Path escapes the workspace')
    await expect(confineToWorkspace(root, '../outside')).rejects.toThrow('Path escapes the workspace')
  })

  it('rejects a symlink resolving outside the workspace', async () => {
    const root = await makeWorkspace()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-dev-panel-outside-'))
    directories.push(outside)
    await symlink(outside, join(root, 'escape'))

    await expect(confineToWorkspace(root, 'escape/secret.txt')).rejects.toThrow('Path escapes the workspace')
  })

  it('rejects a missing or relative root', async () => {
    await expect(confineToWorkspace('/nonexistent/root', '.')).rejects.toThrow()
    await expect(confineToWorkspace('relative/root', '.')).rejects.toThrow('Workspace root must be absolute')
  })
})

describe('file listing and reading', () => {
  it('lists directories first, then files, sorted', async () => {
    const root = await makeWorkspace()
    await writeFile(join(root, 'a.txt'), 'a')

    await expect(listFiles({ root })).resolves.toEqual([
      { name: 'src', type: 'directory', size: 0 },
      { name: 'README.md', type: 'file', size: 12 },
      { name: 'a.txt', type: 'file', size: 1 },
    ])
  })

  it('lists a nested directory', async () => {
    const root = await makeWorkspace()

    await expect(listFiles({ root, path: 'src' })).resolves.toEqual([
      { name: 'index.ts', type: 'file', size: 23 },
    ])
  })

  it('reads a workspace file as UTF-8', async () => {
    const root = await makeWorkspace()

    await expect(readWorkspaceFile({ root }, 'src/index.ts')).resolves.toBe('export const ok = true\n')
  })

  it('rejects reading a directory', async () => {
    const root = await makeWorkspace()

    await expect(readWorkspaceFile({ root }, 'src')).rejects.toThrow('Not a file')
  })

  it('rejects files beyond the preview limit', async () => {
    const root = await makeWorkspace()
    await writeFile(join(root, 'big.bin'), Buffer.alloc(1024 * 1024))

    await expect(readWorkspaceFile({ root }, 'big.bin')).rejects.toThrow('preview limit')
  })
})

describe('git invocations', () => {
  function shellWith(result: { exitCode: number | null; stderr: string; stdout: string }): DevPanelShell {
    return {
      resolve: request => ({ command: request.command, cwd: request.workdir, stdoutMaxBytes: request.stdoutMaxBytes }) as never,
      run: vi.fn(async () => ({
        exitCode: result.exitCode,
        signal: null,
        stdout: { text: result.stdout, truncated: false },
        stderr: { text: result.stderr, truncated: false },
      }) as never),
    }
  }

  it('runs git with the workspace as working directory', async () => {
    const root = await makeWorkspace()
    const shell = shellWith({ exitCode: 0, stderr: '', stdout: ' M src/index.ts\n' })

    const invocation = await runGit(shell, { root }, 'git status --porcelain')

    expect(shell.resolve({ command: '', workdir: root, stdoutMaxBytes: 1 } as never)).toMatchObject({ cwd: root })
    if ('ok' in invocation) throw new Error('expected success')
    expect(invocation.result.stdout.text).toBe(' M src/index.ts\n')
  })

  it('reports a nonzero git exit as an error result', async () => {
    const root = await makeWorkspace()
    const shell = shellWith({ exitCode: 128, stderr: 'fatal: not a git repository', stdout: '' })

    const invocation = await runGit(shell, { root }, 'git status --porcelain')

    expect('ok' in invocation && !invocation.ok).toBe(true)
    if (!('ok' in invocation) || invocation.ok) throw new Error('expected failure')
    expect(invocation.error).toContain('not a git repository')
  })
})
