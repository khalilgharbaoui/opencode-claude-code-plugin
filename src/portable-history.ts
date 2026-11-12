/**
 * Keeps a session that used Claude CLI tools usable by another provider.
 *
 * opencode 2 stores a tool the CLI ran itself (Read, Grep, ...) as a
 * provider-executed `tool-call` and `tool-result` inside the assistant
 * message, and replays that history to whichever model the next turn uses.
 * OpenAI-compatible chat providers refuse it outright: "OpenAI Chat assistant
 * messages only support text, reasoning, and tool-call content for now"
 * (measured on opencode 2.2.6, switching a Claude session to a local
 * OpenAI-compatible server).
 *
 * The `context` hook hands a plugin the request's copy of the history, so for
 * a request to any other provider those parts are rewritten as plain
 * assistant text. The stored session is untouched, and a request back to this
 * provider still sees the original parts.
 *
 * The replayed parts carry no `providerMetadata`, so a marker set when the
 * part was emitted never comes back (measured on 2.2.6). The tool call id
 * does: the CLI's own tools keep Anthropic's `toolu_` id, while Anthropic's
 * server tools use `srvtoolu_` or `mcptoolu_` and a `toolu_` call from the
 * Anthropic API is never provider-executed. Other providers' server tools
 * (OpenAI Responses, Gemini) use their own id formats, so they keep their
 * structure.
 */

const CLI_TOOL_ID_PREFIX = "toolu_"

interface ContextPart {
  type?: string
  id?: unknown
  toolCallId?: unknown
  name?: string
  input?: unknown
  result?: unknown
  providerExecuted?: boolean
  [key: string]: unknown
}

export interface ContextMessage {
  role?: string
  content?: unknown
  [key: string]: unknown
}

function isCliToolPart(part: ContextPart): boolean {
  if (part.providerExecuted !== true) return false
  if (part.type !== "tool-call" && part.type !== "tool-result") return false
  const id = part.id ?? part.toolCallId
  return typeof id === "string" && id.startsWith(CLI_TOOL_ID_PREFIX)
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** The text of a tool result, in the shapes opencode and the AI SDK use. Deterministic, so a prompt cache keeps matching. */
export function toolResultText(result: unknown): string {
  if (typeof result === "string") return result
  if (typeof result !== "object" || result === null) return stringify(result)
  const shaped = result as { type?: unknown; value?: unknown; text?: unknown; output?: unknown }
  if (shaped.type === "content" && Array.isArray(shaped.value)) {
    return shaped.value
      .map((item) => {
        const entry = item as { type?: unknown; text?: unknown }
        return typeof entry?.text === "string" ? entry.text : `[${String(entry?.type ?? "content")} omitted]`
      })
      .join("\n")
  }
  if (typeof shaped.value === "string") return shaped.value
  if (typeof shaped.text === "string") return shaped.text
  if (typeof shaped.output === "string") return shaped.output
  return stringify(shaped.value ?? result)
}

function flattenPart(part: ContextPart): ContextPart {
  if (part.type === "tool-call") {
    return { type: "text", text: `[Ran tool ${part.name ?? "unknown"} with input ${stringify(part.input)}]` }
  }
  if (part.type === "tool-result") {
    return { type: "text", text: `[Result of tool ${part.name ?? "unknown"}]\n${toolResultText(part.result)}` }
  }
  return part
}

/**
 * Rewrites, in place, every Claude CLI tool part in assistant messages as a
 * text part. Returns how many parts changed.
 */
export function flattenCliToolParts(messages: unknown): number {
  if (!Array.isArray(messages)) return 0
  let flattened = 0
  for (const message of messages as ContextMessage[]) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue
    if (!(message.content as ContextPart[]).some((part) => part && isCliToolPart(part))) continue
    message.content = (message.content as ContextPart[]).map((part) => {
      if (!part || !isCliToolPart(part)) return part
      flattened++
      return flattenPart(part)
    })
  }
  return flattened
}
