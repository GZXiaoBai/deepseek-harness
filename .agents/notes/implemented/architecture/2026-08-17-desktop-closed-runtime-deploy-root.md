# Agent Note: Desktop owns a closed runtime deploy root

Status: implemented

English | [中文](2026-08-17-desktop-closed-runtime-deploy-root.zh.md)

## Problem

The public `@deepseek-ai/dsh` manifest describes the installable CLI, not every peer supplied by a concrete host. A pnpm deployment materializes workspace packages outside their development layout, so peer imports used by the assembled CLI and Web plugin graph cannot rely on the checkout's root `node_modules`. Adding every deployment peer to the public CLI would make one Desktop host's composition part of the general CLI package.

Legacy deployment is not a standalone macOS alternative: its workspace symlinks resolve into the checkout, and it omits parts of the Web frontend closure. Running every dependency lifecycle script during deployment also executes unrelated denied scripts, while the subprocess provider needs one reviewed permission repair. Windows additionally requires a hoisted, link-free runtime because the installed application cannot depend on Developer Mode, administrator-created links, or the source checkout.

The Web composition mounts Cordis HMR. Under Electron's embedded Node runtime, HMR needs access to Node's internal ESM loader, but the Electron main process and renderer do not need that access.

## Decision

`apps/desktop/runtime/package.json` is a private dependency-only workspace and the deploy root for both supported Desktop targets. It depends on `@deepseek-ai/dsh` and directly supplies every non-optional workspace peer reachable through the CLI and Web dependency graph. `scripts/verify-runtime-closure.ts --manifest apps/desktop/runtime/package.json` traverses app, package, and vendor manifests and rejects any missing required peer; Desktop build and staging execute that check.

Staging deploys `@deepseek-ai/dsh-desktop-runtime` from the frozen lockfile with injected workspace packages and dependency lifecycle scripts disabled. macOS retains contained pnpm links; Windows uses the hoisted linker and rejects every symbolic link, junction, or other reparse point. Before executing staged code, staging requires the `@deepseek-ai/dsh-subprocess-local` permission repair to be a regular internal file rather than a link. It executes only that repair, runs Electron rebuild for the native platform and architecture, prunes unsupported `node-pty` prebuilds, and repeats the platform containment audit after staged mutations. CLI and frontend paths resolve through package relationships rooted at the deployed runtime.

The Desktop Harness backend child receives `--expose-internals` only when `ELECTRON_RUN_AS_NODE=1`. Plain Node launches do not receive it. The Electron main process argv and renderer preferences remain unchanged; the renderer keeps context isolation, sandboxing, and Node integration disabled.

Standalone runtime verification shutdown signals only the verifier's detached negative process-group id. Before any group signal succeeds, an already-observed leader exit needs no signal, and EPERM may establish that the group is no longer owned when the positive leader pid is gone. After a negative process-group signal succeeds, leader exit does not end ownership: verification keeps probing the negative group id and escalates until the operating system reports ESRCH. EPERM after ownership is established is a verification-cleanup failure.

## Alternatives considered

- **Add the complete closure to `@deepseek-ai/dsh`**: rejected because the public CLI would own dependencies selected by one Desktop deployment.
- **Use pnpm legacy deploy**: rejected because checkout-resolving links are not portable and the Web frontend closure is incomplete.
- **Allow dependency scripts during injected deploy**: rejected because unrelated lifecycle scripts remain explicitly denied; only the reviewed subprocess permission repair is required.
- **Add `--expose-internals` to Electron globally**: rejected because HMR runs in the backend child, while the main process and renderer gain no benefit from the broader internal API access.
- **Ignore every verification-cleanup EPERM**: rejected because a live owned leader with an unsignalable group is a real verification failure.

## Consequences

- Desktop runtime peer ownership is explicit and mechanically closed without widening the public CLI manifest.
- The deploy root duplicates required peer names by design; the closure verifier, rather than manual smoke-test iteration, owns freshness.
- Staged native compatibility is accepted by real Electron loading and exercise. `electron-rebuild` may report no modules when compatible target prebuilds ship in the closure.
- The runtime smoke verifies native loading, CLI version, the strict loopback URL, HTTP status and title, target-specific owned-tree shutdown, TCP connection refusal on the closed port, and the platform link policy. macOS audits arm64 Mach-O objects; Windows audits x64 PE objects and requires a link-free runtime.
