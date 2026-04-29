import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import { EventEmitter } from "node:events"
import { unlink } from "node:fs/promises"
import { log } from "./logger.js"
import type { ProxyMcpServer } from "./proxy-mcp.js"

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

// Cap on live CLI subprocesses. Session-affinity-keyed entries accumulate
// one-per-chat, so an unbounded map would leak processes as users open new
// chats. This caps at a reasonable working-set and evicts the oldest.
const MAX_ACTIVE_PROCESSES = 16

function touch(key: string): void {
  const existing = activeProcesses.get(key)
  if (existing) {
    activeProcesses.delete(key)
    activeProcesses.set(key, existing)
  }
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
  if (ap) touch(key)
  return ap
}

export function setActiveProcess(key: string, ap: ActiveProcess): void {
  activeProcesses.set(key, ap)
}

export function deleteActiveProcess(key: string): void {
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
): ActiveProcess {
  evictIfNeeded()
  log.info("spawning new claude process", { cliPath, cliArgs, cwd, sessionKey })

  const proc = spawn(cliPath, cliArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TERM: "xterm-256color" },
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
    activeProcesses.delete(sessionKey)
    if (code !== 0 && code !== null) {
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
  includeSessionId?: boolean
  model?: string
  permissionMode?: string
  mcpConfig?: string | string[]
  strictMcpConfig?: boolean
  disallowedTools?: string[]
  appendSystemPromptFile?: string
}): string[] {
  const {
    sessionKey,
    skipPermissions,
    includeSessionId = true,
    model,
    permissionMode,
    mcpConfig,
    strictMcpConfig,
    disallowedTools,
    appendSystemPromptFile,
  } = opts
  const args = [
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
  ]

  if (model) {
    args.push("--model", model)
  }

  if (permissionMode) {
    args.push("--permission-mode", permissionMode)
  }

  if (includeSessionId) {
    const sessionId = claudeSessions.get(sessionKey)
    if (sessionId && !activeProcesses.has(sessionKey)) {
      args.push("--session-id", sessionId)
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
