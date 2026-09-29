/**
 * Fire-and-collect for opencode's native background subagents.
 *
 * opencode already has the hard half of this and nobody had measured it. Its
 * `task` tool takes `background: true` and, when the host allows it, returns
 * at once with `<task id="ses_..." state="running">`; when the child finishes,
 * opencode prompts the PARENT session with a synthetic
 * `<task ... state="completed"><task_result>...</task_result></task>` message,
 * which in this plugin arrives as an ordinary new turn. So the dispatch and
 * the delivery already exist and this module deliberately does not rebuild
 * them: inventing a second dispatch path would mean a subagent that opencode
 * does not own, with none of its permissions, rendering or lifecycle.
 *
 * What opencode has no answer for is the other two thirds of the
 * start / collect / cancel triple the operator actually asked for:
 *
 *  - Collect. Delivery is push-only (`TaskTool.injectBackgroundResult`). There
 *    is no route that reads a background job's result back, so a notification
 *    that never lands (the operator interrupted the session, the turn errored,
 *    the conversation was compacted across it) loses the work silently.
 *  - Cancel. `POST /experimental/session/:id/background` only *promotes*
 *    already-running synchronous subagents. Nothing in opencode's tool surface
 *    stops a background child, so a runaway subagent could only be stopped by
 *    the operator, in another pane.
 *
 * Both are answered here against the child's own opencode session, whose id
 * IS the `task_id` opencode hands back, using the captured SDK client. They
 * are interceptors (`ProxyToolInterceptor`), never broker-backed calls: they
 * act on opencode state directly rather than being executed as opencode tool
 * calls, because opencode has no such tools to execute.
 *
 * Two guards that are not optional:
 *
 *  - A collect or cancel may only touch a session whose `parentID` is the
 *    opencode session doing the asking. Without it, any session id the model
 *    could name would read back another conversation's transcript.
 *  - A result is handed over once. The push notification and a collect are two
 *    delivery paths for one answer, so the ledger records the first and a
 *    second collect reports the state without re-pasting the output.
 */
import {
  abortSession,
  fetchSessionParentId,
  fetchSessionReplies,
  fetchSessionRunState,
  type SessionReply,
} from "./runtime-status.js"
import type { ProxyToolResult } from "./proxy-mcp.js"
import { log } from "./logger.js"

export const TASK_STATUS_TOOL_NAME = "task_status"
export const TASK_CANCEL_TOOL_NAME = "task_cancel"

/**
 * Per proxy session key, the background task ids whose output has already been
 * handed to this Claude conversation. Bounded like the compression store: a
 * long-lived opencode session can start many, and the ledger is a convenience,
 * never correctness, so dropping the oldest entry costs at worst one repeated
 * paste.
 */
const MAX_LEDGERS = 32
const MAX_COLLECTED_PER_SESSION = 64
const collected = new Map<string, Set<string>>()

function ledgerFor(sessionKey: string): Set<string> {
  let ids = collected.get(sessionKey)
  if (!ids) {
    ids = new Set()
    collected.set(sessionKey, ids)
    // Insertion order: the oldest conversation's ledger goes first.
    while (collected.size > MAX_LEDGERS) {
      const oldest = collected.keys().next()
      if (oldest.done) break
      collected.delete(oldest.value)
    }
  }
  return ids
}

function markCollected(sessionKey: string, taskId: string): void {
  const ids = ledgerFor(sessionKey)
  ids.add(taskId)
  while (ids.size > MAX_COLLECTED_PER_SESSION) {
    const oldest = ids.values().next()
    if (oldest.done) break
    ids.delete(oldest.value)
  }
}

export function hasCollectedBackgroundTask(
  sessionKey: string,
  taskId: string,
): boolean {
  return collected.get(sessionKey)?.has(taskId) === true
}

/**
 * Drop every ledger entry for one Claude conversation. Called from the same
 * places that release the rest of a conversation's state, so a deleted
 * opencode session or a host exit leaves nothing behind. The child sessions
 * themselves are opencode's to reap: this plugin never deletes them, because
 * a background subagent outliving a Claude process is opencode's design, not
 * a leak.
 */
export function clearBackgroundTasks(sessionKey: string): void {
  collected.delete(sessionKey)
}

/** Test seam: forget every ledger. */
export function _resetBackgroundTasks(): void {
  collected.clear()
}

function readTaskId(input: Record<string, unknown>): string | null {
  const raw = input.task_id ?? input.taskId ?? input.sessionID
  if (typeof raw !== "string") return null
  const id = raw.trim()
  return id.length > 0 ? id : null
}

const MISSING_TASK_ID =
  "task_id is required: pass the id from the `<task id=\"...\">` envelope the" +
  " background dispatch returned."

/**
 * Whether this conversation is allowed to touch that session. `undefined` for
 * the calling session means the turn never learned its opencode id (direct
 * AI-SDK use, tests), in which case the guard cannot be evaluated and is
 * skipped; every real opencode turn carries one.
 */
async function guardParent(
  taskId: string,
  callerSessionId: string | undefined,
): Promise<string | null> {
  if (!callerSessionId || callerSessionId === "default") return null
  const parent = await fetchSessionParentId(taskId)
  if (parent === callerSessionId) return null
  return (
    `task_id ${taskId} is not a subagent of this conversation, so it cannot` +
    " be inspected or cancelled from here. Use the id from a `<task" +
    ' id="...">` envelope this conversation received.'
  )
}

/** One reply's text, or "" when the subagent produced none. */
function lastAssistantReply(replies: SessionReply[]): SessionReply | undefined {
  for (let index = replies.length - 1; index >= 0; index--) {
    const reply = replies[index]!
    if (reply.role === "assistant") return reply
  }
  return undefined
}

export interface BackgroundTaskToolOptions {
  sessionKey: string
  /** The opencode session this Claude conversation is serving. */
  callerSessionId: string | undefined
}

/**
 * Answer `task_status`. Non-blocking on purpose: opencode's own background
 * prose tells the model not to poll, and a blocking collect here would undo
 * the whole point of dispatching in the background. One call reports the state
 * now, and says what to do with it.
 */
export async function collectBackgroundTask(
  input: Record<string, unknown>,
  options: BackgroundTaskToolOptions,
): Promise<ProxyToolResult> {
  const taskId = readTaskId(input)
  if (!taskId) return { kind: "error", message: MISSING_TASK_ID }

  const refused = await guardParent(taskId, options.callerSessionId)
  if (refused) return { kind: "error", message: refused }

  const replies = await fetchSessionReplies(taskId)
  if (replies === undefined) {
    return {
      kind: "error",
      message:
        `Could not read background task ${taskId} from opencode. It may have` +
        " been deleted, or this opencode build does not expose the session" +
        " transcript. The completion notification is still the primary" +
        " delivery path: end your turn and wait for it.",
    }
  }

  const runState = await fetchSessionRunState(taskId)
  if (runState === "busy") {
    return {
      kind: "text",
      text:
        `<task id="${taskId}" state="running">\nStill working. Do not call` +
        " this again in a loop: when it finishes opencode delivers the" +
        " result to this conversation on its own. End your turn, or work on" +
        " something that does not overlap it.\n</task>",
    }
  }

  const reply = lastAssistantReply(replies)
  if (!reply) {
    return {
      kind: "text",
      text:
        `<task id="${taskId}" state="unknown">\nopencode has no assistant` +
        " reply for this task yet and it is not running. It may still be" +
        " starting up.\n</task>",
    }
  }

  if (reply.error) {
    markCollected(options.sessionKey, taskId)
    return {
      kind: "text",
      isError: true,
      text: `<task id="${taskId}" state="error">\n${reply.error}\n</task>`,
    }
  }

  if (hasCollectedBackgroundTask(options.sessionKey, taskId)) {
    return {
      kind: "text",
      text:
        `<task id="${taskId}" state="completed">\nAlready delivered to this` +
        " conversation earlier (by this tool or by opencode's completion" +
        " notification). Scroll back for the result rather than collecting" +
        " it again.\n</task>",
    }
  }

  markCollected(options.sessionKey, taskId)
  log.info("collected background subagent result", {
    sessionKey: options.sessionKey,
    taskId,
    textLength: reply.text.length,
  })
  return {
    kind: "text",
    text:
      `<task id="${taskId}" state="completed">\n<task_result>\n` +
      `${reply.text || "(the subagent produced no text)"}\n` +
      "</task_result>\n</task>",
  }
}

/** Answer `task_cancel`: stop the child session and say whether it stopped. */
export async function cancelBackgroundTask(
  input: Record<string, unknown>,
  options: BackgroundTaskToolOptions,
): Promise<ProxyToolResult> {
  const taskId = readTaskId(input)
  if (!taskId) return { kind: "error", message: MISSING_TASK_ID }

  const refused = await guardParent(taskId, options.callerSessionId)
  if (refused) return { kind: "error", message: refused }

  const before = await fetchSessionRunState(taskId)
  const aborted = await abortSession(taskId)
  if (!aborted) {
    return {
      kind: "error",
      message:
        `Could not cancel background task ${taskId}: opencode did not accept` +
        " the abort. It may have already finished, or this opencode build" +
        " does not expose session abort.",
    }
  }
  // A cancelled task will never deliver, so nothing must later claim it was
  // already delivered.
  collected.get(options.sessionKey)?.delete(taskId)
  log.info("cancelled background subagent", {
    sessionKey: options.sessionKey,
    taskId,
    wasRunning: before === "busy",
  })
  return {
    kind: "text",
    text:
      `<task id="${taskId}" state="cancelled">\n` +
      (before === "busy"
        ? "Stopped. No completion notification will arrive for it."
        : "It was not running when the cancel was sent, so nothing was" +
          " interrupted. No completion notification will arrive for it.") +
      "\n</task>",
  }
}
