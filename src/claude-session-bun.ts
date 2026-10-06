import * as os from "node:os"
import * as fs from "node:fs"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { cliHygieneEnv } from "./cli-version.js"

/**
 * Persistent interactive Claude Code session driven over Bun's NATIVE PTY
 * (Bun.spawn `terminal` option = openpty on POSIX, ConPTY on Windows). This is
 * the in-process Bun port of claude-tui-bridge/src/claudeSession.ts: same
 * design, node-pty swapped for Bun's own ConPTY so it runs inside opencode's
 * Bun runtime with NO node sidecar and NO node-pty dependency.
 *
 *   - ONE long-lived interactive `claude` process per session (multi-turn),
 *   - turns injected by writing into the terminal (bracketed paste + Enter),
 *   - replies captured by tailing the session JSONL transcript
 *     (<CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<session-id>.jsonl) and
 *     parsing the assistant records; completion detected by a terminal
 *     `stop_reason`, an interrupt marker, or the `system/turn_duration`
 *     record the TUI writes when a turn ends,
 *   - the screen read for the few prompts a turn cannot get past on its own
 *     (`classifyScreen`), because the TUI has no control channel to ask.
 *
 * It exists as insurance for the day headless `--print` is removed or
 * restricted. Today both transports draw from the same plan usage limits.
 */

function resolveClaude(cmd = "claude"): string {
  if (path.isAbsolute(cmd) && fs.existsSync(cmd)) return cmd
  const viaBun = Bun.which(cmd)
  if (viaBun) return viaBun
  const isWin = os.platform() === "win32"
  try {
    const out = execFileSync(isWin ? "where" : "which", [cmd], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    const first = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .find((p) => fs.existsSync(p))
    if (first) return first
  } catch {}
  throw new Error(`Could not resolve command on PATH: ${cmd}`)
}

/**
 * Claude names the transcript dir from the cwd's REAL path, then replaces
 * EVERY non-alphanumeric char with `-` (no collapsing of runs). Verified on
 * Windows against ~/.claude/projects, e.g.:
 *   C:\code\my-app    -> C--code-my-app
 *   C:\dev\My Project -> C--dev-My-Project   (the space also becomes `-`).
 *
 * The realpath half was measured on macOS with Claude Code 2.1.280: a headless
 * turn run from `/tmp/cc-probe-endturn` wrote
 * `~/.claude/projects/-private-tmp-cc-probe-endturn/<session>.jsonl`, and one
 * run from the symlink `/private/tmp/ccp-alias-a` wrote to
 * `-private-tmp-ccp-target-a`. So this is not a `/tmp` special case: the CLI
 * resolves symlinks anywhere in the path. Resolving with `path.resolve` alone
 * (which does not follow symlinks) pointed this at a directory the CLI never
 * writes, so the interactive transport could never tail a /tmp cwd's turn.
 *
 * A path that does not exist cannot be realpath'd, so it falls back to
 * `path.resolve`, which is also what every pre-existing caller assumed.
 */
export function encodeCwd(cwd: string): string {
  const resolved = path.resolve(cwd)
  let real = resolved
  try {
    real = fs.realpathSync.native(resolved)
  } catch {
    // ENOENT (the dir is not created yet) or a permission error: the literal
    // resolved path is the best guess available and matches the CLI whenever
    // no symlink is involved.
  }
  return real.replace(/[^a-zA-Z0-9]/g, "-")
}

export interface TurnResult {
  text: string
  stopReason: string | null
  /** The turn summed over DISTINCT API calls, shaped like a headless
   *  `result` frame's usage. The flat counters below are the same totals. */
  usage: any | null
  /** The newest real call's usage: the conversation's context occupancy,
   *  which is NOT the turn sum on a multi-call turn. */
  lastCallUsage: any | null
  cacheReadTokens: number
  cacheCreationTokens: number
  ephemeral1hTokens: number
  ephemeral5mTokens: number
  inputTokens: number
  outputTokens: number
  elapsedMs: number
}

export interface ClaudeSessionOptions {
  cwd?: string
  /** Claude CLI executable or account wrapper path. */
  cliPath?: string
  /** Claude config root used for JSONL transcripts (defaults to ~/.claude). */
  configDir?: string
  model?: string
  /** '' bypasses CLAUDE.md + user/project/local settings load (fast tests).
   *  null/undefined omits the flag entirely (normal settings). */
  settingSources?: string | null
  extraArgs?: string[]
  /** Strip ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN from the spawn env so the
   *  CLI uses subscription auth instead of pay-as-you-go API billing. */
  ignoreAnthropicApiKey?: boolean
  /** CLI effort level (low | medium | high | xhigh | max), exported as
   *  CLAUDE_CODE_EFFORT_LEVEL so it overrides the account's settings.json. */
  effort?: string
  cols?: number
  rows?: number
  bootMinMs?: number
  bootQuietMs?: number
  bootMaxMs?: number
  pollMs?: number
  turnTimeoutMs?: number
  /** false = plain write(prompt)+Enter; true = wrap in bracketed-paste so
   *  multi-line prompts don't submit early. Default true. */
  bracketedPaste?: boolean
  /** Submitting a turn: a large/multi-line bracketed paste collapses into a
   *  "[Pasted text]" placeholder, and an Enter sent while claude is still
   *  ingesting the paste is silently DROPPED — so a single fixed-delay Enter is
   *  unreliable and the turn can hang until turnTimeoutMs. Instead: wait
   *  submitMinMs, send Enter, then confirm the turn was accepted (a new
   *  transcript record appears) within submitConfirmMs; if not, resend Enter,
   *  up to submitMaxRetries times. */
  submitMinMs?: number
  submitConfirmMs?: number
  submitMaxRetries?: number
  /** Abort the call (during boot or an in-flight turn): kills the process and
   *  rejects with an "aborted" error. */
  signal?: AbortSignal
  debug?: boolean
  /** Continue this Claude session (`--resume <id>`) instead of starting a new
   *  one. The CLI appends to the same `<id>.jsonl`, measured on 2.1.288. */
  resumeSessionId?: string
  /**
   * Fork this Claude session instead: this session (its own `sessionId`)
   * starts from a copy of that conversation and the original is never written
   * (`--session-id <own> --resume <id> --fork-session`). Measured on 2.1.288:
   * the copy keeps the parent's records and uuids with the session id
   * rewritten, and a parent caught mid-turn is closed in the copy with a
   * synthetic "No response requested." reply, so the first turn reads nothing
   * before its own prompt record.
   */
  forkOf?: string
  /** The whole child environment. Defaults to `interactiveSpawnEnv`; the
   *  plugin passes the headless spawn's env so both transports get the same
   *  hygiene, effort, cache TTL and thinking variables. `CLAUDE_CONFIG_DIR`
   *  and `TERM` are always set on top. */
  env?: Record<string, string | undefined>
  /** How often a turn reports that the TUI is still working while the
   *  transcript is quiet (a long tool call, a long thinking block). */
  heartbeatMs?: number
  /** How long to wait for the TUI to acknowledge an interrupt before the
   *  turn is ended anyway. */
  interruptGraceMs?: number
  /** How long the PTY must be quiet before a permission dialog is answered,
   *  so model text that merely contains the words is never mistaken for one. */
  permissionQuietMs?: number
  /** How long the transcript must stay quiet after a terminal stop_reason
   *  before the turn counts as ended (the call's remaining records). */
  stopSettleMs?: number
  /** How long `answerPlanApproval` waits for the dialog to be drawn. */
  planDialogWaitMs?: number
  /** Told about every screen the session acted on. */
  onScreen?: (event: ScreenEvent) => void
  /** Told once when the child is gone, with its exit code when it has one. */
  onExit?: (code: number | null) => void
  /** PTY seam for tests. Defaults to Bun's native terminal. */
  spawnPty?: PtySpawner
}

/** The subset of a Bun PTY subprocess this module uses. */
export interface PtyHandle {
  readonly terminal: { write(data: string): unknown; close(): void }
  readonly exited: Promise<number | null | undefined>
  kill(): void
}

export type PtySpawner = (
  argv: string[],
  opts: {
    cwd: string
    env: Record<string, string | undefined>
    cols: number
    rows: number
    onData: (chunk: string) => void
  },
) => PtyHandle

const bunPtySpawner: PtySpawner = (argv, opts) => {
  const [command, ...args] = argv
  return Bun.spawn([resolveClaude(command ?? "claude"), ...args], {
    cwd: opts.cwd,
    env: opts.env,
    terminal: {
      cols: opts.cols,
      rows: opts.rows,
      data: (_term, data) => opts.onData(Buffer.from(data).toString("utf8")),
    },
  })
}

// ---------------------------------------------------------------------------
// Reading the screen.
//
// The TUI has no `can_use_tool` channel and no structured way to say "I am
// waiting for you". Everything it is blocked on is drawn on the screen, so the
// session reads the screen for the few states a turn cannot get past alone.
// Matching is on words with any whitespace between them, because Ink moves the
// cursor with escape sequences instead of writing spaces.
// ---------------------------------------------------------------------------

/** A screen the session recognises. */
export type ScreenKind =
  /** Folder trust. `--print` never asks, so accepting it is parity. */
  | "trust"
  /** No usable login. Nothing typed can fix it; fatal at boot. */
  | "login"
  /** First-run onboarding (theme picker). Fatal: run `claude` once by hand. */
  | "onboarding"
  /** A tool permission dialog. Denied: there is nobody here to ask. */
  | "permission"
  /** `ExitPlanMode`'s approval dialog. Never answered by the session on its
   *  own: it parks until `answerPlanApproval` brings the operator's decision. */
  | "plan-approval"
  /** The usage-limit screen's armed "continuing automatically at <time>".
   *  Cancelled, or the turn reruns later with nobody watching. */
  | "auto-continue"

export interface ScreenState {
  kind: ScreenKind
  /** The matched text, for logs. */
  detail: string
}

export interface ScreenEvent extends ScreenState {
  action: "accepted" | "denied" | "cancelled" | "fatal" | "parked"
}

function words(text: string): string {
  return text
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*")
}

const SCREEN_PATTERNS: ReadonlyArray<{ kind: ScreenKind; pattern: RegExp }> = [
  {
    kind: "login",
    pattern: new RegExp(
      [
        words("Select login method"),
        words("Please run /login"),
        words("Invalid API key"),
        words("OAuth token has expired"),
        words("Not logged in"),
      ].join("|"),
      "i",
    ),
  },
  {
    kind: "onboarding",
    pattern: new RegExp(
      [words("Choose the text style that looks best"), words("Let's get started.")].join("|"),
      "i",
    ),
  },
  {
    kind: "trust",
    pattern: new RegExp(
      [
        words("Do you trust the files in this folder?"),
        words("Is this a project you created or one you trust?"),
        words("Yes, I trust this folder"),
      ].join("|"),
      "i",
    ),
  },
  {
    // Measured verbatim on 2.1.288: "Claude has written up a plan and is ready
    // to execute. Would you like to proceed? ❯ 1. Yes, auto-accept edits
    // 2. Yes, manually approve edits 3. Tell Claude what to change". The
    // numbered last choice is what a reply quoting the question never has.
    kind: "plan-approval",
    pattern: new RegExp(
      `${words("Would you like to proceed?")}[\\s\\S]{0,400}?\\d\\s*\\.\\s*(?:${words("Tell Claude what to change")}|${words("No, keep planning")})`,
      "i",
    ),
  },
  {
    // The question alone is not enough: Claude can write "Do you want to
    // proceed?" in a reply. The dialog always numbers its options.
    kind: "permission",
    pattern: new RegExp(
      `${words("Do you want to")}\\s*(?:proceed|make\\s*this\\s*edit|create|overwrite|allow|run)[^?]{0,160}\\?[\\s\\S]{0,600}?1\\.\\s*Yes`,
      "i",
    ),
  },
  {
    kind: "auto-continue",
    pattern: new RegExp(
      `${words("continuing automatically at")}[^·\\n]{1,40}·\\s*${words("esc to cancel")}`,
      "i",
    ),
  },
]

/**
 * Terminal output as plain text: cursor-forward becomes spaces and every other
 * cursor move a line break, so words drawn apart stay apart; every other
 * escape sequence and control character is dropped.
 */
export function stripTerminal(raw: string): string {
  return raw
    .replace(/\x1B\[(\d*)C/g, (_match, count: string) =>
      " ".repeat(Math.min(Number(count) || 1, 200)),
    )
    .replace(/\x1B\[[0-9;?]*[ABDEFGHJKfd]/g, "\n")
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "")
    .replace(/[ \t]+/g, " ")
}

/**
 * Which choice of a Yes/No select the TUI's `❯` marks, read from the newest
 * draw, or null when no marked choice is on screen. The folder trust dialog
 * marks "No, exit" by default on 2.1.288 (measured 2026-10-05), so Enter is
 * only ever pressed once this says "yes".
 */
export function highlightedChoice(text: string): "yes" | "no" | null {
  let last: string | null = null
  for (const match of text.matchAll(/❯\s*(?:\d+\s*\.\s*)?(Yes|No)\b/gi)) {
    last = match[1]!.toLowerCase()
  }
  return last === "yes" || last === "no" ? last : null
}

/** The operator's decision on an `ExitPlanMode` approval dialog. */
export interface PlanApprovalAnswer {
  approved: boolean
  /** What to tell Claude instead, when not approved. */
  feedback?: string
}

/**
 * Which keys answer a plan approval dialog, read off the dialog itself rather
 * than assumed, because the CLI has numbered these choices differently over
 * time. Approval is "manually approve edits", the choice that changes nothing
 * else about the session's permissions; "auto-accept" only when that is the
 * only Yes drawn. Rejection is "Tell Claude what to change", which takes the
 * operator's words (measured on 2.1.288: the CLI hands them to the model in the
 * `ExitPlanMode` result), or an older "No, keep planning", which takes none.
 */
export function planApprovalKeys(text: string): {
  approve: string | null
  reject: string | null
  rejectTakesText: boolean
} {
  const approve =
    /(\d)\s*\.\s*Yes,?\s*(?:and\s*)?manually\s*approve\s*edits/i.exec(text)?.[1] ??
    /(\d)\s*\.\s*Yes,?\s*(?:and\s*)?auto-?\s*accept\s*edits/i.exec(text)?.[1] ??
    null
  const tell = /(\d)\s*\.\s*Tell\s*Claude\s*what\s*to\s*change/i.exec(text)?.[1]
  if (tell) return { approve, reject: tell, rejectTakesText: true }
  const keep = /(\d)\s*\.\s*No,?\s*keep\s*planning/i.exec(text)?.[1] ?? null
  return { approve, reject: keep, rejectTakesText: false }
}

/** The first recognised screen in this text, or null. Pure. */
export function classifyScreen(text: string): ScreenState | null {
  for (const { kind, pattern } of SCREEN_PATTERNS) {
    const match = pattern.exec(text)
    if (match) {
      return { kind, detail: match[0].replace(/\s+/g, " ").trim().slice(0, 200) }
    }
  }
  return null
}

/** Where the TUI writes a session's transcript. */
export function interactiveTranscriptPath(opts: {
  configDir?: string
  cwd: string
  sessionId: string
}): string {
  return path.join(
    resolveConfigDir(opts.configDir),
    "projects",
    encodeCwd(path.resolve(opts.cwd)),
    `${opts.sessionId}.jsonl`,
  )
}

/**
 * `CLAUDE_CONFIG_DIR` for the child, set only when a config dir was actually
 * configured. Setting it at all changes where the CLI looks for its login:
 * measured on 2.1.288, `claude auth status` says `loggedIn: true` with it
 * unset and `loggedIn: false` with it set to the very same `~/.claude`. So
 * the default account must inherit the variable exactly as the headless
 * spawn does, or every interactive spawn boots logged out.
 */
export function configDirEnv(configDir: string | undefined): Record<string, string> {
  return configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}
}

/**
 * Env for the interactive (TUI) child. The headless counterpart is
 * `claudeSpawnEnv` in session-manager.ts; both must apply `cliHygieneEnv`, so
 * this is a named function rather than an object literal inside `Bun.spawn`,
 * which no test can reach without a real PTY.
 */
export function interactiveSpawnEnv(opts: {
  /** Set only for a configured account; see `configDirEnv`. */
  configDir?: string
  ignoreAnthropicApiKey?: boolean
  effort?: string
}): Record<string, string | undefined> {
  return {
    ...process.env,
    ...configDirEnv(opts.configDir),
    TERM: "xterm-256color",
    // Pin the binary so a mid-session autoupdate cannot invalidate the
    // detected version the flag gates read, and skip non-essential traffic.
    // Fills gaps only, so a var the user exported survives untouched.
    ...cliHygieneEnv(),
    ...(opts.ignoreAnthropicApiKey
      ? { ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined }
      : {}),
    ...(opts.effort ? { CLAUDE_CODE_EFFORT_LEVEL: opts.effort } : {}),
  }
}

function usageInputSide(usage: any): number {
  return (
    (usage?.input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0)
  )
}

/**
 * A transcript record that represents a real API call this turn made.
 *
 * An all-zero record is not one, and that is not a hypothetical:
 * `model: "<synthetic>"` with every counter at 0 is how the CLI writes
 * "Login expired", an unavailable model and a session limit INTO the
 * transcript, carrying a terminal `stop_reason` as it goes. The guard is the
 * same one `stream-parser.ts` applies to `assistant` frames when it builds
 * `lastCallUsage`, so the two agree about what a call is.
 */
export function isApiCallRecord(rec: any): boolean {
  if (!rec || rec.type !== "assistant" || !rec.message) return false
  return usageInputSide(rec.message.usage) > 0
}

/**
 * Per-API-call usage aggregation over session-transcript records.
 *
 * The JSONL writes ONE record per content block, so a single API call appears
 * two or three times (thinking, text, tool_use), each record repeating that
 * call's FINAL usage verbatim. Measured on Claude Code 2.1.280 (2026-09-30):
 * over 240,000 records on this machine no two records of one `message.id`
 * ever disagreed, and summing `output_tokens` per RECORD instead of per CALL
 * doubled the turn (1,306 against a true 653 on a four-tool interactive turn,
 * the 653 confirmed by the CLI's own `cost-state` record). So count a call
 * once, keyed by `message.id`.
 *
 * This is the transcript's own shape, NOT the headless stream's: there a
 * call's frames carry a streaming placeholder (8, 3, 1, 1, 1 for calls whose
 * real output was 180, 93, 95, 92, 30) and only the `result` frame has the
 * truth. The transcript records are written after the call completes, so each
 * one already holds the final count. Measure a path, never port one to it.
 */
export class TurnUsageAccumulator {
  private readonly calls = new Map<string, any>()
  private lastKey: string | null = null

  /** Feed every transcript record of the turn, in file order. */
  add(rec: any): void {
    if (!isApiCallRecord(rec)) return
    const id = rec.message.id
    // Records of one call repeat identical usage, so the newest wins and the
    // first would do just as well. A record with no id cannot be collapsed
    // with anything, so it keys on its own uuid rather than on "".
    const key =
      typeof id === "string" && id.length > 0
        ? id
        : `uuid:${rec.uuid ?? this.calls.size}`
    this.calls.set(key, rec.message.usage)
    this.lastKey = key
  }

  /** Distinct API calls seen, for diagnostics. */
  get callCount(): number {
    return this.calls.size
  }

  /**
   * The newest real call's usage, verbatim (its own `iterations` included):
   * the conversation's context occupancy, which is what a finish must report.
   * See `lastCallContextUsage` in `usage.ts`, the one convention for this.
   */
  get lastCall(): any | null {
    return this.lastKey === null ? null : (this.calls.get(this.lastKey) ?? null)
  }

  /**
   * The turn summed over DISTINCT calls: the shape and the meaning of a
   * headless `result` frame's usage, which is what `total_cost_usd` and
   * `turnStats` are about. Deliberately carries no `iterations`: that is one
   * response's server-side field and a sum of calls has no such list, so
   * `toUsage` falls back to these flat counters, while `lastCall` keeps its
   * own for `lastCallContextUsage` to read.
   */
  get turnTotal(): any | null {
    if (this.calls.size === 0) return null
    const total: any = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_creation: {
        ephemeral_1h_input_tokens: 0,
        ephemeral_5m_input_tokens: 0,
      },
      output_tokens_details: { thinking_tokens: 0 },
    }
    for (const u of this.calls.values()) {
      total.input_tokens += u.input_tokens ?? 0
      total.output_tokens += u.output_tokens ?? 0
      total.cache_read_input_tokens += u.cache_read_input_tokens ?? 0
      total.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0
      total.cache_creation.ephemeral_1h_input_tokens +=
        u.cache_creation?.ephemeral_1h_input_tokens ?? 0
      total.cache_creation.ephemeral_5m_input_tokens +=
        u.cache_creation?.ephemeral_5m_input_tokens ?? 0
      total.output_tokens_details.thinking_tokens +=
        u.output_tokens_details?.thinking_tokens ?? 0
    }
    return total
  }
}

const TERMINAL_STOP = new Set(["end_turn", "stop_sequence", "max_tokens"])
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Raw terminal output kept for diagnostics and for reading the screen. */
const RAW_KEEP_CHARS = 64 * 1024
// One full redraw of a busy 200x50 TUI frame is close to 16 KB of escape
// sequences (measured at 15,379 with a plan approval dialog up, 2.1.288), so a
// smaller window loses the top of a dialog the moment the frame grows: the
// plan approval's question slid out and the dialog went unrecognised until a
// later redraw (h #g201). The window is cleared after every action anyway.
const SCREEN_WINDOW_CHARS = 64 * 1024

/**
 * The text the TUI writes as a user record when a turn is interrupted: Esc on
 * a running turn ("[Request interrupted by user]") or on a tool permission
 * dialog ("[Request interrupted by user for tool use]"). Counted over this
 * machine's transcripts on 2026-10-04: 54 and 1,701 occurrences.
 */
const INTERRUPT_MARKER = "[Request interrupted by user"

/** True for the user record the TUI writes when a turn was interrupted. */
export function isInterruptRecord(rec: any): boolean {
  if (!rec || rec.type !== "user" || !rec.message) return false
  const content = rec.message.content
  if (typeof content === "string") return content.startsWith(INTERRUPT_MARKER)
  if (!Array.isArray(content)) return false
  return content.some(
    (block: any) =>
      block?.type === "text" &&
      typeof block.text === "string" &&
      block.text.startsWith(INTERRUPT_MARKER),
  )
}

/**
 * True for the `system`/`turn_duration` record the TUI writes once a turn is
 * over. Measured on 2.1.288 after a turn that ended on a usage limit; it is a
 * second end signal, never the only one a normal turn relies on.
 */
export function isTurnDurationRecord(rec: any): boolean {
  return rec?.type === "system" && rec.subtype === "turn_duration"
}

/** What the running turn has read so far; see `scanTranscript`. */
interface TurnScan {
  onRecord: (raw: string, rec: any | null) => void
  stopReason: string | null
  /** When records were last read; a terminal stop settles from here. */
  stopSeenAt: number
  end: TurnEnd | null
  /** End signals other than a terminal stop count only after this turn's
   *  own first user record, so a stale one can never end it. */
  sawUserRecord: boolean
  lastBeat: number
  /** A fork's first turn: the normalized prompt whose record ends the copied
   *  history. Nothing before it is read; null once it was seen. */
  awaitingOwnPrompt: string | null
}

const normalizedPrompt = (text: string) => text.replace(/\s+/g, " ").trim()

/** Whether a record is the user record a pasted prompt became. */
function isOwnPromptRecord(rec: any, normalized: string): boolean {
  const content = rec?.type === "user" ? rec.message?.content : undefined
  return typeof content === "string" && normalizedPrompt(content) === normalized
}

/** How a turn ended. */
export type TurnEnd =
  /** An assistant record with a terminal `stop_reason`. */
  | "stop"
  /** The TUI wrote its interrupt marker, or an interrupt was not
   *  acknowledged within `interruptGraceMs` and the turn was abandoned. */
  | "interrupted"
  /** The TUI wrote `turn_duration` without a terminal assistant record. */
  | "ended"

export interface TailTurnResult {
  stopReason: string | null
  end: TurnEnd
  usage: any | null
  lastCallUsage: any | null
  callCount: number
  /** Permission dialogs denied during this turn. */
  denied: ScreenState[]
}

export function resolveConfigDir(configDir: string | undefined): string {
  const value = configDir ?? process.env.CLAUDE_CONFIG_DIR
  if (!value) return path.join(os.homedir(), ".claude")
  if (value === "~") return os.homedir()
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2))
  }
  return path.resolve(value)
}

function fatalScreenMessage(kind: ScreenKind, configDir: string, cwd: string): string {
  if (kind === "trust") {
    return `Claude Code's folder trust dialog for ${cwd} could not be answered. Run \`claude\` in that folder once by hand and trust it, then retry.`
  }
  if (kind === "login") {
    return `Claude Code is not logged in for ${configDir}. Run \`claude\` there once by hand and log in (or \`claude auth login\`), then retry.`
  }
  return `Claude Code has not finished its first-run setup for ${configDir}. Run \`claude\` there once by hand, then retry.`
}

export class ClaudeSession {
  readonly sessionId: string
  readonly cwd: string
  readonly configDir: string
  readonly jsonlPath: string
  /** The newest terminal output, ANSI included, for diagnostics. */
  raw = ""

  private proc: PtyHandle | null = null
  private cursor = 0 // index into transcript split('\n')
  private lastDataAt = 0
  private exited = false
  private exitCode: number | null = null
  private aborted = false
  private readonly signal?: AbortSignal
  private readonly resumeSessionId?: string
  private readonly forkOf?: string
  /** A fork whose first turn has not started: its transcript opens with the
   *  parent's copied conversation, which belongs to no turn of this session. */
  private forkPending = false
  private readonly env?: Record<string, string | undefined>
  private readonly onScreen?: (event: ScreenEvent) => void
  private readonly onExit?: (code: number | null) => void
  private readonly spawnPty: PtySpawner
  /** The configured config dir, which alone is exported to the child. */
  private readonly explicitConfigDir?: string
  /** Output since the screen was last acted on, read by `checkScreen`. */
  private screen = ""
  private screenTimer: ReturnType<typeof setTimeout> | null = null
  private fatal: ScreenEvent | null = null
  /** The folder trust dialog is up and not answered yet. */
  private trustPending = false
  private trustMoves = 0
  private trustMovedAt = 0
  private turn: Promise<unknown> | null = null
  /** The running turn's read state, shared with `flushTranscript`. */
  private scan: TurnScan | null = null
  private turnDenied: ScreenState[] = []
  /** The running turn's `ExitPlanMode` call that has no result yet. */
  private planApprovalToolUseId: string | null = null
  /** The approval dialog as drawn for one `ExitPlanMode` call, until it is
   *  answered. Keyed by the call, so a redraw of a dialog already answered
   *  (the TUI repaints it while it takes the key, measured on 2.1.288) can
   *  never stand in for the next call's dialog. */
  private planDialog: { id: string; text: string } | null = null
  /** This turn's `ExitPlanMode` calls already answered. */
  private readonly answeredPlans = new Set<string>()
  private abandonTurn = false
  private readonly o: Required<
    Omit<
      ClaudeSessionOptions,
      | "cliPath"
      | "configDir"
      | "model"
      | "settingSources"
      | "extraArgs"
      | "signal"
      | "ignoreAnthropicApiKey"
      | "effort"
      | "resumeSessionId"
      | "forkOf"
      | "env"
      | "onScreen"
      | "onExit"
      | "spawnPty"
    >
  > &
    Pick<
      ClaudeSessionOptions,
      | "cliPath"
      | "configDir"
      | "model"
      | "settingSources"
      | "extraArgs"
      | "ignoreAnthropicApiKey"
      | "effort"
    >

  constructor(opts: ClaudeSessionOptions = {}) {
    this.cwd = path.resolve(opts.cwd ?? process.cwd())
    this.configDir = resolveConfigDir(opts.configDir)
    this.explicitConfigDir = opts.configDir ? this.configDir : undefined
    this.signal = opts.signal
    this.resumeSessionId = opts.forkOf ? undefined : opts.resumeSessionId
    this.forkOf = opts.forkOf
    this.forkPending = !!opts.forkOf
    this.env = opts.env
    this.onScreen = opts.onScreen
    this.onExit = opts.onExit
    this.spawnPty = opts.spawnPty ?? bunPtySpawner
    // A resumed session keeps its id: the CLI appends to the same transcript.
    this.sessionId = opts.resumeSessionId ?? randomUUID()
    this.jsonlPath = path.join(
      this.configDir,
      "projects",
      encodeCwd(this.cwd),
      `${this.sessionId}.jsonl`,
    )
    this.o = {
      cwd: this.cwd,
      cliPath: opts.cliPath,
      configDir: this.configDir,
      model: opts.model,
      settingSources: opts.settingSources,
      extraArgs: opts.extraArgs ?? [],
      ignoreAnthropicApiKey: opts.ignoreAnthropicApiKey,
      effort: opts.effort,
      cols: opts.cols ?? 200,
      rows: opts.rows ?? 50,
      bootMinMs: opts.bootMinMs ?? 3000,
      bootQuietMs: opts.bootQuietMs ?? 1500,
      bootMaxMs: opts.bootMaxMs ?? 25000,
      pollMs: opts.pollMs ?? 250,
      // Agentic turns (tool loops) routinely run for many minutes; a short
      // cap would surface as a mid-task error result. 30 min mirrors the
      // proxy-tool ceiling rather than a chat-reply expectation.
      turnTimeoutMs: opts.turnTimeoutMs ?? 1_800_000,
      bracketedPaste: opts.bracketedPaste ?? true,
      submitMinMs: opts.submitMinMs ?? 200,
      submitConfirmMs: opts.submitConfirmMs ?? 1500,
      submitMaxRetries: opts.submitMaxRetries ?? 8,
      debug: opts.debug ?? false,
      // The headless CLI's `tool_progress` heartbeat runs every 30 s, and the
      // wire-inactivity watchdog it keeps quiet fires at 60 s.
      heartbeatMs: opts.heartbeatMs ?? 30_000,
      interruptGraceMs: opts.interruptGraceMs ?? 5_000,
      // Shorter than `bootQuietMs`, so a trust dialog is answered before boot
      // could declare the TUI ready and paste a prompt into it.
      permissionQuietMs: opts.permissionQuietMs ?? 1_000,
      stopSettleMs: opts.stopSettleMs ?? 750,
      // The decision arrives after opencode's own question round trip, by
      // which time the dialog has long been drawn; this only bounds a TUI
      // that never draws it.
      planDialogWaitMs: opts.planDialogWaitMs ?? 30_000,
    }
  }

  /** The CLI arguments this session spawns with. */
  spawnArgs(): string[] {
    const args: string[] = this.forkOf
      ? ["--session-id", this.sessionId, "--resume", this.forkOf, "--fork-session"]
      : this.resumeSessionId
        ? ["--resume", this.resumeSessionId]
        : ["--session-id", this.sessionId]
    if (this.o.model) args.push("--model", this.o.model)
    if (this.o.settingSources !== null && this.o.settingSources !== undefined) {
      args.push("--setting-sources", this.o.settingSources)
    }
    if (this.o.extraArgs && this.o.extraArgs.length) args.push(...this.o.extraArgs)
    return args
  }

  /** The child environment: the caller's (or the default one) plus `TERM`,
   *  and `CLAUDE_CONFIG_DIR` only for a configured one (`configDirEnv`). */
  spawnEnv(): Record<string, string | undefined> {
    if (!this.env) {
      return interactiveSpawnEnv({
        configDir: this.explicitConfigDir,
        ignoreAnthropicApiKey: this.o.ignoreAnthropicApiKey,
        effort: this.o.effort,
      })
    }
    return { ...this.env, ...configDirEnv(this.explicitConfigDir), TERM: "xterm-256color" }
  }

  /** True while a turn is between its paste and its end. */
  get turnRunning(): boolean {
    return this.turn !== null
  }

  /** True once the child is gone (exited, killed or never started). */
  get hasExited(): boolean {
    return this.exited
  }

  async start(): Promise<void> {
    if (this.signal?.aborted) throw new Error("aborted before start")
    this.signal?.addEventListener(
      "abort",
      () => {
        this.aborted = true
        this.dispose()
      },
      { once: true },
    )
    const claude = this.o.cliPath ?? "claude"
    const args = this.spawnArgs()

    if (this.o.debug)
      process.stderr.write(`[session] spawn: ${claude} ${args.join(" ")}\n`)

    this.lastDataAt = Date.now()
    const proc = this.spawnPty([claude, ...args], {
      cwd: this.cwd,
      env: this.spawnEnv(),
      cols: this.o.cols,
      rows: this.o.rows,
      onData: (chunk) => this.onData(chunk),
    })
    this.proc = proc
    const markExited = (code: number | null) => {
      if (this.exited) return
      this.exitCode = code
      this.exited = true
      this.proc = null
      this.clearScreenTimer()
      this.onExit?.(code)
    }
    proc.exited
      .then((code) => markExited(typeof code === "number" ? code : null))
      .catch(() => markExited(null))

    await this.waitForBoot()
    this.cursor = this.lineCount()
  }

  private onData(chunk: string): void {
    this.lastDataAt = Date.now()
    this.raw = (this.raw + chunk).slice(-RAW_KEEP_CHARS)
    this.screen = (this.screen + chunk).slice(-SCREEN_WINDOW_CHARS)
    if (this.o.debug) process.stdout.write(chunk)
    // Act on a screen only once the TUI has stopped drawing: a dialog sits
    // still, while model text that merely contains the words keeps moving.
    this.scheduleScreenCheck()
  }

  private scheduleScreenCheck(): void {
    this.clearScreenTimer()
    this.screenTimer = setTimeout(() => {
      this.screenTimer = null
      this.checkScreen()
    }, this.o.permissionQuietMs)
  }

  private clearScreenTimer(): void {
    if (this.screenTimer) {
      clearTimeout(this.screenTimer)
      this.screenTimer = null
    }
  }

  /**
   * Answer the screen the TUI is blocked on, if it is one of the few this
   * session recognises. Returns what it did, or null. Each screen is acted on
   * once: the window is cleared afterwards, so the next check only reads what
   * the TUI drew since.
   */
  checkScreen(): ScreenEvent | null {
    if (!this.proc || this.exited) return null
    const text = stripTerminal(this.screen)
    // Once the trust dialog is up, a redraw may repaint only the two choice
    // lines, which no longer match the dialog's own wording.
    const state: ScreenState | null = this.trustPending
      ? { kind: "trust", detail: "folder trust dialog" }
      : classifyScreen(text)
    if (!state) return null
    let action: ScreenEvent["action"]
    switch (state.kind) {
      case "trust": {
        this.trustPending = true
        const choice = highlightedChoice(text)
        if (choice === "yes") {
          this.write("\r")
          this.trustPending = false
          action = "accepted"
          break
        }
        // Nothing marked yet, or the last move not drawn yet: wait.
        if (choice === null) return null
        if (this.trustMovedAt && this.lastDataAt <= this.trustMovedAt) return null
        if (this.trustMoves >= 4) {
          action = "fatal"
          break
        }
        // The TUI marks "No, exit": move down one. The window is kept, so the newest `❯` in it is the TUI's own
        // answer to this move.
        this.trustMoves++
        this.trustMovedAt = Date.now()
        this.write("\x1b[B")
        return null
      }
      case "permission":
        // Only a turn can raise one. Outside a turn the match is a reply's
        // text still on screen, and Esc at an idle prompt is not free.
        if (!this.turn) return null
        this.write("\x1b")
        this.turnDenied.push(state)
        action = "denied"
        break
      case "auto-continue":
        this.write("\x1b")
        action = "cancelled"
        break
      case "plan-approval": {
        // Parked, not answered: the decision is the operator's. Only for the
        // call the transcript says is waiting, once, and never for one that
        // was answered already.
        const id = this.planApprovalToolUseId
        if (!this.turn || !id || this.answeredPlans.has(id) || this.planDialog?.id === id) return null
        this.planDialog = { id, text }
        action = "parked"
        break
      }
      case "login":
      case "onboarding":
        action = "fatal"
        break
    }
    this.screen = ""
    const event: ScreenEvent = { ...state, action }
    if (action === "fatal") {
      this.fatal = event
      this.killProcess()
    }
    try {
      this.onScreen?.(event)
    } catch {}
    return event
  }

  private write(data: string): void {
    try {
      this.proc?.terminal.write(data)
    } catch {}
  }

  private fatalError(): Error | null {
    if (!this.fatal) return null
    return new Error(
      this.failureMessage(fatalScreenMessage(this.fatal.kind, this.configDir, this.cwd), true),
    )
  }

  /** Wait until the TUI has been quiet for bootQuietMs (Ink ready), bounded by
   *  bootMinMs..bootMaxMs. A screen still waiting to be answered when the TUI
   *  goes quiet is answered first, and the wait goes on. */
  private async waitForBoot(): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < this.o.bootMaxMs) {
      await delay(150)
      if (this.aborted) throw new Error("aborted during boot")
      const fatal = this.fatalError()
      if (fatal) throw fatal
      if (this.exited) {
        throw new Error(this.failureMessage("claude exited during boot", true))
      }
      const elapsed = Date.now() - start
      const sinceData = Date.now() - this.lastDataAt
      if (elapsed >= this.o.bootMinMs && sinceData >= this.o.bootQuietMs) {
        const acted = this.checkScreen()
        if (!acted && !this.trustPending) return
        const fatalNow = this.fatalError()
        if (fatalNow) throw fatalNow
      }
    }
    // Pasting a prompt into the dialog would answer it with the prompt's text.
    if (this.trustPending) {
      this.fatal = { kind: "trust", detail: "folder trust dialog", action: "fatal" }
      this.killProcess()
      throw this.fatalError()!
    }
  }

  /** Submit the freshly-injected prompt and confirm the turn was actually
   *  accepted. A large bracketed paste collapses into a "[Pasted text]"
   *  placeholder; an Enter sent while claude is still ingesting the paste is
   *  silently dropped, so a single fixed-delay Enter races the paste and can
   *  leave the prompt sitting unsubmitted (→ hang until turnTimeoutMs). Send
   *  Enter, then poll for transcript growth past the cursor (the turn's records
   *  are written on acceptance); resend Enter until accepted or the retry
   *  budget is spent. Polling growth (not a blind delay) also stops us from
   *  sending a stray Enter once the turn is in flight. */
  private async submitTurn(): Promise<void> {
    await delay(this.o.submitMinMs)
    for (let attempt = 0; attempt < this.o.submitMaxRetries; attempt++) {
      if (this.aborted || this.exited || !this.proc) return
      this.proc.terminal.write("\r")
      const until = Date.now() + this.o.submitConfirmMs
      while (Date.now() < until) {
        await delay(80)
        if (this.aborted || this.exited) return
        if (this.lineCount() > this.cursor) return // turn accepted
      }
    }
  }

  private readRawLines(): string[] {
    try {
      return fs.readFileSync(this.jsonlPath, "utf8").split("\n")
    } catch {
      return []
    }
  }

  /** Count of complete lines (split('\n') minus the trailing/partial element). */
  private lineCount(): number {
    const lines = this.readRawLines()
    return lines.length > 0 ? lines.length - 1 : 0
  }

  private rawTail(max = 600): string {
    const clean = stripTerminal(this.raw).replace(/\s+/g, " ").trim()
    return clean.length > max ? clean.slice(-max) : clean
  }

  private failureMessage(reason: string, includeRaw = false): string {
    const parts = [
      `${reason} (sessionId=${this.sessionId}, jsonlPath=${this.jsonlPath}, exitCode=${this.exitCode ?? "unknown"})`,
    ]
    if (includeRaw) {
      const tail = this.rawTail()
      if (tail) parts.push(`terminalTail=${JSON.stringify(tail)}`)
    }
    return parts.join("; ")
  }

  /**
   * Paste a turn into the live session and follow the transcript until the
   * turn ends, handing every new record to `onRecord` (raw line and parsed
   * record, the latter null when the line is not JSON). One turn at a time:
   * a second call while one runs is refused, because both would read the
   * same cursor.
   */
  private async runTurnLoop(
    prompt: string,
    onRecord: (raw: string, rec: any | null) => void,
    timeout: number,
    onHeartbeat?: () => void,
  ): Promise<{ stopReason: string | null; end: TurnEnd | null; denied: ScreenState[] }> {
    if (this.aborted) throw new Error("aborted")
    const fatal = this.fatalError()
    if (fatal) throw fatal
    if (!this.proc || this.exited)
      throw new Error("session not started or already exited")
    if (this.turn) throw new Error("a turn is already running in this session")

    let settle!: () => void
    this.turn = new Promise<void>((resolve) => (settle = resolve))
    this.turnDenied = []
    this.abandonTurn = false
    // Records written between turns (a late `turn_duration`, an interrupt
    // marker) belong to the turn before, never to this one.
    this.cursor = Math.max(this.cursor, this.lineCount())
    // A reply from an earlier turn may still be in the window; nothing this
    // turn raises has been drawn yet.
    this.screen = ""

    try {
      // Bracketed paste keeps multi-line prompts from submitting early;
      // submitTurn() then presses Enter and confirms the turn was accepted,
      // resending Enter if the (collapsed) paste swallowed the first one.
      if (this.o.bracketedPaste) {
        this.proc.terminal.write("\x1b[200~" + prompt + "\x1b[201~")
      } else {
        this.proc.terminal.write(prompt)
      }
      await this.submitTurn()

      const scan: TurnScan = {
        onRecord,
        stopReason: null,
        stopSeenAt: 0,
        end: null,
        sawUserRecord: false,
        lastBeat: Date.now(),
        awaitingOwnPrompt: this.forkPending ? normalizedPrompt(prompt) : null,
      }
      this.forkPending = false
      this.scan = scan
      const deadline = Date.now() + timeout

      while (Date.now() < deadline) {
        await delay(this.o.pollMs)
        if (this.aborted) throw new Error("aborted mid-turn")
        const fatalNow = this.fatalError()
        if (fatalNow) throw fatalNow
        // `flushTranscript` may have read the end between two polls.
        if (this.scanTranscript() || scan.end) {
          if (scan.end) {
            return {
              stopReason: scan.end === "stop" ? scan.stopReason : null,
              end: scan.end,
              denied: this.turnDenied,
            }
          }
          continue
        }
        if (scan.stopReason && Date.now() - scan.stopSeenAt >= this.o.stopSettleMs) {
          return { stopReason: scan.stopReason, end: "stop", denied: this.turnDenied }
        }
        // Drain the transcript before reacting to exit: a final assistant record
        // can be flushed in the same tick the process exits.
        if (this.exited) throw new Error(this.failureMessage("claude exited mid-turn", true))
        if (this.abandonTurn) return { stopReason: null, end: "interrupted", denied: this.turnDenied }
        const now = Date.now()
        if (onHeartbeat && now - scan.lastBeat >= this.o.heartbeatMs) {
          scan.lastBeat = now
          // Only while the TUI is visibly alive (its spinner redraws several
          // times a second): a wedged child must still meet the watchdog.
          if (now - this.lastDataAt < this.o.heartbeatMs) onHeartbeat()
        }
      }
      return { stopReason: null, end: null, denied: this.turnDenied }
    } finally {
      this.turn = null
      this.scan = null
      this.abandonTurn = false
      this.planApprovalToolUseId = null
      this.planDialog = null
      this.answeredPlans.clear()
      settle()
    }
  }

  /**
   * Read every complete transcript record past the cursor into the running
   * turn. Returns whether anything new was read. The one place a record is
   * interpreted, shared by the poll loop and `flushTranscript`.
   */
  private scanTranscript(): boolean {
    const scan = this.scan
    if (!scan || scan.end) return false
    const lines = this.readRawLines()
    const lastComplete = lines.length - 1 // exclusive bound; trailing/partial line skipped
    if (lastComplete <= this.cursor) return false
    for (let i = this.cursor; i < lastComplete && !scan.end; i++) {
      const s = lines[i]
      if (!s || !s.trim()) {
        this.cursor = i + 1
        continue
      }
      let rec: any = null
      try {
        rec = JSON.parse(s)
      } catch {}
      if (scan.awaitingOwnPrompt !== null) {
        if (!isOwnPromptRecord(rec, scan.awaitingOwnPrompt)) {
          this.cursor = i + 1
          continue
        }
        scan.awaitingOwnPrompt = null
      }
      // Before the record is handed on: whoever reads it may ask at once
      // whether a plan approval is pending.
      if (rec) this.notePlanApproval(rec)
      scan.onRecord(s, rec)
      if (rec) {
        if (rec.type === "assistant" && rec.message) {
          const reason = rec.message.stop_reason
          // A non-terminal stop after a terminal one is the model going on
          // (a Stop hook can make it), so the turn is not over.
          if (typeof reason === "string") {
            scan.stopReason = TERMINAL_STOP.has(reason) ? reason : null
          }
        } else if (rec.type === "user") {
          if (scan.sawUserRecord && isInterruptRecord(rec)) scan.end = "interrupted"
          scan.sawUserRecord = true
        } else if ((scan.sawUserRecord || scan.stopReason) && isTurnDurationRecord(rec)) {
          scan.end = scan.stopReason ? "stop" : "ended"
        }
      }
      this.cursor = i + 1
    }
    if (!scan.end) this.cursor = lastComplete
    scan.lastBeat = Date.now()
    scan.stopSeenAt = Date.now()
    return true
  }

  /**
   * Hand the running turn every record the TUI has already written, now
   * rather than at the next poll. The TUI writes a reply's records before it
   * runs the reply's tools, but a proxied tool's MCP call can reach the
   * plugin inside one poll interval, and the step it ends must not close
   * before the text that preceded the call was read. No-op between turns.
   */
  flushTranscript(): void {
    this.scanTranscript()
  }

  /** Track the turn's `ExitPlanMode` call from the transcript: opened by the
   *  assistant record that makes it, closed by the result that answers it. */
  private notePlanApproval(rec: any): void {
    const content = rec?.message?.content
    if (!Array.isArray(content)) return
    if (rec.type === "assistant") {
      for (const block of content) {
        if (block?.type === "tool_use" && block.name === "ExitPlanMode" && typeof block.id === "string") {
          this.planApprovalToolUseId = block.id
          // The dialog may already be drawn and sitting still, and a still
          // screen sends nothing that would make it read again.
          this.scheduleScreenCheck()
        }
      }
    } else if (rec.type === "user" && this.planApprovalToolUseId) {
      const answered = content.some(
        (block: any) => block?.type === "tool_result" && block.tool_use_id === this.planApprovalToolUseId,
      )
      if (answered) {
        if (this.planDialog?.id === this.planApprovalToolUseId) this.planDialog = null
        this.planApprovalToolUseId = null
      }
    }
  }

  /**
   * The running turn's unanswered `ExitPlanMode` call id, or null. While it is
   * set the TUI is parked on (or about to draw) the approval dialog, and the
   * next message is the operator's decision, not a new turn.
   */
  get pendingPlanApproval(): string | null {
    return this.turn ? this.planApprovalToolUseId : null
  }

  /**
   * Answer the plan approval dialog the running turn is parked on. Waits up to
   * `planDialogWaitMs` for it to be drawn, because the transcript records the
   * call before the TUI draws the dialog, and resolves false when there is
   * none to answer or the drawn dialog has no matching choice.
   */
  async answerPlanApproval(
    answer: PlanApprovalAnswer,
    timeoutMs = this.o.planDialogWaitMs,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    let dialog = this.planDialog
    while (!dialog || dialog.id !== this.planApprovalToolUseId) {
      if (!this.turn || this.exited || Date.now() >= deadline) return false
      // A dialog drawn before its call's record was read is still in the
      // window, and a TUI parked on it draws nothing that would read it again.
      if (Date.now() - this.lastDataAt >= this.o.permissionQuietMs) this.checkScreen()
      await delay(this.o.pollMs)
      dialog = this.planDialog
    }
    const keys = planApprovalKeys(dialog.text)
    const key = answer.approved ? keys.approve : keys.reject
    if (!key) return false
    this.answeredPlans.add(dialog.id)
    this.planDialog = null
    this.screen = ""
    this.write(key)
    if (answer.approved || !keys.rejectTakesText) return true
    // The choice opens a text field; type into it once it is drawn. One line:
    // a raw newline would submit early.
    await this.waitForQuiet()
    const text = (answer.feedback ?? "").replace(/\s+/g, " ").trim() || "no"
    this.write(text)
    await delay(this.o.submitMinMs)
    this.write("\r")
    return true
  }

  /** Wait until the PTY has been quiet for `permissionQuietMs`, at most 3 s. */
  private async waitForQuiet(): Promise<void> {
    const until = Date.now() + 3_000
    await delay(Math.min(this.o.permissionQuietMs, 3_000))
    while (Date.now() < until && Date.now() - this.lastDataAt < this.o.permissionQuietMs) {
      await delay(25)
    }
  }

  /**
   * Stop the running turn the way the TUI's own Esc does, and keep the
   * session alive for the next one. Resolves true once the turn ended, false
   * when it was abandoned after `interruptGraceMs` without the TUI saying so.
   */
  async interrupt(graceMs = this.o.interruptGraceMs): Promise<boolean> {
    const turn = this.turn
    if (!turn) return true
    this.write("\x1b")
    const ended = await Promise.race([turn.then(() => true), delay(graceMs).then(() => false)])
    if (ended) return true
    // One more Esc for a TUI that was mid-redraw, then stop following the turn
    // so the caller is not held for up to `turnTimeoutMs`.
    this.write("\x1b")
    this.abandonTurn = true
    await Promise.race([turn, delay(this.o.pollMs * 4)])
    return false
  }

  /**
   * Inject a turn into the live session and return the assistant reply once a
   * terminal stop_reason is observed in the transcript.
   */
  async ask(prompt: string, perTurnTimeoutMs?: number): Promise<TurnResult> {
    const timeout = perTurnTimeoutMs ?? this.o.turnTimeoutMs
    const t0 = Date.now()
    const collected: string[] = []
    const usage = new TurnUsageAccumulator()
    const { stopReason } = await this.runTurnLoop(
      prompt,
      (_raw, rec) => {
        if (rec?.type !== "assistant" || !rec.message) return
        // Each record carries DIFFERENT content blocks of the same call, so
        // text is collected per record while usage is counted per call.
        for (const b of rec.message.content ?? []) {
          if (b?.type === "text" && typeof b.text === "string") collected.push(b.text)
        }
        usage.add(rec)
      },
      timeout,
    )

    if (!stopReason) {
      throw new Error(
        this.failureMessage(
          `turn ended without a terminal assistant record after ${Date.now() - t0}ms (collected ${collected.length} text block(s))`,
        ),
      )
    }

    const turnTotal = usage.turnTotal
    const u = turnTotal ?? {}
    return {
      text: collected.join("\n").trim(),
      stopReason,
      usage: turnTotal,
      lastCallUsage: usage.lastCall,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
      ephemeral1hTokens: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      ephemeral5mTokens: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      elapsedMs: Date.now() - t0,
    }
  }

  /**
   * Like ask(), but instead of collecting the reply text it re-emits each NEW
   * raw JSONL transcript line via onLine (verbatim) until the turn ends. Used
   * by the opencode plugin transport shim, which feeds these raw lines into
   * the existing stream-json line handler unchanged.
   *
   * `usage` is the turn summed over DISTINCT API calls, which is exactly what
   * a headless `result` frame reports, so the shim can synthesize one and
   * every downstream consumer (the finish's `lastCallContextUsage`,
   * `turnStats`) behaves as it does on the headless path. `lastCallUsage` is
   * the newest real call, returned because a caller with no stream parser
   * (`askOnce`) has no other way to get the context side.
   *
   * A turn that ends any way other than a terminal stop (an interrupt, a
   * denied permission dialog, `turn_duration`) resolves with that `end` and a
   * null `stopReason`; only a timeout throws.
   */
  async tailTurn(
    prompt: string,
    onLine: (rawLine: string) => void,
    perTurnTimeoutMs?: number,
    onHeartbeat?: () => void,
  ): Promise<TailTurnResult> {
    const timeout = perTurnTimeoutMs ?? this.o.turnTimeoutMs
    const usage = new TurnUsageAccumulator()
    const { stopReason, end, denied } = await this.runTurnLoop(
      prompt,
      (raw, rec) => {
        onLine(raw)
        if (rec) usage.add(rec)
      },
      timeout,
      onHeartbeat,
    )

    if (!end) {
      throw new Error(
        this.failureMessage(
          `turn timed out after ${timeout}ms (no terminal assistant record)`,
        ),
      )
    }

    return {
      stopReason,
      end,
      usage: usage.turnTotal,
      lastCallUsage: usage.lastCall,
      callCount: usage.callCount,
      denied,
    }
  }

  private killProcess(): void {
    const proc = this.proc
    if (!proc) return
    try {
      proc.terminal.write("\x03")
    } catch {}
    try {
      proc.kill()
    } catch {}
    try {
      proc.terminal.close()
    } catch {}
  }

  dispose(): void {
    this.clearScreenTimer()
    this.killProcess()
    this.proc = null
  }
}

/** One-shot convenience (drop-in for `claude -p`): start, ask, dispose. */
export async function askOnce(
  prompt: string,
  opts: ClaudeSessionOptions = {},
): Promise<TurnResult> {
  const s = new ClaudeSession(opts)
  await s.start()
  try {
    return await s.ask(prompt)
  } finally {
    s.dispose()
  }
}
