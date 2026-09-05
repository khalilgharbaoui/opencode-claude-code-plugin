import { EventEmitter } from "node:events"
import {
  buildProxyTimeoutError,
  resolveProxyCallTimeoutMs,
  type ProxyCallChannel,
  type ProxyToolCall,
  type ProxyToolResult,
} from "./proxy-mcp.js"
import { log } from "./logger.js"

export interface PendingProxyCall {
  sessionKey: string
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  /**
   * Liveness of Claude's HTTP request for this call. Once `closed`, a
   * result written to it is lost; the language model then delivers the
   * result as a user message instead. Absent means open.
   */
  channel?: ProxyCallChannel
  /**
   * True once the language model has handed this call to opencode as a
   * tool-call part. A call that is still pending without it was queued
   * while no turn was attached and has to be drained by the next one.
   */
  emitted?: boolean
}

type InternalPending = PendingProxyCall & {
  createdAt: number
  timer: ReturnType<typeof setTimeout>
  resolve(result: ProxyToolResult): void
  reject(error: Error): void
}

// Primary index: callId -> pending. Tool call IDs are UUIDs produced by
// proxy-mcp, so they are globally unique across sessions.
const pendingByCallId = new Map<string, InternalPending>()
// Reverse index: sessionKey -> set of callIds, so the language model can
// drain or reject every pending call for one Claude subprocess at once.
const callIdsBySession = new Map<string, Set<string>>()

const emitter = new EventEmitter()

function eventName(sessionKey: string) {
  return `pending:${sessionKey}`
}

function indexAdd(sessionKey: string, callId: string) {
  let s = callIdsBySession.get(sessionKey)
  if (!s) {
    s = new Set()
    callIdsBySession.set(sessionKey, s)
  }
  s.add(callId)
}

function indexRemove(sessionKey: string, callId: string) {
  const s = callIdsBySession.get(sessionKey)
  if (!s) return
  s.delete(callId)
  if (s.size === 0) callIdsBySession.delete(sessionKey)
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
  timeoutOverrides?: Record<string, number>,
): PendingProxyCall {
  // Defensive: if this exact callId is somehow already pending (UUID
  // collision or retry storm), replace it cleanly so we never leak two
  // entries for the same id.
  const previous = pendingByCallId.get(call.id)
  if (previous) {
    clearTimeout(previous.timer)
    previous.reject(
      new Error(`Replaced pending proxy call ${call.id} with a fresh one`),
    )
    pendingByCallId.delete(call.id)
    indexRemove(previous.sessionKey, call.id)
  }

  const deadlineMs = resolveProxyCallTimeoutMs(
    call.toolName,
    call.input,
    timeoutOverrides,
  )

  const timer = setTimeout(() => {
    const current = pendingByCallId.get(call.id)
    if (!current) return
    pendingByCallId.delete(call.id)
    indexRemove(current.sessionKey, call.id)
    current.reject(buildProxyTimeoutError(call.toolName, deadlineMs))
    // v0.4.13: demoted from warn to notice. AFK-permission-pending
    // sessions can stack many of these; demoting keeps the UI quiet on
    // return while preserving the audit trail in plugin.log.
    log.notice("timed out pending proxy call", {
      sessionKey: current.sessionKey,
      toolCallId: call.id,
      toolName: call.toolName,
      deadlineMs,
    })
  }, deadlineMs)

  const pending: InternalPending = {
    sessionKey,
    toolCallId: call.id,
    toolName: call.toolName,
    input: call.input,
    channel: call.channel,
    createdAt: Date.now(),
    timer,
    resolve: call.resolve,
    reject: call.reject,
  }
  pendingByCallId.set(call.id, pending)
  indexAdd(sessionKey, call.id)
  emitter.emit(eventName(sessionKey), pending)
  log.info("queued pending proxy call", {
    sessionKey,
    toolCallId: call.id,
    toolName: call.toolName,
  })
  return pending
}

/** Record that opencode has been given this call as a tool-call part. */
export function markPendingProxyCallEmitted(toolCallId: string): void {
  const pending = pendingByCallId.get(toolCallId)
  if (pending) pending.emitted = true
}

/** True when Claude's request for this call is gone (see `channel`). */
export function isPendingProxyCallChannelClosed(
  call: PendingProxyCall,
): boolean {
  return call.channel?.closed === true
}

export function getPendingProxyCalls(sessionKey: string): PendingProxyCall[] {
  const s = callIdsBySession.get(sessionKey)
  if (!s || s.size === 0) return []
  const out: PendingProxyCall[] = []
  for (const id of s) {
    const p = pendingByCallId.get(id)
    if (p) out.push(p)
  }
  return out
}

export function resolvePendingProxyCallById(
  toolCallId: string,
  result: ProxyToolResult,
): boolean {
  const pending = pendingByCallId.get(toolCallId)
  if (!pending) return false
  pendingByCallId.delete(toolCallId)
  indexRemove(pending.sessionKey, toolCallId)
  clearTimeout(pending.timer)
  pending.resolve(result)
  log.info("resolved pending proxy call", {
    sessionKey: pending.sessionKey,
    toolCallId: pending.toolCallId,
    toolName: pending.toolName,
  })
  return true
}

export function rejectPendingProxyCallById(
  toolCallId: string,
  error: Error,
): boolean {
  const pending = pendingByCallId.get(toolCallId)
  if (!pending) return false
  pendingByCallId.delete(toolCallId)
  indexRemove(pending.sessionKey, toolCallId)
  clearTimeout(pending.timer)
  pending.reject(error)
  // Rejection is the broker's cleanup mechanism — fires on timeouts, orphans,
  // stream closes, etc. None are user-actionable. File-log them at NOTICE so
  // the audit trail is intact; rely on caller sites to decide TUI visibility.
  log.notice("rejected pending proxy call", {
    sessionKey: pending.sessionKey,
    toolCallId: pending.toolCallId,
    toolName: pending.toolName,
    error: error.message,
  })
  return true
}

export function rejectAllPendingProxyCallsForSession(
  sessionKey: string,
  error: Error,
): number {
  const s = callIdsBySession.get(sessionKey)
  if (!s) return 0
  const ids = [...s]
  let count = 0
  for (const id of ids) {
    if (rejectPendingProxyCallById(id, error)) count++
  }
  return count
}
