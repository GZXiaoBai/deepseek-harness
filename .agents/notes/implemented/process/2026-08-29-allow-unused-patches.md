# Agent Note: Allow unused patches for deploy subsets

Status: implemented

English | [中文](2026-08-29-allow-unused-patches.zh.md)

## Problem

`pnpm deploy --legacy --prod` of the Python runtime closure fails with `ERR_PNPM_UNUSED_PATCH` on every release-shaped CI platform: the workspace-level `@electron/osx-sign@1.3.3` patch is consumed only by the desktop package's Electron packaging devDependencies, so the closure's production dependency subset never matches the patch key. The closure deploy is structurally incapable of using that patch, while the workspace install uses both patches every time.

## Decision

`pnpm-workspace.yaml` sets `allowUnusedPatches: true`, so a patch whose target is absent from the current install or deploy subset warns instead of failing the command. Patches still apply wherever their target exists — the deployed closure keeps the patched `node-pty` build (verified by the `DSH_NODE_PTY_SPAWN_HELPER` marker surviving in the deployed tree).

## Alternatives

- Removing the osx-sign patch: rejected; the desktop Electron mac packaging still needs the bounded binary inspection until the Tauri implementation fully retires the Electron path.
- Dropping `--legacy` deploy: rejected; the Python runtime packaging owns hoisting, link-materialization, and symlink-free payload invariants built on the legacy deploy implementation.
- Copying `electron-builder` into the closure: rejected; the packaged Python runtime must not carry the desktop build toolchain.

## Consequences

A genuinely stale patch — for example a future `node-pty` version bump without updating the patch key — now only warns during install and deploy. The lockfile pins each patched package by patch hash, and CI rebuilds the `node-pty` addon from source, so a silently unpatched build surfaces in the packaging steps that depend on the patched behavior rather than at dependency resolution.
