/**
 * `node:sea` stub. A VFS-loaded worker module never runs inside a single
 * executable, so `isSea()` answers false: that is this host's real answer to the
 * query, and it keeps SEA-aware code on its ordinary path. Embedded asset reads
 * have no worker counterpart and report the gap when they run.
 */
import { notImplementedFail } from '../../notImplementedFail.ts'

const MODULE = 'node:sea'

/** Single-executable detection: false in the worker host, which is never one. */
export const isSea: typeof import('node:sea').isSea = () => false

/** Embedded asset read (unavailable). */
export const getAsset: typeof import('node:sea').getAsset = notImplementedFail(MODULE, 'getAsset')

/** Embedded asset key enumeration (unavailable). */
export const getAssetKeys: typeof import('node:sea').getAssetKeys = notImplementedFail(MODULE, 'getAssetKeys')

/** Raw embedded asset read (unavailable). */
export const getRawAsset: typeof import('node:sea').getRawAsset = notImplementedFail(MODULE, 'getRawAsset')

/** CommonJS interop marker: the worker loader hands `default` to default imports (see ./builtins.ts). */
export const __esModule = true

/** The `node:sea` declarations this module stands in for. */
type NodeFace = Partial<typeof import('node:sea')>

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default {
  isSea, getAsset, getAssetKeys, getRawAsset,
} satisfies NodeFace
