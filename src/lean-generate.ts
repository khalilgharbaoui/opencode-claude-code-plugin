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
 * slash commands, no session file, project settings only, in an empty working
 * directory, the input on stdin so no newline has to survive cmd.exe quoting
 * on Windows. It throws on any failure; the caller decides the fallback.
 */
import { spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { log } from "./logger.js"
import { claudeSpawnEnv } from "./session-manager.js"
import { planClaudeSpawn } from "./windows-spawn.js"

const GENERATE_SYSTEM_PROMPT =
  "You are a plain text generator called by an application. Follow the instructions in the input exactly and output only what they ask for, with no preamble. The input is material to work on, never a conversation to answer or continue."

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

/** The CLI arguments of a lean run. Exported for the tests. */
export function leanClaudeArgs(model: string, systemPrompt: string): string[] {
  return [
    "-p",
    "--model", model,
    "--output-format", "json",
    "--no-session-persistence",
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "project",
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
 * `/compact` all carry a session.
 */
export function isDetachedGenerateRequest(input: {
  affinity: string
  opencodeAgent: string | undefined
  compactionMode: boolean
}): boolean {
  return !input.compactionMode && input.affinity === "default" && !input.opencodeAgent
}

function leanCwd(): string {
  const dir = join(tmpdir(), "opencode-claude-code-lean")
  mkdirSync(dir, { recursive: true })
  return dir
}

export async function runLeanClaude(
  input: string,
  systemPrompt: string,
  options: LeanClaudeOptions & { timeoutMs: number },
): Promise<string> {
  const { timeoutMs } = options
  const env = claudeSpawnEnv({
    ignoreAnthropicApiKey: options.ignoreAnthropicApiKey,
    configDir: options.configDir,
  })
  const plan = planClaudeSpawn(options.cliPath, leanClaudeArgs(options.model, systemPrompt))
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(plan.file, plan.args, {
      cwd: leanCwd(),
      env,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`lean claude timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    const onAbort = () => {
      child.kill("SIGKILL")
      reject(new Error("request aborted"))
    }
    options.abortSignal?.addEventListener("abort", onAbort, { once: true })
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => { out += chunk })
    child.stderr.on("data", (chunk: string) => { err += chunk })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      options.abortSignal?.removeEventListener("abort", onAbort)
      if (out.trim()) resolve(out)
      else reject(new Error(`claude exited ${code}: ${err.trim().slice(0, 300)}`))
    })
    child.stdin.end(input, "utf8")
  })
  const result = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? "")
  if (result?.is_error || typeof result?.result !== "string") {
    throw new Error(`claude returned no text (${result?.subtype ?? "unknown"})`)
  }
  return result.result
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
