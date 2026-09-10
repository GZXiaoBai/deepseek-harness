import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { createWindowsIco } from './icon-format.mjs'

const sourceIcon = fileURLToPath(new URL('../../web/public/favicon.svg', import.meta.url))
const buildDirectory = new URL('../build/', import.meta.url)
const outputIcns = new URL('../build/icon.icns', import.meta.url)
const outputIco = new URL('../build/icon.ico', import.meta.url)
const tauriIconDirectory = new URL('../src-tauri/icons/', import.meta.url)
const tauriIcon = new URL('../src-tauri/icons/icon.png', import.meta.url)
const iconSizes = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

if (process.platform !== 'darwin' && process.platform !== 'win32') {
  throw new Error(`Unsupported icon build platform: ${process.platform}; expected darwin or win32`)
}

await mkdir(buildDirectory, { recursive: true })
await mkdir(tauriIconDirectory, { recursive: true })
await sharp(sourceIcon).resize(512, 512).png().toFile(fileURLToPath(tauriIcon))
if (process.platform === 'win32') {
  const png = await sharp(sourceIcon).resize(256, 256).png().toBuffer()
  await writeFile(outputIco, createWindowsIco(png))
  process.exit(0)
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'dsh-desktop-icon-'))
const iconsetDirectory = join(temporaryDirectory, 'DeepSeek Harness.iconset')

try {
  await mkdir(iconsetDirectory)
  await Promise.all(iconSizes.map(async ([name, size]) => {
    await sharp(sourceIcon).resize(size, size).png().toFile(join(iconsetDirectory, String(name)))
  }))
  await run('iconutil', ['-c', 'icns', iconsetDirectory, '-o', fileURLToPath(outputIcns)])
} finally {
  await rm(temporaryDirectory, { recursive: true })
}

/** @param {string} executable @param {readonly string[]} args */
async function run(executable, args) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { stdio: 'inherit' })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun()
        return
      }
      rejectRun(new Error(
        `${executable} ${args.join(' ')} failed with ${signal === null ? `exit code ${String(code)}` : `signal ${signal}`}`,
      ))
    })
  })
}
