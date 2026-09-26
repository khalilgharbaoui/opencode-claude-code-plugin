// Removes a stale unscoped `opencode-claude-code-plugin` install left in
// opencode's plugin cache by older configs. The unscoped name is a different
// artifact than this scoped plugin and shadows it when both coexist.
// Disable with OPENCODE_CLAUDE_CODE_PLUGIN_NO_CLEANUP=1.
//
// This walks and mutates opencode's plugin cache, so it is gated on a marker
// carrying the plugin version that last swept: one sweep per installed
// version, not one per plugin load. Force one with
// OPENCODE_CLAUDE_CODE_PLUGIN_FORCE_CLEANUP=1.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { log } from "./logger.js"

const STALE_PACKAGE_NAME = "opencode-claude-code-plugin"
const SUSPECT_DESCRIPTION_TOKEN = "Claude Code"

let alreadyRan = false

function candidateCacheRoots(): string[] {
  const xdg = process.env.XDG_CACHE_HOME
  return [
    xdg ? join(xdg, "opencode") : null,
    join(homedir(), ".cache", "opencode"),
    join(homedir(), "Library", "Caches", "opencode"),
  ].filter((p): p is string => Boolean(p))
}

function userOpencodeJsonPath(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  return join(xdgConfig, "opencode", "opencode.json")
}

function userIntendsToUseUnscoped(): boolean {
  const cfg = userOpencodeJsonPath()
  if (!existsSync(cfg)) return false
  try {
    const json = JSON.parse(readFileSync(cfg, "utf8"))
    const plugins: unknown = json.plugin
    if (!Array.isArray(plugins)) return false
    return plugins.some(
      (entry) =>
        typeof entry === "string" &&
        /^opencode-claude-code-plugin(@[^/]+)?$/.test(entry),
    )
  } catch {
    return false
  }
}

function ourLoadedDir(): string | null {
  try {
    const filePath = fileURLToPath(import.meta.url)
    return realpathSync(resolve(filePath, "..", ".."))
  } catch {
    return null
  }
}

/** This plugin's own version, or null when its package.json is unreadable. */
function ourVersion(dir: string | null): string | null {
  if (!dir) return null
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
    return typeof pkg.version === "string" && pkg.version ? pkg.version : null
  } catch {
    return null
  }
}

/**
 * Where the "which version last swept" marker lives. Deliberately not inside
 * opencode's cache: that is the very tree this module deletes from, and
 * opencode rebuilds it.
 */
function markerPath(): string {
  const stateRoot =
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state")
  return join(stateRoot, "opencode-claude-code-plugin", "cleanup-stale.json")
}

function markerVersion(): string | null {
  try {
    const marker = JSON.parse(readFileSync(markerPath(), "utf8"))
    return typeof marker.version === "string" ? marker.version : null
  } catch {
    return null
  }
}

function writeMarker(version: string): void {
  const file = markerPath()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({ version, at: new Date().toISOString() }, null, 2) + "\n",
      "utf8",
    )
  } catch (err) {
    // Not fatal: without the marker the sweep simply runs again next load.
    log.warn("cleanup-stale: could not record the sweep marker", {
      file,
      error: String(err),
    })
  }
}

/** Test seam: re-arms the once-per-process guard. */
export function _resetCleanupStaleState(): void {
  alreadyRan = false
}

export function cleanupStaleUnscopedInstall(): void {
  if (alreadyRan) return
  alreadyRan = true

  if (process.env.OPENCODE_CLAUDE_CODE_PLUGIN_NO_CLEANUP === "1") return
  if (userIntendsToUseUnscoped()) return

  const ourDir = ourLoadedDir()

  // A version we cannot read cannot be recorded either, so that case keeps the
  // old behaviour: once per process, no marker written.
  const version = ourVersion(ourDir)
  const forced = process.env.OPENCODE_CLAUDE_CODE_PLUGIN_FORCE_CLEANUP === "1"
  if (version && !forced && markerVersion() === version) return

  for (const cacheRoot of candidateCacheRoots()) {
    try {
      cleanupOne(cacheRoot, ourDir)
    } catch (err) {
      log.warn("cleanup-stale: error processing cache root", {
        cacheRoot,
        error: String(err),
      })
    }
  }

  if (version) writeMarker(version)
}

function cleanupOne(cacheRoot: string, ourDir: string | null): void {
  if (!existsSync(cacheRoot)) return

  const stalePath = join(cacheRoot, "node_modules", STALE_PACKAGE_NAME)
  if (!existsSync(stalePath)) return

  // Don't self-delete if we are the unscoped install.
  let realStalePath = stalePath
  try {
    realStalePath = realpathSync(stalePath)
  } catch {
    // ignore
  }
  if (ourDir && realStalePath === ourDir) return

  // Verify identity before removing.
  const pkgJsonPath = join(stalePath, "package.json")
  if (!existsSync(pkgJsonPath)) return
  let pkg: { name?: string; description?: string } = {}
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"))
  } catch {
    return
  }
  if (pkg.name !== STALE_PACKAGE_NAME) return
  if (!pkg.description?.includes(SUSPECT_DESCRIPTION_TOKEN)) return

  log.info("cleanup-stale: removing unscoped install", { stalePath })
  try {
    rmSync(stalePath, { recursive: true, force: true })
  } catch (err) {
    log.warn("cleanup-stale: rmSync failed", {
      stalePath,
      error: String(err),
    })
    return
  }

  // Drop the dep from the cache root's package.json so opencode's installer
  // doesn't reinstate it on its next pass. Lockfile is left alone; bun
  // reconciles against package.json on the next install.
  const cachePkgJson = join(cacheRoot, "package.json")
  if (!existsSync(cachePkgJson)) return
  try {
    const cfg = JSON.parse(readFileSync(cachePkgJson, "utf8"))
    if (cfg?.dependencies?.[STALE_PACKAGE_NAME]) {
      delete cfg.dependencies[STALE_PACKAGE_NAME]
      writeFileSync(cachePkgJson, JSON.stringify(cfg, null, 2) + "\n")
      log.info("cleanup-stale: pruned dep from cache package.json")
    }
  } catch (err) {
    log.warn("cleanup-stale: cache package.json update failed", {
      error: String(err),
    })
  }
}
