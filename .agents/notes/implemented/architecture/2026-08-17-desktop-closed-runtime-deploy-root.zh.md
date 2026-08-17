# Agent Note: Desktop 拥有封闭的运行时部署根

Status: implemented

[English](2026-08-17-desktop-closed-runtime-deploy-root.md) | 中文

## 问题

公开的 `@deepseek-ai/dsh` 清单描述可安装 CLI，而不是某个具体宿主提供的全部 peer。pnpm 注入式部署把工作区包物化为彼此隔离的包条目，因此组装后的 CLI 与 Web 插件图所使用的 peer 导入不能依赖开发检出的提升式 `node_modules`。如果把每个部署 peer 都加入公开 CLI，就会让一个 macOS 宿主的组合成为通用 CLI 包的一部分。

旧式部署不能形成独立替代方案：它的工作区符号链接解析回源码检出，而且会遗漏部分 Web 前端闭包。部署期间执行全部依赖生命周期脚本还会运行无关且被明确拒绝的脚本，而 macOS 子进程提供方只需要一个已审查的权限修复。

Web 组合会挂载 Cordis HMR。HMR 在 Electron 的内嵌 Node 运行时中需要访问 Node 内部 ESM loader，但 Electron 主进程和渲染器不需要这种访问。

## 决策

`apps/desktop/runtime/package.json` 是 macOS Desktop 应用的私有纯依赖工作区和部署根。它依赖 `@deepseek-ai/dsh`，并直接提供 CLI 与 Web 依赖图中可达的每个非可选工作区 peer。`scripts/verify-runtime-closure.ts --manifest apps/desktop/runtime/package.json` 遍历应用、包和 vendor 清单，拒绝任何缺失的必需 peer；Desktop 构建与暂存都会执行该检查。

暂存使用注入式工作区包部署 `@deepseek-ai/dsh-desktop-runtime`，并禁用依赖生命周期脚本。随后只执行已暂存的 `@deepseek-ai/dsh-subprocess-local` 权限修复，并针对目标 Electron 版本与架构运行 Electron rebuild。CLI 和前端路径通过以已部署运行时为根的包关系解析，每个已暂存符号链接的真实目标都必须留在运行时目录内。

只有在 `ELECTRON_RUN_AS_NODE=1` 时，Desktop Harness 后端子进程才会收到 `--expose-internals`。普通 Node 启动不会收到该参数。Electron 主进程参数和渲染器偏好保持不变；渲染器继续启用上下文隔离与沙箱，并禁用 Node 集成。

后端关闭只向自己创建的分离式负进程组 id 发送信号。已经观察到子进程退出时无需发送信号。只有当正数 leader pid 已消失时，EPERM 才表示进程组已不归当前进程所有或 id 已复用；leader 仍存活时的 EPERM 是清理失败。

## 曾考虑的替代方案

- **把完整闭包加入 `@deepseek-ai/dsh`**：否决，因为公开 CLI 会拥有一个 Desktop 部署所选择的依赖。
- **使用 pnpm 旧式部署**：否决，因为解析回源码检出的链接不可移植，而且 Web 前端闭包不完整。
- **在注入式部署期间允许依赖脚本**：否决，因为无关生命周期脚本仍被明确拒绝；只有已审查的子进程权限修复是必需的。
- **全局向 Electron 添加 `--expose-internals`**：否决，因为 HMR 在后端子进程中运行，主进程与渲染器不会从更广的内部 API 访问中获益。
- **忽略每个清理 EPERM**：否决，因为拥有的 leader 仍存活且进程组无法接收信号时，确实存在生命周期失败。

## 结果

- Desktop 运行时 peer 所有权明确且可机械验证为封闭，无需扩大公开 CLI 清单。
- 部署根按设计重复列出必需 peer；闭包验证器而不是逐个修复冒烟失败来负责保持清单新鲜。
- 已暂存原生兼容性由真实 Electron 加载与执行来验收。当闭包携带兼容的 darwin-arm64 N-API 预构建时，`electron-rebuild` 可以报告未发现模块。
- 运行时冒烟验证原生加载、CLI 版本、严格的回环 URL、HTTP 状态与标题、所拥有进程组的关闭、端口关闭，以及不存在解析回源码检出的符号链接。
