import "./isolate.js"
import assert from "node:assert/strict"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { detectCliVersion } from "../src/cli-version.js"
import { CONVERSATION_REWOUND_MARKER } from "../src/conversation-gap.js"
import { createClaudeCode } from "../src/index.js"
import {
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  getActiveProcess,
  getClaudeSessionId,
  sessionKey,
} from "../src/session-manager.js"
import {
  isSessionGenerateRequest,
  OPENCODE_REQUEST_KIND_HEADER,
  resolveRequestKind,
  sessionGenerateQuestion,
} from "../src/session-generate.js"

// What opencode 2.2.6's session warming appends to the session's history
// (its default `warming.prompt`, read out of the binary).
const KEEP_ALIVE =
  "This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK"

const TURN_HANG_STOP_MS = 30_000

const POSIX_ONLY = process.platform === "win32" ? "the fake-CLI harness is POSIX-only" : false

test("the request kind is read off its header, any case", () => {
  assert.equal(resolveRequestKind({ [OPENCODE_REQUEST_KIND_HEADER]: "generate" }), "generate")
  assert.equal(resolveRequestKind({ "X-Opencode-Request-Kind": "primary" }), "primary")
  assert.equal(resolveRequestKind({ [OPENCODE_REQUEST_KIND_HEADER]: "" }), undefined)
  assert.equal(resolveRequestKind({}), undefined)
  assert.equal(resolveRequestKind(undefined), undefined)
})

test("only a generate request about a session is kept out of the conversation", () => {
  const base = { requestKind: "generate", affinity: "ses_a", compactionMode: false }
  assert.equal(isSessionGenerateRequest(base), true)
  assert.equal(isSessionGenerateRequest({ ...base, requestKind: "primary" }), false)
  assert.equal(isSessionGenerateRequest({ ...base, requestKind: "title" }), false)
  assert.equal(isSessionGenerateRequest({ ...base, requestKind: undefined }), false, "opencode 1 sends no kind")
  assert.equal(isSessionGenerateRequest({ ...base, affinity: "default" }), false, "a detached call is leanGenerate's")
  assert.equal(isSessionGenerateRequest({ ...base, compactionMode: true }), false)
})

test("the question is the trailing user message's text", () => {
  assert.equal(
    sessionGenerateQuestion([
      { role: "user", content: [{ type: "text", text: "earlier" }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "system", content: "Instructions updated" },
      { role: "user", content: [{ type: "text", text: `  ${KEEP_ALIVE}\n` }] },
    ]),
    KEEP_ALIVE,
  )
  assert.equal(sessionGenerateQuestion([{ role: "user", content: "plain" }]), "plain")
  assert.equal(sessionGenerateQuestion([{ role: "assistant", content: [{ type: "text", text: "x" }] }]), null)
  assert.equal(sessionGenerateQuestion([{ role: "user", content: [{ type: "text", text: " " }] }]), null)
  assert.equal(sessionGenerateQuestion([]), null)
})

const fixture = mkdtempSync(join(tmpdir(), "opencode-session-generate-"))
const cliPath = join(fixture, "fake-claude.cjs")
const eventsPath = join(fixture, "events.jsonl")

// A CLI that answers turns and side questions and records what it was sent.
writeFileSync(cliPath, `#!${process.execPath}
const fs = require("node:fs")
const readline = require("node:readline")
const record = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({ ...event, pid: process.pid }) + "\\n")
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.322\\n")
  process.exit(0)
}
if (process.argv.includes("--help")) {
  process.stdout.write("--plugin-dir <path>\\n")
  process.exit(0)
}
record({ type: "spawn", argv: process.argv.slice(2) })
let turns = 0
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const envelope = JSON.parse(line)
  record({ type: "input", envelope })
  if (envelope.type === "control_request" && envelope.request?.subtype === "side_question") {
    emit({
      type: "control_response",
      response: { subtype: "success", request_id: envelope.request_id, response: { response: "OK", synthetic: false } },
    })
    return
  }
  if (envelope.type !== "user") return
  turns++
  emit({ type: "system", subtype: "init", session_id: "fake-generate-session", tools: [], mcp_servers: [] })
  emit({
    type: "assistant",
    session_id: "fake-generate-session",
    message: { id: "msg_" + turns, role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Answer " + turns }] },
  })
  emit({
    type: "result",
    subtype: "success",
    session_id: "fake-generate-session",
    is_error: false,
    usage: { input_tokens: 11, output_tokens: 7 },
  })
})
`, { mode: 0o755 })

const modelId = "claude-test-session-generate"

function conversation(affinity: string) {
  writeFileSync(eventsPath, "")
  const sk = sessionKey(fixture, `${modelId}::tools::${affinity}::context=["claude-code","build"]`)
  const model = createClaudeCode({
    cliPath,
    cwd: fixture,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    interactive: false,
    autoContinueIncompleteTurns: false,
    resumeAfterRestart: false,
    hostApi: "v2",
  } as any).languageModel(modelId)
  const prompt: LanguageModelV3CallOptions["prompt"] = []
  const tools: LanguageModelV3CallOptions["tools"] = [
    { type: "function", name: "read", inputSchema: { type: "object", properties: {} } },
  ]
  const headers = (kind: string) => ({
    "x-session-affinity": affinity,
    "x-opencode-agent": "build",
    [OPENCODE_REQUEST_KIND_HEADER]: kind,
  })
  const run = async (options: LanguageModelV3CallOptions) => {
    const response = await model.doStream({ ...options, abortSignal: AbortSignal.timeout(TURN_HANG_STOP_MS) })
    const parts: LanguageModelV3StreamPart[] = []
    for await (const part of response.stream) parts.push(part)
    const text = parts.filter((part) => part.type === "text-delta").map((part) => part.delta).join("")
    return { parts, text }
  }
  return {
    sk,
    events: () =>
      readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map((line) =>
        JSON.parse(line) as { type: string; pid: number; argv?: string[]; envelope?: any },
      ),
    /** A turn opencode stores: the message and its reply join the history. */
    async turn(text: string) {
      prompt.push({ role: "user", content: [{ type: "text", text }] })
      const result = await run({ prompt: [...prompt], tools, headers: headers("primary") })
      prompt.push({ role: "assistant", content: [{ type: "text", text: result.text }] })
      return result
    },
    /** What `session.generate` sends: the history plus one message opencode never stores. */
    generate(text: string) {
      return run({
        prompt: [...prompt, { role: "user", content: [{ type: "text", text }] }],
        tools,
        headers: headers("generate"),
      })
    },
    async cleanup() {
      await deleteActiveProcessAndWait(sk)
      deleteClaudeSessionId(sk)
    },
  }
}

before(async () => {
  if (POSIX_ONLY) return
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (await detectCliVersion(cliPath)) return
  }
  throw new Error("the fake CLI never answered --version")
})

after(() => rmSync(fixture, { recursive: true, force: true }))

test("a warming ping is answered off the conversation and the next turn finds it untouched", {
  skip: POSIX_ONLY,
  timeout: 60_000,
}, async () => {
  const chat = conversation("ses_warming")
  try {
    const first = await chat.turn("Remember the codeword PELICAN.")
    assert.equal(first.text, "Answer 1")
    const active = getActiveProcess(chat.sk)
    assert.ok(active)
    const claudeSession = getClaudeSessionId(chat.sk)
    assert.equal(claudeSession, "fake-generate-session")

    for (let ping = 0; ping < 2; ping++) {
      const warm = await chat.generate(KEEP_ALIVE)
      assert.equal(warm.text, "OK")
      assert.deepEqual(warm.parts.filter((part) => part.type === "error"), [])
      const finish = warm.parts.find((part) => part.type === "finish")!
      assert.equal(finish.finishReason.unified, "stop")
      assert.deepEqual(finish.providerMetadata, { "claude-code": { path: "session-generate", usageUnavailable: true } })
      assert.equal(getActiveProcess(chat.sk), active, "the ping must not end or replace the process")
    }

    const next = await chat.turn("What was the codeword?")
    assert.equal(next.text, "Answer 2")
    assert.doesNotMatch(next.text, new RegExp(CONVERSATION_REWOUND_MARKER.replace(/\*/g, "\\*")))
    assert.equal(getActiveProcess(chat.sk), active)
    assert.equal(getClaudeSessionId(chat.sk), claudeSession)

    const events = chat.events()
    assert.equal(events.filter((event) => event.type === "spawn").length, 1, "one claude for the whole exchange")
    const inputs = events.filter((event) => event.type === "input").map((event) => event.envelope)
    assert.deepEqual(inputs.map((envelope) => envelope.type), ["user", "control_request", "control_request", "user"])
    assert.deepEqual(inputs[1].request, { subtype: "side_question", question: KEEP_ALIVE })
    const users = JSON.stringify(inputs.filter((envelope) => envelope.type === "user"))
    assert.doesNotMatch(users, /keep-alive/, "the ping never reaches the conversation")
    assert.match(users, /What was the codeword\?/)
  } finally {
    await chat.cleanup()
  }
})

test("a generate request with no live claude is refused without a spawn", { skip: POSIX_ONLY }, async () => {
  const chat = conversation("ses_warming_cold")
  try {
    const warm = await chat.generate(KEEP_ALIVE)
    const errors = warm.parts.filter((part) => part.type === "error")
    assert.equal(errors.length, 1)
    assert.match(String((errors[0] as any).error), /no live Claude Code session/)
    assert.equal(warm.text, "")
    assert.equal(getActiveProcess(chat.sk), undefined)
    assert.deepEqual(chat.events(), [])
  } finally {
    await chat.cleanup()
  }
})
