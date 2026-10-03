import { createHash, randomBytes } from "node:crypto"
import { openSync, readSync, closeSync, fstatSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { PLUGIN_LOG_MESSAGES } from "./log-messages.js"

/**
 * `/claude-code-doctor bundle`: the doctor report plus recent warnings, in one
 * block a contributor can paste into a GitHub issue.
 *
 * The problem this solves is that `plugin.log` cannot be attached to anything.
 * It is off by default (`OPENCODE_CLAUDE_CODE_LOG_FILE=1`), and when it is on
 * it has no redaction guarantee at all: measured over the maintainer's own log
 * on 2026-10-01, 4,526 retained lines carried spawn argv with `--settings` JSON
 * and absolute paths, bridged MCP config targets, skill directories, opencode
 * and Claude session ids, and message texts built at runtime from the CLI's own
 * error prose. So contributors filing real bug reports (PRs #62, #63, #67) send
 * screenshots and guesses instead, and the first thing a maintainer needs,
 * versions plus config shape plus the recent warnings, is exactly what they
 * cannot safely share.
 *
 * ## The redaction is an allowlist, and that is the whole point
 *
 * A denylist of secret-shaped patterns (`sk-ant-`, `Authorization`, `token=`)
 * fails the moment someone logs a new field, and the failure is silent and
 * permanent: the leak ships and nobody notices. So nothing survives into a
 * bundle unless this module can name it:
 *
 * - **the level** must be NOTICE, WARN or ERROR. Everything else is dropped.
 * - **the timestamp** is kept verbatim. It is an ISO instant and nothing else.
 * - **the message text** is kept only when it is in `PLUGIN_LOG_MESSAGES`, the
 *   set of message literals extracted from this package's own source (see
 *   `log-message-scan.ts`). A message built at runtime, including every CLI
 *   error string the plugin re-logs, is replaced by its shape.
 * - **a data key** must be in `BUNDLE_DATA_ALLOWLIST`, and its value must then
 *   be the kind that entry declares. A string where a count was declared is
 *   redacted; a 4 KB string where a tool name was declared is redacted.
 * - **everything else** becomes `[redacted, N chars]`, which keeps the shape
 *   (so a maintainer can see that a field was there and how big it was) and
 *   none of the content.
 *
 * Two rewrites then run over the whole report, the doctor table included,
 * because the whole report is what gets pasted: the home directory becomes `~`,
 * and session ids become a short hash salted per bundle, which keeps two lines
 * about one conversation correlated without naming the conversation. They are
 * belt on top of braces, never the mechanism: the allowlist above is what makes
 * the log section safe.
 *
 * ## What a bundle may never contain
 *
 * Prompt or reply text; the system prompt, the appended system prompt or the
 * path's contents; a tool's input or output; file contents; an environment
 * variable's value; a bearer token, the proxy `authToken`, or an API key; an
 * `Authorization` header; an MCP server's env or headers; a URL's credentials
 * or query string; the raw spawn argv. None of these has an allowlist entry,
 * so the default path for all of them is `[redacted, N chars]`.
 */

/** `/claude-code-doctor bundle`, the same parse `usage` gets in plan-usage.ts. */
export const BUNDLE_ARGUMENTS = new Set(["bundle", "issue", "report", "paste"])

export function wantsDiagnosticBundle(argument: string): boolean {
  return BUNDLE_ARGUMENTS.has(argument.trim().toLowerCase())
}

/** The levels a bundle prints. Mirrors `BUNDLED_LEVELS` in log-message-scan.ts. */
export const BUNDLE_LEVELS: ReadonlySet<string> = new Set(["NOTICE", "WARN", "ERROR"])

/**
 * Caps. A GitHub issue body is 65,536 characters, and the doctor report above
 * this section already spends two to four thousand of them, so 120 lines at
 * 24 KB leaves a contributor room to describe their actual problem. The tail
 * read is 512 KB because the log rotates at 5 MB and the longest line measured
 * in the real one was 19 KB, so the tail always holds far more than 120 lines.
 */
export const BUNDLE_MAX_LINES = 120
export const BUNDLE_MAX_BYTES = 24_000
export const BUNDLE_TAIL_BYTES = 512 * 1024
/** Longest allowlisted string value kept whole. Longer is shape only. */
export const BUNDLE_MAX_VALUE_CHARS = 200
export const BUNDLE_MAX_ENUM_CHARS = 40
export const BUNDLE_MAX_VERSION_CHARS = 60
/**
 * 64, because the longest real identifier measured is a proxied MCP tool name
 * (`mcp__opencode_proxy__codebase-memory-mcp_search_graph`, 52 characters) and
 * those are exactly what a proxy bug report is about.
 */
export const BUNDLE_MAX_NAME_CHARS = 64
export const BUNDLE_MAX_ARRAY_ITEMS = 20

/**
 * What an allowlisted value is allowed to be. The kind is the guarantee: a key
 * is only in the allowlist because its values are non-secret *by type*, and the
 * sanitizer enforces the type rather than trusting the name.
 */
export type BundleValueKind =
  | "flag" // boolean
  | "count" // finite number
  | "duration" // finite number of milliseconds
  | "money" // finite number of dollars
  | "enum" // short machine token: a status, a mode, a verdict
  | "name" // tool / server / skill / agent / model identifier
  | "version" // version string
  | "id" // session, call or message id, hashed
  | "path" // filesystem path, home rewritten to `~`
  | "url" // loopback proxy url, credentials and query dropped
  | "argv" // spawn argv: option names kept, every value redacted

/**
 * The key allowlist, built from an inventory of the maintainer's real
 * `plugin.log` plus its rotated predecessor (4,526 lines, 201 distinct data
 * keys) on 2026-10-01. A key absent from here is redacted, which is what makes
 * a newly-added field safe by default rather than dangerous by default.
 *
 * It applies at EVERY depth, not just the top level: a nested key is looked up
 * here by its own name, independently of its parent. That is what keeps the
 * `plugin ready` NOTICE readable, since its `cwd`, `claudeCli` and
 * `permissionPresets` fields are objects and arrays of objects, and it means a
 * nested key gets exactly the same treatment as a top-level one rather than
 * inheriting its parent's.
 */
export const BUNDLE_DATA_ALLOWLIST: Readonly<Record<string, BundleValueKind>> = {
  // booleans: every one of these is a decision the plugin made
  applied: "flag",
  attached: "flag",
  bridgeSkipNativeSkills: "flag",
  channelClosed: "flag",
  compaction: "flag",
  compactionMode: "flag",
  emitted: "flag",
  enabled: "flag",
  executed: "flag",
  isUsingOverage: "flag",
  hadProxyActivity: "flag",
  hadReasoning: "flag",
  hadStreamThinking: "flag",
  hadToolActivity: "flag",
  hasActiveProcess: "flag",
  hasInput: "flag",
  hasText: "flag",
  inFlight: "flag",
  anthropicApiKeyInEnv: "flag",
  includeHistoryContext: "flag",
  interactive: "flag",
  interactiveTransport: "flag",
  isError: "flag",
  planModeQuestion: "flag",
  kept: "flag",
  listsAgentTypes: "flag",
  opencodeHasQuestion: "flag",
  registryResolved: "flag",
  sse: "flag",
  strictMcpConfig: "flag",
  supported: "flag",
  turnStats: "flag",

  // counts and sizes: a length is a shape, never content
  attempts: "count",
  cacheReadTokens: "count",
  cacheWriteTokens: "count",
  code: "count",
  count: "count",
  dropped: "count",
  exitCode: "count",
  historyLength: "count",
  inputTokens: "count",
  lastTextLength: "count",
  lines: "count",
  liveDescriptionLength: "count",
  numTurns: "count",
  outputTokens: "count",
  permissionDenials: "count",
  pid: "count",
  port: "count",
  postTokens: "count",
  preTokens: "count",
  removed: "count",
  skills: "count",
  stderrBytes: "count",
  textLength: "count",
  tools: "count",
  total: "count",

  ageMs: "duration",
  delayMs: "duration",
  deadlineMs: "duration",
  durationApiMs: "duration",
  durationMs: "duration",
  elapsedMs: "duration",
  remainingMs: "duration",
  timeoutMs: "duration",
  waitedMs: "duration",

  costUsd: "money",

  // enums: a fixed vocabulary this package or the CLI defines
  apiKeySource: "enum",
  delivery: "enum",
  effort: "enum",
  finishReason: "enum",
  hash: "enum",
  hostApi: "enum",
  kind: "enum",
  level: "enum",
  mode: "enum",
  overageDisabledReason: "enum",
  overageStatus: "enum",
  permissionMode: "enum",
  preset: "enum",
  rateLimitType: "enum",
  reason: "enum",
  reasoningEffort: "enum",
  scope: "enum",
  signal: "enum",
  source: "enum",
  state: "enum",
  status: "enum",
  stopReason: "enum",
  subtype: "enum",
  transport: "enum",
  trigger: "enum",
  type: "enum",
  verdict: "enum",

  // names: identifiers the operator configured or Claude Code published. The
  // doctor table already prints the same class of value (providers, accounts,
  // proxyTools, MCP servers), so a bundle is no more revealing than the report
  // it is attached to.
  accounts: "name",
  agent: "name",
  bundled: "name",
  excluded: "name",
  excludeServers: "name",
  from: "name",
  joined: "name",
  left: "name",
  mappedName: "name",
  model: "name",
  name: "name",
  names: "name",
  opencodeAgent: "name",
  provider: "name",
  providerOptionsKeys: "name",
  providers: "name",
  proxyTools: "name",
  server: "name",
  servers: "name",
  skipped: "name",
  toolName: "name",
  toolNames: "name",

  cliFloor: "version",
  cliVersion: "version",
  // The two halves of the stale-build WARN: what this process loaded and what
  // is on disk now. Both are this package's own version strings.
  loadedVersion: "version",
  onDiskVersion: "version",
  opencode: "version",
  plugin: "version",
  version: "version",

  // ids: hashed, never printed. Correlation survives, identity does not.
  callId: "id",
  claudeSessionId: "id",
  id: "id",
  messageId: "id",
  newConversationId: "id",
  previousSessionId: "id",
  sessionId: "id",
  sessionID: "id",
  sessionKey: "id",
  toolCallId: "id",
  toolCallIds: "id",
  toolUseId: "id",

  // paths: home becomes `~`. The doctor table prints cwd and the CLI path
  // already, so withholding them here would buy nothing and cost the one
  // field that explains most "it picked the wrong directory" reports.
  claudeLoads: "path",
  cliPath: "path",
  configDir: "path",
  cwd: "path",
  dir: "path",
  notBridged: "path",
  path: "path",
  pluginDir: "path",
  resolved: "path",
  target: "path",

  url: "url",

  cliArgs: "argv",

  // The hook and tool_progress reporters (#g185), added when the two lanes
  // merged: their message text is built at runtime and redacted, so these
  // fields are what keeps a failed-hook WARN readable in a bundle. `stderr`
  // is deliberately absent, because a hook can print anything to it.
  hook: "name",
  hookName: "name",
  event: "enum",
  hookEvent: "enum",
  outcome: "enum",
  tool: "name",
  subagentType: "name",
  errorCategory: "enum",
  errorStatus: "count",
  elapsedSeconds: "count",
  attempt: "count",
  maxRetries: "count",
  taskId: "id",
  agentId: "id",
}

function shape(value: unknown): string {
  if (typeof value === "string") return `[redacted, ${value.length} chars]`
  let size: number
  try {
    size = JSON.stringify(value)?.length ?? 0
  } catch {
    size = 0
  }
  return `[redacted, ${size} chars]`
}

/** A salted short hash, so ids correlate inside one bundle and nowhere else. */
export function createIdHasher(salt: string = randomBytes(16).toString("hex")): (
  raw: string,
) => string {
  return (raw: string) =>
    createHash("sha256").update(salt).update("\u0000").update(raw).digest("hex").slice(0, 8)
}

export interface RedactionContext {
  /** Home directory prefixes to rewrite to `~`, longest first. */
  homes: readonly string[]
  hash: (raw: string) => string
}

export function createRedactionContext(options: {
  home?: string
  salt?: string
} = {}): RedactionContext {
  const home = options.home ?? homedir()
  const homes = new Set<string>()
  if (home) homes.add(home)
  if (home) {
    try {
      homes.add(realpathSync.native(home))
    } catch {
      // A home that cannot be resolved is still worth rewriting literally.
    }
  }
  return {
    homes: [...homes].filter(Boolean).sort((a, b) => b.length - a.length),
    hash: createIdHasher(options.salt),
  }
}

/** Every spelling of the home directory becomes `~`. */
export function redactHome(text: string, context: RedactionContext): string {
  let out = text
  for (const home of context.homes) out = out.split(home).join("~")
  return out
}

/**
 * Session ids anywhere in the report, including the doctor table's own session
 * column. opencode ids are `ses_<base62>`; Claude's are UUIDs.
 */
const OPENCODE_SESSION_ID = /\bses_[A-Za-z0-9]{6,}/g
const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g

export function redactSessionIds(text: string, context: RedactionContext): string {
  return text
    .replace(OPENCODE_SESSION_ID, (raw) => `ses_${context.hash(raw)}`)
    .replace(UUID, (raw) => `uuid_${context.hash(raw)}`)
}

/** Both whole-report rewrites, in the order a reader expects to see them. */
export function redactForPaste(text: string, context: RedactionContext): string {
  return redactSessionIds(redactHome(text, context), context)
}

/**
 * The character classes each kind is defined by. They are deliberately tighter
 * than "a short string", because the adversarial fixtures in
 * `test-diagnostic-bundle.ts` showed that a length cap alone lets a header, a
 * PEM block and an English sentence through a field declared as a name.
 *
 * - a **name** is a whitespace-free identifier starting with a letter or digit:
 *   `claude-opus-5-5`, `mcp__opencode_proxy__task`, `plugin:stripe:stripe`. No
 *   whitespace means it can never be prose, a prompt, a header or a PEM block;
 *   no `=` means it can never be an env assignment.
 * - an **enum** is the same, 40 characters at most.
 * - a **version** starts with a digit or `v` (or is one of a few literal
 *   placeholders), so `2.1.280 (Claude Code)` survives and a sentence does not.
 * - a **path** starts at a root, a home, a drive or a relative marker.
 */
const SAFE_NAME = /^[A-Za-z0-9][\w.:@+/-]*$/
const SAFE_ENUM = /^[A-Za-z0-9][\w.:@+/-]*$/
const SAFE_VERSION = /^[v0-9][\w.()+ -]*$/
const VERSION_PLACEHOLDERS = new Set(["unknown", "none", "not detected", "unset"])
const SAFE_PATH = /^(?:[/~.]|[A-Za-z]:[\\/])/
/** A CLI option name: one or two dashes then an identifier. Never a value. */
const CLI_FLAG = /^-{1,2}[A-Za-z][\w-]*$/

/**
 * Defence in depth, not the mechanism. The allowlist above is what makes a
 * bundle safe; this is a tripwire for the one residual shape a `name` could
 * otherwise carry, an opaque credential that happens to look like an
 * identifier. Kept short and specific on purpose: a long pattern list would
 * invite someone to treat it as the guarantee, which is exactly the denylist
 * mistake this module exists to avoid.
 *
 * Residual, stated plainly: a 33 to 63 character opaque token with none of
 * these markers and no whitespace would pass as a `name`. No key in
 * `BUNDLE_DATA_ALLOWLIST` is populated from one; every id-shaped key is kind
 * `id` and is hashed.
 */
const SUSPICIOUS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]/, // Anthropic and OpenAI style API keys
  /\b(?:gh[pousr]_|xox[baprs]-|github_pat_)/, // GitHub and Slack tokens
  /[0-9a-f]{32,}/i, // hex secrets; the proxy authToken is 64 of these
  /[A-Za-z0-9+/]{40,}={0,2}/, // base64 blobs
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /^bearer\b/i,
  /=/, // any assignment: ANTHROPIC_API_KEY=…, token=…
]

function looksSecret(value: string): boolean {
  return SUSPICIOUS.some((pattern) => pattern.test(value))
}

function sanitizeScalar(
  kind: BundleValueKind,
  value: unknown,
  context: RedactionContext,
): unknown {
  // `null` carries nothing and several of these fields are nullable by design
  // (`exitCode`, `signal`, `preTokens`), so it survives for every kind.
  if (value === null) return null
  switch (kind) {
    case "flag":
      return typeof value === "boolean" ? value : shape(value)
    case "count":
    case "duration":
      return typeof value === "number" && Number.isFinite(value) ? value : shape(value)
    case "money":
      return typeof value === "number" && Number.isFinite(value)
        ? Math.round(value * 10_000) / 10_000
        : shape(value)
    case "enum": {
      if (typeof value === "boolean" || typeof value === "number") return value
      if (typeof value !== "string") return shape(value)
      return value.length <= BUNDLE_MAX_ENUM_CHARS &&
        SAFE_ENUM.test(value) &&
        !looksSecret(value)
        ? value
        : shape(value)
    }
    case "name": {
      if (typeof value !== "string") return shape(value)
      return value.length <= BUNDLE_MAX_NAME_CHARS && SAFE_NAME.test(value) && !looksSecret(value)
        ? value
        : shape(value)
    }
    case "version": {
      if (typeof value !== "string") return shape(value)
      if (VERSION_PLACEHOLDERS.has(value)) return value
      return value.length <= BUNDLE_MAX_VERSION_CHARS &&
        SAFE_VERSION.test(value) &&
        !looksSecret(value)
        ? value
        : shape(value)
    }
    case "id":
      return typeof value === "string" ? context.hash(value) : shape(value)
    case "path": {
      if (typeof value !== "string") return shape(value)
      // A bare command name is a legitimate `cliPath`: the default is just
      // `claude`, resolved off PATH, and redacting it would hide the single
      // most common cause of "the plugin found the wrong binary".
      if (!SAFE_PATH.test(value)) return sanitizeScalar("name", value, context)
      if (looksSecret(value)) return shape(value)
      const rewritten = redactHome(value, context)
      return rewritten.length <= BUNDLE_MAX_VALUE_CHARS && !/\s{2,}|[\n\r]/.test(rewritten)
        ? rewritten
        : shape(value)
    }
    case "url":
      return typeof value === "string" ? sanitizeUrl(value) : shape(value)
    case "argv":
      return shape(value)
  }
}

/**
 * Scheme, host and path only. Credentials and the query string are the two
 * places a URL carries a secret, and neither is ever needed to diagnose the
 * loopback proxy, which is the only URL this package logs.
 */
export function sanitizeUrl(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return shape(raw)
  }
  // http and https only. `new URL` happily reads `Authorization: Bearer <tok>`
  // as the scheme `authorization:` with the token in the path, which is how an
  // `Authorization` header leaked through this function in testing.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return shape(raw)
  if (looksSecret(parsed.pathname)) return shape(raw)
  const credentials = parsed.username || parsed.password ? "[redacted]@" : ""
  const query = parsed.search ? `?[redacted, ${parsed.search.length - 1} chars]` : ""
  return `${parsed.protocol}//${credentials}${parsed.host}${parsed.pathname}${query}`
}

/**
 * The spawn argv, kept as shape. Option names are plugin-authored constants and
 * are the single most useful thing in a bug report about spawning; every value
 * after one is a path, a model id, a `--settings` JSON blob or the
 * `--mcp-config` file that holds the proxy bearer token, so no value survives.
 */
export function sanitizeArgv(value: unknown): unknown {
  if (!Array.isArray(value)) return shape(value)
  const out: string[] = []
  for (const item of value.slice(0, BUNDLE_MAX_ARRAY_ITEMS * 2)) {
    if (typeof item !== "string") {
      out.push(shape(item))
      continue
    }
    if (!item.startsWith("-")) {
      out.push(`[redacted, ${item.length} chars]`)
      continue
    }
    const equals = item.indexOf("=")
    if (equals === -1) {
      out.push(CLI_FLAG.test(item) ? item : shape(item))
      continue
    }
    const flag = item.slice(0, equals)
    out.push(
      `${CLI_FLAG.test(flag) ? flag : "[redacted]"}=[redacted, ${item.length - equals - 1} chars]`,
    )
  }
  if (value.length > out.length) out.push(`[+${value.length - out.length} more]`)
  return out
}

/** How deep the walker goes before it gives up and shapes the rest. */
export const BUNDLE_MAX_DEPTH = 4

function kindFor(key: string): BundleValueKind | undefined {
  return Object.prototype.hasOwnProperty.call(BUNDLE_DATA_ALLOWLIST, key)
    ? BUNDLE_DATA_ALLOWLIST[key]
    : undefined
}

/**
 * One value, under the key that named it.
 *
 * An array is walked item by item under the same key, which is how
 * `servers: ["linear", "slack"]` and `mcpServers: [{name, status}]` are both
 * handled without either needing its own kind. A plain object is walked by its
 * own keys, each looked up in the allowlist independently; a key the allowlist
 * does not name is shaped, so descending can never widen what survives.
 */
export function sanitizeValue(
  key: string,
  value: unknown,
  context: RedactionContext,
  depth = 0,
): unknown {
  if (kindFor(key) === "argv") return sanitizeArgv(value)
  if (depth > BUNDLE_MAX_DEPTH) return shape(value)
  if (Array.isArray(value)) {
    const out: unknown[] = value
      .slice(0, BUNDLE_MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(key, item, context, depth + 1))
    if (value.length > out.length) out.push(`[+${value.length - out.length} more]`)
    return out
  }
  if (value !== null && typeof value === "object") {
    return sanitizeLogData(value as Record<string, unknown>, context, depth + 1)
  }
  const kind = kindFor(key)
  return kind === undefined ? shape(value) : sanitizeScalar(kind, value, context)
}

/**
 * An object's entries: allowlisted keys sanitized, every other key shaped.
 *
 * The key NAME is sanitized too, by the same identifier rule a `name` value
 * gets. A key that is not in the allowlist is still printed so a maintainer can
 * see that a field was there, and a key name built from data (`modelUsage` is
 * keyed by model id, and `data` is a plain object anyone can build) would
 * otherwise be the one string in a line that nothing checked.
 */
export function sanitizeLogData(
  data: Record<string, unknown>,
  context: RedactionContext,
  depth = 0,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    const known = kindFor(key) !== undefined
    const safeKey =
      known || (key.length <= BUNDLE_MAX_NAME_CHARS && SAFE_NAME.test(key) && !looksSecret(key))
        ? key
        : `[redacted key, ${key.length} chars]`
    out[safeKey] = sanitizeValue(key, value, context, depth)
  }
  return out
}

const LOG_LINE = /^\[([^\]]+)\] \[opencode-claude-code\] (DEBUG|INFO|NOTICE|WARN|ERROR): ([\s\S]*)$/

export interface ParsedLogLine {
  timestamp: string
  level: string
  message: string
  data: Record<string, unknown> | null
}

/**
 * Split one `plugin.log` line, matching `fmt()` in logger.ts. The data blob is
 * the first `{` from which the rest of the line parses as a plain object, which
 * is exactly how `fmt` appends it. A message that happens to contain its own
 * `{` can split in the wrong place, and that is harmless: such a message is not
 * in `PLUGIN_LOG_MESSAGES` (every literal there is checked whole), so it is
 * redacted, and the misparsed keys are not in the allowlist either.
 */
export function parseLogLine(raw: string): ParsedLogLine | null {
  const match = LOG_LINE.exec(raw)
  if (!match) return null
  const rest = match[3]!
  for (let index = rest.indexOf("{"); index !== -1; index = rest.indexOf("{", index + 1)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(rest.slice(index))
    } catch {
      continue
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        timestamp: match[1]!,
        level: match[2]!,
        message: rest.slice(0, index).trimEnd(),
        data: parsed as Record<string, unknown>,
      }
    }
  }
  return { timestamp: match[1]!, level: match[2]!, message: rest, data: null }
}

/** One redacted line, or null when the level is not one a bundle prints. */
export function redactLogLine(raw: string, context: RedactionContext): string | null {
  const parsed = parseLogLine(raw)
  if (!parsed || !BUNDLE_LEVELS.has(parsed.level)) return null
  const message = PLUGIN_LOG_MESSAGES.has(parsed.message)
    ? parsed.message
    : `[redacted message, ${parsed.message.length} chars]`
  const head = `[${parsed.timestamp}] ${parsed.level}: ${message}`
  if (!parsed.data || Object.keys(parsed.data).length === 0) return head
  return `${head} ${JSON.stringify(sanitizeLogData(parsed.data, context))}`
}

/** Read at most the last `BUNDLE_TAIL_BYTES`, dropping a split first line. */
export function readLogTail(path: string, maxBytes = BUNDLE_TAIL_BYTES): string {
  const fd = openSync(path, "r")
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.allocUnsafe(length)
    readSync(fd, buffer, 0, length, size - length)
    const text = buffer.toString("utf8")
    if (length < size) {
      const newline = text.indexOf("\n")
      return newline === -1 ? "" : text.slice(newline + 1)
    }
    return text
  } finally {
    closeSync(fd)
  }
}

export interface LogBundleInput {
  /** Where this process writes, whether or not file logging is on. */
  logPath: string
  /** `logging.file` as the running process resolved it. */
  fileLogging: boolean
  context: RedactionContext
  /** Seam for tests; defaults to `readLogTail`. */
  readTailImpl?: (path: string, maxBytes: number) => string
}

export const BUNDLE_HEADER = "**Redacted log bundle**"

/**
 * What a reader has to be told before they trust it, and what a maintainer has
 * to be told before they ask for more. Printed above the fence, never inside
 * it, so quoting the fence into an issue cannot lose it.
 */
export const BUNDLE_PREAMBLE = [
  "Safe to paste into a GitHub issue. Built by an allowlist, not a filter: a line",
  "keeps its timestamp, its level, its message **only** when that message is a",
  "constant in this package's own source, and only those data fields whose values",
  "are non-secret by type (versions, counts, flags, enums, durations, exit codes,",
  "model and tool and server names). Everything else, including every unknown",
  "field, is replaced by `[redacted, N chars]`. Session ids are a per-bundle hash,",
  "so lines correlate here and nowhere else, and your home directory is `~`.",
  "",
  "Never included: prompt or reply text, system prompts, tool inputs or outputs,",
  "file contents, environment values, bearer tokens, API keys, `Authorization`",
  "headers, MCP server env or headers, URL credentials or query strings, or the",
  "raw spawn argv.",
  "",
  "Kept on purpose, so read it before pasting: folder paths below your home (your",
  "project and config folder names) and your `accounts` names, which a maintainer",
  "needs to read a cwd or an account problem.",
].join("\n")

export const BUNDLE_LOGGING_OFF = [
  "File logging is **off**, so there is nothing to bundle. The report above still",
  "answers versions, config shape and live processes.",
  "",
  "Turn it on for one run and reproduce the problem:",
  "",
  "```sh",
  "OPENCODE_CLAUDE_CODE_LOG_FILE=1 opencode",
  "```",
  "",
  "or set it permanently in `opencode.json` under",
  "`provider.claude-code.options.logging`:",
  "",
  "```json",
  '{ "logging": { "file": true } }',
  "```",
  "",
  "Then run `/claude-code-doctor bundle` again. Logging is read once at process",
  "start, so a running window has to be relaunched.",
].join("\n")

/**
 * The section appended under the doctor report. Never throws: a bundle that
 * dies takes the doctor report with it, and the report is the more important
 * half.
 */
export function buildLogBundleSection(input: LogBundleInput): string {
  const lines: string[] = [BUNDLE_HEADER, "", BUNDLE_PREAMBLE, ""]
  if (!input.fileLogging) {
    lines.push(BUNDLE_LOGGING_OFF)
    return lines.join("\n")
  }

  let tail: string
  try {
    tail = (input.readTailImpl ?? readLogTail)(input.logPath, BUNDLE_TAIL_BYTES)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    lines.push(
      `File logging is on, but the log could not be read: ${redactHome(reason, input.context)}`,
    )
    return lines.join("\n")
  }

  const raw = tail.split("\n")
  let scanned = 0
  const kept: string[] = []
  // Newest first, so the caps drop the oldest lines rather than the newest.
  for (let index = raw.length - 1; index >= 0; index--) {
    const line = raw[index]!
    if (!line) continue
    if (parseLogLine(line)) scanned++
    const redacted = redactLogLine(line, input.context)
    if (redacted === null) continue
    if (kept.length >= BUNDLE_MAX_LINES) break
    if (kept.reduce((total, entry) => total + entry.length + 1, 0) + redacted.length > BUNDLE_MAX_BYTES) {
      break
    }
    kept.push(redacted)
  }
  kept.reverse()

  const dropped = Math.max(0, scanned - kept.length)
  lines.push(
    `Log: \`${redactHome(input.logPath, input.context)}\`. ` +
      `${kept.length} NOTICE/WARN/ERROR line${kept.length === 1 ? "" : "s"} kept ` +
      `of ${scanned} scanned (caps: ${BUNDLE_MAX_LINES} lines, ${BUNDLE_MAX_BYTES} bytes, ` +
      `last ${BUNDLE_TAIL_BYTES} bytes of the file).`,
  )
  if (dropped > 0) {
    lines.push("")
    lines.push(
      `${dropped} earlier or lower-level line${dropped === 1 ? " was" : "s were"} not included.`,
    )
  }
  lines.push("")
  lines.push("```text")
  if (kept.length === 0) {
    lines.push("No NOTICE, WARN or ERROR line in the retained log.")
  } else {
    lines.push(...kept)
  }
  lines.push("```")
  return lines.join("\n")
}
