import { EventEmitter } from "node:events"
import {
  buildProxyTimeoutError,
  PROXY_NO_DEADLINE_MS,
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
  /** `PROXY_NO_DEADLINE_MS` (0) when the call has no deadline. */
  deadlineMs: number
  /** Absent when the call has no deadline. */
  timer: ReturnType<typeof setTimeout> | null
  /** Stall heartbeat; only armed for calls that have no deadline. */
  stallTimer: ReturnType<typeof setInterval> | null
  resolve(result: ProxyToolResult): void
  reject(error: Error): void
}

/**
 * How long a call with NO deadline may wait before the broker starts saying
 * so, and how often it repeats afterwards.
 *
 * `task` and `task_batch` have had no deadline since v0.20.0, which is right:
 * every way a call can end is an event the plugin observes, so a wall clock
 * could only ever kill a subagent that was still working. The cost is that a
 * genuinely wedged subagent is now silent forever, with nothing to notice it
 * but the operator. This is the missing half: it never ends a call, it only
 * reports one. Deliberately long, because a real subagent routinely runs
 * minutes and a warning on healthy work is noise. Deadline-bearing calls are
 * not armed at all: their deadline already reports them.
 */
export const PROXY_STALL_WARNING_MS = 5 * 60_000

/** Both timers a pending call can hold. Every removal site must use this. */
function clearPendingTimers(pending: InternalPending): void {
  if (pending.timer) clearTimeout(pending.timer)
  if (pending.stallTimer) clearInterval(pending.stallTimer)
}

/** One pending call, flattened for `/claude-code-doctor`. */
export interface PendingProxyCallSnapshot {
  sessionKey: string
  toolCallId: string
  toolName: string
  ageMs: number
  deadlineMs: number
  emitted: boolean
  channelClosed: boolean
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
  /** Test seam, same shape as `createProxyMcpServer`'s `keepaliveMs`. */
  stallWarningMs: number = PROXY_STALL_WARNING_MS,
): PendingProxyCall {
  // Defensive: if this exact callId is somehow already pending (UUID
  // collision or retry storm), replace it cleanly so we never leak two
  // entries for the same id.
  const previous = pendingByCallId.get(call.id)
  if (previous) {
    clearPendingTimers(previous)
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

  // Same rule as the proxy-mcp handler: a call with no deadline gets no timer
  // (a zero-delay timer would fire on the next tick). It stays pending until
  // a result, an abort, the next turn's orphan sweep, or its process going.
  const timer =
    deadlineMs > PROXY_NO_DEADLINE_MS
      ? setTimeout(() => {
          const current = pendingByCallId.get(call.id)
          if (!current) return
          pendingByCallId.delete(call.id)
          indexRemove(current.sessionKey, call.id)
          clearPendingTimers(current)
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
      : null

  // A call with no deadline has nothing that will ever report it, so it gets
  // a heartbeat instead. WARN on purpose: only warn and error are always on
  // stderr (see `src/logger.ts`), and a NOTICE nobody sees outside debug mode
  // would defeat the point of the line existing at all.
  const stallTimer =
    deadlineMs === PROXY_NO_DEADLINE_MS && stallWarningMs > 0
      ? setInterval(() => {
          const current = pendingByCallId.get(call.id)
          if (!current) return
          log.warn("proxy call still waiting, no deadline", {
            sessionKey: current.sessionKey,
            toolCallId: current.toolCallId,
            toolName: current.toolName,
            waitedMs: Date.now() - current.createdAt,
            emitted: current.emitted === true,
            channelClosed: current.channel?.closed === true,
            note: "nothing will time this out; it ends when opencode returns a result, you abort, you send another message, or the claude process goes",
          })
        }, stallWarningMs)
      : null
  // Never hold opencode's process open for a heartbeat.
  stallTimer?.unref?.()

  const pending: InternalPending = {
    sessionKey,
    toolCallId: call.id,
    toolName: call.toolName,
    input: call.input,
    channel: call.channel,
    createdAt: Date.now(),
    deadlineMs,
    timer,
    stallTimer,
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

/**
 * Every call the broker is currently holding, across all sessions, with how
 * long it has waited and when it gives up. Read-only view for the doctor
 * report; deliberately carries no `input`, since a pending call's arguments
 * can be a whole file's contents.
 */
export function snapshotPendingProxyCalls(now = Date.now()): PendingProxyCallSnapshot[] {
  const out: PendingProxyCallSnapshot[] = []
  for (const pending of pendingByCallId.values()) {
    out.push({
      sessionKey: pending.sessionKey,
      toolCallId: pending.toolCallId,
      toolName: pending.toolName,
      ageMs: Math.max(0, now - pending.createdAt),
      deadlineMs: pending.deadlineMs,
      emitted: pending.emitted === true,
      channelClosed: pending.channel?.closed === true,
    })
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
  clearPendingTimers(pending)
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
  clearPendingTimers(pending)
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
