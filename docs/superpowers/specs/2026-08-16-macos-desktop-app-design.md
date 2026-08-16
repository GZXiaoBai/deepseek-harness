# macOS Desktop App Design

English | [中文](2026-08-16-macos-desktop-app-design.zh.md)

## Scope

This design adds a standalone DeepSeek Harness desktop app for Apple Silicon and macOS 14 or later. The first version is for personal use, retains the existing Web UI, and excludes Intel builds, Apple notarization, automatic updates, and a native UI rewrite.

The deliverables are a directly runnable `DeepSeek Harness.app` and an Apple Silicon DMG that users can drag into Applications. The app must include Electron, the built `dsh` CLI, the Web frontend, and all production runtime dependencies; it must not depend on the source checkout or system installations of Node.js, npm, or pnpm.

## Project location

The desktop app lives in `apps/desktop` as a separate Electron package in the pnpm workspace. This package owns only the desktop process, window, packaging configuration, icon, and desktop lifecycle tests; the existing `apps/web` continues to own the browser UI, and `apps/cli` continues to own the Harness launch entry point.

The desktop app does not copy or fork the Web UI. The build first produces the repository's Host, Client, and Web artifacts, then creates a production-only deployable runtime directory for `@deepseek-ai/dsh` and places that directory in the App bundle as an unpacked resource so child processes and native modules load from real filesystem paths.

## Runtime architecture

The Electron main process acquires the single-instance lock; a second launch only activates the existing window. The app does not introduce a second product renderer or preload API; the `BrowserWindow` first displays a script-free local static startup document, then loads the loopback HTTP address served by Harness.

The main process uses the Electron executable inside the App bundle to start a separate child process and sets `ELECTRON_RUN_AS_NODE=1`, causing that process to execute the packaged `dsh` CLI. The fixed arguments are `web --host 127.0.0.1 --port 0`, which lets the operating system allocate an unused port and allows the desktop app to coexist with the source version's default `3080` service.

The main process accepts only an address matching `dsh web: http://127.0.0.1:<port>` from the child process output, then confirms that the home page is reachable with an HTTP request. After confirmation, the window loads that address and leaves the startup state; a startup timeout, early child exit, or failed health check enters a recoverable error state.

The first version treats the Electron window as a local client of the existing browser HTTP carrier and does not implement the `file://` plus IPC transport. The implementation must update the Web server subsystem documentation and record the responsibility split between this desktop wrapper and a full Electron IPC host in an Agent Note so the two runtime architectures do not share one ambiguous Electron rule.

## Data and launch environment

The desktop child process fixes `DSH_HOME` at `~/Library/Application Support/DeepSeek Harness`. Existing Harness services store profiles, settings, credentials, sessions, and other persistent data in that directory; replacing the App bundle does not change it.

When launched from Finder, the desktop main process supplements only `PATH` from the user's login shell and imports no other shell environment variables. The child process inherits the corrected `PATH` and the Electron process's existing environment, while the desktop main process overrides `DSH_HOME`, `ELECTRON_RUN_AS_NODE`, and internal variables required for desktop startup. API Keys managed by the Web UI remain in the Harness credential service; the desktop layer neither reads nor logs them.

Desktop logs are written to `~/Library/Application Support/DeepSeek Harness/Logs`. Logs include the main process lifecycle, child standard output and standard error, startup address parsing results, and exit status, but must not emit credential file contents or environment variable values.

## Window and security

The main window uses the complete existing Web UI, has a default size of at least `1100 × 720`, and records the user's last window position and size. The app creates a macOS `.icns` from the existing Harness icon, and its menu provides reload, open logs directory, and quit actions.

The `BrowserWindow` enables context isolation and the Chromium sandbox, disables Node.js integration for web content, and exposes no preload bridge. The main window permits navigation only within the loopback origin confirmed at startup; external HTTP or HTTPS links open in the system default browser, while `file:`, custom schemes, new-window requests, and all other navigation are denied.

## Lifecycle and failure handling

When the last window closes or the user chooses Quit, the main process first sends a graceful termination signal to the Harness child process it owns and waits for up to five seconds. If the child does not exit within that deadline, the main process terminates its process tree; the desktop app must not stop any `dsh` process it did not start or any other process using port `3080`.

On startup failure, the window displays a script-free local static error document and an Electron native dialog provides Retry, Open Logs Directory, and Quit actions. Retry must clean up any child process left by the failed attempt before creating a new dynamic-port child process. If the child exits unexpectedly at runtime, the window switches to the same error document instead of retaining a browser connection error page.

## Packaging and distribution

Electron Builder produces the `darwin-arm64` App and DMG. The build uses ad-hoc signing and commits no developer certificate; locally generated artifacts are suitable for personal use, while macOS Gatekeeper may require the first launch of a network-transferred copy to use Open from its context menu.

The first version has no update service. Updating means rebuilding or replacing `/Applications/DeepSeek Harness.app`, while persistent data continues to load from the Application Support directory.

## Verification

Desktop unit tests cover Harness URL parsing, allowed-navigation decisions, single-instance handoff, startup timeout, and child process exit states. Process lifecycle tests use a controllable fake CLI to verify cleanup before retry, forced termination after five seconds, and termination of only the owned process tree.

Packaged acceptance testing starts the built App in an environment without repository Node.js paths and confirms that it allocates a loopback port, returns the Harness home page, displays the existing Web UI, focuses on a second launch, persists settings, and releases the port without leaving a Harness child process after the last window closes. The test also copies the App bundle outside the repository before launching it to prove that the artifact does not depend on the source checkout.

## Completion criteria

- An Apple Silicon Mac can launch DeepSeek Harness from the App or DMG without separately installing Node.js, npm, or pnpm.
- The App displays the same Web UI as the browser version and supports the existing model settings, workspaces, sessions, and tool capabilities.
- Application data resides in the standard Application Support directory and remains usable after replacing the App.
- Repeated launches do not create a second Harness backend, and quitting leaves no background process created by the App.
- The built App passes standalone launch acceptance outside the source repository.
