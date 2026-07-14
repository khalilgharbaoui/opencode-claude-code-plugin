import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import { EventEmitter } from "node:events"
import { unlink } from "node:fs/promises"
import { log } from "./logger.js"
import type { ProxyMcpServer } from "./proxy-mcp.js"
import { clearLedger } from "./todo-ledger.js"
import {
  cliSupportsThinking,
  cliSupportsThinkingDisplay,
  type CliVersion,
} from "./cli-version.js"

export interface ActiveProcess {
  proc: ChildProcess
  lineEmitter: EventEmitter
  proxyServer?: ProxyMcpServer | null
  /**
   * Hash of the bridged opencode MCP config the process was spawned with.
   * `null` when the bridge produced nothing (no MCP servers). `undefined`
   * when the bridge was disabled. Used to detect mid-session config drift
   * and force a respawn.
   */
  mcpHash?: string | null
  /** Temp file holding `--append-system-prompt-file` content; unlinked on exit. */
  systemPromptFile?: string
}

// One active CLI process per session key. Keyed by a composite
// (cwd + model + opencode session-affinity) so two chats don't race.
// Iteration order is insertion order, which we refresh on access to
// make this a poor-man's LRU; see `touch()` below.
const activeProcesses = new Map<string, ActiveProcess>()
const claudeSessions = new Map<string, string>()
const idleEvictionTimers = new Map<string, ReturnType<typeof setTimeout>>()
const MAX_IDLE_TIMEOUT_MS = 2_147_483_647

// Cap on live CLI subprocesses. Session-affinity-keyed entries accumulate
// one-per-chat, so an unbounded map would leak processes as users open new
// chats. This caps at a reasonable working-set and evicts the oldest.
const MAX_ACTIVE_PROCESSES = 16

function envFlagEnabled(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  if (!normalized) return false
  return !["0", "false", "no", "off"].includes(normalized)
}

export function isClaudeThinkingDisabled(): boolean {
  return (
    envFlagEnabled(process.env.CLAUDE_CODE_DISABLE_THINKING) ||
    envFlagEnabled(process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING)
  )
}

export function claudeSpawnEnv(opts?: {
  ignoreAnthropicApiKey?: boolean
}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    TERM: "xterm-256color",
  }

  // Force subscription auth: with an API key in the env, Claude Code bills
  // pay-as-you-go (Console) instead of the logged-in plan, bypassing the
  // Agent SDK credit. Opt-in via `ignoreAnthropicApiKey`.
  if (opts?.ignoreAnthropicApiKey) {
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
  }

  // Default-on thinking summaries for opus-4-7 (which omits thinking by
  // default on the CLI side). Any var the user has explicitly set in their
  // shell is passed through untouched; the plugin only fills in the default.
  if (
    !isClaudeThinkingDisabled() &&
    process.env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES === undefined
  ) {
    env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES = "1"
  }

  return env
}

function touch(key: string): void {
  const existing = activeProcesses.get(key)
  if (existing) {
    activeProcesses.delete(key)
    activeProcesses.set(key, existing)
  }
}

function cancelIdleProcessEviction(key: string): void {
  const timer = idleEvictionTimers.get(key)
  if (!timer) return
  clearTimeout(timer)
  idleEvictionTimers.delete(key)
}

function evictIfNeeded(): void {
  while (activeProcesses.size >= MAX_ACTIVE_PROCESSES) {
    const oldestKey = activeProcesses.keys().next().value
    if (!oldestKey) break
    log.info("evicting LRU claude process", { sessionKey: oldestKey })
    deleteActiveProcess(oldestKey)
  }
}

export function getActiveProcess(key: string): ActiveProcess | undefined {
  const ap = activeProcesses.get(key)
  if (ap) {
    cancelIdleProcessEviction(key)
    touch(key)
  }
  return ap
}

export function setActiveProcess(key: string, ap: ActiveProcess): void {
  cancelIdleProcessEviction(key)
  activeProcesses.set(key, ap)
}

/**
 * Evict a headless Claude worker after a completed turn has stayed idle.
 * Reusing the worker through `getActiveProcess` cancels the timer. The
 * Claude session id is intentionally retained so the next turn can continue
 * the same conversation via `--resume`.
 */
export function scheduleIdleProcessEviction(
  key: string,
  timeoutMs: number | undefined,
): void {
  cancelIdleProcessEviction(key)
  if (
    typeof timeoutMs !== "number" ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_IDLE_TIMEOUT_MS
  ) {
    return
  }

  const scheduledProcess = activeProcesses.get(key)
  if (!scheduledProcess) return

  const timer = setTimeout(() => {
    idleEvictionTimers.delete(key)
    if (activeProcesses.get(key) !== scheduledProcess) return
    log.info("evicting idle claude process", { sessionKey: key, timeoutMs })
    deleteActiveProcess(key)
  }, timeoutMs)
  timer.unref()
  idleEvictionTimers.set(key, timer)
}

export function deleteActiveProcess(key: string): void {
  cancelIdleProcessEviction(key)
  const ap = activeProcesses.get(key)
  if (ap) {
    void ap.proxyServer?.close()
    ap.proc.kill()
    activeProcesses.delete(key)
  }
}

export function getClaudeSessionId(key: string): string | undefined {
  return claudeSessions.get(key)
}

export function setClaudeSessionId(key: string, sessionId: string): void {
  claudeSessions.set(key, sessionId)
}

export function deleteClaudeSessionId(key: string): void {
  const claudeSessionId = claudeSessions.get(key)
  if (claudeSessionId) clearLedger(claudeSessionId)
  claudeSessions.delete(key)
}

export function spawnClaudeProcess(
  cliPath: string,
  cliArgs: string[],
  cwd: string,
  sessionKey: string,
  proxyServer?: ProxyMcpServer | null,
  mcpHash?: string | null,
  systemPromptFile?: string,
  ignoreAnthropicApiKey?: boolean,
): ActiveProcess {
  evictIfNeeded()
  log.info("spawning new claude process", { cliPath, cliArgs, cwd, sessionKey })

  const proc = spawn(cliPath, cliArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: claudeSpawnEnv({ ignoreAnthropicApiKey }),
    shell: process.platform === "win32",
  })

  const lineEmitter = new EventEmitter()

  const rl = createInterface({ input: proc.stdout! })
  rl.on("line", (line: string) => {
    lineEmitter.emit("line", line)
  })
  rl.on("close", () => {
    lineEmitter.emit("close")
  })

  const ap: ActiveProcess = {
    proc,
    lineEmitter,
    proxyServer: proxyServer ?? null,
    mcpHash,
    systemPromptFile,
  }
  cancelIdleProcessEviction(sessionKey)
  activeProcesses.set(sessionKey, ap)

  // Baseline 'error' listener so Node doesn't throw when the process emits
  // an error between stream turns (no per-stream listener attached then).
  proc.on("error", (err) => {
    log.error("claude process error", { sessionKey, error: err.message })
  })

  proc.on("exit", (code, signal) => {
    log.info("claude process exited", { code, signal, sessionKey })
    void proxyServer?.close()
    if (systemPromptFile) {
      void unlink(systemPromptFile).catch(() => {})
    }
    const ownsSession = activeProcesses.get(sessionKey) === ap
    if (ownsSession) {
      cancelIdleProcessEviction(sessionKey)
      activeProcesses.delete(sessionKey)
    }
    if (ownsSession && code !== 0 && code !== null) {
      log.info("process exited with error, clearing session", {
        code,
        sessionKey,
      })
      claudeSessions.delete(sessionKey)
    }
  })

  proc.stderr?.on("data", (data: Buffer) => {
    const stderr = data.toString()
    log.debug("stderr", { data: stderr.slice(0, 200) })

    if (
      activeProcesses.get(sessionKey) === ap &&
      stderr.includes("Session ID") &&
      (stderr.includes("already in use") ||
        stderr.includes("not found") ||
        stderr.includes("invalid"))
    ) {
      log.warn("claude session ID error, clearing session", {
        sessionKey,
        error: stderr.slice(0, 200),
      })
      claudeSessions.delete(sessionKey)
    }
  })

  return ap
}

export function buildCliArgs(opts: {
  sessionKey: string
  skipPermissions: boolean
  includeSessionResume?: boolean
  model?: string
  permissionMode?: string
  mcpConfig?: string | string[]
  strictMcpConfig?: boolean
  disallowedTools?: string[]
  appendSystemPromptFile?: string
  thinking?: "enabled" | "disabled"
  thinkingDisplay?: "summarized" | "omitted"
  cliVersion?: CliVersion | null
}): string[] {
  const {
    sessionKey,
    skipPermissions,
    includeSessionResume = true,
    model,
    permissionMode,
    mcpConfig,
    strictMcpConfig,
    disallowedTools,
    appendSystemPromptFile,
    thinking,
    thinkingDisplay,
    cliVersion,
  } = opts
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
  ]

  if (model) {
    args.push("--model", model)
  }

  if (permissionMode) {
    args.push("--permission-mode", permissionMode)
  }

  if (includeSessionResume) {
    const sessionId = claudeSessions.get(sessionKey)
    if (sessionId && !activeProcesses.has(sessionKey)) {
      args.push("--resume", sessionId)
    }
  }

  if (mcpConfig) {
    const configs = Array.isArray(mcpConfig) ? mcpConfig : [mcpConfig]
    const filtered = configs.filter((c) => typeof c === "string" && c.length > 0)
    if (filtered.length > 0) {
      args.push("--mcp-config", ...filtered)
    }
  }

  if (strictMcpConfig) {
    args.push("--strict-mcp-config")
  }

  if (disallowedTools && disallowedTools.length > 0) {
    args.push("--disallowedTools", ...disallowedTools)
  }

  // `--thinking` is only present from Claude Code 2.x onward; gate so
  // pre-2.x binaries don't crash with a parse error. Unknown version →
  // skip (the spawn still works, the user just doesn't get extended
  // thinking until they upgrade).
  if (thinking && cliSupportsThinking(cliVersion ?? null)) {
    args.push("--thinking", thinking)
  }

  // `--thinking-display` was added in Claude Code 2.1.142. Older CLIs
  // reject it with a parse error, so gate on detected version. When
  // version is unknown (detection failed), be conservative and skip.
  if (thinkingDisplay && cliSupportsThinkingDisplay(cliVersion ?? null)) {
    args.push("--thinking-display", thinkingDisplay)
  }

  if (appendSystemPromptFile) {
    args.push("--append-system-prompt-file", appendSystemPromptFile)
  }

  if (skipPermissions) {
    args.push("--dangerously-skip-permissions")
  }

  return args
}

/**
 * Build a session key that includes both cwd and model,
 * so different models get separate processes.
 */
export function sessionKey(cwd: string, modelId: string): string {
  return `${cwd}::${modelId}`
}
