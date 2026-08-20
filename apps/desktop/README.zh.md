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

在 Windows 上，请运行 `DeepSeek Harness Setup <version>-x64.exe`。向导式 NSIS 安装程序默认为当前用户安装且不请求提权，允许选择安装目录，并会创建桌面和开始菜单快捷方式；安装完成后不会启动应用。随包分发的运行时完整保留（不剥离源码），在启用实时杀毒扫描的机器上，首次安装与冷启动仍可能需要几分钟，因为安装程序要写入数万个小文件。若希望加快安装与首次启动，可将安装目录（`%LOCALAPPDATA%\Programs\...`）与 Harness 数据目录（`%APPDATA%\DeepSeek Harness`）加入 Microsoft Defender 排除列表（Windows 安全中心 > 病毒和威胁防护 > 管理设置 > 排除项）。这只会关闭应用文件的实时扫描；请仅在可信的机器上使用。运行更新版本的安装程序即可更新。卸载会移除应用与快捷方式，但保留 Harness 用户数据。

Windows 个人构建有意保持未签名，因此 Microsoft Defender SmartScreen 可能显示「Windows 已保护你的电脑」。仅当安装程序来自你信任且已核验的来源时，才选择「仍要运行」；企业策略可能不提供该选项。请遵循 Microsoft 当前的 [SmartScreen 信誉指南](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)。请勿在系统范围内禁用 Microsoft Defender 或 SmartScreen。

应用会对照所配置 GitHub 仓库的 Releases（默认 `GZXiaoBai/deepseek-harness`、`stable` 频道）检查更新并就地升级。**Check for Updates…** 菜单项执行手动检查；**Automatic Updates** 开关控制启动时的自动检查。Windows 会下载 NSIS 安装程序，按 release 校验和验证 SHA-256 后，在退出时静默运行安装程序。macOS 会下载 DMG、验证后通过管理员授权把新 App 安装进 `/Applications`；由于个人构建是 ad-hoc 签名且未公证，安装副本会移除 quarantine 属性，Gatekeeper 仍可能要求首次启动时确认。更新偏好持久化在应用数据目录下的 `desktop-settings.json`。发布方式为打 `desktop-v<version>` 标签；标签工作流会构建两个平台并把安装程序、DMG 与按资产的校验和上传到 release。校验和不匹配会中止更新且不安装。

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

Windows 验证器会同时验证 `win-unpacked` 与静默安装的当前用户 NSIS 版本。它检查运行时没有符号链接、junction 或其他 reparse point；应用负载中的每个 PE 文件均为 x64；标准 NSIS 卸载程序是已安装根目录下唯一经过审查的 x86 PE，且 COFF machine 固定为 `0x014c`；应用、安装程序和卸载程序均为 `NotSigned`；随包原生文件夹弹窗 worker 会打开真实弹窗，并在验证器关闭弹窗后报告取消终态；回环 HTTP 与现有页面标题正常；第二次启动保留原后端；关闭窗口会移除所拥有的进程树和监听器；安装会创建开始菜单和桌面快捷方式；卸载会移除程序文件与快捷方式，但保留 Harness 数据。验证器还会记录静默安装耗时、静默卸载耗时与后端启动耗时（harness-starting 到 harness-ready），并把安装程序体积、应用文件数、字节总数与这三项耗时写入 `apps/desktop/release/verify-stats.json`，CI 工作流打印该文件作为安装与启动耗时的回归信号。

GitHub Windows Server 2025 工作流是自动打包门禁。首次发布 Windows 版本前，还必须在真实 Windows 11 x64 电脑上运行同一安装程序与验证器，并单独记录结果；Server 2025 CI 不能作为 Windows 11 验收证据。
