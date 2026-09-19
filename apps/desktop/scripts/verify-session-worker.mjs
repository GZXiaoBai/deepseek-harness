import assert from 'node:assert/strict'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

/** Verifies a standalone session worker outside its workspace and package metadata. */
export async function verifySessionWorker(workerPath) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-worker-'))
  try {
    const entry = join(root, 'worker.cjs')
    const path = join(root, 'session.v3.jsonl')
    await copyFile(workerPath, entry)
    await writeFile(path, JSON.stringify({ type: 'session', version: 3, id: 'desktop-worker', createdAt: 1, delegationDepth: 0, isSeeded: false }) + '\n')
    for (const count of [0, 1]) {
      const worker = new Worker(entry, {
        execArgv: [],
        workerData: { path, compression: 'none', expectedId: 'desktop-worker', expectedEventCount: count },
      })
      let timer
      try {
        const result = await new Promise((resolveResult, reject) => {
          timer = setTimeout(() => reject(new Error('Session recovery worker timed out')), 10_000)
          worker.once('message', resolveResult)
          worker.once('error', reject)
          worker.once('exit', code => reject(new Error(`Session recovery worker exited before reporting: ${code}`)))
        })
        assert.equal(result.ok, count === 0, result.message)
        if (count === 1) assert.equal(result.message, 'current session generation contains 0 events, expected 1')
      } finally {
        clearTimeout(timer)
        await worker.terminate()
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await verifySessionWorker(process.argv[2] ?? fileURLToPath(new URL('../src-tauri/resources/dsh-session-worker.cjs', import.meta.url)))
  console.log('Session recovery worker: isolated validation and rejection passed')
}
