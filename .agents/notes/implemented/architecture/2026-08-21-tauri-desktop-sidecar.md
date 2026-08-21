# Agent Note: Tauri desktop shell with a single-executable Node sidecar

Status: implemented

English | [中文](2026-08-21-tauri-desktop-sidecar.zh.md)

## Problem

The Electron desktop package installed more than 32,000 files and about 610 MB on Windows. Defender's per-file scanning made a clean install take about 220 seconds, and the bundled Chromium process increased cold-start cost. Preserving the Web composition, native modules, and disk-loaded third-party plugins ruled out replacing the backend with a Rust implementation.

## Decision

Tauri 2 owns the native window, menu, navigation policy, single-instance focus, window state, updater, directory dialog, and backend process supervision. The existing Web UI remains unchanged and receives no Tauri shell, filesystem, or general invoke permissions. The window starts on an embedded script-free page and navigates only after the backend reports an exact `http://127.0.0.1:<port>/` origin; unexpected navigation and every popup are denied, while non-loopback HTTP(S) links open in the system browser.

`@yao-pkg/pkg --sea` packages the Node 24 Web backend, built-in plugins, configuration, and static Web assets in one platform-specific executable. Target-native `node-pty`, ripgrep, and the macOS spawn helper remain ordinary adjacent binaries. The sidecar excludes development sources, source maps, tests, and documentation. A startup module-resolution hook maps packaged Cordis and Harness Service Definition peers to VFS singletons while allowing profile plugins and their private dependencies to resolve from disk; packaged profiles never create links into the VFS. The same host adapter resolves each built-in package manifest from its precomputed VFS root for the client-module scan, while names outside the packaged roster keep the profile-anchored resolver. The desktop launcher derives the shipped Agent-preset root from the packaged `@deepseek-ai/dsh` manifest rather than an imported module's `import.meta.url`, which pkg reports as the SEA entry URL. Preset discovery enumerates child names and stats each path because pkg's VFS does not provide complete Node `Dirent` methods.

The versioned line protocol uses the `DSH_DESKTOP/1 ` prefix on stdout. JSON events report startup phases, readiness, fatal errors, shutdown, and native directory-dialog requests; stdin carries shutdown and dialog results. Output without the prefix is logged as plugin output and cannot become a control message. Directory selection therefore uses the Tauri dialog on both targets and does not execute the Koffi Win32 dialog worker that caused the folder-selection process to exit.

Windows creates the sidecar suspended, attaches it to a Job Object with `KILL_ON_JOB_CLOSE`, and then resumes it. macOS assigns an owned POSIX process group. Normal close sends `shutdown`, waits for Harness disposal and `stopped`, and records a forced-termination counter; the operating-system process owner is only used after timeout. Desktop logs rotate, and performance data records process start, sidecar spawn, plugin-tree readiness, HTTP readiness, page load, shutdown, and forced termination.

Automatic update checks start once after the first Harness page finishes loading, so external network latency does not compete with the measured startup path. Manual update checks remain available immediately from the Harness menu.

Tauri's NSIS package installs for the current user without elevation, uses the Windows 11 system WebView2, creates only a Start Menu shortcut, and preserves `%APPDATA%\DeepSeek Harness` on uninstall. The macOS package is Apple Silicon-only, ad-hoc signed with Hardened Runtime, and not notarized. Both targets reuse the Electron data directories and settings. Tauri updater artifacts are signed with a dedicated minisign key; the public key ships in configuration and the private key exists only in release secrets. Application code signing remains independent and the personal Windows build remains unsigned.

The Electron implementation remains available until Windows Server 2025 CI and a real Windows 11 x64 machine pass the same installation, directory-selection, startup, and shutdown acceptance. Its [macOS](../feature/2026-08-16-macos-desktop-app.md), [Windows](../feature/2026-08-17-windows-desktop-app.md), [updater](../feature/2026-08-18-desktop-updater.md), and [closed-runtime](2026-08-17-desktop-closed-runtime-deploy-root.md) decisions document the fallback that is removed after parity is established.

## Alternatives considered

**Optimize the Electron dependency tree further.** Rejected because the complete Node runtime still produced tens of thousands of files and bundled Chromium; Defender installation cost came from the payload structure, not only its compressed bytes.

**Rewrite the Harness backend in Rust.** Rejected because it would duplicate the plugin host, Cordis lifecycle, Node native modules, and third-party plugin ecosystem instead of preserving the existing application.

**Extract a multi-file Node deployment beside Tauri.** Rejected because it keeps the Windows per-file scanning bottleneck and reintroduces link and dependency-closure installation problems that the single executable removes.

**Expose Tauri commands directly to the remote Web UI.** Rejected because the loopback page is a network origin; privileged filesystem and shell access stays behind existing Harness RPC capabilities and the narrow sidecar dialog protocol.

## Consequences

The installed application has a few ordinary target-native files instead of a Node dependency tree or Chromium distribution. On the measured Apple Silicon package, the App contains seven files and 238,907,293 bytes; a clean packaged launch reaches page load in 1.8 seconds and closes without forced termination. Windows retains native CI limits of 500 files, 250 MB, 60 seconds for install, and 10 seconds for first page load; the release limit remains 30 seconds for install, 6 seconds for cold start, and 3 seconds for warm start on real Windows 11 with Defender enabled and no exclusions.

The sidecar build depends on pkg's VFS behavior and an explicit packaged-module manifest. Real feasibility probes execute node-pty, a worker thread, Koffi, Web startup, an external disk plugin with packaged peers, and graceful shutdown before native packaging. Package verification audits target architectures, link containment, signatures, data isolation, single-instance behavior, directory selection, process cleanup, and updater tamper rejection. Startup acceptance parses the served `__DSH_BOOT__` graph, rejects an empty graph, requires parser preloads for client-modules and client-runtime, and fetches both bundles successfully. It then calls the packaged `agentPreset.list`, creates a workspace whose path contains Chinese characters and a space, and creates a session with the shipped `standard` preset. A WebView load event alone is insufficient because the kernel can render a plugin-failure page or a shell whose first session cannot be composed. Server 2025 results do not substitute for the real Windows 11 release check.
