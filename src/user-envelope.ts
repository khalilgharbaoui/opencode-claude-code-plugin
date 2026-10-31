/**
 * The stream-json user envelope the plugin writes to a headless `claude`.
 *
 * `verbatim` stamps `client_composed: true`, the field the Agent SDK's
 * `verbatimPrompts` sets. Without it Claude Code reads the LAST text block of
 * the message the way it reads typing: a leading `/` runs one of its commands
 * (`/model claude-sonnet-5-5` switched the process to Sonnet without a model
 * call) and an `@path` attaches that file. With it the text reaches Claude as
 * written. Measured on 2.1.314 (h #g276).
 *
 * An envelope carrying a `tool_result` is never stamped: it continues a tool
 * round rather than starting a turn, and the field is about a turn's start.
 * With `verbatim` false the output is byte-identical to the envelope the
 * plugin always wrote. Imports nothing, so any module can build one.
 */
export function userEnvelope(content: unknown[], verbatim: boolean): string {
  const envelope: Record<string, unknown> = {
    type: "user",
    message: { role: "user", content },
  }
  const continuesToolRound = content.some(
    (block) => (block as { type?: unknown } | null)?.type === "tool_result",
  )
  if (verbatim && !continuesToolRound) envelope.client_composed = true
  return JSON.stringify(envelope)
}
