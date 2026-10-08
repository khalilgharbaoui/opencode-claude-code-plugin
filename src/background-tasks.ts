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
  type SessionRunState,
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
/**
 * The same bookkeeping for cancels, kept only so the doctor can say what this
 * process did. It is never read by either tool: a cancelled task is dropped
 * from `collected` so nothing can later claim it was delivered.
 */
const cancelled = new Map<string, Set<string>>()

function ledgerIn(
  ledgers: Map<string, Set<string>>,
  sessionKey: string,
): Set<string> {
  let ids = ledgers.get(sessionKey)
  if (!ids) {
    ids = new Set()
    ledgers.set(sessionKey, ids)
    // Insertion order: the oldest conversation's ledger goes first.
    while (ledgers.size > MAX_LEDGERS) {
      const oldest = ledgers.keys().next()
      if (oldest.done) break
      ledgers.delete(oldest.value)
    }
  }
  return ids
}

function mark(
  ledgers: Map<string, Set<string>>,
  sessionKey: string,
  taskId: string,
): void {
  const ids = ledgerIn(ledgers, sessionKey)
  ids.add(taskId)
  while (ids.size > MAX_COLLECTED_PER_SESSION) {
    const oldest = ids.values().next()
    if (oldest.done) break
    ids.delete(oldest.value)
  }
}

function markCollected(sessionKey: string, taskId: string): void {
  mark(collected, sessionKey, taskId)
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
  cancelled.delete(sessionKey)
}

/** Test seam: forget every ledger and the recorded gate. */
export function _resetBackgroundTasks(): void {
  collected.clear()
  cancelled.clear()
  started.clear()
  lastGate = undefined
}

/**
 * Every background dispatch this process saw opencode accept, newest last,
 * keyed by task id. Process-wide and deliberately NOT released with a
 * conversation (`clearBackgroundTasks`): it answers "how many subagents are
 * working right now" for `/claude-code-doctor`, and a background child keeps
 * working after the conversation that started it moved to another key, lost
 * its process or was deleted, because opencode owns it. Bounded, because the
 * count is a gauge and never correctness: the oldest id is the one most likely
 * to have finished long ago.
 */
const MAX_STARTED = 128
const started = new Map<string, { sessionKey: string; at: number }>()

/**
 * The task ids a `task` or `task_batch` result reports as started in the
 * background. Only the two envelopes opencode actually writes for an accepted
 * background dispatch are read, so a foreground result, an error and anything
 * a subagent itself wrote never count: on 1.x `<task id="ses_..."
 * state="running">`, on 2.x the prose `The subagent is working in the
 * background (sessionID: ses_...)` (h #g176). A `task_batch` result is the
 * children's results joined, so it can report several.
 */
export function backgroundTaskIdsIn(text: string): string[] {
  const ids = new Set<string>()
  for (const match of text.matchAll(/<task id="([^"\s]+)" state="running">/g)) {
    ids.add(match[1]!)
  }
  for (const match of text.matchAll(/in the background \(sessionID: ([^)\s]+)\)/g)) {
    ids.add(match[1]!)
  }
  return [...ids]
}

/**
 * Remember the background dispatches one proxied `task` or `task_batch` result
 * reports. Called where opencode's result is handed back to the CLI, which is
 * the one place both majors and both transports pass through. Never throws.
 */
export function noteBackgroundDispatchResult(
  sessionKey: string,
  result: ProxyToolResult,
  now = Date.now(),
): void {
  if (result.kind !== "text" || result.isError === true) return
  for (const taskId of backgroundTaskIdsIn(result.text)) {
    // Re-inserting moves a re-dispatched id to the newest end.
    started.delete(taskId)
    started.set(taskId, { sessionKey, at: now })
    while (started.size > MAX_STARTED) {
      const oldest = started.keys().next()
      if (oldest.done) break
      started.delete(oldest.value)
    }
  }
}

/** How many of this process's background dispatches are still running. */
export interface BackgroundRunningCount {
  /** Still working, by the same test `task_status` applies. */
  running: number
  /** Every background dispatch this process saw opencode accept (bounded). */
  started: number
  /** Neither the run state nor the transcript answered, so not counted as running. */
  unreadable: number
}

/**
 * Count the background subagents still running, for `/claude-code-doctor`.
 *
 * Read-only and never consuming: it asks opencode the same two questions
 * `task_status` does (`fetchSessionRunState`, then the transcript only when
 * the run state cannot answer) and runs the same `isBackgroundTaskRunning`,
 * but never marks anything collected, so the collect-once invariant is
 * untouched. A task this process cancelled is not asked about at all. No
 * inference, no model, no CLI. Never throws: a lookup that fails is counted as
 * `unreadable` rather than guessed.
 */
export async function countRunningBackgroundTasks(): Promise<BackgroundRunningCount> {
  const entries = [...started.entries()]
  const cancelledIds = cancelledTaskIds()
  const states = await Promise.all(
    entries.map(([taskId]) => backgroundTaskState(taskId, cancelledIds)),
  )
  return {
    running: states.filter((state) => state === "running").length,
    started: entries.length,
    unreadable: states.filter((state) => state === "unreadable").length,
  }
}

type BackgroundTaskState = "running" | "stopped" | "unreadable"

function cancelledTaskIds(): Set<string> {
  const ids = new Set<string>()
  for (const set of cancelled.values()) for (const id of set) ids.add(id)
  return ids
}

/** One started task's state, by `task_status`'s own test. Never throws. */
async function backgroundTaskState(
  taskId: string,
  cancelledIds: Set<string>,
): Promise<BackgroundTaskState> {
  if (cancelledIds.has(taskId)) return "stopped"
  try {
    const runState = await fetchSessionRunState(taskId)
    if (runState !== "unknown") {
      return isBackgroundTaskRunning(runState, []) ? "running" : "stopped"
    }
    const replies = await fetchSessionReplies(taskId)
    if (replies === undefined) return "unreadable"
    return isBackgroundTaskRunning(runState, replies) ? "running" : "stopped"
  } catch {
    return "unreadable"
  }
}

/**
 * How long a background dispatch's result may wait for the running count
 * before it goes back to Claude without one. The dispatch itself already
 * happened; the count is a courtesy, and a slow opencode must never make a
 * background dispatch feel like a foreground one.
 */
export const BACKGROUND_COUNT_BUDGET_MS = 500
/** Lookups in flight at once, so a long ledger cannot flood opencode. */
const BACKGROUND_COUNT_CONCURRENCY = 4

/**
 * How many OTHER started background subagents are running, or undefined when
 * the lookups did not all finish inside `budgetMs`, one of them could not be
 * read, or anything threw. An unreadable child is a refusal rather than a
 * zero because a count that is too LOW is the harmful direction: it tells the
 * model there is room it does not have. The same read-only, non-consuming
 * question `countRunningBackgroundTasks` asks, with bounded concurrency and a
 * deadline. A worker stops picking up entries once the deadline passed;
 * lookups already in flight are read-only and simply finish unobserved.
 */
async function countOtherRunningWithin(
  exclude: ReadonlySet<string>,
  budgetMs: number,
): Promise<number | undefined> {
  const taskIds = [...started.keys()].filter((taskId) => !exclude.has(taskId))
  if (taskIds.length === 0) return 0
  const cancelledIds = cancelledTaskIds()
  let overBudget = false
  let unreadable = false
  let next = 0
  let running = 0
  const worker = async (): Promise<void> => {
    while (!overBudget && !unreadable && next < taskIds.length) {
      const taskId = taskIds[next++]!
      const state = await backgroundTaskState(taskId, cancelledIds)
      if (state === "running") running++
      if (state === "unreadable") unreadable = true
    }
  }
  const workers = Array.from(
    { length: Math.min(BACKGROUND_COUNT_CONCURRENCY, taskIds.length) },
    worker,
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<"over">((resolve) => {
    timer = setTimeout(() => resolve("over"), budgetMs)
    timer.unref?.()
  })
  try {
    const outcome = await Promise.race([Promise.all(workers).then(() => "done" as const), deadline])
    if (outcome === "over") {
      overBudget = true
      return undefined
    }
    return unreadable ? undefined : running
  } catch {
    overBudget = true
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * opencode's answer to a background `task` / `task_batch` dispatch, with one
 * line appended saying how many background subagents are running now, so the
 * model can see the load it is adding to. Anything that is not an accepted
 * background dispatch (a foreground answer, an error, every other tool) is
 * returned untouched, and so is a dispatch whose count did not arrive inside
 * the budget: the line is omitted rather than the dispatch delayed.
 *
 * The line goes AFTER opencode's text, so `backgroundTaskIdsIn` and both id
 * patterns still match the result Claude receives. The ids this result just
 * reported are not looked up: opencode has just said they are running, and a
 * child that has not been scheduled yet can still read `idle`, which would
 * make "including" untrue. They are added to the count of the others instead.
 * Call `noteBackgroundDispatchResult` first; this never records anything.
 */
export async function withBackgroundRunningCount(
  result: ProxyToolResult,
  budgetMs = BACKGROUND_COUNT_BUDGET_MS,
): Promise<ProxyToolResult> {
  if (result.kind !== "text" || result.isError === true) return result
  const dispatched = backgroundTaskIdsIn(result.text)
  if (dispatched.length === 0) return result
  const others = await countOtherRunningWithin(new Set(dispatched), budgetMs)
  if (others === undefined) {
    log.info("background running count omitted: a lookup was slow or unreadable", {
      budgetMs,
      dispatched: dispatched.length,
    })
    return result
  }
  return { ...result, text: result.text + formatBackgroundRunningLine(others, dispatched.length) }
}

export function formatBackgroundRunningLine(others: number, dispatched: number): string {
  const total = others + dispatched
  const including = dispatched === 1 ? "this one" : `the ${dispatched} just started`
  return `\n\nBackground subagents running now: ${total} (including ${including}).`
}

/**
 * What the plugin last decided about background subagents on this host, for
 * `/claude-code-doctor`. Recorded rather than recomputed because the gate is
 * read off opencode's live tool registry while a turn plans its proxy tools,
 * and the doctor answers without a turn.
 */
export interface BackgroundSubagentGate {
  /** Whether `background` was offered to Claude and the two tools registered. */
  supported: boolean
  /** Which opencode major that model serves. */
  hostApi: "v1" | "v2"
  /** Whether opencode's live tool registry answered at all. */
  registryResolved: boolean
  /** `Date.now()` of the read. */
  at: number
}

let lastGate: BackgroundSubagentGate | undefined

export function recordBackgroundSubagentGate(
  gate: Omit<BackgroundSubagentGate, "at">,
  now = Date.now(),
): void {
  lastGate = { ...gate, at: now }
}

/** Read-only copy, or undefined when no turn has planned its tools yet. */
export function snapshotBackgroundSubagentGate(): BackgroundSubagentGate | undefined {
  return lastGate ? { ...lastGate } : undefined
}

/** One Claude conversation's background-task bookkeeping, for the doctor. */
export interface BackgroundTaskLedger {
  sessionKey: string
  collected: string[]
  cancelled: string[]
}

/**
 * Every conversation this process has collected or cancelled a background task
 * for. Read-only: it copies the sets and touches no ledger, the same contract
 * `snapshotActiveProcesses` and `snapshotPendingProxyCalls` hold. Task ids are
 * opencode session ids, which the model was already handed and which the
 * doctor already prints as session affinities, so nothing secret is added.
 */
export function snapshotBackgroundTasks(): BackgroundTaskLedger[] {
  const keys = new Set([...collected.keys(), ...cancelled.keys()])
  return [...keys].map((sessionKey) => ({
    sessionKey,
    collected: [...(collected.get(sessionKey) ?? [])],
    cancelled: [...(cancelled.get(sessionKey) ?? [])],
  }))
}

function readTaskId(input: Record<string, unknown>): string | null {
  const raw = input.task_id ?? input.taskId ?? input.sessionID
  if (typeof raw !== "string") return null
  const id = raw.trim()
  return id.length > 0 ? id : null
}

const MISSING_TASK_ID =
  "task_id is required: pass the background subagent's own opencode session" +
  ' id, from the `<task id="...">` envelope on opencode 1.x or the' +
  " `sessionID` the background dispatch reported on opencode 2."

/**
 * Whether this conversation is allowed to touch that session. It fails
 * CLOSED: when the turn never learned its opencode id (`undefined`, or the
 * `"default"` affinity bucket, as in direct AI-SDK use), the parent cannot be
 * checked, and letting the call through would let the model inspect or abort
 * any session id it names. A background task only exists under a real
 * opencode session, so refusing there costs nothing.
 */
async function guardParent(
  taskId: string,
  callerSessionId: string | undefined,
): Promise<string | null> {
  if (!callerSessionId || callerSessionId === "default") {
    return (
      `Cannot check that task_id ${taskId} belongs to this conversation (this` +
      " turn has no opencode session id), so it is not inspected or cancelled."
    )
  }
  const parent = await fetchSessionParentId(taskId)
  if (parent === callerSessionId) return null
  return (
    `task_id ${taskId} is not a subagent of this conversation, so it cannot` +
    " be inspected or cancelled from here. Use the session id from a" +
    " background dispatch this conversation itself made."
  )
}

/**
 * Whether the child is still working.
 *
 * `fetchSessionRunState` is authoritative when it answers, but it cannot
 * answer on opencode 2: V2's all-sessions run-state map is `session.active`,
 * and the `SessionDomain` a plugin is handed there does not include it (read
 * off `@opencode/plugin@2.0.16`). So `unknown` falls back to the transcript,
 * where an assistant message without `time.completed` is one still streaming.
 * `idle` stays authoritative in the other direction: an interrupted turn
 * leaves an assistant message that never completed, and calling that "running"
 * would park the model on a task nothing will finish.
 */
export function isBackgroundTaskRunning(
  runState: SessionRunState,
  replies: SessionReply[],
): boolean {
  if (runState === "busy") return true
  if (runState === "idle") return false
  const reply = lastAssistantReply(replies)
  return reply !== undefined && !reply.completed && reply.error === undefined
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
  if (isBackgroundTaskRunning(runState, replies)) {
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

  const running = isBackgroundTaskRunning(
    await fetchSessionRunState(taskId),
    (await fetchSessionReplies(taskId)) ?? [],
  )
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
  mark(cancelled, options.sessionKey, taskId)
  log.info("cancelled background subagent", {
    sessionKey: options.sessionKey,
    taskId,
    wasRunning: running,
  })
  return {
    kind: "text",
    text:
      `<task id="${taskId}" state="cancelled">\n` +
      (running
        ? "Stopped. No completion notification will arrive for it."
        : "It was not running when the cancel was sent, so nothing was" +
          " interrupted. No completion notification will arrive for it.") +
      "\n</task>",
  }
}
