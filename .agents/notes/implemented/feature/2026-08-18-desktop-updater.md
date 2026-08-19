# Agent Note: Desktop updates from GitHub Releases

Status: implemented

English | [中文](2026-08-18-desktop-updater.zh.md)

## Problem

The Desktop application had no updater: every new build required a manual GitHub download and reinstall, and the README documented that state. The installer payload also grew, so distributing fixes meant repeating the full manual install cycle.

## Decision

The desktop main process owns a small updater over the GitHub Releases API instead of an update framework. `DesktopUpdater` checks `GET /repos/{owner}/{repo}/releases`, filters by channel (`stable` excludes prereleases), parses `desktop-v*` tags, and compares versions with an owned semver comparator. The Windows NSIS installer or the macOS arm64 DMG is selected by platform asset name, downloaded, verified against the release's `checksums.txt` or per-asset `.sha256`, and applied: Windows spawns the installer silently (`/S`) after the app quits; macOS runs an elevated script that waits for the app to exit, attaches the DMG, replaces `/Applications/DeepSeek Harness.app`, strips the download quarantine, and relaunches. A checksum mismatch aborts before any install step.

The update source and behavior are user-data preferences (`desktop-settings.json`, sanitized like `window-state.json`): `repository` (default `GZXiaoBai/deepseek-harness`), `channel`, and `autoUpdate`. The menu gains **Check for Updates…** and an **Automatic Updates** checkbox; the startup check is delayed until the window and backend settle, and every failure lands in `desktop.log` without blocking startup. Releases are produced by the `desktop-v*` tag workflow, which builds both platforms and uploads the installer, DMG, and checksums.

## Alternatives considered

**electron-updater.** The maintained framework expects `latest.yml` publishing and a signed macOS app for auto-update; the personal build is ad-hoc signed and not notarized, so macOS auto-update still fails Gatekeeper and the framework's extra machinery buys nothing. The owned updater keeps the repository, channel, and policy in one visible file and can be replaced by electron-updater later without changing the menu or settings surface.

**Manually downloading from the release page.** Kept as the failure fallback (macOS opens the DMG when the elevated install fails), not as the primary flow.

## Consequences

Updates are one menu click or automatic at startup, and the checksum gate turns corrupted downloads into a logged abort instead of a broken install. macOS auto-update requires an administrator password and may still surface Gatekeeper on first launch because the build is not notarized; the quarantine strip applies only to the copy installed from the configured repository. Release publishing is now a tag push on the fork; moving the default repository to the official repo is a one-line settings default change once official desktop artifacts exist.
