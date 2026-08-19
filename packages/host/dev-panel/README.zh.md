# @deepseek-ai/dsh-host-dev-panel

[English](README.md) | 中文

应用内审查面板的 loopback host 半边：工作区文件列表与读取，以及只读的 git status/diff。浏览器面板（`@deepseek-ai/dsh-client-ui-dev-panel`）消费 loopback Web 服务器上的四个 JSON 路由：

| 路由 | 请求 | 响应 |
| --- | --- | --- |
| `POST /dev-panel.list-files` | `{ root, path? }` | `{ ok, entries: [{ name, type, size }] }` |
| `POST /dev-panel.read-file` | `{ root, file }` | `{ ok, content }` |
| `POST /dev-panel.git-status` | `{ root }` | `{ ok, status }` |
| `POST /dev-panel.git-diff` | `{ root, file? }` | `{ ok, diff }` |

每个请求都要命名浏览器正在浏览的工作区根。路径包含性（`confineToWorkspace`）会解析链接并拒绝绝对路径、`..` 逃逸与越界符号链接；根本身必须是存在的真实目录。文件读取是只读、UTF-8 且每个文件限制 512 KiB。git 命令经 `ctx.shell` 执行器以工作区为工作目录运行，因此部署的沙箱与策略同样生效；面板只发起只读动词 `git status --porcelain` 与 `git diff`。面板是 loopback Web 服务器的同源消费者，与 Web UI 其余部分的信任边界相同。

## 配置

无。

## Model Experience

无：面板在浏览器中呈现工作区与 git 状态，绝不触达模型请求。

#### KV Cache effect

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

- **工作区根由客户端提供** — 被攻破的页面可以浏览它命名的任何目录；包含性防止逃逸到命名根之外，而根就是 UI 已展示的会话工作区。
- **无写操作** — 创建文件或暂存 git 变更不属于审查面板范围。
