# Agent Note: Desktop 拥有封闭的运行时部署根

Status: implemented

[English](2026-08-17-desktop-closed-runtime-deploy-root.md) | 中文

## 问题

公开的 `@deepseek-ai/dsh` 清单描述可安装 CLI，而不是某个具体宿主提供的全部 peer。pnpm 部署会在开发布局之外物化工作区包，因此组装后的 CLI 与 Web 插件图所使用的 peer 导入不能依赖源码检出根目录的 `node_modules`。如果把每个部署 peer 都加入公开 CLI，就会让一个 Desktop 宿主的组合成为通用 CLI 包的一部分。

旧式部署不能形成独立的 macOS 替代方案：它的工作区符号链接解析回源码检出，而且会遗漏部分 Web 前端闭包。部署期间执行全部依赖生命周期脚本还会运行无关且被明确拒绝的脚本，而子进程提供方只需要一个已审查的权限修复。Windows 还需要提升式且不含链接的运行时，因为已安装应用不能依赖开发者模式、管理员创建的链接或源码检出。

Web 组合会挂载 Cordis HMR。HMR 在 Electron 的内嵌 Node 运行时中需要访问 Node 内部 ESM loader，但 Electron 主进程和渲染器不需要这种访问。

## 决策

`apps/desktop/runtime/package.json` 是两个受支持 Desktop 目标共用的私有纯依赖工作区和部署根。它依赖 `@deepseek-ai/dsh`，并直接提供 CLI 与 Web 依赖图中可达的每个非可选工作区 peer。`scripts/verify-runtime-closure.ts --manifest apps/desktop/runtime/package.json` 遍历应用、包和 vendor 清单，拒绝任何缺失的必需 peer；Desktop 构建与暂存都会执行该检查。

暂存使用冻结锁文件和注入式工作区包部署 `@deepseek-ai/dsh-desktop-runtime`，并禁用依赖生命周期脚本。macOS 保留已包含的 pnpm 链接；Windows 使用提升式 linker，并拒绝每个符号链接、junction 或其他 reparse point。在执行已暂存代码前，暂存会要求 `@deepseek-ai/dsh-subprocess-local` 权限修复是运行时内部的常规文件而不是链接。它只执行该修复，针对原生平台与架构运行 Electron rebuild，裁剪不受支持的 `node-pty` 预构建，并在已暂存内容发生变更后重复执行平台包含性审计。CLI 和前端路径通过以已部署运行时为根的包关系解析。

只有在 `ELECTRON_RUN_AS_NODE=1` 时，Desktop Harness 后端子进程才会收到 `--expose-internals`。普通 Node 启动不会收到该参数。Electron 主进程参数和渲染器偏好保持不变；渲染器继续启用上下文隔离与沙箱，并禁用 Node 集成。

独立运行时验证的关闭流程只向验证器创建的分离式负进程组 id 发送信号。在任何进程组信号成功前，已经观察到 leader 退出时无需发送信号；正数 leader pid 已消失时，EPERM 可以证明进程组已不归验证器所有。负进程组信号一旦成功，leader 退出不会结束所有权：验证流程会继续探测负进程组 id 并升级信号，直到操作系统返回 ESRCH。所有权建立后的 EPERM 是验证清理失败。

## 曾考虑的替代方案

- **把完整闭包加入 `@deepseek-ai/dsh`**：否决，因为公开 CLI 会拥有一个 Desktop 部署所选择的依赖。
- **使用 pnpm 旧式部署**：否决，因为解析回源码检出的链接不可移植，而且 Web 前端闭包不完整。
- **在注入式部署期间允许依赖脚本**：否决，因为无关生命周期脚本仍被明确拒绝；只有已审查的子进程权限修复是必需的。
- **全局向 Electron 添加 `--expose-internals`**：否决，因为 HMR 在后端子进程中运行，主进程与渲染器不会从更广的内部 API 访问中获益。
- **忽略每个验证清理 EPERM**：否决，因为拥有的 leader 仍存活且进程组无法接收信号时，确实存在验证失败。

## 结果

- Desktop 运行时 peer 所有权明确且可机械验证为封闭，无需扩大公开 CLI 清单。
- 部署根按设计重复列出必需 peer；闭包验证器而不是逐个修复冒烟失败来负责保持清单新鲜。
- 已暂存原生兼容性由真实 Electron 加载与执行来验收。当闭包携带兼容的目标预构建时，`electron-rebuild` 可以报告未发现模块。
- 运行时冒烟验证原生加载、CLI 版本、严格的回环 URL、HTTP 状态与标题、目标特定的所拥有进程树关闭、已关闭端口拒绝 TCP 连接，以及平台链接策略。macOS 审计 arm64 Mach-O 对象；Windows 审计 x64 PE 对象，并要求运行时不含链接。
