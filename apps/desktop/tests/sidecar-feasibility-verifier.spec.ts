import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn }))

const { verifyDesktopSidecarFeasibility } = await import(
  pathToFileURL(join(import.meta.dirname, '../scripts/verify-sidecar-feasibility.mjs')).href,
) as { verifyDesktopSidecarFeasibility: (input: { platform: string; arch: string }) => Promise<void> }

it.each([undefined, false, true])('requires ptcProcess=true in a packaged feasibility report (%s)', async (ptcProcess) => {
  spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    })
    setImmediate(() => {
      const result = { nodePty: true, workerThread: true, koffi: true, externalPlugin: true, ptcProcess }
      child.stdout.end(`DSH_DESKTOP_PROBE/1 ${JSON.stringify(result)}\n`)
      child.stderr.end()
      child.emit('exit', 0, null)
    })
    return child
  })
  const verification = verifyDesktopSidecarFeasibility({ platform: 'darwin', arch: 'arm64' })
  if (ptcProcess === true) await expect(verification).resolves.toBeUndefined()
  else await expect(verification).rejects.toThrow('Desktop sidecar feasibility failed: ptcProcess')
})
