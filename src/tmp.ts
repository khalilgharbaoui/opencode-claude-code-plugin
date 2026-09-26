import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { log } from "./logger.js"

/**
 * Per-process scratch directory for plugin tmp files (bridged MCP config,
 * proxy server config, etc.). Created lazily on first use and rm'd on
 * normal process exit so we don't leak across runs. PID-isolated so two
 * concurrent opencode processes don't race on the same files.
 *
 * The OS tmpdir is world-writable on a shared Linux host, so the pid name is
 * guessable and pre-creatable by another user. Two rules keep that from
 * turning into a file swap: the directory is created 0700, and a path that
 * already exists but is a symlink, is not a directory, or is not owned by
 * the current user is refused outright in favour of a fresh `mkdtempSync`
 * name. The pid name is still what the normal case uses.
 *
 * Caveat: `process.on("exit")` does not fire for SIGKILL or unhandled
 * external signals, so abnormal terminations still leak. OS-level tmpdir
 * cleanup (`systemd-tmpfiles`, macOS periodic) handles those eventually.
 */
export const PLUGIN_TMP_PREFIX = "opencode-claude-code-"

const PID_TMP_DIR = path.join(
  os.tmpdir(),
  `${PLUGIN_TMP_PREFIX}${process.pid}`,
)

/** The directory this process settled on, once resolved. */
let currentDir: string | null = null
/** Every directory we created, so one exit hook can clean all of them. */
const createdDirs = new Set<string>()
let registered = false

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined
}

/**
 * Why `dir` must not be used as-is, or null when it is absent (we will
 * create it) or already a directory we own. `lstat`, never `stat`: the whole
 * point is to see a symlink rather than follow it.
 */
function untrustworthyReason(dir: string): string | null {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(dir)
  } catch {
    return null
  }
  if (stat.isSymbolicLink()) return "path is a symlink"
  if (!stat.isDirectory()) return "path is not a directory"
  const uid = currentUid()
  if (uid !== undefined && stat.uid !== uid) {
    return `directory is owned by uid ${stat.uid}, not ${uid}`
  }
  return null
}

/** Create `dir` 0700 (and re-assert the mode on a directory we already own). */
function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    // mkdir's mode is masked by the umask, so state it once more outright.
    fs.chmodSync(dir, 0o700)
  } catch {}
}

function chooseDir(): string {
  const reason = untrustworthyReason(PID_TMP_DIR)
  if (!reason) return PID_TMP_DIR

  // Someone else got to the pid name first. mkdtempSync creates 0700 and
  // fails rather than reusing an existing path, so the fresh name is safe.
  const fallback = fs.mkdtempSync(path.join(os.tmpdir(), PLUGIN_TMP_PREFIX))
  log.warn("refusing the pid-named scratch directory", {
    path: PID_TMP_DIR,
    reason,
    fallback,
  })
  return fallback
}

function registerExitCleanup(): void {
  if (registered) return
  registered = true
  process.on("exit", () => {
    for (const dir of createdDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  })
}

const PID_DIR_NAME = /^opencode-claude-code-(\d+)$/

/**
 * Alive from this process's point of view. `EPERM` means the pid exists but
 * belongs to somebody else, which is still alive and doubly not ours.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Remove scratch directories left behind by plugin processes that are gone.
 * The exit hook above never runs under SIGKILL, so a killed opencode leaves
 * its `mcp-<hash>.json` (which can hold `{env:VAR}`-substituted secrets)
 * on disk indefinitely.
 *
 * Four conditions, all required, because the OS tmpdir is shared: the name is
 * exactly our pid pattern, `lstat` says a real directory rather than a
 * symlink, the current user owns it, and the pid is not running. Anything
 * else is left untouched. Opt out with OPENCODE_CLAUDE_CODE_NO_TMP_SWEEP=1.
 *
 * Returns the directories removed, for tests and logging.
 */
export function sweepStalePluginTmpDirs(keep?: string): string[] {
  const removed: string[] = []
  if (process.env.OPENCODE_CLAUDE_CODE_NO_TMP_SWEEP === "1") return removed

  const root = os.tmpdir()
  let entries: string[]
  try {
    entries = fs.readdirSync(root)
  } catch {
    return removed
  }

  const uid = currentUid()
  const keepPath = keep ? path.resolve(keep) : null
  for (const entry of entries) {
    const match = PID_DIR_NAME.exec(entry)
    if (!match) continue
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    if (pid === process.pid) continue

    const dir = path.join(root, entry)
    if (keepPath && path.resolve(dir) === keepPath) continue

    let stat: fs.Stats
    try {
      stat = fs.lstatSync(dir)
    } catch {
      continue
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue
    if (uid !== undefined && stat.uid !== uid) continue
    if (isProcessAlive(pid)) continue

    try {
      fs.rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    } catch (err) {
      log.debug("could not remove a stale scratch directory", {
        dir,
        error: String(err),
      })
    }
  }

  if (removed.length > 0) {
    log.info("removed stale plugin scratch directories", {
      count: removed.length,
      dirs: removed,
    })
  }
  return removed
}

let swept = false

function sweepOnce(keep: string): void {
  if (swept) return
  swept = true
  try {
    sweepStalePluginTmpDirs(keep)
  } catch (err) {
    log.warn("stale scratch directory sweep failed", { error: String(err) })
  }
}

export function pluginTmpDir(): string {
  // Re-check every call: callers hold the string for the life of the process,
  // and a directory that became hostile mid-run must not keep being written to.
  if (currentDir === null || untrustworthyReason(currentDir) !== null) {
    currentDir = chooseDir()
  }
  ensureDir(currentDir)
  createdDirs.add(currentDir)
  registerExitCleanup()
  // First real use is this plugin's startup: nothing else in the module graph
  // is a reliable entry point we are allowed to hook.
  sweepOnce(currentDir)
  return currentDir
}

/** Test seam: forget the resolved directory without touching the exit hook. */
export function _resetPluginTmpDir(): void {
  currentDir = null
}

// Internal helpers exported for tests only.
export const __test = {
  untrustworthyReason,
  PID_TMP_DIR,
}
