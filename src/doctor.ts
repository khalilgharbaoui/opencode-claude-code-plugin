import { detectCliVersion } from "./cli-version.js"
import { log } from "./logger.js"
import {
  snapshotPendingProxyCalls,
  type PendingProxyCallSnapshot,
} from "./proxy-broker.js"
import {
  snapshotActiveProcesses,
  type ActiveProcessSnapshot,
} from "./session-manager.js"
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
 * The name is `claude-code-doctor`, not `claude-code doctor`: opencode
 * commands are invoked as `/<key>` with everything after the first space taken
 * as `$ARGUMENTS`, so a space in the name would make the second word an
 * argument rather than part of the command.
 *
 * Nothing secret goes in it. Not the proxy bearer token, not the value of
 * `ANTHROPIC_API_KEY`, not the system prompt, not a pending call's arguments.
 */

export const DOCTOR_COMMAND = "claude-code-doctor"

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
  opencode: string
  claudeCli: { path: string; version: string }
  cwd: { resolved: string; source: CwdSource }
  providers: string[]
  accounts: string[]
  proxyTools: string[]
  mcpServers: string[]
  transport: "headless" | "interactive"
  planModeQuestion: boolean
  turnStats: boolean
  anthropicApiKeyInEnv: boolean
  processes: ActiveProcessSnapshot[]
  pendingCalls: PendingProxyCallSnapshot[]
  proxyServers: DoctorProxyRow[]
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
 * Markdown, in one text part, led by `DOCTOR_MARKER`. Pure so a test can pin
 * the whole report against a fixed object; everything live is gathered in
 * `gatherDoctorReport`.
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = []
  lines.push(DOCTOR_MARKER)
  lines.push("")
  lines.push("| Field | Value |")
  lines.push("|---|---|")
  lines.push(`| plugin | ${report.plugin} |`)
  lines.push(`| opencode | ${report.opencode} |`)
  lines.push(`| claude CLI | \`${report.claudeCli.path}\` (${report.claudeCli.version}) |`)
  lines.push(`| cwd | \`${report.cwd.resolved}\` (${report.cwd.source}) |`)
  lines.push(`| providers | ${list(report.providers)} |`)
  lines.push(`| accounts | ${list(report.accounts)} |`)
  lines.push(`| proxyTools | ${list(report.proxyTools)} |`)
  lines.push(`| MCP servers (on disk) | ${list(report.mcpServers)} |`)
  lines.push(`| transport | ${report.transport} |`)
  lines.push(`| planModeQuestion | ${report.planModeQuestion} |`)
  lines.push(`| turnStats | ${report.turnStats} |`)
  lines.push(`| ANTHROPIC_API_KEY in env | ${report.anthropicApiKeyInEnv ? "yes" : "no"} |`)

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
      lines.push(
        `| ${call.toolName} | \`${call.toolCallId}\` | ${formatAge(call.ageMs)} | ${formatAge(
          call.deadlineMs,
        )} |`,
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

  return {
    plugin: base.plugin,
    opencode: base.opencode,
    claudeCli: { path: cliPath, version: cli?.raw ?? "not detected" },
    cwd: base.cwd,
    providers: base.providers,
    accounts: base.accounts,
    proxyTools: base.proxyTools,
    mcpServers: base.mcpServers,
    transport: options.interactive || base.interactiveTransport ? "interactive" : "headless",
    planModeQuestion: base.planModeQuestion,
    turnStats: options.turnStats,
    anthropicApiKeyInEnv: base.anthropicApiKeyInEnv,
    processes,
    pendingCalls: snapshotPendingProxyCalls(),
    proxyServers,
  }
}

/** The whole command: gather, format, and never let a failure eat the answer. */
export async function buildDoctorReport(options: GatherDoctorOptions): Promise<string> {
  try {
    const report = await gatherDoctorReport(options)
    log.info("claude-code doctor report", {
      plugin: report.plugin,
      opencode: report.opencode,
      cwd: report.cwd,
      processes: report.processes.length,
      pendingCalls: report.pendingCalls.length,
      proxyServers: report.proxyServers.map((server) => server.auth.status),
    })
    return formatDoctorReport(report)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn("claude-code doctor failed to build its report", { error: message })
    return `${DOCTOR_MARKER}\n\nCould not build the report: ${message}`
  }
}
