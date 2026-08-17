import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const modeIndex = process.argv.indexOf('--mode')
const mode = modeIndex === -1 ? 'normal' : process.argv[modeIndex + 1]

if (process.argv.includes('--ignoring-descendant')) {
  process.on('SIGTERM', () => {})
  process.stdout.write('ignoring descendant ready\n')
  setInterval(() => {}, 1_000)
} else if (mode === 'early-exit') {
  process.exitCode = 42
} else if (mode === 'non-matching-output') {
  process.stdout.write('Listening on a different format\n')
  setInterval(() => {}, 1_000)
} else {
  if (mode === 'internals-ready') {
    const require = createRequire(import.meta.url)
    const internalLoader = require('internal/modules/esm/loader').getOrInitializeCascadedLoader()
    if (!process.execArgv.includes('--expose-internals') || internalLoader === undefined) {
      throw new Error('Electron backend cannot access the internal ESM loader')
    }
  }
  const server = createServer((_request, response) => {
    response.writeHead(200)
    response.end('fake dsh')
  })

  const startServer = () => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP listener')

    const announce = () => {
      process.stdout.write(`dsh web: http://127.0.0.1:${address.port}\n`)
      if (mode === 'exit-later') setTimeout(() => process.exit(7), 30)
    }

    if (mode === 'delayed-ready') {
      setTimeout(announce, 60)
    } else {
      announce()
    }
  })

  if (mode === 'leader-with-ignoring-descendant') {
    const descendant = spawn(process.execPath, [process.argv[1], '--ignoring-descendant'], { stdio: ['ignore', 'pipe', 'ignore'] })
    descendant.stdout.once('data', startServer)
  } else {
    startServer()
  }

  if (mode === 'ignore-term') {
    process.on('SIGTERM', () => {})
  } else {
    process.once('SIGTERM', () => server.close(() => process.exit(0)))
  }
}
