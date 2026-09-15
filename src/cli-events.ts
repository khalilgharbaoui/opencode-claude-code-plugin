import { log } from "./logger.js"
import type { ClaudeStreamMessage } from "./types.js"

/**
 * Claude CLI stream events the plugin used to drop on the floor.
 *
 * Every shape below was read out of the CLI's own zod schemas in the installed
 * bundle (`rg -a` over `~/.local/share/claude/versions/<v>`) on 2.1.263, not
 * guessed, but they are still parsed defensively: a future CLI may rename a
 * field, and a diagnostic that throws is worse than one that stays quiet.
 *
 * Levels follow the rule the rest of this codebase uses. `src/logger.ts` routes
 * only WARN and ERROR to stderr unconditionally, so anything the user has to
 * see without turning on debug logging is either a WARN or a `▌` line written
 * into the transcript. Everything else is INFO or NOTICE for the file log.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

// ---------------------------------------------------------------------------
// rate_limit_event
// ---------------------------------------------------------------------------

/**
 * `{type:"rate_limit_event", rate_limit_info:{...}}`, emitted whenever the
 * CLI's view of the account's limits changes. `status` is the plan window,
 * `overageStatus` is paid extra usage on top of it; either can be `rejected`
 * on its own, so both are read.
 */
export interface RateLimitInfo {
  status?: string
  rateLimitType?: string
  resetsAt?: number
  utilization?: number
  isUsingOverage?: boolean
  overageStatus?: string
  overageResetsAt?: number
  overageDisabledReason?: string
}

export const RATE_LIMIT_MARKER = "▌ **rate limit:**"

/**
 * What the operator can actually do about it. Same four levers the billing
 * note in AGENTS.md lists, which is where this wording comes from: none of
 * them is something the plugin may do on its own.
 */
export const RATE_LIMIT_ACTION =
  "Enable extra usage or add credits on the account, wait for the window to reset, switch account, org or plan, or authenticate with an API key."

const OVERAGE_DISABLED_REASONS: Record<string, string> = {
  overage_not_provisioned: "extra usage is not set up on this account",
  org_level_disabled: "extra usage is disabled for your organization",
  org_level_disabled_until: "extra usage is disabled for your organization for now",
  out_of_credits: "the account's usage credits are spent",
  seat_tier_level_disabled: "your seat tier does not allow extra usage",
  member_level_disabled: "extra usage is disabled for your member account",
  seat_tier_zero_credit_limit: "your seat tier has a zero credit limit",
  group_zero_credit_limit: "your group has a zero credit limit",
  member_zero_credit_limit: "your member account has a zero credit limit",
  org_service_level_disabled: "your organization's service level does not include extra usage",
  no_limits_configured: "no usage limits are configured for this account",
  fetch_error: "the CLI could not read the account's usage limits",
}

const RATE_LIMIT_WINDOWS: Record<string, string> = {
  five_hour: "the 5-hour window",
  seven_day: "the 7-day window",
  seven_day_opus: "the 7-day Opus window",
  seven_day_sonnet: "the 7-day Sonnet window",
  seven_day_overage_included: "the 7-day extra-usage window",
  overage: "extra usage",
}

export function parseRateLimitEvent(msg: ClaudeStreamMessage): RateLimitInfo | null {
  if (msg.type !== "rate_limit_event") return null
  const info = (msg as { rate_limit_info?: unknown }).rate_limit_info
  if (!isRecord(info)) return null
  return {
    status: str(info.status),
    rateLimitType: str(info.rateLimitType),
    resetsAt: num(info.resetsAt),
    utilization: num(info.utilization),
    isUsingOverage: info.isUsingOverage === true,
    overageStatus: str(info.overageStatus),
    overageResetsAt: num(info.overageResetsAt),
    overageDisabledReason: str(info.overageDisabledReason),
  }
}

/** The CLI sends unix seconds; tolerate milliseconds rather than print 1970. */
export function formatResetsAt(resetsAt: number | undefined): string | undefined {
  if (resetsAt === undefined) return undefined
  const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** Dedup identity: one warning per (window, overage status, reason) per process. */
export function rateLimitKey(info: RateLimitInfo): string {
  return [
    info.status ?? "?",
    info.rateLimitType ?? "?",
    info.overageStatus ?? "?",
    info.overageDisabledReason ?? "?",
  ].join("|")
}

export function isRateLimitRejected(info: RateLimitInfo): boolean {
  return info.status === "rejected" || info.overageStatus === "rejected"
}

export interface RateLimitReport {
  key: string
  level: "warn" | "notice" | "info"
  message: string
  /** Text to put in the transcript, or null when this is log-only. */
  transcript: string | null
}

/**
 * A rejection is the only state the user has to act on, so it is the only one
 * that gets a WARN and a transcript line. A warning state is a NOTICE: it is
 * real but not yet blocking, and a per-turn TUI bubble for "you are at 82%"
 * would train people to ignore the blocking one.
 */
export function describeRateLimit(info: RateLimitInfo): RateLimitReport | null {
  if (!info.status && !info.overageStatus) return null
  const window = info.rateLimitType ? RATE_LIMIT_WINDOWS[info.rateLimitType] ?? info.rateLimitType : undefined
  const resets = formatResetsAt(info.resetsAt)
  const overageResets = formatResetsAt(info.overageResetsAt)
  const key = rateLimitKey(info)

  if (isRateLimitRejected(info)) {
    const parts: string[] = []
    parts.push(
      info.status === "rejected"
        ? `Claude Code rejected this request: you are out of usage${window ? ` in ${window}` : ""}.`
        : "Claude Code rejected this request: paid extra usage is not available on this account.",
    )
    const reason = info.overageDisabledReason
      ? OVERAGE_DISABLED_REASONS[info.overageDisabledReason] ?? info.overageDisabledReason
      : undefined
    if (reason) parts.push(`Extra usage is unavailable because ${reason}.`)
    const resetAt = resets ?? overageResets
    if (resetAt) parts.push(`Resets at ${resetAt}.`)
    parts.push(RATE_LIMIT_ACTION)
    const message = parts.join(" ")
    return { key, level: "warn", message, transcript: `\n${RATE_LIMIT_MARKER} ${message}\n` }
  }

  if (info.status === "allowed_warning" || info.overageStatus === "allowed_warning") {
    const used =
      info.utilization === undefined ? "" : ` (${Math.round(info.utilization * 100)}% used)`
    return {
      key,
      level: "notice",
      message: `Approaching the usage limit${window ? ` for ${window}` : ""}${used}${
        resets ? `, resets at ${resets}` : ""
      }.`,
      transcript: null,
    }
  }

  return {
    key,
    level: "info",
    message: `usage limits updated${window ? ` for ${window}` : ""}`,
    transcript: null,
  }
}

const reportedRateLimits = new Set<string>()

/** Test-only. */
export function _resetRateLimitReports(): void {
  reportedRateLimits.clear()
}

/**
 * Logs the event and returns the transcript line to enqueue, if any. Deduped
 * per identity per process: the CLI re-emits the same rejection on every
 * subsequent request, and a repeated WARN would bury the first one.
 */
export function reportRateLimitEvent(msg: ClaudeStreamMessage): string | null {
  const info = parseRateLimitEvent(msg)
  if (!info) return null
  const report = describeRateLimit(info)
  if (!report) return null
  const data: Record<string, unknown> = { ...info }
  if (reportedRateLimits.has(report.key)) {
    log.debug(report.message, data)
    return null
  }
  reportedRateLimits.add(report.key)
  log[report.level](report.message, data)
  return report.transcript
}

// ---------------------------------------------------------------------------
// system / init
// ---------------------------------------------------------------------------

export interface SystemInitInfo {
  apiKeySource?: string
  permissionMode?: string
  model?: string
  cliVersion?: string
  toolCount: number
  mcpServers: Array<{ name: string; status: string }>
}

/**
 * Credential sources that mean the CLI authenticated with an API key rather
 * than the logged-in subscription, so the turn bills pay-as-you-go against the
 * Console account and never touches the plan's Agent SDK credit. `oauth` is
 * the subscription and `none` is no credential at all; everything else in the
 * CLI's enum is a key from some scope.
 */
export const API_KEY_SOURCES = new Set([
  "ANTHROPIC_API_KEY",
  "apiKeyHelper",
  "/login managed key",
  "user",
  "project",
  "org",
  "temporary",
])

export function parseSystemInit(msg: ClaudeStreamMessage): SystemInitInfo | null {
  if (msg.type !== "system" || msg.subtype !== "init") return null
  const raw = msg as unknown as Record<string, unknown>
  const servers: Array<{ name: string; status: string }> = []
  if (Array.isArray(raw.mcp_servers)) {
    for (const entry of raw.mcp_servers) {
      if (!isRecord(entry)) continue
      servers.push({ name: str(entry.name) ?? "unknown", status: str(entry.status) ?? "unknown" })
    }
  }
  return {
    apiKeySource: str(raw.apiKeySource),
    permissionMode: str(raw.permissionMode),
    model: str(raw.model),
    cliVersion: str(raw.claude_code_version),
    toolCount: Array.isArray(raw.tools) ? raw.tools.length : 0,
    mcpServers: servers,
  }
}

/**
 * The warning text for an API-key session, or null when there is nothing to
 * say. Kept pure and separate from the dedup so both halves are testable.
 *
 * `ignoreAnthropicApiKey` strips the env vars from the spawn, so a key still
 * in effect after that came from the CLI's own settings and the option is not
 * the fix; saying so is the whole point of reading this field rather than
 * `process.env`, which only sees one of the two ways a key gets in.
 */
export function apiKeySourceWarning(
  apiKeySource: string | undefined,
  ignoreAnthropicApiKey: boolean | undefined,
): string | null {
  if (!apiKeySource || !API_KEY_SOURCES.has(apiKeySource)) return null
  const base = `Claude Code authenticated with an API key (apiKeySource: ${apiKeySource}), so these turns bill as pay-as-you-go API usage instead of your subscription's Agent SDK credit.`
  return ignoreAnthropicApiKey
    ? `${base} \`ignoreAnthropicApiKey\` is already on, so the key is not coming from the environment: check the CLI's own settings (\`claude config\`) or an \`apiKeyHelper\`.`
    : `${base} Set the provider option \`ignoreAnthropicApiKey: true\` to strip the key from spawns and fall back to the stored subscription auth.`
}

const warnedApiKeySources = new Set<string>()
const warnedMcpFailures = new Set<string>()

/** Test-only. */
export function _resetSystemInitReports(): void {
  warnedApiKeySources.clear()
  warnedMcpFailures.clear()
}

/**
 * Log the CLI's own view of the session it just started, and warn about the
 * two things in it a user has to act on: a credential that changes who gets
 * billed, and an MCP server that did not come up (the model simply will not
 * have those tools, with no other sign of it).
 */
export function reportSystemInit(
  msg: ClaudeStreamMessage,
  options: { ignoreAnthropicApiKey?: boolean } = {},
): void {
  const info = parseSystemInit(msg)
  if (!info) return
  log.info("claude session init", {
    apiKeySource: info.apiKeySource ?? null,
    permissionMode: info.permissionMode ?? null,
    model: info.model ?? null,
    cliVersion: info.cliVersion ?? null,
    tools: info.toolCount,
    mcpServers: info.mcpServers,
  })

  for (const server of info.mcpServers) {
    if (server.status === "connected") continue
    const key = `${server.name}:${server.status}`
    const message = `MCP server "${server.name}" is ${server.status} in Claude Code; its tools are not available to the model this session.`
    if (warnedMcpFailures.has(key)) {
      log.debug(message, { server: server.name, status: server.status })
      continue
    }
    warnedMcpFailures.add(key)
    log.warn(message, { server: server.name, status: server.status })
  }

  const apiKeyMessage = apiKeySourceWarning(info.apiKeySource, options.ignoreAnthropicApiKey)
  if (!apiKeyMessage) return
  const key = `${info.apiKeySource}:${options.ignoreAnthropicApiKey ? "ignored" : "passed"}`
  if (warnedApiKeySources.has(key)) {
    log.debug(apiKeyMessage, { apiKeySource: info.apiKeySource })
    return
  }
  warnedApiKeySources.add(key)
  log.warn(apiKeyMessage, { apiKeySource: info.apiKeySource })
}

// ---------------------------------------------------------------------------
// system / compact_boundary
// ---------------------------------------------------------------------------

export const COMPACT_BOUNDARY_MARKER = "▌ **context compacted:**"

export interface CompactBoundary {
  trigger: string
  preTokens?: number
  postTokens?: number
}

/**
 * The CLI compacted its own context mid-conversation. Nothing in opencode
 * shows this today, so a conversation can silently lose everything before the
 * boundary and the next answer just looks forgetful.
 *
 * Field name confirmed on CLI 2.1.263: the stream schema emits
 * `compact_metadata`, while the CLI's own transcript reader uses
 * `compactMetadata`. Both are read, because it costs one line and the two
 * spellings genuinely coexist inside the binary.
 */
export function parseCompactBoundary(msg: ClaudeStreamMessage): CompactBoundary | null {
  if (msg.type !== "system" || msg.subtype !== "compact_boundary") return null
  const raw = msg as unknown as Record<string, unknown>
  const meta = isRecord(raw.compact_metadata)
    ? raw.compact_metadata
    : isRecord(raw.compactMetadata)
      ? raw.compactMetadata
      : undefined
  return {
    trigger: str(meta?.trigger) ?? "unknown",
    preTokens: num(meta?.pre_tokens) ?? num(meta?.preTokens),
    postTokens: num(meta?.post_tokens) ?? num(meta?.postTokens),
  }
}

export function formatCompactBoundaryNote(boundary: CompactBoundary): string {
  const how = boundary.trigger === "auto" ? "on its own" : `on a ${boundary.trigger} request`
  const sizes =
    boundary.preTokens !== undefined && boundary.postTokens !== undefined
      ? ` (${boundary.preTokens.toLocaleString("en-US")} tokens to ${boundary.postTokens.toLocaleString("en-US")})`
      : ""
  return `\n${COMPACT_BOUNDARY_MARKER} Claude Code compacted its own context ${how}${sizes}. Earlier detail in this conversation is now a summary.\n`
}

/** Logs the boundary and returns the transcript note, or null when not one. */
export function reportCompactBoundary(msg: ClaudeStreamMessage): string | null {
  const boundary = parseCompactBoundary(msg)
  if (!boundary) return null
  log.notice("claude code compacted its own context", {
    trigger: boundary.trigger,
    preTokens: boundary.preTokens ?? null,
    postTokens: boundary.postTokens ?? null,
  })
  return formatCompactBoundaryNote(boundary)
}

// ---------------------------------------------------------------------------
// result subtype
// ---------------------------------------------------------------------------

export const RESULT_ERROR_MARKER = "▌ **claude code error:**"

const RESULT_SUBTYPES: Record<string, string> = {
  error_max_turns: "it hit its internal turn limit before finishing",
  error_during_execution: "it failed while running the turn",
  error_max_budget_usd: "it hit the configured spend limit for the turn",
  error_max_structured_output_retries: "it could not produce valid structured output",
}

/**
 * A `result` whose subtype is not `success` is a failed turn, and until now it
 * finished as a clean `stop`: opencode recorded it as a normal reply and the
 * only trace of the subtype was a debug log line.
 *
 * This is the with-result case only. A CLI that dies without emitting a
 * `result` at all is a different failure, handled elsewhere.
 */
export function describeResultFailure(msg: ClaudeStreamMessage): string | null {
  if (msg.type !== "result") return null
  const subtype = msg.subtype
  if (!subtype || subtype === "success") return null
  const explanation = RESULT_SUBTYPES[subtype]
  return explanation
    ? `Claude Code ended the turn with \`${subtype}\`: ${explanation}.`
    : `Claude Code ended the turn with \`${subtype}\`.`
}

export function formatResultFailureNote(message: string): string {
  return `\n${RESULT_ERROR_MARKER} ${message}\n`
}
