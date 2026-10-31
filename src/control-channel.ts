import { randomUUID } from "node:crypto"
import type { ChildProcess } from "node:child_process"
import type { ActiveProcess } from "./session-manager.js"

/**
 * Control requests the plugin sends a live headless child and waits on, matched
 * to their `control_response` by request id. The live model and effort switch
 * (h #g278) is the only caller: `set_model` and `apply_flag_settings`.
 *
 * Imports only types from the session manager, which calls
 * `dispatchControlResponse` from its line reader, so there is no cycle.
 */

type ControlProcess = Pick<ActiveProcess, "proc" | "lineEmitter">

export type ControlOutcome =
  | { ok: true; response: unknown }
  | {
      ok: false
      /** A kebab token, never a sentence, so a bundle keeps it (h #g215). */
      reason: "refused" | "timeout" | "child-exited" | "stdin-closed" | "aborted"
      error?: string
    }

const pending = new WeakMap<ChildProcess, Set<string>>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Called before the normal stdout routing. Consumes only a `control_response`
 * whose request id this module is waiting on, so a response nobody asked for
 * (and every other line) keeps its existing route.
 */
export function dispatchControlResponse(activeProcess: ControlProcess, line: string): boolean {
  const ids = pending.get(activeProcess.proc)
  if (!ids || ids.size === 0 || !line.includes('"control_response"')) return false
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    return false
  }
  if (!isRecord(message) || message.type !== "control_response") return false
  const response = message.response
  if (!isRecord(response) || typeof response.request_id !== "string") return false
  if (!ids.has(response.request_id)) return false
  return activeProcess.lineEmitter.emit(`control-response:${response.request_id}`, response)
}

/**
 * Write one control request and wait for its answer. Never throws: every way
 * it can fail is an outcome the caller falls back on.
 */
export function sendControlRequest(
  activeProcess: ControlProcess,
  request: Record<string, unknown>,
  options: { timeoutMs: number; abortSignal?: AbortSignal },
): Promise<ControlOutcome> {
  const { proc, lineEmitter } = activeProcess
  const stdin = proc.stdin
  if (
    proc.killed ||
    proc.exitCode != null ||
    proc.signalCode != null ||
    !stdin ||
    stdin.destroyed ||
    stdin.writableEnded ||
    !stdin.writable
  ) {
    return Promise.resolve({ ok: false, reason: "stdin-closed" })
  }
  if (options.abortSignal?.aborted) return Promise.resolve({ ok: false, reason: "aborted" })

  const requestId = randomUUID()
  let ids = pending.get(proc)
  if (!ids) {
    ids = new Set()
    pending.set(proc, ids)
  }
  ids.add(requestId)

  return new Promise<ControlOutcome>((resolve) => {
    const event = `control-response:${requestId}`
    let settled = false
    const finish = (outcome: ControlOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      lineEmitter.off(event, onResponse)
      lineEmitter.off("close", onClose)
      proc.off("exit", onClose)
      stdin.off("error", onError)
      options.abortSignal?.removeEventListener("abort", onAbort)
      ids!.delete(requestId)
      resolve(outcome)
    }
    const onResponse = (response: Record<string, unknown>): void => {
      if (response.subtype === "success") {
        finish({ ok: true, response: response.response })
        return
      }
      finish({
        ok: false,
        reason: "refused",
        ...(typeof response.error === "string" ? { error: response.error.slice(0, 200) } : {}),
      })
    }
    const onClose = (): void => finish({ ok: false, reason: "child-exited" })
    const onError = (): void => finish({ ok: false, reason: "stdin-closed" })
    const onAbort = (): void => finish({ ok: false, reason: "aborted" })
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), options.timeoutMs)
    timer.unref?.()

    lineEmitter.on(event, onResponse)
    lineEmitter.on("close", onClose)
    proc.on("exit", onClose)
    stdin.on("error", onError)
    options.abortSignal?.addEventListener("abort", onAbort, { once: true })
    try {
      stdin.write(JSON.stringify({ type: "control_request", request_id: requestId, request }) + "\n")
    } catch {
      finish({ ok: false, reason: "stdin-closed" })
    }
  })
}
