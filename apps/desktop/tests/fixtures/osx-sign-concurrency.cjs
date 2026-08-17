const { createRequire } = require('node:module')
const { readdir } = require('node:fs/promises')
const { basename, join } = require('node:path')

async function main() {
  const electronBuilderEntry = process.argv[2]
  const fixtureDirectory = process.argv[3]
  if (electronBuilderEntry === undefined || fixtureDirectory === undefined) {
    throw new Error('Expected electron-builder entry and fixture directory')
  }

  const builderRequire = createRequire(electronBuilderEntry)
  const appBuilderLibEntry = builderRequire.resolve('app-builder-lib')
  const osxSignEntry = createRequire(appBuilderLibEntry).resolve('@electron/osx-sign')
  const osxSignRequire = createRequire(osxSignEntry)
  const binaryInspection = osxSignRequire('isbinaryfile')
  let active = 0
  let maxActive = 0
  binaryInspection.isBinaryFile = async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise(resolveProbe => setTimeout(resolveProbe, 5))
    active -= 1
    return true
  }

  const expected = (await readdir(fixtureDirectory)).map(name => join(fixtureDirectory, name))
  const { walkAsync } = osxSignRequire(osxSignEntry)
  const result = await walkAsync(fixtureDirectory)
  process.stdout.write(JSON.stringify({
    maxActive,
    orderPreserved: result.length === expected.length && result.every((path, index) => path === expected[index]),
    result: result.map(path => basename(path)),
  }))
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
