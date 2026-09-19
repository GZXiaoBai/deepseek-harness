# Agent Note: 引入 macOS 桌面包装层

Status: implemented

[English](2026-08-16-macos-desktop-app.md) | 中文

## 问题

DeepSeek Harness 通过 Host/Web 组合提供浏览器界面。希望获得应用程序包的 macOS 用户需要原生启动器，同时不能重复实现 host 组合、静态资源服务、浏览器协议处理或现有 Web UI。

## 决策

`@deepseek-ai/dsh-desktop` 是一个面向搭载 macOS 14 或更高版本的 Apple Silicon Mac 的 Electron 包装层。它使用固定的 `web --host 127.0.0.1 --port 0` 参数，把已暂存的 `@deepseek-ai/dsh` CLI（命令行界面）作为一个分离式后端进程启动，等待获得严格的回环 URL 与 HTTP 健康响应，再在应用窗口中打开同一来源。`@deepseek-ai/dsh-host-webserver` 按[已归档的 GUI 分层决策](../../archived/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)继续拥有 HTTP 服务、API 路由、前端交付以及浏览器可见启动职责。

[Windows 桌面决策](2026-08-17-windows-desktop-app.zh.md)复用这个包装层及其 Web、渲染器、导航、数据分离与单实例边界，只替换目标特定的进程树、暂存、二进制审计和安装程序行为。

采用 `file://` 且由 IPC 支持 host 的应用仍属于一套独立架构。它必须替代 HTTP 服务器的资源、请求、生命周期和安全职责，才能替代回环 HTTP；两种传输方式并非别名关系。

## 安全与运行时边界

渲染器启用上下文隔离和沙箱，禁用 Node 集成，也没有 preload API。仅精确的随包无脚本启动文档和错误文档是 `file://` 顶层例外。Harness 内容仅限已确认的 `http://127.0.0.1:<ephemeral-port>` 来源：允许同源导航，其他 HTTP 和 HTTPS 目标在外部打开，其他所有 scheme 或格式错误的 URL 都会被拒绝。登录 shell 只提供 `PATH`；它的其他环境值既不导入，也不记录。

Desktop 应用只拥有自己创建的分离式进程组。退出、重试、应用信号和意外退出共用一个关闭屏障：所拥有的进程组先收到 `SIGTERM`，可在 5 秒内退出，否则会收到 `SIGKILL`。应用既不发现，也不向无关 Harness 进程发送信号。

打包后端使用[封闭运行时决策](../architecture/2026-08-17-desktop-closed-runtime-deploy-root.zh.md)所述的私有已验证依赖部署。打包目标固定为 `darwin-arm64`，会拒绝其他所有宿主目标、审计所有 Mach-O 文件是否为 arm64，从已暂存运行时中剔除源码与 source map，并在签名前把已包含的运行时复制到 App 内。所有交付的代码对象均使用带 Hardened Runtime 的 ad-hoc 签名；原生模块只会收到已审查的 JIT、未签名可执行内存和库验证 entitlements。此个人构建未经公证；更新来自[桌面更新器决策](2026-08-18-desktop-updater.zh.md)。

## 数据与生命周期边界

Electron 拥有 `~/Library/Application Support/DeepSeek Harness`，包括 `window-state.json`、`Logs/desktop.log` 和它的单实例文件。后端收到作为独立 `Harness/` 子树的 `DSH_HOME`，因此 Harness 文件监视器不会观察到 Electron 的单实例 socket。替换 App 时，Desktop 和 Harness 数据都会保持不变。

应用会强制一个 Electron 实例与一个后端。第二次启动只会聚焦现有窗口，不会启动另一个后端。可恢复的启动失败会留在一个无脚本的本地文档中，并提供重试、打开日志目录或退出选项。致命初始化或控制器启动失败的原始错误会先被记录；如果控制器已创建，应用会尝试并等待其关闭。清理失败会另行报告，此时不能保证后端终止。Electron 仍会以状态码 1 退出并释放单实例锁。

## 验证

行为测试固定了 URL 解析与导航、渲染器偏好、单实例启动、重试、进程组所有权、关闭竞态、数据根目录分离、运行时闭包、暂存包含性、arm64 二进制文件和打包配置。真实打包验收会全面验证发布 App，将它复制到仓库外，重新验证该副本，并仅启动这个副本。该启动会验证通过 HTTP 提供的现有 Web UI、第二次启动后不变的后端身份、Harness 子树与 Web profile 已初始化并与 Electron userData 隔离，以及退出后已关闭的 TCP 端口和进程组。已挂载的 DMG App 会接受完整的静态应用包包含性、arm64、签名和 entitlements 验证，但不会被启动。

## 曾考虑的替代方案

**立即使用 `file://` 加载 Web 前端。** 这可以移除本地监听器，但需要新的 IPC API 和安全的资源加载模型，同时会改变已建立的 Host/Web 请求路径。桌面包装层保留了该路径。

**将 Host/Web 逻辑直接嵌入 Electron。** 这会让 Electron 拥有已由 `@deepseek-ai/dsh-host-webserver` 负责的组合和启动行为，形成两套需要保持一致的实现。

## 结果

应用在自包含 App 与 DMG 中保留现有 Web UI 和 Host/Web 行为，回环监听器、后端生命周期、封闭运行时与 macOS 签名则成为 Desktop 拥有的职责。分发方式有意保持个人用途：因为 ad-hoc 构建未经公证，Gatekeeper 可能要求显式允许首次启动，应用内更新安装新下载的副本之后同样如此。Electron 原生 IPC host 仍可实现，但它需要新的传输决策，不能通过增量重解本决策来完成。
