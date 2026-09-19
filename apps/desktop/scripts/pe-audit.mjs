import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const PE_POINTER_OFFSET = 0x3c
const PE_SIGNATURE = Buffer.from('PE\0\0', 'binary')
const X64_MACHINE = 0x8664

/**
 * Audits every regular file in a Windows tree and requires x64 for each PE image.
 *
 * @param {string} root Directory whose packaged files are inspected without following links.
 * @param {{ expectedNonX64Pe?: Readonly<Record<string, number>>, ignoredRelativePaths?: readonly string[] }} [options] Exact reviewed non-x64 exceptions and audit exclusions.
 * @returns {Promise<readonly string[]>} Sorted paths of discovered x64 PE images.
 */
export async function auditX64Pe(root, options = {}) {
  const binaries = []
  const expectedNonX64 = new Map()
  for (const [path, machine] of Object.entries(options.expectedNonX64Pe ?? {})) {
    let canonicalPath
    try {
      canonicalPath = await realpath(path)
    } catch {
      canonicalPath = resolve(path)
    }
    expectedNonX64.set(canonicalPath, machine)
  }
  const canonicalRoot = await realpath(root)
  const ignored = new Set(options.ignoredRelativePaths ?? [])
  for await (const path of walkRegularFiles(canonicalRoot, ignored)) {
    const machine = await inspectPeMachine(path)
    if (machine === undefined) continue
    if (machine !== X64_MACHINE) {
      const expectedMachine = expectedNonX64.get(resolve(path))
      if (expectedMachine === machine) {
        expectedNonX64.delete(resolve(path))
        continue
      }
      throw new Error(
        `Windows x64 artifact contains a non-x64 PE file: ${path} (0x${machine.toString(16).padStart(4, '0')})`,
      )
    }
    binaries.push(path)
  }
  const missingExpected = expectedNonX64.entries().next().value
  if (missingExpected !== undefined) {
    const [path, machine] = missingExpected
    throw new Error(
      `Expected reviewed non-x64 PE file was missing or changed: ${path} (0x${machine.toString(16).padStart(4, '0')})`,
    )
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

/** @param {string} directory @param {ReadonlySet<string>} ignored */
async function* walkRegularFiles(directory, ignored, relativePath = '') {
  const entries = await opendir(directory)
  for await (const entry of entries) {
    const path = join(directory, entry.name)
    const nextRelative = relativePath === '' ? entry.name : join(relativePath, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) continue
    if (metadata.isDirectory()) {
      if (!ignored.has(nextRelative)) yield* walkRegularFiles(path, ignored, nextRelative)
      continue
    }
    if (metadata.isFile()) yield path
  }
}
