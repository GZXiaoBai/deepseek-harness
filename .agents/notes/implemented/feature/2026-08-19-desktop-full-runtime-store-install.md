# Agent Note: Ship the complete Desktop runtime and install by plain copy

Status: implemented

English | [中文](2026-08-19-desktop-full-runtime-store-install.zh.md)

## Problem

The Desktop installer's silent install took minutes on CI. A payload-trim attempt pruned development-only files (TypeScript sources, source maps, rebuild debris) from the staged runtime, but the owner decided the app must ship the complete runtime and that install and uninstall speed should come from packaging mechanics, not from removing content.

## Decision

Staging no longer prunes any runtime file: `pruneRuntimeSources` and its entry-point gate are removed, so the staged closure ships every published file (31,210 files, 293 MB on macOS at 0.1.0-rc.7). node-pty keeps every platform prebuild and ConPTY asset; the arm64 Mach-O and x64 PE audits now skip the node-pty package directory through `ignoredRelativePaths` (the package legitimately carries every platform's binaries), while `validateNodePtyPrebuild` still requires the target platform's runtime files so a packaging regression fails staging. The Windows installer builds with `compression: store`, so NSIS writes files directly instead of single-threaded LZMA extraction; automatic updates still download only changed blocks through the NSIS blockmap. The Windows verifier now times the silent uninstall as well and reports `uninstallMs` in `verify-stats.json`.

The earlier asar-based single-file payload was rejected for Node resolution reasons; that evidence is archived with [the payload-trim note](../../archived/feature/2026-08-18-desktop-runtime-payload-trim.md).

## Alternatives considered

**Keep pruning.** Rejected by the owner: the runtime ships complete, and speed work stays in packaging mechanics.

**Switch to MSIX.** System-level install avoids NSIS extraction and elevation, but needs a stable signing identity, rewrites the in-app updater (install directories are read-only), and forces the pnpm link layout flat; deferred until a store distribution exists.

## Consequences

The installer grows to roughly the full application size (no payload compression), but install becomes a plain file copy and uninstall duration is measured every build. The architecture audits still cover every binary outside the node-pty package; a future node-pty version that places a wrong-architecture binary in the target platform directory fails the `validateNodePtyPrebuild` file checks and the runtime smoke.
