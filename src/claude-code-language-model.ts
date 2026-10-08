import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3Warning,
} from "@ai-sdk/provider"
import { join } from "node:path"
import { generateId } from "./ids.js"
import type {
  ClaudeCodeConfig,
  ControlRequestBehavior,
  ClaudeStreamMessage,
  ReasoningEffort,
} from "./types.js"
import { translateStreamForHost } from "./host-tools.js"
import { getClaudeUserMessage, getTrailingUserMessages } from "./message-builder.js"
import {
  getAgentRegistry,
  qualifyModelName,
  resolveAgentCacheTtl,
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
import {
  formatCompactionFailure,
  formatSilentTurnNote,
  formatUnattendedReplayNote,
} from "./cli-events.js"
import {
  DEFAULT_ACCOUNT,
  normalizeAccountName,
} from "./accounts.js"
import {
  accountGroup,
  accountProviderMap,
  accountsInGroupOf,
  accountsShareGroup,
  formatAccountGroupNote,
} from "./account-groups.js"
import {
  buildFailoverContinuationPrompt,
  consumeAccountFailoverAnswer,
  createAccountFailoverQuestionCall,
  describeAccountBlock,
  failoverCandidates,
  failoverUntil,
  formatFailoverNote,
  formatFailoverStopNote,
  formatUsageLimitNote,
  isAccountFailoverQuestionActive,
  resolveFailoverSpawn,
  setAccountOverride,
  stripAccountSuffix,
  type FailoverSpawn,
} from "./account-failover.js"
import {
  DOCTOR_COMMAND,
  buildDoctorReport,
  parseDoctorCommand,
} from "./doctor.js"
import { resolveSkillPluginDirs } from "./skill-bridge.js"
import { parseModelId } from "./models.js"
import {
  consumeExitPlanModeQuestionResult,
  hasExitPlanModeQuestions,
  type QuestionToolCall,
} from "./plan-mode-question.js"
import { RuntimeMcpStatus } from "./mcp-bridge.js"
import {
  getRuntimeMcpStatus,
  resolveMcpConnectWaitMs,
  fetchSessionParentId,
  resolveSpawnCwdForSession,
  fetchSessionRunState,
  settleSessionRunState,
} from "./runtime-status.js"
import {
  getActiveProcess,
  processBelongsToAnotherAccount,
  setActiveProcess,
  noteInteractiveProcessExit,
  claudeSpawnEnv,
  spawnClaudeProcess,
  buildCliArgs,
  setClaudeSessionId,
  getClaudeSessionId,
  claudeSessionIsWriting,
  listClaudeSessionKeys,
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
  transferClaudeSession,
  describeSessionKey,
} from "./session-manager.js"
import { interactiveSpawnEnv, spawnInteractiveProcess } from "./claude-session-wrapper.js"
import {
  clearCompression,
  consumeCompressionRestart,
  getCompressionSummary,
} from "./compression-store.js"
import { log } from "./logger.js"
import {
  cliSupportsDontAsk,
  cliSupportsInteractiveBypass,
  cliSupportsRestricted,
  detectCliSupportsFlag,
  detectCliVersion,
  reportUnmeasuredInteractiveCli,
} from "./cli-version.js"
import { interactivePermissionPosture, isReadOnlyPermissionMode } from "./permission-presets.js"
import { hasInteractiveTransport, requestedTransport, selectTransport } from "./transport.js"
import { findForkParent, recordForkFingerprint } from "./session-fork.js"
import {
  findForeignAccountSibling,
  findResumePoint,
  findSiblingResumePoint,
  recordResumePoint,
} from "./session-resume-store.js"
import { recordSessionSpawn } from "./spawn-record-store.js"
import { encodeCwd, resolveConfigDir } from "./claude-session-bun.js"
import {
  carryTranscriptToAccount,
  configDirForAccount,
} from "./account-transcript.js"
import {
  formatStaleBuildNote,
  staleBuildWatch,
  type StaleBuild,
} from "./stale-build.js"
import {
  noteBackgroundDispatchResult,
  withBackgroundRunningCount,
  recordBackgroundSubagentGate,
} from "./background-tasks.js"
import {
  resolveDisallowedTools,
  resolveProxyOpencodeToolDefs,
  overlayTaskProxyDescription,
  overlayQuestionProxyDescription,
  filterQuestionProxyByOpencodeSupport,
  applyBackgroundSubagentSupport,
  liveTaskSupportsBackground,
  setProxyDeadlineGuard,
  TASK_BATCH_TOOL_NAME,
  taskBatchChildToolCallId,
  taskBatchTasks,
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
  userAuthoredInstructions,
  QUESTION_PROXY_HINT,
  SUBAGENT_DISPATCH_HINT,
  BACKGROUND_SUBAGENT_HINT,
  backgroundSubagentHint,
  codeModeProxyHint,
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
  type McpServerRouting,
} from "./spawn-planning.js"
import {
  decideMcpHotReload,
  logMcpHotReloadDecision,
  noteMcpHotReload,
} from "./mcp-hot-reload.js"
import {
  isTitleRequest,
  latestUserText,
  requestScope,
  synthesizeTitle,
} from "./title.js"
import {
  lastCallContextUsage,
  toFinishReason,
  toUsage,
} from "./usage.js"
import {
  claimDispatchChoice,
  consumeSubagentDispatchAnswer,
  createSubagentDispatchQuestion,
  dispatchTasksFromCalls,
  firstUserText,
  hasCandidateClaim,
  isSubagentDispatchActive,
  lookupSessionChoice,
  recordDispatchClaims,
  resolveDispatchAccountSpawn,
  type DispatchContext,
  type SubagentChoice,
  type SubagentDispatchStep,
} from "./subagent-dispatch.js"
import { createTurnState } from "./turn-state.js"
import { watchTurnAbort } from "./turn-abort.js"
import { createLineHandler } from "./stream-parser.js"
import {
  DRAIN_QUIET_MS,
  armStartWatchdog,
  clearFallbackTimer,
  clearStartWatchdog,
  deliverPendingCompletions,
  drainNow,
  enqueueProxyToolCall,
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
  BACKGROUND_SUBAGENT_HINT,
  BACKGROUND_SUBAGENT_HINT_V2,
  backgroundSubagentHint,
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

// How long the CLI gets to enqueue a forwarded user message before the parked
// proxy call it is blocked in is resolved. Measured lag of the enqueue behind
// the tool result without it: up to 19 ms.
export const FORWARD_SETTLE_MS = 250

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

  /** Resolve ProxyToolDef[] for opencode's MCP-backed tools, and route the rest. */
  private resolvedProxyMcpTools(
    allEnabledServerNames: string[],
    modelTools: readonly ModelToolEntry[] | undefined,
    taken?: ReadonlySet<string>,
    runtimeStatus?: RuntimeMcpStatus,
  ): McpServerRouting | null {
    return resolvedProxyMcpTools(
      this.config,
      allEnabledServerNames,
      modelTools,
      taken,
      runtimeStatus,
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
   * What a subagent dispatch form chose for THIS session, or undefined.
   *
   * Two lookups, cheapest first. A session that already claimed a choice keeps
   * it for the rest of its life, because the model and effort are in its
   * session key and a choice that came and went mid-conversation would strand
   * the key behind it. Otherwise, and only when a released dispatch actually
   * recorded a claim this session could match, the parent is fetched and the
   * claim taken: a choice must never land on the wrong child (h #g227).
   */
  private async resolveDispatchChoice(
    options: LanguageModelV3CallOptions,
    affinity: string,
  ): Promise<SubagentChoice | undefined> {
    if (affinity === "default") return undefined
    const claimed = lookupSessionChoice(affinity)
    if (claimed) return claimed
    const agent = this.getOpencodeAgent(options)
    const prompt = firstUserText(options.prompt)
    if (!hasCandidateClaim(agent, prompt)) return undefined
    return claimDispatchChoice({
      sessionId: affinity,
      agent,
      prompt,
      parentSessionId: await fetchSessionParentId(affinity),
    })
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
   * A dispatch form, as a turn: one synthetic `question` tool call and a
   * `tool-calls` finish, which is how the operator's answer comes back on the
   * next `doStream` as a `tool-result` with the same id. The same mechanism
   * `finishWithQuestionCall` gives the plan-approval bridge and the
   * account-switch form, minus a Claude process, because there is nothing for
   * the CLI to do while the operator reads a form.
   */
  private subagentDispatchFormStream(
    call: QuestionToolCall,
    warnings: SharedV3Warning[],
  ): Awaited<ReturnType<LanguageModelV3["doStream"]>> {
    const toUsage = this.toUsage.bind(this)
    const toFinishReason = this.toFinishReason.bind(this)
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings })
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
          usage: toUsage({ input_tokens: 0, output_tokens: 0 }),
          providerMetadata: {
            "claude-code": { synthetic: true, path: "subagent-dispatch-form" },
          },
        })
        controller.close()
      },
    })
    return { stream, request: { body: { text: "" } } }
  }

  /**
   * The release: the dispatch the form was holding, handed to opencode as the
   * `task` tool calls it would have been without the form, with every task's
   * answer recorded as a claim its child will take.
   *
   * A held call that is gone (its deadline, an abort, the child dying while
   * the form was up) is skipped rather than invented, and with every call gone
   * the turn finishes on `stop`: there is nothing left to dispatch and ending
   * on `tool-calls` with no tool calls is a protocol violation.
   */
  private subagentDispatchReleaseStream(
    step: Extract<SubagentDispatchStep, { kind: "release" }>,
    sessionKey: string,
    warnings: SharedV3Warning[],
  ): Awaited<ReturnType<LanguageModelV3["doStream"]>> {
    const recorded = recordDispatchClaims(step.parentSessionId, step.tasks, step.choices)
    const held = step.heldCallIds
      .map((id) => findPendingProxyCall(id))
      .filter((call): call is PendingProxyCall => !!call)
    log.notice("releasing a held subagent dispatch", {
      sessionKey,
      tasks: step.tasks.length,
      claims: recorded,
      released: held.length,
      dropped: step.heldCallIds.length - held.length,
    })
    const toUsage = this.toUsage.bind(this)
    const toFinishReason = this.toFinishReason.bind(this)
    const note = step.note
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings })
        if (note) {
          const id = generateId()
          controller.enqueue({ type: "text-start", id } as any)
          controller.enqueue({ type: "text-delta", id, delta: note })
          controller.enqueue({ type: "text-end", id })
        }
        for (const call of held) {
          if (call.toolName === TASK_BATCH_TOOL_NAME) {
            for (const [index, task] of taskBatchTasks(call.input).entries()) {
              enqueueProxyToolCall(
                controller,
                taskBatchChildToolCallId(call.toolCallId, index),
                "task",
                task,
              )
            }
          } else {
            enqueueProxyToolCall(controller, call.toolCallId, call.toolName, call.input)
          }
          markPendingProxyCallEmitted(call.toolCallId)
        }
        controller.enqueue({
          type: "finish",
          finishReason: toFinishReason(held.length > 0 ? "tool-calls" : "stop"),
          usage: toUsage({ input_tokens: 0, output_tokens: 0 }),
          providerMetadata: {
            "claude-code": { synthetic: true, path: "subagent-dispatch-release" },
          },
        })
        controller.close()
      },
    })
    return { stream, request: { body: { text: "" } } }
  }

  /**
   * Create a proxy MCP server for a single active Claude process/session.
   * The process lifecycle owns the server lifecycle via session-manager.
   */
  private async ensureProxyServer(
    tools: ProxyToolDef[],
    sessionKeyForCalls: string,
    interceptCompress: boolean,
    callerSessionId?: string,
  ): Promise<ProxyMcpServer> {
    return ensureProxyServer(
      this.config,
      tools,
      sessionKeyForCalls,
      interceptCompress,
      callerSessionId,
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
    // Created before the prologue's first await, because
    // `addEventListener("abort")` on a signal that already aborted never
    // fires: the stream's own abort handler cannot exist until this prologue
    // has finished, so a stop that landed in here used to be observed by
    // nobody and the turn spawned, wrote and billed anyway.
    // src/turn-abort.ts, (h #g182).
    const turnAbort = watchTurnAbort(options.abortSignal)
    // How an abort observed before the CLI was ever asked for work ends the
    // turn: nothing spawned, nothing written, no `interrupt` for a turn this
    // doStream did not start, and proxy calls an earlier step left pending
    // are not touched, so the next message's orphan sweep still owns them
    // (h #g26, h #g82). The stream closes with no `finish` and no `error`,
    // which is how the abort branch already ends a turn that had no content.
    const abortedBeforeWork = (
      stage: string,
    ): Awaited<ReturnType<LanguageModelV3["doStream"]>> => {
      log.info("abort before the turn asked claude for work; nothing spawned", {
        stage,
        reason: describeAbortReason(turnAbort.reason),
      })
      turnAbort.dispose()
      const aborted = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings })
          controller.close()
        },
      })
      return { stream: aborted, request: { body: { text: "" } } }
    }
    const skipPermissions = this.config.skipPermissions !== false
    const scope = this.requestScope(options as any)
    const affinity = this.sessionAffinity(options)
    const cwd = await resolveSpawnCwdForSession(this.config.cwd, affinity)
    const compactionMode = this.isCompactionCall(options)
    // What a dispatch form chose for THIS session, when it is a subagent one
    // chose for (h #g227). Resolved here because the model and the effort it
    // can carry are both part of the session key below, and the account it can
    // carry decides which binary the turn spawns.
    //
    // A default install pays one `Map.get` and one scan of an empty array:
    // `hasCandidateClaim` can only be true once a dispatch has actually been
    // released, and `fetchSessionParentId` is reached only behind it.
    const dispatchChoice = compactionMode
      ? undefined
      : await this.resolveDispatchChoice(options, affinity)
    // Use a separate session key for compaction so its short-lived spawn
    // never collides with the main conversation's claude process.
    // A fallback attempt replaces the model NAME and nothing else, which is
    // the same swap `resolveAgentModel` performs and the reason the chain
    // needs no separate plumbing: the id flows into the session key, the
    // effort key, the spawn, the logs and the metadata exactly as a
    // `forceModel` would. Compaction is never given one.
    //
    // A dispatch choice beats both the agent definition and the provider
    // options, because the operator answered a form about THIS dispatch and a
    // file on disk cannot have known about it. A model it names that this
    // install does not have is refused by `qualifyModelName` exactly as a
    // `forceModel` is, and the default stands.
    const dispatchModelId = dispatchChoice?.model
      ? qualifyModelName(dispatchChoice.model, this.modelId)
      : null
    const effectiveModelId = compactionMode
      ? this.resolveCompactionModel()
      : (attempt?.modelOverride ??
        dispatchModelId ??
        resolveAgentModel(
          this.getOpencodeAgent(options),
          this.modelId,
        ))
    if (attempt) attempt.modelId = effectiveModelId
    // Compaction skips request/agent effort overrides; other calls key on it.
    const reasoningEffort = compactionMode
      ? undefined
      : ((dispatchChoice?.effort ??
          resolveAgentEffort(
            this.getOpencodeAgent(options),
            this.getReasoningEffort(options.providerOptions),
          )) as ReasoningEffort | undefined)
    // Compaction keeps the CLI's own cache default, exactly as it skips
    // effort: its spawn is short-lived and its cost belongs to no agent.
    const promptCacheTtl = compactionMode
      ? undefined
      : resolveAgentCacheTtl(this.getOpencodeAgent(options))
    // The TTL changes the spawn, so it has to be in the session key. Two
    // deliberate shape choices. It rides inside the existing context blob
    // rather than as another `::` tail, because `invalidateOtherEffortSessions`
    // rebuilds keys from `baseKey` plus an effort tail and a second tail would
    // make it miss them. And it is appended only when set, so a default
    // install's key is byte-identical to what it was before this option
    // existed: an upgrade must not strand every live conversation's process
    // behind a key nobody will look up again.
    const context: (string | null)[] = [
      this.config.provider,
      this.getOpencodeAgent(options) ?? null,
    ]
    if (promptCacheTtl) context.push(promptCacheTtl)
    const baseKey = sessionKey(
      cwd,
      `${effectiveModelId}::${scope}::${affinity}::context=${JSON.stringify(context)}`,
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
    const transport = requestedTransport(this.config)
    const doctor =
      !compactionMode && scope !== "no-tools" ? parseDoctorCommand(options.prompt) : null
    // Legacy interactive keeps its historical non-Bun fallback. Explicit
    // transport selection fails clearly instead of silently changing modes.
    const selectedTransport = doctor
      ? transport === "interactive" ? "interactive" : "headless"
      : this.config.transport === undefined && !hasInteractiveTransport()
      ? "headless"
      : this.isTitleRequest(scope, options) && !compactionMode
        ? "headless"
        : await Promise.race([selectTransport(transport, this.config.cliPath), turnAbort.whenAborted])
    if (turnAbort.aborted) return abortedBeforeWork("selecting the transport")
    const useInteractive = selectedTransport === "interactive"
    const interactiveBypassRequested =
      this.config.interactiveBypass ??
      flagOn(process.env.CLAUDE_CODE_INTERACTIVE_BYPASS)

    // Whether this attempt may be thrown away and retried on the next model.
    // Compaction is out because its answer is a stored summary and a second
    // model would rewrite it. The interactive transport is in: the TUI writes
    // a refusal as the same `error: "model_not_found"` reply headless streams
    // (measured on 2.1.288), and `streamFrameFromRecord` gives the parser the
    // stream's spelling of it (h #g209). A `doGenerate` turn is armed like any
    // other now that it is this same code: a title stub returns before
    // reaching here, so what a chain can reach is a real spawn, and a refusal
    // there is worth retrying.
    const modelFallbackArmed =
      attempt?.armed === true && !compactionMode

    // Account failover. When a previous turn hit this account's usage limit
    // and the operator picked another account, every turn from then on spawns
    // that account's wrapper instead, until the limit's reset time. The
    // override is keyed on the ACCOUNT, so it covers every session running on
    // it, subagents included. Resolved here, before anything reads `cliPath`.
    //
    // Both transports: the TUI spawns the other account's wrapper and tails
    // that account's transcripts (h #g209).
    // A dispatch form can name the account a subagent runs on, and from that
    // point this session IS that account's: the limit memory, the switch form
    // and the transcript carry below all have to be about the account that
    // actually spawns (h #g227). The form only ever offers an account the
    // dispatching one shares a group with, unless `subagentDispatchCrossGroup`
    // is on.
    const providerAccount = normalizeAccountName(
      this.config.account ?? DEFAULT_ACCOUNT,
    )
    const dispatchAccount =
      dispatchChoice?.account &&
      normalizeAccountName(dispatchChoice.account) !== providerAccount
        ? normalizeAccountName(dispatchChoice.account)
        : undefined
    const sourceAccount = dispatchAccount ?? providerAccount
    // The account topology (h #g226). `accountProviders` is empty on a
    // single-account install, which is what keeps every signature below
    // byte-identical there; `groups` is null unless the operator set
    // `accountGroups`, which is what keeps the guard opt-in.
    const accountProviders = accountProviderMap(this.config.failoverAccounts)
    const groups = this.config.accountGroups ?? null
    const baseCliPath = this.config.baseCliPath ?? this.config.cliPath
    // Where the dispatch moved the account, the spawn it would otherwise have
    // used is replaced before the failover override is resolved on top, so a
    // limit on the account this subagent was sent to is the limit that counts.
    const dispatchSpawn: FailoverSpawn | null = dispatchAccount
      ? await resolveDispatchAccountSpawn({
          account: dispatchAccount,
          baseCliPath,
          modelId: effectiveModelId,
        })
      : null
    let failover: FailoverSpawn
    if (compactionMode) {
      failover = { cliPath: this.config.cliPath, modelId: effectiveModelId, failedOver: false }
    } else {
      const overridden = await resolveFailoverSpawn({
        account: sourceAccount,
        baseCliPath,
        cliPath: dispatchSpawn?.cliPath ?? this.config.cliPath,
        modelId: dispatchSpawn?.modelId ?? effectiveModelId,
      })
      // A usage-limit override on the account the dispatch chose wins; with no
      // override the dispatch's own spawn stands, and with neither this is the
      // untouched value every install had before.
      failover = overridden.failedOver ? overridden : (dispatchSpawn ?? overridden)
    }
    let cliPath = failover.cliPath

    // First checkpoint: the two awaits above both talk to opencode and both
    // can be slow. Taken here, before the doctor, `/btw` and title branches
    // do any work of their own and before this turn consumes a stored
    // failover or plan-approval answer.
    if (turnAbort.aborted) return abortedBeforeWork("resolving the spawn cwd and account")

    // Tagged onto the process each turn so the /btw command hook, which only
    // knows the opencode session id, can find it and ask it early
    // (btw-command.ts).
    const asideTransportRef = { cliPath, interactive: !!useInteractive }

    // `/claude-code-doctor` is answered here, by the plugin, with no CLI
    // inference at all: everything in the report is already in this process.
    // Same shape as the aside branch below, and the exchange is stripped from
    // rebuilt transcripts the same way a `/btw` pair is.
    if (doctor) {
      const doctorOptions = {
        cliPath,
        interactive: !!useInteractive,
        turnStats: this.config.turnStats === true,
        ignoreAnthropicApiKey: this.config.ignoreAnthropicApiKey === true,
        // Where the plugin applies the account itself rather than through a
        // wrapper (`accountInProcess`, Windows), the `/cost` spawn needs the
        // same config dir a turn gets, or it reports the default account's
        // plan usage instead of this provider's.
        configDir: this.config.accountInProcess ? this.config.configDir : undefined,
        // `/claude-code-doctor usage` opts into the CLI's own plan-usage
        // report; anything else here is ignored, as it always has been.
        argument: doctor.rest,
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
    if (!compactionMode && !hasNewUserContent(options.prompt)) {
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

    // The subagent dispatch form's own turns (h #g227). Both of them are
    // answered here, in the prologue, and neither one touches the Claude CLI:
    // the child is parked inside the `task` MCP call it made, and everything
    // this turn has to do is write stream parts.
    //
    // It must return before `setup()` runs, and that is not an optimisation.
    // The held calls are pending-but-unemitted, and the orphan sweep in there
    // rejects exactly those on a turn that carries no matching tool result,
    // which is what this turn is: it carries the answer to a `question`.
    const dispatchStep = compactionMode
      ? null
      : consumeSubagentDispatchAnswer(sk, options.prompt as any)
    if (dispatchStep?.kind === "form") {
      return this.subagentDispatchFormStream(dispatchStep.call, warnings)
    }
    if (dispatchStep?.kind === "release") {
      return this.subagentDispatchReleaseStream(dispatchStep, sk, warnings)
    }

    if (!compactionMode) invalidateOtherEffortSessions(baseKey, reasoningEffort)

    // What this session REALLY spawns as, for the TUI's Subagents section
    // (h #g234). Written here, past every branch that answers without the CLI
    // (title, doctor, aside, the dispatch form), because opencode only ever
    // knows the model it asked for: forceModel, an agent's effort, the dispatch
    // form, the fallback chain and a failover all change the spawn without
    // telling it. One write per session per process, more only on change.
    if (!compactionMode && affinity !== "default") {
      recordSessionSpawn(affinity, {
        model: stripAccountSuffix(failover.modelId),
        effort: reasoningEffort,
        account:
          (this.config.failoverAccounts?.length ?? 0) > 1
            ? (failover.target ?? sourceAccount)
            : undefined,
      })
    }

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
      compactionMode || mode === "generate"
        ? null
        : consumeAccountFailoverAnswer(sk, options.prompt as any, {
            sourceAccount,
            candidates: failoverCandidates(
              this.config.failoverAccounts,
              sourceAccount,
              groups,
            ),
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

    // A live process belongs to the account it was spawned with, so it cannot
    // follow the conversation across a switch: a child speaks to the CLI it
    // was spawned as, and the interactive shim carries the path it was spawned
    // with too (h #g209), so a TUI on the limited account is replaced the same
    // way. The CONVERSATION is a separate question, answered just below.
    // The `CLAUDE_CONFIG_DIR` this turn's spawn exports for itself, which is
    // only where no wrapper script carries the account (`accountInProcess`,
    // Windows, h #g221). Undefined everywhere else, so every POSIX install is
    // on exactly the path it was before.
    const spawnConfigDir = this.config.accountInProcess
      ? this.skillBridgeSpawn(failover).configDir
      : undefined
    const processForAccount = getActiveProcess(sk)
    if (
      !compactionMode &&
      processBelongsToAnotherAccount(processForAccount, cliPath, spawnConfigDir)
    ) {
      log.notice("claude process belongs to another account; starting fresh", {
        sessionKey: sk,
        was: processForAccount?.cliPath,
        now: cliPath,
        failedOver: failover.failedOver,
      })
      deleteActiveProcess(sk)
    }

    // The conversation itself moves by file: a Claude transcript is one file
    // under one account's config dir, and 2.1.288 resumes a copy of it placed
    // under another one with its context intact (h #g218). So a switch carries
    // the transcript into the account this turn is about to spawn and keeps
    // the session id, and the `--resume` both transports already build does
    // the rest; a refusal drops the id and the thread is replayed as text,
    // which is what every switch did before. Runs in both directions, so it
    // also carries the conversation home when the override expires.
    //
    // Gated on more than one account: an install that cannot fail over must
    // not pay a `stat` per turn for a question it can never ask. A turn
    // stopped between the copy and the spawn leaves the copy behind, which is
    // harmless: the next turn finds the conversation already there.
    let conversationOnTarget = false
    const multiAccount = (this.config.failoverAccounts?.length ?? 0) > 1
    const sessionBeforeAccountCheck = getClaudeSessionId(sk)
    if (
      !compactionMode &&
      multiAccount &&
      this.config.crossAccountResume !== false &&
      sessionBeforeAccountCheck
    ) {
      const carry = await carryTranscriptToAccount({
        sessionId: sessionBeforeAccountCheck,
        cwd,
        targetConfigDir: resolveConfigDir(this.skillBridgeSpawn(failover).configDir),
        // Every account's own directory, plus this model's configured one:
        // `configDir` is an option, so an account's directory is not always
        // the `~/.claude-<name>` the name alone would build.
        // Same-group accounts only (h #g226): a transcript sitting in an
        // account from another group is not a source this may read from, and
        // with no groups configured this is the full list exactly as before.
        accountConfigDirs: [
          ...accountsInGroupOf(sourceAccount, this.config.failoverAccounts, groups).map(
            configDirForAccount,
          ),
          resolveConfigDir(this.config.configDir),
        ],
      })
      if (carry.kind === "carried" || carry.kind === "already-there") {
        // A renamed copy is the same conversation under a new id, because the
        // CLI resolves a session by filename and the target path was taken by
        // an older copy from an earlier switch.
        if (carry.sessionId !== sessionBeforeAccountCheck) {
          setClaudeSessionId(sk, carry.sessionId)
        }
        conversationOnTarget = true
        if (carry.kind === "carried") {
          log.notice("carried this conversation's claude transcript to the other account", {
            sessionKey: sk,
            renamed: carry.renamed,
            sessionId: carry.sessionId,
            failedOver: failover.failedOver,
          })
        }
      } else if (!getActiveProcess(sk)) {
        // The id names a transcript the account this turn spawns cannot see,
        // and `--resume` on it would fail outright, so it goes and the thread
        // is replayed. Only with the child gone: while it is alive the
        // conversation is in the child rather than in a file, nothing is about
        // to resume anything, and dropping the id would take the todo ledger
        // and the resume record with it for no reason.
        log.notice("replaying this conversation as text on the other account", {
          sessionKey: sk,
          reason: carry.reason,
          failedOver: failover.failedOver,
        })
        deleteClaudeSessionId(sk)
      }
    } else if (
      !compactionMode &&
      sessionBeforeAccountCheck &&
      processBelongsToAnotherAccount(processForAccount, cliPath, spawnConfigDir)
    ) {
      // The carry is off, or there is only one account: the account this turn
      // spawns cannot see that transcript either way.
      deleteClaudeSessionId(sk)
    }

    const hasExistingSession = !!getClaudeSessionId(sk)
    const hasActiveProcess = !!getActiveProcess(sk)
    let includeHistoryContext =
      !hasExistingSession && !hasActiveProcess && hasPriorConversation
    // A fresh session on the other account holds none of this conversation,
    // so the replay is not optional on a switch the way it is on a normal
    // turn. A carried transcript IS this conversation, so there is nothing to
    // replay into it and doing so would hand the model the thread twice.
    if (failoverAnswer?.kind === "switch" && hasPriorConversation && !conversationOnTarget) {
      includeHistoryContext = true
    }

    // The `accountGroups` guard (h #g226). The operator moved this opencode
    // conversation to an account in another group, by picking a model under
    // its provider: nothing of the conversation may go there, so neither half
    // of the two ways it could happens. The transcript carry is already out
    // (the sibling lookup below refuses a cross-group account), and this is
    // what takes the REPLAY out, which is the same history by another route
    // and would defeat the guard on its own.
    //
    // Detection is deliberately broader than the carry's: any account outside
    // this group that has answered this same opencode conversation counts,
    // whether or not its content still lines up, because the replay is exactly
    // what happens when the carry would have been refused.
    //
    // Gated on `includeHistoryContext`, so it fires once, on the turn that was
    // about to send the thread. The next turn on this account has a session of
    // its own and is an ordinary turn.
    //
    // The source keeps everything: no transfer, no `deleteClaudeSessionId`, and
    // the carry never deletes a transcript, so switching back resumes it.
    let accountGroupNote: string | null = null
    if (
      !compactionMode &&
      groups &&
      accountProviders.size > 0 &&
      includeHistoryContext &&
      failoverAnswer?.kind !== "switch"
    ) {
      const foreign = findForeignAccountSibling({
        sessionKey: sk,
        accountProviders,
        // The live process's own view, so the guard holds with
        // `resumeAfterRestart: false`, where the store is never written.
        extraKeys: listClaudeSessionKeys(),
      })
      if (foreign && !accountsShareGroup(sourceAccount, foreign.account, groups)) {
        includeHistoryContext = false
        accountGroupNote = formatAccountGroupNote({
          sourceAccount: foreign.account,
          sourceGroup: accountGroup(foreign.account, groups),
          targetAccount: sourceAccount,
          targetGroup: accountGroup(sourceAccount, groups),
        })
        log.notice("starting fresh on this account: it is in another account group", {
          sessionKey: sk,
          reason: "another-account-group",
          account: sourceAccount,
          from: foreign.account,
          group: accountGroup(sourceAccount, groups),
        })
      }
    }

    // A new opencode session that is a FORK of one this provider already
    // served does not have to pay for its inherited thread twice. Neither
    // opencode major tells a provider that a session is a fork (see
    // `src/session-fork.ts`), so the parent is found by matching this
    // prompt's history against the conversation each sibling key was last
    // asked to continue. Opt-in: a forked Claude conversation answers under
    // the system prompt recorded on the PARENT's first request, which is the
    // one thing here the replay does differently.
    let forkFromClaudeSessionId: string | undefined
    if (
      this.config.forkSessions === true &&
      includeHistoryContext &&
      !compactionMode &&
      failoverAnswer?.kind !== "switch"
    ) {
      const parent = findForkParent({
        sessionKey: sk,
        prompt: options.prompt,
        cliPath,
        lookupClaudeSessionId: getClaudeSessionId,
        // `claudeSessionIsWriting`, not `getActiveProcess`: this walks every
        // sibling key, and that one refreshes LRU order and cancels idle
        // timers on everything it touches. An idle live child is fine to
        // branch from; a transcript mid-write is not.
        isBusy: claudeSessionIsWriting,
      })
      if (parent) {
        // The only await this branch adds, and it is cached per binary for
        // the life of the process. Raced against the abort for the same
        // reason the MCP status call below is: this is still the prologue.
        const supported = await Promise.race([
          detectCliSupportsFlag(cliPath, "--fork-session"),
          turnAbort.whenAborted.then(() => false),
        ])
        if (turnAbort.aborted) {
          return abortedBeforeWork("probing --fork-session support")
        }
        if (supported) {
          forkFromClaudeSessionId = parent.claudeSessionId
          includeHistoryContext = false
          log.notice(
            "forking the parent conversation's claude session instead of replaying it",
            {
              sessionKey: sk,
              parentKey: parent.parentKey,
              matchedMessages: parent.matched,
            },
          )
        } else {
          log.warn(
            "forkSessions is on but this claude CLI has no --fork-session;" +
              " replaying the conversation instead",
            { cliPath },
          )
        }
      }
    }
    // A conversation this key served in an EARLIER opencode process. Its
    // Claude session id died with that process's memory, so without this the
    // whole thread is replayed as text (`src/session-resume-store.ts` has the
    // measurements and every refusal). Setting the id is all it takes: the
    // spawn below resumes any key that has one and no live process, exactly
    // as it does after an idle eviction.
    // Why this turn ended up replaying, for the one NOTICE below. The
    // branches that try to avoid a replay each overwrite it with what they
    // refused on, so the reason an operator reads in `plugin.log` is the most
    // specific one anything actually decided (h #g215).
    let replayReason = "no-session-for-key"
    if (
      this.config.resumeAfterRestart !== false &&
      includeHistoryContext &&
      !compactionMode &&
      !forkFromClaudeSessionId &&
      failoverAnswer?.kind !== "switch"
    ) {
      const configDir = resolveConfigDir(this.config.configDir)
      // `dir` is a sibling's own recorded config dir, which is the OTHER
      // account's on a by-hand switch (h #g226). Omitted everywhere else, so
      // every existing caller asks about this account's directory exactly as
      // it did before.
      const transcriptPath = (id: string, dir?: string) =>
        join(dir ?? configDir, "projects", encodeCwd(cwd), `${id}.jsonl`)
      const resumePoint = findResumePoint({
        sessionKey: sk,
        prompt: options.prompt,
        cliPath,
        transcriptPath,
        onRefused: (reason) => {
          replayReason = reason
        },
      })
      if (resumePoint) {
        setClaudeSessionId(sk, resumePoint.claudeSessionId)
        includeHistoryContext = false
        log.notice("resuming the claude session from before the restart instead of replaying it", {
          sessionKey: sk,
          matchedMessages: resumePoint.matched,
        })
      } else if (this.config.resumeAcrossModelChanges !== false) {
        // Nothing has answered THIS key, but the same opencode conversation
        // may have been answered under another model or another reasoning
        // effort: both are in the session key, so changing either sends a
        // live conversation down the fresh-session path (issue #91). Neither
        // needs a new Claude conversation, because `--model` and
        // `CLAUDE_CODE_EFFORT_LEVEL` are spawn-time and the CLI applies
        // either to a transcript it resumes (measured on 2.1.288).
        const sibling = findSiblingResumePoint({
          sessionKey: sk,
          prompt: options.prompt,
          cliPath,
          transcriptPath,
          // `claudeSessionIsWriting`, not `getActiveProcess`: this walks every
          // sibling key, and that one refreshes LRU order and cancels idle
          // timers on everything it touches (the same reason the fork lookup
          // above uses it).
          isBusy: claudeSessionIsWriting,
          // The ACCOUNT is the third thing that may differ (h #g226), and the
          // guard is where a cross-group sibling is refused by name.
          accountProviders,
          allowAccount: (account) =>
            this.config.crossAccountResume !== false &&
            accountsShareGroup(sourceAccount, account, groups),
          onRefused: (reason) => {
            replayReason = reason
          },
        })
        if (sibling) {
          // A sibling on ANOTHER account is one more step than a model or
          // effort change: those are spawn flags the CLI applies to a
          // transcript it resumes, while an account is a different config dir,
          // so the FILE has to be here before `--resume` means anything
          // (h #g218). A refused carry falls through to the replay exactly as
          // the failover switch's does.
          let carriedSessionId: string | undefined
          let carryRefused: string | undefined
          if (sibling.siblingAccount && sibling.siblingConfigDir) {
            const carry = await carryTranscriptToAccount({
              sessionId: sibling.claudeSessionId,
              cwd,
              targetConfigDir: resolveConfigDir(this.skillBridgeSpawn(failover).configDir),
              // The sibling's recorded directory first, then every same-group
              // account's. The recorded one can be stale by a turn (it is
              // rewritten only when a turn succeeds), so the conventional
              // directories are what make a stale record recoverable rather
              // than a refusal.
              accountConfigDirs: [
                sibling.siblingConfigDir,
                ...accountsInGroupOf(sourceAccount, this.config.failoverAccounts, groups).map(
                  configDirForAccount,
                ),
                configDir,
              ],
            })
            if (carry.kind === "carried" || carry.kind === "already-there") {
              carriedSessionId = carry.sessionId
            } else {
              carryRefused = carry.reason
            }
          }
          if (carryRefused) {
            replayReason = `sibling-${carryRefused}`
            log.notice("replaying this conversation rather than carrying it across accounts", {
              sessionKey: sk,
              siblingKey: sibling.siblingKey,
              reason: carryRefused,
              account: sourceAccount,
              from: sibling.siblingAccount,
            })
          } else {
            // The sibling's own child, if it still has one, is holding the
            // transcript this turn is about to resume. It goes first, so one
            // `claude` owns one conversation; the transfer then moves the id,
            // the resume record and the fork fingerprint across, leaving the
            // sibling key with no claim on it at all.
            deleteActiveProcess(sibling.siblingKey)
            const carried = transferClaudeSession(sibling.siblingKey, sk)
            if (carried) {
              // A renamed copy is the same conversation under a new id, because
              // the CLI resolves a session by filename and the target path was
              // taken by an older copy from an earlier switch (h #g218).
              if (carriedSessionId && carriedSessionId !== carried) {
                setClaudeSessionId(sk, carriedSessionId)
              }
              includeHistoryContext = false
              log.notice(
                "continuing this conversation's claude session under the new model or effort instead of replaying it",
                {
                  sessionKey: sk,
                  siblingKey: sibling.siblingKey,
                  matchedMessages: sibling.matched,
                  ...(sibling.siblingAccount
                    ? { from: sibling.siblingAccount, account: sourceAccount }
                    : {}),
                },
              )
            } else {
              replayReason = "sibling-carry-over-failed"
            }
          }
        }
      }
    }

    // A turn that is about to resend the whole thread as text. It is lossy
    // (per-message text and tool results are clipped, images and reasoning are
    // dropped) and it is the expensive path, so it says so once, at NOTICE,
    // with what it refused on: before this it was invisible unless the
    // operator read DEBUG, and the only thing on screen was a transcript
    // prefix that read like session corruption (issue #91).
    if (includeHistoryContext && !compactionMode) {
      log.notice("replaying the conversation as text: no claude session was available to continue", {
        sessionKey: sk,
        reason: replayReason,
        messages: options.prompt.length,
      })
    }

    // What this key is being asked to continue, so a later fork of it can be
    // recognised. Only written when the feature is on, so a default install
    // does no hashing at all.
    // Both transports: a TUI branches with the same `--fork-session` and
    // writes the same transcript, so either can be the other's parent (h #g209).
    if (this.config.forkSessions === true && !compactionMode) {
      recordForkFingerprint(sk, options.prompt, cliPath)
    }

    // `effectiveModelId` stays intact for session keys, logs, and metadata;
    // only the name handed to the CLI gets the `-fast` marker stripped, and
    // (on a failover) the `@account` suffix the other account's wrapper would
    // not recognise. Where there is no wrapper at all (`accountInProcess`,
    // Windows) the marker comes off here on every turn: nothing downstream
    // would strip it and the CLI has no such model (h #g221).
    const { model: spawnModelId, fast: fastMode } = parseModelId(
      this.config.accountInProcess
        ? stripAccountSuffix(failover.modelId)
        : failover.modelId,
    )

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
        ? buildFailoverContinuationPrompt(
            options.prompt,
            failoverAnswer.target,
            conversationOnTarget,
          )
        : options.prompt
    const userMsg =
      exitPlanModeQuestionResult ??
      getClaudeUserMessage(effectivePrompt, includeHistoryContext, {
        compactionMode,
        compactionInstructions: useInteractive && compactionMode
          ? extractSystemMessages(effectivePrompt).join("\n\n")
          : undefined,
        cliToolCallIds: new Set(previousPendingProxyCalls.map((c) => c.toolCallId)),
        stripContextReminders: this.stripContextRemindersEnabled(),
      })
    // Plan mode on the TUI writes its plan to `~/.claude/plans/` with Claude's
    // own Write, which proxying `write` disables, and before approval it asks
    // before ANY write, an allow-listed proxied one included: on a TUI that is
    // a dialog only Esc can answer, and the turn dies (measured on 2.1.288,
    // h #g201). So in plan mode the TUI keeps its own Write and Edit, which
    // plan mode itself confines to the plan file until the plan is approved.
    const ptyPlanMode = useInteractive && !compactionMode && this.config.permissionMode === "plan"
    const resolvedProxy = compactionMode
      ? null
      : ptyPlanMode
        ? (this.resolvedProxyTools()?.filter((def) => def.name !== "write" && def.name !== "edit") ?? null)
        : this.resolvedProxyTools()
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
    //
    // This is the longest wait in the prologue (up to 3 s of MCP connect wait
    // plus up to the probe's own 5 s deadline), so it is the one an operator
    // is most likely to stop inside: it races the abort rather than running to
    // completion. The work itself is left running on purpose. `detectCliVersion`
    // caches its answer per `cliPath` for the whole process and three flag
    // gates read it, so cancelling the probe because THIS turn was stopped
    // would withhold every version-gated flag from the next one (h #g181); the
    // MCP wait is given the signal instead, since its poll loop is ours and
    // holds a timer.
    const prologueWork = Promise.all([
      compactionMode
        ? Promise.resolve(undefined)
        : getRuntimeMcpStatus({
            // Give a server opencode is still starting a bounded moment to
            // reach a decision before the spawn is planned without it. Only
            // opencode 2 ever reports `pending`, so on 1.x this is one status
            // call exactly as before.
            waitForPendingMs: resolveMcpConnectWaitMs(
              this.config.mcpConnectWaitMs,
            ),
            signal: options.abortSignal,
          }),
      detectCliVersion(cliPath),
    ])
    // The abort can win the race below and leave nobody awaiting this promise.
    // A rejection then needs an owner here, or it surfaces as an unhandled
    // rejection inside opencode's process; the `await` below still sees it.
    prologueWork.catch(() => undefined)
    const prologue = await Promise.race([
      prologueWork.then((value) => ({ value })),
      turnAbort.whenAborted.then(() => undefined),
    ])
    if (!prologue) {
      return abortedBeforeWork("waiting for opencode's MCP status and the CLI version")
    }
    const [runtimeStatus, cliVersion] = prologue.value
    if (useInteractive) reportUnmeasuredInteractiveCli(cliVersion)

    // The read-only preset on the TUI is `--restricted` plus `dontAsk`
    // (`interactivePermissionPosture`, h #g201). A CLI that lacks either is
    // refused here, before any work, never given an approximation.
    const ptyReadOnly =
      useInteractive && !compactionMode && !doctor && isReadOnlyPermissionMode(this.config.permissionMode)
    const ptyReadOnlySupported = cliSupportsRestricted(cliVersion) && cliSupportsDontAsk(cliVersion)
    const ptyBypassSupported = cliSupportsInteractiveBypass(cliVersion)
    if (ptyReadOnly && !ptyReadOnlySupported) {
      throw new Error(
        "The read-only preset on the interactive transport needs Claude Code 2.1.263 or newer (--restricted and --permission-mode dontAsk). Update claude, or use the headless transport.",
      )
    }

    // Whether a usage limit on this account should end the turn with the
    // switch form. Resolved here, in the prologue, for the same reason the
    // plan-mode gate is: the `result` branch that needs the answer runs in a
    // synchronous line handler. The candidate check comes first so a
    // single-account install never pays for the two lookups behind it, and the
    // `=== "ask"` check comes second so a default install pays for neither:
    // the form is opt-in (h #g194).
    const failoverAccounts = failoverCandidates(
      this.config.failoverAccounts,
      sourceAccount,
      groups,
    )
    const failoverAskActive =
      failoverAccounts.length > 0 &&
      this.config.accountFailover === "ask" &&
      !compactionMode &&
      // A `doGenerate` caller takes the override and reports the plain
      // rate-limit error, never the form. See `TurnMode`.
      mode !== "generate" &&
      isAccountFailoverQuestionActive({
        configured: this.config.accountFailover,
        candidates: failoverAccounts,
        opencodeHasQuestion: (await loadLiveToolInfo()).hasQuestion,
        compactionMode,
        // A subagent follows its parent's account for free, because the
        // override is account-scoped. Asking it would put a form in a session
        // the operator is usually not even looking at.
        childSession: !!(await fetchSessionParentId(affinity)),
      })

    // Whether a usage limit on this turn should be said once, plainly, in the
    // conversation (`formatUsageLimitNote`, h #g194). The complement of the
    // form rather than a second option: exactly one of the two answers a
    // limited turn, and with the form opt-in this is what a default install
    // gets. The parser turns it into `TurnState.usageLimitNote` at the result
    // frame, where whether the limit actually happened is finally known.
    //
    // Excluded for the same two reasons the stale-build note is: a `/compact`
    // turn's text becomes the stored summary, and a `doGenerate` turn's text
    // is aggregated into a return value rather than shown. A child session is
    // NOT excluded: a subagent that died on a usage limit is exactly what the
    // parent's `task` result should say. The fallback chain is not checked
    // here either, because whether it takes the turn is only known once the
    // refusal is in hand; `completeResult` reads this after the chain's own
    // branch has had its chance to return.
    const usageLimitNoteActive =
      !compactionMode && mode !== "generate" && !failoverAskActive

    // Whether this turn tells the operator that the opencode process they are
    // talking to is running an older plugin build than the one on disk
    // (src/stale-build.ts, h #g192). Resolved here, in the prologue, because
    // the one lookup it can need is async; the note itself is written after
    // `stream-start`, which is also where the session is claimed, so a turn
    // stopped before it asked Claude for work spends nothing.
    //
    // Everything excluded here is excluded because the note would land
    // somewhere the operator is not reading, or somewhere it would be taken
    // for Claude's answer: a `/compact` summary, a `doGenerate` return value
    // (whose text is aggregated rather than shown), a turn with no real
    // opencode session, and a subagent, whose reply text can become the
    // parent's `task` result. A title request never reaches this line: its
    // stub returns far above. The disk check is throttled to once a minute
    // and the parent lookup happens only when the build really is stale, so a
    // current build pays nothing at all.
    let staleBuild: StaleBuild | null = null
    if (!compactionMode && mode !== "generate" && affinity !== "default") {
      staleBuild = staleBuildWatch().check()
      if (staleBuild && (await fetchSessionParentId(affinity))) staleBuild = null
    }

    // Whether a dispatch from this turn stops to ask (h #g227). Resolved in the
    // prologue for the same reason the failover form is: the drain that needs
    // the answer runs inside a synchronous handler. Every check behind the
    // `=== "ask"` one costs nothing on a default install, where the option is
    // unset and this is false before anything is fetched.
    const subagentDispatchActive =
      !compactionMode &&
      mode !== "generate" &&
      this.config.subagentDispatch === "ask" &&
      affinity !== "default" &&
      isSubagentDispatchActive({
        configured: this.config.subagentDispatch,
        opencodeHasQuestion: (await loadLiveToolInfo()).hasQuestion,
        compactionMode,
        // A subagent that dispatches subagents of its own follows the choice
        // its parent made for it, which it is already running under.
        childSession: !!(await fetchSessionParentId(affinity)),
      })
    const dispatchContext: DispatchContext = {
      parentSessionId: affinity,
      sourceAccount,
      accounts: this.config.failoverAccounts ?? [],
      groups,
      crossGroup: this.config.subagentDispatchCrossGroup === true,
      describeDefault: (agent: string) => ({
        model: stripAccountSuffix(resolveAgentModel(agent, this.modelId)),
        effort: resolveAgentEffort(
          agent,
          this.getReasoningEffort(options.providerOptions),
        ),
      }),
    }

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

    // Last checkpoint before the stream exists, covering the plan-mode gate,
    // the live tool registry and the parent-session lookup above. From here on
    // the turn has a `TurnState` and the abort handler registered against it,
    // so an abort is handled rather than returned.
    if (turnAbort.aborted) return abortedBeforeWork("planning the spawn")

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
        // The dispatch gate the drain consults (h #g227). Null unless the
        // operator opted in, which is what keeps `drainNow` the drain it has
        // always been on a default install.
        if (subagentDispatchActive) {
          state.subagentDispatchForm = (calls) => {
            const tasks = dispatchTasksFromCalls(calls, taskBatchTasks)
            if (tasks.length === 0) return null
            return createSubagentDispatchQuestion(
              sk,
              calls.map((call) => call.toolCallId),
              tasks,
              dispatchContext,
            )
          }
        }

        // A proxy MCP server this turn created but never handed to a child is
        // a listening socket nothing will ever close. Only ours: the server on
        // a reused process belongs to that process and outlives this turn.
        const discardUnattachedProxyServer = () => {
          const own = state.proxyServer
          if (!own || own === state.activeProcess?.proxyServer) return
          state.proxyServer = null
          void own.close().catch((error: unknown) => {
            log.warn("failed to close the proxy server of an aborted turn", {
              sessionKey: sk,
              error: error instanceof Error ? error.message : String(error),
            })
          })
        }

        // On abort, keep process alive for next message.
        //
        // Registered HERE, in the synchronous part of `start()`, and through
        // the watch created before the prologue's first await rather than
        // through `addEventListener` on the signal: every await above and every
        // await in `setup()` below is a window the operator can stop the turn
        // in, and a listener attached afterwards never hears an abort that has
        // already happened. `onAbort` runs this immediately in that case.
        // (h #g182).
        //
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
        turnAbort.onAbort(() => {
          state.autoContinueState.aborted = true

          // Nothing has been asked of the CLI yet: this turn is still being
          // prepared. End it here, and leave everything else alone. No
          // `interrupt`, because the process in `state.activeProcess` is a
          // reused one whose last turn this doStream never started, and
          // interrupting that would stop work that is not ours. No release of
          // pending proxy calls either: they belong to the previous step, and
          // an abort of a new step changes nothing about how they end
          // (h #g26, h #g82).
          if (!state.cliAskedForWork) {
            if (state.controllerClosed) return
            state.controllerClosed = true
            log.info("abort while the turn was still being prepared; nothing was sent to claude", {
              sessionKey: sk,
              // A process here was spawned by this turn or reused from an
              // earlier one; either way nothing was asked of it.
              attachedProcess: !!state.activeProcess,
              reason: describeAbortReason(turnAbort.reason),
            })
            discardUnattachedProxyServer()
            state.cleanupTurn?.()
            if (!state.streamStarted) {
              state.streamStarted = true
              controller.enqueue({ type: "stream-start", warnings })
            }
            try {
              controller.close()
            } catch {}
            return
          }

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
            // Only a positive `busy` keeps the call; `unknown` releases it,
            // the same as `idle` (h #g26), because a call kept by mistake
            // waits on a turn nobody is running.
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
                log.info("abort between proxy tool boundaries; releasing pending calls", { sk, reason, session: stopped })
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
            state.cleanupTurn?.()
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
          // Abort grace period, short since the user already asked to stop.
          startResultFallback(state, 5_000)
        })

        // Every await in `setup()` is a window the handler above can fire in,
        // and when it does the stream is already closed by the time control
        // comes back. Checked where it matters: before a child is spawned, and
        // before anything is written to one.
        const stoppedBeforeWork = () => {
          if (!state.controllerClosed || state.cliAskedForWork) return false
          // A proxy server whose `ensureProxyServer` resolved after the handler
          // ran was not on the state for it to discard, so the discard belongs
          // here too. Idempotent: the second call finds nothing of ours.
          discardUnattachedProxyServer()
          return true
        }

        const setup = async () => {
          if (stoppedBeforeWork()) return

          // A server opencode connected after this conversation's process was
          // spawned reaches the model by moving the conversation onto a fresh
          // process with the new `--mcp-config` and `--resume`. The boundary
          // is everything: a fresh user turn with nothing of the previous one
          // still in the air. `src/mcp-hot-reload.ts` owns the decision.
          //
          // `deleteActiveProcessAndWait` rather than `respawnActiveProcess`:
          // the watchdog's respawn deliberately reuses the wedged child's
          // `cliArgs`, which carry the OLD `--mcp-config` paths, and the whole
          // point here is a different config. Waiting for the old owner to
          // exit is what keeps two processes from appending to one transcript.
          if (
            !compactionMode &&
            state.activeProcess &&
            self.config.hotReloadMcp !== false &&
            self.config.bridgeOpencodeMcp !== false
          ) {
            const probe = self.effectiveMcpConfig(cwd, undefined, runtimeStatus!)
            const previousHash = state.activeProcess.mcpHash ?? null
            const decision = decideMcpHotReload({
              sessionKey: sk,
              enabled: true,
              hasActiveProcess: true,
              compactionMode,
              interactive: !!useInteractive,
              turnInFlight: isTurnInFlight(state.activeProcess),
              pendingProxyCalls: previousPendingProxyCalls.length,
              planQuestionPending: hasExitPlanModeQuestions(sk),
              previousHash,
              currentHash: probe.bridgedHash,
              previousServers: state.activeProcess.mcpServers,
              currentServers: probe.allEnabledServerNames,
            })
            logMcpHotReloadDecision(decision, {
              sessionKey: sk,
              previousHash,
              currentHash: probe.bridgedHash,
            })
            if (decision.reload) {
              noteMcpHotReload(sk)
              await deleteActiveProcessAndWait(sk)
              state.activeProcess = undefined
              state.proxyServer = null
            }
          }

          // What the proxy MCP server serves for this spawn, the server
          // itself, and which native tools that disables. Shared by both
          // transports: the proxy is plain HTTP, so the interactive TUI reaches
          // opencode's tools, the question form and subagents through it the
          // same way a headless child does.
          const resolveProxyWiring = async () => {
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
            // MCP-bridged tool) and decide every other enabled server. Null
            // when the option is off, which bridges everything directly.
            const mcpRouting = self.resolvedProxyMcpTools(
              discovery.allEnabledServerNames,
              options.tools as readonly ModelToolEntry[] | undefined,
              new Set((resolvedProxy ?? []).map((def) => def.name)),
              runtimeStatus,
            )
            const proxyMcpTools =
              mcpRouting && mcpRouting.resolution.defs.length > 0
                ? mcpRouting.resolution.defs
                : null
            // Exclude the servers a def was built for and the ones opencode
            // has connected but withheld from this agent, and nothing else.
            // Excluding every enabled server, as this did while the resolution
            // was always null, would strand a server opencode is not running:
            // dropped from `--mcp-config` and absent from the proxy, so
            // reachable by neither route.
            const excludeServers: ReadonlySet<string> | undefined =
              mcpRouting?.excludeServers

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
                    taskParameters: undefined,
                    questionDescription: undefined,
                    hasQuestion: false,
                  }
            let enrichedProxy = resolvedProxy
            let backgroundSubagentsSupported = false
            // Which opencode major this model serves. Everything the model is
            // told about a background dispatch is picked with it, because
            // neither envelope is the same on the two majors (h #g176, #g230).
            const hostDialect: "v1" | "v2" =
              self.config.hostApi === "v2" ? "v2" : "v1"
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
              // Background dispatch is the host's to allow, and both answers
              // change the tool surface: supported adds the collect/cancel
              // pair and the note, unsupported strips `background` from the
              // schema so the model cannot burn a call on opencode's hard
              // refusal. Spawn-time only, like every other overlay here.
              backgroundSubagentsSupported = liveTaskSupportsBackground(
                liveToolInfo.taskParameters,
                hostDialect,
              )
              enrichedProxy = applyBackgroundSubagentSupport(
                enrichedProxy,
                backgroundSubagentsSupported,
                hostDialect,
              )
              // The doctor answers without a turn, so the gate has to be
              // remembered here rather than recomputed there.
              recordBackgroundSubagentGate({
                supported: backgroundSubagentsSupported,
                hostApi: hostDialect,
                registryResolved: liveToolInfo.resolved,
              })
              // Say which way it went: with the gate closed the model simply
              // never sees the field, which from the outside is
              // indistinguishable from the plugin ignoring the feature.
              log.info("background subagent gate", {
                supported: backgroundSubagentsSupported,
                registryResolved: liveToolInfo.resolved,
                hostApi: hostDialect,
                note: backgroundSubagentsSupported
                  ? "task accepts `background`; task_status and task_cancel are registered"
                  : "`background` stripped from the task schema; set OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true in opencode's environment to enable it",
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
              modelTools: self.config.hostApi === "v2" ? (options.tools ?? []) : undefined,
              allowCodeExecution: self.config.permissionPreset !== "read-only",
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
                affinity,
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
            return {
              excludeServers,
              taskProxyEnabled,
              backgroundSubagentsSupported,
              hostDialect,
              questionProxyActive,
              opencodeToolDefs,
              pluginCompressEnabled,
              allDisallowed,
            }
          }

          if (useInteractive && compactionMode) {
            // A fresh, tool-less TUI answers only this summary request. No
            // bridge, proxy, skill staging, resume or continuation prompt.
            const ap = spawnInteractiveProcess({
              cwd,
              cliPath,
              configDir: self.config.configDir,
              model: spawnModelId,
              fastMode,
              tools: [],
              mcpConfigPaths: ['{"mcpServers":{}}'],
              env: claudeSpawnEnv({ ignoreAnthropicApiKey: self.config.ignoreAnthropicApiKey }),
            })
            state.proc = ap.proc
            state.lineEmitter = ap.lineEmitter
            state.activeProcess = ap
          } else if (useInteractive) {
            // Interactive Bun-ConPTY transport. Reuse the live session if one
            // exists for this key; else spawn a new interactive claude. The
            // wrapper conforms to ActiveProcess, so reuse/eviction/hot-reload
            // and the whole emission body below work unchanged.
            if (state.activeProcess) {
              state.proc = state.activeProcess.proc
              state.lineEmitter = state.activeProcess.lineEmitter
              log.debug("reusing active interactive session", { sk })
            } else {
              const wiring = await resolveProxyWiring()
              const mcp = self.effectiveMcpConfig(
                cwd,
                state.proxyServer?.configPath(),
                runtimeStatus!,
                wiring.excludeServers,
              )
              // MCP wildcards are always derived from the live bridge config;
              // the built-in tool list is overridable via interactiveAllowTools.
              // A tool the proxy serves is disallowed natively below, so its
              // entry here is inert rather than a second way in.
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
              // Opt-in: what the operator wrote, recovered from the forwarded
              // prompt by provenance; opencode's own text stays out (h #g212).
              const userInstructions =
                self.config.interactiveUserInstructions === true
                  ? userAuthoredInstructions(extractSystemMessages(options.prompt).join("\n\n"), {
                      agentPrompt: getAgentRegistry()[self.getOpencodeAgent(options) ?? ""]?.prompt,
                    })
                  : []
              if (userInstructions.length > 0) {
                log.info("forwarding user-authored instructions to the interactive TUI", {
                  count: userInstructions.length,
                })
              }
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
                      // CLI/AGENTS/continuation prompt remains safe. The
                      // plugin's own short proxy hints are part of that static
                      // prompt: without them the model narrates a subagent
                      // dispatch instead of calling the proxy (h #g74).
                      [
                        ...(wiring.taskProxyEnabled ? [SUBAGENT_DISPATCH_HINT] : []),
                        ...(wiring.backgroundSubagentsSupported
                          ? [backgroundSubagentHint(wiring.hostDialect)]
                          : []),
                        ...(wiring.questionProxyActive ? [QUESTION_PROXY_HINT] : []),
                      ],
                      {
                        compressEnabled: wiring.pluginCompressEnabled,
                        opencodeCompressEnabled: wiring.opencodeToolDefs.some(
                          (t) => t.name === "compress",
                        ),
                        compressionSummary: getCompressionSummary(sk),
                        userInstructions,
                      },
                    )
              if (self.config.interactiveSystemPrompt === false) {
                log.warn(
                  "interactive system prompt disabled; opencode agent prompts will not be appended",
                )
              }
              if (interactiveBypassRequested) {
                log.warn(
                  "interactiveBypass is ignored: skipPermissions governs the interactive transport too",
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
              if (stoppedBeforeWork()) return
              // A conversation whose TUI died or was evicted continues where
              // it was. Without this the key kept its Claude session id, so
              // the history was not replayed either, and the next turn
              // started a blank conversation.
              const resumeSessionId = getClaudeSessionId(sk)
              const posture = interactivePermissionPosture({
                permissionMode: self.config.permissionMode,
                allow,
                supportsReadOnly: ptyReadOnlySupported,
                skipPermissions: self.config.skipPermissions,
                controlRequestBehavior: self.config.controlRequestBehavior,
                controlRequestToolBehaviors: self.config.controlRequestToolBehaviors,
                supportsBypass: ptyBypassSupported,
              })
              // Unreachable past the prologue's refusal; kept so a posture
              // the TUI cannot hold can never spawn one.
              if (!posture) throw new Error("the interactive transport cannot hold this permission posture")
              const ap = spawnInteractiveProcess({
                cwd,
                cliPath,
                // On an account switch, the other account's directory: the
                // TUI writes its transcript there (h #g209).
                configDir: self.skillBridgeSpawn(failover).configDir,
                model: spawnModelId,
                fastMode,
                mcpConfigPaths: mcp.paths,
                pluginDirs: skillPluginDirs,
                permissionsAllow: posture.allow,
                permissionMode: posture.permissionMode,
                restricted: posture.restricted,
                bypass: posture.bypass,
                disallowedTools: [...wiring.allDisallowed, ...posture.disallowed],
                proxyServer: state.proxyServer,
                systemPromptFile,
                ignoreAnthropicApiKey: self.config.ignoreAnthropicApiKey,
                effort: reasoningEffort,
                resumeSessionId,
                // A fork of a conversation already served (`forkSessions`):
                // the TUI branches it instead of the history being replayed.
                ...(forkFromClaudeSessionId && !resumeSessionId
                  ? { forkOf: forkFromClaudeSessionId }
                  : {}),
                // The headless spawn's env, so hygiene, effort and the
                // agent's prompt cache TTL reach both transports alike, plus
                // what keeps a proxied call in the foreground (h #g210).
                env: interactiveSpawnEnv(
                  claudeSpawnEnv({
                    ignoreAnthropicApiKey: self.config.ignoreAnthropicApiKey,
                    effort: reasoningEffort,
                    promptCacheTtl,
                  }),
                ),
              })
              ap.proc.once("exit", (code: number | null) =>
                noteInteractiveProcessExit(sk, ap, code),
              )
              ap.mcpHash = mcp.bridgedHash
              ap.mcpServers = mcp.allEnabledServerNames
              // Which account's binary this TUI runs, for the account check
              // in the prologue, exactly as a headless child records it.
              ap.cliPath = cliPath
              setActiveProcess(sk, ap)
              state.proc = ap.proc
              state.lineEmitter = ap.lineEmitter
              state.activeProcess = ap
              log.info("spawned interactive claude session", {
                sk,
                resumed: !!resumeSessionId,
                forked: !!forkFromClaudeSessionId && !resumeSessionId,
                cliPath,
                configDir: self.config.configDir,
                model: effectiveModelId,
              })
            }
          } else {
          let spawnSystemPromptFile: string | undefined
          let spawnProxyServer: ProxyMcpServer | null = null
          let spawnMcpHash: string | null = null
          let spawnMcpServers: string[] = []

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
            const {
              excludeServers,
              taskProxyEnabled,
              backgroundSubagentsSupported,
              hostDialect,
              questionProxyActive,
              opencodeToolDefs,
              pluginCompressEnabled,
              allDisallowed,
            } = await resolveProxyWiring()
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
                    ...(backgroundSubagentsSupported
                      ? [backgroundSubagentHint(hostDialect)]
                      : []),
                    ...(questionProxyActive ? [QUESTION_PROXY_HINT] : []),
                    ...(self.config.hostApi === "v2" && options.tools?.some((t) => t.name === "execute")
                      ? [codeModeProxyHint(opencodeToolDefs.some((t) => t.name === "execute"))]
                      : []),
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
              forkFromClaudeSessionId,
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
            spawnMcpServers = mcp.allEnabledServerNames
          }

          if (stoppedBeforeWork()) return
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
              promptCacheTtl,
              spawnConfigDir,
            )
            ap.mcpServers = spawnMcpServers
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
          // Nor while an interactive TUI is parked on a plan approval: this
          // turn's message is the decision on it (h #g201).
          if (
            state.activeProcess &&
            !hasMatchedPendingResults &&
            !state.activeProcess.interactiveControl?.planApprovalPending?.() &&
            isTurnInFlight(state.activeProcess)
          ) {
            log.warn("previous turn still in flight; interrupting it", { sk })
            const idle = await interruptTurn(state.activeProcess)
            if (!idle) {
              log.warn("previous turn did not stop in time; this turn may see stale output", { sk })
            }
          }

          // The `interruptTurn` above is the last await before this turn asks
          // the CLI for work, so this is the last chance to stop without one.
          if (stoppedBeforeWork()) return
          state.streamStarted = true
          controller.enqueue({ type: "stream-start", warnings })

          // Before anything Claude says, because it is about whether anything
          // Claude says here comes from the code the operator thinks it does.
          // The session is claimed at this point rather than where the verdict
          // was decided, so a turn that never got here still gets its note on
          // the next message. Its own text part, and never counted as output:
          // `startTextBlock` touches none of the signals `isSilentTurn`,
          // auto-continue, `turnStats` or `provesModelServing` read.
          if (staleBuild && staleBuildWatch().claimSession(affinity)) {
            controller.enqueue({
              type: "text-delta",
              id: state.startTextBlock(),
              delta: formatStaleBuildNote(staleBuild),
            })
            state.endTextBlock()
          }

          // The one thing on screen saying this account was given none of the
          // conversation, because `accountGroups` holds the two apart (h #g226).
          // Its own text part, led by `ACCOUNT_GROUP_MARKER`, for the same
          // reason every other `▌` note is: the plugin wrote it.
          if (accountGroupNote) {
            controller.enqueue({
              type: "text-delta",
              id: state.startTextBlock(),
              delta: accountGroupNote,
            })
            state.endTextBlock()
          }

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
          // Which Claude session answered this conversation, for the next
          // opencode process. Only after a turn that was served: a failed one
          // may leave a transcript the plugin itself would not resume.
          if (
            self.config.resumeAfterRestart !== false &&
            !compactionMode &&
            msg.is_error !== true &&
            typeof msg.session_id === "string"
          ) {
            // Where the transcript was written, and whose account that is, so
            // a later by-hand switch can find the FILE: an account's config
            // dir is configurable, so the account name alone cannot name it
            // (h #g226).
            recordResumePoint(sk, msg.session_id, options.prompt, cliPath, {
              configDir: resolveConfigDir(self.skillBridgeSpawn(failover).configDir),
              account: failover.target ?? sourceAccount,
            })
          }
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
              carryTranscript: self.config.crossAccountResume !== false,
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
                usage: toUsage(lastCallContextUsage(state.lastCallUsage, msg.usage)),
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

          // Nothing above took the turn, so a usage limit is simply what
          // happened: say it once, plainly, and finish as an error. No
          // `return`, because this note replaces text and changes no control
          // flow (h #g194). The parser decided this at the `result` frame and
          // suppressed the CLI's own error text there, so this is the only
          // thing on screen.
          if (state.usageLimitNote) {
            log.warn("claude account is out of usage; the turn ends with a note", {
              sessionKey: sk,
              account: sourceAccount,
              window: state.accountLimitHit?.window ?? null,
              resetsAt: state.accountLimitHit?.resetsAt ?? null,
              candidates: failoverAccounts,
            })
            controller.enqueue({
              type: "text-delta",
              id: state.startTextBlock(),
              delta: formatUsageLimitNote({
                sourceAccount,
                candidates: failoverAccounts,
                resetsAt: state.accountLimitHit?.resetsAt,
                window: state.accountLimitHit?.window,
                resetsText: state.accountLimitHit?.resetsText,
              }),
            })
            state.endTextBlock()
            // Nothing was served, so the turn is a failure and must finish as
            // one: as a `stop` opencode filed a limited turn as an ordinary
            // (very short) reply, which is what let a limited COMPACTION turn
            // be stored as a summary at all. The account-block path has
            // finished this way since it was written; this makes the two
            // agree. The note is still the whole of what is on screen, and
            // every branch above returned before reaching here, so the switch
            // form and the fallback chain are untouched (h #g214).
            state.resultFailure ??= "usage_limit"
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

          // A failed compaction turn ends on an error, never on text. What
          // this stream says is what opencode stores as the summary, so a
          // usage limit used to become the conversation's own memory of
          // itself and every later session started from it (issue #90). The
          // parser has already suppressed the CLI's prose and named the cause
          // in `resultFailure`; the `error` part plus the error finish below
          // are what make opencode mark the compaction failed and keep the
          // history it already has. (h #g214)
          if (compactionMode && state.resultFailure) {
            log.warn("claude could not compact the conversation; no summary was stored", {
              sessionKey: sk,
              cause: state.resultFailure,
            })
            controller.enqueue({
              type: "error",
              error: new Error(
                formatCompactionFailure(state.resultFailure, state.compactionFailureText),
              ),
            })
          }

          // opencode reads this usage as the context the conversation
          // occupies, and `msg.usage` is summed over every call of the turn.
          const usage = toUsage(lastCallContextUsage(state.lastCallUsage, msg.usage))
          controller.enqueue({
            type: "finish",
            finishReason: state.resultFailure
              ? { unified: "error" as const, raw: state.resultFailure }
              : toFinishReason("stop"),
            usage,
            providerMetadata: {
              "claude-code": {
                ...state.resultMeta,
                ...(state.resultFailure ? { resultSubtype: state.resultFailure } : {}),
                ...(compactionMode
                  ? { compactionModel: effectiveModelId }
                  : {}),
              },
              // opencode falls back to this when the usage has no cache
              // write (0 is sent as none), so it must match the usage, never
              // the turn total.
              ...(typeof msg.usage?.cache_creation_input_tokens === "number"
                ? {
                    anthropic: {
                      cacheCreationInputTokens:
                        usage.inputTokens.cacheWrite ?? 0,
                    },
                  }
                : {}),
            },
          })

          state.controllerClosed = true
          cleanupTurn()
          // Both transports: an evicted TUI is replaced on the next message
          // with `--resume`, exactly as a headless child is (h #g200).
          if (!compactionMode) {
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
          interactive: useInteractive,
          sourceAccount,
          failoverAskActive,
          usageLimitNoteActive,
          failoverAccounts,
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
          if (compactionMode && useInteractive) state.proc.kill()
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
              // The marker leads the block, so the operator can tell this from
              // the answer to their own message and a rebuilt transcript drops
              // the whole part instead of handing it back as Claude's reply to
              // the wrong turn (h #g189).
              const replayId = state.startTextBlock()
              controller.enqueue({
                type: "text-delta",
                id: replayId,
                delta: formatUnattendedReplayNote(unattended.dropped),
              })
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

        if (hasMatchedPendingResults) {
          // Resolving a parked call sets the CLI's turn going again, so from
          // here an abort is an abort of work this turn owns: the handler above
          // takes its mid-turn branches, exactly as it did before.
          state.cliAskedForWork = true
          // The prompt that carried these results can also carry user
          // messages the host promoted beside them (a background-PTY or mail
          // notice, a steered prompt). Resolving a proxy call writes no user
          // envelope, so without this the CLI never sees them although
          // opencode has recorded them as delivered. Written BEFORE the
          // parked calls are resolved: the CLI is blocked inside the proxy
          // call, queues a message that arrives now, and attaches it to the
          // model call that follows the result, so it stays in this turn.
          // When the turn already ended (recovery), the completion envelope
          // opens a new turn first and the messages follow it instead. Only
          // what a previous tool-result turn for the same assistant boundary
          // has not already sent.
          const forwardTrailingUserMessages = async (): Promise<number> => {
            if (compactionMode || !state.activeProcess) return 0
            // On the interactive transport a stdin write is a new TUI turn that
            // would supersede the one parked in this proxy call (h #g204), so the
            // message is typed into that turn's own input queue instead, which
            // the TUI attaches to the model call after the result exactly as the
            // headless CLI does (h #g206). Only while that turn runs: typed into
            // an idle TUI it would start a turn nobody is listening to.
            const control = state.activeProcess.interactiveControl
            if (control && (!control.queueInput || !control.turnRunning())) return 0
            const trailing = getTrailingUserMessages(effectivePrompt, {
              stripContextReminders: self.stripContextRemindersEnabled(),
            })
            const sent =
              state.activeProcess.forwardedUserMessages?.assistantIndex === trailing.assistantIndex
                ? state.activeProcess.forwardedUserMessages.count
                : 0
            const fresh = trailing.messages.slice(sent)
            if (fresh.length === 0) return 0
            state.activeProcess.forwardedUserMessages = {
              assistantIndex: trailing.assistantIndex,
              count: trailing.messages.length,
            }
            if (control) {
              let queued = 0
              for (const content of fresh) if (await control.queueInput!(content)) queued++
              if (queued < fresh.length) {
                log.warn("the interactive turn did not take a forwarded user message", {
                  sessionKey: sk,
                  messages: fresh.length - queued,
                })
              }
              log.info("forwarded user messages into the interactive turn's input queue", {
                sessionKey: sk,
                messages: queued,
              })
              return queued
            }
            for (const content of fresh) {
              state.proc.stdin?.write(
                JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n",
              )
            }
            log.info("forwarded user messages that arrived beside tool results", {
              sessionKey: sk,
              messages: fresh.length,
            })
            return fresh.length
          }
          if (!state.unattendedTurnEnded && (await forwardTrailingUserMessages()) > 0) {
            // The CLI reads stdin and the proxy HTTP response on separate paths,
            // and a message it enqueues AFTER it consumed the result runs as a
            // second turn (measured: 2 of 7 forwardings, enqueue 6 and 19 ms
            // after the result). A short head start makes it queue first.
            await new Promise((resolve) => setTimeout(resolve, FORWARD_SETTLE_MS))
            // An abort can land in that wait. Its mid-turn branch has already
            // interrupted the CLI, rejected the parked calls and closed the
            // stream, so resolving them or recording their completions now
            // would hand a rejected call's result to a later turn as late text.
            if (state.controllerClosed) return
          }

          // Tool-result turn: the prompt carries opencode's results for the
          // proxy tool calls we drained on the previous turn. Resolve each
          // matched call (claude CLI's HTTP handlers wake up and continue).
          // Parallel tools may complete in separate opencode turns. Keep
          // unmatched siblings pending until their own result, an explicit
          // abort/new user turn, or the proxy deadline.
          for (const { call, result: opencodeResult } of previousPendingProxyMatches) {
            if (opencodeResult) {
              let result = opencodeResult
              if (call.toolName === "task" || call.toolName === TASK_BATCH_TOOL_NAME) {
                // A background dispatch opencode accepted, remembered so the
                // doctor can say how many are still running. Read-only parse,
                // and it runs before the text below is extended.
                noteBackgroundDispatchResult(sk, result)
                // The same number for the model, as one trailing line. Bounded:
                // a lookup that overruns its budget omits the line instead.
                result = await withBackgroundRunningCount(result)
                // An abort can land in that wait; its branch has already
                // rejected the parked calls, as for the forwarding wait above.
                if (state.controllerClosed) return
              }
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

          if (state.unattendedTurnEnded) {
            deliverPendingCompletions(state)
            await forwardTrailingUserMessages()
          }

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
        state.cliAskedForWork = true
        if (state.activeProcess) {
          noteTurnStarted(state.activeProcess)
          // A new ordinary turn sends its own trailing messages: forget the boundary.
          state.activeProcess.forwardedUserMessages = undefined
        }
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
