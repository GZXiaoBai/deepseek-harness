# Agent Note: 移除应用内审查台

Status: implemented

[English](2026-08-20-remove-dev-panel.md) | 中文

## 问题

应用内审查台（详情栏中的文件/历史/git 标签页）随桌面运行时发布，但所有者认为该界面不够好、不值得保留：它把简单的工具详情面板替换成带标签的容器，为运行时闭包新增两个包，而其价值不足以抵消新增的界面负担。

## 决策

从标准 web 与桌面组合中移除审查台：

- 删除 `@deepseek-ai/dsh-host-dev-panel` 与 `@deepseek-ai/dsh-client-ui-dev-panel`，连同 `packages/bundle/web-app` 中的 bundle 行与桌面运行时闭包条目。
- `ui-conversation` 恢复单一工具详情面板：带标签的 `DetailsPanel`（工具/审查台）回退到上游单槽版本，`conversation.details.devpanel` 槽声明移除。
- 已归档的[应用内审查台记录](../../archived/feature/2026-08-18-dev-panel.md)保留设计档案。

移除同时去掉侧栏底部触发器及其 locale 键；运行时闭包重新收敛（121 个直接依赖、125 个 workspace 包），客户端槽目录重新生成。

## 备选方案

**保留并改进面板。** 所有者已评估该界面并选择移除；改进一个评审未通过的界面属于臆测。

## 影响

详情栏恢复为朴素工具调用面板（少一个标签、少一个槽位），web 与桌面载荷减少两个包，dev-panel 记录归档备查。未来的任何审查界面将从归档设计档案出发，而非重新摸索 loopback 路由与路径收敛工作。
