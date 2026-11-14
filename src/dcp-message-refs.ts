/**
 * opencode-dcp's message references, in the two forms dcp 3.2.0 writes them.
 *
 * dcp numbers the messages it hands a provider and appends a reference to each
 * user text part and each completed tool output, on the way out: opencode's own
 * store never holds it. Read off dcp 3.2.0's `formatMessageIdTag`:
 *
 *   - `xml` (its opencode 1 path): `\n<dcp-message-id>m0004</dcp-message-id>`,
 *     with an optional `priority="..."` attribute and `BLOCKED` for a
 *     protected message.
 *   - `compact` (its opencode 2 path): `\n@4@`, `\n@b3@` for a compressed
 *     block or `\n@blocked@`, optionally followed by ` [<priority>]`.
 *
 * Imports nothing, so both the digest (`src/session-fork.ts`) and the question
 * readers (`src/plan-mode-question.ts`) can use it.
 */

/**
 * The XML form anywhere in a text, any attributes. Global, so only ever used
 * with `replace`. Only the tag itself, not the newlines dcp put before it,
 * because a leading `\s*` would make the scan quadratic over a long run of
 * whitespace.
 */
export const DCP_MESSAGE_ID_TAG = /<dcp-message-id(?:\s[^>]*)?>[^<]*<\/dcp-message-id>/g

/** One whole XML tag, anchored at both ends. */
const DCP_MESSAGE_ID_TAG_WHOLE = /^<dcp-message-id(?:\s[^>]*)?>[^<]*<\/dcp-message-id>$/

/**
 * The compact form, as a whole line: `@12@`, `@b3@` or `@blocked@`, optionally
 * followed by ` [<priority>]`. Measured on opencode 2.0.31: after an undo a
 * message went out as `@4@` before a restart and `@3@` after it (h #g259).
 */
export const DCP_COMPACT_REF_LINE = /^@(?:\d+|b\d+|blocked)@(?: \[[^\]\n]*\])?$/

/**
 * `text` with every dcp reference at its END taken off, in either form, as
 * many as there are, plus the whitespace around them. Returned unchanged (not
 * even trimmed) when it ends in none.
 *
 * Only the end, deliberately: a reference dcp appended always follows the
 * output it was appended to, and a general "drop any tag" rule would eat text
 * the operator typed. A compact line must follow a newline, because dcp always
 * writes one before it and a bare `@4@` could be someone's answer.
 *
 * This is what the question readers need (h #g194, h #g312). The digest
 * strips more, and differently, for reasons of its own (`withoutDcpRefs`).
 */
export function withoutTrailingDcpMessageRefs(text: string): string {
  let out = text
  let removed = false
  for (;;) {
    const trimmed = out.trimEnd()
    if (trimmed.endsWith("</dcp-message-id>")) {
      const start = trimmed.lastIndexOf("<dcp-message-id")
      if (start === -1 || !DCP_MESSAGE_ID_TAG_WHOLE.test(trimmed.slice(start))) break
      out = trimmed.slice(0, start)
      removed = true
      continue
    }
    if (trimmed.endsWith("@") || trimmed.endsWith("]")) {
      const lineStart = trimmed.lastIndexOf("\n") + 1
      if (lineStart === 0 || !DCP_COMPACT_REF_LINE.test(trimmed.slice(lineStart))) break
      out = trimmed.slice(0, lineStart)
      removed = true
      continue
    }
    break
  }
  return removed ? out.trimEnd() : text
}
