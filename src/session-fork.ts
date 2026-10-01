import { createHash } from "node:crypto"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { log } from "./logger.js"

type Prompt = Parameters<LanguageModelV3["doGenerate"]>[0]["prompt"]

/**
 * Forking an opencode session with the Claude prompt cache intact.
 *
 * opencode's own fork copies a conversation into a brand new session, and the
 * new session reaches this plugin as a new session key with no Claude session
 * id behind it, so the turn takes the fresh-session path: the whole thread is
 * re-rendered as text into the first message and paid for again as cache
 * writes. `claude --resume <parent> --fork-session` does the same branching on
 * the CLI's side for a fraction of that, and leaves the parent untouched.
 *
 * The hard part is not the flag, it is knowing that the new session IS a fork
 * and of WHAT. Neither opencode major hands that to a provider:
 *
 * - opencode 1.18.34 copies every message into the new session with fresh ids,
 *   sets no `parentID` (that still means "subagent child" and nothing else),
 *   and records the relationship only in the derived title `<parent> (fork
 *   #N)`. A title is renameable, so it is not an identity.
 * - opencode 2.0.16 publishes a `session.forked` event carrying `parentID` and
 *   a boundary, but a plugin is handed neither that event nor a route that
 *   reports it.
 *
 * What a provider does see is the conversation itself, and on a fork that is
 * the parent's conversation verbatim. So the match here is made on content: a
 * per-message digest chain is recorded for every key this provider serves, and
 * a new key whose history starts with a recorded chain is that chain's fork.
 * Content matching is also the only rule that works the same on both majors.
 *
 * Everything below is deliberately conservative: the match must be exact, the
 * binary must be the same one (a transcript cannot be resumed across
 * accounts), and anything that does not match falls back to today's replay.
 */

/** One conversation message, reduced to its role and a content digest. */
export interface ForkMessageDigest {
  role: "user" | "assistant" | "tool"
  digest: string
}

interface ForkFingerprint {
  entries: ForkMessageDigest[]
  /**
   * The binary that served this conversation. A Claude transcript lives under
   * one account's config dir and `--resume` can never cross accounts, so a
   * candidate whose path differs is not a candidate at all.
   */
  cliPath: string
  /** Insertion counter, so the freshest of two equally good matches wins. */
  seq: number
}

const fingerprints = new Map<string, ForkFingerprint>()
let fingerprintSeq = 0

/**
 * Same shape and reasoning as `MAX_CLAUDE_SESSION_ENTRIES`: the map is only
 * written for keys this provider actually serves, but a long-lived
 * `opencode serve` hopping projects would otherwise grow it forever.
 */
export const MAX_FORK_FINGERPRINTS = 64

/**
 * Feed one message's content into a hash. Only the parts that carry the
 * conversation are included: text, a tool call's name and input, a tool
 * result's name and output, and the kind plus media type of an attachment.
 *
 * Ids are deliberately left out. opencode's fork re-keys every message and
 * part it copies, so a digest over ids would never match anything. Reasoning
 * is left out for the same class of reason: it is model-internal, it is not
 * what makes two conversations the same conversation, and a turn whose
 * reasoning differed also differs in the reply text that follows it.
 */
function hashPart(hash: ReturnType<typeof createHash>, part: unknown): void {
  const p = part as Record<string, unknown> | null
  const type = typeof p?.type === "string" ? p.type : "unknown"
  switch (type) {
    case "text":
      hash.update("text\u0000")
      hash.update(String(p?.text ?? ""))
      break
    case "tool-call":
      hash.update("call\u0000")
      hash.update(String(p?.toolName ?? ""))
      hash.update("\u0000")
      hash.update(stableJson(p?.input))
      break
    case "tool-result":
      hash.update("result\u0000")
      hash.update(String(p?.toolName ?? ""))
      hash.update("\u0000")
      hash.update(stableJson(p?.output))
      break
    case "file":
    case "image":
      hash.update(type)
      hash.update("\u0000")
      hash.update(String(p?.mediaType ?? ""))
      break
    default:
      // Reasoning and anything a future AI SDK adds: counted as present, not
      // as content, so an unknown part can neither forge nor break a match.
      hash.update("other\u0000")
      hash.update(type)
      break
  }
  hash.update("\u001e")
}

/** Key-order-independent JSON, so two equal inputs always hash the same. */
function stableJson(value: unknown): string {
  const seen = new WeakSet<object>()
  const walk = (node: unknown): unknown => {
    if (node === null || typeof node !== "object") return node
    if (seen.has(node as object)) return "[circular]"
    seen.add(node as object)
    if (Array.isArray(node)) return node.map(walk)
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(node as Record<string, unknown>).sort()) {
      out[key] = walk((node as Record<string, unknown>)[key])
    }
    return out
  }
  try {
    return JSON.stringify(walk(value)) ?? "null"
  } catch {
    return "[unserializable]"
  }
}

function messageDigest(msg: { role: string; content: unknown }): string {
  const hash = createHash("sha256")
  hash.update(msg.role)
  hash.update("\u0000")
  if (typeof msg.content === "string") {
    hash.update("text\u0000")
    hash.update(msg.content)
    hash.update("\u001e")
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) hashPart(hash, part)
  }
  return hash.digest("hex").slice(0, 32)
}

/** The conversation messages of a prompt, reduced to a digest chain. */
export function conversationDigests(prompt: Prompt): ForkMessageDigest[] {
  const out: ForkMessageDigest[] = []
  for (const msg of prompt as Array<{ role: string; content: unknown }>) {
    if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "tool") {
      continue
    }
    out.push({
      role: msg.role as ForkMessageDigest["role"],
      digest: messageDigest(msg),
    })
  }
  return out
}

/**
 * Remember what conversation this session key was last asked to continue.
 *
 * Only called when `forkSessions` is on, so a default install pays nothing for
 * a feature it is not using: no hashing, no map, no cap sweep.
 */
export function recordForkFingerprint(
  sessionKey: string,
  prompt: Prompt,
  cliPath: string,
): void {
  const entries = conversationDigests(prompt)
  if (entries.length === 0) return
  // Re-inserting moves the key to the back, so the cap sheds the conversation
  // that has been quiet longest (same rule as `capClaudeSessions`).
  fingerprints.delete(sessionKey)
  fingerprints.set(sessionKey, { entries, cliPath, seq: ++fingerprintSeq })
  while (fingerprints.size > MAX_FORK_FINGERPRINTS) {
    const oldest = fingerprints.keys().next()
    if (oldest.done) break
    fingerprints.delete(oldest.value)
  }
}

/** Drop what was remembered for a key whose Claude session is gone. */
export function forgetForkFingerprint(sessionKey: string): void {
  fingerprints.delete(sessionKey)
}

/** Test seam. */
export function _resetForkFingerprints(): void {
  fingerprints.clear()
  fingerprintSeq = 0
}

/**
 * The part of a session key that every sibling of one opencode conversation
 * shares: the key with its session-affinity segment blanked out.
 *
 * A fork may only resume a transcript recorded under the same cwd (the CLI
 * stores transcripts per encoded working directory, so an id from elsewhere
 * is simply not found), the same model, the same request scope and the same
 * context blob (provider, opencode agent, prompt cache TTL) plus the same
 * effort tail. All of those are already in the key, so comparing keys with
 * the affinity removed enforces every one of them at once.
 *
 * Returns `null` for a key that has no affinity segment to blank, which is
 * what a compaction key (`<cwd>::<model>::compaction::<affinity>`) looks like.
 * That is the gate keeping compaction out of this on both sides: it can never
 * be a fork parent and it can never be forked.
 */
export function forkSiblingSignature(sessionKey: string): string | null {
  const parts = sessionKey.split("::")
  if (parts.length < 5) return null
  if (parts[2] === "compaction") return null
  const blanked = [...parts]
  blanked[3] = "*"
  return blanked.join("::")
}

/**
 * Split a prompt into the history a fork would inherit and the trailing
 * segment this turn is about to send.
 *
 * The trailing segment is everything after the last assistant message, which
 * is exactly the span `getClaudeUserMessage` turns into the current message.
 * `forkable` is false when that span carries a tool result: those are the
 * middle of a tool round trip, where the parent's CLI process is parked inside
 * a proxy call and its transcript ends on an unanswered `tool_use`. Resuming
 * into that is not something this has measured, so it falls back to the replay.
 */
export function splitForkHistory(prompt: Prompt): {
  history: ForkMessageDigest[]
  forkable: boolean
} {
  const messages = prompt as Array<{ role: string; content: unknown }>
  let lastAssistant = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistant = i
      break
    }
  }
  if (lastAssistant < 0) return { history: [], forkable: false }

  for (let i = lastAssistant + 1; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === "tool") return { history: [], forkable: false }
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string }>) {
      if (part?.type === "tool-result") return { history: [], forkable: false }
    }
  }

  return {
    history: conversationDigests(messages.slice(0, lastAssistant + 1) as Prompt),
    forkable: true,
  }
}

export interface ForkParent {
  /** The session key whose Claude conversation this turn should fork. */
  parentKey: string
  /** The Claude session id to pass to `--resume`. */
  claudeSessionId: string
  /** How many messages of the recorded chain matched, for the log line. */
  matched: number
}

/**
 * Find the recorded conversation this turn's prompt is a fork of, or `null`.
 *
 * A candidate qualifies only when all of this holds:
 *
 *  - it is a sibling key (same cwd, model, scope, context blob and effort),
 *  - it was served by the same binary, because `--resume` cannot cross
 *    accounts,
 *  - the plugin still knows its Claude session id,
 *  - it is not busy: a live process, a proxied call in the air or an
 *    unanswered plan-mode question all mean the transcript this would resume
 *    is still being written,
 *  - its whole recorded chain is a prefix of this prompt's history, and
 *  - everything in this prompt's history past that prefix is assistant or
 *    tool content, which is the parent's own last reply. The parent's chain is
 *    what the plugin last SENT, so the reply the CLI produced for it is in the
 *    Claude transcript already and is the only thing allowed to be extra.
 *
 * A chain that is longer than this prompt's history means the parent has been
 * prompted since the fork was taken, and a chain that diverges means the fork
 * was cut mid-conversation. Both fall through to the replay, which is correct:
 * the point of this is a conversation the model sees identically either way.
 */
export function findForkParent(opts: {
  sessionKey: string
  prompt: Prompt
  cliPath: string
  /** `getClaudeSessionId`, injected so this module stays free of the manager. */
  lookupClaudeSessionId: (key: string) => string | undefined
  /** True while a key's transcript may still be written to. */
  isBusy: (key: string) => boolean
}): ForkParent | null {
  const signature = forkSiblingSignature(opts.sessionKey)
  if (!signature) return null

  const { history, forkable } = splitForkHistory(opts.prompt)
  if (!forkable || history.length === 0) return null

  let best: ForkParent | null = null
  let bestLength = 0
  let bestSeq = -1

  for (const [key, fingerprint] of fingerprints) {
    if (key === opts.sessionKey) continue
    if (fingerprint.cliPath !== opts.cliPath) continue
    if (forkSiblingSignature(key) !== signature) continue
    const recorded = fingerprint.entries
    if (recorded.length === 0 || recorded.length > history.length) continue
    if (!isPrefix(recorded, history)) continue
    if (!tailIsReplyOnly(history, recorded.length)) continue
    const claudeSessionId = opts.lookupClaudeSessionId(key)
    if (!claudeSessionId) continue
    if (opts.isBusy(key)) continue
    if (
      recorded.length > bestLength ||
      (recorded.length === bestLength && fingerprint.seq > bestSeq)
    ) {
      best = { parentKey: key, claudeSessionId, matched: recorded.length }
      bestLength = recorded.length
      bestSeq = fingerprint.seq
    }
  }

  if (best) {
    log.info("found a fork parent for this conversation", {
      sessionKey: opts.sessionKey,
      parentKey: best.parentKey,
      matchedMessages: best.matched,
      historyMessages: history.length,
    })
  }
  return best
}

function isPrefix(
  recorded: ForkMessageDigest[],
  history: ForkMessageDigest[],
): boolean {
  for (let i = 0; i < recorded.length; i++) {
    if (recorded[i].role !== history[i].role) return false
    if (recorded[i].digest !== history[i].digest) return false
  }
  return true
}

function tailIsReplyOnly(history: ForkMessageDigest[], from: number): boolean {
  for (let i = from; i < history.length; i++) {
    if (history[i].role === "user") return false
  }
  return true
}
