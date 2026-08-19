# @deepseek-ai/dsh-client-ui-dev-panel

[English](README.md) | 中文

DeepSeek Harness Web UI 的应用内审查面板：一个侧栏底部触发器加一个带三个 tab 的 details 栏面板。

- **文件** — 浏览会话工作区目录树；点击文本文件预览（只读，512 KiB 上限）。
- **历史** — 列出会话的用户与助手消息及其首行摘要。
- **Git** — 显示 `git status --porcelain` 行；点击变更文件查看差异（只读）。

面板在标准 web profile 中默认开启。数据来自 session 标准套件（工作区根、会话节点）以及 [`@deepseek-ai/dsh-host-dev-panel`](../../host/dev-panel/README.md) 提供的 host 路由。触发器行注册进 `sidebar.footer.action` list 槽并打开 details 栏；面板本体注册进 `conversation.details.devpanel`——ui-conversation 拥有的 details 栏的第二个 tab。

## 配置

无。

## Model Experience

无：面板在浏览器中呈现会话、工作区与 git 状态，绝不触达模型请求。

#### KV Cache effect

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

- **历史行不会跳转到会话** — 把聊天滚动到所选消息需要会话内部的滚动机制；列表目前仅展示。
- **文件预览仅限文本** — 图片与二进制预览不在范围内。
- **无写操作** — 面板只审查；编辑仍属于 agent 工具。
