import type { LanguageModelV3 } from "@ai-sdk/provider"
import {
  ACCOUNT_BLOCK_MARKER,
  FAILOVER_MARKER,
  USAGE_LIMIT_MARKER,
  stripAccountFailoverParts,
} from "./account-failover.js"
import { INLINE_ASIDE_MARKER, LEGACY_INLINE_ASIDE_MARKERS } from "./btw-command.js"
import {
  COMPACT_BOUNDARY_MARKER,
  CONVERSATION_RESET_MARKER,
  RATE_LIMIT_MARKER,
  RESULT_ERROR_MARKER,
  SILENT_TURN_MARKER,
  STREAM_TIMEOUT_MARKER,
  UNATTENDED_REPLAY_MARKER,
} from "./cli-events.js"
import { DOCTOR_MARKER, parseDoctorCommandContent } from "./doctor.js"
import { log } from "./logger.js"
import { MODEL_FALLBACK_MARKER } from "./model-fallback.js"
import { parseSideQuestionContent } from "./side-question.js"
import { STALE_BUILD_MARKER } from "./stale-build.js"
import { TURN_STATS_MARKER } from "./turn-stats.js"

type Prompt = Parameters<LanguageModelV3["doGenerate"]>[0]["prompt"]

/**
 * Leading markers of text parts the plugin itself wrote into an assistant
 * reply: the `/btw` aside and its pre-bar form, the turn-stats footer, and the
 * `▌` notes for a CLI compaction, a rate-limit rejection and a failed result
 * subtype. None of them was ever model output or ever in Claude's context, so
 * a transcript rebuilt for a fresh CLI process must not hand any of them back
 * as something Claude said. Each is the first characters of its own text part,
 * which is what makes the strip exact instead of a guess at where a block ends.
 */
const PLUGIN_NOTE_MARKERS = [
  INLINE_ASIDE_MARKER,
  ...LEGACY_INLINE_ASIDE_MARKERS,
  TURN_STATS_MARKER,
  COMPACT_BOUNDARY_MARKER,
  CONVERSATION_RESET_MARKER,
  RATE_LIMIT_MARKER,
  RESULT_ERROR_MARKER,
  DOCTOR_MARKER,
  STREAM_TIMEOUT_MARKER,
  SILENT_TURN_MARKER,
  FAILOVER_MARKER,
  ACCOUNT_BLOCK_MARKER,
  USAGE_LIMIT_MARKER,
  MODEL_FALLBACK_MARKER,
  UNATTENDED_REPLAY_MARKER,
  STALE_BUILD_MARKER,
]

function isPluginNote(part: any): boolean {
  if (!part || part.type !== "text" || typeof part.text !== "string") return false
  const text = part.text.trimStart()
  return PLUGIN_NOTE_MARKERS.some((marker) => text.startsWith(marker))
}

function stripPluginNotes(content: unknown): unknown {
  if (!Array.isArray(content)) return content
  const kept = content.filter((part: any) => !isPluginNote(part))
  return kept.length === content.length ? content : kept
}

/**
 * Drop every plugin-authored exchange and note from a transcript before it is
 * replayed to the CLI: the `/btw` question with its answer, the
 * `/claude-code-doctor` report with its command, and the `▌` blocks listed in
 * `PLUGIN_NOTE_MARKERS`. Named for the `/btw` case it started as; it is the
 * one place all of them are removed, and it is called from both transcript
 * rebuild paths.
 */
export function filterSideQuestionHistory(prompt: Prompt): Prompt {
  // The account-failover form is a synthetic `question` call Claude never
  // issued, answered by a `tool-result` it never saw. It has to come out
  // before anything is replayed, which is on the switch turn by definition.
  prompt = stripAccountFailoverParts(prompt)
  let pluginCommand = false
  const kept = prompt.filter((message) => {
    if (message.role === "user") {
      pluginCommand =
        parseSideQuestionContent(message.content) !== null ||
        parseDoctorCommandContent(message.content) !== null
      return !pluginCommand
    }
    return message.role !== "assistant" || !pluginCommand
  })
  return kept.map((message) =>
    message.role === "assistant" ? ({ ...message, content: stripPluginNotes(message.content) } as typeof message) : message,
  )
}

/**
 * opencode-dcp anchors its nudges into message text as
 * `<dcp-system-reminder>` blocks (its `lib/messages/inject/utils.ts` appends
 * one to an existing text part, or splices in a synthetic part), and the
 * loudest of them orders the model to "use the `compress` tool now". Under
 * this provider that tool is only reachable when the operator forwards it,
 * so otherwise the block is an order that cannot be obeyed, carried by every
 * message it is anchored to.
 *
 * Blocks are removed wherever they sit rather than by matching a whole part,
 * because dcp appends its own `<dcp-message-id>` marker after one and an
 * end-anchored check would miss it. That is the same trap the `/btw`
 * reminder strip hit in production.
 */
const DCP_REMINDER_BLOCK =
  /<dcp-system-reminder\b[^>]*>[\s\S]*?<\/dcp-system-reminder>/gi

/** Remove every dcp reminder block from one piece of text. */
export function stripContextReminderBlocks(text: string): string {
  if (!text.includes("<dcp-system-reminder")) return text
  return text.replace(DCP_REMINDER_BLOCK, "").replace(/\n{3,}/g, "\n\n").trim()
}

/**
 * Whether this turn should strip those blocks: the operator opted in AND no
 * `compress` tool is being proxied. When compress IS proxied the reminder is
 * satisfiable and must survive, or the model is told to compress by nothing
 * and holds a tool it never learns it needs.
 *
 * Resolved from configuration alone so it is available before the spawn
 * block decides anything. A name that is configured but missing from
 * opencode's registry therefore counts as callable and nothing is stripped,
 * which is the conservative direction: the cost is a reminder that stays.
 */
export function shouldStripContextReminders(options: {
  enabled?: boolean
  proxyTools?: readonly string[]
  proxyOpencodeTools?: readonly string[]
}): boolean {
  if (options.enabled !== true) return false
  const namesCompress = (list?: readonly string[]): boolean =>
    (list ?? []).some((name) => String(name).trim().toLowerCase() === "compress")
  return !namesCompress(options.proxyTools) && !namesCompress(options.proxyOpencodeTools)
}

/**
 * Strip dcp reminder blocks from every user and assistant text part.
 *
 * Emptied parts are kept as empty strings rather than dropped: a nudge is
 * sometimes a message's only text part, and removing the part outright could
 * leave a user message with no content at all, which takes the empty-content
 * sentinel path in `getClaudeUserMessage`. Every consumer here already skips
 * a falsy `text`.
 */
export function stripContextReminders(prompt: Prompt): {
  prompt: Prompt
  removed: number
} {
  let removed = 0
  const countIn = (text: string): number =>
    (text.match(DCP_REMINDER_BLOCK) ?? []).length

  const out = prompt.map((message) => {
    if (message.role !== "user" && message.role !== "assistant") return message

    // AI SDK v3 always delivers user/assistant content as a part array, so
    // there is no string form to handle here.
    if (!Array.isArray(message.content)) return message

    let touched = false
    const parts = (message.content as any[]).map((part) => {
      if (!part || part.type !== "text" || typeof part.text !== "string") return part
      const hits = countIn(part.text)
      if (hits === 0) return part
      removed += hits
      touched = true
      return { ...part, text: stripContextReminderBlocks(part.text) }
    })
    return touched ? ({ ...message, content: parts } as typeof message) : message
  })

  return removed > 0 ? { prompt: out, removed } : { prompt, removed: 0 }
}

const PDF_MEDIA_TYPE = "application/pdf"

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

/** An image or PDF file part as a Claude content block, or null to skip it. */
function toAttachmentBlock(part: any): any | null {
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

  // A PDF is a `document` block, which the CLI passes to the API as it is
  // (measured on 2.1.288: Haiku 4.5 read a PDF sent this way, h #g213).
  if (resolvedMediaType.toLowerCase() === PDF_MEDIA_TYPE) {
    return {
      type: "document",
      source: { type: "base64", media_type: PDF_MEDIA_TYPE, data: base64 },
    }
  }

  if (!resolvedMediaType || !SUPPORTED_IMAGE_TYPES.has(resolvedMediaType)) {
    log.warn("unsupported media type for Claude attachment block, skipping", {
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

// Fresh-session replay caps. An assistant message keeps every step's tool
// calls ahead of the prose the model wrote last, so clipping from the end
// dropped the answer and kept the tool output in front of it.
const MAX_REPLAY_MESSAGE_CHARS = 2_000
const MAX_REPLAY_LAST_REPLY_CHARS = 12_000
const MAX_REPLAY_HEAD_CHARS = 1_000

/** Keep the start and, above all, the end; drop the middle. */
function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.min(Math.floor(max / 4), MAX_REPLAY_HEAD_CHARS)
  const tail = max - head
  return `${text.slice(0, head)}\n…[${text.length - max} chars omitted]…\n${text.slice(-tail)}`
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
 *   result bodies survive, then clips each message at 2000 chars (12000 for
 *   the newest assistant reply) by dropping the MIDDLE, so the prose a
 *   message ends on is kept. Used when
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

  // The reply the operator is most likely answering. It gets a larger budget
  // because a short answer like "1, 2 -> ok" points straight into it.
  let lastAssistant = -1
  for (let i = conversationMessages.length - 2; i >= 0; i--) {
    if (conversationMessages[i].role === "assistant") {
      lastAssistant = i
      break
    }
  }

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
      const max =
        i === lastAssistant ? MAX_REPLAY_LAST_REPLY_CHARS : MAX_REPLAY_MESSAGE_CHARS
      historyParts.push(`${role}: ${clipMiddle(text, max)}`)
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
  opts: {
    compactionMode?: boolean
    /** PTY compaction has no appended system prompt, so type its instructions. */
    compactionInstructions?: string
    cliToolCallIds?: ReadonlySet<string>
    stripContextReminders?: boolean
  } = {},
): string {
  const compactionMode = opts.compactionMode === true
  const cliToolCallIds = opts.cliToolCallIds
  const content: any[] = []

  // The account-failover form is the plugin's own dialog: Claude never issued
  // that call and never saw its answer. The transcript rebuilds stripped it
  // already; the current message did not, so on the turn after a form the
  // answer reached Claude as a stray `<opencode_tool_result>` ("The user
  // dismissed this question"), measured 2026-09-23.
  prompt = stripAccountFailoverParts(prompt)

  // Done once here, at the top, so every path below (the current message,
  // the fresh-session rebuild and the /compact transcript) sees the cleaned
  // text without each needing its own flag.
  if (opts.stripContextReminders) {
    const stripped = stripContextReminders(prompt)
    if (stripped.removed > 0) {
      log.info("stripped unsatisfiable context reminders", {
        blocks: stripped.removed,
      })
      prompt = stripped.prompt
    }
  }

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
    if (opts.compactionInstructions?.trim()) {
      content.push({ type: "text", text: opts.compactionInstructions })
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
The following is a summary of our conversation so far, replayed as text because no Claude session was available to continue it:

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
            const block = toAttachmentBlock(part)
            if (block) {
              content.push(block)
            } else {
              log.debug("skipped unsupported file part", {
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

/**
 * The plain user messages that follow the last assistant message, one array of
 * content blocks per message, plus the prompt index of that assistant message.
 *
 * A tool-result turn resolves the parked proxy calls and never writes a user
 * envelope, so anything the host promoted into the prompt beside the results
 * (a background-PTY notice, a mail-watch notice, a steered prompt) has to be
 * forwarded by the caller or the CLI never sees it. `tool` messages and
 * `tool-result` parts are skipped: those are what the resolution already
 * delivers. The index identifies which assistant boundary the messages belong
 * to, so a later tool-result turn for the same boundary does not send them twice.
 */
export function getTrailingUserMessages(
  prompt: Prompt,
  opts: { stripContextReminders?: boolean } = {},
): {
  assistantIndex: number
  messages: any[][]
} {
  // The same cleaning `getClaudeUserMessage` applies, so a forwarded message
  // never carries what the envelope path would have removed.
  prompt = stripAccountFailoverParts(prompt)
  if (opts.stripContextReminders) prompt = stripContextReminders(prompt).prompt
  let assistantIndex = -1
  for (let i = prompt.length - 1; i >= 0; i--) {
    if (prompt[i].role === "assistant") {
      assistantIndex = i
      break
    }
  }
  const messages: any[][] = []
  for (let i = assistantIndex + 1; i < prompt.length; i++) {
    const msg = prompt[i]
    if (msg.role !== "user") continue
    if (parseSideQuestionContent(msg.content) !== null) continue
    const blocks: any[] = []
    if (typeof msg.content === "string") {
      if ((msg.content as string).trim()) blocks.push({ type: "text", text: msg.content })
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as any[]) {
        if (part.type === "text") {
          if (part.text && part.text.trim()) blocks.push({ type: "text", text: part.text })
        } else if (part.type === "file" || part.type === "image") {
          const block = toAttachmentBlock(part)
          if (block) blocks.push(block)
        }
      }
    }
    if (blocks.length > 0) messages.push(blocks)
  }
  return { assistantIndex, messages }
}
