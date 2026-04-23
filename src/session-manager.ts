import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import { EventEmitter } from "node:events"
import { log } from "./logger.js"

export interface ActiveProcess {
  proc: ChildProcess
  lineEmitter: EventEmitter
}

// Keyed by cwd - one active process per working directory
const activeProcesses = new Map<string, ActiveProcess>()

// Map cwd -> Claude CLI session ID for session reuse
const claudeSessions = new Map<string, string>()

export function getActiveProcess(key: string): ActiveProcess | undefined {
  return activeProcesses.get(key)
}

export function setActiveProcess(key: string, ap: ActiveProcess): void {
  activeProcesses.set(key, ap)
}

export function deleteActiveProcess(key: string): void {
  const ap = activeProcesses.get(key)
  if (ap) {
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
): ActiveProcess {
  log.info("spawning new claude process", { cliPath, cliArgs, cwd, sessionKey })

  const proc = spawn(cliPath, cliArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TERM: "xterm-256color" },
  })

  const lineEmitter = new EventEmitter()

  const rl = createInterface({ input: proc.stdout! })
  rl.on("line", (line: string) => {
    lineEmitter.emit("line", line)
  })
  rl.on("close", () => {
    lineEmitter.emit("close")
  })

  const ap: ActiveProcess = { proc, lineEmitter }
  activeProcesses.set(sessionKey, ap)

  proc.on("exit", (code, signal) => {
    log.info("claude process exited", { code, signal, sessionKey })
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
  mcpConfig?: string | string[]
  strictMcpConfig?: boolean
}): string[] {
  const {
    sessionKey,
    skipPermissions,
    includeSessionId = true,
    model,
    mcpConfig,
    strictMcpConfig,
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
