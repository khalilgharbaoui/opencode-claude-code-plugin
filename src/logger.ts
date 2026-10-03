import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { isMainThread } from "node:worker_threads"

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
  _resetLogSinkForTests()
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

// ---------------------------------------------------------------------------
// Where an operator-facing line goes when a full-screen TUI owns the terminal
// ---------------------------------------------------------------------------

/**
 * One entry on its way to the operator. `line` is the same formatted string
 * stderr and the log file get, so a sink that wants the whole thing has it;
 * `message` alone is what a toast shows.
 */
export interface LogSinkEntry {
  level: LogLevel
  message: string
  data?: Record<string, unknown>
  line: string
}

/**
 * Somewhere operator-facing lines can go that is not this process's stderr.
 * Both methods are fire-and-forget by contract: neither may throw, reject into
 * the caller, or log (a sink that logged would re-enter `emit` forever).
 */
export interface LogSink {
  /** Every surfaced entry, whatever its level. */
  log: (entry: LogSinkEntry) => void
  /** warn and error only, already deduplicated by message text. */
  toast: (entry: LogSinkEntry) => void
}

/**
 * Running off the main thread is the measured signal that a full-screen TUI
 * owns this terminal. opencode 1.18.34 runs a plugin in the TUI's own server
 * worker thread (`isMainThread: false`, `threadId: 1`, argv
 * `["bun", "/$bunfs/root/src/cli/tui/worker.js"]`), where stderr IS the
 * terminal the TUI is drawing on, so a `console.error` lands on top of the
 * interface and stays there until something forces a redraw. `opencode run`
 * and `opencode serve` are both main-thread, and so is every test, so they
 * keep writing to stderr. No TUI-specific env var exists to key on instead.
 *
 * opencode 2.0.22 runs plugins in a separate `serve --stdio` subprocess whose
 * stderr is a pipe, on the main thread, so it reads as "not a TUI host" here
 * and is correctly left alone: it never had this problem.
 */
let tuiHostOverride: boolean | undefined

export function isTuiHost(): boolean {
  return tuiHostOverride ?? !isMainThread
}

/**
 * Force the TUI-host answer. Tests use it to exercise both branches without a
 * worker; `undefined` restores the real detection.
 */
export function setTuiHostForTests(value: boolean | undefined): void {
  tuiHostOverride = value
}

/**
 * How many surfaced entries are held while no sink is registered yet. Startup
 * warnings (`warnIfAnthropicApiKey`, the stale-install sweep) are emitted
 * before the plugin has opencode's SDK client, and losing them is exactly the
 * failure this whole mechanism exists to avoid. The sink registers within
 * milliseconds, so in practice this holds a handful of lines; the cap is there
 * so a host that never registers one cannot grow the array without end.
 */
export const MAX_BUFFERED_SINK_ENTRIES = 50

/**
 * How many distinct warn/error texts are remembered for toast deduplication.
 * Past it, deduplication degrades to off rather than to silence: a repeated
 * toast is noise, a withheld one is a problem the operator never hears about.
 */
const MAX_TOASTED_MESSAGES = 200

/**
 * How many toasts one burst may raise, and how long a burst is.
 *
 * Deduplication by message text is not enough on its own, because a burst can
 * be 25 DIFFERENT texts: measured live on 1.18.34, one turn produced 25
 * `MCP server "<name>" is needs-auth in Claude Code` WARNs in the same
 * millisecond, one per server. That is exactly the noise this whole change
 * exists to remove, just in toast form. So the first few go out and the rest
 * are counted into one summary toast that names how many and where to read
 * them. Nothing is withheld from opencode's log or the plugin log file; this
 * governs the screen only.
 */
let toastBurstLimit = 3
let toastBurstWindowMs = 2_000

let activeSink: LogSink | null = null
let bufferedEntries: LogSinkEntry[] = []
let droppedBeforeSink = 0
const toastedMessages = new Set<string>()
let burstWindowStart = 0
let burstCount = 0
let burstSuppressed = 0
let burstSummaryTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Register where TUI-mode lines go, and flush everything buffered since the
 * process started, in order. Replacing a sink is allowed (the V2 entry and the
 * V1 entry can both run in one process); the buffer is only ever flushed once,
 * because it is emptied as it drains.
 */
export function setLogSink(sink: LogSink | null): void {
  activeSink = sink
  if (!sink) return
  const pending = bufferedEntries
  const dropped = droppedBeforeSink
  bufferedEntries = []
  droppedBeforeSink = 0
  for (const entry of pending) deliverToSink(entry)
  if (dropped > 0) {
    // Built here rather than through `log.warn`, which would re-enter `emit`.
    const message = `${dropped} earlier log line(s) were dropped before opencode's log channel was available`
    deliverToSink({
      level: "warn",
      message,
      line: fmt("WARN", message),
    })
  }
}

/** Test-only: forget the sink, the buffer, the toast dedup and the burst. */
export function _resetLogSinkForTests(): void {
  activeSink = null
  bufferedEntries = []
  droppedBeforeSink = 0
  toastedMessages.clear()
  tuiHostOverride = undefined
  if (burstSummaryTimer) clearTimeout(burstSummaryTimer)
  burstSummaryTimer = null
  burstWindowStart = 0
  burstCount = 0
  burstSuppressed = 0
  toastBurstLimit = 3
  toastBurstWindowMs = 2_000
}

/** Test-only: drive the burst guard without sitting through a real window. */
export function _setToastBurstForTests(limit: number, windowMs: number): void {
  toastBurstLimit = limit
  toastBurstWindowMs = windowMs
}

function routeToSink(entry: LogSinkEntry): void {
  if (!activeSink) {
    if (bufferedEntries.length >= MAX_BUFFERED_SINK_ENTRIES) {
      droppedBeforeSink += 1
      return
    }
    bufferedEntries.push(entry)
    return
  }
  deliverToSink(entry)
}

function deliverToSink(entry: LogSinkEntry): void {
  const sink = activeSink
  if (!sink) return
  // A sink that throws is swallowed here and nowhere else: it must never reach
  // the code that called `log.warn`, and it must never be logged either.
  try {
    sink.log(entry)
  } catch {
    // intentionally silent
  }
  if (entry.level !== "warn" && entry.level !== "error") return
  if (toastedMessages.has(entry.message)) return
  if (toastedMessages.size < MAX_TOASTED_MESSAGES) toastedMessages.add(entry.message)
  if (!allowToastNow()) return
  sendToast(sink, entry)
}

function sendToast(sink: LogSink, entry: LogSinkEntry): void {
  try {
    sink.toast(entry)
  } catch {
    // intentionally silent
  }
}

/** Whether this toast fits in the current burst; counts it when it does not. */
function allowToastNow(): boolean {
  const now = Date.now()
  if (now - burstWindowStart >= toastBurstWindowMs) {
    burstWindowStart = now
    burstCount = 0
  }
  if (burstCount < toastBurstLimit) {
    burstCount += 1
    return true
  }
  burstSuppressed += 1
  armBurstSummary()
  return false
}

/**
 * One trailing toast saying how many warnings the burst held back. Unref'd, so
 * it can never keep opencode's process alive, and armed only while something
 * is actually suppressed.
 */
function armBurstSummary(): void {
  if (burstSummaryTimer) return
  burstSummaryTimer = setTimeout(() => {
    burstSummaryTimer = null
    const suppressed = burstSuppressed
    burstSuppressed = 0
    if (suppressed <= 0) return
    const sink = activeSink
    if (!sink) return
    // Built here rather than through `log.warn`, which would re-enter `emit`.
    const message = `${suppressed} more claude-code warning(s) were not shown; the full text is in opencode's log`
    sendToast(sink, { level: "warn", message, line: fmt("WARN", message) })
  }, toastBurstWindowMs)
  burstSummaryTimer.unref?.()
}

/**
 * Whether this entry is meant for the operator rather than only the log file.
 * warn/error always are: a developer who passes the level threshold should
 * still see real problems regardless of mode. Below-threshold entries are
 * filtered earlier by `shouldEmit()`.
 *
 * Where it then goes is `isTuiHost()`'s call, not this function's: outside a
 * full-screen TUI it is stderr exactly as it always was, and inside one it is
 * opencode's own log plus (for warn/error) a toast. See `routeToSink`.
 */
function shouldSurface(level: LogLevel): boolean {
  if (level === "warn" || level === "error") return true
  return activeConfig.mode === "debug"
}

function emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  if (!shouldEmit(level)) return
  const line = fmt(level.toUpperCase(), msg, data)
  if (shouldSurface(level)) {
    if (isTuiHost()) {
      routeToSink({ level, message: msg, data, line })
    } else {
      console.error(line)
    }
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
