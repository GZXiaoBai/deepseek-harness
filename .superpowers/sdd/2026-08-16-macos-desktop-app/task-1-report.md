# Task 1 report: desktop package registration and decision record

## Implementation

Added the public `@deepseek-ai/dsh-desktop` workspace scaffold with the required Apple-Silicon desktop manifest, TypeScript declaration build configuration, and Electron main-process bundle configuration. Root commands now build, test, and package the desktop application; `package:desktop` first runs the existing Host/Web build. The Host aggregate includes future desktop source and test files without making the root build invoke the desktop package.

Registered the desktop package's publication payload in the workspace-constraint checker. The checker test runs the real checker against a temporary desktop manifest in `apps/`, so it proves the accepted payload behavior without asserting the private policy table or source text. The workspace configuration approves Electron's reviewed install script and explicitly denies the unused Windows-only helper pulled in by electron-builder.

Added the proposed bilingual Agent Note and pairing record. It records the loopback-HTTP wrapper decision, keeps `@deepseek-ai/dsh-host-webserver` responsible for HTTP serving and browser startup, and treats a future `file://` plus IPC host as a separate architecture. Regenerated `THIRD_PARTY_NOTICES.md` for the new declared dependencies.

## Files

- Added `apps/desktop/package.json`, `apps/desktop/tsconfig.json`, and `apps/desktop/tsdown.config.ts`.
- Added `scripts/check-workspace-constraints.spec.ts`.
- Updated root commands, Host TypeScript inclusion, pnpm build-script policy, publication constraints, lockfile, and third-party notices.
- Added `.agents/notes/proposed/feature/2026-08-16-macos-desktop-app.{md,zh.md,i18n.yaml}`.

## RED/GREEN evidence

RED: `pnpm exec vitest run scripts/check-workspace-constraints.spec.ts` failed with `@deepseek-ai/dsh-desktop: app package has no publication files policy` before the policy and package scaffold existed.

GREEN: after the implementation, `pnpm exec vitest run scripts/check-workspace-constraints.spec.ts && pnpm run constraints` passed with 1 test passing and the constraints command exiting successfully. The test remained green after a cross-platform `basename()` refactor.

## Tests and checks

- Passed: `pnpm install` (after explicitly reviewing and denying `electron-winstaller`; install emitted existing missing-built-bin warnings for example workspaces).
- Passed: focused constraint test and `pnpm run constraints`.
- Passed: `pnpm run verify-translation-pairing --write .agents/notes/proposed/feature/2026-08-16-macos-desktop-app.md .agents/notes/proposed/feature/2026-08-16-macos-desktop-app.zh.md`.
- Passed: `pnpm run verify-agent-note-format`.
- Passed: `pnpm run build`.
- Passed: `pnpm run doc-sync` (28 gates) and `pnpm run lint`.
- Full-suite run: `pnpm run test` completed in 171.01 seconds with 802 passing files, 8 skipped files, 13,402 passing tests, and 109 skipped tests. It initially failed on stale third-party notices and an unrelated HMR watcher timeout. After `pnpm run gen-third-party-notices`, `pnpm exec vitest run scripts/gen-third-party-notices.spec.ts packages/boot/app-boot/tests/hmr-config.spec.ts` passed (32 tests).
- Passed: `pnpm run publint`, `pnpm run verify-dsh-package-licenses`, `pnpm run verify-package-invariants`, `pnpm run verify-built-package-invariants`, `pnpm run verify-cordis-config`, `pnpm run verify-node-next-types`, `pnpm run verify-runtime-closure`, and `pnpm run verify-vendored-links`.
- Passed: `git diff --check`.

## Self-review

The manifest retains every required exact dependency and publication value. The root `build` command remains platform-neutral; desktop work is opt-in through `build:desktop` and `package:desktop`. The behavioral constraint test exercises a controlled manifest through the actual command, and its temporary directory is always removed. The bilingual note has the required structure and a generated pairing record.

## Concerns

`pnpm run hygiene` did not complete because its first `rescope-vendor:check` stage reports 26 existing pre-rescope residue findings outside this task. Running the remaining checks separately showed that `knip` reports `shell-path`, `@electron/rebuild`, `electron`, `electron-builder`, and `sharp` as unused; this is expected at the scaffold-only Task 1 stage, before later desktop implementation tasks add their imports and scripts. The focused affected checks, build, documentation gates, and all remaining publication checks pass.
