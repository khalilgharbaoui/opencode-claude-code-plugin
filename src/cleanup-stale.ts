// Removes a stale unscoped `opencode-claude-code-plugin` install left in
// opencode's plugin cache by older configs. The unscoped name is a different
// artifact than this scoped plugin and shadows it when both coexist.
// Disable with OPENCODE_CLAUDE_CODE_PLUGIN_NO_CLEANUP=1.

import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
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

export function cleanupStaleUnscopedInstall(): void {
  if (alreadyRan) return
  alreadyRan = true

  if (process.env.OPENCODE_CLAUDE_CODE_PLUGIN_NO_CLEANUP === "1") return
  if (userIntendsToUseUnscoped()) return

  const ourDir = ourLoadedDir()

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
