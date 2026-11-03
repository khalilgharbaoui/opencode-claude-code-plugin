/**
 * How long a turn took, for the sidebar's progress bar (h #g247): one sample
 * per finished turn, keyed by the agent and the model it ran as, written by
 * the server half at the CLI's `result` and read by the TUI half
 * (`src/tui.ts`). What the bar is drawn from that record is
 * `src/turn-model.ts`; this module is the record itself, and the counts both
 * halves must agree on (the prompt's length, the turn's tool calls, where a
 * turn starts).
 *
 * ## The store
 *
 * ```json
 * { "version": 1, "turns": { "build/claude-opus-5-5": [
 *     { "ms": 61230, "chars": 420, "effort": "high", "calls": 3, "out": 5321, "session": "5c1d0f3a", "at": 1760000000000 },
 *     { "ms": 6077, "chars": 279, "effort": "low", "calls": 1, "failed": true, "at": 1760000100000 } ] } }
 * ```
 *
 * A duration, a character count, an effort level, a tool-call count, the
 * output tokens its API calls generated, whether the turn ended on a failed
 * tool result, a short tag of the conversation it ran in, and a time: no
 * prompt text, no path, no session id, nothing secret. The output count is
 * the sum the live channel (`src/turn-progress-store.ts`) wrote as the turn
 * ran, so the record and the running turn count it the same way. The tag is
 * a 32-bit hash of the opencode session id (`sessionTag`),
 * enough for the estimate to tell this conversation's turns from another's
 * and not the id. Same discipline as the spawn record store (h #g234):
 * merge-on-write so two opencode processes do not erase each other, atomic
 * rename, `0600` in the `0700` directory, bounded at `MAX_TURN_SAMPLES`
 * newest samples per key, `MAX_TURN_KEYS` keys and `TURN_SAMPLE_MAX_AGE_MS`.
 * A missing, unreadable or half-written file is an empty store, which costs
 * a bar and nothing else.
 *
 * Imports nothing that logs, because the TUI bundle reads it on the
 * terminal's own thread (h #g193): every function here is silent and never
 * throws.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { recordTurnProgress } from "./turn-progress-store.js"

export interface TurnSample {
  /** How long the turn took, from the prompt reaching the provider to the CLI's `result`. */
  ms: number
  /** The prompt's length in characters, the host's injected blocks taken off; absent when unknown. */
  chars?: number
  effort?: string
  /** Tool calls the turn made, counted as the TUI counts a turn's tool parts; absent on a sample from before 0.57.2. */
  calls?: number
  /**
   * Output tokens the turn's API calls generated, summed off each call's
   * `message_delta`; absent on a sample from before 0.58.0 and on a turn the
   * stream carried no `message_delta` for (the interactive transport's).
   */
  out?: number
  /**
   * The turn's last tool result was an error (the CLI's own refusal of a tool,
   * or a proxied tool opencode reported as failed), so the turn ended on a
   * failure opencode may have reported as the subagent failing. Its length
   * says nothing about a served turn's, and the estimate skips it (h #g251).
   * Written only when true.
   */
  failed?: boolean
  /**
   * The conversation the turn ran in, as `sessionTag` hashes its opencode
   * session id: the estimate's session level reads it (`src/turn-model.ts`).
   * Absent on a sample from before 0.58.0.
   */
  session?: string
  at: number
}

/** Samples per key, oldest first. */
export type TurnHistory = Map<string, TurnSample[]>

/** Samples kept per agent and model: enough for a median, few enough to read every tick. */
export const MAX_TURN_SAMPLES = 48
/** Agent and model pairs kept at once. */
export const MAX_TURN_KEYS = 64
/** A turn older than this says little about how the agent runs now. */
export const TURN_SAMPLE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

const SESSION_TAG = /^[0-9a-f]{8}$/

let pathOverride: string | null = null

export function turnHistoryStorePath(): string {
  if (pathOverride) return pathOverride
  const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(stateRoot, "opencode-claude-code-plugin", "turn-history.json")
}

/** The key a turn's samples live under: the agent it ran as and the model, `build/claude-opus-5-5`. */
export function turnHistoryKey(agent: string | undefined, model: string): string {
  return `${agent || "main"}/${model}`
}

/**
 * A short tag for an opencode session id, the same on both halves: FNV-1a
 * over its characters, 32 bits as eight hex digits. Enough for the estimate
 * to tell one conversation's turns from another's (h #g251), and not the id:
 * a hash of it, which the store's "no session id" means to keep true.
 * Undefined for no id, and for `default`, the affinity of a turn opencode
 * did not tag with a session.
 */
export function sessionTag(sessionID: string | undefined): string | undefined {
  if (!sessionID || sessionID === "default") return undefined
  let hash = 0x811c9dc5
  for (let index = 0; index < sessionID.length; index += 1) {
    hash ^= sessionID.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

// ---------------------------------------------------------------------------
// The prompt's length, counted the same on both halves
// ---------------------------------------------------------------------------

const INJECTED_BLOCKS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<dcp-system-reminder>[\s\S]*?<\/dcp-system-reminder>/g,
  /<dcp-message-id>[\s\S]*?<\/dcp-message-id>/g,
]

/**
 * How long a prompt is, in characters, with the blocks a host injects at
 * provider time taken off (opencode's `<system-reminder>`, opencode-dcp's
 * reminder and its message id): the TUI counts the stored message and the
 * server the forwarded one, and the kernel needs both to count the same
 * text. `undefined` for no text at all, which is "unknown", never zero.
 */
export function promptChars(texts: readonly string[]): number | undefined {
  if (texts.length === 0) return undefined
  let total = 0
  for (const text of texts) {
    let stripped = text
    for (const block of INJECTED_BLOCKS) stripped = stripped.replace(block, "")
    total += stripped.trim().length
  }
  return total
}

interface PromptMessageLike {
  role: string
  content: unknown
}

function textsOf(content: unknown): string[] {
  if (typeof content === "string") return [content]
  if (!Array.isArray(content)) return []
  const texts: string[] = []
  for (const part of content) {
    if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "text") continue
    const text = (part as { text?: unknown }).text
    if (typeof text === "string") texts.push(text)
  }
  return texts
}

/** The newest user message's length: the one this turn answers. */
export function newestPromptChars(prompt: readonly PromptMessageLike[]): number | undefined {
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    if (prompt[index].role === "user") return promptChars(textsOf(prompt[index].content))
  }
  return undefined
}

function toolResultParts(message: PromptMessageLike): Array<{ toolCallId?: unknown; output?: unknown }> {
  if (!Array.isArray(message.content)) return []
  return message.content.filter(
    (part): part is { toolCallId?: unknown; output?: unknown } =>
      !!part && typeof part === "object" && (part as { type?: unknown }).type === "tool-result",
  )
}

/**
 * Whether a prompt STARTS a turn: it ends in a user message that does not
 * follow a tool result. A tool-result prompt continues the turn that made
 * the call, and so does a user message the host promoted beside one (h #g204).
 *
 * The exception is a tool result for no call this process is waiting on
 * (h #g251): after an interrupted turn opencode's next prompt ends in the
 * interrupted calls' results and then the operator's new message, which is a
 * fresh turn, not a continuation. Given the ids of the proxied calls still
 * parked, a trailing tool message that answers none of them starts the turn.
 */
export function startsTurn(prompt: readonly PromptMessageLike[], pendingToolCallIds?: ReadonlySet<string>): boolean {
  const last = prompt[prompt.length - 1]
  if (!last || last.role !== "user") return false
  const before = prompt[prompt.length - 2]
  if (before === undefined || before.role !== "tool") return true
  if (!pendingToolCallIds) return false
  return toolResultParts(before).every((part) => typeof part.toolCallId !== "string" || !pendingToolCallIds.has(part.toolCallId))
}

/**
 * How many tool calls the turn a prompt continues has made so far: the
 * `tool-call` parts of the assistant messages since the message that started
 * it. Every proxied and CLI-executed call the plugin emitted in an earlier
 * step is one of them, because opencode stores each as a tool part and hands
 * them back here; the step that sees the `result` adds its own emitted
 * calls, which are not in its prompt yet. That is the count the TUI reads
 * off the turn's tool parts (`measureProgress`), which is what lets the
 * estimate condition on it mid-turn (h #g250).
 *
 * Where the turn started is `from`, the prompt's length when `markTurnStart`
 * ran, so the count agrees with the start that was marked (h #g251); without
 * it, or with a prompt shorter than that (a compaction in between), the
 * boundary is read back off the prompt by `startsTurn`'s plain rule, the
 * last user message not following a tool result, so a message the host
 * steered in mid-turn does not restart the count.
 */
export function turnToolCalls(prompt: readonly PromptMessageLike[], from?: number): number {
  let start = 0
  if (from !== undefined && from >= 0 && from <= prompt.length) {
    start = from
  } else {
    for (let index = prompt.length - 1; index >= 0; index -= 1) {
      if (prompt[index].role !== "user") continue
      const before = prompt[index - 1]
      if (before === undefined || before.role !== "tool") {
        start = index
        break
      }
    }
  }
  let calls = 0
  for (let index = start; index < prompt.length; index += 1) {
    const message = prompt[index]
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "tool-call") calls += 1
    }
  }
  return calls
}

/**
 * Whether the turn's newest tool result in the prompt, the one the final
 * step was answering, was an error: a proxied tool opencode ran and reported
 * failed (`error-text`, `error-json`, `execution-denied`). Trailing user
 * messages (a steered one) are looked past; a tool message from before the
 * turn started (`from`) is not this turn's. The final step's own CLI-executed
 * results are newer than anything here and are read off the stream instead.
 */
export function lastToolResultFailed(prompt: readonly PromptMessageLike[], from: number): boolean {
  for (let index = prompt.length - 1; index >= Math.max(0, from); index -= 1) {
    const message = prompt[index]
    if (message.role === "user") continue
    if (message.role !== "tool") return false
    const parts = toolResultParts(message)
    const newest = parts[parts.length - 1]
    const output = newest?.output as { type?: unknown } | undefined
    const type = output && typeof output === "object" ? output.type : undefined
    return type === "error-text" || type === "error-json" || type === "execution-denied"
  }
  return false
}

// ---------------------------------------------------------------------------
// When a turn started, held from its first step to its result
// ---------------------------------------------------------------------------

const MAX_TURN_STARTS = 256

export interface TurnStart {
  at: number
  chars?: number
  /** The prompt's length when the turn started: where `turnToolCalls` counts from. */
  promptLength?: number
  /** The session's tag (`sessionTag`): where the live channel writes this turn's progress. */
  session?: string
  /** Output tokens the turn's API calls have generated so far; absent until the first call ends. */
  out?: number
}

const turnStarts = new Map<string, TurnStart>()

/**
 * Note that a turn on `key` started. A turn is a run of steps (every proxied
 * tool call ends one), and only its last step sees the `result`, so the
 * start waits here, keyed like the process, until `takeTurnStart`; the
 * output its calls generate is added to it as they end (`noteTurnOutput`).
 * A turn that never reaches a result leaves its start to be overwritten by
 * the key's next one.
 */
export function markTurnStart(key: string, start: TurnStart): void {
  turnStarts.delete(key)
  if (turnStarts.size >= MAX_TURN_STARTS) {
    const oldest = turnStarts.keys().next().value
    if (oldest !== undefined) turnStarts.delete(oldest)
  }
  turnStarts.set(key, {
    at: start.at,
    ...(start.chars !== undefined ? { chars: start.chars } : {}),
    ...(start.promptLength !== undefined ? { promptLength: start.promptLength } : {}),
    ...(start.session !== undefined ? { session: start.session } : {}),
  })
}

/**
 * One API call of the turn on `key` ended, having generated `tokens` output
 * tokens (its `message_delta`'s count, the real one): add them to the turn's
 * total and write the total to the live channel, where the TUI reads it
 * while the turn runs (h #g251). A key with no turn marked (a compaction, a
 * turn opencode did not tag with a session) is not one the sidebar shows,
 * and nothing is written.
 */
export function noteTurnOutput(key: string, tokens: number, now: number = Date.now()): void {
  const start = turnStarts.get(key)
  if (!start || !Number.isFinite(tokens) || tokens < 0) return
  start.out = (start.out ?? 0) + tokens
  if (start.session) recordTurnProgress(start.session, { turn: start.at, out: start.out }, now)
}

/** The start noted for `key`, once: a second `result` in the same turn finds nothing. */
export function takeTurnStart(key: string): TurnStart | undefined {
  const start = turnStarts.get(key)
  turnStarts.delete(key)
  return start
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

function isSample(value: unknown): value is TurnSample {
  const sample = value as TurnSample | null
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) return false
  if (typeof sample.ms !== "number" || !Number.isFinite(sample.ms) || sample.ms < 0) return false
  if (typeof sample.at !== "number" || !Number.isFinite(sample.at)) return false
  if (sample.chars !== undefined && (typeof sample.chars !== "number" || !Number.isFinite(sample.chars) || sample.chars < 0)) {
    return false
  }
  if (sample.effort !== undefined && typeof sample.effort !== "string") return false
  if (sample.calls !== undefined && (typeof sample.calls !== "number" || !Number.isFinite(sample.calls) || sample.calls < 0)) {
    return false
  }
  if (sample.out !== undefined && (typeof sample.out !== "number" || !Number.isFinite(sample.out) || sample.out < 0)) {
    return false
  }
  if (sample.failed !== undefined && typeof sample.failed !== "boolean") return false
  if (sample.session !== undefined && (typeof sample.session !== "string" || !SESSION_TAG.test(sample.session))) {
    return false
  }
  return true
}

function cleanSample(sample: TurnSample): TurnSample {
  return {
    ms: Math.round(sample.ms),
    ...(sample.chars !== undefined ? { chars: Math.round(sample.chars) } : {}),
    ...(sample.effort ? { effort: sample.effort } : {}),
    ...(sample.calls !== undefined ? { calls: Math.round(sample.calls) } : {}),
    ...(sample.out !== undefined ? { out: Math.round(sample.out) } : {}),
    ...(sample.failed ? { failed: true } : {}),
    ...(sample.session ? { session: sample.session } : {}),
    at: sample.at,
  }
}

function readEntries(file: string, now: number): TurnHistory {
  const out: TurnHistory = new Map()
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    const entries = parsed && typeof parsed === "object" ? parsed.turns : null
    if (!entries || typeof entries !== "object") return out
    const cutoff = now - TURN_SAMPLE_MAX_AGE_MS
    for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
      if (!key || !Array.isArray(value)) continue
      const samples = value
        .filter(isSample)
        .filter((sample) => sample.at >= cutoff)
        .sort((a, b) => a.at - b.at)
        .slice(-MAX_TURN_SAMPLES)
        .map(cleanSample)
      if (samples.length > 0) out.set(key, samples)
    }
  } catch {
    // ENOENT before the first turn, or a file another process is renaming
    // into place: the empty store is the answer.
  }
  return out
}

/** The keys with the newest samples, `MAX_TURN_KEYS` of them. */
function bounded(history: TurnHistory): TurnHistory {
  const newest = (samples: TurnSample[]) => samples[samples.length - 1]?.at ?? 0
  return new Map([...history.entries()].sort((a, b) => newest(a[1]) - newest(b[1])).slice(-MAX_TURN_KEYS))
}

/**
 * Record one finished turn under `key`. Returns whether the disk was
 * written, which is false for an unusable sample and a failed write alike:
 * the caller has nothing to do about either.
 */
export function recordTurnSample(key: string, sample: TurnSample): boolean {
  if (!key || !isSample(sample)) return false
  const file = turnHistoryStorePath()
  const merged = readEntries(file, sample.at)
  const samples = [...(merged.get(key) ?? []), cleanSample(sample)].sort((a, b) => a.at - b.at).slice(-MAX_TURN_SAMPLES)
  merged.set(key, samples)
  const kept = bounded(merged)
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
 * one `stat`. The `ino` is read exactly, for the reason
 * `createTurnProgressReader` gives (h #g286).
 */
export function createTurnHistoryReader(file: () => string = turnHistoryStorePath) {
  let identity = ""
  let cached: TurnHistory = new Map()
  return {
    read(now: number = Date.now()): TurnHistory {
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

export function _setTurnHistoryStorePathForTests(path: string | null): void {
  pathOverride = path
  turnStarts.clear()
}
