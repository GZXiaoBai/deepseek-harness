import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Closes a Win32 folder dialog through the same user32 operations as the production driver.
 * @param {number} threadId Native worker thread that owns the dialog.
 * @param {() => Promise<any>} loadKoffi Loads koffi from the packaged runtime.
 * @param {{ attempts: number; delay: () => Promise<void> }} [retry] Window-creation race policy.
 */
export async function closeWin32DialogThread(
  threadId,
  loadKoffi,
  retry = { attempts: 40, delay: async () => { await delay(50) } },
) {
  const loaded = await loadKoffi()
  const koffi = loaded.default ?? loaded
  const user32 = koffi.load('user32.dll')
  const enumThreadWindows = user32.func('__stdcall', 'EnumThreadWindows', 'int', ['uint32', 'void *', 'intptr'])
  const postMessageW = user32.func('__stdcall', 'PostMessageW', 'int', ['void *', 'uint32', 'uintptr', 'intptr'])
  const protoEnumProc = koffi.proto('int __stdcall DshVerifyEnumThreadWndProc(void *hwnd, intptr lparam)')
  let posted = 0
  const callback = koffi.register((window) => {
    posted += 1
    postMessageW(window, 0x10, 0, 0)
    return 1
  }, koffi.pointer(protoEnumProc))
  try {
    for (let attempt = 0; attempt < retry.attempts; attempt += 1) {
      posted = 0
      enumThreadWindows(threadId, callback, 0)
      if (posted > 0) return
      if (attempt + 1 < retry.attempts) await retry.delay()
    }
  } finally {
    koffi.unregister(callback)
  }
  throw new Error(`Packaged Win32 folder dialog did not create a window for thread ${String(threadId)}`)
}

async function main() {
  const [koffiEntry, rawThreadId] = process.argv.slice(2)
  const threadId = Number(rawThreadId)
  if (koffiEntry === undefined || !Number.isInteger(threadId) || threadId < 1) {
    throw new Error('Usage: close-win32-dialog.mjs <absolute-koffi-entry> <positive-thread-id>')
  }
  const require = createRequire(import.meta.url)
  await closeWin32DialogThread(threadId, async () => require(koffiEntry))
}

async function delay(timeoutMs) {
  await new Promise(resolveDelay => setTimeout(resolveDelay, timeoutMs))
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  await main()
}
