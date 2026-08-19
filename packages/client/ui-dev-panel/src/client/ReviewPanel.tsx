/**
 * Review panel body: Files, History, and Git tabs fed by the loopback host
 * routes. Pure presentation — every data access arrives through the session
 * standard kit (workspace root, conversation nodes) or the injected host
 * route caller.
 */
import { useMemo, useState, type JSX } from 'react'
import type { ReviewPanelProps } from './contract/slots.ts'
import css from './ReviewPanel.module.css'

type TabId = 'files' | 'history' | 'vcs'

/** Extracts the text payload of one content block. */
function blockText(block: { kind: string; text?: unknown }): string {
  return block.kind === 'text' && typeof block.text === 'string' ? block.text : ''
}

/** Renders the first non-empty text line of a message row. */
function messageSummary(content: readonly { kind: string; text?: unknown }[]): string {
  for (const block of content) {
    const text = blockText(block).trim()
    if (text !== '') return text.split('\n')[0] ?? ''
  }
  return ''
}

export function ReviewPanel({ useSession, useSessions, sessionId, callPanel, t }: ReviewPanelProps) {
  const [tab, setTab] = useState<TabId>('files')
  const workspaceRoot = useSessions(list => list.byId[sessionId]?.cwd)

  const history = useSession(s => s.chat.legacy.nodes)
  const messages = useMemo(
    () => history
      .filter((node): node is Extract<typeof node, { kind: 'user' | 'assistant' }> => node.kind === 'user' || node.kind === 'assistant')
      .map(node => ({
        key: String(node.seq),
        kind: node.kind,
        text: messageSummary(
          (node.kind === 'user' ? node.content : node.blocks) as unknown as readonly { kind: string; text?: unknown }[],
        ),
      })),
    [history],
  )

  return (
    <div className={css.root}>
      <div className={css.tabs}>
        {(['files', 'history', 'vcs'] as const).map(id => (
          <button
            key={id} type="button" className={tab === id ? css.tabActive : css.tab}
            onClick={() => { setTab(id) }}
          >
            {t(`panel.tabs.${id}`)}
          </button>
        ))}
      </div>
      <div className={css.body}>
        {tab === 'files' && (
          <FilesTab
            root={workspaceRoot ?? ''} callPanel={callPanel}
            emptyLabel={t('panel.files.empty')} previewLabel={t('panel.files.preview')}
            previewCloseLabel={t('panel.files.previewClose')} previewErrorLabel={t('panel.files.previewError')}
          />
        )}
        {tab === 'history' && (
          messages.length === 0
            ? <div className={css.empty}>{t('panel.history.empty')}</div>
            : (
              <ul className={css.history}>
                {messages.map(message => (
                  <li key={message.key} className={message.kind === 'user' ? css.userRow : css.assistantRow}>
                    <span className={css.rowKind}>{message.kind === 'user' ? 'User' : 'Assistant'}</span>
                    <span className={css.rowText}>{message.text}</span>
                  </li>
                ))}
              </ul>
            )
        )}
        {tab === 'vcs' && <VcsTab root={workspaceRoot ?? ''} callPanel={callPanel} t={t} />}
      </div>
    </div>
  )
}

/** Files tab: directory tree navigation plus read-only preview. */
function FilesTab(props: {
  root: string
  callPanel: ReviewPanelProps['callPanel']
  emptyLabel: string
  previewLabel: string
  previewCloseLabel: string
  previewErrorLabel: string
}): JSX.Element {
  const [directory, setDirectory] = useState('')
  const [entries, setEntries] = useState<Array<{ name: string; type: 'file' | 'directory'; size: number }>>([])
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null)

  const navigate = async (path: string): Promise<void> => {
    setPreview(null)
    if (props.root === '') return
    const response = await props.callPanel('/dev-panel.list-files', { root: props.root, path })
    if (!response.ok) {
      setError(response.error)
      return
    }
    setError(null)
    setDirectory(path)
    if ('entries' in response) setEntries(response.entries)
  }

  const openPreview = async (name: string): Promise<void> => {
    const path = directory === '' ? name : `${directory}/${name}`
    const response = await props.callPanel('/dev-panel.read-file', { root: props.root, path })
    if (!response.ok || !('content' in response)) {
      setError(props.previewErrorLabel)
      return
    }
    setPreview({ path, content: response.content })
  }

  return (
    <div className={css.files}>
      <div className={css.breadcrumb}>
        <button type="button" className={css.crumb} onClick={() => { void navigate('') }}>.</button>
        {directory !== '' && (
          <button type="button" className={css.crumb} onClick={() => { void navigate('') }}>
            /{directory}
          </button>
        )}
      </div>
      {error !== null && <div className={css.error}>{error}</div>}
      {entries.length === 0 && error === null && <div className={css.empty}>{props.emptyLabel}</div>}
      <ul className={css.entries}>
        {entries.map(entry => (
          <li key={entry.name}>
            <button
              type="button"
              className={css.entry}
              onClick={() => {
                if (entry.type === 'directory') void navigate(directory === '' ? entry.name : `${directory}/${entry.name}`)
                else void openPreview(entry.name)
              }}
            >
              <span className={entry.type === 'directory' ? css.dirIcon : css.fileIcon}>
                {entry.type === 'directory' ? '▸' : ''}
              </span>
              <span className={css.entryName}>{entry.name}</span>
              {entry.type === 'file' && <span className={css.entrySize}>{entry.size}</span>}
            </button>
          </li>
        ))}
      </ul>
      {preview !== null && (
        <div className={css.preview}>
          <div className={css.previewHeader}>
            <span>{props.previewLabel}: {preview.path}</span>
            <button type="button" className={css.previewClose} onClick={() => { setPreview(null) }}>
              {props.previewCloseLabel}
            </button>
          </div>
          <pre className={css.previewContent}>{preview.content}</pre>
        </div>
      )}
    </div>
  )
}

/** Git tab: porcelain status rows with per-file diff preview. */
function VcsTab(props: {
  root: string
  callPanel: ReviewPanelProps['callPanel']
  t: ReviewPanelProps['t']
}): JSX.Element {
  const [status, setStatus] = useState<string>('')
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    if (props.root === '') return
    const response = await props.callPanel('/dev-panel.git-status', { root: props.root })
    if (!response.ok) {
      setError(response.error)
      return
    }
    setError(null)
    if ('status' in response) setStatus(response.status)
  }

  const showDiff = async (path: string): Promise<void> => {
    const response = await props.callPanel('/dev-panel.git-diff', { root: props.root, file: path })
    setSelected(path)
    setDiff(!response.ok || !('diff' in response) ? '' : response.diff)
  }

  const rows = useMemo(
    () => status.split('\n').map(line => line.trim()).filter(line => line !== '')
      .map(line => ({ code: line.slice(0, 2), path: line.slice(3) })),
    [status],
  )

  return (
    <div className={css.vcs}>
      <button type="button" className={css.refresh} onClick={() => { void refresh() }}>Refresh</button>
      {error !== null && <div className={css.error}>{error}</div>}
      {rows.length === 0 && error === null && <div className={css.empty}>{props.t('panel.vcs.empty')}</div>}
      <ul className={css.status}>
        {rows.map(row => (
          <li key={row.path}>
            <button type="button" className={css.statusRow} onClick={() => { void showDiff(row.path) }}>
              <span className={css.statusCode}>{row.code}</span>
              <span className={css.entryName}>{row.path}</span>
            </button>
          </li>
        ))}
      </ul>
      {selected !== null && (
        <div className={css.preview}>
          <div className={css.previewHeader}>
            <span>{props.t('panel.vcs.diff')}: {selected}</span>
          </div>
          <pre className={css.previewContent}>{diff}</pre>
        </div>
      )}
    </div>
  )
}
