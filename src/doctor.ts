import {
  snapshotBackgroundSubagentGate,
  snapshotBackgroundTasks,
  type BackgroundSubagentGate,
  type BackgroundTaskLedger,
} from "./background-tasks.js"
import { detectCliVersion } from "./cli-version.js"
import {
  buildLogBundleSection,
  createRedactionContext,
  redactForPaste,
  wantsDiagnosticBundle,
  type RedactionContext,
} from "./diagnostic-bundle.js"
import {
  snapshotHookFailures,
  snapshotMcpServerErrors,
  snapshotPluginLoadFailures,
  type HookFailure,
  type McpServerError,
  type PluginLoadFailure,
} from "./cli-events.js"
import { describeLogFile, log } from "./logger.js"
import { fetchPlanUsage, wantsPlanUsage, type PlanUsage } from "./plan-usage.js"
import {
  snapshotPendingProxyCalls,
  type PendingProxyCallSnapshot,
} from "./proxy-broker.js"
import {
  NO_PERMISSION_PRESET,
  type PermissionPresetSummary,
} from "./permission-presets.js"
import {
  describeSessionKey,
  snapshotActiveProcesses,
  type ActiveProcessSnapshot,
} from "./session-manager.js"
import {
  describeBuildStatus,
  staleBuildWatch,
  type StaleBuildStatus,
} from "./stale-build.js"
import {
  collectStartupDiagnostics,
  detectOpencodeVersion,
  lastDiagnosticsProviders,
  lastKnownOpencodeVersion,
  type CwdSource,
} from "./startup-diagnostics.js"

/**
 * `/claude-code-doctor`: what the plugin thinks is happening, in the chat,
 * right now.
 *
 * The startup block already answers most of this, but it is logged once per
 * process to a file that is off by default, so in practice nobody sees it. The
 * command is answered by the plugin itself with no CLI inference, following
 * the `/btw` branch in `claude-code-language-model.ts`: the report is emitted
 * as assistant text at zero tokens, and the whole exchange is stripped from
 * any transcript rebuilt for the CLI.
 *
 * "No CLI inference" is the invariant, not "no CLI process": the version row
 * has always come from `detectCliVersion`, which spawns. `/claude-code-doctor
 * usage` adds one more such spawn, `claude -p /cost`, which the CLI answers
 * locally at `num_turns: 0` and `$0` (see `plan-usage.ts`). Nothing here ever
 * sends a prompt to a model.
 *
 * The name is `claude-code-doctor`, not `claude-code doctor`: opencode
 * commands are invoked as `/<key>` with everything after the first space taken
 * as `$ARGUMENTS`, so a space in the name would make the second word an
 * argument rather than part of the command.
 *
 * Nothing secret goes in it. Not the proxy bearer token, not the value of
 * `ANTHROPIC_API_KEY`, not the system prompt, not a pending call's arguments.
 *
 * `/claude-code-doctor bundle` extends that rule to the log: the same report,
 * plus the recent NOTICE/WARN/ERROR lines run through the allowlist in
 * `diagnostic-bundle.ts`, so a contributor filing an issue has one thing to
 * paste instead of a `plugin.log` that has no redaction guarantee at all. It
 * starts no process, unlike `usage`.
 */

export const DOCTOR_COMMAND = "claude-code-doctor"

export const DOCTOR_COMMAND_DESCRIPTION =
  "Report what the Claude Code plugin sees: versions, cwd, live processes, pending proxy calls. Add `usage` for plan windows, or `bundle` for a redacted log you can paste into an issue"

/** Leading marker of the report block, so `message-builder` can strip it. */
export const DOCTOR_MARKER = "▌ **claude-code doctor**"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * The same `<system-reminder>` strip `/btw` needs: opencode appends its own
 * reminder blocks as extra text parts on the user message, and without this a
 * bare `/claude-code-doctor` would never look bare.
 */
const SYSTEM_REMINDER_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/g

export function parseDoctorCommandContent(content: unknown): { rest: string } | null {
  let text: string
  if (typeof content === "string") {
    text = content
  } else if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return null
      parts.push(part.text)
    }
    text = parts.join("\n")
  } else {
    return null
  }
  const match = new RegExp(`^/${DOCTOR_COMMAND}(?:\\s+([\\s\\S]*))?$`).exec(
    text.replace(SYSTEM_REMINDER_BLOCK, "").trim(),
  )
  return match ? { rest: (match[1] ?? "").trim() } : null
}

/** Only the newest user message, so a historical report is never re-run. */
export function parseDoctorCommand(
  prompt: readonly { role: string; content: unknown }[],
): { rest: string } | null {
  const latest = prompt.at(-1)
  return latest?.role === "user" ? parseDoctorCommandContent(latest.content) : null
}

export type ProxyAuthCheck =
  | { status: "ok"; code: number }
  | { status: "unsafe"; code: number }
  | { status: "unreachable"; error: string }
  | { status: "skipped" }

export interface DoctorProxyRow {
  url: string
  auth: ProxyAuthCheck
}

export interface DoctorReport {
  plugin: string
  /**
   * Whether the build this opencode process is running is still the one on
   * disk (src/stale-build.ts). Read unthrottled and marking no session: the
   * doctor observes, it never spends the note a conversation is owed.
   */
  build: StaleBuildStatus
  opencode: string
  claudeCli: { path: string; version: string }
  cwd: { resolved: string; source: CwdSource }
  providers: string[]
  accounts: string[]
  proxyTools: string[]
  mcpServers: string[]
  /** One row per provider; `none` where no preset is configured. */
  permissionPresets: PermissionPresetSummary[]
  transport: "headless" | "interactive"
  planModeQuestion: boolean
  turnStats: boolean
  anthropicApiKeyInEnv: boolean
  processes: ActiveProcessSnapshot[]
  pendingCalls: PendingProxyCallSnapshot[]
  proxyServers: DoctorProxyRow[]
  /** `--mcp-config` entries Claude Code skipped this process. */
  mcpServerErrors: McpServerError[]
  /** Claude plugins (the skill bridge's included) that did not load this process. */
  pluginLoadFailures: PluginLoadFailure[]
  /** Hooks the user configured that failed on a spawn this process made. */
  hookFailures: HookFailure[]
  /** The CLI's own plan-usage report, only when `usage` was asked for. */
  planUsage: PlanUsage
  /** Background subagents: the gate as last read, and what this process did. */
  backgroundSubagents: {
    gate: BackgroundSubagentGate | undefined
    ledgers: BackgroundTaskLedger[]
  }
}

function formatAge(ms: number | undefined): string {
  if (ms === undefined) return "unknown"
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function list(values: string[]): string {
  return values.length ? values.join(", ") : "none"
}

function describeAuth(auth: ProxyAuthCheck): string {
  switch (auth.status) {
    case "ok":
      return `${auth.code}, good`
    case "unsafe":
      return `${auth.code}, UNSAFE: an unauthenticated caller was accepted. Restart every opencode window; a window opened before 0.13.2 keeps serving an open port.`
    case "unreachable":
      return `could not be checked (${auth.error})`
    case "skipped":
      return "not checked"
  }
}

/**
 * The preset cell: `provider: preset` per provider, so an operator running two
 * accounts can see which one is restricted. An unrecognised name is called out
 * rather than shown as if it took effect, because a typo'd `permissionPreset`
 * runs at full permissions and that is the whole point of reporting it.
 */
function describePermissionPresets(rows: PermissionPresetSummary[]): string {
  if (rows.length === 0) return NO_PERMISSION_PRESET
  return rows
    .map((row) => {
      const suffix =
        row.preset === NO_PERMISSION_PRESET || row.applied
          ? ""
          : " (unknown, nothing applied)"
      return `${row.provider}: ${row.preset}${suffix}`
    })
    .join(", ")
}

/**
 * Markdown, in one text part, led by `DOCTOR_MARKER`. Pure so a test can pin
 * the whole report against a fixed object; everything live is gathered in
 * `gatherDoctorReport`.
 */
/**
 * One table cell of text the plugin did not write. A hook's stderr is often
 * several lines, and a newline or a `|` would break the row it sits in.
 */
function tableCell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|")
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = []
  lines.push(DOCTOR_MARKER)
  lines.push("")
  lines.push("| Field | Value |")
  lines.push("|---|---|")
  lines.push(`| plugin | ${report.plugin} |`)
  // Right under the version, because it is the sentence that says whether the
  // version above is the code answering you.
  lines.push(`| plugin build | ${describeBuildStatus(report.build)} |`)
  lines.push(`| opencode | ${report.opencode} |`)
  lines.push(`| claude CLI | \`${report.claudeCli.path}\` (${report.claudeCli.version}) |`)
  lines.push(`| cwd | \`${report.cwd.resolved}\` (${report.cwd.source}) |`)
  lines.push(`| providers | ${list(report.providers)} |`)
  lines.push(`| accounts | ${list(report.accounts)} |`)
  lines.push(`| proxyTools | ${list(report.proxyTools)} |`)
  lines.push(`| MCP servers (on disk) | ${list(report.mcpServers)} |`)
  lines.push(`| permissionPreset | ${describePermissionPresets(report.permissionPresets)} |`)
  lines.push(`| transport | ${report.transport} |`)
  lines.push(`| planModeQuestion | ${report.planModeQuestion} |`)
  lines.push(`| turnStats | ${report.turnStats} |`)
  lines.push(`| ANTHROPIC_API_KEY in env | ${report.anthropicApiKeyInEnv ? "yes" : "no"} |`)

  // Only when a preset actually replaced something, the way "Last stderr"
  // below appears only when there is stderr to show.
  const overriding = report.permissionPresets.filter((row) => row.overrides.length > 0)
  if (overriding.length > 0) {
    lines.push("")
    lines.push("**Permission preset overrides**")
    for (const row of overriding) {
      lines.push("")
      lines.push(`\`${row.provider}\` (${row.preset}) replaced:`)
      lines.push("")
      for (const override of row.overrides) lines.push(`- ${override}`)
    }
  }

  lines.push("")
  lines.push("**Live `claude` processes**")
  lines.push("")
  if (report.processes.length === 0) {
    lines.push("None. The next message in a Claude Code session spawns one.")
  } else {
    lines.push("| session | model | pid | in flight | age | effort |")
    lines.push("|---|---|---|---|---|---|")
    for (const proc of report.processes) {
      lines.push(
        `| ${proc.session}${proc.compaction ? " (compaction)" : ""} | ${proc.model} | ${
          proc.pid ?? "unknown"
        } | ${proc.inFlight ? "yes" : "no"} | ${formatAge(proc.ageMs)} | ${proc.effort ?? "inherited"} |`,
      )
    }
  }

  lines.push("")
  lines.push("**Pending proxy calls**")
  lines.push("")
  if (report.pendingCalls.length === 0) {
    lines.push("None.")
  } else {
    lines.push("| tool | call id | age | deadline |")
    lines.push("|---|---|---|---|")
    for (const call of report.pendingCalls) {
      // A deadline of 0 is "none": task calls wait for the subagent by default.
      const deadline = call.deadlineMs > 0 ? formatAge(call.deadlineMs) : "none"
      lines.push(
        `| ${call.toolName} | \`${call.toolCallId}\` | ${formatAge(call.ageMs)} | ${deadline} |`,
      )
    }
  }

  lines.push("")
  lines.push("**Proxy servers**")
  lines.push("")
  if (report.proxyServers.length === 0) {
    lines.push("None running.")
  } else {
    lines.push("| url | unauthenticated `initialize` |")
    lines.push("|---|---|")
    for (const server of report.proxyServers) {
      lines.push(`| ${server.url} | ${describeAuth(server.auth)} |`)
    }
  }

  // Only when there is something wrong to show. A skipped entry is absent from
  // `mcp_servers` entirely, so nothing else in this report would hint at it.
  if (report.mcpServerErrors.length > 0) {
    lines.push("")
    lines.push("**MCP config entries Claude Code skipped**")
    lines.push("")
    lines.push("| server | category | Claude Code said |")
    lines.push("|---|---|---|")
    for (const error of report.mcpServerErrors) {
      lines.push(`| ${error.name} | \`${error.type}\` | ${tableCell(error.message) || "no detail"} |`)
    }
    lines.push("")
    lines.push("A skipped server is missing from the model's tools with no other sign of it.")
  }

  // The same rule for plugins: a demoted one is absent from the CLI's
  // `plugins[]`, and the skill bridge is one of them.
  if (report.pluginLoadFailures.length > 0) {
    lines.push("")
    lines.push("**Plugins Claude Code did not load**")
    lines.push("")
    lines.push("| plugin | kind | category | Claude Code said |")
    lines.push("|---|---|---|---|")
    for (const failure of report.pluginLoadFailures) {
      lines.push(
        `| ${failure.plugin} | ${failure.kind} | \`${failure.type}\` | ${tableCell(failure.message) || "no detail"} |`,
      )
    }
  }

  // Same rule again, and the reason is the same shape: a hook that fails
  // leaves no trace in the turn at all. The CLI runs it, discards it and
  // answers normally, so the only sign is the WARN, which reaches stderr and
  // a log file that is off by default.
  if (report.hookFailures.length > 0) {
    lines.push("")
    lines.push("**Hooks Claude Code ran that failed**")
    lines.push("")
    lines.push("| hook | event | exit | outcome | its stderr |")
    lines.push("|---|---|---|---|---|")
    for (const failure of report.hookFailures) {
      lines.push(
        `| ${failure.hookName} | ${failure.hookEvent} | ${failure.exitCode ?? "n/a"} | ` +
          `${failure.outcome ?? "unknown"} | ${tableCell(failure.stderr) || "nothing"} |`,
      )
    }
    lines.push("")
    lines.push(
      "These are your own Claude Code hooks, not opencode's. A failed hook's " +
        "contribution to the session is missing and the turn succeeds anyway. Only the " +
        "hook's stderr is shown: its stdout is spliced into the model's context and has " +
        "no business in a bug report.",
    )
  }

  lines.push("")
  lines.push("**Background subagents**")
  lines.push("")
  lines.push(...formatBackgroundSubagents(report.backgroundSubagents))

  lines.push("")
  lines.push("**Plan usage**")
  lines.push("")
  switch (report.planUsage.status) {
    case "ok":
      lines.push("```text")
      lines.push(report.planUsage.text)
      lines.push("```")
      break
    case "failed":
      lines.push(`Could not read it from the CLI: ${report.planUsage.error}`)
      break
    case "not-requested":
      lines.push(
        "Not checked. Run `/claude-code-doctor usage` for the account's plan windows and " +
          "reset times, straight from the CLI. It costs no tokens, but it does start a " +
          "`claude` process, so it runs your `SessionStart` hooks and takes a few seconds.",
      )
      break
  }

  const stderr = report.processes.filter((proc) => proc.lastStderr)
  if (stderr.length > 0) {
    lines.push("")
    lines.push("**Last stderr**")
    lines.push("")
    for (const proc of stderr) {
      lines.push(`\`${proc.session}\`:`)
      lines.push("")
      lines.push("```text")
      lines.push(proc.lastStderr!.trimEnd())
      lines.push("```")
    }
  }

  return lines.join("\n")
}

/**
 * Why Claude does or does not offer `background` on this host, plus what this
 * process has collected or cancelled.
 *
 * The gate is a recorded read, not a recompute: it comes off opencode's live
 * tool registry while a turn plans its proxy tools (`liveTaskSupportsBackground`),
 * and the doctor may well run before any turn has. "Not read yet" is therefore
 * a real answer and says so rather than guessing `false`, which would read as
 * "your host cannot do this".
 */
function formatBackgroundSubagents(state: {
  gate: BackgroundSubagentGate | undefined
  ledgers: BackgroundTaskLedger[]
}): string[] {
  const lines: string[] = []
  const gate = state.gate
  if (!gate) {
    lines.push(
      "Not read yet this process. The gate is resolved the first time a turn plans its " +
        "proxy tools, so send one message and run this again.",
    )
  } else {
    lines.push("| Field | Value |")
    lines.push("|---|---|")
    lines.push(`| \`background\` offered to Claude | ${gate.supported ? "yes" : "no"} |`)
    lines.push(
      `| \`task_status\` / \`task_cancel\` | ${gate.supported ? "registered" : "not registered"} |`,
    )
    lines.push(`| opencode API | ${gate.hostApi} |`)
    lines.push(`| decided from | ${describeBackgroundGateSource(gate)} |`)
    lines.push(`| read | ${formatAge(Math.max(0, Date.now() - gate.at))} ago |`)
    if (!gate.supported && gate.hostApi === "v1") {
      lines.push("")
      lines.push(
        "opencode 1.x keeps background subagents behind a flag on its OWN process: set " +
          "`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` (or the blanket " +
          "`OPENCODE_EXPERIMENTAL`) in opencode's environment and restart it. The plugin " +
          "never reads that variable itself; it reads whether opencode's advertised `task` " +
          "schema carries a `background` property, which is how opencode publishes the flag.",
      )
    }
  }

  const active = state.ledgers.filter(
    (ledger) => ledger.collected.length > 0 || ledger.cancelled.length > 0,
  )
  lines.push("")
  if (active.length === 0) {
    lines.push("No background task has been collected or cancelled by this process.")
  } else {
    lines.push("| session | collected | cancelled |")
    lines.push("|---|---|---|")
    for (const ledger of active) {
      lines.push(
        `| ${describeSessionKey(ledger.sessionKey).session} | ${list(ledger.collected)} | ${list(
          ledger.cancelled,
        )} |`,
      )
    }
    lines.push("")
    lines.push(
      "A collected task is one this conversation read back with `task_status`, or was told " +
        "about by opencode's own completion notification; a result is handed over once.",
    )
  }
  return lines
}

/** The one sentence that explains the gate's answer on this major. */
function describeBackgroundGateSource(gate: BackgroundSubagentGate): string {
  if (gate.hostApi === "v2") {
    return "opencode 2 offers `background` unconditionally, so the registry is not consulted"
  }
  return gate.registryResolved
    ? "opencode's live `task` schema"
    : "opencode's live tool registry did not answer, so the answer defaulted to no"
}

/**
 * The security probe from the README: an unauthenticated `initialize` with the
 * right Host, no Origin and a JSON content type must be refused. 401 is the
 * patched behaviour; a 200 means this opencode window predates 0.13.2 and is
 * serving an open loopback port that executes Bash through opencode.
 *
 * Deliberately only `initialize`: a `tools/call` probe would run something.
 */
export async function checkProxyAuth(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3000,
): Promise<ProxyAuthCheck> {
  let authority: string
  try {
    authority = new URL(url).host
  } catch {
    return { status: "skipped" }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", host: authority },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
      signal: controller.signal,
    })
    // Drain so the socket is not left half-read.
    await response.text().catch(() => "")
    return response.status === 401
      ? { status: "ok", code: response.status }
      : { status: "unsafe", code: response.status }
  } catch (error) {
    return {
      status: "unreachable",
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

export interface GatherDoctorOptions {
  cliPath: string
  interactive: boolean
  turnStats: boolean
  fetchImpl?: typeof fetch
  /** Whatever followed `/claude-code-doctor`; `usage` asks for plan usage. */
  argument?: string
  /** Seam for tests, threaded to `fetchPlanUsage`. */
  planUsageImpl?: typeof fetchPlanUsage
  /** The provider option, so the `usage` spawn strips a key like a turn does. */
  ignoreAnthropicApiKey?: boolean
  /** Seam for tests: where the log is and whether it is on. */
  logFileImpl?: typeof describeLogFile
  /** Seam for tests: reads the tail of the log file. */
  readLogTailImpl?: (path: string, maxBytes: number) => string
  /** Seam for tests: fixes the per-bundle id salt and the home directory. */
  redactionContextImpl?: RedactionContext
}

/** Assemble the live report. Never throws: a broken field reads as unknown. */
export async function gatherDoctorReport(
  options: GatherDoctorOptions,
): Promise<DoctorReport> {
  const providers = lastDiagnosticsProviders()
  const opencodeVersion =
    lastKnownOpencodeVersion() ??
    process.env.OPENCODE_VERSION ??
    (await detectOpencodeVersion().catch(() => undefined))
  const { claudeCliPath, ...base } = collectStartupDiagnostics(providers, opencodeVersion)
  const cliPath = options.cliPath || claudeCliPath
  const cli = await detectCliVersion(cliPath).catch(() => null)

  const processes = snapshotActiveProcesses()
  const seen = new Set<string>()
  const proxyServers: DoctorProxyRow[] = []
  for (const proc of processes) {
    if (!proc.proxyUrl || seen.has(proc.proxyUrl)) continue
    seen.add(proc.proxyUrl)
    proxyServers.push({
      url: proc.proxyUrl,
      auth: await checkProxyAuth(proc.proxyUrl, options.fetchImpl ?? fetch),
    })
  }

  // Opt-in, and after the cheap fields so a slow or wedged CLI cannot stop the
  // rest of the report being assembled.
  const planUsage: PlanUsage = wantsPlanUsage(options.argument ?? "")
    ? await (options.planUsageImpl ?? fetchPlanUsage)(cliPath, {
        ignoreAnthropicApiKey: options.ignoreAnthropicApiKey,
      })
    : { status: "not-requested" }

  return {
    plugin: base.plugin,
    // `describe`, not `check`: unthrottled, silent, and it claims no session.
    build: staleBuildWatch().describe(),
    opencode: base.opencode,
    claudeCli: { path: cliPath, version: cli?.raw ?? "not detected" },
    cwd: base.cwd,
    providers: base.providers,
    accounts: base.accounts,
    proxyTools: base.proxyTools,
    mcpServers: base.mcpServers,
    permissionPresets: base.permissionPresets,
    transport: options.interactive || base.interactiveTransport ? "interactive" : "headless",
    planModeQuestion: base.planModeQuestion,
    turnStats: options.turnStats,
    anthropicApiKeyInEnv: base.anthropicApiKeyInEnv,
    processes,
    pendingCalls: snapshotPendingProxyCalls(),
    proxyServers,
    mcpServerErrors: snapshotMcpServerErrors(),
    pluginLoadFailures: snapshotPluginLoadFailures(),
    hookFailures: snapshotHookFailures(),
    planUsage,
    backgroundSubagents: {
      gate: snapshotBackgroundSubagentGate(),
      ledgers: snapshotBackgroundTasks(),
    },
  }
}

/**
 * `/claude-code-doctor bundle`: the same report, plus the recent warnings,
 * redacted so the whole thing can be pasted into a GitHub issue.
 *
 * The bundle is appended rather than woven in, and the two whole-report
 * rewrites (home to `~`, session ids to a per-bundle hash) run over the
 * joined text on purpose: the doctor table is what gets pasted along with the
 * log, so leaving `/Users/<name>/...` in the cwd row would defeat the section
 * below it. A plain `/claude-code-doctor`, and `usage`, are untouched.
 *
 * No new provider option and no new spawn: `bundle` reads the `argument` that
 * `usage` already parses (#g167), and unlike `usage` it starts no process at
 * all, so the report stays instant.
 */
export function decorateDoctorReport(report: string, options: GatherDoctorOptions): string {
  if (!wantsDiagnosticBundle(options.argument ?? "")) return report
  const context = options.redactionContextImpl ?? createRedactionContext()
  const logFile = (options.logFileImpl ?? describeLogFile)()
  const section = buildLogBundleSection({
    logPath: logFile.path,
    fileLogging: logFile.enabled,
    context,
    readTailImpl: options.readLogTailImpl,
  })
  return redactForPaste(`${report}\n\n${section}`, context)
}

/**
 * The report a bundle formats, with its free text withheld. A hook's stderr
 * and Claude Code's own sentences about a skipped MCP entry or a plugin that
 * did not load are not plugin-authored and can carry anything (a token in an
 * error, a URL with credentials), and the whole-report rewrites in
 * `decorateDoctorReport` only reach the home directory and session ids. The
 * name, category, kind, outcome and exit code stay: they are what a
 * maintainer reads first. A plain report keeps the text, because there it is
 * the user's own screen.
 */
export function withholdFreeText(report: DoctorReport): DoctorReport {
  const withhold = (text: string): string => (text ? `[redacted, ${text.length} chars]` : text)
  return {
    ...report,
    mcpServerErrors: report.mcpServerErrors.map((error) => ({
      ...error,
      message: withhold(error.message),
    })),
    pluginLoadFailures: report.pluginLoadFailures.map((failure) => ({
      ...failure,
      message: withhold(failure.message),
    })),
    hookFailures: report.hookFailures.map((failure) => ({
      ...failure,
      stderr: withhold(failure.stderr),
    })),
  }
}

/** Format a gathered report as the command answers it, bundle or not. */
export function renderDoctorReport(report: DoctorReport, options: GatherDoctorOptions): string {
  const bundle = wantsDiagnosticBundle(options.argument ?? "")
  return decorateDoctorReport(formatDoctorReport(bundle ? withholdFreeText(report) : report), options)
}

/** The whole command: gather, format, and never let a failure eat the answer. */
export async function buildDoctorReport(options: GatherDoctorOptions): Promise<string> {
  try {
    const report = await gatherDoctorReport(options)
    log.info("claude-code doctor report", {
      plugin: report.plugin,
      verdict: report.build.verdict,
      opencode: report.opencode,
      cwd: report.cwd,
      processes: report.processes.length,
      pendingCalls: report.pendingCalls.length,
      proxyServers: report.proxyServers.map((server) => server.auth.status),
      mcpServerErrors: report.mcpServerErrors.length,
      pluginLoadFailures: report.pluginLoadFailures.length,
      hookFailures: report.hookFailures.length,
      planUsage: report.planUsage.status,
      backgroundSubagents: report.backgroundSubagents.gate?.supported ?? "not read",
    })
    return renderDoctorReport(report, options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn("claude-code doctor failed to build its report", { error: message })
    return `${DOCTOR_MARKER}\n\nCould not build the report: ${message}`
  }
}
