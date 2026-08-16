# Agent Note: 引入 macOS 桌面封装层

Status: proposed

[English](2026-08-16-macos-desktop-app.md) | 中文

## 问题

DeepSeek Harness 目前通过 Host/Web 组合提供浏览器界面。希望获得应用程序包的 macOS 用户需要一个原生启动器，同时不能重复实现 host 组合、静态资源服务或浏览器协议处理。

## 提案

新增一个仅支持 Apple Silicon 的 Electron 封装层：它通过 loopback HTTP 启动现有 Host/Web 应用，并在 Electron 窗口中打开其 URL。该封装层负责进程启动、运行时准备、Electron 打包和 macOS 应用元数据。

`@deepseek-ai/dsh-host-webserver` 继续负责启动面向应用的 HTTP 服务器、提供构建后的 web 前端、路由现有 API 流量，并定义浏览器可见的启动行为。Electron 不替代该包，也不提供第二套 host 组合。

未来采用 `file://` 并由 IPC 支持的 host 是一套独立架构。在它能够替代 loopback HTTP 前，必须明确替换 HTTP 服务器所承担的资源、请求、生命周期和安全职责。

## 考虑过的替代方案

**立即使用 `file://` 加载 web 前端。** 这可以移除本地监听器，但需要新的 IPC API 和安全的资源加载模型，并会改变当前 Host/Web 请求路径。首个封装层保留这条已建立的路径。

**将 Host/Web 逻辑直接嵌入 Electron。** 这会让 Electron 承担已由 `@deepseek-ai/dsh-host-webserver` 负责的组合和启动行为，形成两套需要保持一致的实现。

## 验收标准

- 桌面包发布 Electron 主进程输出、准备后的运行时和打包后的应用文件。
- 桌面启动器通过 loopback HTTP 打开现有 Host/Web 应用。
- `@deepseek-ai/dsh-host-webserver` 仍是应用 HTTP 服务和浏览器可见启动行为的责任方。
- 首个版本仅面向 Apple Silicon macOS。

## 风险

应用需要管理 loopback 监听器和 Electron 进程生命周期。本地 HTTP 传输是首个版本的有意选择，但并不承诺与 `file://` 或 IPC 兼容。未来的原生 host 设计必须作为替代架构评估，包括其安全模型和迁移成本。
