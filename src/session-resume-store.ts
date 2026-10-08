import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { sessionKeyAccount } from "./account-groups.js"
import { log } from "./logger.js"
import {
  continuesRecordedConversation,
  conversationDigests,
  modelSiblingSignature,
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
  /**
   * The same conversation with every assistant message reduced to "a turn
   * happened here" (`assistantContent: false`). Only `findSiblingResumePoint`
   * reads it, because only a cross-model lookup needs an identity that opencode
   * does not rewrite per target model (h #g215). Absent on a record an older
   * version wrote, which simply makes that record no sibling candidate.
   */
  shape?: ForkMessageDigest[]
  /**
   * The `CLAUDE_CONFIG_DIR` the transcript was written under, and the account
   * name that directory belongs to. Both absent on a record an older version
   * wrote, which simply makes that record no CROSS-ACCOUNT candidate; it stays
   * a perfectly good same-account one.
   *
   * The directory is recorded rather than recomputed because an account's
   * config dir is a configurable option, so the `~/.claude-<name>` the account
   * name alone would build is not always where its transcripts are (h #g226).
   */
  configDir?: string
  account?: string
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
    record.chain.every(isDigest) &&
    (record.shape === undefined ||
      (Array.isArray(record.shape) && record.shape.every(isDigest))) &&
    (record.configDir === undefined || typeof record.configDir === "string") &&
    (record.account === undefined || typeof record.account === "string")
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
  /** Where this turn's transcript was written, and whose account that is. */
  where?: { configDir?: string; account?: string },
): void {
  const chain = conversationDigests(prompt)
  if (chain.length === 0) return
  const shape = conversationDigests(prompt, { assistantContent: false })
  const configDir = where?.configDir
  const account = where?.account
  const current = load().get(sessionKey)
  if (
    current &&
    current.claudeSessionId === claudeSessionId &&
    current.cliPath === cliPath &&
    current.shape !== undefined &&
    current.configDir === configDir &&
    current.account === account &&
    current.chain.length === chain.length &&
    current.chain.every((entry, i) => entry.digest === chain[i].digest)
  ) {
    return
  }
  save((merged) => {
    merged.delete(sessionKey)
    merged.set(sessionKey, {
      claudeSessionId,
      cliPath,
      chain,
      shape,
      ...(configDir === undefined ? {} : { configDir }),
      ...(account === undefined ? {} : { account }),
      updatedAt: Date.now(),
    })
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
 * Move a record onto the key that is taking over its Claude conversation
 * (`transferClaudeSession`). A move, never a copy: two session keys recorded
 * against one Claude session id would both resume the same transcript, and
 * the second to spawn would append to a conversation the first is already
 * writing. The destination keeps whatever it had, because a key with a
 * conversation of its own is not one that needs to inherit another.
 */
export function moveResumePoint(fromKey: string, toKey: string): void {
  const record = load().get(fromKey)
  if (!record) return
  save((merged) => {
    merged.delete(fromKey)
    if (merged.has(toKey)) return
    merged.set(toKey, { ...record, updatedAt: Date.now() })
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
  /** Told why this lookup came back empty, so the turn that then replays the
   *  conversation as text can name the reason in one NOTICE (h #g215). */
  onRefused?: (reason: string) => void
}): { claudeSessionId: string; matched: number } | undefined {
  const record = load().get(opts.sessionKey)
  if (!record) {
    opts.onRefused?.("no-session-recorded")
    return undefined
  }
  const refuse = (reason: string) => {
    log.info("not resuming the claude session from before the restart", {
      sessionKey: opts.sessionKey,
      reason,
    })
    opts.onRefused?.(reason)
    return undefined
  }
  if (record.cliPath !== opts.cliPath) return refuse("another-claude-binary")
  if (!continuesRecordedConversation(record.chain, opts.prompt)) {
    return refuse("conversation-changed")
  }
  if (!existsSync(opts.transcriptPath(record.claudeSessionId))) {
    return refuse("transcript-gone")
  }
  return { claudeSessionId: record.claudeSessionId, matched: record.chain.length }
}

/**
 * The Claude session this opencode conversation was on before the operator
 * moved it to another model or another reasoning effort, or `undefined`.
 *
 * Both of those are in the session key, so changing either lands the same
 * conversation on a key nothing has ever answered, and the turn replays the
 * whole thread as text (issue #91: at least 18 times in one ~15-hour session).
 * Neither is a reason to start a new Claude conversation: `--model` and
 * `CLAUDE_CODE_EFFORT_LEVEL` are both spawn-time, and the CLI applies either
 * to a transcript it resumes, so the sibling's transcript can simply be
 * continued under the new one.
 *
 * `findResumePoint`'s refusals all hold here and are the whole safety of it:
 * the same binary (`--resume` cannot cross accounts, h #g98), a transcript
 * still on disk, and this prompt's history being exactly the recorded
 * conversation plus Claude's own reply.
 *
 * The one thing it does differently is WHICH recorded conversation it compares.
 * A strict chain cannot match across a model change, because opencode hands a
 * provider an assistant message's stored reasoning as a `reasoning` part for
 * the model that produced it and as a flattened leading `text` part for every
 * other model (measured on 1.18.35, h #g215), and a flattened reasoning part is
 * indistinguishable from reply text. So this compares `shape`: every user and
 * tool message by content, every assistant message by position alone. What that
 * gives up is a conversation whose replies were regenerated under an unchanged
 * prompt; what it keeps is every edit, revert and compaction, because all three
 * change the user side. The strict chain is untouched and is still what
 * `findResumePoint` and `forkSessions` compare.
 *
 * Two more refusals are specific to a sibling:
 *
 *  - a candidate whose transcript may still be written to is refused, because
 *    this hands the id to a key that is about to spawn a child on it, and two
 *    children appending to one transcript is not a thing to find out later,
 *  - the match must be a sibling and not this key, so an unrelated
 *    conversation in another directory, scope, agent or opencode session is
 *    never a candidate however well its content lines up.
 *
 * The caller TRANSFERS the id rather than copying it, so one Claude
 * conversation is owned by exactly one session key at a time.
 */
export interface SiblingResumePoint {
  claudeSessionId: string
  siblingKey: string
  matched: number
  /**
   * The account the sibling ran on, and the config dir its transcript is in,
   * for a sibling on ANOTHER account. Both undefined for the same-account case,
   * which is what every caller before (h #g226) was written against.
   */
  siblingAccount?: string
  siblingConfigDir?: string
}

export function findSiblingResumePoint(opts: {
  sessionKey: string
  prompt: Prompt
  cliPath: string
  /**
   * The transcript file a session id names. Given the sibling's own recorded
   * `configDir` when it has one, because a cross-account sibling's transcript
   * is under the OTHER account's directory and asking for this account's would
   * refuse every real candidate.
   */
  transcriptPath: (claudeSessionId: string, configDir?: string) => string
  /** `claudeSessionIsWriting`, injected so this module stays free of the
   *  session manager. True while a key's transcript may still be written. */
  isBusy: (sessionKey: string) => boolean
  /**
   * `accountProviderMap(accounts)`. Empty or absent keeps the provider element
   * of the context blob strict, which is exactly the pre-(h #g226) behaviour
   * and what a single-account install gets.
   */
  accountProviders?: ReadonlyMap<string, string>
  /**
   * Whether this turn's account may take a conversation from `account`. The
   * `accountGroups` guard, injected: this module knows nothing about groups,
   * only that a caller can say no. Absent means yes, which is the default
   * because the guard is opt-in.
   */
  allowAccount?: (account: string) => boolean
  onRefused?: (reason: string) => void
}): SiblingResumePoint | undefined {
  const providers = opts.accountProviders
  const signature = modelSiblingSignature(opts.sessionKey, providers)
  if (!signature) {
    opts.onRefused?.("no-sibling-possible")
    return undefined
  }
  const ownAccount = providers ? sessionKeyAccount(opts.sessionKey, providers) : undefined

  let best: SiblingResumePoint | undefined
  let bestUpdatedAt = -1
  let refusal: string | undefined

  for (const [key, record] of load()) {
    if (key === opts.sessionKey) continue
    if (modelSiblingSignature(key, providers) !== signature) continue

    // Which account this candidate ran on, and therefore whether a different
    // `cliPath` is expected (every account has its own wrapper) or is a
    // genuinely different `claude` and a refusal.
    const siblingAccount = providers ? sessionKeyAccount(key, providers) : undefined
    const crossAccount =
      ownAccount !== undefined &&
      siblingAccount !== undefined &&
      siblingAccount !== ownAccount
    if (crossAccount) {
      if (opts.allowAccount && !opts.allowAccount(siblingAccount)) {
        refusal = "sibling-another-account-group"
        continue
      }
      // Without the source directory there is no file to carry: the account
      // name alone cannot name it, because `configDir` is configurable.
      if (!record.configDir) {
        refusal = "sibling-account-dir-unknown"
        continue
      }
    } else if (record.cliPath !== opts.cliPath) {
      refusal = "sibling-another-claude-binary"
      continue
    }

    if (
      !record.shape ||
      !continuesRecordedConversation(record.shape, opts.prompt, {
        assistantContent: false,
      })
    ) {
      refusal = "sibling-conversation-changed"
      continue
    }
    if (opts.isBusy(key)) {
      refusal = "sibling-still-writing"
      continue
    }
    if (!existsSync(opts.transcriptPath(record.claudeSessionId, record.configDir))) {
      refusal = "sibling-transcript-gone"
      continue
    }
    // Freshest wins: with several siblings recorded, the one the operator was
    // on last is the one this turn is continuing. `>=` rather than `>` because
    // two records written in the same millisecond are a real tie, and the
    // store iterates oldest-first, so the later writer is still the later one.
    if (record.updatedAt >= bestUpdatedAt) {
      bestUpdatedAt = record.updatedAt
      best = {
        claudeSessionId: record.claudeSessionId,
        siblingKey: key,
        matched: record.chain.length,
        ...(crossAccount
          ? { siblingAccount, siblingConfigDir: record.configDir }
          : {}),
      }
    }
  }

  if (!best) {
    opts.onRefused?.(
      refusal ?? "no-sibling-recorded",
    )
  }
  return best
}

/**
 * Any account OTHER than this turn's that has answered this same opencode
 * conversation, whether or not its conversation still matches.
 *
 * This is the `accountGroups` guard's detector, and it is deliberately broader
 * than `findSiblingResumePoint`: the guard has to hold even when the carry
 * would have been refused anyway, because the thing it blocks is the REPLAY,
 * and the replay happens exactly when the carry does not. So nothing about
 * content, transcripts, binaries or busy-ness is consulted. The one test is
 * the sibling signature, which already pins cwd, request scope, opencode
 * session, agent and prompt-cache TTL, and leaves only the model, the effort
 * and the account free.
 *
 * `extraKeys` is the in-memory session-key set (`listClaudeSessionKeys`), so
 * the guard still works with `resumeAfterRestart: false`, where nothing is
 * written to the store at all. The one gap left is that combination PLUS an
 * opencode restart in between, where nothing in this process has ever seen the
 * other account; that is documented rather than papered over.
 */
export function findForeignAccountSibling(opts: {
  sessionKey: string
  accountProviders: ReadonlyMap<string, string>
  extraKeys?: Iterable<string>
}): { siblingKey: string; account: string } | undefined {
  const providers = opts.accountProviders
  if (providers.size === 0) return undefined
  const signature = modelSiblingSignature(opts.sessionKey, providers)
  if (!signature) return undefined
  const ownAccount = sessionKeyAccount(opts.sessionKey, providers)
  if (ownAccount === undefined) return undefined

  const consider = (key: string): { siblingKey: string; account: string } | undefined => {
    if (key === opts.sessionKey) return undefined
    if (modelSiblingSignature(key, providers) !== signature) return undefined
    const account = sessionKeyAccount(key, providers)
    if (account === undefined || account === ownAccount) return undefined
    return { siblingKey: key, account }
  }

  // The live process first: its view is the newest and it needs no store.
  for (const key of opts.extraKeys ?? []) {
    const hit = consider(key)
    if (hit) return hit
  }
  let found: { siblingKey: string; account: string } | undefined
  let foundUpdatedAt = -1
  for (const [key, record] of load()) {
    const hit = consider(key)
    if (hit && record.updatedAt >= foundUpdatedAt) {
      found = hit
      foundUpdatedAt = record.updatedAt
    }
  }
  return found
}

/** Test seam: point the store at a scratch file and drop the cache. */
export function _setResumeStorePath(file: string | null): void {
  pathOverride = file
  records = null
}
