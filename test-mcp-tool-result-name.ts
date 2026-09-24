/**
 * A CLI-executed call and its result must reach opencode under the same tool
 * name; otherwise opencode aborts the turn with "Tool result name changed".
 *
 * Usage: npx tsx --test test-mcp-tool-result-name.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClaudeCode } from "./src/index.js"
import { deleteActiveProcess, sessionKey } from "./src/session-manager.js"

/** A fake `claude` that streams one tool call it ran itself, plus its result. */
function createFakeToolCallCli(toolName: string, toolUseId: string) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-tool-result-name-"))
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

  // The CLI runs the tool itself and streams the call.
  event({ type: "message_start", message: { role: "assistant" } })
  event({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: ${JSON.stringify(toolUseId)}, name: ${JSON.stringify(toolName)} },
  })
  event({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"query":"probe"}' },
  })
  event({ type: "content_block_stop", index: 0 })

  // ...then reports its result for the same tool_use id.
  emit({
    type: "user",
    session_id: "fake-session",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: ${JSON.stringify(toolUseId)}, content: "probe result" },
      ],
    },
  })

  // The answer that follows, then the turn's terminal result.
  event({ type: "message_start", message: { role: "assistant" } })
  event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
  event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "PROBE-OK" } })
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

async function streamToolPairs(toolName: string, toolUseId: string) {
  const fake = createFakeToolCallCli(toolName, toolUseId)
  const modelId = "claude-test-tool-result-name"
  const sk = sessionKey(fake.cwd, `${modelId}::tools::default::context=["claude-code",null]`)

  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: [],
    }).languageModel(modelId)

    const response = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Run the probe tool." }] }],
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

test("an MCP tool result carries the same mapped name as its call", async () => {
  const id = "toolu_mcp_probe"
  const parts = await streamToolPairs("mcp__demo_server__do_thing", id)

  const call = parts.find((part) => part.type === "tool-call" && part.toolCallId === id)
  const result = parts.find((part) => part.type === "tool-result" && part.toolCallId === id)

  assert.ok(call, "the CLI-executed call must reach opencode")
  assert.equal(call.toolName, "demo_server_do_thing", "the call keeps the registry-shaped name")
  assert.ok(result, "the CLI-executed result must reach opencode")
  assert.equal(
    result.toolName,
    call.toolName,
    "opencode aborts the turn with 'Tool result name changed' when these differ",
  )
})

test("a lowercased CLI tool keeps its mapped name on the result too", async () => {
  const id = "toolu_read_probe"
  const parts = await streamToolPairs("Read", id)

  const call = parts.find((part) => part.type === "tool-call" && part.toolCallId === id)
  const result = parts.find((part) => part.type === "tool-result" && part.toolCallId === id)

  assert.ok(call)
  assert.equal(call.toolName, "read")
  assert.ok(result)
  assert.equal(result.toolName, call.toolName)
})
