import type { ClaudeStreamMessage } from "./types.js"
import type { TurnState } from "./turn-state.js"
import { cliToolCallInputJson, emitCliToolCall } from "./turn-state.js"
import { log } from "./logger.js"
import {
  describeWatchdogClose,
  formatRequestResentNote,
  formatStreamTimeoutNote,
  streamTimeoutPhase,
  type StreamTimeoutPhase,
} from "./cli-events.js"
import { userEnvelope } from "./user-envelope.js"
import { effectiveSpawnMcpTimeoutMs } from "./cli-version.js"
import {
  deleteActiveProcess,
  deleteClaudeSessionId,
  interruptTurn,
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
  READ_ONLY_PROXY_TOOLS,
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
import { lastCallContextUsage } from "./usage.js"

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

let drainQuietMs = DRAIN_QUIET_MS

/** The drain window in effect: `DRAIN_QUIET_MS` unless a test widened it. */
export function currentDrainQuietMs(): number {
  return drainQuietMs
}

/**
 * Test seam: `null` restores the default. A test that has to act while a
 * proxied call keeps its turn open widens the window instead of racing it,
 * because under load a child's death took longer than 100 ms to reach the
 * parent (h #g283).
 */
export function _setDrainQuietMs(ms: number | null): void {
  drainQuietMs = ms ?? DRAIN_QUIET_MS
}

// ---- The wire-inactivity watchdog ----------------------------------------

export function clearFallbackTimer(state: TurnState): void {
  if (state.resultFallbackTimer) {
    clearTimeout(state.resultFallbackTimer)
    state.resultFallbackTimer = null
  }
}

/** How far past its deadline the inactivity watchdog may fire and still close. */
const RESULT_FALLBACK_LATE_SLACK_MS = 5_000

let resultFallbackLateSlackMs = RESULT_FALLBACK_LATE_SLACK_MS
let watchdogNow: () => number = () => Date.now()

/** Test seams: a clock that can jump, as a sleep makes it, and the slack. `null` restores. */
export function _setResultFallbackClock(now: (() => number) | null): void {
  watchdogNow = now ?? (() => Date.now())
}
export function _setResultFallbackLateSlackMs(ms: number | null): void {
  resultFallbackLateSlackMs = ms ?? RESULT_FALLBACK_LATE_SLACK_MS
}

/**
 * Wire-inactivity watchdog. Resets on every line received from the CLI; only
 * fires if the CLI has emitted content and then gone silent on stdout for
 * `delayMs` without sending a `result`. The previous design armed this on
 * every text content_block_stop, which killed legitimate mid-turn think pauses
 * (most visibly with sonnet between text-end and the next tool_use_start).
 * Tunable for reproduces and for the regression test, the same seam
 * CLAUDE_CODE_START_WATCHDOG_MS gives the start watchdog below.
 *
 * A fire that comes well past its deadline re-arms instead of closing (h #g316):
 * the timer counts wall-clock time, sleep included (measured on 2026-11-14: it
 * fired 3 s into a dark wake, five minutes after it was due, with at most 41 s
 * of awake time behind it), so ten minutes of a sleeping Mac read as ten
 * minutes of a silent CLI and the turn was closed while the CLI was only
 * waiting for the network. A late fire means this process was not running, so
 * the silence was never observed; an event-loop stall is the same case, with
 * the CLI's output possibly unread in the pipe. A fire that does close the turn
 * also interrupts the CLI, as an abort does (h #g59): closed here, nobody reads
 * what it does next, and one child ran on unattached for 28 minutes.
 */
export function startResultFallback(
  state: TurnState,
  delayMs = state.resultFallbackMs,
): void {
  clearFallbackTimer(state)
  if ((!state.hasReceivedContent && !state.hasReceivedProgress) || state.controllerClosed) return
  // Waiting for the CLI to acknowledge the resend's interrupt; that wait has
  // its own bound (`interruptTurn`'s timeout). An abort's grace period still
  // arms: the operator asked to stop, and the resend will not go out.
  if (state.deadRequestResend === "interrupting" && !state.autoContinueState.aborted) return
  const armedAt = watchdogNow()
  state.resultFallbackTimer = setTimeout(() => {
    if (state.controllerClosed) return
    const lateMs = watchdogNow() - armedAt - delayMs
    if (lateMs > resultFallbackLateSlackMs) {
      log.info("result fallback timer fired late; the process was not running, so it waits again", {
        delayMs,
        lateMs,
      })
      startResultFallback(state, delayMs)
      return
    }
    const phase = streamTimeoutPhase(state)
    if (shouldResendDeadRequest(state, phase)) {
      resendDeadRequest(state, delayMs)
      return
    }
    closeOnWatchdog(state, delayMs, phase)
  }, delayMs)
}

/**
 * Close the turn the watchdog gave up on. The CLI is interrupted, as an abort
 * does (h #g59, h #g316): closed here, nobody reads what it does next. The
 * note and the error say what the stream showed (h #g323): a request that got
 * no answer, a reply that had finished, or one that stopped partway. Before,
 * the close went through the crash handler, which waited for an exit that
 * never came and reported "The Claude Code CLI closed its output". A reply that
 * had finished ends as a stop, which is what Claude Code itself reports when
 * that stream is interrupted (measured: a `success` result). An abort is
 * exempt from all of it: the operator asked, and the abort's short grace
 * period is not a silent CLI. A compaction turn gets no note, because what it
 * says is stored as the summary (h #g214), and always ends as an error.
 */
function closeOnWatchdog(state: TurnState, delayMs: number, phase: StreamTimeoutPhase): void {
  if (state.controllerClosed) return
  const resent = state.deadRequestResend === "resent"
  const aborted = state.autoContinueState.aborted === true
  log.warn("result fallback timer fired; closing the turn without a result", {
    delayMs,
    phase,
    resent,
  })
  const child = state.activeProcess
  if (child && !aborted) {
    void interruptTurn(child).catch(() => undefined)
  }
  if (!aborted) {
    if (!state.compactionMode) {
      state.controller.enqueue({
        type: "text-delta",
        id: state.startTextBlock(),
        delta: formatStreamTimeoutNote(delayMs, phase, resent),
      })
      state.endTextBlock()
    }
    const errorText =
      describeWatchdogClose(delayMs, phase === "complete" && state.compactionMode ? "mid-reply" : phase, resent)
    state.watchdogClose = { phase, errorText }
  }
  state.closeHandler()
}

/**
 * The continuation the resend writes after interrupting a request that got no
 * answer. Claude sees it in the same user message as Claude Code's own
 * "[Request interrupted by user]" (measured on 2.1.322: the next request's last
 * message is the tool result, that marker and this text), so it says who
 * interrupted and why.
 */
export const DEAD_REQUEST_RESEND_PROMPT =
  "Your last request to the Anthropic API got no response, so the opencode plugin interrupted it" +
  " (that is the interruption above, not the user) and is retrying it once with this message." +
  " Continue the task exactly where you left off, without repeating work that is already done."

export function makeDeadRequestResendMessage(verbatim = false): string {
  return userEnvelope([{ type: "text", text: DEAD_REQUEST_RESEND_PROMPT }], verbatim)
}

/**
 * Whether this fire resends instead of closing (h #g323). Only a request that
 * got no answer at all: the stream showed `requesting` and nothing after it,
 * not even `message_start`. Nothing was generated for it, so a second request
 * cannot bill output twice, and the only alternative is the close, after which
 * someone has to send a message again (a subagent has nobody to do it). A
 * reply that had started is never resent, however slowly it streams: its
 * output was being generated and billed. Once per turn; never on an aborted
 * turn, a compaction (its text is the summary) or the interactive transport
 * (no `requesting` frames, and its interrupt is the TUI's Esc).
 */
function shouldResendDeadRequest(state: TurnState, phase: StreamTimeoutPhase): boolean {
  if (phase !== "no-answer") return false
  if (state.deadRequestResend !== "idle") return false
  if (state.autoContinueState.aborted || state.compactionMode) return false
  const child = state.activeProcess
  if (!child || child.interactiveControl) return false
  // The resend leans on the interrupt ending the CLI's turn first, and
  // `interruptTurn` writes none for a process it believes idle.
  return child.turnInFlight === true && child.proc.stdin?.writable === true
}

/**
 * Interrupt the request that got no answer and, once the CLI has gone idle,
 * ask the same process to go on. Measured on 2.1.322 against a local API that
 * never answered: the interrupt's `control_response` and an
 * `error_during_execution` result (`terminal_reason: "aborted_streaming"`)
 * came 2 to 4 ms after it, the HTTP request was closed, and a continuation
 * envelope on the same process started a new turn whose fresh request carried
 * the whole conversation and was answered. The parser drops that result while
 * the resend is `interrupting`. An interrupt the CLI does not acknowledge in
 * time, or a resend that went silent too, closes the turn as before.
 */
function resendDeadRequest(state: TurnState, delayMs: number): void {
  const child = state.activeProcess!
  state.deadRequestResend = "interrupting"
  log.warn("claude code's API request got no answer; interrupting it and sending it once more", {
    sessionKey: state.sessionKey,
    delayMs,
  })
  const giveUp = () => {
    state.deadRequestResend = "resent"
    closeOnWatchdog(state, delayMs, "no-answer")
  }
  void interruptTurn(child)
    .then((idle) => {
      if (state.controllerClosed || state.autoContinueState.aborted) return
      if (!idle || state.activeProcess !== child) {
        log.warn("claude code did not acknowledge the interrupt; closing the turn", {
          sessionKey: state.sessionKey,
        })
        giveUp()
        return
      }
      state.deadRequestResend = "resent"
      state.requestAwaitingReply = false
      state.controller.enqueue({
        type: "text-delta",
        id: state.startTextBlock(),
        delta: formatRequestResentNote(delayMs),
      })
      state.endTextBlock()
      // A late proxy result waiting to be delivered is itself a message that
      // asks the CLI to go on (h #g82, h #g119); otherwise, the continuation.
      if (!deliverPendingCompletions(state)) {
        noteTurnStarted(child)
        state.proc.stdin?.write(makeDeadRequestResendMessage(state.verbatimPrompts) + "\n")
      }
      startResultFallback(state)
    })
    .catch(() => {
      if (!state.controllerClosed) giveUp()
    })
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
  // The interactive transport writes nothing until the TUI has booted and the
  // first API call has finished, which can take longer than this deadline,
  // and it has its own liveness: a dead TUI ends the turn with a `result`, a
  // wedged one meets `turnTimeoutMs`. A respawn here would build a HEADLESS
  // child from `cliArgs` the interactive spawn never set, so wait instead.
  const interactive = state.activeProcess?.interactiveControl
  if (interactive) {
    if (interactive.turnRunning()) armStartWatchdog(state)
    return
  }
  if (state.respawnAttempted) {
    log.error(
      "claude process still silent after respawn; ending turn",
      {
        sessionKey: state.sessionKey,
        startWatchdogMs: state.startWatchdogArmedMs,
        beforeInit: state.startWatchdogBeforeInit,
      },
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
    {
      sessionKey: state.sessionKey,
      startWatchdogMs: state.startWatchdogArmedMs,
      beforeInit: state.startWatchdogBeforeInit,
    },
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

/**
 * What a headless child gets on top of its own `MCP_TIMEOUT` before its first
 * `system`/`init`: its boot and the user's `SessionStart` hooks, which run
 * before that line too and measured several seconds under load (h #g256).
 */
export const START_WATCHDOG_INIT_MARGIN_MS = 30_000

/**
 * The start watchdog's delay. A child that has not written `system`/`init`
 * yet may be waiting on an MCP server, which Claude Code allows up to
 * `MCP_TIMEOUT` (120 s from the plugin, 90 s being the configured delay):
 * after a wake from sleep on 2026-10-17 that wait outlasted the delay on
 * every spawn for three minutes, and each was killed twice and failed (h
 * #g256). So until `init` the delay is at least that timeout plus a margin;
 * from `init` on it is the configured delay, which is what a reused process
 * always gets, since its servers are connected and it writes `init` at once.
 */
export function startWatchdogDelayMs(
  configuredMs: number,
  beforeInit: boolean,
  mcpTimeoutMs: number = effectiveSpawnMcpTimeoutMs(),
): number {
  return beforeInit
    ? Math.max(configuredMs, mcpTimeoutMs + START_WATCHDOG_INIT_MARGIN_MS)
    : configuredMs
}

/**
 * `extraMs` is a wait the CLI announced itself (an `api_retry` frame's
 * `retry_delay_ms`), added so a CLI that is only backing off before its next
 * attempt is not taken for a silent one. A late fire re-arms, as the
 * inactivity watchdog's does: the clock counts sleep (h #g316).
 */
export function armStartWatchdog(state: TurnState, extraMs = 0): void {
  clearStartWatchdog(state)
  if (state.controllerClosed) return
  const ap = state.activeProcess
  // The interactive shim never respawns from here (see the fire handler), so
  // it keeps the configured delay.
  state.startWatchdogBeforeInit = !ap?.interactiveControl && ap?.initSeen !== true
  state.startWatchdogArmedMs =
    startWatchdogDelayMs(state.startWatchdogMs, state.startWatchdogBeforeInit) + extraMs
  const armedAt = watchdogNow()
  const delayMs = state.startWatchdogArmedMs
  state.startWatchdog = setTimeout(() => {
    const lateMs = watchdogNow() - armedAt - delayMs
    if (lateMs > resultFallbackLateSlackMs && !state.controllerClosed) {
      log.info("start watchdog fired late; the process was not running, so it waits again", {
        delayMs,
        lateMs,
      })
      armStartWatchdog(state)
      return
    }
    onStartWatchdogFire(state)
  }, delayMs)
}

/** Longest wait an `api_retry` frame may add to a watchdog (h #g316). */
const MAX_ANNOUNCED_RETRY_WAIT_MS = 30 * 60_000

/**
 * The CLI said it will wait before its next attempt: measured on 2.1.322
 * against a server answering 529, the `system`/`api_retry` frame arrives as the
 * attempt fails, with `retry_delay_ms` equal to the gap before the next request
 * (`retry-after: 4` gave 4000 and a request 4.0 s later). Whichever watchdog is
 * armed waits that much longer, so a backoff longer than its window neither
 * closes the turn (and, since h #g316, interrupts the CLI) nor respawns a child
 * that is working as designed. The CLI's own `max_retries` bounds how often.
 */
export function noteAnnouncedRetry(state: TurnState, msg: ClaudeStreamMessage): void {
  const announced = (msg as { retry_delay_ms?: unknown }).retry_delay_ms
  if (typeof announced !== "number" || !Number.isFinite(announced) || announced <= 0) return
  const waitMs = Math.min(announced, MAX_ANNOUNCED_RETRY_WAIT_MS)
  log.info("claude code is retrying the API request; the watchdogs wait for it", { waitMs })
  if (state.resultFallbackTimer) startResultFallback(state, state.resultFallbackMs + waitMs)
  if (state.startWatchdog) armStartWatchdog(state, waitMs)
}

/**
 * The parser calls this on every `system`/`init`. Only the first one a child
 * writes changes anything: the watchdog armed with the longer pre-`init`
 * delay starts over with the configured one, counted from now.
 */
export function noteStartWatchdogInit(state: TurnState): void {
  if (!state.startWatchdog || !state.startWatchdogBeforeInit) return
  if (state.activeProcess?.initSeen !== true) return
  armStartWatchdog(state)
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
  state.watchdogMessage = makeLateProxyResultMessage(entries, state.verbatimPrompts)
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

/**
 * What a CLI-executed tool's row says when this step ends before the CLI
 * handed its output over. The output itself is not lost: it is in Claude's own
 * context, which is the only place it was ever going to be read.
 */
export const CLI_RESULT_DEFERRED_OUTPUT =
  "Claude Code ran this tool itself and kept its output in its own context." +
  " This step ended on a tool call opencode has to run, so the output was not" +
  " available to show here."

/**
 * Close out every CLI-executed tool call of this step that has no result yet.
 *
 * The CLI answers a whole assistant message's tool calls with ONE `user`
 * frame, so when one of them is a proxied call it withholds its own results
 * until the plugin sends the proxied one back, which cannot happen before this
 * step ends. Whatever arrives on the next stream reaches a turn whose state is
 * gone, so the row is never answered: opencode 2.0.22 says so out loud
 * ("Provider did not return a tool result") and opencode 1.18.34 leaves it
 * pending (h #g190).
 *
 * Two shapes, in order, because they need different amounts of finishing: a
 * registered call is missing only its result, while a block the CLI has not
 * closed yet is missing its `tool-call` part too (`emitCliToolCall` is a no-op
 * for the first group, since their part is already out). `skipResultForIds`
 * excludes both the proxied calls and everything opencode runs itself, which
 * is what makes what is left exactly the dangling set.
 *
 * The placeholder also gives a rebuilt transcript a `tool_result` for a
 * `tool_use` this CLI process issued, which the issue-#29 gate (h #g121) would
 * otherwise have to send back unanswered.
 *
 * Only this path needs it: `finishWithQuestionCall` runs from `completeResult`
 * on a terminal `result`, by which point the CLI has delivered everything.
 */
function closeDeferredCliToolResults(state: TurnState): void {
  const answer = (id: string, name: string, stage: string) => {
    emitCliToolCall(state, id, name, cliToolCallInputJson(state, id), true)
    state.controller.enqueue({
      type: "tool-result",
      toolCallId: id,
      toolName: name,
      result: {
        output: CLI_RESULT_DEFERRED_OUTPUT,
        title: name,
        metadata: {},
      },
      providerExecuted: true,
    } as any)
    state.toolCallsById.delete(id)
    state.toolCallAnsweredIds.add(id)
    log.info("closing a CLI-executed tool call whose result this step cannot wait for", {
      sessionKey: state.sessionKey,
      toolUseId: id,
      name,
      stage,
    })
  }

  // Registered and still unanswered: its block closed, or its result came in
  // ahead of the close. Either way a `tool-call` part is already out.
  for (const [id, toolCall] of [...state.toolCallsById]) {
    if (state.skipResultForIds.has(id)) continue
    answer(id, toolCall.name, "registered")
  }

  // The block never closed, so only `tool-input-start` went out: the part
  // needs its `tool-call` too. This is the common shape, because the CLI
  // starts the block, runs the tool, and emits `content_block_stop` with the
  // assistant frame that closes the whole batch, which it is holding for the
  // proxied call.
  for (const entry of state.toolCallMap.values()) {
    if (!entry.started || !entry.mappedName) continue
    if (state.skipResultForIds.has(entry.id)) continue
    if (state.toolCallAnsweredIds.has(entry.id)) continue
    if (state.toolCallEmittedIds.has(entry.id)) continue
    answer(entry.id, entry.mappedName, "open-block")
  }
}

/**
 * Hand one proxied call to opencode as a tool-call part.
 *
 * Shared with the subagent dispatch release (h #g227), which emits the same
 * parts for the same calls out of a synthetic stream that has no `TurnState`:
 * two copies of this would be two places for the part shape to drift.
 */
export function enqueueProxyToolCall(
  controller: ReadableStreamDefaultController<any>,
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
): void {
  controller.enqueue({
    type: "tool-input-start",
    id: toolCallId,
    toolName,
  } as any)
  controller.enqueue({
    type: "tool-call",
    toolCallId,
    toolName,
    input: JSON.stringify(input),
    providerExecuted: false,
  } as any)
}

export function finishWithToolCalls(
  state: TurnState,
  calls: PendingProxyCall[],
): void {
  if (state.controllerClosed) return
  if (calls.length === 0) return
  closeDeferredCliToolResults(state)
  const enqueueToolCall = (
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>,
  ) => {
    enqueueProxyToolCall(state.controller, toolCallId, toolName, input)
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
    // No result yet (the usual mid-turn boundary) still reports nothing.
    usage: state.toUsage(lastCallContextUsage(state.lastCallUsage, state.resultMeta.usage)),
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
    usage: state.toUsage(lastCallContextUsage(state.lastCallUsage, state.resultMeta.usage)),
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
 * End this step on the plan an interactive TUI is parked on, when there is no
 * question tool to ask through (`planModeQuestion` off): the plan is already
 * written as text, and the operator's next message is the decision, which the
 * shim types into the parked dialog instead of starting a new turn (h #g201).
 * A finished reply, not a tool call.
 */
export function finishAwaitingPlanApproval(state: TurnState): void {
  if (state.controllerClosed) return
  state.endTextBlock()
  state.controller.enqueue({
    type: "finish",
    finishReason: state.toFinishReason("stop"),
    usage: state.toUsage(lastCallContextUsage(state.lastCallUsage, state.resultMeta.usage)),
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

/**
 * Longest the drain waits for a reply to finish streaming while it holds only
 * read-only calls (h #g289). Measured on 2.1.314, a reply's read-only calls
 * reached the proxy 100 to 180 ms apart, so the quiet window alone split
 * three fetches over two steps; the reply's own `message_stop` came a few
 * hundred ms after its first call. The cap bounds a reply that keeps
 * streaming text after its calls.
 */
export const READ_ONLY_HOLD_CAP_MS = 2000

/** True while the drain should keep waiting for more of this reply's calls. */
function holdsForReadOnlyReply(state: TurnState, now: number): boolean {
  return (
    state.holdReadOnlyDrain &&
    state.replyStreaming &&
    state.drainBuffer.length > 0 &&
    state.drainBuffer.every((call) => READ_ONLY_PROXY_TOOLS.includes(call.toolName)) &&
    now - (state.drainHeldSince ?? now) < READ_ONLY_HOLD_CAP_MS
  )
}

/**
 * (Re)arms the drain after a proxied call arrived. Claude Code sends a
 * non-read-only call only after the previous result, so a batch holding one
 * drains after the quiet window as it always did. A batch of read-only calls
 * may still grow while the reply streams, so it waits for `message_stop`
 * (`replyStreaming`), up to `READ_ONLY_HOLD_CAP_MS`.
 */
export function scheduleDrain(state: TurnState): void {
  if (state.drainTimer) clearTimeout(state.drainTimer)
  if (state.drainHeldSince === null) state.drainHeldSince = Date.now()
  state.drainTimer = setTimeout(() => {
    state.drainTimer = null
    if (holdsForReadOnlyReply(state, Date.now())) {
      scheduleDrain(state)
      return
    }
    drainNow(state)
  }, currentDrainQuietMs())
}

export function drainNow(state: TurnState): void {
  if (state.drainTimer) {
    clearTimeout(state.drainTimer)
    state.drainTimer = null
  }
  state.drainHeldSince = null
  if (state.drainBuffer.length === 0) return
  if (state.controllerClosed) return
  // The interactive TUI writes a reply's records before it runs the reply's
  // tools, but its transcript is polled: read what is already there, or the
  // text that led to this call lands after the step it belongs to.
  state.activeProcess?.interactiveControl?.flushTranscript()
  if (state.controllerClosed) return
  const batch = state.drainBuffer.splice(0, state.drainBuffer.length)
  // The subagent dispatch form (h #g227). With `subagentDispatch` off, which
  // is the default, the slot is null and this is the drain it always was.
  // With it on, a batch that starts subagents ends this step on a `question`
  // instead; the calls stay in the broker, unemitted, and the next doStream
  // releases them with the operator's answer applied.
  const form = state.subagentDispatchForm?.(batch) ?? null
  if (form) {
    log.notice("holding a subagent dispatch for the operator's answer", {
      sessionKey: state.sessionKey,
      count: batch.length,
      toolCallIds: batch.map((c) => c.toolCallId),
      questionToolCallId: form.toolCallId,
    })
    finishWithQuestionCall(state, form)
    return
  }
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
  state.drainTimer = setTimeout(() => settleResultBoundary(state), currentDrainQuietMs())
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
    state.proc.stdin?.write(makeAutoContinueMessage(state.verbatimPrompts) + "\n")
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
