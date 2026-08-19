/** Sidebar footer trigger that opens the details column onto the review panel. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the sidebar SlotMap merge (the footer action seat).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './ReviewPanel.module.css'

/** Registrant-private injected share of the footer trigger. */
export interface PanelTriggerInjected {
  /** Opens the details column (the tabbed panel owns tab selection). */
  openPanel: () => void
}

/** Full footer-trigger props: sidebar owner share, injected open callback, and locale. */
export type PanelTriggerProps = PropsRuntime<'sidebar.footer.action'> & PanelTriggerInjected & PropsLocale<'devpanel'>

/** Renders one footer action row that opens the review panel. */
export function PanelTrigger({ wide, openPanel, t }: PanelTriggerProps): JSX.Element {
  return (
    <button type="button" className={wide ? css.trigger : css.triggerRail} onClick={openPanel}>
      {wide && <span className={css.triggerLabel}>{t('panel.footer.open')}</span>}
      {!wide && <span className={css.triggerRailIcon} aria-hidden>◎</span>}
    </button>
  )
}
