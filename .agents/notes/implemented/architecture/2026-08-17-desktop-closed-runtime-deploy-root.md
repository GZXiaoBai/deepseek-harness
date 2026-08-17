# Agent Note: Desktop owns a closed runtime deploy root

Status: implemented

English | [中文](2026-08-17-desktop-closed-runtime-deploy-root.zh.md)

## Problem

The public `@deepseek-ai/dsh` manifest describes the installable CLI, not every peer supplied by a concrete host. A pnpm injected deployment materializes workspace packages as isolated package entries, so peer imports used by the assembled CLI and Web plugin graph cannot rely on the development checkout's hoisted `node_modules`. Adding every deployment peer to the public CLI would make one macOS host's composition part of the general CLI package.

Legacy deployment is not a standalone alternative: its workspace symlinks resolve into the checkout, and it omits parts of the Web frontend closure. Running every dependency lifecycle script during deployment also executes unrelated denied scripts, while the macOS subprocess provider needs one reviewed permission repair.

The Web composition mounts Cordis HMR. Under Electron's embedded Node runtime, HMR needs access to Node's internal ESM loader, but the Electron main process and renderer do not need that access.

## Decision

`apps/desktop/runtime/package.json` is a private dependency-only workspace and the deploy root for the macOS Desktop application. It depends on `@deepseek-ai/dsh` and directly supplies every non-optional workspace peer reachable through the CLI and Web dependency graph. `scripts/verify-runtime-closure.ts --manifest apps/desktop/runtime/package.json` traverses app, package, and vendor manifests and rejects any missing required peer; Desktop build and staging execute that check.

Staging deploys `@deepseek-ai/dsh-desktop-runtime` with injected workspace packages and dependency lifecycle scripts disabled. It then executes only the staged `@deepseek-ai/dsh-subprocess-local` permission repair and runs Electron rebuild for the target Electron version and architecture. CLI and frontend paths resolve through package relationships rooted at the deployed runtime, and every staged symlink's real target must remain inside the runtime directory.

The Desktop Harness backend child receives `--expose-internals` only when `ELECTRON_RUN_AS_NODE=1`. Plain Node launches do not receive it. The Electron main process argv and renderer preferences remain unchanged; the renderer keeps context isolation, sandboxing, and Node integration disabled.

Owned backend shutdown signals only the detached negative process-group id. An already-observed child exit needs no signal. EPERM is treated as a non-owned or reused group only when the positive leader pid is gone; EPERM while the leader remains alive is a cleanup failure.

## Alternatives considered

- **Add the complete closure to `@deepseek-ai/dsh`**: rejected because the public CLI would own dependencies selected by one Desktop deployment.
- **Use pnpm legacy deploy**: rejected because checkout-resolving links are not portable and the Web frontend closure is incomplete.
- **Allow dependency scripts during injected deploy**: rejected because unrelated lifecycle scripts remain explicitly denied; only the reviewed subprocess permission repair is required.
- **Add `--expose-internals` to Electron globally**: rejected because HMR runs in the backend child, while the main process and renderer gain no benefit from the broader internal API access.
- **Ignore every cleanup EPERM**: rejected because a live owned leader with an unsignalable group is a real lifecycle failure.

## Consequences

- Desktop runtime peer ownership is explicit and mechanically closed without widening the public CLI manifest.
- The deploy root duplicates required peer names by design; the closure verifier, rather than manual smoke-test iteration, owns freshness.
- Staged native compatibility is accepted by real Electron loading and exercise. `electron-rebuild` may report no modules when compatible darwin-arm64 N-API prebuilds ship in the closure.
- The runtime smoke verifies native loading, CLI version, the strict loopback URL, HTTP status and title, owned-group shutdown, port closure, and absence of checkout-resolving symlinks.
