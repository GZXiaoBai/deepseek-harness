const REQUIRED_BOOT_MODULES = [
  '@deepseek-ai/dsh-client-modules',
]

const REQUIRED_DESKTOP_CLIENT_MODULES = [
  '@deepseek-ai/dsh-client-ui-settings-general',
  '@deepseek-ai/dsh-client-ui-agent-preset',
  '@deepseek-ai/dsh-client-ui-directory-picker-native',
]

/** Returns the latest strictly validated ready URL from a tab-separated Desktop log. */
export function parseDesktopReadyUrl(text) {
  const marker = '\tsidecar-stdout\tDSH_DESKTOP/1 '
  const frames = text.split(/\r?\n/).flatMap((line) => {
    const offset = line.indexOf(marker)
    if (offset < 0) return []
    try {
      return [JSON.parse(line.slice(offset + marker.length))]
    } catch {
      return []
    }
  })
  const ready = frames.findLast(frame => frame?.type === 'ready')
  if (typeof ready?.url !== 'string') return undefined
  const match = /^http:\/\/127\.0\.0\.1:([0-9]+)\/(?:\?token=([A-Za-z0-9_-]+))?$/.exec(ready.url)
  if (match === null) return undefined
  const port = Number(match[1])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  return new URL(ready.url)
}

/** Returns every client-bundle URL after validating the required parser preloads. */
export function validateHarnessBootHtml(html) {
  const serialized = /globalThis\["__DSH_BOOT__"\] = (\{.*?\})<\/script>/.exec(html)?.[1]
  if (serialized === undefined) throw new Error('Harness boot graph is missing from the packaged index')
  const graph = JSON.parse(serialized)
  if (!Array.isArray(graph.entries) || graph.entries.length === 0) {
    throw new Error('Harness boot graph has no client plugin entries')
  }
  const urls = graph.entries.map((entry) => {
    if (typeof entry?.id !== 'string' || typeof entry.url !== 'string') {
      throw new Error('Harness boot graph contains an invalid client plugin entry')
    }
    return entry.url
  })
  for (const id of REQUIRED_DESKTOP_CLIENT_MODULES) {
    if (!graph.entries.some(entry => entry.id === id)) {
      throw new Error(`Harness boot graph is missing ${id}`)
    }
  }
  const blockingScripts = [...html.matchAll(/<script\s+src="([^"]+)"\s*><\/script>/g)]
    .map(match => match[1])
  for (const id of REQUIRED_BOOT_MODULES) {
    const entry = graph.entries.find(candidate => candidate?.id === id)
    if (typeof entry?.url !== 'string') throw new Error(`Harness boot graph is missing ${id}`)
    if (!blockingScripts.some(source => source?.includes(`${id}/client.js`) === true)) {
      throw new Error(`Harness index did not parser-preload ${id}`)
    }
  }
  return urls
}

/** Requires the packaged roster to expose the built-in default Agent preset. */
export function validateHarnessAgentPresetResponse(response) {
  if (response?.result?.ok !== true) {
    throw new Error(`Harness Agent preset RPC failed: ${JSON.stringify(response?.result?.error ?? response)}`)
  }
  const standard = response.result.value?.presets?.find(candidate => candidate?.id === 'standard')
  if (standard?.trust !== 'system' || standard?.isDefault !== true || standard?.broken !== undefined) {
    throw new Error('Harness packaged runtime has no usable default standard Agent preset')
  }
}

/** Exchanges an optional launch token for the persistent browser cookie used by package probes. */
async function authenticateHarnessLaunch(url, timeoutMs) {
  const launch = new URL(url)
  if (!launch.searchParams.has('token')) {
    return { url: launch.href, fetch: globalThis.fetch }
  }
  const exchange = await fetch(launch, {
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const location = exchange.headers.get('location')
  const setCookie = exchange.headers.get('set-cookie')
  if (exchange.status !== 303 || location !== '/' || setCookie === null) {
    throw new Error(`Harness launch-token exchange failed with HTTP ${exchange.status}`)
  }
  const cookie = setCookie.split(';', 1)[0]
  if (cookie === undefined || cookie.length === 0) {
    throw new Error('Harness launch-token exchange returned an empty cookie')
  }
  const cleanUrl = new URL(location, launch)
  const authenticatedFetch = (input, init = {}) => {
    const headers = new Headers(init.headers)
    headers.set('cookie', cookie)
    return fetch(input, { ...init, headers })
  }
  return { url: cleanUrl.href, fetch: authenticatedFetch }
}

/** Exercises the packaged preset roster and the workspace-to-session path. */
export async function requireHarnessFunctionality(url, workspacePath, timeoutMs, fetchImpl = fetch) {
  const call = async (method, payload) => {
    const rpcId = `desktop-verify-${method}`
    const response = await fetchImpl(new URL(`/api/${method}`, url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: payload } }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`Harness ${method} returned HTTP ${response.status}`)
    const envelope = await response.json()
    if (envelope?.type !== 'server-response' || envelope?.rpcId !== rpcId) {
      throw new Error(`Harness ${method} returned an invalid RPC envelope`)
    }
    return envelope
  }

  const presets = await call('agentPresets/list', {})
  validateHarnessAgentPresetResponse(presets)
  const workspace = await call('workspace/create', { path: workspacePath })
  if (workspace.result?.ok !== true || typeof workspace.result.value?.workspace?.workspaceId !== 'string') {
    throw new Error(`Harness workspace creation failed: ${JSON.stringify(workspace.result?.error ?? workspace)}`)
  }
  const session = await call('session/create', {
    workspaceId: workspace.result.value.workspace.workspaceId,
    agentPreset: 'standard',
  })
  if (session.result?.ok !== true || session.result.value?.agentPreset !== 'standard') {
    throw new Error(`Harness standard session creation failed: ${JSON.stringify(session.result?.error ?? session)}`)
  }
}

/** Requires the Harness index and every advertised client bundle to answer successfully. */
export async function requireHarnessBoot(url, timeoutMs) {
  const session = await authenticateHarnessLaunch(url, timeoutMs)
  const response = await session.fetch(session.url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`Harness index returned HTTP ${response.status}`)
  const bundleUrls = validateHarnessBootHtml(await response.text())
  for (const bundleUrl of bundleUrls) {
    const bundle = await session.fetch(new URL(bundleUrl, session.url), { signal: AbortSignal.timeout(timeoutMs) })
    if (!bundle.ok) throw new Error(`Harness client bundle returned HTTP ${bundle.status}: ${bundleUrl}`)
  }
  return session
}
