import { EventEmitter } from "node:events"
import { existsSync } from "node:fs"
import { unlink } from "node:fs/promises"
import {
  ClaudeSession,
  type ClaudeSessionOptions,
  type PlanApprovalAnswer,
  type PtySpawner,
  type TurnEnd,
} from "./claude-session-bun.js"
import { bufferUnattendedLine, cliEffortLevel, type ActiveProcess } from "./session-manager.js"
import type { ProxyMcpServer } from "./proxy-mcp.js"
import type { ReasoningEffort } from "./types.js"
import { log } from "./logger.js"
import { REJECTED_EXIT_PLAN_MODE_PREFIX } from "./plan-mode-question.js"

export interface InteractiveSpawnOptions {
  cwd: string
  /** Claude CLI executable or account wrapper path. */
  cliPath?: string
  /** Claude config root used for JSONL transcripts. */
  configDir?: string
  model?: string
  /** Request Claude Code's fast mode (Opus 4.8 / 5 / 5.5 only). Folded into
   *  the single `--settings` payload alongside `permissions`. */
  fastMode?: boolean
  /** Bridged Claude `--mcp-config` file paths (from effectiveMcpConfig). */
  mcpConfigPaths?: string[]
  /** Session-scoped `--plugin-dir` paths (from `resolveSkillPluginDirs`),
   *  which expose opencode skills to the TUI's native Skill tool. Already
   *  filtered for CLI support, and empty when there is nothing to bridge. */
  pluginDirs?: string[]
  /** Native tools the proxy serves instead (`--disallowedTools`), so a call
   *  reaches opencode, its permission prompt and its UI, as on headless. */
  disallowedTools?: string[]
  /** Explicit native tool set. An empty list disables tools for compaction. */
  tools?: string[]
  /** The proxy MCP server this session's `--mcp-config` points at. Owned by
   *  the session from here: closed when its TUI exits. */
  proxyServer?: ProxyMcpServer | null
  /** permissions.allow rules (e.g. mcp__server__*, Bash, Edit). */
  permissionsAllow?: string[]
  /** `--restricted`, for the read-only preset (`interactivePermissionPosture`). */
  restricted?: boolean
  /** Optional permission mode. `bypassPermissions` is ignored for interactive
   *  sessions because Claude Code shows a safety confirmation screen first. */
  permissionMode?: string
  /** Temp file for --append-system-prompt-file (parity with the headless
   *  spawn; unlinked when the session is killed). */
  systemPromptFile?: string
  /** "" = skip CLAUDE.md + ambient settings (fast e2e); null/undefined =
   *  normal settings (default — parity with the headless transport). */
  settingSources?: string | null
  /** Strip ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN from the spawn env so the
   *  CLI uses subscription auth instead of pay-as-you-go API billing. */
  ignoreAnthropicApiKey?: boolean
  /** Reasoning effort, exported as CLAUDE_CODE_EFFORT_LEVEL for the session. */
  effort?: ReasoningEffort
  /** Continue this Claude session with `--resume` instead of starting a new
   *  one, which is what keeps a conversation whose TUI died or was evicted
   *  from starting over empty. */
  resumeSessionId?: string
  /** The child environment, normally the headless spawn's (`claudeSpawnEnv`)
   *  so both transports carry the same hygiene, effort and cache TTL. */
  env?: Record<string, string | undefined>
  /** PTY seam for tests. */
  spawnPty?: PtySpawner
  /** Timing overrides, for tests that cannot wait out production delays. */
  tuning?: Pick<
    ClaudeSessionOptions,
    | "bootMinMs"
    | "bootQuietMs"
    | "pollMs"
    | "submitMinMs"
    | "submitConfirmMs"
    | "stopSettleMs"
    | "heartbeatMs"
    | "interruptGraceMs"
    | "permissionQuietMs"
  >
}

/**
 * doStream writes stream-json user envelopes to stdin
 * (`{"type":"user","message":{content:[...]}}`). The interactive TUI expects
 * plain typed text, so decode the envelope: extract the text blocks and drop
 * anything that can't be typed into a terminal (an image block would paste
 * megabytes of base64 into the chat). Tool results are rendered as labeled
 * text so the model still sees the outcome. Non-envelope input (already plain
 * text) passes through verbatim.
 */
export function decodeUserEnvelope(chunk: string): string {
  let parsed: any
  try {
    parsed = JSON.parse(chunk)
  } catch {
    return chunk
  }
  if (!parsed || parsed.type !== "user" || !parsed.message) return chunk
  const content = parsed.message.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return chunk

  const parts: string[] = []
  let dropped = 0
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text)
    } else if (block?.type === "tool_result") {
      const v = block.content
      const text =
        typeof v === "string"
          ? v
          : Array.isArray(v)
            ? v
                .map((i: any) => (i?.type === "text" ? i.text : ""))
                .filter(Boolean)
                .join("\n")
            : ""
      parts.push(
        `[Tool result${block.tool_use_id ? ` ${block.tool_use_id}` : ""}]\n${text}`,
      )
    } else {
      dropped++
    }
  }
  if (dropped > 0) {
    log.warn("interactive transport dropped non-text content blocks", {
      dropped,
    })
  }
  return parts.join("\n\n")
}


const APPROVAL_WORDS =
  /^(?:y|yes|yep|yeah|ok|okay|sure|approve|approved|proceed|go|go ahead|do it|lgtm)[.!\s]*$/i
const HOST_ANNOTATIONS =
  /<(?:dcp-)?system-reminder>[\s\S]*?<\/(?:dcp-)?system-reminder>|<dcp-message-id>[^<]*<\/dcp-message-id>/g

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((item: any) => (item?.type === "text" && typeof item.text === "string" ? item.text : ""))
    .join("\n")
}

/**
 * The operator's decision, out of the message written while the TUI is parked
 * on a plan approval (h #g201). With the `planModeQuestion` bridge it is the
 * `tool_result` envelope `consumeExitPlanModeQuestionResult` builds for this
 * `ExitPlanMode` call; without it, it is whatever the operator typed next,
 * which is approval only when it says nothing but yes. Anything else is what
 * Claude is told to change. opencode's reminders and opencode-dcp's id tag are
 * the host's, never the operator's words.
 */
export function planApprovalAnswer(raw: string, toolUseId: string): PlanApprovalAnswer {
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {}
  const content = parsed?.type === "user" ? parsed.message?.content : undefined
  if (Array.isArray(content)) {
    const result = content.find(
      (block: any) => block?.type === "tool_result" && block.tool_use_id === toolUseId,
    )
    if (result) {
      if (result.is_error !== true) return { approved: true }
      const text = toolResultText(result.content)
      const feedback = text.startsWith(REJECTED_EXIT_PLAN_MODE_PREFIX)
        ? text.slice(REJECTED_EXIT_PLAN_MODE_PREFIX.length)
        : text
      return { approved: false, feedback: feedback.trim() || "no" }
    }
  }
  const typed = decodeUserEnvelope(raw).replace(HOST_ANNOTATIONS, "").trim()
  return APPROVAL_WORDS.test(typed) ? { approved: true } : { approved: false, feedback: typed || "no" }
}

/**
 * The CLI flags an interactive spawn adds after `ClaudeSession`'s own
 * `--session-id` (or `--resume`) / `--model` / `--setting-sources`. Exported
 * so the spawn arguments can be checked without a PTY.
 */
export function interactiveExtraArgs(opts: InteractiveSpawnOptions): string[] {
  const extraArgs: string[] = []
  if (opts.tools) extraArgs.push("--tools", opts.tools.join(","))
  if (opts.restricted) extraArgs.push("--restricted")
  if (opts.mcpConfigPaths && opts.mcpConfigPaths.length > 0) {
    extraArgs.push(
      "--mcp-config",
      ...opts.mcpConfigPaths,
      "--strict-mcp-config",
    )
  }
  // Variadic, like `--mcp-config`: one flag, every name after it.
  if (opts.disallowedTools && opts.disallowedTools.length > 0) {
    extraArgs.push("--disallowedTools", ...opts.disallowedTools)
  }
  // `--plugin-dir` is repeatable and scoped to this session only.
  for (const dir of opts.pluginDirs ?? []) {
    extraArgs.push("--plugin-dir", dir)
  }
  // One `--settings` for the whole flag-settings layer. The CLI accepts the
  // flag once, so pushing a second occurrence would silently drop the first
  // rather than merge it.
  const flagSettings: Record<string, unknown> = {}
  if (opts.permissionsAllow && opts.permissionsAllow.length > 0) {
    flagSettings.permissions = { allow: opts.permissionsAllow }
  }
  if (opts.fastMode) {
    flagSettings.fastMode = true
  }
  if (Object.keys(flagSettings).length > 0) {
    extraArgs.push("--settings", JSON.stringify(flagSettings))
  }
  if (opts.permissionMode === "bypassPermissions") {
    log.warn(
      "interactive permissionMode bypassPermissions ignored: Claude Code prompts for confirmation in the TUI",
    )
  } else if (opts.permissionMode) {
    extraArgs.push("--permission-mode", opts.permissionMode)
  }
  if (opts.systemPromptFile) {
    extraArgs.push("--append-system-prompt-file", opts.systemPromptFile)
  }
  return extraArgs
}

/**
 * Tool calls the TUI started and has not answered yet, read off the
 * transcript records the turn forwards. The heartbeat names the newest one,
 * the way the headless CLI's own `tool_progress` frame does.
 */
export class OpenToolCalls {
  private readonly open = new Map<string, { name: string; startedAt: number }>()

  add(rec: any, now = Date.now()): void {
    const content = rec?.message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (rec.type === "assistant" && block?.type === "tool_use" && typeof block.id === "string") {
        this.open.set(block.id, { name: String(block.name ?? "tool"), startedAt: now })
      } else if (rec.type === "user" && block?.type === "tool_result") {
        this.open.delete(block.tool_use_id)
      }
    }
  }

  newest(): { id: string; name: string; startedAt: number } | null {
    let newest: { id: string; name: string; startedAt: number } | null = null
    for (const [id, call] of this.open) newest = { id, ...call }
    return newest
  }

  clear(): void {
    this.open.clear()
  }
}

/**
 * The frame a heartbeat emits. The line handler resets the wire-inactivity
 * watchdog on every line, so what matters is that it is a line the parser
 * reads without acting on: a `tool_progress` (logged, h #g184) while a tool
 * is open, otherwise a `system`/`status` (deliberately unparsed, h #g191).
 */
export function heartbeatFrame(
  sessionId: string,
  openCall: { id: string; name: string; startedAt: number } | null,
  now = Date.now(),
): string {
  if (openCall) {
    // The headless heartbeat's own id is synthetic and the call is in
    // `parent_tool_use_id` (`parseToolProgress`); this follows that shape.
    return JSON.stringify({
      type: "tool_progress",
      tool_use_id: `${openCall.id}-heartbeat`,
      tool_name: openCall.name,
      parent_tool_use_id: openCall.id,
      heartbeat: true,
      elapsed_time_seconds: Math.round((now - openCall.startedAt) / 1000),
      session_id: sessionId,
    })
  }
  return JSON.stringify({
    type: "system",
    subtype: "status",
    status: "requesting",
    session_id: sessionId,
  })
}

/**
 * The terminal `result` frame for an interactive turn, in the shape a
 * headless turn emits.
 *
 * Measured verbatim on Claude Code 2.1.280 (`claude -p ... --output-format
 * stream-json --verbose`), both for a clean reply and for a turn the CLI
 * failed on its own max-output-tokens guard:
 *
 *   clean:  "stop_reason":"end_turn",    ... "terminal_reason":"completed",
 *           "is_error":false, "subtype":"success"
 *   failed: "stop_reason":"stop_sequence", ... "terminal_reason":"api_error",
 *           "is_error":true,  "subtype":"success"
 *
 * So the CLI NEVER encodes a stop reason in `subtype`: it stays `success` and
 * the stop reason rides in a TOP-LEVEL `stop_reason` field. Putting the stop
 * reason in `subtype` made every completed interactive turn trip
 * `describeResultFailure` (h #g113), finish as `{unified:"error"}` and
 * suppress `turnStats` (h #g109).
 *
 * `max_tokens` is deliberately NOT an error: the call completed and billed,
 * the headless CLI says `is_error:false`, and an error would skip both
 * `turnStats` and the auto-continue nudge (`shouldDeferResult` needs
 * `!msg.is_error`; `isTruncationStopReason`, h #g104, reads the assistant
 * record's own `stop_reason`, which the turn already forwarded).
 *
 * A turn that ended without a terminal stop (an interrupt, a `turn_duration`
 * with no reply, a denied permission dialog that ended it) is reported
 * honestly as an error, so a cut-short answer never reads as a finished one.
 */
/** One `permission_denials` entry, as the headless `result` carries them. */
export interface PermissionDenial {
  tool_name: string
  tool_use_id?: string
}

export function interactiveResultFrame(opts: {
  /** Omitted when the conversation was never written, so the next spawn
   *  does not `--resume` a session the CLI has no transcript for. */
  sessionId?: string
  end: TurnEnd | "failed"
  stopReason: string | null
  usage?: unknown
  denials?: PermissionDenial[]
  error?: string
}): string {
  const completed = opts.end === "stop" && !!opts.stopReason
  let result: string | undefined
  let terminalReason = "completed"
  if (!completed) {
    if (opts.end === "failed") {
      terminalReason = "error_during_execution"
      result = `Interactive transport failed: ${opts.error ?? "unknown error"}`
    } else if (opts.end === "interrupted") {
      terminalReason = "aborted"
      result = "Interactive transport: the turn was interrupted."
    } else {
      terminalReason = "error_during_execution"
      result =
        "Interactive transport: the turn ended without a terminal stop_reason. Output above may be incomplete."
    }
  }
  return JSON.stringify({
    type: "result",
    subtype: completed ? "success" : "error_during_execution",
    is_error: !completed,
    stop_reason: completed ? opts.stopReason : null,
    terminal_reason: terminalReason,
    result,
    session_id: opts.sessionId,
    usage: opts.usage ?? {},
    // The TUI has no `can_use_tool` channel, so a permission dialog is the
    // only way it asks; each one the session denied is reported in the
    // headless field's place, names and ids only (h #g109).
    permission_denials: opts.denials ?? [],
    total_cost_usd: null,
    duration_ms: 0,
  })
}

/**
 * True for a transcript record a detached turn would lose something by
 * dropping: an assistant record with reply text. The TUI also writes
 * bookkeeping records (attachments, snapshots, hook summaries) the whole time
 * it waits on a proxied call, and keeping those would lead every proxied step
 * with an empty "between turns" note.
 */
export function carriesReplyText(line: string): boolean {
  try {
    const rec = JSON.parse(line)
    if (rec?.type !== "assistant" || !Array.isArray(rec.message?.content)) return false
    return rec.message.content.some(
      (block: any) => block?.type === "text" && typeof block.text === "string" && block.text.trim(),
    )
  } catch {
    return false
  }
}

/**
 * Adapt a ClaudeSession (interactive Bun PTY transport) to the ActiveProcess
 * contract the doStream line handler depends on. The shim's `proc.stdin.write`
 * injects a turn into the live interactive `claude` and re-emits each new JSONL
 * transcript record on `lineEmitter` as a 'line' event, then a synthesized
 * `{type:'result'}` line (`interactiveResultFrame`) so the existing finish
 * branch (usage + providerMetadata + controller.close) fires unchanged.
 *
 * What makes it behave like a headless child to the rest of the plugin:
 *   - `exitCode` / `signalCode` and real `exit` / `close` events, so
 *     `deleteActiveProcessAndWait` and the close handler see the child die,
 *   - `interactiveControl`, so an abort stops the turn with Esc
 *     (`interruptTurn`) and keeps the session for the next message,
 *   - turns run one at a time in write order, and a turn's `result` is dropped
 *     once a newer write superseded it, so an interrupted turn's late result
 *     can never close the next turn's stream,
 *   - a heartbeat line while the TUI is visibly working and the transcript is
 *     quiet, which is what the headless CLI's `tool_progress` does.
 */
export function spawnInteractiveProcess(
  opts: InteractiveSpawnOptions,
): ActiveProcess {
  const extraArgs = interactiveExtraArgs(opts)
  const openCalls = new OpenToolCalls()
  let denials: PermissionDenial[] = []
  const lineEmitter = new EventEmitter()
  // A plain emitter is what `ChildProcess` is to its listeners. `error` is
  // emitted only when someone listens, because an unheard `error` throws.
  const proc: any = new EventEmitter()
  // Filled in below; `emit` and the exit hook only run once it is.
  let ap!: ActiveProcess
  let proxyClosed = false
  const closeProxyServer = () => {
    if (proxyClosed || !opts.proxyServer) return
    proxyClosed = true
    void opts.proxyServer.close()
  }

  const session = new ClaudeSession({
    ...opts.tuning,
    cwd: opts.cwd,
    cliPath: opts.cliPath,
    configDir: opts.configDir,
    model: opts.model,
    // Default null = normal CLAUDE.md + settings load, matching what the
    // headless spawn does. "" (skip everything) is for fast e2e runs only.
    settingSources:
      opts.settingSources === undefined ? null : opts.settingSources,
    extraArgs,
    ignoreAnthropicApiKey: opts.ignoreAnthropicApiKey,
    effort: opts.effort ? cliEffortLevel(opts.effort) : undefined,
    resumeSessionId: opts.resumeSessionId,
    env: opts.env,
    spawnPty: opts.spawnPty,
    onScreen: (event) => {
      if (event.action === "denied") {
        // The dialog is about the call the TUI is holding, which is the
        // newest one the transcript opened and has not answered.
        const call = openCalls.newest()
        denials.push(call ? { tool_name: call.name, tool_use_id: call.id } : { tool_name: "unknown" })
      }
      const data = { sessionId: session.sessionId, screen: event.kind, detail: event.detail }
      if (event.action === "accepted") log.info("interactive transport accepted a prompt", data)
      else if (event.action === "fatal") log.error("interactive transport cannot continue", data)
      else if (event.action === "denied") log.warn("interactive transport denied a permission prompt", data)
      else if (event.action === "parked") log.info("interactive transport is waiting on a plan approval", data)
      else log.warn("interactive transport cancelled the usage-limit auto-continue", data)
    },
    onExit: (code) => {
      // A child we killed reads as signalled; one that died on its own with
      // no code does too, so `hasProcessExited` never mistakes it for alive.
      proc.exitCode = code
      proc.signalCode = code === null ? "SIGTERM" : null
      // Same as a headless child's exit handler: the server dies with the
      // process it was serving, whoever owns the session key by now.
      closeProxyServer()
      log.info("interactive claude exited", { sessionId: session.sessionId, code })
      proc.emit("exit", proc.exitCode, proc.signalCode)
      proc.emit("close", proc.exitCode, proc.signalCode)
    },
  })
  log.info("prepared interactive claude session", {
    cwd: opts.cwd,
    cliPath: opts.cliPath ?? "claude",
    configDir: session.configDir,
    model: opts.model,
    effort: opts.effort,
    sessionId: session.sessionId,
    resumed: !!opts.resumeSessionId,
    jsonlPath: session.jsonlPath,
  })

  let startPromise: Promise<void> | null = null
  const ensureStarted = (): Promise<void> => {
    if (!startPromise) startPromise = session.start()
    return startPromise
  }

  /** Bumped by every write; a turn whose number is stale has been superseded. */
  let writes = 0
  /** Every turn up to this write number was interrupted, run or queued. */
  let cancelledThrough = 0
  /** Turns waiting for, or holding, the session. */
  let queued = 0
  let chain: Promise<void> = Promise.resolve()

  const runTurn = async (userMsg: string, turnNumber: number): Promise<void> => {
    const current = () => turnNumber === writes
    const emit = (line: string) => {
      if (!current()) return
      // Between the steps of one turn (a proxied call ends the step, and the
      // next step attaches when opencode sends the result) nobody listens.
      // Kept exactly as a headless child's stdout is, and shown by the next
      // turn rather than lost (h #g189).
      if (lineEmitter.listenerCount("line") === 0) {
        if (carriesReplyText(line)) bufferUnattendedLine(ap, line)
        return
      }
      lineEmitter.emit("line", line)
    }
    try {
      await ensureStarted()
      if (turnNumber <= cancelledThrough) {
        log.info("interactive turn cancelled before it started", { sessionId: session.sessionId })
        return
      }
      openCalls.clear()
      denials = []
      const { stopReason, end, usage, lastCallUsage, callCount, denied } =
        await session.tailTurn(
          userMsg,
          (raw) => {
            try {
              openCalls.add(JSON.parse(raw))
            } catch {}
            emit(raw)
          },
          undefined,
          // Only to a listening turn: it feeds that turn's watchdog, and the
          // TUI redraws its spinner the whole time it waits on a proxied call.
          () => {
            if (lineEmitter.listenerCount("line") > 0) {
              emit(heartbeatFrame(session.sessionId, openCalls.newest()))
            }
          },
        )
      // The `result` carries the TURN totals, as a headless one does, so
      // `turnStats` matches the bill; the finish narrows to the last call
      // through `lastCallContextUsage` off the records already forwarded.
      log.info("interactive turn ended", {
        end,
        stopReason,
        superseded: !current(),
        apiCalls: callCount,
        turnOutputTokens: usage?.output_tokens,
        turnInputTokens: usage?.input_tokens,
        turnCacheReadTokens: usage?.cache_read_input_tokens,
        lastCallInputTokens: lastCallUsage?.input_tokens,
        lastCallCacheReadTokens: lastCallUsage?.cache_read_input_tokens,
        lastCallCacheWriteTokens: lastCallUsage?.cache_creation_input_tokens,
        deniedPrompts: denied.length,
        cancelled: turnNumber <= cancelledThrough,
      })
      emit(
        interactiveResultFrame({
          sessionId: session.sessionId,
          end,
          stopReason,
          usage,
          denials,
        }),
      )
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      log.error("interactive turn failed", { error: e.message, superseded: !current() })
      if (!current()) return
      emit(
        interactiveResultFrame({
          sessionId: existsSync(session.jsonlPath) ? session.sessionId : undefined,
          end: "failed",
          stopReason: null,
          error: e.message,
        }),
      )
      if (proc.listenerCount("error") > 0) proc.emit("error", e)
      else lineEmitter.emit("close")
    }
  }

  // The answer continues the parked turn: no write number is taken, so that
  // turn stays current and its records reach whichever turn now listens. A
  // dialog that cannot be answered is not left to wait out the turn timeout.
  const answerPlan = async (answer: PlanApprovalAnswer): Promise<void> => {
    log.info("interactive transport answering a plan approval", {
      sessionId: session.sessionId,
      approved: answer.approved,
    })
    const answered = await session.answerPlanApproval(answer).catch(() => false)
    if (answered) return
    log.warn("interactive transport could not answer the plan approval; stopping the turn", {
      sessionId: session.sessionId,
    })
    cancelledThrough = writes
    await session.interrupt().catch(() => false)
  }

  const enqueueTurn = (userMsg: string): void => {
    const turnNumber = ++writes
    queued++
    chain = chain
      .then(() => runTurn(userMsg, turnNumber))
      .finally(() => {
        queued--
      })
  }

  Object.assign(proc, {
    stdin: {
      writable: true,
      write(chunk: string): boolean {
        const raw =
          typeof chunk === "string" && chunk.endsWith("\n")
            ? chunk.slice(0, -1)
            : chunk
        // While the TUI is parked on a plan approval, what is written is the
        // decision on it, not a new turn (h #g201).
        const planToolUseId = session.pendingPlanApproval
        if (planToolUseId) {
          void answerPlan(planApprovalAnswer(raw, planToolUseId))
          return true
        }
        // doStream writes stream-json envelopes; the TUI needs plain text.
        enqueueTurn(decodeUserEnvelope(raw))
        return true
      },
      end(): void {},
    },
    stdout: null,
    stderr: null,
    pid: -1,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill(): boolean {
      if (!proc.killed) {
        proc.killed = true
        if (opts.systemPromptFile) {
          void unlink(opts.systemPromptFile).catch(() => {})
        }
      }
      closeProxyServer()
      const started = startPromise !== null
      try {
        session.dispose()
      } catch {}
      // Never started: there is no child to report an exit, so report it
      // here, once, or a caller waiting for `exit` waits out its timeout.
      if (!started && proc.exitCode === null && proc.signalCode === null) {
        proc.signalCode = "SIGTERM"
        proc.emit("exit", null, "SIGTERM")
        proc.emit("close", null, "SIGTERM")
      }
      return true
    },
  })

  ap = {
    proc: proc as ActiveProcess["proc"],
    lineEmitter,
    proxyServer: opts.proxyServer ?? null,
    mcpHash: undefined,
    unattendedLines: [],
    unattendedDropped: 0,
    systemPromptFile: opts.systemPromptFile,
    cliPath: opts.cliPath,
    interactiveControl: {
      turnRunning: () => queued > 0,
      // Stops the running turn and every queued one: they were all written
      // by the turn being aborted, or by one before it.
      interrupt: (timeoutMs: number) => {
        cancelledThrough = writes
        return session.interrupt(timeoutMs)
      },
      flushTranscript: () => session.flushTranscript(),
      planApprovalPending: () => session.pendingPlanApproval !== null,
    },
  }
  return ap
}
