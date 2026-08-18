# Agent Note: Extend the Desktop wrapper to Windows x64

Status: implemented

English | [中文](2026-08-17-windows-desktop-app.zh.md)

## Problem

Windows 11 users need the same personal-use DeepSeek Harness application experience as the Apple Silicon package without creating a second renderer, Host/Web composition, or lifecycle implementation. The installed runtime must work for a standard current user without administrator privileges, Developer Mode, checkout links, or a development toolchain.

## Decision

`@deepseek-ai/dsh-desktop` has two explicit native targets: `darwin-arm64` and `win32-x64`. Every other platform and architecture is rejected. The Windows target reuses the existing Electron main process, BrowserWindow security preferences, navigation policy, native editing shortcuts, window state, strict loopback Web UI, single-instance handoff, startup recovery, and `userData/Harness` data separation defined by the [macOS desktop decision](2026-08-16-macos-desktop-app.md). Packaging runs only on the matching native host; macOS-to-Windows cross-packaging and Wine are not supported.

Windows starts the Harness backend without a shell, with `detached: false` and `windowsHide: true`. The Desktop controller owns only the root process it created and its descendant tree. Shutdown invokes `taskkill.exe /PID <pid> /T /F`, waits for the process and listener to disappear, and keeps cleanup failures visible. The command is skipped only when the root process was already observed as exited before cleanup begins; an error returned by an invoked command remains a cleanup failure even if the root exits concurrently. Cleanup failure never replaces an earlier startup diagnosis.

## Runtime and installer boundaries

The shared [closed-runtime deploy root](../architecture/2026-08-17-desktop-closed-runtime-deploy-root.md) remains the dependency authority. Windows staging uses the pnpm hoisted linker with injected workspace packages and disabled dependency lifecycle scripts, runs the one reviewed subprocess repair, rebuilds for `win32-x64`, and keeps only `node-pty/prebuilds/win32-x64`. The final runtime must contain no symbolic link, junction, or other reparse point. Every PE file is parsed directly and must declare COFF machine `0x8664`; CLI, Web frontend, configuration, ConPTY, koffi, and loopback Web startup are exercised under Electron.

Electron Builder produces `win-unpacked` and `DeepSeek Harness Setup <version>-x64.exe`. The assisted NSIS installer defaults to a per-user install, forbids elevation, lets users choose the install directory, creates Desktop and Start Menu shortcuts, does not run the application after installation, and preserves application data during uninstall. The standard NSIS uninstaller is the only reviewed x86 PE in the installed root; verification requires its exact path, COFF machine `0x014c`, and unsigned status while every application payload PE remains x64. The personal package is intentionally unsigned and has no updater; certificates, MSIX, Windows ARM64, and automatic update infrastructure remain outside this decision.

## Verification

Behavior tests pin target parsing, Windows spawn arguments, `taskkill.exe` failure semantics, hoisted staging, prebuild pruning, PE parsing, afterPack destinations, ICO generation, NSIS configuration, and workflow policy. The native Windows verifier checks both the unpacked directory and a silent NSIS installation for link-free containment, x64 application payloads, the exact NSIS uninstaller exception, expected `NotSigned` status, repository-external startup, strict loopback HTTP and page title, isolated Harness profile initialization, second-instance backend identity, window-close process-tree and port cleanup, shortcut placement, uninstall cleanup, and retained Harness data.

The pull-request and manual Windows Desktop workflow runs this verifier on the existing Windows Server 2025 x64 runner and retains the installer for 14 days. This is automated Windows packaging evidence, not Windows 11 compatibility evidence. A real Windows 11 x64 machine must run the same install and acceptance script before the first release, and that result must be recorded separately.

## Alternatives considered

**Build a separate Windows desktop application.** This would duplicate renderer, security, and lifecycle behavior and allow the two platforms to drift. A target adapter keeps shared behavior in one application.

**Use POSIX-style detached groups on Windows.** Windows does not provide the same negative-process-group signaling contract. A shell-free `taskkill.exe /T /F` operation matches the selected ownership boundary and includes descendants.

**Ship pnpm links and require Developer Mode.** This would make installation depend on machine policy or administrator-created filesystem objects. The Windows runtime is hoisted and link-free instead.

**Cross-package Windows from macOS.** Cross-packaging cannot provide native rebuild or real ConPTY, PE, installer, launch, and uninstall evidence. Windows artifacts are built and accepted on Windows.

## Consequences

The existing Web UI and Desktop behavior now have one shared implementation with explicit platform adapters. Windows packaging is larger than a linked pnpm tree but is portable for a standard user and mechanically rejects links and non-x64 application payloads; the exact standard NSIS x86 uninstaller remains a packaging-tool exception. Unsigned personal installers can trigger Microsoft Defender SmartScreen and may be blocked by enterprise policy; users must not be instructed to disable system-wide protections. Windows Server CI and Windows 11 release acceptance remain distinct evidence.
