/**
 * opencode-dcp's trailing message references (h #g312): every form dcp 3.2.0's
 * `formatMessageIdTag` writes comes off the end of a tool output, and nothing
 * else does. The question readers that use it are covered in
 * `test/subagent-dispatch.test.ts` and `test/account-failover.test.ts`; the
 * digest's own, wider strip in `test/session-fork.test.ts`.
 *
 * Usage: npx tsx --test test/dcp-message-refs.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { test } from "node:test"

import { withoutTrailingDcpMessageRefs } from "../src/dcp-message-refs.js"

const SENTENCE =
  'User has answered your questions: "q"="claude-opus-5-5 / max". You can now continue with the user\'s answers in mind.'

test("every compact form dcp writes comes off the end", () => {
  // `formatMessageIdTag(ref, attributes, "compact")`: "\n" + ref, plus
  // " [priority]" when there is one, and "\n@blocked@" for a protected message.
  for (const ref of ["@1044@", "@4@", "@b3@", "@blocked@", "@1044@ [high]", "@7@ [low priority]"]) {
    assert.equal(withoutTrailingDcpMessageRefs(`${SENTENCE}\n${ref}`), SENTENCE, ref)
  }
})

test("every xml form dcp writes comes off the end, attributes and BLOCKED included", () => {
  for (const tag of [
    "<dcp-message-id>m0795</dcp-message-id>",
    '<dcp-message-id priority="high">m0004</dcp-message-id>',
    "<dcp-message-id>BLOCKED</dcp-message-id>",
    "<dcp-message-id>b3</dcp-message-id>",
  ]) {
    assert.equal(withoutTrailingDcpMessageRefs(`${SENTENCE}\n${tag}`), SENTENCE, tag)
  }
})

test("several references and the whitespace around them all come off", () => {
  assert.equal(
    withoutTrailingDcpMessageRefs(`${SENTENCE}\n@12@\n<dcp-message-id>m1</dcp-message-id>\n@13@ [high]\n  `),
    SENTENCE,
  )
})

test("text with no reference at its end is returned exactly, untrimmed", () => {
  for (const text of [SENTENCE, `${SENTENCE}\n`, "yes", "  padded  ", ""]) {
    assert.equal(withoutTrailingDcpMessageRefs(text), text)
  }
})

test("only a reference at the end goes, and a compact one needs its own line", () => {
  // In the middle: an answer that mentions a reference is still the answer.
  const middle = `${SENTENCE.replace("claude-opus-5-5 / max", "@4@ please")}`
  assert.equal(withoutTrailingDcpMessageRefs(middle), middle)
  // A bare `@4@` with no newline in front could be what someone typed.
  assert.equal(withoutTrailingDcpMessageRefs("@4@"), "@4@")
  // Shapes dcp never writes stay.
  for (const text of [`${SENTENCE}\n@abc@`, `${SENTENCE}\n@4@ extra`, `${SENTENCE}\n[high]`, `${SENTENCE}\n@@`]) {
    assert.equal(withoutTrailingDcpMessageRefs(text), text, text)
  }
  // A bare answer followed by a reference reads as the answer.
  assert.equal(withoutTrailingDcpMessageRefs("yes\n@1044@"), "yes")
})
