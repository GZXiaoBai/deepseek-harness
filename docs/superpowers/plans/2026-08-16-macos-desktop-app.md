# macOS Desktop App Implementation Plan

English | [中文](2026-08-16-macos-desktop-app.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a self-contained, personal-use `DeepSeek Harness.app` and DMG for Apple Silicon Macs running macOS 14 or later, while preserving the existing Web UI.

**Architecture:** A sandboxed Electron main process owns one detached Harness child process. The child runs the staged `@deepseek-ai/dsh` CLI through Electron's embedded Node runtime, binds to a dynamic loopback port, and serves the existing Web UI. Packaging stages the full production dependency closure outside `app.asar`, rebuilds native modules for Electron arm64, and produces an ad-hoc-signed App and DMG.

**Tech Stack:** TypeScript 6, Electron 43.4.0, Electron Builder 26.15.3, `@electron/rebuild` 4.2.0, pnpm deploy, Vitest, macOS `iconutil`, `codesign`, and `hdiutil`.

## Global Constraints

- Support only `darwin-arm64` and macOS 14 or later; reject packaging on other platforms or architectures.
- Keep the existing React Web UI unchanged; do not add a renderer fork or preload API.
- Use only the confirmed `http://127.0.0.1:<dynamic-port>` origin inside the main window.
- Store Harness state and desktop logs under `app.getPath('userData')`, which resolves to `~/Library/Application Support/DeepSeek Harness` in production.
- Import only `PATH` from the login shell. Never copy or log the rest of the shell environment.
- Stop only the detached process group created by the desktop app. Graceful shutdown gets five seconds before `SIGKILL`.
- Every behavioral change starts with a failing test. Commit after each task passes its focused checks.
- Keep English and Chinese documentation paired, with byte-identical fenced code blocks and refreshed `.i18n.yaml` records.

---

### Task 1: Register the desktop package and decision record

**Files:**

- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/tsdown.config.ts`
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `scripts/check-workspace-constraints.ts`
- Create: `scripts/check-workspace-constraints.spec.ts`
- Modify: `tsconfig.host.json`
- Create: `.agents/notes/proposed/feature/2026-08-16-macos-desktop-app.md`
- Create: `.agents/notes/proposed/feature/2026-08-16-macos-desktop-app.zh.md`
- Create: `.agents/notes/proposed/feature/2026-08-16-macos-desktop-app.i18n.yaml`

- [ ] **Step 1: Write the failing workspace policy test**

Add an assertion to `scripts/check-workspace-constraints.spec.ts` that loads `apps/desktop/package.json` and expects a release-family version, public repository metadata, and this exact package file policy:

```ts ignore-check
expect(appPackageFiles['@deepseek-ai/dsh-desktop']).toEqual([
  'lib/*.js',
  'static',
  'build',
])
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `pnpm exec vitest run scripts/check-workspace-constraints.spec.ts`

Expected: FAIL because `@deepseek-ai/dsh-desktop` and its file policy do not exist.

- [ ] **Step 3: Add the package scaffold and root commands**

Create the manifest with the repository's current release-family version and exact desktop dependencies:

```json
{
  "name": "@deepseek-ai/dsh-desktop",
  "version": "0.1.0-rc.5",
  "description": "Apple Silicon macOS desktop wrapper for DeepSeek Harness",
  "publishConfig": { "access": "public" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/deepseek-ai/deepseek-harness.git",
    "directory": "apps/desktop"
  },
  "type": "module",
  "main": "lib/main.js",
  "files": ["lib/*.js", "static", "build"],
  "scripts": {
    "build": "tsc -p tsconfig.json && tsdown --config tsdown.config.ts",
    "test": "vitest run tests",
    "stage": "node scripts/stage-runtime.mjs",
    "package": "node scripts/package.mjs"
  },
  "license": "MIT",
  "dependencies": { "shell-path": "3.1.0" },
  "devDependencies": {
    "@electron/rebuild": "4.2.0",
    "@types/node": "^22.20.0",
    "electron": "43.4.0",
    "electron-builder": "26.15.3",
    "sharp": "^0.35.3",
    "tsdown": "^0.22.2",
    "typescript": "^6.0.3",
    "vitest": "^4.1.8"
  }
}
```

Add root commands `build:desktop`, `test:desktop`, and `package:desktop`; add the desktop source and tests to `tsconfig.host.json`; add the package to `appPackageFiles`; and explicitly allow Electron's reviewed install script:

```yaml
allowBuilds:
  electron: true
```

Keep root `build` platform-neutral. `package:desktop` must invoke the existing Host/Web build before the desktop package, staging, and packaging commands.

- [ ] **Step 4: Add the proposed Agent Note pair**

Record why the first desktop wrapper uses loopback HTTP, which responsibilities remain with `@deepseek-ai/dsh-host-webserver`, and why a future `file://` plus IPC host is a separate architecture. Include problem, proposal, alternatives, acceptance criteria, and risks.

- [ ] **Step 5: Install and verify workspace policy**

Run: `pnpm install`

Run: `pnpm exec vitest run scripts/check-workspace-constraints.spec.ts`

Run: `pnpm run constraints`

Expected: all commands pass and `pnpm-lock.yaml` records only the reviewed desktop toolchain additions.

- [ ] **Step 6: Pair the Agent Note and commit**

Run: `pnpm run verify-translation-pairing --write .agents/notes/proposed/feature/2026-08-16-macos-desktop-app.md .agents/notes/proposed/feature/2026-08-16-macos-desktop-app.zh.md`

Run: `pnpm run verify-agent-note-format`

Commit: `git commit -m "chore: scaffold macOS desktop app"`

---

### Task 2: Implement strict URL and navigation policies

**Files:**

- Create: `apps/desktop/src/harness-url.ts`
- Create: `apps/desktop/src/navigation-policy.ts`
- Create: `apps/desktop/tests/harness-url.spec.ts`
- Create: `apps/desktop/tests/navigation-policy.spec.ts`

- [ ] **Step 1: Write failing URL parsing tests**

Cover a valid dynamic port and reject `localhost`, IPv6, credentials, paths, fragments, port zero, ports above 65535, and output that merely contains a URL. The public contract is:

```ts
export declare function parseHarnessUrl(line: string): URL | undefined
```

Use this exact positive assertion:

```ts ignore-check
expect(parseHarnessUrl('dsh web: http://127.0.0.1:43127')?.href)
  .toBe('http://127.0.0.1:43127/')
```

- [ ] **Step 2: Write failing navigation policy tests**

The decision type and policy entry point are:

```ts
export type NavigationDecision = 'allow' | 'external' | 'deny'

export declare function classifyNavigation(
  target: URL,
  harnessOrigin: string,
): NavigationDecision
```

Assert same-origin HTTP is allowed, other HTTP/HTTPS origins are external, and `file:`, `data:`, `javascript:`, custom schemes, credentials, or malformed origins are denied.

- [ ] **Step 3: Run tests and confirm failure**

Run: `pnpm exec vitest run apps/desktop/tests/harness-url.spec.ts apps/desktop/tests/navigation-policy.spec.ts`

Expected: FAIL because both modules are missing.

- [ ] **Step 4: Implement the minimum strict policies**

Parse only a full-line match, validate the numeric port, reconstruct the URL, and compare normalized origins. Do not use substring matching or trust child-provided paths.

- [ ] **Step 5: Re-run tests and commit**

Run: `pnpm exec vitest run apps/desktop/tests/harness-url.spec.ts apps/desktop/tests/navigation-policy.spec.ts`

Expected: PASS.

Commit: `git commit -m "feat(desktop): validate harness navigation"`

---

### Task 3: Own the Harness child-process lifecycle

**Files:**

- Create: `apps/desktop/src/desktop-logger.ts`
- Create: `apps/desktop/src/harness-process.ts`
- Create: `apps/desktop/src/login-path.ts`
- Create: `apps/desktop/tests/fixtures/fake-dsh.mjs`
- Create: `apps/desktop/tests/harness-process.spec.ts`
- Create: `apps/desktop/tests/login-path.spec.ts`

- [ ] **Step 1: Write failing lifecycle tests around injected boundaries**

Test delayed readiness, startup timeout, early exit, non-matching stdout, health-check failure, retry cleanup, normal `SIGTERM`, forced `SIGKILL`, and unexpected runtime exit. Keep process spawning, process-group killing, clock, and HTTP health checks injectable:

```ts ignore-check
export interface HarnessProcessOptions {
  executable: string
  cliPath: string
  dshHome: string
  cwd: string
  env: NodeJS.ProcessEnv
  startupTimeoutMs?: number
  shutdownTimeoutMs?: number
  spawnProcess?: typeof spawn
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void
  healthCheck?: (url: URL, signal: AbortSignal) => Promise<void>
  logger: DesktopLogger
}

export class HarnessProcessController {
  constructor(options: HarnessProcessOptions)
  start(): Promise<URL>
  stop(): Promise<void>
  onUnexpectedExit(listener: (error: Error) => void): () => void
}
```

The fake CLI must expose deterministic modes through arguments, never through production-only branches.

- [ ] **Step 2: Write the failing login-PATH test**

Inject the `shellPath()` provider and verify that only `PATH` changes:

```ts ignore-check
await expect(buildChildEnvironment(
  { HOME: '/Users/test', SECRET: 'unchanged', PATH: '/usr/bin' },
  async () => '/opt/homebrew/bin:/usr/bin',
)).resolves.toMatchObject({
  HOME: '/Users/test',
  SECRET: 'unchanged',
  PATH: '/opt/homebrew/bin:/usr/bin',
  ELECTRON_RUN_AS_NODE: '1',
})
```

The production call must override `DSH_HOME` after this function returns. Logs must never serialize the environment object.

- [ ] **Step 3: Run tests and confirm failure**

Run: `pnpm exec vitest run apps/desktop/tests/harness-process.spec.ts apps/desktop/tests/login-path.spec.ts`

Expected: FAIL because lifecycle modules are missing.

- [ ] **Step 4: Implement the controller**

Spawn these fixed arguments with `detached: true` and piped stdout/stderr:

```ts ignore-check
const args = [cliPath, 'web', '--host', '127.0.0.1', '--port', '0']
```

Buffer output by line, accept only `parseHarnessUrl`, then perform an abortable HTTP GET that requires a 2xx response. On stop, send `SIGTERM` to `-pid`, wait up to five seconds, then send `SIGKILL` to the same owned group. Make `start()` idempotently reject while already starting or ready, and make `stop()` safe to call repeatedly.

Write newline-delimited log entries under `<userData>/Logs/desktop.log` with fixed event names and safe metadata. Child stdout/stderr may be copied as text, but no environment values, credential files, request bodies, or settings documents may be read by the logger.

- [ ] **Step 5: Re-run focused tests and commit**

Run: `pnpm exec vitest run apps/desktop/tests/harness-process.spec.ts apps/desktop/tests/login-path.spec.ts`

Expected: PASS, including a fake child that ignores `SIGTERM` and is reaped by `SIGKILL`.

Commit: `git commit -m "feat(desktop): manage harness child lifecycle"`

---

### Task 4: Build the secure Electron application shell

**Files:**

- Create: `apps/desktop/src/main.ts`
- Create: `apps/desktop/src/window-state.ts`
- Create: `apps/desktop/src/menu.ts`
- Create: `apps/desktop/static/startup.html`
- Create: `apps/desktop/static/error.html`
- Create: `apps/desktop/tests/window-state.spec.ts`
- Create: `apps/desktop/tests/application-controller.spec.ts`

- [ ] **Step 1: Write failing window-state and orchestration tests**

Extract Electron calls behind a small adapter so tests can assert single-instance handoff, initial startup page, readiness transition, retry cleanup, unexpected-exit error state, second-instance focus, and last-window shutdown without importing a real Electron binary.

Persist and sanitize this model:

```ts
export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
}

export const defaultWindowBounds: WindowBounds = {
  width: 1100,
  height: 720,
}
```

Reject persisted dimensions below `900 × 600` or completely outside all connected displays.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm exec vitest run apps/desktop/tests/window-state.spec.ts apps/desktop/tests/application-controller.spec.ts`

Expected: FAIL because the application shell does not exist.

- [ ] **Step 3: Implement the BrowserWindow security contract**

Create the window with no preload script and these non-negotiable preferences:

```ts
const webPreferences = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
}
```

Disable `window.open`; route allowed external HTTP/HTTPS URLs through `shell.openExternal`; prevent every disallowed top-level navigation; and load only the startup document, error document, or confirmed Harness origin.

- [ ] **Step 4: Implement lifecycle, menu, and recovery**

Acquire `app.requestSingleInstanceLock()` before creating state. A second launch restores and focuses the existing window. Build menu actions for Reload, Open Logs Directory, and Quit. On startup failure, load `error.html` and show a native dialog with Retry, Open Logs Directory, and Quit. Retry must await `controller.stop()` before `controller.start()`.

Handle Cmd+Q, last-window close, `SIGTERM`, and `SIGINT` through one idempotent asynchronous shutdown barrier. Do not call `app.quit()` until the owned Harness process has stopped.

- [ ] **Step 5: Re-run tests and perform an unpackaged smoke test**

Run: `pnpm --filter @deepseek-ai/dsh-desktop run build`

Run: `pnpm exec vitest run apps/desktop/tests`

Run: `pnpm --filter @deepseek-ai/dsh-desktop exec electron lib/main.js`

Expected: the window shows the existing Web UI, a second launch focuses it, and quitting leaves no child matching the recorded PID.

- [ ] **Step 6: Commit**

Commit: `git commit -m "feat(desktop): add secure Electron shell"`

---

### Task 5: Stage a standalone runtime and build the icon

**Files:**

- Create: `apps/desktop/scripts/stage-runtime.mjs`
- Create: `apps/desktop/scripts/build-icon.mjs`
- Create: `apps/desktop/scripts/verify-runtime.mjs`
- Create: `apps/desktop/tests/stage-runtime.spec.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Write the failing staging policy tests**

Test the platform guard, deterministic staging paths, required CLI entry point, absence of repository symlinks, and construction of the native-module rebuild command. The exported plan function is pure:

```ts
export interface StagePlan {
  readonly runtimeDirectory: string
}

export declare function createStagePlan(input: {
  repoRoot: string
  platform: NodeJS.Platform
  arch: string
  electronVersion: string
}): StagePlan
```

Assert it rejects any target except `darwin` plus `arm64`.

- [ ] **Step 2: Run the test and confirm failure**

Run: `pnpm exec vitest run apps/desktop/tests/stage-runtime.spec.ts`

Expected: FAIL because the staging script does not exist.

- [ ] **Step 3: Implement production runtime staging**

The script must remove only `apps/desktop/.runtime`, then execute the equivalent of:

```sh
pnpm --filter @deepseek-ai/dsh --prod deploy --legacy apps/desktop/.runtime
pnpm exec electron-rebuild --module-dir apps/desktop/.runtime --arch arm64 --version 43.4.0
```

Resolve every path from `import.meta.url`, never the caller's current directory. After deployment, walk `.runtime` and fail on symlinks that resolve into the repository. Require `.runtime/lib/bin.js` and the built Web frontend closure before succeeding.

- [ ] **Step 4: Build a proper macOS icon**

Render the existing `apps/web/public/favicon.svg` into all required iconset sizes using the repository's existing Sharp toolchain, then call `iconutil -c icns`. Keep the generated `.icns` out of Git; the SVG remains the single source.

- [ ] **Step 5: Verify the embedded Node runtime directly**

Use the installed Electron binary with `ELECTRON_RUN_AS_NODE=1` to run the staged CLI first with `--version`, then with `web --host 127.0.0.1 --port 0`. Parse the emitted URL, require HTTP 200, terminate the owned process group, and assert no repository path appears in the resolved runtime files.

- [ ] **Step 6: Run checks and commit**

Run: `pnpm exec vitest run apps/desktop/tests/stage-runtime.spec.ts`

Run: `pnpm --filter @deepseek-ai/dsh-desktop run stage`

Run: `node apps/desktop/scripts/verify-runtime.mjs`

Expected: PASS on Apple Silicon and a clear unsupported-platform failure elsewhere.

Commit: `git commit -m "build(desktop): stage standalone harness runtime"`

---

### Task 6: Produce the App, DMG, and standalone acceptance test

**Files:**

- Create: `apps/desktop/electron-builder.yml`
- Create: `apps/desktop/build/entitlements.mac.plist`
- Create: `apps/desktop/scripts/package.mjs`
- Create: `apps/desktop/scripts/verify-package.mjs`
- Create: `apps/desktop/tests/package-config.spec.ts`

- [ ] **Step 1: Write the failing package-config test**

Parse the builder config and require `arm64`, minimum macOS `14.0`, no updater, no notarization, runtime placement under `Contents/Resources/runtime`, and explicit ad-hoc signing. The essential configuration is:

```yaml
appId: ai.deepseek.harness
productName: DeepSeek Harness
asar: true
files:
  - lib/*.js
  - static/**
extraResources:
  - from: .runtime
    to: runtime
mac:
  target:
    - target: dmg
      arch: [arm64]
    - target: dir
      arch: [arm64]
  category: public.app-category.developer-tools
  minimumSystemVersion: '14.0'
  identity: '-'
  hardenedRuntime: true
  entitlements: build/entitlements.mac.plist
```

The entitlement file must include Electron JIT support and `com.apple.security.cs.disable-library-validation`, which is required when the ad-hoc app retains Hardened Runtime.

- [ ] **Step 2: Run the package-config test and confirm failure**

Run: `pnpm exec vitest run apps/desktop/tests/package-config.spec.ts`

Expected: FAIL because no packaged artifact or builder config exists.

- [ ] **Step 3: Implement deterministic packaging**

`package.mjs` must guard `darwin-arm64`, build the icon, stage and verify runtime, invoke Electron Builder without publish or notarization, and place outputs under `apps/desktop/release`. It must never discover or use a Developer ID identity from the user's keychain; the checked-in config fixes `identity: '-'`.

- [ ] **Step 4: Implement the outside-repository smoke test**

Copy `DeepSeek Harness.app` to a `mkdtemp` directory outside the checkout. Launch `Contents/MacOS/DeepSeek Harness` with a temporary `--user-data-dir`, poll `Logs/desktop.log` for the ready URL, require HTTP 200 and the expected page title, launch a second instance, and assert the original backend PID is unchanged. Then terminate the app, wait for the recorded process group to disappear, and confirm its loopback port is closed.

Mount the DMG with `hdiutil attach`, require the App inside it, and detach it in a `finally` block. Verify signatures with:

```sh
codesign --verify --deep --strict "apps/desktop/release/mac-arm64/DeepSeek Harness.app"
codesign -dv --verbose=4 "apps/desktop/release/mac-arm64/DeepSeek Harness.app"
```

Do not treat `spctl` rejection as a failure because this personal build is ad-hoc signed and not notarized.

- [ ] **Step 5: Build and verify artifacts**

Run: `pnpm run package:desktop`

Run: `node apps/desktop/scripts/verify-package.mjs`

Expected: an arm64 App and DMG pass standalone launch, single-instance, Web UI, signature, and cleanup checks outside the repository.

- [ ] **Step 6: Commit**

Commit: `git commit -m "build(desktop): package Apple Silicon app"`

---

### Task 7: Align architecture docs, notices, and final gates

**Files:**

- Create: `apps/desktop/README.md`
- Create: `apps/desktop/README.zh.md`
- Create: `apps/desktop/README.i18n.yaml`
- Modify: `docs/subsystems/web-server.md`
- Modify: `docs/subsystems/web-server.zh.md`
- Modify: `docs/subsystems/web-server.i18n.yaml`
- Modify: `packages/host/webserver/README.md`
- Modify: `packages/host/webserver/README.zh.md`
- Modify: `packages/host/webserver/README.i18n.yaml`
- Modify: `packages/host/webserver/src/index.ts`
- Move: `.agents/notes/proposed/feature/2026-08-16-macos-desktop-app.md` → `.agents/notes/implemented/feature/2026-08-16-macos-desktop-app.md`
- Move: `.agents/notes/proposed/feature/2026-08-16-macos-desktop-app.zh.md` → `.agents/notes/implemented/feature/2026-08-16-macos-desktop-app.zh.md`
- Move: `.agents/notes/proposed/feature/2026-08-16-macos-desktop-app.i18n.yaml` → `.agents/notes/implemented/feature/2026-08-16-macos-desktop-app.i18n.yaml`
- Modify: `THIRD_PARTY_NOTICES.md`

- [ ] **Step 1: Write the user and maintainer docs**

Document supported hardware and OS, `pnpm run package:desktop`, artifact locations, first-launch Gatekeeper behavior, data/log locations, lack of auto-update/notarization, and how to replace the App without losing settings.

Update Web-server docs and the source module comment to say the first macOS wrapper deliberately uses loopback HTTP; reserve `file://` plus IPC for a future Electron-native host. Do not describe both as the same transport.

- [ ] **Step 2: Finalize the Agent Note**

Move both language files and their pair record to `implemented/feature`, change `Status: proposed` to `Status: implemented`, replace proposal text with the actual decision, and report current consequences and test evidence. Refresh all touched pair records.

- [ ] **Step 3: Regenerate third-party notices**

Run: `pnpm run gen-third-party-notices`

Expected: Electron desktop dependencies are represented and `pnpm run verify-third-party-notices` passes.

- [ ] **Step 4: Run focused and repository gates**

Run: `pnpm run test:desktop`

Run: `pnpm run build`

Run: `pnpm run build:desktop`

Run: `pnpm run lint`

Run: `pnpm run constraints`

Run: `pnpm run doc-sync`

Run: `pnpm run verify-agent-note-format`

Run: `pnpm run verify-third-party-notices`

Run: `pnpm run hygiene`

Expected: all gates pass. If an unrelated pre-existing gate fails, capture the exact command and evidence separately; do not weaken the gate.

- [ ] **Step 5: Repeat the packaged acceptance test from a clean artifact**

Run: `pnpm run package:desktop`

Run: `node apps/desktop/scripts/verify-package.mjs`

Expected: the copied App launches without repository Node.js paths, serves the existing Web UI, reuses one backend, persists data under the temporary user-data directory, and leaves no owned process after quit.

- [ ] **Step 6: Inspect the final diff and commit**

Run: `git status --short`

Run: `git diff --check`

Run: `git diff --stat HEAD~6`

Commit: `git commit -m "docs: document macOS desktop distribution"`

The branch is complete only when both the App and DMG exist locally and the outside-repository acceptance test passes.
