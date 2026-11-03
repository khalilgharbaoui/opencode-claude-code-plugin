/**
 * The live half of the progress estimate's record (h #g251): how much output
 * a running turn has generated so far, which is the one measure of a turn's
 * progress the TUI cannot read off opencode's store. opencode shows the
 * turn's tool calls as they stream, but every API call within a step lands
 * in one assistant message, and a step's usage is reported as zeros until
 * the turn's `result` on purpose (h #g169, h #g225). The server half reads
 * each call's real output at its `message_delta` (the `assistant` frames
 * carry a placeholder, measured on 2.1.293: 6 against the call's 41) and
 * writes the turn's running total here, once per API call; the TUI reads it
 * beside the turn history and the estimate conditions on it
 * (`src/turn-model.ts`).
 *
 * ## Shape, and what is never written
 *
 * ```json
 * { "version": 1, "turns": { "5c1d0f3a": { "turn": 1760000000000, "out": 5321, "at": 1760000012345 } } }
 * ```
 *
 * Keyed by the session's tag (`sessionTag` in `src/turn-history.ts`, a hash
 * of its opencode session id, which the TUI computes from the same id), so
 * the file holds no session id at all. `turn` is when the server half saw
 * the turn start, which is how the TUI tells this turn's record from the
 * previous one's; `out` the output tokens the turn's calls have generated;
 * `at` the last write. Nothing else: no prompt, no path, no text.
 *
 * ## Cost and failure
 *
 * One small write per API call, the same discipline as the spawn record
 * store (h #g234): merge-on-write so two opencode processes do not erase each
 * other, atomic rename, `0600` in the `0700` directory, bounded at
 * `MAX_TURN_PROGRESS` newest turns and `TURN_PROGRESS_MAX_AGE_MS` since their
 * last write. A missing, unreadable or half-written file is an empty store,
 * which costs the estimate one input and nothing else.
 *
 * Imports nothing that logs, because the TUI bundle reads it on the
 * terminal's own thread (h #g193): every function here is silent and never
 * throws.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface TurnProgress {
  /** When the server half saw the turn start. */
  turn: number
  /** Output tokens the turn's API calls have generated so far. */
  out: number
  /** The last write. */
  at: number
}

/** Turns kept at once: one per session that has run a turn lately. */
export const MAX_TURN_PROGRESS = 64
/** A record not written this long is no running turn's. */
export const TURN_PROGRESS_MAX_AGE_MS = 24 * 60 * 60 * 1000

const TAG = /^[0-9a-f]{8}$/

let pathOverride: string | null = null

export function turnProgressStorePath(): string {
  if (pathOverride) return pathOverride
  const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(stateRoot, "opencode-claude-code-plugin", "turn-progress.json")
}

function isProgress(value: unknown): value is TurnProgress {
  const record = value as TurnProgress | null
  if (!record || typeof record !== "object" || Array.isArray(record)) return false
  const count = (field: unknown) => typeof field === "number" && Number.isFinite(field) && field >= 0
  return count(record.turn) && count(record.out) && count(record.at)
}

function readEntries(file: string, now: number): Map<string, TurnProgress> {
  const out = new Map<string, TurnProgress>()
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    const entries = parsed && typeof parsed === "object" ? parsed.turns : null
    if (!entries || typeof entries !== "object") return out
    const cutoff = now - TURN_PROGRESS_MAX_AGE_MS
    const valid = Object.entries(entries as Record<string, unknown>)
      .filter((entry): entry is [string, TurnProgress] => TAG.test(entry[0]) && isProgress(entry[1]))
      .filter(([, record]) => record.at >= cutoff)
      .sort((a, b) => a[1].at - b[1].at)
      .slice(-MAX_TURN_PROGRESS)
    for (const [tag, record] of valid) out.set(tag, { turn: record.turn, out: Math.round(record.out), at: record.at })
  } catch {
    // ENOENT before the first call, or a file another process is renaming
    // into place: the empty store is the answer.
  }
  return out
}

/**
 * Record that the turn `tag`'s session started at `turn` has generated `out`
 * output tokens so far. Returns whether the disk was written, which is false
 * for an unusable record and a failed write alike: the caller has nothing to
 * do about either.
 */
export function recordTurnProgress(tag: string, progress: { turn: number; out: number }, now: number = Date.now()): boolean {
  const record = { turn: progress.turn, out: progress.out, at: now }
  if (!TAG.test(tag) || !isProgress(record)) return false
  const file = turnProgressStorePath()
  const merged = readEntries(file, now)
  merged.delete(tag)
  merged.set(tag, { ...record, out: Math.round(record.out) })
  const kept = [...merged.entries()].slice(-MAX_TURN_PROGRESS)
  try {
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, turns: Object.fromEntries(kept) }), { mode: 0o600 })
    renameSync(tmp, file)
  } catch {
    return false
  }
  return true
}

/**
 * A reader that re-parses the file only when it changed. The TUI calls
 * `read()` on every refresh while something runs; an unchanged file costs
 * one `stat`. Every write renames a new file into place, so its `ino` always
 * changes, read exactly: as a number, an NTFS file id above 2^53 loses its
 * low bits, and two writes inside one timestamp tick, of the same size, read
 * back as the same file on Windows (h #g286).
 */
export function createTurnProgressReader(file: () => string = turnProgressStorePath) {
  let identity = ""
  let cached = new Map<string, TurnProgress>()
  return {
    read(now: number = Date.now()): Map<string, TurnProgress> {
      const path = file()
      let next = ""
      try {
        const stats = statSync(path, { bigint: true })
        next = `${stats.mtimeNs}:${stats.size}:${stats.ino}`
      } catch {
        next = "missing"
      }
      if (next !== identity) {
        identity = next
        cached = next === "missing" ? new Map() : readEntries(path, now)
      }
      return cached
    },
  }
}

export function _setTurnProgressStorePathForTests(path: string | null): void {
  pathOverride = path
}
