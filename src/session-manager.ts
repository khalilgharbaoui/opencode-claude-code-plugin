import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { unlink } from "node:fs/promises"
import { log } from "./logger.js"
import type { ProxyMcpServer, ProxyToolResult } from "./proxy-mcp.js"
import { getPendingProxyCalls, type PendingProxyCall } from "./proxy-broker.js"
import { clearLedger } from "./todo-ledger.js"
import { clearExitPlanModeQuestions, hasExitPlanModeQuestions } from "./plan-mode-question.js"
import { clearCompression } from "./compression-store.js"
import {
  cliSupportsFastMode,
  cliSupportsThinking,
  cliSupportsThinkingDisplay,
  type CliVersion,
} from "./cli-version.js"
import type { ReasoningEffort } from "./types.js"
import { dispatchSideQuestionResponse, isSideQuestionPending } from "./side-question.js"

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
  /** Effort the process was spawned with, so a respawn keeps it. */
  effort?: ReasoningEffort
  cliArgs?: string[]
  // Retain resolved calls until continuation settles, including late channel closure.
  pendingProxyCompletions?: Map<string, {
    call: PendingProxyCall
    result: ProxyToolResult
    recoveryRequired: boolean
  }>
  /**
   * stdout lines the child emitted while no turn had a line listener
   * attached (between opencode turns). Bounded; see `bufferUnattendedLine`.
   * Absent on the interactive shim, which has no unattended window.
   */
  unattendedLines?: string[]
  /** Lines evicted from `unattendedLines` because the cap was hit. */
  unattendedDropped?: number
  /**
   * opencode session this process last served, tagged by doStream each turn.
   * `/btw` runs from a command hook that only knows the session id, so this is
   * how it finds the process to ask (see `findActiveProcessBySessionId`).
   */
  opencodeSessionID?: string
  /** What the /btw command hook needs to send a side question to this process early. */
  asideTransport?: { cliPath: string; interactive: boolean }
  /**
   * True from a stdin write that asks the CLI for work until its terminal
   * `result` line, whether or not a turn is still listening. Set by
   * `noteTurnStarted`, cleared by `noteTurnLine` (see `interruptTurn`).
   */
  turnInFlight?: boolean
  turnIdleWaiters?: Array<() => void>
}

/** Most recently used process serving an opencode session id, if any. */
export function findActiveProcessBySessionId(sessionID: string): ActiveProcess | undefined {
  let found: ActiveProcess | undefined
  // Map order is LRU (see `touch`), so the last match is the freshest.
  for (const ap of activeProcesses.values()) {
    if (ap.opencodeSessionID === sessionID) found = ap
  }
  return found
}

// A child normally only speaks while a doStream turn is listening. The one
// exception is a turn that ended on the CLI's side while opencode was still
// waiting on a proxy call (Claude's MCP client gave up on the request and
// the model carried on alone). Keep what it said so the next turn can show
// it instead of losing it; cap it so a runaway child cannot grow the heap.
const UNATTENDED_LINE_CAP = 500
const UNATTENDED_BYTE_CAP = 2 * 1024 * 1024

export function bufferUnattendedLine(ap: ActiveProcess, line: string): void {
  const lines = (ap.unattendedLines ??= [])
  lines.push(line)
  let bytes = 0
  for (const kept of lines) bytes += Buffer.byteLength(kept)
  while (
    lines.length > 0 &&
    (lines.length > UNATTENDED_LINE_CAP || bytes > UNATTENDED_BYTE_CAP)
  ) {
    bytes -= Buffer.byteLength(lines.shift()!)
    ap.unattendedDropped = (ap.unattendedDropped ?? 0) + 1
  }
}

/** Hand over and clear everything the child said while nobody listened. */
export function takeUnattendedLines(ap: ActiveProcess): {
  lines: string[]
  dropped: number
} {
  const lines = ap.unattendedLines ?? []
  const dropped = ap.unattendedDropped ?? 0
  ap.unattendedLines = []
  ap.unattendedDropped = 0
  return { lines, dropped }
}

// One active CLI process per session key. Keyed by a composite
// (cwd + model + opencode session-affinity) so two chats don't race.
// Iteration order is insertion order, which we refresh on access to
// make this a poor-man's LRU; see `touch()` below.
const activeProcesses = new Map<string, ActiveProcess>()
const claudeSessions = new Map<string, string>()
// Idle-eviction timers keyed like `activeProcesses` (idle timeout by
// @bernardofortes, absorbed from a5f723a).
const idleEvictionTimers = new Map<string, ReturnType<typeof setTimeout>>()
const MAX_IDLE_TIMEOUT_MS = 2_147_483_647

// Cap on live CLI subprocesses. Session-affinity-keyed entries accumulate
// one-per-chat, so an unbounded map would leak processes as users open new
// chats. This caps at a reasonable working-set and evicts the oldest.
const MAX_ACTIVE_PROCESSES = 16
const PROCESS_EXIT_TIMEOUT_MS = 1_500
const PROCESS_FORCE_EXIT_TIMEOUT_MS = 500

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

/**
 * The CLI's effort vocabulary is low | medium | high | xhigh | max. `minimal`
 * is this provider's own lowest step with no CLI counterpart, so it lands on
 * `low`.
 */
export function cliEffortLevel(effort: ReasoningEffort): string {
  return effort === "minimal" ? "low" : effort
}

export function claudeSpawnEnv(opts?: {
  ignoreAnthropicApiKey?: boolean
  /** Reasoning effort for this spawn; wins over a shell-level override. */
  effort?: ReasoningEffort
}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    TERM: "xterm-256color",
  }

  // Effort travels as CLAUDE_CODE_EFFORT_LEVEL, which the CLI treats as the
  // session-wide override (it beats settings.json and `/effort`). An env var
  // rather than `--effort` because a CLI too old to know it ignores it
  // instead of refusing to start. Unlike the thinking vars below, an explicit
  // effort from the request wins over the shell: the variant picker and an
  // agent's `reasoningEffort` are per-request choices, a shell export is not.
  if (opts?.effort) {
    env.CLAUDE_CODE_EFFORT_LEVEL = cliEffortLevel(opts.effort)
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

function evictIfNeeded(): void {
  while (activeProcesses.size >= MAX_ACTIVE_PROCESSES) {
    const oldestKey = activeProcesses.keys().next().value
    if (!oldestKey) break
    log.info("evicting LRU claude process", { sessionKey: oldestKey })
    deleteActiveProcess(oldestKey)
  }
}

// Turn lifecycle and interrupt (from @broskees' 68ed142, adapted).
//
// The Claude CLI runs one turn per process. Closing the opencode-side stream
// tells it nothing: before this, an abort only detached our listeners and the
// CLI ran the abandoned turn to completion (Joseph Roberts measured ~7,500
// extra characters generated after abort on a haiku probe), kept billing, kept
// running tools, and its late output landed in whatever turn came next, whose
// own stream was then closed early by the stale `result`. The CLI answers a
// stream-json `control_request` of subtype `interrupt` by aborting the turn
// and emitting a terminal `result`, normally within milliseconds.

const TURN_INTERRUPT_TIMEOUT_MS = 5_000

/** Cheap pre-filter before JSON.parse, since every CLI stdout line hits this. */
function isTerminalResultLine(line: string): boolean {
  if (!line.includes('"result"')) return false
  try {
    return (JSON.parse(line) as { type?: string }).type === "result"
  } catch {
    return false
  }
}

function settleTurn(ap: ActiveProcess): void {
  ap.turnInFlight = false
  const waiters = ap.turnIdleWaiters ?? []
  ap.turnIdleWaiters = []
  for (const wake of waiters) wake()
}

/** Call immediately before any stdin write that asks the CLI to do work. */
export function noteTurnStarted(ap: ActiveProcess): void {
  // The interactive transport never reports through `noteTurnLine`, so a flag
  // set there would never clear.
  if (ap.asideTransport?.interactive) return
  ap.turnInFlight = true
}

/**
 * Feed every CLI stdout line here, independent of whichever turn currently
 * owns the stream: a `result` that lands after its turn detached (the abort
 * case) must still mark the CLI idle rather than leak into the next turn.
 */
export function noteTurnLine(ap: ActiveProcess, line: string): void {
  if (!ap.turnInFlight) return
  if (isTerminalResultLine(line)) settleTurn(ap)
}

export function isTurnInFlight(ap: ActiveProcess): boolean {
  return ap.turnInFlight === true
}

/** Resolves true once the CLI is idle, false if it stayed busy past the timeout. */
export function awaitTurnIdle(ap: ActiveProcess, timeoutMs: number): Promise<boolean> {
  if (!ap.turnInFlight) return Promise.resolve(true)
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      const waiters = ap.turnIdleWaiters ?? []
      const at = waiters.indexOf(wake)
      if (at >= 0) waiters.splice(at, 1)
      resolve(false)
    }, timeoutMs)
    ;(ap.turnIdleWaiters ??= []).push(wake)
  })
}

/** Ask the CLI to abandon the in-flight turn, and wait for it to say it did. */
export function interruptTurn(
  ap: ActiveProcess,
  timeoutMs = TURN_INTERRUPT_TIMEOUT_MS,
): Promise<boolean> {
  if (!ap.turnInFlight) return Promise.resolve(true)
  const stdin = ap.proc.stdin
  if (ap.asideTransport?.interactive || !stdin || !stdin.writable) {
    // A TUI stdin would type the JSON in as text. Wait the turn out instead.
    log.notice("cannot interrupt this transport; waiting for the turn to end")
    return awaitTurnIdle(ap, timeoutMs)
  }
  try {
    stdin.write(
      JSON.stringify({
        type: "control_request",
        request_id: randomUUID(),
        request: { subtype: "interrupt" },
      }) + "\n",
    )
  } catch (error) {
    log.warn("failed to write interrupt control request", {
      error: error instanceof Error ? error.message : String(error),
    })
    return Promise.resolve(false)
  }
  return awaitTurnIdle(ap, timeoutMs)
}

function cancelIdleProcessEviction(key: string): void {
  const timer = idleEvictionTimers.get(key)
  if (!timer) return
  clearTimeout(timer)
  idleEvictionTimers.delete(key)
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

function detachActiveProcess(key: string): ActiveProcess | undefined {
  cancelIdleProcessEviction(key)
  const ap = activeProcesses.get(key)
  if (!ap) return undefined
  activeProcesses.delete(key)
  void ap.proxyServer?.close()
  return ap
}

export function deleteActiveProcess(key: string): void {
  const ap = detachActiveProcess(key)
  ap?.proc.kill()
}

function hasProcessExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null
}

function waitForProcessExit(
  proc: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (hasProcessExited(proc)) return Promise.resolve(true)

  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      proc.off("exit", onExit)
      resolve(hasProcessExited(proc))
    }, timeoutMs)
    proc.once("exit", onExit)
  })
}

export async function deleteActiveProcessAndWait(
  key: string,
  options: {
    exitTimeoutMs?: number
    forceExitTimeoutMs?: number
  } = {},
): Promise<boolean> {
  const ap = detachActiveProcess(key)
  if (!ap || hasProcessExited(ap.proc)) return true

  const gracefulExit = waitForProcessExit(
    ap.proc,
    options.exitTimeoutMs ?? PROCESS_EXIT_TIMEOUT_MS,
  )
  ap.proc.kill()
  if (await gracefulExit) return true

  const forcedExit = waitForProcessExit(
    ap.proc,
    options.forceExitTimeoutMs ?? PROCESS_FORCE_EXIT_TIMEOUT_MS,
  )
  ap.proc.kill("SIGKILL")
  if (await forcedExit) return true

  log.warn("claude process did not exit; starting a fresh session", {
    sessionKey: key,
  })
  deleteClaudeSessionId(key)
  return false
}

export function getClaudeSessionId(key: string): string | undefined {
  return claudeSessions.get(key)
}

export function setClaudeSessionId(key: string, sessionId: string): void {
  claudeSessions.set(key, sessionId)
}

export function deleteClaudeSessionId(key: string): void {
  clearExitPlanModeQuestions(key)
  const claudeSessionId = claudeSessions.get(key)
  if (claudeSessionId) clearLedger(claudeSessionId)
  claudeSessions.delete(key)
}

export function effortSessionKey(baseKey: string, effort?: ReasoningEffort): string {
  return effort ? `${baseKey}::effort=${effort}` : baseKey
}

/** Retire sibling effort sessions before deciding whether to replay history. */
export function invalidateOtherEffortSessions(
  baseKey: string,
  effort?: ReasoningEffort,
): void {
  const levels: (ReasoningEffort | undefined)[] = [
    undefined, "minimal", "low", "medium", "high", "xhigh", "max",
  ]
  const staleKeys = levels
    .filter((level) => level !== effort)
    .map((level) => effortSessionKey(baseKey, level))

  // Refuse the transition atomically. Tool results and recovery completions
  // still belong to the old process; they must finish at its original effort.
  for (const key of staleKeys) {
    const active = activeProcesses.get(key)
    if (
      getPendingProxyCalls(key).length ||
      hasExitPlanModeQuestions(key) ||
      active?.pendingProxyCompletions?.size ||
      (active && (active.lineEmitter.listenerCount("line") > 0 || isSideQuestionPending(active)))
    ) {
      throw new Error(
        "Cannot change reasoning effort while the previous effort session has pending work. Finish that work at its original effort first.",
      )
    }
  }
  for (const key of staleKeys) {
    deleteActiveProcess(key)
    deleteClaudeSessionId(key)
    clearCompression(key)
  }
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
  effort?: ReasoningEffort,
): ActiveProcess {
  evictIfNeeded()
  log.info("spawning new claude process", {
    cliPath,
    cliArgs,
    cwd,
    sessionKey,
    effort,
  })

  const proc = spawn(cliPath, cliArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: claudeSpawnEnv({ ignoreAnthropicApiKey, effort }),
    shell: process.platform === "win32",
  })

  const lineEmitter = new EventEmitter()

  const ap: ActiveProcess = {
    proc,
    lineEmitter,
    proxyServer: proxyServer ?? null,
    mcpHash,
    systemPromptFile,
    effort,
    cliArgs: [...cliArgs],
    unattendedLines: [],
    unattendedDropped: 0,
  }

  const rl = createInterface({ input: proc.stdout! })
  rl.on("line", (line: string) => {
    if (dispatchSideQuestionResponse(ap, line)) return
    noteTurnLine(ap, line)
    if (lineEmitter.listenerCount("line") === 0) {
      bufferUnattendedLine(ap, line)
      return
    }
    lineEmitter.emit("line", line)
  })
  rl.on("close", () => {
    settleTurn(ap)
    lineEmitter.emit("close")
  })
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
    const ownsSessionKey = activeProcesses.get(sessionKey) === ap
    if (ownsSessionKey) {
      cancelIdleProcessEviction(sessionKey)
      activeProcesses.delete(sessionKey)
    }
    if (ownsSessionKey && code !== 0 && code !== null) {
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

    // "No conversation found with session ID: <uuid>" is what `--resume`
    // prints for a purged transcript — note the lowercase "session ID",
    // which the capitalized match below does not catch.
    if (
      stderr.includes("No conversation found") ||
      (stderr.includes("Session ID") &&
        (stderr.includes("already in use") ||
          stderr.includes("not found") ||
          stderr.includes("invalid")))
    ) {
      if (activeProcesses.get(sessionKey) === ap) {
        log.warn("claude session ID error, clearing session", {
          sessionKey,
          error: stderr.slice(0, 200),
        })
        claudeSessions.delete(sessionKey)
      } else {
        log.debug("ignoring session ID error from stale claude process", {
          sessionKey,
        })
      }
    }
  })

  return ap
}

/**
 * Append `--resume <id>` to an already-built args vector when a Claude
 * conversation id is known for the session and the args don't already carry
 * a session flag. Used by `respawnActiveProcess` to resume the conversation
 * in a fresh child without rebuilding the whole (version-gated) args vector.
 * `--resume`, not `--session-id`: the latter means "create a NEW session
 * with this UUID" and the CLI rejects it with "Session ID ... is already in
 * use" whenever a transcript exists on disk — which is exactly the state a
 * mid-conversation respawn is in. If the wedged child died before writing
 * any transcript, `--resume` fails with "No conversation found with session
 * ID", which the stderr recovery matcher already catches (fresh-session
 * fallback).
 */
export function appendResumeIfNeeded(
  sessionKey: string,
  cliArgs: string[],
): string[] {
  if (cliArgs.includes("--resume") || cliArgs.includes("--session-id")) {
    return cliArgs
  }
  const sid = claudeSessions.get(sessionKey)
  if (!sid) return cliArgs
  return [...cliArgs, "--resume", sid]
}

/**
 * Replace a wedged reused process with a fresh one, resuming the same
 * Claude conversation. Used by the doStream start-watchdog when a reused
 * process produces no stdout within a grace window after a fresh-turn
 * envelope write — observed after a very long proxy-blocked tool call
 * (e.g. a multi-minute `task` subagent). Before the per-tool proxy timeout
 * fix this was masked because the flat 10-minute ceiling ended the turn
 * first; now that the task proxy blocks and returns successfully, resuming
 * a reused child after such a long wait can leave it silent on stdout.
 *
 * Reuses the existing proxy server, system-prompt file, and MCP hash (their
 * handles are already baked into `cliArgs`' `--mcp-config`/append-prompt
 * paths), so this only swaps the child process. The old child's exit
 * handler is silenced before kill so it doesn't close the proxy server we
 * are reusing; the new child gets its own exit handler from
 * `spawnClaudeProcess`. `claudeSessions` is left intact so the respawn can
 * add `--resume` (see `appendResumeIfNeeded`).
 *
 * Returns the new `ActiveProcess`, or `undefined` if there was no active
 * process for the key (caller should treat that as "nothing to respawn").
 */
export function respawnActiveProcess(
  sessionKey: string,
  cliPath: string,
  cliArgs: string[],
  cwd: string,
  ignoreAnthropicApiKey?: boolean,
): ActiveProcess | undefined {
  const old = activeProcesses.get(sessionKey)
  if (!old) return undefined
  activeProcesses.delete(sessionKey)
  // Silence the old exit handler so it doesn't close the proxy server,
  // unlink the system-prompt file, or touch claudeSessions on its way out
  // — those handles are reused by the new child. spawnClaudeProcess wires
  // a fresh exit handler for the respawned child.
  old.proc.removeAllListeners("exit")
  try {
    old.proc.kill()
  } catch {}
  const replacement = spawnClaudeProcess(
    cliPath,
    appendResumeIfNeeded(sessionKey, old.cliArgs ?? cliArgs),
    cwd,
    sessionKey,
    old.proxyServer,
    old.mcpHash,
    old.systemPromptFile,
    ignoreAnthropicApiKey,
    old.effort,
  )
  replacement.pendingProxyCompletions = old.pendingProxyCompletions
  delete old.pendingProxyCompletions
  return replacement
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
  /** `--plugin-dir` values (skill bridge), one flag per directory. */
  pluginDirs?: string[]
  thinking?: "enabled" | "disabled"
  thinkingDisplay?: "summarized" | "omitted"
  fastMode?: boolean
  cliVersion?: CliVersion | null
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
    pluginDirs,
    thinking,
    thinkingDisplay,
    fastMode,
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

  // `--session-id` means "create a NEW session with this UUID" and the CLI
  // exits with "Session ID ... is already in use" whenever a transcript for
  // that ID already exists on disk. Continuing an existing session requires
  // `--resume` (which keeps the same session ID in print mode).
  if (includeSessionId) {
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
  for (const dir of pluginDirs ?? []) {
    args.push("--plugin-dir", dir)
  }

  // Fast mode's only headless opt-in. `--settings` feeds the CLI's
  // `flagSettings` layer, which is the one its SDK gate checks; a `fastMode`
  // in the user's own settings.json is NOT enough for a `--print` run.
  // Built as one object so later flag-settings keys merge here instead of
  // adding a second `--settings` (the CLI takes the flag once).
  if (fastMode && cliSupportsFastMode(cliVersion ?? null)) {
    args.push("--settings", JSON.stringify({ fastMode: true }))
  }

  // Plan mode is a capability restriction, not a prompt policy, and the CLI
  // lets `--dangerously-skip-permissions` override it outright: measured on
  // 2.1.258, a plan-mode run carrying both flags wrote a file on request
  // without prompting, while the same run without the skip flag refused and
  // created nothing. Since `skipPermissions` defaults to true, passing both
  // is the common case, so anyone asking for plan mode was silently getting
  // full write access. Plan mode must never permit edits, so it wins here.
  // Every other `permissionMode` value governs prompting, which is exactly
  // what the skip flag is for, so those still pass both.
  if (skipPermissions && permissionMode !== "plan") {
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
