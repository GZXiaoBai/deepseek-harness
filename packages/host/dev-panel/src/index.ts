/**
 * Loopback host half of the in-app review panel.
 *
 * Serves four read-only JSON routes for the browser panel: workspace file
 * listing and reading, and git status/diff. File access confines every path
 * to the session workspace root the browser supplies; git commands run
 * through the `ctx.shell` executor, so the deployment's sandbox and policy
 * apply to them like any other host shell work. The browser panel is a
 * same-origin consumer of the loopback Web server, the same trust boundary
 * as the rest of the Web UI.
 * @module @deepseek-ai/dsh-host-dev-panel
 */

import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Empty type imports carry the `webServer` and `shell` Context merges.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'

/** Maximum bytes of one workspace file the panel reads (bounds the response). */
const MAX_READ_BYTES = 512 * 1024
/** Maximum accepted request body bytes. */
const MAX_REQUEST_BYTES = 1024 * 1024

/** One directory entry returned by the panel. */
export interface DevPanelEntry {
  name: string
  type: 'file' | 'directory'
  size: number
}

/** Normalized panel request shared by the four routes. */
export interface DevPanelRequest {
  /** Workspace root the browser is browsing; every path resolves inside it. */
  root: string
  /** Path relative to the workspace root; absent means the root itself. */
  path?: string
}

/** JSON body of one panel request. */
export interface DevPanelRequestBody extends DevPanelRequest {
  /** Workspace-relative file path for read-file and git-diff. */
  file?: string
}

/** Successful response payload. */
export type DevPanelResponse =
  | { ok: true; entries: DevPanelEntry[] }
  | { ok: true; content: string }
  | { ok: true; status: string }
  | { ok: true; diff: string }
  | { ok: false; error: string }

/** Narrow shell surface consumed by the git routes. */
export interface DevPanelShell {
  resolve(request: ShellExecRequest): ShellExecSpec
  run(spec: ShellExecSpec): Promise<ShellRunResult>
}

/**
 * Confines one requested path inside the workspace root, resolving links.
 *
 * The browser may name the root itself or any descendant; absolute paths,
 * `..` escapes, and symlinks resolving outside the root are rejected. The
 * root must be an existing real directory.
 *
 * @param root Workspace root supplied by the browser.
 * @param requested Workspace-relative or root path.
 * @returns The canonical confined path.
 */
export async function confineToWorkspace(root: string, requested: string): Promise<string> {
  if (!isAbsolute(root)) throw new Error('Workspace root must be absolute')
  const canonicalRoot = await realpath(root)
  const target = resolve(canonicalRoot, requested)
  const fromRoot = relative(canonicalRoot, target)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('Path escapes the workspace')
  }
  if (fromRoot === '') return canonicalRoot
  // Resolve the deepest existing ancestor so a symlink escape is rejected
  // even when the requested leaf itself does not exist.
  const canonicalParent = await realpath(dirname(target))
  const fromParent = relative(canonicalRoot, canonicalParent)
  if (fromParent === '..' || fromParent.startsWith(`..${sep}`) || isAbsolute(fromParent)) {
    throw new Error('Path escapes the workspace')
  }
  return join(canonicalParent, basename(target))
}

/**
 * Lists one workspace directory.
 *
 * @param request Normalized request.
 * @returns Sorted directory entries.
 */
export async function listFiles(request: DevPanelRequest): Promise<DevPanelEntry[]> {
  const directory = await confineToWorkspace(request.root, request.path ?? '.')
  const entries = await readdir(directory, { withFileTypes: true })
  const result: DevPanelEntry[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    let size = 0
    if (entry.isFile()) {
      size = (await stat(join(directory, entry.name))).size
    }
    result.push({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : 'file',
      size,
    })
  }
  return result.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  })
}

/**
 * Reads one workspace file as UTF-8 text, bounded by {@link MAX_READ_BYTES}.
 *
 * @param request Normalized request.
 * @param file Workspace-relative file path.
 * @returns The file content.
 */
export async function readWorkspaceFile(request: DevPanelRequest, file: string): Promise<string> {
  const target = await confineToWorkspace(request.root, file)
  const info = await stat(target)
  if (!info.isFile()) throw new Error('Not a file')
  if (info.size > MAX_READ_BYTES) throw new Error(`File exceeds the ${MAX_READ_BYTES} byte preview limit`)
  return await readFile(target, 'utf8')
}

/** Result of one git invocation through the shell executor. */
export interface GitInvocation {
  spec: ShellExecSpec
  result: ShellRunResult
}

/**
 * Runs a read-only git command in the workspace through the shell executor.
 *
 * @param shell Executor surface.
 * @param request Normalized request.
 * @param command Git command line (read-only verbs only).
 * @returns The invocation, or an error result when git failed.
 */
export async function runGit(
  shell: DevPanelShell,
  request: DevPanelRequest,
  command: string,
): Promise<GitInvocation | { ok: false; error: string }> {
  const root = await confineToWorkspace(request.root, '.')
  const spec = shell.resolve({ command, workdir: root, stdoutMaxBytes: MAX_READ_BYTES })
  const result = await shell.run(spec)
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr.text.trim() || `git exited with code ${String(result.exitCode)}` }
  }
  return { spec, result }
}

/** @param request Incoming request. @returns Parsed JSON body. */
async function readJsonBody(request: IncomingMessage): Promise<DevPanelRequestBody> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    total += (chunk as Buffer).length
    if (total > MAX_REQUEST_BYTES) throw new Error('Request body too large')
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  const parsed = JSON.parse(raw === '' ? '{}' : raw) as Partial<DevPanelRequestBody>
  if (typeof parsed.root !== 'string' || parsed.root === '') {
    throw new Error('Missing workspace root')
  }
  return {
    root: parsed.root,
    ...(typeof parsed.path === 'string' ? { path: parsed.path } : {}),
    ...(typeof parsed.file === 'string' ? { file: parsed.file } : {}),
  }
}

/** @param response Server response. @param payload JSON payload to send. */
function sendJson(response: ServerResponse, payload: DevPanelResponse): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

/** @param response Server response. @param error Error text to send. */
function sendError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  sendJson(response, { ok: false, error: message })
}

/** @param pathname Route path. @param handler Route handler. */
function route(pathname: string, handler: (request: DevPanelRequestBody, response: ServerResponse) => Promise<void>) {
  return {
    kind: 'exact' as const,
    path: pathname,
    handler: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      try {
        const body = await readJsonBody(request)
        await handler(body, response)
      } catch (error) {
        sendError(response, error)
      }
    },
  }
}

/** @param shell Executor surface. @param request Normalized request. @param response Server response. */
async function handleGitStatus(shell: DevPanelShell, request: DevPanelRequest, response: ServerResponse): Promise<void> {
  const invocation = await runGit(shell, request, 'git status --porcelain')
  if ('ok' in invocation) {
    sendJson(response, { ok: false, error: invocation.error })
    return
  }
  sendJson(response, { ok: true, status: invocation.result.stdout.text })
}

/** @param shell Executor surface. @param body Normalized request. @param response Server response. */
async function handleGitDiff(shell: DevPanelShell, body: DevPanelRequestBody, response: ServerResponse): Promise<void> {
  const file = typeof body.file === 'string' && body.file !== '' ? body.file : undefined
  const command = `git diff -- ${file ?? '.'}`.trimEnd()
  const invocation = await runGit(shell, body, command)
  if ('ok' in invocation) {
    sendJson(response, { ok: false, error: invocation.error })
    return
  }
  sendJson(response, { ok: true, diff: invocation.result.stdout.text })
}

/** Services required by the review-panel host plugin. */
export const inject = ['webServer', 'shell']

/**
 * Registers the four review-panel routes on the loopback Web server.
 *
 * @param ctx - Context carrying the injected Web server and shell services.
 * @returns The route registrations' combined disposer.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const shell: DevPanelShell = { resolve: request => ctx.shell.resolve(request), run: spec => ctx.shell.run(spec) }
    const disposers = [
      ctx.webServer.register(route('/dev-panel.list-files', async (body, response) => {
        sendJson(response, { ok: true, entries: await listFiles(body) })
      })),
      ctx.webServer.register(route('/dev-panel.read-file', async (body, response) => {
        if (typeof body.file !== 'string' || body.file === '') throw new Error('Missing file path')
        sendJson(response, { ok: true, content: await readWorkspaceFile(body, body.file) })
      })),
      ctx.webServer.register(route('/dev-panel.git-status', async (body, response) => {
        await handleGitStatus(shell, body, response)
      })),
      ctx.webServer.register(route('/dev-panel.git-diff', async (body, response) => {
        await handleGitDiff(shell, body, response)
      })),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dev-panel: loopback routes')
}
