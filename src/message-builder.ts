import type { LanguageModelV3 } from "@ai-sdk/provider"
import { INLINE_ASIDE_MARKER, LEGACY_INLINE_ASIDE_MARKERS } from "./btw-command.js"
import { log } from "./logger.js"
import { parseSideQuestionContent } from "./side-question.js"

type Prompt = Parameters<LanguageModelV3["doGenerate"]>[0]["prompt"]

const ASIDE_MARKERS = [INLINE_ASIDE_MARKER, ...LEGACY_INLINE_ASIDE_MARKERS]

function isInlineAside(part: any): boolean {
  if (!part || part.type !== "text" || typeof part.text !== "string") return false
  const text = part.text.trimStart()
  return ASIDE_MARKERS.some((marker) => text.startsWith(marker))
}

/**
 * An aside answered while a turn was running was written into that turn's
 * reply as its own text part (btw-command.ts). It was never Claude's own
 * output and was never in Claude's context, so a rebuilt transcript must not
 * hand it back as something Claude said.
 */
function stripInlineAsides(content: unknown): unknown {
  if (!Array.isArray(content)) return content
  const kept = content.filter((part: any) => !isInlineAside(part))
  return kept.length === content.length ? content : kept
}

export function filterSideQuestionHistory(prompt: Prompt): Prompt {
  let aside = false
  const kept = prompt.filter((message) => {
    if (message.role === "user") {
      aside = parseSideQuestionContent(message.content) !== null
      return !aside
    }
    return message.role !== "assistant" || !aside
  })
  return kept.map((message) =>
    message.role === "assistant" ? ({ ...message, content: stripInlineAsides(message.content) } as typeof message) : message,
  )
}

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

function toImageBlock(part: any): any | null {
  const raw: unknown = part.image ?? part.data ?? part.url ?? part.source?.data
  if (!raw) {
    log.warn("file part without data, skipping")
    return null
  }

  let resolvedMediaType: string = part.mediaType || part.mimeType || part.mime || ""
  let base64: string | null = null

  if (typeof raw === "string") {
    if (raw.startsWith("data:")) {
      const match = /^data:([^;,]+)(?:;[^,]*)*(?:;base64)?,(.*)$/s.exec(raw)
      if (!match) {
        log.warn("malformed data URI, skipping file part")
        return null
      }
      resolvedMediaType = resolvedMediaType || match[1]
      base64 = match[2]
    } else if (/^https?:\/\//i.test(raw)) {
      log.warn("remote URL images are not supported by Claude CLI, skipping")
      return null
    } else {
      base64 = raw
    }
  } else if (raw instanceof URL) {
    log.warn("remote URL images are not supported by Claude CLI, skipping")
    return null
  } else if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
    base64 = Buffer.from(raw as Uint8Array).toString("base64")
  } else {
    log.warn("unsupported file part data type", { dataType: typeof raw })
    return null
  }

  if (!resolvedMediaType || !SUPPORTED_IMAGE_TYPES.has(resolvedMediaType)) {
    log.warn("unsupported media type for Claude image block, skipping", {
      mediaType: resolvedMediaType,
    })
    return null
  }

  return {
    type: "image",
    source: { type: "base64", media_type: resolvedMediaType, data: base64 },
  }
}

function getToolResultText(part: any): string {
  const value = part.output ?? part.result

  if (typeof value === "string") {
    return value
  }

  if (!value || typeof value !== "object") {
    return JSON.stringify(value)
  }

  switch (value.type) {
    case "text":
    case "error-text":
      return String(value.value)
    case "json":
    case "error-json":
      return JSON.stringify(value.value)
    case "execution-denied":
      return value.reason ? `Execution denied: ${value.reason}` : "Execution denied"
    case "content":
      return Array.isArray(value.value)
        ? value.value
            .map((item: any) => {
              if (item?.type === "text") return item.text
              return JSON.stringify(item)
            })
            .join("\n")
        : JSON.stringify(value.value)
    default:
      return JSON.stringify(value)
  }
}

// Compaction-mode caps. These are the only knobs that affect how much
// transcript content reaches the model when opencode invokes /compact.
// 180k chars ≈ 60k tokens worst-case — well under Haiku 4.5's 200k window
// after accounting for system prompt + output budget.
const MAX_HISTORY_CHARS = 180_000
const MAX_TOOL_RESULT_CHARS = 10_000
const MAX_TOOL_INPUT_CHARS = 2_000

function clipWithMarker(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`
}

function renderToolInput(input: unknown): string {
  let raw: string
  try {
    raw = typeof input === "string" ? input : JSON.stringify(input)
  } catch {
    raw = String(input)
  }
  return clipWithMarker(raw, MAX_TOOL_INPUT_CHARS)
}

function renderMessageContentForCompaction(
  msg: any,
): { text: string; toolResultCount: number } {
  const lines: string[] = []
  let toolResultCount = 0

  if (typeof msg.content === "string") {
    return { text: msg.content, toolResultCount: 0 }
  }

  if (!Array.isArray(msg.content)) {
    return { text: "", toolResultCount: 0 }
  }

  for (const part of msg.content as any[]) {
    if (!part) continue
    switch (part.type) {
      case "text":
        if (part.text) lines.push(part.text)
        break
      case "tool-call":
        lines.push(
          `[tool_use:${part.toolName ?? "unknown"}(${renderToolInput(part.input)})]`,
        )
        break
      case "tool-result":
        toolResultCount++
        lines.push(
          `[tool_result:${part.toolName ?? part.toolCallId ?? "unknown"}]\n${clipWithMarker(
            getToolResultText(part),
            MAX_TOOL_RESULT_CHARS,
          )}`,
        )
        break
      case "image":
        lines.push(
          `[image: ${part.mediaType ?? part.mimeType ?? "unknown"}]`,
        )
        break
      case "file":
        lines.push(
          `[file: ${part.mediaType ?? part.mimeType ?? "unknown"}]`,
        )
        break
      case "reasoning":
        // Skip reasoning blocks in compaction — they bloat input without
        // helping the summarizer.
        break
    }
  }

  return { text: lines.join("\n"), toolResultCount }
}

/**
 * Compact conversation history into a context summary.
 *
 * - mode "fresh-session" (default): includes user, assistant and tool roles,
 *   renders each with the same serializer /compact uses so tool inputs and
 *   result bodies survive, then clips each message at 2000 chars. Used when
 *   starting a fresh CLI session that lost its prior session id. It used to
 *   filter to user/assistant only and reduce tool content to
 *   `[Called N tool(s)]` placeholders, which silently dropped subagent
 *   output entirely (issue #29).
 * - mode "compaction": rich serializer for opencode /compact. Includes
 *   tool roles, renders tool_use input and tool_result content (each
 *   clipped at MAX_TOOL_RESULT_CHARS), and caps aggregate output at
 *   MAX_HISTORY_CHARS by dropping oldest entries first.
 */
export function compactConversationHistory(
  prompt: Prompt,
  opts: { mode?: "fresh-session" | "compaction" } = {},
): string | null {
  const mode = opts.mode ?? "fresh-session"
  prompt = filterSideQuestionHistory(prompt)

  if (mode === "compaction") {
    return buildCompactionHistory(prompt)
  }

  // `tool`-role messages carry the results of everything opencode ran itself,
  // so they belong in the transcript. Filtering them out (issue #29) meant a
  // subagent's whole answer vanished: the assistant message kept a
  // `[Called 1 tool(s): task]` placeholder and the result it referred to was
  // never rendered at all.
  const conversationMessages = prompt.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "tool",
  )

  if (conversationMessages.length <= 1) {
    return null
  }

  const historyParts: string[] = []

  for (let i = 0; i < conversationMessages.length - 1; i++) {
    const msg = conversationMessages[i]
    const role =
      msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : "Tool"

    // Same renderer the /compact transcript uses, so tool inputs and result
    // bodies survive instead of collapsing to counts. This path used to write
    // `[Called N tool(s): ...]` / `[Received N tool result(s)]` and discard
    // every byte of the payload, which is the second half of issue #29.
    const { text } = renderMessageContentForCompaction(msg)

    if (text.trim()) {
      const truncated =
        text.length > 2000 ? text.slice(0, 2000) + "..." : text
      historyParts.push(`${role}: ${truncated}`)
    }
  }

  if (historyParts.length === 0) {
    return null
  }

  return historyParts.join("\n\n")
}

function buildCompactionHistory(prompt: Prompt): string | null {
  // Iterate newest-first, accumulate up to MAX_HISTORY_CHARS, then reverse
  // to chronological order. Oldest messages get dropped when the budget
  // is exhausted — they are the least relevant for a summary of recent
  // work.
  const entries: string[] = []
  let total = 0
  let totalToolResults = 0
  let droppedOldest = 0

  // Skip the trailing user message: opencode's /compact appends the
  // synthesis instruction as the final user turn. The instruction itself
  // is added by getClaudeUserMessage after the transcript block, so we
  // don't want it duplicated inside the transcript.
  const end = prompt.length > 0 && prompt[prompt.length - 1].role === "user"
    ? prompt.length - 1
    : prompt.length

  for (let i = end - 1; i >= 0; i--) {
    const msg = prompt[i] as any
    const roleLabel =
      msg.role === "user"
        ? "User"
        : msg.role === "assistant"
          ? "Assistant"
          : msg.role === "tool"
            ? "Tool"
            : msg.role

    const { text, toolResultCount } = renderMessageContentForCompaction(msg)
    if (!text.trim()) continue

    const entry = `${roleLabel}: ${text}`
    if (total + entry.length > MAX_HISTORY_CHARS) {
      droppedOldest = i + 1
      break
    }
    entries.push(entry)
    total += entry.length + 2 // +2 for the "\n\n" join
    totalToolResults += toolResultCount
  }

  if (entries.length === 0) return null

  entries.reverse()
  log.info("built compaction history", {
    entries: entries.length,
    chars: total,
    toolResults: totalToolResults,
    droppedOldestBefore: droppedOldest,
  })

  return entries.join("\n\n")
}

/**
 * Convert AI SDK prompt into a Claude CLI stream-json user message.
 *
 * `compactionMode` switches behavior for opencode /compact: the prior
 * transcript is rendered with rich tool content (not placeholders) and the
 * wrapper framing tells the model this is the authoritative thread.
 *
 * Reasoning effort is not part of the message. It used to ride here as a
 * thinking keyword ("(ultrathink)"), but Claude Code dropped every keyword
 * except that one, so effort now reaches the CLI as CLAUDE_CODE_EFFORT_LEVEL
 * at spawn time (see `claudeSpawnEnv`).
 */
export function getClaudeUserMessage(
  prompt: Prompt,
  includeHistoryContext: boolean = false,
  opts: { compactionMode?: boolean; cliToolCallIds?: ReadonlySet<string> } = {},
): string {
  const compactionMode = opts.compactionMode === true
  const cliToolCallIds = opts.cliToolCallIds
  const content: any[] = []

  /**
   * A `tool_result` block is only meaningful to a resumed CLI session when
   * that session issued the matching `tool_use`. Anything opencode ran on its
   * own behalf (a `subtask: true` command's `task` call, issue #29) has an id
   * the CLI never emitted, so the block is orphaned: Claude cannot resolve it
   * and the payload, which is right there in the envelope, is unreachable.
   * Those are rendered as plain text instead, which keeps the content and
   * loses only the pairing the CLI could not have honoured anyway.
   *
   * `cliToolCallIds` is the set of calls this CLI process is waiting on. When
   * a caller does not supply it we keep the old unconditional block, so a
   * forgotten call site degrades to today's behaviour rather than breaking
   * the proxy round-trip.
   */
  const pushToolResult = (part: any): void => {
    const id = part.toolCallId
    const text = getToolResultText(part)
    if (!cliToolCallIds || cliToolCallIds.has(id)) {
      content.push({ type: "tool_result", tool_use_id: id, content: text })
      return
    }
    log.info("rendering opencode-side tool result as text", {
      toolCallId: id,
      toolName: part.toolName,
      chars: text.length,
    })
    content.push({
      type: "text",
      text: `<opencode_tool_result tool="${part.toolName ?? "unknown"}">\n${text}\n</opencode_tool_result>`,
    })
  }

  if (compactionMode) {
    const transcript = compactConversationHistory(prompt, {
      mode: "compaction",
    })
    if (transcript) {
      log.info("including compaction transcript", {
        historyLength: transcript.length,
      })
      content.push({
        type: "text",
        text: `<conversation_transcript>
${transcript}
</conversation_transcript>

The complete prior conversation appears above. The synthesis instructions follow below.

`,
      })
    }
  } else if (includeHistoryContext) {
    const historyContext = compactConversationHistory(prompt)
    if (historyContext) {
      log.info("including conversation history context", {
        historyLength: historyContext.length,
      })
      content.push({
        type: "text",
        text: `<conversation_history>
The following is a summary of our conversation so far (from a previous session that couldn't be resumed):

${historyContext}

</conversation_history>

Now continuing with the current message:

`,
      })
    }
  }

  // Find messages since last assistant message
  const messages: typeof prompt = []
  for (let i = prompt.length - 1; i >= 0; i--) {
    if (prompt[i].role === "assistant") break
    messages.unshift(prompt[i])
  }

  for (const msg of messages) {
    if (msg.role === "user") {
      if (parseSideQuestionContent(msg.content) !== null) continue
      if (typeof msg.content === "string") {
        const str = msg.content as string
        if (str.trim()) {
          content.push({ type: "text", text: str })
        }
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content as any[]) {
          if (part.type === "text") {
            if (part.text && part.text.trim()) {
              content.push({ type: "text", text: part.text })
            }
          } else if (part.type === "file" || part.type === "image") {
            const block = toImageBlock(part)
            if (block) {
              content.push(block)
            } else {
              log.debug("skipped non-image file part", {
                mediaType: part.mediaType,
              })
            }
          } else if (part.type === "tool-result") {
            pushToolResult(part)
          }
        }
      }
    } else if (msg.role === "tool") {
      // AI SDK V3 delivers tool results in `tool`-role messages, not `user`.
      // Without this branch we'd hit the empty-content sentinel path and
      // send "(empty)" to Claude CLI instead of the actual tool result —
      // forcing the user to press "continue" between proxy tool calls.
      if (Array.isArray(msg.content)) {
        for (const part of msg.content as any[]) {
          if (part?.type === "tool-result") {
            pushToolResult(part)
          }
        }
      }
    }
  }

  if (content.length === 0) {
    // CLI rejects a zero-block message with 400, and Anthropic rejects
    // whitespace-only text blocks — so we need a non-whitespace sentinel.
    // "(empty)" matches the parenthetical meta-note convention this file
    // already uses for reasoning keywords ("(think)", "(megathink)", etc.),
    // which the model reads as out-of-band metadata rather than a prompt to
    // continue its previous turn.
    log.warn("empty user content; sending sentinel to satisfy CLI")
    return JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "(empty)" }],
      },
    })
  }

  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content,
    },
  })
}
