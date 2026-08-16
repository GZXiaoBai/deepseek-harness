# Agent Note: Introduce a macOS desktop wrapper

Status: proposed

English | [中文](2026-08-16-macos-desktop-app.zh.md)

## Problem

DeepSeek Harness currently presents its browser interface through the Host/Web assembly. macOS users who want an application bundle need a native launcher without duplicating the host composition, static-asset serving, or browser protocol handling.

## Proposal

Add an Apple-Silicon-only Electron wrapper that starts the existing Host/Web application on loopback HTTP and opens its URL in an Electron window. The wrapper owns process startup, runtime staging, Electron packaging, and macOS application metadata.

`@deepseek-ai/dsh-host-webserver` remains responsible for starting the application-facing HTTP server, serving the built web frontend, routing its existing API traffic, and defining the browser-visible startup behavior. Electron does not replace that package or expose a second host composition.

A future `file://` application with an IPC-backed host is a separate architecture. It would need an explicit replacement for the HTTP server's asset, request, lifecycle, and security responsibilities before it can retire loopback HTTP.

## Alternatives considered

**Load the web frontend with `file://` immediately.** This removes a local listener, but it requires new IPC APIs and a secure asset-loading model while changing the current Host/Web request path. The first wrapper keeps that established path intact.

**Embed the Host/Web logic directly in Electron.** This would make Electron own composition and startup behavior already owned by `@deepseek-ai/dsh-host-webserver`, creating two implementations to keep aligned.

## Acceptance criteria

- The desktop package publishes its Electron main-process output, staged runtime, and packaged application files.
- The desktop launcher opens the existing Host/Web application over loopback HTTP.
- `@deepseek-ai/dsh-host-webserver` remains the owner of application HTTP serving and browser-facing startup behavior.
- The first release targets Apple Silicon macOS only.

## Risks

The application has a loopback listener and Electron process lifecycle to manage. Its local HTTP transport is intentional for the first release, but it is not a commitment to `file://` or IPC compatibility. A future native-host design must be evaluated as a replacement architecture, including its security model and migration cost.
