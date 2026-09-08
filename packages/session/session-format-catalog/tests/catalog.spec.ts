import { describe, expect, it } from 'vitest'
import { sessionFormatCatalog } from '../src/index.ts'

describe('first-party Session format catalog', () => {
  it.each(['default', 'selection', 'inferred'])('preserves historical permission origin %s through v0 to v2', (origin) => {
    const header = { type: 'session', version: 0, id: 'historical-permission', createdAt: 1, delegationDepth: 0 }
    const rows = [{ type: 'permission/preset', seq: 0, time: 1, data: { preset: 'workspace-write', origin } }]
    const source = structuredClone(rows)
    const migrated = sessionFormatCatalog.migrate(sessionFormatCatalog.decodeArtifact(header, rows))
    expect(migrated.header.version).toBe(2)
    expect(migrated.events).toEqual(source)
    expect(rows).toEqual(source)
    const encoded = sessionFormatCatalog.encodeCurrent(migrated)
    expect(sessionFormatCatalog.migrate(sessionFormatCatalog.decodeArtifact(encoded.header, encoded.rows)).events)
      .toEqual(source)
  })

  it.each(['unknown', '', null, 1])('refuses malformed historical permission origin %j', (origin) => {
    const header = { type: 'session', version: 0, id: 'invalid-permission', createdAt: 1, delegationDepth: 0 }
    const rows = [{ type: 'permission/preset', seq: 0, time: 1, data: { preset: 'default', origin } }]
    expect(() => sessionFormatCatalog.migrate(sessionFormatCatalog.decodeArtifact(header, rows))).toThrow(/origin/)
  })

  it('statically owns the complete adjacent v0 to v2 chain', () => {
    const header = {
      type: 'session',
      version: 0,
      id: 'catalog',
      createdAt: 1,
      seedLength: 0,
      delegationDepth: 0,
    }

    expect(sessionFormatCatalog.currentVersion).toBe(2)
    expect(sessionFormatCatalog.readHeader(header)).toEqual({
      status: 'migration-required',
      storedVersion: 0,
      targetVersion: 2,
      header: {
        version: 2,
        id: 'catalog',
        createdAt: 1,
        isSeeded: true,
        delegationDepth: 0,
      },
    })

    const v1Header = { ...header, version: 1 }
    const current = sessionFormatCatalog.decodeArtifact(v1Header, [
      { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } },
    ])
    expect(sessionFormatCatalog.migrate(current)).toMatchObject({
      header: { version: 2, id: 'catalog' },
    })
  })

  it('restores the installed current vocabulary without freezing ordinary payload additions', () => {
    const header = {
      type: 'session', version: 2, id: 'current-growth', createdAt: 1, isSeeded: false, delegationDepth: 0,
    }
    const extended = sessionFormatCatalog.decodeArtifact(header, [{
      type: 'turn/start', seq: 0, time: 1, data: { turn: 1, postReleaseMember: true },
    }])
    expect(sessionFormatCatalog.migrate(extended).events).toEqual(extended.events)

    const unknownRequired = sessionFormatCatalog.decodeArtifact(header, [{
      type: 'ordinary/not-installed', seq: 0, time: 1, data: 'future',
    }])
    expect(() => sessionFormatCatalog.migrate(unknownRequired)).toThrow(/unknown event type/)

    const extension = sessionFormatCatalog.decodeArtifact(header, [{
      type: 'ordinary/external', seq: 0, time: 1, data: null, ignorable: true,
    }])
    expect(sessionFormatCatalog.migrate(extension).events).toEqual([{
      type: 'ordinary/external', seq: 0, time: 1, data: null, ignorable: true,
    }])
  })
})
