import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface WorkflowStep {
  name?: string
  uses?: string
  run?: string
  env?: Record<string, string>
  'timeout-minutes'?: number
  with?: Record<string, unknown>
  needs?: string[]
}

interface WindowsWorkflow {
  on?: Record<string, unknown>
  permissions?: { contents?: string }
  jobs?: Record<string, {
    'runs-on'?: unknown
    steps?: WorkflowStep[]
  }>
}

describe('Windows Desktop workflow', () => {
  it('builds and verifies NSIS on pull requests and manual dispatches before uploading it for 14 days', async () => {
    const workflowPath = join(import.meta.dirname, '../../../.github/workflows/desktop-windows.yml')
    const workflow = parse(await readFile(workflowPath, 'utf8')) as WindowsWorkflow

    expect(workflow.on).toMatchObject({ pull_request: {}, workflow_dispatch: {} })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    const job = workflow.jobs?.['windows-desktop']
    expect(String(job?.['runs-on'])).toContain("|| 'windows-2025'")
    expect(job?.steps?.some(step => step.name?.includes('Developer Mode'))).toBe(false)
    const rust = job?.steps?.find(step => step.name === 'Install Rust MSVC target')
    expect(rust).toMatchObject({
      uses: 'dtolnay/rust-toolchain@stable',
      with: { targets: 'x86_64-pc-windows-msvc' },
    })
    expect(job?.steps?.map(step => step.run).filter(Boolean)).toContain('pnpm run test:desktop')
    expect(job?.steps?.map(step => step.run).filter(Boolean)).toContain('pnpm run package:desktop:tauri')
    const webview = job?.steps?.find(step => step.name === 'Install WebView2 Runtime for Server acceptance')
    expect(webview?.run).toContain('https://go.microsoft.com/fwlink/p/?LinkId=2124703')
    expect(webview?.run).toContain('/silent /install')
    const verifyPackage = job?.steps?.find(step => step.name === 'Verify unpacked App, installation, launch, and uninstall')
    expect(verifyPackage).toMatchObject({
      run: 'pnpm --filter @deepseek-ai/dsh-desktop run verify:tauri:windows',
      env: { DSH_POWERSHELL_EXECUTABLE: 'pwsh.exe' },
    })
    const upload = job?.steps?.find(step => step.uses?.startsWith('actions/upload-artifact@'))
    expect(upload?.with).toMatchObject({
      name: 'deepseek-harness-tauri-windows-x64',
      'if-no-files-found': 'error',
      'retention-days': 14,
    })
    expect(String(upload?.with?.path)).toContain('apps/desktop/release-tauri/DeepSeek Harness Setup *-x64.exe')
  })

  it('publishes signed Tauri update artifacts from both native runners through one release job', async () => {
    const workflowPath = join(import.meta.dirname, '../../../.github/workflows/desktop-release.yml')
    const workflow = parse(await readFile(workflowPath, 'utf8')) as {
      on?: { push?: { tags?: string[] } }
      permissions?: { contents?: string }
      jobs?: Record<string, WorkflowStep & { 'runs-on'?: unknown; steps?: WorkflowStep[] }>
    }

    expect(workflow.on?.push?.tags).toEqual(['desktop-v*'])
    expect(workflow.permissions).toEqual({ contents: 'write' })
    const windowsJob = workflow.jobs?.['windows']
    const macosJob = workflow.jobs?.['macos']
    expect(String(windowsJob?.['runs-on'])).toContain('windows-2025')
    expect(String(macosJob?.['runs-on'])).toContain('macos-15')
    expect(windowsJob?.steps?.map(step => step.run).filter(Boolean)).toContain('pnpm run package:desktop:tauri')
    const webview = windowsJob?.steps?.find(step => step.name === 'Install WebView2 Runtime for Server acceptance')
    expect(webview?.run).toContain('https://go.microsoft.com/fwlink/p/?LinkId=2124703')
    expect(webview?.run).toContain('/silent /install')
    expect(macosJob?.steps?.map(step => step.run).filter(Boolean)).toContain('pnpm run package:desktop:tauri')
    expect(windowsJob?.steps?.some(step => step.name === 'Verify updater signature and tamper rejection')).toBe(true)
    expect(macosJob?.steps?.some(step => step.name === 'Verify updater signature and tamper rejection')).toBe(true)
    const publishJob = workflow.jobs?.['publish']
    expect(publishJob?.needs).toEqual(['windows', 'macos'])
    const manifest = publishJob?.steps?.find(step => step.name === 'Create updater manifest and SHA-256 files')
    expect(manifest?.run).toContain('create-tauri-update-manifest.mjs')
    expect(manifest?.run).toContain('sha256sum')
    const publish = publishJob?.steps?.find(step => step.name === 'Publish installers and signed updater metadata')
    expect(publish?.run).toContain('gh release create')
  })
})
