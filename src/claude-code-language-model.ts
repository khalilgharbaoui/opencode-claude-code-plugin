import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3Warning,
} from "@ai-sdk/provider"
import { generateId } from "@ai-sdk/provider-utils"
import type {
  ClaudeCodeConfig,
  ControlRequestBehavior,
  ClaudeStreamMessage,
  ReasoningEffort,
} from "./types.js"
import { mapTool, isWebSearchTool, isWebSearchHandledByCli } from "./tool-mapping.js"
import { translateStreamForHost } from "./host-tools.js"
import { applyTaskCreateToolResult } from "./todo-ledger.js"
import {
  getClaudeUserMessage,
} from "./message-builder.js"
import { resolveAgentEffort, resolveAgentModel } from "./agent-models.js"
import {
  type ModelFallbackAttempt,
  type ModelRefusal,
  formatModelFallbackNote,
  modelRefusalFromAssistant,
  modelRefusalFromResult,
  nextFallbackModel,
  provesModelServing,
  resolveFallbackChain,
} from "./model-fallback.js"
import { parseSideQuestion, requestSideQuestion, collectSideQuestionHistory, SIDE_QUESTION_USAGE, type SideQuestionResult } from "./side-question.js"
import { BTW_NO_SESSION_MESSAGE, registerAsideSink, takeSideQuestionAnswer } from "./btw-command.js"
import {
  describeResultFailure,
  formatResultFailureNote,
  formatSilentTurnNote,
  formatStreamTimeoutNote,
  isRateLimitRejected,
  parseRateLimitEvent,
  reportCompactBoundary,
  reportConversationReset,
  reportRateLimitEvent,
  reportSystemInit,
} from "./cli-events.js"
import {
  DEFAULT_ACCOUNT,
  normalizeAccountName,
} from "./accounts.js"
import {
  accountBlockKind,
  buildFailoverContinuationPrompt,
  consumeAccountFailoverAnswer,
  createAccountFailoverQuestionCall,
  describeAccountBlock,
  failoverCandidates,
  failoverUntil,
  formatAccountBlockNote,
  formatFailoverNote,
  formatFailoverStopNote,
  isAccountFailoverQuestionActive,
  isAccountLimitError,
  resolveFailoverSpawn,
  setAccountOverride,
  type AccountBlockKind,
  type FailoverSpawn,
} from "./account-failover.js"
import { DOCTOR_COMMAND, buildDoctorReport, parseDoctorCommand } from "./doctor.js"
import {
  extractTurnStats,
  formatTurnStatsBlock,
  turnStatsLogPayload,
} from "./turn-stats.js"
import { resolveSkillPluginDirs } from "./skill-bridge.js"
import { parseModelId } from "./models.js"
import {
  consumeExitPlanModeQuestionResult,
  createExitPlanModeQuestionCall,
  type QuestionToolCall,
} from "./plan-mode-question.js"
import type { RuntimeMcpStatus } from "./mcp-bridge.js"
import {
  getRuntimeMcpStatus,
  fetchSessionParentId,
  resolveSpawnCwdForSession,
  fetchSessionRunState,
  settleSessionRunState,
} from "./runtime-status.js"
import {
  getActiveProcess,
  setActiveProcess,
  spawnClaudeProcess,
  buildCliArgs,
  setClaudeSessionId,
  getClaudeSessionId,
  deleteClaudeSessionId,
  deleteActiveProcess,
  deleteActiveProcessAndWait,
  respawnActiveProcess,
  resolveIdleProcessTimeoutMs,
  scheduleIdleProcessEviction,
  noteTurnStarted,
  isTurnInFlight,
  interruptTurn,
  takeUnattendedLines,
  describeChildCrash,
  isClaudeThinkingDisabled,
  sessionKey,
  effortSessionKey,
  invalidateOtherEffortSessions,
  describeSessionKey,
} from "./session-manager.js"
import { spawnInteractiveProcess } from "./claude-session-wrapper.js"
import {
  clearCompression,
  consumeCompressionRestart,
  getCompressionSummary,
} from "./compression-store.js"
import { log } from "./logger.js"
import { detectCliVersion } from "./cli-version.js"
import {
  resolveDisallowedTools,
  resolveProxyOpencodeToolDefs,
  overlayTaskProxyDescription,
  overlayQuestionProxyDescription,
  filterQuestionProxyByOpencodeSupport,
  PROXY_TOOL_PREFIX,
  TASK_BATCH_TOOL_NAME,
  taskBatchTasks,
  taskBatchChildToolCallId,
  setProxyDeadlineGuard,
  type McpProxyToolResolution,
  type ModelToolEntry,
  type ProxyMcpServer,
  type ProxyToolDef,
  type ProxyToolResult,
} from "./proxy-mcp.js"
import {
  findPendingProxyCall,
  getPendingProxyCalls,
  isPendingProxyCallChannelClosed,
  markPendingProxyCallEmitted,
  onPendingProxyCall,
  rejectAllPendingProxyCallsForSession,
  rejectPendingProxyCallById,
  resolvePendingProxyCallById,
  type PendingProxyCall,
} from "./proxy-broker.js"
import {
  buildAppendedSystemPrompt,
  extractSystemMessages,
  QUESTION_PROXY_HINT,
  SUBAGENT_DISPATCH_HINT,
} from "./prompts.js"
import {
  autoContinueEnabledFor,
  continuationSignature,
  isSilentTurn,
  makeAutoContinueMessage,
  shouldAutoContinueIncompleteTurn,
  type AutoContinueState,
} from "./auto-continue.js"
import {
  denyMessageForTool,
  formatAskUserQuestion,
  isAskUserQuestionTool,
} from "./ask-user-question.js"
import { reportFastModeState } from "./fast-mode.js"
import {
  describeAbortReason,
  hasNewUserContent,
  resolveCompactionModel,
  resolveOpencodeAgent,
  resolveSessionAffinity,
} from "./call-options.js"
import {
  extractPendingProxyResultForCall,
  makeLateProxyResultMessage,
} from "./proxy-results.js"
import {
  controlRequestBehaviorForTool,
  handleControlRequest,
  writeControlResponse,
} from "./control-request.js"
import {
  createLiveToolInfoLoader,
  effectiveMcpConfig,
  ensureProxyServer,
  fetchLiveToolInfo,
  resolvedProxyMcpTools,
  resolvedProxyTools,
  resolvePlanModeQuestion,
  skillBridgeSpawn,
  stripContextRemindersEnabled,
  type LiveToolInfo,
} from "./spawn-planning.js"
import {
  isTitleRequest,
  latestUserText,
  requestScope,
  synthesizeTitle,
} from "./title.js"
import { toFinishReason, toUsage } from "./usage.js"
import { createTurnState } from "./turn-state.js"

// Re-exported so importers that have always reached for these here keep
// working after the split. The definitions live in the modules named above.
export {
  buildAppendedSystemPrompt,
  QUESTION_PROXY_HINT,
  SUBAGENT_DISPATCH_HINT,
} from "./prompts.js"
export type { AppendedSystemPromptOptions } from "./prompts.js"
export {
  autoContinueEnabledFor,
  isSilentTurn,
  shouldAutoContinueIncompleteTurn,
} from "./auto-continue.js"
export { denyMessageForTool, isAskUserQuestionTool } from "./ask-user-question.js"
export { reportFastModeState, _resetFastModeWarnings } from "./fast-mode.js"
export {
  DEFAULT_COMPACTION_MODEL,
  describeAbortReason,
  hasNewUserContent,
  resolveCompactionModel,
  resolveOpencodeAgent,
  resolveSessionAffinity,
} from "./call-options.js"
export { makeLateProxyResultMessage } from "./proxy-results.js"

/**
 * Whether opencode is still serving a proxied call whose deadline just passed.
 * Only a call opencode was actually handed (`emitted`), in a session opencode
 * positively reports `busy`, is kept: that is a permission prompt still open
 * or the tool itself still running. Anything else, including `unknown` (no
 * SDK client, no status route, the no-affinity `default` session), ends at
 * the deadline exactly as before.
 */
export async function isProxyCallStillServed(callId: string): Promise<boolean> {
  const pending = findPendingProxyCall(callId)
  if (!pending || pending.emitted !== true) return false
  const session = describeSessionKey(pending.sessionKey).session
  return (await fetchSessionRunState(session)) === "busy"
}

setProxyDeadlineGuard(({ callId }) => isProxyCallStillServed(callId))

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
// Quiet window the batched drain and the result boundary share, so claude
// CLI's parallel tool_use blocks leave in one tool-calls finish.
const DRAIN_QUIET_MS = 100
// How long a turn that lost its child waits for that child's exit status
// before reporting the crash without one.
const CHILD_EXIT_STATUS_GRACE_MS = 250

/**
 * Which host method the turn was entered through. There is one turn
 * implementation and `"generate"` changes exactly one thing inside it: the
 * account-failover dialog is neither offered nor read back. A `doGenerate`
 * caller must still follow the account the conversation was moved to, but it
 * must not put a question in a session the operator is usually not looking at
 * (the account-failover invariant that says it takes the override with no
 * dialog of its own).
 */
type TurnMode = "stream" | "generate"

export class ClaudeCodeLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  readonly modelId: string
  private readonly config: ClaudeCodeConfig

  constructor(modelId: string, config: ClaudeCodeConfig) {
    this.modelId = modelId
    this.config = config
  }

  readonly supportedUrls: Record<string, RegExp[]> = {}

  get provider(): string {
    return this.config.provider
  }

  private toUsage(rawUsage?: ClaudeStreamMessage["usage"]): LanguageModelV3Usage {
    return toUsage(rawUsage)
  }

  private toFinishReason(
    reason: "stop" | "tool-calls" | "error" = "stop",
  ): LanguageModelV3FinishReason {
    return toFinishReason(reason)
  }

  /**
   * Whether this call only names the session, which gets the synthetic stub
   * rather than a `claude` spawn. See `isTitleRequest` in title.ts.
   */
  private isTitleRequest(
    scope: "tools" | "no-tools",
    options: LanguageModelV3CallOptions,
  ): boolean {
    return isTitleRequest(this.config, scope, options)
  }

  private requestScope(options: { tools?: unknown }): "tools" | "no-tools" {
    return requestScope(options)
  }

  /**
   * Build the combined `--mcp-config` list and return both the list and the
   * hash of the bridged opencode MCP block. See `effectiveMcpConfig` in
   * spawn-planning.ts.
   */
  private effectiveMcpConfig(
    cwd: string,
    proxyConfigPath?: string,
    runtimeStatus?: RuntimeMcpStatus,
    excludeServers?: ReadonlySet<string>,
  ): {
    paths: string[]
    bridgedHash: string | null
    allEnabledServerNames: string[]
  } {
    return effectiveMcpConfig(
      this.config,
      cwd,
      proxyConfigPath,
      runtimeStatus,
      excludeServers,
    )
  }

  /** Resolve ProxyToolDef[] for the configured proxyTools names. */
  private resolvedProxyTools(): ProxyToolDef[] | null {
    return resolvedProxyTools(this.config)
  }

  /** Resolve ProxyToolDef[] for opencode's MCP-backed tools. */
  private resolvedProxyMcpTools(
    allEnabledServerNames: string[],
    modelTools: readonly ModelToolEntry[] | undefined,
    taken?: ReadonlySet<string>,
  ): McpProxyToolResolution | null {
    return resolvedProxyMcpTools(
      this.config,
      allEnabledServerNames,
      modelTools,
      taken,
    )
  }

  /** One `client.tool.list()` fetch, shaped for this turn's gates. */
  private async fetchLiveToolInfo(): Promise<LiveToolInfo> {
    return fetchLiveToolInfo(this.config, this.modelId)
  }

  /**
   * Whether dcp-style context reminders should be stripped from this turn's
   * messages. Config-only and synchronous, so it can be answered before the
   * spawn block resolves anything: `userMsg` is built well ahead of it.
   */
  private stripContextRemindersEnabled(): boolean {
    return stripContextRemindersEnabled(this.config)
  }

  /**
   * Arguments the skill bridge needs beyond `cwd` / `cliPath`: which
   * `CLAUDE_CONFIG_DIR` this spawn reads its native skills from, and whether
   * to drop the ones it already loads.
   */
  private skillBridgeSpawn(failover: FailoverSpawn): {
    configDir: string | undefined
    skipNative: boolean
  } {
    return skillBridgeSpawn(this.config, failover)
  }

  /** Share one lazy registry request within a turn without making it stale. */
  private createLiveToolInfoLoader(): () => Promise<LiveToolInfo> {
    return createLiveToolInfoLoader(this.config, this.modelId)
  }

  /**
   * Whether the ExitPlanMode approval bridge is live for this turn: the
   * operator opted in AND opencode's registry actually has the `question`
   * tool. Without the registry entry the emitted tool-call would render as
   * `⚙ invalid` and wedge the turn, so the plugin keeps the text path.
   */
  private async resolvePlanModeQuestion(
    compactionMode: boolean,
    loadLiveToolInfo = () => this.fetchLiveToolInfo(),
  ): Promise<boolean> {
    return resolvePlanModeQuestion(this.config, compactionMode, loadLiveToolInfo)
  }

  /**
   * Create a proxy MCP server for a single active Claude process/session.
   * The process lifecycle owns the server lifecycle via session-manager.
   */
  private async ensureProxyServer(
    tools: ProxyToolDef[],
    sessionKeyForCalls: string,
    interceptCompress: boolean,
  ): Promise<ProxyMcpServer> {
    return ensureProxyServer(
      this.config,
      tools,
      sessionKeyForCalls,
      interceptCompress,
    )
  }

  /**
   * Resolve the session affinity token for this LLM call. Delegates to the
   * exported `resolveSessionAffinity` helper so the logic is unit-testable.
   * Priority:
   *   1. `x-session-affinity` request header (primary).
   *   2. `opencodeSessionID` in providerOptions (chat.params hook fallback —
   *      covers provider switches mid-session and title synthesis paths
   *      where the header is absent).
   *   3. `"default"`.
   */
  private sessionAffinity(
    options: LanguageModelV3CallOptions,
  ): string {
    const headers = (options as any)?.headers as
      | Record<string, string | undefined>
      | undefined
    return resolveSessionAffinity(
      headers,
      options.providerOptions as Record<string, unknown> | undefined,
      this.config.provider,
    )
  }

  private controlRequestBehaviorForTool(toolName: string): ControlRequestBehavior {
    return controlRequestBehaviorForTool(this.config, toolName)
  }

  private writeControlResponse(
    proc: import("child_process").ChildProcess,
    requestId: string,
    response?: Record<string, unknown>,
  ): void {
    writeControlResponse(proc, requestId, response)
  }

  /**
   * Handle Claude stream-json control requests (`can_use_tool`, etc.) and
   * respond via stdin with a matching `control_response`.
   */
  private handleControlRequest(
    msg: ClaudeStreamMessage,
    proc: import("child_process").ChildProcess,
  ): boolean {
    return handleControlRequest(this.config, msg, proc)
  }

  private getReasoningEffort(
    providerOptions?: LanguageModelV3CallOptions["providerOptions"],
  ): ReasoningEffort | undefined {
    if (!providerOptions) return undefined
    const ownKey = this.config.provider
    const bag =
      (providerOptions as any)[ownKey] ??
      (providerOptions as any)["claude-code"]
    const effort = bag?.reasoningEffort
    const valid: ReasoningEffort[] = [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]
    return valid.includes(effort) ? effort : undefined
  }

  private getOpencodeAgent(options: LanguageModelV3CallOptions): string | undefined {
    return resolveOpencodeAgent(
      (options as any)?.headers as Record<string, string | undefined> | undefined,
      options.providerOptions as Record<string, unknown> | undefined,
      this.config.provider,
    )
  }

  private isCompactionCall(
    options: LanguageModelV3CallOptions,
  ): boolean {
    return this.getOpencodeAgent(options) === "compaction"
  }

  /**
   * Pick the model used to handle /compact. Precedence:
   *   1. `CLAUDE_CODE_COMPACTION_MODEL` env var (per-process override)
   *   2. `compactionModel` provider setting (opencode.json / .jsonc)
   *   3. Built-in default (claude-haiku-4-5)
   */
  private resolveCompactionModel(): string {
    return resolveCompactionModel(this.config.compactionModel)
  }

  private thinkingCliOptions(): {
    thinking?: "enabled"
    thinkingDisplay?: "summarized"
  } {
    if (isClaudeThinkingDisabled()) return {}

    return {
      thinking: "enabled",
      thinkingDisplay:
        process.env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES === undefined
          ? "summarized"
          : undefined,
    }
  }

  private latestUserText(
    prompt: LanguageModelV3CallOptions["prompt"],
  ): string {
    return latestUserText(prompt)
  }

  private synthesizeTitle(
    prompt: LanguageModelV3CallOptions["prompt"],
  ): string {
    return synthesizeTitle(prompt)
  }

  /**
   * Aggregates the one turn implementation into a `doGenerate` result.
   *
   * `doGenerate` used to carry a second copy of `doStreamForHost`'s line
   * parser: no inactivity watchdog, no `/claude-code-doctor`, no proxy or MCP
   * wiring, no auto-continue, no turn stats, and no test of its own. Three of
   * its own branches (a `/btw` aside, proxied tools, compaction) already bailed
   * out to this method. The copy is deleted and every `doGenerate` call is now
   * this aggregation, so a fix to the turn lands once.
   *
   * Tool parts arrive already in the host's vocabulary, because `streamTurn`
   * rewrites them once at the stream's edge (src/host-tools.ts). Nothing is
   * translated a second time here.
   */
  private async doGenerateViaStream(
    options: LanguageModelV3CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV3["doGenerate"]>>> {
    // The deleted copy logged `doGenerate starting`, which is how anyone
    // reading plugin.log could tell the two paths apart. Keep a line here: it
    // is the only fingerprint that opencode used this host method at all.
    log.info("doGenerate aggregating the stream", {
      scope: this.requestScope(options as any),
      opencodeAgent: this.getOpencodeAgent(options),
    })
    const result = await this.streamTurn(options, "generate")
    const reader = result.stream.getReader()

    let text = ""
    let reasoning = ""
    const toolCalls: LanguageModelV3Content[] = []
    let finishReason = this.toFinishReason("stop")
    let usage: LanguageModelV3Usage = this.toUsage()
    let providerMetadata: any

    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      switch ((value as any).type) {
        case "text-delta":
          text += (value as any).delta ?? ""
          break
        case "reasoning-delta":
          reasoning += (value as any).delta ?? ""
          break
        case "tool-call":
          toolCalls.push({
            type: "tool-call",
            toolCallId: (value as any).toolCallId,
            toolName: (value as any).toolName,
            input: (value as any).input,
            providerExecuted: (value as any).providerExecuted,
          } as any)
          break
        case "finish":
          finishReason = (value as any).finishReason ?? finishReason
          usage = (value as any).usage ?? usage
          providerMetadata = (value as any).providerMetadata ?? providerMetadata
          break
      }
    }

    const content: LanguageModelV3Content[] = []
    if (reasoning) {
      content.push({ type: "reasoning", text: reasoning } as any)
    }
    if (text) {
      content.push({ type: "text", text, providerMetadata } as any)
    }
    content.push(...toolCalls)

    // The claude session id, when the turn had one, exactly as the deleted
    // copy reported it: opencode shows this id and a stub has none.
    const sessionId = (providerMetadata as any)?.["claude-code"]?.sessionId

    return {
      content,
      finishReason,
      usage,
      request: result.request,
      response: {
        id: typeof sessionId === "string" && sessionId ? sessionId : generateId(),
        timestamp: new Date(),
        modelId: this.modelId,
      },
      providerMetadata,
      warnings: [],
    }
  }

  /**
   * One turn implementation serves both host methods, so this is `doStream`
   * aggregated. The host's tool vocabulary is applied inside `streamTurn`,
   * which is why nothing is renamed here.
   */
  async doGenerate(
    options: LanguageModelV3CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV3["doGenerate"]>>> {
    return this.doGenerateViaStream(options)
  }

  /**
   * Tool parts leave in opencode 1.x's vocabulary; on opencode 2.x they are
   * renamed at this one edge (src/host-tools.ts). On V1 the stream is
   * returned untouched.
   */
  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV3["doStream"]>>> {
    return this.streamTurn(options, "stream")
  }

  /**
   * The turn, for both host methods. `mode` is documented on `TurnMode`; it is
   * threaded down to `doStreamForHost` rather than read from the call options,
   * because which method opencode used is not in them.
   */
  private async streamTurn(
    options: LanguageModelV3CallOptions,
    mode: TurnMode,
  ): Promise<Awaited<ReturnType<LanguageModelV3["doStream"]>>> {
    const result = await this.runModelChain(options, mode)
    return {
      ...result,
      stream: translateStreamForHost(result.stream as any, this.config.hostApi ?? "v1") as any,
    }
  }

  /**
   * Run the turn, moving to the next model in the fallback chain if the one
   * it started on is refused. The single wiring point for `src/model-fallback.ts`.
   *
   * With no chain declared (the default) this is `doStreamForHost` and one
   * `await`, so nothing about an existing install changes. With a chain, one
   * rule carries the whole design: **an attempt's parts are withheld until it
   * proves the model is serving**, and a refused attempt is then discarded
   * whole rather than edited. That is what keeps the CLI's "There's an issue
   * with the selected model" text out of the operator's transcript and out of
   * any replay, and it costs nothing on a served turn, because the very first
   * content block commits the attempt and every later part passes straight
   * through.
   *
   * The bound is `tried`: one turn spawns each model at most once, in order,
   * and an exhausted chain leaves the last attempt un-armed so its error
   * surfaces exactly as it does today.
   */
  private async runModelChain(
    options: LanguageModelV3CallOptions,
    mode: TurnMode,
  ): Promise<Awaited<ReturnType<LanguageModelV3["doStream"]>>> {
    const agent = this.getOpencodeAgent(options)
    const chain = this.isCompactionCall(options)
      ? []
      : resolveFallbackChain(agent, resolveAgentModel(agent, this.modelId))
    if (chain.length === 0) return this.doStreamForHost(options, undefined, mode)

    const self = this
    const tried = new Set<string>()
    let attempt: ModelFallbackAttempt = { armed: true }
    let inner = await this.doStreamForHost(options, attempt, mode)
    const request = inner.request

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        let pendingNote: string | null = null
        try {
          for (;;) {
            if (attempt.modelId) tried.add(attempt.modelId)

            const buffered: LanguageModelV3StreamPart[] = []
            let flushed = false
            const emitNote = (note: string) => {
              const id = generateId()
              controller.enqueue({ type: "text-start", id } as any)
              controller.enqueue({ type: "text-delta", id, delta: note })
              controller.enqueue({ type: "text-end", id })
            }
            // The note belongs after `stream-start`, which is always the
            // serving attempt's first part, and in its own text part so
            // `PLUGIN_NOTE_MARKERS` can strip it from a rebuilt transcript.
            const flush = () => {
              if (flushed) return
              flushed = true
              for (const part of buffered) {
                controller.enqueue(part)
                if (pendingNote && (part as { type?: string }).type === "stream-start") {
                  emitNote(pendingNote)
                  pendingNote = null
                }
              }
              buffered.length = 0
              if (pendingNote) {
                emitNote(pendingNote)
                pendingNote = null
              }
            }

            const reader = inner.stream.getReader()
            try {
              for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                if (flushed) {
                  controller.enqueue(value)
                  continue
                }
                buffered.push(value)
                if (attempt.serving) flush()
              }
            } finally {
              reader.releaseLock()
            }

            const refusal = attempt.refusal
            const next =
              refusal && !attempt.serving
                ? nextFallbackModel(chain, tried)
                : undefined
            if (!next || !refusal) {
              flush()
              break
            }

            // Everything the refused model emitted goes in the bin: its only
            // output was the CLI's own error, which was never Claude's answer.
            buffered.length = 0
            pendingNote = formatModelFallbackNote({
              failed: attempt.modelId ?? self.modelId,
              serving: next,
              refusal,
            })
            log.notice("falling back to the next model in the chain", {
              from: attempt.modelId ?? self.modelId,
              to: next,
              reason: refusal.kind,
              tried: [...tried],
            })
            tried.add(next)
            attempt = {
              modelOverride: next,
              armed: nextFallbackModel(chain, tried) !== undefined,
            }
            inner = await self.doStreamForHost(options, attempt, mode)
          }
        } catch (error) {
          controller.enqueue({ type: "error", error })
        } finally {
          try {
            controller.close()
          } catch {}
        }
      },
    })

    return { stream, request }
  }

  private async doStreamForHost(
    options: LanguageModelV3CallOptions,
    attempt?: ModelFallbackAttempt,
    mode: TurnMode = "stream",
  ): Promise<Awaited<ReturnType<LanguageModelV3["doStream"]>>> {
    const warnings: SharedV3Warning[] = []
    const skipPermissions = this.config.skipPermissions !== false
    const scope = this.requestScope(options as any)
    const affinity = this.sessionAffinity(options)
    const cwd = await resolveSpawnCwdForSession(this.config.cwd, affinity)
    const compactionMode = this.isCompactionCall(options)
    // Use a separate session key for compaction so its short-lived spawn
    // never collides with the main conversation's claude process.
    // A fallback attempt replaces the model NAME and nothing else, which is
    // the same swap `resolveAgentModel` performs and the reason the chain
    // needs no separate plumbing: the id flows into the session key, the
    // effort key, the spawn, the logs and the metadata exactly as a
    // `forceModel` would. Compaction is never given one.
    const effectiveModelId = compactionMode
      ? this.resolveCompactionModel()
      : (attempt?.modelOverride ??
        resolveAgentModel(
          this.getOpencodeAgent(options),
          this.modelId,
        ))
    if (attempt) attempt.modelId = effectiveModelId
    // Compaction skips request/agent effort overrides; other calls key on it.
    const reasoningEffort = compactionMode
      ? undefined
      : (resolveAgentEffort(
          this.getOpencodeAgent(options),
          this.getReasoningEffort(options.providerOptions),
        ) as ReasoningEffort | undefined)
    const baseKey = sessionKey(
      cwd,
      `${effectiveModelId}::${scope}::${affinity}::context=${JSON.stringify([this.config.provider, this.getOpencodeAgent(options) ?? null])}`,
    )
    const sk = compactionMode
      ? sessionKey(cwd, `${effectiveModelId}::compaction::${affinity}`)
      : effortSessionKey(baseKey, reasoningEffort)
    const toUsage = this.toUsage.bind(this)
    const toFinishReason = this.toFinishReason.bind(this)
    const handleControlRequest = this.handleControlRequest.bind(this)
    const flagOn = (v: string | undefined) =>
      v !== undefined &&
      !["", "0", "false", "no", "off"].includes(v.trim().toLowerCase())
    // Interactive (subscription) transport: drive the claude TUI over Bun's
    // native ConPTY + JSONL tail instead of headless `--print` stream-json.
    // Prefer the provider option (config-driven, reliable in the GUI app where
    // process env vars are not inherited); fall back to the env var. Self-healing:
    // if Bun.Terminal is unavailable (e.g. not under Bun), use the headless path.
    const interactivePref =
      this.config.interactive ??
      flagOn(process.env.CLAUDE_CODE_INTERACTIVE_TRANSPORT)
    const useInteractive =
      interactivePref && typeof (globalThis as any).Bun?.Terminal === "function"
    const interactiveBypassRequested =
      this.config.interactiveBypass ??
      flagOn(process.env.CLAUDE_CODE_INTERACTIVE_BYPASS)

    // Whether this attempt may be thrown away and retried on the next model.
    // Compaction is out because its answer is a stored summary and a second
    // model would rewrite it; the interactive transport is out because it
    // drives a TUI over a PTY and has no `result` frame of this shape to read
    // a refusal from. A `doGenerate` turn is armed like any other now that it
    // is this same code: a title stub returns before reaching here, so what a
    // chain can reach is a real spawn, and a refusal there is worth retrying.
    const modelFallbackArmed =
      attempt?.armed === true && !compactionMode && !useInteractive

    // Account failover. When a previous turn hit this account's usage limit
    // and the operator picked another account, every turn from then on spawns
    // that account's wrapper instead, until the limit's reset time. The
    // override is keyed on the ACCOUNT, so it covers every session running on
    // it, subagents included. Resolved here, before anything reads `cliPath`.
    //
    // Excluded for the interactive transport, which drives a TUI over a PTY
    // with no proxy server: nothing in that path can show the form or replay
    // the conversation, so it keeps the plain rate-limit error.
    const sourceAccount = normalizeAccountName(
      this.config.account ?? DEFAULT_ACCOUNT,
    )
    const baseCliPath = this.config.baseCliPath ?? this.config.cliPath
    let failover: FailoverSpawn =
      useInteractive || compactionMode
        ? { cliPath: this.config.cliPath, modelId: effectiveModelId, failedOver: false }
        : await resolveFailoverSpawn({
            account: sourceAccount,
            baseCliPath,
            cliPath: this.config.cliPath,
            modelId: effectiveModelId,
          })
    let cliPath = failover.cliPath

    // Tagged onto the process each turn so the /btw command hook, which only
    // knows the opencode session id, can find it and ask it early
    // (btw-command.ts).
    const asideTransportRef = { cliPath, interactive: !!useInteractive }

    // `/claude-code-doctor` is answered here, by the plugin, with no CLI
    // inference at all: everything in the report is already in this process.
    // Same shape as the aside branch below, and the exchange is stripped from
    // rebuilt transcripts the same way a `/btw` pair is.
    const doctor =
      !compactionMode && scope !== "no-tools" ? parseDoctorCommand(options.prompt) : null
    if (doctor) {
      const doctorOptions = {
        cliPath,
        interactive: !!useInteractive,
        turnStats: this.config.turnStats === true,
      }
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings })
          try {
            const text = await buildDoctorReport(doctorOptions)
            const id = generateId()
            controller.enqueue({ type: "text-start", id })
            controller.enqueue({ type: "text-delta", id, delta: text })
            controller.enqueue({ type: "text-end", id })
            controller.enqueue({
              type: "finish",
              finishReason: toFinishReason("stop"),
              usage: toUsage({ input_tokens: 0, output_tokens: 0 }),
              providerMetadata: {
                "claude-code": { path: "doctor", synthetic: true, usageUnavailable: true },
              },
            })
          } catch (error) {
            controller.enqueue({ type: "error", error })
          } finally {
            controller.close()
          }
        },
      })
      return { stream, request: { body: { text: `/${DOCTOR_COMMAND}` } } }
    }

    const aside = !compactionMode && scope !== "no-tools" ? parseSideQuestion(options.prompt) : null
    if (aside) {
      // `/btw` is an ordinary user message in this conversation, so opencode
      // keeps the exchange, but it is answered over the CLI's side_question
      // control channel, never as a turn. The command hook normally sent the
      // question ahead, while the previous turn was still streaming, and its
      // answer is taken here; otherwise the process is idle now and is asked
      // directly. Earlier asides in this conversation ride along as history.
      const active = getActiveProcess(sk)
      const early = aside.question ? takeSideQuestionAnswer(affinity, aside.question) : undefined
      const history = collectSideQuestionHistory(options.prompt)
      const answerAside = async (): Promise<SideQuestionResult> => {
        if (!aside.question) return { response: SIDE_QUESTION_USAGE, synthetic: true }
        if (early) {
          try {
            return await early
          } catch (error) {
            log.info("btw: early answer failed, asking the idle process", { error: String(error) })
          }
        }
        if (!active) return { response: BTW_NO_SESSION_MESSAGE, synthetic: true }
        return requestSideQuestion(active, aside.question, {
          cliVersion: await detectCliVersion(cliPath),
          interactive: useInteractive,
          abortSignal: options.abortSignal,
          ...(history.length ? { history } : {}),
        })
      }
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings })
          try {
            const answer = await answerAside()
            const id = generateId()
            controller.enqueue({ type: "text-start", id })
            controller.enqueue({ type: "text-delta", id, delta: answer.response })
            controller.enqueue({ type: "text-end", id })
            controller.enqueue({
              type: "finish",
              finishReason: toFinishReason("stop"),
              usage: toUsage({}),
              providerMetadata: { "claude-code": { path: "side-question", synthetic: answer.synthetic, usageUnavailable: true } },
            })
          } catch (error) {
            controller.enqueue({ type: "error", error })
          } finally {
            controller.close()
          }
        },
      })
      return { stream, request: { body: { text: aside.question } } }
    }

    if (this.isTitleRequest(scope, options) && !compactionMode) {
      log.info("doStream no-tools title stub", {
        compactionMode,
        opencodeAgent: this.getOpencodeAgent(options),
        providerOptionsKeys: options.providerOptions
          ? Object.keys(options.providerOptions)
          : [],
      })
      const text = this.synthesizeTitle(options.prompt)
      const textId = generateId()
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings })
          controller.enqueue({ type: "text-start", id: textId } as any)
          controller.enqueue({
            type: "text-delta",
            id: textId,
            delta: text,
          })
          controller.enqueue({ type: "text-end", id: textId })
          controller.enqueue({
            type: "finish",
            finishReason: toFinishReason("stop"),
            usage: toUsage({ input_tokens: 0, output_tokens: 0 }),
            providerMetadata: {
              "claude-code": {
                synthetic: true,
                path: "no-tools",
              },
            },
          })
          controller.close()
        },
      })

      return {
        stream,
        request: { body: { text: "" } },
      }
    }

    // Short-circuit when opencode iterates the agent loop one more time
    // after a turn already finished. The prompt ends with an assistant
    // message and has no fresh user input — spawning Claude here would
    // just produce a stub like "No input received. Standing by".
    if (!hasNewUserContent(options.prompt)) {
      log.info("doStream short-circuit: no new user content")
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings })
          controller.enqueue({
            type: "finish",
            finishReason: toFinishReason("stop"),
            usage: toUsage({ input_tokens: 0, output_tokens: 0 }),
            providerMetadata: {
              "claude-code": { synthetic: true, path: "no-new-user-content" },
            },
          })
          controller.close()
        },
      })
      return { stream, request: { body: { text: "" } } }
    }

    if (!compactionMode) invalidateOtherEffortSessions(baseKey, reasoningEffort)

    const hasPriorConversation =
      options.prompt.filter((m) => m.role === "user" || m.role === "assistant")
        .length > 1

    // New session — clear any stale state from a previous session.
    // A compression summary is scoped to one conversation, so this is the
    // one place it is dropped: the compress restart itself calls
    // deleteClaudeSessionId, and clearing there would wipe the summary
    // just before the fresh spawn reads it.
    if (!hasPriorConversation) {
      deleteClaudeSessionId(sk)
      deleteActiveProcess(sk)
      clearCompression(sk)
    }

    // The operator's answer to a failover form this session asked on an
    // earlier turn. Consumed before the session/process state below is read,
    // because a switch changes which account those belong to.
    // A `doGenerate` turn asks nothing (see `TurnMode`), so it has no answer of
    // its own to read either: it follows the account override and no more.
    const failoverAnswer =
      compactionMode || useInteractive || mode === "generate"
        ? null
        : consumeAccountFailoverAnswer(sk, options.prompt as any, {
            sourceAccount,
            candidates: failoverCandidates(this.config.failoverAccounts, sourceAccount),
          })

    if (failoverAnswer?.kind === "stop") {
      // Dismissed, answered `stop`, or answered with something that is not
      // one of the offered accounts. End the turn the way the rate-limit
      // error ends it today: no CLI inference, nothing spawned.
      log.warn("account failover declined; ending the turn", {
        sessionKey: sk,
        account: sourceAccount,
        reason: failoverAnswer.reason,
      })
      const note = formatFailoverStopNote(failoverAnswer.reason)
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings })
          const id = generateId()
          controller.enqueue({ type: "text-start", id } as any)
          controller.enqueue({ type: "text-delta", id, delta: note })
          controller.enqueue({ type: "text-end", id })
          controller.enqueue({
            type: "error",
            error: new Error(
              `Claude account "${sourceAccount}" is out of usage and no other account was picked.`,
            ),
          })
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "error" as const, raw: "account_limit" },
            usage: toUsage({ input_tokens: 0, output_tokens: 0 }),
            providerMetadata: {
              "claude-code": {
                path: "account-failover-stop",
                synthetic: true,
                usageUnavailable: true,
              },
            },
          })
          controller.close()
        },
      })
      return { stream, request: { body: { text: "" } } }
    }

    // The pick applies from this turn on, so re-resolve before the spawn
    // reads anything: this turn is the one that continues the task.
    let failoverNote: string | null = null
    if (failoverAnswer?.kind === "switch") {
      setAccountOverride(
        failoverAnswer.sourceAccount,
        failoverAnswer.target,
        failoverUntil(failoverAnswer.resetsAt),
      )
      failover = await resolveFailoverSpawn({
        account: sourceAccount,
        baseCliPath,
        cliPath: this.config.cliPath,
        modelId: effectiveModelId,
      })
      cliPath = failover.cliPath
      asideTransportRef.cliPath = cliPath
      failoverNote = formatFailoverNote({
        sourceAccount: failoverAnswer.sourceAccount,
        target: failoverAnswer.target,
        resetsAt: failoverAnswer.resetsAt,
      })
    }

    // A live process belongs to the account it was spawned with, and its
    // Claude transcript lives under that account's config dir, so neither can
    // follow the conversation across a switch. Dropping both here (before
    // `includeHistoryContext` is computed) is what turns the switch into a
    // fresh session with the thread replayed, and it is equally what switches
    // back once the override expires. The `?.cliPath &&` guard keeps the
    // interactive shim, which carries no path, out of it.
    const processForAccount = getActiveProcess(sk)
    if (
      !compactionMode &&
      !useInteractive &&
      processForAccount?.cliPath &&
      processForAccount.cliPath !== cliPath
    ) {
      log.notice("claude process belongs to another account; starting fresh", {
        sessionKey: sk,
        was: processForAccount.cliPath,
        now: cliPath,
        failedOver: failover.failedOver,
      })
      deleteActiveProcess(sk)
      deleteClaudeSessionId(sk)
    }

    const hasExistingSession = !!getClaudeSessionId(sk)
    const hasActiveProcess = !!getActiveProcess(sk)
    let includeHistoryContext =
      !hasExistingSession && !hasActiveProcess && hasPriorConversation
    // A fresh session on the other account holds none of this conversation,
    // so the replay is not optional on a switch the way it is on a normal turn.
    if (failoverAnswer?.kind === "switch" && hasPriorConversation) {
      includeHistoryContext = true
    }

    // `effectiveModelId` stays intact for session keys, logs, and metadata;
    // only the name handed to the CLI gets the `-fast` marker stripped, and
    // (on a failover) the `@account` suffix the other account's wrapper would
    // not recognise.
    const { model: spawnModelId, fast: fastMode } = parseModelId(failover.modelId)

    const exitPlanModeQuestionResult = compactionMode
      ? null
      : consumeExitPlanModeQuestionResult(sk, options.prompt as any)
    if (exitPlanModeQuestionResult) {
      // The whole user message for this turn is the `tool_result` for the
      // pending ExitPlanMode call, so say so: an operator looking at a turn
      // that carries none of their typed text needs the reason in the log.
      log.info("sending plan approval decision to claude", { sk })
    }
    // Read before the envelope is built, and used by it: only these ids were
    // issued by this CLI process, so only these may be sent back as
    // `tool_result` blocks (issue #29).
    const previousPendingProxyCalls = compactionMode
      ? []
      : getPendingProxyCalls(sk)
    // On a switch the dialog comes out of the transcript and a short note
    // telling the fresh session to carry on goes in as the current message.
    const effectivePrompt =
      failoverAnswer?.kind === "switch"
        ? buildFailoverContinuationPrompt(options.prompt, failoverAnswer.target)
        : options.prompt
    const userMsg =
      exitPlanModeQuestionResult ??
      getClaudeUserMessage(effectivePrompt, includeHistoryContext, {
        compactionMode,
        cliToolCallIds: new Set(previousPendingProxyCalls.map((c) => c.toolCallId)),
        stripContextReminders: this.stripContextRemindersEnabled(),
      })
    const resolvedProxy = compactionMode ? null : this.resolvedProxyTools()
    const loadLiveToolInfo = this.createLiveToolInfoLoader()
    // Resolved here, not inside the stream body: the ExitPlanMode branches
    // run in a synchronous line handler and a reused process never reaches
    // the spawn block where the registry snapshot is otherwise taken.
    const planModeQuestionActive = await this.resolvePlanModeQuestion(
      compactionMode,
      loadLiveToolInfo,
    )
    const self = this

    const previousPendingProxyMatches: Array<{
      call: PendingProxyCall
      result: ProxyToolResult | null
    }> = previousPendingProxyCalls.map((call) => ({
      call,
      result: extractPendingProxyResultForCall(options.prompt, call),
    }))
    const hasMatchedPendingResults = previousPendingProxyMatches.some(
      (m) => m.result !== null,
    )

    // Pre-fetch opencode's MCP runtime status before constructing the
    // ReadableStream so the sync hot-reload check and async setup() see
    // the same overlay snapshot. One in-process call per turn — cheap;
    // the SDK client routes through `Server.app.fetch` (no socket).
    // Detect the Claude CLI version in parallel so the spawn can decide
    // which optional flags it supports without crashing older binaries.
    const [runtimeStatus, cliVersion] = await Promise.all([
      compactionMode ? Promise.resolve(undefined) : getRuntimeMcpStatus(),
      detectCliVersion(cliPath),
    ])

    // Whether a usage limit on this account should end the turn with the
    // switch form. Resolved here, in the prologue, for the same reason the
    // plan-mode gate is: the `result` branch that needs the answer runs in a
    // synchronous line handler. The candidate check comes first so a
    // single-account install never pays for the two lookups behind it.
    const failoverAccounts = failoverCandidates(
      this.config.failoverAccounts,
      sourceAccount,
    )
    const failoverAskActive =
      failoverAccounts.length > 0 &&
      this.config.accountFailover !== "off" &&
      !compactionMode &&
      !useInteractive &&
      // A `doGenerate` caller takes the override and reports the plain
      // rate-limit error, never the form. See `TurnMode`.
      mode !== "generate" &&
      isAccountFailoverQuestionActive({
        configured: this.config.accountFailover,
        candidates: failoverAccounts,
        opencodeHasQuestion: (await loadLiveToolInfo()).hasQuestion,
        compactionMode,
        interactive: !!useInteractive,
        // A subagent follows its parent's account for free, because the
        // override is account-scoped. Asking it would put a form in a session
        // the operator is usually not even looking at.
        childSession: !!(await fetchSessionParentId(affinity)),
      })

    log.info("doStream starting", {
      cwd,
      model: effectiveModelId,
      textLength: userMsg.length,
      includeHistoryContext,
      hasActiveProcess,
      reasoningEffort,
      proxyTools: resolvedProxy?.map((t) => t.name) ?? null,
      compactionMode,
      scope,
      opencodeAgent: this.getOpencodeAgent(options),
      providerOptionsKeys: options.providerOptions
        ? Object.keys(options.providerOptions)
        : [],
    })

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        // Compaction is a one-shot call. Don't reuse any cached process
        // from a prior compaction — each /compact gets a fresh spawn so
        // the new transcript isn't appended to a stale claude session.
        if (compactionMode) {
          deleteActiveProcess(sk)
          deleteClaudeSessionId(sk)
        }

        // A compress call lands mid-turn, when the child is still streaming,
        // so the reset it asks for happens here instead: drop the child and
        // its session id, and the spawn below starts clean. `userMsg` and
        // `includeHistoryContext` were resolved above while the session
        // still existed, so the fresh process is given only this turn's
        // message — the summary in its system prompt is the whole of its
        // prior context, exactly as the tool promised.
        //
        // Not while this turn carries results for the live child: evicting
        // it would send a tool_result to a process that never issued the
        // matching tool_use. The mark survives to the next turn.
        if (!compactionMode && !hasMatchedPendingResults && consumeCompressionRestart(sk)) {
          deleteActiveProcess(sk)
          deleteClaudeSessionId(sk)
          log.info("compress reset: dropped claude process and session id", {
            sessionKey: sk,
          })
        }

        // One object holds the whole of this turn's mutable state
        // (src/turn-state.ts). Everything below reads and writes it instead of
        // a shared scope, which is what lets a handler leave this closure at
        // all. Created here, where the first of those locals was declared.
        const state = createTurnState({
          controller,
          sessionKey: sk,
          cwd,
          cliPath,
          ignoreAnthropicApiKey: self.config.ignoreAnthropicApiKey,
          userMsg,
          autoContinueEnabled: autoContinueEnabledFor(
            compactionMode,
            self.config.autoContinueIncompleteTurns,
          ),
          toUsage,
          toFinishReason,
        })
        state.activeProcess = getActiveProcess(sk)
        state.proxyServer = state.activeProcess?.proxyServer ?? null

        const setup = async () => {
          // Wait for the old owner to exit before resuming its session ID in
          // the replacement, so two processes never append to one transcript.
          if (
            !compactionMode &&
            state.activeProcess &&
            self.config.hotReloadMcp !== false &&
            self.config.bridgeOpencodeMcp !== false
          ) {
            const probe = self.effectiveMcpConfig(cwd, undefined, runtimeStatus!)
            const previousHash = state.activeProcess.mcpHash ?? null
            if (previousHash !== probe.bridgedHash) {
              if (previousPendingProxyCalls.length > 0) {
                log.info("deferring MCP hot reload until proxy calls resolve", {
                  sk,
                  previousHash,
                  currentHash: probe.bridgedHash,
                  pendingCalls: previousPendingProxyCalls.length,
                })
              } else {
                log.info("opencode MCP config changed, respawning claude", {
                  sk,
                  previousHash,
                  currentHash: probe.bridgedHash,
                })
                await deleteActiveProcessAndWait(sk)
                state.activeProcess = undefined
                state.proxyServer = null
              }
            }
          }

          if (useInteractive && !compactionMode) {
            // Interactive Bun-ConPTY transport. Reuse the live session if one
            // exists for this key; else spawn a new interactive claude. The
            // wrapper conforms to ActiveProcess, so reuse/eviction/hot-reload
            // and the whole emission body below work unchanged.
            const mcp = self.effectiveMcpConfig(cwd, undefined, runtimeStatus!)
            if (state.activeProcess) {
              state.proc = state.activeProcess.proc
              state.lineEmitter = state.activeProcess.lineEmitter
              log.debug("reusing active interactive session", { sk })
            } else {
              // MCP wildcards are always derived from the live bridge config;
              // the built-in tool list is overridable via interactiveAllowTools.
              const allow = [
                ...mcp.allEnabledServerNames.map((n) => `mcp__${n}__*`),
                "mcp__opencode_proxy__*",
                ...(self.config.interactiveAllowTools ?? [
                  "Bash",
                  "Edit",
                  "Write",
                  "Read",
                  "WebFetch",
                ]),
              ]
              const systemPromptFile =
                self.config.interactiveSystemPrompt === false
                  ? undefined
                  : buildAppendedSystemPrompt(
                      cwd,
                      self.config.multiStepContinuation !== false,
                      // Do not forward opencode's own system prompt into the
                      // interactive TUI. Live subscription-account testing
                      // showed that large forwarded payload can trigger Claude
                      // Code's third-party-app usage gate, while our static
                      // CLI/AGENTS/continuation prompt remains safe.
                    )
              if (self.config.interactiveSystemPrompt === false) {
                log.warn(
                  "interactive system prompt disabled; opencode agent prompts will not be appended",
                )
              }
              if (interactiveBypassRequested) {
                log.warn(
                  "interactiveBypass ignored: Claude Code prompts for bypassPermissions confirmation in the interactive TUI",
                )
              }
              // Same skill bridge as the headless spawn: the TUI's native
              // Skill tool reads `--plugin-dir` too, and the flag probe
              // keeps it off a CLI that does not know the flag.
              const skillPluginDirs = await resolveSkillPluginDirs({
                cwd,
                cliPath,
                enabled: self.config.bridgeOpencodeSkills === true,
                ...self.skillBridgeSpawn(failover),
              })
              const ap = spawnInteractiveProcess({
                cwd,
                cliPath,
                configDir: self.config.configDir,
                model: spawnModelId,
                fastMode,
                mcpConfigPaths: mcp.paths,
                pluginDirs: skillPluginDirs,
                permissionsAllow: allow,
                systemPromptFile,
                ignoreAnthropicApiKey: self.config.ignoreAnthropicApiKey,
                effort: reasoningEffort,
              })
              ap.mcpHash = mcp.bridgedHash
              setActiveProcess(sk, ap)
              state.proc = ap.proc
              state.lineEmitter = ap.lineEmitter
              state.activeProcess = ap
              log.info("spawned interactive claude session", {
                sk,
                cliPath,
                configDir: self.config.configDir,
                model: effectiveModelId,
              })
            }
          } else {
          let spawnSystemPromptFile: string | undefined
          let spawnProxyServer: ProxyMcpServer | null = null
          let spawnMcpHash: string | null = null

          if (compactionMode) {
            // Compaction takes a lean spawn: no MCP servers, no proxy, no
            // appended system prompt, no disallowed-tools list. The model
            // is asked for text output only on a single turn — all the
            // normal tool wiring is pure overhead and adds latency.
            // Explicitly opt out of `--resume` so a stale id can never
            // resume into the lean spawn.
            state.cliArgs = buildCliArgs({
              sessionKey: sk,
              skipPermissions,
              includeSessionId: false,
              model: spawnModelId,
              permissionMode: self.config.permissionMode,
              fastMode,
              cliVersion,
            })
          } else {
            // First pass: discover which opencode MCP servers would be
            // bridged. We use this to decide which ones to re-route through
            // the proxy instead. No --mcp-config path is consumed here;
            // it's recomputed below with the exclusion set in place.
            const discovery = self.effectiveMcpConfig(
              cwd,
              undefined,
              runtimeStatus!,
            )

            // Fetch the proxy MCP tools (one ProxyToolDef per opencode
            // MCP-bridged tool). If discovery returns nothing or the SDK
            // is unreachable, this is null and we fall back to direct
            // bridging.
            const mcpResolution = self.resolvedProxyMcpTools(
              discovery.allEnabledServerNames,
              options.tools as readonly ModelToolEntry[] | undefined,
              new Set((resolvedProxy ?? []).map((def) => def.name)),
            )
            const proxyMcpTools = mcpResolution?.defs ?? null
            // Exclude only the servers a def was actually built for. Excluding
            // every enabled server, as this did while the resolution was always
            // null, would strand a server whose tools were not in the model's
            // tool set: dropped from `--mcp-config` and absent from the proxy,
            // so reachable by neither route.
            const excludeServers: ReadonlySet<string> | undefined = mcpResolution
              ? mcpResolution.coveredServers
              : undefined

            // Overlay opencode's live tool info onto the static proxy defs.
            // Both the `task` description (with the "Available agent types"
            // list, so the model sees which subagents exist instead of
            // grepping configs) and the `question` version gate (older
            // opencode builds lack the `question` registry entry; the def
            // must be dropped or a forwarded call renders `⚙ invalid`)
            // derive from a single tool-list fetch. Spawn-time only, like
            // the rest of this block; a reused process keeps its defs.
            const taskProxyEnabled =
              resolvedProxy?.some((t) => t.name === "task") ?? false
            const questionProxyEnabled =
              resolvedProxy?.some((t) => t.name === "question") ?? false
            // `proxyOpencodeTools` reads its defs out of the same registry
            // snapshot, so it joins the condition instead of fetching again.
            const opencodeToolsRequested =
              (self.config.proxyOpencodeTools?.length ?? 0) > 0
            log.debug("opencode tool forwarding gate", {
              requested: self.config.proxyOpencodeTools ?? null,
              opencodeToolsRequested,
            })
            const liveToolInfo =
              taskProxyEnabled || questionProxyEnabled || opencodeToolsRequested
                ? await loadLiveToolInfo()
                : {
                    resolved: false,
                    taskDescription: undefined,
                    questionDescription: undefined,
                    hasQuestion: false,
                  }
            let enrichedProxy = resolvedProxy
            if (enrichedProxy && taskProxyEnabled) {
              enrichedProxy = overlayTaskProxyDescription(
                enrichedProxy,
                liveToolInfo.taskDescription,
              )
              // Whether the model will see opencode's agent list is the
              // difference between a dispatch and an "Unknown agent type"
              // guess, so say so out loud.
              log.info("task proxy description overlay", {
                applied: Boolean(liveToolInfo.taskDescription),
                liveDescriptionLength: liveToolInfo.taskDescription?.length ?? 0,
                listsAgentTypes: Boolean(
                  liveToolInfo.taskDescription?.includes(
                    "Available agent types",
                  ),
                ),
              })
            }
            if (enrichedProxy && questionProxyEnabled) {
              // When the version gate is about to drop the def
              // (`hasQuestion === false`) the live description is moot,
              // so only overlay when the entry actually exists.
              enrichedProxy = overlayQuestionProxyDescription(
                enrichedProxy,
                liveToolInfo.hasQuestion
                  ? liveToolInfo.questionDescription
                  : undefined,
              )
              enrichedProxy = filterQuestionProxyByOpencodeSupport(
                enrichedProxy,
                liveToolInfo.hasQuestion,
              )
              // Same reasoning as the task overlay log: when the gate drops
              // the def the model silently falls back to the deny/markdown
              // path, which looks from the outside like the feature is off.
              log.info("question proxy version gate", {
                opencodeHasQuestion: liveToolInfo.hasQuestion,
                kept: liveToolInfo.hasQuestion,
              })
            }

            // Combine the static proxy defs with any MCP-bridged proxy
            // tools. Guard against the empty case: a version gate can
            // drop every configured def (e.g. `proxyTools: ["Question"]`
            // on an opencode build that lacks the `question` registry
            // entry), and spinning up an MCP server with zero tools is
            // wasteful and wrong shape.
            // Opencode tools that belong to no MCP server are invisible to
            // resolvedProxyMcpTools, so an explicitly named one is resolved
            // here. It goes into the same combined list, which means the same
            // broker path, and therefore the same abort / orphan-sweep /
            // session-delete / child-exit release as every other proxy call.
            // Last in `taken`, so a static def or an MCP tool keeps a
            // contested name (`compress`) and this one is dropped with a
            // warning rather than shadowing it.
            const opencodeToolDefs = resolveProxyOpencodeToolDefs({
              requested: self.config.proxyOpencodeTools,
              items: liveToolInfo.items,
              taken: new Set(
                [...(enrichedProxy ?? []), ...(proxyMcpTools ?? [])].map(
                  (t) => t.name,
                ),
              ),
            })
            if (opencodeToolDefs.length > 0) {
              log.info("forwarding opencode tools through the proxy", {
                tools: opencodeToolDefs.map((t) => t.name),
              })
            }

            const combinedList = [
              ...(enrichedProxy ?? []),
              ...(proxyMcpTools ?? []),
              ...opencodeToolDefs,
            ]
            const combinedProxyTools: ProxyToolDef[] | null =
              combinedList.length > 0 ? combinedList : null

            const pluginCompressEnabled =
              enrichedProxy?.some((t) => t.name === "compress") ?? false

            if (!state.proxyServer && combinedProxyTools) {
              state.proxyServer = await self.ensureProxyServer(
                combinedProxyTools,
                sk,
                pluginCompressEnabled,
              )
            }

            // Whether the question proxy actually survived the version
            // gate (post-filter). Used to decide whether to inject the
            // QUESTION_PROXY_HINT — if the gate dropped the def, the
            // model must fall back to AskUserQuestion (the deny/markdown
            // path) and must NOT be told to call a proxy tool that does
            // not exist.
            const questionProxyActive =
              enrichedProxy?.some((t) => t.name === "question") ?? false

            // Compute disallowed flags from the POST-FILTER proxy list
            // (enrichedProxy), not the pre-filter one (resolvedProxy).
            // When the version gate drops `question` on an older opencode
            // build, AskUserQuestion must NOT be added to
            // --disallowedTools — otherwise the native tool is disabled
            // while the proxy replacement is absent, leaving the model
            // with no way to ask questions at all (neither proxy nor the
            // deny/markdown fallback path fires).
            const allDisallowed = resolveDisallowedTools({
              proxyTools: enrichedProxy,
              extraDisallowedTools: self.config.extraDisallowedTools,
              disableWebSearch: self.config.webSearch === "disabled",
            })
            const mcp = self.effectiveMcpConfig(
              cwd,
              state.proxyServer?.configPath(),
              runtimeStatus!,
              excludeServers,
            )
            const systemPromptFile = state.activeProcess
              ? undefined
              : buildAppendedSystemPrompt(
                  cwd,
                  self.config.multiStepContinuation !== false,
                  [
                    ...extractSystemMessages(options.prompt),
                    ...(taskProxyEnabled ? [SUBAGENT_DISPATCH_HINT] : []),
                    ...(questionProxyActive ? [QUESTION_PROXY_HINT] : []),
                  ],
                  {
                    compressEnabled: pluginCompressEnabled,
                    opencodeCompressEnabled: opencodeToolDefs.some(
                      (t) => t.name === "compress",
                    ),
                    compressionSummary: getCompressionSummary(sk),
                  },
                )
            // Skill bridge (@broskees): stage opencode skills as a
            // session-scoped --plugin-dir so Claude's Skill tool can run them.
            // Opt-in via `bridgeOpencodeSkills: true`; the bundled skill is
            // staged either way.
            const skillPluginDirs = await resolveSkillPluginDirs({
              cwd,
              cliPath,
              enabled: self.config.bridgeOpencodeSkills === true,
              ...self.skillBridgeSpawn(failover),
            })
            state.cliArgs = buildCliArgs({
              sessionKey: sk,
              skipPermissions,
              model: spawnModelId,
              permissionMode: self.config.permissionMode,
              mcpConfig: mcp.paths,
              strictMcpConfig: self.config.strictMcpConfig,
              disallowedTools: allDisallowed.length > 0 ? allDisallowed : undefined,
              appendSystemPromptFile: systemPromptFile,
              pluginDirs: skillPluginDirs,
              ...self.thinkingCliOptions(),
              fastMode,
              cliVersion,
            })
            spawnSystemPromptFile = systemPromptFile
            spawnProxyServer = state.proxyServer
            spawnMcpHash = mcp.bridgedHash
          }

          if (state.activeProcess && !compactionMode) {
            state.proc = state.activeProcess.proc
            state.lineEmitter = state.activeProcess.lineEmitter
            log.debug("reusing active process", { sk })
          } else {
            const ap = spawnClaudeProcess(
              cliPath,
              state.cliArgs,
              cwd,
              sk,
              spawnProxyServer,
              spawnMcpHash,
              spawnSystemPromptFile,
              self.config.ignoreAnthropicApiKey,
              reasoningEffort,
            )
            state.proc = ap.proc
            state.lineEmitter = ap.lineEmitter
            state.activeProcess = ap
          }
          }

          // The CLI serves one turn at a time. If the previous one is still
          // running (the user aborted it, or it ended on our inactivity
          // fallback rather than a real `result`), stop it before this turn
          // attaches any listeners; otherwise its tail streams into us and its
          // `result` closes us before our own answer arrives. Skipped for
          // tool-result turns: there the CLI is deliberately parked inside a
          // proxy MCP call waiting for the result we are about to deliver.
          if (state.activeProcess && !hasMatchedPendingResults && isTurnInFlight(state.activeProcess)) {
            log.warn("previous turn still in flight; interrupting it", { sk })
            const idle = await interruptTurn(state.activeProcess)
            if (!idle) {
              log.warn("previous turn did not stop in time; this turn may see stale output", { sk })
            }
          }

          controller.enqueue({ type: "stream-start", warnings })


          // Its own text part, led by FAILOVER_MARKER, so a later transcript
          // rebuild strips it exactly: it was never Claude's output.
          if (failoverNote) {
            controller.enqueue({
              type: "text-delta",
              id: state.startTextBlock(),
              delta: failoverNote,
            })
            state.endTextBlock()
          }

          // The auto-continue clock starts where it always did, after the
          // spawn rather than at stream construction: `createTurnState` stamps
          // it at creation, which on a fresh spawn is earlier.
          state.autoContinueState.startedAt = Date.now()

          const clearFallbackTimer = () => {
            if (state.resultFallbackTimer) {
              clearTimeout(state.resultFallbackTimer)
              state.resultFallbackTimer = null
            }
          }

          // Wire-inactivity watchdog. Resets on every line received from the
          // CLI; only fires if the CLI has emitted content and then gone
          // silent on stdout for `delayMs` without sending a `result`. The
          // previous design armed this on every text content_block_stop,
          // which killed legitimate mid-turn think pauses (most visibly
          // with sonnet between text-end and the next tool_use_start).
          // Tunable for reproduces and for the regression test, the same seam
          // CLAUDE_CODE_state.startWatchdogMs gives the start watchdog below.
          const startResultFallback = (delayMs = state.resultFallbackMs) => {
            clearFallbackTimer()
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
                controller.enqueue({
                  type: "text-delta",
                  id: state.startTextBlock(),
                  delta: formatStreamTimeoutNote(delayMs),
                })
                state.endTextBlock()
              }
              closeHandler()
            }, delayMs)
          }

          // Start watchdog: complementary to the inactivity watchdog above.
          // That one only arms once content has arrived; this one covers the
          // gap the other explicitly skips — a reused process that produces
          // NO stdout at all after a fresh-turn envelope write. Seen after a
          // very long proxy-blocked tool call resumed successfully (the child
          // stays silent on stdout). On first fire we respawn the child with
          // --session-id to resume the conversation transparently; on a
          // second fire (respawn also silent) we end the turn cleanly so the
          // next opencode turn spawns fresh. Tunable via env for reproduces.
          const clearStartWatchdog = () => {
            if (state.startWatchdog) {
              clearTimeout(state.startWatchdog)
              state.startWatchdog = null
            }
          }
          const onStartWatchdogFire = () => {
            state.startWatchdog = null
            if (state.controllerClosed || state.hasReceivedContent || state.hasReceivedProgress) return
            if (state.respawnAttempted) {
              log.error(
                "claude process still silent after respawn; ending turn",
                { sessionKey: sk },
              )
              deleteActiveProcess(sk)
              deleteClaudeSessionId(sk)
              state.controllerClosed = true
              cleanupTurn()
              controller.enqueue({
                type: "error",
                error: new Error(
                  "Claude process produced no output after the envelope write (start watchdog timeout).",
                ),
              })
              try {
                controller.close()
              } catch {}
              return
            }
            state.respawnAttempted = true
            log.warn(
              "no stdout after envelope write; respawning claude process to resume conversation",
              { sessionKey: sk, startWatchdogMs: state.startWatchdogMs },
            )
            state.lineEmitter.off("line", lineHandler)
            state.lineEmitter.off("close", closeHandler)
            state.proc.off("error", procErrorHandler)
            const newAp = respawnActiveProcess(
              sk,
              cliPath,
              state.cliArgs,
              cwd,
              self.config.ignoreAnthropicApiKey,
            )
            if (!newAp) {
              log.error(
                "no active process to respawn (start watchdog); ending turn",
                { sessionKey: sk },
              )
              state.controllerClosed = true
              cleanupTurn()
              controller.enqueue({
                type: "error",
                error: new Error(
                  "No active claude process to respawn after start watchdog timeout.",
                ),
              })
              try {
                controller.close()
              } catch {}
              return
            }
            state.proc = newAp.proc
            state.lineEmitter = newAp.lineEmitter
            state.activeProcess = newAp
            state.lineEmitter.on("line", lineHandler)
            state.lineEmitter.on("close", closeHandler)
            state.proc.on("error", procErrorHandler)
            try {
              if (!deliverPendingCompletions(true)) {
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
            armStartWatchdog()
          }
          const armStartWatchdog = () => {
            clearStartWatchdog()
            if (state.controllerClosed) return
            state.startWatchdog = setTimeout(onStartWatchdogFire, state.startWatchdogMs)
          }

          // Both buffered/live terminal boundaries and respawn consume through
          // this path. Open-channel results remain available for a later close.
          const deliverPendingCompletions = (force = false): boolean => {
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
              sessionKey: sk,
              toolCallIds: entries.map(({ call }) => call.toolCallId),
              respawn: force,
            })
            state.gotPartialEvents = false
            state.hasReceivedContent = false
            state.hasReceivedProgress = false
            state.turnCompleted = false
            resetAutoContinueWindow()
            clearFallbackTimer()
            armStartWatchdog()
            return true
          }



        // Batched drain so claude CLI's parallel tool_use blocks (e.g. two
        // bash calls in one assistant message) end up in a single
        // tool-calls finish event. Without this, the broker would reject
        // every overlapping call and claude would see spurious tool errors.

        const finishWithToolCalls = (calls: PendingProxyCall[]) => {
          if (state.controllerClosed) return
          if (calls.length === 0) return
          const enqueueToolCall = (
            toolCallId: string,
            toolName: string,
            input: Record<string, unknown>,
          ) => {
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
          controller.enqueue({
            type: "finish",
            finishReason: toFinishReason("tool-calls"),
            usage: toUsage(state.resultMeta.usage),
            providerMetadata: {
              "claude-code": state.resultMeta,
            },
          })
          state.controllerClosed = true
          cleanupTurn()
          try {
            controller.close()
          } catch {}
        }

        /**
         * End the turn on a synthetic call to opencode's native `question`
         * tool. opencode runs the tool, and the operator's answer arrives on
         * the NEXT doStream as a `tool-result` carrying this same id, which
         * is what keeps the whole exchange inside one opencode turn. Shared
         * by the plan-mode approval bridge and the account-failover form.
         */
        const finishWithQuestionCall = (call: QuestionToolCall) => {
          if (state.controllerClosed) return
          state.endTextBlock()
          controller.enqueue({
            type: "tool-input-start",
            id: call.toolCallId,
            toolName: call.toolName,
            providerExecuted: false,
          } as any)
          controller.enqueue({
            type: "tool-call",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: JSON.stringify(call.input),
            providerExecuted: false,
          } as any)
          controller.enqueue({
            type: "finish",
            finishReason: toFinishReason("tool-calls"),
            usage: toUsage(state.resultMeta.usage),
            providerMetadata: {
              "claude-code": state.resultMeta,
            },
          })
          state.controllerClosed = true
          cleanupTurn()
          try {
            controller.close()
          } catch {}
        }

        const drainNow = () => {
          if (state.drainTimer) {
            clearTimeout(state.drainTimer)
            state.drainTimer = null
          }
          if (state.drainBuffer.length === 0) return
          if (state.controllerClosed) return
          const batch = state.drainBuffer.splice(0, state.drainBuffer.length)
          log.info("draining pending proxy calls into stream finish", {
            sessionKey: sk,
            count: batch.length,
            toolCallIds: batch.map((c) => c.toolCallId),
          })
          finishWithToolCalls(batch)
        }

        const settleResultBoundary = () => {
          state.drainTimer = null
          const completeResult = state.pendingResultCompletion
          state.pendingResultCompletion = null
          if (!completeResult || state.controllerClosed) return
          if (state.drainBuffer.length > 0) {
            drainNow()
            return
          }
          completeResult()
        }

        const scheduleResultBoundary = (
          completeResult: () => void,
          delayMs: number,
        ) => {
          state.pendingResultCompletion = completeResult
          if (state.drainTimer) clearTimeout(state.drainTimer)
          state.drainTimer = setTimeout(settleResultBoundary, delayMs)
        }

        const noteResultBoundaryCall = (): boolean => {
          if (!state.pendingResultCompletion) return false
          if (state.drainTimer) clearTimeout(state.drainTimer)
          state.drainTimer = setTimeout(settleResultBoundary, DRAIN_QUIET_MS)
          return true
        }

        const noteVisibleText = (text: string) => {
          state.visibleTextSinceContinue += text
          state.lastVisibleTextSinceContinue += text
          if (text.length > 0) state.sawVisibleText = true
        }

        const resetLastVisibleTextBlock = () => {
          state.lastVisibleTextSinceContinue = ""
        }

        const noteReasoning = () => {
          state.hadReasoningSinceContinue = true
          state.sawReasoning = true
        }

        const noteToolActivity = () => {
          state.hadToolActivitySinceContinue = true
          state.sawToolActivity = true
        }

        const noteProxyActivity = () => {
          state.hadProxyActivitySinceContinue = true
          state.sawProxyActivity = true
        }

        const resetAutoContinueWindow = () => {
          state.visibleTextSinceContinue = ""
          state.lastVisibleTextSinceContinue = ""
          state.hadReasoningSinceContinue = false
          state.hadToolActivitySinceContinue = false
          state.hadProxyActivitySinceContinue = false
          state.lastStopReason = null
        }

        const completeResult = (msg: ClaudeStreamMessage) => {
          if (state.controllerClosed) return
          // The socket may have closed after the tool-result prompt was matched,
          // or while the result-boundary grace timer was running.
          if (deliverPendingCompletions()) {
            if (state.drainBuffer.length > 0) drainNow()
            return
          }
          if (state.drainBuffer.length > 0) {
            drainNow()
            return
          }

          const pendingSiblings = getPendingProxyCalls(sk)
          if (pendingSiblings.length > 0) {
            log.info("leaving parallel proxy calls pending at result boundary", {
              sessionKey: sk,
              count: pendingSiblings.length,
            })
          }

          state.activeProcess?.pendingProxyCompletions?.clear()

          // This account is out of usage. Rather than finish as an error the
          // operator can only act on by editing config, end the turn on a
          // form listing the other configured accounts. Leaving it unanswered
          // waits and costs nothing; every answer that is not one of those
          // accounts comes back as a `stop` and ends the turn as before.
          // Only a turn that failed: a limit event on a turn that was served
          // is information, and replacing its answer with this form would
          // throw the answer away.
          if ((state.accountLimitHit || state.accountBlock) && failoverAskActive && msg.is_error === true) {
            const call = createAccountFailoverQuestionCall(sk, {
              sourceAccount,
              candidates: failoverAccounts,
              resetsAt: state.accountLimitHit?.resetsAt,
              window: state.accountLimitHit?.window,
              reason: state.accountLimitHit || !state.accountBlock ? undefined : describeAccountBlock(state.accountBlock),
            })
            log.warn(
              `Claude account "${sourceAccount}" ${
                state.accountLimitHit || !state.accountBlock ? "is out of usage" : `cannot serve (${state.accountBlock})`
              }; asking which account to continue on.`,
              {
                sessionKey: sk,
                candidates: failoverAccounts,
                toolCallId: call.toolCallId,
                resetsAt: state.accountLimitHit?.resetsAt ?? null,
              },
            )
            finishWithQuestionCall(call)
            return
          }

          // Nothing above took the turn, so the chain may. Deliberately below
          // the form: when another account is on offer a usage limit is the
          // operator's decision to make, and only an account with nothing to
          // switch to falls back onto a cheaper model instead. A per-model
          // weekly cap is the case that makes that worth doing at all, and it
          // is why the limit is a chain trigger and not only a failover one.
          //
          // `state.accountBlock` is excluded on purpose: an expired login or a
          // billing hold fails identically on every model in the chain, so
          // retrying would spend three spawns to print the same error.
          if (modelFallbackArmed && attempt && msg.is_error === true) {
            const refusal: ModelRefusal | null =
              state.modelRefusal ??
              (state.accountLimitHit && !failoverAskActive && !state.accountBlock
                ? { kind: "account_limit" as const }
                : null)
            if (refusal) {
              attempt.refusal = refusal
              log.warn(
                `Claude will not serve "${effectiveModelId}" (${refusal.kind}); falling back to the next model in the chain.`,
                { sessionKey: sk, model: effectiveModelId, detail: refusal.detail ?? null },
              )
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "error" as const, raw: refusal.kind },
                usage: toUsage(msg.usage),
                providerMetadata: {
                  "claude-code": { ...state.resultMeta, path: "model-fallback" },
                },
              })
              state.controllerClosed = true
              cleanupTurn()
              // The refused model owns this session key, and the next model
              // gets its own, so nothing here is ever resumed. Dropping both
              // after `cleanupTurn` has detached the listeners is what makes
              // the next attempt a fresh session with the thread replayed,
              // through the same path a failover switch uses.
              deleteActiveProcess(sk)
              deleteClaudeSessionId(sk)
              try {
                controller.close()
              } catch {}
              return
            }
          }

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
              sessionKey: sk,
              reason: autoDecision.reason,
              attempts: state.autoContinueState.attempts,
              textLength: state.visibleTextSinceContinue.length,
              lastTextLength: state.lastVisibleTextSinceContinue.length,
              hadReasoning: state.hadReasoningSinceContinue,
              hadToolActivity: state.hadToolActivitySinceContinue,
              hadProxyActivity: state.hadProxyActivitySinceContinue,
            })
            state.turnCompleted = false
            resetAutoContinueWindow()
            // The `result` just consumed marked the CLI idle; this puts it back to work.
            if (state.activeProcess) noteTurnStarted(state.activeProcess)
            state.proc.stdin?.write(makeAutoContinueMessage() + "\n")
            return
          }
          log.notice("auto-continuation stopped", {
            sessionKey: sk,
            reason: autoDecision.reason,
            stopReason: state.lastStopReason,
            attempts: state.autoContinueState.attempts,
            textLength: state.visibleTextSinceContinue.length,
            lastTextLength: state.lastVisibleTextSinceContinue.length,
            hadReasoning: state.hadReasoningSinceContinue,
            hadToolActivity: state.hadToolActivitySinceContinue,
            hadProxyActivity: state.hadProxyActivitySinceContinue,
          })

          for (const [idx, reasoningId] of state.reasoningIds) {
            if (state.reasoningStarted.get(idx)) {
              controller.enqueue({
                type: "reasoning-end",
                id: reasoningId,
              } as any)
            }
          }

          // A turn that finished cleanly having said nothing and done nothing.
          // opencode files it as an ordinary reply, so without this the
          // operator gets a blank assistant message and no way to tell it from
          // a crash. Its own text part, led by SILENT_TURN_MARKER, so a later
          // transcript rebuild strips it: it was never Claude's output.
          if (
            isSilentTurn({
              enabled: state.autoContinueState.enabled,
              compactionMode,
              sawVisibleText: state.sawVisibleText,
              sawToolActivity: state.sawToolActivity,
              sawProxyActivity: state.sawProxyActivity,
              isError: msg.is_error === true || state.resultFailure !== undefined,
              aborted: state.autoContinueState.aborted,
              sawQuestion: state.autoContinueState.sawAskUserQuestion,
            })
          ) {
            log.notice("claude finished the turn without a reply", {
              sessionKey: sk,
              stopReason: state.lastStopReason,
              hadReasoning: state.sawReasoning,
              attempts: state.autoContinueState.attempts,
            })
            controller.enqueue({
              type: "text-delta",
              id: state.startTextBlock(),
              delta: formatSilentTurnNote(state.sawReasoning),
            })
            state.endTextBlock()
          }

          controller.enqueue({
            type: "finish",
            finishReason: state.resultFailure
              ? { unified: "error" as const, raw: state.resultFailure }
              : toFinishReason("stop"),
            usage: toUsage(msg.usage),
            providerMetadata: {
              "claude-code": {
                ...state.resultMeta,
                ...(state.resultFailure ? { resultSubtype: state.resultFailure } : {}),
                ...(compactionMode
                  ? { compactionModel: effectiveModelId }
                  : {}),
              },
              ...(typeof msg.usage?.cache_creation_input_tokens === "number"
                ? {
                    anthropic: {
                      cacheCreationInputTokens:
                        msg.usage.cache_creation_input_tokens,
                    },
                  }
                : {}),
            },
          })

          state.controllerClosed = true
          cleanupTurn()
          if (!useInteractive && !compactionMode) {
            scheduleIdleProcessEviction(
              sk,
              resolveIdleProcessTimeoutMs(self.config.idleProcessTimeoutMs),
            )
          }

          try {
            controller.close()
          } catch {}
        }

        // Set true once we observe a `stream_event` envelope. When on, the
        // top-level `assistant` message is a duplicate of what we already
        // streamed via content_block_* deltas — skip its content.

        const lineHandler = (line: string) => {
          if (!line.trim()) return
          if (state.controllerClosed) return

          // Any line from the CLI counts as activity — reset the inactivity
          // watchdog so mid-turn pauses between blocks don't get killed.
          startResultFallback()

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
              clearStartWatchdog()
              startResultFallback()
            }

            // Read before anything is enqueued for this message, because the
            // chain runner keys its withhold-or-flush decision on these two
            // flags and reads them only after the handler has returned.
            // `modelProgress` above cannot stand in: it counts the CLI's own
            // synthetic error reply, which is precisely a refusal.
            if (attempt && !attempt.serving && provesModelServing(msg)) {
              attempt.serving = true
            }
            if (modelFallbackArmed && !state.modelRefusal) {
              state.modelRefusal = modelRefusalFromAssistant(msg)
            }

            if (outer.type === "stream_event") {
              state.gotPartialEvents = true
            }

            if (handleControlRequest(msg, state.proc)) {
              return
            }

            log.debug("stream message", {
              type: msg.type,
              subtype: msg.subtype,
            })

            // Handle system init
            if (msg.type === "system" && msg.subtype === "init") {
              if (msg.session_id) {
                setClaudeSessionId(sk, msg.session_id)
                log.info("session initialized", {
                  claudeSessionId: msg.session_id,
                })
              }
              reportFastModeState(msg, fastMode)
              reportSystemInit(msg, {
                ignoreAnthropicApiKey: self.config.ignoreAnthropicApiKey,
              })
            }

            // The CLI compacted its own context. Nothing else tells the user
            // that everything before this point is now a summary.
            if (msg.type === "system" && msg.subtype === "compact_boundary") {
              const note = reportCompactBoundary(msg)
              if (note) {
                controller.enqueue({ type: "text-delta", id: state.startTextBlock(), delta: note })
                state.endTextBlock()
              }
            }

            // Claude Code started a new conversation (`/clear`, plan-mode
            // exit). Content-block indices restart with it, so nothing keyed
            // by index may survive: a stale `state.toolCallMap` entry re-emits a
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
                controller.enqueue({ type: "text-delta", id: state.startTextBlock(), delta: note })
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
              }
              const note = reportRateLimitEvent(msg)
              if (note) {
                controller.enqueue({ type: "text-delta", id: state.startTextBlock(), delta: note })
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
                noteReasoning()
                const reasoningId = generateId()
                state.reasoningIds.set(idx, reasoningId)
              }

              if (block.type === "text") {
                state.textBlockIndices.add(idx)
                // New text block — clear last-block buffer so final-answer
                // detection only considers this block's contents, not earlier
                // mid-task narration.
                resetLastVisibleTextBlock()
                if (block.text) {
                  if (!state.currentTextId) state.startTextBlock()
                  controller.enqueue({
                    type: "text-delta",
                    id: state.currentTextId!,
                    delta: block.text,
                  })
                  noteVisibleText(block.text)
                  state.hasReceivedContent = true
                }
              }

              if (block.type === "tool_use" && block.id && block.name) {
                noteToolActivity()
                const entry = {
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
                      webSearch: self.config.webSearch,
                      sessionId: getClaudeSessionId(sk),
                      toolUseId: block.id,
                    },
                  )
                  if (!skip) {
                    entry.started = true
                    controller.enqueue({
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
                noteReasoning()
                state.hadThinkingTextFromStream = true
                const reasoningId = state.reasoningIds.get(idx)
                if (reasoningId) {
                  if (!state.reasoningStarted.get(idx)) {
                    controller.enqueue({
                      type: "reasoning-start",
                      id: reasoningId,
                    } as any)
                    state.reasoningStarted.set(idx, true)
                  }
                  controller.enqueue({
                    type: "reasoning-delta",
                    id: reasoningId,
                    delta: delta.thinking,
                  } as any)
                }
              }

              if (delta.type === "text_delta" && delta.text) {
                if (!state.currentTextId) state.startTextBlock()
                controller.enqueue({
                  type: "text-delta",
                  id: state.currentTextId!,
                  delta: delta.text,
                })
                noteVisibleText(delta.text)
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
                    controller.enqueue({
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
                controller.enqueue({
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
                  controller.enqueue({
                    type: "text-delta",
                    id: askId,
                    delta: formatAskUserQuestion(parsedInput),
                  })
                  state.endTextBlock()
                } else if (tc.name === "ExitPlanMode") {
                  const plan = (parsedInput?.plan as string) || ""

                  if (planModeQuestionActive) {
                    // Approval bridge: render the plan, then hand the
                    // yes/no back to opencode's own `question` tool and end
                    // the turn on "tool-calls" so the outer loop runs it.
                    const questionCall = createExitPlanModeQuestionCall(
                      sk,
                      tc.id,
                      plan,
                    )
                    const planId = state.startTextBlock()
                    controller.enqueue({
                      type: "text-delta",
                      id: planId,
                      delta: questionCall.text,
                    })
                    finishWithQuestionCall(questionCall)
                    return
                  }

                  const planId = state.startTextBlock()
                  controller.enqueue({
                    type: "text-delta",
                    id: planId,
                    delta: `\n\n${plan}\n\n---\n**Do you want to proceed with this plan?** (yes/no)\n`,
                  })
                  state.endTextBlock()
                } else if (
                  isWebSearchTool(tc.name) &&
                  isWebSearchHandledByCli(self.config.webSearch)
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
                  controller.enqueue({
                    type: "text-delta",
                    id: searchId,
                    delta: `\n> **Web search:** ${query}\n`,
                  })
                  state.endTextBlock()
                } else if (tc.name.startsWith(PROXY_TOOL_PREFIX)) {
                  noteProxyActivity()
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
                    webSearch: self.config.webSearch,
                    sessionId: getClaudeSessionId(sk),
                    toolUseId: tc.id,
                  })

                  if (!skip) {
                    state.toolCallsById.set(tc.id, {
                      id: tc.id,
                      name: mappedName,
                      input: parsedInput,
                    })
                    if (!executed) state.skipResultForIds.add(tc.id)

                    controller.enqueue({
                      type: "tool-call",
                      toolCallId: tc.id,
                      toolName: mappedName,
                      input: JSON.stringify(mappedInput),
                      providerExecuted: executed,
                    } as any)
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
                      noteReasoning()
                      state.hadThinkingTextFromStream = true
                      const thinkingId = generateId()
                      controller.enqueue({
                        type: "reasoning-start",
                        id: thinkingId,
                      } as any)
                      controller.enqueue({
                        type: "reasoning-delta",
                        id: thinkingId,
                        delta: block.thinking,
                      } as any)
                      controller.enqueue({
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

              if (hasText && !hasToolUse) {
                startResultFallback()
              }
              if (hasToolUse) {
                clearFallbackTimer()
              }

              for (const block of msg.message.content) {
                if (block.type === "text" && block.text) {
                  // New text block — keep only this block's text in the
                  // last-block buffer for final-answer detection.
                  resetLastVisibleTextBlock()
                  const blockId = state.startTextBlock()
                  controller.enqueue({
                    type: "text-delta",
                    id: blockId,
                    delta: block.text,
                  })
                  state.endTextBlock()
                  noteVisibleText(block.text)
                  state.hasReceivedContent = true
                }

                if (block.type === "thinking" && block.thinking) {
                  noteReasoning()
                  const thinkingId = generateId()
                  controller.enqueue({
                    type: "reasoning-start",
                    id: thinkingId,
                  } as any)
                  controller.enqueue({
                    type: "reasoning-delta",
                    id: thinkingId,
                    delta: block.thinking,
                  } as any)
                  controller.enqueue({
                    type: "reasoning-end",
                    id: thinkingId,
                  } as any)
                }

                if (block.type === "tool_use" && block.id && block.name) {
                  noteToolActivity()
                  const parsedInput = (block.input ?? {}) as Record<
                    string,
                    unknown
                  >

                  if (isAskUserQuestionTool(block.name)) {
                    const askId = state.startTextBlock()
                    controller.enqueue({
                      type: "text-delta",
                      id: askId,
                      delta: formatAskUserQuestion(parsedInput),
                    })
                    state.endTextBlock()
                  } else if (block.name === "ExitPlanMode") {
                    const plan = (parsedInput?.plan as string) || ""

                    if (planModeQuestionActive) {
                      const questionCall = createExitPlanModeQuestionCall(
                        sk,
                        block.id,
                        plan,
                      )
                      const planId = state.startTextBlock()
                      controller.enqueue({
                        type: "text-delta",
                        id: planId,
                        delta: questionCall.text,
                      })
                      finishWithQuestionCall(questionCall)
                      return
                    }

                    const planId = state.startTextBlock()
                    controller.enqueue({
                      type: "text-delta",
                      id: planId,
                      delta: `\n\n${plan}\n\n---\n**Do you want to proceed with this plan?** (yes/no)\n`,
                    })
                    state.endTextBlock()
                  } else if (
                    isWebSearchTool(block.name) &&
                    isWebSearchHandledByCli(self.config.webSearch)
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
                    controller.enqueue({
                      type: "text-delta",
                      id: searchId,
                      delta: `\n> **Web search:** ${query}\n`,
                    })
                    state.endTextBlock()
                  } else if (block.name.startsWith(PROXY_TOOL_PREFIX)) {
                    noteProxyActivity()
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
                      webSearch: self.config.webSearch,
                      sessionId: getClaudeSessionId(sk),
                      toolUseId: block.id,
                    })

                    if (!skip) {
                      state.toolCallsById.set(block.id, {
                        id: block.id,
                        name: mappedName,
                        input: parsedInput,
                      })
                      if (!executed) state.skipResultForIds.add(block.id)
                      controller.enqueue({
                        type: "tool-input-start",
                        id: block.id,
                        toolName: mappedName,
                        providerExecuted: executed,
                      } as any)
                      controller.enqueue({
                        type: "tool-call",
                        toolCallId: block.id,
                        toolName: mappedName,
                        input: JSON.stringify(mappedInput),
                        providerExecuted: executed,
                      } as any)
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
                  const claudeSessionId = getClaudeSessionId(sk)
                  if (claudeSessionId) {
                    const list = applyTaskCreateToolResult(
                      claudeSessionId,
                      block.tool_use_id,
                      resultText,
                    )
                    if (list) {
                      const synthId = `todowrite_${block.tool_use_id}`
                      controller.enqueue({
                        type: "tool-input-start",
                        id: synthId,
                        toolName: "todowrite",
                        providerExecuted: false,
                      } as any)
                      controller.enqueue({
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
                      noteToolActivity()
                    }
                  }

                  const toolCall = state.toolCallsById.get(block.tool_use_id)
                  if (toolCall) {
                    // A CLI-executed tool that failed carries `is_error`. The
                    // AI SDK turns a `tool-result` with `isError` into a
                    // `tool-error` part, which is what makes opencode render
                    // the row as failed; without the flag every failed CLI
                    // tool was forwarded as a success whose output happened
                    // to be an error message.
                    const isError = block.is_error === true
                    controller.enqueue({
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
                    noteToolActivity()
                    log.info("tool result emitted", {
                      toolUseId: block.tool_use_id,
                      name: toolCall.name,
                      isError,
                    })
                    state.toolCallsById.delete(block.tool_use_id)
                  }
                }
              }
            }

            // result - end of conversation turn
            if (msg.type === "result") {
              clearFallbackTimer()

              if (msg.session_id) {
                setClaudeSessionId(sk, msg.session_id)
              }

              if (deliverPendingCompletions()) {
                // Finish the abandoned turn before submitting its late result.
                // Otherwise this result could close the stream for the new turn.
                return
              }

              // Some CLI failures only include user-readable text in
              // `result.result` (no prior assistant text blocks). Emit it so
              // opencode users don't see a blank turn.
              if (
                !state.currentTextId &&
                msg.is_error &&
                typeof msg.result === "string" &&
                msg.result.trim().length > 0
              ) {
                const errId = state.startTextBlock()
                controller.enqueue({
                  type: "text-delta",
                  id: errId,
                  delta: msg.result,
                })
              }

              // The other half of the limit signal: some rejections only ever
              // reach us as the error text of the terminal result.
              if (
                !state.accountLimitHit &&
                msg.is_error &&
                isAccountLimitError({
                  resultText: typeof msg.result === "string" ? msg.result : null,
                })
              ) {
                state.accountLimitHit = {}
              }

              // The other half of the refusal signal, for a CLI that reports
              // no assistant frame. The `result`'s own `subtype` is `success`
              // even here, so it can never be the thing that is read.
              if (modelFallbackArmed && !state.modelRefusal) {
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
                const offeringSwitch = failoverAskActive
                controller.enqueue({
                  type: "text-delta",
                  id: state.startTextBlock(),
                  delta: formatAccountBlockNote({
                    kind: state.accountBlock,
                    account: sourceAccount,
                    configDir: self.config.configDir,
                    offeringSwitch,
                  }),
                })
                state.endTextBlock()
                log.warn(`Claude account "${sourceAccount}" cannot serve requests`, {
                  sessionKey: sk,
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
                controller.enqueue({
                  type: "text-delta",
                  id: state.startTextBlock(),
                  delta: formatResultFailureNote(failure),
                })
                log.warn(failure, { sessionKey: sk, subtype: msg.subtype })
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
              if (self.config.turnStats && !compactionMode && !msg.is_error && !failure) {
                const footer = formatTurnStatsBlock(turnStats)
                if (footer) {
                  controller.enqueue({
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
                    sessionKey: sk,
                    count: state.drainBuffer.length,
                  },
                )
                scheduleResultBoundary(
                  () => completeResult(msg),
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
                    sessionKey: sk,
                    graceMs: PROXY_RESULT_BOUNDARY_GRACE_MS,
                  },
                )
                scheduleResultBoundary(
                  () => completeResult(msg),
                  PROXY_RESULT_BOUNDARY_GRACE_MS,
                )
                return
              }

              completeResult(msg)
            }
          } catch (e) {
            log.debug("failed to parse line", {
              error:
                e instanceof Error ? e.message : String(e),
            })
          }
        }

        const closeHandler = () => {
          log.debug("readline closed")
          if (state.controllerClosed) return
          // Claude CLI's stdio is gone. The proxy-mcp HTTP requests that
          // backed any pending tool calls have no one to answer them now —
          // reject so the handlers return errors rather than hang.
          if (state.drainBuffer.length > 0 || getPendingProxyCalls(sk).length > 0) {
            rejectAllPendingProxyCallsForSession(
              sk,
              new Error(
                "Claude CLI subprocess closed before pending tool calls were resolved",
              ),
            )
            state.drainBuffer.length = 0
          }
          // A close without a terminal `result` means the child died mid-turn.
          // Reporting that as `stop` with empty usage made a crashed CLI look
          // like a short but successful answer. An abort is not a crash: the
          // operator asked for it, and the CLI may exit before its interrupt
          // result lands.
          const crashed = !state.turnCompleted && !state.autoContinueState.aborted
          state.controllerClosed = true
          cleanupTurn()
          state.endTextBlock()

          const finishClose = (
            exitCode: number | null,
            signal: NodeJS.Signals | null,
          ) => {
            if (crashed) {
              log.warn("claude process closed without a result", {
                sessionKey: sk,
                exitCode,
                signal,
                stderrBytes: state.activeProcess?.lastStderr?.length ?? 0,
              })
              controller.enqueue({
                type: "error",
                error: new Error(
                  describeChildCrash(exitCode, signal, state.activeProcess?.lastStderr),
                ),
              })
            }
            controller.enqueue({
              type: "finish",
              finishReason: toFinishReason(crashed ? "error" : "stop"),
              usage: toUsage(),
              providerMetadata: {
                "claude-code": {
                  ...state.resultMeta,
                  ...(compactionMode
                    ? { compactionModel: effectiveModelId }
                    : {}),
                },
              },
            })
            try {
              controller.close()
            } catch {}
          }

          // stdout usually reaches EOF a tick before the child's `exit` event,
          // so the status that explains the crash is not known yet here. The
          // turn is over either way; wait briefly for it rather than report a
          // bare "closed its output". Bounded, and only on the crash path.
          if (crashed && state.proc.exitCode === null && state.proc.signalCode === null) {
            let reported = false
            const report = (
              exitCode: number | null,
              signal: NodeJS.Signals | null,
            ) => {
              if (reported) return
              reported = true
              clearTimeout(exitGrace)
              state.proc.off("exit", onExit)
              finishClose(exitCode, signal)
            }
            const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
              report(code, signal)
            const exitGrace = setTimeout(
              () => report(state.proc.exitCode, state.proc.signalCode),
              CHILD_EXIT_STATUS_GRACE_MS,
            )
            state.proc.once("exit", onExit)
            return
          }
          finishClose(state.proc.exitCode, state.proc.signalCode)
        }

        // Centralised per-turn teardown. Every exit path funnels through here
        // so we don't accumulate listeners across turns on a reused process.
        const cleanupTurn = () => {
          if (state.cleanedUp) return
          state.cleanedUp = true
          clearFallbackTimer()
          state.pendingResultCompletion = null
          clearStartWatchdog()
          if (state.drainTimer) {
            clearTimeout(state.drainTimer)
            state.drainTimer = null
          }
          state.lineEmitter.off("line", lineHandler)
          state.lineEmitter.off("close", closeHandler)
          state.pendingProxyUnsubscribe?.()
          state.pendingProxyUnsubscribe = null
          state.asideSinkUnregister?.()
          state.asideSinkUnregister = null
          state.proc.off("error", procErrorHandler)
        }

        const procErrorHandler = (err: Error) => {
          log.error("process error", { error: err.message })
          deleteActiveProcess(sk)
          deleteClaudeSessionId(sk)
          if (state.controllerClosed) return
          // Subprocess failure invalidates every pending HTTP-bound tool
          // call for this session. Reject them so proxy-mcp returns errors
          // to Claude rather than letting the sockets stall.
          if (state.drainBuffer.length > 0 || getPendingProxyCalls(sk).length > 0) {
            rejectAllPendingProxyCallsForSession(
              sk,
              new Error(
                `Claude CLI subprocess error: ${err.message}`,
              ),
            )
            state.drainBuffer.length = 0
          }
          state.controllerClosed = true
          cleanupTurn()
          controller.enqueue({ type: "error", error: err })
          try {
            controller.close()
          } catch {}
        }

        // Whatever the child said while no turn was listening comes first:
        // the operator gets to see it, and a turn that already ended on the
        // CLI's side is known before this one decides what to send.
        if (state.activeProcess) {
          const unattended = takeUnattendedLines(state.activeProcess)
          if (unattended.lines.length > 0 || unattended.dropped > 0) {
            log.notice("replaying stdout the child emitted between turns", {
              sessionKey: sk,
              lines: unattended.lines.length,
              dropped: unattended.dropped,
            })
            // Render narration only. Replaying actionable events could execute
            // old tools or close this new stream on a stale approval/result.
            let partialText = false
            {
              if (unattended.dropped > 0) {
                const id = state.startTextBlock()
                controller.enqueue({
                  type: "text-delta",
                  id,
                  delta: `> _${unattended.dropped} lines of output emitted between turns were dropped._\n\n`,
                })
              }
              for (const line of unattended.lines) {
                try {
                  const outer: ClaudeStreamMessage = JSON.parse(line)
                  const msg = outer.type === "stream_event" && outer.event ? outer.event : outer
                  let text = ""
                  if (msg.type === "content_block_delta" && msg.delta?.type === "text_delta") {
                    text = msg.delta.text ?? ""
                    partialText = true
                  } else if (msg.type === "assistant") {
                    if (!partialText) text = (msg.message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("")
                    partialText = false
                  } else if (msg.type === "result") {
                    state.unattendedTurnEnded = true
                    for (const entry of state.activeProcess.pendingProxyCompletions?.values() ?? []) {
                      if (isPendingProxyCallChannelClosed(entry.call)) entry.recoveryRequired = true
                    }
                    if (outer.session_id) setClaudeSessionId(sk, outer.session_id)
                    if (msg.is_error && msg.result) text = msg.result
                  }
                  if (text) controller.enqueue({ type: "text-delta", id: state.currentTextId ?? state.startTextBlock(), delta: text })
                } catch { /* Ignore incomplete or malformed buffered lines. */ }
              }
            }
            state.endTextBlock()
            // Replayed lines are history, not liveness: the watchdogs below
            // must judge the child on what it does from here on.
            clearFallbackTimer()
            state.hasReceivedContent = false
          }
        }

        if (state.activeProcess && !compactionMode) {
          state.activeProcess.opencodeSessionID = affinity
          state.activeProcess.asideTransport = asideTransportRef
        }
        if (!compactionMode) {
          // Lets a `/btw` answered while this turn runs land in the turn's own
          // reply instead of a toast (btw-command.ts). Its own text block, so
          // the marker stays at the start of a part and the block can be
          // stripped exactly when a transcript is rebuilt.
          state.asideSinkUnregister = registerAsideSink(affinity, (text) => {
            if (state.controllerClosed) return false
            const asideId = state.startTextBlock()
            controller.enqueue({ type: "text-delta", id: asideId, delta: text })
            state.endTextBlock()
            return true
          })
        }
        state.lineEmitter.on("line", lineHandler)
        state.lineEmitter.on("close", closeHandler)

        state.pendingProxyUnsubscribe = onPendingProxyCall(sk, (call) => {
          if (state.controllerClosed) {
            // Stream already closed (we already drained). Late arrival —
            // reject immediately so the proxy-mcp HTTP request returns
            // instead of hanging until its 10-min timeout.
            log.warn(
              "pending proxy call arrived after stream close; rejecting",
              {
                sessionKey: sk,
                toolCallId: call.toolCallId,
                toolName: call.toolName,
              },
            )
            rejectPendingProxyCallById(
              call.toolCallId,
              new Error(
                `Pending proxy call '${call.toolName}' arrived after the stream was already closed`,
              ),
            )
            return
          }
          log.info("received pending proxy call for session", {
            sessionKey: sk,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
          })
          noteProxyActivity()
          noteToolActivity()
          state.drainBuffer.push(call)
          if (noteResultBoundaryCall()) return
          if (state.drainTimer) clearTimeout(state.drainTimer)
          state.drainTimer = setTimeout(drainNow, DRAIN_QUIET_MS)
        })

        state.proc.on("error", procErrorHandler)

        // On abort, keep process alive for next message
        if (options.abortSignal) {
          // Proxy calls this turn handed to opencode will never get a result
          // once the operator aborts: opencode stops its tool runs with the
          // turn. Release them now, so the CLI's parked requests return and
          // nothing waits for the next message to find out. Late-result
          // recovery is untouched: it holds results that already arrived.
          const releaseAbandonedProxyCalls = (reason: string) => {
            if (state.drainBuffer.length === 0 && getPendingProxyCalls(sk).length === 0) return
            rejectAllPendingProxyCallsForSession(sk, new Error(reason))
            state.drainBuffer.length = 0
          }
          options.abortSignal.addEventListener("abort", () => {
            state.autoContinueState.aborted = true
            if (state.turnCompleted || state.controllerClosed) {
              // This stream already ended on a proxy tool boundary. An abort
              // here is NOT necessarily the operator: opencode 1.18.32 aborts
              // the signal of every step that ends in tool calls, about a
              // second after the finish, while it runs the tool (measured:
              // 348 of 938 proxied calls on 2026-09-23, and every call in a
              // plugin-only scratch config). Releasing on that rejected calls
              // that were working, told Claude "the user doesn't want to
              // proceed", and pushed each result into the next turn as text.
              // The abort reason is the same `AbortError` either way, so
              // opencode's session status decides: still busy means it is
              // running the tool, idle means the operator stopped the turn.
              // Unknown keeps the call, which at worst leaves a real abort
              // waiting for the next message, as it did before release-on-
              // abort existed.
              const stoppedProcess = state.activeProcess
              if (
                stoppedProcess &&
                stoppedProcess.lineEmitter.listenerCount("line") === 0 &&
                getPendingProxyCalls(sk).length > 0
              ) {
                const reason = describeAbortReason(options.abortSignal?.reason)
                void settleSessionRunState(affinity).then((stopped) => {
                  // Re-checked after the wait: a later turn that attached in
                  // the meantime owns these calls now.
                  const stillParked =
                    stoppedProcess.lineEmitter.listenerCount("line") === 0 &&
                    getPendingProxyCalls(sk).length > 0
                  // Only a positive `busy` keeps the call. `unknown` (no SDK
                  // client, no status route, a failed read) releases exactly
                  // as it did before this check existed, so a build that
                  // cannot ask is never left worse off.
                  if (stopped === "busy" || !stillParked) {
                    log.debug("abort at a tool boundary while opencode is still running the turn; keeping pending calls", {
                      sk,
                      session: stopped,
                      stillParked,
                      reason,
                    })
                    return
                  }
                  log.info("abort between proxy tool boundaries; releasing pending calls", { sk, reason })
                  void interruptTurn(stoppedProcess).then((idle) => {
                    log.info("interrupt sent for aborted turn", { sk, idle })
                  })
                  releaseAbandonedProxyCalls(
                    "Provider stream was aborted while opencode was running its proxy tool calls",
                  )
                })
              }
              return
            }

            // Stop the CLI's turn, not just our end of the stream: it would
            // otherwise run the abandoned turn to completion, billing tokens
            // and executing tools, with its late output landing in the next
            // turn. The process itself stays alive for the next message.
            if (state.activeProcess) {
              void interruptTurn(state.activeProcess).then((idle) => {
                log.info("interrupt sent for aborted turn", { sk, idle })
              })
            }

            if (!state.hasReceivedContent) {
              log.info(
                "abort signal received before content, closing stream immediately",
                { cwd },
              )
              releaseAbandonedProxyCalls(
                "Provider stream was aborted before pending proxy calls were emitted",
              )
              state.controllerClosed = true
              cleanupTurn()
              try {
                controller.close()
              } catch {}
              return
            }

            log.info(
              "abort signal received mid-turn, starting grace period",
              { cwd },
            )
            releaseAbandonedProxyCalls(
              "Provider stream was aborted while proxy tool calls were pending",
            )
            // Abort grace period — short, since the user already asked to stop.
            startResultFallback(5_000)
          })
        }

        if (hasMatchedPendingResults) {
          // Tool-result turn: the prompt carries opencode's results for the
          // proxy tool calls we drained on the previous turn. Resolve each
          // matched call (claude CLI's HTTP handlers wake up and continue).
          // Parallel tools may complete in separate opencode turns. Keep
          // unmatched siblings pending until their own result, an explicit
          // abort/new user turn, or the proxy deadline.
          for (const { call, result } of previousPendingProxyMatches) {
            if (result) {
              const channelClosed = isPendingProxyCallChannelClosed(call)
              log.info("resolving pending proxy call from tool result prompt", {
                sessionKey: sk,
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                channelClosed,
              })
              const completions = (state.activeProcess!.pendingProxyCompletions ??= new Map())
              if (!completions.has(call.toolCallId)) {
                completions.set(call.toolCallId, {
                  call,
                  result,
                  recoveryRequired: channelClosed || state.unattendedTurnEnded,
                })
              }
              // With a closed channel this only clears the broker entry;
              // proxy-mcp drops the write and the result travels below.
              resolvePendingProxyCallById(call.toolCallId, result)
            } else {
              log.info(
                "leaving unmatched parallel proxy call pending",
                {
                  sessionKey: sk,
                  toolCallId: call.toolCallId,
                  toolName: call.toolName,
                },
              )
            }
          }

          if (state.unattendedTurnEnded) deliverPendingCompletions()

          // Calls queued while no turn was attached were never handed to
          // opencode; the child is blocked on them right now.
          const unemitted = getPendingProxyCalls(sk).filter(
            (call) => !call.emitted,
          )
          if (unemitted.length > 0) {
            log.notice("draining proxy calls queued between turns", {
              sessionKey: sk,
              toolCallIds: unemitted.map((call) => call.toolCallId),
            })
            state.drainBuffer.push(...unemitted)
            drainNow()
            return
          }

          if (getPendingProxyCalls(sk).length === 0) {
            armStartWatchdog()
          }
          return
        }

        // No pending calls had matching tool-results. If any pending calls
        // are still hanging around from a prior turn, reject them so the
        // HTTP handlers in proxy-mcp don't sit blocked forever while we
        // proceed with a brand new user message.
        if (previousPendingProxyCalls.length > 0) {
          for (const call of previousPendingProxyCalls) {
            rejectPendingProxyCallById(
              call.toolCallId,
              new Error(
                `Pending proxy call '${call.toolName}' (${call.toolCallId}) was orphaned by a new user turn; rejecting`,
              ),
            )
          }
        }

        // Send the user message for a fresh turn.
        if (state.activeProcess) noteTurnStarted(state.activeProcess)
        state.proc.stdin?.write(userMsg + "\n")
        log.debug("sent user message", { textLength: userMsg.length })
        // Arm the start watchdog so a reused child that goes silent after
        // the envelope write (seen after a long proxy-blocked tool call)
        // is respawned with --session-id instead of hanging the turn.
        armStartWatchdog()
        }

        void setup().catch((err) => {
          log.error("failed to set up doStream", {
            error: err instanceof Error ? err.message : String(err),
          })
          controller.enqueue({
            type: "error",
            error: err instanceof Error ? err : new Error(String(err)),
          })
          try {
            controller.close()
          } catch {}
        })
      },
      cancel() {
        // Consumer cancelled the stream
      },
    })

    return {
      stream,
      request: { body: { text: userMsg } },
      response: { headers: {} },
    }
  }
}
