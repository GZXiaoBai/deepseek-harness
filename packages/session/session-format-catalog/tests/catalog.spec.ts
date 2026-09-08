import { describe, expect, it } from 'vitest'
import { sessionFormatCatalog } from '../src/index.ts'

describe('first-party Session format catalog', () => {
  it.each(['default', 'selection', 'inferred'])('preserves historical permission origin %s through v0 to v2', (origin) => {
    const header = { type: 'session', version: 0, id: 'historical-permission', createdAt: 1, delegationDepth: 0 }
    const rows = [{ type: 'permission/preset', seq: 0, time: 1, data: { preset: 'workspace-write', origin } }]
    const source = structuredClone(rows)
    const restore = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    for (const row of rows) restore.decodeRow(row)
    const migrated = restore.finish()
    expect(migrated.header.version).toBe(2)
    expect(migrated.events).toEqual(source)
    expect(rows).toEqual(source)
    const encodedHeader = sessionFormatCatalog.encodeCurrentHeader(migrated.header, migrated.inheritedEventCount)
    const roundTrip = sessionFormatCatalog.createRestore(encodedHeader, { recovery: 'strict', validation: 'current' })
    for (const event of migrated.events) roundTrip.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event))
    expect(roundTrip.finish().events).toEqual(source)
  })

  it.each(['unknown', '', null, 1])('refuses malformed historical permission origin %j', (origin) => {
    const header = { type: 'session', version: 0, id: 'invalid-permission', createdAt: 1, delegationDepth: 0 }
    const rows = [{ type: 'permission/preset', seq: 0, time: 1, data: { preset: 'default', origin } }]
    const restore = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    expect(() => {
      for (const row of rows) restore.decodeRow(row)
      restore.finish()
    }).toThrow(/origin/)
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
    const restore = sessionFormatCatalog.createRestore(v1Header, {
      recovery: 'strict', validation: 'current',
    })
    restore.decodeRow({ type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } })
    expect(restore.finish()).toMatchObject({
      header: { version: 2, id: 'catalog' },
    })
  })

  it('restores the installed current vocabulary without freezing ordinary payload additions', () => {
    const header = {
      type: 'session', version: 2, id: 'current-growth', createdAt: 1, isSeeded: false, delegationDepth: 0,
    }
    const restore = (rows: readonly unknown[]) => {
      const current = sessionFormatCatalog.createRestore(header, {
        recovery: 'strict', validation: 'current',
      })
      for (const row of rows) current.decodeRow(row)
      return current.finish()
    }
    const extended = restore([{
      type: 'turn/start', seq: 0, time: 1, data: { turn: 1, postReleaseMember: true },
    }])
    expect(extended.events).toEqual([{
      type: 'turn/start', seq: 0, time: 1, data: { turn: 1, postReleaseMember: true },
    }])

    expect(() => restore([{
      type: 'ordinary/not-installed', seq: 0, time: 1, data: 'future',
    }])).toThrow(/unknown event type/)

    const extension = restore([{
      type: 'ordinary/external', seq: 0, time: 1, data: null, ignorable: true,
    }])
    expect(extension.events).toEqual([{
      type: 'ordinary/external', seq: 0, time: 1, data: null, ignorable: true,
    }])
  })

  it('validates complete relationships after streaming migration', () => {
    const stream = sessionFormatCatalog.createRestore({
      type: 'session', version: 1, id: 'invalid-stream', createdAt: 1, delegationDepth: 0,
    }, { recovery: 'strict', validation: 'current' })
    stream.decodeRow({ type: 'step/start', seq: 0, time: 2, data: { turn: 1, step: 1 } })

    expect(() => stream.finish()).toThrow(/open turn/)
  })
})
