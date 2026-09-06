import { detectCliVersion } from "./cli-version.js"
import { log } from "./logger.js"
import { getOpencodeClient } from "./runtime-status.js"
import { findActiveProcessBySessionId, type ActiveProcess } from "./session-manager.js"
import {
  collectSideQuestionHistory,
  isSideQuestionPending,
  requestSideQuestion,
  SIDE_QUESTION_USAGE,
  type SideQuestionExchange,
  type SideQuestionResult,
} from "./side-question.js"

/**
 * `/btw`: a side question that is answered while the main turn keeps running,
 * and whose exchange is kept in the conversation where it was asked.
 *
 * opencode's TUI sends every slash command to the server the moment it is
 * typed, busy or not (`tui/component/prompt/index.tsx`), so the
 * `command.execute.before` hook fires immediately. The user message the
 * command produces is what gets held back ("Queued") until the running turn
 * ends, and opencode's loop then runs it as a step of its own: the loop only
 * exits when the newest assistant message answers the newest user message
 * (`session/prompt.ts`, `lastAssistant.parentID === lastUser.id`).
 *
 * So the hook does two things and then lets the message through:
 *   1. sends the question to the conversation's live `claude` process as a
 *      `side_question` control request right away (Claude Code answers those
 *      on a separate advisor call, concurrently with a running turn, from the
 *      conversation's context), and remembers the pending answer per session;
 *   2. when the turn was busy, shows the answer as a toast the moment it
 *      arrives, since the transcript cannot show it until the turn ends.
 * The queued `/btw` message then reaches the aside branch in
 * `claude-code-language-model.ts`, which takes the remembered answer (or asks
 * the now idle process) and emits it as that message's assistant reply, at no
 * cost. `filterSideQuestionHistory` keeps every such pair out of Claude's
 * prompt afterwards, and the control request never touches Claude's own
 * transcript, so the aside is persisted for the operator only.
 */

type SdkResult<T = unknown> = Promise<{ data?: T; error?: unknown }>

export interface BtwToast {
  title?: string
  message: string
  variant: "info" | "success" | "warning" | "error"
  duration?: number
}

export interface BtwSdkMessage {
  info?: { role?: string }
  parts?: unknown[]
}

export interface BtwSdkClient {
  session?: {
    messages?: (options: { path: { id: string } }) => SdkResult<BtwSdkMessage[]>
    /** `GET /session/status`: sessions missing from the map are idle. */
    status?: () => SdkResult<Record<string, { type: string }>>
  }
  tui?: {
    showToast?: (options: { body: BtwToast }) => SdkResult
  }
}

export interface BtwCommandInput {
  command: string
  sessionID: string
  arguments: string
}

/** Thrown to make opencode drop the prompt when there is nothing worth keeping. */
export class BtwHandledError extends Error {
  override readonly name = "BtwHandledError"
  constructor(message = "/btw was handled by the claude-code plugin; nothing to add to this conversation.") {
    super(message)
  }
}

export const BTW_NO_SESSION_MESSAGE =
  "/btw needs a live Claude Code session in this conversation. Send a normal message with a Claude Code model first, then ask again."

export const BTW_BUSY_TOAST_MESSAGE =
  "Answering alongside the running turn. The full answer is added to this conversation when the turn ends."

export const BTW_IN_FLIGHT_TOAST_MESSAGE =
  "A previous /btw is still being answered. This one is asked once the turn ends."

export const BTW_TURN_TOO_LONG_MESSAGE =
  "/btw gave up waiting for this turn to end. Ask again once it is over."

const IDLE_POLL_MS = 500
const IDLE_WAIT_MAX_MS = 30 * 60_000

const ANSWER_TOAST_MIN_MS = 10_000
const ANSWER_TOAST_MAX_MS = 60_000
const ANSWER_TOAST_MS_PER_CHAR = 60
const ANSWER_TOAST_CHARS = 600
const PENDING_ANSWER_TTL_MS = 10 * 60_000
const PENDING_ANSWER_CAP = 32

interface PendingAnswer {
  question: string
  answer: Promise<SideQuestionResult>
  at: number
}

/** Answers the hook requested ahead of the queued prompt, one per opencode session. */
const pendingAnswers = new Map<string, PendingAnswer>()

export function rememberSideQuestionAnswer(
  sessionID: string,
  question: string,
  answer: Promise<SideQuestionResult>,
  now = Date.now(),
): void {
  for (const [id, entry] of pendingAnswers) {
    if (now - entry.at > PENDING_ANSWER_TTL_MS) pendingAnswers.delete(id)
  }
  pendingAnswers.delete(sessionID)
  while (pendingAnswers.size >= PENDING_ANSWER_CAP) {
    const oldest = pendingAnswers.keys().next().value
    if (oldest === undefined) break
    pendingAnswers.delete(oldest)
  }
  pendingAnswers.set(sessionID, { question: question.trim(), answer, at: now })
}

/**
 * The answer the hook already requested for this session, if it was for this
 * question and is still fresh. Taking it consumes it: a later `/btw` with the
 * same text asks again rather than replaying a stale answer.
 *
 * The question the turn parses may be longer than what the hook saw: a
 * harness can append trailing metadata to the message text (opencode-dcp adds
 * a `<dcp-message-id>` marker), so the hook's question only has to be a prefix.
 * Measured live: an exact match missed, the turn asked again, and the
 * single-flight guard refused it as a second concurrent aside.
 */
export function takeSideQuestionAnswer(
  sessionID: string,
  question: string,
  now = Date.now(),
): Promise<SideQuestionResult> | undefined {
  const entry = pendingAnswers.get(sessionID)
  if (!entry) return undefined
  pendingAnswers.delete(sessionID)
  if (!question.trim().startsWith(entry.question) || now - entry.at > PENDING_ANSWER_TTL_MS) return undefined
  return entry.answer
}

/** Test seam. */
export function clearPendingSideQuestionAnswers(): void {
  pendingAnswers.clear()
}

export function answerToastMessage(answer: string): string {
  const flat = answer.replace(/\s+/g, " ").trim()
  return flat.length > ANSWER_TOAST_CHARS ? `${flat.slice(0, ANSWER_TOAST_CHARS - 3)}...` : flat
}

/** Long enough to read: the TUI's toast is 60 columns wide and word-wraps. */
export function answerToastDuration(answer: string): number {
  const chars = Math.min(answer.trim().length, ANSWER_TOAST_CHARS)
  return Math.min(ANSWER_TOAST_MAX_MS, Math.max(ANSWER_TOAST_MIN_MS, ANSWER_TOAST_MIN_MS + chars * ANSWER_TOAST_MS_PER_CHAR))
}

export function showToast(client: BtwSdkClient | null, body: BtwToast): void {
  // Keep the receiver: the SDK's namespace methods read `this._client`, so a
  // detached `const show = client.tui.showToast` throws at call time.
  try {
    void client?.tui?.showToast?.({ body })?.catch((error: unknown) => {
      log.debug("btw toast failed", { error: errorText(error) })
    })
  } catch (error) {
    log.debug("btw toast failed", { error: errorText(error) })
  }
}

/** A turn is streaming from this process, so its transcript cannot show an answer yet. */
export function isProcessBusy(active: Pick<ActiveProcess, "lineEmitter">): boolean {
  return active.lineEmitter.listenerCount("line") > 0
}

/**
 * opencode's own view of the session: `busy` for the whole turn, including
 * the gaps where opencode runs a tool and no stream is attached to the
 * process, which `isProcessBusy` cannot see. `unknown` when the SDK has no
 * status route or it fails.
 */
export async function sessionStatus(
  client: BtwSdkClient | null,
  sessionID: string,
): Promise<"busy" | "idle" | "unknown"> {
  const status = client?.session?.status
  if (!status) return "unknown"
  try {
    const result = await status.call(client!.session)
    const entry = result.data?.[sessionID]
    return entry && entry.type !== "idle" ? "busy" : "idle"
  } catch (error) {
    log.debug("btw: could not read session status", { sessionID, error: errorText(error) })
    return "unknown"
  }
}

/**
 * Resolves once the session is no longer busy. Returns false on timeout. A
 * client without a status route resolves at once, since there is nothing to
 * wait on.
 */
export async function waitForSessionIdle(
  client: BtwSdkClient | null,
  sessionID: string,
  options: { pollMs?: number; timeoutMs?: number } = {},
): Promise<boolean> {
  const pollMs = options.pollMs ?? IDLE_POLL_MS
  const timeoutMs = options.timeoutMs ?? IDLE_WAIT_MAX_MS
  const started = Date.now()
  for (;;) {
    if ((await sessionStatus(client, sessionID)) !== "busy") return true
    if (Date.now() - started >= timeoutMs) return false
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") {
    return (error as { message: string }).message
  }
  return String(error)
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
  return (
    part !== null &&
    typeof part === "object" &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
  )
}

/**
 * Earlier `/btw` exchanges in this conversation, read back from opencode
 * because the hook runs before the current question exists as a message.
 * Best effort: a follow-up without history still gets an answer, just one
 * that cannot refer to previous asides.
 */
export async function fetchAsideHistory(
  client: BtwSdkClient | null,
  sessionID: string,
  question: string,
): Promise<SideQuestionExchange[]> {
  const messages = client?.session?.messages
  if (!messages) return []
  try {
    const result = await messages.call(client!.session, { path: { id: sessionID } })
    const prompt: { role: string; content: unknown }[] = []
    for (const message of result.data ?? []) {
      const role = message.info?.role
      if (role !== "user" && role !== "assistant") continue
      prompt.push({ role, content: (message.parts ?? []).filter(isTextPart) })
    }
    // collectSideQuestionHistory skips the final message as the question being
    // asked; stand in for the one opencode has not created yet.
    prompt.push({ role: "user", content: `/btw ${question}` })
    return collectSideQuestionHistory(prompt)
  } catch (error) {
    log.debug("btw: could not read aside history", { sessionID, error: errorText(error) })
    return []
  }
}

/**
 * `command.execute.before` handler for `btw`. Returns normally so opencode
 * creates the `/btw` message in this conversation; throws only when there is
 * nothing to keep (a bare `/btw`, or a turn that never ended).
 *
 * While the session is busy the return is delayed until it is idle. opencode
 * would otherwise queue the message behind the running turn and run it as
 * that turn's next step, which is also the step that carries the results of
 * the tools opencode just ran: answering the aside there would swallow the
 * turn's own continuation (measured live: the main answer never appeared).
 * opencode already keeps the command route open for a queued prompt, so
 * holding it here changes nothing on the wire, and the TUI's call is
 * fire-and-forget.
 */
export async function handleBtwCommand(
  client: BtwSdkClient | null,
  input: BtwCommandInput,
  options: { pollMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const question = input.arguments.trim()
  if (!question) {
    showToast(client, { title: "btw", message: SIDE_QUESTION_USAGE, variant: "warning", duration: 6_000 })
    throw new BtwHandledError("/btw needs a question.")
  }
  const active = findActiveProcessBySessionId(input.sessionID)
  const transport = active?.asideTransport
  if (!active || !transport) {
    // The message still goes through: the session is idle, so the aside
    // branch answers it at once with an explanation that stays readable.
    log.info("btw: no live claude process for session, leaving it to the turn", { sessionID: input.sessionID })
    return
  }
  const status = await sessionStatus(client, input.sessionID)
  const busy = status === "busy" || (status === "unknown" && isProcessBusy(active))
  if (isSideQuestionPending(active)) {
    // One aside per process at a time. Leave the earlier answer in place for
    // its own message; this one asks when its turn comes.
    log.info("btw: an aside is already in flight, leaving this one to the turn", { sessionID: input.sessionID, busy })
    showToast(client, { title: "btw", message: BTW_IN_FLIGHT_TOAST_MESSAGE, variant: "info", duration: 5_000 })
  } else {
    const history = await fetchAsideHistory(client, input.sessionID, question)
    const answer = requestSideQuestion(active, question, {
      cliVersion: await detectCliVersion(transport.cliPath),
      interactive: transport.interactive,
      ...(history.length ? { history } : {}),
    })
    rememberSideQuestionAnswer(input.sessionID, question, answer)
    log.info("btw: aside sent ahead of its message", {
      sessionID: input.sessionID,
      busy,
      questionLength: question.length,
      history: history.length,
    })
    if (busy) {
      showToast(client, { title: "btw", message: BTW_BUSY_TOAST_MESSAGE, variant: "info", duration: 4_000 })
    }
    answer.then(
      (result) => {
        log.info("btw: early answer arrived", { sessionID: input.sessionID, busy, responseLength: result.response.length })
        if (busy && !result.synthetic) {
          showToast(client, {
            title: "btw",
            message: answerToastMessage(result.response),
            variant: "success",
            duration: answerToastDuration(result.response),
          })
        }
      },
      (error: unknown) => {
        // The message asks again once its turn runs, so no toast here.
        log.warn("btw: early aside failed; the message will ask again", {
          sessionID: input.sessionID,
          error: errorText(error),
        })
      },
    )
  }
  if (!busy) return
  const started = Date.now()
  const idle = await waitForSessionIdle(client, input.sessionID, options)
  log.info("btw: turn over, releasing the /btw message", { sessionID: input.sessionID, idle, waitedMs: Date.now() - started })
  if (!idle) {
    showToast(client, { title: "btw", message: BTW_TURN_TOO_LONG_MESSAGE, variant: "warning", duration: 8_000 })
    throw new BtwHandledError(BTW_TURN_TOO_LONG_MESSAGE)
  }
}
