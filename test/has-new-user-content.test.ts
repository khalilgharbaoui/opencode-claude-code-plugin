/**
 * Unit tests for hasNewUserContent in src/claude-code-language-model.ts.
 */
import "./isolate.js"
import { test } from "node:test"
import assert from "node:assert/strict"

import { hasNewUserContent } from "../src/claude-code-language-model.js"

const p = (msgs: any[]) => msgs as any

test("tool-role message with tool-result counts as new content", () => {
  assert.equal(
    hasNewUserContent(
      p([
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "x",
              output: { type: "text", value: "done" },
            },
          ],
        },
      ]),
    ),
    true,
  )
})

test("assistant-ended prompt still returns false (49345e3 preserved)", () => {
  assert.equal(
    hasNewUserContent(
      p([
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ]),
    ),
    false,
  )
})

test("empty tool-role content does not falsely return true", () => {
  assert.equal(
    hasNewUserContent(
      p([
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "tool", content: [] },
      ]),
    ),
    false,
  )
})

test("tool-role without tool-result parts is not new content", () => {
  assert.equal(
    hasNewUserContent(
      p([
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "tool", content: [{ type: "other" } as any] },
      ]),
    ),
    false,
  )
})

test("trailing user message after tool-result is new content", () => {
  assert.equal(
    hasNewUserContent(
      p([
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "x",
              output: { type: "text", value: "done" },
            },
          ],
        },
        { role: "user", content: "more" },
      ]),
    ),
    true,
  )
})
