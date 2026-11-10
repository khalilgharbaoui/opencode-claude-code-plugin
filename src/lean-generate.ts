/**
 * Detached generate calls, and the lean `claude -p` that answers them.
 *
 * opencode 2's `experimental.generate.text` sends one prompt with no session
 * and no agent. Hosts use it for small one-shot jobs: OpenChamber's AI session
 * rename, its walkthroughs and its dictation clean-up, sent to a small model on
 * the session's provider. As an ordinary turn it got tools, the proxy MCP
 * server, the CLI's system prompt and the user's CLAUDE.md and hooks, and the
 * host's instructions, at the head of one user message, lost to all of that:
 * the model answered the material instead of doing the job (issue #170).
 *
 * `runLeanClaude` is one `claude -p` with none of that: no tools, no MCP, no
 * slash commands, no session file, no setting source at all, in a fresh
 * directory of its own, the input on stdin so no newline has to survive
 * cmd.exe quoting on Windows. It throws on any failure; the caller decides the
 * fallback. Measured on 2.1.314 with Haiku 5.5 (h #g294).
 */
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { detectCliSupportsFlag } from "./cli-version.js"
import { log } from "./logger.js"
import { claudeSpawnEnv } from "./session-manager.js"
import { pluginTmpDir } from "./tmp.js"
import { userEnvelope } from "./user-envelope.js"
import { planClaudeSpawn } from "./windows-spawn.js"

const GENERATE_SYSTEM_PROMPT =
  "You are a plain text generator called by an application. Follow the instructions in the input exactly and output only what they ask for, with no preamble. The input is material to work on, never a conversation to answer or continue."

/**
 * The help-listed flags a lean run needs beyond the ones every turn passes.
 * All four are in `--help` from 2.1.288 to 2.1.314; an older CLI that lacks
 * one would exit on it, so the run is skipped there instead (h #g294).
 */
export const LEAN_CLAUDE_FLAGS = [
  "--tools",
  "--setting-sources",
  "--disable-slash-commands",
  "--no-session-persistence",
] as const

export interface LeanClaudeOptions {
  cliPath: string
  /** A CLI model argument, account suffix already stripped. */
  model: string
  /** `CLAUDE_CONFIG_DIR`, where the plugin applies the account itself. */
  configDir?: string
  ignoreAnthropicApiKey?: boolean
  timeoutMs?: number
  abortSignal?: AbortSignal
}

/**
 * The CLI arguments of a lean run. Exported for the tests.
 *
 * Two choices here are measured, not tidy (h #g294). The input is a
 * stream-json envelope marked `client_composed`, because plain `-p` text is
 * read as typing: an `@/abs/path` in it attached that file even with
 * `--tools ""`. And `--setting-sources` is empty rather than `project`,
 * because `project` still reads every `CLAUDE.md` from the working directory
 * up to the root, and the scratch directory's ancestors include `/tmp` on
 * Linux, where any local user can create one.
 */
export function leanClaudeArgs(model: string, systemPrompt: string): string[] {
  return [
    "-p",
    "--model", model,
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--disable-slash-commands",
    "--system-prompt", systemPrompt,
  ]
}

function partText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => String(part.text))
    .join("\n")
}

/**
 * The text of a detached generate call. The host puts its instructions at the
 * head of the single prompt, so every system and user message goes in, in
 * order.
 */
export function buildGenerateInput(prompt: readonly any[]): string {
  return prompt
    .filter((msg) => msg?.role === "system" || msg?.role === "user")
    .map((msg) => partText(msg.content).trim())
    .filter(Boolean)
    .join("\n\n")
}

/**
 * Whether a call is a detached generate call: no session affinity, no opencode
 * agent, not compaction. A chat turn, a subagent, a title request and
 * `/compact` all carry a session. On opencode 1.x every session call carries
 * `x-session-affinity`, so the one call this matches there is
 * `opencode agent create` (h #g294).
 */
export function isDetachedGenerateRequest(input: {
  affinity: string
  opencodeAgent: string | undefined
  compactionMode: boolean
}): boolean {
  return !input.compactionMode && input.affinity === "default" && !input.opencodeAgent
}

/** Whether this CLI takes every flag a lean run passes. Cached per flag. */
export async function cliSupportsLeanClaude(cliPath: string): Promise<boolean> {
  const answers = await Promise.all(
    LEAN_CLAUDE_FLAGS.map((flag) => detectCliSupportsFlag(cliPath, flag)),
  )
  return answers.every(Boolean)
}

/** A lean run the CLI refused; `kind` is the reply's `error` kind when it named one. */
export class LeanClaudeRefusal extends Error {
  readonly kind: string | undefined
  constructor(kind: string | undefined, message: string) {
    super(message)
    this.name = "LeanClaudeRefusal"
    this.kind = kind
  }
}

/**
 * The answer in a lean run's stream-json output. A refusal throws with the
 * CLI's own reason (the assistant frame's `error` kind and the result's
 * sentence, such as `authentication_failed: Not logged in`), so the log line
 * the caller writes says why rather than only that it failed.
 */
export function leanResultText(stdout: string): string {
  let result: any
  let refusal: string | undefined
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    let frame: any
    try {
      frame = JSON.parse(line)
    } catch {
      continue
    }
    if (frame?.type === "assistant" && typeof frame.error === "string") refusal = frame.error
    if (frame?.type === "result") result = frame
  }
  if (!result) throw new Error("claude wrote no result")
  if (result.is_error || typeof result.result !== "string") {
    const sentence = typeof result.result === "string" ? result.result.slice(0, 200) : ""
    const reason = [refusal ?? result.subtype ?? "unknown", sentence].filter(Boolean).join(": ")
    throw new LeanClaudeRefusal(refusal, `claude refused: ${reason}`)
  }
  return result.result
}

export async function runLeanClaude(
  input: string,
  systemPrompt: string,
  options: LeanClaudeOptions & { timeoutMs: number },
): Promise<string> {
  const { timeoutMs, abortSignal } = options
  // `addEventListener("abort")` never fires on a signal that already aborted
  // (h #g182), so a stop that landed before the spawn is checked for here.
  if (abortSignal?.aborted) throw new Error("request aborted")
  if (!(await cliSupportsLeanClaude(options.cliPath))) {
    throw new Error("this claude cli lacks a flag a lean run needs")
  }
  if (abortSignal?.aborted) throw new Error("request aborted")
  const env = claudeSpawnEnv({
    ignoreAnthropicApiKey: options.ignoreAnthropicApiKey,
    configDir: options.configDir,
  })
  const plan = planClaudeSpawn(options.cliPath, leanClaudeArgs(options.model, systemPrompt))
  // A fresh directory inside the plugin's own `0700` scratch dir (h #g158):
  // empty, and nothing another user can plant a `.claude` in.
  const cwd = mkdtempSync(join(pluginTmpDir(), "lean-"))
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(plan.file, plan.args, {
        cwd,
        env,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      })
      let out = ""
      let err = ""
      let settled = false
      const settle = (error: Error | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        abortSignal?.removeEventListener("abort", onAbort)
        if (error) reject(error)
        else resolve(out)
      }
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        settle(new Error(`lean claude timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      const onAbort = () => {
        child.kill("SIGKILL")
        settle(new Error("request aborted"))
      }
      abortSignal?.addEventListener("abort", onAbort, { once: true })
      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => { out += chunk })
      child.stderr.on("data", (chunk: string) => { err += chunk })
      // A child that exits before reading its input makes the write fail with
      // EPIPE, and an `error` on a stream with no listener throws inside
      // opencode's process (h #g61). The `close` below reports the outcome.
      child.stdin.on("error", (error) => {
        log.debug("lean claude stdin error", { error: error.message })
      })
      child.on("error", (error) => settle(error))
      child.on("close", (code) => {
        if (out.trim()) settle(null)
        else settle(new Error(`claude exited ${code}: ${err.trim().slice(0, 300)}`))
      })
      child.stdin.end(userEnvelope([{ type: "text", text: input }], true) + "\n", "utf8")
    })
    return leanResultText(stdout)
  } finally {
    try {
      rmSync(cwd, { recursive: true, force: true })
    } catch {
      // The scratch dir's own exit cleanup removes it.
    }
  }
}

/** Answer a detached generate call; undefined on any failure. */
export async function generateDetachedText(
  prompt: readonly any[],
  options: LeanClaudeOptions,
): Promise<string | undefined> {
  const started = Date.now()
  try {
    const text = await runLeanClaude(buildGenerateInput(prompt), GENERATE_SYSTEM_PROMPT, {
      ...options,
      timeoutMs: options.timeoutMs ?? 180_000,
    })
    log.info("detached generate from lean claude", {
      model: options.model,
      ms: Date.now() - started,
      chars: text.length,
    })
    return text
  } catch (error) {
    log.info("lean detached generate failed; running a full turn", {
      model: options.model,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}
