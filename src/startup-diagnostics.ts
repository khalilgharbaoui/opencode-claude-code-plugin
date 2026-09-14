import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

import { detectCliVersion } from "./cli-version.js"
import { log } from "./logger.js"
import { mergeOpencodeMcp } from "./mcp-bridge.js"
import { getOpencodeProjectDirectory, isUsableDirectory } from "./runtime-status.js"

/**
 * One compact status block logged once per process, right after providers are
 * registered. Every field here answers a question that previously cost a live
 * debugging session: which plugin build is loaded, whether the Claude CLI is
 * even reachable, which cwd the spawn will use and why, what is proxied, and
 * how many MCP servers the bridge sees. Keep it cheap and never let it throw:
 * diagnostics must not be able to break provider registration.
 */
export interface StartupDiagnostics {
  plugin: string
  opencode: string
  claudeCli: { path: string; version: string }
  cwd: { resolved: string; source: CwdSource }
  providers: string[]
  accounts: string[]
  proxyTools: string[]
  mcpServers: string[]
  interactiveTransport: boolean
  /** ExitPlanMode approval routed through opencode's `question` tool. */
  planModeQuestion: boolean
  anthropicApiKeyInEnv: boolean
}

/** Which branch of `resolveSpawnCwd` a Claude CLI spawn would take right now. */
export type CwdSource = "configured" | "process" | "captured" | "unresolved"

export interface DiagnosticsProviderEntry {
  name?: string
  options?: Record<string, unknown>
}

let cachedPluginVersion: string | undefined

/** Version of this plugin, read from the package manifest one level up. */
export function pluginVersion(): string {
  if (cachedPluginVersion) return cachedPluginVersion
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const raw = fs.readFileSync(path.join(here, "..", "package.json"), "utf8")
    const version = (JSON.parse(raw) as { version?: unknown }).version
    cachedPluginVersion = typeof version === "string" ? version : "unknown"
  } catch {
    cachedPluginVersion = "unknown"
  }
  return cachedPluginVersion
}

/**
 * Best-effort opencode version from the plugin input. Re-verified on opencode
 * 1.18.5: nothing on the plugin surface carries it. `PluginInput` has no
 * version field, the SDK client's `app` namespace exposes only `log`/`agents`,
 * and the server has no `/version` route. So this probes a couple of plausible
 * shapes for future opencode releases and otherwise returns undefined, leaving
 * the binary probe (`detectOpencodeVersion`) as the fallback. Do not replace it
 * with a `client.app.get()` call — that method does not exist.
 */
export function pickOpencodeVersion(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const app = (input as { app?: unknown }).app
  if (app && typeof app === "object") {
    const version = (app as { version?: unknown }).version
    if (typeof version === "string" && version.length > 0) return version
  }
  const direct = (input as { version?: unknown }).version
  if (typeof direct === "string" && direct.length > 0) return direct
  return undefined
}

const execFileAsync = promisify(execFile)

let opencodeVersionProbe: Promise<string | undefined> | undefined

/**
 * The plugin runs *inside* opencode's process, so `process.execPath` is the
 * opencode binary itself — asking it for `--version` is the only reliable way
 * to name the version, since the plugin API exposes it nowhere (see
 * `pickOpencodeVersion`). Guarded on the basename: when opencode is run from
 * source (`bun run packages/opencode/src/index.ts`) execPath is the Bun binary,
 * and reporting Bun's version as opencode's would be worse than "unknown".
 * Cached, 5s timeout, never throws.
 */
export function detectOpencodeVersion(
  execPath: string = process.execPath,
): Promise<string | undefined> {
  if (opencodeVersionProbe) return opencodeVersionProbe
  opencodeVersionProbe = (async (): Promise<string | undefined> => {
    if (!path.basename(execPath).toLowerCase().includes("opencode")) {
      log.debug("skipping opencode version probe: execPath is not opencode", { execPath })
      return undefined
    }
    try {
      const { stdout } = await execFileAsync(execPath, ["--version"], { timeout: 5000 })
      const match = /\d+\.\d+\.\d+\S*/.exec(stdout.trim())
      return match ? match[0] : undefined
    } catch (err) {
      log.debug("opencode version probe failed", {
        execPath,
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  })()
  return opencodeVersionProbe
}

/** Test seam: drop the cached probe so a fresh execPath is honored. */
export function resetOpencodeVersionProbe(): void {
  opencodeVersionProbe = undefined
}

/**
 * Mirror of `resolveSpawnCwd`'s priority order, but reporting *which* branch
 * won. `configured` means `options.cwd` pinned it, `process` is the normal
 * lazy path, `captured` means `process.cwd()` was unusable (macOS GUI launch
 * at `/`) and the captured project directory rescued it — that one is the
 * fingerprint of issue #4.
 */
export function describeSpawnCwd(
  configured: unknown,
  live: string = process.cwd(),
  captured: string | undefined = getOpencodeProjectDirectory(),
): { resolved: string; source: CwdSource } {
  if (typeof configured === "string" && configured.length > 0) {
    return { resolved: configured, source: "configured" }
  }
  if (isUsableDirectory(live)) return { resolved: live, source: "process" }
  if (isUsableDirectory(captured)) return { resolved: captured, source: "captured" }
  return { resolved: live, source: "unresolved" }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string")
}

function firstOption(
  providers: Record<string, DiagnosticsProviderEntry>,
  key: string,
): unknown {
  for (const entry of Object.values(providers)) {
    const value = entry?.options?.[key]
    if (value !== undefined) return value
  }
  return undefined
}

export function collectStartupDiagnostics(
  providers: Record<string, DiagnosticsProviderEntry>,
  opencodeVersion?: string,
): Omit<StartupDiagnostics, "claudeCli"> & { claudeCliPath: string } {
  const accounts: string[] = []
  for (const entry of Object.values(providers)) {
    const account = entry?.options?.account
    if (typeof account === "string" && account.length > 0) accounts.push(account)
  }

  const cwd = describeSpawnCwd(firstOption(providers, "cwd"))

  let mcpServers: string[] = []
  try {
    // Disk-only view: opencode's runtime MCP status isn't settled at plugin
    // init (servers are still connecting), so the per-turn overlay is not
    // applied here. This is what the bridge would ship on a cold start.
    mcpServers = mergeOpencodeMcp(cwd.resolved).enabledServerNames
  } catch (err) {
    log.debug("startup diagnostics could not read MCP config", {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return {
    plugin: pluginVersion(),
    opencode: opencodeVersion ?? process.env.OPENCODE_VERSION ?? "unknown",
    claudeCliPath: String(firstOption(providers, "cliPath") ?? "claude"),
    cwd,
    providers: Object.keys(providers),
    accounts,
    proxyTools: stringList(firstOption(providers, "proxyTools")),
    mcpServers,
    interactiveTransport:
      firstOption(providers, "interactive") === true ||
      process.env.CLAUDE_CODE_INTERACTIVE_TRANSPORT === "1",
    planModeQuestion: firstOption(providers, "planModeQuestion") === true,
    anthropicApiKeyInEnv: Boolean(
      process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
    ),
  }
}

let logged = false
let lastProviders: Record<string, DiagnosticsProviderEntry> = {}
let lastOpencodeVersion: string | undefined

/**
 * The providers the config hook last registered, so `/claude-code-doctor` can
 * re-run `collectStartupDiagnostics` on demand instead of reporting a snapshot
 * frozen at startup. Kept here rather than in the doctor because this is
 * already the module that owns the shape.
 */
export function lastDiagnosticsProviders(): Record<string, DiagnosticsProviderEntry> {
  return lastProviders
}

export function lastKnownOpencodeVersion(): string | undefined {
  return lastOpencodeVersion
}

/**
 * Emit the startup block once per process. Fire-and-forget: the Claude CLI
 * version probe is async (`claude --version`, 5s timeout, cached), and a slow
 * or missing binary must never delay provider registration.
 */
export function logStartupDiagnostics(
  providers: Record<string, DiagnosticsProviderEntry>,
  opencodeVersion?: string,
): void {
  // Recorded before the once-per-process guard: an account expansion calls
  // this a second time with the real provider set, and the doctor should read
  // that one rather than the pre-expansion view.
  lastProviders = providers
  if (opencodeVersion) lastOpencodeVersion = opencodeVersion
  if (logged) return
  logged = true
  void (async () => {
    try {
      // Probe the binary only when the plugin input and env gave us nothing,
      // so a future opencode that reports its version costs no spawn.
      const version =
        opencodeVersion ?? process.env.OPENCODE_VERSION ?? (await detectOpencodeVersion())
      const { claudeCliPath, ...rest } = collectStartupDiagnostics(providers, version)
      const cli = await detectCliVersion(claudeCliPath)
      const diagnostics: StartupDiagnostics = {
        ...rest,
        claudeCli: { path: claudeCliPath, version: cli?.raw ?? "not detected" },
      }
      log.notice("claude-code plugin ready", { ...diagnostics })
    } catch (err) {
      log.debug("startup diagnostics failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })()
}

/** For tests. */
export function _resetStartupDiagnostics(): void {
  logged = false
  lastProviders = {}
  lastOpencodeVersion = undefined
}
