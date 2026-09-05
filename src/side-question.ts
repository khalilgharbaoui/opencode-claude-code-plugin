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
  busy?: boolean
  abortSignal?: AbortSignal
  timeoutMs?: number
  history?: readonly { question: string; response: string }[]
}

export const SIDE_QUESTION_USAGE =
  "Usage: /btw <question>. Ask a side question about the current conversation without adding it to the main context."

const pendingProcesses = new WeakSet<ChildProcess>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

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
  const match = /^\/btw(?:\s+([\s\S]*))?$/.exec(text.trim())
  return match ? { question: (match[1] ?? "").trim() } : null
}

/** Do not replay a historical /btw during an assistant/tool continuation. */
export function parseSideQuestion(
  prompt: readonly { role: string; content: unknown }[],
): { question: string } | null {
  const latest = prompt.at(-1)
  return latest?.role === "user" ? parseSideQuestionContent(latest.content) : null
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

/** Uses an existing idle headless process, never a user envelope or a new spawn. */
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
  if (options.busy || lineEmitter.listenerCount("line") > 0 || pendingProcesses.has(proc)) {
    throw new Error("/btw requires an idle Claude Code session. Wait for the current turn to finish.")
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
