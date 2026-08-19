# Agent Note: Ship the complete Desktop runtime and install by plain copy

Status: implemented

English | [中文](2026-08-19-desktop-full-runtime-store-install.zh.md)

## Problem

The Desktop installer's silent install took minutes on CI. A payload-trim attempt pruned development-only files (TypeScript sources, source maps, rebuild debris) from the staged runtime, but the owner decided the app must ship the complete runtime and that install and uninstall speed should come from packaging mechanics, not from removing content.

## Decision

Staging no longer prunes any runtime file: `pruneRuntimeSources` and its entry-point gate are removed, so the staged closure ships every published file (31,210 files, 293 MB on macOS at 0.1.0-rc.7). node-pty keeps every platform prebuild and ConPTY asset; the arm64 Mach-O and x64 PE audits now skip the node-pty package directory through `ignoredRelativePaths` (the package legitimately carries every platform's binaries), while `validateNodePtyPrebuild` still requires the target platform's runtime files so a packaging regression fails staging. The Windows verifier now times the silent uninstall as well — through the asynchronous NSIS cleanup, not the uninstaller process exit — and reports `uninstallMs` in `verify-stats.json`.

`compression: store` was attempted but does not apply to NSIS: the differential-update archive path (`configureDifferentialAwareArchiveOptions`) hard-codes `compression: "normal"` so blockmaps stay deterministic, and disabling differential packages would force full 610 MB downloads on every update. The default normal compression stays, and the measured 0.1.0-rc.7 install is 203 s (32,002 files, 610 MB) against 283 s for the trimmed 13,641-file build.

The earlier asar-based single-file payload was rejected for Node resolution reasons; that evidence is archived with [the payload-trim note](../../archived/feature/2026-08-18-desktop-runtime-payload-trim.md).

## Alternatives considered

**Keep pruning.** Rejected by the owner: the runtime ships complete, and speed work stays in packaging mechanics.

**`compression: store` for the Windows installer.** Attempted and rejected: NSIS differential packaging hard-codes normal compression for deterministic blockmaps, and disabling it would make every automatic update a full ~610 MB download. The measured normal-compressed install (203 s) already beats the trimmed build (283 s) because the differential configuration uses a 1 MB dictionary and non-solid archives.

**Switch to MSIX.** System-level install avoids NSIS extraction and elevation, but needs a stable signing identity, rewrites the in-app updater (install directories are read-only), and forces the pnpm link layout flat; deferred until a store distribution exists.

## Consequences

The installer keeps the normal-compressed size (~150 MB) while the packaged app grows to the complete 610 MB across 32,002 files; the measured silent install is 203 s against 283 s for the trimmed build, and the silent uninstall duration is now measured every build. The architecture audits still cover every binary outside the node-pty package; a future node-pty version that places a wrong-architecture binary in the target platform directory fails the `validateNodePtyPrebuild` file checks and the runtime smoke.
