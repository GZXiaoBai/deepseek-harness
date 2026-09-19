type MenuAction = () => void

/** Native Electron editing command delegated to the focused web content. */
export type ApplicationMenuRole = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'

/** Framework-independent menu item consumed by the Electron adapter. */
export interface ApplicationMenuItem {
  label?: string
  type?: 'separator' | 'checkbox'
  checked?: boolean
  role?: ApplicationMenuRole
  accelerator?: string
  action?: MenuAction
  submenu?: ApplicationMenuItem[]
}

/** Complete desktop application menu model. */
export type ApplicationMenu = ApplicationMenuItem[]

/** Actions owned by the desktop application controller. */
export interface ApplicationMenuActions {
  reload: MenuAction
  openLogsDirectory: MenuAction
  quit: MenuAction
  checkForUpdates: MenuAction
  /** Toggles the persisted automatic-update preference and rebuilds the menu. */
  setAutomaticUpdates: (enabled: boolean) => void
  /** Whether automatic updates are currently enabled. */
  automaticUpdatesEnabled: boolean
}

/**
 * Builds the desktop menu without importing Electron into orchestration tests.
 *
 * @param actions Controller callbacks for every application-owned menu action.
 * @returns The application menu consumed by the Electron adapter.
 */
export function createApplicationMenu(actions: ApplicationMenuActions): ApplicationMenu {
  return [
    {
      label: 'DeepSeek Harness',
      submenu: [
        { label: 'Check for Updates…', action: actions.checkForUpdates },
        {
          label: 'Automatic Updates',
          type: 'checkbox',
          checked: actions.automaticUpdatesEnabled,
          action: () => { actions.setAutomaticUpdates(!actions.automaticUpdatesEnabled) },
        },
        { type: 'separator' },
        { label: 'Open Logs Directory', action: actions.openLogsDirectory },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CommandOrControl+Q', action: actions.quit },
      ],
    },
    {
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
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CommandOrControl+R', action: actions.reload },
      ],
    },
  ]
}
