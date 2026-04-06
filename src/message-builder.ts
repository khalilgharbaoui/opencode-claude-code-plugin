import type { LanguageModelV2 } from "@ai-sdk/provider"
import { log } from "./logger.js"

type Prompt = Parameters<LanguageModelV2["doGenerate"]>[0]["prompt"]

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
        content.push({ type: "text", text: msg.content })
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content as any[]) {
          if (part.type === "text") {
            content.push({ type: "text", text: part.text })
          } else if (part.type === "tool-result") {
            const p = part as any
            let resultText = ""
            if (typeof p.result === "string") {
              resultText = p.result
            } else if (
              typeof p.result === "object" &&
              p.result &&
              "output" in p.result
            ) {
              resultText = String(p.result.output)
            } else {
              resultText = JSON.stringify(p.result)
            }
            content.push({
              type: "tool_result",
              tool_use_id: p.toolCallId,
              content: resultText,
            })
          }
        }
      }
    }
  }

  if (content.length === 0) {
    return JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "" }],
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
