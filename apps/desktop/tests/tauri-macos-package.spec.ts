import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const {
  createTauriMacosVerifyPlan,
  requireHarnessFunctionality,
  validateHarnessAgentPresetResponse,
  validateHarnessBootHtml,
} = await import(
  pathToFileURL(join(import.meta.dirname, '../scripts/verify-tauri-macos.mjs')).href,
) as {
  createTauriMacosVerifyPlan: (input: { desktopRoot: string; platform: string; arch: string }) => {
    releaseDirectory: string
    app: string
    executable: string
    smokeExitAfterReadyMs: number
  }
  validateHarnessBootHtml: (html: string) => string[]
  validateHarnessAgentPresetResponse: (response: unknown) => void
  requireHarnessFunctionality: (
    url: string,
    workspacePath: string,
    timeoutMs: number,
    fetchImpl?: typeof fetch,
  ) => Promise<void>
}

const { requireHarnessBoot } = await import(
  pathToFileURL(join(import.meta.dirname, '../scripts/harness-boot-audit.mjs')).href,
) as { requireHarnessBoot: (url: string, timeoutMs: number) => Promise<unknown> }

describe('Tauri macOS package verification plan', () => {
  const desktopRoot = resolve(import.meta.dirname, '..')

  it('targets the collected Apple Silicon application', () => {
    expect(createTauriMacosVerifyPlan({ desktopRoot, platform: 'darwin', arch: 'arm64' })).toEqual({
      releaseDirectory: join(desktopRoot, 'release-tauri'),
      app: join(desktopRoot, 'release-tauri/DeepSeek Harness.app'),
      executable: join(desktopRoot, 'release-tauri/DeepSeek Harness.app/Contents/MacOS/deepseek-harness-desktop'),
      smokeExitAfterReadyMs: 6_000,
    })
  })

  it('requires the parser bootstrap in a non-empty Harness boot graph', () => {
    const entries = [
      { id: '@deepseek-ai/dsh-client-modules', url: '/plugins/modules.js?rev=1' },
      { id: '@deepseek-ai/dsh-api-session-controller', url: '/plugins/session.js?rev=2' },
      { id: '@deepseek-ai/dsh-typert-registry', url: '/plugins/typert.js?rev=3' },
      { id: '@deepseek-ai/dsh-client-ui-settings-general', url: '/plugins/settings.js?rev=4' },
      { id: '@deepseek-ai/dsh-client-ui-agent-preset', url: '/plugins/presets.js?rev=5' },
      { id: '@deepseek-ai/dsh-client-ui-directory-picker-native', url: '/plugins/picker.js?rev=6' },
    ]
    const html = [
      '<html><head>',
      '<script src="/plugins/??@deepseek-ai/dsh-client-modules/client.js&amp;rev=bootstrap"></script>',
      `<script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({ rev: 'graph', entries })}</script>`,
      '</head></html>',
    ].join('')

    expect(validateHarnessBootHtml(html)).toEqual([
      '/plugins/modules.js?rev=1',
      '/plugins/session.js?rev=2',
      '/plugins/typert.js?rev=3',
      '/plugins/settings.js?rev=4',
      '/plugins/presets.js?rev=5',
      '/plugins/picker.js?rev=6',
    ])
    expect(() => validateHarnessBootHtml(html.replace(JSON.stringify(entries), '[]')))
      .toThrow('no client plugin entries')
    expect(() => validateHarnessBootHtml(html.replace(JSON.stringify(entries), JSON.stringify(entries.slice(0, -1)))))
      .toThrow('missing @deepseek-ai/dsh-client-ui-directory-picker-native')
    expect(() => validateHarnessBootHtml(html.replace(
      '<script src="/plugins/??@deepseek-ai/dsh-client-modules/client.js&amp;rev=bootstrap"></script>',
      '',
    )))
      .toThrow('did not parser-preload @deepseek-ai/dsh-client-modules')
  })

  it('requires the packaged Host to expose a usable standard Agent preset', () => {
    expect(() => {
      validateHarnessAgentPresetResponse({
        type: 'server-response',
        rpcId: 'desktop-verify-agent-presets',
        result: {
          ok: true,
          value: { presets: [{ id: 'standard', trust: 'system', isDefault: true }] },
        },
      })
    }).not.toThrow()
    expect(() => {
      validateHarnessAgentPresetResponse({
        type: 'server-response',
        rpcId: 'desktop-verify-agent-presets',
        result: { ok: true, value: { presets: [] } },
      })
    }).toThrow('standard Agent preset')
  })

  it('exchanges the alpha launch token and authenticates every boot request with its cookie', async () => {
    const launchUrl = 'http://127.0.0.1:43127/?token=abc_123-XYZ'
    const entries = [
      { id: '@deepseek-ai/dsh-client-modules', url: '/plugins/modules.js?rev=1' },
      { id: '@deepseek-ai/dsh-client-ui-settings-general', url: '/plugins/settings.js?rev=2' },
      { id: '@deepseek-ai/dsh-client-ui-agent-preset', url: '/plugins/presets.js?rev=3' },
      { id: '@deepseek-ai/dsh-client-ui-directory-picker-native', url: '/plugins/picker.js?rev=4' },
    ]
    const html = [
      '<html><head>',
      '<script src="/plugins/??@deepseek-ai/dsh-client-modules/client.js&amp;rev=bootstrap"></script>',
      `<script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({ rev: 'graph', entries })}</script>`,
      '</head></html>',
    ].join('')
    const requests: Array<{ url: string; cookie: string | null; redirect?: RequestRedirect }> = []
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = new Headers(init?.headers)
      requests.push({
        url,
        cookie: headers.get('cookie'),
        ...(init?.redirect === undefined ? {} : { redirect: init.redirect }),
      })
      if (requests.length === 1) {
        return new Response(null, {
          status: 303,
          headers: { location: '/', 'set-cookie': 'dsh_session=signed; Path=/; HttpOnly; SameSite=Strict' },
        })
      }
      if (url === 'http://127.0.0.1:43127/') return new Response(html, { status: 200 })
      return new Response('bundle', { status: 200 })
    })
    try {
      await requireHarnessBoot(launchUrl, 5_000)
    } finally {
      fetchMock.mockRestore()
    }
    expect(requests[0]).toEqual({ url: launchUrl, cookie: null, redirect: 'manual' })
    expect(requests.slice(1).every(request => request.cookie === 'dsh_session=signed')).toBe(true)
  })

  it('verifies the packaged workspace-to-standard-session flow over the real RPC envelopes', async () => {
    interface TestRpcRequest {
      readonly type: 'client-request'
      readonly rpcId: string
      readonly method: string
      readonly payload: unknown
    }
    const seen: Array<{ url: string; body: TestRpcRequest }> = []
    const values = [
      { presets: [{ id: 'standard', trust: 'system', isDefault: true }] },
      { workspace: { workspaceId: 'workspace-1' }, created: true },
      { sessionId: 'session-1', agentPreset: 'standard' },
    ]
    const fetchImpl: typeof fetch = async (input, init) => {
      if (typeof init?.body !== 'string') throw new Error('test RPC requires a JSON string body')
      const body = JSON.parse(init.body) as TestRpcRequest
      const url = typeof input === 'string'
        ? input
        : input instanceof URL ? input.href : input.url
      seen.push({ url, body })
      return Response.json({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: values.shift() },
      })
    }

    await requireHarnessFunctionality(
      'http://127.0.0.1:43127/',
      '/tmp/验证 工作区',
      5_000,
      fetchImpl,
    )
    expect(seen).toEqual([
      {
        url: 'http://127.0.0.1:43127/api/agentPresets/list',
        body: {
          type: 'client-request',
          rpcId: 'desktop-verify-agentPresets/list',
          method: 'agentPresets/list',
          payload: { args: {} },
        },
      },
      {
        url: 'http://127.0.0.1:43127/api/workspace/create',
        body: {
          type: 'client-request',
          rpcId: 'desktop-verify-workspace/create',
          method: 'workspace/create',
          payload: { args: { request: { path: '/tmp/验证 工作区' } } },
        },
      },
      {
        url: 'http://127.0.0.1:43127/api/session/create',
        body: {
          type: 'client-request',
          rpcId: 'desktop-verify-session/create',
          method: 'session/create',
          payload: { args: { request: { workspaceId: 'workspace-1', agentPreset: 'standard' } } },
        },
      },
    ])
  })

  it('rejects unsupported hosts', () => {
    expect(() => createTauriMacosVerifyPlan({ desktopRoot, platform: 'darwin', arch: 'x64' }))
      .toThrow(/expected darwin-arm64/)
  })
})
