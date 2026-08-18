# Agent Note: 将 Desktop 包装层扩展到 Windows x64

Status: implemented

[English](2026-08-17-windows-desktop-app.md) | 中文

## 问题

Windows 11 用户需要与 Apple Silicon 包相同的个人使用 DeepSeek Harness 应用体验，同时不能创建第二套渲染器、Host/Web 组合或生命周期实现。已安装运行时必须能供标准当前用户使用，不依赖管理员权限、开发者模式、源码检出链接或开发工具链。

## 决策

`@deepseek-ai/dsh-desktop` 有两个显式原生目标：`darwin-arm64` 与 `win32-x64`。其他所有平台与架构都会被拒绝。Windows 目标复用 [macOS 桌面决策](2026-08-16-macos-desktop-app.md)定义的现有 Electron 主进程、BrowserWindow 安全偏好、导航策略、原生编辑快捷键、窗口状态、严格回环 Web UI、单实例交接、启动恢复和 `userData/Harness` 数据分离。打包只在匹配的原生宿主上运行；不支持 macOS 到 Windows 的交叉打包或 Wine。

Windows 不通过 shell 启动 Harness 后端，并设置 `detached: false` 与 `windowsHide: true`。Desktop 控制器只拥有自己创建的根进程及其后代树。关闭时会调用 `taskkill.exe /PID <pid> /T /F`，等待进程与监听器消失，并保留可见的清理失败。只有在清理开始前已经观察到根进程退出时，才会跳过该命令；已调用命令返回的错误仍属于清理失败，即使根进程同时退出也不例外。清理失败永远不会覆盖更早的启动诊断。

## 运行时与安装程序边界

共享的[封闭运行时部署根](../architecture/2026-08-17-desktop-closed-runtime-deploy-root.md)仍是依赖真源。Windows 暂存使用 pnpm 提升式 linker 和注入式工作区包，禁用依赖生命周期脚本，运行唯一已审查的子进程修复，针对 `win32-x64` 重建，并只保留 `node-pty/prebuilds/win32-x64`。最终运行时不得包含符号链接、junction 或其他 reparse point。所有 PE 文件都会被直接解析，且必须声明 COFF machine `0x8664`；CLI、Web 前端、配置、ConPTY、koffi 与回环 Web 启动都会在 Electron 下实际执行。

Electron Builder 生成 `win-unpacked` 与 `DeepSeek Harness Setup <version>-x64.exe`。暂存会在打包前从运行时剔除 TypeScript 源码、source map 与重建残留，安装文件数大致减半；向导式 NSIS 安装程序默认按用户安装、禁止提权、允许选择安装目录、会创建桌面和开始菜单快捷方式、安装后不运行应用，并在卸载时保留应用数据。标准 NSIS 卸载程序是已安装根目录中唯一经过审查的 x86 PE；验证要求其精确路径、COFF machine `0x014c` 和未签名状态，同时每个应用负载 PE 均保持 x64。个人包有意保持未签名且没有更新器；证书、MSIX、Windows ARM64 与自动更新基础设施仍不属于本决策范围。

## 验证

行为测试固定了目标解析、Windows 启动参数、`taskkill.exe` 失败语义、提升式暂存、预构建裁剪、PE 解析、afterPack 目标、ICO 生成、NSIS 配置和工作流策略。原生 Windows 验证器会同时检查未打包目录与静默安装的 NSIS 版本，覆盖无链接包含性、x64 应用负载、精确的 NSIS 卸载程序例外、预期 `NotSigned` 状态、自动关闭后报告取消终态的随包原生文件夹弹窗、仓库外启动、严格回环 HTTP 与页面标题、隔离的 Harness profile 初始化、第二实例后端身份、窗口关闭后的进程树与端口清理、快捷方式位置、卸载清理及 Harness 数据保留。验证器还会记录静默安装耗时，并把安装程序体积、应用文件数与字节总数写入 `apps/desktop/release/verify-stats.json`，作为安装耗时的回归信号。

拉取请求与手动 Windows Desktop 工作流会在现有 Windows Server 2025 x64 runner 上运行该验证器，并保留安装程序 14 天。这属于自动 Windows 打包证据，而不是 Windows 11 兼容性证据。首次发布前，必须在真实 Windows 11 x64 电脑上运行同一安装与验收脚本，并单独记录结果。

## 曾考虑的替代方案

**构建独立的 Windows 桌面应用。** 这会重复渲染器、安全和生命周期行为，并让两个平台发生漂移。目标适配器让共享行为保留在一个应用中。

**在 Windows 上使用 POSIX 风格的分离式进程组。** Windows 不提供相同的负进程组信号契约。无 shell 的 `taskkill.exe /T /F` 操作符合选定的所有权边界，并会覆盖后代进程。

**交付 pnpm 链接并要求开发者模式。** 这会让安装依赖机器策略或管理员创建的文件系统对象。因此 Windows 运行时采用提升式布局且不含链接。

**从 macOS 交叉打包 Windows。** 交叉打包无法提供原生重建，也无法提供真实 ConPTY、PE、安装程序、启动与卸载证据。Windows 产物会在 Windows 上构建和验收。

## 结果

现有 Web UI 与 Desktop 行为现在拥有一套共享实现和显式平台适配器。Windows 包比链接式 pnpm 树更大，但可供标准用户移植使用，并会机械拒绝链接与非 x64 应用负载；精确的标准 NSIS x86 卸载程序仍是打包工具例外。未签名个人安装程序可能触发 Microsoft Defender SmartScreen，也可能被企业策略阻止；不能指导用户在系统范围内禁用保护。Windows Server CI 与 Windows 11 发布验收仍是两种不同证据。
