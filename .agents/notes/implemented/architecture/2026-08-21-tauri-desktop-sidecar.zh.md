# Agent Note: 使用单文件 Node sidecar 的 Tauri 桌面外壳

Status: implemented

[English](2026-08-21-tauri-desktop-sidecar.md) | 中文

## Problem

Electron 桌面包在 Windows 上安装超过 32,000 个文件，总体积约 610 MB。Defender 对每个文件的扫描使清洁安装耗时约 220 秒，随包 Chromium 进程也增加了冷启动成本。必须保留 Web 组合、原生模块和从磁盘加载的第三方插件，因此不能把后端改写为 Rust 实现。

## Decision

Tauri 2 负责原生窗口、菜单、导航策略、单实例聚焦、窗口状态、更新、目录对话框和后端进程监管。现有 Web UI 保持不变，不获得 Tauri shell、文件系统或通用 invoke 权限。窗口先显示内置的无脚本启动页，只在后端报告 `http://127.0.0.1:<port>/` 或带认证的 `http://127.0.0.1:<port>/?token=<URL-safe-token>` 格式后导航；空 token、重复参数和附加查询参数都会被拒绝。非预期导航和所有弹窗都会被拒绝，非回环 HTTP(S) 链接则交给系统浏览器。

`@yao-pkg/pkg --sea` 把 Node 24 Web 后端、内置插件、配置和 Web 静态资源打进一个目标平台专用的可执行文件。目标原生的 `node-pty`、ripgrep 与 macOS spawn helper 仍是相邻的普通二进制文件。sidecar 排除开发源码、source map、测试和文档。桌面专用 overlay 与 worker 输入不列入 npm 包文件清单，而是在 pkg 捕获 VFS 前显式复制到部署闭包。启动时的模块解析 hook 把打包后的 Cordis 与 Harness Service Definition peer 映射到 VFS 单例，同时允许 profile 插件及其私有依赖从磁盘解析；打包 profile 不会创建指向 VFS 的链接。客户端模块发现过程通过每个活动 Loader 配置项所属的树解析包 metadata，其中也包括嵌入式 VFS hook。桌面启动器从打包的 `@deepseek-ai/dsh` manifest 推导随附 Agent preset 根目录，而不依赖导入模块的 `import.meta.url`；pkg 会把后者报告为 SEA 入口 URL。preset 发现过程先枚举子项名称，再分别执行 stat，因为 pkg VFS 不提供完整的 Node `Dirent` 方法。

版本化行协议在 stdout 使用 `DSH_DESKTOP/1 ` 前缀。JSON 事件报告启动阶段、就绪、致命错误、停止和原生目录对话框请求；stdin 传递 shutdown 与对话框结果。没有前缀的输出只作为插件日志，不能被识别为控制消息。桌面 profile 使用 Tauri provider 替换 adaptive host picker，并显式保留负责渲染工作区操作、调用该 provider 的原生目录选择客户端模块。因此两个目标的目录选择都使用 Tauri 对话框，不再执行曾导致文件夹选择进程退出的 Koffi Win32 dialog worker。

Windows 先以挂起状态创建 sidecar，把它加入设置了 `KILL_ON_JOB_CLOSE` 的 Job Object，再恢复执行。macOS 为它分配独立 POSIX 进程组。在 Windows 上，主窗口关闭请求会保存窗口状态并隐藏窗口，由托盘图标继续持有应用；点击托盘图标或其中的 Show 项会恢复并聚焦窗口，Exit 项则开始关闭。macOS 窗口关闭与 Windows 托盘 Exit 都会发送 `shutdown`，等待 Harness dispose 与 `stopped`，并记录强制终止次数；只有超时才使用操作系统进程所有权兜底。桌面日志会轮转，性能数据记录进程启动、sidecar spawn、插件树就绪、HTTP 就绪、页面加载、关闭和强制终止。

自动更新检查只在第一个 Harness 页面完成加载后启动一次，避免外部网络延迟与受测启动路径争用资源。Harness 菜单中的手工更新检查仍可立即使用。

Tauri NSIS 包按当前用户安装，不提权，使用 Windows 11 系统 WebView2，只创建开始菜单快捷方式，并在卸载时保留 `%APPDATA%\DeepSeek Harness`。macOS 包只支持 Apple Silicon，使用带 Hardened Runtime 的 ad-hoc 签名，但不公证。两个目标都复用 Electron 数据目录和设置。Tauri 更新包使用独立 minisign 密钥签名；公钥随配置交付，私钥只存在于发布密钥。应用代码签名与更新签名相互独立，个人 Windows 构建继续保持未签名。

Electron 实现在 Windows Server 2025 CI 与真实 Windows 11 x64 电脑通过同一套安装、目录选择、启动和关闭验收前仍可使用。它的 [macOS](../feature/2026-08-16-macos-desktop-app.zh.md)、[Windows](../feature/2026-08-17-windows-desktop-app.zh.md)、[更新器](../feature/2026-08-18-desktop-updater.zh.md)和[封闭运行时](2026-08-17-desktop-closed-runtime-deploy-root.zh.md)决策记录了建立功能对等后才会删除的回退实现。

## Alternatives considered

**继续优化 Electron 依赖树。** 不采用，因为完整 Node 运行时仍产生数万个文件并携带 Chromium；Defender 安装成本来自负载结构，而不只是压缩字节数。

**使用 Rust 重写 Harness 后端。** 不采用，因为这会重复实现插件 host、Cordis 生命周期、Node 原生模块和第三方插件生态，而不是保留现有应用。

**在 Tauri 旁边部署多文件 Node 运行时。** 不采用，因为它会保留 Windows 逐文件扫描瓶颈，并重新引入单文件方案已经消除的链接与依赖闭包安装问题。

**直接向远程 Web UI 开放 Tauri 命令。** 不采用，因为回环页面是网络来源；高权限文件系统与 shell 访问继续由现有 Harness RPC capability 和窄化的 sidecar 对话框协议负责。

## Consequences

安装后的应用只含少量普通目标原生文件，不再携带 Node 依赖树或 Chromium 分发。实测 Apple Silicon App 包含 7 个文件和 238,907,293 字节；打包应用的清洁启动在 1.8 秒内完成页面加载，并且关闭时不需要强制终止。Windows 原生 CI 限制仍为 500 个文件、250 MB、安装 60 秒和首次页面加载 10 秒；真实 Windows 11 在开启 Defender 且未设排除项时的发布限制仍为安装 30 秒、冷启动 6 秒和热启动 3 秒。

sidecar 构建依赖 pkg 的 VFS 行为和显式 packaged-module 清单。原生打包前，真实可行性探针会执行 node-pty、worker thread、Koffi、Web 启动、带打包 peer 的外部磁盘插件以及优雅关闭。安装包验收会审计目标架构、链接包含性、签名、数据隔离、单实例行为、目录选择、关闭到托盘行为、进程清理和更新篡改拒绝。Server 2025 job 会安装微软官方 Evergreen WebView2 bootstrapper 作为 runner 准备；这不会改变应用负载，应用仍使用 Windows 11 系统运行时。启动验收会解析服务端提供的 `__DSH_BOOT__` 图，拒绝空图，要求 client-modules parser bootstrap，要求设置、Agent preset 和原生目录选择客户端条目，并请求所有声明的 bundle。随后它调用打包后的 `agentPreset.list`，创建路径包含中文与空格的工作区，再使用随附的 `standard` preset 创建会话。Windows 验证器还会调用 `host.pickDirectory`，要求出现版本化 sidecar 请求，关闭 Tauri 持有的文件夹对话框，并要求得到成功的取消结果；这样，直接调用 `workspace.create` 就不能掩盖错误的目录选择 provider。仅有 WebView load 事件并不足够，因为内核也可能渲染插件加载失败页面，或显示一个无法组装首个会话的外壳。Server 2025 结果不能替代真实 Windows 11 发布验收。
