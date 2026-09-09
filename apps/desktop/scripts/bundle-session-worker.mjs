import { createRequire } from 'node:module'
import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const [source, destination] = process.argv.slice(2)
if (source === undefined || destination === undefined) {
  throw new Error('Usage: bundle-session-worker.mjs <source> <destination>')
}

const esbuildMain = await findEsbuildMain()
const require = createRequire(esbuildMain)
const { build } = require(esbuildMain)
await build({
  entryPoints: [source],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: destination,
  external: ['node:*'],
  define: { 'import.meta.url': '__DSH_IMPORT_META_URL' },
  banner: {
    js: 'var __DSH_IMPORT_META_URL = require("node:url").pathToFileURL(__filename).href; var __DSH_IMPORT_META_DIRNAME = require("node:path").dirname(__filename);',
  },
})

async function findEsbuildMain() {
  const virtualStore = join(repositoryRoot, 'node_modules/.pnpm')
  if (!existsSync(virtualStore)) throw new Error('Desktop sidecar build requires esbuild')
  const candidates = (await readdir(virtualStore))
    .filter(name => name.startsWith('esbuild@'))
    .sort()
    .reverse()
  for (const candidate of candidates) {
    const main = join(virtualStore, candidate, 'node_modules/esbuild/lib/main.js')
    if (existsSync(main)) return main
  }
  throw new Error('Desktop sidecar build requires an installed esbuild package')
}
