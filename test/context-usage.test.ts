/**
 * The usage a `finish` part reports is what opencode reads as the context the
 * conversation occupies, and opencode compacts on it. The CLI's terminal
 * `result` sums every API call the turn made, so a tool-heavy turn read as
 * several times its real context. These tests drive a fake `claude` through a
 * real `doStream` and assert on the finish part opencode receives.
 *
 * Usage: npx tsx --test test/context-usage.test.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClaudeCode } from "../src/index.js"
import { getPendingProxyCalls, resolvePendingProxyCallById } from "../src/proxy-broker.js"
import { deleteActiveProcess, sessionKey } from "../src/session-manager.js"
import { contextUsageMetadata, lastCallContextUsage, toUsage } from "../src/usage.js"
import type { ClaudeStreamMessage } from "../src/types.js"

const SESSION = "fake-session"

/** A fake `claude` that replays a fixed line sequence on the first stdin write. */
function createFakeCli(lines: unknown[]) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-context-usage-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const source = `#!/usr/bin/env node
const readline = require("node:readline")

if (process.argv.includes("--version")) {
  process.stdout.write("2.1.281\\n")
  process.exit(0)
}

const LINES = ${JSON.stringify(lines)}
const rl = readline.createInterface({ input: process.stdin })
let answered = false
rl.on("line", () => {
  if (answered) return
  answered = true
  for (const line of LINES) process.stdout.write(JSON.stringify(line) + "\\n")
})
`
  writeFileSync(cliPath, source)
  chmodSync(cliPath, 0o755)
  return { cliPath, cwd }
}

const TASK_INPUT = {
  description: "Inspect provider flow",
  prompt: "Verify the provider delegates this task through opencode.",
  subagent_type: "general",
}

/**
 * A fake `claude` that makes one proxied `task` call. `mid-turn` never sends a
 * `result`, which is the ordinary proxied-tool boundary: the CLI is parked
 * inside the MCP call. `result-first` sends the `result` and then the call,
 * so the tool-call finish is written after the result arrived.
 */
function createFakeProxyCli(
  mode: "mid-turn" | "result-first",
  options: {
    usage?: ClaudeStreamMessage["usage"] | null
    afterAssistant?: unknown[]
  } = {},
) {
  const callUsage = options.usage === undefined
    ? { input_tokens: 9, cache_read_input_tokens: 150000, cache_creation_input_tokens: 600, output_tokens: 40 }
    : options.usage
  const cwd = mkdtempSync(join(tmpdir(), "opencode-context-usage-proxy-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const source = `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")

if (process.argv.includes("--version")) {
  process.stdout.write("2.1.281\\n")
  process.exit(0)
}

const args = process.argv.slice(2)
const configIndex = args.indexOf("--mcp-config")
let proxyUrl
let proxyHeaders = {}
for (let index = configIndex + 1; configIndex >= 0 && index < args.length; index++) {
  if (args[index].startsWith("--")) break
  try {
    const entry = JSON.parse(fs.readFileSync(args[index], "utf8")).mcpServers?.opencode_proxy
    proxyUrl = entry?.url ?? proxyUrl
    proxyHeaders = entry?.headers ?? proxyHeaders
  } catch {}
}

const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
const callTask = () =>
  fetch(proxyUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...proxyHeaders },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "task", arguments: ${JSON.stringify(TASK_INPUT)} },
    }),
  })

let handled = false
readline.createInterface({ input: process.stdin }).on("line", () => {
  if (handled) return
  handled = true
  emit({ type: "system", subtype: "init", session_id: "${SESSION}" })
  emit({
    type: "assistant",
    session_id: "${SESSION}",
    message: {
      role: "assistant",
      stop_reason: "tool_use",
      content: [{
        type: "tool_use",
        id: "claude-proxy-task",
        name: "mcp__opencode_proxy__task",
        input: ${JSON.stringify(TASK_INPUT)},
      }],
      usage: ${JSON.stringify(callUsage)},
    },
  })
  for (const frame of ${JSON.stringify(options.afterAssistant ?? [])}) emit(frame)
  if (${JSON.stringify(mode)} === "result-first") {
    emit({
      type: "result",
      subtype: "success",
      session_id: "${SESSION}",
      is_error: false,
      num_turns: 2,
      total_cost_usd: 0.5,
      usage: {
        input_tokens: 20,
        cache_read_input_tokens: 300000,
        cache_creation_input_tokens: 5000,
        output_tokens: 90,
        iterations: [],
      },
    })
    setTimeout(() => void callTask().catch(() => {}), 25)
    return
  }
  void callTask().catch(() => {})
})
`
  writeFileSync(cliPath, source)
  chmodSync(cliPath, 0o755)
  return { cliPath, cwd }
}

async function streamParts(
  fake: { cliPath: string; cwd: string },
  settings: Record<string, unknown> = {},
): Promise<any[]> {
  const modelId = "claude-test-context-usage"
  const sk = sessionKey(fake.cwd, `${modelId}::tools::default::context=["claude-code",null]`)
  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: [],
      ...settings,
    }).languageModel(modelId)

    const response = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      // Presence of tools is what selects the real streaming path.
      tools: [
        {
          type: "function",
          name: "read",
          description: "Read a file",
          inputSchema: { type: "object", properties: {} },
        },
        {
          type: "function",
          name: "task",
          description: "Delegate work to an opencode subagent",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    } as any)

    const parts: any[] = []
    for await (const part of response.stream) parts.push(part)
    return parts
  } finally {
    for (const call of getPendingProxyCalls(sk)) {
      resolvePendingProxyCallById(call.toolCallId, { kind: "text", text: "test cleanup" })
    }
    deleteActiveProcess(sk)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
}

function onlyFinish(parts: any[]) {
  const finishes = parts.filter((part) => part.type === "finish")
  assert.equal(finishes.length, 1)
  return finishes[0]
}

const init = { type: "system", subtype: "init", session_id: SESSION, tools: ["Read"] }
const streamEvent = (event: unknown) => ({ type: "stream_event", session_id: SESSION, event })

/**
 * One API call of a tool-using turn as the CLI streams it with
 * `--include-partial-messages`: the stream events, then the whole `assistant`
 * frame, whose input and cache counters are final while `output_tokens` is
 * only what had been generated when the frame was written.
 */
function readCall(id: string, usage: Record<string, number>) {
  return [
    streamEvent({ type: "message_start", message: { role: "assistant" } }),
    streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name: "Read" },
    }),
    streamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"file_path":"/tmp/probe"}' },
    }),
    streamEvent({ type: "content_block_stop", index: 0 }),
    {
      type: "assistant",
      session_id: SESSION,
      message: {
        role: "assistant",
        model: "claude-opus-5-5",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id, name: "Read", input: { file_path: "/tmp/probe" } }],
        usage,
      },
    },
    {
      type: "user",
      session_id: SESSION,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "body" }] },
    },
  ]
}

function answerCall(text: string, usage?: Record<string, number>) {
  return [
    streamEvent({ type: "message_start", message: { role: "assistant" } }),
    streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    streamEvent({ type: "content_block_stop", index: 0 }),
    streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    {
      type: "assistant",
      session_id: SESSION,
      message: {
        role: "assistant",
        model: "claude-opus-5-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text }],
        ...(usage ? { usage } : {}),
      },
    },
  ]
}

test("a multi-call turn reports the last call's context, not the sum over the turn", async () => {
  // The CLI's `result.usage` is these three calls added together. Its
  // `iterations` is the last response's server-side field, normally empty,
  // so it says nothing about the calls.
  const turnTotal = {
    input_tokens: 15,
    cache_read_input_tokens: 330_000,
    cache_creation_input_tokens: 4_300,
    output_tokens: 750,
    iterations: [],
  }
  const parts = await streamParts(
    createFakeCli([
      init,
      ...readCall("toolu_1", {
        input_tokens: 3,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 2_000,
        output_tokens: 1,
      }),
      ...readCall("toolu_2", {
        input_tokens: 5,
        cache_read_input_tokens: 110_000,
        cache_creation_input_tokens: 1_500,
        output_tokens: 1,
      }),
      ...answerCall("done", {
        input_tokens: 7,
        cache_read_input_tokens: 120_000,
        cache_creation_input_tokens: 800,
        output_tokens: 1,
      }),
      {
        type: "result",
        subtype: "success",
        session_id: SESSION,
        is_error: false,
        result: "done",
        num_turns: 3,
        total_cost_usd: 0.4321,
        usage: turnTotal,
      },
    ]),
  )

  const finish = onlyFinish(parts)
  assert.equal(finish.finishReason.unified, "stop")
  assert.equal(finish.usage.inputTokens.total, 7 + 120_000 + 800)
  assert.equal(finish.usage.inputTokens.noCache, 7)
  assert.equal(finish.usage.inputTokens.cacheRead, 120_000)
  assert.equal(finish.usage.inputTokens.cacheWrite, 800)
  // Output is every generation the turn made, as the interactive transport
  // already reports it.
  assert.equal(finish.usage.outputTokens.total, 750)
  // opencode falls back to this when the usage carries no cache write, so it
  // must say the same thing the usage does.
  assert.equal(finish.providerMetadata.anthropic.cacheCreationInputTokens, 800)
  // The turn's true totals and cost are still there for anyone who wants them.
  assert.deepEqual(finish.providerMetadata["claude-code"].usage, turnTotal)
  assert.equal(finish.providerMetadata["claude-code"].costUsd, 0.4321)
  assert.deepEqual(finish.providerMetadata["claude-code"].contextUsage, {
    source: "last-api-call",
    inputTokens: 120_807,
    nonCachedInputTokens: 7,
    cacheReadInputTokens: 120_000,
    cacheWriteInputTokens: 800,
  })
})

test("a zero-usage synthetic assistant frame does not replace the last real call", async () => {
  // Without --include-partial-messages the `assistant` frame is all there is.
  const parts = await streamParts(
    createFakeCli([
      init,
      {
        type: "assistant",
        session_id: SESSION,
        message: {
          role: "assistant",
          model: "claude-opus-5-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "the answer" }],
          usage: {
            input_tokens: 4,
            cache_read_input_tokens: 120_000,
            cache_creation_input_tokens: 0,
            output_tokens: 60,
          },
        },
      },
      {
        type: "assistant",
        session_id: SESSION,
        message: {
          role: "assistant",
          model: "<synthetic>",
          stop_reason: "stop_sequence",
          content: [{ type: "text", text: "No response requested." }],
          usage: {
            input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 0,
          },
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: SESSION,
        is_error: false,
        result: "the answer",
        usage: {
          input_tokens: 9,
          cache_read_input_tokens: 230_000,
          cache_creation_input_tokens: 3_000,
          output_tokens: 60,
          iterations: [],
        },
      },
    ]),
  )

  const finish = onlyFinish(parts)
  assert.equal(finish.usage.inputTokens.total, 4 + 120_000)
  assert.equal(finish.usage.inputTokens.cacheRead, 120_000)
  assert.equal(finish.usage.inputTokens.cacheWrite, undefined)
  assert.equal(finish.usage.outputTokens.total, 60)
  // Zero, not the turn's 3,000: opencode reads this when the usage has none.
  assert.equal(finish.providerMetadata.anthropic.cacheCreationInputTokens, 0)
  assert.equal(finish.providerMetadata["claude-code"].contextUsage.inputTokens, 120_004)
})

test("with no assistant usage in the stream the result's usage is reported as before", async () => {
  const resultUsage = {
    input_tokens: 1234,
    output_tokens: 812,
    cache_read_input_tokens: 45_120,
    cache_creation_input_tokens: 2048,
  }
  const parts = await streamParts(
    createFakeCli([
      init,
      ...answerCall("done"),
      {
        type: "result",
        subtype: "success",
        session_id: SESSION,
        is_error: false,
        result: "done",
        usage: resultUsage,
      },
    ]),
  )

  const finish = onlyFinish(parts)
  assert.equal(finish.usage.inputTokens.total, 1234 + 45_120 + 2048)
  assert.equal(finish.usage.inputTokens.cacheRead, 45_120)
  assert.equal(finish.usage.inputTokens.cacheWrite, 2048)
  assert.equal(finish.usage.outputTokens.total, 812)
  assert.deepEqual(finish.usage.raw, resultUsage)
  assert.equal(finish.providerMetadata.anthropic.cacheCreationInputTokens, 2048)
  // Turn totals are not a substitute for a last-call context snapshot.
  assert.equal(finish.providerMetadata["claude-code"].contextUsage, undefined)
})

test("a mid-turn proxied tool boundary exposes display metadata but keeps compaction usage empty", async () => {
  // No `result` has arrived: the CLI is parked inside the MCP call. Reporting
  // the real context here would let opencode compact with that call parked,
  // which has never been verified, so it stays what it always was.
  const parts = await streamParts(createFakeProxyCli("mid-turn"), { proxyTools: ["Task"] })

  const finish = onlyFinish(parts)
  assert.equal(finish.finishReason.unified, "tool-calls")
  assert.equal(finish.usage.inputTokens.total, 0)
  assert.equal(finish.usage.inputTokens.cacheRead, undefined)
  assert.equal(finish.usage.outputTokens.total, undefined)
  assert.equal(finish.providerMetadata.anthropic, undefined)
  assert.deepEqual(finish.providerMetadata["claude-code"], {
    contextUsage: {
      source: "last-api-call",
      inputTokens: 150_609,
      nonCachedInputTokens: 9,
      cacheReadInputTokens: 150_000,
      cacheWriteInputTokens: 600,
    },
  })
})

test("V2 tool translation preserves telemetry without promoting it to compaction usage", async () => {
  const parts = await streamParts(createFakeProxyCli("mid-turn", { usage: {
    input_tokens: 2, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0, output_tokens: 40,
  } }), { proxyTools: ["Task"], hostApi: "v2" })
  const finish = onlyFinish(parts)
  assert.equal(parts.find((part) => part.type === "tool-call")?.toolName, "subagent")
  assert.equal(finish.providerMetadata["claude-code"].contextUsage.inputTokens, 1_000_002)
  assert.equal(finish.usage.inputTokens.total, 0)
  assert.equal(finish.usage.inputTokens.cacheRead, undefined)
  assert.equal(finish.usage.outputTokens.total, undefined)
  assert.equal(finish.providerMetadata.anthropic, undefined)
})

test("a mid-turn boundary with no measured call does not invent display metadata", async () => {
  const parts = await streamParts(createFakeProxyCli("mid-turn", { usage: null }), { proxyTools: ["Task"] })
  const finish = onlyFinish(parts)
  assert.equal(finish.usage.inputTokens.total, 0)
  assert.deepEqual(finish.providerMetadata["claude-code"], {})
})

test("duplicate and synthetic assistant frames do not accumulate or erase boundary telemetry", async () => {
  const realUsage = { input_tokens: 2, cache_read_input_tokens: 90_566, cache_creation_input_tokens: 1_332, output_tokens: 444 }
  const afterAssistant = [
    { type: "assistant", message: { role: "assistant", content: [], usage: realUsage } },
    { type: "assistant", message: { role: "assistant", model: "<synthetic>", content: [], usage: {
      input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0,
    } } },
  ]
  const parts = await streamParts(createFakeProxyCli("mid-turn", { usage: realUsage, afterAssistant }), { proxyTools: ["Task"] })
  const finish = onlyFinish(parts)
  assert.equal(finish.providerMetadata["claude-code"].contextUsage.inputTokens, 91_900)
  assert.equal(finish.usage.inputTokens.total, 0)
  assert.equal(finish.usage.outputTokens.total, undefined)
  assert.equal(finish.providerMetadata["claude-code"].usage, undefined)
})

test("a tool-call finish written after the result reports the last call's context", async () => {
  const parts = await streamParts(createFakeProxyCli("result-first"), { proxyTools: ["Task"] })

  const finish = onlyFinish(parts)
  assert.equal(finish.finishReason.unified, "tool-calls")
  assert.equal(finish.usage.inputTokens.total, 9 + 150_000 + 600)
  assert.equal(finish.usage.inputTokens.cacheWrite, 600)
  assert.equal(finish.usage.outputTokens.total, 90)
  assert.equal(finish.providerMetadata["claude-code"].usage.cache_read_input_tokens, 300_000)
  assert.equal(finish.providerMetadata["claude-code"].contextUsage.inputTokens, 150_609)
  assert.equal(finish.providerMetadata["claude-code"].costUsd, 0.5)
})

test("a call carrying server-side iterations reports its last iteration's context", () => {
  const lastCall = {
    input_tokens: 10,
    cache_read_input_tokens: 90_000,
    cache_creation_input_tokens: 400,
    output_tokens: 300,
    iterations: [
      { input_tokens: 5, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 400, output_tokens: 100 },
      { input_tokens: 3, cache_read_input_tokens: 90_500, cache_creation_input_tokens: 20, output_tokens: 200 },
    ],
  }
  const turnTotal = {
    input_tokens: 25,
    cache_read_input_tokens: 270_000,
    cache_creation_input_tokens: 1_200,
    output_tokens: 999,
    iterations: [],
  }

  const usage = toUsage(lastCallContextUsage(lastCall, turnTotal))
  assert.equal(usage.inputTokens.total, 3 + 90_500 + 20)
  assert.equal(usage.inputTokens.cacheRead, 90_500)
  assert.equal(usage.inputTokens.cacheWrite, 20)
  assert.equal(usage.outputTokens.total, 999)

  // Nothing seen, or no result yet: the turn total goes through untouched.
  assert.equal(lastCallContextUsage(undefined, turnTotal), turnTotal)
  assert.equal(lastCallContextUsage(lastCall, undefined), undefined)
  assert.equal(contextUsageMetadata(lastCall).contextUsage?.inputTokens, 90_523)
})

test("display telemetry omits placeholder output and does not mutate CLI usage", () => {
  const call = Object.freeze({ input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 7, output_tokens: 999 })
  assert.deepEqual(contextUsageMetadata(call), {
    contextUsage: {
      source: "last-api-call", inputTokens: 110, nonCachedInputTokens: 3,
      cacheReadInputTokens: 100, cacheWriteInputTokens: 7,
    },
  })
  assert.equal(call.output_tokens, 999)
  assert.equal(lastCallContextUsage(call, undefined), undefined)
})

test("display telemetry rejects absent, synthetic and malformed counters", () => {
  for (const usage of [
    undefined,
    { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    { input_tokens: -1, cache_read_input_tokens: 100 },
    { input_tokens: NaN },
    { cache_read_input_tokens: Infinity },
    { input_tokens: Number.MAX_VALUE, cache_read_input_tokens: Number.MAX_VALUE },
  ]) {
    assert.deepEqual(contextUsageMetadata(usage), {})
  }
})
