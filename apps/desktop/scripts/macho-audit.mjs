import { spawn } from 'node:child_process'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { extname, join } from 'node:path'

const MACH_O_EXTENSIONS = new Set(['.bundle', '.dylib', '.node', '.so'])

/**
 * Audits every plausible binary in a macOS tree and requires arm64-only Mach-O files.
 *
 * @param {string} rootDirectory Root of the staged runtime or packaged application.
 * @param {{ describeFile?: (path: string) => Promise<string>, inspectArchitectures?: (path: string) => Promise<readonly string[]>, ignoredRelativePaths?: readonly string[] }} [options] Injectable binary inspectors and audit exclusions.
 * @returns {Promise<readonly string[]>} Sorted absolute paths of the audited Mach-O files.
 */
export async function auditArm64MachO(rootDirectory, options = {}) {
  const describeFile = options.describeFile ?? describeWithFile
  const inspectArchitectures = options.inspectArchitectures ?? inspectWithLipo
  const root = await realpath(rootDirectory)
  const ignored = new Set(options.ignoredRelativePaths ?? [])
  const candidates = []
  for await (const path of walkFiles(root, ignored)) {
    const entry = await lstat(path)
    if (isBinaryCandidate(path, entry.mode)) candidates.push(path)
  }
  candidates.sort()

  const binaries = []
  for (const path of candidates) {
    const description = await describeFile(path)
    if (!description.includes('Mach-O')) continue
    const architectures = [...await inspectArchitectures(path)].sort()
    if (architectures.length !== 1 || architectures[0] !== 'arm64') {
      throw new Error(
        `Apple Silicon artifact contains a non-arm64 Mach-O file: ${path} (${architectures.join(', ') || 'unknown'})`,
      )
    }
    binaries.push(path)
  }
  return binaries
}

/** @param {string} path @param {number} mode */
function isBinaryCandidate(path, mode) {
  return (mode & 0o111) !== 0 || MACH_O_EXTENSIONS.has(extname(path).toLowerCase())
}

/** @param {string} path */
async function describeWithFile(path) {
  return await runCapture('/usr/bin/file', ['-b', path])
}

/** @param {string} path */
async function inspectWithLipo(path) {
  return (await runCapture('/usr/bin/lipo', ['-archs', path])).trim().split(/\s+/u).filter(Boolean)
}

/** @param {string} executable @param {readonly string[]} args */
async function runCapture(executable, args) {
  return await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', rejectCommand)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveCommand(stdout.trim())
        return
      }
      rejectCommand(new Error(
        `${executable} ${args.join(' ')} failed (${signal ?? `exit ${String(code)}`}): ${stderr.trim()}`,
      ))
    })
  })
}

/** @param {string} directory @param {ReadonlySet<string>} ignored */
async function* walkFiles(directory, ignored, relativePath = '') {
  const entries = await opendir(directory)
  for await (const entry of entries) {
    const path = join(directory, entry.name)
    const nextRelative = relativePath === '' ? entry.name : join(relativePath, entry.name)
    if (entry.isDirectory()) {
      if (!ignored.has(nextRelative)) yield* walkFiles(path, ignored, nextRelative)
      continue
    }
    if (entry.isFile()) yield path
  }
}
