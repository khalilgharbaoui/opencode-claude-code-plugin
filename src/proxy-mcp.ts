import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import * as fs from "node:fs"
import * as path from "node:path"
import * as crypto from "node:crypto"
import { EventEmitter } from "node:events"
import { log } from "./logger.js"
import { pluginTmpDir } from "./tmp.js"

/**
 * Minimal MCP HTTP server embedded in-process. Exposes a set of "proxy"
 * tools (Bash, Edit, Write, etc.) that Claude CLI calls when its built-in
 * equivalents are disabled via --disallowedTools. Our handler blocks until
 * an external broker resolves the call, then responds to Claude.
 *
 * Wire protocol: JSON-RPC 2.0 over plain HTTP POST to `/mcp`. Protocol
 * methods (`initialize`, `tools/list`) and calls answered in-process get a
 * single JSON reply. A broker-backed `tools/call` can block for as long as
 * opencode takes to run the tool, so its reply is streamed: SSE when the
 * client accepts it, otherwise a chunked JSON body whose headers go out at
 * once and which carries keepalive whitespace until the result is ready
 * (see `openEventStream` / `openJsonStream`).
 */

export interface ProxyMcpServer {
  url: string
  serverName: string
  tools: ProxyToolDef[]
  /** Per-server bearer secret. Minted on start, handed to Claude via the
   * `headers` block of the generated MCP config, and required on every
   * request. Exposed so callers (and tests) can authenticate; MUST NOT be
   * logged or placed in the URL. */
  authToken: string
  /** Fires when Claude invokes one of our proxy tools. The handler resolves
   * the returned pending call once a result is available. */
  calls: EventEmitter
  /** Write `--mcp-config <path>`-compatible scratch file and return its path. */
  configPath(): string
  /**
   * Ids of the `tools/call` requests this server is still holding open.
   * Read-only. An entry leaves this list only when its promise settles, so
   * it is the direct evidence that a lifecycle event released the HTTP side
   * of a call and not just the broker's entry for it.
   */
  pendingCallIds(): string[]
  close(): Promise<void>
}

export interface ProxyToolDef {
  /** Raw name as seen by Claude once proxied: the MCP exposed tool name. */
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * Liveness of the HTTP reply channel behind one proxy call. Shared by
 * reference between proxy-mcp (which flips `closed` when Claude's request
 * goes away) and the broker / language model (which read it before
 * answering), so the two never need to import each other.
 */
export interface ProxyCallChannel {
  closed: boolean
}

export interface ProxyToolCall {
  id: string
  toolName: string
  input: Record<string, unknown>
  resolve: (result: ProxyToolResult) => void
  reject: (err: Error) => void
  /** Absent for calls built by hand in tests; treated as open. */
  channel?: ProxyCallChannel
}

/**
 * Keep unanswered HTTP calls active independently of the tool deadline.
 * A held call timed out before delivery on CLI 2.1.258; with immediate
 * headers and these comments, the same 390-second hold completed. The same
 * cadence drives the whitespace keepalive of a JSON-only reply: both must
 * stay well under the ~300 s header/body timers in the CLI's HTTP client.
 */
export const PROXY_KEEPALIVE_MS = 15_000

/** True when the client advertised `text/event-stream` in Accept. */
export function acceptsEventStream(acceptHeader: unknown): boolean {
  return (
    typeof acceptHeader === "string" &&
    acceptHeader.toLowerCase().includes("text/event-stream")
  )
}

export type ProxyToolResult =
  | { kind: "text"; text: string; isError?: boolean }
  | { kind: "error"; message: string }

/**
 * Handler that answers a `tools/call` inside this process instead of
 * queueing it for opencode. Used by tools that act on plugin state rather
 * than on the workspace (currently only `compress`), so they never reach
 * the broker, never block on a human, and have no deadline.
 */
export type ProxyToolInterceptor = (
  input: Record<string, unknown>,
) => Promise<ProxyToolResult> | ProxyToolResult

export const SERVER_CLOSED_MESSAGE = "proxy MCP server closed"

/** Rejections that fire on normal lifecycle transitions: AFK-permission
 * timeouts, orphan rejections at turn boundaries, stream aborts, and server
 * close while its owning Claude process exits or is replaced. None are
 * user-actionable — file-log them at NOTICE. Anything else stays WARN so
 * genuine bugs remain visible in the TUI. */
export function isExpectedCleanupError(message: string): boolean {
  return (
    (message.includes("timed out after") &&
      message.includes("waiting for opencode to resolve")) ||
    message.includes("rejecting as orphaned") ||
    message.includes("was orphaned by a new user turn") ||
    message.includes("stream was aborted") ||
    message.includes(SERVER_CLOSED_MESSAGE)
  )
}

const PROTOCOL_VERSION = "2024-11-05"
const SERVER_NAME = "opencode_proxy"
export const PROXY_TOOL_PREFIX = `mcp__${SERVER_NAME}__`

// Flat fallback cap on how long a proxy tool call may wait for opencode to
// resolve it. Matches Claude CLI's hard upper bound for Bash (10 min). The
// effective deadline is resolved per tool — see `resolveProxyCallTimeoutMs`.
export const PROXY_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** A resolved deadline of 0 means the call waits until a lifecycle event
 * releases it: a result, an abort, the next user turn's orphan sweep, the
 * child closing, or the proxy server closing with its process. */
export const PROXY_NO_DEADLINE_MS = 0

// Per-tool default deadlines, keyed by lowercase proxy tool name. `task` and
// `task_batch` dispatch opencode subagents, and the wall clock is the wrong
// unit for those: a 10-min flat ceiling fired mid-subagent and dropped the
// late result on the floor (@jknlsn, live session ses_0cfc0da6, 2026-07-05),
// and a 60-min one did the same to any subagent that ran longer (@broskees'
// dd494a8). So they carry no deadline at all: an abandoned task call is
// released by the same lifecycle events that already release every other
// call, and a positive `proxyToolTimeoutMs` override restores a backstop.
//
// `question` blocks on a human reading a TUI form, so the flat ceiling is
// the wrong unit entirely: a question posed just before the operator steps
// away would be rejected mid-answer. 30 min is jknlsn's original figure and
// matches the "prefer fewer, high-signal questions" guidance in the def.
export const PROXY_PER_TOOL_DEFAULT_TIMEOUT_MS: Record<string, number> = {
  task: PROXY_NO_DEADLINE_MS,
  task_batch: PROXY_NO_DEADLINE_MS, // same reasoning: it IS task calls
  question: 30 * 60 * 1000, // 30 min
}

// Node's setTimeout delay is a signed 32-bit int; values above 2^31-1 ms
// (~24.85 days) trigger TimeoutOverflowWarning and fire at ~1ms instead.
// Clamp absurd overrides / input.timeouts so a misconfigured deadline
// can't collapse to "fires immediately".
export const MAX_PROXY_TIMEOUT_MS = 2 ** 31 - 1

/**
 * Resolve the proxy deadline for a tool call. Layers, most-specific last:
 *  1. flat default (`PROXY_DEFAULT_TIMEOUT_MS`, 10 min)
 *  2. per-tool default (`PROXY_PER_TOOL_DEFAULT_TIMEOUT_MS`; `task` and
 *     `task_batch` have none)
 *  3. user override via `proxyToolTimeoutMs` config (case-insensitive key).
 *     A positive value replaces the default, `0` disables the deadline for
 *     that tool, and a negative or non-finite value is ignored.
 *  4. for `bash`, the call's own `input.timeout` -- the proxy must never
 *     undercut a build the caller explicitly asked to run long. The bash
 *     proxy def advertises a `timeout` field; before this fix the proxy
 *     ignored it and killed the call at the flat ceiling anyway. It only
 *     ever raises, so it also turns a disabled bash deadline back into one.
 * Finally clamped to `MAX_PROXY_TIMEOUT_MS` to stay within Node's timer range.
 * Returns `PROXY_NO_DEADLINE_MS` (0) when the call has no deadline; callers
 * must not arm a timer for that value.
 */
export function resolveProxyCallTimeoutMs(
  toolName: string,
  input: Record<string, unknown> | undefined,
  overrides: Record<string, number> | undefined,
): number {
  const key = toolName.toLowerCase()
  let ms = PROXY_PER_TOOL_DEFAULT_TIMEOUT_MS[key] ?? PROXY_DEFAULT_TIMEOUT_MS
  if (overrides) {
    const ov = lookupCaseInsensitive(overrides, key)
    if (isDeadlineOverride(ov)) ms = ov
  }
  if (key === "bash") {
    const requested = input?.timeout
    if (typeof requested === "number" && requested > ms) ms = requested
  }
  return Math.min(ms, MAX_PROXY_TIMEOUT_MS)
}

/** `0` (no deadline) or a positive finite number of milliseconds. */
function isDeadlineOverride(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function lookupCaseInsensitive(
  map: Record<string, number>,
  key: string,
): number | undefined {
  if (Object.prototype.hasOwnProperty.call(map, key)) return map[key]
  for (const k of Object.keys(map)) {
    if (k.toLowerCase() === key) return map[k]
  }
  return undefined
}

/**
 * Client-side abort ceiling written into Claude's `--mcp-config` entry for
 * the proxy server. Without a `timeout` there, Claude CLI's remote-HTTP MCP
 * client aborts each call at its 60-second default even while an opencode
 * subagent is still running (@broskees, PR #18). It must be >= the largest
 * server-side deadline or the client gives up before the broker does, so it
 * tracks the max of every tool's effective deadline: the flat default, the
 * per-tool defaults, and the user's overrides applied on top of them. A tool
 * with no deadline needs the largest value the client accepts, because the
 * CLI rejects `timeout: 0` in the MCP config outright (measured on the fork
 * this came from, @broskees' dd494a8), and this is also Node's timer max.
 * (A bash call raising its own `input.timeout` above this ceiling is a known
 * edge; Claude CLI caps bash at 10 min anyway.)
 */
export function resolveProxyClientCeilingMs(
  overrides: Record<string, number> | undefined,
): number {
  let ms = PROXY_DEFAULT_TIMEOUT_MS
  const consider = (deadlineMs: number): boolean => {
    if (deadlineMs === PROXY_NO_DEADLINE_MS) return true
    if (deadlineMs > ms) ms = deadlineMs
    return false
  }
  for (const [toolName, defaultMs] of Object.entries(PROXY_PER_TOOL_DEFAULT_TIMEOUT_MS)) {
    const override = overrides ? lookupCaseInsensitive(overrides, toolName) : undefined
    if (consider(isDeadlineOverride(override) ? override : defaultMs)) {
      return MAX_PROXY_TIMEOUT_MS
    }
  }
  for (const value of Object.values(overrides ?? {})) {
    if (isDeadlineOverride(value) && consider(value)) return MAX_PROXY_TIMEOUT_MS
  }
  return Math.min(ms, MAX_PROXY_TIMEOUT_MS)
}

/**
 * Asked when a call's deadline passes. `true` means opencode is still serving
 * the call, so it keeps waiting and is asked about again later.
 *
 * The deadline counted time the operator spent on opencode's permission
 * prompt, and that is where nearly every deadline went: measured 2026-09-23,
 * three proxied `bash` calls sat on an `external_directory` prompt for 24, 34
 * and 10.5 minutes (opencode's own part timings) and each was rejected at 10.
 * Claude then moved on to a new call, and the approval, once given, arrived as
 * a late result that the next turn's orphan sweep read as a new message: the
 * new call was cancelled and Claude was told the user had refused it. opencode
 * reports the session `busy` for as long as a prompt is open (measured on
 * 1.18.32), which is the signal the language model's guard reads.
 *
 * Registered by the language model; with no guard every deadline is final, as
 * it always was, so a bare proxy server and the offline tests are unchanged.
 */
export type ProxyDeadlineGuard = (call: { callId: string; toolName: string }) => Promise<boolean>

let proxyDeadlineGuard: ProxyDeadlineGuard | null = null

export function setProxyDeadlineGuard(guard: ProxyDeadlineGuard | null): void {
  proxyDeadlineGuard = guard
}

/** How often a call kept past its deadline is looked at again. */
export const PROXY_DEADLINE_RECHECK_MS = 60_000

let deadlineRecheckMs = PROXY_DEADLINE_RECHECK_MS

/** Test seam: `null` restores the default. */
export function _setProxyDeadlineRecheckMs(ms: number | null): void {
  deadlineRecheckMs = ms ?? PROXY_DEADLINE_RECHECK_MS
}

export interface ProxyDeadline {
  cancel(): void
}

/**
 * One call's deadline, shared by the HTTP handler and the broker so the two
 * layers make the same decision. `onExpire` runs only once the guard says
 * opencode is no longer serving the call (or there is no guard). A guard that
 * throws counts as "not serving", so a failed lookup can only end a call the
 * way it always ended, never hold one open.
 */
export function armProxyDeadline(opts: {
  callId: string
  toolName: string
  deadlineMs: number
  onExpire: () => void
  /** Only one layer logs the extension, so a call does not report twice. */
  logExtension?: boolean
  /** Test seam. */
  recheckMs?: number
}): ProxyDeadline {
  let cancelled = false
  let extended = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const check = async (): Promise<void> => {
    timer = null
    if (cancelled) return
    let keep = false
    const guard = proxyDeadlineGuard
    if (guard) {
      try {
        keep = await guard({ callId: opts.callId, toolName: opts.toolName })
      } catch {
        keep = false
      }
    }
    if (cancelled) return
    if (keep) {
      if (!extended && opts.logExtension) {
        log.warn("proxy call past its deadline, but opencode is still serving it; waiting", {
          callId: opts.callId,
          toolName: opts.toolName,
          deadlineMs: opts.deadlineMs,
          note: "usually a permission prompt in opencode; the call ends when it is answered, you abort, or the claude process goes",
        })
      }
      extended = true
      timer = setTimeout(() => void check(), opts.recheckMs ?? deadlineRecheckMs)
      return
    }
    opts.onExpire()
  }

  timer = setTimeout(() => void check(), opts.deadlineMs)
  return {
    cancel() {
      cancelled = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

/**
 * Build the timeout error surfaced to Claude. Keeps the substrings
 * `"timed out after"` and `"waiting for opencode to resolve"` that the
 * proxy-mcp catch block classifies as expected cleanup (notice, not warn).
 * For `task` we append guidance: a Task timeout means the subagent may
 * still be running but its result is now unreachable, and the model must
 * neither declare the dispatch failed nor "schedule a wake-up" -- that is a
 * Claude Code affordance which cannot fire in this headless/proxy context,
 * so deferring silently drops the work.
 */
export function buildProxyTimeoutError(toolName: string, ms: number): Error {
  const key = toolName.toLowerCase()
  const base = `Proxy tool '${toolName}' timed out after ${ms}ms waiting for opencode to resolve the call`
  if (key === "task" || key === TASK_BATCH_TOOL_NAME) {
    return new Error(
      base +
        (key === "task" ? " (the subagent)." : " (the subagents).") +
        " The subagent may still be running but its result" +
        " is no longer reachable in this session. Do not declare the dispatch" +
        " failed, and do not 'schedule a wake-up' or defer -- that mechanism" +
        " does not apply here. If the result is required, re-dispatch or" +
        " verify it directly now.",
    )
  }
  return new Error(base)
}

/**
 * Disambiguation appended to the `task` proxy def (both the static
 * fallback and the live overlay). Models routinely resolve opencode's
 * "call the task tool with subagent: X" mention hint to Claude Code's
 * native TaskCreate (a todo tool) — creating a todo, dispatching nothing,
 * and then narrating a successful dispatch. Others burn turns grepping
 * config files to verify a subagent exists before daring to call it.
 * Both failure modes are addressed here, at the tool the model reads.
 */
export const TASK_PROXY_NOTE =
  "This and task_batch are the ONLY tools that dispatch opencode subagents" +
  " (including user @-mentions). Claude Code's built-in TaskCreate/TaskUpdate" +
  " manage a local todo list and cannot dispatch subagents. Do not search" +
  " config files to verify a subagent type exists: invalid types fail fast" +
  " with a clear error. Foreground calls block until the subagent finishes;" +
  " set `background` to request opencode's background execution mode. For" +
  " two or more independent subagents in one response use task_batch, not" +
  " several task calls: those run one after another. Task calls have no" +
  " proxy deadline by default: the call waits for the subagent to finish" +
  " (a positive proxyToolTimeoutMs override adds a deadline)."

/**
 * `task_batch`: one MCP call that opencode runs as N parallel `task` calls.
 *
 * Design and first implementation by Joseph Roberts (@broskees) on his fork
 * (68ed142), absorbed here with credit. The limitation it works around is
 * measured, not assumed: Claude Code emits several `mcp__opencode_proxy__*`
 * tool_use blocks in one assistant message but sends the MCP requests one at
 * a time, each only after the previous result (2026-09-06, haiku, two
 * 8-second bash calls: second request arrived 7 ms after the first resolved).
 * So "call task twice" is serial by construction, and the only way to get two
 * subagents running at once is a single proxy call that the plugin fans out
 * inside one opencode tool boundary, where opencode executes tool calls
 * concurrently. The children are ordinary `task` calls with ids derived from
 * the parent (`taskBatchChildToolCallId`), and their results are gathered
 * back onto the parent id (`formatTaskBatchResults`) before the CLI sees it.
 */
export const TASK_BATCH_TOOL_NAME = "task_batch"

export const TASK_BATCH_PROXY_NOTE =
  "Use this instead of several task calls in one response: Claude Code runs" +
  " MCP tool calls one at a time, so separate task calls run serially even" +
  " when emitted together, while one task_batch call fans them out as" +
  " parallel opencode task calls. Each task takes the same fields as the" +
  " task tool. Results come back in task order, each labelled. Like task it" +
  " has no proxy deadline by default (a positive proxyToolTimeoutMs override" +
  " adds one)."

export const TASK_INPUT_REQUIRED = ["description", "prompt", "subagent_type"]

/** Why a `task_batch` input is unusable, or null when it is fine. */
export function taskBatchInputError(input: Record<string, unknown> | undefined): string | null {
  const tasks = input?.tasks
  if (!Array.isArray(tasks) || tasks.length < 2) {
    return "task_batch requires a `tasks` array with at least two items; use `task` for one subagent"
  }
  for (const [index, task] of tasks.entries()) {
    if (task === null || typeof task !== "object" || Array.isArray(task)) {
      return `task_batch tasks[${index}] must be an object`
    }
    const item = task as Record<string, unknown>
    for (const field of TASK_INPUT_REQUIRED) {
      if (typeof item[field] !== "string") {
        return `task_batch tasks[${index}].${field} must be a string`
      }
    }
  }
  return null
}

/** The batch's task inputs, or [] when the input never passed validation. */
export function taskBatchTasks(input: Record<string, unknown> | undefined): Record<string, unknown>[] {
  if (taskBatchInputError(input)) return []
  return input!.tasks as Record<string, unknown>[]
}

/**
 * Child ids stay derivable from the parent so the next turn can find every
 * child's `tool-result` without extra state. Only `[A-Za-z0-9_-]`: AI SDK
 * bridges normalise other characters and the round trip would not match.
 */
export function taskBatchChildToolCallId(parentToolCallId: string, index: number): string {
  return `${parentToolCallId}_task_${index}`
}

/**
 * One readable result for the parent call. Children are labelled in task
 * order; a child opencode did not answer is said so rather than dropped,
 * since a silent gap would read as a subagent that never ran.
 */
export function formatTaskBatchResults(
  children: Array<{ task: Record<string, unknown>; result: ProxyToolResult | null }>,
): ProxyToolResult {
  const total = children.length
  const sections = children.map(({ task, result }, index) => {
    const label = typeof task.description === "string" ? task.description : `task ${index + 1}`
    const agent = typeof task.subagent_type === "string" ? ` (${task.subagent_type})` : ""
    const header = `## task ${index + 1} of ${total}: ${label}${agent}`
    if (!result) return `${header}\n[missing] opencode returned no result for this task in the batch`
    if (result.kind === "error") return `${header}\n[error] ${result.message}`
    return `${header}\n${result.isError ? "[error] " : ""}${result.text}`
  })
  const failed = children.some(({ result }) => !result || result.kind === "error" || result.isError)
  return { kind: "text", text: sections.join("\n\n"), ...(failed ? { isError: true } : {}) }
}

const AGENT_TYPES_HEADING = "Available agent types"

/** Longest per-agent blurb we keep; enough to choose, short enough to survive. */
const AGENT_BLURB_LIMIT = 140

/**
 * Disambiguation appended to the `question` proxy def. Claude Code ships
 * a built-in `AskUserQuestion` that, when proxied, is disabled via
 * `--disallowedTools`; without an explicit hand-off note models keep
 * reaching for the disabled built-in or fall back to plain text. This
 * states that the proxy is the structured-questions path and summarises
 * the answer shape so the model can act on the result without a second
 * round-trip.
 */
export const QUESTION_PROXY_NOTE =
  "This routes structured questions through opencode's native `question`" +
  " tool, which renders a TUI form with the options you provide and" +
  " blocks until the operator answers. Claude Code's built-in" +
  " AskUserQuestion is disabled in this environment; this proxy is the" +
  " ONLY way to ask the operator for a decision or clarification." +
  " Answers come back as arrays of selected labels (set `multiple: true`" +
  " to allow more than one). If the operator dismisses the form the call" +
  " returns an error — treat that as 'no answer' and stop, do not guess." +
  " Question calls get a 30-minute proxy deadline by default (configurable" +
  " via proxyToolTimeoutMs); for long-AFK scenarios prefer fewer," +
  " high-signal questions."

/**
 * Disambiguation appended to the `compress` proxy def. Two things the
 * model gets wrong without it: when the reset happens (not mid-turn, so
 * it can keep working after the call), and how much survives it (only
 * the summary, because the fresh spawn is not given the prior transcript).
 */
export const COMPRESS_PROXY_NOTE =
  "The current turn continues normally after this call — finish what you" +
  " are doing. The reset happens at the START of the next turn: the" +
  " Claude Code session is discarded and a fresh one begins with your" +
  " summary as its only prior context. Everything else, including tool" +
  " output and files you read, is gone, so write the summary as the" +
  " authoritative record. Call this once per compression, when older" +
  " resolved work no longer needs full detail."

/**
 * Pull *only* the agent-type list out of opencode's live `task` description.
 *
 * jknlsn's original overlaid the whole live description (2.8 KB here) in front
 * of the static def. Live check 2026-07-26 showed that backfires: Claude Code
 * truncates long MCP tool descriptions, and opencode puts the agent list at
 * the *end* (char 2306 of 2858), so the one part the model needs is exactly
 * what gets cut — haiku then guessed `general-purpose`, `default`, and
 * `code-reviewer` (Claude Code's own agent names) and every dispatch failed
 * with "Unknown agent type". So: keep the list, drop opencode's preamble
 * (generic delegation advice the model already has), trim each blurb, and let
 * the caller put it first.
 *
 * Returns undefined when the description carries no parsable list, so callers
 * leave the static def alone.
 */
export function extractAgentTypeList(
  liveDescription: string | undefined,
): string | undefined {
  const live = liveDescription?.trim()
  if (!live) return undefined
  const start = live.indexOf(AGENT_TYPES_HEADING)
  if (start === -1) return undefined
  const entries: string[] = []
  for (const raw of live.slice(start).split("\n")) {
    const match = /^-\s*([^:]+):\s*(.+)$/.exec(raw.trim())
    if (!match) continue
    const name = match[1].trim()
    const blurb = match[2].trim()
    entries.push(
      `- ${name}: ${
        blurb.length > AGENT_BLURB_LIMIT
          ? `${blurb.slice(0, AGENT_BLURB_LIMIT).trimEnd()}…`
          : blurb
      }`,
    )
  }
  if (entries.length === 0) return undefined
  return `Valid subagent_type values, from opencode's live registry — anything else fails:\n${entries.join("\n")}`
}

/**
 * Front-load opencode's live agent-type list onto the static `task` proxy def
 * so the model picks a real `subagent_type` instead of guessing a Claude Code
 * name. First, not last: see `extractAgentTypeList` for why position matters.
 * No-op when no list can be extracted (SDK client missing, older opencode) or
 * the `task` def is not among the tools.
 */
export function overlayTaskProxyDescription(
  tools: ProxyToolDef[],
  liveDescription: string | undefined,
): ProxyToolDef[] {
  const agentTypes = extractAgentTypeList(liveDescription)
  if (!agentTypes) return tools
  return tools.map((t) =>
    t.name === "task" || t.name === TASK_BATCH_TOOL_NAME
      ? { ...t, description: `${agentTypes}\n\n${t.description}` }
      : t,
  )
}

/**
 * Overlay opencode's live `question` tool description onto the static
 * proxy def, then append the disambiguation note. No-op when the live
 * description is unavailable (older opencode, SDK client missing) — the
 * static def + note stands. Mirrors `overlayTaskProxyDescription`.
 */
export function overlayQuestionProxyDescription(
  tools: ProxyToolDef[],
  liveDescription: string | undefined,
): ProxyToolDef[] {
  const live = liveDescription?.trim()
  if (!live) return tools
  return tools.map((t) =>
    t.name === "question"
      ? { ...t, description: `${live}\n\n${QUESTION_PROXY_NOTE}` }
      : t,
  )
}

/**
 * Version gate for the `question` proxy. opencode added a built-in
 * `question` tool (registry id `question`) — on older builds that entry
 * is absent and a forwarded `mcp__opencode_proxy__question` call would
 * resolve to `⚙ invalid` in opencode. Drop the def silently when the
 * live registry does not contain it so the model never sees a dead tool.
 */
export function filterQuestionProxyByOpencodeSupport(
  tools: ProxyToolDef[],
  opencodeHasQuestion: boolean,
): ProxyToolDef[] {
  if (opencodeHasQuestion) return tools
  return tools.filter((t) => t.name !== "question")
}

/** Input fields of one `task`, shared with each `task_batch` item. */
export const TASK_INPUT_PROPERTIES = {
  description: {
    type: "string",
    description: "A short (3-5 words) description of the task",
  },
  prompt: {
    type: "string",
    description: "The task for the agent to perform",
  },
  subagent_type: {
    type: "string",
    description: "The type of specialized agent to use for this task",
  },
  task_id: {
    type: "string",
    description:
      "Set this only if you mean to resume a previous task: pass the" +
      " prior task_id to continue the same subagent session instead of" +
      " creating a fresh one.",
  },
  command: {
    type: "string",
    description: "The command that triggered this task",
  },
  background: {
    type: "boolean",
    description:
      "Run the task in the background when supported by opencode",
  },
}

export const DEFAULT_PROXY_TOOLS: ProxyToolDef[] = [
  {
    name: "bash",
    description:
      "Execute a shell command. Routed through opencode's bash tool so" +
      " permission prompts flow through opencode's UI.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute.",
        },
        description: {
          type: "string",
          description: "Short human-readable description of what the command does.",
        },
        timeout: {
          type: "number",
          description: "Optional timeout in milliseconds.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "write",
    description:
      "Write a file. Routed through opencode's write tool so permission prompts flow through opencode's UI.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "The file to write. Absolute paths are preferred.",
        },
        content: {
          type: "string",
          description: "The full content to write to the file.",
        },
      },
      required: ["filePath", "content"],
    },
  },
  {
    name: "edit",
    description:
      "Replace text in an existing file. Routed through opencode's edit tool so permission prompts flow through opencode's UI.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "The file to edit. Absolute paths are preferred.",
        },
        oldString: {
          type: "string",
          description: "The exact text to replace.",
        },
        newString: {
          type: "string",
          description: "The replacement text.",
        },
        replaceAll: {
          type: "boolean",
          description: "Replace all occurrences instead of just the first one.",
        },
      },
      required: ["filePath", "oldString", "newString"],
    },
  },
  {
    name: "webfetch",
    description:
      "Fetch content from a URL. Routed through opencode's webfetch tool so" +
      " permission prompts flow through opencode's UI. Returns the page" +
      " content in the requested format.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch content from. Must start with http:// or https://.",
        },
        format: {
          type: "string",
          enum: ["text", "markdown", "html"],
          description:
            "The format to return the content in. Defaults to markdown.",
        },
        timeout: {
          type: "number",
          description: "Optional timeout in seconds (max 120).",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "task",
    description:
      "Launch an opencode subagent to handle a complex multi-step task" +
      " autonomously. Routed through opencode's task tool so subagent" +
      " orchestration, permission, and lifecycle are handled by opencode." +
      " Use `subagent_type` to pick which configured subagent runs (e.g." +
      " `build`, `general`, `explore`, or any custom subagent declared in" +
      " opencode.json). " +
      TASK_PROXY_NOTE,
    inputSchema: {
      type: "object",
      properties: TASK_INPUT_PROPERTIES,
      required: TASK_INPUT_REQUIRED,
    },
  },
  {
    name: TASK_BATCH_TOOL_NAME,
    description:
      "Launch two or more independent opencode subagents at the same time and" +
      " get all their results back together. Put one ordinary task input in" +
      " `tasks` for each subagent. " +
      TASK_BATCH_PROXY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 2,
          description: "Independent subagent tasks to run concurrently",
          items: {
            type: "object",
            properties: TASK_INPUT_PROPERTIES,
            required: TASK_INPUT_REQUIRED,
          },
        },
      },
      required: ["tasks"],
    },
  },
  {
    name: "question",
    description:
      "Ask the operator structured questions with options and receive" +
      " their answers back. Routed through opencode's native `question`" +
      " tool so the prompt renders as a real TUI form (with options and a" +
      " custom-answer field) instead of a plain text turn. Use this when" +
      " you need a decision, clarification, or preference from the" +
      " operator mid-task. " +
      QUESTION_PROXY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "Questions to ask.",
          items: {
            type: "object",
            properties: {
              question: {
                type: "string",
                description: "Complete question.",
              },
              header: {
                type: "string",
                description: "Very short label (max 30 chars).",
              },
              options: {
                type: "array",
                description: "Available choices.",
                items: {
                  type: "object",
                  properties: {
                    label: {
                      type: "string",
                      description: "Display text (1-5 words, concise).",
                    },
                    description: {
                      type: "string",
                      description: "Explanation of choice.",
                    },
                  },
                  required: ["label", "description"],
                },
              },
              multiple: {
                type: "boolean",
                description:
                  "Allow selecting multiple choices. Defaults to false.",
              },
            },
            required: ["question", "header", "options"],
          },
        },
      },
      required: ["questions"],
    },
  },
  {
    name: "compress",
    description:
      "Replace older conversation detail with a summary you write, then" +
      " continue in a fresh Claude Code session. Handled inside the plugin," +
      " so it never prompts the operator. " +
      COMPRESS_PROXY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "Dense technical summary of the work being compressed: decisions" +
            " made, files changed, commands run and their outcomes, and what" +
            " is still open. This is the ONLY prior context that survives, so" +
            " anything omitted is lost.",
        },
      },
      required: ["summary"],
    },
  },
]

export async function createProxyMcpServer(
  tools: ProxyToolDef[] = DEFAULT_PROXY_TOOLS,
  timeoutOverrides?: Record<string, number>,
  interceptors?: Map<string, ProxyToolInterceptor>,
  options: {
    /** Keepalive cadence for streamed replies; a test seam, defaults to `PROXY_KEEPALIVE_MS`. */
    keepaliveMs?: number
  } = {},
): Promise<ProxyMcpServer> {
  const calls = new EventEmitter()
  const pending = new Map<string, ProxyToolCall>()
  const keepaliveMs = options.keepaliveMs ?? PROXY_KEEPALIVE_MS

  // Per-server bearer secret (256 bits). This endpoint executes Bash/Edit/
  // Write through opencode's executor, so an unauthenticated caller on
  // loopback would have arbitrary command execution. The token lives only
  // in this process and in the 0600 MCP config file Claude reads; it is
  // deliberately kept out of the URL, because query strings leak into logs
  // and process listings.
  const authToken = crypto.randomBytes(32).toString("hex")
  const expectedAuth = Buffer.from(`Bearer ${authToken}`)
  // The exact authority we hand to Claude. Set once the ephemeral port is
  // known; compared against the Host header to defeat DNS rebinding.
  let boundAuthority = ""

  function authOk(req: IncomingMessage): boolean {
    const got = req.headers.authorization
    if (typeof got !== "string") return false
    const candidate = Buffer.from(got)
    // timingSafeEqual throws on length mismatch, so length-check first.
    // Length is not secret (the token is fixed-width).
    if (candidate.length !== expectedAuth.length) return false
    return crypto.timingSafeEqual(candidate, expectedAuth)
  }

  /**
   * Reject a request without leaving the connection usable.
   *
   * Ending the response alone is not enough. A peer can declare a large
   * Content-Length, send a single byte, take the rejection, and leave the
   * request still arriving — and `server.close()` does not reap connections
   * that are still sending, so a shutdown would hang behind it. Node's
   * default whole-request timeout is five minutes, which is five minutes of
   * a socket held by an unauthenticated caller.
   *
   * `Connection: close` tells Node to close once the response is flushed;
   * destroying the socket on `finish` covers the case where the peer never
   * finishes its body.
   */
  function reject(
    req: IncomingMessage,
    res: ServerResponse,
    statusCode: number,
    reason: string,
  ): void {
    // Every guard below is a measured property of the client we spawn, not a
    // guarantee about future ones. If a later Claude CLI starts sending an
    // Origin header, or a different Content-Type, every proxy call would
    // 403/415 with no other symptom than tools mysteriously not working — so
    // say why, here, once per rejected request. Header VALUES are omitted:
    // this line must never carry the bearer token.
    log.notice("proxy-mcp rejected a request", {
      statusCode,
      reason,
      method: req.method,
      hasAuthorization: typeof req.headers.authorization === "string",
    })
    res.statusCode = statusCode
    res.setHeader("Connection", "close")
    res.on("finish", () => {
      req.socket?.destroy()
    })
    res.end()
  }

  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/mcp")) {
      reject(req, res, 404, "not a POST to /mcp")
      return
    }
    // Everything below runs BEFORE readBody: an unauthenticated peer must
    // not be able to stream an unbounded body into memory.
    //
    // DNS rebinding: a browser rebound onto this port via an attacker
    // hostname sends that hostname in Host, never the loopback authority we
    // generated. This does NOT block a page posting directly to
    // 127.0.0.1:<port> — such a request carries exactly the expected Host —
    // so it is a rebinding defense specifically, not a browser defense. The
    // Origin and Content-Type guards below, and the token, cover that case.
    if (req.headers.host !== boundAuthority) {
      reject(req, res, 403, "host header is not the bound authority")
      return
    }
    // Claude Code 2.1.226 sends no Origin on MCP requests (verified). The MCP
    // transport spec obliges SERVERS to validate Origin; it does not oblige
    // clients to omit it, so this is a measured property of the client we
    // spawn rather than a guarantee about all conforming clients.
    if (req.headers.origin !== undefined) {
      reject(req, res, 403, "origin header present")
      return
    }
    // Requiring application/json forces a CORS preflight for cross-origin
    // callers (which then fails), closing the text/plain "simple request"
    // bypass that would otherwise allow blind cross-site POSTs.
    const contentType = String(req.headers["content-type"] ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase()
    if (contentType !== "application/json") {
      reject(req, res, 415, "content-type is not application/json")
      return
    }
    if (!authOk(req)) {
      reject(req, res, 401, "missing or invalid bearer token")
      return
    }
    // Hoist the request id and method so the catch block can echo them
    // in error responses. Without this, a broker rejection (timeout /
    // orphan) on a tools/call lands in the catch with no visible id, and
    // the response goes back with `id: null` which Claude CLI cannot
    // match to the original request. The method is also needed because
    // tools/call errors must be returned as MCP results with isError
    // (not JSON-RPC errors) or Claude CLI rejects them as a "malformed
    // result that failed schema validation" (seen live 2026-07-04).
    let requestId: number | string | null = null
    let requestMethod: string | null = null
    // Hoisted for the same reason: once a streamed reply's headers are out,
    // an error must travel down that stream instead of through writeJson
    // (which would try to set headers again and throw inside the catch).
    let reply: ReplyStream | null = null
    try {
      const body = await readBody(req)
      const request = JSON.parse(body) as {
        jsonrpc?: string
        id?: number | string | null
        method?: string
        params?: Record<string, unknown>
      }
      requestId = request?.id ?? null
      requestMethod = typeof request?.method === "string" ? request.method : null

      if (request?.jsonrpc !== "2.0" || typeof request.method !== "string") {
        writeJson(res, {
          jsonrpc: "2.0",
          id: requestId,
          error: { code: -32600, message: "Invalid request" },
        })
        return
      }

      log.debug("proxy-mcp request", {
        method: request.method,
        id: request.id,
      })

      if (request.method === "initialize") {
        writeJson(res, {
          jsonrpc: "2.0",
          id: requestId,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: {
              name: SERVER_NAME,
              version: "0.1.0",
            },
          },
        })
        return
      }

      if (request.method === "notifications/initialized") {
        res.statusCode = 204
        res.end()
        return
      }

      if (request.method === "tools/list") {
        writeJson(res, {
          jsonrpc: "2.0",
          id: requestId,
          result: {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        })
        return
      }

      if (request.method === "tools/call") {
        const params = request.params ?? {}
        const toolName = String(params.name ?? "")
        const input = (params.arguments ?? {}) as Record<string, unknown>

        if (!tools.some((t) => t.name === toolName)) {
          // tools/call failures MUST be MCP results with isError, never
          // JSON-RPC error envelopes: Claude CLI validates every tools/call
          // response against the MCP result schema and rejects JSON-RPC
          // errors as malformed (@jknlsn, seen live 2026-07-04).
          writeJson(res, {
            jsonrpc: "2.0",
            id: requestId,
            result: {
              content: [{ type: "text", text: `Unknown proxy tool: ${toolName}` }],
              isError: true,
            },
          })
          return
        }

        if (toolName === TASK_BATCH_TOOL_NAME) {
          const problem = taskBatchInputError(input)
          if (problem) {
            // Same rule as the unknown-tool path: an MCP result with isError,
            // never a JSON-RPC error envelope.
            writeToolCallResult(res, requestId, { kind: "error", message: problem })
            return
          }
        }

        // Intercepted tools act on plugin state, not on the workspace, so
        // they are answered here and never queued for opencode. The result
        // still goes through the shared MCP envelope below — a JSON-RPC
        // error here would be rejected by Claude CLI exactly like any other
        // tools/call error envelope.
        const interceptor = interceptors?.get(toolName)
        if (interceptor) {
          let intercepted: ProxyToolResult
          try {
            intercepted = await interceptor(input)
          } catch (interceptorError) {
            const message =
              interceptorError instanceof Error
                ? interceptorError.message
                : String(interceptorError)
            log.warn("proxy-mcp interceptor failed", { toolName, error: message })
            intercepted = { kind: "error", message }
          }
          writeToolCallResult(res, requestId, intercepted)
          return
        }

        const callId = crypto.randomUUID()
        log.info("proxy-mcp tool call received", {
          callId,
          toolName,
          hasInput: input != null,
          sse: acceptsEventStream(req.headers.accept),
        })

        // Broker-backed calls can block for as long as a subagent runs. The
        // reply is streamed either way so the client's own HTTP timers never
        // fire on a silent connection: SSE when the client accepts it
        // (headers and a comment now, keepalive comments, the JSON-RPC result
        // as the final event), otherwise a chunked JSON body whose headers go
        // out now and which carries keepalive whitespace until the result.
        // Every guard above has already run, so nothing is flushed for an
        // unauthenticated peer, an unknown tool, or a rejected batch.
        const channel: ProxyCallChannel = { closed: false }
        reply = acceptsEventStream(req.headers.accept)
          ? openEventStream(res, keepaliveMs)
          : openJsonStream(res, keepaliveMs)
        res.once("close", () => {
          reply?.stop()
          if (res.writableFinished) return
          channel.closed = true
          log.notice("proxy-mcp client closed a tool call before its result", {
            callId,
            toolName,
          })
        })

        let timer: ProxyDeadline | null = null
        const result = await new Promise<ProxyToolResult>(
          (resolve, reject) => {
            const entry: ProxyToolCall = {
              id: callId,
              toolName,
              input,
              resolve,
              reject,
              channel,
            }
            pending.set(callId, entry)
            const deadlineMs = resolveProxyCallTimeoutMs(
              toolName,
              input,
              timeoutOverrides,
            )
            // No deadline means no timer at all: `setTimeout(fn, 0)` would
            // reject the call on the next tick. The broker applies the same
            // rule to the same resolved value, so the two layers agree.
            if (deadlineMs > PROXY_NO_DEADLINE_MS) {
              // A permission prompt still open in opencode extends it; see
              // `ProxyDeadlineGuard`. The broker logs that, not this layer.
              timer = armProxyDeadline({
                callId,
                toolName,
                deadlineMs,
                onExpire: () => {
                  if (!pending.has(callId)) return
                  pending.delete(callId)
                  log.notice("proxy-mcp tool call timed out", {
                    callId,
                    toolName,
                    deadlineMs,
                  })
                  reject(buildProxyTimeoutError(toolName, deadlineMs))
                },
              })
            }
            calls.emit("call", entry)
          },
        ).finally(() => {
          timer?.cancel()
          pending.delete(callId)
        })

        if (channel.closed) {
          // Nobody is reading. The language model already saw the closed
          // channel and hands the result to Claude another way.
          log.notice("proxy-mcp dropping result for a closed tool call", {
            callId,
            toolName,
          })
          return
        }
        writeToolCallResult(res, requestId, result, reply)
        return
      }

      writeJson(res, {
        jsonrpc: "2.0",
        id: requestId,
        error: { code: -32601, message: `Unknown method: ${request.method}` },
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const logFn = isExpectedCleanupError(errorMessage) ? log.notice : log.warn
      logFn("proxy-mcp error handling request", {
        error: errorMessage,
      })
      // Broker rejections (timeouts, orphans, server close) surface here for
      // tools/call requests. Same rule as above: respond with an MCP result
      // carrying isError, never a JSON-RPC error envelope, or Claude CLI
      // rejects the response as schema-invalid.
      if (requestMethod === "tools/call") {
        try {
          writeToolCallResult(
            res,
            requestId,
            { kind: "error", message: errorMessage },
            reply,
          )
        } catch {
          try {
            res.statusCode = 500
            res.end()
          } catch {}
        }
        return
      }
      try {
        // tools/call already returned above with an MCP result; anything
        // reaching here is a protocol-level method (initialize, tools/list)
        // where a JSON-RPC error is the correct shape.
        writeJson(res, {
          jsonrpc: "2.0",
          id: requestId,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal error",
          },
        })
      } catch {
        try {
          res.statusCode = 500
          res.end()
        } catch {}
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })

  const addr = server.address() as AddressInfo | null
  if (!addr) {
    server.close()
    throw new Error("Failed to bind proxy MCP server")
  }

  boundAuthority = `127.0.0.1:${addr.port}`
  const url = `http://${boundAuthority}/mcp`

  // NOTE: authToken is deliberately absent from this line and every other
  // log call. The plugin log is written to disk and echoed to the TUI in
  // debug mode; a leaked token there would defeat the whole mechanism.
  log.info("proxy-mcp server started", {
    url,
    tools: tools.map((t) => t.name),
  })

  let configFilePath: string | null = null

  const api: ProxyMcpServer = {
    url,
    serverName: SERVER_NAME,
    tools,
    authToken,
    calls,
    configPath() {
      if (configFilePath) return configFilePath
      const body = JSON.stringify(
        {
          mcpServers: {
            [SERVER_NAME]: {
              type: "http",
              url,
              // Claude CLI replays these headers on every request to this
              // server, which is what lets the handler above reject anyone
              // who did not read this 0600 file.
              headers: { Authorization: `Bearer ${authToken}` },
              timeout: resolveProxyClientCeilingMs(timeoutOverrides),
            },
          },
        },
        null,
        2,
      )
      const hash = crypto
        .createHash("sha256")
        .update(body)
        .digest("hex")
        .slice(0, 12)
      const outPath = path.join(
        pluginTmpDir(),
        `proxy-${hash}.json`,
      )
      fs.writeFileSync(outPath, body, { encoding: "utf8", mode: 0o600 })
      configFilePath = outPath
      return outPath
    },
    pendingCallIds() {
      return [...pending.keys()]
    },
    async close() {
      for (const entry of pending.values()) {
        entry.reject(new Error(SERVER_CLOSED_MESSAGE))
      }
      pending.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      if (configFilePath) {
        try {
          fs.unlinkSync(configFilePath)
        } catch {}
        configFilePath = null
      }
    },
  }

  return api
}

/** CLI-ready list of Claude tool names to disable, for each proxied tool. */
export function disallowedToolFlags(tools: ProxyToolDef[]): string[] {
  // Map our lowercase MCP tool names to the Claude tool name(s) they replace.
  // `edit` covers both `Edit` and `MultiEdit` because opencode has no
  // MultiEdit equivalent; without disabling MultiEdit, Claude can batch
  // file changes through it and bypass opencode's permission UI.
  // `task` disables Claude CLI's `Agent` tool (its built-in subagent
  // dispatcher) so subagent calls flow through opencode's `task` tool
  // instead — which lets opencode's configured subagent set (`build`,
  // `general`, custom subagents in opencode.json) execute the work
  // under opencode's permission/lifecycle, rather than Claude's
  // internal-only general-purpose / Explore / Plan options.
  const nameMap: Record<string, string[]> = {
    bash: ["Bash"],
    read: ["Read"],
    write: ["Write"],
    edit: ["Edit", "MultiEdit"],
    glob: ["Glob"],
    grep: ["Grep"],
    webfetch: ["WebFetch"],
    task: ["Agent"],
    task_batch: ["Agent"],
    // `question` disables Claude Code's built-in `AskUserQuestion` so the
    // structured-questions path flows through opencode's native `question`
    // tool instead — same UI/permission/audit benefits as the other
    // proxies. Without this, the model can call both and the two paths
    // diverge (opencode's form vs the headless deny-and-render fallback).
    question: ["AskUserQuestion"],
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of tools) {
    const mapped = nameMap[t.name.toLowerCase()]
    if (!mapped) continue
    for (const claudeTool of mapped) {
      if (seen.has(claudeTool)) continue
      seen.add(claudeTool)
      out.push(claudeTool)
    }
  }
  return out
}

/**
 * Everything that goes to `--disallowedTools` for one spawn: the built-ins
 * the proxied tools replace, plus the ones the operator named directly.
 *
 * `disallowedToolFlags` can only cover tools the plugin has a proxy for, so
 * a built-in with no equivalent (`NotebookEdit`, and anything Claude Code
 * ships next) is unreachable without `extraDisallowedTools` — issue #26.
 */
export function resolveDisallowedTools(options: {
  proxyTools?: ProxyToolDef[] | null
  extraDisallowedTools?: string[]
  disableWebSearch?: boolean
}): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (name: string) => {
    const trimmed = name.trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    out.push(trimmed)
  }

  for (const name of disallowedToolFlags(options.proxyTools ?? [])) push(name)
  for (const name of options.extraDisallowedTools ?? []) push(String(name))
  if (options.disableWebSearch) push("WebSearch")
  return out
}

/** The shape of one `client.tool.list()` entry this resolver needs. */
export interface OpencodeToolListEntry {
  id: string
  description?: string
  parameters?: unknown
}

/**
 * Build proxy defs for the opencode tools named in `proxyOpencodeTools`.
 *
 * `resolvedProxyMcpTools` only forwards a tool whose id matches an enabled
 * MCP server (`<server>` or `<server>_<tool>`), so a tool another opencode
 * plugin declares directly matches nothing and is dropped. opencode-dcp's
 * `compress` is the case that motivated this: it is in opencode's registry,
 * dcp tells the model "you MUST use the `compress` tool now", and under this
 * provider the model was never offered it. This is the explicit allowlist
 * that forwards such a tool. It is deliberately never automatic: these run
 * inside opencode with the caller's permissions, so which ones cross over is
 * the operator's decision.
 *
 * A name already held by another proxy def wins, and the forwarded entry is
 * dropped with a warning. That is not arbitrary: `ensureProxyServer`
 * registers interceptors by name and an intercepted call is answered
 * in-process, so a forwarded def sharing a name with an intercepted one
 * (`compress` again) could never reach opencode at all. Dropping it loudly
 * is the difference between documented precedence and a silent shadow.
 */
export function resolveProxyOpencodeToolDefs(options: {
  requested?: readonly string[]
  items?: readonly OpencodeToolListEntry[]
  taken?: ReadonlySet<string>
}): ProxyToolDef[] {
  const requested = options.requested ?? []
  if (requested.length === 0) return []

  const items = options.items
  if (!items) {
    log.warn(
      "proxyOpencodeTools is set but opencode's tool registry did not answer;" +
        " forwarding nothing this spawn",
      { requested: requested.map(String) },
    )
    return []
  }

  const byLowerId = new Map<string, OpencodeToolListEntry>()
  for (const item of items) {
    const key = item.id.toLowerCase()
    if (!byLowerId.has(key)) byLowerId.set(key, item)
  }

  const taken = options.taken ?? new Set<string>()
  const out: ProxyToolDef[] = []
  const seen = new Set<string>()
  const unknown: string[] = []
  const collided: string[] = []

  for (const raw of requested) {
    const name = String(raw).trim()
    if (!name) continue
    const item = byLowerId.get(name.toLowerCase())
    if (!item) {
      unknown.push(name)
      continue
    }
    if (taken.has(item.id)) {
      collided.push(item.id)
      continue
    }
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push({
      name: item.id,
      description: typeof item.description === "string" ? item.description : "",
      inputSchema:
        item.parameters && typeof item.parameters === "object"
          ? (item.parameters as Record<string, unknown>)
          : { type: "object", properties: {} },
    })
  }

  // Same reasoning as the `proxyTools` typo warning: an unrecognised name is
  // simply not forwarded, and silence looks from the outside like the option
  // was ignored.
  if (unknown.length > 0) {
    log.warn("ignoring unknown proxyOpencodeTools entries", {
      unknown,
      known: [...byLowerId.values()].map((item) => item.id).join(", "),
    })
  }
  if (collided.length > 0) {
    log.warn(
      "proxyOpencodeTools entry dropped: a proxy tool already holds that name," +
        " and it keeps it",
      { collided },
    )
  }
  return out
}

/** One entry of the AI SDK `tools` array opencode hands `doStream`. */
export interface ModelToolEntry {
  type?: string
  name?: string
  description?: string
  inputSchema?: unknown
}

/** What `resolveMcpProxyToolDefs` found, split by the two things callers need. */
export interface McpProxyToolResolution {
  /** One def per MCP tool that will be served from the proxy instead. */
  defs: ProxyToolDef[]
  /** Only the servers a def was actually built for. */
  coveredServers: Set<string>
}

/**
 * Build proxy defs for opencode's MCP-backed tools out of the tool array
 * opencode already passes to `doStream`.
 *
 * The discovery source matters, and it is the whole reason this function
 * exists. The obvious source, `client.tool.list()` behind
 * `/experimental/tool`, enumerates opencode's `ToolRegistry` only: built-ins
 * plus plugin-declared tools. MCP tools are not in that registry on 1.18.31,
 * they are merged into the model's tool set afterwards, so a registry-based
 * match finds nothing however the prefix rule is written. The AI SDK `tools`
 * argument is downstream of that merge, so it is the one place a provider
 * plugin can see them at all.
 *
 * Matching is still by enabled-server prefix, longest name first so
 * `slack_intl_*` resolves to `slack_intl` and not `slack`. That is
 * deliberately narrow: everything else in the array is a built-in or another
 * plugin's tool, and forwarding those wholesale is what the explicit
 * `proxyOpencodeTools` allowlist is for.
 */
export function resolveMcpProxyToolDefs(options: {
  serverNames: readonly string[]
  tools?: readonly ModelToolEntry[]
  taken?: ReadonlySet<string>
}): McpProxyToolResolution {
  const empty: McpProxyToolResolution = { defs: [], coveredServers: new Set() }
  const serverNames = options.serverNames ?? []
  if (serverNames.length === 0) return empty

  const tools = options.tools
  if (!tools || tools.length === 0) return empty

  const serversByLengthDesc = [...serverNames].sort((a, b) => b.length - a.length)
  const taken = options.taken ?? new Set<string>()
  const defs: ProxyToolDef[] = []
  const coveredServers = new Set<string>()
  const seen = new Set<string>()
  const collided: string[] = []

  for (const tool of tools) {
    // opencode only ever puts plain function tools in this array; a
    // provider-defined entry has no opencode executor behind it, so
    // forwarding one would produce a call nothing can answer.
    if (tool?.type !== undefined && tool.type !== "function") continue
    const name = typeof tool?.name === "string" ? tool.name.trim() : ""
    if (!name) continue

    const matchedServer = serversByLengthDesc.find(
      (server) => name === server || name.startsWith(`${server}_`),
    )
    if (!matchedServer) continue
    if (seen.has(name)) continue
    if (taken.has(name)) {
      collided.push(name)
      continue
    }
    seen.add(name)
    coveredServers.add(matchedServer)
    defs.push({
      name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema:
        tool.inputSchema && typeof tool.inputSchema === "object"
          ? (tool.inputSchema as Record<string, unknown>)
          : { type: "object", properties: {} },
    })
  }

  if (collided.length > 0) {
    // WARN, not NOTICE: only warn and error are alwaysStderr in src/logger.ts,
    // and a shadowed MCP tool silently stops being routed through opencode,
    // which is exactly the class of surprise this lane exists to end.
    log.warn(
      "MCP tool not routed through the proxy: another proxy tool already holds" +
        " that name, and it keeps it",
      { collided },
    )
  }
  return { defs, coveredServers }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

/**
 * The single exit for every `tools/call`, broker-backed or intercepted.
 * Success and failure share one MCP result envelope: a JSON-RPC error for
 * `kind: "error"` was rejected by Claude CLI as a "malformed result that
 * failed schema validation", so tool failures must surface as
 * `isError: true` instead.
 */
function writeToolCallResult(
  res: ServerResponse,
  requestId: unknown,
  result: ProxyToolResult,
  reply: ReplyStream | null = null,
): void {
  const text = result.kind === "error" ? result.message : result.text
  const isError = result.kind === "error" || result.isError === true
  const envelope = {
    jsonrpc: "2.0",
    id: requestId ?? null,
    result: {
      content: [{ type: "text", text }],
      isError,
    },
  }
  if (reply) {
    reply.finish(envelope)
    return
  }
  writeJson(res, envelope)
}

/**
 * An in-flight streamed reply whose headers are already on the wire.
 * `finish` writes the JSON-RPC response and ends the body; `stop` only
 * cancels the keepalive, for when the client went away first.
 */
interface ReplyStream {
  finish(envelope: unknown): void
  stop(): void
}

/**
 * Write `ping` every `keepaliveMs` until stopped or the response is gone.
 * Never keeps the host process alive on its own.
 */
function startKeepalive(
  res: ServerResponse,
  keepaliveMs: number,
  ping: string,
): () => void {
  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      stop()
      return
    }
    res.write(ping)
  }, keepaliveMs)
  timer.unref?.()
  const stop = () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }
  return stop
}

/**
 * SSE reply: the JSON-RPC response goes out as the single `message` event,
 * which is what the MCP Streamable HTTP client expects for a request
 * answered over SSE.
 */
function openEventStream(res: ServerResponse, keepaliveMs: number): ReplyStream {
  res.statusCode = 200
  res.setHeader("Content-Type", "text/event-stream")
  res.setHeader("Cache-Control", "no-cache, no-transform")
  res.setHeader("Connection", "keep-alive")
  res.flushHeaders()
  // Start the response body without waiting for the tool result.
  res.write(": open\n\n")
  const stop = startKeepalive(res, keepaliveMs, ": keepalive\n\n")
  return {
    stop,
    finish(envelope) {
      stop()
      if (res.writableEnded || res.destroyed) return
      res.end(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`)
    },
  }
}

/**
 * JSON reply for a client that did not ask for SSE (@broskees' 68ed142,
 * adapted). Headers are flushed at once, which stops the client's header
 * timer, and whitespace is written on the keepalive cadence, which stops its
 * body timer. There is no `Content-Length`, so the body is chunked, and the
 * envelope is written last: whitespace before a JSON value is insignificant
 * (RFC 8259), so the whole body still parses as the one JSON-RPC response,
 * on success and on error alike.
 */
function openJsonStream(res: ServerResponse, keepaliveMs: number): ReplyStream {
  res.statusCode = 200
  res.setHeader("Content-Type", "application/json")
  res.setHeader("Cache-Control", "no-cache, no-transform")
  res.flushHeaders()
  const stop = startKeepalive(res, keepaliveMs, " ")
  return {
    stop,
    finish(envelope) {
      stop()
      if (res.writableEnded || res.destroyed) return
      res.end(JSON.stringify(envelope))
    },
  }
}

function writeJson(res: ServerResponse, body: unknown): void {
  if (res.destroyed || res.writableEnded) return
  const payload = JSON.stringify(body)
  res.statusCode = 200
  res.setHeader("Content-Type", "application/json")
  res.setHeader("Content-Length", Buffer.byteLength(payload).toString())
  res.end(payload)
}
