import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClaudeCode } from "./src/index.js"
import { deleteActiveProcess, sessionKey } from "./src/session-manager.js"

// Claude CLI restarts content-block indices at 0 on every assistant message,
// and one turn holds several of them (tool_use -> tool_result -> answer).
// This fake emits a tool_use at index 0, then reuses index 0 for the answer
// text in the next message, which is the exact shape that made a subagent's
// `task` call report "Tool execution aborted" while the child answered fine.
function createFakeIndexReuseCli() {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-block-index-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const source = `#!/usr/bin/env node
const readline = require("node:readline")

if (process.argv.includes("--version")) {
  process.stdout.write("2.1.142\\n")
  process.exit(0)
}

const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
const event = (value) =>
  emit({ type: "stream_event", session_id: "fake-session", event: value })

const rl = readline.createInterface({ input: process.stdin })
let answered = false
rl.on("line", () => {
  if (answered) return
  answered = true

  emit({ type: "system", subtype: "init", session_id: "fake-session" })

  // Assistant message 1: tool_use occupies block index 0.
  event({ type: "message_start", message: { role: "assistant" } })
  event({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_probe", name: "Read" },
  })
  event({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"file_path":"/tmp/probe.json"}' },
  })
  event({ type: "content_block_stop", index: 0 })

  // Claude ran Read itself and reports the result.
  emit({
    type: "user",
    session_id: "fake-session",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_probe", content: "probe file body" },
      ],
    },
  })

  // Assistant message 2: the answer text REUSES block index 0.
  event({ type: "message_start", message: { role: "assistant" } })
  event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
  event({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "PROBE-OK" },
  })
  event({ type: "content_block_stop", index: 0 })
  event({ type: "message_delta", delta: { stop_reason: "end_turn" } })

  emit({
    type: "result",
    subtype: "success",
    session_id: "fake-session",
    is_error: false,
    result: "PROBE-OK",
  })
})
`
  writeFileSync(cliPath, source)
  chmodSync(cliPath, 0o755)
  return { cliPath, cwd }
}

async function streamIndexReuse() {
  const fake = createFakeIndexReuseCli()
  const modelId = "claude-test-block-index"
  const sk = sessionKey(
    fake.cwd,
    `${modelId}::tools::default::context=["claude-code",null]`,
  )

  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: [],
    }).languageModel(modelId)

    const response = await model.doStream({
      prompt: [
        { role: "user", content: [{ type: "text", text: "Read the probe file." }] },
      ],
      // Presence of tools is what selects the real streaming path; without it
      // doStream falls through to the no-tools title stub.
      tools: [
        {
          type: "function",
          name: "read",
          description: "Read a file",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    } as any)

    const parts: any[] = []
    for await (const part of response.stream) parts.push(part)
    return parts
  } finally {
    deleteActiveProcess(sk)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
}

test("a reused content-block index does not re-emit a completed tool call", async () => {
  const parts = await streamIndexReuse()

  const toolCalls = parts.filter(
    (part) => part.type === "tool-call" && part.toolCallId === "toolu_probe",
  )
  // Without the toolCallMap.delete(idx) at content_block_stop this is 2: the
  // answer text's block_stop in message 2 finds the stale message-1 entry at
  // the same index. opencode then holds a second part for a callID it already
  // completed, never gets a result for it, and aborts it at stream end.
  assert.equal(
    toolCalls.length,
    1,
    `expected exactly one tool-call for toolu_probe, got ${toolCalls.length}`,
  )

  const toolResults = parts.filter(
    (part) => part.type === "tool-result" && part.toolCallId === "toolu_probe",
  )
  assert.equal(toolResults.length, 1)

  // The answer text still comes through, and the turn still ends cleanly.
  const text = parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
  assert.match(text, /PROBE-OK/)
})
