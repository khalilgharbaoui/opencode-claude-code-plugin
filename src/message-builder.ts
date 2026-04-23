import type { LanguageModelV3 } from "@ai-sdk/provider"
import { log } from "./logger.js"
import type { ReasoningEffort } from "./types.js"

type Prompt = Parameters<LanguageModelV3["doGenerate"]>[0]["prompt"]

const THINKING_KEYWORDS: Record<ReasoningEffort, string | null> = {
  minimal: null,
  low: "think",
  medium: "think hard",
  high: "think harder",
  xhigh: "megathink",
  max: "ultrathink",
}

export function reasoningKeyword(effort?: ReasoningEffort): string | null {
  if (!effort) return null
  return THINKING_KEYWORDS[effort] ?? null
}

function toImageBlock(part: any): any | null {
  const mediaType: string = part.mediaType || part.mimeType || ""
  if (!mediaType.startsWith("image/")) return null

  const data = part.data

  if (data instanceof URL) {
    return { type: "image", source: { type: "url", url: data.toString() } }
  }

  if (typeof data === "string") {
    if (data.startsWith("http://") || data.startsWith("https://")) {
      return { type: "image", source: { type: "url", url: data } }
    }
    // data URL: "data:image/png;base64,XXXX"
    if (data.startsWith("data:")) {
      const match = data.match(/^data:([^;]+);base64,(.+)$/)
      if (match) {
        return {
          type: "image",
          source: { type: "base64", media_type: match[1], data: match[2] },
        }
      }
    }
    // Otherwise assume already base64
    return {
      type: "image",
      source: { type: "base64", media_type: mediaType, data },
    }
  }

  if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
    const base64 = Buffer.from(data as Uint8Array).toString("base64")
    return {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: base64 },
    }
  }

  return null
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

/**
 * Compact conversation history into a context summary for when we start
 * a fresh Claude CLI session but want to preserve conversation context.
 */
export function compactConversationHistory(prompt: Prompt): string | null {
  const conversationMessages = prompt.filter(
    (m) => m.role === "user" || m.role === "assistant",
  )

  if (conversationMessages.length <= 1) {
    return null
  }

  const historyParts: string[] = []

  for (let i = 0; i < conversationMessages.length - 1; i++) {
    const msg = conversationMessages[i]
    const role = msg.role === "user" ? "User" : "Assistant"

    let text = ""
    if (typeof msg.content === "string") {
      text = msg.content
    } else if (Array.isArray(msg.content)) {
      const textParts = (msg.content as any[])
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text)
      text = textParts.join("\n")

      const toolCalls = (msg.content as any[]).filter(
        (p) => p.type === "tool-call",
      )
      const toolResults = (msg.content as any[]).filter(
        (p) => p.type === "tool-result",
      )

      if (toolCalls.length > 0) {
        text += `\n[Called ${toolCalls.length} tool(s): ${toolCalls.map((t: any) => t.toolName).join(", ")}]`
      }
      if (toolResults.length > 0) {
        text += `\n[Received ${toolResults.length} tool result(s)]`
      }
    }

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

/**
 * Convert AI SDK prompt into a Claude CLI stream-json user message.
 */
export function getClaudeUserMessage(
  prompt: Prompt,
  includeHistoryContext: boolean = false,
  reasoningEffort?: ReasoningEffort,
): string {
  const content: any[] = []

  if (includeHistoryContext) {
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
            const p = part as any
            content.push({
              type: "tool_result",
              tool_use_id: p.toolCallId,
              content: getToolResultText(p),
            })
          }
        }
      }
    }
  }

  if (content.length === 0) {
    // CLI rejects a zero-block message with 400, and Anthropic rejects
    // whitespace-only text blocks — so we need a non-whitespace sentinel
    // that the model is unlikely to read as an instruction (e.g. "continue").
    log.warn("empty user content; sending sentinel to satisfy CLI")
    return JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "." }],
      },
    })
  }

  const keyword = reasoningKeyword(reasoningEffort)
  if (keyword) {
    const lastTextPart = [...content].reverse().find((p) => p.type === "text")
    if (lastTextPart) {
      lastTextPart.text = lastTextPart.text
        ? `${lastTextPart.text}\n\n(${keyword})`
        : `(${keyword})`
    } else {
      content.push({ type: "text", text: `(${keyword})` })
    }
    log.debug("injected reasoning keyword", { effort: reasoningEffort, keyword })
  }

  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content,
    },
  })
}
