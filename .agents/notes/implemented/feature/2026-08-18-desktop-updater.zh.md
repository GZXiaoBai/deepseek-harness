# Agent Note: 从 GitHub Releases 更新桌面端

Status: implemented

[English](2026-08-18-desktop-updater.md) | 中文

## 问题

Desktop 应用没有更新器：每个新构建都要手动从 GitHub 下载并重装，README 也记录了这一状态。安装包载荷还在增长，分发修复意味着重复完整的手动安装循环。

## 决策

桌面主进程基于 GitHub Releases API 自持一个轻量更新器，而不是引入更新框架。`DesktopUpdater` 请求 `GET /repos/{owner}/{repo}/releases`，按频道过滤（`stable` 排除预发布），解析 `desktop-v*` 标签，并用自实现的 semver 比较器比较版本。按平台资产名选择 Windows NSIS 安装程序或 macOS arm64 DMG，下载后对照 release 的 `checksums.txt` 或按资产的 `.sha256` 校验，再应用：Windows 在应用退出后静默运行安装程序（`/S`）；macOS 运行提权脚本，等待应用退出、挂载 DMG、替换 `/Applications/DeepSeek Harness.app`、移除下载 quarantine 并重新启动。校验和不匹配会在任何安装步骤之前中止。

更新源与行为是用户数据偏好（`desktop-settings.json`，与 `window-state.json` 同样的净化方式）：`repository`（默认 `GZXiaoBai/deepseek-harness`）、`channel` 与 `autoUpdate`。菜单新增 **Check for Updates…** 与 **Automatic Updates** 复选；启动检查延迟到窗口与后端稳定之后，所有失败都记入 `desktop.log` 且不阻塞启动。发布由 `desktop-v*` 标签工作流完成，它构建两个平台并上传安装程序、DMG 与校验和。

## 曾考虑的替代方案

**electron-updater。** 该维护良好的框架期望 `latest.yml` 发布链路，且 macOS 自动更新需要签名应用；个人构建是 ad-hoc 签名且未公证，macOS 自动更新仍然过不了 Gatekeeper，框架的额外机制没有收益。自持更新器把仓库、频道与策略放在一个可见文件里，日后换用 electron-updater 也不需要改菜单或设置面。

**从发布页手动下载。** 保留为失败兜底（macOS 提权安装失败时打开 DMG），不作为主流程。

## 结果

更新变成一次菜单点击或启动时自动完成，校验和门禁把损坏的下载变成日志里的中止而不是坏掉的安装。macOS 自动更新需要管理员密码，且因为构建未公证，首次启动仍可能遇到 Gatekeeper；quarantine 移除只作用于从所配置仓库安装的副本。发布现在是在 fork 上打一个标签；等官方桌面产物出现后，把默认仓库切到官方仓库只是一行设置默认值的变化。
