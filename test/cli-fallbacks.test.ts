/**
 * Claude Code's two silent fallbacks, as opencode sees them through a real
 * `doStream` (h #g300). Every frame sequence below is the shape Claude Code
 * 2.1.322 wrote against a local fake Messages API, cut down to the fields the
 * plugin reads.
 *
 * - Non-streaming: a call whose streaming request failed is resent with
 *   `stream: false`, and its reply reaches stdout as an `assistant` frame with
 *   no stream events of its own (a 404 on the streaming endpoint), or after a
 *   bare `message_start` / `message_stop` under another id (a stream cut before
 *   any output). After a streamed call in the same turn, that frame was
 *   dropped.
 * - Refusal: after a safety refusal the CLI answers on another model and keeps
 *   it for the process. Off by default (`CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK`
 *   filled in); with the operator's `0`, the reply names the model that
 *   answered and so do the spawn record and the turn history.
 *
 * Usage: npx tsx --test test/cli-fallbacks.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { REFUSAL_FALLBACK_MARKER, _resetRefusalFallbackReports } from "../src/cli-events.js"
import { createClaudeCode } from "../src/index.js"
import {
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  snapshotActiveProcesses,
} from "../src/session-manager.js"
import { spawnRecordStorePath } from "../src/spawn-record-store.js"
import { turnHistoryStorePath } from "../src/turn-history.js"

const SESSION = "fake-fallbacks"

const event = (apiMessageId: string, inner: Record<string, unknown>) => ({
  type: "stream_event",
  session_id: SESSION,
  api_message_id: apiMessageId,
  event: inner,
})

const messageStart = (id: string, model: string) =>
  event(id, {
    type: "message_start",
    message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } },
  })

const assistant = (id: string, model: string, content: unknown[], stopReason: string | null = null) => ({
  type: "assistant",
  session_id: SESSION,
  message: { id, type: "message", role: "assistant", model, content, stop_reason: stopReason, usage: { input_tokens: 12, output_tokens: 7 } },
})

/** One streamed text call, in 2.1.322's order: the `assistant` frame lands before `content_block_stop`. */
function streamedText(id: string, model: string, text: string, stopReason = "end_turn") {
  return [
    messageStart(id, model),
    event(id, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    event(id, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    assistant(id, model, [{ type: "text", text }]),
    event(id, { type: "content_block_stop", index: 0 }),
    event(id, { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 7 } }),
    event(id, { type: "message_stop" }),
  ]
}

/** A streamed CLI-native `Read` call and its result, the call before the fallback. */
function streamedRead(model: string) {
  const id = "msg_streamed_tool"
  const input = { file_path: "/tmp/notes.txt" }
  return [
    messageStart(id, model),
    event(id, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_read_1", name: "Read", input: {} } }),
    event(id, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }),
    assistant(id, model, [{ type: "tool_use", id: "toolu_read_1", name: "Read", input }]),
    { type: "user", session_id: SESSION, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read_1", content: "the notes" }] } },
    event(id, { type: "content_block_stop", index: 0 }),
    event(id, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }),
    event(id, { type: "message_stop" }),
  ]
}

const init = { type: "system", subtype: "init", session_id: SESSION }
const result = (text: string) => ({
  type: "result",
  subtype: "success",
  session_id: SESSION,
  is_error: false,
  result: text,
  usage: { input_tokens: 12, output_tokens: 7 },
})

/**
 * A fake `claude` that answers its Nth user message with `turns[N]` (the last
 * one repeats) and records the refusal-fallback variable it was spawned with.
 */
function createFakeCli(turns: unknown[][]) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-cli-fallbacks-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const envLog = join(cwd, "env.jsonl")
  writeFileSync(
    cliPath,
    `#!${process.execPath}
const fs = require("node:fs")
const args = process.argv.slice(2)
if (args.includes("--version")) { process.stdout.write("2.1.322\\n"); process.exit(0) }
if (args.includes("--help")) { process.stdout.write("Usage: claude\\n"); process.exit(0) }
fs.appendFileSync(${JSON.stringify(envLog)}, JSON.stringify({ refusalFallback: process.env.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK ?? null }) + "\\n")
const TURNS = ${JSON.stringify(turns)}
const emit = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
let turn = 0
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (message.type === "control_request") {
    emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id } })
    return
  }
  if (message.type !== "user") return
  for (const frame of TURNS[Math.min(turn, TURNS.length - 1)]) emit(frame)
  turn++
})
`,
    { mode: 0o755 },
  )
  return {
    cwd,
    cliPath,
    spawnEnvs: () =>
      existsSync(envLog)
        ? readFileSync(envLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [],
  }
}

const TOOLS = [{ type: "function", name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }]
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] })

async function turn(
  fake: { cwd: string; cliPath: string },
  modelId: string,
  prompt: unknown[],
  options: { affinity?: string; agent?: string } = {},
): Promise<any[]> {
  const model = createClaudeCode({
    cliPath: fake.cliPath,
    cwd: fake.cwd,
    bridgeOpencodeMcp: false,
    bridgeOpencodeSkills: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    autoContinueIncompleteTurns: false,
  }).languageModel(modelId)
  const response = await model.doStream({
    prompt,
    tools: TOOLS,
    abortSignal: AbortSignal.timeout(60_000),
    ...(options.affinity ? { headers: { "x-session-affinity": options.affinity } } : {}),
    ...(options.agent ? { providerOptions: { "claude-code": { opencodeAgent: options.agent } } } : {}),
  } as any)
  const parts: any[] = []
  for await (const part of response.stream) parts.push(part)
  return parts
}

async function cleanup(fake: { cwd: string }) {
  for (const active of snapshotActiveProcesses()) {
    if (active.sessionKey.includes(fake.cwd)) {
      await deleteActiveProcessAndWait(active.sessionKey)
      deleteClaudeSessionId(active.sessionKey)
    }
  }
  rmSync(fake.cwd, { recursive: true, force: true })
}

function withRefusalFallbackEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const saved = process.env.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK
  if (value === undefined) delete process.env.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK
  else process.env.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK = value
  return run().finally(() => {
    if (saved === undefined) delete process.env.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK
    else process.env.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK = saved
  })
}

const texts = (parts: any[]) => parts.filter((part) => part.type === "text-delta").map((part) => part.delta as string)
const finishOf = (parts: any[]) => parts.find((part) => part.type === "finish")

// ---------------------------------------------------------------------------
// Non-streaming fallback
// ---------------------------------------------------------------------------

const HAIKU = "claude-haiku-4-5"
const NONSTREAMED = "NONSTREAM-AFTER-TOOL-OK"

test("a reply sent without streaming after a streamed call is rendered (404 on the streaming endpoint)", { timeout: 90_000 }, async () => {
  const fake = createFakeCli([
    [
      init,
      ...streamedRead(HAIKU),
      // The resent `stream: false` call: no stream events at all.
      assistant("msg_nonstreamed", HAIKU, [{ type: "text", text: NONSTREAMED }], "end_turn"),
      result(NONSTREAMED),
    ],
  ])
  try {
    const parts = await withRefusalFallbackEnv(undefined, () => turn(fake, HAIKU, [user("go")]))
    assert.deepEqual(texts(parts), [NONSTREAMED], "the unstreamed reply, exactly once")
    assert.ok(parts.some((part) => part.type === "tool-call" && part.toolCallId === "toolu_read_1"), "the streamed call is still there")
    assert.equal(finishOf(parts)?.finishReason?.unified, "stop")
    // The CLI's refusal fallback is off unless the operator chose.
    assert.deepEqual(fake.spawnEnvs(), [{ refusalFallback: "1" }])
  } finally {
    await cleanup(fake)
  }
})

test("a reply sent without streaming after a stream cut before any output is rendered", { timeout: 90_000 }, async () => {
  const fake = createFakeCli([
    [
      init,
      ...streamedRead(HAIKU),
      // The cut stream: a message_start and an abandoning message_stop, then
      // the non-streamed reply under a different id.
      messageStart("msg_cut", HAIKU),
      { ...event("msg_cut", { type: "message_stop" }), abandoned_blocks: { api_message_id: "msg_cut", from_block_index: 0 } },
      assistant("msg_nonstreamed", HAIKU, [{ type: "text", text: NONSTREAMED }], "end_turn"),
      result(NONSTREAMED),
    ],
  ])
  try {
    const parts = await turn(fake, HAIKU, [user("go")])
    assert.deepEqual(texts(parts), [NONSTREAMED])
  } finally {
    await cleanup(fake)
  }
})

test("a streamed reply's own assistant frame is still not rendered twice", { timeout: 90_000 }, async () => {
  const fake = createFakeCli([[init, ...streamedRead(HAIKU), ...streamedText("msg_streamed_text", HAIKU, "STREAMED-ONCE"), result("STREAMED-ONCE")]])
  try {
    const parts = await turn(fake, HAIKU, [user("go")])
    assert.deepEqual(texts(parts), ["STREAMED-ONCE"])
  } finally {
    await cleanup(fake)
  }
})

test("a non-streamed reply's own tool call reaches opencode", { timeout: 90_000 }, async () => {
  const input = { file_path: "/tmp/other.txt" }
  const fake = createFakeCli([
    [
      init,
      ...streamedRead(HAIKU),
      assistant("msg_nonstreamed_tool", HAIKU, [{ type: "tool_use", id: "toolu_read_2", name: "Read", input }], "tool_use"),
      { type: "user", session_id: SESSION, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read_2", content: "other" }] } },
      ...streamedText("msg_after", HAIKU, "done"),
      result("done"),
    ],
  ])
  try {
    const parts = await turn(fake, HAIKU, [user("go")])
    const call = parts.find((part) => part.type === "tool-call" && part.toolCallId === "toolu_read_2")
    assert.ok(call, "the unstreamed call is a tool call")
    assert.ok(parts.some((part) => part.type === "tool-result" && part.toolCallId === "toolu_read_2"))
    assert.deepEqual(texts(parts), ["done"])
  } finally {
    await cleanup(fake)
  }
})

// ---------------------------------------------------------------------------
// Refusal fallback
// ---------------------------------------------------------------------------

const OPUS = "claude-opus-5-5"
const FALLBACK = "claude-opus-4-8"

/** 2.1.322's sequence when Opus 5.5 refuses twice and the fallback is on. */
const refusalTurn = [
  init,
  ...streamedText("msg_refused_1", OPUS, "Sure, here is the start", "refusal"),
  { type: "system", subtype: "informational", session_id: SESSION, content: "Opus 5.5's safeguards stopped the response above", level: "notice" },
  ...streamedText("msg_refused_2", OPUS, "Sure, here is the start", "refusal").slice(0, 5),
  {
    type: "system",
    subtype: "model_refusal_fallback",
    session_id: SESSION,
    trigger: "refusal",
    direction: "retry",
    scope: "session",
    original_model: OPUS,
    fallback_model: FALLBACK,
    request_id: "req_fake",
    api_refusal_category: "cyber",
    retracted_message_uuids: ["f44b2162-b4d3-4e4f-99a8-ad4b2a67d725"],
    content: "Opus 5.5's safeguards flagged this session.",
  },
  event("msg_refused_2", { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 7 } }),
  event("msg_refused_2", { type: "message_stop" }),
  ...streamedText("msg_fallback", FALLBACK, `FALLBACK-REPLY from ${FALLBACK}`),
  result(`FALLBACK-REPLY from ${FALLBACK}`),
]

/** The same process's next message, which goes straight to the fallback model. */
const afterFallbackTurn = [
  ...streamedText("msg_next", FALLBACK, `NEXT-REPLY from ${FALLBACK}`),
  result(`NEXT-REPLY from ${FALLBACK}`),
]

test("a refusal fallback the operator kept is named in the reply, the spawn record and the turn history", { timeout: 90_000 }, async () => {
  _resetRefusalFallbackReports()
  const fake = createFakeCli([refusalTurn, afterFallbackTurn])
  const affinity = "ses_refusal_fallback"
  try {
    await withRefusalFallbackEnv("0", async () => {
      const first = await turn(fake, OPUS, [user("go")], { affinity, agent: "build" })
      const said = texts(first)
      const noteAt = said.findIndex((text) => text.trimStart().startsWith(REFUSAL_FALLBACK_MARKER))
      assert.ok(noteAt >= 0, `a refusal-fallback note: ${JSON.stringify(said)}`)
      assert.match(said[noteAt], new RegExp(`${OPUS}.*${FALLBACK}`, "s"), "names both models")
      assert.match(said[noteAt], /withdrew/, "says the refused text above was withdrawn")
      assert.equal(said.indexOf(`FALLBACK-REPLY from ${FALLBACK}`), said.length - 1)
      assert.ok(noteAt < said.length - 1, "between the refused text and the answer")
      assert.equal(said.filter((text) => text.includes(REFUSAL_FALLBACK_MARKER)).length, 1)
      assert.equal(finishOf(first)?.finishReason?.unified, "stop")

      const spawned = () => JSON.parse(readFileSync(spawnRecordStorePath(), "utf8")).sessions[affinity]
      assert.equal(spawned().model, FALLBACK, "the sidebar names the model that answered")

      // The same process, next message: still the fallback model, no new note.
      const second = await turn(fake, OPUS, [user("go"), reply(`FALLBACK-REPLY from ${FALLBACK}`), user("again")], { affinity, agent: "build" })
      assert.deepEqual(texts(second), [`NEXT-REPLY from ${FALLBACK}`])
      assert.equal(spawned().model, FALLBACK, "a later turn on the same process does not put the requested model back")
      assert.equal(fake.spawnEnvs().length, 1, "one process for both turns")
      assert.deepEqual(fake.spawnEnvs(), [{ refusalFallback: "0" }], "the operator's own value reaches the CLI")

      const turns = JSON.parse(readFileSync(turnHistoryStorePath(), "utf8")).turns
      assert.equal(turns[`build/${FALLBACK}`]?.length, 2, "both samples are the fallback model's")
      assert.equal(turns[`build/${OPUS}`], undefined, "none under the model that refused")
    })
  } finally {
    await cleanup(fake)
  }
})

test("a refusal fallback on a compaction turn writes no note into the summary", { timeout: 90_000 }, async () => {
  _resetRefusalFallbackReports()
  const fake = createFakeCli([refusalTurn])
  try {
    await withRefusalFallbackEnv("0", async () => {
      const parts = await turn(fake, OPUS, [user("first"), reply("second"), user("summarize this")], { agent: "compaction" })
      const said = texts(parts)
      assert.ok(!said.some((text) => text.includes(REFUSAL_FALLBACK_MARKER)), JSON.stringify(said))
      assert.ok(said.includes(`FALLBACK-REPLY from ${FALLBACK}`))
    })
  } finally {
    await cleanup(fake)
  }
})
