import { EventEmitter } from "node:events"
import { unlink } from "node:fs/promises"
import { ClaudeSession } from "./claude-session-bun.js"
import { cliEffortLevel, type ActiveProcess } from "./session-manager.js"
import type { ReasoningEffort } from "./types.js"
import { log } from "./logger.js"

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
  /** permissions.allow rules (e.g. mcp__server__*, Bash, Edit). */
  permissionsAllow?: string[]
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

/**
 * Adapt a ClaudeSession (interactive Bun ConPTY transport) to the ActiveProcess
 * contract the doStream line handler depends on. The shim's `proc.stdin.write`
 * injects a turn into the live interactive `claude` and re-emits each new JSONL
 * transcript record on `lineEmitter` as a 'line' event, plus a synthetic
 * `{type:'result'}` line on a terminal stop_reason so the existing finish branch
 * (usage + providerMetadata + controller.close) fires unchanged.
 *
 * No node-pty, no node sidecar: runs in-process under opencode's Bun (which
 * bundles a Bun version with native ConPTY). Interactive = subscription billing.
 */
/**
 * The CLI flags an interactive spawn adds after `ClaudeSession`'s own
 * `--session-id` / `--model` / `--setting-sources`. Exported so the spawn
 * arguments can be checked without a PTY.
 */
export function interactiveExtraArgs(opts: InteractiveSpawnOptions): string[] {
  const extraArgs: string[] = []
  if (opts.mcpConfigPaths && opts.mcpConfigPaths.length > 0) {
    extraArgs.push(
      "--mcp-config",
      ...opts.mcpConfigPaths,
      "--strict-mcp-config",
    )
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

export function spawnInteractiveProcess(
  opts: InteractiveSpawnOptions,
): ActiveProcess {
  const extraArgs = interactiveExtraArgs(opts)

  const session = new ClaudeSession({
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
  })
  log.info("prepared interactive claude session", {
    cwd: opts.cwd,
    cliPath: opts.cliPath ?? "claude",
    configDir: session.configDir,
    model: opts.model,
    effort: opts.effort,
    sessionId: session.sessionId,
    jsonlPath: session.jsonlPath,
  })

  const lineEmitter = new EventEmitter()
  const errorHandlers = new Set<(err: Error) => void>()
  let startPromise: Promise<void> | null = null

  const ensureStarted = (): Promise<void> => {
    if (!startPromise) startPromise = session.start()
    return startPromise
  }

  /**
   * Synthesize the terminal `result` frame in the shape a headless turn emits.
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
   * So the CLI NEVER encodes a stop reason in `subtype`: `subtype` stayed
   * `success` even on the failing turn, and the stop reason rides in a
   * TOP-LEVEL `stop_reason` field. Putting the stop reason in `subtype` (which
   * is what this did) made every completed interactive turn trip
   * `describeResultFailure` (h #g113), so it finished as
   * `{unified:"error"}` and `turnStats` was suppressed (h #g109).
   */
  const emitResult = (opts: {
    subtype: string
    isError: boolean
    stopReason: string | null
    terminalReason: string
    result?: string
    usage?: unknown
  }): void => {
    lineEmitter.emit(
      "line",
      JSON.stringify({
        type: "result",
        subtype: opts.subtype,
        is_error: opts.isError,
        stop_reason: opts.stopReason,
        terminal_reason: opts.terminalReason,
        result: opts.result,
        session_id: session.sessionId,
        usage: opts.usage ?? {},
        total_cost_usd: null,
        duration_ms: 0,
      }),
    )
  }

  const runTurn = (userMsg: string): void => {
    void (async () => {
      try {
        await ensureStarted()
        const { stopReason, usage, lastCallUsage, callCount } =
          await session.tailTurn(userMsg, (raw) => {
            lineEmitter.emit("line", raw)
          })
        // The synthesized `result` below carries the TURN totals, as a
        // headless one does, so `turnStats` matches the bill. The finish's
        // own usage is narrowed to the last call's context by
        // `lastCallContextUsage`, off the same `assistant` records the line
        // handler already saw. Logged because the two differ on every
        // multi-call turn and only the log says by how much.
        log.info("interactive turn usage", {
          apiCalls: callCount,
          turnOutputTokens: usage?.output_tokens,
          turnInputTokens: usage?.input_tokens,
          turnCacheReadTokens: usage?.cache_read_input_tokens,
          lastCallInputTokens: lastCallUsage?.input_tokens,
          lastCallCacheReadTokens: lastCallUsage?.cache_read_input_tokens,
          lastCallCacheWriteTokens: lastCallUsage?.cache_creation_input_tokens,
        })
        // Synthesize the `result` line the headless transport would have
        // emitted, so doStream's existing finish branch runs verbatim. A turn
        // with no terminal stop_reason (turn timeout / session exit mid-turn)
        // is still reported HONESTLY as an error result, so truncation stays
        // visible to the user and to auto-continue.
        //
        // `max_tokens` is deliberately NOT an error here. It is a terminal
        // stop_reason, so the turn did complete an API call and did bill, and
        // the headless CLI reports the same situation with `is_error:false`.
        // Marking it an error would suppress `turnStats` on a turn that cost
        // money, and would skip the auto-continue nudge that is the one
        // handling truncation deserves: `shouldDeferResult` in the stream
        // parser requires `!msg.is_error`, and `isTruncationStopReason`
        // (h #g104) reads the assistant record's own `stop_reason`, which
        // `tailTurn` already forwards verbatim.
        const timedOut = !stopReason
        emitResult({
          subtype: timedOut ? "error_during_execution" : "success",
          isError: timedOut,
          stopReason: timedOut ? null : stopReason,
          terminalReason: timedOut ? "error_during_execution" : "completed",
          result: timedOut
            ? "Interactive transport: the turn ended without a terminal stop_reason (turn timeout or claude exit). Output above may be incomplete."
            : undefined,
          usage,
        })
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        log.error("interactive turn failed", { error: e.message })
        emitResult({
          subtype: "error_during_execution",
          isError: true,
          stopReason: null,
          terminalReason: "error_during_execution",
          result: `Interactive transport failed: ${e.message}`,
        })
        if (errorHandlers.size > 0) {
          for (const h of errorHandlers) h(e)
        } else {
          lineEmitter.emit("close")
        }
      }
    })()
  }

  // Minimal ChildProcess-shaped shim: only the members doStream/session-manager
  // actually touch (stdin.write, on/off 'error', kill).
  const proc: any = {
    stdin: {
      write(chunk: string): boolean {
        const raw =
          typeof chunk === "string" && chunk.endsWith("\n")
            ? chunk.slice(0, -1)
            : chunk
        // doStream writes stream-json envelopes; the TUI needs plain text.
        runTurn(decodeUserEnvelope(raw))
        return true
      },
      end(): void {},
    },
    stdout: null,
    stderr: null,
    pid: -1,
    killed: false,
    on(event: string, fn: (err: Error) => void): unknown {
      if (event === "error") errorHandlers.add(fn)
      return proc
    },
    once(): unknown {
      return proc
    },
    off(event: string, fn: (err: Error) => void): unknown {
      if (event === "error") errorHandlers.delete(fn)
      return proc
    },
    kill(): boolean {
      try {
        session.dispose()
      } catch {}
      if (opts.systemPromptFile) {
        void unlink(opts.systemPromptFile).catch(() => {})
      }
      proc.killed = true
      return true
    },
  }

  return {
    proc: proc as unknown as ActiveProcess["proc"],
    lineEmitter,
    proxyServer: null,
    mcpHash: undefined,
    systemPromptFile: opts.systemPromptFile,
  }
}
