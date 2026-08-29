# Agent Note：允许 deploy 子集存在未使用的 patch

Status: implemented

[English](2026-08-29-allow-unused-patches.md) | 中文

## 问题

Python runtime 闭包的 `pnpm deploy --legacy --prod` 在所有 release 形态的 CI 平台上都以 `ERR_PNPM_UNUSED_PATCH` 失败：workspace 级的 `@electron/osx-sign@1.3.3` patch 只被桌面包的 Electron 打包 devDependencies 消费，而闭包的生产依赖子集永远不会匹配该 patch 键。闭包部署在结构上用不到这个 patch，而 workspace 全量安装每次都用得到全部 patch。

## 决策

`pnpm-workspace.yaml` 设置 `allowUnusedPatches: true`，让目标包不在当前安装或部署子集中的 patch 降级为警告而不是使命令失败。patch 在目标存在的地方仍然生效——部署后的闭包保留打了补丁的 `node-pty` 构建（已通过部署树中存留的 `DSH_NODE_PTY_SPAWN_HELPER` 标记验证）。

## 备选方案

- 移除 osx-sign patch：拒绝；在 Tauri 实现完全取代 Electron 路径之前，桌面 Electron mac 打包仍依赖有界二进制检查。
- 放弃 `--legacy` 部署：拒绝；Python runtime 打包的提升（hoisting）、链接物化和无符号链接负载等不变式都建立在 legacy deploy 实现之上。
- 把 `electron-builder` 复制进闭包：拒绝；打包后的 Python runtime 不应携带桌面构建工具链。

## 后果

真正过期的 patch——例如未来升级 `node-pty` 版本而没同步更新 patch 键——现在在安装和部署时只会产生警告。lockfile 通过 patch hash 固定每个被打补丁的包，CI 会从源码重建 `node-pty` addon，因此悄悄丢失补丁的构建会在依赖这些补丁行为的打包步骤中暴露出来，而不是在依赖解析阶段。
