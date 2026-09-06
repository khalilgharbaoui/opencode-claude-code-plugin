/**
 * Unit tests for getClaudeUserMessage in src/message-builder.ts.
 *
 * Covers the v0.4.8 fix: tool-role messages (AI SDK V3 shape) must produce
 * tool_result content blocks instead of falling through to the "(empty)"
 * sentinel — otherwise opencode's outer agent loop hangs after every proxy
 * tool call, forcing the user to press "continue".
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import {
  compactConversationHistory,
  filterSideQuestionHistory,
  getClaudeUserMessage,
} from "./src/message-builder.js"

const p = (msgs: any[]) => msgs as any

function parsed(prompt: any) {
  return JSON.parse(getClaudeUserMessage(prompt))
}

test("tool-role tool-result produces tool_result block, not sentinel", () => {
  const out = parsed(
    p([
      { role: "user", content: "run bash" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            output: { type: "text", value: "hello from bash" },
          },
        ],
      },
    ]),
  )

  const blocks = out.message.content
  assert.equal(Array.isArray(blocks), true)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, "tool_result")
  assert.equal(blocks[0].tool_use_id, "call_1")
  // Must NOT be the "(empty)" sentinel.
  assert.notEqual(blocks[0].type, "text")
})

test("multiple tool-results in single tool-role message all flow through", () => {
  const out = parsed(
    p([
      { role: "user", content: "do both" },
      { role: "assistant", content: [{ type: "text", text: "running" }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_a",
            output: { type: "text", value: "a result" },
          },
          {
            type: "tool-result",
            toolCallId: "call_b",
            output: { type: "text", value: "b result" },
          },
        ],
      },
    ]),
  )

  const blocks = out.message.content
  assert.equal(blocks.length, 2)
  assert.deepEqual(
    blocks.map((b: any) => [b.type, b.tool_use_id]),
    [
      ["tool_result", "call_a"],
      ["tool_result", "call_b"],
    ],
  )
})

test("tool-role without tool-result parts still falls through to sentinel", () => {
  const out = parsed(
    p([
      { role: "user", content: "x" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "tool",
        content: [{ type: "something-else" }],
      },
    ]),
  )

  // No tool-result extracted → falls through to "(empty)" sentinel path
  // (correct behavior, matches hasNewUserContent's symmetry).
  const blocks = out.message.content
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, "text")
  assert.equal(blocks[0].text, "(empty)")
})

test("mixed user-text + tool-role both flow into the same content array", () => {
  const out = parsed(
    p([
      { role: "user", content: "first turn" },
      { role: "assistant", content: [{ type: "text", text: "running tool" }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            output: { type: "text", value: "tool output" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "follow-up question" }],
      },
    ]),
  )

  const blocks = out.message.content
  // Should have both the tool_result and the follow-up text, no sentinel.
  const types = blocks.map((b: any) => b.type)
  assert.ok(types.includes("tool_result"), `expected tool_result in ${types}`)
  assert.ok(types.includes("text"), `expected text in ${types}`)
  // No "(empty)" sentinel injected.
  const textBlock = blocks.find((b: any) => b.type === "text")
  assert.notEqual(textBlock.text, "(empty)")
})

// ---------------------------------------------------------------------------
// Compaction mode tests
// ---------------------------------------------------------------------------

function parsedCompaction(prompt: any) {
  return JSON.parse(
    getClaudeUserMessage(prompt as any, false, {
      compactionMode: true,
    }),
  )
}

test("compaction wraps transcript in <conversation_transcript> tag", () => {
  const out = parsedCompaction(
    p([
      { role: "user", content: "what's 2+2?" },
      { role: "assistant", content: [{ type: "text", text: "4" }] },
      {
        role: "user",
        content: [{ type: "text", text: "summarize this conversation" }],
      },
    ]),
  )

  const blocks = out.message.content
  const textBlock = blocks.find((b: any) => b.type === "text")
  assert.ok(textBlock, "expected a text block")
  assert.ok(
    textBlock.text.includes("<conversation_transcript>"),
    "expected transcript wrapper",
  )
  assert.ok(
    textBlock.text.includes("</conversation_transcript>"),
    "expected closing transcript tag",
  )
  assert.ok(
    !textBlock.text.includes("from a previous session that couldn't be resumed"),
    "should not use the fresh-session wrapper text",
  )
})

test("compaction transcript includes tool_use input, not just count", () => {
  const out = parsedCompaction(
    p([
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "running ls" },
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "Bash",
            input: { command: "ls -la /tmp/specific-path" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "Bash",
            output: {
              type: "text",
              value: "file1.txt\nfile2.txt\nspecific-content-here",
            },
          },
        ],
      },
      { role: "user", content: "summarize" },
    ]),
  )

  const transcript = out.message.content.find((b: any) => b.type === "text").text
  assert.ok(
    transcript.includes("tool_use:Bash"),
    "expected rendered tool_use with name",
  )
  assert.ok(
    transcript.includes("ls -la /tmp/specific-path"),
    "expected tool input rendered, not placeholder",
  )
  assert.ok(
    transcript.includes("specific-content-here"),
    "expected tool_result content rendered, not placeholder",
  )
  // Legacy placeholder text must NOT appear in compaction mode.
  assert.ok(
    !transcript.includes("[Called 1 tool(s)"),
    "should not use legacy placeholder",
  )
  assert.ok(
    !transcript.includes("[Received 1 tool result(s)]"),
    "should not use legacy placeholder",
  )
})

test("compaction clips long tool_result with truncation marker", () => {
  const longOutput = "x".repeat(15_000)
  const out = parsedCompaction(
    p([
      { role: "user", content: "do thing" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "Read",
            input: { file: "big.txt" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "Read",
            output: { type: "text", value: longOutput },
          },
        ],
      },
      { role: "user", content: "summarize" },
    ]),
  )

  const transcript = out.message.content.find((b: any) => b.type === "text").text
  assert.ok(
    transcript.includes("[truncated"),
    "expected truncation marker for over-cap tool_result",
  )
  // Bounded: must not contain the full 15k blob.
  assert.ok(
    transcript.length < 14_000,
    `transcript should be capped near 10k chars per tool_result, got ${transcript.length}`,
  )
})

test("compaction final user instruction follows the transcript", () => {
  const out = parsedCompaction(
    p([
      { role: "user", content: "what's up" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Your task is to summarize the conversation.",
          },
        ],
      },
    ]),
  )

  const blocks = out.message.content
  // Expect: [transcript-text-block, instruction-text-block]
  const texts = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text)
  assert.equal(texts.length, 2, `expected 2 text blocks, got ${texts.length}`)
  assert.ok(texts[0].includes("<conversation_transcript>"))
  assert.ok(texts[1].includes("Your task is to summarize"))
  // Synthesis instruction must NOT be embedded inside the transcript block.
  assert.ok(!texts[0].includes("Your task is to summarize"))
})

test("no thinking keyword is appended to the user message", () => {
  // Effort reaches the CLI as CLAUDE_CODE_EFFORT_LEVEL at spawn; the message
  // itself must carry none of the retired "(ultrathink)"-style hints.
  const out = JSON.parse(
    getClaudeUserMessage(p([{ role: "user", content: "hello" }]) as any, false),
  )
  const texts = out.message.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n")
  assert.ok(texts.includes("hello"))
  assert.ok(
    !/\((think( hard(er)?)?|megathink|ultrathink)\)/.test(texts),
    "no reasoning keyword may be injected into the message",
  )
})

test("AI SDK v4 image part carries its binary in part.image", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const out = parsed(
    p([
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this screenshot?" },
          { type: "image", image: png, mediaType: "image/png" },
        ],
      },
    ]),
  )

  const image = out.message.content.find((b: any) => b.type === "image")
  assert.ok(image, "image part must not be dropped")
  assert.equal(image.source.media_type, "image/png")
  assert.equal(image.source.data, png.toString("base64"))
})

test("part.data still wins when part.image is absent", () => {
  const out = parsed(
    p([
      {
        role: "user",
        content: [
          { type: "file", data: "aGVsbG8=", mediaType: "image/webp" },
        ],
      },
    ]),
  )

  const image = out.message.content.find((b: any) => b.type === "image")
  assert.ok(image, "data-carrying file part must still produce an image block")
  assert.equal(image.source.media_type, "image/webp")
  assert.equal(image.source.data, "aGVsbG8=")
})

test("fresh-session and compaction histories exclude aside exchanges, not subsequent work", () => {
  const prompt = p([
    { role: "user", content: "main task" },
    { role: "assistant", content: [{ type: "text", text: "main answer" }] },
    { role: "user", content: [{ type: "text", text: "/btw private aside" }] },
    { role: "assistant", content: [{ type: "text", text: "private answer" }] },
    { role: "user", content: "/btw" },
    { role: "assistant", content: [{ type: "text", text: "aside usage" }] },
    { role: "user", content: "ordinary next user" },
    { role: "assistant", content: [{ type: "text", text: "ordinary next answer" }] },
    { role: "user", content: "current instruction" },
  ])
  const original = structuredClone(prompt)
  for (const mode of ["fresh-session", "compaction"] as const) {
    const transcript = compactConversationHistory(prompt, { mode })!
    assert.match(transcript, /main task/)
    assert.match(transcript, /main answer/)
    assert.match(transcript, /ordinary next user/)
    assert.match(transcript, /ordinary next answer/)
    assert.doesNotMatch(transcript, /private|aside usage|\/btw|current instruction/)
    const message = JSON.parse(getClaudeUserMessage(prompt, true, { compactionMode: mode === "compaction" }))
    assert.doesNotMatch(JSON.stringify(message), /private|aside usage|\/btw/)
    assert.equal(message.message.content.at(-1).text, "current instruction")
  }
  assert.deepEqual(prompt, original, "history filtering must not mutate the prompt")
})

test("an unanswered aside never removes the following ordinary user or replays in its envelope", () => {
  const prompt = p([
    { role: "user", content: "main task" },
    { role: "assistant", content: [{ type: "text", text: "main answer" }] },
    { role: "user", content: "/btw unanswered aside" },
    { role: "user", content: "ordinary next user" },
  ])
  const message = JSON.parse(getClaudeUserMessage(prompt, true))
  assert.doesNotMatch(JSON.stringify(message), /unanswered aside|\/btw/)
  assert.equal(message.message.content.at(-1).text, "ordinary next user")
  assert.equal(filterSideQuestionHistory(prompt).at(-1), prompt.at(-1))
})

test("aside filtering preserves ordinary /btw mentions, mixed media, tools, and their replies", () => {
  const prompt = p([
    { role: "user", content: "explain /btw please" },
    { role: "assistant", content: [{ type: "text", text: "/btw is a command" }] },
    { role: "user", content: [{ type: "text", text: "/btw image question" }, { type: "image", image: "image data" }] },
    { role: "assistant", content: [{ type: "text", text: "image response" }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "call", output: { type: "text", value: "tool result" } }] },
    { role: "user", content: "summarize" },
  ])
  assert.deepEqual(filterSideQuestionHistory(prompt), prompt)
  const transcript = compactConversationHistory(prompt, { mode: "compaction" })!
  assert.match(transcript, /explain \/btw please/)
  assert.match(transcript, /image question/)
  assert.match(transcript, /image response/)
  assert.match(transcript, /tool result/)
})

test("consecutive and split aside responses stay excluded until the next user", () => {
  const nextUser = { role: "user", content: "main follow-up" }
  const nextAnswer = { role: "assistant", content: [{ type: "text", text: "main reply" }] }
  const prompt = p([
    { role: "user", content: "/btw first\nsecond line" },
    { role: "assistant", content: [{ type: "reasoning", text: "aside reasoning" }] },
    { role: "assistant", content: [{ type: "text", text: "aside response" }] },
    { role: "user", content: "/btw another" },
    { role: "assistant", content: [{ type: "text", text: "another aside response" }] },
    nextUser,
    nextAnswer,
  ])
  assert.deepEqual(filterSideQuestionHistory(prompt), [nextUser, nextAnswer])
})

// Issue #29 (@nic-lan): opencode runs some tools itself, notably the `task`
// call a `subtask: true` command dispatches. The resumed CLI session never
// emitted those `tool_use` blocks, so sending a `tool_result` for one is
// orphaned: Claude cannot resolve the id and the payload sitting in the
// envelope is unreachable. The result was a subagent that finished correctly
// while the main session saw no output at all.
const subtaskPrompt = () =>
  p([
    { role: "user", content: [{ type: "text", text: "Recall what we decided about X." }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Dispatching the subagent." },
        { type: "tool-call", toolCallId: "call_X", toolName: "task", input: { subagent_type: "general" } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_X",
          toolName: "task",
          output: { type: "text", value: "We decided X because of Y." },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "text", text: "Summarize the task tool output above and continue with your task." }],
    },
  ])

test("a tool result this CLI process never asked for is sent as text, not an orphaned tool_result", () => {
  const out = JSON.parse(
    getClaudeUserMessage(subtaskPrompt(), false, { cliToolCallIds: new Set<string>() }),
  )
  const blocks = out.message.content
  assert.equal(
    blocks.some((b: any) => b.type === "tool_result"),
    false,
    "an id the CLI never issued must not be sent back as a tool_result",
  )
  const rendered = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")
  assert.match(rendered, /We decided X because of Y\./, "the subagent's answer still reaches the model")
  assert.match(rendered, /<opencode_tool_result tool="task">/, "and it says what produced it")
  assert.ok(
    rendered.indexOf("We decided X because of Y.") < rendered.indexOf("Summarize the task tool output above"),
    "the output has to precede the instruction that calls it 'above'",
  )
})

test("a tool result this CLI process is waiting on is still a real tool_result block", () => {
  const out = JSON.parse(
    getClaudeUserMessage(subtaskPrompt(), false, { cliToolCallIds: new Set(["call_X"]) }),
  )
  const result = out.message.content.find((b: any) => b.type === "tool_result")
  assert.ok(result, "the proxy round-trip depends on this block, so the gate must let it through")
  assert.equal(result.tool_use_id, "call_X")
  assert.match(result.content, /We decided X because of Y\./)
})

test("the fresh-session history keeps tool inputs and result bodies", () => {
  const history = compactConversationHistory(subtaskPrompt())
  assert.ok(history, "there is prior conversation to render")
  assert.match(history!, /We decided X because of Y\./, "the result body survives, not just a count")
  assert.match(history!, /\[tool_use:task\(/, "and the call that produced it is named with its input")
  assert.doesNotMatch(history!, /Called 1 tool\(s\)/, "the lossy placeholder is gone")
})
