# Agent Note: Remove the in-app review panel

Status: implemented

English | [中文](2026-08-20-remove-dev-panel.zh.md)

## Problem

The in-app review panel (files / history / git tabs in the details column) shipped in the desktop runtime, but the owner judged the surface not good enough to keep: it replaced the simple tool-details panel with a tabbed container, added two packages to the runtime closure, and its value did not justify the added chrome.

## Decision

The review panel is removed from the standard web and desktop composition:

- `@deepseek-ai/dsh-host-dev-panel` and `@deepseek-ai/dsh-client-ui-dev-panel` are deleted, together with their bundle rows in `packages/bundle/web-app` and the desktop runtime closure entries.
- `ui-conversation` returns to the single tool-details panel: the tabbed `DetailsPanel` (tool/panel tabs) reverts to the upstream single-seat version, and the `conversation.details.devpanel` slot declaration is dropped.
- The archived [in-app review panel note](../../archived/feature/2026-08-18-dev-panel.md) keeps the design record.

The removal also drops the sidebar footer trigger and its locale keys; the runtime closure re-converges (121 direct dependencies, 125 workspace packages) and the client slot catalog regenerates.

## Alternatives considered

**Keep the panel but improve it.** The owner already evaluated the surface and chose removal; improving a surface that failed review is speculative.

## Consequences

The details column is again the plain tool-call panel (one less tab, one less slot seat), the web and desktop payloads shrink by two packages, and the dev-panel note is archived for reference. Any future review surface starts from the archived design record instead of rediscovering the loopback-route and confinement work.
