import type { ClaudeStreamMessage } from "./types.js"
import type { TurnState } from "./turn-state.js"
import { log } from "./logger.js"
import { formatStreamTimeoutNote } from "./cli-events.js"
import {
  deleteActiveProcess,
  deleteClaudeSessionId,
  noteTurnStarted,
  respawnActiveProcess,
} from "./session-manager.js"
import { makeLateProxyResultMessage } from "./proxy-results.js"
import {
  isPendingProxyCallChannelClosed,
  markPendingProxyCallEmitted,
  type PendingProxyCall,
} from "./proxy-broker.js"
import {
  TASK_BATCH_TOOL_NAME,
  taskBatchChildToolCallId,
  taskBatchTasks,
} from "./proxy-mcp.js"
import {
  continuationSignature,
  makeAutoContinueMessage,
  shouldAutoContinueIncompleteTurn,
} from "./auto-continue.js"
import type { QuestionToolCall } from "./plan-mode-question.js"

/**
 * The turn's timers, its batched drain and its auto-continue window, moved out
 * of `doStreamForHost`'s `start()` closure with no change beyond taking the
 * `TurnState` they used to close over.
 *
 * Every one of these was reachable only by reading three thousand lines of one
 * function. They are here because they need nothing else: the state, and each
 * other. The line handler and `completeResult` stay where they are, because
 * they also read the turn's prologue (the failover gate, the model chain, the
 * config), which is not turn state.
 *
 * The four handler slots (`lineHandler`, `closeHandler`, `procErrorHandler`,
 * `cleanupTurn`) are read off the state rather than taken as arguments,
 * because the respawn path below has to detach and re-attach all three and
 * they are defined after these functions are.
 */

/**
 * Quiet window the batched drain and the result boundary share, so claude
 * CLI's parallel tool_use blocks (two bash calls in one assistant message)
 * end up in a single tool-calls finish event. Without it the broker would
 * reject every overlapping call and claude would see spurious tool errors.
 */
export const DRAIN_QUIET_MS = 100

// ---- The wire-inactivity watchdog ----------------------------------------

export function clearFallbackTimer(state: TurnState): void {
  if (state.resultFallbackTimer) {
    clearTimeout(state.resultFallbackTimer)
    state.resultFallbackTimer = null
  }
}

/**
 * Wire-inactivity watchdog. Resets on every line received from the CLI; only
 * fires if the CLI has emitted content and then gone silent on stdout for
 * `delayMs` without sending a `result`. The previous design armed this on
 * every text content_block_stop, which killed legitimate mid-turn think pauses
 * (most visibly with sonnet between text-end and the next tool_use_start).
 * Tunable for reproduces and for the regression test, the same seam
 * CLAUDE_CODE_START_WATCHDOG_MS gives the start watchdog below.
 */
export function startResultFallback(
  state: TurnState,
  delayMs = state.resultFallbackMs,
): void {
  clearFallbackTimer(state)
  if ((!state.hasReceivedContent && !state.hasReceivedProgress) || state.controllerClosed) return
  state.resultFallbackTimer = setTimeout(() => {
    if (state.controllerClosed) return
    log.warn("result fallback timer fired — closing stream without result event", {
      delayMs,
    })
    // Closing on a log line alone left the operator with a reply that
    // just stopped. An abort is exempt: they asked for it, and the
    // short grace period there is not a silent CLI.
    if (!state.autoContinueState.aborted) {
      state.controller.enqueue({
        type: "text-delta",
        id: state.startTextBlock(),
        delta: formatStreamTimeoutNote(delayMs),
      })
      state.endTextBlock()
    }
    state.closeHandler()
  }, delayMs)
}

// ---- The start watchdog ---------------------------------------------------

export function clearStartWatchdog(state: TurnState): void {
  if (state.startWatchdog) {
    clearTimeout(state.startWatchdog)
    state.startWatchdog = null
  }
}

/**
 * Start watchdog: complementary to the inactivity watchdog above. That one
 * only arms once content has arrived; this one covers the gap the other
 * explicitly skips, a reused process that produces NO stdout at all after a
 * fresh-turn envelope write. Seen after a very long proxy-blocked tool call
 * resumed successfully (the child stays silent on stdout). On first fire we
 * respawn the child with --session-id to resume the conversation
 * transparently; on a second fire (respawn also silent) we end the turn
 * cleanly so the next opencode turn spawns fresh. Tunable via env for
 * reproduces.
 */
function onStartWatchdogFire(state: TurnState): void {
  state.startWatchdog = null
  if (state.controllerClosed || state.hasReceivedContent || state.hasReceivedProgress) return
  if (state.respawnAttempted) {
    log.error(
      "claude process still silent after respawn; ending turn",
      { sessionKey: state.sessionKey },
    )
    deleteActiveProcess(state.sessionKey)
    deleteClaudeSessionId(state.sessionKey)
    state.controllerClosed = true
    state.cleanupTurn()
    state.controller.enqueue({
      type: "error",
      error: new Error(
        "Claude process produced no output after the envelope write (start watchdog timeout).",
      ),
    })
    try {
      state.controller.close()
    } catch {}
    return
  }
  state.respawnAttempted = true
  log.warn(
    "no stdout after envelope write; respawning claude process to resume conversation",
    { sessionKey: state.sessionKey, startWatchdogMs: state.startWatchdogMs },
  )
  state.lineEmitter.off("line", state.lineHandler)
  state.lineEmitter.off("close", state.closeHandler)
  state.proc.off("error", state.procErrorHandler)
  const newAp = respawnActiveProcess(
    state.sessionKey,
    state.cliPath,
    state.cliArgs,
    state.cwd,
    state.ignoreAnthropicApiKey,
  )
  if (!newAp) {
    log.error(
      "no active process to respawn (start watchdog); ending turn",
      { sessionKey: state.sessionKey },
    )
    state.controllerClosed = true
    state.cleanupTurn()
    state.controller.enqueue({
      type: "error",
      error: new Error(
        "No active claude process to respawn after start watchdog timeout.",
      ),
    })
    try {
      state.controller.close()
    } catch {}
    return
  }
  state.proc = newAp.proc
  state.lineEmitter = newAp.lineEmitter
  state.activeProcess = newAp
  state.lineEmitter.on("line", state.lineHandler)
  state.lineEmitter.on("close", state.closeHandler)
  state.proc.on("error", state.procErrorHandler)
  try {
    if (!deliverPendingCompletions(state, true)) {
      noteTurnStarted(newAp)
      state.proc.stdin?.write(state.watchdogMessage + "\n")
    }
    log.debug("re-sent user message after respawn", {
      textLength: state.watchdogMessage.length,
    })
  } catch (err) {
    log.error("failed to re-send envelope after respawn", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  armStartWatchdog(state)
}

export function armStartWatchdog(state: TurnState): void {
  clearStartWatchdog(state)
  if (state.controllerClosed) return
  state.startWatchdog = setTimeout(
    () => onStartWatchdogFire(state),
    state.startWatchdogMs,
  )
}

// ---- Late proxy results ---------------------------------------------------

/**
 * Both buffered/live terminal boundaries and respawn consume through this
 * path. Open-channel results remain available for a later close.
 */
export function deliverPendingCompletions(
  state: TurnState,
  force = false,
): boolean {
  const pending = state.activeProcess?.pendingProxyCompletions
  const entries = [...(pending?.values() ?? [])].filter(
    (entry) => force || entry.recoveryRequired || isPendingProxyCallChannelClosed(entry.call),
  )
  if (entries.length === 0) return false
  state.endTextBlock()
  state.watchdogMessage = makeLateProxyResultMessage(entries)
  // This write asks the CLI for work like any fresh envelope, so
  // abort, LRU eviction and the idle timer must see it as busy.
  if (state.activeProcess) noteTurnStarted(state.activeProcess)
  state.proc.stdin!.write(state.watchdogMessage + "\n")
  for (const { call } of entries) pending!.delete(call.toolCallId)
  log.warn("delivering proxy results after interrupted continuation", {
    sessionKey: state.sessionKey,
    toolCallIds: entries.map(({ call }) => call.toolCallId),
    respawn: force,
  })
  state.gotPartialEvents = false
  state.hasReceivedContent = false
  state.hasReceivedProgress = false
  state.turnCompleted = false
  resetAutoContinueWindow(state)
  clearFallbackTimer(state)
  armStartWatchdog(state)
  return true
}

// ---- Ending the turn on tool calls ----------------------------------------

export function finishWithToolCalls(
  state: TurnState,
  calls: PendingProxyCall[],
): void {
  if (state.controllerClosed) return
  if (calls.length === 0) return
  const enqueueToolCall = (
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>,
  ) => {
    state.controller.enqueue({
      type: "tool-input-start",
      id: toolCallId,
      toolName,
    } as any)
    state.controller.enqueue({
      type: "tool-call",
      toolCallId,
      toolName,
      input: JSON.stringify(input),
      providerExecuted: false,
    } as any)
    state.skipResultForIds.add(toolCallId)
  }
  for (const call of calls) {
    if (call.toolName === TASK_BATCH_TOOL_NAME) {
      // One MCP call from the CLI becomes N opencode `task` calls in
      // this single tool boundary, which is what makes them run at the
      // same time: the CLI serialises MCP calls, opencode runs the
      // tool calls of one step concurrently. Their results are
      // gathered back onto the parent id in
      // extractPendingProxyResultForCall.
      for (const [index, task] of taskBatchTasks(call.input).entries()) {
        enqueueToolCall(
          taskBatchChildToolCallId(call.toolCallId, index),
          "task",
          task,
        )
      }
      state.skipResultForIds.add(call.toolCallId)
    } else {
      enqueueToolCall(call.toolCallId, call.toolName, call.input)
    }
    markPendingProxyCallEmitted(call.toolCallId)
  }
  state.controller.enqueue({
    type: "finish",
    finishReason: state.toFinishReason("tool-calls"),
    usage: state.toUsage(state.resultMeta.usage),
    providerMetadata: {
      "claude-code": state.resultMeta,
    },
  })
  state.controllerClosed = true
  state.cleanupTurn()
  try {
    state.controller.close()
  } catch {}
}

/**
 * End the turn on a synthetic call to opencode's native `question` tool.
 * opencode runs the tool, and the operator's answer arrives on the NEXT
 * doStream as a `tool-result` carrying this same id, which is what keeps the
 * whole exchange inside one opencode turn. Shared by the plan-mode approval
 * bridge and the account-failover form.
 */
export function finishWithQuestionCall(
  state: TurnState,
  call: QuestionToolCall,
): void {
  if (state.controllerClosed) return
  state.endTextBlock()
  state.controller.enqueue({
    type: "tool-input-start",
    id: call.toolCallId,
    toolName: call.toolName,
    providerExecuted: false,
  } as any)
  state.controller.enqueue({
    type: "tool-call",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: JSON.stringify(call.input),
    providerExecuted: false,
  } as any)
  state.controller.enqueue({
    type: "finish",
    finishReason: state.toFinishReason("tool-calls"),
    usage: state.toUsage(state.resultMeta.usage),
    providerMetadata: {
      "claude-code": state.resultMeta,
    },
  })
  state.controllerClosed = true
  state.cleanupTurn()
  try {
    state.controller.close()
  } catch {}
}

// ---- The batched drain ----------------------------------------------------

export function drainNow(state: TurnState): void {
  if (state.drainTimer) {
    clearTimeout(state.drainTimer)
    state.drainTimer = null
  }
  if (state.drainBuffer.length === 0) return
  if (state.controllerClosed) return
  const batch = state.drainBuffer.splice(0, state.drainBuffer.length)
  log.info("draining pending proxy calls into stream finish", {
    sessionKey: state.sessionKey,
    count: batch.length,
    toolCallIds: batch.map((c) => c.toolCallId),
  })
  finishWithToolCalls(state, batch)
}

function settleResultBoundary(state: TurnState): void {
  state.drainTimer = null
  const completeResult = state.pendingResultCompletion
  state.pendingResultCompletion = null
  if (!completeResult || state.controllerClosed) return
  if (state.drainBuffer.length > 0) {
    drainNow(state)
    return
  }
  completeResult()
}

export function scheduleResultBoundary(
  state: TurnState,
  completeResult: () => void,
  delayMs: number,
): void {
  state.pendingResultCompletion = completeResult
  if (state.drainTimer) clearTimeout(state.drainTimer)
  state.drainTimer = setTimeout(() => settleResultBoundary(state), delayMs)
}

export function noteResultBoundaryCall(state: TurnState): boolean {
  if (!state.pendingResultCompletion) return false
  if (state.drainTimer) clearTimeout(state.drainTimer)
  state.drainTimer = setTimeout(() => settleResultBoundary(state), DRAIN_QUIET_MS)
  return true
}

// ---- The auto-continue window ---------------------------------------------

export function noteVisibleText(state: TurnState, text: string): void {
  state.visibleTextSinceContinue += text
  state.lastVisibleTextSinceContinue += text
  if (text.length > 0) state.sawVisibleText = true
}

export function resetLastVisibleTextBlock(state: TurnState): void {
  state.lastVisibleTextSinceContinue = ""
}

export function noteReasoning(state: TurnState): void {
  state.hadReasoningSinceContinue = true
  state.sawReasoning = true
}

export function noteToolActivity(state: TurnState): void {
  state.hadToolActivitySinceContinue = true
  state.sawToolActivity = true
}

export function noteProxyActivity(state: TurnState): void {
  state.hadProxyActivitySinceContinue = true
  state.sawProxyActivity = true
}

export function resetAutoContinueWindow(state: TurnState): void {
  state.visibleTextSinceContinue = ""
  state.lastVisibleTextSinceContinue = ""
  state.hadReasoningSinceContinue = false
  state.hadToolActivitySinceContinue = false
  state.hadProxyActivitySinceContinue = false
  state.lastStopReason = null
}

/**
 * The nudge, and only the nudge. Returns true when the turn was put back to
 * work, which is `completeResult`'s signal to return without finishing.
 *
 * Both log lines stay here so the pair is read together: a nudge and the one
 * line that says the nudging stopped. A compaction turn never reaches this,
 * because `autoContinueEnabledFor` already turned `state.autoContinueState`
 * off for it.
 */
export function runAutoContinue(
  state: TurnState,
  msg: ClaudeStreamMessage,
): boolean {
  const autoDecision = shouldAutoContinueIncompleteTurn(
    state.autoContinueState,
    {
      text: state.visibleTextSinceContinue,
      lastVisibleText: state.lastVisibleTextSinceContinue,
      hadReasoning: state.hadReasoningSinceContinue,
      hadToolActivity: state.hadToolActivitySinceContinue,
      hadProxyActivity: state.hadProxyActivitySinceContinue,
      isError: msg.is_error,
      stopReason: state.lastStopReason,
    },
  )
  if (autoDecision.continue) {
    const signature = continuationSignature({
      text: state.visibleTextSinceContinue,
      lastVisibleText: state.lastVisibleTextSinceContinue,
      hadReasoning: state.hadReasoningSinceContinue,
      hadToolActivity: state.hadToolActivitySinceContinue,
      hadProxyActivity: state.hadProxyActivitySinceContinue,
      isError: msg.is_error,
    })
    state.autoContinueState.noProgressCount =
      signature === state.autoContinueState.lastSignature
        ? state.autoContinueState.noProgressCount + 1
        : 0
    state.autoContinueState.lastSignature = signature
    state.autoContinueState.attempts++
    log.notice("auto-continuing incomplete claude result", {
      sessionKey: state.sessionKey,
      reason: autoDecision.reason,
      attempts: state.autoContinueState.attempts,
      textLength: state.visibleTextSinceContinue.length,
      lastTextLength: state.lastVisibleTextSinceContinue.length,
      hadReasoning: state.hadReasoningSinceContinue,
      hadToolActivity: state.hadToolActivitySinceContinue,
      hadProxyActivity: state.hadProxyActivitySinceContinue,
    })
    state.turnCompleted = false
    resetAutoContinueWindow(state)
    // The `result` just consumed marked the CLI idle; this puts it back to work.
    if (state.activeProcess) noteTurnStarted(state.activeProcess)
    state.proc.stdin?.write(makeAutoContinueMessage() + "\n")
    return true
  }
  log.notice("auto-continuation stopped", {
    sessionKey: state.sessionKey,
    reason: autoDecision.reason,
    stopReason: state.lastStopReason,
    attempts: state.autoContinueState.attempts,
    textLength: state.visibleTextSinceContinue.length,
    lastTextLength: state.lastVisibleTextSinceContinue.length,
    hadReasoning: state.hadReasoningSinceContinue,
    hadToolActivity: state.hadToolActivitySinceContinue,
    hadProxyActivity: state.hadProxyActivitySinceContinue,
  })
  return false
}
