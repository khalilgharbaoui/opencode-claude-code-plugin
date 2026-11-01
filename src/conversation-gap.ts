import { createHash } from "node:crypto"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { conversationDigests, type ForkMessageDigest } from "./session-fork.js"
import { log } from "./logger.js"

type Prompt = Parameters<LanguageModelV3["doGenerate"]>[0]["prompt"]

/**
 * What each session key's Claude session was last asked, so a turn can tell
 * whether the conversation moved on without it (issue #114).
 *
 * The opencode agent is part of the session key, so one opencode conversation
 * that goes build -> plan -> build runs on two keys and two `claude`
 * processes, each with its own transcript. That is deliberate: a Claude
 * conversation answers under the system prompt recorded on its FIRST request
 * (h #g187, h #g223), so handing the plan agent's session to the build agent
 * would leave Claude under the plan agent's instructions while opencode has
 * granted build permissions. The cost of keeping them apart was this: a turn
 * on a reused process, or on a `--resume` of its own session, sends only the
 * messages after the last assistant reply, which is exactly right when that
 * reply was its own and exactly wrong when the other agent answered in
 * between. The build session was never told what the plan agent said, and
 * carried on from its own last reply, which the reporter saw as the agent
 * "referring to much earlier messages instead of the latest plan".
 *
 * So every key records the SHAPE of the conversation it was last asked to
 * continue (`conversationDigests` with `assistantContent: false`: user and
 * tool messages by content, assistant messages by position, the chain
 * `findSiblingResumePoint` compares, because a strict one cannot survive a
 * model change, h #g215), and the next turn on that key asks what lies
 * between that chain and the message it is about to send. A tail of nothing
 * but the session's own reply is the ordinary case and answers null. A tail
 * with a USER message in it is a conversation that went elsewhere, and the
 * slice from that message to the last assistant reply is what the caller
 * replays ahead of the current message, bounded like any replay.
 *
 * In memory only, like the fork fingerprints: after an opencode restart the
 * resume store (`findResumePoint`) refuses a session whose chain has user
 * messages past it and the whole thread is replayed, which covers the gap by
 * the expensive route. Pure apart from the map, injected with nothing, and
 * the caller decides what to do with the slice.
 *
 * Every served turn also leaves a CHECKPOINT: where its reply ended in
 * Claude's transcript. That is what lets a rewound thread continue a copy of
 * the session cut at the last turn both versions still share, rather than
 * replaying the thread as text (h #g282).
 */

/**
 * Where one served turn's reply ended in Claude's transcript. The Claude
 * session `claudeSessionId`, cut at the entry `messageUuid`
 * (`--resume-session-at`), holds the conversation's first `anchor` shape-chain
 * entries and then that turn's own reply, nothing else.
 */
export interface ConversationCheckpoint {
  /**
   * The length of the chain up to and including the last USER message the
   * turn answered. Not the whole chain the turn was asked to continue: a turn
   * that made proxied tool calls was recorded with its own steps rendered the
   * way opencode renders a step in flight, and opencode may render the same
   * reply differently once the turn is over (h #g242, refusal 2). Everything
   * up to the user message was already rendered the way it stays.
   */
  anchor: number
  /** A digest of those `anchor` entries, compared against a later history. */
  prefix: string
  /** The Claude session the turn ran in. */
  claudeSessionId: string
  /** The transcript entry the reply ended on: the kept turn's last entry. */
  messageUuid: string
}

interface ServedConversation {
  chain: ForkMessageDigest[]
  /** Insertion counter, for the cap's eviction order. */
  seq: number
  /** Oldest first; see `ConversationCheckpoint`. */
  checkpoints: ConversationCheckpoint[]
}

const served = new Map<string, ServedConversation>()
let servedSeq = 0

/**
 * Same bound and reasoning as `MAX_CLAUDE_SESSION_ENTRIES` and
 * `MAX_FORK_FINGERPRINTS`: written only for keys this provider serves, and
 * capped so a long-lived `opencode serve` cannot grow it forever.
 */
export const MAX_SERVED_CONVERSATIONS = 64

/**
 * Checkpoints kept per key, newest last. An undo further back than this many
 * turns finds none and replays the thread as text, which is what every undo
 * did before checkpoints existed.
 */
export const MAX_CONVERSATION_CHECKPOINTS = 64

/** One digest over a chain prefix, so a checkpoint is a number and a string. */
function prefixDigest(entries: ReadonlyArray<{ role: string; digest: string }>, length: number): string {
  const hash = createHash("sha256")
  for (let i = 0; i < length; i++) {
    hash.update(entries[i].role).update("\u0000").update(entries[i].digest).update("\u0001")
  }
  return hash.digest("hex")
}

/** One past the chain's last user entry, or 0 when it has none. */
function anchorOf(entries: ReadonlyArray<{ role: string }>): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].role === "user") return i + 1
  }
  return 0
}

/**
 * Remember the conversation `sessionKey`'s Claude session was just asked to
 * continue. With `checkpoint`, also where the turn's reply ended in that
 * session's transcript: the caller passes one only for a turn that was
 * served, and only with the uuid of the reply's last entry.
 */
export function recordServedConversation(
  sessionKey: string,
  prompt: Prompt,
  checkpoint?: { claudeSessionId: string; messageUuid: string },
): void {
  const chain = conversationDigests(prompt, { assistantContent: false })
  if (chain.length === 0) return
  const checkpoints = [...(served.get(sessionKey)?.checkpoints ?? [])]
  const anchor = anchorOf(chain)
  if (checkpoint && anchor > 0) {
    // A second result for the same question (the auto-continue nudge) ended
    // later in the same session, and the reply opencode shows holds both.
    while (checkpoints.length > 0 && checkpoints[checkpoints.length - 1].anchor >= anchor) {
      checkpoints.pop()
    }
    checkpoints.push({ anchor, prefix: prefixDigest(chain, anchor), ...checkpoint })
    while (checkpoints.length > MAX_CONVERSATION_CHECKPOINTS) checkpoints.shift()
  }
  // Re-inserting moves the key to the back, so the cap sheds the conversation
  // that has been quiet longest.
  served.delete(sessionKey)
  served.set(sessionKey, { chain, seq: ++servedSeq, checkpoints })
  while (served.size > MAX_SERVED_CONVERSATIONS) {
    const oldest = served.keys().next()
    if (oldest.done) break
    served.delete(oldest.value)
  }
}

/**
 * Put back the checkpoints a fork kept (`RewindCheckpoint.kept`) after
 * `deleteClaudeSessionId` dropped the record with the session it was about.
 * The chain stays empty, so the next turn reads no gap and no rewind until
 * the fork's own result records what it was asked (h #g282).
 */
export function restoreConversationCheckpoints(
  sessionKey: string,
  checkpoints: readonly ConversationCheckpoint[],
): void {
  if (checkpoints.length === 0) return
  served.delete(sessionKey)
  served.set(sessionKey, {
    chain: [],
    seq: ++servedSeq,
    checkpoints: [...checkpoints].slice(-MAX_CONVERSATION_CHECKPOINTS),
  })
  while (served.size > MAX_SERVED_CONVERSATIONS) {
    const oldest = served.keys().next()
    if (oldest.done) break
    served.delete(oldest.value)
  }
}

/**
 * Drop a key's checkpoints and keep the rest. For the CLI's own compaction
 * (`compact_boundary`): a cut before the boundary would bring back the long
 * conversation the CLI had just summarised because it was nearly full.
 */
export function forgetConversationCheckpoints(sessionKey: string): void {
  const record = served.get(sessionKey)
  if (record) record.checkpoints = []
}

/** Drop what was remembered for a key whose Claude session is gone. */
export function forgetServedConversation(sessionKey: string): void {
  served.delete(sessionKey)
}

/**
 * Move the record onto the key that is taking over the Claude conversation
 * (`transferClaudeSession`): the session is the same, so what it has seen is.
 */
export function moveServedConversation(fromKey: string, toKey: string): void {
  const record = served.get(fromKey)
  if (!record) return
  served.delete(fromKey)
  served.delete(toKey)
  served.set(toKey, { ...record, seq: ++servedSeq })
}

/** Test seam. */
export function _resetServedConversations(): void {
  served.clear()
  servedSeq = 0
}

export interface MissedMessages {
  kind: "missed"
  /**
   * The messages the session never saw, in order: from the first user message
   * past the recorded chain to the last assistant reply in the prompt. The
   * caller's own prompt objects, so it can hand them to the same renderer and
   * the same cleaning the rest of the envelope goes through.
   */
  messages: Prompt
  /** How many of them are user messages, for the log line. */
  userMessages: number
}

/**
 * The conversation this key's Claude session was asked to continue no longer
 * exists: the operator undid it, edited a message in it, or regenerated the
 * last reply, and the thread opencode is sending now is a different one that
 * shares a beginning with it.
 *
 * The session still holds the removed turns and will act on them, which is
 * what the caller fixes by starting a fresh one, or by continuing a copy cut
 * at `checkpoint` when there is one. Nothing here to replay: what is gone is
 * gone and the thread that remains is in the prompt.
 */
export interface RewoundConversation {
  kind: "rewound"
  /** How many messages of the recorded chain this prompt still has, in order. */
  sharedMessages: number
  /** How many recorded messages past that prefix this prompt does not have. */
  removedMessages: number
  /** How many of those were user messages. */
  removedUserMessages: number
  /**
   * The served turn the thread as it stands now ends on, when one was
   * recorded: a copy of `claudeSessionId` cut at `messageUuid` holds exactly
   * this prompt's history, so the turn can continue it with nothing replayed.
   * Absent when no checkpoint matches; the caller then replays (h #g282).
   */
  checkpoint?: RewindCheckpoint
}

/** The checkpoint a rewound thread can be cut at, and what survives the cut. */
export interface RewindCheckpoint {
  claudeSessionId: string
  messageUuid: string
  /** History entries the cut keeps: the chosen checkpoint's anchor. */
  anchor: number
  /**
   * This key's checkpoints at and before the chosen one, for
   * `restoreConversationCheckpoints`. The later ones were taken on turns the
   * rewind removed and must not outlive it.
   */
  kept: ConversationCheckpoint[]
}

/**
 * The newest checkpoint that ends exactly where this history does: the
 * prompt's history up to its last user message is the checkpoint's own
 * prefix, and after that message comes nothing but the reply to it. The
 * history's last user message is the only place a turn's checkpoint can sit,
 * so that is the one anchor compared; newest first, because an older
 * checkpoint with the same prefix belongs to a reply the thread has since
 * replaced.
 */
function checkpointFor(
  record: ServedConversation,
  history: ReadonlyArray<{ role: string; digest: string }>,
): RewindCheckpoint | undefined {
  if (record.checkpoints.length === 0) return undefined
  const anchor = anchorOf(history)
  // A reply has to follow the anchor: a cut keeps the turn's whole reply.
  if (anchor === 0 || anchor >= history.length) return undefined
  const prefix = prefixDigest(history, anchor)
  for (let i = record.checkpoints.length - 1; i >= 0; i--) {
    const checkpoint = record.checkpoints[i]
    if (checkpoint.anchor !== anchor || checkpoint.prefix !== prefix) continue
    return {
      claudeSessionId: checkpoint.claudeSessionId,
      messageUuid: checkpoint.messageUuid,
      anchor,
      kept: record.checkpoints.slice(0, i + 1).filter((kept) => kept.anchor <= anchor),
    }
  }
  return undefined
}

export type ConversationChange = MissedMessages | RewoundConversation

/**
 * How the conversation moved since `sessionKey`'s Claude session was last
 * asked to continue it, or null when nothing can be said about it.
 *
 * Three answers:
 *
 * - `missed`: the recorded chain is a prefix of this prompt's history and
 *   there are USER messages past it. The conversation ran under another key
 *   (another opencode agent, another model) and came back, so the session
 *   needs to be told what it was. Issue #114, h #g239.
 * - `rewound`: the recorded chain and this prompt's history share a non-empty
 *   prefix, and the chain holds user messages past it that the prompt does
 *   not. The thread got shorter or diverged: an `/undo`, an edited message, a
 *   regenerated reply. The session's context still holds those turns, which is
 *   the caller's cue to drop it. h #g242.
 * - null: every ordinary turn, and anything neither rule can name.
 *
 * Two refusals are the point rather than an oversight, and both of them keep
 * today's behaviour:
 *
 * - A shared prefix of ZERO is never `rewound`. That is what an opencode
 *   compaction looks like from here (the head of the thread replaced by a
 *   summary), and a reused session has to survive one. The cost is that an
 *   undo back to the very first message, or an edit of it, is not recognised.
 * - A removed stretch with no USER message in it is never `rewound` either.
 *   A turn following a proxied tool call can re-render one opencode message's
 *   tool-call and text halves as one assistant message where the recorded
 *   chain has two messages and a `tool` between them, and killing a healthy
 *   session on every such turn would be far worse than the bug being fixed.
 *   An undo, an edit and a regenerate all remove at least one user message.
 *
 * The prompt should be the conversation as the envelope builder sees it
 * (`filterSideQuestionHistory`), the same view `recordServedConversation` was
 * given, so a `/btw` or a doctor exchange that never reached the CLI is
 * neither recorded as seen, replayed as missed, nor read as a rewind.
 */
export function classifyConversationChange(
  sessionKey: string,
  prompt: Prompt,
): ConversationChange | null {
  const record = served.get(sessionKey)
  if (!record) return null
  const recorded = record.chain
  if (recorded.length === 0) return null

  const messages = prompt as Array<{ role: string; content: unknown }>
  let lastAssistant = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistant = i
      break
    }
  }
  if (lastAssistant < 0) return null

  // Each conversation message up to the last reply, with the prompt index it
  // came from: `conversationDigests` skips system messages, so its positions
  // are not prompt positions.
  const history: Array<{ index: number; role: string; digest: string }> = []
  for (let i = 0; i <= lastAssistant; i++) {
    const msg = messages[i]
    if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "tool") continue
    const [entry] = conversationDigests([msg] as Prompt, { assistantContent: false })
    history.push({ index: i, role: entry.role, digest: entry.digest })
  }

  let shared = 0
  while (
    shared < recorded.length &&
    shared < history.length &&
    recorded[shared].role === history[shared].role &&
    recorded[shared].digest === history[shared].digest
  ) {
    shared++
  }

  if (shared < recorded.length) {
    // The chain this prompt cannot account for. Both refusals documented
    // above live here, and both of them answer null, which is what every
    // caller did with this shape before.
    if (shared === 0) return null
    let removedUserMessages = 0
    for (let i = shared; i < recorded.length; i++) {
      if (recorded[i].role === "user") removedUserMessages++
    }
    if (removedUserMessages === 0) return null
    const checkpoint = checkpointFor(record, history)
    log.debug("this claude session holds turns the conversation no longer has", {
      sessionKey,
      recorded: recorded.length,
      shared,
      removedUserMessages,
      checkpoint: checkpoint !== undefined,
    })
    return {
      kind: "rewound",
      sharedMessages: shared,
      removedMessages: recorded.length - shared,
      removedUserMessages,
      ...(checkpoint ? { checkpoint } : {}),
    }
  }

  let firstUser = -1
  for (let i = recorded.length; i < history.length; i++) {
    if (history[i].role === "user") {
      firstUser = i
      break
    }
  }
  if (firstUser < 0) return null

  const from = history[firstUser].index
  const missed = messages.slice(from, lastAssistant + 1) as Prompt
  let userMessages = 0
  for (let i = firstUser; i < history.length; i++) {
    if (history[i].role === "user") userMessages++
  }
  log.debug("this claude session missed part of the conversation", {
    sessionKey,
    recorded: recorded.length,
    missed: missed.length,
    userMessages,
  })
  return { kind: "missed", messages: missed, userMessages }
}

/**
 * The messages `sessionKey`'s Claude session missed, or null. The `missed`
 * half of `classifyConversationChange`, kept because it is what the gap
 * replay is about and what most of its tests read.
 */
export function findMissedMessages(
  sessionKey: string,
  prompt: Prompt,
): MissedMessages | null {
  const change = classifyConversationChange(sessionKey, prompt)
  return change?.kind === "missed" ? change : null
}

/** Leading characters of the note a rewound thread writes into the reply. */
export const CONVERSATION_REWOUND_MARKER = "▌ **conversation rewound:**"

/**
 * The one thing on screen saying this turn started a new Claude session
 * because the thread it had been answering no longer exists (h #g242), and
 * whether that session is a copy cut where the thread still matches (h #g282)
 * or a replay of the thread as text.
 */
export function formatConversationRewoundNote(how: "forked" | "replayed" = "replayed"): string {
  const continued =
    how === "forked"
      ? `This turn continues a copy of that session cut at the last turn both versions ` +
        `share, which no longer has them.`
      : `This turn replays the thread as it stands now into a fresh Claude session, which ` +
        `no longer has them.`
  return (
    `\n${CONVERSATION_REWOUND_MARKER} this conversation was edited or undone, so the ` +
    `Claude session answering it still held the turns that were removed. ${continued}\n`
  )
}
