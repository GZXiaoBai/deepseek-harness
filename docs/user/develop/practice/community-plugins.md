# Community plugin picks

English | [中文](community-plugins.zh.md)

DeepSeek Harness is plugin-first: the model provider, sandbox, tools, session store, and the Web UI are all Cordis plugins, and the community ships hundreds of installable bundles. [cordis.run](https://cordis.run) indexes 300+ plugins with per-plugin security scan status, and the [awesome-dsh-plugin](https://github.com/Anil-matcha/awesome-dsh-plugin) list curates them by category. Install any of them into a profile with a pinned commit:

```sh
dsh plugin --profile web add github:<owner>/<repo>#<commit-sha>
```

Restart `dsh web` after installing and refresh the page.

## Picks by need

| Need | Plugin | Notes |
| --- | --- | --- |
| Long-term memory | [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) (120★) | Three-tier local-first memory (runtime / brief / full) with auto-injection |
| Turn-completion notifications | [dsh-notification](https://github.com/omdsh-dev/dsh-notification) (64★) | Desktop notifications per outcome |
| Zero-dependency utility tools | [dsh-toolkit](https://github.com/omdsh-dev/dsh-toolkit) (23★) | time / encoding / json / calculator / csv / regex / markdown / diff / stat tools |
| Safe Git tools | [dsh-tool-git](https://github.com/lxj808624/dsh-tool-git) | Structured git status/diff/log/stage/commit family |
| Real terminal panel | [`terminal`](https://github.com/giiiiiithub/terminal) | node-pty + xterm.js PTY panel with tabs, dock, and floating window |
| Status HUD | [dsh-hud](https://github.com/a903067276-rgb/dsh-hud) | Floating Git / MCP / skills / model / token usage |
| Diagram rendering | [dsh-mermaid](https://github.com/AKS1st/dsh-mermaid) | Sanitized theme-aware Mermaid SVG rendering |
| Keyboard shortcuts | [dsh-shortcuts](https://github.com/Ricketts-Guo/dsh-shortcuts) | 34 pre-registered shortcuts with one-click recording |
| Web plugin manager | [dsh-plugin-manager](https://github.com/hrhgit/deepseek-harness-plugin-manager) | Inspect, enable, disable, and group runtime plugins from the Web UI |
| Plugin relationship graph | [dsh-plugin-graph](https://github.com/erduotong/dsh-plugin-graph) | Force-directed graph of client plugin dependencies |
| Composer file references | [dsh-at-file](https://github.com/omdsh-dev/dsh-at-file) | Codex-style `@path` workspace search without content injection |

## Choosing safely

The ecosystem is young and fast-moving: star counts are small, quality varies, and plugins are unsigned. Prefer plugins indexed on cordis.run with a green security scan, pin the exact commit you install, and inspect what a plugin's bundle patch mounts before granting it a profile seat. Official DeepSeek Harness plugins live under the `@deepseek-ai/dsh-*` scope; anything else is community code with no compatibility promise.
