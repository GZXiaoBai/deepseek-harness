/**
 * Review panel client plugin: a sidebar footer trigger and the details-column
 * panel (Files / History / Git), fed by the loopback host routes.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale, layout, sidebar, and conversation Context/SlotMap merges.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PanelResponse } from './contract/slots.ts'
import { ReviewPanel } from './ReviewPanel.tsx'
import { PanelTrigger } from './PanelTrigger.tsx'
import { en, zh, type DevPanelKey } from './locales.ts'

export type { PanelResponse, ReviewPanelInjected } from './contract/slots.ts'
export type { DevPanelKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Review panel controls copy. */
    devpanel: DevPanelKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'devpanel'

/** Services required by the review panel plugin. */
export const inject = ['slots', 'layout', 'locale'] as const

/**
 * Registers the footer trigger and the details-column panel.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-dev-panel: dictionaries')

  /** POST one host panel route and parse the JSON envelope. */
  const callPanel = async (
    route: string,
    body: { root: string; path?: string; file?: string },
  ): Promise<PanelResponse> => {
    const response = await fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return await response.json() as PanelResponse
  }

  ctx.effect(
    () => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'dev-panel-trigger',
      locale: NS,
      inject: () => ({
        openPanel: () => { ctx.layout.openDetails() },
      }),
    }, PanelTrigger)),
    'ui-dev-panel: footer trigger',
  )

  ctx.effect(
    () => ctx.slots.inject('conversation.details.devpanel', () => ctx.slots.register({
      name: 'conversation.details.devpanel',
      locale: NS,
      inject: () => ({
        callPanel,
      }),
    }, ReviewPanel)),
    'ui-dev-panel: details panel',
  )
}
