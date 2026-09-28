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
import { translateStreamForHost } from "./host-tools.js"
import { getClaudeUserMessage } from "./message-builder.js"
import {
  resolveAgentEffort,
  resolveAgentModel,
} from "./agent-models.js"
import {
  type ModelFallbackAttempt,
  type ModelRefusal,
  formatModelFallbackNote,
  nextFallbackModel,
  resolveFallbackChain,
} from "./model-fallback.js"
import {
  parseSideQuestion,
  requestSideQuestion,
  collectSideQuestionHistory,
  SIDE_QUESTION_USAGE,
  type SideQuestionResult,
} from "./side-question.js"
import {
  BTW_NO_SESSION_MESSAGE,
  registerAsideSink,
  takeSideQuestionAnswer,
} from "./btw-command.js"
import { formatSilentTurnNote } from "./cli-events.js"
import {
  DEFAULT_ACCOUNT,
  normalizeAccountName,
} from "./accounts.js"
import {
  buildFailoverContinuationPrompt,
  consumeAccountFailoverAnswer,
  createAccountFailoverQuestionCall,
  describeAccountBlock,
  failoverCandidates,
  failoverUntil,
  formatFailoverNote,
  formatFailoverStopNote,
  isAccountFailoverQuestionActive,
  resolveFailoverSpawn,
  setAccountOverride,
  type FailoverSpawn,
} from "./account-failover.js"
import {
  DOCTOR_COMMAND,
  buildDoctorReport,
  parseDoctorCommand,
} from "./doctor.js"
import { resolveSkillPluginDirs } from "./skill-bridge.js"
import { parseModelId } from "./models.js"
import { consumeExitPlanModeQuestionResult } from "./plan-mode-question.js"
import { RuntimeMcpStatus } from "./mcp-bridge.js"
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
  isSilentTurn,
} from "./auto-continue.js"
import {
  describeAbortReason,
  hasNewUserContent,
  resolveCompactionModel,
  resolveOpencodeAgent,
  resolveSessionAffinity,
} from "./call-options.js"
import { extractPendingProxyResultForCall } from "./proxy-results.js"
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
import {
  toFinishReason,
  toUsage,
} from "./usage.js"
import { createTurnState } from "./turn-state.js"
import { createLineHandler } from "./stream-parser.js"
import {
  DRAIN_QUIET_MS,
  armStartWatchdog,
  clearFallbackTimer,
  clearStartWatchdog,
  deliverPendingCompletions,
  drainNow,
  finishWithQuestionCall,
  noteProxyActivity,
  noteResultBoundaryCall,
  noteToolActivity,
  runAutoContinue,
  startResultFallback,
} from "./turn-controller.js"

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

        // The turn's timers, its batched drain and its auto-continue window
        // live in src/turn-controller.ts now, taking the `TurnState` they used
        // to close over. What stayed is what also reads the turn's prologue:
        // the line handler, the close handler and `completeResult` below.
        const completeResult = (msg: ClaudeStreamMessage) => {
          if (state.controllerClosed) return
          // The socket may have closed after the tool-result prompt was matched,
          // or while the result-boundary grace timer was running.
          if (deliverPendingCompletions(state)) {
            if (state.drainBuffer.length > 0) drainNow(state)
            return
          }
          if (state.drainBuffer.length > 0) {
            drainNow(state)
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
            finishWithQuestionCall(state, call)
            return
          }

          // Nothing above took the turn, so the chain may. Deliberately below
          // the form: when another account is on offer a usage limit is the
          // operator's decision to make, and only an account with nothing to
          // switch to falls back onto a cheaper model instead. A per-model
          // weekly cap is the case that makes that worth doing at all, and it
          // is why the limit is a chain trigger and not only a failover one.
          //
          // `accountBlock` is excluded on purpose: an expired login or a
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

          // The nudge and the one line that says the nudging stopped, both
          // in src/turn-controller.ts. True means the turn was put back to
          // work and must not finish here.
          if (runAutoContinue(state, msg)) return

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

        const lineHandler = createLineHandler(state, {
          config: self.config,
          compactionMode,
          fastMode,
          planModeQuestionActive,
          sourceAccount,
          failoverAskActive,
          modelFallbackArmed,
          attempt,
          handleControlRequest,
          completeResult,
        })

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
          clearFallbackTimer(state)
          state.pendingResultCompletion = null
          clearStartWatchdog(state)
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

        // The four handlers go onto the state as soon as all four exist, and
        // before anything can call one. The start watchdog's respawn detaches
        // and re-attaches all three listeners from src/turn-controller.ts, and
        // the inactivity watchdog ends the turn through `closeHandler`: both
        // run on a timer armed at the end of this function, so they read the
        // same function objects `cleanupTurn` below detaches.
        state.lineHandler = lineHandler
        state.closeHandler = closeHandler
        state.procErrorHandler = procErrorHandler
        state.cleanupTurn = cleanupTurn

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
            clearFallbackTimer(state)
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
          noteProxyActivity(state)
          noteToolActivity(state)
          state.drainBuffer.push(call)
          if (noteResultBoundaryCall(state)) return
          if (state.drainTimer) clearTimeout(state.drainTimer)
          state.drainTimer = setTimeout(() => drainNow(state), DRAIN_QUIET_MS)
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
            startResultFallback(state, 5_000)
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

          if (state.unattendedTurnEnded) deliverPendingCompletions(state)

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
            drainNow(state)
            return
          }

          if (getPendingProxyCalls(sk).length === 0) {
            armStartWatchdog(state)
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
        armStartWatchdog(state)
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
