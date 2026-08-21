# DeepSeek Harness 桌面版

[English](README.md) | 中文

本包使用 Tauri 2 构建个人使用的 DeepSeek Harness 桌面应用，支持搭载 macOS 14 或更高版本的 Apple Silicon Mac 与 Windows 11 x64 电脑。原生外壳保留现有 Web UI，并以 Node 24 单文件 sidecar 运行 Harness Web 后端，只监听私有的 `http://127.0.0.1:<ephemeral-port>/` 来源。[Tauri 与 sidecar 决策](../../.agents/notes/implemented/architecture/2026-08-21-tauri-desktop-sidecar.zh.md)负责运行时划分；Electron 的 [macOS](../../.agents/notes/implemented/feature/2026-08-16-macos-desktop-app.zh.md)、[Windows](../../.agents/notes/implemented/feature/2026-08-17-windows-desktop-app.zh.md)和[封闭运行时](../../.agents/notes/implemented/architecture/2026-08-17-desktop-closed-runtime-deploy-root.zh.md)记录在最终 Windows 验收完成、回退实现删除前仍然有效。

## 支持目标与构建

`pnpm run package:desktop:tauri` 只构建当前宿主的原生目标。请在 Apple Silicon Mac 或 Windows 11 x64 电脑上从仓库根目录运行。交叉打包、Wine、Intel Mac、Windows ARM64、MSIX、Windows Authenticode 签名、Apple Developer ID 签名和公证均不受支持。

| 宿主 | 输出 |
| --- | --- |
| 搭载 Apple Silicon 的 macOS 14+ | `apps/desktop/release-tauri/DeepSeek Harness.app` 与 `DeepSeek Harness-<version>-arm64.dmg` |
| Windows 11 x64 | `apps/desktop/release-tauri/win-unpacked` 与 `DeepSeek Harness Setup <version>-x64.exe` |

sidecar 把 Web 后端、内置插件和 Web 资源嵌入 VFS；目标平台专用的 `node-pty`、ripgrep 和进程辅助程序仍是普通 sidecar 文件。安装包不包含开发用 TypeScript、source map、测试或文档。第三方插件保留在用户 Harness profile 的磁盘目录中，可以加载自己的私有依赖，并共享打包后的 Cordis 与 Harness Service Definition 单例。

## 安装与更新

在 macOS 上，请打开 DMG，再将 `DeepSeek Harness.app` 复制到 `/Applications`。个人构建使用带 Hardened Runtime 的 ad-hoc 签名，但未经公证。如果 Gatekeeper 阻止首次启动，请按照 Apple 的[打开来自身份不明开发者的 Mac App](https://support.apple.com/guide/mac-help/mh40616/mac)说明操作；不要全局关闭 Gatekeeper。

在 Windows 上，请运行 `DeepSeek Harness Setup <version>-x64.exe`。一键式 NSIS 安装程序按当前用户安装，不申请提权；它创建开始菜单快捷方式，不创建桌面快捷方式，安装结束后不自动启动。程序使用 Windows 11 自带的系统 WebView2，不要求开发者模式。个人构建有意保持未签名，因此 SmartScreen 在文件建立信誉前可能警告。只有确认安装程序来自预期 Release 后才继续；不要关闭 Defender 或 SmartScreen。参见微软的 [SmartScreen 信誉说明](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)。

Harness 菜单可以手工检查更新或切换自动检查。Release 会发布 NSIS 安装程序、macOS 更新归档、`.sig` 文件、`latest.json`、DMG 与 SHA-256 文件。Tauri 使用 `tauri.conf.json` 中的公钥验证每个更新，签名私钥只存在于发布密钥中。未签名或被修改的更新会被拒绝，这项校验独立于操作系统代码签名。

## 数据与日志

应用继续使用原有数据位置：

- macOS：`~/Library/Application Support/DeepSeek Harness`
- Windows：`%APPDATA%\DeepSeek Harness`

Harness 数据位于 `Harness/`，桌面日志在 `Logs/desktop.log` 下轮转，性能统计写入 `Logs/desktop-performance.json`，设置继续保存在 `desktop-settings.json`。替换或卸载应用会保留此目录；删除此目录会重置 Desktop 与 Harness 状态。

原生外壳会立即显示内置启动页，只接受 sidecar 报告的精确回环来源，拒绝弹窗和非预期顶层导航，也不向 Web UI 开放 Tauri shell、文件系统或通用 invoke API。第二次启动只聚焦现有窗口。在 Windows 上，点击窗口关闭按钮会保存窗口状态并隐藏到系统托盘；点击托盘图标或选择 **Show DeepSeek Harness** 可恢复窗口，选择托盘菜单中的 **Exit** 才会退出程序。退出时先通过协议请求 Harness dispose 并等待完成；Windows Job Object 与 macOS 进程组仅作为超时兜底。macOS 保持正常的窗口关闭行为。

## 验证

可在任一宿主运行行为测试与 Rust 测试，再在目标宿主构建和验证原生包：

```sh
pnpm run test:desktop
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm run package:desktop:tauri
pnpm --filter @deepseek-ai/dsh-desktop run verify:tauri:macos
# Windows: pnpm --filter @deepseek-ai/dsh-desktop run verify:tauri:windows
```

Windows Server 2025 工作流会验证当前用户静默安装与卸载、快捷方式位置、零 reparse point、x64 PE 负载、预期未签名状态、严格回环启动、所有声明的客户端 bundle、profile 初始化、原生目录选择请求、内置 Agent preset、单实例归属、关闭到托盘行为、关闭清理、数据保留、文件与体积限制以及 CI 时间限制。协议测试会保留包含中文和空格的路径，发布工作流还会证明原始更新包验签成功，而修改一个字节后的包验签失败。正式发布前，必须在开启 Defender 且未设置排除项的真实 Windows 11 x64 电脑上运行同一安装验收，并实际选择包含中文和空格的目录；Server 2025 不能替代 Windows 11 实机结果。
