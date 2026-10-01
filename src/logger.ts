import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type LogLevel = "debug" | "info" | "notice" | "warn" | "error"
export type LogMode = "silent" | "debug"

export interface LoggerConfig {
  file: boolean
  dir: string | null
  mode: LogMode
  level: LogLevel
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  notice: 2,
  warn: 3,
  error: 4,
}

const MAX_LOG_BYTES = 5 * 1024 * 1024 // 5 MB
const DEFAULT_DIR = join(homedir(), ".local", "share", "opencode-claude-code")

const DEFAULT_CONFIG: LoggerConfig = {
  file: false,
  dir: null,
  mode: "silent",
  level: "info",
}

function parseBoolEnv(v: string | undefined): boolean | undefined {
  if (v == null) return undefined
  const s = v.toLowerCase().trim()
  if (s === "") return undefined
  if (s === "0" || s === "false" || s === "no" || s === "off") return false
  return true
}

function parseLevelEnv(v: string | undefined): LogLevel | undefined {
  if (v == null) return undefined
  const s = v.toLowerCase().trim()
  if (s === "") return undefined
  if (s === "debug" || s === "info" || s === "notice" || s === "warn" || s === "error") {
    return s
  }
  return undefined
}

function parseModeFromDebugEnv(v: string | undefined): LogMode | undefined {
  if (v == null || v === "") return undefined
  return v.includes("opencode-claude-code") ? "debug" : undefined
}

function withEnvOverrides(base: LoggerConfig): LoggerConfig {
  const result: LoggerConfig = { ...base }
  const envFile = parseBoolEnv(process.env.OPENCODE_CLAUDE_CODE_LOG_FILE)
  if (envFile !== undefined) result.file = envFile
  const envDir = process.env.OPENCODE_CLAUDE_CODE_LOG_DIR
  if (envDir !== undefined && envDir !== "") result.dir = envDir
  const envMode = parseModeFromDebugEnv(process.env.DEBUG)
  if (envMode !== undefined) result.mode = envMode
  const envLevel = parseLevelEnv(process.env.OPENCODE_CLAUDE_CODE_LOG_LEVEL)
  if (envLevel !== undefined) result.level = envLevel
  return result
}

let activeConfig: LoggerConfig = withEnvOverrides(DEFAULT_CONFIG)
let fileLoggingDisabled = false

/**
 * Configure the logger from plugin settings. Env vars override the supplied
 * config when explicitly set, so a developer can flip behavior for a single
 * process without editing opencode.jsonc.
 *
 *   `OPENCODE_CLAUDE_CODE_LOG_FILE`   → `file`   (1/true/on/yes vs 0/false/no/off)
 *   `OPENCODE_CLAUDE_CODE_LOG_DIR`    → `dir`
 *   `DEBUG=opencode-claude-code`      → `mode: "debug"`
 *   `OPENCODE_CLAUDE_CODE_LOG_LEVEL`  → `level` (debug | info | notice | warn | error)
 */
export function configureLogger(input: Partial<LoggerConfig>): void {
  const merged: LoggerConfig = { ...DEFAULT_CONFIG, ...input }
  activeConfig = withEnvOverrides(merged)
  fileLoggingDisabled = false
}

export function getLoggerConfig(): LoggerConfig {
  return { ...activeConfig }
}

/** Test-only helper. Resets to defaults+env so tests are deterministic. */
export function _resetLoggerForTests(): void {
  activeConfig = withEnvOverrides(DEFAULT_CONFIG)
  fileLoggingDisabled = false
}

function resolvedLogFile(): string {
  return join(activeConfig.dir ?? DEFAULT_DIR, "plugin.log")
}

/**
 * Where this process writes, and whether it is writing. Read-only, in the
 * sense `snapshotActiveProcesses` is: `/claude-code-doctor bundle` needs the
 * path the running process resolved, including an `OPENCODE_CLAUDE_CODE_LOG_DIR`
 * override, and must not create or touch the file to find out.
 *
 * `enabled` reports what is actually happening, so a log that was disabled
 * mid-process by a write failure reads as off rather than as an empty bundle.
 */
export function describeLogFile(): { path: string; enabled: boolean } {
  return { path: resolvedLogFile(), enabled: activeConfig.file && !fileLoggingDisabled }
}

function rotateIfNeeded(logFile: string): void {
  try {
    const stat = statSync(logFile)
    if (stat.size > MAX_LOG_BYTES) {
      renameSync(logFile, `${logFile}.1`)
    }
  } catch {
    // file does not exist yet — nothing to rotate
  }
}

function writeToFile(line: string): void {
  if (!activeConfig.file) return
  if (fileLoggingDisabled) return
  try {
    const logFile = resolvedLogFile()
    mkdirSync(dirname(logFile), { recursive: true })
    rotateIfNeeded(logFile)
    appendFileSync(logFile, line + "\n", "utf8")
  } catch {
    // Disable on first failure to avoid spamming errors on a read-only FS.
    fileLoggingDisabled = true
  }
}

function fmt(level: string, msg: string, data?: Record<string, unknown>): string {
  const ts = new Date().toISOString()
  const base = `[${ts}] [opencode-claude-code] ${level}: ${msg}`
  if (data && Object.keys(data).length > 0) {
    return `${base} ${JSON.stringify(data)}`
  }
  return base
}

function shouldEmit(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[activeConfig.level]
}

function shouldTui(level: LogLevel): boolean {
  // warn/error are alwaysStderr: a developer who passes the level threshold
  // should still see real problems in the TUI regardless of mode. Below-
  // threshold entries are filtered earlier by shouldEmit().
  if (level === "warn" || level === "error") return true
  return activeConfig.mode === "debug"
}

function emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  if (!shouldEmit(level)) return
  const line = fmt(level.toUpperCase(), msg, data)
  if (shouldTui(level)) {
    console.error(line)
  }
  writeToFile(line)
}

export const log = {
  debug(msg: string, data?: Record<string, unknown>) {
    emit("debug", msg, data)
  },
  info(msg: string, data?: Record<string, unknown>) {
    emit("info", msg, data)
  },
  notice(msg: string, data?: Record<string, unknown>) {
    emit("notice", msg, data)
  },
  warn(msg: string, data?: Record<string, unknown>) {
    emit("warn", msg, data)
  },
  error(msg: string, data?: Record<string, unknown>) {
    emit("error", msg, data)
  },
}
