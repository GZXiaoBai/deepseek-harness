import { describe, expect, it } from 'vitest'
import {
  parseDesktopSidecarCommand,
  parseDesktopSidecarEvent,
  serializeDesktopSidecarCommand,
  serializeDesktopSidecarEvent,
} from '../src/sidecar-protocol.ts'

describe('desktop sidecar protocol', () => {
  it('parses only a complete prefixed control line and leaves plugin output alone', () => {
    expect(parseDesktopSidecarEvent('plugin: DSH_DESKTOP/1 {"type":"stopped"}')).toBeUndefined()
    expect(parseDesktopSidecarEvent('ordinary plugin output')).toBeUndefined()
    expect(parseDesktopSidecarEvent('DSH_DESKTOP/1 {"type":"stopped"}')).toEqual({ type: 'stopped' })
  })

  it('accepts the exact dynamic IPv4 loopback origin reported by ready', () => {
    expect(parseDesktopSidecarEvent(
      'DSH_DESKTOP/1 {"type":"ready","url":"http://127.0.0.1:43127/"}',
    )).toEqual({ type: 'ready', url: 'http://127.0.0.1:43127/' })
  })

  it('accepts one URL-safe Web authentication token on the ready URL', () => {
    expect(parseDesktopSidecarEvent(
      'DSH_DESKTOP/1 {"type":"ready","url":"http://127.0.0.1:43127/?token=abc_123-XYZ"}',
    )).toEqual({ type: 'ready', url: 'http://127.0.0.1:43127/?token=abc_123-XYZ' })
  })

  it.each([
    ['localhost', 'http://localhost:43127/'],
    ['IPv6', 'http://[::1]:43127/'],
    ['credentials', 'http://user:pass@127.0.0.1:43127/'],
    ['path', 'http://127.0.0.1:43127/app'],
    ['query', 'http://127.0.0.1:43127/?source=desktop'],
    ['empty token', 'http://127.0.0.1:43127/?token='],
    ['duplicate token', 'http://127.0.0.1:43127/?token=one&token=two'],
    ['extra query', 'http://127.0.0.1:43127/?token=one&next=two'],
    ['fragment', 'http://127.0.0.1:43127/#app'],
    ['port zero', 'http://127.0.0.1:0/'],
  ])('rejects a ready event with a non-canonical %s URL', (_case, url) => {
    expect(() => parseDesktopSidecarEvent(
      `DSH_DESKTOP/1 ${JSON.stringify({ type: 'ready', url })}`,
    )).toThrow('invalid ready URL')
  })

  it('rejects malformed or unknown prefixed control messages instead of logging them as plugin output', () => {
    expect(() => parseDesktopSidecarEvent('DSH_DESKTOP/1 not-json')).toThrow('invalid JSON')
    expect(() => parseDesktopSidecarEvent('DSH_DESKTOP/1 {"type":"surprise"}')).toThrow('unknown event type')
  })

  it('parses lifecycle, fatal, and native directory-picker events', () => {
    expect(parseDesktopSidecarEvent(
      'DSH_DESKTOP/1 {"type":"phase","phase":"plugin-tree-ready","elapsedMs":812}',
    )).toEqual({ type: 'phase', phase: 'plugin-tree-ready', elapsedMs: 812 })
    expect(parseDesktopSidecarEvent(
      'DSH_DESKTOP/1 {"type":"fatal","message":"profile failed"}',
    )).toEqual({ type: 'fatal', message: 'profile failed' })
    expect(parseDesktopSidecarEvent(
      'DSH_DESKTOP/1 {"type":"directory-picker-request","requestId":"picker-7","title":"选择工作区"}',
    )).toEqual({
      type: 'directory-picker-request',
      requestId: 'picker-7',
      title: '选择工作区',
    })
  })

  it('serializes shutdown and Unicode directory-picker results as one framed stdin line', () => {
    expect(serializeDesktopSidecarCommand({ type: 'shutdown' }))
      .toBe('DSH_DESKTOP/1 {"type":"shutdown"}\n')
    expect(serializeDesktopSidecarCommand({
      type: 'directory-picker-result',
      requestId: 'picker-7',
      path: 'C:\\用户\\有 空格',
    })).toBe(
      'DSH_DESKTOP/1 {"type":"directory-picker-result","requestId":"picker-7","path":"C:\\\\用户\\\\有 空格"}\n',
    )
  })

  it('round-trips sidecar events and native-shell commands through their wire directions', () => {
    expect(serializeDesktopSidecarEvent({
      type: 'directory-picker-request',
      requestId: 'picker-9',
      title: '选择工作区',
    })).toBe(
      'DSH_DESKTOP/1 {"type":"directory-picker-request","requestId":"picker-9","title":"选择工作区"}\n',
    )
    expect(parseDesktopSidecarCommand(
      'DSH_DESKTOP/1 {"type":"directory-picker-result","requestId":"picker-9","path":"C:\\\\用户\\\\有 空格"}',
    )).toEqual({
      type: 'directory-picker-result',
      requestId: 'picker-9',
      path: 'C:\\用户\\有 空格',
    })
    expect(parseDesktopSidecarCommand('DSH_DESKTOP/1 {"type":"shutdown"}')).toEqual({ type: 'shutdown' })
  })

  it('rejects ordinary, unknown, and malformed stdin frames', () => {
    expect(() => parseDesktopSidecarCommand('ordinary input')).toThrow('missing protocol prefix')
    expect(() => parseDesktopSidecarCommand('DSH_DESKTOP/1 {"type":"other"}')).toThrow('unknown command type')
    expect(() => parseDesktopSidecarCommand('DSH_DESKTOP/1 {')).toThrow('invalid JSON')
  })
})
