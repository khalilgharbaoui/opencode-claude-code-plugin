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
 * So the hook sends the question to the conversation's live `claude` process
 * as a `side_question` control request right away (Claude Code answers those
 * on a separate advisor call, concurrently with a running turn, from the
 * conversation's context) and remembers the pending answer per session. Where
 * the answer lands then depends on what is open when it arrives:
 *   1. a turn is streaming, so the answer is written into that turn's own
 *      reply as its own text block and the `/btw` message is dropped. The
 *      operator reads it in place, the moment it is ready, and it stays;
 *   2. nothing is open to write to, so the `/btw` message is held until the
 *      turn ends. It then reaches the aside branch in
 *      `claude-code-language-model.ts`, which takes the remembered answer and
 *      emits it as that message's reply, at no cost;
 *   3. the conversation was idle all along, so the message runs at once and
 *      case 2 is all that happens.
 * Every one of those lands in the conversation, so none of them toasts: a
 * toast expires and the operator asked for the answer to stay. The two that
 * remain are the paths where nothing reaches the conversation at all, a bare
 * `/btw` and a turn that never ended, where a toast is the only feedback left.
 * `filterSideQuestionHistory` keeps every `/btw` pair out of Claude's prompt,
 * `INLINE_ASIDE_MARKER` does the same for case 1's block, and the control
 * request never touches Claude's own transcript, so an aside is persisted for
 * the operator only.
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

/** Every wait the hook can make, so tests do not have to sit through them. */
export interface BtwWaitOptions {
  /** How often to re-read opencode's session status. */
  pollMs?: number
  /** Cap on holding the `/btw` message back while a turn runs. */
  timeoutMs?: number
  /** Cap on treating an idle-looking status as not yet registered. */
  settleMs?: number
  /** Cap on waiting for the running turn's `claude` process to be tagged. */
  spawnWaitMs?: number
  /** How often to retry writing the answer into the running turn. */
  inlinePollMs?: number
  /** Cap on waiting for a stream to write the answer into. */
  inlineWaitMs?: number
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

export const BTW_INLINE_HANDLED_MESSAGE =
  "/btw was answered inside the running turn; nothing to add to this conversation."

export const BTW_TURN_TOO_LONG_MESSAGE =
  "/btw gave up waiting for this turn to end. Ask again once it is over."

const IDLE_POLL_MS = 500
const IDLE_WAIT_MAX_MS = 30 * 60_000
/**
 * How long a single status read is allowed to be wrong. opencode registers
 * the turn a moment after the TUI sends the command, and a session missing
 * from `GET /session/status` reads as idle, so a `/btw` typed inside that gap
 * would decide the conversation is free and let its message queue.
 */
const BUSY_SETTLE_MS = 1_500
/**
 * How long to wait for the turn's `claude` process to appear. doStream tags
 * the process only once it attaches its line listener, which is after the
 * whole spawn path, so the first `/btw` of a conversation regularly arrives
 * before there is anything to ask. Bounded, because the running turn may
 * belong to another provider and then no process is ever coming.
 */
const SPAWN_WAIT_MAX_MS = 30_000

const INLINE_POLL_MS = 200
/**
 * How long to keep trying to write into the turn. A turn is a run of streams,
 * not one: every proxy tool call ends the current stream and opencode opens
 * the next one with the tool's result, so an answer that arrives inside that
 * gap has nothing to write to yet and has to wait for the next stream.
 */
const INLINE_WAIT_MAX_MS = 20_000

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

/**
 * Header of the block an aside writes into the running turn's own reply, and
 * the marker `message-builder` strips by when a transcript has to be rebuilt
 * for a fresh Claude process. Kept as the first characters of its own text
 * part so the strip is exact rather than a guess at where the block ends.
 */
export const INLINE_ASIDE_MARKER = "▌ **btw:**"

/**
 * Markers of blocks written before the bar replaced the blockquote. Only the
 * strip reads these: a conversation that already holds an old aside still has
 * to keep it out of a rebuilt transcript.
 */
export const LEGACY_INLINE_ASIDE_MARKERS = ["> **btw:**"]

/**
 * A literal bar on every line, blank ones included, so the aside reads as one
 * block down its whole height.
 *
 * The obvious alternative, a markdown blockquote, was tried first and is why
 * this exists: opencode renders assistant text with OpenTUI's markdown, which
 * draws a blockquote's left border in the `conceal` scope's colour, not the
 * theme's `markdownBlockQuote`. That border is dim by design and there is no
 * per-block way to change it, so the bar has to be text the plugin emits.
 * Line breaks survive because OpenTUI renders a paragraph from `token.raw`,
 * verbatim, rather than reflowing it.
 */
function barEveryLine(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() === "" ? "▌" : `▌ ${line}`))
    .join("\n")
}

function oneLine(question: string): string {
  return question.replace(/\s+/g, " ").trim()
}

function asideHeader(question: string): string {
  return `${INLINE_ASIDE_MARKER} ${oneLine(question)}`
}

export function formatInlineAside(question: string, answer: string): string {
  return `\n${asideHeader(question)}\n▌\n${barEveryLine(answer.trim())}\n`
}

/**
 * The receipt's trailing note. Past tense, because the block stays in the
 * conversation and an "answering..." would read as stale the moment the
 * answer lands.
 */
export const INLINE_ASIDE_SENT_NOTE = "*sent to Claude on the side*"

/**
 * A receipt written into the running turn the moment the question goes out, so
 * a `/btw` typed mid-turn shows as taken instead of looking swallowed until
 * the answer arrives.
 *
 * It quotes the question back **in full**, which is what the operator asked
 * for: the prompt box clears on submit and no `/btw` message is ever created,
 * so this is the only place the question can be read back. It was briefly
 * capped at 240 characters and that was wrong for the same reason, since a
 * long aside would then be unreadable everywhere. The note goes on its own bar
 * line so the question is never crowded by it.
 *
 * The answer block repeats the question rather than dropping it, because the
 * model keeps streaming its own text between the two and a headerless answer
 * arriving after that reads as orphaned.
 */
export function formatInlineAsideAsk(question: string): string {
  return `\n${asideHeader(question)}\n▌ ${INLINE_ASIDE_SENT_NOTE}\n`
}

/**
 * Writes one finished text block into a stream that is open right now.
 * Returns false when there is nothing to write to, which is the whole reason
 * the held-message path is still here.
 */
export type AsideSink = (text: string) => boolean

/** At most one open stream per conversation, so a plain map is enough. */
const asideSinks = new Map<string, AsideSink>()

export function registerAsideSink(sessionID: string, sink: AsideSink): () => void {
  asideSinks.set(sessionID, sink)
  return () => {
    // Only the stream that registered may unregister: a later turn's sink
    // must survive the earlier turn's cleanup.
    if (asideSinks.get(sessionID) === sink) asideSinks.delete(sessionID)
  }
}

export function emitAsideInline(sessionID: string, text: string): boolean {
  const sink = asideSinks.get(sessionID)
  if (!sink) return false
  try {
    return sink(text)
  } catch (error) {
    log.debug("btw: could not write the aside into the running turn", { sessionID, error: errorText(error) })
    return false
  }
}

/** Test seam. */
export function clearAsideSinks(): void {
  asideSinks.clear()
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
  options: { pollMs?: number; timeoutMs?: number; stop?: () => boolean } = {},
): Promise<boolean> {
  const pollMs = options.pollMs ?? IDLE_POLL_MS
  const timeoutMs = options.timeoutMs ?? IDLE_WAIT_MAX_MS
  const started = Date.now()
  for (;;) {
    if (options.stop?.()) return true
    if ((await sessionStatus(client, sessionID)) !== "busy") return true
    if (Date.now() - started >= timeoutMs) return false
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/**
 * Puts the answer in the conversation while the turn that prompted it is
 * still running, by writing it as its own text block into that turn's live
 * stream. It lands in the assistant reply the operator is already watching:
 * full markdown, scrollable, kept by opencode, and readable long after a
 * toast would have gone.
 *
 * Retries while the conversation stays busy, because a turn is a run of
 * streams rather than one and the gap between two of them is short. Gives up
 * once the turn ends, leaving the message to carry the answer instead.
 */
export async function deliverAsideInline(
  client: BtwSdkClient | null,
  sessionID: string,
  text: string,
  options: BtwWaitOptions = {},
): Promise<boolean> {
  const pollMs = options.inlinePollMs ?? INLINE_POLL_MS
  const timeoutMs = options.inlineWaitMs ?? INLINE_WAIT_MAX_MS
  const started = Date.now()
  for (;;) {
    if (emitAsideInline(sessionID, text)) return true
    if (Date.now() - started >= timeoutMs) return false
    if ((await sessionStatus(client, sessionID)) !== "busy") return false
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/**
 * The `claude` process serving this conversation, waiting for it when a turn
 * is already running but has not yet reached the point where doStream tags it
 * (`claude-code-language-model.ts`, where the line listener attaches). That
 * gap is the whole spawn path on a conversation's first turn, and a `/btw`
 * typed inside it used to fall straight through, which is exactly what leaves
 * a "Queued" bubble in the transcript: measured live on 2026-09-06, a `/btw`
 * logged "no live claude process for session" and the same question 22 s
 * later found one and was answered concurrently.
 */
export async function waitForAsideProcess(
  client: BtwSdkClient | null,
  sessionID: string,
  options: BtwWaitOptions = {},
): Promise<ActiveProcess | undefined> {
  const pollMs = options.pollMs ?? IDLE_POLL_MS
  const settleMs = options.settleMs ?? BUSY_SETTLE_MS
  const spawnWaitMs = options.spawnWaitMs ?? SPAWN_WAIT_MAX_MS
  const started = Date.now()
  for (;;) {
    const active = findActiveProcessBySessionId(sessionID)
    if (active) return active
    const busy = (await sessionStatus(client, sessionID)) === "busy"
    const waitedMs = Date.now() - started
    if (!busy && waitedMs >= settleMs) {
      // Nothing is running, so no process is on its way either.
      log.info("btw: no live claude process for session, leaving it to the turn", { sessionID, waitedMs })
      return undefined
    }
    if (busy && waitedMs >= spawnWaitMs) {
      // A turn is running but it never produced a process of ours: it belongs
      // to another provider, or the spawn failed. Do not hold the message for
      // the rest of it.
      log.warn("btw: a turn is running but no claude process appeared for it", { sessionID, waitedMs })
      return undefined
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/**
 * Whether a turn is running, tolerant of the same registration lag: a status
 * read taken the instant `/btw` is typed can still say idle while opencode is
 * starting the turn, and skipping the hold on that reading is what queues the
 * message behind the turn instead of releasing it afterwards.
 */
export async function settleSessionBusy(
  client: BtwSdkClient | null,
  sessionID: string,
  active: Pick<ActiveProcess, "lineEmitter">,
  options: BtwWaitOptions = {},
): Promise<boolean> {
  const pollMs = options.pollMs ?? IDLE_POLL_MS
  const settleMs = options.settleMs ?? BUSY_SETTLE_MS
  const started = Date.now()
  for (;;) {
    const status = await sessionStatus(client, sessionID)
    if (status === "busy") return true
    // No status route to poll: the process's own stream is all there is.
    if (status === "unknown") return isProcessBusy(active)
    if (Date.now() - started >= settleMs) return false
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
 *
 * Both waits before that hold exist because a `/btw` typed early in a turn
 * used to be seen as belonging to an idle conversation with no process, and
 * was let through to be queued: `waitForAsideProcess` covers the spawn gap,
 * `settleSessionBusy` covers opencode registering the turn.
 */
export async function handleBtwCommand(
  client: BtwSdkClient | null,
  input: BtwCommandInput,
  options: BtwWaitOptions = {},
): Promise<void> {
  const question = input.arguments.trim()
  if (!question) {
    showToast(client, { title: "btw", message: SIDE_QUESTION_USAGE, variant: "warning", duration: 6_000 })
    throw new BtwHandledError("/btw needs a question.")
  }
  const active = await waitForAsideProcess(client, input.sessionID, options)
  const transport = active?.asideTransport
  if (!active || !transport) {
    // The message still goes through: the aside branch answers it with an
    // explanation that stays readable in the conversation.
    if (active) log.info("btw: process has no aside transport, leaving it to the turn", { sessionID: input.sessionID })
    return
  }
  let busy = false
  let inlineDone = false
  let markInlineDelivered = (): void => {}
  const inlineDelivered = new Promise<"inline">((resolve) => {
    markInlineDelivered = () => {
      inlineDone = true
      resolve("inline")
    }
  })
  if (isSideQuestionPending(active)) {
    // One aside per process at a time. Leave the earlier answer in place for
    // its own message; this one asks when its turn comes.
    busy = await settleSessionBusy(client, input.sessionID, active, options)
    log.info("btw: an aside is already in flight, leaving this one to the turn", { sessionID: input.sessionID, busy })
  } else {
    // Settled alongside the request rather than before it: an aside asked
    // while the conversation is idle must not wait out the settle window
    // before it is even sent.
    const settling = settleSessionBusy(client, input.sessionID, active, options)
    const history = await fetchAsideHistory(client, input.sessionID, question)
    const answer = requestSideQuestion(active, question, {
      cliVersion: await detectCliVersion(transport.cliPath),
      interactive: transport.interactive,
      ...(history.length ? { history } : {}),
    })
    // Handled from this tick on. The settle below can span several timer
    // ticks, and an aside that fails immediately (a dead process, an
    // interactive transport) would otherwise raise an unhandled rejection in
    // the host before the real handlers further down are attached.
    answer.catch(() => undefined)
    rememberSideQuestionAnswer(input.sessionID, question, answer)
    busy = await settling
    log.info("btw: aside sent ahead of its message", {
      sessionID: input.sessionID,
      busy,
      questionLength: question.length,
      history: history.length,
    })
    // Written before the answer exists, so a `/btw` typed mid-turn shows up in
    // the turn straight away rather than looking swallowed until the answer
    // arrives. Only while a turn is running: an idle conversation gets the
    // whole pair as its own message a moment later anyway.
    const asked = busy
      ? deliverAsideInline(client, input.sessionID, formatInlineAsideAsk(question), options).catch(() => false)
      : Promise.resolve(false)
    answer.then(
      async (result) => {
        log.info("btw: early answer arrived", { sessionID: input.sessionID, busy, responseLength: result.response.length })
        if (!busy || result.synthetic) return
        // Awaited, not raced: a receipt that landed after the answer it
        // announces would read backwards. In the common case it was written
        // long before this and the await is already settled.
        await asked
        const inline = await deliverAsideInline(
          client,
          input.sessionID,
          formatInlineAside(question, result.response),
          options,
        )
        if (inline) {
          // The answer is in the conversation already, so the `/btw` message
          // has nothing left to carry. The remembered answer is deliberately
          // left in place: if the drop below does not take, the message
          // replays this answer instead of paying for a second one.
          log.info("btw: answer written into the running turn", { sessionID: input.sessionID })
          markInlineDelivered()
          return
        }
        // Nothing was open to write to. The held `/btw` message carries this
        // same answer into the conversation once the turn ends, which is the
        // durable copy, so there is nothing to announce here.
        log.info("btw: no open stream for the answer; the held message will carry it", {
          sessionID: input.sessionID,
        })
      },
      (error: unknown) => {
        // The message asks again once its turn runs.
        log.warn("btw: early aside failed; the message will ask again", {
          sessionID: input.sessionID,
          error: errorText(error),
        })
      },
    )
  }
  if (!busy) return
  const started = Date.now()
  const outcome = await Promise.race([
    inlineDelivered,
    waitForSessionIdle(client, input.sessionID, { ...options, stop: () => inlineDone }).then((idle) =>
      idle ? ("idle" as const) : ("timeout" as const),
    ),
  ])
  if (outcome === "inline") {
    log.info("btw: answered inside the running turn, dropping the /btw message", {
      sessionID: input.sessionID,
      waitedMs: Date.now() - started,
    })
    throw new BtwHandledError(BTW_INLINE_HANDLED_MESSAGE)
  }
  log.info("btw: turn over, releasing the /btw message", {
    sessionID: input.sessionID,
    idle: outcome === "idle",
    waitedMs: Date.now() - started,
  })
  if (outcome === "timeout") {
    showToast(client, { title: "btw", message: BTW_TURN_TOO_LONG_MESSAGE, variant: "warning", duration: 8_000 })
    throw new BtwHandledError(BTW_TURN_TOO_LONG_MESSAGE)
  }
}
