# DeepSeek Harness macOS 版

[English](README.md) | 中文

本包用于在搭载 macOS 14 或更高版本的 Apple Silicon Mac 上构建个人使用的 DeepSeek Harness 桌面应用。它保留现有 Web UI，并在 `http://127.0.0.1:<ephemeral-port>` 上启动私有 Harness 后端。[桌面应用决策](../../.agents/notes/implemented/feature/2026-08-16-macos-desktop-app.md)负责应用边界，[封闭运行时决策](../../.agents/notes/implemented/architecture/2026-08-17-desktop-closed-runtime-deploy-root.md)负责依赖暂存。

## 构建

请在 Apple Silicon Mac 上从仓库根目录运行生产构建：

```sh
pnpm run package:desktop
```

该命令会拒绝非 macOS 和非 arm64 宿主。它会将应用写入 `apps/desktop/release/mac-arm64/DeepSeek Harness.app`，并将安装包写入 `apps/desktop/release/DeepSeek Harness-<version>-arm64.dmg`；`apps/desktop/package.json` 是版本真源。

## 安装与替换

退出 DeepSeek Harness，打开 DMG，再将 `DeepSeek Harness.app` 复制到 `/Applications`。安装更新的本地构建时，请退出现有应用，并仅替换 `/Applications/DeepSeek Harness.app`；替换应用不会删除 `~/Library/Application Support/DeepSeek Harness` 下的数据。

此个人构建使用带 Hardened Runtime 的 ad-hoc 签名，但未经公证。Gatekeeper 可能会阻止首次启动被隔离的应用。请先尝试打开应用；macOS 阻止后，打开「系统设置 > 隐私与安全性」，点击「仍要打开」，再确认「打开」。当前恢复步骤以 Apple 的[打开来自未识别开发者的 Mac 应用](https://support.apple.com/guide/mac-help/mh40616/mac)指南为准。请勿在系统范围内禁用 Gatekeeper。

本应用不提供更新器。更新时需要手动构建并替换。

## 数据与日志

Electron 拥有 `~/Library/Application Support/DeepSeek Harness`。窗口边界存储在 `window-state.json` 中，桌面生命周期日志追加到 `Logs/desktop.log`。Harness 拥有该目录下的 `Harness/` 子树，包括配置、profile 和会话。替换 App 或 DMG 不会改动此目录；删除它会重置 Desktop 和 Harness 状态。如果初始化在恢复界面接管前失败，应用会记录原始错误；如果控制器已创建，应用会尝试并等待其关闭。清理失败会另行报告，此时不能保证后端终止。Electron 仍会以状态码 1 退出并释放单实例锁。

## 验证

打包验证器会全面验证发布 App，将它复制到仓库外，再次验证该副本，并仅启动这个副本。该启动会证明通过 HTTP 提供的现有 Web UI、第二实例交接时不会替换后端、Harness 子树与 Web profile 已初始化并与 Electron userData 隔离，以及后端进程组和 TCP 端口的清理。验证器会另行挂载 DMG，并重新验证已挂载 App 的应用包包含性、arm64 Mach-O 文件、ad-hoc Hardened Runtime 签名和 entitlements，但不会启动它。

```sh
pnpm run test:desktop
pnpm run build:desktop
pnpm --filter @deepseek-ai/dsh-desktop run verify:package
codesign --verify --deep --strict "apps/desktop/release/mac-arm64/DeepSeek Harness.app"
spctl --assess --type execute --verbose=4 "apps/desktop/release/mac-arm64/DeepSeek Harness.app"
```

`spctl` 命令预期会拒绝这个有意未经公证的个人构建。其他命令必须成功。
