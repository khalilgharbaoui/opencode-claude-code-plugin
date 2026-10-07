import { log } from "./logger.js"
import { PROXY_MCP_SERVER_NAME, SKILL_PLUGIN_NAME, type ClaudeStreamMessage } from "./types.js"

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

/**
 * Nothing writes this any more (see `describeRateLimit`), but it stays in
 * `PLUGIN_NOTE_MARKERS`: a conversation that was open before the upgrade still
 * holds blocks led by it, and replaying one back to Claude as its own words is
 * exactly what that list exists to prevent.
 */
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

/** The CLI sends unix seconds; tolerate milliseconds rather than mean 1970. */
export function resetsAtToMs(resetsAt: number | undefined): number | undefined {
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return undefined
  return resetsAt < 1e12 ? resetsAt * 1000 : resetsAt
}

export function formatResetsAt(resetsAt: number | undefined): string | undefined {
  const ms = resetsAtToMs(resetsAt)
  if (ms === undefined) return undefined
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** Local time to the minute: `2026-09-22 20:56`. Seconds would be noise. */
export function formatLocalMinute(ms: number): string {
  const when = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, "0")
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}`
  )
}

/**
 * The reset time in the operator's OWN time zone, which is the only form they
 * can act on without doing arithmetic: a UTC instant printed next to "wait for
 * the reset" is the shape the maintainer read as unhelpful on 2026-10-03.
 * `formatResetsAt` stays the UTC form for logs and for the switch form, where
 * an unambiguous instant is what a pasted diagnostic needs.
 */
export function formatResetsAtLocal(resetsAt: number | undefined): string | undefined {
  const ms = resetsAtToMs(resetsAt)
  if (ms === undefined || Number.isNaN(new Date(ms).getTime())) return undefined
  return formatLocalMinute(ms)
}

/** The friendly name of a `rateLimitType`, or the raw token when unknown. */
export function describeRateLimitWindow(
  rateLimitType: string | undefined,
): string | undefined {
  if (!rateLimitType) return undefined
  return RATE_LIMIT_WINDOWS[rateLimitType] ?? rateLimitType
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

/**
 * Whether the CLI refused this request. `status` is the request's own verdict
 * and wins whenever it is present: `overageStatus: "rejected"` on its own only
 * says paid extra usage is unavailable, which is the normal steady state for
 * an org with extra usage disabled. Measured on CLI 2.1.280 (2026-09-23): an
 * event of `{status: "allowed", overageStatus: "rejected",
 * overageDisabledReason: "org_level_disabled"}` arrived on a turn that was
 * served and answered. Treating that as a rejection printed a false "rejected
 * this request" line and, worse, set account failover off on a successful turn.
 * An overage rejection still counts when no status came with it.
 */
export function isRateLimitRejected(info: RateLimitInfo): boolean {
  if (info.status === "rejected") return true
  if (info.status === "allowed" || info.status === "allowed_warning") return false
  return info.overageStatus === "rejected"
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
 * that gets a WARN. A warning state is a NOTICE: it is real but not yet
 * blocking, and a per-turn TUI bubble for "you are at 82%" would train people
 * to ignore the blocking one.
 *
 * Nothing here writes to the transcript any more. This reporter dedupes per
 * identity per process, so the paragraph it used to enqueue appeared on the
 * FIRST limited turn of a process and on none of the others, while the turn's
 * own failure text appeared every time: measured on 2026-10-03, three limited
 * turns in one window produced one five-sentence block and two raw CLI
 * sentences. The operator-facing half is one `▌ **usage limit:**` note per
 * limited turn now, written at the result boundary where the turn knows
 * whether the switch form or the fallback chain is taking it instead
 * (`formatUsageLimitNote`, src/account-failover.ts, h #g194). The WARN and the
 * dedup are unchanged: a log line is for whoever reads the log, and the
 * per-process rule is what keeps one window's repeats from burying the first.
 */
export function describeRateLimit(info: RateLimitInfo): RateLimitReport | null {
  if (!info.status && !info.overageStatus) return null
  const window = describeRateLimitWindow(info.rateLimitType)
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
    return { key, level: "warn", message, transcript: null }
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
  /** `--mcp-config` entries the CLI refused. Empty when the key was omitted. */
  mcpServerErrors: McpServerError[]
  /** Plugins the CLI demoted at load time. Empty when the key was omitted. */
  pluginErrors: PluginDiagnostic[]
  /** Plugin authoring feedback. Empty when the key was omitted. */
  pluginWarnings: PluginDiagnostic[]
  /** Every `plugins[]` entry's `source` and `name`, to tell an advisory warning apart. */
  loadedPlugins: string[]
}

/**
 * One entry of the init frame's optional `plugin_errors` or `plugin_warnings`,
 * `{plugin, type, message}` in both. Read out of the CLI's zod schema on
 * 2.1.280 (`rg -a -o 'plugin_errors:[^;]{0,900}'`):
 *
 *   - `plugin_errors`: "Plugin load-time errors (e.g., unsatisfied dependency
 *     version). Affected plugins are demoted and absent from `plugins[]`."
 *   - `plugin_warnings`: "When `plugin` matches an entry in `plugins[]`, that
 *     plugin loaded and the warning is advisory; warnings with a synthetic
 *     `plugin` source (no matching `plugins[]` entry ...) describe content
 *     that did NOT load."
 *
 * Measured the same day with a `--plugin-dir` whose manifest names a
 * dependency that is not installed: `{"plugin":"probe-dep@inline","type":
 * "dependency-unsatisfied","message":"Dependency ... is not installed ..."}`.
 * `plugin` is `name@source`, the form a loaded entry carries in `source`.
 * The skill bridge stages such a plugin dir, so a bridged skill that fails to
 * load used to disappear with no trace at all.
 */
export interface PluginDiagnostic {
  plugin: string
  type: string
  message: string
}

/**
 * One `--mcp-config` entry Claude Code refused to load, from the optional
 * `mcp_server_errors` key on the `system`/`init` frame.
 *
 * Read out of the CLI's own zod schema on 2.1.280 (`rg -a -o
 * 'mcp_server_errors:k\(u\(\{name:o\(\),type:o\(\),message:o\(\)\}\)\).{0,1400}'`),
 * which documents it as "MCP server config entries from --mcp-config that
 * failed validation and were skipped (e.g. a `url` entry with no `type`).
 * Affected servers are absent from `mcp_servers[]`."
 *
 * That last sentence is the whole reason this needs its own reporter:
 * `reportSystemInit` already warns about a server that came up broken, but a
 * server the CLI skipped is simply not in the list, so until now it was
 * invisible. The plugin writes its own `--mcp-config`, so the entry that goes
 * missing can be the proxy every proxied tool call depends on.
 */
export interface McpServerError {
  name: string
  type: string
  message: string
}

/**
 * The schema calls `type` "a stable category from an open set", names five
 * general categories plus the Remote Control `bridge_carrier_*` family, and
 * says to "treat values you do not recognize as a generic skip". So this maps
 * only what is documented and falls back to the CLI's own sentence, which is
 * already written for a human.
 */
const MCP_SERVER_ERROR_TYPES: Record<string, string> = {
  unknown_type: "its `type` is not one Claude Code knows",
  url_missing_type: "it has a `url` but no `type`",
  invalid_config: "its configuration did not validate",
  reserved_name: "its name is reserved",
}

export function parseMcpServerErrors(msg: ClaudeStreamMessage): McpServerError[] {
  const raw = (msg as unknown as Record<string, unknown>).mcp_server_errors
  if (!Array.isArray(raw)) return []
  const errors: McpServerError[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    errors.push({
      name: str(entry.name) ?? "unknown",
      type: str(entry.type) ?? "unknown",
      message: str(entry.message) ?? "",
    })
  }
  return errors
}

/**
 * What the user has to do about a skipped server. The plugin's own proxy gets
 * its own sentence because the consequence is categorically different: a
 * missing third-party server costs the model some tools, while a missing
 * `opencode_proxy` means every proxied tool call in the session fails and the
 * fix is not in the user's MCP config at all.
 */
export function describeMcpServerError(error: McpServerError): string {
  const why = MCP_SERVER_ERROR_TYPES[error.type]
  const reason = why ? ` because ${why}` : ""
  const detail = error.message ? ` Claude Code said: ${error.message}` : ""
  if (error.name === PROXY_MCP_SERVER_NAME) {
    return (
      `Claude Code skipped the plugin's own MCP server "${error.name}" (${error.type})${reason}, ` +
      "so every proxied tool call this session will fail. This is a plugin bug or a corrupted " +
      `scratch config rather than something in your own MCP settings: report it with this line.${detail}`
    )
  }
  return (
    `Claude Code skipped MCP server "${error.name}" (${error.type})${reason}, so its tools are ` +
    `not available to the model this session. Fix the entry in your MCP config.${detail}`
  )
}

/**
 * Credential sources that mean the CLI authenticated with an API key rather
 * than the logged-in subscription, so the turn bills pay-as-you-go against the
 * Console account and never touches the plan's usage limits. `oauth` is
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
    mcpServerErrors: parseMcpServerErrors(msg),
    pluginErrors: parsePluginDiagnostics(raw.plugin_errors),
    pluginWarnings: parsePluginDiagnostics(raw.plugin_warnings),
    loadedPlugins: parseLoadedPlugins(raw.plugins),
  }
}

function parsePluginDiagnostics(raw: unknown): PluginDiagnostic[] {
  if (!Array.isArray(raw)) return []
  const diagnostics: PluginDiagnostic[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    diagnostics.push({
      plugin: str(entry.plugin) ?? "unknown",
      type: str(entry.type) ?? "unknown",
      message: str(entry.message) ?? "",
    })
  }
  return diagnostics
}

function parseLoadedPlugins(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const loaded: string[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    for (const id of [str(entry.source), str(entry.name)]) {
      if (id && !loaded.includes(id)) loaded.push(id)
    }
  }
  return loaded
}

/**
 * What to tell the user about a plugin that did not load. The bridge's own
 * plugin gets its own sentence for the reason `opencode_proxy` does in
 * `describeMcpServerError`: the plugin writes that directory, so it is never
 * the user's config to fix.
 */
export function describePluginLoadFailure(diagnostic: PluginDiagnostic): string {
  const detail = diagnostic.message ? ` Claude Code said: ${diagnostic.message}` : ""
  const name = diagnostic.plugin.split("@", 1)[0]
  if (name === SKILL_PLUGIN_NAME) {
    return (
      `Claude Code did not load the plugin's own skill bridge "${diagnostic.plugin}" ` +
      `(${diagnostic.type}), so the opencode skills it bridges are missing this session. ` +
      "This is a plugin bug or a corrupted scratch directory rather than your config: " +
      `report it with this line.${detail}`
    )
  }
  return (
    `Claude Code did not load plugin "${diagnostic.plugin}" (${diagnostic.type}), so its ` +
    `skills, commands and MCP servers are missing this session.${detail}`
  )
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
  const base = `Claude Code authenticated with an API key (apiKeySource: ${apiKeySource}), so these turns bill as pay-as-you-go API usage instead of your subscription.`
  return ignoreAnthropicApiKey
    ? `${base} \`ignoreAnthropicApiKey\` is already on, so the key is not coming from the environment: check the CLI's own settings (\`claude config\`) or an \`apiKeyHelper\`.`
    : `${base} Set the provider option \`ignoreAnthropicApiKey: true\` to strip the key from spawns and fall back to the stored subscription auth.`
}

const warnedApiKeySources = new Set<string>()
const warnedMcpFailures = new Set<string>()
const warnedMcpSkips = new Set<string>()

/**
 * The skipped entries this process has seen, newest wins per name, for
 * `/claude-code-doctor`.
 *
 * The WARN below goes to stderr and the log file, and the log file is off by
 * default, so without this the one diagnostic that explains a session full of
 * failing proxy calls is the one nobody can retrieve. Kept keyed by name so a
 * respawn that fixed the config does not leave a stale row.
 */
const lastMcpServerErrors = new Map<string, McpServerError>()

/** A plugin diagnostic that means something did not load, for the doctor. */
export interface PluginLoadFailure extends PluginDiagnostic {
  kind: "error" | "warning"
}

const warnedPluginDiagnostics = new Set<string>()
/** Newest wins per plugin, like `lastMcpServerErrors`, for `/claude-code-doctor`. */
const lastPluginLoadFailures = new Map<string, PluginLoadFailure>()

/** Test-only. */
export function _resetSystemInitReports(): void {
  warnedApiKeySources.clear()
  warnedMcpFailures.clear()
  warnedMcpSkips.clear()
  lastMcpServerErrors.clear()
  warnedPluginDiagnostics.clear()
  lastPluginLoadFailures.clear()
}

/** Read-only view for the doctor. Never touches the dedup sets. */
export function snapshotMcpServerErrors(): McpServerError[] {
  return [...lastMcpServerErrors.values()]
}

/** Read-only view for the doctor. Never touches the dedup sets. */
export function snapshotPluginLoadFailures(): PluginLoadFailure[] {
  return [...lastPluginLoadFailures.values()]
}

/**
 * WARN once per `kind:plugin:type` per process for everything that did not
 * load: every `plugin_errors` entry, and a `plugin_warnings` entry whose plugin
 * is not in `plugins[]`. A warning about a plugin that did load is advisory
 * authoring feedback and stays at INFO.
 */
function reportPluginDiagnostics(info: SystemInitInfo): void {
  const report = (kind: PluginLoadFailure["kind"], diagnostic: PluginDiagnostic) => {
    const loaded = kind === "warning" && info.loadedPlugins.includes(diagnostic.plugin)
    const message = loaded
      ? `Claude Code has advisory feedback for plugin "${diagnostic.plugin}" (${diagnostic.type}): ${diagnostic.message}`
      : describePluginLoadFailure(diagnostic)
    if (!loaded) lastPluginLoadFailures.set(diagnostic.plugin, { kind, ...diagnostic })
    const key = `${kind}:${diagnostic.plugin}:${diagnostic.type}`
    const data = { plugin: diagnostic.plugin, type: diagnostic.type, kind }
    if (warnedPluginDiagnostics.has(key)) {
      log.debug(message, data)
      return
    }
    warnedPluginDiagnostics.add(key)
    if (loaded) log.info(message, data)
    else log.warn(message, data)
  }
  for (const diagnostic of info.pluginErrors) report("error", diagnostic)
  for (const diagnostic of info.pluginWarnings) report("warning", diagnostic)
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
    mcpServerErrors: info.mcpServerErrors,
    pluginErrors: info.pluginErrors,
    pluginWarnings: info.pluginWarnings,
  })

  reportPluginDiagnostics(info)

  // A skipped entry first, because it is the one failure mode with no other
  // trace: the server is missing from `mcp_servers` rather than listed broken.
  for (const error of info.mcpServerErrors) {
    lastMcpServerErrors.set(error.name, error)
    const key = `${error.name}:${error.type}`
    const message = describeMcpServerError(error)
    if (warnedMcpSkips.has(key)) {
      log.debug(message, { server: error.name, type: error.type })
      continue
    }
    warnedMcpSkips.add(key)
    log.warn(message, { server: error.name, type: error.type })
  }

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
// conversation_reset
// ---------------------------------------------------------------------------

export const CONVERSATION_RESET_MARKER = "▌ **claude code reset:**"

export interface ConversationReset {
  newConversationId: string
  /** The session the reset ended; the next `system/init` carries the new one. */
  previousSessionId?: string
}

/**
 * Claude Code threw its conversation away and started a new one. Schema from
 * Claude Code 2.1.280: `{type: "conversation_reset", new_conversation_id,
 * uuid, session_id}`, emitted by `/clear`, plan-mode exit and fresh-session
 * flows. Measured the same day by driving the real CLI: an ordinary turn emits
 * none, and `/clear` emits one carrying the OLD `session_id`, followed by a
 * `system/init` with a new session id that differs from `new_conversation_id`,
 * after which Claude could not recall the conversation. A frame without a
 * string `new_conversation_id` is ignored, as the CLI's own adapter drops it.
 */
export function parseConversationReset(msg: ClaudeStreamMessage): ConversationReset | null {
  if (msg.type !== "conversation_reset") return null
  const newConversationId = str(msg.new_conversation_id)
  if (!newConversationId) return null
  return { newConversationId, previousSessionId: str(msg.session_id) }
}

/**
 * Deliberately a note and not a history replay: every known trigger is a
 * clear the user or Claude Code asked for, and replaying opencode's transcript
 * on the next message would silently undo it.
 */
export function formatConversationResetNote(): string {
  return `\n${CONVERSATION_RESET_MARKER} Claude Code cleared its conversation, so from here on Claude does not see the earlier messages this chat still shows. Start a new opencode session for a clean slate, or restate what matters.\n`
}

/** Logs the reset and returns the transcript note, or null when not one. */
export function reportConversationReset(msg: ClaudeStreamMessage): string | null {
  const reset = parseConversationReset(msg)
  if (!reset) return null
  log.notice("claude code reset its conversation", {
    newConversationId: reset.newConversationId,
    previousSessionId: reset.previousSessionId ?? null,
  })
  return formatConversationResetNote()
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

/**
 * What a failed compaction turn says, as the message of the `error` stream
 * part that ends it. Never written into the conversation: a compaction turn's
 * text is what opencode stores as the summary, which is the whole of issue #90
 * (a usage limit was stored as the summary and every later session started
 * from it). The cause is `TurnState.resultFailure`, so it is the account-block
 * kind, `usage_limit`, a failing result subtype, or a bare `error`; `detail` is
 * the CLI's own sentence when there was one. (h #g214)
 */
export function formatCompactionFailure(
  cause: string,
  detail: string | null | undefined,
): string {
  const said = detail?.trim()
  return (
    `Claude Code could not compact this conversation (${cause}), ` +
    "so no summary was produced." +
    (said ? ` The CLI said: ${said}` : "")
  )
}

// ---------------------------------------------------------------------------
// stdout silence after content
// ---------------------------------------------------------------------------

export const STREAM_TIMEOUT_MARKER = "▌ **stream timeout:**"

/**
 * The inactivity watchdog in `doStream` closes a turn whose CLI produced
 * output and then stopped talking without sending a `result`. That decision
 * was log-only, so the operator saw a reply that simply stopped mid-thought
 * with nothing saying why. This is the note that says it.
 */
export function formatStreamTimeoutNote(silenceMs: number): string {
  const seconds = Math.max(1, Math.round(silenceMs / 1000))
  return (
    `\n${STREAM_TIMEOUT_MARKER} The Claude Code CLI produced output and then went ` +
    `silent for ${seconds}s without finishing the turn, so it was closed without a ` +
    "result. The answer above may be incomplete.\n"
  )
}

// ---------------------------------------------------------------------------
// a turn that succeeded without saying anything
// ---------------------------------------------------------------------------

export const SILENT_TURN_MARKER = "▌ **no reply:**"

/**
 * A `result` with `subtype: "success"` after a stream that emitted no visible
 * text and called no tool. opencode records it as an ordinary reply, so the
 * operator gets an empty assistant message and has to guess whether Claude
 * failed, was interrupted, or simply had nothing to say. This is the note that
 * says which.
 *
 * `hadReasoning` distinguishes the two shapes the empty turn takes: a thinking
 * block with no answer after it, and a turn that produced nothing at all.
 */
export function formatSilentTurnNote(hadReasoning: boolean): string {
  const what = hadReasoning
    ? "Claude Code finished the turn after thinking but never wrote an answer"
    : "Claude Code finished the turn without writing anything or calling a tool"
  return (
    `\n${SILENT_TURN_MARKER} ${what}, so there is no reply above. ` +
    "Nothing failed and nothing is pending: send the message again, or rephrase it.\n"
  )
}

// ---------------------------------------------------------------------------
// output the child wrote while no turn was listening
// ---------------------------------------------------------------------------

export const UNATTENDED_REPLAY_MARKER = "▌ **between turns:**"

/**
 * A reused `claude` process can write a whole turn's worth of frames after the
 * plugin's own turn ended on its terminal `result`, and the next turn replays
 * them so the operator sees them rather than losing them. Measured ways in:
 * the proxy-detach path (PR #35), and a CLI-side background task whose
 * notification lands after the result, which makes the CLI continue the
 * conversation on its own (both 2.1.280 and 2.1.286, see (h #g189)).
 *
 * The replay used to be bare text, indistinguishable from this turn's answer:
 * an operator who asked one question got the previous turn's trailing sentence
 * on top of the reply, and a transcript rebuilt for a fresh process handed it
 * back as something Claude had said in answer to the wrong message. Leading
 * the block with a marker fixes both at once, because `PLUGIN_NOTE_MARKERS`
 * strips a text part by its first characters.
 */
export function formatUnattendedReplayNote(dropped: number): string {
  const lost =
    dropped > 0 ? ` ${dropped} earlier line${dropped === 1 ? "" : "s"} were dropped.` : ""
  return (
    `${UNATTENDED_REPLAY_MARKER} The Claude Code CLI wrote this after the previous ` +
    `turn had already finished, so it is not an answer to the message above.${lost}\n\n`
  )
}

// ---------------------------------------------------------------------------
// unrecognized_model (stderr)
// ---------------------------------------------------------------------------

/**
 * The line a CLI writes to stderr when `--model` names a model it has no
 * catalog entry for. Verbatim from Claude Code 2.1.280 running
 * `claude-sonnet-5-5` in the plugin's own mode (`-p`, stream-json, verbose),
 * 2026-09-30: `[claude-code:unrecognized_model] {"model":"claude-sonnet-5-5",
 * "query_source":"sdk"}`. A model it knows writes nothing to stderr.
 *
 * The turn still succeeds, which is why nothing else notices: the API serves
 * the model, but the CLI runs it on fallback limits. Measured on that pair:
 * `modelUsage.contextWindow` 200,000 for a 1M model, and a `total_cost_usd`
 * the CLI estimated rather than priced. So its own compaction can work
 * against the wrong window and the `turnStats` cost is approximate, until the user
 * updates Claude Code to a release that ships the model.
 */
export const UNRECOGNIZED_MODEL_STDERR_MARKER = "[claude-code:unrecognized_model]"

/**
 * The first Claude Code release that knows a model, where it is known, so the
 * warning can name the fix exactly. Taken from Claude Code's CHANGELOG, not
 * inferred; a model missing here still gets the generic advice.
 */
const MODEL_CLI_FLOORS: Record<string, string> = {
  // "Added Claude Sonnet 5.5 (`claude-sonnet-5-5`)" (CHANGELOG, 2.1.284).
  "claude-sonnet-5-5": "2.1.284",
  // "Added Claude Haiku 5.5 (`claude-haiku-5-5`), now the default Haiku model
  // on the Anthropic API" (CHANGELOG, 2.1.293). Absent from 2.1.288's catalog.
  "claude-haiku-5-5": "2.1.293",
}

/**
 * The model named by an `unrecognized_model` line anywhere in a stderr chunk,
 * `{ model: undefined }` when the marker is there but its payload does not
 * parse, and null when the chunk carries no such line.
 */
export function parseUnrecognizedModel(stderr: string): { model: string | undefined } | null {
  const at = stderr.indexOf(UNRECOGNIZED_MODEL_STDERR_MARKER)
  if (at === -1) return null
  const rest = stderr.slice(at + UNRECOGNIZED_MODEL_STDERR_MARKER.length)
  const line = rest.split("\n", 1)[0].trim()
  try {
    const payload: unknown = JSON.parse(line)
    return { model: isRecord(payload) ? str(payload.model) : undefined }
  } catch {
    return { model: undefined }
  }
}

const warnedUnrecognizedModels = new Set<string>()

/** Test-only. */
export function _resetUnrecognizedModelReports(): void {
  warnedUnrecognizedModels.clear()
}

/**
 * WARN once per model per process when the CLI says it does not know the
 * model it was spawned with. The CLI writes the line on every turn, so the
 * repeats go to DEBUG.
 */
export function reportUnrecognizedModel(stderr: string): void {
  const parsed = parseUnrecognizedModel(stderr)
  if (!parsed) return
  const model = parsed.model ?? "unknown"
  const floor = parsed.model ? MODEL_CLI_FLOORS[parsed.model] : undefined
  const fix = floor
    ? `It needs Claude Code ${floor} or newer: run \`claude update\`.`
    : "Update Claude Code (`claude update`) to a release that knows it."
  const message =
    `Claude Code does not recognise the model "${model}". It still runs it, but on ` +
    "fallback limits (measured on 2.1.280: a 200k context window instead of 1M, and " +
    `an estimated cost), so its own compaction may start early and turnStats' cost is approximate. ${fix}`
  if (warnedUnrecognizedModels.has(model)) {
    log.debug(message, { model })
    return
  }
  warnedUnrecognizedModels.add(model)
  log.warn(message, { model, ...(floor ? { cliFloor: floor } : {}) })
}

// ---------------------------------------------------------------------------
// system / hook_started, hook_progress, hook_response
// ---------------------------------------------------------------------------

/**
 * One frame of a Claude Code hook's lifecycle. Schemas read out of the CLI's
 * own zod on 2.1.280:
 *
 *   `{type:"system",subtype:"hook_started",hook_id,hook_name,hook_event,uuid,session_id}`
 *   `{type:"system",subtype:"hook_progress",hook_id,hook_name,hook_event,stdout,stderr,output,uuid,session_id}`
 *   `{type:"system",subtype:"hook_response",hook_id,hook_name,hook_event,output,stdout,stderr,exit_code?,outcome:["success","error","cancelled"],uuid,session_id}`
 *
 * The gate in the same binary is `i3(event)`: `["SessionStart","Setup"]`
 * always emit, every other hook event only when `--include-hook-events` set
 * `allHookEventsEnabled`. The plugin never passes that flag, so what arrives
 * on a plugin spawn is exactly the `SessionStart` family, and it arrives on
 * every spawn: measured on 2.1.280 in the plugin's own argv, three
 * `SessionStart:startup` hooks produced three `hook_started` and three
 * `hook_response` before `system`/`init`.
 */
export interface HookEvent {
  phase: "started" | "progress" | "response"
  hookId: string
  /** `SessionStart:startup`, the matcher-qualified name the CLI displays. */
  hookName: string
  /** `SessionStart`, the lifecycle event it is attached to. */
  hookEvent: string
  exitCode?: number
  outcome?: string
  /** Only ever the hook's stderr; see `describeHookFailure` for why. */
  stderr?: string
}

const HOOK_SUBTYPES: Record<string, HookEvent["phase"]> = {
  hook_started: "started",
  hook_progress: "progress",
  hook_response: "response",
}

export function parseHookEvent(msg: ClaudeStreamMessage): HookEvent | null {
  if (msg.type !== "system") return null
  const phase = msg.subtype ? HOOK_SUBTYPES[msg.subtype] : undefined
  if (!phase) return null
  const raw = msg as unknown as Record<string, unknown>
  const hookName = str(raw.hook_name)
  const hookEvent = str(raw.hook_event)
  // The CLI's own adapter drops a frame it cannot name; so do we, rather than
  // warn about `undefined` failing.
  if (!hookName || !hookEvent) return null
  return {
    phase,
    hookId: str(raw.hook_id) ?? "unknown",
    hookName,
    hookEvent,
    exitCode: num(raw.exit_code),
    outcome: str(raw.outcome),
    stderr: str(raw.stderr),
  }
}

/**
 * Whether this response is a hook the user has to fix.
 *
 * `outcome` is the CLI's own verdict and is authoritative, but `exit_code` is
 * optional in the schema while `outcome` is not, so a non-zero exit with no
 * outcome still counts. `cancelled` is deliberately not a failure: an abort
 * cancels whatever hooks were in flight, and warning about that would fire on
 * every interrupted turn.
 */
export function isHookFailure(hook: HookEvent): boolean {
  if (hook.phase !== "response") return false
  if (hook.outcome === "error") return true
  if (hook.outcome === "cancelled" || hook.outcome === "success") return false
  return hook.exitCode !== undefined && hook.exitCode !== 0
}

/**
 * The 200-character cap and the stderr-only rule are the whole reason this is
 * a separate function.
 *
 * A hook's `output` and `stdout` are what the CLI splices into the model's
 * context: measured on 2.1.280, the maintainer's own `SessionStart` hooks put
 * a whole instruction block and a `hookSpecificOutput.additionalContext`
 * payload there. None of that belongs in a WARN or in a bug report pasted
 * into an issue. `stderr` is where a failing hook writes why it failed, and
 * nothing else is read.
 */
export const HOOK_STDERR_CAP = 200

export function describeHookFailure(hook: HookEvent): string {
  const how =
    hook.exitCode !== undefined
      ? `exited ${hook.exitCode}`
      : `reported \`${hook.outcome ?? "error"}\``
  const tail = hook.stderr?.trim()
  const detail = tail
    ? ` It wrote to stderr: ${tail.length > HOOK_STDERR_CAP ? `${tail.slice(0, HOOK_STDERR_CAP)}...` : tail}`
    : " It wrote nothing to stderr."
  return (
    `Claude Code's "${hook.hookName}" hook (${hook.hookEvent}) ${how}, so whatever it ` +
    "contributes to the session is missing and every turn on this process runs without " +
    `it. Fix or remove the hook in your Claude Code settings.${detail}`
  )
}

/** A failed hook kept for `/claude-code-doctor`. */
export interface HookFailure {
  hookName: string
  hookEvent: string
  exitCode: number | undefined
  outcome: string | undefined
  stderr: string
}

const warnedHookFailures = new Set<string>()
/** Newest wins per `event:name`, like `lastMcpServerErrors`, for the doctor. */
const lastHookFailures = new Map<string, HookFailure>()

/** Test-only. */
export function _resetHookEventReports(): void {
  warnedHookFailures.clear()
  lastHookFailures.clear()
}

/** Read-only view for the doctor. Never touches the dedup set. */
export function snapshotHookFailures(): HookFailure[] {
  return [...lastHookFailures.values()]
}

/**
 * WARN once per `event:name:outcome:exit` per process for a hook that failed,
 * and nothing louder than DEBUG for anything else.
 *
 * The identity deliberately excludes `hook_id`, which is a fresh uuid on every
 * spawn: keying on it would warn again for the same broken hook on every
 * respawn and on every one of the sixteen processes a session can hold.
 */
export function reportHookEvent(msg: ClaudeStreamMessage): void {
  const hook = parseHookEvent(msg)
  if (!hook) return
  const data = {
    hook: hook.hookName,
    event: hook.hookEvent,
    ...(hook.exitCode === undefined ? {} : { exitCode: hook.exitCode }),
    ...(hook.outcome ? { outcome: hook.outcome } : {}),
  }
  if (!isHookFailure(hook)) {
    // Including `cancelled`: real, but caused by an abort rather than by the
    // hook, and the operator already knows they interrupted the turn.
    log.debug(`claude code hook ${hook.phase}`, data)
    return
  }
  const failure: HookFailure = {
    hookName: hook.hookName,
    hookEvent: hook.hookEvent,
    exitCode: hook.exitCode,
    outcome: hook.outcome,
    stderr: hook.stderr?.trim().slice(0, HOOK_STDERR_CAP) ?? "",
  }
  lastHookFailures.set(`${hook.hookEvent}:${hook.hookName}`, failure)
  const key = `${hook.hookEvent}:${hook.hookName}:${hook.outcome ?? "?"}:${hook.exitCode ?? "?"}`
  const message = describeHookFailure(hook)
  if (warnedHookFailures.has(key)) {
    log.debug(message, data)
    return
  }
  warnedHookFailures.add(key)
  log.warn(message, data)
}

// ---------------------------------------------------------------------------
// tool_progress
// ---------------------------------------------------------------------------

/**
 * A tool the CLI is still running. Schema from Claude Code 2.1.280:
 * `{type:"tool_progress",tool_use_id,tool_name,parent_tool_use_id,
 * elapsed_time_seconds,task_id?,uuid,session_id,heartbeat?,subagent_type?,
 * subagent_retry?}`.
 *
 * Two of its emitters are gated and one is not. `bash_progress` and
 * `powershell_progress` need `CLAUDE_CODE_REMOTE` or `CLAUDE_CODE_CONTAINER_ID`
 * in the environment, so a local Bash never produces them. The heartbeat does
 * not: `xEn` arms a 30-second interval around every tool call in the main
 * conversation, which is why these arrive in the plugin's own mode with no
 * flag at all. Measured on 2.1.280 driving a CLI-executed `sleep 95`: frames
 * at 30, 60 and 90 seconds, so the longest gap between two stdout lines across
 * the whole 102-second turn was 30.0s.
 *
 * `tool_use_id` on a heartbeat frame is synthetic (`<real id>-heartbeat-0`,
 * `-1`, ...) and the real tool's id is in `parent_tool_use_id`. Reading the
 * wrong one gives an id nothing else in the turn has ever seen, so
 * `toolUseId` below is the real one and the frame's own is kept separately.
 */
export interface ToolProgress {
  /** The tool call this is about: `parent_tool_use_id` when the CLI set one. */
  toolUseId: string
  /** The frame's own id, synthetic on a heartbeat. */
  frameToolUseId: string
  toolName: string
  elapsedSeconds: number
  heartbeat: boolean
  taskId?: string
  subagentType?: string
  subagentRetry?: {
    agentId: string
    attempt: number
    maxRetries: number
    errorStatus: number | undefined
    errorCategory: string
  }
}

/**
 * Defensive in the CLI's own terms: its `sdkMessageAdapter` drops a frame
 * "with a non-string tool_name/tool_use_id or non-finite
 * elapsed_time_seconds", so this returns null on exactly those.
 */
export function parseToolProgress(msg: ClaudeStreamMessage): ToolProgress | null {
  if (msg.type !== "tool_progress") return null
  const raw = msg as unknown as Record<string, unknown>
  const frameToolUseId = str(raw.tool_use_id)
  const toolName = str(raw.tool_name)
  const elapsedSeconds = num(raw.elapsed_time_seconds)
  if (!frameToolUseId || !toolName || elapsedSeconds === undefined) return null
  const retry = isRecord(raw.subagent_retry) ? raw.subagent_retry : undefined
  return {
    toolUseId: str(raw.parent_tool_use_id) ?? frameToolUseId,
    frameToolUseId,
    toolName,
    elapsedSeconds,
    heartbeat: raw.heartbeat === true,
    taskId: str(raw.task_id),
    subagentType: str(raw.subagent_type),
    subagentRetry: retry
      ? {
          agentId: str(retry.agent_id) ?? "unknown",
          attempt: num(retry.attempt) ?? 0,
          maxRetries: num(retry.max_retries) ?? 0,
          errorStatus: num(retry.error_status),
          errorCategory: str(retry.error_category) ?? "unknown",
        }
      : undefined,
  }
}

export function describeToolProgress(progress: ToolProgress): string {
  if (progress.subagentRetry) {
    const retry = progress.subagentRetry
    return (
      `Claude Code is retrying a subagent's API call (${retry.errorCategory}` +
      `${retry.errorStatus === undefined ? "" : ` ${retry.errorStatus}`}), attempt ` +
      `${retry.attempt} of ${retry.maxRetries}. The turn is still running.`
    )
  }
  return `claude code tool still running: ${progress.toolName} at ${progress.elapsedSeconds}s`
}

const reportedSubagentRetries = new Set<string>()

/** Test-only. */
export function _resetToolProgressReports(): void {
  reportedSubagentRetries.clear()
}

/**
 * Logs the frame. Deliberately returns nothing: there is no transcript note
 * and no stream part here.
 *
 * The one job a progress frame could have done is already done for free. The
 * line handler calls `startResultFallback` on every line it receives, so a
 * heartbeat resets the 60-second wire-inactivity watchdog like any other line,
 * and the measured 30-second cadence keeps a long CLI-executed tool at half
 * the deadline. What was missing was not the reset but the diagnostic: until
 * now a turn stuck inside a ten-minute `Bash` wrote twenty `stream message
 * tool_progress` debug lines that named neither the tool nor how long it had
 * been going. That is what the INFO line below says.
 *
 * No dedup on the heartbeat, which is the one reporter in this file without
 * one, because its identity is `(tool_use_id, elapsed)` and the CLI never
 * repeats a pair: deduping would suppress nothing and hide the elapsed times,
 * which are the whole content. A subagent retry does repeat, so it dedupes.
 */
export function reportToolProgress(msg: ClaudeStreamMessage): void {
  const progress = parseToolProgress(msg)
  if (!progress) return
  const data: Record<string, unknown> = {
    tool: progress.toolName,
    toolUseId: progress.toolUseId,
    elapsedSeconds: progress.elapsedSeconds,
    ...(progress.taskId ? { taskId: progress.taskId } : {}),
    ...(progress.subagentType ? { subagentType: progress.subagentType } : {}),
  }
  const message = describeToolProgress(progress)
  if (!progress.subagentRetry) {
    log.info(message, data)
    return
  }
  const retry = progress.subagentRetry
  const key = `${retry.agentId}:${retry.errorCategory}`
  const retryData = { ...data, ...retry }
  if (reportedSubagentRetries.has(key)) {
    log.debug(message, retryData)
    return
  }
  reportedSubagentRetries.add(key)
  log.notice(message, retryData)
}
