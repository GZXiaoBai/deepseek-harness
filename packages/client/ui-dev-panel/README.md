# @deepseek-ai/dsh-client-ui-dev-panel

English | [中文](README.zh.md)

In-app review panel for the DeepSeek Harness Web UI: a sidebar footer trigger and a details-column panel with three tabs.

- **Files** — browse the session workspace directory tree; click a text file to preview it (read-only, 512 KiB bound).
- **History** — list the session's user and assistant messages with their first-line summaries.
- **Git** — show `git status --porcelain` rows; click a changed file to view its diff (read-only).

The panel is enabled by default in the standard web profile. Data arrives through the session standard kit (workspace root, conversation nodes) and the host routes served by [`@deepseek-ai/dsh-host-dev-panel`](../../host/dev-panel/README.md). The trigger row registers into the `sidebar.footer.action` list slot and opens the details column; the panel body registers into `conversation.details.devpanel`, the second tab of the details column that ui-conversation owns.

## Config

None.

## Model Experience

None: the panel renders session, workspace, and git state in the browser and never reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **History rows do not jump to the conversation** — scrolling the chat to a selected message needs conversation-internal scroll plumbing; the list is display-only for now.
- **Files preview is text-only** — image and binary previews are out of scope.
- **No write operations** — the panel reviews; edits stay in the agent tools.
