# Agent Note: Trim and measure the Desktop runtime payload

Status: implemented

English | [中文](2026-08-18-desktop-runtime-payload-trim.zh.md)

## Problem

The Desktop installer wrote the staged runtime as tens of thousands of small files (the 0.1.0-rc.5 macOS runtime measured 31,408 files, 329 MB). On Windows, NSIS decompression plus antivirus real-time scanning of every created file made installation take several minutes to tens of minutes, and the same per-file scanning slowed the first launch. The installer also gave no observable size or duration signal, so the cost could regress silently.

## Decision

Staging prunes development-only files from the runtime after the Electron rebuild: TypeScript sources, source maps, and object files (`*.ts`, `*.mts`, `*.cts`, `*.map`, `*.o`, `*.obj`). A manifest scan of the staged closure shows no `main`/`exports` runtime condition pointing at `.ts`, and source maps are debugger-only, so the pruned extensions carry no runtime role; the staged smoke (native modules, CLI version, Web startup) and the packaged launch acceptance both run after pruning and would catch a wrong cut. A staging gate then rejects any manifest whose Node-evaluated entry (`main`, `bin`, or `exports` conditions `node`/`import`/`require`/`default`) names a pruned source file, so a future dependency cannot route a loadable entry at a pruned extension; bundler-only conditions (`source`, `development`, `browser`) and `types` stay out of the check.  The pruned count is roughly half the staged tree, which cuts installer size and the per-file antivirus cost of installation on both platforms.

The Windows verifier times the silent NSIS install and writes installer size, application file count, and byte total to `apps/desktop/release/verify-stats.json`; the Windows CI workflow prints that file, making install duration a measured regression signal instead of an anecdote.

## Alternatives considered

**Ship the JavaScript runtime inside `app.asar`.** Electron's embedded Node reads JavaScript directly from the archive, so the installer would write one file instead of tens of thousands. This was prototyped and rejected: Node's module resolution (both ESM and CJS) cannot follow a real-directory symlink whose target lies inside an `app.asar` archive under `ELECTRON_RUN_AS_NODE`, and the profile boot depends on exactly that shape — `$DSH_HOME/profiles/node_modules` links every in-box plugin into the runtime, and out-of-tree plugin peers import Service Definition packages through those links. Imports whose resolution chain starts inside the archive work; imports that reach the archive through a real-directory link fail with `ERR_MODULE_NOT_FOUND`. Routing bare names through a host base URL (`bareModuleBaseUrl`) would fix patch entries but not the out-of-tree peer case, which has no clean resolution without copying runtime packages into user data.

**Extract a runtime archive on first launch.** This keeps the archive as one installer file but moves the same per-file write and scan cost into first launch, doubles disk usage, and requires an extraction-aware startup flow.

**Keep the unpacked runtime and only prune sources.** Chosen: pruning cuts the dominant cost (per-file creation and scanning during install) by roughly half with no architecture change.

## Consequences

Installer payload and file count drop by roughly half, with no change to the runtime layout or the profile resolution contract. The prune set is mechanical and gated by the staged smoke plus the packaged launch acceptance. Windows install duration now has a CI-printed regression signal instead of being anecdotal. The asar rejection is recorded here so a future packaging change starts from the resolution-constraint evidence instead of rediscovering it.
