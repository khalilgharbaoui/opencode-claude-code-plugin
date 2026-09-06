import { log } from "./logger.js"
import { getOpencodeClient } from "./runtime-status.js"
import { findActiveProcessBySessionId } from "./session-manager.js"
import { SIDE_QUESTION_USAGE } from "./side-question.js"

/**
 * `/btw` as a concurrent aside.
 *
 * opencode's TUI sends every slash command to the server the moment it is
 * typed, busy or not (`tui/component/prompt/index.tsx`), so the
 * `command.execute.before` hook fires immediately. Only the user message the
 * command would produce is held back ("Queued") until the running turn ends.
 * That hook is therefore the one place a side question can be answered while
 * the main lane is still working.
 *
 * The hook never lets `/btw` into the parent conversation. It creates (or
 * reuses) one child session per parent, sends the question there, and throws
 * so opencode drops the parent prompt. The child's own model turn is
 * intercepted by the aside branch in `claude-code-language-model.ts`, which
 * routes the question to the PARENT's live `claude` process as a
 * `side_question` control request. Claude Code answers those concurrently
 * with a running turn (measured on 2.1.258: answered 1.4 s into a 45 s tool
 * hold), from the parent's context, at zero opencode-visible cost, and the
 * question never enters the parent's transcript on either side.
 */

type SdkResult<T = unknown> = Promise<{ data?: T; error?: unknown }>

export interface BtwToast {
  title?: string
  message: string
  variant: "info" | "success" | "warning" | "error"
  duration?: number
}

export interface BtwSdkClient {
  session?: {
    create?: (options: { body: { parentID?: string; title?: string } }) => SdkResult<{ id?: string }>
    get?: (options: { path: { id: string } }) => SdkResult<{ id?: string; parentID?: string }>
    update?: (options: { path: { id: string }; body: { title?: string } }) => SdkResult
    promptAsync?: (options: {
      path: { id: string }
      body: {
        model?: { providerID: string; modelID: string }
        parts: { type: "text"; text: string }[]
      }
    }) => SdkResult
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

/** Thrown to make opencode drop the parent prompt after the aside was dispatched. */
export class BtwHandledError extends Error {
  override readonly name = "BtwHandledError"
  constructor(message = "/btw was answered in a child session; nothing to add to this conversation.") {
    super(message)
  }
}

export const BTW_NO_SESSION_MESSAGE =
  "/btw needs a live Claude Code session here. Send a normal message with a Claude Code model first."

const ANSWER_TOAST_MS = 12_000
const ANSWER_TOAST_CHARS = 280
const TITLE_CHARS = 60

const childByParent = new Map<string, string>()
const parentByChild = new Map<string, string>()

export function registerAsideSession(childID: string, parentID: string): void {
  const previous = childByParent.get(parentID)
  if (previous && previous !== childID) parentByChild.delete(previous)
  childByParent.set(parentID, childID)
  parentByChild.set(childID, parentID)
}

export function asideParentOf(childID: string): string | undefined {
  return parentByChild.get(childID)
}

export function forgetAsideSession(childID: string): void {
  const parentID = parentByChild.get(childID)
  parentByChild.delete(childID)
  if (parentID && childByParent.get(parentID) === childID) childByParent.delete(parentID)
}

/** Test seam. */
export function clearAsideSessions(): void {
  childByParent.clear()
  parentByChild.clear()
}

/**
 * The in-memory map is authoritative while opencode runs. After a restart a
 * follow-up typed in an old btw child still carries `parentID`, so fall back
 * to asking opencode.
 */
export async function resolveAsideParent(
  sessionID: string,
  client: BtwSdkClient | null = getOpencodeClient() as BtwSdkClient | null,
): Promise<string | undefined> {
  const known = asideParentOf(sessionID)
  if (known) return known
  if (!client?.session?.get) return undefined
  try {
    const result = await client.session.get({ path: { id: sessionID } })
    const parentID = result.data?.parentID
    if (typeof parentID !== "string" || !parentID) return undefined
    registerAsideSession(sessionID, parentID)
    return parentID
  } catch {
    return undefined
  }
}

/**
 * The TUI's subagent footer labels a child session from its title
 * (`/@(\w+) subagent/`), so this reads as "Btw" there instead of "Subagent".
 */
export function asideSessionTitle(question: string): string {
  const flat = question.replace(/\s+/g, " ").trim()
  const short = flat.length > TITLE_CHARS ? `${flat.slice(0, TITLE_CHARS - 3)}...` : flat
  return `@btw subagent · ${short}`
}

export function answerToastMessage(answer: string): string {
  const flat = answer.replace(/\s+/g, " ").trim()
  return flat.length > ANSWER_TOAST_CHARS ? `${flat.slice(0, ANSWER_TOAST_CHARS - 3)}...` : flat
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

/** Called from the child's aside branch once the parent's process has answered. */
export function showBtwAnswerToast(answer: string, client: BtwSdkClient | null = getOpencodeClient() as BtwSdkClient | null): void {
  showToast(client, {
    title: "btw",
    message: answerToastMessage(answer),
    variant: "success",
    duration: ANSWER_TOAST_MS,
  })
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") {
    return (error as { message: string }).message
  }
  return String(error)
}

async function ensureChildSession(
  client: BtwSdkClient,
  parentID: string,
  question: string,
): Promise<string> {
  const session = client.session
  if (!session?.create) throw new Error("opencode's SDK client has no session.create; cannot open a /btw session.")
  const existing = childByParent.get(parentID)
  if (existing && session.get) {
    const found = await session.get({ path: { id: existing } }).catch(() => ({ data: undefined, error: true }))
    if (found.data?.id === existing && !found.error) {
      if (session.update) {
        await session.update({ path: { id: existing }, body: { title: asideSessionTitle(question) } }).catch(() => undefined)
      }
      return existing
    }
    forgetAsideSession(existing)
  }
  const created = await session.create({ body: { parentID, title: asideSessionTitle(question) } })
  const childID = created.data?.id
  if (created.error || typeof childID !== "string" || !childID) {
    throw new Error(`opencode could not create the /btw session: ${errorText(created.error ?? "no session id returned")}`)
  }
  registerAsideSession(childID, parentID)
  return childID
}

/**
 * `command.execute.before` handler for `btw`. Always throws: either
 * `BtwHandledError` after dispatching the aside (or after telling the
 * operator why it could not), so the raw `/btw` text never becomes a queued
 * parent prompt that a later turn would have to reject.
 */
export async function handleBtwCommand(
  client: BtwSdkClient | null,
  input: BtwCommandInput,
): Promise<never> {
  const question = input.arguments.trim()
  if (!question) {
    showToast(client, { title: "btw", message: SIDE_QUESTION_USAGE, variant: "warning", duration: 6_000 })
    throw new BtwHandledError("/btw needs a question.")
  }
  const parent = findActiveProcessBySessionId(input.sessionID)
  if (!parent) {
    log.info("btw: no live claude process for session", { sessionID: input.sessionID })
    showToast(client, { title: "btw", message: BTW_NO_SESSION_MESSAGE, variant: "warning", duration: 8_000 })
    throw new BtwHandledError(BTW_NO_SESSION_MESSAGE)
  }
  const model = parent.opencodeModel
  if (!client?.session?.promptAsync || !model) {
    const message = "/btw could not reach opencode's session API to open a side session."
    log.warn("btw: cannot dispatch aside", { sessionID: input.sessionID, hasClient: !!client, hasModel: !!model })
    showToast(client, { title: "btw", message, variant: "error", duration: 8_000 })
    throw new BtwHandledError(message)
  }
  try {
    const childID = await ensureChildSession(client, input.sessionID, question)
    const sent = await client.session.promptAsync({
      path: { id: childID },
      body: { model, parts: [{ type: "text", text: `/btw ${question}` }] },
    })
    if (sent.error) throw new Error(errorText(sent.error))
    log.info("btw: aside dispatched to child session", {
      sessionID: input.sessionID,
      childID,
      questionLength: question.length,
      model: `${model.providerID}/${model.modelID}`,
    })
    showToast(client, {
      title: "btw",
      message: "Asking in the btw session. The answer will show here and in that session.",
      variant: "info",
      duration: 4_000,
    })
  } catch (error) {
    const message = `/btw failed: ${errorText(error)}`
    log.warn("btw: dispatch failed", { sessionID: input.sessionID, error: errorText(error) })
    showToast(client, { title: "btw", message, variant: "error", duration: 8_000 })
    throw new BtwHandledError(message)
  }
  throw new BtwHandledError()
}
