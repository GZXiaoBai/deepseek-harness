/** Review panel slot registrations and their plain callbacks. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-dev-panel/client'
import type { ReviewPanelInjected } from '@deepseek-ai/dsh-client-ui-dev-panel/client'

async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const layout = { openDetails: vi.fn() }
  ctx.provide('layout', layout)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const slots = ctx.get('slots') as SlotRegistry
  if (declare) {
    // Mirror the real composition chain: root declares the two parent seats,
    // which declare the child slots the plugin registers into.
    slots.register(
      {
        name: 'root',
        children: {
          'sidebar': { kind: 'single', scope: 'root' },
          'details': { kind: 'single', scope: 'session' },
        },
      },
      () => null,
    )
    slots.register(
      { name: 'sidebar', children: { 'sidebar.footer.action': { kind: 'list', scope: 'root' } } },
      () => null,
    )
    slots.register(
      { name: 'details', children: { 'conversation.details.devpanel': { kind: 'single', scope: 'session' } } },
      () => null,
    )
  }
  return { ctx, slots, layout }
}

describe('ui-dev-panel apply', () => {
  it('declares only the services it uses', () => {
    expect(inject).toEqual(['slots', 'layout', 'locale'])
  })

  it('registers the footer trigger and the details panel', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(1)
    expect(b.slots.entries('conversation.details.devpanel')).toHaveLength(1)
    expect(b.slots.entries('conversation.details.devpanel')[0]!.locale).toBe('devpanel')
  })

  it('opens the details column through the trigger callback', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const trigger = b.slots.entries('sidebar.footer.action')[0]!.inject as () => { openPanel: () => void }

    trigger().openPanel()

    expect(b.layout.openDetails).toHaveBeenCalledOnce()
  })

  it('posts panel requests as JSON through the injected caller', async () => {
    const b = await bench()
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ ok: true as const, entries: [] }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const panel = b.slots.entries('conversation.details.devpanel')[0]!.inject as () => ReviewPanelInjected

    const response = await panel().callPanel('/dev-panel.list-files', { root: '/workspace' })

    expect(response).toEqual({ ok: true, entries: [] })
    expect(fetchMock).toHaveBeenCalledWith(
      '/dev-panel.list-files',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: '/workspace' }),
      }),
    )
    vi.unstubAllGlobals()
  })

  it('registers after the owning slots are declared later', async () => {
    const b = await bench(false)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(0)
    b.slots.register(
      {
        name: 'root',
        children: {
          'sidebar': { kind: 'single', scope: 'root' },
          'details': { kind: 'single', scope: 'session' },
        },
      },
      () => null,
    )
    b.slots.register(
      { name: 'sidebar', children: { 'sidebar.footer.action': { kind: 'list', scope: 'root' } } },
      () => null,
    )
    b.slots.register(
      { name: 'details', children: { 'conversation.details.devpanel': { kind: 'single', scope: 'session' } } },
      () => null,
    )
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(1)
    expect(b.slots.entries('conversation.details.devpanel')).toHaveLength(1)
  })

  it('removes both contributions on teardown', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(0)
    expect(b.slots.entries('conversation.details.devpanel')).toHaveLength(0)
  })
})
