import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import { DesktopLogger } from './desktop-logger.ts'
import { HarnessProcessController } from './harness-process.ts'
import { buildChildEnvironment } from './login-path.ts'
import { createApplicationMenu, type ApplicationMenu, type ApplicationMenuItem } from './menu.ts'
import { classifyNavigation } from './navigation-policy.ts'
import { loadWindowBounds, saveWindowBounds, type DisplayBounds, type WindowBounds } from './window-state.ts'

const WINDOW_STATE_FILE = 'window-state.json'
const LOG_DIRECTORY = 'Logs'
const HARNESS_DATA_DIRECTORY = 'Harness'

/** Browser security settings required for the Harness web renderer. */
export interface DesktopWebPreferences {
  contextIsolation: true
  sandbox: true
  nodeIntegration: false
}

/** BrowserWindow configuration owned by desktop orchestration. */
export interface DesktopWindowOptions {
  bounds: WindowBounds
  minWidth: number
  minHeight: number
  webPreferences: DesktopWebPreferences
  preload?: string
}

/** Electron-independent main-window operations used by the application controller. */
export interface DesktopWindow {
  loadFile(path: string): Promise<void>
  loadUrl(url: string): Promise<void>
  reload(): void
  show(): void
  focus(): void
  isMinimized(): boolean
  restore(): void
  getBounds(): Required<WindowBounds>
  onClosed(listener: () => void): void
  onBoundsChanged(listener: () => void): void
  onWindowOpen(listener: (url: string) => void): void
  onTopLevelNavigation(listener: (url: string) => boolean): void
}

/** Quit event subset needed by the asynchronous shutdown barrier. */
export interface ShutdownEvent {
  preventDefault(): void
}

/** Main-frame navigation events needed to enforce redirect and direct-navigation policy. */
export interface TopLevelNavigationEvents {
  on(event: 'will-navigate' | 'will-redirect', listener: (event: ShutdownEvent, url: string) => void): void
}

/** Process signals that initiate graceful desktop shutdown. */
export type TerminationSignal = 'SIGTERM' | 'SIGINT'

/** Persistent signal listener registration used by desktop shutdown. */
export interface TerminationSignalSource {
  on(signal: TerminationSignal, listener: () => void): void
}

/** Native startup-failure choices exposed by the Electron adapter. */
export type StartupFailureAction = 'retry' | 'open-logs' | 'quit'

/** Narrow Electron application surface consumed by desktop orchestration. */
export interface DesktopAdapter {
  requestSingleInstanceLock(): boolean
  /**
   * Exits Electron immediately with the requested process status.
   *
   * @param code Process status returned to the operating system.
   */
  exit(code: number): void
  whenReady(): Promise<void>
  createWindow(options: DesktopWindowOptions): DesktopWindow
  getDisplayBounds(): DisplayBounds[]
  setApplicationMenu(menu: ApplicationMenu): void
  onSecondInstance(listener: () => void): void
  onBeforeQuit(listener: (event: ShutdownEvent) => void): void
  onAllWindowsClosed(listener: () => void): void
  onTerminationSignal(listener: () => void): void
  openExternal(url: string): void
  openPath(path: string): void
  showStartupFailure(error: Error): Promise<StartupFailureAction>
  quit(): void
}

/** Owned Harness lifecycle consumed by desktop orchestration. */
export interface HarnessLifecycle {
  start(): Promise<URL>
  stop(): Promise<void>
  onUnexpectedExit(listener: (error: Error) => void): () => void
}

/** Inputs whose lifecycles are coordinated by the desktop application controller. */
export interface ApplicationControllerOptions {
  adapter: DesktopAdapter
  harness: HarnessLifecycle
  startupDocument: string
  errorDocument: string
  userDataPath: string
}

export type { ApplicationMenu, ApplicationMenuItem }

/**
 * Resolves the Harness-owned data root below Electron's application data.
 *
 * @param userDataPath Electron's per-user application-data directory.
 * @returns The separate root created and populated by the Harness backend.
 */
export function resolveDesktopDshHome(userDataPath: string): string {
  return join(userDataPath, HARNESS_DATA_DIRECTORY)
}

/** Inputs that locate the Harness CLI for an Electron launch. */
export interface DesktopCliEntryOptions {
  isPackaged: boolean
  resourcesPath: string
  moduleUrl: string
}

/** Harness CLI path and working directory used by the backend child. */
export interface DesktopCliEntry {
  cliPath: string
  cwd: string
}

/**
 * Resolves an existing Harness CLI without allowing a packaged dependency link to escape its runtime.
 *
 * @param options Electron packaging state and application paths.
 * @returns Existing CLI entry and the runtime or checkout working directory.
 */
export async function resolveDesktopCliEntry(options: DesktopCliEntryOptions): Promise<DesktopCliEntry> {
  if (!options.isPackaged) {
    const cliPath = fileURLToPath(new URL('../../cli/lib/bin.js', options.moduleUrl))
    await requireRegularFile(cliPath, 'Unpackaged Harness CLI entry is missing')
    return {
      cliPath,
      cwd: resolve(fileURLToPath(new URL('../../..', options.moduleUrl))),
    }
  }

  const runtimeDirectory = resolve(options.resourcesPath, 'runtime')
  const cliPath = join(runtimeDirectory, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  let canonicalRuntime: string
  let canonicalCli: string
  try {
    const canonicalPaths = await Promise.all([
      realpath(runtimeDirectory),
      realpath(cliPath),
    ])
    canonicalRuntime = canonicalPaths[0]
    canonicalCli = canonicalPaths[1]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Packaged Harness CLI entry is missing: ${cliPath}`)
    }
    throw error
  }
  const fromRuntime = relative(canonicalRuntime, canonicalCli)
  if (fromRuntime === '..' || fromRuntime.startsWith(`..${sep}`) || isAbsolute(fromRuntime)) {
    throw new Error(`Packaged Harness CLI entry resolves outside the staged runtime: ${canonicalCli}`)
  }
  await requireRegularFile(canonicalCli, `Packaged Harness CLI entry is missing: ${cliPath}`)
  return { cliPath, cwd: runtimeDirectory }
}

async function requireRegularFile(path: string, message: string): Promise<void> {
  try {
    if ((await stat(path)).isFile()) return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  throw new Error(message)
}

/**
 * Installs one policy callback for direct top-level navigations and server redirects.
 *
 * @param events Main-frame navigation event source.
 * @param allow Whether a requested top-level URL may load in the desktop window.
 */
export function installTopLevelNavigationGuard(
  events: TopLevelNavigationEvents,
  allow: (url: string) => boolean,
): void {
  const guard = (event: ShutdownEvent, url: string): void => {
    if (!allow(url)) event.preventDefault()
  }
  events.on('will-navigate', guard)
  events.on('will-redirect', guard)
}

/**
 * Keeps every termination signal routed through the application's shutdown barrier.
 *
 * @param source Persistent signal registration source.
 * @param listener Shared shutdown request callback.
 */
export function installTerminationSignalHandlers(
  source: TerminationSignalSource,
  listener: () => void,
): void {
  source.on('SIGTERM', listener)
  source.on('SIGINT', listener)
}

/** Coordinates one Electron window and one owned Harness process. */
export class ApplicationController {
  readonly #adapter: DesktopAdapter
  readonly #harness: HarnessLifecycle
  readonly #startupDocument: string
  readonly #errorDocument: string
  readonly #logsDirectory: string
  readonly #windowStatePath: string
  #window: DesktopWindow | undefined
  #harnessOrigin: string | undefined
  #shutdown: Promise<void> | undefined
  #allowQuit = false
  #started = false
  #focusPending = false

  /**
   * Creates desktop orchestration around injected Electron and Harness operations.
   *
   * @param options Adapter, process controller, documents, and user-data root.
   */
  constructor(options: ApplicationControllerOptions) {
    this.#adapter = options.adapter
    this.#harness = options.harness
    this.#startupDocument = options.startupDocument
    this.#errorDocument = options.errorDocument
    this.#logsDirectory = join(options.userDataPath, LOG_DIRECTORY)
    this.#windowStatePath = join(options.userDataPath, WINDOW_STATE_FILE)
  }

  /**
   * Creates the secure window, installs lifecycle handlers, and starts Harness.
   *
   * @returns Completion after Harness becomes ready or the user quits recovery.
   */
  async start(): Promise<void> {
    if (this.#started) throw new Error('Desktop application has already started')
    this.#started = true
    this.#installLifecycleHandlers()
    this.#installMenu()

    await this.#adapter.whenReady()
    if (this.#isShuttingDown()) return
    const bounds = await loadWindowBounds(this.#windowStatePath, this.#adapter.getDisplayBounds())
    if (this.#isShuttingDown()) return
    const window = this.#adapter.createWindow({
      bounds,
      minWidth: 900,
      minHeight: 600,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    })
    this.#window = window
    this.#installWindowHandlers(window)
    await window.loadFile(this.#startupDocument)
    if (this.#isShuttingDown()) return
    window.show()
    if (this.#focusPending) this.#focusWindow()
    await this.#startHarnessWithRecovery()
  }

  /**
   * Stops the owned Harness process once, then lets Electron quit.
   *
   * @returns The shared shutdown completion barrier.
   */
  requestShutdown(): Promise<void> {
    this.#shutdown ??= (async () => {
      this.#harnessOrigin = undefined
      await this.#harness.stop()
      this.#allowQuit = true
      this.#adapter.quit()
    })()
    return this.#shutdown
  }

  /** Restores and focuses the primary window, or queues activation until it exists. */
  activate(): void {
    this.#focusWindow()
  }

  #installLifecycleHandlers(): void {
    this.#adapter.onBeforeQuit((event) => {
      if (this.#allowQuit) return
      event.preventDefault()
      this.#beginShutdown()
    })
    this.#adapter.onAllWindowsClosed(() => {
      this.#beginShutdown()
    })
    this.#adapter.onTerminationSignal(() => {
      this.#beginShutdown()
    })
    this.#harness.onUnexpectedExit((error) => {
      void this.#showFailure(error).catch(() => {
        this.#beginShutdown()
      })
    })
  }

  #installMenu(): void {
    this.#adapter.setApplicationMenu(createApplicationMenu({
      reload: () => {
        this.#window?.reload()
      },
      openLogsDirectory: () => {
        this.#adapter.openPath(this.#logsDirectory)
      },
      quit: () => {
        this.#beginShutdown()
      },
    }))
  }

  #installWindowHandlers(window: DesktopWindow): void {
    window.onClosed(() => {
      if (this.#window === window) this.#window = undefined
    })
    window.onBoundsChanged(() => {
      void saveWindowBounds(this.#windowStatePath, window.getBounds()).catch(() => {
        // Window state is optional; an unwritable file must not end the application.
      })
    })
    window.onWindowOpen((url) => {
      this.#handleWindowOpen(url)
    })
    window.onTopLevelNavigation(url => this.#allowTopLevelNavigation(url))
  }

  async #startHarnessWithRecovery(): Promise<void> {
    if (this.#isShuttingDown()) return
    try {
      const url = await this.#harness.start()
      if (this.#shutdown !== undefined) return
      this.#harnessOrigin = url.origin
      await this.#window?.loadUrl(url.href)
    } catch (error) {
      if (this.#shutdown !== undefined) return
      await this.#showFailure(asError(error, 'Harness failed to start'))
    }
  }

  async #showFailure(error: Error): Promise<void> {
    if (this.#shutdown !== undefined) return
    this.#harnessOrigin = undefined
    await this.#window?.loadFile(this.#errorDocument)

    for (;;) {
      if (this.#isShuttingDown()) return
      const action = await this.#adapter.showStartupFailure(error)
      if (action === 'open-logs') {
        this.#adapter.openPath(this.#logsDirectory)
        continue
      }
      if (action === 'quit') {
        await this.requestShutdown()
        return
      }

      await this.#harness.stop()
      if (this.#isShuttingDown()) return
      await this.#window?.loadFile(this.#startupDocument)
      await this.#startHarnessWithRecovery()
      return
    }
  }

  #allowTopLevelNavigation(rawUrl: string): boolean {
    let target: URL
    try {
      target = new URL(rawUrl)
    } catch {
      return false
    }

    if (target.href === pathToFileURL(this.#startupDocument).href || target.href === pathToFileURL(this.#errorDocument).href) {
      return true
    }
    if (this.#harnessOrigin === undefined) return false

    const decision = classifyNavigation(target, this.#harnessOrigin)
    if (decision === 'allow') return true
    if (decision === 'external') this.#adapter.openExternal(target.href)
    return false
  }

  #handleWindowOpen(rawUrl: string): void {
    if (this.#harnessOrigin === undefined) return

    let target: URL
    try {
      target = new URL(rawUrl)
    } catch {
      return
    }

    if (classifyNavigation(target, this.#harnessOrigin) === 'external') {
      this.#adapter.openExternal(target.href)
    }
  }

  #focusWindow(): void {
    const window = this.#window
    if (window === undefined) {
      this.#focusPending = true
      return
    }
    this.#focusPending = false
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  #beginShutdown(): void {
    void this.requestShutdown().catch(() => {})
  }

  #isShuttingDown(): boolean {
    return this.#shutdown !== undefined
  }
}

/**
 * Acquires the process-wide instance lock before creating any application state.
 * A fatal creation or start failure is diagnosed before any created controller
 * is shut down, then the primary Electron process exits with status 1.
 *
 * @param adapter Electron application adapter.
 * @param createApplication Lazy application factory invoked only by the primary instance.
 * @returns The started primary controller, or undefined after handoff or fatal startup cleanup.
 */
export async function launchDesktopApplication(
  adapter: DesktopAdapter,
  createApplication: () => Promise<ApplicationController>,
): Promise<ApplicationController | undefined> {
  let application: ApplicationController | undefined
  try {
    if (!adapter.requestSingleInstanceLock()) {
      adapter.exit(0)
      return undefined
    }

    const activation: {
      application: ApplicationController | undefined
      pending: boolean
    } = { application: undefined, pending: false }
    adapter.onSecondInstance(() => {
      if (activation.application === undefined) {
        activation.pending = true
      } else {
        activation.application.activate()
      }
    })
    application = await createApplication()
    activation.application = application
    if (activation.pending) application.activate()
    await application.start()
    return application
  } catch (error: unknown) {
    console.error('DeepSeek Harness desktop startup failed', error)
    if (application !== undefined) {
      try {
        await application.requestShutdown()
      } catch (shutdownError: unknown) {
        console.error('DeepSeek Harness desktop cleanup after startup failure failed', shutdownError)
      }
    }
    adapter.exit(1)
    return undefined
  }
}

type ElectronModule = typeof import('electron')

class ElectronDesktopWindow implements DesktopWindow {
  readonly #window: BrowserWindow

  constructor(window: BrowserWindow) {
    this.#window = window
  }

  loadFile(path: string): Promise<void> {
    return this.#window.loadFile(path)
  }

  loadUrl(url: string): Promise<void> {
    return this.#window.loadURL(url)
  }

  reload(): void {
    this.#window.webContents.reload()
  }

  show(): void {
    this.#window.show()
  }

  focus(): void {
    this.#window.focus()
  }

  isMinimized(): boolean {
    return this.#window.isMinimized()
  }

  restore(): void {
    this.#window.restore()
  }

  getBounds(): Required<WindowBounds> {
    return this.#window.getBounds()
  }

  onClosed(listener: () => void): void {
    this.#window.on('closed', listener)
  }

  onBoundsChanged(listener: () => void): void {
    this.#window.on('resize', listener)
    this.#window.on('move', listener)
  }

  onWindowOpen(listener: (url: string) => void): void {
    this.#window.webContents.setWindowOpenHandler((details) => {
      listener(details.url)
      return { action: 'deny' }
    })
  }

  onTopLevelNavigation(listener: (url: string) => boolean): void {
    installTopLevelNavigationGuard({
      on: (event, guard) => {
        if (event === 'will-navigate') {
          this.#window.webContents.on('will-navigate', guard)
        } else {
          this.#window.webContents.on('will-redirect', guard)
        }
      },
    }, listener)
  }
}

class ElectronAdapter implements DesktopAdapter {
  readonly #electron: ElectronModule

  constructor(electron: ElectronModule) {
    this.#electron = electron
  }

  requestSingleInstanceLock(): boolean {
    return this.#electron.app.requestSingleInstanceLock()
  }

  exit(code: number): void {
    this.#electron.app.exit(code)
  }

  whenReady(): Promise<void> {
    return this.#electron.app.whenReady()
  }

  createWindow(options: DesktopWindowOptions): DesktopWindow {
    const window = new this.#electron.BrowserWindow({
      ...options.bounds,
      minWidth: options.minWidth,
      minHeight: options.minHeight,
      show: false,
      webPreferences: options.webPreferences,
    })
    return new ElectronDesktopWindow(window)
  }

  getDisplayBounds(): DisplayBounds[] {
    return this.#electron.screen.getAllDisplays().map(display => display.bounds)
  }

  setApplicationMenu(menu: ApplicationMenu): void {
    this.#electron.Menu.setApplicationMenu(this.#electron.Menu.buildFromTemplate(menu.map(toElectronMenuItem)))
  }

  onSecondInstance(listener: () => void): void {
    this.#electron.app.on('second-instance', listener)
  }

  onBeforeQuit(listener: (event: ShutdownEvent) => void): void {
    this.#electron.app.on('before-quit', listener)
  }

  onAllWindowsClosed(listener: () => void): void {
    this.#electron.app.on('window-all-closed', listener)
  }

  onTerminationSignal(listener: () => void): void {
    installTerminationSignalHandlers(process, listener)
  }

  openExternal(url: string): void {
    void this.#electron.shell.openExternal(url).catch((error: unknown) => {
      console.error('Unable to open external URL', error)
    })
  }

  openPath(path: string): void {
    void this.#electron.shell.openPath(path).then((error) => {
      if (error !== '') console.error('Unable to open desktop path', error)
    })
  }

  async showStartupFailure(error: Error): Promise<StartupFailureAction> {
    const result = await this.#electron.dialog.showMessageBox({
      type: 'error',
      message: 'DeepSeek Harness could not start',
      detail: error.message,
      buttons: ['Retry', 'Open Logs Directory', 'Quit'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    return ['retry', 'open-logs', 'quit'][result.response] as StartupFailureAction
  }

  quit(): void {
    this.#electron.app.quit()
  }
}

function toElectronMenuItem(item: ApplicationMenuItem): MenuItemConstructorOptions {
  if (item.type === 'separator') return { type: 'separator' }
  const electronItem: MenuItemConstructorOptions = {}
  if (item.label !== undefined) electronItem.label = item.label
  if (item.role !== undefined) electronItem.role = item.role
  if (item.accelerator !== undefined) electronItem.accelerator = item.accelerator
  if (item.action !== undefined) electronItem.click = item.action
  if (item.submenu !== undefined) electronItem.submenu = item.submenu.map(toElectronMenuItem)
  return electronItem
}

async function runElectronMain(): Promise<void> {
  const electron = await import('electron')
  const adapter = new ElectronAdapter(electron)
  await launchDesktopApplication(adapter, async () => {
    const userDataPath = electron.app.getPath('userData')
    const logger = new DesktopLogger(userDataPath)
    const { cliPath, cwd } = await resolveDesktopCliEntry({
      isPackaged: electron.app.isPackaged,
      resourcesPath: process.resourcesPath,
      moduleUrl: import.meta.url,
    })
    const environment = await buildChildEnvironment(process.env)
    const harness = new HarnessProcessController({
      executable: process.execPath,
      cliPath,
      dshHome: resolveDesktopDshHome(userDataPath),
      cwd,
      env: environment,
      logger,
    })
    return new ApplicationController({
      adapter,
      harness,
      startupDocument: fileURLToPath(new URL('../static/startup.html', import.meta.url)),
      errorDocument: fileURLToPath(new URL('../static/error.html', import.meta.url)),
      userDataPath,
    })
  })
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback)
}

if (Object.prototype.hasOwnProperty.call(process.versions, 'electron')) {
  void runElectronMain().catch((error: unknown) => {
    console.error('DeepSeek Harness desktop startup failed', error)
    process.exit(1)
  })
}
