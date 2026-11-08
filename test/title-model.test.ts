import { test } from "node:test"
import assert from "node:assert/strict"
import { buildTitleInput, cleanTitle } from "../src/title-model.js"

test("the title input carries the title agent's system prompt and the conversation", () => {
  const input = buildTitleInput([
    { role: "system", content: "Name the session in two to four words." },
    {
      role: "user",
      content: [{ type: "text", text: "Here is the first message of the conversation:\n<message>How do I rename chats</message>" }],
    },
  ])
  assert.match(input, /<instructions>\nName the session in two to four words\.\n<\/instructions>/)
  assert.match(input, /<user>\nHere is the first message/)
})

test("the title input keeps the end of a long conversation", () => {
  const input = buildTitleInput([
    { role: "user", content: [{ type: "text", text: "x".repeat(20_000) }] },
    { role: "user", content: [{ type: "text", text: "the last message" }] },
  ])
  assert.ok(input.length < 13_000)
  assert.match(input, /the last message/)
})

test("cleanTitle strips quotes, a label and a trailing period", () => {
  assert.equal(cleanTitle('"Chat renaming bug."'), "Chat renaming bug")
  assert.equal(cleanTitle("Title: Plan mode bug\nextra"), "Plan mode bug")
  assert.equal(cleanTitle("  \n "), undefined)
})
