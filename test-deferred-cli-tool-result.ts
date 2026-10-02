/**
 * A step that ends on a proxied tool call must still answer the CLI-executed
 * tool calls of the same assistant message.
 *
 * The CLI answers one assistant message's tool calls with ONE `user` frame, so
 * when any of them is proxied it withholds its own results until the plugin
 * sends the proxied one back. That cannot happen before the step ends, and the
 * per-turn `toolCallsById` is gone by the time the result arrives on the next
 * stream, so the call part was left without a result forever. opencode 2.0.22
 * reports that as "Provider did not return a tool result" on the row; opencode
 * 1.18.34 leaves it pending. Measured live on CLI 2.1.286 (h #g190).
 *
 * Usage: npx tsx --test test-deferred-cli-tool-result.ts
 */
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { createClaudeCode } from "./src/index.js"
import { deleteActiveProcess, sessionKey } from "./src/session-manager.js"
import { CLI_RESULT_DEFERRED_OUTPUT } from "./src/turn-controller.js"

const CLI_TOOL_ID = "toolu_cli_side_mcp"
const CLI_TOOL_NAME = "mcp__demo_server__do_thing"
const PROXY_TOOL_ID = "toolu_proxied_bash"

/**
 * A fake `claude` that emits one CLI-executed tool call and one proxied tool
 * call in the same assistant message, then calls the proxy over HTTP and goes
 * quiet, exactly as the real CLI does: no `tool_result` for its own call and
 * no terminal `result`, because it is waiting for opencode's answer.
 */
function createFakeCli(closeBlock: boolean, refuseEarly = false) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-deferred-cli-result-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const source = `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")

if (process.argv.includes("--version")) {
  process.stdout.write("2.1.142\\n")
  process.exit(0)
}
// The flag probe runs \`--help\`, which must not look like a broken binary.
if (process.argv.includes("--help")) {
  process.stdout.write("--plugin-dir\\n--fork-session\\n--thinking-display\\n")
  process.exit(0)
}

const args = process.argv.slice(2)
const configIndex = args.indexOf("--mcp-config")
let proxyUrl
let proxyHeaders = {}
if (configIndex >= 0) {
  for (let index = configIndex + 1; index < args.length; index++) {
    const value = args[index]
    if (value.startsWith("--")) break
    try {
      const config = JSON.parse(fs.readFileSync(value, "utf8"))
      const entry = config.mcpServers?.opencode_proxy
      proxyUrl = entry?.url ?? proxyUrl
      proxyHeaders = entry?.headers ?? proxyHeaders
    } catch {}
  }
}
if (!proxyUrl) {
  process.stderr.write("missing opencode proxy URL\\n")
  process.exit(2)
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
  event({ type: "message_start", message: { role: "assistant" } })

  // Block 0: a tool the CLI runs itself.
  event({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: ${JSON.stringify(CLI_TOOL_ID)}, name: ${JSON.stringify(CLI_TOOL_NAME)} },
  })
  event({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"query":"probe"}' },
  })
  // Left open when \`closeBlock\` is false: the CLI starts the block, runs the
  // tool, and emits \`content_block_stop\` only with the assistant frame that
  // closes the whole batch, which it is holding for the proxied call. That is
  // the shape measured live, twice.
  if (${JSON.stringify(closeBlock)}) event({ type: "content_block_stop", index: 0 })

  // Block 1: a tool opencode has to run, in the SAME assistant message.
  event({
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: ${JSON.stringify(PROXY_TOOL_ID)}, name: "mcp__opencode_proxy__bash" },
  })
  event({
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"command":"echo probe"}' },
  })
  event({ type: "content_block_stop", index: 1 })
  event({ type: "message_delta", delta: { stop_reason: "tool_use" } })
  event({ type: "message_stop" })

  // A refused tool answers itself, and the refusal arrives BEFORE the block's
  // close: the shape measured on 2.1.286 with --disallowedTools. The step
  // still ends on the proxied call, so this is the case where the result is
  // already out and must not be answered a second time.
  if (${JSON.stringify(refuseEarly)}) {
    emit({
      type: "user",
      session_id: "fake-session",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: ${JSON.stringify(CLI_TOOL_ID)},
          is_error: true,
          content: "<tool_use_error>Error: No such tool available.</tool_use_error>",
        }],
      },
    })
    event({ type: "content_block_stop", index: 0 })
  }

  // The proxied call. Deliberately not awaited and never followed by a
  // \`tool_result\` for the CLI's own call: the real CLI holds that frame
  // until this one is answered.
  fetch(proxyUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...proxyHeaders },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "bash", arguments: { command: "echo probe" } },
    }),
  }).catch(() => {})
})
`
  writeFileSync(cliPath, source)
  chmodSync(cliPath, 0o755)
  return { cliPath, cwd }
}

async function streamOneStep(closeBlock: boolean, refuseEarly = false) {
  const fake = createFakeCli(closeBlock, refuseEarly)
  const modelId = `claude-test-deferred-cli-result-${closeBlock ? "closed" : "open"}${refuseEarly ? "-refused" : ""}`
  const sk = sessionKey(fake.cwd, `${modelId}::tools::default::context=["claude-code",null]`)
  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: ["Bash"],
    }).languageModel(modelId)

    const response = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Read it and echo it." }] }],
      tools: [
        {
          type: "function",
          name: "bash",
          description: "Run a command",
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

async function assertStepAnswersItsCliCall(closeBlock: boolean) {
  const parts = await streamOneStep(closeBlock)

  const finish = parts.find((part) => part.type === "finish")
  assert.ok(finish, "the step must finish")
  assert.equal(
    finish.finishReason?.unified ?? finish.finishReason,
    "tool-calls",
    "the step ends on the proxied call",
  )

  const cliCall = parts.find(
    (part) => part.type === "tool-call" && part.toolCallId === CLI_TOOL_ID,
  )
  assert.ok(cliCall, "the CLI-executed call must reach opencode")
  assert.equal(cliCall.toolName, "demo_server_do_thing")

  const cliResult = parts.find(
    (part) => part.type === "tool-result" && part.toolCallId === CLI_TOOL_ID,
  )
  assert.ok(
    cliResult,
    "without a result opencode 2.x reports 'Provider did not return a tool result'",
  )
  assert.equal(
    cliResult.toolName,
    cliCall.toolName,
    "a result must carry its call's mapped name (h #g: Tool result name changed)",
  )
  assert.equal(cliResult.result?.output, CLI_RESULT_DEFERRED_OUTPUT)
  assert.notEqual(cliResult.isError, true, "nothing failed, so the row must not read as an error")

  // The placeholder has to land before the finish, or opencode has already
  // judged the step by the time it arrives.
  assert.ok(
    parts.indexOf(cliResult) < parts.indexOf(finish),
    "the result must be enqueued before the finish part",
  )

  // The proxied call is still the thing opencode is being asked to run, and
  // it must NOT be given a result here.
  const proxyCall = parts.find((part) => part.type === "tool-call" && part.toolName === "bash")
  assert.ok(proxyCall, "the proxied call must reach opencode")
  const proxyResult = parts.find(
    (part) => part.type === "tool-result" && part.toolCallId === proxyCall.toolCallId,
  )
  assert.equal(proxyResult, undefined, "opencode runs the proxied call; the plugin must not answer it")

  // One call part per id, whichever stage the block was closed out at.
  assert.equal(
    parts.filter((part) => part.type === "tool-call" && part.toolCallId === CLI_TOOL_ID).length,
    1,
    "the CLI-executed call must not be emitted twice",
  )
  assert.equal(
    parts.filter((part) => part.type === "tool-result" && part.toolCallId === CLI_TOOL_ID).length,
    1,
    "the placeholder must not be emitted twice",
  )
}

test("a closed CLI-executed block that has no result yet is answered", {
  timeout: 30_000,
}, async () => {
  await assertStepAnswersItsCliCall(true)
})

test("a CLI-executed block still open when the step ends is answered", {
  timeout: 30_000,
}, async () => {
  await assertStepAnswersItsCliCall(false)
})

test("a result that already went out is not answered again at the step's end", {
  timeout: 30_000,
}, async () => {
  // The CLI refuses its own tool, so the result arrives ahead of the block's
  // close, and the step still ends on the proxied call. Both closeout paths
  // must leave it alone: a second `tool-result` for one id is exactly what
  // opencode aborts a part over.
  const parts = await streamOneStep(false, true)

  const results = parts.filter(
    (part) => part.type === "tool-result" && part.toolCallId === CLI_TOOL_ID,
  )
  assert.equal(results.length, 1, "exactly one result for the refused call")
  assert.equal(results[0].isError, true, "the CLI's refusal keeps its error flag")
  assert.notEqual(
    results[0].result?.output,
    CLI_RESULT_DEFERRED_OUTPUT,
    "the real refusal text must survive, not be replaced by the placeholder",
  )
  assert.equal(
    parts.filter((part) => part.type === "tool-call" && part.toolCallId === CLI_TOOL_ID).length,
    1,
    "and exactly one call part",
  )
})
