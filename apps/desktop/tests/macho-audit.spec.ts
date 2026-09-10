import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

interface MachOAuditModule {
  auditArm64MachO: (
    rootDirectory: string,
    options?: {
      describeFile(path: string): Promise<string>
      inspectArchitectures(path: string): Promise<readonly string[]>
      ignoredRelativePaths?: readonly string[]
    },
  ) => Promise<readonly string[]>
}

const auditScriptUrl = pathToFileURL(join(import.meta.dirname, '../scripts/macho-audit.mjs')).href
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async directory => rm(directory, { force: true, recursive: true })))
})

async function loadAudit(): Promise<MachOAuditModule> {
  return await import(auditScriptUrl) as MachOAuditModule
}

async function makeFixture(): Promise<{
  root: string
  arm64Node: string
  arm64Helper: string
  x64Node: string
  textFile: string
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-macho-audit-')))
  directories.push(root)
  const arm64Directory = join(root, 'node-pty/prebuilds/darwin-arm64')
  const x64Directory = join(root, 'node-pty/prebuilds/darwin-x64')
  await mkdir(arm64Directory, { recursive: true })
  await mkdir(x64Directory, { recursive: true })
  const arm64Node = join(arm64Directory, 'pty.node')
  const arm64Helper = join(arm64Directory, 'spawn-helper')
  const x64Node = join(x64Directory, 'pty.node')
  const textFile = join(root, 'README.md')
  await Promise.all([
    writeFile(arm64Node, 'fixture'),
    writeFile(arm64Helper, 'fixture'),
    writeFile(x64Node, 'fixture'),
    writeFile(textFile, 'fixture'),
  ])
  await chmod(arm64Helper, 0o755)
  return { root, arm64Node, arm64Helper, x64Node, textFile }
}

function fixtureInspectors(x64Node: string) {
  return {
    describeFile: async (path: string) => path.endsWith('.node') || path.endsWith('spawn-helper')
      ? 'Mach-O 64-bit bundle'
      : 'ASCII text',
    inspectArchitectures: async (path: string) => path === x64Node ? ['x86_64'] : ['arm64'],
  }
}

describe.skipIf(process.platform === 'win32')('Apple Silicon Mach-O audit', () => {
  it('rejects a dormant x86_64-only native prebuild', async () => {
    const fixture = await makeFixture()
    const { auditArm64MachO } = await loadAudit()

    await expect(auditArm64MachO(fixture.root, fixtureInspectors(fixture.x64Node))).rejects.toThrow(
      `Apple Silicon artifact contains a non-arm64 Mach-O file: ${fixture.x64Node} (x86_64)`,
    )
  })

  it('audits native modules and executable helpers while ignoring non-Mach-O files', async () => {
    const fixture = await makeFixture()
    await rm(join(fixture.root, 'node-pty/prebuilds/darwin-x64'), { recursive: true })
    const { auditArm64MachO } = await loadAudit()

    await expect(auditArm64MachO(fixture.root, fixtureInspectors(fixture.x64Node))).resolves.toEqual([
      fixture.arm64Node,
      fixture.arm64Helper,
    ].sort())
  })

  it('skips an ignored multi-platform prebuild directory instead of failing it', async () => {
    const fixture = await makeFixture()
    const { auditArm64MachO } = await loadAudit()

    await expect(auditArm64MachO(fixture.root, {
      ...fixtureInspectors(fixture.x64Node),
      ignoredRelativePaths: ['node-pty/prebuilds/darwin-x64'],
    })).resolves.toEqual([
      fixture.arm64Node,
      fixture.arm64Helper,
    ].sort())
  })
})
