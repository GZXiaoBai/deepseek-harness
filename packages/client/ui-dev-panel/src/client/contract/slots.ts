/** Review panel browser-side contract: injected API face and locale keys. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the conversation SlotMap merge (the details child seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Successful or failed host route response. */
export type PanelResponse =
  | { ok: true; entries?: Array<{ name: string; type: 'file' | 'directory'; size: number }> }
  | { ok: true; content?: string }
  | { ok: true; status?: string }
  | { ok: true; diff?: string }
  | { ok: false; error: string }

/** Registrant-private injected share: the panel's host route caller. */
export interface ReviewPanelInjected {
  /** POST one host panel route with a JSON body and parse the envelope. */
  callPanel: (route: string, body: { root: string; path?: string; file?: string }) => Promise<PanelResponse>
}

/** Full review-panel slot props: session runtime share, injected route caller, and locale. */
export type ReviewPanelProps = PropsRuntime<'conversation.details.devpanel'> & ReviewPanelInjected & PropsLocale<'devpanel'>
