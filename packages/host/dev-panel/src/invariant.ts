/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-host-dev-panel`.
 * @module @deepseek-ai/dsh-host-dev-panel/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-dev-panel'

/** Cordis companion plugin name. */
export const name = 'host-dev-panel-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package registers static read-only Web routes and
 * performs no cross-plugin state mutation; path confinement and route
 * behavior are asserted by this package's unit tests and the real-composition
 * test in the bundle.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
