# Agent Note: 在嵌入式运行时之外运行 office 引擎

Status: implemented

[English](2026-09-18-desktop-office-engine-outside-the-embedded-runtime.md) | 中文

## 问题

[Tauri sidecar 决策](2026-08-21-tauri-desktop-sidecar.zh.md)负责嵌入式运行时及其相邻文件规则；本记录补充 office 转换所需的 package 暂存。

Web profile 会挂载 `@deepseek-ai/dsh-office-to-pdf`，它通过 `@deepseek-ai/libreoffice-kit` 转换文档。kit 在调用时解析平台引擎包，并把引擎作为子进程启动。打包后的 sidecar 把运行时放在嵌入式文件系统里，该文件系统只为构建时注入的 package 清单提供模块解析；同时嵌入文件无法启动引擎可执行文件。把引擎嵌入可执行文件还会让同一份约 260 MB 的负载重复出现，而验收预算覆盖整个软件包。

## 决策

sidecar 构建把 kit API、它的平台引擎以及两者之间所有已安装的生产依赖暂存到 `apps/desktop/src-tauri/resources/libreoffice/node_modules/`，并在旁边写入 `staged-packages.json`。外壳把该目录作为 `DSH_DESKTOP_REAL_PACKAGES_ROOT` 传入，sidecar 的解析 hook 会在嵌入式运行时之前，按记录从真实文件系统提供这些 package 的入口与子路径，因此 kit 自身的引擎查找会在相邻的引擎包上解析。两个 package 都会在组装可执行文件之前从暂存运行时中移除，因此嵌入式清单不再声明它们，引擎只保存一份。两个目标的打包文件数与字节预算都覆盖暂存的引擎。

## 考虑过的替代方案

**把引擎嵌入可执行文件。** 引擎可执行文件无法从嵌入文件启动，重复的一份还会让打包负载翻倍。

**通过 harness 的 closed-runtime 解析器解析引擎包。** 该解析器只服务挂载 profile 树内的 Cordis 插件导入，无法应答已安装 npm package 发起的 `require.resolve`。

## 结果

office 转换路径只在外壳启动 sidecar 之后才会被使用，因此独立的 SEA 可行性探针从不加载它。缺少引擎包或目标不受支持时，现在会在 sidecar 构建阶段失败，而不是等到打包应用首次转换时才报错。
