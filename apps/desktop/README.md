# DeepSeek Harness for macOS

English | [中文](README.zh.md)

This package builds the personal-use DeepSeek Harness desktop application for Apple Silicon Macs running macOS 14 or later. It keeps the existing Web UI and starts its private Harness backend on `http://127.0.0.1:<ephemeral-port>`. The [desktop decision](../../.agents/notes/implemented/feature/2026-08-16-macos-desktop-app.md) owns the application boundaries, and the [closed-runtime decision](../../.agents/notes/implemented/architecture/2026-08-17-desktop-closed-runtime-deploy-root.md) owns dependency staging.

## Build

Run the production build from the repository root on an Apple Silicon Mac:

```sh
pnpm run package:desktop
```

The command rejects non-macOS and non-arm64 hosts. It writes the application to `apps/desktop/release/mac-arm64/DeepSeek Harness.app` and the installer to `apps/desktop/release/DeepSeek Harness-0.1.0-rc.5-arm64.dmg`.

## Install and replace

Quit DeepSeek Harness, open the DMG, and copy `DeepSeek Harness.app` to `/Applications`. To install a newer local build, quit the existing application and replace only `/Applications/DeepSeek Harness.app`; application replacement does not remove data under `~/Library/Application Support/DeepSeek Harness`.

This personal build is ad-hoc signed with Hardened Runtime but is not notarized. A quarantined first launch may be blocked by Gatekeeper. In Finder, Control-click the application and choose **Open**, then confirm **Open**; if macOS instead offers **Open Anyway**, use it under **System Settings > Privacy & Security** after the blocked launch. Do not disable Gatekeeper globally.

The application has no updater. Build and replace it manually when updating.

## Data and logs

Electron owns `~/Library/Application Support/DeepSeek Harness`. Window bounds are stored in `window-state.json`, and desktop lifecycle logs are appended to `Logs/desktop.log`. Harness owns the `Harness/` subtree below that directory, including configuration, profiles, and sessions. Replacing the App or DMG leaves this directory unchanged; removing it resets both Desktop and Harness state.

## Verify

The package verifier requires the release App and DMG, validates bundle containment, arm64 Mach-O files, ad-hoc Hardened Runtime signatures and entitlements, then launches copied and mounted applications outside the repository to verify the existing Web UI, single-instance behavior, data persistence, and backend cleanup.

```sh
pnpm run test:desktop
pnpm run build:desktop
pnpm --filter @deepseek-ai/dsh-desktop run verify:package
codesign --verify --deep --strict "apps/desktop/release/mac-arm64/DeepSeek Harness.app"
spctl --assess --type execute --verbose=4 "apps/desktop/release/mac-arm64/DeepSeek Harness.app"
```

The `spctl` command is expected to reject this intentionally unnotarized personal build. The other commands must succeed.
