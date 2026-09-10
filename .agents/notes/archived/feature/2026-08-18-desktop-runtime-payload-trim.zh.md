# Agent Note: 精简并度量 Desktop 运行时载荷

Status: implemented
Archived: 2026-08-19

[English](2026-08-18-desktop-runtime-payload-trim.md) | 中文

## 问题

Desktop 安装程序把已暂存运行时写成数万个小文件（0.1.0-rc.5 的 macOS 运行时实测 31,408 个文件、329 MB）。在 Windows 上，NSIS 解压加上杀毒软件对每个新建文件的实时扫描，让安装耗时长达数分钟到数十分钟，首次启动也会因同样的逐文件扫描而变慢。安装过程也没有任何可观测的体积或耗时信号，成本可能悄悄回归。

## 决策

暂存在 Electron rebuild 之后从运行时中剔除仅用于开发的文件：TypeScript 源码、source map 与目标文件（`*.ts`、`*.mts`、`*.cts`、`*.map`、`*.o`、`*.obj`）。对已暂存闭包的清单扫描显示，没有任何 `main`/`exports` 运行时条件指向 `.ts`，source map 仅供调试使用，因此这些扩展名没有运行时作用；已暂存冒烟（原生模块、CLI 版本、Web 启动）与打包后的启动验收都在剔除之后运行，错误的裁剪会被当场发现。随后的暂存门禁会拒绝任何把 Node 实际求值的入口（`main`、`bin`，或 `exports` 的 `node`/`import`/`require`/`default` 条件）指向已剪除源码文件的清单，因此未来的依赖不可能把可加载入口路由到被剪除的扩展名；打包器专用条件（`source`、`development`、`browser`）与 `types` 不在检查范围内。剔除量约为已暂存树的一半，同时缩小了两个平台的安装包体积与安装时的逐文件杀毒成本。

Windows 验证器会记录静默 NSIS 安装耗时，并把安装程序体积、应用文件数与字节总数写入 `apps/desktop/release/verify-stats.json`；Windows CI 工作流打印该文件，让安装耗时成为可度量的回归信号而不是传闻。

## 曾考虑的替代方案

**把 JavaScript 运行时放进 `app.asar`。** Electron 内嵌的 Node 直接从归档读取 JavaScript，安装程序就能写一个文件而不是数万个。该方案已原型验证并否决：Node 的模块解析（ESM 与 CJS 都是）在 `ELECTRON_RUN_AS_NODE` 下无法跟随目标位于 `app.asar` 归档内部的真实目录符号链接，而 profile 启动恰好依赖这种形态——`$DSH_HOME/profiles/node_modules` 把每个内置插件链接进运行时，out-of-tree 插件的 peer 依赖也通过这些链接导入 Service Definition 包。解析链从归档内部开始可以工作；从真实目录经链接进入归档则报 `ERR_MODULE_NOT_FOUND`。用宿主 base URL（`bareModuleBaseUrl`）路由裸模块名能修复补丁条目，但修复不了 out-of-tree peer 场景，而后者在不把运行时包复制进用户数据的情况下没有干净的解法。

**首次启动时解压运行时归档。** 归档仍是单个安装文件，但同样的逐文件写入与扫描成本会挪到首次启动，磁盘占用翻倍，还需要解压感知的启动流程。

**保留未打包运行时、只剪除源码。** 已采纳：剪除让主导成本（安装时逐文件创建与扫描）大致减半，且不改变架构。

## 结果

安装包载荷与文件数大致减半，运行时布局与 profile 解析契约不变。剪除集是机械的，并由已暂存冒烟与打包后的启动验收把关。Windows 安装耗时现在有 CI 打印的回归信号而不是传闻。asar 被否决的原因记录于此，未来的打包改造将从这条解析约束证据出发，而不是重新发现它。
