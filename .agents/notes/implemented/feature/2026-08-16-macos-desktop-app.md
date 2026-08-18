# Agent Note: Introduce a macOS desktop wrapper

Status: implemented

English | [中文](2026-08-16-macos-desktop-app.zh.md)

## Problem

DeepSeek Harness presents its browser interface through the Host/Web composition. macOS users who want an application bundle need a native launcher without duplicating host composition, static-asset serving, browser protocol handling, or the existing Web UI.

## Decision

`@deepseek-ai/dsh-desktop` is an Electron wrapper for Apple Silicon Macs running macOS 14 or later. It starts the staged `@deepseek-ai/dsh` CLI as one detached backend process with fixed `web --host 127.0.0.1 --port 0` arguments, waits for its strict loopback URL and HTTP health response, then opens that same origin in the application window. `@deepseek-ai/dsh-host-webserver` retains HTTP serving, API routing, frontend delivery, and browser-visible startup responsibilities under the [GUI layering decision](../architecture/2026-07-19-gui-layering-and-rpc-protocol.md).

The [Windows desktop decision](2026-08-17-windows-desktop-app.md) reuses this wrapper and its Web, renderer, navigation, data-separation, and single-instance boundaries while replacing only target-specific process-tree, staging, binary-audit, and installer behavior.

A `file://` application with an IPC-backed host remains a separate architecture. It must replace the HTTP server's asset, request, lifecycle, and security responsibilities before it can replace loopback HTTP; the two transports are not aliases.

## Security and runtime boundaries

The renderer has context isolation and sandboxing enabled, with Node integration disabled and no preload API. The exact bundled, script-free startup and error documents are the only `file://` top-level exceptions. Harness content stays on the confirmed `http://127.0.0.1:<ephemeral-port>` origin: same-origin navigation is allowed, other HTTP and HTTPS destinations open externally, and every other scheme or malformed URL is denied. The login shell contributes only `PATH`; its other environment values are neither imported nor logged.

The Desktop app owns only the detached process group it creates. Quit, retry, application signals, and unexpected exits share one shutdown barrier: the owned group receives `SIGTERM`, gets five seconds to exit, then receives `SIGKILL` if necessary. The application neither discovers nor signals unrelated Harness processes.

The packaged backend uses the private, verified dependency deployment described by the [closed-runtime decision](../architecture/2026-08-17-desktop-closed-runtime-deploy-root.md). Packaging is fixed to `darwin-arm64`, rejects every other host target, audits all Mach-O files as arm64, prunes sources and source maps from the staged runtime, and copies the contained runtime into the App before signing. Every shipped code object is ad-hoc signed with Hardened Runtime; native modules receive only the reviewed JIT, unsigned-executable-memory, and library-validation entitlements. The personal build is not notarized and has no updater.

## Data and lifecycle boundaries

Electron owns `~/Library/Application Support/DeepSeek Harness`, including `window-state.json`, `Logs/desktop.log`, and its singleton files. The backend receives `DSH_HOME` as the separate `Harness/` subtree so Harness file watchers never observe Electron's singleton socket. Replacing the App leaves both Desktop and Harness data intact.

The application enforces one Electron instance and one backend. A second launch focuses the existing window without starting another backend. Recoverable startup failure stays in a script-free local document and offers retry, log-directory access, or quit. The original fatal initialization or controller-start failure is recorded first; when a controller exists, the application attempts and awaits its shutdown. Cleanup failure is reported separately and means backend termination is not guaranteed. Electron still exits with status 1 and releases the single-instance lock.

## Verification

Behavior tests pin URL parsing and navigation, renderer preferences, single-instance startup, retry, process-group ownership, shutdown races, data-root separation, runtime closure, staging containment, arm64 binaries, and package configuration. Real package acceptance fully validates the release App, copies it outside the repository, revalidates the copy, and launches only that copy. The launch verifies the existing Web UI over HTTP, unchanged backend identity after a second launch, Harness subtree and Web-profile initialization isolated from Electron userData, and the closed TCP port and process group after quit. The mounted DMG App receives the complete static bundle-containment, arm64, signature, and entitlement validation but is not launched.

## Alternatives considered

**Load the web frontend with `file://` immediately.** This removes a local listener, but it requires new IPC APIs and a secure asset-loading model while changing the established Host/Web request path. The desktop wrapper keeps that path intact.

**Embed Host/Web logic directly in Electron.** This would make Electron own composition and startup behavior already owned by `@deepseek-ai/dsh-host-webserver`, creating two implementations to keep aligned.

## Consequences

The application preserves the existing Web UI and Host/Web behavior in a self-contained App and DMG, while the loopback listener, backend lifecycle, closed runtime, and macOS signing become Desktop-owned responsibilities. Distribution remains deliberately personal: Gatekeeper may require an explicit first-launch override because the ad-hoc build is not notarized, and updates require rebuilding and replacing the App. An Electron-native IPC host remains possible, but it requires a new transport decision rather than an incremental reinterpretation of this one.
