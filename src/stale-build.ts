import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { formatLocalMinute } from "./cli-events.js"
import { log } from "./logger.js"
import { pluginVersion } from "./startup-diagnostics.js"

/**
 * Is the opencode process you are talking to still running the plugin build it
 * loaded at startup, rather than the one on disk?
 *
 * opencode reads a plugin's code once, when the process starts, and never
 * again. A machine that has had opencode open for a fortnight can therefore be
 * running a build from a fortnight ago while the package manager, the npm
 * registry and `git log` all agree on something newer, and nothing anywhere
 * says so. On 2026-10-03 that cost a live debugging session: an account
 * failover answered `unrecognised answer`, a defect 0.29.2 had fixed, because
 * the window answering it had been open since 2026-09-22 and was running
 * 0.29.1. Ten opencode processes were alive at the time. See (h #g192).
 *
 * Two shapes of wrong, because there are two ways to install this package:
 *
 * - `version`: the manifest on disk names a different version than the one
 *   this process loaded. That is an npm install or an upgrade.
 * - `rebuilt`: the version is the same but the entry file's mtime or size
 *   changed. That is a `file://` install, which the maintainer runs, where
 *   `npm run build` replaces `dist/index.js` without touching the version.
 *
 * Everything here fails to "nothing". A package cache directory deleted but
 * not yet repopulated, a build caught mid-`clean`, a read-only mount: none of
 * them is evidence that the running build is stale, and a note that fires on
 * them would be noise in exactly the moment the operator is busy. The only
 * output is one text note, one WARN and one doctor row.
 */

/** Leads the note's own text part, so `message-builder` can strip it. */
export const STALE_BUILD_MARKER = "▌ **restart opencode:**"

/**
 * At most one stat pair per minute. An ordinary turn then does no I/O at all:
 * the first turn of a minute reads, every other turn reads the cached verdict.
 */
export const STALE_BUILD_THROTTLE_MS = 60_000

/**
 * How many opencode sessions are remembered as already told. Bounded because
 * the process can outlive any number of sessions, and small because the only
 * thing forgetting costs is one repeated note in a very old conversation.
 */
export const STALE_BUILD_SESSION_CAP = 64

/** The build this process is RUNNING. Recorded once, at module load. */
export interface LoadedBuild {
  version: string
  /** The module file opencode imported: `dist/index.js` in a real install. */
  entryPath: string
  /** Undefined when the entry file could not be stat'd at load. */
  mtimeMs: number | undefined
  size: number | undefined
  loadedAt: number
}

/** The build that is on DISK right now. Read uncached, every check. */
export interface OnDiskBuild {
  version: string
  mtimeMs: number
  size: number
}

export type StaleBuildKind = "version" | "rebuilt"

export interface StaleBuild {
  kind: StaleBuildKind
  loadedVersion: string
  onDiskVersion: string
  loadedAt: number
  /** When the entry file on disk was last written. Only for `rebuilt`. */
  rebuiltAt?: number
}

export type StaleBuildVerdict = StaleBuildKind | "current" | "unreadable"

export interface StaleBuildStatus {
  loaded: LoadedBuild
  /** Undefined means the check could not read the disk, which is not stale. */
  onDisk: OnDiskBuild | undefined
  stale: StaleBuild | null
  verdict: StaleBuildVerdict
}

/**
 * The whole decision, pure. `onDisk` undefined is "could not read", which is
 * deliberately indistinguishable from "current" to every caller but the
 * doctor: an unreadable manifest is not evidence of anything.
 */
export function compareBuilds(
  loaded: LoadedBuild,
  onDisk: OnDiskBuild | undefined,
): StaleBuild | null {
  if (!onDisk) return null
  if (onDisk.version !== loaded.version) {
    return {
      kind: "version",
      loadedVersion: loaded.version,
      onDiskVersion: onDisk.version,
      loadedAt: loaded.loadedAt,
    }
  }
  // No baseline means a rebuild cannot be told from the build we are running,
  // so the same rule applies: say nothing.
  if (loaded.mtimeMs === undefined || loaded.size === undefined) return null
  if (onDisk.mtimeMs === loaded.mtimeMs && onDisk.size === loaded.size) return null
  return {
    kind: "rebuilt",
    loadedVersion: loaded.version,
    onDiskVersion: onDisk.version,
    loadedAt: loaded.loadedAt,
    rebuiltAt: onDisk.mtimeMs,
  }
}

/**
 * Re-exported, not defined here: the usage-limit note needs the same local
 * minute and `src/cli-events.ts` already owns the reset-time formatters, so
 * that is where it lives now. The name stays importable from here because this
 * is the module whose notes are built out of it.
 */
export { formatLocalMinute }

/**
 * The note, in the operator's own words rather than the plugin's: what is
 * running, what is on disk, and the one action that fixes it. Its own text
 * part, led by the marker, so a rebuilt transcript drops it (h #g108).
 */
export function formatStaleBuildNote(stale: StaleBuild): string {
  const loadedAt = formatLocalMinute(stale.loadedAt)
  if (stale.kind === "version") {
    return (
      `${STALE_BUILD_MARKER} plugin ${stale.onDiskVersion} is on disk, but this opencode ` +
      `process still runs ${stale.loadedVersion}, loaded ${loadedAt}. opencode reads a ` +
      `plugin once at startup, so fixes since then are not active here: quit every ` +
      `opencode window and relaunch.`
    )
  }
  const rebuiltAt = stale.rebuiltAt === undefined ? "since" : `at ${formatLocalMinute(stale.rebuiltAt)}`
  return (
    `${STALE_BUILD_MARKER} this opencode process loaded plugin ${stale.loadedVersion} at ` +
    `${loadedAt}, and that build was rebuilt on disk ${rebuiltAt}. opencode reads a plugin ` +
    `once at startup, so what you just built is not running here: quit every opencode ` +
    `window and relaunch.`
  )
}

/** The doctor's one-line verdict. Prints no path and no text the plugin did not write. */
export function describeBuildStatus(status: StaleBuildStatus): string {
  const loadedAt = formatLocalMinute(status.loaded.loadedAt)
  switch (status.verdict) {
    case "current":
      return `${status.loaded.version}, loaded ${loadedAt}, current`
    case "version":
      return (
        `${status.loaded.version}, loaded ${loadedAt}; on disk ` +
        `${status.onDisk?.version ?? "unknown"}. Restart opencode to run it`
      )
    case "rebuilt":
      return (
        `${status.loaded.version}, loaded ${loadedAt}; the same version was rebuilt on disk ` +
        `${status.onDisk ? `at ${formatLocalMinute(status.onDisk.mtimeMs)}` : "since"}. ` +
        `Restart opencode to run it`
      )
    case "unreadable":
      return `${status.loaded.version}, loaded ${loadedAt}; the build on disk could not be read`
  }
}

export interface StaleBuildIo {
  loaded: LoadedBuild
  /** Uncached. Returns undefined for every failure, including a missing file. */
  readOnDisk: () => OnDiskBuild | undefined
  now: () => number
  throttleMs?: number
  /**
   * Seam: what the once-per-identity WARN does. Only the data, never the
   * message: `log-message-scan.ts` reads the literal out of the warn call
   * below, and a message routed through a parameter would be classified as
   * runtime-built and redacted out of a diagnostic bundle.
   */
  warn?: (data: Record<string, unknown>) => void
}

export interface StaleBuildWatch {
  readonly loaded: LoadedBuild
  /** Throttled to one disk read per `throttleMs`; warns once per identity. */
  check(): StaleBuild | null
  /** Unthrottled, silent, and marks nothing. What `/claude-code-doctor` reads. */
  describe(): StaleBuildStatus
  /**
   * True the first time this opencode session is told, false afterwards.
   * Called at the moment the note is written, never when it is decided, so a
   * turn aborted before it asked Claude for work does not consume the session's
   * one note (h #g182).
   */
  claimSession(sessionId: string): boolean
  /** Test seam: which sessions have been told. */
  claimedSessions(): string[]
}

export function createStaleBuildWatch(io: StaleBuildIo): StaleBuildWatch {
  const throttleMs = io.throttleMs ?? STALE_BUILD_THROTTLE_MS
  const warn =
    io.warn ??
    ((data: Record<string, unknown>) => {
      log.warn(
        "this opencode process is running an older plugin build than the one on disk",
        data,
      )
    })
  const claimed = new Set<string>()
  const warned = new Set<string>()
  let checkedAt: number | undefined
  let cached: StaleBuild | null = null

  const read = (): StaleBuildStatus => {
    let onDisk: OnDiskBuild | undefined
    try {
      onDisk = io.readOnDisk()
    } catch {
      onDisk = undefined
    }
    const stale = compareBuilds(io.loaded, onDisk)
    const verdict: StaleBuildVerdict = !onDisk
      ? "unreadable"
      : stale
        ? stale.kind
        : "current"
    return { loaded: io.loaded, onDisk, stale, verdict }
  }

  return {
    get loaded() {
      return io.loaded
    },
    check(): StaleBuild | null {
      const now = io.now()
      if (checkedAt !== undefined && now - checkedAt < throttleMs) return cached
      checkedAt = now
      const status = read()
      cached = status.stale
      if (status.stale && status.onDisk) {
        // One WARN per on-disk identity: a second rebuild is news, the same
        // one seen on the next turn is not. It reaches stderr and a log file
        // that is off by default, which is why the note and the doctor row
        // exist as well.
        const identity = `${status.stale.kind}:${status.onDisk.version}:${status.onDisk.mtimeMs}:${status.onDisk.size}`
        if (!warned.has(identity)) {
          warned.add(identity)
          warn({
            kind: status.stale.kind,
            loadedVersion: status.stale.loadedVersion,
            onDiskVersion: status.stale.onDiskVersion,
            path: io.loaded.entryPath,
          })
        }
      }
      return cached
    },
    describe(): StaleBuildStatus {
      return read()
    },
    claimSession(sessionId: string): boolean {
      if (claimed.has(sessionId)) return false
      claimed.add(sessionId)
      while (claimed.size > STALE_BUILD_SESSION_CAP) {
        const oldest = claimed.values().next()
        if (oldest.done) break
        claimed.delete(oldest.value)
      }
      return true
    },
    claimedSessions(): string[] {
      return [...claimed]
    },
  }
}

/**
 * The entry file opencode actually imported. In a published install tsup has
 * bundled every module into one `dist/index.js`, so this is that file and its
 * mtime is the build time; from a source checkout under tsx it is this file,
 * which is still replaced by any edit to it. The manifest sits one level up
 * from either, which is the same resolution `pluginVersion` uses.
 */
function defaultEntryPath(): string {
  return fileURLToPath(import.meta.url)
}

function readOnDiskBuild(entryPath: string): OnDiskBuild | undefined {
  try {
    // Uncached on purpose: `pluginVersion()` memoises the LOADED version, and
    // comparing a cached value with itself can only ever say "current".
    const raw = fs.readFileSync(path.join(path.dirname(entryPath), "..", "package.json"), "utf8")
    const version = (JSON.parse(raw) as { version?: unknown }).version
    if (typeof version !== "string" || version.length === 0) return undefined
    const stat = fs.statSync(entryPath)
    return { version, mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return undefined
  }
}

function recordLoadedBuild(): LoadedBuild {
  const entryPath = defaultEntryPath()
  let mtimeMs: number | undefined
  let size: number | undefined
  try {
    const stat = fs.statSync(entryPath)
    mtimeMs = stat.mtimeMs
    size = stat.size
  } catch {
    // A build we cannot stat still has a version, so `version` staleness keeps
    // working; only `rebuilt` goes quiet.
  }
  return { version: pluginVersion(), entryPath, mtimeMs, size, loadedAt: Date.now() }
}

/**
 * The running build, recorded when this module is evaluated, which is when
 * opencode imported the plugin. Not on first use: a process whose first turn
 * comes after a rebuild would take the rebuilt file as its baseline and never
 * say `rebuilt`, and the note's "loaded" time would be that first turn's.
 */
const loadedAtImport = recordLoadedBuild()

let watch: StaleBuildWatch | undefined

/** The process's one watch, over the build recorded at import. */
export function staleBuildWatch(): StaleBuildWatch {
  if (!watch) {
    const loaded = loadedAtImport
    watch = createStaleBuildWatch({
      loaded,
      readOnDisk: () => readOnDiskBuild(loaded.entryPath),
      now: () => Date.now(),
    })
  }
  return watch
}

/** Test seam: replace or drop the process watch. */
export function _setStaleBuildWatch(next: StaleBuildWatch | undefined): void {
  watch = next
}
