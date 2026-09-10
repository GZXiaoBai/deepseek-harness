# 社区插件推荐

[English](community-plugins.md) | 中文

DeepSeek Harness 以插件为先：模型提供方、沙箱、工具、会话存储与 Web UI 都是 Cordis 插件，社区已经发布数百个可安装 bundle。[cordis.run](https://cordis.run) 收录 300+ 插件并标注每个插件的安全扫描状态，[awesome-dsh-plugin](https://github.com/Anil-matcha/awesome-dsh-plugin) 按类别精选。安装任意插件到 profile 时请锁定提交：

```sh
dsh plugin --profile web add github:<owner>/<repo>#<commit-sha>
```

安装后重启 `dsh web` 并刷新页面。

## 按需推荐

| 需求 | 插件 | 说明 |
| --- | --- | --- |
| 长期记忆 | [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon)（120★） | 三层本地优先记忆（运行时/简报/全文），自动注入 |
| 回合完成通知 | [dsh-notification](https://github.com/omdsh-dev/dsh-notification)（64★） | 按结果分类的桌面通知 |
| 零依赖工具集 | [dsh-toolkit](https://github.com/omdsh-dev/dsh-toolkit)（23★） | time / encoding / json / calculator / csv / regex / markdown / diff / stat 工具 |
| 安全 Git 工具 | [dsh-tool-git](https://github.com/lxj808624/dsh-tool-git) | 结构化 git status/diff/log/stage/commit 工具族 |
| 真实终端面板 | [`terminal`](https://github.com/giiiiiithub/terminal) | node-pty + xterm.js 终端面板，支持多标签、停靠与浮动窗口 |
| 状态 HUD | [dsh-hud](https://github.com/a903067276-rgb/dsh-hud) | 浮动显示 Git / MCP / 技能 / 模型 / 令牌用量 |
| 图表渲染 | [dsh-mermaid](https://github.com/AKS1st/dsh-mermaid) | 净化且随主题变化的 Mermaid SVG 渲染 |
| 键盘快捷键 | [dsh-shortcuts](https://github.com/Ricketts-Guo/dsh-shortcuts) | 34 个预置快捷键，一键录制自定义 |
| Web 插件管理 | [dsh-plugin-manager](https://github.com/hrhgit/deepseek-harness-plugin-manager) | 在 Web UI 中查看、启用、禁用与分组运行时插件 |
| 插件关系图 | [dsh-plugin-graph](https://github.com/erduotong/dsh-plugin-graph) | 客户端插件依赖的力导向关系图 |
| 编辑器文件引用 | [dsh-at-file](https://github.com/omdsh-dev/dsh-at-file) | Codex 风格 `@path` 工作区搜索，不注入文件内容 |

## 安全选择

生态很新且变化很快：星标数普遍不大、质量参差、插件均未签名。优先选择 cordis.run 上有绿色安全扫描的插件，锁定要安装的确切提交，并在把插件的 bundle patch 挂进 profile 之前审查它挂载了什么。官方 DeepSeek Harness 插件位于 `@deepseek-ai/dsh-*` 作用域下；其余都是没有兼容承诺的社区代码。
