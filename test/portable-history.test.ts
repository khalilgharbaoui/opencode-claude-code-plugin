import "./isolate.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import { flattenCliToolParts, toolResultText } from "../src/portable-history.js"

// The shape opencode 2.2.6 handed the `context` hook for a session whose
// Claude turn ran Read (measured 2026-11-12): no providerMetadata on replay.
function claudeTurn() {
  return [
    { id: "msg_1", role: "user", content: [{ type: "text", text: "count the lines" }] },
    {
      id: "msg_2",
      role: "assistant",
      content: [
        { type: "tool-call", id: "toolu_01A", name: "read", input: { filePath: "notes.txt" }, providerExecuted: true },
        {
          type: "tool-result",
          id: "toolu_01A",
          name: "read",
          result: { type: "text", value: "alpha\nbeta\ngamma" },
          providerExecuted: true,
        },
        { type: "reasoning", text: "three lines" },
        { type: "text", text: "3" },
      ],
    },
  ]
}

test("Claude CLI tool parts become assistant text, in order, and nothing else changes", () => {
  const messages = claudeTurn()
  const user = messages[0]
  const [, , reasoning, answer] = messages[1].content

  assert.equal(flattenCliToolParts(messages), 2)

  assert.equal(messages[0], user, "a user message is left as it was")
  assert.deepEqual(messages[1].content, [
    { type: "text", text: '[Ran tool read with input {"filePath":"notes.txt"}]' },
    { type: "text", text: "[Result of tool read]\nalpha\nbeta\ngamma" },
    reasoning,
    answer,
  ])
})

test("flattening is deterministic, so a prompt cache keeps matching across turns", () => {
  const first = claudeTurn()
  const second = claudeTurn()
  flattenCliToolParts(first)
  flattenCliToolParts(second)
  assert.deepEqual(first, second)
})

test("another provider's own server tools keep their structure", () => {
  // Anthropic server and MCP tools, and OpenAI Responses tools, are
  // provider-executed too, under their own id formats.
  const anthropicSearch = {
    type: "tool-result",
    id: "srvtoolu_01B",
    name: "web_search",
    result: { type: "json", value: [{ url: "https://example.com" }] },
    providerExecuted: true,
  }
  const anthropicMcp = { type: "tool-call", id: "mcptoolu_01C", name: "lookup", input: {}, providerExecuted: true }
  const openaiSearch = { type: "tool-call", id: "ws_123", name: "web_search", input: {}, providerExecuted: true }
  const messages = [{ role: "assistant", content: [anthropicSearch, anthropicMcp, openaiSearch] }]
  const before = structuredClone(messages)

  assert.equal(flattenCliToolParts(messages), 0)
  assert.deepEqual(messages, before)
})

test("a client tool call and a tool message are untouched", () => {
  const clientCall = { type: "tool-call", id: "toolu_01D", name: "edit", input: {}, providerExecuted: false }
  const messages = [
    { role: "assistant", content: [clientCall] },
    { role: "tool", content: [{ type: "tool-result", id: "toolu_01D", providerExecuted: true }] },
  ]
  const before = structuredClone(messages)

  assert.equal(flattenCliToolParts(messages), 0)
  assert.deepEqual(messages, before)
})

test("the AI SDK's toolCallId field is recognised too", () => {
  const messages = [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "toolu_01E", name: "grep", input: { pattern: "x" }, providerExecuted: true }] },
  ]
  assert.equal(flattenCliToolParts(messages), 1)
})

test("odd input is ignored rather than thrown on", () => {
  assert.equal(flattenCliToolParts(undefined), 0)
  assert.equal(flattenCliToolParts([null, { role: "assistant" }, { role: "assistant", content: "text" }]), 0)
  assert.equal(flattenCliToolParts([{ role: "assistant", content: [null, { type: "tool-call", providerExecuted: true }] }]), 0)
})

test("tool result text covers the result shapes", () => {
  assert.equal(toolResultText("plain"), "plain")
  assert.equal(toolResultText({ type: "text", value: "v" }), "v")
  assert.equal(toolResultText({ type: "error-text", value: "boom" }), "boom")
  assert.equal(toolResultText({ type: "json", value: { a: 1 } }), '{"a":1}')
  assert.equal(toolResultText({ output: "out", title: "read", metadata: {} }), "out")
  assert.equal(
    toolResultText({ type: "content", value: [{ type: "text", text: "seen" }, { type: "media", data: "AAAA", mediaType: "image/png" }] }),
    "seen\n[media omitted]",
    "binary content is named, never inlined",
  )
})
