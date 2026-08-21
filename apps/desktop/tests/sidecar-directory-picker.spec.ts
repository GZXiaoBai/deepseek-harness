import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopSidecarChannel } from '../src/sidecar-channel.ts'
import SidecarDirectoryPicker, {
  installDesktopSidecarChannel,
} from '../src/sidecar-directory-picker.ts'

let uninstall: (() => void) | undefined

afterEach(() => {
  uninstall?.()
  uninstall = undefined
})

describe('SidecarDirectoryPicker', () => {
  it('fails at plugin load when the native parent transport is absent', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(SidecarDirectoryPicker)

    await expect(fiber.await()).rejects.toThrow('desktop sidecar channel is not installed')
  })

  it('registers the native capability and delegates selection to the parent process', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const channel = new DesktopSidecarChannel({ input, output, dispose: async () => {} })
    channel.start()
    uninstall = installDesktopSidecarChannel(channel)
    const ctx = new Context()
    const fiber = ctx.plugin(SidecarDirectoryPicker)
    await fiber.await()

    const capability = ctx.get('directoryPicker')!.capability()
    expect(capability.kind).toBe('native')
    if (capability.kind !== 'native') throw new Error('desktop picker must be native')
    const picked = capability.pick(AbortSignal.timeout(5_000))
    const chunk: unknown = output.read()
    const request = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : typeof chunk === 'string' ? chunk : ''
    expect(request).toContain('"type":"directory-picker-request"')
    input.write('DSH_DESKTOP/1 {"type":"directory-picker-result","requestId":"picker-1","path":"/tmp/工作 区"}\n')
    await expect(picked).resolves.toBe('/tmp/工作 区')

    await fiber.dispose()
    expect(ctx.get('directoryPicker')).toBeUndefined()
  })

  it('allows only one installed parent transport at a time', () => {
    const channel = new DesktopSidecarChannel({
      input: new PassThrough(),
      output: new PassThrough(),
      dispose: async () => {},
    })
    uninstall = installDesktopSidecarChannel(channel)

    expect(() => installDesktopSidecarChannel(channel)).toThrow('already installed')
  })
})
