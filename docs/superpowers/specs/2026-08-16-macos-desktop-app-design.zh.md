# macOS 桌面应用设计

[English](2026-08-16-macos-desktop-app-design.md) | 中文

## 范围

本设计为 DeepSeek Harness 增加一个仅支持 Apple Silicon 和 macOS 14 及更高版本的独立桌面应用。第一版面向个人使用，保留现有 Web UI，不提供 Intel 构建、Apple 公证、自动更新或原生界面重写。

交付物包括可直接运行的 `DeepSeek Harness.app` 和可拖入 Applications 的 Apple Silicon DMG。应用必须包含 Electron、构建后的 `dsh` CLI、Web 前端和全部生产运行时依赖，不依赖源码目录、系统 Node.js、npm 或 pnpm。

## 工程位置

桌面应用位于 `apps/desktop`，作为 pnpm workspace 中的独立 Electron 包。该包只拥有桌面进程、窗口、打包配置、图标和桌面生命周期测试；现有 `apps/web` 继续拥有浏览器 UI，`apps/cli` 继续拥有 Harness 启动入口。

桌面应用不复制或分叉 Web UI。构建流程先产生仓库的 Host、Client 和 Web 产物，再为 `@deepseek-ai/dsh` 生成仅含生产依赖的可部署运行时目录，并将该目录作为未压缩资源放入 App bundle，以便子进程和原生模块从真实文件系统路径加载。

## 运行架构

Electron 主进程取得单实例锁；第二次启动只激活现有窗口。应用不引入第二套产品渲染器或 preload API；`BrowserWindow` 先显示无脚本的本地静态启动文档，再加载 Harness 提供的 loopback HTTP 地址。

主进程使用 App bundle 内的 Electron 可执行文件启动独立子进程，并设置 `ELECTRON_RUN_AS_NODE=1`，让该进程执行打包后的 `dsh` CLI。启动参数固定为 `web --host 127.0.0.1 --port 0`，由操作系统分配未占用端口，因此桌面应用可以与源码版默认的 `3080` 服务并存。

主进程只接受子进程输出中格式为 `dsh web: http://127.0.0.1:<port>` 的地址，随后以 HTTP 请求确认首页可访问。窗口在确认成功后加载该地址并结束启动状态；启动超时、子进程提前退出或健康检查失败均进入可恢复错误状态。

第一版将 Electron 窗口作为现有 browser HTTP carrier 的本机客户端，不实现 `file://` 加 IPC transport。实现必须同步更新 Web server 子系统文档，并用 Agent Note 记录该桌面封装与完整 Electron IPC host 的职责区别，避免两种运行架构共用一个含混的 Electron 约定。

## 数据与启动环境

桌面子进程的 `DSH_HOME` 固定为 `~/Library/Application Support/DeepSeek Harness`。Harness 的 profile、设置、凭据、会话和其他持久数据由现有服务写入该目录；替换 App bundle 不改变该目录。

从 Finder 启动时，桌面主进程只从用户登录 shell 补全 `PATH`，不导入其他 shell 环境变量。子进程继承修正后的 `PATH` 和 Electron 进程已有的环境，并由桌面主进程覆盖 `DSH_HOME`、`ELECTRON_RUN_AS_NODE` 及桌面启动所需的内部变量。Web UI 管理的 API Key 继续由 Harness 凭据服务保存，桌面层不读取或记录密钥。

桌面日志写入 `~/Library/Application Support/DeepSeek Harness/Logs`。日志包括主进程生命周期、子进程标准输出和标准错误、启动地址解析结果及退出状态，但不得输出凭据文件内容或环境变量值。

## 窗口与安全

主窗口使用现有 Web UI 的完整布局，默认窗口尺寸不小于 `1100 × 720`，并记录用户最后使用的窗口位置和尺寸。应用使用现有 Harness 图标生成 macOS `.icns`，菜单提供重新加载、打开日志目录和退出操作。

`BrowserWindow` 启用上下文隔离和 Chromium sandbox，禁用网页 Node.js 集成，不暴露 preload bridge。主窗口只允许在启动时确认的 loopback origin 内导航；HTTP 或 HTTPS 外部链接交给系统默认浏览器，`file:`、自定义 scheme、新窗口请求和其他导航均被拒绝。

## 生命周期与故障处理

关闭最后一个窗口或选择退出时，主进程先向它拥有的 Harness 子进程发送优雅终止信号并等待最多五秒。子进程未在期限内退出时，主进程终止该进程树；桌面应用不得关闭并非由自己启动的 `dsh` 或占用 `3080` 的其他进程。

启动失败时，窗口显示无脚本的本地静态错误文档，并由 Electron 原生对话框提供重试、打开日志目录和退出操作。重试必须先清理本次失败启动留下的子进程，再创建新的动态端口子进程。运行期间子进程意外退出时，窗口切换到同一错误文档，而不是保留无法连接的浏览器错误页面。

## 打包与分发

打包使用 Electron Builder 生成 `darwin-arm64` App 和 DMG。构建使用 ad-hoc 签名且不提交开发者证书；本机生成的产物可供个人使用，通过网络传输后 macOS Gatekeeper 可能要求首次右键打开。

第一版没有更新服务。更新流程重新构建或替换 `/Applications/DeepSeek Harness.app`，持久数据继续从 Application Support 目录读取。

## 验证

桌面单元测试覆盖 Harness URL 解析、允许的导航判定、单实例转交、启动超时和子进程退出状态。进程生命周期测试使用可控的假 CLI，验证重试前清理、五秒后的强制终止以及仅终止拥有的进程树。

打包验收在没有仓库 Node.js 路径的环境中启动构建出的 App，确认其自动分配 loopback 端口、返回 Harness 首页、显示现有 Web UI、聚焦第二次启动、持久保存设置，并在关闭最后一个窗口后释放端口且不留下 Harness 子进程。验收还将 App bundle 复制到仓库外再运行，以证明产物不依赖源码目录。

## 完成条件

- Apple Silicon Mac 可以从 App 或 DMG 启动 DeepSeek Harness，不需要另外安装 Node.js、npm 或 pnpm。
- App 显示与浏览器版相同的 Web UI，并能使用现有模型设置、工作区、会话和工具能力。
- 应用数据保存在标准 Application Support 目录，替换 App 后仍可使用。
- 重复启动不会产生第二个 Harness 后台，退出后不会残留由 App 创建的后台进程。
- 构建出的 App 在源码仓库之外通过独立启动验收。
