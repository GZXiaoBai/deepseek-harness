# macOS 桌面 App 实施计划

[English](2026-08-16-macos-desktop-app.md) | 中文

> **致智能体执行者：** 必须使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 子技能，逐项实施本计划。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 为运行 macOS 14 或更高版本的 Apple Silicon Mac 交付可独立运行、供个人使用的 `DeepSeek Harness.app` 和 DMG，同时保留现有 Web UI。

**架构：** 启用沙箱的 Electron 主进程拥有一个独立进程组中的 Harness 子进程。子进程通过 Electron 内置的 Node 运行时执行暂存后的 `@deepseek-ai/dsh` CLI，在动态回环端口上提供现有 Web UI。打包流程把完整的生产依赖闭包放在 `app.asar` 外，为 Electron arm64 重建原生模块，并生成临时签名的 App 和 DMG。

**技术栈：** TypeScript 6、Electron 43.4.0、Electron Builder 26.15.3、`@electron/rebuild` 4.2.0、pnpm deploy、Vitest，以及 macOS 的 `iconutil`、`codesign` 和 `hdiutil`。

## 全局约束

- 只支持 `darwin-arm64` 和 macOS 14 或更高版本；在其他平台或架构上拒绝打包。
- 保持现有 React Web UI 不变；不创建渲染器分支或 preload API。
- 主窗口内只使用已确认的 `http://127.0.0.1:<dynamic-port>` 来源。
- Harness 状态和桌面日志存放在 `app.getPath('userData')` 下；生产环境中它解析为 `~/Library/Application Support/DeepSeek Harness`。
- 只从登录 Shell 导入 `PATH`，绝不复制或记录其余 Shell 环境。
- 只终止桌面 App 自己创建的独立进程组。优雅退出等待五秒，随后发送 `SIGKILL`。
- 每项行为变更先编写失败测试；每个任务通过聚焦检查后提交。
- 中英文文档必须成对，代码围栏内容逐字节一致，并刷新 `.i18n.yaml` 记录。

---

### 任务 1：注册桌面包和决策记录

**文件：**

- 新建：`apps/desktop/package.json`
- 新建：`apps/desktop/tsconfig.json`
- 新建：`apps/desktop/tsdown.config.ts`
- 修改：`package.json`
- 修改：`pnpm-workspace.yaml`
- 修改：`scripts/check-workspace-constraints.ts`
- 新建：`scripts/check-workspace-constraints.spec.ts`
- 修改：`tsconfig.host.json`
- 新建：`.agents/notes/proposed/feature/2026-08-16-macos-desktop-app.md`
- 新建：`.agents/notes/proposed/feature/2026-08-16-macos-desktop-app.zh.md`
- 新建：`.agents/notes/proposed/feature/2026-08-16-macos-desktop-app.i18n.yaml`

- [ ] **步骤 1：编写会失败的工作区策略测试**

在 `scripts/check-workspace-constraints.spec.ts` 中添加断言，加载 `apps/desktop/package.json`，并要求发布家族版本、公开仓库元数据以及以下精确的包文件策略：

```ts ignore-check
expect(appPackageFiles['@deepseek-ai/dsh-desktop']).toEqual([
  'lib/*.js',
  'static',
  'build',
])
```

- [ ] **步骤 2：运行聚焦测试并确认失败**

运行：`pnpm exec vitest run scripts/check-workspace-constraints.spec.ts`

预期：失败，因为 `@deepseek-ai/dsh-desktop` 及其文件策略尚不存在。

- [ ] **步骤 3：添加包骨架和根命令**

使用仓库当前发布家族版本和精确的桌面依赖创建清单：

```json
{
  "name": "@deepseek-ai/dsh-desktop",
  "version": "0.1.0-rc.5",
  "description": "Apple Silicon macOS desktop wrapper for DeepSeek Harness",
  "publishConfig": { "access": "public" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/deepseek-ai/deepseek-harness.git",
    "directory": "apps/desktop"
  },
  "type": "module",
  "main": "lib/main.js",
  "files": ["lib/*.js", "static", "build"],
  "scripts": {
    "build": "tsc -p tsconfig.json && tsdown --config tsdown.config.ts",
    "test": "vitest run tests",
    "stage": "node scripts/stage-runtime.mjs",
    "package": "node scripts/package.mjs"
  },
  "license": "MIT",
  "dependencies": { "shell-path": "3.1.0" },
  "devDependencies": {
    "@electron/rebuild": "4.2.0",
    "@types/node": "^22.20.0",
    "electron": "43.4.0",
    "electron-builder": "26.15.3",
    "sharp": "^0.35.3",
    "tsdown": "^0.22.2",
    "typescript": "^6.0.3",
    "vitest": "^4.1.8"
  }
}
```

添加根命令 `build:desktop`、`test:desktop` 和 `package:desktop`；把桌面源码和测试加入 `tsconfig.host.json`；把该包加入 `appPackageFiles`；并明确允许经过审核的 Electron 安装脚本：

```yaml
allowBuilds:
  electron: true
```

保持根 `build` 与平台无关。`package:desktop` 必须先调用现有 Host/Web 构建，再执行桌面包构建、暂存和打包命令。

- [ ] **步骤 4：添加 proposed Agent Note 双语对**

记录首版桌面封装为何使用回环 HTTP、哪些职责仍归 `@deepseek-ai/dsh-host-webserver`，以及未来 `file://` 加 IPC Host 为何属于另一种架构。包括问题、提案、备选方案、验收条件和风险。

- [ ] **步骤 5：安装并验证工作区策略**

运行：`pnpm install`

运行：`pnpm exec vitest run scripts/check-workspace-constraints.spec.ts`

运行：`pnpm run constraints`

预期：全部通过，且 `pnpm-lock.yaml` 只记录已审核的桌面工具链新增项。

- [ ] **步骤 6：配对 Agent Note 并提交**

运行：`pnpm run verify-translation-pairing --write .agents/notes/proposed/feature/2026-08-16-macos-desktop-app.md .agents/notes/proposed/feature/2026-08-16-macos-desktop-app.zh.md`

运行：`pnpm run verify-agent-note-format`

提交：`git commit -m "chore: scaffold macOS desktop app"`

---

### 任务 2：实现严格的 URL 与导航策略

**文件：**

- 新建：`apps/desktop/src/harness-url.ts`
- 新建：`apps/desktop/src/navigation-policy.ts`
- 新建：`apps/desktop/tests/harness-url.spec.ts`
- 新建：`apps/desktop/tests/navigation-policy.spec.ts`

- [ ] **步骤 1：编写会失败的 URL 解析测试**

覆盖有效动态端口，并拒绝 `localhost`、IPv6、凭据、路径、片段、零端口、大于 65535 的端口以及只是包含 URL 的输出。公开契约为：

```ts
export declare function parseHarnessUrl(line: string): URL | undefined
```

使用以下精确的正向断言：

```ts ignore-check
expect(parseHarnessUrl('dsh web: http://127.0.0.1:43127')?.href)
  .toBe('http://127.0.0.1:43127/')
```

- [ ] **步骤 2：编写会失败的导航策略测试**

决策类型和策略入口为：

```ts
export type NavigationDecision = 'allow' | 'external' | 'deny'

export declare function classifyNavigation(
  target: URL,
  harnessOrigin: string,
): NavigationDecision
```

断言同源 HTTP 允许访问，其他 HTTP/HTTPS 来源交给外部浏览器，而 `file:`、`data:`、`javascript:`、自定义协议、凭据或格式错误的来源会被拒绝。

- [ ] **步骤 3：运行测试并确认失败**

运行：`pnpm exec vitest run apps/desktop/tests/harness-url.spec.ts apps/desktop/tests/navigation-policy.spec.ts`

预期：失败，因为两个模块均不存在。

- [ ] **步骤 4：实现最小而严格的策略**

只解析整行匹配，验证数字端口，重新构造 URL，并比较规范化来源。不得使用子串匹配，也不得信任子进程提供的路径。

- [ ] **步骤 5：重新运行测试并提交**

运行：`pnpm exec vitest run apps/desktop/tests/harness-url.spec.ts apps/desktop/tests/navigation-policy.spec.ts`

预期：通过。

提交：`git commit -m "feat(desktop): validate harness navigation"`

---

### 任务 3：负责 Harness 子进程生命周期

**文件：**

- 新建：`apps/desktop/src/desktop-logger.ts`
- 新建：`apps/desktop/src/harness-process.ts`
- 新建：`apps/desktop/src/login-path.ts`
- 新建：`apps/desktop/tests/fixtures/fake-dsh.mjs`
- 新建：`apps/desktop/tests/harness-process.spec.ts`
- 新建：`apps/desktop/tests/login-path.spec.ts`

- [ ] **步骤 1：围绕可注入边界编写会失败的生命周期测试**

测试延迟就绪、启动超时、提前退出、不匹配的 stdout、健康检查失败、重试前清理、正常 `SIGTERM`、强制 `SIGKILL` 和运行时意外退出。进程启动、进程组终止、时钟和 HTTP 健康检查必须可注入：

```ts ignore-check
export interface HarnessProcessOptions {
  executable: string
  cliPath: string
  dshHome: string
  cwd: string
  env: NodeJS.ProcessEnv
  startupTimeoutMs?: number
  shutdownTimeoutMs?: number
  spawnProcess?: typeof spawn
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void
  healthCheck?: (url: URL, signal: AbortSignal) => Promise<void>
  logger: DesktopLogger
}

export class HarnessProcessController {
  constructor(options: HarnessProcessOptions)
  start(): Promise<URL>
  stop(): Promise<void>
  onUnexpectedExit(listener: (error: Error) => void): () => void
}
```

假 CLI 必须通过参数提供确定性模式，不得在生产代码中加入测试专用分支。

- [ ] **步骤 2：编写会失败的登录 PATH 测试**

注入 `shellPath()` 提供者，并验证只有 `PATH` 发生变化：

```ts ignore-check
await expect(buildChildEnvironment(
  { HOME: '/Users/test', SECRET: 'unchanged', PATH: '/usr/bin' },
  async () => '/opt/homebrew/bin:/usr/bin',
)).resolves.toMatchObject({
  HOME: '/Users/test',
  SECRET: 'unchanged',
  PATH: '/opt/homebrew/bin:/usr/bin',
  ELECTRON_RUN_AS_NODE: '1',
})
```

生产调用必须在函数返回后覆盖 `DSH_HOME`。日志绝不能序列化环境对象。

- [ ] **步骤 3：运行测试并确认失败**

运行：`pnpm exec vitest run apps/desktop/tests/harness-process.spec.ts apps/desktop/tests/login-path.spec.ts`

预期：失败，因为生命周期模块不存在。

- [ ] **步骤 4：实现控制器**

使用 `detached: true` 和管道化 stdout/stderr 启动以下固定参数：

```ts ignore-check
const args = [cliPath, 'web', '--host', '127.0.0.1', '--port', '0']
```

按行缓冲输出，只接受 `parseHarnessUrl`，随后执行可中止的 HTTP GET，并要求 2xx 响应。停止时向 `-pid` 发送 `SIGTERM`，最多等待五秒，再向同一自有进程组发送 `SIGKILL`。启动中或已就绪时，`start()` 应以一致方式拒绝；`stop()` 应可安全重复调用。

在 `<userData>/Logs/desktop.log` 写入换行分隔的日志条目，使用固定事件名和安全元数据。子进程 stdout/stderr 可以按文本复制，但日志器不得读取环境值、凭据文件、请求正文或设置文档。

- [ ] **步骤 5：重新运行聚焦测试并提交**

运行：`pnpm exec vitest run apps/desktop/tests/harness-process.spec.ts apps/desktop/tests/login-path.spec.ts`

预期：通过，包括一个忽略 `SIGTERM` 并由 `SIGKILL` 回收的假子进程。

提交：`git commit -m "feat(desktop): manage harness child lifecycle"`

---

### 任务 4：构建安全的 Electron App 外壳

**文件：**

- 新建：`apps/desktop/src/main.ts`
- 新建：`apps/desktop/src/window-state.ts`
- 新建：`apps/desktop/src/menu.ts`
- 新建：`apps/desktop/static/startup.html`
- 新建：`apps/desktop/static/error.html`
- 新建：`apps/desktop/tests/window-state.spec.ts`
- 新建：`apps/desktop/tests/application-controller.spec.ts`

- [ ] **步骤 1：编写会失败的窗口状态和编排测试**

在小型适配器后隔离 Electron 调用，使测试可以在不导入真实 Electron 二进制的情况下断言单实例转交、初始启动页、就绪转换、重试清理、意外退出错误状态、第二实例聚焦和最后窗口关闭。

持久化并校验以下模型：

```ts
export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
}

export const defaultWindowBounds: WindowBounds = {
  width: 1100,
  height: 720,
}
```

拒绝小于 `900 × 600` 或完全位于所有已连接显示器范围外的持久化尺寸。

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm exec vitest run apps/desktop/tests/window-state.spec.ts apps/desktop/tests/application-controller.spec.ts`

预期：失败，因为 App 外壳不存在。

- [ ] **步骤 3：实现 BrowserWindow 安全契约**

创建不带 preload 脚本的窗口，并设置以下不可协商的首选项：

```ts
const webPreferences = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
}
```

禁用 `window.open`；将允许的外部 HTTP/HTTPS URL 交给 `shell.openExternal`；阻止所有不允许的顶层导航；只加载启动文档、错误文档或已确认的 Harness 来源。

- [ ] **步骤 4：实现生命周期、菜单和恢复**

在创建状态前获取 `app.requestSingleInstanceLock()`。第二次启动时恢复并聚焦现有窗口。构建 Reload、Open Logs Directory 和 Quit 菜单项。启动失败时加载 `error.html`，并显示带 Retry、Open Logs Directory 和 Quit 的原生对话框。Retry 必须等待 `controller.stop()` 完成后再调用 `controller.start()`。

让 Cmd+Q、最后窗口关闭、`SIGTERM` 和 `SIGINT` 经过同一个幂等异步退出屏障。在自有 Harness 进程停止前不得调用 `app.quit()`。

- [ ] **步骤 5：重新运行测试并执行未打包冒烟测试**

运行：`pnpm --filter @deepseek-ai/dsh-desktop run build`

运行：`pnpm exec vitest run apps/desktop/tests`

运行：`pnpm --filter @deepseek-ai/dsh-desktop exec electron lib/main.js`

预期：窗口显示现有 Web UI，第二次启动会聚焦该窗口，退出后不存在与所记录 PID 匹配的子进程。

- [ ] **步骤 6：提交**

提交：`git commit -m "feat(desktop): add secure Electron shell"`

---

### 任务 5：暂存独立运行时并构建图标

**文件：**

- 新建：`apps/desktop/scripts/stage-runtime.mjs`
- 新建：`apps/desktop/scripts/build-icon.mjs`
- 新建：`apps/desktop/scripts/verify-runtime.mjs`
- 新建：`apps/desktop/tests/stage-runtime.spec.ts`
- 修改：`.gitignore`

- [ ] **步骤 1：编写会失败的暂存策略测试**

测试平台防护、确定性暂存路径、必要 CLI 入口、仓库符号链接缺失以及原生模块重建命令的构造。导出的计划函数保持纯函数：

```ts
export interface StagePlan {
  readonly runtimeDirectory: string
}

export declare function createStagePlan(input: {
  repoRoot: string
  platform: NodeJS.Platform
  arch: string
  electronVersion: string
}): StagePlan
```

断言它拒绝除 `darwin` 加 `arm64` 之外的所有目标。

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm exec vitest run apps/desktop/tests/stage-runtime.spec.ts`

预期：失败，因为暂存脚本不存在。

- [ ] **步骤 3：实现生产运行时暂存**

脚本只能删除 `apps/desktop/.runtime`，随后执行等价于以下内容的命令：

```sh
pnpm --filter @deepseek-ai/dsh --prod deploy --legacy apps/desktop/.runtime
pnpm exec electron-rebuild --module-dir apps/desktop/.runtime --arch arm64 --version 43.4.0
```

所有路径都必须相对于 `import.meta.url` 解析，不能依赖调用方当前目录。部署后遍历 `.runtime`，若符号链接解析回仓库则失败。成功前要求 `.runtime/lib/bin.js` 和已构建 Web 前端闭包存在。

- [ ] **步骤 4：构建正确的 macOS 图标**

使用仓库现有 Sharp 工具链把 `apps/web/public/favicon.svg` 渲染为 iconset 所需的全部尺寸，再调用 `iconutil -c icns`。生成的 `.icns` 不纳入 Git；SVG 保持为唯一来源。

- [ ] **步骤 5：直接验证内置 Node 运行时**

使用已安装的 Electron 二进制和 `ELECTRON_RUN_AS_NODE=1`，先以 `--version` 运行暂存 CLI，再以 `web --host 127.0.0.1 --port 0` 运行。解析输出 URL，要求 HTTP 200，终止自有进程组，并断言已解析运行时文件中不出现仓库路径。

- [ ] **步骤 6：运行检查并提交**

运行：`pnpm exec vitest run apps/desktop/tests/stage-runtime.spec.ts`

运行：`pnpm --filter @deepseek-ai/dsh-desktop run stage`

运行：`node apps/desktop/scripts/verify-runtime.mjs`

预期：在 Apple Silicon 上通过，在其他平台上给出清晰的不支持平台错误。

提交：`git commit -m "build(desktop): stage standalone harness runtime"`

---

### 任务 6：生成 App、DMG 和独立验收测试

**文件：**

- 新建：`apps/desktop/electron-builder.yml`
- 新建：`apps/desktop/build/entitlements.mac.plist`
- 新建：`apps/desktop/scripts/package.mjs`
- 新建：`apps/desktop/scripts/verify-package.mjs`
- 新建：`apps/desktop/tests/package-config.spec.ts`

- [ ] **步骤 1：编写会失败的打包配置测试**

解析 Builder 配置，并要求 `arm64`、最低 macOS `14.0`、无更新器、无公证、运行时放在 `Contents/Resources/runtime`，以及明确的临时签名。关键配置为：

```yaml
appId: ai.deepseek.harness
productName: DeepSeek Harness
asar: true
files:
  - lib/*.js
  - static/**
extraResources:
  - from: .runtime
    to: runtime
mac:
  target:
    - target: dmg
      arch: [arm64]
    - target: dir
      arch: [arm64]
  category: public.app-category.developer-tools
  minimumSystemVersion: '14.0'
  identity: '-'
  hardenedRuntime: true
  entitlements: build/entitlements.mac.plist
```

Entitlement 文件必须包含 Electron JIT 支持和 `com.apple.security.cs.disable-library-validation`；临时签名 App 保留 Hardened Runtime 时需要后者。

- [ ] **步骤 2：运行打包配置测试并确认失败**

运行：`pnpm exec vitest run apps/desktop/tests/package-config.spec.ts`

预期：失败，因为打包产物和 Builder 配置均不存在。

- [ ] **步骤 3：实现确定性打包**

`package.mjs` 必须限制 `darwin-arm64`，构建图标，暂存并验证运行时，调用 Electron Builder 且不发布、不公证，并把输出放在 `apps/desktop/release`。它绝不能从用户钥匙串发现或使用 Developer ID；纳入版本控制的配置固定 `identity: '-'`。

- [ ] **步骤 4：实现仓库外冒烟测试**

把 `DeepSeek Harness.app` 复制到检出目录外的 `mkdtemp` 目录。使用临时 `--user-data-dir` 启动 `Contents/MacOS/DeepSeek Harness`，轮询 `Logs/desktop.log` 中的就绪 URL，要求 HTTP 200 和预期页面标题，再启动第二个实例，并断言原后端 PID 未变化。随后终止 App，等待所记录进程组消失，并确认其回环端口已关闭。

使用 `hdiutil attach` 挂载 DMG，要求其中存在 App，并在 `finally` 块中卸载。使用以下命令验证签名：

```sh
codesign --verify --deep --strict "apps/desktop/release/mac-arm64/DeepSeek Harness.app"
codesign -dv --verbose=4 "apps/desktop/release/mac-arm64/DeepSeek Harness.app"
```

不要把 `spctl` 拒绝视为失败，因为这个个人构建采用临时签名且未公证。

- [ ] **步骤 5：构建并验证产物**

运行：`pnpm run package:desktop`

运行：`node apps/desktop/scripts/verify-package.mjs`

预期：arm64 App 和 DMG 在仓库外通过独立启动、单实例、Web UI、签名及清理检查。

- [ ] **步骤 6：提交**

提交：`git commit -m "build(desktop): package Apple Silicon app"`

---

### 任务 7：同步架构文档、声明和最终检查

**文件：**

- 新建：`apps/desktop/README.md`
- 新建：`apps/desktop/README.zh.md`
- 新建：`apps/desktop/README.i18n.yaml`
- 修改：`docs/subsystems/web-server.md`
- 修改：`docs/subsystems/web-server.zh.md`
- 修改：`docs/subsystems/web-server.i18n.yaml`
- 修改：`packages/host/webserver/README.md`
- 修改：`packages/host/webserver/README.zh.md`
- 修改：`packages/host/webserver/README.i18n.yaml`
- 修改：`packages/host/webserver/src/index.ts`
- 移动：`.agents/notes/proposed/feature/2026-08-16-macos-desktop-app.md` → `.agents/notes/implemented/feature/2026-08-16-macos-desktop-app.md`
- 移动：`.agents/notes/proposed/feature/2026-08-16-macos-desktop-app.zh.md` → `.agents/notes/implemented/feature/2026-08-16-macos-desktop-app.zh.md`
- 移动：`.agents/notes/proposed/feature/2026-08-16-macos-desktop-app.i18n.yaml` → `.agents/notes/implemented/feature/2026-08-16-macos-desktop-app.i18n.yaml`
- 修改：`THIRD_PARTY_NOTICES.md`

- [ ] **步骤 1：编写用户和维护者文档**

记录支持的硬件与系统、`pnpm run package:desktop`、产物位置、首次启动的 Gatekeeper 行为、数据/日志位置、不自动更新/不公证的限制，以及如何替换 App 而不丢失设置。

更新 Web Server 文档和源码模块注释，说明首版 macOS 封装有意使用回环 HTTP；把 `file://` 加 IPC 保留给未来 Electron 原生 Host。不得把两者描述为同一种传输方式。

- [ ] **步骤 2：完成 Agent Note**

把两个语言文件及其配对记录移动到 `implemented/feature`，将 `Status: proposed` 改为 `Status: implemented`，用实际决策替换提案文本，并记录当前后果和测试证据。刷新所有受影响的配对记录。

- [ ] **步骤 3：重新生成第三方声明**

运行：`pnpm run gen-third-party-notices`

预期：Electron 桌面依赖已被包含，且 `pnpm run verify-third-party-notices` 通过。

- [ ] **步骤 4：运行聚焦检查和仓库门禁**

运行：`pnpm run test:desktop`

运行：`pnpm run build`

运行：`pnpm run build:desktop`

运行：`pnpm run lint`

运行：`pnpm run constraints`

运行：`pnpm run doc-sync`

运行：`pnpm run verify-agent-note-format`

运行：`pnpm run verify-third-party-notices`

运行：`pnpm run hygiene`

预期：全部通过。如果不相关的既有门禁失败，应单独记录精确命令和证据，不得削弱门禁。

- [ ] **步骤 5：使用干净产物重复打包验收**

运行：`pnpm run package:desktop`

运行：`node apps/desktop/scripts/verify-package.mjs`

预期：复制后的 App 在不使用仓库 Node.js 路径的情况下启动，提供现有 Web UI，复用一个后端，把数据保存在临时用户数据目录，并在退出后不留下自有进程。

- [ ] **步骤 6：检查最终差异并提交**

运行：`git status --short`

运行：`git diff --check`

运行：`git diff --stat HEAD~6`

提交：`git commit -m "docs: document macOS desktop distribution"`

只有 App 和 DMG 均已在本地生成，且仓库外验收测试通过后，分支才算完成。
