# DeepSeek Harness 桌面版

[English](README.md) | 中文

本包用于在搭载 macOS 14 或更高版本的 Apple Silicon Mac，以及 Windows 11 x64 电脑上构建个人使用的 DeepSeek Harness 桌面应用。两个目标都保留现有 Web UI，并在 `http://127.0.0.1:<ephemeral-port>` 上启动私有 Harness 后端。[macOS 决策](../../.agents/notes/implemented/feature/2026-08-16-macos-desktop-app.md)、[Windows 决策](../../.agents/notes/implemented/feature/2026-08-17-windows-desktop-app.md)和[封闭运行时决策](../../.agents/notes/implemented/architecture/2026-08-17-desktop-closed-runtime-deploy-root.md)负责平台与依赖边界。

## 支持目标与构建

`pnpm run package:desktop` 只构建当前宿主的原生目标。请在 Apple Silicon Mac 或 Windows 11 x64 电脑上从仓库根目录运行。macOS 到 Windows 的交叉打包、Wine、Intel Mac、Windows ARM64、证书、Windows 签名、MSIX 和自动更新均不属于本包范围。

| 宿主 | 输出 |
| --- | --- |
| 搭载 Apple Silicon 的 macOS 14+ | `apps/desktop/release/mac-arm64/DeepSeek Harness.app` 与 `apps/desktop/release/DeepSeek Harness-<version>-arm64.dmg` |
| Windows 11 x64 | `apps/desktop/release/win-unpacked` 与 `apps/desktop/release/DeepSeek Harness Setup <version>-x64.exe` |

`apps/desktop/package.json` 是版本真源。打包前会拒绝其他所有宿主或架构。

## 安装与更新

在 macOS 上，请退出 DeepSeek Harness，打开 DMG，再将 `DeepSeek Harness.app` 复制到 `/Applications`。更新时，请退出应用，并仅替换 `/Applications/DeepSeek Harness.app`；替换应用不会删除 `~/Library/Application Support/DeepSeek Harness` 下的数据。

macOS 个人构建使用带 Hardened Runtime 的 ad-hoc 签名，但未经公证。Gatekeeper 可能会阻止首次启动被隔离的应用。请先尝试打开应用；macOS 阻止后，打开「系统设置 > 隐私与安全性」，点击「仍要打开」，再确认「打开」。当前恢复步骤以 Apple 的[打开来自未识别开发者的 Mac 应用](https://support.apple.com/guide/mac-help/mh40616/mac)指南为准。请勿在系统范围内禁用 Gatekeeper。

在 Windows 上，请运行 `DeepSeek Harness Setup <version>-x64.exe`。一键式 NSIS 安装程序会为当前用户安装且不请求提权，创建开始菜单快捷方式，不创建桌面快捷方式，也不会在安装完成后启动应用。运行更新版本的安装程序即可更新。卸载会移除应用与快捷方式，但保留 Harness 用户数据。

Windows 个人构建有意保持未签名，因此 Microsoft Defender SmartScreen 可能显示「Windows 已保护你的电脑」。仅当安装程序来自你信任且已核验的来源时，才选择「仍要运行」；企业策略可能不提供该选项。请遵循 Microsoft 当前的 [SmartScreen 信誉指南](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)。请勿在系统范围内禁用 Microsoft Defender 或 SmartScreen。

两个平台都不提供更新器。更新时需要手动构建并安装替代版本。

## 数据与日志

在 macOS 上，Electron 拥有 `~/Library/Application Support/DeepSeek Harness`；在 Windows 上，它拥有 `%APPDATA%\DeepSeek Harness`。窗口边界存储在 `window-state.json` 中，桌面生命周期日志追加到 `Logs/desktop.log`。Harness 拥有平台目录下的 `Harness/` 子树，包括配置、profile 和会话。替换或卸载应用不会改动此目录；删除它会重置 Desktop 和 Harness 状态。

如果初始化在恢复界面接管前失败，应用会记录原始错误；如果控制器已创建，应用会尝试并等待其关闭。清理失败会另行报告，此时不能保证后端终止。Electron 仍会以状态码 1 退出并释放单实例锁。

## 验证

请在生成产物的同一平台上运行共享行为测试、构建与原生打包验证：

```sh
pnpm run test:desktop
pnpm run build:desktop
pnpm --filter @deepseek-ai/dsh-desktop run verify:package
```

macOS 验证器会验证发布 App，启动仓库外的副本，并对已挂载 DMG 中的 App 重新进行静态验证。它检查 Web UI、单实例交接、隔离的 Harness 数据、进程与端口清理、运行时包含性、arm64 Mach-O 文件、ad-hoc Hardened Runtime 签名和 entitlements。`spctl` 拒绝这个有意未经公证的个人构建属于预期结果。

Windows 验证器会同时验证 `win-unpacked` 与静默安装的当前用户 NSIS 版本。它检查运行时没有符号链接、junction 或其他 reparse point；应用负载中的每个 PE 文件均为 x64；标准 NSIS 卸载程序是已安装根目录下唯一经过审查的 x86 PE，且 COFF machine 固定为 `0x014c`；应用、安装程序和卸载程序均为 `NotSigned`；回环 HTTP 与现有页面标题正常；第二次启动保留原后端；关闭窗口会移除所拥有的进程树和监听器；安装只创建开始菜单快捷方式；卸载会移除程序文件但保留 Harness 数据。

GitHub Windows Server 2025 工作流是自动打包门禁。首次发布 Windows 版本前，还必须在真实 Windows 11 x64 电脑上运行同一安装程序与验证器，并单独记录结果；Server 2025 CI 不能作为 Windows 11 验收证据。
