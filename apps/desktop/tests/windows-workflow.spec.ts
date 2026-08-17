import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface WorkflowStep {
  uses?: string
  run?: string
  with?: Record<string, unknown>
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
    expect(job?.steps?.map(step => step.run).filter(Boolean)).toContain('pnpm run test:desktop')
    expect(job?.steps?.map(step => step.run).filter(Boolean)).toContain('pnpm run package:desktop')
    expect(job?.steps?.map(step => step.run).filter(Boolean)).toContain(
      'pnpm --filter @deepseek-ai/dsh-desktop run verify:package',
    )
    const upload = job?.steps?.find(step => step.uses?.startsWith('actions/upload-artifact@'))
    expect(upload?.with).toMatchObject({
      name: 'deepseek-harness-windows-x64',
      path: 'apps/desktop/release/DeepSeek Harness Setup *-x64.exe',
      'if-no-files-found': 'error',
      'retention-days': 14,
    })
  })
})
