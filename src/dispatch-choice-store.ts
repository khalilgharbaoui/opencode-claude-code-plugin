/**
 * What the operator last told a dispatch form, kept across opencode restarts.
 *
 * `Same as last time` is the one-click answer the dispatch form (h #g227) is
 * built around, and until now it lived in a module-level `Map`: per opencode
 * conversation, per agent type, and gone the moment the opencode process
 * restarted. The maintainer's measurement of that is simply what it feels like
 * to use: an opencode restart is a routine thing (a config edit, a plugin
 * upgrade, a crash), the conversation it restarts into is the same
 * conversation, and a form that then offers `Default` where it offered
 * `claude-opus-5-5 / max` has forgotten something nobody said to forget. So the
 * choice follows the session, restart or no restart.
 *
 * ## Shape, and why it is this small
 *
 * One record per opencode session id, holding one entry per agent type:
 *
 * ```json
 * { "version": 1, "sessions": {
 *     "ses_abc": { "updatedAt": 1760000000000, "choices": {
 *       "implementor": { "model": "claude-opus-5-5", "effort": "max", "account": "worker" }
 *     } } } }
 * ```
 *
 * Nothing else is written, and that is deliberate: a task prompt would be
 * conversation content on disk, and a session key would be a working directory
 * nobody asked to persist. A model id, an effort level and an account NAME are
 * the three things the form resolves and the three things a spawn needs; none
 * of them is secret and none of them says anything but what this install was
 * already configured with.
 *
 * ## Everything that can go wrong, and what it costs
 *
 * Same discipline as `src/session-resume-store.ts` (h #g197), because the
 * failure modes are that file's: a missing, unreadable, truncated or
 * half-written file is an EMPTY store rather than an error, which costs one
 * extra read of a form the operator was about to look at anyway. A write reads
 * the file back and merges first, so two opencode processes keeping different
 * conversations do not erase each other, and it lands by `rename` so a reader
 * never sees half of it. `0600`, in the `0700` directory the resume store and
 * `cleanup-stale.json` already share.
 *
 * Bounded three ways, because this is written on every answered dispatch and
 * nothing ever revisits an old conversation: at most
 * `MAX_DISPATCH_CHOICE_SESSIONS` sessions (oldest dropped first), at most
 * `MAX_DISPATCH_CHOICES_PER_SESSION` agent types inside one session, and
 * nothing older than `DISPATCH_CHOICE_MAX_AGE_MS`. A deleted opencode session
 * drops its record outright (`forgetDispatchChoices`, from the `session.deleted`
 * path, h #g63), which is what keeps a reused session id from reading somebody
 * else's answer.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { log } from "./logger.js"

/** What a subagent should run as. Mirrors `SubagentChoice`, by value only. */
export interface StoredDispatchChoice {
  model?: string
  effort?: string
  account?: string
}

interface SessionRecord {
  choices: Record<string, StoredDispatchChoice>
  updatedAt: number
}

/** Conversations worth remembering at once. One opencode session each. */
export const MAX_DISPATCH_CHOICE_SESSIONS = 128

/** Agent types inside one conversation. A fan-out names a handful. */
export const MAX_DISPATCH_CHOICES_PER_SESSION = 32

/** A conversation untouched this long is not one this form is about. */
export const DISPATCH_CHOICE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

let sessions: Map<string, SessionRecord> | null = null
let pathOverride: string | null = null

export function dispatchChoiceStorePath(): string {
  if (pathOverride) return pathOverride
  const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(stateRoot, "opencode-claude-code-plugin", "subagent-dispatch.json")
}

/**
 * A stored choice is three optional strings and nothing else, and every one of
 * them is checked: a file another version wrote, or one somebody edited, must
 * not put an object where a `--model` flag goes.
 */
function isChoice(value: unknown): value is StoredDispatchChoice {
  const choice = value as StoredDispatchChoice | null
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return false
  const ok = (field: unknown) => field === undefined || typeof field === "string"
  if (!ok(choice.model) || !ok(choice.effort) || !ok(choice.account)) return false
  return !!(choice.model || choice.effort || choice.account)
}

function isSessionRecord(value: unknown): value is SessionRecord {
  const record = value as SessionRecord | null
  if (!record || typeof record !== "object" || Array.isArray(record)) return false
  if (typeof record.updatedAt !== "number" || !Number.isFinite(record.updatedAt)) {
    return false
  }
  const choices = record.choices
  if (!choices || typeof choices !== "object" || Array.isArray(choices)) return false
  return Object.values(choices as Record<string, unknown>).every(isChoice)
}

/** Keep only the entries that are still a choice, newest keys last. */
function trimChoices(
  choices: Record<string, StoredDispatchChoice>,
): Record<string, StoredDispatchChoice> {
  const entries = Object.entries(choices).filter(([, choice]) => isChoice(choice))
  return Object.fromEntries(entries.slice(-MAX_DISPATCH_CHOICES_PER_SESSION))
}

function readFile(file: string): Map<string, SessionRecord> {
  const out = new Map<string, SessionRecord>()
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    const entries = parsed && typeof parsed === "object" ? parsed.sessions : null
    if (!entries || typeof entries !== "object") return out
    const cutoff = Date.now() - DISPATCH_CHOICE_MAX_AGE_MS
    const valid = Object.entries(entries as Record<string, unknown>)
      .filter((entry): entry is [string, SessionRecord] => isSessionRecord(entry[1]))
      .filter(([, record]) => record.updatedAt >= cutoff)
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    for (const [key, record] of valid) out.set(key, record)
  } catch {
    // ENOENT on a first run, or a file half-written by another process: the
    // empty store is the answer, and it costs one unremembered form.
  }
  return out
}

/** Read the file once per process; everything after that is in memory. */
function load(): Map<string, SessionRecord> {
  if (!sessions) sessions = readFile(dispatchChoiceStorePath())
  return sessions
}

/**
 * Write the whole store, merging whatever is on disk first so a second opencode
 * process keeping a different conversation is not erased. Atomic by rename.
 */
function save(update: (merged: Map<string, SessionRecord>) => void): void {
  const file = dispatchChoiceStorePath()
  const merged = readFile(file)
  update(merged)
  const cutoff = Date.now() - DISPATCH_CHOICE_MAX_AGE_MS
  const kept = [...merged.entries()]
    .filter(([, record]) => record.updatedAt >= cutoff)
    .filter(([, record]) => Object.keys(record.choices).length > 0)
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    .slice(-MAX_DISPATCH_CHOICE_SESSIONS)
  sessions = new Map(kept)
  try {
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, sessions: Object.fromEntries(kept) }), {
      mode: 0o600,
    })
    renameSync(tmp, file)
  } catch (err) {
    log.debug("could not write the subagent dispatch choice store", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** What this conversation last chose for this agent type, or undefined. */
export function readDispatchChoice(
  opencodeSessionId: string,
  agent: string,
): StoredDispatchChoice | undefined {
  if (!opencodeSessionId || opencodeSessionId === "default") return undefined
  const record = load().get(opencodeSessionId)
  const choice = record?.choices[agent]
  return choice ? { ...choice } : undefined
}

/** Remember it, for this conversation and this agent type, across restarts. */
export function writeDispatchChoice(
  opencodeSessionId: string,
  agent: string,
  choice: StoredDispatchChoice,
): void {
  if (!opencodeSessionId || opencodeSessionId === "default" || !agent) return
  const stored: StoredDispatchChoice = {
    ...(choice.model ? { model: choice.model } : {}),
    ...(choice.effort ? { effort: choice.effort } : {}),
    ...(choice.account ? { account: choice.account } : {}),
  }
  if (!isChoice(stored)) return
  const current = load().get(opencodeSessionId)?.choices[agent]
  if (
    current &&
    current.model === stored.model &&
    current.effort === stored.effort &&
    current.account === stored.account
  ) {
    return
  }
  save((merged) => {
    const record = merged.get(opencodeSessionId) ?? { choices: {}, updatedAt: 0 }
    // Deleted before it is re-inserted so this type lands last, which is the
    // end `trimChoices` keeps: the type nobody has touched is the one dropped.
    const choices = { ...record.choices }
    delete choices[agent]
    choices[agent] = stored
    merged.delete(opencodeSessionId)
    merged.set(opencodeSessionId, {
      choices: trimChoices(choices),
      updatedAt: Date.now(),
    })
  })
}

/** Drop a conversation's whole record, from the `session.deleted` path. */
export function forgetDispatchChoices(opencodeSessionId: string): void {
  if (!load().has(opencodeSessionId)) return
  save((merged) => {
    merged.delete(opencodeSessionId)
  })
}

/** Test seam: point the store at a scratch file and drop the cache. */
export function _setDispatchChoiceStorePath(file: string | null): void {
  pathOverride = file
  sessions = null
}

/** Test seam: forget what this process read, so a restart can be simulated. */
export function _reloadDispatchChoiceStore(): void {
  sessions = null
}
