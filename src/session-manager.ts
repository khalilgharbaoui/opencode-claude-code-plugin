import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { unlink } from "node:fs/promises"
import { log } from "./logger.js"
import { reportUnrecognizedModel } from "./cli-events.js"
import { SERVER_CLOSED_MESSAGE, type ProxyMcpServer, type ProxyToolResult } from "./proxy-mcp.js"
import {
  getPendingProxyCalls,
  hasAnyPendingProxyCall,
  rejectAllPendingProxyCallsForSession,
  type PendingProxyCall,
} from "./proxy-broker.js"
import { clearLedger } from "./todo-ledger.js"
import { clearExitPlanModeQuestions, hasExitPlanModeQuestions } from "./plan-mode-question.js"
import { clearAccountFailoverQuestions, hasAccountFailoverQuestions } from "./account-failover.js"
import {
  clearSubagentDispatchQuestions,
  forgetDispatchChoicesForSession,
  forgetSessionChoice,
  hasPendingSubagentDispatch,
} from "./subagent-dispatch.js"
import { forgetExplicitTaskModel, hasUnclaimedExplicitTaskModels } from "./task-model.js"
import { clearCompression } from "./compression-store.js"
import { clearBackgroundTasks } from "./background-tasks.js"
import { forgetForkFingerprint, moveForkFingerprint } from "./session-fork.js"
import { forgetServedConversation, moveServedConversation } from "./conversation-gap.js"
import { forgetResumePoint, moveResumePoint } from "./session-resume-store.js"
import {
  cliHygieneEnv,
  cliSupportsFastMode,
  cliSupportsPermissionPrompts,
  cliSupportsRestricted,
  cliSupportsThinking,
  cliSupportsThinkingDisplay,
  type CliVersion,
  spawnMcpTimeoutEnv,
} from "./cli-version.js"
import { isReadOnlyPermissionMode } from "./permission-presets.js"
import { planClaudeSpawn } from "./windows-spawn.js"
import type { ReasoningEffort } from "./types.js"
import { dispatchSideQuestionResponse, isSideQuestionPending } from "./side-question.js"
import { noteRelayMemberServing } from "./session-event-relay.js"

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
  /**
   * The opencode MCP server names that were enabled when this process was
   * spawned, so the hot-reload decision can say which ones joined or left
   * instead of printing two hashes at an operator. Pre-exclusion, matching
   * `effectiveMcpConfig`'s `allEnabledServerNames`: it mirrors what opencode
   * has enabled, not which route each server took.
   */
  mcpServers?: string[]
  /** Temp file holding `--append-system-prompt-file` content; unlinked on exit. */
  systemPromptFile?: string
  /** Effort the process was spawned with, so a respawn keeps it. */
  effort?: ReasoningEffort
  /** Prompt cache TTL the process was spawned with, so a respawn keeps it. */
  promptCacheTtl?: string
  /** Whether the child was spawned with `enableTodoTools`, so a respawn keeps it. */
  enableTodoTools?: boolean
  /** When the child was spawned, so `/claude-code-doctor` can report its age. */
  startedAt?: number
  /**
   * The binary this child was spawned with. Account failover compares it
   * against the path the current turn resolves to: a difference means the
   * conversation has moved to another account, and this child has to go,
   * because it speaks to the CLI it was spawned as. Its Claude session id
   * does not have to go with it: a transcript copied into the other account's
   * config dir resumes there (`src/account-transcript.ts`, h #g218), and only
   * a refused carry drops the id and replays the thread. The interactive shim
   * records it too, so a TUI fails over on the same terms (h #g209).
   */
  cliPath?: string
  cliArgs?: string[]
  /**
   * The `CLAUDE_CONFIG_DIR` this child was spawned with, where the plugin set
   * it itself (`accountInProcess`, Windows). It is the account identity there,
   * because every account shares one binary when no wrapper is generated, so
   * `cliPath` alone cannot tell two accounts apart. Undefined on POSIX, where
   * the wrapper path already names the account.
   */
  configDir?: string
  /**
   * How many of the plain user messages after the assistant message at
   * `assistantIndex` a tool-result turn has already written to this child. A
   * later tool-result turn for the same boundary (parallel proxy calls finish
   * in separate opencode turns) sends only what is beyond `count`. A respawned
   * child starts without it, on purpose: a message the killed child had only
   * queued would be lost if it were carried, and one it had already attached is
   * merely repeated if it is reset, and repeating is the safer failure.
   */
  forwardedUserMessages?: { assistantIndex: number; count: number }
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
   * Set by the interactive transport only, which has no stdin protocol to
   * carry an `interrupt` control request and keeps its own turn state.
   * `interruptTurn` and `isTurnInFlight` ask it instead of `turnInFlight`.
   */
  interactiveControl?: {
    turnRunning(): boolean
    /** True while the TUI is parked on an `ExitPlanMode` approval: the next
     *  message answers it instead of being a new turn. */
    planApprovalPending?(): boolean
    /** Type a user message into the running TUI turn's own input queue, which
     *  the TUI attaches to the turn's next model call; resolves true once the
     *  TUI recorded the enqueue (h #g206). */
    queueInput?(content: unknown): Promise<boolean>
    /** Answer a `/btw` from a short-lived fork of this conversation, which
     *  shares its prompt cache and never writes to it (h #g203). */
    askAside?(
      question: string,
      options: {
        history?: readonly { question: string; response: string }[]
        timeoutMs?: number
        abortSignal?: AbortSignal
      },
    ): Promise<string>
    /** Esc to the TUI; resolves true once the turn ended. */
    interrupt(timeoutMs: number): Promise<boolean>
    /** Hand the attached turn every record the TUI has already written. */
    flushTranscript(): void
  }
  /**
   * True from a stdin write that asks the CLI for work until its terminal
   * `result` line, whether or not a turn is still listening. Set by
   * `noteTurnStarted`, cleared by `noteTurnLine` (see `interruptTurn`).
   */
  turnInFlight?: boolean
  turnIdleWaiters?: Array<() => void>
  /**
   * True once the child has written its first `system`/`init` line, whether or
   * not a turn was listening. Claude Code writes it only after every MCP server
   * has connected or hit `MCP_TIMEOUT` (measured on 2.1.293: a server answering
   * at 8 s held it to 8.8 s), so until then a silent child may simply be
   * waiting on a server, and the start watchdog gives it that wait (h #g256).
   * A respawn is a new child and starts without it. Never set on the
   * interactive shim, whose start watchdog does not respawn.
   */
  initSeen?: boolean
  /**
   * Tail of what the child last wrote to stderr, capped at
   * `STDERR_RETAIN_BYTES` with the newest bytes kept. Often the only record
   * of why a child died when it closed without emitting a terminal `result`
   * line; see `describeChildCrash`.
   */
  lastStderr?: string
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

// The CLI writes its own diagnostics to stderr, which is where the reason a
// child died is usually the only thing on record. Keep the tail so a turn
// that ends with the child gone can say why; bounded, newest bytes win.
const STDERR_RETAIN_BYTES = 2 * 1024

export function retainStderr(ap: ActiveProcess, chunk: string): void {
  ap.lastStderr = ((ap.lastStderr ?? "") + chunk).slice(-STDERR_RETAIN_BYTES)
}

/**
 * One line (plus the stderr tail) explaining a child that closed its stdio
 * without emitting a terminal `result`. Before this the turn simply finished
 * with reason `stop` and empty usage, so a crashed CLI read as a short but
 * successful answer.
 */
export function describeChildCrash(
  exitCode: number | null | undefined,
  signal: NodeJS.Signals | null | undefined,
  lastStderr: string | undefined,
): string {
  const how = signal
    ? `was killed by ${signal}`
    : typeof exitCode === "number"
      ? `exited with code ${exitCode}`
      : "closed its output"
  const tail = lastStderr?.trim()
  return (
    `The Claude Code CLI ${how} before finishing this turn (no result was emitted), ` +
    "so the answer above may be incomplete." +
    (tail ? `\n\nLast stderr from the CLI:\n${tail}` : "")
  )
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

/**
 * Idle eviction is off unless `idleProcessTimeoutMs` is set: an unset option
 * resolves to 0, which arms no timer, so workers live until LRU eviction as
 * they always have. PR #36 (@broskees) proposed 30 minutes by default; that
 * was reverted at merge because it changes when a resumed chat pays for a
 * fresh `--resume` spawn, which is the user's call. An idle `claude --print`
 * holds roughly 250 MB resident, so setting it is worth documenting, not
 * imposing. The Claude session id survives eviction either way.
 */
export const DEFAULT_IDLE_PROCESS_TIMEOUT_MS = 0

/** The idle timeout a caller-facing option resolves to: unset means the default. */
export function resolveIdleProcessTimeoutMs(configured: number | undefined): number {
  return configured === undefined ? DEFAULT_IDLE_PROCESS_TIMEOUT_MS : configured
}

// Cap on live CLI subprocesses. Session-affinity-keyed entries accumulate
// one-per-chat, so an unbounded map would leak processes as users open new
// chats. This caps at a reasonable working-set and evicts the oldest idle
// one, never a process that is mid-turn. Kept at 16: PR #36 proposed 8 on
// the assumption that a default idle timer does the real work, and that
// default was not adopted, so the cap is still the only bound.
export const MAX_ACTIVE_PROCESSES = 16
const PROCESS_EXIT_TIMEOUT_MS = 1_500
const PROCESS_FORCE_EXIT_TIMEOUT_MS = 500
/** Same wording the attached turn's close handler uses, so one log line
 * shape covers a child that died mid-turn and one that died between turns. */
export const CHILD_EXITED_MESSAGE =
  "Claude CLI subprocess closed before pending tool calls were resolved"

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
  /** Prompt cache TTL (`5m` / `1h`) for this spawn; wins over the shell. */
  promptCacheTtl?: string
  /**
   * `CLAUDE_CONFIG_DIR` for this spawn. Passed only where the plugin applies
   * an account itself (`accountInProcess`, Windows); on POSIX the per-account
   * wrapper exports it and this stays undefined, so a default install's
   * environment is untouched.
   */
  configDir?: string
  /** The `enableTodoTools` provider option; see `todoToolsEnv`. */
  enableTodoTools?: boolean
}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    TERM: "xterm-256color",
    // Pin the child to the binary whose version we detected, and keep it off
    // non-essential network calls. Fills gaps only, so an explicit shell value
    // survives: see `cliHygieneEnv` for why the version has to hold still.
    ...cliHygieneEnv(),
    // 120 s for MCP servers to start, so a subagent outlasts an opencode
    // stall instead of running without the proxy: see `spawnMcpTimeoutEnv`.
    ...spawnMcpTimeoutEnv(),
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

  // Prompt cache TTL travels as CLAUDE_CODE_PROMPT_CACHE_TTL, the CLI's
  // MAIN-conversation setting, because every process this plugin spawns is a
  // main conversation even when it is serving an opencode subagent
  // (`resolveAgentCacheTtl` has the measurement). An env var rather than a
  // flag for the same reason as effort: a CLI too old to know it ignores it
  // instead of refusing to start, so there is nothing to version-gate. Only
  // set when an agent actually asked, so the CLI's own default survives.
  if (opts?.promptCacheTtl) {
    env.CLAUDE_CODE_PROMPT_CACHE_TTL = opts.promptCacheTtl
  }

  // The account, where no wrapper script carries it. Set only for a configured
  // account's own directory: the CLI reports itself logged out when
  // CLAUDE_CONFIG_DIR names the default `~/.claude` (h #g196), so the caller
  // passes nothing for the default account and nothing changes here.
  if (opts?.configDir) {
    env.CLAUDE_CONFIG_DIR = opts.configDir
  }

  Object.assign(env, todoToolsEnv(opts?.enableTodoTools === true))

  // Force subscription auth: with an API key in the env, Claude Code bills
  // pay-as-you-go (Console) instead of the logged-in plan's usage limits.
  // Opt-in via `ignoreAnthropicApiKey`.
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

/**
 * `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` when the operator asked for it with
 * `enableTodoTools`, else nothing. Claude Code offers its todo tools
 * (`TaskCreate`, `TaskUpdate`, `TaskGet`, `TaskList`) only to a fixed list of
 * older models plus anything this variable turns on, measured on 2.1.280 to
 * 2.1.293 (h #g259), so on Opus 5.5 or Fable no todo reaches the ledger
 * (`src/todo-ledger.ts`) without it. Fills a gap only, like `cliHygieneEnv`:
 * a value already in opencode's environment, `0` included, is the operator's
 * and decides.
 */
export function todoToolsEnv(enabled: boolean): Record<string, string> {
  if (!enabled || process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS !== undefined) return {}
  return { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" }
}

function touch(key: string): void {
  const existing = activeProcesses.get(key)
  if (existing) {
    activeProcesses.delete(key)
    activeProcesses.set(key, existing)
  }
}

/**
 * Make room for a new child, but never by killing one that is mid-turn.
 * Insertion order is LRU, so the first idle entry is the oldest safe victim.
 * Evicting an in-flight process truncates that turn silently: its readline
 * closes, the close handler finishes the stream, and the operator sees a
 * half-written answer with no error. When every process is busy we exceed the
 * cap for now rather than kill live work; the next spawn tries again.
 */
export function evictIfNeeded(): void {
  while (activeProcesses.size >= MAX_ACTIVE_PROCESSES) {
    let victimKey: string | undefined
    for (const [key, ap] of activeProcesses) {
      if (!isTurnInFlight(ap)) {
        victimKey = key
        break
      }
    }
    if (!victimKey) {
      log.warn("every claude process is mid-turn; skipping LRU eviction", {
        active: activeProcesses.size,
        cap: MAX_ACTIVE_PROCESSES,
      })
      return
    }
    log.info("evicting LRU claude process", { sessionKey: victimKey })
    deleteActiveProcess(victimKey)
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

/** Same pre-filter for the CLI's `system`/`init` line. */
function isSystemInitLine(line: string): boolean {
  if (!line.includes('"init"')) return false
  try {
    const parsed = JSON.parse(line) as { type?: string; subtype?: string }
    return parsed.type === "system" && parsed.subtype === "init"
  } catch {
    return false
  }
}

/**
 * Feed every CLI stdout line here too. Only the first `init` matters: it says
 * the child got past its MCP servers (see `ActiveProcess.initSeen`).
 */
export function noteInitLine(ap: ActiveProcess, line: string): void {
  if (!ap.initSeen && isSystemInitLine(line)) ap.initSeen = true
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
  if (ap.interactiveControl) return ap.interactiveControl.turnRunning()
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
  // The interactive transport stops a turn the way its TUI does, with Esc,
  // and keeps the session alive for the next message.
  if (ap.interactiveControl) return ap.interactiveControl.interrupt(timeoutMs)
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

/**
 * Whether a live child was spawned as a DIFFERENT account than the one this
 * turn is about to use, which is what makes it unusable: a child speaks to
 * the CLI it was started as, under the config dir it was started with.
 *
 * Two signals, because the account is carried differently per platform. On
 * POSIX the per-account wrapper path IS the account, so `cliPath` answers it
 * alone and `configDir` is never recorded. On Windows there is no wrapper, so
 * every account runs the same binary and only `CLAUDE_CONFIG_DIR` separates
 * them (h #g221). Either side being unrecorded means "cannot tell", which
 * keeps the process, exactly as the `cliPath` check alone always has.
 */
export function processBelongsToAnotherAccount(
  active: ActiveProcess | undefined,
  cliPath: string,
  configDir: string | undefined,
): boolean {
  if (!active) return false
  if (active.cliPath && active.cliPath !== cliPath) return true
  return !!active.configDir && active.configDir !== configDir
}

export function setActiveProcess(key: string, ap: ActiveProcess): void {
  cancelIdleProcessEviction(key)
  activeProcesses.set(key, ap)
  // This copy owns a `claude` process now, so it must hear opencode 2's
  // session events even after a reload disposes its own subscription (h #g268).
  noteRelayMemberServing()
}

/**
 * The interactive transport's counterpart to the exit handler
 * `spawnClaudeProcess` wires for a headless child: a TUI that died stops
 * being the process this key reuses, so the next turn spawns again with
 * `--resume` instead of writing into a dead session. The Claude session id
 * is kept for that resume, unless the child failed with a code, exactly as
 * the headless handler decides.
 */
export function noteInteractiveProcessExit(
  sessionKey: string,
  ap: ActiveProcess,
  code: number | null,
): void {
  if (activeProcesses.get(sessionKey) !== ap) return
  cancelIdleProcessEviction(sessionKey)
  activeProcesses.delete(sessionKey)
  // As for a headless child: nothing else could consume these calls' results.
  if (getPendingProxyCalls(sessionKey).length > 0) {
    rejectAllPendingProxyCallsForSession(sessionKey, new Error(CHILD_EXITED_MESSAGE))
  }
  if (code !== 0 && code !== null) {
    claudeSessions.delete(sessionKey)
    forgetResumePoint(sessionKey)
  }
}

/**
 * Evict a headless Claude worker after a completed turn has stayed idle.
 * Armed by the turn's `completeResult`, so the clock starts when a turn
 * finishes, not when the child was spawned. Reusing the worker through
 * `getActiveProcess` cancels the timer. The Claude session id is
 * intentionally retained so the next turn can continue the same conversation
 * via `--resume`. A process found mid-turn when the timer fires (a recovered
 * continuation, an auto-continue, a late tool result) is not evicted; the
 * timer is re-armed instead, the same rule the LRU cap follows.
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
    if (isTurnInFlight(scheduledProcess)) {
      log.info("idle timer found a turn in flight; re-arming", { sessionKey: key, timeoutMs })
      scheduleIdleProcessEviction(key, timeoutMs)
      return
    }
    log.info("evicting idle claude process", { sessionKey: key, timeoutMs })
    deleteActiveProcess(key)
  }, timeoutMs)
  timer.unref()
  idleEvictionTimers.set(key, timer)
}

/** Whether an idle-eviction timer is armed for the key (read-only, for tests). */
export function isIdleProcessEvictionScheduled(key: string): boolean {
  return idleEvictionTimers.has(key)
}

function detachActiveProcess(key: string): ActiveProcess | undefined {
  cancelIdleProcessEviction(key)
  const ap = activeProcesses.get(key)
  if (!ap) return undefined
  activeProcesses.delete(key)
  if (ap.proxyServer) {
    void ap.proxyServer.close()
    // The server's close already answered every open HTTP request with an
    // error; the broker's entries for them can never be resolved to anyone
    // now, and a `task` call has no deadline that would otherwise reap them.
    rejectAllPendingProxyCallsForSession(key, new Error(SERVER_CLOSED_MESSAGE))
  }
  return ap
}

/**
 * Release everything this plugin holds for one opencode session that was
 * deleted: its live `claude` children (any model, effort, or compaction
 * spawn), the remembered Claude session ids, and per-session state. Unlike
 * idle eviction this is a real deletion, so nothing is kept for a resume.
 * The `"default"` affinity is the shared bucket used when no session id is
 * known and is deliberately never matched. Returns the released keys.
 */
export function deleteActiveProcessesForSession(sessionID: string): string[] {
  if (!sessionID || sessionID === "default") return []
  const released: string[] = []
  for (const [key, ap] of [...activeProcesses]) {
    const owned =
      ap.opencodeSessionID === sessionID || describeSessionKey(key).session === sessionID
    if (!owned) continue
    log.info("releasing claude process for deleted session", { sessionKey: key, sessionID })
    void deleteActiveProcessAndWait(key)
    released.push(key)
  }
  // Session ids and per-session state can outlive their process (idle
  // eviction keeps them for `--resume`); a deleted session never resumes.
  for (const key of [...claudeSessions.keys()]) {
    if (describeSessionKey(key).session !== sessionID) continue
    deleteClaudeSessionId(key)
    clearCompression(key)
    if (!released.includes(key)) released.push(key)
  }
  // Every key this call released, whether it had a live process or only a
  // remembered session id: a deleted opencode session must leave no ledger.
  for (const key of released) clearBackgroundTasks(key)
  // A deleted subagent session must not keep the choice its dispatch gave it:
  // nothing will ever ask for it again, and an id opencode reuses would read
  // somebody else's answer (h #g227). The dispatching side of the same pair is
  // on disk now, so the delete has to reach the file too (h #g228).
  forgetSessionChoice(sessionID)
  forgetDispatchChoicesForSession(sessionID)
  // Likewise the model its parent named for it in a `task` call (h #g254).
  forgetExplicitTaskModel(sessionID)
  return released
}

/** What a proxied call is rejected with when opencode 2 reports its turn stopped. */
export const STOPPED_TURN_MESSAGE =
  "opencode stopped the turn while it was running its proxy tool calls"

/**
 * What opencode 1's abort branch does when the operator stops a turn that is
 * parked in proxied calls, for the host where no abort ever arrives.
 *
 * On opencode 1 the stop reaches the finished stream's abort signal, the
 * session then reads idle, and the plugin interrupts the CLI's turn and
 * rejects the calls parked in it (h #g26). opencode 2 never aborts a provider
 * stream that already ended at a tool boundary (measured on 2.0.31: no abort
 * at all across three parked calls and an interrupt), so a stopped turn left
 * its calls pending until the next message's orphan sweep, with the `claude`
 * turn still blocked inside them. Its event stream does say it, as
 * `session.execution.interrupted` with reason `user` (h #g253), and that is
 * what calls this.
 *
 * Only a process with no stream attached is touched: a turn that is streaming
 * owns its calls and has its own abort. Returns the released keys, and is a
 * no-op the second time (opencode 2 can deliver the same event once per
 * location the plugin was set up for).
 */
export function releaseParkedProxyCallsForSession(
  sessionID: string,
  reason = STOPPED_TURN_MESSAGE,
): string[] {
  if (!sessionID || sessionID === "default") return []
  const released: string[] = []
  for (const [key, ap] of [...activeProcesses]) {
    const owned =
      ap.opencodeSessionID === sessionID || describeSessionKey(key).session === sessionID
    if (!owned) continue
    if (ap.lineEmitter.listenerCount("line") > 0) continue
    if (getPendingProxyCalls(key).length === 0) continue
    log.info("opencode stopped the turn at a proxy tool boundary; releasing pending calls", {
      sessionKey: key,
      sessionID,
    })
    void interruptTurn(ap).then((idle) => {
      log.info("interrupt sent for aborted turn", { sk: key, idle })
    })
    rejectAllPendingProxyCallsForSession(key, new Error(reason))
    released.push(key)
  }
  return released
}

/**
 * Synchronous best-effort sweep for host process exit. Node does not kill
 * children on exit, so without this a hard opencode shutdown reparents every
 * live `claude` to init. Must stay sync: `process.on("exit")` runs no async
 * work. Session ids are left alone; the process is going away with them.
 */
export function killAllActiveProcesses(): string[] {
  const keys = [...activeProcesses.keys()]
  for (const key of keys) deleteActiveProcess(key)
  // The background-task ledgers are plain in-process maps, so the exit hook
  // is where they go. The child opencode sessions themselves are not touched:
  // a background subagent outliving a `claude` process is opencode's design,
  // and opencode owns reaping them.
  for (const key of keys) clearBackgroundTasks(key)
  return keys
}

let processExitCleanupWired = false

/**
 * Arm `killAllActiveProcesses` for host process exit, once per process. The
 * plugin entry can run more than once (tests, account expansion), and each
 * run must not add another `exit` listener. Returns whether this call armed it.
 */
export function ensureProcessExitCleanup(): boolean {
  if (processExitCleanupWired) return false
  processExitCleanupWired = true
  process.once("exit", () => {
    killAllActiveProcesses()
  })
  return true
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

/**
 * Every session key this process has a Claude conversation for.
 *
 * Read-only and allocation-light (the map's own key iterator), and deliberately
 * not touching LRU order or any timer, for the reason `findForkParent` takes
 * `claudeSessionIsWriting` rather than `getActiveProcess`. The one caller is
 * the `accountGroups` guard (`findForeignAccountSibling`), which needs to know
 * that another account has answered this conversation even when nothing was
 * written to the resume store (h #g226).
 */
export function listClaudeSessionKeys(): IterableIterator<string> {
  return claudeSessions.keys()
}

/**
 * A Claude session id outlives its process on purpose, so nothing in the
 * ordinary lifecycle ever removes one: under a long-lived `opencode serve`
 * that hops projects and models this map only grows, and each entry pins a
 * todo ledger with it. The cap is the same shape as
 * `MAX_COMPRESSION_ENTRIES`, and it is generous because the cost of getting
 * it wrong is a conversation that silently restarts.
 */
export const MAX_CLAUDE_SESSION_ENTRIES = 64

/**
 * A key with a live process, a proxied call still in the air or an unanswered
 * plan-mode question is doing work that the id is part of; dropping it would
 * strand that work on a session the next turn no longer resumes. Read from
 * the map directly rather than through `getActiveProcess`: that one refreshes
 * LRU order and cancels idle timers, which a scan must not do.
 *
 */
function claudeSessionIsBusy(key: string): boolean {
  if (activeProcesses.has(key)) return true
  return getPendingProxyCalls(key).length > 0 || hasExitPlanModeQuestions(key)
}

/**
 * Whether this key's Claude transcript may still be written to.
 *
 * Deliberately weaker than `claudeSessionIsBusy`: a key with a live but IDLE
 * child is not writing anything, and refusing those would make the session
 * fork fire almost never, since idle eviction is off by default and a
 * conversation's worker lives until the LRU cap. What a fork must not branch
 * from is a transcript mid-write: a turn in flight, a proxied call still in
 * the air (the child is parked inside an MCP call and its transcript ends on
 * an unanswered `tool_use`), or an unanswered plan-mode question.
 *
 * Read from the map directly for the same reason `claudeSessionIsBusy` does:
 * this is a scan over every sibling key, and `getActiveProcess` refreshes LRU
 * order and cancels idle timers on everything it touches.
 */
export function claudeSessionIsWriting(key: string): boolean {
  const active = activeProcesses.get(key)
  if (active && isTurnInFlight(active)) return true
  return getPendingProxyCalls(key).length > 0 || hasExitPlanModeQuestions(key)
}

/**
 * Shed the least recently used idle sessions. When every key is busy this
 * evicts nothing and the map runs over the cap for a while, the same rule
 * `evictIfNeeded` follows: exceeding a cap briefly is cheaper than cutting a
 * conversation that is still running.
 */
function capClaudeSessions(): void {
  for (const key of [...claudeSessions.keys()]) {
    if (claudeSessions.size <= MAX_CLAUDE_SESSION_ENTRIES) return
    if (claudeSessionIsBusy(key)) continue
    log.info("claude session cap reached; releasing an idle session", {
      sessionKey: key,
      size: claudeSessions.size,
      cap: MAX_CLAUDE_SESSION_ENTRIES,
    })
    // Through the central release so the todo ledger and any pending
    // plan-mode question go with it rather than outliving the id.
    deleteClaudeSessionId(key)
  }
}

export function setClaudeSessionId(key: string, sessionId: string): void {
  // Re-inserting moves the key to the back, so the cap sheds the conversation
  // that has been quiet longest rather than the one that started first.
  claudeSessions.delete(key)
  claudeSessions.set(key, sessionId)
  capClaudeSessions()
}

/**
 * Test seam: lose the in-memory id the way a restarted opencode process does,
 * leaving the copy `src/session-resume-store.ts` keeps on disk alone.
 */
export function _forgetClaudeSessionIdInMemory(key: string): void {
  claudeSessions.delete(key)
}

export function deleteClaudeSessionId(key: string): void {
  forgetClaudeSessionInMemory(key)
  // Same for the copy kept across restarts: a conversation this process
  // abandoned must not be resumed by the next one.
  forgetResumePoint(key)
}

/**
 * Everything `deleteClaudeSessionId` drops except the resume record on disk,
 * which is what a handover to another copy of the plugin needs (h #g269): the
 * conversation is not abandoned, it is resumed elsewhere from that record.
 */
function forgetClaudeSessionInMemory(key: string): void {
  clearExitPlanModeQuestions(key)
  clearAccountFailoverQuestions(key)
  clearSubagentDispatchQuestions(key)
  const claudeSessionId = claudeSessions.get(key)
  if (claudeSessionId) clearLedger(claudeSessionId)
  claudeSessions.delete(key)
  // The fork fingerprint only exists to point at that id. Keeping it would
  // offer a conversation whose transcript this plugin can no longer name.
  forgetForkFingerprint(key)
  // And what that session had been asked: the next session under this key
  // starts with a replay, which carries everything (h #g239).
  forgetServedConversation(key)
}

function keyBelongsToSession(key: string, sessionID: string, ap?: ActiveProcess): boolean {
  return ap?.opencodeSessionID === sessionID || describeSessionKey(key).session === sessionID
}

/** Work under one key that only this copy of the plugin can finish. */
function keyHeldHere(key: string): boolean {
  return (
    claudeSessionIsWriting(key) ||
    hasAccountFailoverQuestions(key) ||
    hasPendingSubagentDispatch(key)
  )
}

/**
 * Whether this copy of the plugin still has work for one opencode session that
 * only it can finish (h #g269): a turn streaming or parked, a proxied call
 * outstanding, or a form (plan mode, account switch, subagent dispatch) whose
 * answer the session's next turn carries. That work lives in this copy's
 * memory, so the session stays here until it is done, whichever build is newer.
 */
export function sessionHeldHere(sessionID: string): boolean {
  if (!sessionID || sessionID === "default") return false
  for (const [key, ap] of activeProcesses) {
    if (keyBelongsToSession(key, sessionID, ap) && keyHeldHere(key)) return true
  }
  for (const key of claudeSessions.keys()) {
    if (keyBelongsToSession(key, sessionID) && keyHeldHere(key)) return true
  }
  return false
}

/**
 * Whether this copy has nothing in flight in any session: no turn streaming or
 * parked, no proxied call outstanding, and no explicit task model waiting for a
 * child to claim it. The build switch waits for every older copy to say so
 * (h #g269). Forms are left out on purpose: each belongs to one session, which
 * `sessionHeldHere` keeps, and an unanswered form in a forgotten session must
 * not keep every other session on an old build.
 */
export function noWorkInFlightHere(): boolean {
  for (const ap of activeProcesses.values()) {
    if (isTurnInFlight(ap)) return false
  }
  return !hasAnyPendingProxyCall() && !hasUnclaimedExplicitTaskModels()
}

/**
 * Whether this copy has no `claude` child, no remembered Claude session and no
 * proxied call left: a disposed copy in that state can leave the process's
 * list of copies (h #g269).
 */
export function holdsNoClaudeState(): boolean {
  return activeProcesses.size === 0 && claudeSessions.size === 0 && !hasAnyPendingProxyCall()
}

/**
 * Hand this copy's conversations to another copy of the plugin (h #g269): stop
 * the idle `claude` children of one opencode session, or of every session when
 * none is named, and forget what this copy remembers about them, while KEEPING
 * the resume record on disk. The next copy's first turn `--resume`s from that
 * record exactly as a restarted opencode does (`src/session-resume-store.ts`),
 * and waits for this copy's child to have exited, because two children must
 * never write one transcript. A key with work only this copy can finish is
 * left alone. Returns the released keys.
 */
export async function releaseIdleForHandover(sessionID?: string): Promise<string[]> {
  if (sessionID === "default") return []
  const belongs = (key: string, ap?: ActiveProcess) =>
    sessionID === undefined || keyBelongsToSession(key, sessionID, ap)
  const released: string[] = []
  const exits: Promise<boolean>[] = []
  for (const [key, ap] of [...activeProcesses]) {
    if (!belongs(key, ap) || keyHeldHere(key)) continue
    exits.push(deleteActiveProcessAndWait(key))
    released.push(key)
  }
  await Promise.all(exits)
  for (const key of [...claudeSessions.keys()]) {
    if (!belongs(key) || keyHeldHere(key)) continue
    forgetClaudeSessionInMemory(key)
    if (!released.includes(key)) released.push(key)
  }
  if (released.length > 0) {
    log.info("handed claude sessions to another copy of the plugin", { sessionID, released })
  }
  return released
}

/**
 * Hand one session key's Claude conversation to another, and leave the source
 * holding nothing.
 *
 * Used where the same opencode conversation moves to a key it has never been
 * answered under: another reasoning effort, prompt cache TTL or CLI cap
 * (`invalidateOtherSpawnVariants`) or another model (the sibling carry-over
 * in the turn prologue). Neither is a
 * reason to start a new Claude conversation, because both are spawn-time
 * choices the CLI applies to a transcript it resumes.
 *
 * A MOVE, never a copy, and that is the whole of its safety: two session keys
 * naming one Claude session id would each spawn a child that resumes the same
 * transcript, and the second would append to a conversation the first is
 * already writing. The id, the resume record and the fork fingerprint all go
 * together, because each of the three exists only to point at the other two.
 *
 * The todo ledger is keyed by Claude session id rather than by session key, so
 * it is deliberately NOT cleared here: the conversation it belongs to is still
 * running, under a new key. This is exactly why the transfer cannot be written
 * as `deleteClaudeSessionId` plus `setClaudeSessionId`.
 *
 * `recorded` is the id the source's resume record names, for a source this
 * process never held in memory: after an opencode restart, or a handover to
 * another copy of the plugin (h #g269), that record is the only thing that
 * knows which Claude session answered it (h #g274). Only the sibling carry
 * passes it, after `findSiblingResumePoint` has applied every refusal to that
 * record. An id in memory still wins.
 *
 * Refuses when the destination already has a conversation of its own, and
 * returns the id it moved, or `undefined` when nothing moved.
 */
export function transferClaudeSession(
  fromKey: string,
  toKey: string,
  recorded?: string,
): string | undefined {
  if (fromKey === toKey) return undefined
  const claudeSessionId = claudeSessions.get(fromKey) ?? recorded
  if (!claudeSessionId) return undefined
  if (claudeSessions.has(toKey)) return undefined
  claudeSessions.delete(fromKey)
  setClaudeSessionId(toKey, claudeSessionId)
  moveResumePoint(fromKey, toKey)
  moveForkFingerprint(fromKey, toKey)
  // The session is the same one, so what it has seen is (h #g239).
  moveServedConversation(fromKey, toKey)
  // The source key keeps no claim on the conversation, so the questions and
  // overrides recorded against it are stale the moment the id leaves.
  clearExitPlanModeQuestions(fromKey)
  clearAccountFailoverQuestions(fromKey)
  clearSubagentDispatchQuestions(fromKey)
  log.notice("carrying the claude conversation over to the new session key", {
    fromKey,
    toKey,
  })
  return claudeSessionId
}

export function effortSessionKey(baseKey: string, effort?: ReasoningEffort): string {
  return effort ? `${baseKey}::effort=${effort}` : baseKey
}

/**
 * A session key with every spawn-time setting taken out: the effort tail, and
 * whatever the context blob carries after its provider and agent (the prompt
 * cache TTL, `maxTurns=`, `maxBudgetUsd=`). Two keys with the same identity are
 * one opencode conversation on one model and one agent, spawned differently,
 * so at most one of them may own a live child (issue #140, h #g270). A key
 * without a context blob (compaction, hand-built test keys) loses only its
 * effort tail.
 */
export function spawnIdentity(key: string): string {
  const parts = key.split("::")
  if (parts.length > 1 && parts[parts.length - 1].startsWith("effort=")) parts.pop()
  const last = parts.length - 1
  if (parts[last].startsWith("context=")) {
    try {
      const context: unknown = JSON.parse(parts[last].slice("context=".length))
      if (Array.isArray(context)) parts[last] = `context=${JSON.stringify(context.slice(0, 2))}`
    } catch {
      // Not a blob this plugin wrote, so it stays whole and only matches itself.
    }
  }
  return parts.join("::")
}

/**
 * Whether a key's child or conversation is in the middle of a turn: a proxied
 * call parked in it, a recovery completion owed to it, an open plan-mode
 * question, a stream attached to its output, or a `/btw` in the air.
 */
function spawnHasPendingWork(key: string): boolean {
  const active = activeProcesses.get(key)
  return !!(
    getPendingProxyCalls(key).length ||
    hasExitPlanModeQuestions(key) ||
    active?.pendingProxyCompletions?.size ||
    (active && (active.lineEmitter.listenerCount("line") > 0 || isSideQuestionPending(active)))
  )
}

/**
 * `spawnIdentity` with the model name blanked too, its `@account` marker kept:
 * one opencode conversation, agent, scope, cwd and account on any model.
 * Undefined for compaction keys, keys of another shape, and the shared
 * `default` affinity, which is no one conversation.
 */
function conversationIdentity(key: string): string | undefined {
  const parts = spawnIdentity(key).split("::")
  if (parts.length !== 5 || parts[2] === "compaction" || parts[3] === "default") return undefined
  parts[1] = parts[1].replace(/^[^@]*/, "*")
  return parts.join("::")
}

/**
 * Another spawn of this conversation that is still inside a turn, under
 * another model, effort, prompt cache TTL or CLI cap, or `undefined`. The
 * caller serves the turn on it, so work in flight finishes under the settings
 * it started with and the change applies at the first turn that finds it
 * idle. Before this an effort or TTL change mid-turn was refused, and a model
 * change spawned a second child beside the busy one (h #g271). Never when the
 * requested key is itself busy: that turn is already where it belongs.
 */
export function findBusySpawnVariant(requestedKey: string): string | undefined {
  const identity = conversationIdentity(requestedKey)
  if (!identity || spawnHasPendingWork(requestedKey)) return undefined
  for (const key of new Set([...activeProcesses.keys(), ...claudeSessions.keys()])) {
    if (key === requestedKey || conversationIdentity(key) !== identity) continue
    if (spawnHasPendingWork(key)) return key
  }
  return undefined
}

/**
 * Retire every other spawn of this conversation before deciding whether to
 * replay history: the keys `spawnIdentity` reads as the same conversation,
 * model and agent under another effort, prompt cache TTL, `maxTurns` or
 * `maxBudgetUsd`. `carryConversation: false` (`resumeAcrossModelChanges:
 * false`) releases their Claude sessions instead of moving one over, so the
 * new spawn replays the thread as it did before (issue #91).
 */
export function invalidateOtherSpawnVariants(
  currentKey: string,
  options: { carryConversation?: boolean } = {},
): void {
  const levels: (ReasoningEffort | undefined)[] = [
    undefined, "minimal", "low", "medium", "high", "xhigh", "max",
  ]
  const baseKey = currentKey.replace(/::effort=[a-z]+$/, "")
  const identity = spawnIdentity(currentKey)
  // Effort siblings are named outright, so one holding nothing but a parked
  // call or an open plan-mode question is still seen. The other settings live
  // in the context blob, which cannot be enumerated, so those siblings are
  // found by scanning the keys that hold a conversation or a child. Before
  // this scan a TTL change landed on a key nothing looked at, and the old
  // child kept running beside the new one (issue #140). Newest conversation
  // first, so if more than one stale key still holds one, the one carried
  // over is the one the operator was on last.
  const staleKeys = [
    ...new Set([
      ...[...claudeSessions.keys()].reverse(),
      ...levels.map((level) => effortSessionKey(baseKey, level)),
      ...activeProcesses.keys(),
    ]),
  ].filter((key) => key !== currentKey && spawnIdentity(key) === identity)

  // Refuse the transition atomically. Tool results and recovery completions
  // still belong to the old process; they must finish under its settings. A
  // turn that finds one busy is served there (`findBusySpawnVariant`) before
  // it gets here, so this is the backstop for what that scan cannot see: a
  // key holding work with neither a child nor a conversation.
  for (const key of staleKeys) {
    if (spawnHasPendingWork(key)) {
      throw new Error(
        "Cannot change reasoning effort, prompt cache TTL, maxTurns or maxBudgetUsd while this conversation's previous claude process has pending work. Finish that work under its original settings first.",
      )
    }
  }
  // The process has to go: effort is fixed per child (`CLAUDE_CODE_EFFORT_LEVEL`
  // is spawn-time, h #g41), and so are the TTL and the CLI caps. The
  // CONVERSATION does not, and dropping it was what made every effort change
  // replay the whole thread as text (issue #91). The id moves to the key this
  // turn is about to use, so the spawn below resumes it under the new
  // settings; the old key is left holding nothing, so flipping back later
  // finds the conversation where it actually is.
  const carry = options.carryConversation !== false
  for (const key of staleKeys) {
    deleteActiveProcess(key)
    if (carry && transferClaudeSession(key, currentKey)) {
      // Transferred, not released: `deleteClaudeSessionId` would clear the
      // todo ledger this conversation is still using and forget the resume
      // record the new key now owns.
      clearCompression(key)
      clearBackgroundTasks(key)
      continue
    }
    // A key this process never held is known only from the resume record an
    // earlier process wrote (an opencode restart, or a handover, h #g269).
    // Nothing here abandoned it, so the record stays for the sibling carry in
    // the prologue, which takes it only past every refusal of
    // `findSiblingResumePoint`. Forgetting it here made the first effort change
    // after a restart replay the thread (h #g274).
    if (carry && !claudeSessions.has(key)) forgetClaudeSessionInMemory(key)
    else deleteClaudeSessionId(key)
    clearCompression(key)
    clearBackgroundTasks(key)
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
  promptCacheTtl?: string,
  configDir?: string,
  enableTodoTools?: boolean,
): ActiveProcess {
  evictIfNeeded()
  log.info("spawning new claude process", {
    cliPath,
    cliArgs,
    cwd,
    sessionKey,
    effort,
    promptCacheTtl,
    configDir,
    ...(enableTodoTools ? { enableTodoTools } : {}),
  })

  // Never `shell: true`. On Windows the plan resolves `claude` to a real file
  // and, for a `.cmd` shim, builds an escaped `cmd.exe /d /s /c` command line
  // itself; everywhere else it is the command unchanged. See
  // `src/windows-spawn.ts`.
  const plan = planClaudeSpawn(cliPath, cliArgs)
  const proc = spawn(plan.file, plan.args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: claudeSpawnEnv({ ignoreAnthropicApiKey, effort, promptCacheTtl, configDir, enableTodoTools }),
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  })

  const lineEmitter = new EventEmitter()

  const ap: ActiveProcess = {
    proc,
    lineEmitter,
    proxyServer: proxyServer ?? null,
    mcpHash,
    systemPromptFile,
    effort,
    promptCacheTtl,
    enableTodoTools,
    startedAt: Date.now(),
    cliPath,
    cliArgs: [...cliArgs],
    configDir,
    unattendedLines: [],
    unattendedDropped: 0,
  }

  const rl = createInterface({ input: proc.stdout! })
  rl.on("line", (line: string) => {
    if (dispatchSideQuestionResponse(ap, line)) return
    noteTurnLine(ap, line)
    noteInitLine(ap, line)
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
  setActiveProcess(sessionKey, ap)

  // Baseline 'error' listener so Node doesn't throw when the process emits
  // an error between stream turns (no per-stream listener attached then).
  proc.on("error", (err) => {
    log.error("claude process error", { sessionKey, error: err.message })
  })

  // Same baseline for the child's stdin, which is a separate emitter. Every
  // write that asks the CLI for work (fresh envelope, auto-continue, the
  // watchdog re-send, the interrupt request) can land after the child died,
  // and an unhandled 'error' on a stream throws inside opencode's own
  // process. Ending the turn is not this handler's job: the child is gone,
  // so its readline 'close' follows and the turn's close handler reports it
  // (see `describeChildCrash`). Releasing `turnInFlight` is, since no
  // terminal `result` is ever coming for a write that never arrived.
  proc.stdin?.on("error", (err: NodeJS.ErrnoException) => {
    log.warn("claude process stdin error", {
      sessionKey,
      code: err.code,
      error: err.message,
    })
    settleTurn(ap)
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
      // The child is the only thing that could still consume these calls'
      // results. A turn that is attached rejects them from its own close
      // handler; this covers a child that dies between turns, which no
      // deadline would otherwise reap now that `task` has none.
      if (getPendingProxyCalls(sessionKey).length > 0) {
        rejectAllPendingProxyCallsForSession(
          sessionKey,
          new Error(CHILD_EXITED_MESSAGE),
        )
      }
    }
    if (ownsSessionKey && code !== 0 && code !== null) {
      // Deliberately NOT forgotten. A child that dies mid-turn leaves a
      // transcript the CLI still resumes: measured on 2.1.288, a headless
      // `claude -p` SIGKILLed nine seconds into its answer, and one killed the
      // moment its `system`/`init` frame arrived, were both resumed afterwards
      // and still knew the codename set before the crash (h #g215). The
      // transcript file exists from `init` onward, which is also the only
      // point this plugin has an id to keep. Clearing it here turned every
      // crash into a full replay of the thread as text (issue #91).
      //
      // The backstop for an id that really is unusable stays where it was: the
      // stderr handler below forgets the session on "No conversation found",
      // which is what a purged or never-written transcript answers `--resume`
      // with.
      log.info("process exited with error; keeping the claude session to resume", {
        code,
        sessionKey,
        resumable: claudeSessions.has(sessionKey),
      })
    }
  })

  proc.stderr?.on("data", (data: Buffer) => {
    const stderr = data.toString()
    log.debug("stderr", { data: stderr.slice(0, 200) })
    retainStderr(ap, stderr)
    // A model the CLI has no catalog entry for still runs, on fallback limits,
    // and this line is the only sign of it (src/cli-events.ts).
    reportUnrecognizedModel(stderr)

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
        forgetResumePoint(sessionKey)
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
  // A fork spawn's args point `--resume` at ANOTHER key's conversation and
  // carry `--fork-session`. Replaying them verbatim would branch the parent a
  // second time and strand whatever the first fork had already written, so
  // once this key has a session id of its own the respawn continues that
  // instead. Before the `system`/`init` frame there is no such id and nothing
  // was written, and re-forking the parent is then the correct recovery.
  if (cliArgs.includes("--fork-session")) {
    const forkedSessionId = claudeSessions.get(sessionKey)
    if (!forkedSessionId) return cliArgs
    const resumed: string[] = []
    for (let i = 0; i < cliArgs.length; i++) {
      if (cliArgs[i] === "--fork-session") continue
      if (cliArgs[i] === "--resume") {
        resumed.push("--resume", forkedSessionId)
        i++
        continue
      }
      resumed.push(cliArgs[i])
    }
    log.info("respawning a forked session on its own claude conversation", {
      sessionKey,
      claudeSessionId: forkedSessionId,
    })
    return resumed
  }
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
 * The respawn happens in the middle of the same logical turn, and the caller
 * re-sends that turn's envelope at once. Turn state lives on the
 * `ActiveProcess`, so the replacement inherits the old process's in-flight
 * marker (@broskees' b719497); without that handoff abort, LRU eviction, the
 * idle timer and the next turn's quiesce all mistake the busy replacement
 * for an idle process.
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
  const turnWasInFlight = isTurnInFlight(old)
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
    old.promptCacheTtl,
    old.configDir,
    old.enableTodoTools,
  )
  // The replacement reuses the old child's `cliArgs`, so it reuses its MCP
  // config: `mcpHash` rides along above and the server names it names have
  // to ride with it, or the next turn's hot-reload diff reports every server
  // as newly joined.
  replacement.mcpServers = old.mcpServers
  replacement.pendingProxyCompletions = old.pendingProxyCompletions
  delete old.pendingProxyCompletions
  if (turnWasInFlight) noteTurnStarted(replacement)
  return replacement
}

export function buildCliArgs(opts: {
  sessionKey: string
  skipPermissions: boolean
  includeSessionId?: boolean
  /**
   * Claude session id to branch this spawn off, for an opencode session that
   * is a fork of one this provider already served (`src/session-fork.ts`).
   * Adds `--resume <id> --fork-session`, which starts a NEW Claude session
   * holding the parent's conversation and leaves the parent's own transcript
   * untouched. Mutually exclusive with the `--resume` below by construction:
   * a key that already has a session id of its own is never a fork candidate.
   */
  forkFromClaudeSessionId?: string
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
  /**
   * `--max-turns`: API round trips the CLI allows per user message (h #g245).
   * Already gated by the caller (`resolveSpawnCliCaps`); unset passes nothing.
   */
  maxTurns?: number
  /**
   * `--max-budget-usd`: dollars the CLI allows over this process's life, reset
   * on every `--resume` (h #g245). Already gated; subagents only.
   */
  maxBudgetUsd?: number
}): string[] {
  const {
    sessionKey,
    skipPermissions,
    includeSessionId = true,
    forkFromClaudeSessionId,
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
    maxTurns,
    maxBudgetUsd,
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

  // The read-only preset arrives as an internal `permissionMode` token rather
  // than a mode the CLI knows, because it is a capability restriction and the
  // CLI spells that as its own flags. `--restricted` removes Bash, the REPL,
  // the other code-running built-ins and WebFetch, confines the file tools to
  // the working directories, and refuses bypassPermissions.
  // `--permission-prompts none` denies anything left that would prompt
  // without asking this plugin, which is the same answer the preset's
  // `controlRequestBehavior: "deny"` gives on a CLI too old for the flag.
  const readOnly = isReadOnlyPermissionMode(permissionMode)
  if (readOnly) {
    if (cliSupportsRestricted(cliVersion ?? null)) {
      args.push("--restricted")
    } else {
      // The preset still holds: `--disallowedTools` carries the same tool
      // names and the plugin denies every permission request itself. What is
      // lost is the cwd confinement on reads and the CLI-side refusal of
      // bypass, so say so rather than degrading quietly.
      log.warn(
        'permissionPreset "read-only": this claude CLI has no --restricted' +
          " (2.1.258+), so file reads are not confined to the working" +
          " directory. The mutating tools are still refused via" +
          " --disallowedTools and every permission request is denied.",
        { cliVersion: cliVersion?.raw ?? "unknown" },
      )
    }
    if (cliSupportsPermissionPrompts(cliVersion ?? null)) {
      args.push("--permission-prompts", "none")
    } else {
      log.warn(
        'permissionPreset "read-only": this claude CLI has no' +
          " --permission-prompts (2.1.263+), so permission requests are" +
          " denied by the plugin's own can_use_tool handler instead of by" +
          " the CLI. Same outcome, one layer fewer.",
        { cliVersion: cliVersion?.raw ?? "unknown" },
      )
    }
  } else if (permissionMode) {
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
    } else if (forkFromClaudeSessionId) {
      // A forked opencode session continuing another session's Claude
      // conversation. `--fork-session` is what makes this safe to point at a
      // transcript that is not ours: the CLI writes a new session id (which
      // the `system`/`init` frame reports, so the stream parser maps this key
      // to it exactly as it would a fresh one) and never touches the parent's.
      args.push("--resume", forkFromClaudeSessionId, "--fork-session")
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

  if (maxTurns !== undefined) args.push("--max-turns", String(maxTurns))
  if (maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(maxBudgetUsd))

  // Same rule as plan mode below, with a harder edge: `--restricted` and
  // `--dangerously-skip-permissions` together are not a silent override but a
  // startup error ("Error: bypassPermissions not supported in restricted
  // mode", measured on 2.1.280), so a read-only spawn carrying both would
  // never run at all. The preset already forces `skipPermissions` false; this
  // is the second lock, for anyone calling `buildCliArgs` directly.
  //
  // Plan mode is a capability restriction, not a prompt policy, and the CLI
  // lets `--dangerously-skip-permissions` override it outright: measured on
  // 2.1.258, a plan-mode run carrying both flags wrote a file on request
  // without prompting, while the same run without the skip flag refused and
  // created nothing. Since `skipPermissions` defaults to true, passing both
  // is the common case, so anyone asking for plan mode was silently getting
  // full write access. Plan mode must never permit edits, so it wins here.
  // Every other `permissionMode` value governs prompting, which is exactly
  // what the skip flag is for, so those still pass both.
  if (skipPermissions && permissionMode !== "plan" && !readOnly) {
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

/**
 * Pull the readable parts back out of a session key for the doctor report.
 * The key is `<cwd>::<model>::<scope>::<affinity>::context=[...]` with an
 * optional `::effort=<level>` tail, and the compaction variant is
 * `<cwd>::<model>::compaction::<affinity>`, so the model and the opencode
 * session id sit at the same two positions either way.
 */
export function describeSessionKey(key: string): {
  cwd: string
  model: string
  session: string
  compaction: boolean
} {
  const parts = key.split("::")
  return {
    cwd: parts[0] ?? "unknown",
    model: parts[1] ?? "unknown",
    session: parts[3] ?? "unknown",
    compaction: parts[2] === "compaction",
  }
}

/** One live `claude` child, flattened for `/claude-code-doctor`. */
export interface ActiveProcessSnapshot {
  sessionKey: string
  session: string
  model: string
  compaction: boolean
  pid?: number
  inFlight: boolean
  ageMs?: number
  effort?: ReasoningEffort
  attached: boolean
  /** Which transport this process is: the PTY shim carries `interactiveControl`. */
  transport: "headless" | "interactive"
  proxyUrl?: string
  /**
   * Tail of the child's stderr, when something upstream of this module is
   * recording one. Read through an optional property so the doctor works
   * whether or not that field exists on the running build.
   */
  lastStderr?: string
}

/**
 * Every live child, oldest-used first (the map is LRU). Read-only; nothing
 * here touches eviction or the process's own listeners.
 */
export function snapshotActiveProcesses(now = Date.now()): ActiveProcessSnapshot[] {
  const out: ActiveProcessSnapshot[] = []
  for (const [key, ap] of activeProcesses) {
    const described = describeSessionKey(key)
    const lastStderr = (ap as { lastStderr?: unknown }).lastStderr
    out.push({
      sessionKey: key,
      session: ap.opencodeSessionID ?? described.session,
      model: described.model,
      compaction: described.compaction,
      pid: ap.proc.pid,
      inFlight: ap.turnInFlight === true,
      ageMs: ap.startedAt === undefined ? undefined : Math.max(0, now - ap.startedAt),
      effort: ap.effort,
      attached: ap.lineEmitter.listenerCount("line") > 0,
      transport: ap.interactiveControl ? "interactive" : "headless",
      proxyUrl: ap.proxyServer?.url,
      lastStderr: typeof lastStderr === "string" ? lastStderr : undefined,
    })
  }
  return out
}
