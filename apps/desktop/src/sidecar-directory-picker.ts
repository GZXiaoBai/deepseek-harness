import type { Context } from '@deepseek-ai/cordis'
import {
  DirectoryPicker,
  type DirectoryPickerCapability,
} from '@deepseek-ai/dsh-host-directory-picker'
import type { DesktopSidecarChannel } from './sidecar-channel.ts'

const CHANNEL_KEY = Symbol.for('ai.deepseek.harness.desktop-sidecar-channel')

function currentChannel(): DesktopSidecarChannel | undefined {
  return Reflect.get(globalThis, CHANNEL_KEY) as DesktopSidecarChannel | undefined
}

/**
 * Installs the one native-parent transport used by the desktop profile.
 *
 * @param channel Process-owned sidecar command channel.
 * @returns An idempotent disposer that removes only this installation.
 */
export function installDesktopSidecarChannel(channel: DesktopSidecarChannel): () => void {
  if (currentChannel() !== undefined) throw new Error('desktop sidecar channel is already installed')
  Reflect.set(globalThis, CHANNEL_KEY, channel)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    if (currentChannel() === channel) Reflect.deleteProperty(globalThis, CHANNEL_KEY)
  }
}

/** Native directory-picker provider backed by the owning Tauri process. */
export default class SidecarDirectoryPicker extends DirectoryPicker {
  private readonly nativeCapability: DirectoryPickerCapability

  /**
   * Registers a stable native capability over the already-installed parent transport.
   *
   * @param ctx Cordis plugin context for the desktop profile.
   */
  constructor(ctx: Context) {
    const channel = currentChannel()
    if (channel === undefined) throw new Error('desktop sidecar channel is not installed')
    super(ctx)
    this.nativeCapability = {
      kind: 'native',
      pick: signal => channel.pickDirectory('Select workspace folder', signal),
    }
  }

  /**
   * Returns the stable native interaction capability.
   *
   * @returns Native directory picker delegated to the Tauri parent.
   */
  capability(): DirectoryPickerCapability {
    return this.nativeCapability
  }
}
