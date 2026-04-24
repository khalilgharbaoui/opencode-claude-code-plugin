import { EventEmitter } from "node:events"
import type { ProxyToolCall, ProxyToolResult } from "./proxy-mcp.js"
import { log } from "./logger.js"

export interface PendingProxyCall {
  sessionKey: string
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

type InternalPending = PendingProxyCall & {
  resolve(result: ProxyToolResult): void
  reject(error: Error): void
}

const pendingBySession = new Map<string, InternalPending>()
const emitter = new EventEmitter()

function eventName(sessionKey: string) {
  return `pending:${sessionKey}`
}

export function onPendingProxyCall(
  sessionKey: string,
  handler: (call: PendingProxyCall) => void,
): () => void {
  const name = eventName(sessionKey)
  emitter.on(name, handler)
  return () => emitter.off(name, handler)
}

export function queuePendingProxyCall(
  sessionKey: string,
  call: ProxyToolCall,
): PendingProxyCall {
  const existing = pendingBySession.get(sessionKey)
  if (existing) {
    existing.reject(
      new Error(`Another proxy tool call is already pending for ${sessionKey}`),
    )
    pendingBySession.delete(sessionKey)
  }

  const pending: InternalPending = {
    sessionKey,
    toolCallId: call.id,
    toolName: call.toolName,
    input: call.input,
    resolve: call.resolve,
    reject: call.reject,
  }
  pendingBySession.set(sessionKey, pending)
  emitter.emit(eventName(sessionKey), pending)
  log.info("queued pending proxy call", {
    sessionKey,
    toolCallId: call.id,
    toolName: call.toolName,
  })
  return pending
}

export function getPendingProxyCall(
  sessionKey: string,
): PendingProxyCall | undefined {
  return pendingBySession.get(sessionKey)
}

export function resolvePendingProxyCall(
  sessionKey: string,
  result: ProxyToolResult,
): boolean {
  const pending = pendingBySession.get(sessionKey)
  if (!pending) return false
  pendingBySession.delete(sessionKey)
  pending.resolve(result)
  log.info("resolved pending proxy call", {
    sessionKey,
    toolCallId: pending.toolCallId,
    toolName: pending.toolName,
  })
  return true
}

export function rejectPendingProxyCall(
  sessionKey: string,
  error: Error,
): boolean {
  const pending = pendingBySession.get(sessionKey)
  if (!pending) return false
  pendingBySession.delete(sessionKey)
  pending.reject(error)
  log.warn("rejected pending proxy call", {
    sessionKey,
    toolCallId: pending.toolCallId,
    toolName: pending.toolName,
    error: error.message,
  })
  return true
}
