# Agent Note: Run the office engine outside the embedded runtime

Status: implemented

English | [中文](2026-09-18-desktop-office-engine-outside-the-embedded-runtime.zh.md)

## Problem

The [Tauri and sidecar decision](2026-08-21-tauri-desktop-sidecar.md) owns the embedded runtime and its adjacency rules; this note extends it with the package staging office conversion requires.

The Web profile mounts `@deepseek-ai/dsh-office-to-pdf`, which converts documents through `@deepseek-ai/libreoffice-kit`. The kit resolves its platform engine package at call time and starts the engine as a child process. A packaged sidecar holds its runtime in an embedded filesystem that serves module resolution only for the package roster injected at build time, and no engine executable can start from an embedded file. Embedding the engine also duplicated about 260 MB inside an executable whose verification budgets cover the whole package.

## Decision

The sidecar build stages the kit API, its platform engine, and every installed production dependency between them into `apps/desktop/src-tauri/resources/libreoffice/node_modules/` and writes `staged-packages.json` beside them. The shell passes that directory as `DSH_DESKTOP_REAL_PACKAGES_ROOT`, and the sidecar's resolve hook serves the recorded package entries and subpaths from the real filesystem ahead of the embedded runtime, so the kit's own engine lookup resolves against the sibling engine package. Both packages leave the staged runtime before the executable is assembled, so the embedded roster no longer claims them and the engine is stored once. Packaged file-count and byte budgets cover the staged engine for both targets.

## Alternatives considered

**Embed the engine in the executable.** The engine executable cannot start from an embedded file, and the duplicate copy doubled the packaged payload.

**Resolve engine packages through the harness closed-runtime resolver.** That resolver serves Cordis plugin imports inside the mounted profile tree and cannot answer a `require.resolve` performed by an installed npm package.

## Consequences

The office conversion path is exercised only after the shell starts the sidecar, so the standalone SEA feasibility probe never loads it. A missing or unsupported engine package now fails the sidecar build instead of the packaged application's first conversion.
