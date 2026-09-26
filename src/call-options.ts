/**
 * Reading a single LLM call: which opencode session and agent it belongs
 * to, which model handles /compact, whether the prompt has anything new in
 * it, and how to describe an abort.
 *
 * Split out of `claude-code-language-model.ts` verbatim. Everything here is
 * pure and free-standing, which is why it was already exported and unit
 * tested from the class's outside.
 */
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"

/**
 * Default model used for opencode `/compact`. Haiku 4.5 is fast
 * (~150 tok/s), has a hard 8k output cap that bounds latency, and is a
 * strong structured summarizer. Override per-project via the
 * `compactionModel` provider setting in opencode.json / opencode.jsonc,
 * or per-run via the `CLAUDE_CODE_COMPACTION_MODEL` env var (env wins).
 */
export const DEFAULT_COMPACTION_MODEL = "claude-haiku-4-5"

/**
 * Pick the model used to handle /compact. Precedence:
 *   1. `CLAUDE_CODE_COMPACTION_MODEL` env var (per-process override)
 *   2. `configured` argument (the `compactionModel` provider setting)
 *   3. `DEFAULT_COMPACTION_MODEL`
 *
 * Exported as a free function so it can be unit-tested without
 * instantiating the language model class.
 */
export function resolveCompactionModel(configured?: string): string {
  const env = process.env.CLAUDE_CODE_COMPACTION_MODEL?.trim()
  if (env) return env
  const trimmed = configured?.trim()
  if (trimmed) return trimmed
  return DEFAULT_COMPACTION_MODEL
}

/**
 * Resolve the session affinity token for a given LLM call. The affinity
 * token is part of the session key in session-manager so two different
 * opencode sessions sharing the same cwd+model still get separate Claude
 * CLI processes.
 *
 * Priority:
 *   1. `x-session-affinity` request header (primary — opencode sets it for
 *      third-party providers in packages/opencode/src/session/llm.ts).
 *   2. `opencodeSessionID` inside `providerOptions` (injected by the
 *      `chat.params` hook in index.ts). Covers cases where the header is
 *      absent: provider switch mid-session, title synthesis paths, older
 *      opencode versions. opencode wraps `output.options` under the
 *      providerID before passing it to the language model, so we look up
 *      both the configured provider key and the canonical `"claude-code"`.
 *   3. `"default"` — safe fallback when neither source is available.
 *
 * Exported as a free function so it can be unit-tested without
 * instantiating the language model class.
 */
export function resolveSessionAffinity(
  headers: Record<string, string | undefined> | undefined,
  providerOptions: Record<string, unknown> | undefined,
  providerKey: string,
): string {
  if (headers) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "x-session-affinity") {
        const v = headers[key]
        if (typeof v === "string" && v.length > 0) return v
      }
    }
  }
  if (providerOptions) {
    const bag =
      (providerOptions as any)[providerKey] ??
      (providerOptions as any)["claude-code"]
    const sid = bag?.opencodeSessionID
    if (typeof sid === "string" && sid.length > 0) return sid
  }
  return "default"
}

/**
 * The opencode agent this call runs for, which is how compaction and title
 * calls are told apart from ordinary turns.
 *
 *   1. `opencodeAgent` in providerOptions, written by V1's `chat.params`
 *      hook. Checked first so opencode 1.x behaves exactly as it always has.
 *   2. The `x-opencode-agent` request header, written by the V2 entrypoint's
 *      `model.request` hook (src/v2.ts), which can set headers but not
 *      provider options.
 */
export function resolveOpencodeAgent(
  headers: Record<string, string | undefined> | undefined,
  providerOptions: Record<string, unknown> | undefined,
  providerKey: string,
): string | undefined {
  if (providerOptions) {
    const bag =
      (providerOptions as any)[providerKey] ??
      (providerOptions as any)["claude-code"]
    const agent = bag?.opencodeAgent
    if (typeof agent === "string") return agent
  }
  if (headers) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "x-opencode-agent") {
        const value = headers[key]
        if (typeof value === "string" && value.length > 0) return value
      }
    }
  }
  return undefined
}

/** An `AbortSignal.reason` as loggable text: its name and message, or its type. */
export function describeAbortReason(reason: unknown): string {
  if (reason === undefined) return "undefined"
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`
  if (typeof reason === "string") return reason
  try {
    return JSON.stringify(reason) ?? typeof reason
  } catch {
    return typeof reason
  }
}

/**
 * True if the prompt has any user-side content after the last assistant
 * message (text, tool_result, or any user role entry). False when the
 * prompt ends with an assistant message and there is nothing for Claude
 * to respond to — opencode sometimes iterates the agent loop one more
 * time after a turn naturally completed; without short-circuiting we'd
 * spawn Claude CLI on an empty turn and the model would reply with a
 * stub like "Did you mean to send a message?".
 */
export function hasNewUserContent(
  prompt: LanguageModelV3CallOptions["prompt"],
): boolean {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const msg = prompt[i]
    if (msg.role === "assistant") return false
    // Tool-result turns from opencode's outer loop arrive in `tool`-role
    // messages (AI SDK V3 shape). Treat any tool-result part as new
    // content so the short-circuit doesn't drop turns where opencode is
    // delivering the result for a still-pending proxy MCP call — letting
    // that fire `stop` is what was forcing the user to press "continue".
    if (msg.role === "tool") {
      const content: any = msg.content
      if (Array.isArray(content)) {
        for (const part of content as any[]) {
          if (part?.type === "tool-result") return true
        }
      }
      continue
    }
    if (msg.role !== "user") continue
    const content: any = msg.content
    if (typeof content === "string") {
      if (content.trim()) return true
      continue
    }
    if (Array.isArray(content)) {
      for (const part of content as any[]) {
        if (part.type === "text" && part.text && part.text.trim()) return true
        if (part.type === "tool-result") return true
        // Image/file-only user turns count as new input — without this the
        // short-circuit drops them as if the turn were empty.
        if (part.type === "image" || part.type === "file") return true
      }
    }
  }
  return false
}
