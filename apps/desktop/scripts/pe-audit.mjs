import { lstat, open, opendir } from 'node:fs/promises'
import { join } from 'node:path'

const PE_POINTER_OFFSET = 0x3c
const PE_SIGNATURE = Buffer.from('PE\0\0', 'binary')
const X64_MACHINE = 0x8664

/**
 * Audits every regular file in a Windows tree and requires x64 for each PE image.
 *
 * @param {string} root Directory whose packaged files are inspected without following links.
 * @returns {Promise<readonly string[]>} Sorted paths of discovered x64 PE images.
 */
export async function auditX64Pe(root) {
  const binaries = []
  for await (const path of walkRegularFiles(root)) {
    const machine = await inspectPeMachine(path)
    if (machine === undefined) continue
    if (machine !== X64_MACHINE) {
      throw new Error(
        `Windows x64 artifact contains a non-x64 PE file: ${path} (0x${machine.toString(16).padStart(4, '0')})`,
      )
    }
    binaries.push(path)
  }
  return binaries.sort()
}

/** @param {string} path */
async function inspectPeMachine(path) {
  const file = await open(path, 'r')
  try {
    const header = Buffer.alloc(PE_POINTER_OFFSET + 4)
    const initial = await file.read(header, 0, header.length, 0)
    if (initial.bytesRead < header.length || header.subarray(0, 2).toString('ascii') !== 'MZ') return undefined

    const peOffset = header.readUInt32LE(PE_POINTER_OFFSET)
    const coffHeader = Buffer.alloc(6)
    const pe = await file.read(coffHeader, 0, coffHeader.length, peOffset)
    if (pe.bytesRead < coffHeader.length || !coffHeader.subarray(0, 4).equals(PE_SIGNATURE)) return undefined
    return coffHeader.readUInt16LE(4)
  } finally {
    await file.close()
  }
}

/** @param {string} directory */
async function* walkRegularFiles(directory) {
  const entries = await opendir(directory)
  for await (const entry of entries) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) continue
    if (metadata.isDirectory()) {
      yield* walkRegularFiles(path)
      continue
    }
    if (metadata.isFile()) yield path
  }
}
