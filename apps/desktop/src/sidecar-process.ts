/** Private child-process dispatch for the shared desktop executable. */
export type DesktopProcessSelection =
  | { kind: 'desktop' }
  | { kind: 'ptc' }
  | { kind: 'acl' }
  | { kind: 'runner'; selection: string }

/**
 * Select the executable entry before starting the desktop protocol.
 * @param environment - Process launch selectors supplied by subprocess providers.
 * @param argv - Node-compatible executable arguments.
 * @param aclRunner - Packaged Windows ACL runner path, absent on other platforms.
 * @returns The private runner or the interactive desktop host.
 */
export function selectDesktopProcess(
  environment: NodeJS.ProcessEnv,
  argv: readonly string[],
  aclRunner: string | undefined,
): DesktopProcessSelection {
  if (aclRunner !== undefined && argv[2] === aclRunner) return { kind: 'acl' }
  if (environment.DSH_PTC_RUNTIME_NODE === '1') return { kind: 'ptc' }
  if (environment.DSH_SUBPROCESS_RUNNER !== undefined) {
    return { kind: 'runner', selection: environment.DSH_SUBPROCESS_RUNNER }
  }
  return { kind: 'desktop' }
}
