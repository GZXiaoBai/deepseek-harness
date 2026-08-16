import { createServer } from 'node:http'

const modeIndex = process.argv.indexOf('--mode')
const mode = modeIndex === -1 ? 'normal' : process.argv[modeIndex + 1]

if (mode === 'early-exit') {
  process.exitCode = 42
} else if (mode === 'non-matching-output') {
  process.stdout.write('Listening on a different format\n')
  setInterval(() => {}, 1_000)
} else {
  const server = createServer((_request, response) => {
    response.writeHead(200)
    response.end('fake dsh')
  })

  server.listen(0, '127.0.0.1', () => {
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

  if (mode === 'ignore-term') {
    process.on('SIGTERM', () => {})
  } else {
    process.once('SIGTERM', () => server.close(() => process.exit(0)))
  }
}
