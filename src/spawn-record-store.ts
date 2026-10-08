/**
 * What each opencode session's `claude` process REALLY spawned as: model,
 * effort and account. Written by the server half on every turn that reaches
 * the CLI, read by the TUI half's `Subagents` sidebar section (`src/tui.ts`).
 *
 * ## Why a file, and why the TUI cannot read this anywhere else
 *
 * Measured on opencode 1.18.35 (h #g234): an `implementor` subagent whose
 * agent file says `forceModel: claude-sonnet-5-5` and `reasoningEffort: high`
 * spawned as exactly that, while the finished `task` part's `metadata.model`
 * said `claude-code-default/claude-opus-5-5` and no message carried an effort
 * at all. Everything that changes a spawn on the plugin side (an agent's
 * `forceModel` and `reasoningEffort`, `defaultSubagentModel`, the dispatch form
 * of h #g227, the fallback chain of h #g162, an account failover) is invisible
 * to opencode by construction, so showing opencode's own view would be showing
 * the wrong model exactly when the operator configured it not to be. The two
 * halves do not share memory on either major (1.x runs the server half in a
 * worker thread, 2.x in a subprocess), so the record goes through the state
 * directory the resume and dispatch stores already use.
 *
 * ## Shape, and what is never written
 *
 * ```json
 * { "version": 1, "sessions": {
 *     "ses_abc": { "model": "claude-sonnet-5-5", "effort": "high", "account": "alpha", "at": 1760000000000 } } }
 * ```
 *
 * A model id, an effort level and an account NAME: the same three strings the
 * dispatch store keeps (h #g228), none secret. No prompt, no path, no session
 * key. `account` is written only on a multi-account install, where it tells
 * two configured accounts apart; on a single-account install there is nothing
 * to tell apart and it stays out.
 *
 * ## Cost and failure
 *
 * One write per session per process, and another only when what it spawns as
 * changes: `recordSessionSpawn` compares against what this process last wrote
 * and returns before touching the disk otherwise. Same discipline as the
 * resume store (h #g197): merge-on-write so two opencode processes do not erase
 * each other, atomic rename, `0600` in the `0700` directory, bounded at
 * `MAX_SPAWN_RECORDS` newest sessions and `SPAWN_RECORD_MAX_AGE_MS`. A missing,
 * unreadable or half-written file is an empty store, which costs the sidebar
 * its effort and falls back to the model opencode asked for. Two writers racing
 * can drop one entry; the next turn of that session writes it again, and the
 * only thing it ever costs is a label.
 *
 * Imports nothing that logs, because the TUI bundle reads it on the terminal's
 * own thread (h #g193): every function here is silent and never throws.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface SpawnRecord {
  model?: string
  effort?: string
  account?: string
  at: number
}

/** Sessions worth remembering at once. A subagent fan-out names a handful. */
export const MAX_SPAWN_RECORDS = 256

/** A session not spawned this long ago is not one the sidebar is showing. */
export const SPAWN_RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

let pathOverride: string | null = null
const lastWritten = new Map<string, string>()

export function spawnRecordStorePath(): string {
  if (pathOverride) return pathOverride
  const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(stateRoot, "opencode-claude-code-plugin", "session-spawns.json")
}

function isRecord(value: unknown): value is SpawnRecord {
  const record = value as SpawnRecord | null
  if (!record || typeof record !== "object" || Array.isArray(record)) return false
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) return false
  const ok = (field: unknown) => field === undefined || typeof field === "string"
  if (!ok(record.model) || !ok(record.effort) || !ok(record.account)) return false
  return !!record.model
}

function readEntries(file: string): Map<string, SpawnRecord> {
  const out = new Map<string, SpawnRecord>()
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    const entries = parsed && typeof parsed === "object" ? parsed.sessions : null
    if (!entries || typeof entries !== "object") return out
    const cutoff = Date.now() - SPAWN_RECORD_MAX_AGE_MS
    const valid = Object.entries(entries as Record<string, unknown>)
      .filter((entry): entry is [string, SpawnRecord] => isRecord(entry[1]))
      .filter(([, record]) => record.at >= cutoff)
      .sort((a, b) => a[1].at - b[1].at)
    for (const [key, record] of valid) {
      out.set(key, {
        model: record.model,
        ...(record.effort ? { effort: record.effort } : {}),
        ...(record.account ? { account: record.account } : {}),
        at: record.at,
      })
    }
  } catch {
    // ENOENT before the first spawn, or a file another process is renaming
    // into place: the empty store is the answer.
  }
  return out
}

/**
 * Record what `sessionID` spawned as. Returns whether the disk was written,
 * which is false for an unchanged record, an unusable id and a failed write
 * alike: the caller has nothing to do about any of them.
 */
export function recordSessionSpawn(
  sessionID: string,
  spawn: { model: string; effort?: string; account?: string },
  now: number = Date.now(),
): boolean {
  if (!sessionID || sessionID === "default" || !spawn.model) return false
  const record: SpawnRecord = {
    model: spawn.model,
    ...(spawn.effort ? { effort: spawn.effort } : {}),
    ...(spawn.account ? { account: spawn.account } : {}),
    at: now,
  }
  const fingerprint = `${record.model}\n${record.effort ?? ""}\n${record.account ?? ""}`
  if (lastWritten.get(sessionID) === fingerprint) return false
  const file = spawnRecordStorePath()
  const merged = readEntries(file)
  merged.delete(sessionID)
  merged.set(sessionID, record)
  const cutoff = now - SPAWN_RECORD_MAX_AGE_MS
  const kept = [...merged.entries()]
    .filter(([, entry]) => entry.at >= cutoff)
    .sort((a, b) => a[1].at - b[1].at)
    .slice(-MAX_SPAWN_RECORDS)
  try {
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, sessions: Object.fromEntries(kept) }), {
      mode: 0o600,
    })
    renameSync(tmp, file)
  } catch {
    return false
  }
  if (lastWritten.size >= MAX_SPAWN_RECORDS) lastWritten.clear()
  lastWritten.set(sessionID, fingerprint)
  return true
}

/**
 * A reader that re-parses the file only when it changed. The TUI calls `read()`
 * on every refresh; an unchanged file costs one `stat`.
 */
export function createSpawnRecordReader(file: () => string = spawnRecordStorePath) {
  let identity = ""
  let cached = new Map<string, SpawnRecord>()
  return {
    read(): Map<string, SpawnRecord> {
      const path = file()
      let next = ""
      try {
        const stats = statSync(path)
        next = `${stats.mtimeMs}:${stats.size}:${stats.ino}`
      } catch {
        next = "missing"
      }
      if (next !== identity) {
        identity = next
        cached = next === "missing" ? new Map() : readEntries(path)
      }
      return cached
    },
  }
}

export function _setSpawnRecordStorePathForTests(path: string | null): void {
  pathOverride = path
  lastWritten.clear()
}
