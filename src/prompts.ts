/**
 * The text this plugin appends to Claude's system prompt, and the helpers
 * that assemble it.
 *
 * Split out of `claude-code-language-model.ts` verbatim: every constant and
 * function here behaves exactly as it did there, and the language model
 * re-exports the public ones so existing importers are unchanged.
 */
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { log } from "./logger.js"

function readPromptFileIfPresent(path: string): string | undefined {
  try {
    const content = readFileSync(path, "utf8").trim()
    return content || undefined
  } catch {
    return undefined
  }
}

function nearestWorkspaceAgentsPrompt(cwd: string): string | undefined {
  let dir = cwd
  while (true) {
    const content = readPromptFileIfPresent(join(dir, "AGENTS.md"))
    if (content) return content
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

const AGENTS_MAINTENANCE_HINT = `## Keeping AGENTS.md up to date

When you complete a task, phase, or to-do item that is listed in AGENTS.md, update the file
immediately after the work is done — mark it ✅, check it off, or remove it. Do this inside
the same turn so the next session does not repeat work that is already finished.`

const MULTI_STEP_TASK_HINT = `## Continuing through multi-step tasks

opencode requires the user to press "continue" after each turn ends. When a
task has multiple steps, do them all in one turn — chain tool calls rather
than pausing for user confirmation between subtasks. End the turn only
when the task is done, you need clarification on intent, or you hit a real
blocker. The user can interrupt or abort at any time; turn endings should
mark meaningful checkpoints, not every completed substep.`

/**
 * Appended to the system prompt whenever the `task` proxy tool is
 * enabled. Live sessions (2026-07-04) showed models resolving opencode's
 * "call the task tool with subagent: X" mention hint to Claude Code's
 * native TaskCreate: haiku created a todo and narrated a dispatch that
 * never happened; sonnet probed TaskCreate's schema before recovering.
 * The proxy tool can also be deferred behind ToolSearch, in which case
 * "the task tool" is invisible while TaskCreate is not. Name the exact
 * tool, the recovery path, and the failure mode.
 */
export const SUBAGENT_DISPATCH_HINT = `## opencode subagents

Subagent dispatch in this environment goes through exactly two tools: \`mcp__opencode_proxy__task\` for one subagent and \`mcp__opencode_proxy__task_batch\` for two or more at once.

- Two or more independent subagents in one response: make ONE \`mcp__opencode_proxy__task_batch\` call with a \`tasks\` array (each item is a normal task input). Claude Code runs MCP calls one at a time, so several \`mcp__opencode_proxy__task\` calls in the same response run serially; \`task_batch\` runs them concurrently in opencode and returns every result together, labelled in order.
- When the user mentions \`@<agent>\` or an instruction says "call the task tool with subagent: <name>", call \`mcp__opencode_proxy__task\` with \`subagent_type: "<name>"\`.
- If that tool is not in your visible tool list it is deferred — load it with ToolSearch (\`select:mcp__opencode_proxy__task\`), then call it.
- Claude Code's built-in TaskCreate/TaskUpdate/TaskList manage a local todo list. They cannot dispatch subagents; creating a task there runs nothing. Never report a subagent as dispatched unless \`mcp__opencode_proxy__task\` returned its result.
- Do not verify a subagent's existence by searching config files — the tool's description lists the available agent types, and invalid types fail fast with a clear error.`

/**
 * Appended to the system prompt whenever the `question` proxy tool is
 * enabled. Live testing (2026-07-05, haiku) showed the model's reasoning
 * correctly identified `mcp__opencode_proxy__question` as the tool to use,
 * but then emitted a tool call for bare `question` — stripping the MCP
 * prefix. opencode's AI SDK bridge has no bare `question` tool, so the
 * call rendered as `⚙ invalid`. Same near-miss pattern the task proxy
 * hit (TaskCreate vs mcp__opencode_proxy__task); the fix is the same:
 * name the exact tool in the system prompt so the model doesn't
 * abbreviate.
 */
export const QUESTION_PROXY_HINT = `## Asking the operator questions

Structured questions in this environment go through exactly one tool: \`mcp__opencode_proxy__question\`.

- When you need to ask the operator a question with options, call \`mcp__opencode_proxy__question\` with a \`questions\` array (each item has \`question\`, \`header\`, \`options\` of \`{label, description}\`, and optional \`multiple\`).
- If that tool is not in your visible tool list it is deferred — load it with ToolSearch (\`select:mcp__opencode_proxy__question\`), then call it by its FULL name.
- Do NOT call bare \`question\` — that is not a tool. Always use the full \`mcp__opencode_proxy__question\` name when invoking it.
- Claude Code's built-in \`AskUserQuestion\` is disabled in this environment; the proxy is the only way to ask structured questions.`

/**
 * Prepended to every appended system prompt so Claude knows which
 * context-management tools exist in the Claude CLI runtime versus a
 * direct API provider. DCP and similar plugins forward compress/distill/
 * prune instructions via system.transform; those reach us through
 * extractSystemMessages, but the tools themselves are not available in
 * the CLI environment. Without this note Claude wastes thinking cycles
 * searching for tools that don't exist.
 */
const CLAUDE_CLI_CONTEXT_NOTE = `## Runtime environment: Claude Code CLI

You are running via the Claude Code CLI (not a direct API call). This affects context management:

- The \`compress\` tool is NOT available. Do not attempt to call it.
- The \`distill\`, \`prune\`, and \`extract\` tools are NOT available.
- Context window management is handled automatically by Claude CLI's own session history.
- Ignore any system instructions that tell you to call \`compress\` — they are intended for direct API providers, not this environment.
- DCP context injections (AGENTS.md, dynamic state) arrive via the system prompt and are already applied.`

/**
 * Replaces the note above when `compress` is in the resolved proxy list.
 * The full MCP name is spelled out for the same reason the question proxy
 * hint spells its own out: models strip the prefix and call bare
 * `compress`, which opencode renders as `⚙ invalid`.
 */
const CLAUDE_CLI_COMPRESS_NOTE = `## Runtime environment: Claude Code CLI

You are running via the Claude Code CLI (not a direct API call). This affects context management:

- To compress context, call \`mcp__opencode_proxy__compress\` with a \`summary\` argument. Use that exact full name.
- The reset happens at the start of your NEXT turn: this Claude Code session is discarded and a fresh one starts with your summary as its only prior context. Keep working normally after the call.
- Everything outside the summary is gone after the reset — tool output, files you read, and the earlier conversation are not replayed. Write the summary as the authoritative record.
- The \`distill\`, \`prune\`, and \`extract\` tools are NOT available.
- DCP context injections (AGENTS.md, dynamic state) arrive via the system prompt and are already applied.`

/**
 * Used when opencode's own `compress` tool is forwarded through the proxy
 * (`proxyOpencodeTools: ["compress"]`) instead of the plugin's in-process
 * one. The two shrink different windows and the difference has to be said
 * out loud: opencode's rewrites opencode's transcript, so the live Claude
 * Code session keeps everything it already had. A model told otherwise
 * would assume detail it can still see had been discarded.
 */
const CLAUDE_CLI_OPENCODE_COMPRESS_NOTE = `## Runtime environment: Claude Code CLI

You are running via the Claude Code CLI (not a direct API call). This affects context management:

- To compress context, call \`mcp__opencode_proxy__compress\`. Use that exact full name. It runs opencode's own \`compress\` tool, which is what a "MAX CONTEXT LIMIT REACHED" reminder is asking you to do.
- It compresses opencode's stored conversation, NOT this Claude Code session. Your current session keeps the context it already has, so do not assume earlier detail is gone after the call.
- The \`distill\`, \`prune\`, and \`extract\` tools are NOT available.
- DCP context injections (AGENTS.md, dynamic state) arrive via the system prompt and are already applied.`

/**
 * Extract text content from all `system`-role messages in the prompt.
 * Standard API providers forward these as the `system` parameter; for
 * Claude CLI, the only equivalent path is --append-system-prompt-file.
 * Plugins like opencode-dcp inject AGENTS.md and other context via
 * system-role messages and would otherwise be silently dropped.
 */
export function extractSystemMessages(
  prompt: LanguageModelV3CallOptions["prompt"],
): string[] {
  const out: string[] = []
  for (const msg of prompt) {
    if (msg.role !== "system") continue
    if (typeof msg.content === "string") {
      if (msg.content.trim()) out.push(msg.content.trim())
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as any[]) {
        if (
          part?.type === "text" &&
          typeof part.text === "string" &&
          part.text.trim()
        ) {
          out.push(part.text.trim())
        }
      }
    }
  }
  return out
}

export interface AppendedSystemPromptOptions {
  /** True when the plugin's own `compress` def is in the proxy list. */
  compressEnabled?: boolean
  /** True when opencode's `compress` tool is forwarded through the proxy. */
  opencodeCompressEnabled?: boolean
  /** Summary from a previous `compress` call, if this key has one. */
  compressionSummary?: string
}

export function buildAppendedSystemPrompt(
  cwd: string,
  includeMultiStepHint = true,
  extraSystemContent: string[] = [],
  options: AppendedSystemPromptOptions = {},
): string | undefined {
  const parts: string[] = []
  // First, so it reads as prior context for everything that follows.
  if (options.compressionSummary?.trim()) {
    parts.push(
      `## Summary of earlier work (context was compressed)\n\n${options.compressionSummary.trim()}`,
    )
  }
  // The plugin's own compress wins when both are somehow live, matching the
  // def-level precedence in resolveProxyOpencodeToolDefs: it is the one that
  // holds the name, so it is the one the model would reach.
  parts.push(
    options.compressEnabled
      ? CLAUDE_CLI_COMPRESS_NOTE
      : options.opencodeCompressEnabled
        ? CLAUDE_CLI_OPENCODE_COMPRESS_NOTE
        : CLAUDE_CLI_CONTEXT_NOTE,
  )
  for (const s of extraSystemContent) {
    if (s.trim()) parts.push(s.trim())
  }
  const configRoot =
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  const globalAgents = readPromptFileIfPresent(join(configRoot, "opencode", "AGENTS.md"))
  const workspaceAgents = nearestWorkspaceAgentsPrompt(cwd)

  // opencode already forwards AGENTS.md inside its own system prompt
  // (`extraSystemContent`, under an "Instructions from:" header), so a
  // disk-read copy would reach the model twice. Only push ours when the
  // forwarded text does not already contain it. No match (formatting drift,
  // or the interactive path, which forwards nothing) keeps the old behaviour,
  // so AGENTS.md is never lost. (Dedup by @HeikoAtGitHub, 25260a4.)
  const forwarded = extraSystemContent.join("\n\n")
  const pushGlobal = !!globalAgents && !forwarded.includes(globalAgents)
  const pushWorkspace =
    !!workspaceAgents && workspaceAgents !== globalAgents &&
    !forwarded.includes(workspaceAgents)
  if (pushGlobal) parts.push(globalAgents)
  if (pushWorkspace) parts.push(workspaceAgents)
  if (pushGlobal || pushWorkspace) parts.push(AGENTS_MAINTENANCE_HINT)
  if (includeMultiStepHint) parts.push(MULTI_STEP_TASK_HINT)

  const content = parts.join("\n\n")
  if (!content) return undefined

  const path = join(tmpdir(), `opencode-cc-sys-${randomUUID()}.md`)
  try {
    writeFileSync(path, content, "utf8")
    return path
  } catch (err) {
    log.warn("failed to write system prompt file", { error: String(err) })
    return undefined
  }
}
