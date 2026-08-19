import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { DesktopLogSink } from './desktop-logger.ts'

/** GitHub release channel selection for update checks. */
export type UpdateChannel = 'stable' | 'prerelease'

/** Update source and behavior preferences persisted by the desktop app. */
export interface UpdaterPreferences {
  /** `owner/repo` whose GitHub Releases supply desktop artifacts. */
  repository: string
  channel: UpdateChannel
  /** Whether the app checks for updates automatically at startup. */
  autoUpdate: boolean
}

/** One release candidate discovered by an update check. */
export interface UpdateInfo {
  /** Version parsed from the release tag, without the `desktop-v` prefix. */
  version: string
  /** Full release tag name. */
  tagName: string
  /** Direct download URL of the platform asset, or null when missing. */
  assetUrl: string | null
  /** Asset file name for checksum lookup and download naming. */
  assetName: string | null
  /** GitHub release body. */
  notes: string
  /** Release creation timestamp. */
  publishedAt: string
}

/** Raw GitHub release asset as returned by the Releases API. */
export interface ReleaseAsset {
  name: string
  browser_download_url: string
}

/** Raw GitHub release as returned by the Releases API. */
export interface GitHubRelease {
  tag_name: string
  prerelease: boolean
  published_at: string
  body?: string
  assets: ReleaseAsset[]
}

/** Injectable operations that keep the updater free of Electron imports. */
export interface UpdaterRuntimeOps {
  /** Fetches one JSON document (GitHub API response). */
  fetchJson(url: string): Promise<unknown>
  /** Fetches one text document (checksum assets). */
  fetchText(url: string): Promise<string>
  /** Downloads one URL to a local file. */
  download(url: string, destination: string): Promise<void>
  /** Reads a downloaded file's bytes (checksum input). */
  readFile(path: string): Promise<Buffer>
  /** Removes a temporary file after a failed or completed download. */
  unlink(path: string): Promise<void>
  /** Shows a modal choice dialog; resolves the clicked button label. */
  dialog(message: string, detail: string, buttons: readonly string[]): Promise<string>
  /** Detached-spawns a process without waiting (NSIS installer). */
  spawnDetached(executable: string, args: readonly string[]): void
  /** Runs a shell script (macOS install chain) and reports success. */
  runShellScript(script: string, elevated: boolean): Promise<{ ok: boolean; detail: string }>
  /** Quits the application (used after staging an update). */
  quit(): void
}

/** Combines the updater preferences with the runtime context. */
export interface DesktopUpdaterOptions {
  /** Current application version (Electron `app.getVersion()`). */
  currentVersion: string
  /** Target platform: `win32` or `darwin`; anything else is unsupported. */
  platform: NodeJS.Platform
  /** Preferences used when no persisted settings exist. */
  preferences: UpdaterPreferences
  /** Injectable operations for network, dialogs, and process control. */
  ops: UpdaterRuntimeOps
  /** Lifecycle log sink for observable updater events. */
  logger: DesktopLogSink
}

const RELEASE_TAG_PREFIX = 'desktop-v'
const WINDOWS_ASSET_PATTERN = /^DeepSeek Harness Setup .+?-x64\.exe$/
const MAC_ASSET_PATTERN = /-arm64\.dmg$/
const CHECKSUM_NAMES = ['checksums.txt', 'checksums.sha256']

/**
 * Compares two semantic versions including prerelease ordering.
 *
 * `1.0.0-rc.1 < 1.0.0`; `1.0.0-rc.2 > 1.0.0-rc.1`; an absent prerelease
 * sorts after any prerelease of the same core. Invalid input throws, because
 * an unparseable release tag must fail the check, not silently match.
 *
 * @param left Left version string.
 * @param right Right version string.
 * @returns -1, 0, or 1 when `left` is lower, equal, or higher than `right`.
 */
export function compareSemver(left: string, right: string): -1 | 0 | 1 {
  const [leftMajor, leftMinor, leftPatch] = parseCore(left)
  const [rightMajor, rightMinor, rightPatch] = parseCore(right)
  for (const [leftPart, rightPart] of [[leftMajor, rightMajor], [leftMinor, rightMinor], [leftPatch, rightPatch]] as const) {
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1
    }
  }
  const leftPre = parsePrerelease(left)
  const rightPre = parsePrerelease(right)
  if (leftPre === null && rightPre === null) return 0
  if (leftPre === null) return 1
  if (rightPre === null) return -1
  for (let index = 0; index < Math.max(leftPre.length, rightPre.length); index += 1) {
    const leftPart = leftPre[index]
    const rightPart = rightPre[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined
    const rightNumeric = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined
    if (leftNumeric !== undefined && rightNumeric !== undefined) {
      return leftNumeric < rightNumeric ? -1 : 1
    }
    const leftLower = leftPart < rightPart
    return leftLower ? -1 : 1
  }
  return 0
}

/** @param version Version string. @returns Core [major, minor, patch] numbers. */
function parseCore(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (match === null) throw new Error(`Invalid semantic version: ${version}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** @param version Version string. @returns Prerelease identifiers or null. */
function parsePrerelease(version: string): string[] | null {
  const dash = version.indexOf('-')
  if (dash === -1) return null
  const withoutBuild = version.slice(dash + 1).split('+')[0] ?? ''
  const prerelease = withoutBuild.split('.').map(part => part.trim())
  return prerelease.some(part => part === '') ? null : prerelease
}

/**
 * Parses the version out of a release tag, tolerating optional prefixes.
 *
 * @param tagName GitHub release tag.
 * @returns The version portion of the tag.
 */
export function parseReleaseTag(tagName: string): string {
  let stripped = tagName.startsWith(RELEASE_TAG_PREFIX) ? tagName.slice(RELEASE_TAG_PREFIX.length) : tagName
  if (stripped.startsWith('v')) stripped = stripped.slice(1)
  if (!/^\d+\.\d+\.\d+/.test(stripped)) {
    throw new Error(`Unrecognized desktop release tag: ${tagName}`)
  }
  return stripped
}

/**
 * Selects the platform update asset from a release's asset list.
 *
 * @param assets Release assets.
 * @param platform Target platform.
 * @returns The matching asset, or null when the release lacks one.
 */
export function selectUpdateAsset(assets: readonly ReleaseAsset[], platform: NodeJS.Platform): ReleaseAsset | null {
  const pattern = platform === 'win32' ? WINDOWS_ASSET_PATTERN : MAC_ASSET_PATTERN
  return assets.find(asset => pattern.test(asset.name)) ?? null
}

/** @param repository `owner/repo` string. @returns Releases API listing URL. */
export function releasesUrl(repository: string): string {
  const [owner, repo] = repository.split('/')
  if (owner === undefined || repo === undefined || owner === '' || repo === '') {
    throw new Error(`Invalid update repository: ${repository}`)
  }
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`
}

/**
 * Computes the SHA-256 hex digest of one file.
 *
 * @param filePath Path of the downloaded artifact.
 * @param readFile Injectable file reader.
 * @returns Lowercase hex digest.
 */
export async function sha256Of(filePath: string, readFile: (path: string) => Promise<Buffer>): Promise<string> {
  const hash = createHash('sha256')
  hash.update(await readFile(filePath))
  return hash.digest('hex')
}

/**
 * Verifies a downloaded artifact against a release checksum asset.
 *
 * Supports a combined `checksums.txt`/`checksums.sha256` asset with
 * `<digest>  <name>` lines, or a per-asset `<name>.sha256` file containing
 * one digest. Missing checksum assets fail the verification.
 *
 * @param artifactPath Downloaded artifact path.
 * @param artifactName Artifact file name (checksum line lookup key).
 * @param checksumAssets Release checksum assets.
 * @param fetchText Fetches one text document.
 * @param readFile Reads the downloaded artifact.
 * @returns The expected digest when verification passes.
 */
export async function verifyArtifactChecksum(
  artifactPath: string,
  artifactName: string,
  checksumAssets: readonly ReleaseAsset[],
  fetchText: (url: string) => Promise<string>,
  readFile: (path: string) => Promise<Buffer>,
): Promise<string> {
  const expected = await resolveExpectedDigest(artifactName, checksumAssets, fetchText)
  const actual = await sha256Of(artifactPath, readFile)
  if (actual !== expected.toLowerCase()) {
    throw new Error(`Update artifact checksum mismatch for ${artifactName}`)
  }
  return expected
}

/** @param artifactName Asset name. @param assets Checksum assets. @param fetchText Text fetcher. */
async function resolveExpectedDigest(
  artifactName: string,
  assets: readonly ReleaseAsset[],
  fetchText: (url: string) => Promise<string>,
): Promise<string> {
  const combined = assets.find(asset => CHECKSUM_NAMES.includes(asset.name))
  if (combined !== undefined) {
    const text = await fetchText(combined.browser_download_url)
    for (const line of text.split(/\r?\n/)) {
      const match = /^([0-9a-fA-F]{64})\s+(?:\*)?(.+)$/.exec(line.trim())
      if (match !== null && match[2] === artifactName) {
        if (match[1] === undefined) throw new Error(`Checksum line has no digest: ${line}`)
        return match[1]
      }
    }
  }
  const perAsset = assets.find(asset => asset.name === `${artifactName}.sha256`)
  if (perAsset !== undefined) {
    const digest = (await fetchText(perAsset.browser_download_url)).trim()
    if (/^[0-9a-fA-F]{64}$/.test(digest)) return digest
  }
  throw new Error(`No checksum asset found for ${artifactName}`)
}

/**
 * Finds the newest release satisfying the channel, or null when it is not
 * newer than the current version.
 *
 * @param repository `owner/repo` update source.
 * @param channel Release channel.
 * @param currentVersion Installed version.
 * @param fetchJson Injectable JSON fetcher.
 * @returns The update to install, or null when up to date.
 */
export async function findUpdate(
  repository: string,
  channel: UpdateChannel,
  currentVersion: string,
  platform: NodeJS.Platform,
  fetchJson: (url: string) => Promise<unknown>,
): Promise<UpdateInfo | null> {
  const releases = (await fetchJson(releasesUrl(repository))) as GitHubRelease[]
  if (!Array.isArray(releases)) throw new Error(`Unexpected GitHub releases response for ${repository}`)
  let newest: { release: GitHubRelease; version: string } | null = null
  for (const release of releases) {
    if (channel === 'stable' && release.prerelease) continue
    let version: string
    try {
      version = parseReleaseTag(release.tag_name)
    } catch {
      continue
    }
    if (newest === null || compareSemver(version, newest.version) > 0) {
      newest = { release, version }
    }
  }
  if (newest === null || compareSemver(newest.version, currentVersion) <= 0) return null
  const asset = selectUpdateAsset(newest.release.assets, platform)
  return {
    version: newest.version,
    tagName: newest.release.tag_name,
    assetUrl: asset?.browser_download_url ?? null,
    assetName: asset?.name ?? null,
    notes: newest.release.body ?? '',
    publishedAt: newest.release.published_at,
  }
}

/** Result of one update check presented to the user. */
export type ManualCheckResult =
  | { kind: 'up-to-date' }
  | { kind: 'error'; message: string }
  | { kind: 'available'; update: UpdateInfo }

/**
 * Owns the update lifecycle: check, download, verify, and apply.
 *
 * The class keeps every Electron dependency behind the injected runtime ops,
 * so unit tests exercise check, verification, and application decisions with
 * fixtures. The application layer supplies real fetch, dialog, and process
 * operations from the Electron main process.
 */
export class DesktopUpdater {
  readonly #currentVersion: string
  readonly #platform: NodeJS.Platform
  readonly #preferences: UpdaterPreferences
  readonly #ops: UpdaterRuntimeOps
  readonly #logger: DesktopLogSink
  #checking = false

  /**
   * Creates an updater for one application version and platform.
   *
   * @param options Version, platform, preferences, operations, and logger.
   */
  constructor(options: DesktopUpdaterOptions) {
    this.#currentVersion = options.currentVersion
    this.#platform = options.platform
    this.#preferences = options.preferences
    this.#ops = options.ops
    this.#logger = options.logger
  }

  /**
   * Runs one update check and reports the outcome without side effects.
   *
   * @returns The check result; `available` carries the update to install.
   */
  async check(): Promise<ManualCheckResult> {
    if (this.#checking) return { kind: 'error', message: 'Update check already in progress' }
    this.#checking = true
    try {
      const update = await findUpdate(
        this.#preferences.repository,
        this.#preferences.channel,
        this.#currentVersion,
        this.#platform,
        this.#ops.fetchJson,
      )
      this.#logger.log('updater-checked', {
        repository: this.#preferences.repository,
        updateVersion: update?.version ?? null,
      })
      if (update === null) return { kind: 'up-to-date' }
      if (update.assetUrl === null || update.assetName === null) {
        return { kind: 'error', message: `Release ${update.tagName} has no ${this.#platform} asset` }
      }
      return { kind: 'available', update }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#logger.log('updater-check-failed', { message })
      return { kind: 'error', message }
    } finally {
      this.#checking = false
    }
  }

  /**
   * Downloads, verifies, and installs one update, asking before applying.
   *
   * @param update The update to install.
   * @param downloadDirectory Temporary directory for the artifact.
   * @returns Whether the update was staged and the application will quit.
   */
  async install(update: UpdateInfo, downloadDirectory: string): Promise<boolean> {
    if (update.assetUrl === null || update.assetName === null) {
      throw new Error(`Update ${update.tagName} has no ${this.#platform} asset`)
    }
    const artifactPath = join(downloadDirectory, update.assetName)
    const choice = await this.#ops.dialog(
      `Update ${update.version} is available`,
      `Download and install ${update.assetName}?`,
      ['Download & Install', 'Later'],
    )
    if (choice !== 'Download & Install') {
      this.#logger.log('updater-declined', { version: update.version })
      return false
    }
    try {
      this.#logger.log('updater-downloading', { version: update.version })
      await this.#ops.download(update.assetUrl, artifactPath)
      await this.#verifyChecksum(update, artifactPath)
      this.#logger.log('updater-downloaded', { version: update.version, path: artifactPath })
      await this.#apply(update, artifactPath)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#logger.log('updater-install-failed', { version: update.version, message })
      await this.#ops.unlink(artifactPath).catch(() => {})
      throw error
    }
  }

  /** @param update Update being installed. @param artifactPath Downloaded artifact. */
  async #verifyChecksum(update: UpdateInfo, artifactPath: string): Promise<void> {
    const release = (await this.#ops.fetchJson(`https://api.github.com/repos/${this.#preferences.repository}/releases/tags/${update.tagName}`)) as GitHubRelease
    const checksumAssets = Array.isArray(release.assets) ? release.assets : []
    await verifyArtifactChecksum(
      artifactPath,
      update.assetName ?? '',
      checksumAssets,
      this.#ops.fetchText,
      this.#ops.readFile,
    )
  }

  /** @param update Update being installed. @param artifactPath Downloaded artifact. */
  async #apply(update: UpdateInfo, artifactPath: string): Promise<void> {
    if (this.#platform === 'win32') {
      const confirm = await this.#ops.dialog(
        'Ready to update',
        'DeepSeek Harness will quit and the installer will finish the update.',
        ['Update Now', 'Later'],
      )
      if (confirm !== 'Update Now') return
      this.#logger.log('updater-applying', { version: update.version, platform: 'win32' })
      this.#ops.spawnDetached(artifactPath, ['/S'])
      this.#ops.quit()
      return
    }
    if (this.#platform === 'darwin') {
      const confirm = await this.#ops.dialog(
        'Ready to update',
        'DeepSeek Harness will quit, install the new version into /Applications, and relaunch.',
        ['Update Now', 'Later'],
      )
      if (confirm !== 'Update Now') return
      this.#logger.log('updater-applying', { version: update.version, platform: 'darwin' })
      // The script waits for this process to exit, then installs and relaunches.
      this.#ops.quit()
      const result = await this.#ops.runShellScript(macInstallScript(artifactPath), true)
      if (!result.ok) {
        this.#logger.log('updater-mac-install-failed', { version: update.version, detail: result.detail })
      }
      return
    }
    throw new Error(`Automatic updates are unsupported on ${this.#platform}`)
  }

  /**
   * Runs one check and presents the outcome through dialogs.
   *
   * @returns The resolved check result (post-dialog).
   */
  async manualCheck(): Promise<ManualCheckResult> {
    const result = await this.check()
    if (result.kind === 'up-to-date') {
      await this.#ops.dialog('Up to date', 'You are running the latest version.', ['OK'])
    } else if (result.kind === 'error') {
      await this.#ops.dialog('Update check failed', result.message, ['OK'])
    }
    return result
  }
}

/**
 * Builds the elevated macOS install shell script for one downloaded DMG.
 *
 * The script attaches the DMG, replaces the application bundle, strips the
 * download quarantine (the personal build is ad-hoc signed and not
 * notarized), detaches, and relaunches the app.
 *
 * @param artifactPath Downloaded DMG path.
 * @returns Shell script executed with administrator privileges.
 */
export function macInstallScript(artifactPath: string): string {
  return [
    'set -e',
    // Wait for the quitting application to exit before replacing its bundle.
    'while pgrep -x "DeepSeek Harness" >/dev/null 2>&1; do sleep 1; done',
    `DMG=${JSON.stringify(artifactPath)}`,
    'MOUNT=$(hdiutil attach -nobrowse -quiet "$DMG" | tail -1 | sed "s/.*\\/Volumes\\///;s/\\t.*//")',
    'APP=$(find "/Volumes/$MOUNT" -maxdepth 1 -name "*.app" | head -1)',
    'ditto "$APP" "/Applications/DeepSeek Harness.app"',
    'xattr -dr com.apple.quarantine "/Applications/DeepSeek Harness.app"',
    'hdiutil detach "/Volumes/$MOUNT" -quiet',
    'open "/Applications/DeepSeek Harness.app"',
  ].join('\n')
}
