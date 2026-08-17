# DeepSeek Harness macOS 版

[English](README.md) | 中文

本包用于在搭载 macOS 14 或更高版本的 Apple Silicon Mac 上构建个人使用的 DeepSeek Harness 桌面应用。它保留现有 Web UI，并在 `http://127.0.0.1:<ephemeral-port>` 上启动私有 Harness 后端。[桌面应用决策](../../.agents/notes/implemented/feature/2026-08-16-macos-desktop-app.md)负责应用边界，[封闭运行时决策](../../.agents/notes/implemented/architecture/2026-08-17-desktop-closed-runtime-deploy-root.md)负责依赖暂存。

## 构建

请在 Apple Silicon Mac 上从仓库根目录运行生产构建：

```sh
pnpm run package:desktop
```

该命令会拒绝非 macOS 和非 arm64 宿主。它会将应用写入 `apps/desktop/release/mac-arm64/DeepSeek Harness.app`，并将安装包写入 `apps/desktop/release/DeepSeek Harness-0.1.0-rc.5-arm64.dmg`。

## 安装与替换

退出 DeepSeek Harness，打开 DMG，再将 `DeepSeek Harness.app` 复制到 `/Applications`。安装更新的本地构建时，请退出现有应用，并仅替换 `/Applications/DeepSeek Harness.app`；替换应用不会删除 `~/Library/Application Support/DeepSeek Harness` 下的数据。

此个人构建使用带 Hardened Runtime 的 ad-hoc 签名，但未经公证。Gatekeeper 可能会阻止首次启动被隔离的应用。在 Finder 中按住 Control 点击应用并选择「打开」，然后再确认「打开」；如果 macOS 改为提供「仍要打开」，请在启动被阻止后前往「系统设置 > 隐私与安全性」使用该选项。请勿在系统范围内禁用 Gatekeeper。

本应用不提供更新器。更新时需要手动构建并替换。

## 数据与日志

Electron 拥有 `~/Library/Application Support/DeepSeek Harness`。窗口边界存储在 `window-state.json` 中，桌面生命周期日志追加到 `Logs/desktop.log`。Harness 拥有该目录下的 `Harness/` 子树，包括配置、profile 和会话。替换 App 或 DMG 不会改动此目录；删除它会重置 Desktop 和 Harness 状态。

## 验证

打包验证器要求本地存在发布 App 和 DMG，会验证应用包包含性、arm64 Mach-O 文件、ad-hoc Hardened Runtime 签名与 entitlements，然后在仓库外启动复制出的应用和已挂载的应用，以验证现有 Web UI、单实例行为、数据持久化以及后端清理。

```sh
pnpm run test:desktop
pnpm run build:desktop
pnpm --filter @deepseek-ai/dsh-desktop run verify:package
codesign --verify --deep --strict "apps/desktop/release/mac-arm64/DeepSeek Harness.app"
spctl --assess --type execute --verbose=4 "apps/desktop/release/mac-arm64/DeepSeek Harness.app"
```

`spctl` 命令预期会拒绝这个有意未经公证的个人构建。其他命令必须成功。
