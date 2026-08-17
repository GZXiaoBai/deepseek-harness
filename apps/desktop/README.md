# DeepSeek Harness for macOS

English | [中文](README.zh.md)

This package builds the personal-use DeepSeek Harness desktop application for Apple Silicon Macs running macOS 14 or later. It keeps the existing Web UI and starts its private Harness backend on `http://127.0.0.1:<ephemeral-port>`. The [desktop decision](../../.agents/notes/implemented/feature/2026-08-16-macos-desktop-app.md) owns the application boundaries, and the [closed-runtime decision](../../.agents/notes/implemented/architecture/2026-08-17-desktop-closed-runtime-deploy-root.md) owns dependency staging.

## Build

Run the production build from the repository root on an Apple Silicon Mac:

```sh
pnpm run package:desktop
```

The command rejects non-macOS and non-arm64 hosts. It writes the application to `apps/desktop/release/mac-arm64/DeepSeek Harness.app` and the installer to `apps/desktop/release/DeepSeek Harness-<version>-arm64.dmg`; `apps/desktop/package.json` is the version source.

## Install and replace

Quit DeepSeek Harness, open the DMG, and copy `DeepSeek Harness.app` to `/Applications`. To install a newer local build, quit the existing application and replace only `/Applications/DeepSeek Harness.app`; application replacement does not remove data under `~/Library/Application Support/DeepSeek Harness`.

This personal build is ad-hoc signed with Hardened Runtime but is not notarized. A quarantined first launch may be blocked by Gatekeeper. First try to open the application; after macOS blocks it, open **System Settings > Privacy & Security**, click **Open Anyway**, then confirm **Open**. Follow Apple's [Open a Mac app from an unknown developer](https://support.apple.com/guide/mac-help/mh40616/mac) guide for current recovery steps. Do not disable Gatekeeper globally.

The application has no updater. Build and replace it manually when updating.

## Data and logs

Electron owns `~/Library/Application Support/DeepSeek Harness`. Window bounds are stored in `window-state.json`, and desktop lifecycle logs are appended to `Logs/desktop.log`. Harness owns the `Harness/` subtree below that directory, including configuration, profiles, and sessions. Replacing the App or DMG leaves this directory unchanged; removing it resets both Desktop and Harness state. If initialization fails before the recovery UI can take over, the app reports the original error, stops an already-created controller, and exits with status 1; a cleanup error is reported separately and cannot leave the primary instance running.

## Verify

The package verifier fully validates the release App, copies it outside the repository, validates the copy again, and launches only that copy. The launch proves the existing Web UI over HTTP, second-instance handoff without a replacement backend, Harness subtree and Web-profile initialization isolated from Electron userData, and backend process-group plus TCP-port cleanup. It separately mounts the DMG and revalidates the mounted App's bundle containment, arm64 Mach-O files, ad-hoc Hardened Runtime signatures, and entitlements without launching it.

```sh
pnpm run test:desktop
pnpm run build:desktop
pnpm --filter @deepseek-ai/dsh-desktop run verify:package
codesign --verify --deep --strict "apps/desktop/release/mac-arm64/DeepSeek Harness.app"
spctl --assess --type execute --verbose=4 "apps/desktop/release/mac-arm64/DeepSeek Harness.app"
```

The `spctl` command is expected to reject this intentionally unnotarized personal build. The other commands must succeed.
