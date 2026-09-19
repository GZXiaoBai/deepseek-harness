import { describe, expect, it, vi } from 'vitest'

import { createApplicationMenu } from '../src/menu.ts'

describe('desktop application menu', () => {
  it('provides the native macOS editing commands', () => {
    const menu = createApplicationMenu({
      reload: vi.fn(),
      openLogsDirectory: vi.fn(),
      quit: vi.fn(),
      checkForUpdates: vi.fn(),
      setAutomaticUpdates: vi.fn(),
      automaticUpdatesEnabled: false,
    })

    expect(menu).toContainEqual({
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    })
  })

  it('offers a manual update check and a persisted automatic-update toggle', () => {
    const checkForUpdates = vi.fn()
    const setAutomaticUpdates = vi.fn()
    const menu = createApplicationMenu({
      reload: vi.fn(),
      openLogsDirectory: vi.fn(),
      quit: vi.fn(),
      checkForUpdates,
      setAutomaticUpdates,
      automaticUpdatesEnabled: true,
    })
    const appMenu = menu.find(item => item.label === 'DeepSeek Harness')

    expect(appMenu?.submenu).toContainEqual({ label: 'Check for Updates…', action: checkForUpdates })
    expect(appMenu?.submenu).toContainEqual({
      label: 'Automatic Updates',
      type: 'checkbox',
      checked: true,
      action: expect.any(Function) as () => void,
    })
  })

  it('toggles the automatic-update preference through the checkbox action', () => {
    const setAutomaticUpdates = vi.fn()
    const menu = createApplicationMenu({
      reload: vi.fn(),
      openLogsDirectory: vi.fn(),
      quit: vi.fn(),
      checkForUpdates: vi.fn(),
      setAutomaticUpdates,
      automaticUpdatesEnabled: false,
    })
    const appMenu = menu.find(item => item.label === 'DeepSeek Harness')
    const toggle = appMenu?.submenu?.find(item => item.label === 'Automatic Updates')

    expect(toggle?.type).toBe('checkbox')
    toggle?.action?.()

    expect(setAutomaticUpdates).toHaveBeenCalledWith(true)
  })
})
