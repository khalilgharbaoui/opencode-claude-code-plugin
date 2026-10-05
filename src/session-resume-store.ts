import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { log } from "./logger.js"
import {
  continuesRecordedConversation,
  conversationDigests,
  type ForkMessageDigest,
} from "./session-fork.js"

type Prompt = Parameters<LanguageModelV3["doGenerate"]>[0]["prompt"]

/**
 * Which Claude session answered a conversation, kept across opencode restarts.
 *
 * The session-id map in `src/session-manager.ts` lives in memory, so the first
 * turn of an existing conversation in a new opencode process found no session
 * and replayed the whole thread as text into a fresh one: 3 such replays in the
 * maintainer's retained `plugin.log`, averaging 648,653 characters and up to
 * 981,109. The id is enough for `--resume`; what makes it safe is knowing the
 * conversation in front of us is still the one that id answered.
 *
 * So a record is the session id plus the digest chain of what that turn was
 * asked to continue (`src/session-fork.ts`, which matches conversations on
 * content because neither opencode major hands a provider anything better).
 * It is used only when every one of these holds, and anything else replays
 * exactly as before:
 *
 *  - the same session key, so the same opencode session, cwd, model, agent,
 *    effort and cache TTL,
 *  - the same binary, because a transcript lives under one account's config
 *    dir and `--resume` cannot cross accounts,
 *  - the transcript file is still on disk,
 *  - this turn's history is the recorded conversation plus Claude's own reply,
 *    with no tool round trip open. An edit, a revert or an opencode compaction
 *    changes the chain and falls back to the replay.
 *
 * Records are written only after a successful `result`, and forgotten with
 * the in-memory id (`deleteClaudeSessionId`), so a conversation the plugin
 * deliberately abandoned in one process is not picked up by the next.
 */

interface ResumeRecord {
  claudeSessionId: string
  cliPath: string
  chain: ForkMessageDigest[]
  updatedAt: number
}

/** Same reasoning as `MAX_CLAUDE_SESSION_ENTRIES`, sized for many processes. */
export const MAX_RESUME_RECORDS = 256

/** A conversation untouched this long is not worth a lookup. */
export const RESUME_RECORD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

let records: Map<string, ResumeRecord> | null = null
let pathOverride: string | null = null

export function resumeStorePath(): string {
  if (pathOverride) return pathOverride
  const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(stateRoot, "opencode-claude-code-plugin", "claude-sessions.json")
}

function isDigest(value: unknown): value is ForkMessageDigest {
  const entry = value as ForkMessageDigest | null
  return (
    !!entry &&
    (entry.role === "user" || entry.role === "assistant" || entry.role === "tool") &&
    typeof entry.digest === "string"
  )
}

function isRecord(value: unknown): value is ResumeRecord {
  const record = value as ResumeRecord | null
  return (
    !!record &&
    typeof record.claudeSessionId === "string" &&
    typeof record.cliPath === "string" &&
    typeof record.updatedAt === "number" &&
    Array.isArray(record.chain) &&
    record.chain.every(isDigest)
  )
}

/**
 * Read the file once per process. A missing, unreadable or malformed file is
 * an empty store, never an error: the worst it can cost is the replay that
 * would have happened anyway.
 */
function load(): Map<string, ResumeRecord> {
  if (records) return records
  records = new Map()
  try {
    const parsed = JSON.parse(readFileSync(resumeStorePath(), "utf8"))
    const entries = parsed && typeof parsed === "object" ? parsed.sessions : null
    if (entries && typeof entries === "object") {
      const cutoff = Date.now() - RESUME_RECORD_MAX_AGE_MS
      const valid = Object.entries(entries as Record<string, unknown>)
        .filter((entry): entry is [string, ResumeRecord] => isRecord(entry[1]))
        .filter(([, record]) => record.updatedAt >= cutoff)
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
      for (const [key, record] of valid) records.set(key, record)
    }
  } catch {
    // ENOENT on a first run, or a file another version wrote: start empty.
  }
  return records
}

/**
 * Write the whole store. Read back first, so two opencode processes writing
 * different conversations keep each other's records; the file is small and
 * this runs once per finished turn. Atomic by rename, and the file is `0600`
 * because the keys carry working directories (the directory is shared with
 * `cleanup-stale.json`, which may have created it first).
 */
function save(update: (merged: Map<string, ResumeRecord>) => void): void {
  const file = resumeStorePath()
  const merged = new Map<string, ResumeRecord>()
  try {
    const onDisk = JSON.parse(readFileSync(file, "utf8"))?.sessions
    if (onDisk && typeof onDisk === "object") {
      for (const [key, record] of Object.entries(onDisk as Record<string, unknown>)) {
        if (isRecord(record)) merged.set(key, record)
      }
    }
  } catch {
    // Nothing on disk yet.
  }
  update(merged)
  const cutoff = Date.now() - RESUME_RECORD_MAX_AGE_MS
  const kept = [...merged.entries()]
    .filter(([, record]) => record.updatedAt >= cutoff)
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    .slice(-MAX_RESUME_RECORDS)
  records = new Map(kept)
  try {
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, sessions: Object.fromEntries(kept) }), {
      mode: 0o600,
    })
    renameSync(tmp, file)
  } catch (err) {
    log.debug("could not write the claude session resume store", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Remember which Claude session answered the conversation in `prompt`. */
export function recordResumePoint(
  sessionKey: string,
  claudeSessionId: string,
  prompt: Prompt,
  cliPath: string,
): void {
  const chain = conversationDigests(prompt)
  if (chain.length === 0) return
  const current = load().get(sessionKey)
  if (
    current &&
    current.claudeSessionId === claudeSessionId &&
    current.cliPath === cliPath &&
    current.chain.length === chain.length &&
    current.chain.every((entry, i) => entry.digest === chain[i].digest)
  ) {
    return
  }
  save((merged) => {
    merged.delete(sessionKey)
    merged.set(sessionKey, { claudeSessionId, cliPath, chain, updatedAt: Date.now() })
  })
}

/** Forget a key, alongside `deleteClaudeSessionId`. */
export function forgetResumePoint(sessionKey: string): void {
  if (!load().has(sessionKey)) return
  save((merged) => {
    merged.delete(sessionKey)
  })
}

/**
 * The Claude session id to resume for this turn, or undefined to replay.
 * `transcriptPath` names the file the CLI would resume from, so a transcript
 * that was deleted, or lives under another config dir, is never asked for.
 */
export function findResumePoint(opts: {
  sessionKey: string
  prompt: Prompt
  cliPath: string
  transcriptPath: (claudeSessionId: string) => string
}): { claudeSessionId: string; matched: number } | undefined {
  const record = load().get(opts.sessionKey)
  if (!record) return undefined
  const refuse = (reason: string) => {
    log.info("not resuming the claude session from before the restart", {
      sessionKey: opts.sessionKey,
      reason,
    })
    return undefined
  }
  if (record.cliPath !== opts.cliPath) return refuse("another claude binary")
  if (!continuesRecordedConversation(record.chain, opts.prompt)) {
    return refuse("the conversation changed")
  }
  if (!existsSync(opts.transcriptPath(record.claudeSessionId))) {
    return refuse("the transcript is gone")
  }
  return { claudeSessionId: record.claudeSessionId, matched: record.chain.length }
}

/** Test seam: point the store at a scratch file and drop the cache. */
export function _setResumeStorePath(file: string | null): void {
  pathOverride = file
  records = null
}
