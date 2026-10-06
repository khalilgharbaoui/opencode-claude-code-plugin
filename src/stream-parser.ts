import { generateId } from "./ids.js"
import type { ClaudeCodeConfig, ClaudeStreamMessage } from "./types.js"
import type { TurnState, TurnToolCallEntry } from "./turn-state.js"
import { emitCliToolCall } from "./turn-state.js"
import { log } from "./logger.js"
import { mapTool, isWebSearchTool, isWebSearchHandledByCli } from "./tool-mapping.js"
import { applyTaskCreateToolResult } from "./todo-ledger.js"
import { getClaudeSessionId, setClaudeSessionId } from "./session-manager.js"
import { reportFastModeState } from "./fast-mode.js"
import {
  describeResultFailure,
  formatResultFailureNote,
  isRateLimitRejected,
  parseRateLimitEvent,
  reportCompactBoundary,
  reportConversationReset,
  reportHookEvent,
  reportRateLimitEvent,
  reportSystemInit,
  reportToolProgress,
} from "./cli-events.js"
import {
  accountBlockKind,
  formatAccountBlockNote,
  isAccountLimitError,
  recallAccountLimit,
  rememberAccountLimit,
} from "./account-failover.js"
import {
  extractTurnStats,
  formatTurnStatsBlock,
  turnStatsLogPayload,
} from "./turn-stats.js"
import { formatAskUserQuestion, isAskUserQuestionTool } from "./ask-user-question.js"
import { createExitPlanModeQuestionCall } from "./plan-mode-question.js"
import { PROXY_TOOL_PREFIX } from "./proxy-mcp.js"
import {
  modelRefusalFromAssistant,
  modelRefusalFromResult,
  provesModelServing,
  type ModelFallbackAttempt,
} from "./model-fallback.js"
import {
  DRAIN_QUIET_MS,
  clearFallbackTimer,
  clearStartWatchdog,
  deliverPendingCompletions,
  finishWithQuestionCall,
  finishAwaitingPlanApproval,
  noteProxyActivity,
  noteReasoning,
  noteToolActivity,
  noteVisibleText,
  resetLastVisibleTextBlock,
  scheduleResultBoundary,
  startResultFallback,
} from "./turn-controller.js"

/**
 * The Claude CLI stream-json line handler, moved out of `doStreamForHost`'s
 * `start()` closure verbatim.
 *
 * It is the largest thing that was in there and the densest in invariants:
 * `toolCallMap` deleted at `content_block_stop`, `tool-input-delta` gated on
 * `started` while `inputJson` accumulates either way, `signature_delta`
 * ignored quietly, a reasoning part started only on the first non-empty
 * `thinking_delta`, the twin `AskUserQuestion` and `ExitPlanMode` sites on the
 * partial and the whole-message paths, and the `conversation_reset` clear of
 * exactly the four index-keyed collections. None of that changed: the body
 * below is the same text, reading its state off `TurnState` and the twelve
 * values it took from the turn's prologue off `StreamParserContext`.
 */

/**
 * What the handler needs beyond the turn's own state. Everything here is
 * fixed for the turn except `attempt`, which the handler writes
 * (`attempt.serving`) because the model-fallback chain reads it back after
 * the handler returns, and `completeResult`, which stays in the model because
 * it also reads the failover gate and the chain.
 */
export interface StreamParserContext {
  config: ClaudeCodeConfig
  compactionMode: boolean
  fastMode: boolean
  planModeQuestionActive: boolean
  /** The interactive transport, whose TUI parks on `ExitPlanMode`'s dialog. */
  interactive: boolean
  /** The account this turn spawned on; the account-block note names it. */
  sourceAccount: string
  /** Whether a usage limit should end the turn on the switch form. */
  failoverAskActive: boolean
  /**
   * Whether a usage limit should end the turn on the `▌ **usage limit:**`
   * note, the complement of `failoverAskActive` (h #g194). The limit itself is
   * not known until the `result` frame, which is where this becomes
   * `TurnState.usageLimitNote`.
   */
  usageLimitNoteActive: boolean
  /** The other configured accounts, for a note that names where to move the work. */
  failoverAccounts: readonly string[]
  /** Whether a refusal on this turn may move to the next model in the chain. */
  modelFallbackArmed: boolean
  attempt?: ModelFallbackAttempt
  handleControlRequest: (
    msg: ClaudeStreamMessage,
    proc: import("child_process").ChildProcess,
  ) => boolean
  completeResult: (msg: ClaudeStreamMessage) => void
}

/**
 * Stream delta types we handle explicitly. `signature_delta` is listed as
 * known-and-silent: it carries encrypted thinking-block signatures that
 * are opaque to clients (the server uses them to reconstitute thinking
 * across turns), so there's nothing for us to do but ignore it.
 */
const KNOWN_DELTA_TYPES = new Set([
  "thinking_delta",
  "text_delta",
  "input_json_delta",
  "signature_delta",
])

const PROXY_RESULT_BOUNDARY_GRACE_MS = 250

/**
 * Register, and complete the `tool-call` part of, a CLI-executed call whose
 * content block has not closed yet, so a `tool_result` that arrives first can
 * still be paired. Returns the registration, or `undefined` when the id names
 * no open block the plugin started a part for (a skipped tool, a proxy call,
 * or an id from an earlier message). See (h #g190).
 */
function adoptOpenCliToolCall(
  state: TurnState,
  ctx: StreamParserContext,
  id: string,
): { id: string; name: string; input: unknown } | undefined {
  for (const entry of state.toolCallMap.values()) {
    if (entry.id !== id || !entry.started || !entry.mappedName) continue
    let parsedInput: Record<string, unknown> = {}
    try {
      parsedInput = JSON.parse(entry.inputJson || "{}")
    } catch {}
    const { input: mappedInput, executed } = mapTool(entry.name, parsedInput, {
      webSearch: ctx.config.webSearch,
      sessionId: getClaudeSessionId(state.sessionKey),
      toolUseId: entry.id,
    })
    const registration = { id: entry.id, name: entry.mappedName, input: parsedInput }
    state.toolCallsById.set(entry.id, registration)
    emitCliToolCall(state, entry.id, entry.mappedName, JSON.stringify(mappedInput), executed)
    return registration
  }
  return undefined
}

export function createLineHandler(
  state: TurnState,
  ctx: StreamParserContext,
): (line: string) => void {
  return (line: string) => {
    if (!line.trim()) return
    if (state.controllerClosed) return

    // Any line from the CLI counts as activity — reset the inactivity
    // watchdog so mid-turn pauses between blocks don't get killed.
    startResultFallback(state)

    try {
      const outer: ClaudeStreamMessage = JSON.parse(line)

      // Unwrap stream_event envelope (--include-partial-messages).
      // Inner event uses the same content_block_* / message_* shape.
      const msg: ClaudeStreamMessage =
        outer.type === "stream_event" && outer.event
          ? { ...outer.event, session_id: outer.session_id }
          : outer

      const modelProgress =
        (msg.type === "assistant" && !!msg.message?.content?.length) ||
        (msg.type === "content_block_start" && msg.content_block?.type === "tool_use") ||
        (msg.type === "content_block_delta" &&
          ((msg.delta?.type === "text_delta" && !!msg.delta.text) ||
           (msg.delta?.type === "thinking_delta" && !!msg.delta.thinking)))
      if (modelProgress) {
        state.hasReceivedProgress = true
        clearStartWatchdog(state)
        startResultFallback(state)
      }

      // Read before anything is enqueued for this message, because the
      // chain runner keys its withhold-or-flush decision on these two
      // flags and reads them only after the handler has returned.
      // `modelProgress` above cannot stand in: it counts the CLI's own
      // synthetic error reply, which is precisely a refusal.
      if (ctx.attempt && !ctx.attempt.serving && provesModelServing(msg)) {
        ctx.attempt.serving = true
      }
      if (ctx.modelFallbackArmed && !state.modelRefusal) {
        state.modelRefusal = modelRefusalFromAssistant(msg)
      }

      if (outer.type === "stream_event") {
        state.gotPartialEvents = true
      }

      if (ctx.handleControlRequest(msg, state.proc)) {
        return
      }

      log.debug("stream message", {
        type: msg.type,
        subtype: msg.subtype,
      })

      // Handle system init
      if (msg.type === "system" && msg.subtype === "init") {
        if (msg.session_id) {
          setClaudeSessionId(state.sessionKey, msg.session_id)
          log.info("session initialized", {
            claudeSessionId: msg.session_id,
          })
        }
        reportFastModeState(msg, ctx.fastMode)
        reportSystemInit(msg, {
          ignoreAnthropicApiKey: ctx.config.ignoreAnthropicApiKey,
        })
      }

      // The CLI compacted its own context. Nothing else tells the user
      // that everything before this point is now a summary.
      if (msg.type === "system" && msg.subtype === "compact_boundary") {
        const note = reportCompactBoundary(msg)
        if (note) {
          state.controller.enqueue({ type: "text-delta", id: state.startTextBlock(), delta: note })
          state.endTextBlock()
        }
      }

      // A hook the user configured ran. Only the SessionStart family
      // reaches a plugin spawn (everything else needs
      // `--include-hook-events`, which the plugin never passes), and a
      // failing one is silent today: the turn succeeds, the context the
      // hook was meant to add is simply absent. The reporter warns once
      // and keeps the row for `/claude-code-doctor`; it writes no
      // transcript note, because a broken hook is a property of the
      // session rather than of this answer.
      if (msg.type === "system") {
        reportHookEvent(msg)
      }

      // The CLI is still inside a tool it is running itself. Nothing is
      // enqueued: the watchdog reset this frame is worth already happened
      // at the top of the handler, and the rest is a log line naming the
      // tool and how long it has been going.
      if (msg.type === "tool_progress") {
        reportToolProgress(msg)
        return
      }

      // Claude Code started a new conversation (`/clear`, plan-mode
      // exit). Content-block indices restart with it, so nothing keyed
      // by index may survive: a stale `toolCallMap` entry re-emits a
      // finished tool call on the new conversation's first block, the
      // failure fixed on 2026-09-06. The Claude session id needs nothing
      // here; the `system/init` that follows carries the new one.
      if (msg.type === "conversation_reset") {
        const note = reportConversationReset(msg)
        if (note) {
          state.toolCallMap.clear()
          state.reasoningIds.clear()
          state.reasoningStarted.clear()
          state.textBlockIndices.clear()
          state.controller.enqueue({ type: "text-delta", id: state.startTextBlock(), delta: note })
          state.endTextBlock()
        }
        return
      }

      // Not returned from: the reply's own text still renders below.
      const block = accountBlockKind(msg)
      if (block) state.accountBlock = block

      // A rejection is why the turn is about to fail. Put it in the
      // transcript so the reason does not live only in a log file that
      // is off by default.
      if (msg.type === "rate_limit_event") {
        // Parsed separately from the reporter, which dedupes per
        // process and returns null on a repeat: the second rejection in
        // a session is still a rejection this turn has to act on.
        const info = parseRateLimitEvent(msg)
        if (info && isRateLimitRejected(info)) {
          state.accountLimitHit = {
            resetsAt: info.resetsAt ?? info.overageResetsAt,
            window: info.rateLimitType,
          }
          // Kept for the rest of the window, because a later limited turn on
          // a reused child gets no event of its own. See
          // `rememberAccountLimit`.
          rememberAccountLimit(ctx.sourceAccount, state.accountLimitHit)
        }
        const note = reportRateLimitEvent(msg)
        if (note) {
          state.controller.enqueue({ type: "text-delta", id: state.startTextBlock(), delta: note })
          state.endTextBlock()
        }
        return
      }

      // content_block_start
      if (
        msg.type === "content_block_start" &&
        msg.content_block &&
        msg.index !== undefined
      ) {
        const block = msg.content_block
        const idx = msg.index

        if (block.type === "thinking") {
          noteReasoning(state)
          const reasoningId = generateId()
          state.reasoningIds.set(idx, reasoningId)
        }

        if (block.type === "text") {
          state.textBlockIndices.add(idx)
          // New text block — clear last-block buffer so final-answer
          // detection only considers this block's contents, not earlier
          // mid-task narration.
          resetLastVisibleTextBlock(state)
          if (block.text) {
            if (!state.currentTextId) state.startTextBlock()
            state.controller.enqueue({
              type: "text-delta",
              id: state.currentTextId!,
              delta: block.text,
            })
            noteVisibleText(state, block.text)
            state.hasReceivedContent = true
          }
        }

        if (block.type === "tool_use" && block.id && block.name) {
          noteToolActivity(state)
          const entry: TurnToolCallEntry = {
            id: block.id,
            name: block.name,
            inputJson: "",
            started: false,
          }
          state.toolCallMap.set(idx, entry)

          if (
            block.name !== "AskUserQuestion" &&
            block.name !== "ask_user_question" &&
            block.name !== "ExitPlanMode" &&
            !block.name.startsWith(PROXY_TOOL_PREFIX)
          ) {
            const { name: mappedName, skip, executed } = mapTool(
              block.name,
              undefined,
              {
                webSearch: ctx.config.webSearch,
                sessionId: getClaudeSessionId(state.sessionKey),
                toolUseId: block.id,
              },
            )
            if (!skip) {
              entry.started = true
              entry.mappedName = mappedName
              state.controller.enqueue({
                type: "tool-input-start",
                id: block.id,
                toolName: mappedName,
                providerExecuted: executed,
              } as any)
              log.info("tool started", {
                name: block.name,
                mappedName,
                id: block.id,
              })
            }
          }
        }
      }

      // content_block_delta
      if (
        msg.type === "content_block_delta" &&
        msg.delta &&
        msg.index !== undefined
      ) {
        const delta = msg.delta
        const idx = msg.index

        if (delta.type === "thinking_delta" && delta.thinking) {
          noteReasoning(state)
          state.hadThinkingTextFromStream = true
          const reasoningId = state.reasoningIds.get(idx)
          if (reasoningId) {
            if (!state.reasoningStarted.get(idx)) {
              state.controller.enqueue({
                type: "reasoning-start",
                id: reasoningId,
              } as any)
              state.reasoningStarted.set(idx, true)
            }
            state.controller.enqueue({
              type: "reasoning-delta",
              id: reasoningId,
              delta: delta.thinking,
            } as any)
          }
        }

        if (delta.type === "text_delta" && delta.text) {
          if (!state.currentTextId) state.startTextBlock()
          state.controller.enqueue({
            type: "text-delta",
            id: state.currentTextId!,
            delta: delta.text,
          })
          noteVisibleText(state, delta.text)
          state.hasReceivedContent = true
        }

        if (delta.type === "input_json_delta" && delta.partial_json) {
          const tc = state.toolCallMap.get(idx)
          if (tc) {
            tc.inputJson += delta.partial_json
            // Only forward deltas for tool calls whose tool-input-start
            // was actually emitted. Skipped tools (CLAUDE_INTERNAL_TOOLS,
            // TaskCreate/TaskUpdate, CLI-internal WebSearch, AskUserQuestion,
            // ExitPlanMode, proxy tools) never get a named start part, so
            // forwarding their deltas makes opencode's AI SDK bridge fall
            // back to a nameless pending part rendered as `⚙ unknown`.
            if (tc.started) {
              state.controller.enqueue({
                type: "tool-input-delta",
                id: tc.id,
                delta: delta.partial_json,
              } as any)
            }
          }
        }

        if (!KNOWN_DELTA_TYPES.has(delta.type)) {
          log.debug("unrecognized content_block_delta type", {
            type: delta.type,
            idx,
            keys: Object.keys(delta),
          })
        }
      }

      // content_block_stop
      if (
        msg.type === "content_block_stop" &&
        msg.index !== undefined
      ) {
        const idx = msg.index

        const reasoningId = state.reasoningIds.get(idx)
        if (reasoningId && state.reasoningStarted.get(idx)) {
          state.controller.enqueue({
            type: "reasoning-end",
            id: reasoningId,
          } as any)
          state.reasoningStarted.delete(idx)
        }

        if (state.textBlockIndices.has(idx)) {
          state.endTextBlock()
          state.textBlockIndices.delete(idx)
        }

        const tc = state.toolCallMap.get(idx)
        if (tc) {
          // Block indices restart at 0 on every assistant message, and a
          // turn can hold several (tool_use -> tool_result -> answer).
          // Without this delete the entry outlives its message, so the
          // next message's block at the same index re-emits a tool-call
          // for an id opencode already completed. That second part never
          // gets a result, opencode aborts it at stream end, and a
          // subagent's `task` call reports "Tool execution aborted"
          // even though the child answered correctly.
          state.toolCallMap.delete(idx)
          let parsedInput: any = {}
          try {
            parsedInput = JSON.parse(tc.inputJson || "{}")
          } catch {}

          if (isAskUserQuestionTool(tc.name)) {
            // Latch: the model handed control to the operator. Block any
            // auto-continue nudge for the rest of the turn so it can't
            // proceed on its own before the operator replies.
            state.autoContinueState.sawAskUserQuestion = true
            const askId = state.startTextBlock()
            state.controller.enqueue({
              type: "text-delta",
              id: askId,
              delta: formatAskUserQuestion(parsedInput),
            })
            state.endTextBlock()
          } else if (tc.name === "ExitPlanMode") {
            const plan = (parsedInput?.plan as string) || ""

            if (ctx.planModeQuestionActive) {
              // Approval bridge: render the plan, then hand the
              // yes/no back to opencode's own `question` tool and end
              // the turn on "tool-calls" so the outer loop runs it.
              const questionCall = createExitPlanModeQuestionCall(
                state.sessionKey,
                tc.id,
                plan,
              )
              const planId = state.startTextBlock()
              state.controller.enqueue({
                type: "text-delta",
                id: planId,
                delta: questionCall.text,
              })
              finishWithQuestionCall(state, questionCall)
              return
            }

            const planId = state.startTextBlock()
            state.controller.enqueue({
              type: "text-delta",
              id: planId,
              delta: `\n\n${plan}\n\n---\n**Do you want to proceed with this plan?** (yes/no)\n`,
            })
            state.endTextBlock()
          } else if (
            isWebSearchTool(tc.name) &&
            isWebSearchHandledByCli(ctx.config.webSearch)
          ) {
            // Claude CLI runs WebSearch internally. Forwarding the
            // "WebSearch" tool-call part would render an invalid tool
            // row in opencode (no registry entry), so show the query
            // as a text line instead. The result stays CLI-internal.
            const query =
              typeof parsedInput?.query === "string"
                ? parsedInput.query
                : JSON.stringify(parsedInput)
            const searchId = state.startTextBlock()
            state.controller.enqueue({
              type: "text-delta",
              id: searchId,
              delta: `\n> **Web search:** ${query}\n`,
            })
            state.endTextBlock()
          } else if (tc.name.startsWith(PROXY_TOOL_PREFIX)) {
            noteProxyActivity(state)
            log.debug("ignoring proxy tool_use block; broker handles it", {
              name: tc.name,
              id: tc.id,
            })
          } else {
            const {
              name: mappedName,
              input: mappedInput,
              executed,
              skip,
            } = mapTool(tc.name, parsedInput, {
              webSearch: ctx.config.webSearch,
              sessionId: getClaudeSessionId(state.sessionKey),
              toolUseId: tc.id,
            })

            if (!skip && !state.toolCallAnsweredIds.has(tc.id)) {
              // Not re-registered once the result has gone out: the CLI can
              // send that before this close, and a re-registered id gets a
              // second, placeholder result at the end of a step that waits on
              // a proxied call (h #g190).
              state.toolCallsById.set(tc.id, {
                id: tc.id,
                name: mappedName,
                input: parsedInput,
              })
              if (!executed) state.skipResultForIds.add(tc.id)
              // A no-op when the CLI's own result already completed this part
              // (h #g190); otherwise the ordinary path.
              emitCliToolCall(state, tc.id, mappedName, JSON.stringify(mappedInput), executed)
            }
            log.info("tool call complete", {
              name: tc.name,
              mappedName,
              id: tc.id,
              executed,
            })
          }
        }
      }

      // Capture protocol-level stop_reason from the streaming
      // `message_delta` event (sent right before the final
      // `message_stop`). Any non-empty value is the source-of-truth
      // for why the turn ended — used to bypass the keyword heuristic.
      if (
        state.gotPartialEvents &&
        msg.type === "message_delta" &&
        typeof (msg as any).delta?.stop_reason === "string"
      ) {
        state.lastStopReason = (msg as any).delta.stop_reason
      }

      // assistant message (complete, not streaming).
      // When --include-partial-messages is on, this is a duplicate of
      // what we already streamed via content_block_* events. Skip it
      // for content, but still capture stop_reason from it for the
      // non-partial path.
      if (
        msg.type === "assistant" &&
        msg.message &&
        typeof (msg.message as any).stop_reason === "string"
      ) {
        state.lastStopReason = (msg.message as any).stop_reason
      }
      // An API call arrives as one `assistant` frame per content block (with
      // or without partial messages), all sharing that call's usage, so the
      // newest frame is the newest call. Its input and cache counters are
      // final; its `output_tokens` is a placeholder, which is why output
      // comes from the `result`. The CLI's `<synthetic>` frames carry all
      // zeros and are not a call.
      const callUsage = msg.type === "assistant" ? msg.message?.usage : undefined
      if (
        callUsage &&
        (callUsage.input_tokens ?? 0) +
          (callUsage.cache_read_input_tokens ?? 0) +
          (callUsage.cache_creation_input_tokens ?? 0) >
          0
      ) {
        state.lastCallUsage = callUsage
      }
      // Fallback: extract thinking from the complete assistant
      // message. opus-4-7's CLI strips thinking_delta from stream
      // events but may include thinking in the final message.
      if (
        msg.type === "assistant" &&
        msg.message?.content &&
        state.gotPartialEvents
      ) {
        const thinkingBlocks = (msg.message.content as any[]).filter(
          (b) => b.type === "thinking",
        )
        if (thinkingBlocks.length > 0) {
          log.info("assistant message thinking blocks", {
            count: thinkingBlocks.length,
            hasText: thinkingBlocks.some(
              (b) => typeof b.thinking === "string" && b.thinking.length > 0,
            ),
            hadStreamThinking: state.hadThinkingTextFromStream,
          })
          if (!state.hadThinkingTextFromStream) {
            for (const block of thinkingBlocks) {
              if (block.thinking && block.thinking.length > 0) {
                noteReasoning(state)
                state.hadThinkingTextFromStream = true
                const thinkingId = generateId()
                state.controller.enqueue({
                  type: "reasoning-start",
                  id: thinkingId,
                } as any)
                state.controller.enqueue({
                  type: "reasoning-delta",
                  id: thinkingId,
                  delta: block.thinking,
                } as any)
                state.controller.enqueue({
                  type: "reasoning-end",
                  id: thinkingId,
                } as any)
              }
            }
          }
        }
      }
      if (
        msg.type === "assistant" &&
        msg.message?.content &&
        !state.gotPartialEvents
      ) {
        const hasText = msg.message.content.some(
          (b: any) => b.type === "text" && b.text,
        )
        const hasToolUse = msg.message.content.some(
          (b: any) => b.type === "tool_use",
        )

        if (hasText) {
          state.hasReceivedContent = true
        }

        // A usage limit does not reach us only as the result's error text:
        // measured live on CLI 2.1.288 (2026-10-03), the CLI answers with a
        // `<synthetic>` assistant frame carrying its own sentence ("You've hit
        // your individual spend limit · run /usage-credits …"), flagged
        // `is_api_error_message: true` and `error: "rate_limit"`, and THAT is
        // what reached the transcript. So the suppression the note needs lives
        // here as well as at the `result`, keyed on the same flag the model
        // chain uses to know a frame is the CLI's prose rather than Claude's
        // words.
        //
        // The frame has to say it is about the LIMIT, by its own `error` kind
        // or by its text, rather than merely arriving on a turn that saw a
        // rejection: a `server_error` reply on such a turn is a different
        // failure and its text is the only account of it. Reading it also
        // makes the note certain to fire at the result. (h #g194)
        const apiErrorReply = (msg as { is_api_error_message?: unknown })
          .is_api_error_message === true
        const limitErrorReply =
          apiErrorReply &&
          ctx.usageLimitNoteActive &&
          !state.accountBlock &&
          ((msg as { error?: unknown }).error === "rate_limit" ||
            isAccountLimitError({
              resultText: (msg.message.content as any[])
                .filter((b) => b.type === "text" && b.text)
                .map((b) => String(b.text))
                .join("\n"),
            }))
        if (limitErrorReply) {
          state.accountLimitHit ??= recallAccountLimit(ctx.sourceAccount)
        }

        if (hasText && !hasToolUse) {
          startResultFallback(state)
        }
        if (hasToolUse) {
          clearFallbackTimer(state)
        }

        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) {
            // The usage-limit note says this better and names the account,
            // which the CLI's sentence does not. Dropped rather than
            // rendered, so a limited turn carries exactly one block.
            if (limitErrorReply) continue
            // New text block — keep only this block's text in the
            // last-block buffer for final-answer detection.
            resetLastVisibleTextBlock(state)
            const blockId = state.startTextBlock()
            state.controller.enqueue({
              type: "text-delta",
              id: blockId,
              delta: block.text,
            })
            state.endTextBlock()
            noteVisibleText(state, block.text)
            state.hasReceivedContent = true
          }

          if (block.type === "thinking" && block.thinking) {
            noteReasoning(state)
            const thinkingId = generateId()
            state.controller.enqueue({
              type: "reasoning-start",
              id: thinkingId,
            } as any)
            state.controller.enqueue({
              type: "reasoning-delta",
              id: thinkingId,
              delta: block.thinking,
            } as any)
            state.controller.enqueue({
              type: "reasoning-end",
              id: thinkingId,
            } as any)
          }

          if (block.type === "tool_use" && block.id && block.name) {
            noteToolActivity(state)
            const parsedInput = (block.input ?? {}) as Record<
              string,
              unknown
            >

            if (isAskUserQuestionTool(block.name)) {
              const askId = state.startTextBlock()
              state.controller.enqueue({
                type: "text-delta",
                id: askId,
                delta: formatAskUserQuestion(parsedInput),
              })
              state.endTextBlock()
            } else if (block.name === "ExitPlanMode") {
              const plan = (parsedInput?.plan as string) || ""

              if (ctx.planModeQuestionActive) {
                const questionCall = createExitPlanModeQuestionCall(
                  state.sessionKey,
                  block.id,
                  plan,
                )
                const planId = state.startTextBlock()
                state.controller.enqueue({
                  type: "text-delta",
                  id: planId,
                  delta: questionCall.text,
                })
                finishWithQuestionCall(state, questionCall)
                return
              }

              const planId = state.startTextBlock()
              state.controller.enqueue({
                type: "text-delta",
                id: planId,
                delta: `\n\n${plan}\n\n---\n**Do you want to proceed with this plan?** (yes/no)\n`,
              })
              state.endTextBlock()
              // The TUI is parked on the approval dialog and will draw
              // nothing more until it is answered, so this step ends here and
              // the operator's reply answers it (h #g201).
              if (ctx.interactive) {
                finishAwaitingPlanApproval(state)
                return
              }
            } else if (
              isWebSearchTool(block.name) &&
              isWebSearchHandledByCli(ctx.config.webSearch)
            ) {
              // CLI-internal WebSearch: render the query as text and
              // drop the call/result parts (no opencode registry entry
              // for "WebSearch" — would render as an invalid tool row).
              state.toolCallsById.delete(block.id)
              const query =
                typeof parsedInput?.query === "string"
                  ? parsedInput.query
                  : JSON.stringify(parsedInput)
              const searchId = state.startTextBlock()
              state.controller.enqueue({
                type: "text-delta",
                id: searchId,
                delta: `\n> **Web search:** ${query}\n`,
              })
              state.endTextBlock()
            } else if (block.name.startsWith(PROXY_TOOL_PREFIX)) {
              noteProxyActivity(state)
              log.debug("ignoring proxy tool_use from assistant message", {
                name: block.name,
                id: block.id,
              })
            } else {
              const {
                name: mappedName,
                input: mappedInput,
                executed,
                skip,
              } = mapTool(block.name, parsedInput, {
                webSearch: ctx.config.webSearch,
                sessionId: getClaudeSessionId(state.sessionKey),
                toolUseId: block.id,
              })

              if (!skip) {
                state.toolCallsById.set(block.id, {
                  id: block.id,
                  name: mappedName,
                  input: parsedInput,
                })
                if (!executed) state.skipResultForIds.add(block.id)
                state.controller.enqueue({
                  type: "tool-input-start",
                  id: block.id,
                  toolName: mappedName,
                  providerExecuted: executed,
                } as any)
                emitCliToolCall(state, block.id, mappedName, JSON.stringify(mappedInput), executed)
              }
              log.info("tool_use from assistant message", {
                name: block.name,
                mappedName,
                id: block.id,
                executed,
              })
            }
          }

          if (block.type === "tool_result") {
            log.debug("tool_result", {
              toolUseId: block.tool_use_id,
            })
          }
        }
      }

      // user message (tool results from Claude CLI)
      if (msg.type === "user" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            if (state.skipResultForIds.has(block.tool_use_id)) {
              log.debug("skipping tool-result (opencode runs it)", {
                toolUseId: block.tool_use_id,
              })
              continue
            }

            let resultText = ""
            if (typeof block.content === "string") {
              resultText = block.content
            } else if (Array.isArray(block.content)) {
              resultText = block.content
                .filter(
                  (
                    c,
                  ): c is { type: string; text: string } =>
                    c.type === "text" &&
                    typeof c.text === "string",
                )
                .map((c) => c.text)
                .join("\n")
            }

            // Ledger hook: commit pending TaskCreate to opencode's todo
            // panel via a synthetic todowrite emission. Pass-through —
            // returns null for non-TaskCreate ids, so cheap and silent.
            const claudeSessionId = getClaudeSessionId(state.sessionKey)
            if (claudeSessionId) {
              const list = applyTaskCreateToolResult(
                claudeSessionId,
                block.tool_use_id,
                resultText,
              )
              if (list) {
                const synthId = `todowrite_${block.tool_use_id}`
                state.controller.enqueue({
                  type: "tool-input-start",
                  id: synthId,
                  toolName: "todowrite",
                  providerExecuted: false,
                } as any)
                state.controller.enqueue({
                  type: "tool-call",
                  toolCallId: synthId,
                  toolName: "todowrite",
                  input: JSON.stringify({
                    todos: list.map((t) => ({
                      id: t.id,
                      content: t.content,
                      status: t.status,
                      priority: "medium",
                    })),
                  }),
                  providerExecuted: false,
                } as any)
                noteToolActivity(state)
              }
            }

            // The CLI can send this result BEFORE the `content_block_stop`
            // that used to be the only place the call was registered, so the
            // name to pair the result under was simply absent and the result
            // was dropped. Measured on 2.1.286 for a `Write` the CLI refused:
            // the refusal frame arrives one line ahead of the block's close,
            // and opencode 2.x reports the unanswered row as "Provider did
            // not return a tool result". The open block already knows the
            // mapped name, so finish the part from it here; the block's own
            // close then finds the id already emitted and adds nothing
            // (h #g190).
            const toolCall =
              state.toolCallsById.get(block.tool_use_id) ??
              adoptOpenCliToolCall(state, ctx, block.tool_use_id)
            if (toolCall) {
              // A CLI-executed tool that failed carries `is_error`. The
              // AI SDK turns a `tool-result` with `isError` into a
              // `tool-error` part, which is what makes opencode render
              // the row as failed; without the flag every failed CLI
              // tool was forwarded as a success whose output happened
              // to be an error message.
              const isError = block.is_error === true
              state.controller.enqueue({
                type: "tool-result",
                toolCallId: block.tool_use_id,
                toolName: toolCall.name,
                result: {
                  output: resultText,
                  title: toolCall.name,
                  metadata: isError ? { error: true } : {},
                },
                ...(isError ? { isError: true } : {}),
                providerExecuted: true,
              } as any)
              noteToolActivity(state)
              log.info("tool result emitted", {
                toolUseId: block.tool_use_id,
                name: toolCall.name,
                isError,
              })
              state.toolCallsById.delete(block.tool_use_id)
              state.toolCallAnsweredIds.add(block.tool_use_id)
            }
          }
        }
      }

      // result - end of conversation turn
      if (msg.type === "result") {
        clearFallbackTimer(state)

        if (msg.session_id) {
          setClaudeSessionId(state.sessionKey, msg.session_id)
        }

        if (deliverPendingCompletions(state)) {
          // Finish the abandoned turn before submitting its late result.
          // Otherwise this result could close the stream for the new turn.
          return
        }

        // The other half of the limit signal: some rejections only ever
        // reach us as the error text of the terminal result. Read BEFORE the
        // error text is emitted below, because for this shape of limit that
        // text IS the limit and the note replaces it.
        if (
          !state.accountLimitHit &&
          msg.is_error &&
          isAccountLimitError({
            resultText: typeof msg.result === "string" ? msg.result : null,
          })
        ) {
          // The result's text says nothing about which window or when it
          // resets, so a limit the plugin has already seen on this account
          // supplies both (`recallAccountLimit`); a first-ever one is `{}`.
          state.accountLimitHit = recallAccountLimit(ctx.sourceAccount)
        }

        // The one place this is decided; see `TurnState.usageLimitNote`.
        state.usageLimitNote =
          ctx.usageLimitNoteActive &&
          !!state.accountLimitHit &&
          // An expired login or a billing hold writes its own note just below
          // and says what to run; two notes about one failure is one too many.
          !state.accountBlock &&
          msg.is_error === true

        // Some CLI failures only include user-readable text in
        // `result.result` (no prior assistant text blocks). Emit it so
        // opencode users don't see a blank turn. The one exception is a limit
        // the note is about to describe: the CLI's own sentence names no
        // account, gives the reset in UTC or not at all, and would sit
        // directly above a note saying the same thing better.
        if (
          !state.currentTextId &&
          msg.is_error &&
          !state.usageLimitNote &&
          typeof msg.result === "string" &&
          msg.result.trim().length > 0
        ) {
          const errId = state.startTextBlock()
          state.controller.enqueue({
            type: "text-delta",
            id: errId,
            delta: msg.result,
          })
        }

        // The other half of the refusal signal, for a CLI that reports
        // no assistant frame. The `result`'s own `subtype` is `success`
        // even here, so it can never be the thing that is read.
        if (ctx.modelFallbackArmed && !state.modelRefusal) {
          state.modelRefusal = modelRefusalFromResult(msg)
        }

        // Say which account and what to run. Without this the only
        // thing on screen was the CLI's "Failed to authenticate: OAuth
        // session expired", which names neither.
        if (state.accountBlock && msg.is_error) {
          // The CLI labels this result `success` with `is_error: true`,
          // so nothing else marks the turn failed; without this it
          // finished as an ordinary `stop` with the error as its answer.
          state.resultFailure ??= state.accountBlock
          const offeringSwitch = ctx.failoverAskActive
          state.controller.enqueue({
            type: "text-delta",
            id: state.startTextBlock(),
            delta: formatAccountBlockNote({
              kind: state.accountBlock,
              account: ctx.sourceAccount,
              configDir: ctx.config.configDir,
              offeringSwitch,
              // Read only when the form is not taking the turn, which is the
              // default: moving the work by hand is then the operator's only
              // route and nothing else on screen says it exists (h #g194).
              candidates: ctx.failoverAccounts,
            }),
          })
          state.endTextBlock()
          log.warn(`Claude account "${ctx.sourceAccount}" cannot serve requests`, {
            sessionKey: state.sessionKey,
            kind: state.accountBlock,
            offeringSwitch,
          })
        }

        // A non-`success` subtype is a failed turn. Name it in the
        // transcript and finish as an error, rather than letting it be
        // recorded as an ordinary reply with the subtype only in a
        // debug log line.
        const failure = describeResultFailure(msg)
        if (failure) {
          state.resultFailure = msg.subtype
          state.controller.enqueue({
            type: "text-delta",
            id: state.startTextBlock(),
            delta: formatResultFailureNote(failure),
          })
          log.warn(failure, { sessionKey: state.sessionKey, subtype: msg.subtype })
        }

        const turnStats = extractTurnStats(msg)
        state.resultMeta = {
          sessionId: msg.session_id,
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
          durationApiMs: msg.duration_api_ms,
          numTurns: msg.num_turns,
          usage: msg.usage,
          modelUsage: msg.modelUsage,
          // Names and ids only: a denial's `tool_input` can be a whole
          // file write payload and has no business in metadata.
          permissionDenials: msg.permission_denials?.map((denial) => ({
            tool_name: denial.tool_name,
            tool_use_id: denial.tool_use_id,
          })),
        }

        // Logged whatever `turnStats` is set to: the footer is a
        // display preference, the numbers are diagnostics.
        log.info("conversation result", {
          sessionId: msg.session_id,
          numTurns: msg.num_turns,
          isError: msg.is_error,
          subtype: msg.subtype,
          ...turnStatsLogPayload(turnStats),
        })

        // Never on a compaction turn (the footer would be appended to
        // what opencode stores as the summary) and never on a failed
        // one (the error is the thing to read, not the bill).
        if (ctx.config.turnStats && !ctx.compactionMode && !msg.is_error && !failure) {
          const footer = formatTurnStatsBlock(turnStats)
          if (footer) {
            state.controller.enqueue({
              type: "text-delta",
              id: state.startTextBlock(),
              delta: footer,
            })
          }
        }

        state.turnCompleted = true

        state.endTextBlock()

        const shouldDeferResult =
          !msg.is_error &&
          !state.autoContinueState.aborted &&
          !state.autoContinueState.sawAskUserQuestion

        if (state.drainBuffer.length > 0 && shouldDeferResult) {
          log.info(
            "waiting for parallel proxy calls at turn-result boundary",
            {
              sessionKey: state.sessionKey,
              count: state.drainBuffer.length,
            },
          )
          scheduleResultBoundary(
            state,
            () => ctx.completeResult(msg),
            DRAIN_QUIET_MS,
          )
          return
        }

        if (
          state.drainBuffer.length === 0 &&
          state.hadProxyActivitySinceContinue &&
          shouldDeferResult
        ) {
          log.info(
            "waiting for delayed proxy call at turn-result boundary",
            {
              sessionKey: state.sessionKey,
              graceMs: PROXY_RESULT_BOUNDARY_GRACE_MS,
            },
          )
          scheduleResultBoundary(
            state,
            () => ctx.completeResult(msg),
            PROXY_RESULT_BOUNDARY_GRACE_MS,
          )
          return
        }

        ctx.completeResult(msg)
      }
    } catch (e) {
      log.debug("failed to parse line", {
        error:
          e instanceof Error ? e.message : String(e),
      })
    }
  }
}
