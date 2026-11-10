/**
 * opencode 2's `session.generate`: a one-off question about a session that is
 * answered with the session's context and never added to it (h #g299).
 *
 * Two built-in callers send one. Session warming (`warming` in opencode's
 * config, off by default) pings every idle session on an interval to keep the
 * prompt cache warm, and the `/goal` judge asks whether the goal is met each
 * time a goal session goes idle. Both reach a provider as an ordinary model
 * request with the session's history, the session's agent and a trailing user
 * message, told apart only by the request kind (`"generate"`), which the V2
 * entrypoint's `model.request` hook forwards as a header.
 *
 * Served as a turn, each one was written into the live Claude conversation,
 * and since opencode never stores it, the next request read that conversation
 * as rewound: measured on opencode 2.2.6 with Claude Code 2.1.322, every
 * warming ping after the first ended the `claude` process and forked it, and
 * the operator's next message carried a `conversation rewound` note for an
 * edit nobody made. opencode's own Claude provider answers these on a copy of
 * the session it deletes afterwards; here the CLI's `side_question` does the
 * same without a spawn, and measured with a five-minute cache TTL it keeps the
 * conversation's cache warm exactly as a forked turn does.
 */

/** Written by the V2 entrypoint's `model.request` hook (src/v2.ts). */
export const OPENCODE_REQUEST_KIND_HEADER = "x-opencode-request-kind"

/** The request kind the header carries, or undefined when there is none. */
export function resolveRequestKind(
  headers: Record<string, string | undefined> | undefined,
): string | undefined {
  if (!headers) return undefined
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== OPENCODE_REQUEST_KIND_HEADER) continue
    const value = headers[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

/**
 * Whether a call is a `session.generate` request about a session. A detached
 * generate call (affinity `default`) is not: it has no conversation to keep
 * out of, and `leanGenerate` owns it (h #g294).
 */
export function isSessionGenerateRequest(input: {
  requestKind: string | undefined
  affinity: string
  compactionMode: boolean
}): boolean {
  return !input.compactionMode && input.requestKind === "generate" && input.affinity !== "default"
}

/**
 * The question a `session.generate` request asks: the text of its trailing
 * user message, which is the one message opencode appends to the session's
 * history for it. Null when the prompt does not end on a user message with
 * text, which no measured caller sends.
 */
export function sessionGenerateQuestion(
  prompt: readonly { role: string; content: unknown }[],
): string | null {
  const latest = prompt.at(-1)
  if (latest?.role !== "user") return null
  let text: string
  if (typeof latest.content === "string") {
    text = latest.content
  } else if (Array.isArray(latest.content)) {
    text = latest.content
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text as string)
      .join("\n")
  } else {
    return null
  }
  text = text.trim()
  return text.length > 0 ? text : null
}

/** Why a `session.generate` request was refused rather than answered. */
export function sessionGenerateRefusal(reason: "no-question" | "no-live-session"): string {
  return reason === "no-question"
    ? "opencode asked a question about this session with no text in it."
    : "There is no live Claude Code session for this conversation to answer a question about it without " +
      "adding the question to the conversation. Send a normal message first."
}
