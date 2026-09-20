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
import { applyTaskCreateToolResult } from "./todo-ledger.js"
import {
  getClaudeUserMessage,
  shouldStripContextReminders,
} from "./message-builder.js"
import { resolveAgentEffort, resolveAgentModel } from "./agent-models.js"
import { parseSideQuestion, requestSideQuestion, collectSideQuestionHistory, SIDE_QUESTION_USAGE, type SideQuestionResult } from "./side-question.js"
import { BTW_NO_SESSION_MESSAGE, registerAsideSink, takeSideQuestionAnswer } from "./btw-command.js"
import {
  describeResultFailure,
  formatResultFailureNote,
  isRateLimitRejected,
  parseRateLimitEvent,
  reportCompactBoundary,
  reportRateLimitEvent,
  reportSystemInit,
} from "./cli-events.js"
import { DEFAULT_ACCOUNT, normalizeAccountName } from "./accounts.js"
import {
  buildFailoverContinuationPrompt,
  consumeAccountFailoverAnswer,
  createAccountFailoverQuestionCall,
  failoverCandidates,
  failoverUntil,
  formatFailoverNote,
  formatFailoverStopNote,
  isAccountFailoverQuestionActive,
  isAccountLimitError,
  resolveFailoverSpawn,
  setAccountOverride,
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
  QUESTION_TOOL_NAME,
  consumeExitPlanModeQuestionResult,
  createExitPlanModeQuestionCall,
  isPlanModeQuestionActive,
  type QuestionToolCall,
} from "./plan-mode-question.js"
import { bridgeOpencodeMcp, type RuntimeMcpStatus } from "./mcp-bridge.js"
import {
  getRuntimeMcpStatus,
  fetchOpencodeToolList,
  fetchSessionParentId,
  type OpencodeToolListItem,
  resolveSpawnCwdForSession,
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
  claudeSpawnEnv,
  isClaudeThinkingDisabled,
  sessionKey,
  effortSessionKey,
  invalidateOtherEffortSessions,
} from "./session-manager.js"
import { spawnInteractiveProcess } from "./claude-session-wrapper.js"
import {
  clearCompression,
  consumeCompressionRestart,
  getCompressionSummary,
  storeCompressionSummary,
} from "./compression-store.js"
import { log } from "./logger.js"
import { detectCliVersion } from "./cli-version.js"
import {
  createProxyMcpServer,
  resolveDisallowedTools,
  resolveProxyOpencodeToolDefs,
  resolveMcpProxyToolDefs,
  DEFAULT_PROXY_TOOLS,
  overlayTaskProxyDescription,
  overlayQuestionProxyDescription,
  filterQuestionProxyByOpencodeSupport,
  PROXY_TOOL_PREFIX,
  TASK_BATCH_TOOL_NAME,
  taskBatchTasks,
  taskBatchChildToolCallId,
  formatTaskBatchResults,
  type McpProxyToolResolution,
  type ModelToolEntry,
  type ProxyMcpServer,
  type ProxyToolCall,
  type ProxyToolDef,
  type ProxyToolInterceptor,
  type ProxyToolResult,
} from "./proxy-mcp.js"
import {
  getPendingProxyCalls,
  isPendingProxyCallChannelClosed,
  markPendingProxyCallEmitted,
  onPendingProxyCall,
  queuePendingProxyCall,
  rejectAllPendingProxyCallsForSession,
  rejectPendingProxyCallById,
  resolvePendingProxyCallById,
  type PendingProxyCall,
} from "./proxy-broker.js"
import { readFileSync, writeFileSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"

/**
 * Default model used for opencode `/compact`. Haiku 4.5 is fast
 * (~150 tok/s), has a hard 8k output cap that bounds latency, and is a
 * strong structured summarizer. Override per-project via the
 * `compactionModel` provider setting in opencode.json / opencode.jsonc,
 * or per-run via the `CLAUDE_CODE_COMPACTION_MODEL` env var (env wins).
 */
export const DEFAULT_COMPACTION_MODEL = "claude-haiku-4-5"

/**
 * Pick the model used to handle /compact. Precedence:
 *   1. `CLAUDE_CODE_COMPACTION_MODEL` env var (per-process override)
 *   2. `configured` argument (the `compactionModel` provider setting)
 *   3. `DEFAULT_COMPACTION_MODEL`
 *
 * Exported as a free function so it can be unit-tested without
 * instantiating the language model class.
 */
export function resolveCompactionModel(configured?: string): string {
  const env = process.env.CLAUDE_CODE_COMPACTION_MODEL?.trim()
  if (env) return env
  const trimmed = configured?.trim()
  if (trimmed) return trimmed
  return DEFAULT_COMPACTION_MODEL
}

/**
 * Resolve the session affinity token for a given LLM call. The affinity
 * token is part of the session key in session-manager so two different
 * opencode sessions sharing the same cwd+model still get separate Claude
 * CLI processes.
 *
 * Priority:
 *   1. `x-session-affinity` request header (primary — opencode sets it for
 *      third-party providers in packages/opencode/src/session/llm.ts).
 *   2. `opencodeSessionID` inside `providerOptions` (injected by the
 *      `chat.params` hook in index.ts). Covers cases where the header is
 *      absent: provider switch mid-session, title synthesis paths, older
 *      opencode versions. opencode wraps `output.options` under the
 *      providerID before passing it to the language model, so we look up
 *      both the configured provider key and the canonical `"claude-code"`.
 *   3. `"default"` — safe fallback when neither source is available.
 *
 * Exported as a free function so it can be unit-tested without
 * instantiating the language model class.
 */
export function resolveSessionAffinity(
  headers: Record<string, string | undefined> | undefined,
  providerOptions: Record<string, unknown> | undefined,
  providerKey: string,
): string {
  if (headers) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "x-session-affinity") {
        const v = headers[key]
        if (typeof v === "string" && v.length > 0) return v
      }
    }
  }
  if (providerOptions) {
    const bag =
      (providerOptions as any)[providerKey] ??
      (providerOptions as any)["claude-code"]
    const sid = bag?.opencodeSessionID
    if (typeof sid === "string" && sid.length > 0) return sid
  }
  return "default"
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

/**
 * True if the prompt has any user-side content after the last assistant
 * message (text, tool_result, or any user role entry). False when the
 * prompt ends with an assistant message and there is nothing for Claude
 * to respond to — opencode sometimes iterates the agent loop one more
 * time after a turn naturally completed; without short-circuiting we'd
 * spawn Claude CLI on an empty turn and the model would reply with a
 * stub like "Did you mean to send a message?".
 */
export function hasNewUserContent(
  prompt: LanguageModelV3CallOptions["prompt"],
): boolean {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const msg = prompt[i]
    if (msg.role === "assistant") return false
    // Tool-result turns from opencode's outer loop arrive in `tool`-role
    // messages (AI SDK V3 shape). Treat any tool-result part as new
    // content so the short-circuit doesn't drop turns where opencode is
    // delivering the result for a still-pending proxy MCP call — letting
    // that fire `stop` is what was forcing the user to press "continue".
    if (msg.role === "tool") {
      const content: any = msg.content
      if (Array.isArray(content)) {
        for (const part of content as any[]) {
          if (part?.type === "tool-result") return true
        }
      }
      continue
    }
    if (msg.role !== "user") continue
    const content: any = msg.content
    if (typeof content === "string") {
      if (content.trim()) return true
      continue
    }
    if (Array.isArray(content)) {
      for (const part of content as any[]) {
        if (part.type === "text" && part.text && part.text.trim()) return true
        if (part.type === "tool-result") return true
        // Image/file-only user turns count as new input — without this the
        // short-circuit drops them as if the turn were empty.
        if (part.type === "image" || part.type === "file") return true
      }
    }
  }
  return false
}

const AUTO_CONTINUE_MAX_ATTEMPTS = 8
const AUTO_CONTINUE_MAX_ELAPSED_MS = 10 * 60 * 1000
const AUTO_CONTINUE_NO_PROGRESS_LIMIT = 2
const PROXY_RESULT_BOUNDARY_GRACE_MS = 250
// How long a turn that lost its child waits for that child's exit status
// before reporting the crash without one.
const CHILD_EXIT_STATUS_GRACE_MS = 250

const AUTO_CONTINUE_PROMPT =
  "Continue the task from where you stopped. Do not summarize; keep working until the requested task is complete, you need clarification, or you hit a real blocker."

/** One per-turn snapshot of opencode's live tool registry. */
interface LiveToolInfo {
  /** False when nothing answered (no SDK client, fetch failed). */
  resolved: boolean
  taskDescription: string | undefined
  questionDescription: string | undefined
  hasQuestion: boolean
  /**
   * The raw registry entries behind the fields above, so `proxyOpencodeTools`
   * can be resolved from the same single fetch rather than a second one.
   */
  items?: OpencodeToolListItem[]
}

interface AutoContinueState {
  enabled: boolean | "smart" | undefined
  attempts: number
  startedAt: number
  noProgressCount: number
  lastSignature?: string
  aborted?: boolean
  /**
   * Latched true once AskUserQuestion is rendered this turn. Auto-continue
   * must never fire afterwards: the model has handed control to the operator
   * and is waiting for a real reply. Without this, a short trailing text after
   * the question (one that doesn't trip looksLikeQuestion) would let the turn
   * look "incomplete", and the auto-continue nudge would make the model
   * proceed on its own — which the operator sees as the question being
   * answered/cancelled without them ever interacting.
   */
  sawAskUserQuestion?: boolean
}

interface AutoContinueSnapshot {
  text: string
  /**
   * Text of the most recent assistant text block only. Used for final-answer
   * detection so mid-task narration like "Implementing now. Updated the
   * search index." in an earlier block doesn't trip the keyword regex.
   */
  lastVisibleText: string
  hadReasoning: boolean
  hadToolActivity: boolean
  hadProxyActivity: boolean
  isError?: boolean
  /**
   * Protocol-level stop signal from the Claude API (forwarded by Claude
   * CLI). When present and non-empty, we trust it as authoritative — the
   * model itself signaled why the turn ended (`end_turn`, `max_tokens`,
   * `stop_sequence`, `refusal`, `pause_turn`, `tool_use`, etc.) — and stop
   * without running the keyword regex. The heuristic only runs as a
   * fallback when `stop_reason` is missing (older CLI versions, abrupt
   * termination).
   */
  stopReason?: string | null
  now?: number
}

/**
 * A compaction turn must never be nudged to continue. `AUTO_CONTINUE_PROMPT`
 * says "Do not summarize; keep working", the exact inverse of what `/compact`
 * is for, and continuation reopens the same stream rather than closing it, so
 * the non-summary text would land inside what opencode stores as the session
 * summary. This was unreachable while every `stop_reason` ended the turn;
 * truncation-continue made a summary that hits the output cap reach it.
 * Exported so the wiring is testable, since the state itself is built inline
 * in `doStream`.
 */
export function autoContinueEnabledFor(
  compactionMode: boolean,
  configured: boolean | "smart" | undefined,
): boolean | "smart" | undefined {
  return compactionMode ? false : configured
}

/**
 * Stop reasons that mean "cut off", not "done". Anthropic sends `max_tokens`;
 * `max_output_tokens` is accepted as a defensive alias so a rename upstream
 * degrades to today's behaviour rather than silently mis-reading a real stop.
 */
function isTruncationStopReason(stopReason: string): boolean {
  return stopReason === "max_tokens" || stopReason === "max_output_tokens"
}

interface AutoContinueDecision {
  continue: boolean
  reason: string
}

function normalizeVisibleText(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/** Tool names that mean "ask the human a question" (CLI casing variants). */
export function isAskUserQuestionTool(name: string | undefined): boolean {
  if (!name) return false
  const n = name.toLowerCase()
  return n === "askuserquestion" || n === "ask_user_question"
}

/**
 * Deny message returned to the model when it invokes AskUserQuestion.
 *
 * AskUserQuestion is denied (see controlRequestBehaviorForTool) so the
 * headless CLI cannot self-answer against an empty TTY. The question is
 * already rendered to the operator by formatAskUserQuestion, so this text
 * tells the model to stop and wait — unconditionally. Earlier versions
 * offered an "if this is non-interactive, proceed with a reasonable guess"
 * escape hatch, but the model could not reliably tell interactive opencode
 * from a headless run and routinely took it, so questions appeared to be
 * skipped (issue #8). Stopping is the correct default for opencode; a
 * headless run simply ends the turn with the question as its final output.
 */
const ASK_USER_QUESTION_DENY_MESSAGE =
  "Your question and its options have already been presented to the" +
  " operator verbatim. This is NOT a cancellation or a refusal — the" +
  " operator simply has not answered yet. Stop now: end your turn without" +
  " calling any more tools and without answering the question yourself. Do" +
  " not say the question was cancelled, skipped, or declined, and do not" +
  " guess, assume, or proceed on their behalf. Wait for the operator's" +
  " reply, which arrives as the next user message."

/** Build the deny message for an auto-denied control request. */
export function denyMessageForTool(
  toolName: string | undefined,
  configuredDenyMessage?: string,
): string {
  if (isAskUserQuestionTool(toolName)) return ASK_USER_QUESTION_DENY_MESSAGE
  return (
    configuredDenyMessage ??
    `Denied by opencode-claude-code policy for tool ${toolName}`
  )
}

/**
 * Render Claude Code's `AskUserQuestion` tool input as visible markdown.
 *
 * This is the fallback path used when the `Question` proxy is off or the
 * opencode build lacks the `question` registry entry. When the proxy is
 * enabled, `AskUserQuestion` is disabled via `--disallowedTools` and the
 * model calls `mcp__opencode_proxy__question` instead (opencode's native
 * `question` tool renders the TUI form). Here, the question + every
 * option is rendered as readable assistant text and the user answers in
 * the next turn — same approach as the `ExitPlanMode` handling. The
 * previous behavior collapsed the whole payload to a single faint
 * `_Asking: <q>_` line, dropping all options and any question past the
 * first.
 */
function formatAskUserQuestion(input: Record<string, unknown>): string {
  const anyInput = input as any
  const questions: any[] = Array.isArray(anyInput?.questions)
    ? anyInput.questions
    : []

  if (questions.length === 0) {
    const single = anyInput?.question ?? anyInput?.text
    const q =
      typeof single === "string" && single.trim() ? single.trim() : "Question?"
    return `\n\n**${q}**\n\n_Reply with your answer to continue._\n\n`
  }

  const out: string[] = ["\n\n"]
  const multiQ = questions.length > 1
  questions.forEach((q, i) => {
    const text =
      (typeof q?.question === "string" && q.question.trim()) ||
      (typeof q?.text === "string" && q.text.trim()) ||
      "Question?"
    const header =
      typeof q?.header === "string" && q.header.trim() ? q.header.trim() : ""
    out.push(`**${multiQ ? `${i + 1}. ` : ""}${text}**`)
    if (header) out.push(` _(${header})_`)
    out.push("\n\n")

    const options: any[] = Array.isArray(q?.options) ? q.options : []
    options.forEach((opt, j) => {
      const label =
        (typeof opt?.label === "string" && opt.label.trim()) ||
        (typeof opt === "string" && opt.trim()) ||
        `Option ${j + 1}`
      const desc =
        typeof opt?.description === "string" && opt.description.trim()
          ? ` — ${opt.description.trim()}`
          : ""
      out.push(`${j + 1}. **${label}**${desc}\n`)
    })

    out.push(
      q?.multiSelect === true
        ? "\n_Select one or more — reply with the numbers or labels._\n\n"
        : "\n_Reply with your choice (the number or label)._\n\n",
    )
  })
  return out.join("")
}

function looksLikeQuestion(text: string): boolean {
  const normalized = normalizeVisibleText(text).toLowerCase()
  if (!normalized) return false
  // v0.4.10 tweak 5a: '?' anywhere in the last block, not just trailing.
  // Catches long answers that pose a question mid-text then list options
  // and end with a period. FP risk on inline code (`result?.value`) is
  // accepted — cost is one extra "continue" press, in the safe direction.
  if (normalized.includes("?")) return true
  // v0.4.11 additions: ready when you are / standing by / i'll stand by /
  // let me know when. These are awaiting-input idioms with no '?'. The
  // "standing by" addition has historical significance — it's the exact
  // stub phrase Claude CLI emits on empty turns that commit 49345e3 was
  // designed to suppress at the message-builder layer. This adds a second
  // line of defense at the model-output layer for cases where the model
  // organically produces the same idiom.
  //
  // v0.4.12 additions: over to you / your turn / all yours / let me know
  // how / i'm here. Defensive coverage of soft-proceed idioms in the
  // model's vocabulary. "i'm here" has the highest FP risk ("I'm here to
  // help with X" is a conversational opener) but cost of FP is one extra
  // continue press — safe direction.
  return /\b(please confirm|can you confirm|should i|would you like|do you want|which option|choose|pick one|need your|need you to|what would you like|let me know if|let me know whether|let me know what|let me know when|let me know how|if you'?d like|if you want to|tell me if|tell me which|tell me whether|say (?:go|yes|no)|push back|sign off|sounds? (?:good|right)|your call|your move|your turn|over to you|all yours|up to you|ready to (?:ship|go|proceed|merge)|ready (?:when|whenever|once|if) you|standing by|i'?ll stand ?by|i'?m here|happy to (?:ship|go|proceed|merge))\b/.test(normalized)
}

function looksLikeBlocker(text: string): boolean {
  const normalized = normalizeVisibleText(text).toLowerCase()
  if (!normalized) return false
  // v0.4.10 tweak 3: 'needs your' / 'needs you to' / 'action required'
  // are intent-equivalent to 'requires your' but use the verb-with-s form.
  return /\b(blocked|blocker|cannot proceed|can't proceed|unable to proceed|need clarification|need more information|permission denied|failed and needs|requires your|needs your|needs you to|action required|manual step|required from you)\b/.test(normalized)
}

function looksLikeFinalAnswer(text: string): boolean {
  const normalized = normalizeVisibleText(text).toLowerCase()
  if (looksLikeQuestion(normalized) || looksLikeBlocker(normalized)) return false
  // v0.4.15: strong-completion phrases bypass the 30-char length floor.
  // These are unambiguous end-of-turn signals at any text length — even
  // a short standalone "We're done." should stop.
  if (/\b(we'?re done|we are done|all done|all set)\b/.test(normalized)) {
    return true
  }
  // v0.4.10 tweak 4: floor lowered 40 → 30 chars. Catches short clean
  // completions like "Task is now completely done. Pushed." (36 chars)
  // while keeping a buffer against ambiguous short narration.
  if (normalized.length < 30) return false
  // v0.4.15: keyword list extended with deploy/ship verbs the model
  // routinely uses at turn end (shipped, deployed, merged, tagged, live,
  // pinned). FP risk highest on "live" — "live data" mid-turn could match
  // — but cost of FP is one extra continue press, safe direction.
  return /\b(done|completed|fixed|implemented|verified|published|released|sent|delivered|updated|shipped|deployed|merged|tagged|live|pinned)\b/.test(normalized) ||
    // v0.4.15: also accept present-tense "tests pass" / "checks pass".
    // Real fire 03:31 ended in "78/78 tests pass" — past-tense-only regex
    // missed it.
    /\b(checks?|tests?) (?:pass|passes|passed)\b/.test(normalized) ||
    /\b(summary|what changed|verification)\b/.test(normalized)
}

function continuationSignature(snapshot: AutoContinueSnapshot): string {
  const text = normalizeVisibleText(snapshot.text).slice(-500)
  return JSON.stringify({
    text,
    reasoning: snapshot.hadReasoning,
    tools: snapshot.hadToolActivity,
    proxy: snapshot.hadProxyActivity,
  })
}

export function shouldAutoContinueIncompleteTurn(
  state: AutoContinueState,
  snapshot: AutoContinueSnapshot,
): AutoContinueDecision {
  if (state.enabled === false) return { continue: false, reason: "disabled" }
  if (snapshot.isError) return { continue: false, reason: "error" }
  if (state.aborted) return { continue: false, reason: "aborted" }
  // Once the model asked the operator a question this turn, never nudge it to
  // continue — it is waiting for a reply, not stalled. Latched so it holds
  // even when the trailing text after the question doesn't read as a question.
  if (state.sawAskUserQuestion) return { continue: false, reason: "question" }
  // v0.4.17: trust ANY protocol-level stop_reason as authoritative. If
  // Claude CLI emitted a stop_reason value at all, the model has signaled
  // a stop — honor it without consulting the keyword heuristic. The
  // heuristic only runs as a fallback when stop_reason is missing (older
  // CLI versions / edge cases). Maps snake_case → kebab-case for reason
  // label consistency with other reasons.
  if (snapshot.stopReason) {
    // ...with one exception, which is the narrow half of @JWebCoder's PR #15
    // worth keeping. Truncation is the single stop_reason that does NOT mean
    // the model finished: the response hit the output cap mid-sentence. The
    // old guard read it as a stop, so a cut-off answer was silently accepted
    // as complete. Falling through to the keyword heuristic below would not
    // fix it either, because a truncated prose answer has no tool or
    // reasoning activity and would die at the `no-activity` gate. So
    // truncation is authoritative in the opposite direction: continue, still
    // bounded by the attempt and elapsed rails. PR #15 itself deleted the
    // whole guard, which would have handed every turn back to the regex that
    // v0.4.17 deliberately demoted; that is why it was closed.
    if (isTruncationStopReason(snapshot.stopReason)) {
      if (state.attempts >= AUTO_CONTINUE_MAX_ATTEMPTS) {
        return { continue: false, reason: "max-attempts" }
      }
      const truncatedAt = snapshot.now ?? Date.now()
      if (truncatedAt - state.startedAt > AUTO_CONTINUE_MAX_ELAPSED_MS) {
        return { continue: false, reason: "max-elapsed" }
      }
      return { continue: true, reason: "truncated" }
    }
    return {
      continue: false,
      reason: snapshot.stopReason.replace(/_/g, "-"),
    }
  }
  if (state.attempts >= AUTO_CONTINUE_MAX_ATTEMPTS) {
    return { continue: false, reason: "max-attempts" }
  }
  const now = snapshot.now ?? Date.now()
  if (now - state.startedAt > AUTO_CONTINUE_MAX_ELAPSED_MS) {
    return { continue: false, reason: "max-elapsed" }
  }

  const text = normalizeVisibleText(snapshot.text)
  const lastText = normalizeVisibleText(snapshot.lastVisibleText)
  if (looksLikeQuestion(text)) return { continue: false, reason: "question" }
  if (looksLikeBlocker(text)) return { continue: false, reason: "blocker" }
  // Final-answer detection runs on the most recent text block only. Earlier
  // blocks may contain mid-task narration that would false-positive the
  // keyword regex; the model's actual "I'm done" sentence is in the last
  // block before result/end_turn.
  if (looksLikeFinalAnswer(lastText)) {
    return { continue: false, reason: "final-answer" }
  }

  const hadActivity =
    snapshot.hadReasoning || snapshot.hadToolActivity || snapshot.hadProxyActivity
  if (!hadActivity) return { continue: false, reason: "no-activity" }

  const signature = continuationSignature(snapshot)
  const noProgress = signature === state.lastSignature
  if (noProgress && state.noProgressCount + 1 >= AUTO_CONTINUE_NO_PROGRESS_LIMIT) {
    return { continue: false, reason: "no-progress" }
  }

  if (!text) {
    return { continue: true, reason: "activity-without-visible-answer" }
  }

  return { continue: true, reason: "non-final-progress" }
}

function makeAutoContinueMessage(): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: AUTO_CONTINUE_PROMPT }],
    },
  })
}

/**
 * A proxy result whose HTTP reply channel Claude already abandoned cannot
 * go back as a `tool_result` (the CLI closed that tool_use with a timeout
 * error). Hand it over as a user message that names the call instead.
 */
export function makeLateProxyResultMessage(
  entries: Array<{ call: PendingProxyCall; result: ProxyToolResult }>,
): string {
  const sections = entries.map(({ call, result }) => {
    const failed = result.kind === "error" || result.isError === true
    const body = result.kind === "error" ? result.message : result.text
    return (
      `Your earlier \`${call.toolName}\` tool call (id ${call.toolCallId})` +
      ` has ${failed ? "failed" : "completed"}, but delivery or continuation was interrupted.` +
      ` Treat the following as its ${failed ? "error" : "result"} and continue from there;` +
      ` do not re-run it.\n\n${body}`
    )
  })
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
    },
  })
}

function readPromptFileIfPresent(path: string): string | undefined {
  try {
    const content = readFileSync(path, "utf8").trim()
    return content || undefined
  } catch {
    return undefined
  }
}

function nearestWorkspaceAgentsPrompt(cwd: string): string | undefined {
  let dir = cwd
  while (true) {
    const content = readPromptFileIfPresent(join(dir, "AGENTS.md"))
    if (content) return content
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

const AGENTS_MAINTENANCE_HINT = `## Keeping AGENTS.md up to date

When you complete a task, phase, or to-do item that is listed in AGENTS.md, update the file
immediately after the work is done — mark it ✅, check it off, or remove it. Do this inside
the same turn so the next session does not repeat work that is already finished.`

const MULTI_STEP_TASK_HINT = `## Continuing through multi-step tasks

opencode requires the user to press "continue" after each turn ends. When a
task has multiple steps, do them all in one turn — chain tool calls rather
than pausing for user confirmation between subtasks. End the turn only
when the task is done, you need clarification on intent, or you hit a real
blocker. The user can interrupt or abort at any time; turn endings should
mark meaningful checkpoints, not every completed substep.`

/**
 * Appended to the system prompt whenever the `task` proxy tool is
 * enabled. Live sessions (2026-07-04) showed models resolving opencode's
 * "call the task tool with subagent: X" mention hint to Claude Code's
 * native TaskCreate: haiku created a todo and narrated a dispatch that
 * never happened; sonnet probed TaskCreate's schema before recovering.
 * The proxy tool can also be deferred behind ToolSearch, in which case
 * "the task tool" is invisible while TaskCreate is not. Name the exact
 * tool, the recovery path, and the failure mode.
 */
export const SUBAGENT_DISPATCH_HINT = `## opencode subagents

Subagent dispatch in this environment goes through exactly two tools: \`mcp__opencode_proxy__task\` for one subagent and \`mcp__opencode_proxy__task_batch\` for two or more at once.

- Two or more independent subagents in one response: make ONE \`mcp__opencode_proxy__task_batch\` call with a \`tasks\` array (each item is a normal task input). Claude Code runs MCP calls one at a time, so several \`mcp__opencode_proxy__task\` calls in the same response run serially; \`task_batch\` runs them concurrently in opencode and returns every result together, labelled in order.
- When the user mentions \`@<agent>\` or an instruction says "call the task tool with subagent: <name>", call \`mcp__opencode_proxy__task\` with \`subagent_type: "<name>"\`.
- If that tool is not in your visible tool list it is deferred — load it with ToolSearch (\`select:mcp__opencode_proxy__task\`), then call it.
- Claude Code's built-in TaskCreate/TaskUpdate/TaskList manage a local todo list. They cannot dispatch subagents; creating a task there runs nothing. Never report a subagent as dispatched unless \`mcp__opencode_proxy__task\` returned its result.
- Do not verify a subagent's existence by searching config files — the tool's description lists the available agent types, and invalid types fail fast with a clear error.`

/**
 * Appended to the system prompt whenever the `question` proxy tool is
 * enabled. Live testing (2026-07-05, haiku) showed the model's reasoning
 * correctly identified `mcp__opencode_proxy__question` as the tool to use,
 * but then emitted a tool call for bare `question` — stripping the MCP
 * prefix. opencode's AI SDK bridge has no bare `question` tool, so the
 * call rendered as `⚙ invalid`. Same near-miss pattern the task proxy
 * hit (TaskCreate vs mcp__opencode_proxy__task); the fix is the same:
 * name the exact tool in the system prompt so the model doesn't
 * abbreviate.
 */
export const QUESTION_PROXY_HINT = `## Asking the operator questions

Structured questions in this environment go through exactly one tool: \`mcp__opencode_proxy__question\`.

- When you need to ask the operator a question with options, call \`mcp__opencode_proxy__question\` with a \`questions\` array (each item has \`question\`, \`header\`, \`options\` of \`{label, description}\`, and optional \`multiple\`).
- If that tool is not in your visible tool list it is deferred — load it with ToolSearch (\`select:mcp__opencode_proxy__question\`), then call it by its FULL name.
- Do NOT call bare \`question\` — that is not a tool. Always use the full \`mcp__opencode_proxy__question\` name when invoking it.
- Claude Code's built-in \`AskUserQuestion\` is disabled in this environment; the proxy is the only way to ask structured questions.`

/**
 * Prepended to every appended system prompt so Claude knows which
 * context-management tools exist in the Claude CLI runtime versus a
 * direct API provider. DCP and similar plugins forward compress/distill/
 * prune instructions via system.transform; those reach us through
 * extractSystemMessages, but the tools themselves are not available in
 * the CLI environment. Without this note Claude wastes thinking cycles
 * searching for tools that don't exist.
 */
const CLAUDE_CLI_CONTEXT_NOTE = `## Runtime environment: Claude Code CLI

You are running via the Claude Code CLI (not a direct API call). This affects context management:

- The \`compress\` tool is NOT available. Do not attempt to call it.
- The \`distill\`, \`prune\`, and \`extract\` tools are NOT available.
- Context window management is handled automatically by Claude CLI's own session history.
- Ignore any system instructions that tell you to call \`compress\` — they are intended for direct API providers, not this environment.
- DCP context injections (AGENTS.md, dynamic state) arrive via the system prompt and are already applied.`

/**
 * Replaces the note above when `compress` is in the resolved proxy list.
 * The full MCP name is spelled out for the same reason the question proxy
 * hint spells its own out: models strip the prefix and call bare
 * `compress`, which opencode renders as `⚙ invalid`.
 */
const CLAUDE_CLI_COMPRESS_NOTE = `## Runtime environment: Claude Code CLI

You are running via the Claude Code CLI (not a direct API call). This affects context management:

- To compress context, call \`mcp__opencode_proxy__compress\` with a \`summary\` argument. Use that exact full name.
- The reset happens at the start of your NEXT turn: this Claude Code session is discarded and a fresh one starts with your summary as its only prior context. Keep working normally after the call.
- Everything outside the summary is gone after the reset — tool output, files you read, and the earlier conversation are not replayed. Write the summary as the authoritative record.
- The \`distill\`, \`prune\`, and \`extract\` tools are NOT available.
- DCP context injections (AGENTS.md, dynamic state) arrive via the system prompt and are already applied.`

/**
 * Used when opencode's own `compress` tool is forwarded through the proxy
 * (`proxyOpencodeTools: ["compress"]`) instead of the plugin's in-process
 * one. The two shrink different windows and the difference has to be said
 * out loud: opencode's rewrites opencode's transcript, so the live Claude
 * Code session keeps everything it already had. A model told otherwise
 * would assume detail it can still see had been discarded.
 */
const CLAUDE_CLI_OPENCODE_COMPRESS_NOTE = `## Runtime environment: Claude Code CLI

You are running via the Claude Code CLI (not a direct API call). This affects context management:

- To compress context, call \`mcp__opencode_proxy__compress\`. Use that exact full name. It runs opencode's own \`compress\` tool, which is what a "MAX CONTEXT LIMIT REACHED" reminder is asking you to do.
- It compresses opencode's stored conversation, NOT this Claude Code session. Your current session keeps the context it already has, so do not assume earlier detail is gone after the call.
- The \`distill\`, \`prune\`, and \`extract\` tools are NOT available.
- DCP context injections (AGENTS.md, dynamic state) arrive via the system prompt and are already applied.`

/**
 * Extract text content from all `system`-role messages in the prompt.
 * Standard API providers forward these as the `system` parameter; for
 * Claude CLI, the only equivalent path is --append-system-prompt-file.
 * Plugins like opencode-dcp inject AGENTS.md and other context via
 * system-role messages and would otherwise be silently dropped.
 */
function extractSystemMessages(
  prompt: LanguageModelV3CallOptions["prompt"],
): string[] {
  const out: string[] = []
  for (const msg of prompt) {
    if (msg.role !== "system") continue
    if (typeof msg.content === "string") {
      if (msg.content.trim()) out.push(msg.content.trim())
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as any[]) {
        if (
          part?.type === "text" &&
          typeof part.text === "string" &&
          part.text.trim()
        ) {
          out.push(part.text.trim())
        }
      }
    }
  }
  return out
}

export interface AppendedSystemPromptOptions {
  /** True when the plugin's own `compress` def is in the proxy list. */
  compressEnabled?: boolean
  /** True when opencode's `compress` tool is forwarded through the proxy. */
  opencodeCompressEnabled?: boolean
  /** Summary from a previous `compress` call, if this key has one. */
  compressionSummary?: string
}

export function buildAppendedSystemPrompt(
  cwd: string,
  includeMultiStepHint = true,
  extraSystemContent: string[] = [],
  options: AppendedSystemPromptOptions = {},
): string | undefined {
  const parts: string[] = []
  // First, so it reads as prior context for everything that follows.
  if (options.compressionSummary?.trim()) {
    parts.push(
      `## Summary of earlier work (context was compressed)\n\n${options.compressionSummary.trim()}`,
    )
  }
  // The plugin's own compress wins when both are somehow live, matching the
  // def-level precedence in resolveProxyOpencodeToolDefs: it is the one that
  // holds the name, so it is the one the model would reach.
  parts.push(
    options.compressEnabled
      ? CLAUDE_CLI_COMPRESS_NOTE
      : options.opencodeCompressEnabled
        ? CLAUDE_CLI_OPENCODE_COMPRESS_NOTE
        : CLAUDE_CLI_CONTEXT_NOTE,
  )
  for (const s of extraSystemContent) {
    if (s.trim()) parts.push(s.trim())
  }
  const configRoot =
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  const globalAgents = readPromptFileIfPresent(join(configRoot, "opencode", "AGENTS.md"))
  const workspaceAgents = nearestWorkspaceAgentsPrompt(cwd)

  // opencode already forwards AGENTS.md inside its own system prompt
  // (`extraSystemContent`, under an "Instructions from:" header), so a
  // disk-read copy would reach the model twice. Only push ours when the
  // forwarded text does not already contain it. No match (formatting drift,
  // or the interactive path, which forwards nothing) keeps the old behaviour,
  // so AGENTS.md is never lost. (Dedup by @HeikoAtGitHub, 25260a4.)
  const forwarded = extraSystemContent.join("\n\n")
  const pushGlobal = !!globalAgents && !forwarded.includes(globalAgents)
  const pushWorkspace =
    !!workspaceAgents && workspaceAgents !== globalAgents &&
    !forwarded.includes(workspaceAgents)
  if (pushGlobal) parts.push(globalAgents)
  if (pushWorkspace) parts.push(workspaceAgents)
  if (pushGlobal || pushWorkspace) parts.push(AGENTS_MAINTENANCE_HINT)
  if (includeMultiStepHint) parts.push(MULTI_STEP_TASK_HINT)

  const content = parts.join("\n\n")
  if (!content) return undefined

  const path = join(tmpdir(), `opencode-cc-sys-${randomUUID()}.md`)
  try {
    writeFileSync(path, content, "utf8")
    return path
  } catch (err) {
    log.warn("failed to write system prompt file", { error: String(err) })
    return undefined
  }
}

/**
 * Human-readable explanations for the CLI's `fast_mode_disabled_reason` codes,
 * so a downgrade tells the user what to do instead of leaking an enum.
 */
const FAST_MODE_REASONS: Record<string, string> = {
  sdk_opt_in_required:
    "the CLI did not receive the headless opt-in (--settings). This is a plugin bug, please report it",
  extra_usage_disabled:
    "your account has usage credits turned off. Run /usage-credits in an interactive `claude` session to enable them",
  free: "fast mode requires a paid subscription or purchased credits",
  preference: "fast mode is turned off for your organization",
  model_not_allowed:
    "this model is not in your organization's allowed models",
  not_first_party:
    "fast mode only works against the Anthropic API directly, not Bedrock / Vertex / Foundry",
  network_error: "the CLI could not reach Anthropic to check availability",
  disabled_by_env: "CLAUDE_CODE_DISABLE_FAST_MODE is set in the environment",
  pending: "the CLI is still checking availability",
}

/** Reasons already surfaced this process, so a persistent block warns once. */
const warnedFastModeReasons = new Set<string>()

/** Test-only. */
export function _resetFastModeWarnings(): void {
  warnedFastModeReasons.clear()
}

/**
 * Report what actually happened to a fast-mode request.
 *
 * Fast mode fails soft: an ineligible account or a rate-limit cooldown drops
 * back to standard speed with no error. That silence is the problem worth
 * solving here: the fast model ids advertise 10x pricing in opencode's picker,
 * so a downgrade the user cannot see means the picker is lying about cost for
 * every subsequent turn.
 *
 * A hard block is therefore a WARN, which this codebase routes to the TUI
 * unconditionally (NOTICE only surfaces in debug mode, which would defeat the
 * purpose). It is deduped per reason per process because the blocking
 * conditions are account-level and would otherwise repeat on every respawn.
 * Cooldown stays quieter: it is transient and clears on its own.
 */
export function reportFastModeState(
  msg: ClaudeStreamMessage,
  requested: boolean,
): void {
  const state = msg.fast_mode_state
  if (!state) return

  if (!requested) {
    // Nothing was asked for. Only interesting at debug level.
    log.debug("fast mode state", { state })
    return
  }

  if (state === "on") {
    log.info("fast mode active", { state })
    return
  }

  const reason = msg.fast_mode_disabled_reason
  if (state === "cooldown") {
    log.notice(
      "fast mode is in cooldown after a rate limit; this turn runs at standard speed and is billed at standard Opus rates, not the 10x shown in the model picker.",
      { state, reason: reason ?? null },
    )
    return
  }

  const key = reason ?? "unknown"
  const explanation = reason ? FAST_MODE_REASONS[reason] : undefined
  const message = `fast mode was requested but is off${
    explanation ? `: ${explanation}` : reason ? ` (${reason})` : ""
  }. Turns run at standard speed and are billed at standard Opus rates, not the 10x shown in the model picker. Switch to the non-fast model id to make the picker's price accurate.`

  if (warnedFastModeReasons.has(key)) {
    log.debug(message, { state, reason: reason ?? null })
    return
  }
  warnedFastModeReasons.add(key)
  log.warn(message, { state, reason: reason ?? null })
}

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
    // Prefer the last iteration's counters over cumulative totals.
    // CLI usage is the sum across all internal tool-use iterations;
    // using it directly inflates context size and triggers premature compaction.
    const iter = rawUsage?.iterations
    const effective = iter?.length ? iter[iter.length - 1] : rawUsage
    // Claude CLI reports input_tokens as non-cached input only.
    // OpenCode expects total = noCache + cacheRead + cacheWrite.
    const noCache = effective?.input_tokens ?? 0
    const cacheRead = effective?.cache_read_input_tokens ?? 0
    const cacheWrite = effective?.cache_creation_input_tokens ?? 0
    return {
      inputTokens: {
        total: noCache + cacheRead + cacheWrite,
        noCache,
        cacheRead: cacheRead || undefined,
        cacheWrite: cacheWrite || undefined,
      },
      outputTokens: {
        total: effective?.output_tokens,
        text: effective?.output_tokens,
        reasoning: undefined,
      },
      raw: rawUsage as any,
    }
  }

  private toFinishReason(
    reason: "stop" | "tool-calls" | "error" = "stop",
  ): LanguageModelV3FinishReason {
    return {
      unified: reason,
      raw: reason,
    }
  }

  private requestScope(options: { tools?: unknown }): "tools" | "no-tools" {
    const tools = options?.tools
    if (Array.isArray(tools)) return "tools"
    if (tools && typeof tools === "object") {
      return Object.keys(tools as Record<string, unknown>).length > 0
        ? "tools"
        : "no-tools"
    }
    return "no-tools"
  }

  /**
   * Build the combined `--mcp-config` list and return both the list and the
   * hash of the bridged opencode MCP block (or null when bridging is off /
   * yields nothing). The hash is used to detect mid-session config changes
   * and respawn the underlying claude process.
   *
   * `runtimeStatus` is a snapshot of opencode's `client.mcp.status()`. When
   * provided it overlays opencode's UI-toggled state on top of disk config
   * so `/mcps` toggles propagate without a config file write.
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
    const paths = Array.isArray(this.config.mcpConfig)
      ? this.config.mcpConfig.slice()
      : this.config.mcpConfig
        ? [this.config.mcpConfig]
        : []
    let bridgedHash: string | null = null
    let allEnabledServerNames: string[] = []
    if (this.config.bridgeOpencodeMcp !== false) {
      const bridged = bridgeOpencodeMcp(cwd, runtimeStatus, excludeServers)
      if (bridged) {
        if (bridged.path) paths.push(bridged.path)
        bridgedHash = bridged.hash
        allEnabledServerNames = bridged.allEnabledServerNames
      }
    }
    if (proxyConfigPath) paths.push(proxyConfigPath)
    return { paths, bridgedHash, allEnabledServerNames }
  }

  /** Resolve ProxyToolDef[] for the configured proxyTools names. */
  private resolvedProxyTools(): ProxyToolDef[] | null {
    const names = this.config.proxyTools
    if (!names || names.length === 0) return null
    const defsByName = new Map(
      DEFAULT_PROXY_TOOLS.map((t) => [t.name.toLowerCase(), t]),
    )
    const picked: ProxyToolDef[] = []
    const seen = new Set<string>()
    const unknown: string[] = []
    const pick = (def: ProxyToolDef) => {
      if (seen.has(def.name)) return
      seen.add(def.name)
      picked.push(def)
    }
    for (const n of names) {
      const def = defsByName.get(String(n).toLowerCase())
      if (!def) {
        unknown.push(String(n))
        continue
      }
      pick(def)
      // `task_batch` rides along with `task`: it is the same dispatch path for
      // two or more subagents at once (TASK_BATCH_PROXY_NOTE), and a
      // `proxyTools` list that names `Task` should not have to know it exists.
      if (def.name === "task") {
        const batch = defsByName.get(TASK_BATCH_TOOL_NAME)
        if (batch) pick(batch)
      }
    }
    // A typo used to vanish here. Silence is the wrong response: unknown
    // names are not proxied, so the matching Claude built-in stays enabled
    // and unmediated, and if *every* name is unknown the whole turn runs
    // with no proxy at all (issue #26).
    if (unknown.length > 0) {
      const known = [...defsByName.keys()].join(", ")
      if (picked.length === 0) {
        log.warn(
          "no proxyTools entry was recognised; nothing will be proxied this turn",
          { unknown, known },
        )
      } else {
        log.warn("ignoring unknown proxyTools entries", { unknown, known })
      }
    }
    return picked.length > 0 ? picked : null
  }

  /**
   * Resolve ProxyToolDef[] for opencode's MCP-backed tools so they go
   * through the in-process proxy instead of being bridged into Claude CLI's
   * `--mcp-config`. Routing through the proxy keeps a single execution site
   * (opencode), so the call is permission-prompted and rendered as an
   * opencode tool call.
   *
   * Opt-in (`proxyOpencodeMcpTools: true`) and off by default. It used to
   * default to true while finding nothing, because it discovered tools via
   * `client.tool.list()`, which enumerates opencode's `ToolRegistry` and not
   * the MCP tools merged into the model's tool set afterwards. Discovery now
   * reads that merged set, the `tools` array opencode passes `doStream`, so
   * the option does what it says. Turning it on by default at the same time
   * would have silently moved every existing user's MCP traffic off the
   * working direct bridge, so the default went to false instead: today's
   * behaviour is preserved exactly and crossing over is the operator's call.
   *
   * Returns null when the feature is off or nothing matched, which leaves
   * every server on the direct bridge.
   */
  private resolvedProxyMcpTools(
    allEnabledServerNames: string[],
    modelTools: readonly ModelToolEntry[] | undefined,
    taken?: ReadonlySet<string>,
  ): McpProxyToolResolution | null {
    if (this.config.proxyOpencodeMcpTools !== true) return null
    if (this.config.bridgeOpencodeMcp === false) return null
    if (allEnabledServerNames.length === 0) return null

    const resolution = resolveMcpProxyToolDefs({
      serverNames: allEnabledServerNames,
      tools: modelTools,
      taken,
    })
    if (resolution.defs.length === 0) {
      // WARN, not NOTICE: only warn and error are alwaysStderr in
      // src/logger.ts, so a NOTICE would be invisible to the very operator
      // who opted in and is entitled to know their MCP calls are still
      // going direct, and so still are not permission-prompted by opencode.
      log.warn(
        "proxyOpencodeMcpTools is on but no MCP tool was found in opencode's" +
          " tool set; those servers stay on the direct bridge this spawn",
        { servers: allEnabledServerNames, modelTools: modelTools?.length ?? 0 },
      )
      return null
    }
    log.debug("routing opencode MCP tools through the proxy", {
      servers: [...resolution.coveredServers],
      tools: resolution.defs.map((def) => def.name),
    })
    return resolution
  }

  /**
   * Live tool info derived from a single `client.tool.list()` fetch:
   *
   * - `taskDescription`: opencode's `task` tool description exactly as the
   *   registry renders it for native models, including the "Available
   *   agent types" list. Overlaid onto the static `task` proxy def so
   *   Claude sees the same subagent catalog native models see, instead
   *   of hunting through config files.
   * - `questionDescription` / `hasQuestion`: opencode's `question` tool
   *   description and whether the registry has the entry at all. Older
   *   builds lack it, in which case a `mcp__opencode_proxy__question`
   *   call resolves to `⚙ invalid`; the version gate drops the def.
   *
   * Returns undefined/false when the SDK client is unavailable (direct
   * AI-SDK use, tests) so the static defs stand. `resolved` distinguishes
   * "the registry answered and has no `question` entry" from "nobody
   * answered": only the former is a real version-gate signal.
   */
  private async fetchLiveToolInfo(): Promise<LiveToolInfo> {
    const items = await fetchOpencodeToolList(
      this.config.provider,
      this.modelId,
      this.config.cwd,
    )
    const question = items?.find((item) => item.id === "question")
    return {
      resolved: items !== undefined,
      taskDescription: items?.find((item) => item.id === "task")?.description,
      questionDescription: question?.description,
      hasQuestion: !!question,
      items,
    }
  }

  /**
   * Whether dcp-style context reminders should be stripped from this turn's
   * messages. Config-only and synchronous, so it can be answered before the
   * spawn block resolves anything: `userMsg` is built well ahead of it.
   */
  private stripContextRemindersEnabled(): boolean {
    return shouldStripContextReminders({
      enabled: this.config.stripContextReminders,
      proxyTools: this.config.proxyTools,
      proxyOpencodeTools: this.config.proxyOpencodeTools,
    })
  }

  /** Share one lazy registry request within a turn without making it stale. */
  private createLiveToolInfoLoader(): () => Promise<LiveToolInfo> {
    let pending: Promise<LiveToolInfo> | undefined
    return () => {
      pending ??= this.fetchLiveToolInfo()
      return pending
    }
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
    if (compactionMode || this.config.planModeQuestion !== true) return false
    const info = await loadLiveToolInfo()
    const active = isPlanModeQuestionActive({
      configured: this.config.planModeQuestion,
      opencodeHasQuestion: info.hasQuestion,
      compactionMode,
    })
    if (!active) {
      // Same reasoning as the question proxy's version-gate log: a silent
      // fallback to the text path looks from the outside like the setting
      // was ignored.
      log.info("plan-mode question gate", {
        opencodeHasQuestion: info.hasQuestion,
        registryResolved: info.resolved,
        active,
      })
    }
    return active
  }

  /**
   * Create a proxy MCP server for a single active Claude process/session.
   * The process lifecycle owns the server lifecycle via session-manager.
   */
  private async ensureProxyServer(
    tools: ProxyToolDef[],
    sessionKeyForCalls: string,
    // Whether the `compress` in `tools` is the PLUGIN's def rather than
    // opencode's forwarded one. Keying the interceptor on the name alone
    // would answer a forwarded `compress` in-process and opencode would
    // never see the call: the same name, the wrong tool, silently. The
    // caller knows which list the def came from, so it decides.
    interceptCompress: boolean,
  ): Promise<ProxyMcpServer> {
    const timeoutOverrides = this.config.proxyToolTimeoutMs
    const interceptors = new Map<string, ProxyToolInterceptor>()
    if (interceptCompress && tools.some((t) => t.name === "compress")) {
      interceptors.set("compress", (input) => {
        const summary = typeof input.summary === "string" ? input.summary.trim() : ""
        if (!summary) {
          return {
            kind: "error",
            message:
              "compress needs a non-empty `summary`: it becomes the only" +
              " prior context after the reset. Nothing was compressed.",
          }
        }
        storeCompressionSummary(sessionKeyForCalls, summary)
        log.info("compress stored summary; session resets next turn", {
          sessionKey: sessionKeyForCalls,
          summaryLength: summary.length,
        })
        return {
          kind: "text",
          text:
            "Summary stored. Finish this turn as normal; the next turn starts" +
            " a fresh Claude Code session with this summary as its only prior" +
            " context.",
        }
      })
    }
    const srv = await createProxyMcpServer(tools, timeoutOverrides, interceptors)
    srv.calls.on("call", (call: ProxyToolCall) => {
      queuePendingProxyCall(sessionKeyForCalls, call, timeoutOverrides)
    })
    return srv
  }

  private extractPendingProxyResult(
    prompt: LanguageModelV3CallOptions["prompt"],
    toolCallId: string,
  ): ProxyToolResult | null {
    for (let i = prompt.length - 1; i >= 0; i--) {
      const msg = prompt[i]
      if (msg.role !== "tool" || !Array.isArray(msg.content)) continue

      for (const part of msg.content) {
        if (part.type !== "tool-result" || part.toolCallId !== toolCallId) continue

        const output = part.output as any
        if (!output || typeof output !== "object") {
          return {
            kind: "text",
            text: String(output ?? ""),
          }
        }

        if (output.type === "text") {
          return {
            kind: "text",
            text: String(output.value ?? ""),
          }
        }

        if (output.type === "json") {
          return {
            kind: "text",
            text: JSON.stringify(output.value),
          }
        }

        if (output.type === "content" && Array.isArray(output.value)) {
          const text = output.value
            .filter((v: any) => v?.type === "text" && typeof v.text === "string")
            .map((v: any) => v.text)
            .join("\n")
          return {
            kind: "text",
            text,
          }
        }

        return {
          kind: "text",
          text: JSON.stringify(output),
        }
      }
    }

    return null
  }

  /**
   * The result opencode produced for a pending proxy call, if the prompt
   * carries it. For `task_batch` that means every child's result gathered
   * back onto the parent: opencode runs the children in one step and hands
   * all their results to the next call together, so a partial set is not
   * expected. If it ever happens the batch still resolves, with the gap
   * named in the text, because leaving the parent pending would send this
   * turn down the fresh-envelope path and reject the call as orphaned.
   */
  private extractPendingProxyResultForCall(
    prompt: LanguageModelV3CallOptions["prompt"],
    call: PendingProxyCall,
  ): ProxyToolResult | null {
    if (call.toolName !== TASK_BATCH_TOOL_NAME) {
      return this.extractPendingProxyResult(prompt, call.toolCallId)
    }
    const tasks = taskBatchTasks(call.input)
    if (tasks.length === 0) {
      return { kind: "error", message: "task_batch input is not a list of task objects" }
    }
    const children = tasks.map((task, index) => ({
      task,
      result: this.extractPendingProxyResult(
        prompt,
        taskBatchChildToolCallId(call.toolCallId, index),
      ),
    }))
    const answered = children.filter((child) => child.result !== null).length
    if (answered === 0) return null
    if (answered < children.length) {
      log.warn("task_batch resolving with child results missing", {
        toolCallId: call.toolCallId,
        answered,
        total: children.length,
      })
    }
    return formatTaskBatchResults(children)
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
    const configured = this.config.controlRequestToolBehaviors
    if (configured && toolName) {
      const direct = configured[toolName] ?? configured[toolName.toLowerCase()]
      if (direct === "allow" || direct === "deny") return direct

      const lower = toolName.toLowerCase()
      for (const [key, behavior] of Object.entries(configured)) {
        if (key.toLowerCase() === lower && (behavior === "allow" || behavior === "deny")) {
          return behavior
        }
      }
    }

    // AskUserQuestion must never be auto-allowed. Allowing it lets the
    // Claude CLI resolve its own question internally — in headless mode
    // there is no TTY, so the CLI fabricates/empties the answer and the
    // model proceeds on a guess. Deny so the CLI cannot self-answer; the
    // tool_use is still streamed and rendered to the opencode user by
    // formatAskUserQuestion, and the turn stops for a real reply. An
    // explicit controlRequestToolBehaviors entry above can still override.
    if (isAskUserQuestionTool(toolName)) return "deny"

    return this.config.controlRequestBehavior ?? "allow"
  }

  private writeControlResponse(
    proc: import("child_process").ChildProcess,
    requestId: string,
    response?: Record<string, unknown>,
  ): void {
    const payload = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response,
      },
    }

    try {
      proc.stdin?.write(JSON.stringify(payload) + "\n")
    } catch (error) {
      log.warn("failed to write control response", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Handle Claude stream-json control requests (`can_use_tool`, etc.) and
   * respond via stdin with a matching `control_response`.
   */
  private handleControlRequest(
    msg: ClaudeStreamMessage,
    proc: import("child_process").ChildProcess,
  ): boolean {
    if (msg.type !== "control_request") return false
    const requestId = msg.request_id
    const request = msg.request
    if (!requestId || !request?.subtype) return false

    if (request.subtype === "can_use_tool") {
      const toolName = request.tool_name ?? "unknown"
      const behavior = this.controlRequestBehaviorForTool(toolName)

      if (behavior === "allow") {
        this.writeControlResponse(proc, requestId, {
          behavior: "allow",
          updatedInput: request.input ?? {},
          toolUseID: request.tool_use_id,
        })
        log.info("control request auto-allowed", {
          requestId,
          toolName,
        })
      } else {
        const denyMessage = denyMessageForTool(
          toolName,
          this.config.controlRequestDenyMessage,
        )
        this.writeControlResponse(proc, requestId, {
          behavior: "deny",
          message: denyMessage,
          toolUseID: request.tool_use_id,
        })
        log.info("control request auto-denied", {
          requestId,
          toolName,
        })
      }

      return true
    }

    // For control request subtypes we don't actively handle yet, acknowledge
    // with an empty success so the CLI stream does not stall.
    this.writeControlResponse(proc, requestId, {})
    log.debug("control request acknowledged", {
      requestId,
      subtype: request.subtype,
    })
    return true
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

  private getOpencodeAgent(
    providerOptions?: LanguageModelV3CallOptions["providerOptions"],
  ): string | undefined {
    if (!providerOptions) return undefined
    const ownKey = this.config.provider
    const bag =
      (providerOptions as any)[ownKey] ??
      (providerOptions as any)["claude-code"]
    const agent = bag?.opencodeAgent
    return typeof agent === "string" ? agent : undefined
  }

  private isCompactionCall(
    options: LanguageModelV3CallOptions,
  ): boolean {
    return this.getOpencodeAgent(options.providerOptions) === "compaction"
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
    for (let i = prompt.length - 1; i >= 0; i--) {
      const msg = prompt[i]
      if (msg.role !== "user") continue

      if (typeof msg.content === "string") {
        return String(msg.content).trim()
      }

      if (Array.isArray(msg.content)) {
        const text = (msg.content as any[])
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part: any) => String(part.text).trim())
          .filter(Boolean)
          .join(" ")
        if (text) return text
      }
    }

    return ""
  }

  private synthesizeTitle(
    prompt: LanguageModelV3CallOptions["prompt"],
  ): string {
    const source = this.latestUserText(prompt)
      .replace(/\s+/g, " ")
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .trim()

    if (!source) return "New Session"

    const stop = new Set([
      "a",
      "an",
      "the",
      "and",
      "or",
      "but",
      "to",
      "for",
      "of",
      "in",
      "on",
      "at",
      "with",
      "can",
      "could",
      "would",
      "should",
      "please",
      "hi",
      "hello",
      "hey",
      "there",
      "you",
      "your",
      "this",
      "that",
      "is",
      "are",
      "was",
      "were",
      "be",
      "do",
      "does",
      "did",
      "summarize",
      "summary",
      "project",
    ])

    const words = source
      .split(" ")
      .map((word) => word.trim())
      .filter(Boolean)
      .filter((word) => !stop.has(word.toLowerCase()))

    const picked = (words.length > 0 ? words : source.split(" ").filter(Boolean))
      .slice(0, 6)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")

    return picked || "New Session"
  }

  private async doGenerateViaStream(
    options: LanguageModelV3CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV3["doGenerate"]>>> {
    const result = await this.doStream(options)
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

    return {
      content,
      finishReason,
      usage,
      request: result.request,
      response: {
        id: generateId(),
        timestamp: new Date(),
        modelId: this.modelId,
      },
      providerMetadata,
      warnings: [],
    }
  }

  async doGenerate(
    options: LanguageModelV3CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV3["doGenerate"]>>> {
    if (!this.isCompactionCall(options) && this.requestScope(options as any) !== "no-tools" && parseSideQuestion(options.prompt)) {
      return this.doGenerateViaStream(options)
    }
    const warnings: SharedV3Warning[] = []
    const scope = this.requestScope(options as any)
    const affinity = this.sessionAffinity(options)
    const cwd = await resolveSpawnCwdForSession(this.config.cwd, affinity)
    // An agent may run on a different model than the one opencode routed here
    // (see agent-models.ts). The session key must carry the effective model or
    // an overridden agent shares a claude process with its caller.
    const effectiveModelId = resolveAgentModel(
      this.getOpencodeAgent(options.providerOptions),
      this.modelId,
    )
    const reasoningEffort = resolveAgentEffort(
      this.getOpencodeAgent(options.providerOptions),
      this.getReasoningEffort(options.providerOptions),
    ) as ReasoningEffort | undefined
    // Keep effort invalidation inside one agent/provider, even when callers
    // share a model and opencode session (for example switching agents).
    const baseKey = sessionKey(
      cwd,
      `${effectiveModelId}::${scope}::${affinity}::context=${JSON.stringify([this.config.provider, this.getOpencodeAgent(options.providerOptions) ?? null])}`,
    )
    const sk = effortSessionKey(baseKey, reasoningEffort)

    // When selective proxying is enabled, doGenerate must not bypass the
    // proxy path. Reuse doStream and aggregate its events so proxied tools
    // still route through opencode permissions/execution. Same for
    // opencode MCP proxying — doStream is the only path that wires up the
    // proxy server with the dynamically-discovered MCP tool defs.
    const compactionMode = this.isCompactionCall(options)

    if (
      scope === "tools" &&
      (this.resolvedProxyTools() ||
        (this.config.proxyOpencodeMcpTools === true &&
          this.config.bridgeOpencodeMcp !== false))
    ) {
      return this.doGenerateViaStream(options)
    }

    // Route compaction through doStream so it gets the lean spawn path,
    // model override, and rich transcript handling. Aggregating a stream
    // for doGenerate matches what doGenerateViaStream already does for
    // proxy tools.
    if (compactionMode) {
      return this.doGenerateViaStream(options)
    }

    if (scope === "no-tools") {
      log.info("doGenerate no-tools title stub", {
        compactionMode,
        opencodeAgent: this.getOpencodeAgent(options.providerOptions),
        providerOptionsKeys: options.providerOptions
          ? Object.keys(options.providerOptions)
          : [],
      })
      const text = this.synthesizeTitle(options.prompt)
      return {
        content: [{ type: "text", text }] as any,
        finishReason: this.toFinishReason("stop"),
        usage: this.toUsage({ input_tokens: 0, output_tokens: 0 }),
        request: { body: { text: "" } },
        response: {
          id: generateId(),
          timestamp: new Date(),
          modelId: this.modelId,
        },
        providerMetadata: {
          "claude-code": {
            synthetic: true,
            path: "no-tools",
          },
        },
        warnings,
      }
    }

    // Short-circuit when opencode iterates the agent loop one more time
    // after a turn already finished. The prompt ends with an assistant
    // message and has no fresh user input — spawning Claude here would
    // just produce a stub like "No input received. Standing by".
    if (!hasNewUserContent(options.prompt)) {
      log.info("doGenerate short-circuit: no new user content")
      return {
        content: [],
        finishReason: this.toFinishReason("stop"),
        usage: this.toUsage({ input_tokens: 0, output_tokens: 0 }),
        request: { body: { text: "" } },
        response: {
          id: generateId(),
          timestamp: new Date(),
          modelId: this.modelId,
        },
        providerMetadata: {
          "claude-code": { synthetic: true, path: "no-new-user-content" },
        },
        warnings,
      }
    }

    invalidateOtherEffortSessions(baseKey, reasoningEffort)

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

    const hasExistingSession = !!getClaudeSessionId(sk)
    const includeHistoryContext = !hasExistingSession && hasPriorConversation

    const userMsg =
      consumeExitPlanModeQuestionResult(sk, options.prompt as any) ??
      // doGenerate has no proxy wiring, so this process issued no tool calls
      // at all: every tool result reaching it belongs to opencode and must be
      // rendered as text rather than an orphaned `tool_result` (issue #29).
      getClaudeUserMessage(options.prompt, includeHistoryContext, {
        cliToolCallIds: new Set<string>(),
        stripContextReminders: this.stripContextRemindersEnabled(),
      })

    // The same account override doStream applies, with no dialog of its own:
    // a title or no-tools call must not ask anything, but it must follow the
    // account the conversation was moved to, or it bills the limited one.
    const failover = await resolveFailoverSpawn({
      account: this.config.account ?? DEFAULT_ACCOUNT,
      baseCliPath: this.config.baseCliPath ?? this.config.cliPath,
      cliPath: this.config.cliPath,
      modelId: effectiveModelId,
    })
    const cliPath = failover.cliPath

    // doGenerate always spawns a fresh process, never reuse session ID.
    // Pre-fetch opencode's MCP runtime status so the bridge overlays
    // UI-toggled state on top of disk config.
    const [runtimeStatus, cliVersion, planModeQuestionActive] = await Promise.all([
      getRuntimeMcpStatus(),
      detectCliVersion(cliPath),
      this.resolvePlanModeQuestion(compactionMode),
    ])
    const systemPromptFile = buildAppendedSystemPrompt(
      cwd,
      this.config.multiStepContinuation !== false,
      extractSystemMessages(options.prompt),
      // doGenerate has no proxy wiring, so `compress` is not callable here.
      // An existing summary still carries: it is this key's prior context.
      { compressEnabled: false, compressionSummary: getCompressionSummary(sk) },
    )
    const { model: spawnModelId, fast: fastMode } = parseModelId(failover.modelId)
    // The same skill bridge as doStream's spawn: Claude's Skill tool is the
    // only way a Claude-routed turn can load an opencode skill, on this path
    // as much as on the streaming one.
    const skillPluginDirs = await resolveSkillPluginDirs({
      cwd,
      cliPath,
      enabled: this.config.bridgeOpencodeSkills === true,
    })
    const cliArgs = buildCliArgs({
      sessionKey: sk,
      skipPermissions: this.config.skipPermissions !== false,
      includeSessionId: false,
      model: spawnModelId,
      permissionMode: this.config.permissionMode,
      mcpConfig: this.effectiveMcpConfig(cwd, undefined, runtimeStatus).paths,
      strictMcpConfig: this.config.strictMcpConfig,
      disallowedTools:
        this.config.webSearch === "disabled" ? ["WebSearch"] : undefined,
      appendSystemPromptFile: systemPromptFile,
      pluginDirs: skillPluginDirs,
      ...this.thinkingCliOptions(),
      fastMode,
      cliVersion,
    })

    log.info("doGenerate starting", {
      cwd,
      model: effectiveModelId,
      requestedModel: this.modelId,
      textLength: userMsg.length,
      includeHistoryContext,
    })

    const { spawn } = await import("node:child_process")
    const { createInterface } = await import("node:readline")

    const proc = spawn(cliPath, cliArgs, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: claudeSpawnEnv({
        ignoreAnthropicApiKey: this.config.ignoreAnthropicApiKey,
        effort: reasoningEffort,
      }),
      shell: process.platform === "win32",
    })

    if (systemPromptFile) {
      proc.on("exit", () => {
        void unlink(systemPromptFile).catch(() => {})
      })
    }

    const rl = createInterface({ input: proc.stdout! })

    let responseText = ""
    let thinkingText = ""
    let resultMeta: {
      sessionId?: string
      costUsd?: number
      durationMs?: number
      durationApiMs?: number
      numTurns?: number
      usage?: ClaudeStreamMessage["usage"]
      modelUsage?: ClaudeStreamMessage["modelUsage"]
      permissionDenials?: ClaudeStreamMessage["permission_denials"]
    } = {}
    const toolCalls: Array<{ id: string; name: string; args: unknown }> = []
    // Streaming tool_use entries keyed by content-block index. We accumulate
    // partial_json chunks here instead of trying to JSON.parse each chunk
    // independently, and flush to `toolCalls` at content_block_stop. The
    // previous code indexed `toolCalls` by `msg.index` directly, which is
    // wrong whenever non-tool blocks (text, thinking) precede a tool_use.
    const toolCallStreams = new Map<
      number,
      { id: string; name: string; inputJson: string }
    >()

    // Set true once we observe a `stream_event` envelope. When on, the
    // top-level `assistant` message is a duplicate of content already
    // accumulated via the inner content_block_* events — skip it.
    let gotPartialEvents = false

    const result = await new Promise<
      typeof resultMeta & {
        text: string
        thinking: string
        toolCalls: typeof toolCalls
      }
    >((resolve, reject) => {
      const cleanup = () => {
        try {
          if (!proc.killed && proc.exitCode === null) proc.kill()
        } catch {}
      }

      rl.on("line", (line) => {
        if (!line.trim()) return
        try {
          const outer: ClaudeStreamMessage = JSON.parse(line)

          // Unwrap stream_event envelope (--include-partial-messages).
          // Inner event uses the same content_block_* / message_* shape.
          const msg: ClaudeStreamMessage =
            outer.type === "stream_event" && outer.event
              ? { ...outer.event, session_id: outer.session_id }
              : outer

          if (outer.type === "stream_event") {
            gotPartialEvents = true
          }

          if (this.handleControlRequest(msg, proc)) {
            return
          }

          if (msg.type === "system" && msg.subtype === "init") {
            if (msg.session_id) {
              setClaudeSessionId(sk, msg.session_id)
            }
            reportFastModeState(msg, fastMode)
            reportSystemInit(msg, {
              ignoreAnthropicApiKey: this.config.ignoreAnthropicApiKey,
            })
          }

          if (msg.type === "rate_limit_event") {
            reportRateLimitEvent(msg)
            return
          }

          if (
            msg.type === "assistant" &&
            msg.message?.content &&
            !gotPartialEvents
          ) {
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text) {
                responseText += block.text
              }
              if (block.type === "thinking" && block.thinking) {
                thinkingText += block.thinking
              }
              if (block.type === "tool_use" && block.id && block.name) {
                if (isAskUserQuestionTool(block.name)) {
                  // Render the full question + options as visible text so
                  // the user can actually see and answer it.
                  const parsedInput = (block.input ?? {}) as Record<
                    string,
                    unknown
                  >
                  responseText += formatAskUserQuestion(parsedInput)
                  continue
                }

                if (block.name === "ExitPlanMode") {
                  const parsedInput = (block.input ?? {}) as Record<
                    string,
                    unknown
                  >
                  const plan = (parsedInput?.plan as string) || ""
                  if (planModeQuestionActive) {
                    const questionCall = createExitPlanModeQuestionCall(
                      sk,
                      block.id,
                      plan,
                    )
                    responseText += questionCall.text
                    toolCalls.push({
                      id: questionCall.toolCallId,
                      name: questionCall.toolName,
                      args: questionCall.input,
                    })
                    continue
                  }
                  responseText += `\n\n${plan}\n\n---\n**Do you want to proceed with this plan?** (yes/no)\n`
                  continue
                }

                toolCalls.push({
                  id: block.id,
                  name: block.name,
                  args: block.input ?? {},
                })
              }
            }
          }

          if (
            msg.type === "content_block_start" &&
            msg.content_block &&
            msg.index !== undefined
          ) {
            if (
              msg.content_block.type === "tool_use" &&
              msg.content_block.id &&
              msg.content_block.name
            ) {
              toolCallStreams.set(msg.index, {
                id: msg.content_block.id,
                name: msg.content_block.name,
                inputJson: "",
              })
            }
          }

          if (
            msg.type === "content_block_delta" &&
            msg.delta &&
            msg.index !== undefined
          ) {
            if (msg.delta.type === "text_delta" && msg.delta.text) {
              responseText += msg.delta.text
            }
            if (msg.delta.type === "thinking_delta" && msg.delta.thinking) {
              thinkingText += msg.delta.thinking
            }
            if (
              msg.delta.type === "input_json_delta" &&
              msg.delta.partial_json
            ) {
              const tc = toolCallStreams.get(msg.index)
              if (tc) tc.inputJson += msg.delta.partial_json
            }
          }

          if (msg.type === "content_block_stop" && msg.index !== undefined) {
            const tc = toolCallStreams.get(msg.index)
            if (tc) {
              let args: unknown = {}
              try {
                args = tc.inputJson ? JSON.parse(tc.inputJson) : {}
              } catch (err) {
                log.warn("tool input JSON parse failed", {
                  name: tc.name,
                  error: String(err),
                })
              }
              if (tc.name === "ExitPlanMode" && planModeQuestionActive) {
                const parsedInput = args as Record<string, unknown>
                const plan = (parsedInput?.plan as string) || ""
                const questionCall = createExitPlanModeQuestionCall(sk, tc.id, plan)
                responseText += questionCall.text
                toolCalls.push({
                  id: questionCall.toolCallId,
                  name: questionCall.toolName,
                  args: questionCall.input,
                })
              } else {
                toolCalls.push({ id: tc.id, name: tc.name, args })
              }
              toolCallStreams.delete(msg.index)
            }
          }

          if (msg.type === "result") {
            if (msg.session_id) {
              setClaudeSessionId(sk, msg.session_id)
            }

            // Some CLI failures only surface user-readable text on the final
            // `result` message (without prior assistant text blocks). Preserve
            // that so callers don't receive an empty response.
            if (
              !responseText &&
              msg.is_error &&
              typeof msg.result === "string" &&
              msg.result.trim().length > 0
            ) {
              responseText = msg.result
            }

            resultMeta = {
              sessionId: msg.session_id,
              costUsd: msg.total_cost_usd,
              durationMs: msg.duration_ms,
              durationApiMs: msg.duration_api_ms,
              numTurns: msg.num_turns,
              usage: msg.usage,
              modelUsage: msg.modelUsage,
              permissionDenials: msg.permission_denials?.map((denial) => ({
                tool_name: denial.tool_name,
                tool_use_id: denial.tool_use_id,
              })),
            }
            log.info("conversation result", {
              sessionId: msg.session_id,
              isError: msg.is_error,
              subtype: msg.subtype,
              ...turnStatsLogPayload(extractTurnStats(msg)),
            })
            cleanup()
            resolve({
              ...resultMeta,
              text: responseText,
              thinking: thinkingText,
              toolCalls,
            })
          }
        } catch {
          // Ignore non-JSON lines
        }
      })

      rl.on("close", () => {
        cleanup()
        resolve({
          ...resultMeta,
          text: responseText,
          thinking: thinkingText,
          toolCalls,
        })
      })

      proc.on("error", (err) => {
        log.error("process error", { error: err.message })
        cleanup()
        reject(err)
      })

      proc.stderr?.on("data", (data: Buffer) => {
        log.debug("stderr", { data: data.toString().slice(0, 200) })
      })

      proc.stdin?.write(userMsg + "\n")
    })

    const content: LanguageModelV3Content[] = []

    if (result.thinking) {
      content.push({
        type: "reasoning",
        text: result.thinking,
      } as any)
    }

    if (result.text) {
      content.push({
        type: "text",
        text: result.text,
        providerMetadata: {
          "claude-code": {
            sessionId: result.sessionId ?? null,
            costUsd: result.costUsd ?? null,
            durationMs: result.durationMs ?? null,
          },
          ...(typeof result.usage?.cache_creation_input_tokens === "number"
            ? {
                anthropic: {
                  cacheCreationInputTokens:
                    result.usage.cache_creation_input_tokens,
                },
              }
            : {}),
        },
      })
    }

    for (const tc of result.toolCalls) {
      if (tc.name === QUESTION_TOOL_NAME) {
        content.push({
          type: "tool-call",
          toolCallId: tc.id,
          toolName: tc.name,
          input: JSON.stringify(tc.args),
          providerExecuted: false,
        } as any)
        continue
      }

      const {
        name: mappedName,
        input: mappedInput,
        executed,
        skip,
      } = mapTool(tc.name, tc.args, {
        webSearch: this.config.webSearch,
        sessionId: getClaudeSessionId(sk),
        toolUseId: tc.id,
      })
      if (skip) continue
      content.push({
        type: "tool-call",
        toolCallId: tc.id,
        toolName: mappedName,
        input: JSON.stringify(mappedInput),
        providerExecuted: executed,
      } as any)
    }

    const usage = this.toUsage(result.usage)

    return {
      content,
      // Claude CLI's `result` message normally signals a fully-completed turn:
      // tools have already been executed internally and final assistant text
      // has been produced. ExitPlanMode is the exception: we surface it as
      // opencode's native question tool so the outer loop must run that tool.
      finishReason: this.toFinishReason(
        result.toolCalls.some((tc) => tc.name === QUESTION_TOOL_NAME)
          ? "tool-calls"
          : "stop",
      ),
      usage,
      request: { body: { text: userMsg } },
      response: {
        id: result.sessionId ?? generateId(),
        timestamp: new Date(),
        modelId: this.modelId,
      },
      providerMetadata: {
        "claude-code": {
          sessionId: result.sessionId ?? null,
          costUsd: result.costUsd ?? null,
          durationMs: result.durationMs ?? null,
        },
        ...(typeof result.usage?.cache_creation_input_tokens === "number"
          ? {
              anthropic: {
                cacheCreationInputTokens:
                  result.usage.cache_creation_input_tokens,
              },
            }
          : {}),
      },
      warnings,
    }
  }

  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV3["doStream"]>>> {
    const warnings: SharedV3Warning[] = []
    const skipPermissions = this.config.skipPermissions !== false
    const scope = this.requestScope(options as any)
    const affinity = this.sessionAffinity(options)
    const cwd = await resolveSpawnCwdForSession(this.config.cwd, affinity)
    const compactionMode = this.isCompactionCall(options)
    // Use a separate session key for compaction so its short-lived spawn
    // never collides with the main conversation's claude process.
    const effectiveModelId = compactionMode
      ? this.resolveCompactionModel()
      : resolveAgentModel(
          this.getOpencodeAgent(options.providerOptions),
          this.modelId,
        )
    // Compaction skips request/agent effort overrides; other calls key on it.
    const reasoningEffort = compactionMode
      ? undefined
      : (resolveAgentEffort(
          this.getOpencodeAgent(options.providerOptions),
          this.getReasoningEffort(options.providerOptions),
        ) as ReasoningEffort | undefined)
    const baseKey = sessionKey(
      cwd,
      `${effectiveModelId}::${scope}::${affinity}::context=${JSON.stringify([this.config.provider, this.getOpencodeAgent(options.providerOptions) ?? null])}`,
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

    if (scope === "no-tools" && !compactionMode) {
      log.info("doStream no-tools title stub", {
        compactionMode,
        opencodeAgent: this.getOpencodeAgent(options.providerOptions),
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
    const failoverAnswer =
      compactionMode || useInteractive
        ? null
        : consumeAccountFailoverAnswer(sk, options.prompt as any)

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
      result: this.extractPendingProxyResultForCall(options.prompt, call),
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
      opencodeAgent: this.getOpencodeAgent(options.providerOptions),
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

        let activeProcess = getActiveProcess(sk)
        let proc: import("child_process").ChildProcess
        let lineEmitter: import("events").EventEmitter
        let cliArgs: string[]
        let proxyServer: ProxyMcpServer | null = activeProcess?.proxyServer ?? null

        const setup = async () => {
          // Wait for the old owner to exit before resuming its session ID in
          // the replacement, so two processes never append to one transcript.
          if (
            !compactionMode &&
            activeProcess &&
            self.config.hotReloadMcp !== false &&
            self.config.bridgeOpencodeMcp !== false
          ) {
            const probe = self.effectiveMcpConfig(cwd, undefined, runtimeStatus!)
            const previousHash = activeProcess.mcpHash ?? null
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
                activeProcess = undefined
                proxyServer = null
              }
            }
          }

          if (useInteractive && !compactionMode) {
            // Interactive Bun-ConPTY transport. Reuse the live session if one
            // exists for this key; else spawn a new interactive claude. The
            // wrapper conforms to ActiveProcess, so reuse/eviction/hot-reload
            // and the whole emission body below work unchanged.
            const mcp = self.effectiveMcpConfig(cwd, undefined, runtimeStatus!)
            if (activeProcess) {
              proc = activeProcess.proc
              lineEmitter = activeProcess.lineEmitter
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
              proc = ap.proc
              lineEmitter = ap.lineEmitter
              activeProcess = ap
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
            cliArgs = buildCliArgs({
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

            if (!proxyServer && combinedProxyTools) {
              proxyServer = await self.ensureProxyServer(
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
              proxyServer?.configPath(),
              runtimeStatus!,
              excludeServers,
            )
            const systemPromptFile = activeProcess
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
            })
            cliArgs = buildCliArgs({
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
            spawnProxyServer = proxyServer
            spawnMcpHash = mcp.bridgedHash
          }

          if (activeProcess && !compactionMode) {
            proc = activeProcess.proc
            lineEmitter = activeProcess.lineEmitter
            log.debug("reusing active process", { sk })
          } else {
            const ap = spawnClaudeProcess(
              cliPath,
              cliArgs,
              cwd,
              sk,
              spawnProxyServer,
              spawnMcpHash,
              spawnSystemPromptFile,
              self.config.ignoreAnthropicApiKey,
              reasoningEffort,
            )
            proc = ap.proc
            lineEmitter = ap.lineEmitter
            activeProcess = ap
          }
          }

          // The CLI serves one turn at a time. If the previous one is still
          // running (the user aborted it, or it ended on our inactivity
          // fallback rather than a real `result`), stop it before this turn
          // attaches any listeners; otherwise its tail streams into us and its
          // `result` closes us before our own answer arrives. Skipped for
          // tool-result turns: there the CLI is deliberately parked inside a
          // proxy MCP call waiting for the result we are about to deliver.
          if (activeProcess && !hasMatchedPendingResults && isTurnInFlight(activeProcess)) {
            log.warn("previous turn still in flight; interrupting it", { sk })
            const idle = await interruptTurn(activeProcess)
            if (!idle) {
              log.warn("previous turn did not stop in time; this turn may see stale output", { sk })
            }
          }

          controller.enqueue({ type: "stream-start", warnings })

          let currentTextId: string | null = null
          const textBlockIndices = new Set<number>()

          const startTextBlock = (): string => {
            if (currentTextId) {
              controller.enqueue({ type: "text-end", id: currentTextId })
            }
            const id = generateId()
            currentTextId = id
            controller.enqueue({ type: "text-start", id } as any)
            return id
          }

          const endTextBlock = (): void => {
            if (currentTextId) {
              controller.enqueue({ type: "text-end", id: currentTextId })
              currentTextId = null
            }
          }

          // Its own text part, led by FAILOVER_MARKER, so a later transcript
          // rebuild strips it exactly: it was never Claude's output.
          if (failoverNote) {
            controller.enqueue({
              type: "text-delta",
              id: startTextBlock(),
              delta: failoverNote,
            })
            endTextBlock()
          }

          const reasoningIds = new Map<number, string>()
          const reasoningStarted = new Map<number, boolean>()
          let hadThinkingTextFromStream = false

          let turnCompleted = false
          let controllerClosed = false
          // Buffered terminal results belong to the previous CLI turn.
          let unattendedTurnEnded = false
          let watchdogMessage = userMsg
          let pendingProxyUnsubscribe: (() => void) | null = null
          let asideSinkUnregister: (() => void) | null = null
          let resultFallbackTimer: ReturnType<typeof setTimeout> | null = null
          let pendingResultCompletion: (() => void) | null = null
          let hasReceivedContent = false
          let hasReceivedProgress = false
          let visibleTextSinceContinue = ""
          let lastVisibleTextSinceContinue = ""
          let hadReasoningSinceContinue = false
          let hadToolActivitySinceContinue = false
          let hadProxyActivitySinceContinue = false
          // v0.4.16: protocol-level stop signal captured from Claude CLI's
          // stream. Set by either the `message_delta` partial event or the
          // top-level `assistant` message, whichever arrives first.
          let lastStopReason: string | null = null
          const autoContinueState: AutoContinueState = {
            enabled: autoContinueEnabledFor(
              compactionMode,
              self.config.autoContinueIncompleteTurns,
            ),
            attempts: 0,
            startedAt: Date.now(),
            noProgressCount: 0,
          }

          const clearFallbackTimer = () => {
            if (resultFallbackTimer) {
              clearTimeout(resultFallbackTimer)
              resultFallbackTimer = null
            }
          }

          // Wire-inactivity watchdog. Resets on every line received from the
          // CLI; only fires if the CLI has emitted content and then gone
          // silent on stdout for `delayMs` without sending a `result`. The
          // previous design armed this on every text content_block_stop,
          // which killed legitimate mid-turn think pauses (most visibly
          // with sonnet between text-end and the next tool_use_start).
          const startResultFallback = (delayMs = 60_000) => {
            clearFallbackTimer()
            if ((!hasReceivedContent && !hasReceivedProgress) || controllerClosed) return
            resultFallbackTimer = setTimeout(() => {
              if (controllerClosed) return
              log.warn("result fallback timer fired — closing stream without result event", {
                delayMs,
              })
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
          const START_WATCHDOG_MS = (() => {
            const env = process.env.CLAUDE_CODE_START_WATCHDOG_MS
            const parsed = env ? Number.parseInt(env, 10) : NaN
            return Number.isFinite(parsed) && parsed > 0 ? parsed : 90_000
          })()
          let startWatchdog: ReturnType<typeof setTimeout> | null = null
          let respawnAttempted = false
          const clearStartWatchdog = () => {
            if (startWatchdog) {
              clearTimeout(startWatchdog)
              startWatchdog = null
            }
          }
          const onStartWatchdogFire = () => {
            startWatchdog = null
            if (controllerClosed || hasReceivedContent || hasReceivedProgress) return
            if (respawnAttempted) {
              log.error(
                "claude process still silent after respawn; ending turn",
                { sessionKey: sk },
              )
              deleteActiveProcess(sk)
              deleteClaudeSessionId(sk)
              controllerClosed = true
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
            respawnAttempted = true
            log.warn(
              "no stdout after envelope write; respawning claude process to resume conversation",
              { sessionKey: sk, startWatchdogMs: START_WATCHDOG_MS },
            )
            lineEmitter.off("line", lineHandler)
            lineEmitter.off("close", closeHandler)
            proc.off("error", procErrorHandler)
            const newAp = respawnActiveProcess(
              sk,
              cliPath,
              cliArgs,
              cwd,
              self.config.ignoreAnthropicApiKey,
            )
            if (!newAp) {
              log.error(
                "no active process to respawn (start watchdog); ending turn",
                { sessionKey: sk },
              )
              controllerClosed = true
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
            proc = newAp.proc
            lineEmitter = newAp.lineEmitter
            activeProcess = newAp
            lineEmitter.on("line", lineHandler)
            lineEmitter.on("close", closeHandler)
            proc.on("error", procErrorHandler)
            try {
              if (!deliverPendingCompletions(true)) {
                noteTurnStarted(newAp)
                proc.stdin?.write(watchdogMessage + "\n")
              }
              log.debug("re-sent user message after respawn", {
                textLength: watchdogMessage.length,
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
            if (controllerClosed) return
            startWatchdog = setTimeout(onStartWatchdogFire, START_WATCHDOG_MS)
          }

          // Both buffered/live terminal boundaries and respawn consume through
          // this path. Open-channel results remain available for a later close.
          const deliverPendingCompletions = (force = false): boolean => {
            const pending = activeProcess?.pendingProxyCompletions
            const entries = [...(pending?.values() ?? [])].filter(
              (entry) => force || entry.recoveryRequired || isPendingProxyCallChannelClosed(entry.call),
            )
            if (entries.length === 0) return false
            endTextBlock()
            watchdogMessage = makeLateProxyResultMessage(entries)
            // This write asks the CLI for work like any fresh envelope, so
            // abort, LRU eviction and the idle timer must see it as busy.
            if (activeProcess) noteTurnStarted(activeProcess)
            proc.stdin!.write(watchdogMessage + "\n")
            for (const { call } of entries) pending!.delete(call.toolCallId)
            log.warn("delivering proxy results after interrupted continuation", {
              sessionKey: sk,
              toolCallIds: entries.map(({ call }) => call.toolCallId),
              respawn: force,
            })
            gotPartialEvents = false
            hasReceivedContent = false
            hasReceivedProgress = false
            turnCompleted = false
            resetAutoContinueWindow()
            clearFallbackTimer()
            armStartWatchdog()
            return true
          }

          const toolCallMap = new Map<
            number,
            { id: string; name: string; inputJson: string; started: boolean }
          >()
          // Tool calls the plugin reported as providerExecuted:false — opencode
          // will run these itself and emit its own tool-result, so we must NOT
          // forward Claude CLI's tool_result for them (would short-circuit
          // opencode's execute).
          const skipResultForIds = new Set<string>()
          const toolCallsById = new Map<
            string,
            { id: string; name: string; input: unknown }
          >()

          let resultMeta: {
            sessionId?: string
            costUsd?: number
            durationMs?: number
            durationApiMs?: number
            numTurns?: number
            usage?: ClaudeStreamMessage["usage"]
            modelUsage?: ClaudeStreamMessage["modelUsage"]
            permissionDenials?: ClaudeStreamMessage["permission_denials"]
          } = {}

          // Subtype of a failing `result`, so the finish below reports the
          // turn as an error instead of a clean stop.
          let resultFailure: string | undefined

          // Set only by a REJECTED rate-limit event or by one of the two
          // known account-limit error texts, never by a generic failure: a
          // transient error must not open a form that moves the billing.
          let accountLimitHit: { resetsAt?: number; window?: string } | null = null

        // Batched drain so claude CLI's parallel tool_use blocks (e.g. two
        // bash calls in one assistant message) end up in a single
        // tool-calls finish event. Without this, the broker would reject
        // every overlapping call and claude would see spurious tool errors.
        const drainBuffer: PendingProxyCall[] = []
        let drainTimer: ReturnType<typeof setTimeout> | null = null
        const DRAIN_QUIET_MS = 100

        const finishWithToolCalls = (calls: PendingProxyCall[]) => {
          if (controllerClosed) return
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
            skipResultForIds.add(toolCallId)
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
              skipResultForIds.add(call.toolCallId)
            } else {
              enqueueToolCall(call.toolCallId, call.toolName, call.input)
            }
            markPendingProxyCallEmitted(call.toolCallId)
          }
          controller.enqueue({
            type: "finish",
            finishReason: toFinishReason("tool-calls"),
            usage: toUsage(resultMeta.usage),
            providerMetadata: {
              "claude-code": resultMeta,
            },
          })
          controllerClosed = true
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
          if (controllerClosed) return
          endTextBlock()
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
            usage: toUsage(resultMeta.usage),
            providerMetadata: {
              "claude-code": resultMeta,
            },
          })
          controllerClosed = true
          cleanupTurn()
          try {
            controller.close()
          } catch {}
        }

        const drainNow = () => {
          if (drainTimer) {
            clearTimeout(drainTimer)
            drainTimer = null
          }
          if (drainBuffer.length === 0) return
          if (controllerClosed) return
          const batch = drainBuffer.splice(0, drainBuffer.length)
          log.info("draining pending proxy calls into stream finish", {
            sessionKey: sk,
            count: batch.length,
            toolCallIds: batch.map((c) => c.toolCallId),
          })
          finishWithToolCalls(batch)
        }

        const settleResultBoundary = () => {
          drainTimer = null
          const completeResult = pendingResultCompletion
          pendingResultCompletion = null
          if (!completeResult || controllerClosed) return
          if (drainBuffer.length > 0) {
            drainNow()
            return
          }
          completeResult()
        }

        const scheduleResultBoundary = (
          completeResult: () => void,
          delayMs: number,
        ) => {
          pendingResultCompletion = completeResult
          if (drainTimer) clearTimeout(drainTimer)
          drainTimer = setTimeout(settleResultBoundary, delayMs)
        }

        const noteResultBoundaryCall = (): boolean => {
          if (!pendingResultCompletion) return false
          if (drainTimer) clearTimeout(drainTimer)
          drainTimer = setTimeout(settleResultBoundary, DRAIN_QUIET_MS)
          return true
        }

        const noteVisibleText = (text: string) => {
          visibleTextSinceContinue += text
          lastVisibleTextSinceContinue += text
        }

        const resetLastVisibleTextBlock = () => {
          lastVisibleTextSinceContinue = ""
        }

        const noteReasoning = () => {
          hadReasoningSinceContinue = true
        }

        const noteToolActivity = () => {
          hadToolActivitySinceContinue = true
        }

        const noteProxyActivity = () => {
          hadProxyActivitySinceContinue = true
        }

        const resetAutoContinueWindow = () => {
          visibleTextSinceContinue = ""
          lastVisibleTextSinceContinue = ""
          hadReasoningSinceContinue = false
          hadToolActivitySinceContinue = false
          hadProxyActivitySinceContinue = false
          lastStopReason = null
        }

        const completeResult = (msg: ClaudeStreamMessage) => {
          if (controllerClosed) return
          // The socket may have closed after the tool-result prompt was matched,
          // or while the result-boundary grace timer was running.
          if (deliverPendingCompletions()) {
            if (drainBuffer.length > 0) drainNow()
            return
          }
          if (drainBuffer.length > 0) {
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

          activeProcess?.pendingProxyCompletions?.clear()

          // This account is out of usage. Rather than finish as an error the
          // operator can only act on by editing config, end the turn on a
          // form listing the other configured accounts. Leaving it unanswered
          // waits and costs nothing; every answer that is not one of those
          // accounts comes back as a `stop` and ends the turn as before.
          if (accountLimitHit && failoverAskActive) {
            const call = createAccountFailoverQuestionCall(sk, {
              sourceAccount,
              candidates: failoverAccounts,
              resetsAt: accountLimitHit.resetsAt,
              window: accountLimitHit.window,
            })
            log.warn(
              `Claude account "${sourceAccount}" is out of usage; asking which account to continue on.`,
              {
                sessionKey: sk,
                candidates: failoverAccounts,
                toolCallId: call.toolCallId,
                resetsAt: accountLimitHit.resetsAt ?? null,
              },
            )
            finishWithQuestionCall(call)
            return
          }

          const autoDecision = shouldAutoContinueIncompleteTurn(
            autoContinueState,
            {
              text: visibleTextSinceContinue,
              lastVisibleText: lastVisibleTextSinceContinue,
              hadReasoning: hadReasoningSinceContinue,
              hadToolActivity: hadToolActivitySinceContinue,
              hadProxyActivity: hadProxyActivitySinceContinue,
              isError: msg.is_error,
              stopReason: lastStopReason,
            },
          )
          if (autoDecision.continue) {
            const signature = continuationSignature({
              text: visibleTextSinceContinue,
              lastVisibleText: lastVisibleTextSinceContinue,
              hadReasoning: hadReasoningSinceContinue,
              hadToolActivity: hadToolActivitySinceContinue,
              hadProxyActivity: hadProxyActivitySinceContinue,
              isError: msg.is_error,
            })
            autoContinueState.noProgressCount =
              signature === autoContinueState.lastSignature
                ? autoContinueState.noProgressCount + 1
                : 0
            autoContinueState.lastSignature = signature
            autoContinueState.attempts++
            log.notice("auto-continuing incomplete claude result", {
              sessionKey: sk,
              reason: autoDecision.reason,
              attempts: autoContinueState.attempts,
              textLength: visibleTextSinceContinue.length,
              lastTextLength: lastVisibleTextSinceContinue.length,
              hadReasoning: hadReasoningSinceContinue,
              hadToolActivity: hadToolActivitySinceContinue,
              hadProxyActivity: hadProxyActivitySinceContinue,
            })
            turnCompleted = false
            resetAutoContinueWindow()
            // The `result` just consumed marked the CLI idle; this puts it back to work.
            if (activeProcess) noteTurnStarted(activeProcess)
            proc.stdin?.write(makeAutoContinueMessage() + "\n")
            return
          }
          log.notice("auto-continuation stopped", {
            sessionKey: sk,
            reason: autoDecision.reason,
            stopReason: lastStopReason,
            attempts: autoContinueState.attempts,
            textLength: visibleTextSinceContinue.length,
            lastTextLength: lastVisibleTextSinceContinue.length,
            hadReasoning: hadReasoningSinceContinue,
            hadToolActivity: hadToolActivitySinceContinue,
            hadProxyActivity: hadProxyActivitySinceContinue,
          })

          for (const [idx, reasoningId] of reasoningIds) {
            if (reasoningStarted.get(idx)) {
              controller.enqueue({
                type: "reasoning-end",
                id: reasoningId,
              } as any)
            }
          }

          controller.enqueue({
            type: "finish",
            finishReason: resultFailure
              ? { unified: "error" as const, raw: resultFailure }
              : toFinishReason("stop"),
            usage: toUsage(msg.usage),
            providerMetadata: {
              "claude-code": {
                ...resultMeta,
                ...(resultFailure ? { resultSubtype: resultFailure } : {}),
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

          controllerClosed = true
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
        let gotPartialEvents = false

        const lineHandler = (line: string) => {
          if (!line.trim()) return
          if (controllerClosed) return

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
              hasReceivedProgress = true
              clearStartWatchdog()
              startResultFallback()
            }

            if (outer.type === "stream_event") {
              gotPartialEvents = true
            }

            if (handleControlRequest(msg, proc)) {
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
                controller.enqueue({ type: "text-delta", id: startTextBlock(), delta: note })
                endTextBlock()
              }
            }

            // A rejection is why the turn is about to fail. Put it in the
            // transcript so the reason does not live only in a log file that
            // is off by default.
            if (msg.type === "rate_limit_event") {
              // Parsed separately from the reporter, which dedupes per
              // process and returns null on a repeat: the second rejection in
              // a session is still a rejection this turn has to act on.
              const info = parseRateLimitEvent(msg)
              if (info && isRateLimitRejected(info)) {
                accountLimitHit = {
                  resetsAt: info.resetsAt ?? info.overageResetsAt,
                  window: info.rateLimitType,
                }
              }
              const note = reportRateLimitEvent(msg)
              if (note) {
                controller.enqueue({ type: "text-delta", id: startTextBlock(), delta: note })
                endTextBlock()
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
                reasoningIds.set(idx, reasoningId)
              }

              if (block.type === "text") {
                textBlockIndices.add(idx)
                // New text block — clear last-block buffer so final-answer
                // detection only considers this block's contents, not earlier
                // mid-task narration.
                resetLastVisibleTextBlock()
                if (block.text) {
                  if (!currentTextId) startTextBlock()
                  controller.enqueue({
                    type: "text-delta",
                    id: currentTextId!,
                    delta: block.text,
                  })
                  noteVisibleText(block.text)
                  hasReceivedContent = true
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
                toolCallMap.set(idx, entry)

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
                hadThinkingTextFromStream = true
                const reasoningId = reasoningIds.get(idx)
                if (reasoningId) {
                  if (!reasoningStarted.get(idx)) {
                    controller.enqueue({
                      type: "reasoning-start",
                      id: reasoningId,
                    } as any)
                    reasoningStarted.set(idx, true)
                  }
                  controller.enqueue({
                    type: "reasoning-delta",
                    id: reasoningId,
                    delta: delta.thinking,
                  } as any)
                }
              }

              if (delta.type === "text_delta" && delta.text) {
                if (!currentTextId) startTextBlock()
                controller.enqueue({
                  type: "text-delta",
                  id: currentTextId!,
                  delta: delta.text,
                })
                noteVisibleText(delta.text)
                hasReceivedContent = true
              }

              if (delta.type === "input_json_delta" && delta.partial_json) {
                const tc = toolCallMap.get(idx)
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

              const reasoningId = reasoningIds.get(idx)
              if (reasoningId && reasoningStarted.get(idx)) {
                controller.enqueue({
                  type: "reasoning-end",
                  id: reasoningId,
                } as any)
                reasoningStarted.delete(idx)
              }

              if (textBlockIndices.has(idx)) {
                endTextBlock()
                textBlockIndices.delete(idx)
              }

              const tc = toolCallMap.get(idx)
              if (tc) {
                // Block indices restart at 0 on every assistant message, and a
                // turn can hold several (tool_use -> tool_result -> answer).
                // Without this delete the entry outlives its message, so the
                // next message's block at the same index re-emits a tool-call
                // for an id opencode already completed. That second part never
                // gets a result, opencode aborts it at stream end, and a
                // subagent's `task` call reports "Tool execution aborted"
                // even though the child answered correctly.
                toolCallMap.delete(idx)
                let parsedInput: any = {}
                try {
                  parsedInput = JSON.parse(tc.inputJson || "{}")
                } catch {}

                if (isAskUserQuestionTool(tc.name)) {
                  // Latch: the model handed control to the operator. Block any
                  // auto-continue nudge for the rest of the turn so it can't
                  // proceed on its own before the operator replies.
                  autoContinueState.sawAskUserQuestion = true
                  const askId = startTextBlock()
                  controller.enqueue({
                    type: "text-delta",
                    id: askId,
                    delta: formatAskUserQuestion(parsedInput),
                  })
                  endTextBlock()
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
                    const planId = startTextBlock()
                    controller.enqueue({
                      type: "text-delta",
                      id: planId,
                      delta: questionCall.text,
                    })
                    finishWithQuestionCall(questionCall)
                    return
                  }

                  const planId = startTextBlock()
                  controller.enqueue({
                    type: "text-delta",
                    id: planId,
                    delta: `\n\n${plan}\n\n---\n**Do you want to proceed with this plan?** (yes/no)\n`,
                  })
                  endTextBlock()
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
                  const searchId = startTextBlock()
                  controller.enqueue({
                    type: "text-delta",
                    id: searchId,
                    delta: `\n> **Web search:** ${query}\n`,
                  })
                  endTextBlock()
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
                    toolCallsById.set(tc.id, {
                      id: tc.id,
                      name: tc.name,
                      input: parsedInput,
                    })
                    if (!executed) skipResultForIds.add(tc.id)

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
              gotPartialEvents &&
              msg.type === "message_delta" &&
              typeof (msg as any).delta?.stop_reason === "string"
            ) {
              lastStopReason = (msg as any).delta.stop_reason
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
              lastStopReason = (msg.message as any).stop_reason
            }
            // Fallback: extract thinking from the complete assistant
            // message. opus-4-7's CLI strips thinking_delta from stream
            // events but may include thinking in the final message.
            if (
              msg.type === "assistant" &&
              msg.message?.content &&
              gotPartialEvents
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
                  hadStreamThinking: hadThinkingTextFromStream,
                })
                if (!hadThinkingTextFromStream) {
                  for (const block of thinkingBlocks) {
                    if (block.thinking && block.thinking.length > 0) {
                      noteReasoning()
                      hadThinkingTextFromStream = true
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
              !gotPartialEvents
            ) {
              const hasText = msg.message.content.some(
                (b: any) => b.type === "text" && b.text,
              )
              const hasToolUse = msg.message.content.some(
                (b: any) => b.type === "tool_use",
              )

              if (hasText) {
                hasReceivedContent = true
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
                  const blockId = startTextBlock()
                  controller.enqueue({
                    type: "text-delta",
                    id: blockId,
                    delta: block.text,
                  })
                  endTextBlock()
                  noteVisibleText(block.text)
                  hasReceivedContent = true
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
                    const askId = startTextBlock()
                    controller.enqueue({
                      type: "text-delta",
                      id: askId,
                      delta: formatAskUserQuestion(parsedInput),
                    })
                    endTextBlock()
                  } else if (block.name === "ExitPlanMode") {
                    const plan = (parsedInput?.plan as string) || ""

                    if (planModeQuestionActive) {
                      const questionCall = createExitPlanModeQuestionCall(
                        sk,
                        block.id,
                        plan,
                      )
                      const planId = startTextBlock()
                      controller.enqueue({
                        type: "text-delta",
                        id: planId,
                        delta: questionCall.text,
                      })
                      finishWithQuestionCall(questionCall)
                      return
                    }

                    const planId = startTextBlock()
                    controller.enqueue({
                      type: "text-delta",
                      id: planId,
                      delta: `\n\n${plan}\n\n---\n**Do you want to proceed with this plan?** (yes/no)\n`,
                    })
                    endTextBlock()
                  } else if (
                    isWebSearchTool(block.name) &&
                    isWebSearchHandledByCli(self.config.webSearch)
                  ) {
                    // CLI-internal WebSearch: render the query as text and
                    // drop the call/result parts (no opencode registry entry
                    // for "WebSearch" — would render as an invalid tool row).
                    toolCallsById.delete(block.id)
                    const query =
                      typeof parsedInput?.query === "string"
                        ? parsedInput.query
                        : JSON.stringify(parsedInput)
                    const searchId = startTextBlock()
                    controller.enqueue({
                      type: "text-delta",
                      id: searchId,
                      delta: `\n> **Web search:** ${query}\n`,
                    })
                    endTextBlock()
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
                      toolCallsById.set(block.id, {
                        id: block.id,
                        name: block.name,
                        input: parsedInput,
                      })
                      if (!executed) skipResultForIds.add(block.id)
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
                  if (skipResultForIds.has(block.tool_use_id)) {
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

                  const toolCall = toolCallsById.get(block.tool_use_id)
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
                    toolCallsById.delete(block.tool_use_id)
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
                !currentTextId &&
                msg.is_error &&
                typeof msg.result === "string" &&
                msg.result.trim().length > 0
              ) {
                const errId = startTextBlock()
                controller.enqueue({
                  type: "text-delta",
                  id: errId,
                  delta: msg.result,
                })
              }

              // The other half of the limit signal: some rejections only ever
              // reach us as the error text of the terminal result.
              if (
                !accountLimitHit &&
                msg.is_error &&
                isAccountLimitError({
                  resultText: typeof msg.result === "string" ? msg.result : null,
                })
              ) {
                accountLimitHit = {}
              }

              // A non-`success` subtype is a failed turn. Name it in the
              // transcript and finish as an error, rather than letting it be
              // recorded as an ordinary reply with the subtype only in a
              // debug log line.
              const failure = describeResultFailure(msg)
              if (failure) {
                resultFailure = msg.subtype
                controller.enqueue({
                  type: "text-delta",
                  id: startTextBlock(),
                  delta: formatResultFailureNote(failure),
                })
                log.warn(failure, { sessionKey: sk, subtype: msg.subtype })
              }

              const turnStats = extractTurnStats(msg)
              resultMeta = {
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
                    id: startTextBlock(),
                    delta: footer,
                  })
                }
              }

              turnCompleted = true

              endTextBlock()

              const shouldDeferResult =
                !msg.is_error &&
                !autoContinueState.aborted &&
                !autoContinueState.sawAskUserQuestion

              if (drainBuffer.length > 0 && shouldDeferResult) {
                log.info(
                  "waiting for parallel proxy calls at turn-result boundary",
                  {
                    sessionKey: sk,
                    count: drainBuffer.length,
                  },
                )
                scheduleResultBoundary(
                  () => completeResult(msg),
                  DRAIN_QUIET_MS,
                )
                return
              }

              if (
                drainBuffer.length === 0 &&
                hadProxyActivitySinceContinue &&
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
          if (controllerClosed) return
          // Claude CLI's stdio is gone. The proxy-mcp HTTP requests that
          // backed any pending tool calls have no one to answer them now —
          // reject so the handlers return errors rather than hang.
          if (drainBuffer.length > 0 || getPendingProxyCalls(sk).length > 0) {
            rejectAllPendingProxyCallsForSession(
              sk,
              new Error(
                "Claude CLI subprocess closed before pending tool calls were resolved",
              ),
            )
            drainBuffer.length = 0
          }
          // A close without a terminal `result` means the child died mid-turn.
          // Reporting that as `stop` with empty usage made a crashed CLI look
          // like a short but successful answer. An abort is not a crash: the
          // operator asked for it, and the CLI may exit before its interrupt
          // result lands.
          const crashed = !turnCompleted && !autoContinueState.aborted
          controllerClosed = true
          cleanupTurn()
          endTextBlock()

          const finishClose = (
            exitCode: number | null,
            signal: NodeJS.Signals | null,
          ) => {
            if (crashed) {
              log.warn("claude process closed without a result", {
                sessionKey: sk,
                exitCode,
                signal,
                stderrBytes: activeProcess?.lastStderr?.length ?? 0,
              })
              controller.enqueue({
                type: "error",
                error: new Error(
                  describeChildCrash(exitCode, signal, activeProcess?.lastStderr),
                ),
              })
            }
            controller.enqueue({
              type: "finish",
              finishReason: toFinishReason(crashed ? "error" : "stop"),
              usage: toUsage(),
              providerMetadata: {
                "claude-code": {
                  ...resultMeta,
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
          if (crashed && proc.exitCode === null && proc.signalCode === null) {
            let reported = false
            const report = (
              exitCode: number | null,
              signal: NodeJS.Signals | null,
            ) => {
              if (reported) return
              reported = true
              clearTimeout(exitGrace)
              proc.off("exit", onExit)
              finishClose(exitCode, signal)
            }
            const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
              report(code, signal)
            const exitGrace = setTimeout(
              () => report(proc.exitCode, proc.signalCode),
              CHILD_EXIT_STATUS_GRACE_MS,
            )
            proc.once("exit", onExit)
            return
          }
          finishClose(proc.exitCode, proc.signalCode)
        }

        // Centralised per-turn teardown. Every exit path funnels through here
        // so we don't accumulate listeners across turns on a reused process.
        let cleanedUp = false
        const cleanupTurn = () => {
          if (cleanedUp) return
          cleanedUp = true
          clearFallbackTimer()
          pendingResultCompletion = null
          clearStartWatchdog()
          if (drainTimer) {
            clearTimeout(drainTimer)
            drainTimer = null
          }
          lineEmitter.off("line", lineHandler)
          lineEmitter.off("close", closeHandler)
          pendingProxyUnsubscribe?.()
          pendingProxyUnsubscribe = null
          asideSinkUnregister?.()
          asideSinkUnregister = null
          proc.off("error", procErrorHandler)
        }

        const procErrorHandler = (err: Error) => {
          log.error("process error", { error: err.message })
          deleteActiveProcess(sk)
          deleteClaudeSessionId(sk)
          if (controllerClosed) return
          // Subprocess failure invalidates every pending HTTP-bound tool
          // call for this session. Reject them so proxy-mcp returns errors
          // to Claude rather than letting the sockets stall.
          if (drainBuffer.length > 0 || getPendingProxyCalls(sk).length > 0) {
            rejectAllPendingProxyCallsForSession(
              sk,
              new Error(
                `Claude CLI subprocess error: ${err.message}`,
              ),
            )
            drainBuffer.length = 0
          }
          controllerClosed = true
          cleanupTurn()
          controller.enqueue({ type: "error", error: err })
          try {
            controller.close()
          } catch {}
        }

        // Whatever the child said while no turn was listening comes first:
        // the operator gets to see it, and a turn that already ended on the
        // CLI's side is known before this one decides what to send.
        if (activeProcess) {
          const unattended = takeUnattendedLines(activeProcess)
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
                const id = startTextBlock()
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
                    unattendedTurnEnded = true
                    for (const entry of activeProcess.pendingProxyCompletions?.values() ?? []) {
                      if (isPendingProxyCallChannelClosed(entry.call)) entry.recoveryRequired = true
                    }
                    if (outer.session_id) setClaudeSessionId(sk, outer.session_id)
                    if (msg.is_error && msg.result) text = msg.result
                  }
                  if (text) controller.enqueue({ type: "text-delta", id: currentTextId ?? startTextBlock(), delta: text })
                } catch { /* Ignore incomplete or malformed buffered lines. */ }
              }
            }
            endTextBlock()
            // Replayed lines are history, not liveness: the watchdogs below
            // must judge the child on what it does from here on.
            clearFallbackTimer()
            hasReceivedContent = false
          }
        }

        if (activeProcess && !compactionMode) {
          activeProcess.opencodeSessionID = affinity
          activeProcess.asideTransport = asideTransportRef
        }
        if (!compactionMode) {
          // Lets a `/btw` answered while this turn runs land in the turn's own
          // reply instead of a toast (btw-command.ts). Its own text block, so
          // the marker stays at the start of a part and the block can be
          // stripped exactly when a transcript is rebuilt.
          asideSinkUnregister = registerAsideSink(affinity, (text) => {
            if (controllerClosed) return false
            const asideId = startTextBlock()
            controller.enqueue({ type: "text-delta", id: asideId, delta: text })
            endTextBlock()
            return true
          })
        }
        lineEmitter.on("line", lineHandler)
        lineEmitter.on("close", closeHandler)

        pendingProxyUnsubscribe = onPendingProxyCall(sk, (call) => {
          if (controllerClosed) {
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
          drainBuffer.push(call)
          if (noteResultBoundaryCall()) return
          if (drainTimer) clearTimeout(drainTimer)
          drainTimer = setTimeout(drainNow, DRAIN_QUIET_MS)
        })

        proc.on("error", procErrorHandler)

        // On abort, keep process alive for next message
        if (options.abortSignal) {
          // Proxy calls this turn handed to opencode will never get a result
          // once the operator aborts: opencode stops its tool runs with the
          // turn. Release them now, so the CLI's parked requests return and
          // nothing waits for the next message to find out. Late-result
          // recovery is untouched: it holds results that already arrived.
          const releaseAbandonedProxyCalls = (reason: string) => {
            if (drainBuffer.length === 0 && getPendingProxyCalls(sk).length === 0) return
            rejectAllPendingProxyCallsForSession(sk, new Error(reason))
            drainBuffer.length = 0
          }
          options.abortSignal.addEventListener("abort", () => {
            autoContinueState.aborted = true
            if (turnCompleted || controllerClosed) {
              // This stream already ended on a proxy tool boundary and
              // opencode was running the tool when the operator aborted.
              // The CLI is parked in that call and nobody else will answer
              // it; but only while no later turn has attached to the
              // process, since that turn's calls are its own.
              if (
                activeProcess &&
                activeProcess.lineEmitter.listenerCount("line") === 0 &&
                getPendingProxyCalls(sk).length > 0
              ) {
                log.info("abort between proxy tool boundaries; releasing pending calls", { sk })
                void interruptTurn(activeProcess).then((idle) => {
                  log.info("interrupt sent for aborted turn", { sk, idle })
                })
                releaseAbandonedProxyCalls(
                  "Provider stream was aborted while opencode was running its proxy tool calls",
                )
              }
              return
            }

            // Stop the CLI's turn, not just our end of the stream: it would
            // otherwise run the abandoned turn to completion, billing tokens
            // and executing tools, with its late output landing in the next
            // turn. The process itself stays alive for the next message.
            if (activeProcess) {
              void interruptTurn(activeProcess).then((idle) => {
                log.info("interrupt sent for aborted turn", { sk, idle })
              })
            }

            if (!hasReceivedContent) {
              log.info(
                "abort signal received before content, closing stream immediately",
                { cwd },
              )
              releaseAbandonedProxyCalls(
                "Provider stream was aborted before pending proxy calls were emitted",
              )
              controllerClosed = true
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
              const completions = (activeProcess!.pendingProxyCompletions ??= new Map())
              if (!completions.has(call.toolCallId)) {
                completions.set(call.toolCallId, {
                  call,
                  result,
                  recoveryRequired: channelClosed || unattendedTurnEnded,
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

          if (unattendedTurnEnded) deliverPendingCompletions()

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
            drainBuffer.push(...unemitted)
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
        if (activeProcess) noteTurnStarted(activeProcess)
        proc.stdin?.write(userMsg + "\n")
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
