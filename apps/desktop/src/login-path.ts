import { shellPath } from 'shell-path'

/** Resolves the command path that an interactive login shell exposes. */
export type ShellPathProvider = () => Promise<string>

/**
 * Builds the base environment for Electron's embedded Node runtime.
 *
 * Callers add application-specific variables, such as `DSH_HOME`, after this
 * function returns so this function only owns login-shell PATH discovery.
 *
 * @param environment The parent process environment to preserve.
 * @param getShellPath Login-shell PATH provider.
 * @returns A copy of the environment with the login-shell PATH and Electron Node mode.
 */
export async function buildChildEnvironment(
  environment: NodeJS.ProcessEnv,
  getShellPath: ShellPathProvider = shellPath,
): Promise<NodeJS.ProcessEnv> {
  return {
    ...environment,
    PATH: await getShellPath(),
    ELECTRON_RUN_AS_NODE: '1',
  }
}
