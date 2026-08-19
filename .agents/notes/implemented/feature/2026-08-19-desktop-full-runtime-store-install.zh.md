# Agent Note: 发布完整 Desktop 运行时并以纯复制方式安装

Status: implemented

[English](2026-08-19-desktop-full-runtime-store-install.md) | 中文

## 问题

Desktop 安装器的静默安装在 CI 上耗时数分钟。此前的载荷裁剪尝试从暂存运行时中剔除仅用于开发的文件（TypeScript 源码、源码映射、重建残留），但所有者决定应用必须携带完整运行时，安装与卸载速度应来自打包机制而非删除内容。

## 决策

暂存不再删除任何运行时文件：`pruneRuntimeSources` 及其入口校验门已移除，暂存闭包携带每个已发布文件（0.1.0-rc.7 在 macOS 上为 31,210 个文件、293 MB）。node-pty 保留全部平台 prebuild 与 ConPTY 资产；arm64 Mach-O 与 x64 PE 审计现在通过 `ignoredRelativePaths` 跳过 node-pty 包目录（该包合法携带所有平台的二进制），而 `validateNodePtyPrebuild` 仍要求目标平台的运行时文件，使打包回归在暂存期即失败。Windows 安装器以 `compression: store` 构建，NSIS 直接写文件而非单线程 LZMA 解压；自动更新仍通过 NSIS blockmap 只下载变化块。Windows 验证器现在同样计时静默卸载，并在 `verify-stats.json` 中报告 `uninstallMs`。

早先基于 asar 的单文件载荷因 Node 解析原因被否决；该证据随[载荷裁剪记录](../../archived/feature/2026-08-18-desktop-runtime-payload-trim.md)一并归档。

## 备选方案

**继续裁剪。** 所有者否决：运行时完整发布，提速工作留在打包机制内。

**改用 MSIX。** 系统级安装免去 NSIS 解压与提权，但需要长期稳定的签名身份、重写应用内更新链路（安装目录只读），并需将 pnpm 链接布局拍平；推迟到存在商店分发形态时再议。

## 影响

安装器膨胀到接近完整应用体积（无载荷压缩），但安装变为纯文件复制，卸载耗时每次构建都有测量。架构审计仍覆盖 node-pty 包之外的所有二进制；若未来 node-pty 版本在目标平台目录放入错误架构的二进制，`validateNodePtyPrebuild` 文件校验与运行时冒烟会失败。
