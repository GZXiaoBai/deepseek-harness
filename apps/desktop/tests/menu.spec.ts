import { describe, expect, it, vi } from 'vitest'

import { createApplicationMenu } from '../src/menu.ts'

describe('desktop application menu', () => {
  it('provides the native macOS editing commands', () => {
    const menu = createApplicationMenu({
      reload: vi.fn(),
      openLogsDirectory: vi.fn(),
      quit: vi.fn(),
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
})
