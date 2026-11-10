/**
 * A real model for title requests (`titleModel`, issue #169).
 *
 * The default answer to a title request is the synthetic title in title.ts:
 * the first six non-stop words of the latest user text. A lead-in before the
 * text to name ("Here is the first message of the conversation: <message>…")
 * then becomes the title of every session, and the title agent's system
 * prompt is never read. With `titleModel` set, the request gets one lean
 * `claude -p` on that model (lean-generate.ts) with the host's system prompt
 * and messages; any failure keeps the synthetic title.
 */
import { log } from "./logger.js"
import { LeanClaudeRefusal, runLeanClaude, type LeanClaudeOptions } from "./lean-generate.js"

const TITLE_SYSTEM_PROMPT =
  "You write a short title for a chat session. The input holds the naming instructions and the conversation to name. Never answer or continue the conversation. Output only the title."
const MAX_INPUT_CHARS = 12_000
const MAX_TITLE_CHARS = 100

/**
 * Models the CLI has refused as unknown, warned about once each. Every other
 * failure (a usage limit, an expired login, a timeout) is the account's or the
 * moment's and stays at INFO, because the next chat turn says it anyway; a
 * typo in `titleModel` would otherwise fail silently on every session.
 */
const warnedUnknownModels = new Set<string>()

/** Test seam: forget which models were warned about. */
export function _resetTitleModelWarnings(): void {
  warnedUnknownModels.clear()
}

function partText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => String(part.text))
    .join("\n")
}

/** The title agent's system prompt as instructions, then the conversation, its end kept. */
export function buildTitleInput(prompt: readonly any[]): string {
  const instructions = prompt
    .filter((msg) => msg?.role === "system")
    .map((msg) => partText(msg.content).trim())
    .filter(Boolean)
    .join("\n\n")
  let conversation = prompt
    .filter((msg) => msg?.role === "user" || msg?.role === "assistant")
    .map((msg) => ({ role: msg.role as string, text: partText(msg.content).trim() }))
    .filter((turn) => turn.text)
    .map((turn) => `<${turn.role}>\n${turn.text}\n</${turn.role}>`)
    .join("\n")
  if (conversation.length > MAX_INPUT_CHARS) {
    // The message to name is the last one.
    conversation = conversation.slice(-MAX_INPUT_CHARS)
  }
  return (
    (instructions ? `<instructions>\n${instructions}\n</instructions>\n` : "") +
    `<conversation>\n${conversation}\n</conversation>\n`
  )
}

/** The first non-empty line, without quotes, a `Title:` label or a trailing period. */
export function cleanTitle(raw: string): string | undefined {
  const line = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean)
  if (!line) return undefined
  const title = line
    .replace(/^title\s*:\s*/i, "")
    .replace(/^["'`*#\s]+|["'`*\s.]+$/g, "")
    .trim()
  if (!title) return undefined
  return title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS).trim() : title
}

/** A title from the model, or undefined so the caller keeps the synthetic one. */
export async function generateTitleWithModel(
  prompt: readonly any[],
  options: LeanClaudeOptions,
): Promise<string | undefined> {
  const started = Date.now()
  try {
    const title = cleanTitle(
      await runLeanClaude(buildTitleInput(prompt), TITLE_SYSTEM_PROMPT, {
        ...options,
        timeoutMs: options.timeoutMs ?? 30_000,
      }),
    )
    log.info("title from model", {
      model: options.model,
      ms: Date.now() - started,
      chars: title?.length ?? 0,
    })
    return title
  } catch (error) {
    log.info("title model failed; using the synthetic title", {
      model: options.model,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    })
    if (
      error instanceof LeanClaudeRefusal &&
      error.kind === "model_not_found" &&
      !warnedUnknownModels.has(options.model)
    ) {
      warnedUnknownModels.add(options.model)
      log.warn("titleModel is a model claude does not know; session titles stay synthetic", {
        model: options.model,
      })
    }
    return undefined
  }
}
