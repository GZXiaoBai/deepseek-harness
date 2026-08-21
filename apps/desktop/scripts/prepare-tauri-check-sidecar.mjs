import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const desktopRoot = join(import.meta.dirname, '..')
const targetTriple = spawnSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).stdout.trim()
if (targetTriple === '') throw new Error('Unable to resolve the host Rust target triple')

const binariesDirectory = join(desktopRoot, 'src-tauri', 'binaries')
if (process.platform === 'win32') {
  throw new Error('Build the Windows SEA before checking the Tauri shell')
}
await mkdir(binariesDirectory, { recursive: true })
for (const name of [
  'dsh-desktop-sidecar',
  'dsh-desktop-sidecar-rg',
  ...process.platform === 'darwin' ? ['dsh-desktop-sidecar-spawn-helper'] : [],
]) {
  const destination = join(binariesDirectory, `${name}-${targetTriple}`)
  const content = name === 'dsh-desktop-sidecar'
    ? `#!/usr/bin/env node
process.stdout.write('DSH_DESKTOP/1 {"type":"fatal","message":"development sidecar has not been built"}\\n')
`
    : '#!/bin/sh\nexit 1\n'
  try {
    await writeFile(destination, content, { flag: 'wx' })
    await chmod(destination, 0o755)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
}
