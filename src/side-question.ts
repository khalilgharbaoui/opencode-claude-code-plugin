import { randomUUID } from "node:crypto"
import type { ChildProcess } from "node:child_process"
import { cliSupportsSideQuestion, type CliVersion } from "./cli-version.js"
import type { ActiveProcess } from "./session-manager.js"

type SideQuestionProcess = Pick<ActiveProcess, "proc" | "lineEmitter">

export interface SideQuestionResult {
  response: string
  synthetic: boolean
}

export interface SideQuestionOptions {
  cliVersion: CliVersion | null
  interactive?: boolean
  abortSignal?: AbortSignal
  timeoutMs?: number
  history?: readonly { question: string; response: string }[]
}

export interface SideQuestionExchange {
  question: string
  response: string
}

const MAX_HISTORY_EXCHANGES = 20

export const SIDE_QUESTION_USAGE =
  "Usage: /btw <question>. Ask a side question about the current conversation without adding it to the main context."

const pendingProcesses = new WeakSet<ChildProcess>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * opencode appends its own `<system-reminder>` blocks to the user message, as
 * extra text parts on the same message. They instruct a normal turn and are not
 * part of what the operator typed after `/btw`, so they must not travel with the
 * aside: a plan-mode reminder alone is over 1.5 KB, and measured live it both
 * steered the answer and kept a bare `/btw` from ever looking empty.
 *
 * Blocks are removed wherever they sit rather than by matching a whole part,
 * because a harness may append its own trailing metadata after one (opencode-dcp
 * adds a `<dcp-message-id>` marker), which an end-anchored check would miss.
 */
const SYSTEM_REMINDER_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/g

export function parseSideQuestionContent(content: unknown): { question: string } | null {
  let text: string
  if (typeof content === "string") {
    text = content
  } else if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return null
      parts.push(part.text)
    }
    text = parts.join("\n")
  } else {
    return null
  }
  const match = /^\/btw(?:\s+([\s\S]*))?$/.exec(text.replace(SYSTEM_REMINDER_BLOCK, "").trim())
  return match ? { question: (match[1] ?? "").trim() } : null
}

/** Do not replay a historical /btw during an assistant/tool continuation. */
export function parseSideQuestion(
  prompt: readonly { role: string; content: unknown }[],
): { question: string } | null {
  const latest = prompt.at(-1)
  return latest?.role === "user" ? parseSideQuestionContent(latest.content) : null
}

function assistantText(content: unknown): string {
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const part of content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") parts.push(part.text)
  }
  return parts.join("\n").trim()
}

/**
 * Earlier `/btw` exchanges in this conversation, oldest first, for the
 * control request's `history` so follow-ups can refer to previous asides.
 * The final user message is the current question and is left out.
 */
export function collectSideQuestionHistory(
  prompt: readonly { role: string; content: unknown }[],
): SideQuestionExchange[] {
  const history: SideQuestionExchange[] = []
  for (let index = 0; index < prompt.length - 1; index++) {
    const message = prompt[index]
    if (message.role !== "user") continue
    const aside = parseSideQuestionContent(message.content)
    if (!aside?.question) continue
    const reply = prompt[index + 1]
    if (reply.role !== "assistant") continue
    const response = assistantText(reply.content)
    if (!response || response === SIDE_QUESTION_USAGE) continue
    history.push({ question: aside.question, response })
  }
  return history.slice(-MAX_HISTORY_EXCHANGES)
}

export function isSideQuestionPending(activeProcess: SideQuestionProcess): boolean {
  return pendingProcesses.has(activeProcess.proc)
}

/**
 * Call before the normal stdout line/buffer dispatch. Only a response with an
 * active request-ID listener is consumed. Progress and unrelated lines retain
 * their existing routing; the helper never subscribes to the shared `line` event.
 */
export function dispatchSideQuestionResponse(
  activeProcess: SideQuestionProcess,
  line: string,
): boolean {
  if (!pendingProcesses.has(activeProcess.proc)) return false
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    return false
  }
  if (!isRecord(message) || message.type !== "control_response") return false
  const response = message.response
  if (!isRecord(response) || typeof response.request_id !== "string") return false
  return activeProcess.lineEmitter.emit(`side-question:${response.request_id}`, response)
}

/**
 * Uses an existing headless process, never a user envelope or a new spawn.
 * The process may be mid-turn: Claude Code answers `side_question` on a
 * separate advisor call while the main loop keeps running (measured live on
 * 2.1.258 with the turn blocked on a held MCP tool). Only one aside per
 * process is in flight at a time; responses are matched by request id ahead
 * of the normal stdout routing, so a streaming turn never sees them.
 */
export async function requestSideQuestion(
  activeProcess: SideQuestionProcess,
  question: string,
  options: SideQuestionOptions,
): Promise<SideQuestionResult> {
  question = question.trim()
  if (!question) return { response: SIDE_QUESTION_USAGE, synthetic: true }
  options.abortSignal?.throwIfAborted()
  const { proc, lineEmitter } = activeProcess
  if (options.interactive || !proc.stdout) {
    throw new Error("/btw requires the headless Claude Code transport; interactive sessions are not supported.")
  }
  if (!cliSupportsSideQuestion(options.cliVersion)) {
    throw new Error("/btw requires Claude Code CLI 2.1.258 or newer (the oldest verified version).")
  }
  if (pendingProcesses.has(proc)) {
    throw new Error("Wait for the current /btw to finish before asking another.")
  }
  const stdin = proc.stdin
  if (proc.killed || proc.exitCode != null || proc.signalCode != null ||
      !stdin || stdin.destroyed || stdin.writableEnded || !stdin.writable) {
    throw new Error("/btw requires a live Claude Code session with writable stdin.")
  }
  const timeoutMs = options.timeoutMs ?? 120_000
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("/btw timeoutMs must be a positive 32-bit integer.")
  }
  const requestId = randomUUID()
  const request = JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "side_question",
      question,
      ...(options.history === undefined ? {} : { history: options.history }),
    },
  })

  pendingProcesses.add(proc)
  return new Promise<SideQuestionResult>((resolve, reject) => {
    const event = `side-question:${requestId}`
    let settled = false
    let sent = false
    let cancelPending = false

    const cleanup = (): void => {
      clearTimeout(timer)
      lineEmitter.off(event, onResponse)
      lineEmitter.off("close", onClose)
      lineEmitter.off("error", onError)
      proc.off("exit", onClose)
      proc.off("close", onClose)
      proc.off("error", onError)
      if (!cancelPending) stdin.off("error", onError)
      options.abortSignal?.removeEventListener("abort", onAbort)
      pendingProcesses.delete(proc)
    }
    const fail = (error: unknown, cancel = false): void => {
      if (settled) return
      settled = true
      if (cancel && sent && !stdin.destroyed && !stdin.writableEnded && stdin.writable) {
        try {
          cancelPending = true
          stdin.write(
            JSON.stringify({ type: "control_cancel_request", request_id: requestId }) + "\n",
            () => {
              // A failed write emits `error` after its callback. Keep the pipe
              // listener through that event without delaying abort/timeout.
              queueMicrotask(() => stdin.off("error", onError))
            },
          )
        } catch {
          cancelPending = false
          // Preserve the original abort/timeout even if the child has gone away.
        }
      }
      cleanup()
      reject(error)
    }
    const onClose = (): void => fail(new Error("Claude Code closed before answering /btw."))
    const onError = (error: Error): void => fail(error)
    const onAbort = (): void => fail(
      options.abortSignal?.reason ?? new DOMException("/btw was aborted.", "AbortError"),
      true,
    )
    const onResponse = (response: Record<string, unknown>): void => {
      if (settled || response.request_id !== requestId) return
      if (response.subtype === "error") {
        fail(new Error(typeof response.error === "string" ? response.error : "Claude Code rejected /btw."))
        return
      }
      const result = response.response
      if (response.subtype !== "success" || !isRecord(result) ||
          typeof result.response !== "string" || typeof result.synthetic !== "boolean") {
        fail(new Error("Claude Code returned an invalid /btw response."))
        return
      }
      settled = true
      cleanup()
      resolve({ response: result.response, synthetic: result.synthetic })
    }
    const timer = setTimeout(() => {
      fail(new Error(`/btw timed out after ${timeoutMs}ms.`), true)
    }, timeoutMs)

    lineEmitter.on(event, onResponse)
    lineEmitter.on("close", onClose)
    lineEmitter.on("error", onError)
    proc.on("exit", onClose)
    proc.on("close", onClose)
    proc.on("error", onError)
    stdin.on("error", onError)
    options.abortSignal?.addEventListener("abort", onAbort, { once: true })
    if (options.abortSignal?.aborted) {
      onAbort()
      return
    }
    try {
      sent = true
      stdin.write(request + "\n")
    } catch (error) {
      fail(error)
    }
  })
}
