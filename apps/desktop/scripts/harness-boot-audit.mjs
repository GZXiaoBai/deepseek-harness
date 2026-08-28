const REQUIRED_BOOT_MODULES = [
  '@deepseek-ai/dsh-client-modules',
]

const REQUIRED_DESKTOP_CLIENT_MODULES = [
  '@deepseek-ai/dsh-client-ui-settings-general',
  '@deepseek-ai/dsh-client-ui-agent-preset',
  '@deepseek-ai/dsh-client-ui-directory-picker-native',
]

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
  for (const id of REQUIRED_BOOT_MODULES) {
    const entry = graph.entries.find(candidate => candidate?.id === id)
    if (typeof entry?.url !== 'string') throw new Error(`Harness boot graph is missing ${id}`)
    if (!html.includes(`<script src="${entry.url}"></script>`)) {
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

/** Exercises the packaged preset roster and the workspace-to-session path. */
export async function requireHarnessFunctionality(url, workspacePath, timeoutMs, fetchImpl = fetch) {
  const call = async (method, payload) => {
    const rpcId = `desktop-verify-${method}`
    const response = await fetchImpl(new URL(`/api/${method}`, url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`Harness ${method} returned HTTP ${response.status}`)
    const envelope = await response.json()
    if (envelope?.type !== 'server-response' || envelope?.rpcId !== rpcId) {
      throw new Error(`Harness ${method} returned an invalid RPC envelope`)
    }
    return envelope
  }

  const presets = await call('agentPreset.list', {})
  validateHarnessAgentPresetResponse(presets)
  const workspace = await call('workspace.create', { path: workspacePath })
  if (workspace.result?.ok !== true || typeof workspace.result.value?.workspace?.workspaceId !== 'string') {
    throw new Error(`Harness workspace creation failed: ${JSON.stringify(workspace.result?.error ?? workspace)}`)
  }
  const session = await call('session.create', {
    workspaceId: workspace.result.value.workspace.workspaceId,
    agentPreset: 'standard',
  })
  if (session.result?.ok !== true || session.result.value?.agentPreset !== 'standard') {
    throw new Error(`Harness standard session creation failed: ${JSON.stringify(session.result?.error ?? session)}`)
  }
}

/** Requires the Harness index and every advertised client bundle to answer successfully. */
export async function requireHarnessBoot(url, timeoutMs) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`Harness index returned HTTP ${response.status}`)
  const bundleUrls = validateHarnessBootHtml(await response.text())
  for (const bundleUrl of bundleUrls) {
    const bundle = await fetch(new URL(bundleUrl, url), { signal: AbortSignal.timeout(timeoutMs) })
    if (!bundle.ok) throw new Error(`Harness client bundle returned HTTP ${bundle.status}: ${bundleUrl}`)
  }
}
