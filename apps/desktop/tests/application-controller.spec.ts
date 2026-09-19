import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApplicationController,
  installTerminationSignalHandlers,
  installTopLevelNavigationGuard,
  launchDesktopApplication,
  resolveDesktopCliEntry,
  resolveDesktopDshHome,
  type ApplicationMenu,
  type DesktopAdapter,
  type DesktopWindow,
  type DesktopWindowOptions,
  type HarnessLifecycle,
  type ShutdownEvent,
  type StartupFailureAction,
  type TerminationSignal,
} from '../src/main.ts'

const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(async directory => rm(directory, { force: true, recursive: true })))
})

class TestWindow implements DesktopWindow {
  readonly loaded: string[] = []
  readonly options: DesktopWindowOptions
  focused = false
  minimized = false
  visible = false
  reloads = 0
  urlLoadError: Error | undefined
  #bounds = { x: 20, y: 30, width: 1100, height: 720 }
  #open: ((url: string) => void) | undefined
  #navigate: ((url: string) => boolean) | undefined
  readonly #loadFileBarrier: Promise<void>
  readonly #loadUrlBarrier: Promise<void>
  #closed: (() => void) | undefined
  #destroyed = false
  #operationsDestroyed = false

  constructor(options: DesktopWindowOptions, loadFileBarrier: Promise<void>, loadUrlBarrier: Promise<void>) {
    this.options = options
    this.#loadFileBarrier = loadFileBarrier
    this.#loadUrlBarrier = loadUrlBarrier
  }

  async loadFile(path: string): Promise<void> {
    if (this.#operationsDestroyed) throw new Error('Object has been destroyed')
    this.loaded.push(path)
    await this.#loadFileBarrier
  }

  async loadUrl(url: string): Promise<void> {
    this.loaded.push(url)
    await this.#loadUrlBarrier
    if (this.urlLoadError !== undefined) throw this.urlLoadError
    if (this.#operationsDestroyed) throw new Error('Object has been destroyed')
  }

  reload(): void {
    this.reloads += 1
  }

  show(): void {
    this.visible = true
  }

  focus(): void {
    this.focused = true
  }

  isMinimized(): boolean {
    return this.minimized
  }

  restore(): void {
    this.minimized = false
  }

  getBounds(): { x: number; y: number; width: number; height: number } {
    return this.#bounds
  }

  onClosed(listener: () => void): void {
    this.#closed = listener
  }

  isDestroyed(): boolean {
    return this.#destroyed
  }

  onBoundsChanged(_listener: () => void): void {}

  onWindowOpen(listener: (url: string) => void): void {
    this.#open = listener
  }

  onTopLevelNavigation(listener: (url: string) => boolean): void {
    this.#navigate = listener
  }

  emitWindowOpen(url: string): void {
    this.#open?.(url)
  }

  emitNavigation(url: string): boolean {
    return this.#navigate?.(url) ?? true
  }

  destroyBeforeClosedEvent(): void {
    this.#operationsDestroyed = true
  }

  emitClosed(): void {
    this.#closed?.()
  }
}

class TestSignalSource {
  readonly #listeners = new Map<TerminationSignal, Set<() => void>>()
  defaultTerminations = 0

  on(signal: TerminationSignal, listener: () => void): void {
    const listeners = this.#listeners.get(signal) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(signal, listeners)
  }

  emit(signal: TerminationSignal): void {
    const listeners = this.#listeners.get(signal)
    if (listeners === undefined || listeners.size === 0) {
      this.defaultTerminations += 1
      return
    }
    for (const listener of listeners) listener()
  }
}

class TestAdapter implements DesktopAdapter {
  lock = true
  exited = false
  exitCodes: number[] = []
  quitCount = 0
  menu: ApplicationMenu | undefined
  window: TestWindow | undefined
  openedExternal: string[] = []
  openedPaths: string[] = []
  failureActions: StartupFailureAction[] = []
  ready: Promise<void> = Promise.resolve()
  windowLoad: Promise<void> = Promise.resolve()
  windowUrlLoad: Promise<void> = Promise.resolve()
  #secondInstance: (() => void) | undefined
  #beforeQuit: ((event: ShutdownEvent) => void) | undefined
  #allWindowsClosed: (() => void) | undefined
  #signal: (() => void) | undefined

  requestSingleInstanceLock(): boolean {
    return this.lock
  }

  exit(code = 0): void {
    this.exited = true
    this.exitCodes.push(code)
  }

  async whenReady(): Promise<void> {
    await this.ready
  }

  createWindow(options: DesktopWindowOptions): DesktopWindow {
    this.window = new TestWindow(options, this.windowLoad, this.windowUrlLoad)
    return this.window
  }

  getDisplayBounds(): Array<{ x: number; y: number; width: number; height: number }> {
    return [{ x: 0, y: 0, width: 1512, height: 982 }]
  }

  setApplicationMenu(menu: ApplicationMenu): void {
    this.menu = menu
  }

  onSecondInstance(listener: () => void): void {
    this.#secondInstance = listener
  }

  onBeforeQuit(listener: (event: ShutdownEvent) => void): void {
    this.#beforeQuit = listener
  }

  onAllWindowsClosed(listener: () => void): void {
    this.#allWindowsClosed = listener
  }

  onTerminationSignal(listener: () => void): void {
    this.#signal = listener
  }

  openExternal(url: string): void {
    this.openedExternal.push(url)
  }

  openPath(path: string): void {
    this.openedPaths.push(path)
  }

  async showStartupFailure(): Promise<StartupFailureAction> {
    const action = this.failureActions.shift()
    if (action === undefined) return new Promise<StartupFailureAction>(() => {})
    return action
  }

  quit(): void {
    this.quitCount += 1
  }

  emitSecondInstance(): void {
    this.#secondInstance?.()
  }

  emitBeforeQuit(): boolean {
    let prevented = false
    this.#beforeQuit?.({ preventDefault: () => { prevented = true } })
    return prevented
  }

  emitAllWindowsClosed(): void {
    this.#allWindowsClosed?.()
  }

  emitSignal(): void {
    this.#signal?.()
  }
}

class TestHarness implements HarnessLifecycle {
  readonly transitions: string[] = []
  startResults: Array<URL | Error> = [new URL('http://127.0.0.1:43127/')]
  pendingStop: Promise<void> | undefined
  #unexpectedExit: ((error: Error) => void) | undefined

  async start(): Promise<URL> {
    this.transitions.push('start')
    const result = this.startResults.shift()
    if (result instanceof Error) throw result
    if (result === undefined) return new Promise<URL>(() => {})
    return result
  }

  async stop(): Promise<void> {
    this.transitions.push('stop')
    await this.pendingStop
  }

  onUnexpectedExit(listener: (error: Error) => void): () => void {
    this.#unexpectedExit = listener
    return () => { this.#unexpectedExit = undefined }
  }

  emitUnexpectedExit(error: Error): void {
    this.#unexpectedExit?.(error)
  }
}

async function createOptions(adapter: TestAdapter, harness: TestHarness) {
  const userDataPath = await mkdtemp(join(tmpdir(), 'dsh-desktop-app-'))
  directories.push(userDataPath)
  return {
    adapter,
    harness,
    startupDocument: join(userDataPath, 'startup.html'),
    errorDocument: join(userDataPath, 'error.html'),
    userDataPath,
    logger: { log: () => {} },
  }
}

async function flush(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('desktop application controller', () => {
  it('isolates Harness data below Electron userData without creating it in the main process', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'dsh-desktop-user-data-'))
    directories.push(userDataPath)

    const dshHome = resolveDesktopDshHome(userDataPath)

    expect(dshHome).toBe(join(userDataPath, 'Harness'))
    expect(dshHome).not.toBe(userDataPath)
    await expect(lstat(dshHome)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('resolves the packaged CLI through the deployed runtime root dependency link', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'dsh-desktop-resources-'))
    directories.push(resourcesPath)
    const cliPath = join(resourcesPath, 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js')
    await mkdir(join(cliPath, '..'), { recursive: true })
    await writeFile(cliPath, '')

    await expect(resolveDesktopCliEntry({
      isPackaged: true,
      resourcesPath,
      moduleUrl: import.meta.url,
    })).resolves.toEqual({
      cliPath,
      cwd: join(resourcesPath, 'runtime'),
    })
  })

  it('resolves the unpackaged CLI from the application module location', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-source-'))
    directories.push(root)
    const modulePath = join(root, 'apps/desktop/lib/main.js')
    const cliPath = join(root, 'apps/cli/lib/bin.js')
    await mkdir(join(modulePath, '..'), { recursive: true })
    await mkdir(join(cliPath, '..'), { recursive: true })
    await writeFile(cliPath, '')

    await expect(resolveDesktopCliEntry({
      isPackaged: false,
      resourcesPath: join(root, 'unused-resources'),
      moduleUrl: pathToFileURL(modulePath).href,
    })).resolves.toEqual({ cliPath, cwd: root })
  })

  it('rejects a missing packaged CLI entry', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'dsh-desktop-resources-'))
    directories.push(resourcesPath)
    await mkdir(join(resourcesPath, 'runtime'), { recursive: true })

    await expect(resolveDesktopCliEntry({
      isPackaged: true,
      resourcesPath,
      moduleUrl: import.meta.url,
    })).rejects.toThrow('Packaged Harness CLI entry is missing')
  })

  it('rejects a packaged CLI dependency link that escapes the staged runtime', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'dsh-desktop-resources-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-desktop-outside-'))
    directories.push(resourcesPath, outside)
    const dependencyLink = join(resourcesPath, 'runtime/node_modules/@deepseek-ai/dsh')
    await mkdir(join(dependencyLink, '..'), { recursive: true })
    await mkdir(join(outside, 'lib'), { recursive: true })
    await writeFile(join(outside, 'lib/bin.js'), '')
    await symlink(outside, dependencyLink)

    await expect(resolveDesktopCliEntry({
      isPackaged: true,
      resourcesPath,
      moduleUrl: import.meta.url,
    })).rejects.toThrow('Packaged Harness CLI entry resolves outside the staged runtime')
  })

  it('prevents a disallowed server redirect as top-level navigation', () => {
    const listeners = new Map<string, (event: ShutdownEvent, url: string) => void>()
    installTopLevelNavigationGuard({
      on: (event, listener) => { listeners.set(event, listener) },
    }, url => url === 'http://127.0.0.1:43127/allowed')
    let prevented = false

    listeners.get('will-redirect')?.(
      { preventDefault: () => { prevented = true } },
      'https://example.test/redirected',
    )

    expect(prevented).toBe(true)
  })

  it('exits a second process before creating application state', async () => {
    const adapter = new TestAdapter()
    adapter.lock = false
    let created = false

    await expect(launchDesktopApplication(adapter, async () => {
      created = true
      return new ApplicationController(await createOptions(adapter, new TestHarness()))
    })).resolves.toBeUndefined()

    expect(adapter.exited).toBe(true)
    expect(adapter.exitCodes).toEqual([0])
    expect(created).toBe(false)
  })

  it('exits with failure when primary application creation fails', async () => {
    const adapter = new TestAdapter()
    const startupFailure = new Error('desktop logger initialization failed')
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(launchDesktopApplication(adapter, async () => {
      throw startupFailure
    })).resolves.toBeUndefined()

    expect(adapter.exitCodes).toEqual([1])
    expect(diagnostic).toHaveBeenCalledWith('DeepSeek Harness desktop startup failed', startupFailure)
  })

  it('shuts down a created controller before exiting after start fails', async () => {
    const adapter = new TestAdapter()
    const startupFailure = new Error('Electron readiness failed')
    const ready = Promise.withResolvers<undefined>()
    adapter.ready = ready.promise
    const harness = new TestHarness()
    const stop = Promise.withResolvers<undefined>()
    harness.pendingStop = stop.promise
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    const launching = launchDesktopApplication(adapter, async () => (
      new ApplicationController(await createOptions(adapter, harness))
    ))

    await expect.poll(() => adapter.menu).toBeDefined()
    ready.reject(startupFailure)
    await expect.poll(() => harness.transitions).toEqual(['stop'])
    expect(adapter.exitCodes).toEqual([])

    stop.resolve(undefined)
    await expect(launching).resolves.toBeUndefined()
    expect(adapter.exitCodes).toEqual([1])
    expect(diagnostic).toHaveBeenCalledWith('DeepSeek Harness desktop startup failed', startupFailure)
  })

  it('exits and preserves the startup diagnostic when failure cleanup rejects', async () => {
    const adapter = new TestAdapter()
    const startupFailure = new Error('Electron readiness failed')
    const cleanupFailure = new Error('Harness cleanup failed')
    const ready = Promise.withResolvers<undefined>()
    adapter.ready = ready.promise
    const harness = new TestHarness()
    const stop = Promise.withResolvers<undefined>()
    harness.pendingStop = stop.promise
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    const launching = launchDesktopApplication(adapter, async () => (
      new ApplicationController(await createOptions(adapter, harness))
    ))

    await expect.poll(() => adapter.menu).toBeDefined()
    ready.reject(startupFailure)
    await expect.poll(() => harness.transitions).toEqual(['stop'])
    stop.reject(cleanupFailure)
    await expect(launching).resolves.toBeUndefined()

    expect(adapter.exitCodes).toEqual([1])
    expect(diagnostic.mock.calls[0]).toEqual(['DeepSeek Harness desktop startup failed', startupFailure])
    expect(diagnostic).toHaveBeenCalledWith(
      'DeepSeek Harness desktop cleanup after startup failure failed',
      cleanupFailure,
    )
  })

  it('shows the startup document before loading the confirmed Harness URL', async () => {
    const adapter = new TestAdapter()
    const harness = new TestHarness()
    const ready = Promise.withResolvers<URL>()
    harness.start = async () => {
      harness.transitions.push('start')
      return ready.promise
    }
    const options = await createOptions(adapter, harness)
    const launching = launchDesktopApplication(adapter, async () => new ApplicationController(options))

    await expect.poll(() => adapter.window?.loaded).toEqual([options.startupDocument])
    expect(adapter.window?.options.webPreferences).toEqual({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    })
    expect(adapter.window?.options.preload).toBeUndefined()

    ready.resolve(new URL('http://127.0.0.1:43127/'))
    await launching
    expect(adapter.window?.loaded).toEqual([options.startupDocument, 'http://127.0.0.1:43127/'])
  })

  it('shuts down cleanly when Electron reports destroyed before the window state updates', async () => {
    const adapter = new TestAdapter()
    const urlLoad = Promise.withResolvers<undefined>()
    adapter.windowUrlLoad = urlLoad.promise
    const harness = new TestHarness()
    const options = await createOptions(adapter, harness)
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    const launching = launchDesktopApplication(adapter, async () => new ApplicationController(options))

    await expect.poll(() => adapter.window?.loaded).toEqual([
      options.startupDocument,
      'http://127.0.0.1:43127/',
    ])
    adapter.window?.destroyBeforeClosedEvent()
    urlLoad.resolve(undefined)
    await launching

    await expect.poll(() => adapter.quitCount).toBe(1)
    expect(harness.transitions).toEqual(['start', 'stop'])
    expect(adapter.exitCodes).toEqual([])
    expect(diagnostic).not.toHaveBeenCalled()
  })

  it('shuts down cleanly when the failure page is destroyed after a URL load error', async () => {
    const adapter = new TestAdapter()
    const urlLoad = Promise.withResolvers<undefined>()
    adapter.windowUrlLoad = urlLoad.promise
    const harness = new TestHarness()
    const options = await createOptions(adapter, harness)
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    const launching = launchDesktopApplication(adapter, async () => new ApplicationController(options))

    await expect.poll(() => adapter.window?.loaded).toEqual([
      options.startupDocument,
      'http://127.0.0.1:43127/',
    ])
    if (adapter.window === undefined) throw new Error('Desktop test window was not created')
    adapter.window.urlLoadError = new Error('ERR_FAILED (-2) loading the Harness page')
    adapter.window.destroyBeforeClosedEvent()
    urlLoad.resolve(undefined)
    await launching

    await expect.poll(() => adapter.quitCount).toBe(1)
    expect(harness.transitions).toEqual(['start', 'stop'])
    expect(adapter.exitCodes).toEqual([])
    expect(diagnostic).not.toHaveBeenCalled()
  })

  it.each([
    ['last-window close', (adapter: TestAdapter) => { adapter.emitAllWindowsClosed() }],
    ['menu Quit', (adapter: TestAdapter) => {
      adapter.menu?.flatMap(item => item.submenu ?? []).find(item => item.label === 'Quit')?.action?.()
    }],
  ])('does not start Harness after %s completes while the startup document is loading', async (_case, shutDown) => {
    const adapter = new TestAdapter()
    const startupDocument = Promise.withResolvers<undefined>()
    adapter.windowLoad = startupDocument.promise
    const harness = new TestHarness()
    const options = await createOptions(adapter, harness)
    const launching = launchDesktopApplication(adapter, async () => new ApplicationController(options))
    await expect.poll(() => adapter.window?.loaded).toEqual([options.startupDocument])

    shutDown(adapter)
    await expect.poll(() => adapter.quitCount).toBe(1)
    expect(harness.transitions).toEqual(['stop'])

    startupDocument.resolve(undefined)
    await launching
    expect(adapter.quitCount).toBe(1)
    expect(harness.transitions).toEqual(['stop'])
  })

  it('cleans up a failed attempt before retrying on a new URL', async () => {
    const adapter = new TestAdapter()
    adapter.failureActions.push('retry')
    const harness = new TestHarness()
    harness.startResults = [new Error('startup failed'), new URL('http://127.0.0.1:43128/')]
    const stop = Promise.withResolvers<undefined>()
    harness.pendingStop = stop.promise
    const options = await createOptions(adapter, harness)
    const launching = launchDesktopApplication(adapter, async () => new ApplicationController(options))

    await expect.poll(() => adapter.window?.loaded).toEqual([options.startupDocument, options.errorDocument])
    expect(harness.transitions).toEqual(['start', 'stop'])

    stop.resolve(undefined)
    await launching
    expect(harness.transitions).toEqual(['start', 'stop', 'start'])
    expect(adapter.window?.loaded.at(-1)).toBe('http://127.0.0.1:43128/')
  })

  it('switches to the error document after an unexpected Harness exit', async () => {
    const adapter = new TestAdapter()
    const harness = new TestHarness()
    const options = await createOptions(adapter, harness)
    await launchDesktopApplication(adapter, async () => new ApplicationController(options))

    harness.emitUnexpectedExit(new Error('Harness exited'))
    await flush()

    expect(adapter.window?.loaded.at(-1)).toBe(options.errorDocument)
    expect(adapter.window?.emitNavigation('http://127.0.0.1:43127/session')).toBe(false)
  })

  it('restores and focuses the existing window after a second-instance handoff', async () => {
    const adapter = new TestAdapter()
    const harness = new TestHarness()
    await launchDesktopApplication(adapter, async () => new ApplicationController(await createOptions(adapter, harness)))
    adapter.window!.minimized = true

    adapter.emitSecondInstance()

    expect(adapter.window?.minimized).toBe(false)
    expect(adapter.window?.visible).toBe(true)
    expect(adapter.window?.focused).toBe(true)
  })

  it('honors a second-instance handoff received while the first window is still opening', async () => {
    const adapter = new TestAdapter()
    const ready = Promise.withResolvers<undefined>()
    adapter.ready = ready.promise
    const harness = new TestHarness()
    const launching = launchDesktopApplication(adapter, async () => (
      new ApplicationController(await createOptions(adapter, harness))
    ))

    await flush()
    adapter.emitSecondInstance()
    ready.resolve(undefined)
    await launching

    expect(adapter.window?.visible).toBe(true)
    expect(adapter.window?.focused).toBe(true)
  })

  it('denies new windows and opens only credential-free external HTTP links in the system browser', async () => {
    const adapter = new TestAdapter()
    const harness = new TestHarness()
    await launchDesktopApplication(adapter, async () => new ApplicationController(await createOptions(adapter, harness)))

    adapter.window?.emitWindowOpen('https://example.test/help')
    adapter.window?.emitWindowOpen('file:///tmp/secret')
    adapter.window?.emitWindowOpen('https://user:pass@example.test/help')
    await flush()

    expect(adapter.openedExternal).toEqual(['https://example.test/help'])
    expect(adapter.window?.emitNavigation('https://example.test/help')).toBe(false)
    expect(adapter.window?.emitNavigation('file:///tmp/secret')).toBe(false)
    expect(adapter.window?.emitNavigation('http://127.0.0.1:43127/session')).toBe(true)
  })

  it('uses one shutdown barrier for Cmd+Q, last-window close, signals, and Electron quit', async () => {
    const adapter = new TestAdapter()
    const harness = new TestHarness()
    const stop = Promise.withResolvers<undefined>()
    harness.pendingStop = stop.promise
    await launchDesktopApplication(adapter, async () => new ApplicationController(await createOptions(adapter, harness)))

    const quitItem = adapter.menu?.flatMap(item => item.submenu ?? []).find(item => item.label === 'Quit')
    quitItem?.action?.()
    adapter.emitAllWindowsClosed()
    adapter.emitSignal()
    expect(adapter.emitBeforeQuit()).toBe(true)
    await flush()

    expect(harness.transitions).toEqual(['start', 'stop'])
    expect(adapter.quitCount).toBe(0)

    stop.resolve(undefined)
    await flush()
    expect(adapter.quitCount).toBe(1)
    expect(adapter.emitBeforeQuit()).toBe(false)
  })

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'keeps repeated %s events inside the same pending shutdown barrier',
    async (signal) => {
      const adapter = new TestAdapter()
      const harness = new TestHarness()
      const stop = Promise.withResolvers<undefined>()
      harness.pendingStop = stop.promise
      const application = await launchDesktopApplication(adapter, async () => (
        new ApplicationController(await createOptions(adapter, harness))
      ))
      if (application === undefined) throw new Error('primary application did not start')
      const signals = new TestSignalSource()
      const shutdowns: Promise<void>[] = []
      installTerminationSignalHandlers(signals, () => {
        shutdowns.push(application.requestShutdown())
      })

      signals.emit(signal)
      signals.emit(signal)
      await flush()

      expect(signals.defaultTerminations).toBe(0)
      expect(shutdowns).toHaveLength(2)
      expect(shutdowns[0]).toBe(shutdowns[1])
      expect(harness.transitions).toEqual(['start', 'stop'])
      expect(adapter.quitCount).toBe(0)

      stop.resolve(undefined)
      await flush()
      expect(adapter.quitCount).toBe(1)
    },
  )

})
