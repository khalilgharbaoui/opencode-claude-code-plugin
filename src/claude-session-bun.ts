import * as os from "node:os"
import * as fs from "node:fs"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"

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
 *     `stop_reason`.
 *
 * Driving the INTERACTIVE TUI (real TTY) keeps model calls on the subscription
 * billing path (not `claude -p` / Agent SDK, which meter after 2026-06-15).
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

/** Claude encodes the absolute cwd into the transcript dir name by replacing
 *  EVERY non-alphanumeric char with `-` (no collapsing of runs). Verified on
 *  Windows against ~/.claude/projects, e.g.:
 *    C:\code\my-app    -> C--code-my-app
 *    C:\dev\My Project -> C--dev-My-Project   (the space also becomes `-`). */
export function encodeCwd(cwd: string): string {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-")
}

export interface TurnResult {
  text: string
  stopReason: string | null
  usage: any | null
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
}

const TERMINAL_STOP = new Set(["end_turn", "stop_sequence", "max_tokens"])
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function resolveConfigDir(configDir: string | undefined): string {
  const value = configDir ?? process.env.CLAUDE_CONFIG_DIR
  if (!value) return path.join(os.homedir(), ".claude")
  if (value === "~") return os.homedir()
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2))
  }
  return path.resolve(value)
}

export class ClaudeSession {
  readonly sessionId: string
  readonly cwd: string
  readonly configDir: string
  readonly jsonlPath: string
  raw = ""

  private proc: BunSubprocess | null = null
  private cursor = 0 // index into transcript split('\n')
  private lastDataAt = 0
  private exited = false
  private exitCode: number | null = null
  private aborted = false
  private readonly signal?: AbortSignal
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
    this.signal = opts.signal
    this.sessionId = randomUUID()
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
    }
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
    const claude = resolveClaude(this.o.cliPath ?? "claude")
    const args: string[] = ["--session-id", this.sessionId]
    if (this.o.model) args.push("--model", this.o.model)
    if (this.o.settingSources !== null && this.o.settingSources !== undefined) {
      args.push("--setting-sources", this.o.settingSources)
    }
    if (this.o.extraArgs && this.o.extraArgs.length) args.push(...this.o.extraArgs)

    if (this.o.debug)
      process.stderr.write(`[session] spawn: ${claude} ${args.join(" ")}\n`)

    this.lastDataAt = Date.now()
    this.proc = Bun.spawn([claude, ...args], {
      cwd: this.cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: this.o.configDir,
        TERM: "xterm-256color",
        ...(this.o.ignoreAnthropicApiKey
          ? { ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined }
          : {}),
        ...(this.o.effort ? { CLAUDE_CODE_EFFORT_LEVEL: this.o.effort } : {}),
      },
      terminal: {
        cols: this.o.cols,
        rows: this.o.rows,
        data: (_term, d) => {
          this.lastDataAt = Date.now()
          const chunk = Buffer.from(d).toString("utf8")
          this.raw += chunk
          if (this.o.debug) process.stdout.write(chunk)
        },
      },
    })
    this.proc.exited
      .then((code) => {
        this.exitCode = typeof code === "number" ? code : null
        this.exited = true
        this.proc = null
      })
      .catch(() => {
        this.exited = true
        this.proc = null
      })

    await this.waitForBoot()
    this.cursor = this.lineCount()
  }

  /** Wait until the TUI has been quiet for bootQuietMs (Ink ready), bounded by
   *  bootMinMs..bootMaxMs. */
  private async waitForBoot(): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < this.o.bootMaxMs) {
      await delay(150)
      if (this.aborted) throw new Error("aborted during boot")
      if (this.exited) {
        throw new Error(this.failureMessage("claude exited during boot", true))
      }
      const elapsed = Date.now() - start
      const sinceData = Date.now() - this.lastDataAt
      if (elapsed >= this.o.bootMinMs && sinceData >= this.o.bootQuietMs) return
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
    const clean = this.raw
      // Strip ANSI escape/control sequences before including terminal output in diagnostics.
      .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
      .replace(/\s+/g, " ")
      .trim()
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
   * Inject a turn into the live session and return the assistant reply once a
   * terminal stop_reason is observed in the transcript.
   */
  async ask(prompt: string, perTurnTimeoutMs?: number): Promise<TurnResult> {
    if (this.aborted) throw new Error("aborted")
    if (!this.proc || this.exited)
      throw new Error("session not started or already exited")
    const timeout = perTurnTimeoutMs ?? this.o.turnTimeoutMs
    const t0 = Date.now()

    // Inject. Bracketed paste keeps multi-line prompts from submitting early;
    // submitTurn() then presses Enter and confirms the turn was accepted,
    // resending Enter if the (collapsed) paste swallowed the first one.
    if (this.o.bracketedPaste) {
      this.proc.terminal.write("\x1b[200~" + prompt + "\x1b[201~")
    } else {
      this.proc.terminal.write(prompt)
    }
    await this.submitTurn()

    const collected: string[] = []
    let lastUsage: any = null
    let stopReason: string | null = null
    const deadline = Date.now() + timeout

    while (Date.now() < deadline) {
      await delay(this.o.pollMs)
      if (this.aborted) throw new Error("aborted mid-turn")
      const lines = this.readRawLines()
      const lastComplete = lines.length - 1 // exclusive bound; trailing/partial line skipped
      if (lastComplete <= this.cursor) {
        // Drain the transcript before reacting to exit: a final assistant record
        // can be flushed in the same tick the process exits.
        if (this.exited) throw new Error(this.failureMessage("claude exited mid-turn", true))
        continue
      }

      for (let i = this.cursor; i < lastComplete; i++) {
        const s = lines[i]
        if (!s || !s.trim()) continue
        let rec: any
        try {
          rec = JSON.parse(s)
        } catch {
          continue
        }
        if (rec.type === "assistant" && rec.message) {
          for (const b of rec.message.content ?? []) {
            if (b?.type === "text" && typeof b.text === "string")
              collected.push(b.text)
          }
          if (rec.message.usage) lastUsage = rec.message.usage
          if (
            rec.message.stop_reason &&
            TERMINAL_STOP.has(rec.message.stop_reason)
          ) {
            stopReason = rec.message.stop_reason
          }
        }
      }
      this.cursor = lastComplete
      if (stopReason) break
    }

    if (!stopReason) {
      throw new Error(
        this.failureMessage(
          `turn timed out after ${timeout}ms (no terminal assistant record; collected ${collected.length} text block(s))`,
        ),
      )
    }

    const u = lastUsage ?? {}
    return {
      text: collected.join("\n").trim(),
      stopReason,
      usage: lastUsage,
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
   * raw JSONL transcript line via onLine (verbatim) until a terminal
   * stop_reason. Returns the terminal stop_reason + the last assistant usage.
   * Used by the opencode plugin transport shim, which feeds these raw lines
   * into the existing stream-json line handler unchanged.
   */
  async tailTurn(
    prompt: string,
    onLine: (rawLine: string) => void,
    perTurnTimeoutMs?: number
  ): Promise<{ stopReason: string | null; usage: any | null }> {
    if (this.aborted) throw new Error("aborted")
    if (!this.proc || this.exited)
      throw new Error("session not started or already exited")
    const timeout = perTurnTimeoutMs ?? this.o.turnTimeoutMs

    if (this.o.bracketedPaste) {
      this.proc.terminal.write("\x1b[200~" + prompt + "\x1b[201~")
    } else {
      this.proc.terminal.write(prompt)
    }
    await this.submitTurn()

    let lastUsage: any = null
    let totalOutput = 0
    let stopReason: string | null = null
    const deadline = Date.now() + timeout

    while (Date.now() < deadline) {
      await delay(this.o.pollMs)
      if (this.aborted) throw new Error("aborted mid-turn")
      const lines = this.readRawLines()
      const lastComplete = lines.length - 1
      if (lastComplete <= this.cursor) {
        // Drain the transcript before reacting to exit: the terminal assistant
        // record can land in the same tick the process exits.
        if (this.exited) {
          throw new Error(this.failureMessage("claude exited mid-turn", true))
        }
        continue
      }
      for (let i = this.cursor; i < lastComplete; i++) {
        const s = lines[i]
        if (!s || !s.trim()) continue
        onLine(s)
        let rec: any
        try {
          rec = JSON.parse(s)
        } catch {
          continue
        }
        if (rec.type === "assistant" && rec.message) {
          if (rec.message.usage) {
            lastUsage = rec.message.usage
            totalOutput += rec.message.usage.output_tokens ?? 0
          }
          if (
            rec.message.stop_reason &&
            TERMINAL_STOP.has(rec.message.stop_reason)
          ) {
            stopReason = rec.message.stop_reason
          }
        }
      }
      this.cursor = lastComplete
      if (stopReason) break
    }

    // Context (input/cache) = the LAST record's full conversation state; output
    // = SUM across all assistant records this turn (each generation), else
    // multi-record tool turns undercount output. toUsage() prefers
    // iterations[last], so patch that entry's output too.
    let usage: any = lastUsage
    if (lastUsage) {
      usage = { ...lastUsage, output_tokens: totalOutput }
      if (Array.isArray(lastUsage.iterations) && lastUsage.iterations.length > 0) {
        const iters = lastUsage.iterations.map((it: any) => ({ ...it }))
        iters[iters.length - 1] = {
          ...iters[iters.length - 1],
          output_tokens: totalOutput,
        }
        usage.iterations = iters
      }
    }
    if (!stopReason) {
      throw new Error(
        this.failureMessage(
          `turn timed out after ${timeout}ms (no terminal assistant record)`,
        ),
      )
    }

    return { stopReason, usage }
  }

  dispose(): void {
    if (this.proc) {
      try {
        this.proc.terminal.write("\x03")
      } catch {}
      try {
        this.proc.kill()
      } catch {}
      try {
        this.proc.terminal.close()
      } catch {}
    }
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
