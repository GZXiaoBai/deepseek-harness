import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { DesktopSidecarChannel } from '../src/sidecar-channel.ts'

function outputLines(stream: PassThrough): string[] {
  const chunk: unknown = stream.read()
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : typeof chunk === 'string' ? chunk : ''
  return text.trimEnd().split('\n').filter(line => line !== '')
}

function outputFrames(stream: PassThrough): Array<Record<string, unknown>> {
  return outputLines(stream).map((line) => {
    const value: unknown = JSON.parse(line.slice('DSH_DESKTOP/1 '.length))
    if (value === null || typeof value !== 'object') throw new Error('expected an object protocol frame')
    return value as Record<string, unknown>
  })
}

describe('DesktopSidecarChannel', () => {
  it('resolves a native directory request with a Unicode path returned over stdin', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const channel = new DesktopSidecarChannel({ input, output, dispose: async () => {} })
    channel.start()

    const picked = channel.pickDirectory('选择工作区', AbortSignal.timeout(5_000))
    expect(outputLines(output)).toEqual([
      'DSH_DESKTOP/1 {"type":"directory-picker-request","requestId":"picker-1","title":"选择工作区"}',
    ])
    input.write(
      'DSH_DESKTOP/1 {"type":"directory-picker-result","requestId":"picker-1","path":"C:\\\\用户\\\\有 空格"}\n',
    )

    await expect(picked).resolves.toBe('C:\\用户\\有 空格')
  })

  it('cancels one pending native picker without affecting the next request', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const channel = new DesktopSidecarChannel({ input, output, dispose: async () => {} })
    channel.start()
    const abort = new AbortController()

    const first = channel.pickDirectory(undefined, abort.signal)
    abort.abort(new Error('request disconnected'))
    await expect(first).rejects.toThrow('request disconnected')

    const second = channel.pickDirectory(undefined, AbortSignal.timeout(5_000))
    input.write('DSH_DESKTOP/1 {"type":"directory-picker-result","requestId":"picker-2","path":null}\n')
    await expect(second).resolves.toBeNull()
  })

  it('coalesces shutdown commands, disposes the Harness tree, and reports stopped', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let disposeCount = 0
    const channel = new DesktopSidecarChannel({
      input,
      output,
      dispose: async () => { disposeCount += 1 },
    })
    channel.start()

    input.write('DSH_DESKTOP/1 {"type":"shutdown"}\nDSH_DESKTOP/1 {"type":"shutdown"}\n')
    await channel.stopped

    expect(disposeCount).toBe(1)
    const frames = outputFrames(output)
    expect(frames).toHaveLength(2)
    expect(frames[0]).toMatchObject({ type: 'phase', phase: 'shutdown-started' })
    expect(typeof frames[0]?.elapsedMs).toBe('number')
    expect(frames[1]).toEqual({ type: 'stopped' })
  })

  it('rejects pending picker calls when stdin closes before a result arrives', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const channel = new DesktopSidecarChannel({ input, output, dispose: async () => {} })
    channel.start()

    const picked = channel.pickDirectory(undefined, AbortSignal.timeout(5_000))
    input.end()

    await expect(picked).rejects.toThrow('native shell command channel closed')
  })

  it('reports a startup failure, disposes partial state, and reaches stopped', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let disposeCount = 0
    const channel = new DesktopSidecarChannel({
      input,
      output,
      dispose: async () => { disposeCount += 1 },
    })
    channel.start()

    await channel.fail(new Error('plugin tree failed'))
    channel.close()

    expect(disposeCount).toBe(1)
    expect(input.listenerCount('data')).toBe(0)
    expect(input.isPaused()).toBe(true)
    const frames = outputFrames(output)
    expect(frames).toHaveLength(3)
    expect(frames[0]).toEqual({ type: 'fatal', message: 'plugin tree failed' })
    expect(frames[1]).toMatchObject({ type: 'phase', phase: 'shutdown-started' })
    expect(typeof frames[1]?.elapsedMs).toBe('number')
    expect(frames[2]).toEqual({ type: 'stopped' })
  })
})
