# DeepSeek Harness Desktop

English | [中文](README.zh.md)

This package builds the personal-use DeepSeek Harness desktop application for Apple Silicon Macs running macOS 14 or later and Windows 11 x64 PCs. Both targets keep the existing Web UI and start a private Harness backend on `http://127.0.0.1:<ephemeral-port>`. The [macOS decision](../../.agents/notes/implemented/feature/2026-08-16-macos-desktop-app.md), [Windows decision](../../.agents/notes/implemented/feature/2026-08-17-windows-desktop-app.md), and [closed-runtime decision](../../.agents/notes/implemented/architecture/2026-08-17-desktop-closed-runtime-deploy-root.md) own the platform and dependency boundaries.

## Supported targets and build

`pnpm run package:desktop` builds only the native target of the current host. Run it from the repository root on either an Apple Silicon Mac or a Windows 11 x64 machine. macOS-to-Windows cross-packaging, Wine, Intel Macs, Windows ARM64, certificates, Windows signing, MSIX, and automatic updates are outside this package.

| Host | Output |
| --- | --- |
| macOS 14+ on Apple Silicon | `apps/desktop/release/mac-arm64/DeepSeek Harness.app` and `apps/desktop/release/DeepSeek Harness-<version>-arm64.dmg` |
| Windows 11 x64 | `apps/desktop/release/win-unpacked` and `apps/desktop/release/DeepSeek Harness Setup <version>-x64.exe` |

`apps/desktop/package.json` is the version source. Every other host or architecture is rejected before packaging.

## Install and update

On macOS, quit DeepSeek Harness, open the DMG, and copy `DeepSeek Harness.app` to `/Applications`. To update, quit the application and replace only `/Applications/DeepSeek Harness.app`; application replacement does not remove data under `~/Library/Application Support/DeepSeek Harness`.

The macOS personal build is ad-hoc signed with Hardened Runtime but is not notarized. A quarantined first launch may be blocked by Gatekeeper. First try to open the application; after macOS blocks it, open **System Settings > Privacy & Security**, click **Open Anyway**, then confirm **Open**. Follow Apple's [Open a Mac app from an unknown developer](https://support.apple.com/guide/mac-help/mh40616/mac) guide for current recovery steps. Do not disable Gatekeeper globally.

On Windows, run `DeepSeek Harness Setup <version>-x64.exe`. The assisted NSIS installer defaults to a current-user installation without elevation, lets you choose the install directory, and creates Desktop and Start Menu shortcuts. It does not launch the application when installation finishes. The packaged runtime ships complete (no source stripping), and on machines with real-time antivirus scanning the first installation and cold start can still take a few minutes because the installer writes tens of thousands of small files. To speed up installation and first launch, add the install directory (`%LOCALAPPDATA%\Programs\...`) and the Harness data directory (`%APPDATA%\DeepSeek Harness`) to the Microsoft Defender exclusion list (Windows Security > Virus & threat protection > Manage settings > Exclusions). This disables real-time scanning of the application files only; apply it on machines you trust. Run a newer installer to update. Uninstall removes the application and shortcuts but retains Harness user data.

The Windows personal build is intentionally unsigned, so Microsoft Defender SmartScreen may show **Windows protected your PC**. Continue with **Run anyway** only when you obtained and verified the installer from a trusted source; enterprise policy may prevent that option. Follow Microsoft's current [SmartScreen reputation guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation). Do not disable Microsoft Defender or SmartScreen globally.

The application checks for updates against the configured GitHub repository's Releases (default `GZXiaoBai/deepseek-harness`, `stable` channel) and updates in place. The **Check for Updates…** menu item runs a manual check; **Automatic Updates** toggles the startup check. Windows downloads the NSIS installer, verifies its SHA-256 against the release checksum, and runs it silently on quit. macOS downloads the DMG, verifies it, and installs the new App into `/Applications` through an administrator prompt; because the personal build is ad-hoc signed and not notarized, the installed copy has its quarantine attribute removed and Gatekeeper may still ask to confirm the first launch. Update preferences persist in `desktop-settings.json` below the application-data directory. A release is published by tagging `desktop-v<version>`; the tag workflow builds both platforms and uploads the installer, DMG, and per-asset checksums. A checksum mismatch aborts the update without installing.

## Data and logs

On macOS, Electron owns `~/Library/Application Support/DeepSeek Harness`. On Windows, it owns `%APPDATA%\DeepSeek Harness`. Window bounds are stored in `window-state.json`, and desktop lifecycle logs are appended to `Logs/desktop.log`. Harness owns the `Harness/` subtree below the platform directory, including configuration, profiles, and sessions. Replacing or uninstalling the application leaves this directory unchanged; removing it resets both Desktop and Harness state.

If initialization fails before the recovery UI can take over, the application records the original failure and, when a controller exists, attempts and awaits its shutdown. A cleanup failure is reported separately and means backend termination is not guaranteed. Electron still exits with status 1 and releases the single-instance lock.

## Verify

Run the shared behavior, build, and native package verification on the same platform that produced the artifacts:

```sh
pnpm run test:desktop
pnpm run build:desktop
pnpm --filter @deepseek-ai/dsh-desktop run verify:package
```

The macOS verifier validates the release App, launches a copy outside the repository, and statically revalidates the mounted DMG App. It checks the Web UI, single-instance handoff, isolated Harness data, process and port cleanup, runtime containment, arm64 Mach-O files, ad-hoc Hardened Runtime signatures, and entitlements. `spctl` rejection is expected for the intentionally unnotarized personal build.

The Windows verifier validates both `win-unpacked` and a silent current-user NSIS installation. It checks that the runtime has no symbolic links, junctions, or other reparse points; every application payload PE file is x64; the standard NSIS uninstaller is the sole reviewed x86 PE at the installed root with COFF machine `0x014c`; the application, installer, and uninstaller are `NotSigned`; the packaged native folder-dialog worker opens a real dialog and reports terminal cancellation after the verifier closes it; loopback HTTP and the existing page title work; the second launch keeps the original backend; closing the window removes the owned process tree and listener; installation creates the Start Menu and Desktop shortcuts; and uninstall removes program files and shortcuts while retaining Harness data. It times the silent installation, the silent uninstall, and the backend startup (harness-starting to harness-ready), and records installer size, application file count, byte total, and those three durations in `apps/desktop/release/verify-stats.json`, which the CI workflow prints as the install and startup regression signal.

The GitHub Windows Server 2025 workflow is the automated packaging gate. Before the first Windows release, run the same installer and verifier on a real Windows 11 x64 PC and record that result separately; Server 2025 CI is not evidence of Windows 11 acceptance.
