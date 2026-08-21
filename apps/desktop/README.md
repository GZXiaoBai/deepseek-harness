# DeepSeek Harness Desktop

English | [中文](README.zh.md)

This package builds the personal-use DeepSeek Harness desktop application with Tauri 2 for Apple Silicon Macs running macOS 14 or later and Windows 11 x64 PCs. The native shell preserves the Web UI and runs the Harness Web backend as a Node 24 single-executable sidecar on a private `http://127.0.0.1:<ephemeral-port>/` origin. The [Tauri and sidecar decision](../../.agents/notes/implemented/architecture/2026-08-21-tauri-desktop-sidecar.md) owns the runtime split; the Electron [macOS](../../.agents/notes/implemented/feature/2026-08-16-macos-desktop-app.md), [Windows](../../.agents/notes/implemented/feature/2026-08-17-windows-desktop-app.md), and [closed-runtime](../../.agents/notes/implemented/architecture/2026-08-17-desktop-closed-runtime-deploy-root.md) records remain relevant while the fallback implementation is retained for final Windows acceptance.

## Supported targets and build

`pnpm run package:desktop:tauri` builds only the current host's native target. Run it from the repository root on an Apple Silicon Mac or Windows 11 x64 machine. Cross-packaging, Wine, Intel Macs, Windows ARM64, MSIX, Windows Authenticode signing, Apple Developer ID signing, and notarization are unsupported.

| Host | Output |
| --- | --- |
| macOS 14+ on Apple Silicon | `apps/desktop/release-tauri/DeepSeek Harness.app` and `DeepSeek Harness-<version>-arm64.dmg` |
| Windows 11 x64 | `apps/desktop/release-tauri/win-unpacked` and `DeepSeek Harness Setup <version>-x64.exe` |

The sidecar embeds the Web backend, built-in plugins, and Web assets in its VFS. Target-specific `node-pty`, ripgrep, and process helpers remain ordinary sidecar files. The package contains no development TypeScript, source maps, tests, or documentation. A third-party plugin stays on disk below the user's Harness profile and may load its private dependencies while sharing the packaged Cordis and Harness Service Definition instances.

## Install and update

On macOS, open the DMG and copy `DeepSeek Harness.app` to `/Applications`. The personal build is ad-hoc signed with Hardened Runtime but is not notarized. If Gatekeeper blocks the first launch, follow Apple's [Open a Mac app from an unknown developer](https://support.apple.com/guide/mac-help/mh40616/mac) instructions; do not disable Gatekeeper globally.

On Windows, run `DeepSeek Harness Setup <version>-x64.exe`. The one-click NSIS installer installs for the current user without elevation, creates a Start Menu shortcut, creates no Desktop shortcut, and does not launch after installation. It uses the system WebView2 runtime included with Windows 11 and does not require Developer Mode. The personal build is intentionally unsigned, so SmartScreen may warn until the file gains reputation. Continue only after verifying the installer came from the expected release; do not disable Defender or SmartScreen. See Microsoft's [SmartScreen reputation guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

The Harness menu can check for updates or toggle automatic checks. A release publishes the NSIS installer, macOS updater archive, `.sig` files, `latest.json`, DMG, and SHA-256 files. Tauri verifies every update with the public key embedded in `tauri.conf.json`; the signing private key exists only in release secrets. An unsigned or modified update is rejected independently of operating-system code signing.

## Data and logs

The application reuses the existing data locations:

- macOS: `~/Library/Application Support/DeepSeek Harness`
- Windows: `%APPDATA%\DeepSeek Harness`

Harness data lives in `Harness/`, desktop logs rotate below `Logs/desktop.log`, performance timings are recorded in `Logs/desktop-performance.json`, and settings remain in `desktop-settings.json`. Replacing or uninstalling the application preserves this directory. Removing it resets both Desktop and Harness state.

The shell displays its embedded startup page immediately, accepts only the sidecar's exact loopback origin, denies popups and unexpected top-level navigation, and exposes no Tauri shell, filesystem, or general invoke API to the Web UI. A second launch focuses the existing window. Closing sends a protocol-level shutdown request and waits for Harness disposal; Windows Job Object and macOS process-group termination are timeout fallbacks.

## Verify

Run behavior and Rust tests on either host, then build and verify the native package on the target host:

```sh
pnpm run test:desktop
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm run package:desktop:tauri
pnpm --filter @deepseek-ai/dsh-desktop run verify:tauri:macos
# Windows: pnpm --filter @deepseek-ai/dsh-desktop run verify:tauri:windows
```

The Windows Server 2025 workflow verifies silent current-user install and uninstall, shortcut placement, zero reparse points, x64 PE payloads, expected unsigned binaries, strict loopback startup, profile initialization, single-instance ownership, shutdown cleanup, retained data, file and byte limits, and CI timing limits. Protocol tests preserve Unicode paths with spaces, and the release workflow proves that the original updater artifact verifies while a one-byte modification fails. Before release, run the same installer acceptance and select a Unicode path with spaces on a real Windows 11 x64 PC with Defender enabled and no exclusions; Server 2025 is not Windows 11 evidence.
