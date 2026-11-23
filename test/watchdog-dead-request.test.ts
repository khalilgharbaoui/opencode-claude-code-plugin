/**
 * The inactivity watchdog says what happened, and resends once a request the
 * Anthropic API never answered (h #g323).
 *
 * On 2026-11-19 a subagent died twice reported as a CLI crash ("The Claude
 * Code CLI closed its output before finishing this turn"): Claude Code had
 * sent an API request, the network swallowed it, and the 90 s watchdog closed
 * the turn through the crash handler. The fake `claude` below writes the
 * frames 2.1.322 was measured to write: `system`/`status` `requesting` before
 * each request, `message_start` when an answer starts, and on `interrupt` a
 * `control_response`, Claude Code's "[Request interrupted by user]" user frame
 * and an `error_during_execution` result with `terminal_reason:
 * "aborted_streaming"`.
 *
 * Nothing here races a clock: every silence is permanent until the plugin
 * writes something, and every answer follows a stdin line.
 *
 * Usage: npx tsx --test test/watchdog-dead-request.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  REQUEST_RESENT_MARKER,
  STREAM_TIMEOUT_MARKER,
  describeWatchdogClose,
  formatRequestResentNote,
  formatStreamTimeoutNote,
  streamTimeoutPhase,
} from "../src/cli-events.js"
import { createClaudeCode } from "../src/index.js"
import { filterSideQuestionHistory } from "../src/message-builder.js"
import { describeChildCrash, deleteActiveProcess, sessionKey } from "../src/session-manager.js"
import { DEAD_REQUEST_RESEND_PROMPT, makeDeadRequestResendMessage } from "../src/turn-controller.js"

// ---- The wording ------------------------------------------------------------

test("the phase is read off the stream: a request with no answer, a finished reply, or anything else", () => {
  assert.equal(streamTimeoutPhase({ requestAwaitingReply: true, replyStopReason: null }), "no-answer")
  // A request outranks an older call's stop reason: it is the newer fact.
  assert.equal(streamTimeoutPhase({ requestAwaitingReply: true, replyStopReason: "end_turn" }), "no-answer")
  assert.equal(streamTimeoutPhase({ requestAwaitingReply: false, replyStopReason: "end_turn" }), "complete")
  assert.equal(streamTimeoutPhase({ requestAwaitingReply: false, replyStopReason: "stop_sequence" }), "complete")
  for (const stop of [null, "tool_use", "max_tokens", "refusal", "pause_turn"]) {
    assert.equal(streamTimeoutPhase({ requestAwaitingReply: false, replyStopReason: stop }), "mid-reply", String(stop))
  }
})

test("the note says what arrived, and only an unfinished reply may be incomplete", () => {
  const noAnswer = formatStreamTimeoutNote(90_000, "no-answer")
  assert.ok(noAnswer.trimStart().startsWith(STREAM_TIMEOUT_MARKER))
  assert.match(noAnswer, /no answer for 90s/)
  assert.doesNotMatch(noAnswer, /second time/)
  assert.match(formatStreamTimeoutNote(90_000, "no-answer", true), /sent a second time, and that went unanswered too/)

  const complete = formatStreamTimeoutNote(90_000, "complete")
  assert.match(complete, /reply above had finished/)
  assert.match(complete, /Nothing is missing/)
  assert.doesNotMatch(complete, /incomplete/)

  const midReply = formatStreamTimeoutNote(90_000, "mid-reply")
  assert.match(midReply, /stayed silent for 90s/)
  assert.match(midReply, /may be incomplete/)
  // The default is the old meaning: output, then silence.
  assert.equal(formatStreamTimeoutNote(90_000), midReply)
})

test("the error a watchdog close ends on is never the crash text, and a finished reply has none", () => {
  const crash = describeChildCrash(null, null, undefined)
  const noAnswer = describeWatchdogClose(90_000, "no-answer")!
  assert.match(noAnswer, /waited 90s for an answer from the Anthropic API/)
  assert.match(noAnswer, /did not crash/)
  assert.doesNotMatch(noAnswer, /sent twice/)
  assert.match(describeWatchdogClose(90_000, "no-answer", true)!, /sent twice/)
  const midReply = describeWatchdogClose(90_000, "mid-reply")!
  assert.match(midReply, /went silent for 90s/)
  for (const text of [noAnswer, midReply]) {
    assert.notEqual(text, crash)
    assert.doesNotMatch(text, /closed its output/)
  }
  assert.equal(describeWatchdogClose(90_000, "complete"), null)
})

test("the resend note is a plugin note, stripped from a rebuilt transcript", () => {
  const note = formatRequestResentNote(90_000)
  assert.ok(note.trimStart().startsWith(REQUEST_RESENT_MARKER))
  assert.match(note, /no answer for 90s/)
  const filtered = filterSideQuestionHistory([
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "text", text: "working" }, { type: "text", text: note }] },
  ] as any)
  assert.deepEqual((filtered[1] as any).content, [{ type: "text", text: "working" }])
})

test("the continuation says the plugin made the interruption, and is stamped like every plugin envelope", () => {
  assert.match(DEAD_REQUEST_RESEND_PROMPT, /opencode plugin interrupted it/)
  assert.match(DEAD_REQUEST_RESEND_PROMPT, /not the user/)
  const stamped = JSON.parse(makeDeadRequestResendMessage(true))
  assert.equal(stamped.type, "user")
  assert.equal(stamped.message.content[0].text, DEAD_REQUEST_RESEND_PROMPT)
  assert.equal(stamped.client_composed, true)
  assert.equal(JSON.parse(makeDeadRequestResendMessage(false)).client_composed, undefined)
})

// ---- Through a real doStream -------------------------------------------------

/**
 * One scripted reply per user envelope. Each reply is a list of frames; the
 * literal string "silent" stops there and writes nothing more until the next
 * stdin line, and "exit:N" ends the process with that code. Every reply opens
 * with `system`/`init`, as each new turn does on 2.1.322.
 */
type Reply = Array<Record<string, unknown> | "silent" | `exit:${number}`>

function createFakeCli(replies: Reply[]) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-watchdog-dead-request-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const record = join(cwd, "stdin.jsonl")
  writeFileSync(
    cliPath,
    `#!${process.execPath}
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.322\\n")
  process.exit(0)
}
if (process.argv.includes("--help")) process.exit(0)
const emit = (message) => process.stdout.write(JSON.stringify({ session_id: "fake-session", ...message }) + "\\n")
const REPLIES = ${JSON.stringify(replies)}
let next = 0
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  fs.appendFileSync(${JSON.stringify(record)}, line + "\\n")
  const message = JSON.parse(line)
  if (message.type === "control_request" && message.request && message.request.subtype === "interrupt") {
    emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id } })
    emit({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } })
    emit({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 2, terminal_reason: "aborted_streaming", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } })
    return
  }
  if (message.type !== "user") return
  const reply = REPLIES[next++]
  if (!reply) return
  emit({ type: "system", subtype: "init", tools: ["Read"] })
  for (const frame of reply) {
    if (frame === "silent") return
    if (typeof frame === "string" && frame.startsWith("exit:")) process.exit(Number(frame.slice(5)))
    emit(frame)
  }
})
`,
    { mode: 0o755 },
  )
  const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [])
  return {
    cwd,
    cliPath,
    stdinLines: (): any[] => read(record).map((line) => JSON.parse(line)),
  }
}

const requesting = { type: "system", subtype: "status", status: "requesting" }
const event = (inner: Record<string, unknown>) => ({ type: "stream_event", event: inner })
const messageStart = (id: string) =>
  event({ type: "message_start", message: { id, type: "message", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 1 } } })
const textStart = event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
const textDelta = (text: string) => event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })
const blockStop = event({ type: "content_block_stop", index: 0 })
const messageDelta = (stop: string) =>
  event({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 3 } })
const messageStop = event({ type: "message_stop" })
const success = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  result: "done",
  total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 1 },
}

/** A reply that streams `text` as one finished message. */
const answer = (id: string, text: string, stop = "end_turn") => [
  messageStart(id),
  textStart,
  textDelta(text),
  blockStop,
  messageDelta(stop),
  messageStop,
]

async function runTurn(fake: ReturnType<typeof createFakeCli>, fallbackMs: number) {
  const modelId = "claude-test-watchdog-dead-request"
  const key = sessionKey(fake.cwd, `${modelId}::tools::default::context=["claude-code",null]`)
  const previous = process.env.CLAUDE_CODE_RESULT_FALLBACK_MS
  process.env.CLAUDE_CODE_RESULT_FALLBACK_MS = String(fallbackMs)
  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: [],
      autoContinueIncompleteTurns: false,
    }).languageModel(modelId)
    const response = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      tools: [{ type: "function", name: "read", description: "Read", inputSchema: { type: "object", properties: {} } }],
      abortSignal: AbortSignal.timeout(60_000),
    } as any)
    const parts: any[] = []
    for await (const part of response.stream) parts.push(part)
    return { parts, key }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_RESULT_FALLBACK_MS
    else process.env.CLAUDE_CODE_RESULT_FALLBACK_MS = previous
  }
}

const POSIX = {
  timeout: 60_000,
  skip: process.platform === "win32" ? "the fake-CLI harness is POSIX-only" : false,
} as const

const body = (parts: any[]) =>
  parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
const errors = (parts: any[]) => parts.filter((part) => part.type === "error").map((part) => String(part.error?.message))
const finishOf = (parts: any[]) => parts.find((part) => part.type === "finish")
const interruptsIn = (lines: any[]) =>
  lines.filter((line) => line.type === "control_request" && line.request?.subtype === "interrupt")
const resendsIn = (lines: any[]) =>
  lines.filter(
    (line) =>
      line.type === "user" &&
      line.message?.content?.some?.((block: any) => block.text === DEAD_REQUEST_RESEND_PROMPT),
  )

async function waitFor(check: () => boolean): Promise<void> {
  for (let waited = 0; waited < 10_000 && !check(); waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test("a request that got no answer is interrupted and sent once more, and the turn finishes", POSIX, async () => {
  // The first message streams a step, asks for another and hears nothing; the
  // continuation is answered at once.
  const fake = createFakeCli([
    [...answer("msg_one", "first step. ", "tool_use"), requesting, "silent"],
    [requesting, ...answer("msg_two", "the rest"), success],
  ])
  let key = ""
  try {
    const turn = await runTurn(fake, 1_500)
    key = turn.key
    const said = body(turn.parts)
    assert.match(said, /first step\./)
    assert.match(said, /the rest/)
    assert.ok(said.includes(REQUEST_RESENT_MARKER), said)
    assert.ok(!said.includes(STREAM_TIMEOUT_MARKER), said)
    assert.deepEqual(errors(turn.parts), [])
    assert.deepEqual(finishOf(turn.parts).finishReason, { unified: "stop", raw: "stop" })

    // Exactly one interrupt, then exactly one continuation, in that order.
    const lines = fake.stdinLines()
    assert.equal(interruptsIn(lines).length, 1, JSON.stringify(lines))
    assert.equal(resendsIn(lines).length, 1, JSON.stringify(lines))
    assert.ok(lines.indexOf(interruptsIn(lines)[0]) < lines.indexOf(resendsIn(lines)[0]))
    assert.equal(resendsIn(lines)[0].client_composed, true)
  } finally {
    if (key) deleteActiveProcess(key)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a resend that gets no answer either closes the turn as a request with no answer, not a crash", POSIX, async () => {
  const fake = createFakeCli([
    [...answer("msg_one", "first step. ", "tool_use"), requesting, "silent"],
    [requesting, "silent"],
  ])
  let key = ""
  try {
    const turn = await runTurn(fake, 800)
    key = turn.key
    const said = body(turn.parts)
    assert.ok(said.includes(REQUEST_RESENT_MARKER), said)
    assert.match(said, /no answer for 1s/)
    assert.match(said, /sent a second time, and that went unanswered too/)
    const [error, ...more] = errors(turn.parts)
    assert.equal(more.length, 0)
    assert.match(error, /answer from the Anthropic API that never came \(the request was sent twice\)/)
    assert.doesNotMatch(error, /closed its output/)
    assert.deepEqual(finishOf(turn.parts).finishReason, { unified: "error", raw: "error" })

    // Never a second resend; the close interrupts the CLI as it always did.
    await waitFor(() => interruptsIn(fake.stdinLines()).length >= 2)
    const lines = fake.stdinLines()
    assert.equal(resendsIn(lines).length, 1, JSON.stringify(lines))
    assert.equal(interruptsIn(lines).length, 2, JSON.stringify(lines))
  } finally {
    if (key) deleteActiveProcess(key)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a reply that had started streaming is never resent, however long it stalls", POSIX, async () => {
  // The answer started (`message_start`, then text) and stopped: its output
  // was being generated, so sending the request again could bill it twice.
  const fake = createFakeCli([[requesting, messageStart("msg_one"), textStart, textDelta("half an ans"), "silent"]])
  let key = ""
  try {
    const turn = await runTurn(fake, 600)
    key = turn.key
    const said = body(turn.parts)
    assert.match(said, /half an ans/)
    assert.ok(!said.includes(REQUEST_RESENT_MARKER), said)
    assert.match(said, /stopped sending output partway/)
    assert.match(said, /may be incomplete/)
    const [error] = errors(turn.parts)
    assert.match(error, /went silent for 1s partway through this turn/)
    assert.doesNotMatch(error, /closed its output/)
    assert.deepEqual(finishOf(turn.parts).finishReason, { unified: "error", raw: "error" })

    await waitFor(() => interruptsIn(fake.stdinLines()).length >= 1)
    const lines = fake.stdinLines()
    assert.equal(resendsIn(lines).length, 0, JSON.stringify(lines))
    assert.equal(interruptsIn(lines).length, 1, JSON.stringify(lines))
  } finally {
    if (key) deleteActiveProcess(key)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a reply whose stop reason arrived is complete: the note says so and the turn ends as a stop", POSIX, async () => {
  // The whole answer and its `end_turn` arrived; only `message_stop` and the
  // `result` never did (h #g320: 6 of 38 closes).
  const fake = createFakeCli([
    [requesting, messageStart("msg_one"), textStart, textDelta("the whole answer"), blockStop, messageDelta("end_turn"), "silent"],
  ])
  let key = ""
  try {
    const turn = await runTurn(fake, 600)
    key = turn.key
    const said = body(turn.parts)
    assert.match(said, /the whole answer/)
    assert.match(said, /reply above had finished/)
    assert.doesNotMatch(said, /incomplete/)
    assert.ok(!said.includes(REQUEST_RESENT_MARKER), said)
    assert.deepEqual(errors(turn.parts), [])
    assert.deepEqual(finishOf(turn.parts).finishReason, { unified: "stop", raw: "stop" })
    assert.equal(resendsIn(fake.stdinLines()).length, 0)
  } finally {
    if (key) deleteActiveProcess(key)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a CLI that really exits mid-turn still reports the crash", POSIX, async () => {
  const fake = createFakeCli([[requesting, messageStart("msg_one"), textStart, textDelta("half an ans"), "exit:3"]])
  let key = ""
  try {
    const turn = await runTurn(fake, 30_000)
    key = turn.key
    const [error, ...more] = errors(turn.parts)
    assert.equal(more.length, 0)
    assert.match(error, /The Claude Code CLI exited with code 3 before finishing this turn/)
    assert.ok(!body(turn.parts).includes(STREAM_TIMEOUT_MARKER))
    assert.deepEqual(finishOf(turn.parts).finishReason, { unified: "error", raw: "error" })
  } finally {
    if (key) deleteActiveProcess(key)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})
