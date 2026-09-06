import assert from "node:assert/strict"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import type { ChildProcess } from "node:child_process"
import { EventEmitter, getEventListeners } from "node:events"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { test } from "node:test"
import { setImmediate } from "node:timers/promises"
import { cliSupportsSideQuestion, type CliVersion } from "./src/cli-version.js"
import { createClaudeCode, registerSideQuestionCommand } from "./src/index.js"
import type { OpenCodeConfig } from "./src/opencode-types.js"
import {
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  getActiveProcess,
  getClaudeSessionId,
  sessionKey,
} from "./src/session-manager.js"
import {
  collectSideQuestionHistory,
  dispatchSideQuestionResponse,
  isSideQuestionPending,
  parseSideQuestion,
  requestSideQuestion,
  SIDE_QUESTION_USAGE,
} from "./src/side-question.js"

const cliVersion: CliVersion = { major: 2, minor: 1, patch: 258, raw: "2.1.258" }
const options = { cliVersion, timeoutMs: 1_000 }

function fakeProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  })
  const activeProcess = {
    proc: proc as unknown as ChildProcess,
    lineEmitter: new EventEmitter(),
  }
  const writes: { type: string; request_id: string; request?: unknown }[] = []
  proc.stdin.on("data", (chunk: Buffer) => {
    assert.ok(chunk.toString().endsWith("\n"))
    writes.push(JSON.parse(chunk.toString()))
  })
  const skipped: string[] = []
  const receive = (message: unknown): boolean => {
    const line = typeof message === "string" ? message : JSON.stringify(message)
    if (dispatchSideQuestionResponse(activeProcess, line)) return true
    if (!activeProcess.lineEmitter.emit("line", line)) skipped.push(line)
    return false
  }
  const answer = (response = "pong", synthetic = false): boolean => receive({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: writes[0].request_id,
      response: { response, synthetic },
    },
  })
  const assertClean = (signal?: AbortSignal): void => {
    assert.deepEqual(activeProcess.lineEmitter.eventNames(), [])
    assert.deepEqual(proc.eventNames(), [])
    assert.equal(proc.stdin.listenerCount("error"), 0)
    assert.equal(isSideQuestionPending(activeProcess), false)
    if (signal) assert.equal(getEventListeners(signal, "abort").length, 0)
  }
  return { activeProcess, proc, writes, skipped, receive, answer, assertClean }
}

test("parses only a complete latest all-text /btw user message", () => {
  const cases = [
    ["/btw what changed?", "what changed?"],
    ["  /btw\twhy?  ", "why?"],
    ["/btw first line\nsecond line", "first line\nsecond line"],
    ["/btw", ""],
    ["/btw \n\t", ""],
    [[{ type: "text", text: "/btw" }, { type: "text", text: "more\ncontext" }], "more\ncontext"],
  ] as const
  for (const [content, question] of cases) {
    assert.deepEqual(parseSideQuestion([{ role: "user", content }]), { question })
  }
  for (const content of [
    "normal question", "mention /btw here", "/btwhatever", "/btw?", "/BTW question",
    [{ type: "text", text: "/btw question" }, { type: "image", image: "aGVsbG8=" }],
    [{ type: "text", text: "/btw question" }, { type: "file", data: "data" }],
    [{ type: "text", text: "/btw question" }, { type: "tool-result", toolCallId: "id" }],
    [{ type: "text", text: 42 }], [null], [], null,
  ]) {
    assert.equal(parseSideQuestion([{ role: "user", content }]), null)
  }
  assert.equal(parseSideQuestion([]), null)
  assert.equal(parseSideQuestion([
    { role: "user", content: "/btw old question" },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "ordinary next user" },
  ]), null)
  for (const role of ["assistant", "tool", "system"]) {
    assert.equal(parseSideQuestion([
      { role: "user", content: "/btw old question" },
      { role, content: "/btw not a new user question" },
    ]), null)
  }
})

test("drops opencode's appended system-reminder parts from the question", () => {
  // Shape measured live on opencode 1.18.29: the typed text and the reminder
  // arrive as two separate text parts on the same user message.
  const reminder =
    "<system-reminder>\n# Plan Mode - System Reminder\n\nCRITICAL: Plan mode ACTIVE" +
    " - you are in READ-ONLY phase.\n</system-reminder>"
  const asked = parseSideQuestion([{
    role: "user",
    content: [
      { type: "text", text: "/btw What fruit did I ask for? One word.\n\n" },
      { type: "text", text: reminder },
    ],
  }])
  assert.deepEqual(asked, { question: "What fruit did I ask for? One word." })

  // A bare /btw must still look empty so the usage text renders.
  assert.deepEqual(
    parseSideQuestion([{
      role: "user",
      content: [{ type: "text", text: "/btw\n\n" }, { type: "text", text: reminder }],
    }]),
    { question: "" },
  )

  // More than one appended block, and surrounding whitespace, are both handled.
  assert.deepEqual(
    parseSideQuestion([{
      role: "user",
      content: [
        { type: "text", text: "/btw why?" },
        { type: "text", text: `\n${reminder}\n` },
        { type: "text", text: reminder },
      ],
    }]),
    { question: "why?" },
  )

  // A block is removed wherever it sits, including inside a part that also
  // carries real text, which is kept.
  assert.deepEqual(
    parseSideQuestion([{
      role: "user",
      content: [{ type: "text", text: `/btw why?\n${reminder}\nand also this` }],
    }]),
    { question: "why?\n\nand also this" },
  )

  // Measured live: opencode-dcp appends its own marker after the closing tag,
  // so an end-anchored check would leave the whole reminder in the question.
  assert.deepEqual(
    parseSideQuestion([{
      role: "user",
      content: [
        { type: "text", text: "/btw why?" },
        { type: "text", text: `${reminder}\n\n<dcp-message-id>m0003</dcp-message-id>` },
      ],
    }]),
    { question: "why?\n\n\n<dcp-message-id>m0003</dcp-message-id>" },
  )

  // Reminder-only content never becomes a side question of its own.
  assert.equal(
    parseSideQuestion([{ role: "user", content: [{ type: "text", text: reminder }] }]),
    null,
  )
})

test("gates the protocol at the oldest measured CLI version", () => {
  assert.equal(cliSupportsSideQuestion(null), false)
  assert.equal(cliSupportsSideQuestion({ ...cliVersion, patch: 257 }), false)
  assert.equal(cliSupportsSideQuestion({ ...cliVersion, minor: 0, patch: 999 }), false)
  assert.equal(cliSupportsSideQuestion(cliVersion), true)
  assert.equal(cliSupportsSideQuestion({ ...cliVersion, patch: 259 }), true)
  assert.equal(cliSupportsSideQuestion({ ...cliVersion, minor: 2, patch: 0 }), true)
  assert.equal(cliSupportsSideQuestion({ ...cliVersion, major: 3, minor: 0, patch: 0 }), true)
})

test("registers /btw without choosing an agent/model or replacing user commands", () => {
  const config: OpenCodeConfig = {}
  registerSideQuestionCommand(config)
  assert.deepEqual(config.command?.btw, {
    template: "/btw $ARGUMENTS",
    description: "Ask a side question in the live Claude Code session without changing its context",
  })
  const ownCommand = { template: "custom $ARGUMENTS", agent: "plan", model: "user/model" }
  const ownConfig: OpenCodeConfig = { command: { btw: ownCommand, other: { template: "other" } } }
  const before = structuredClone(ownConfig)
  registerSideQuestionCommand(ownConfig)
  assert.deepEqual(ownConfig, before)
  assert.equal(ownConfig.command?.btw, ownCommand)
})

test("empty /btw returns usage without writing or requiring protocol support", async () => {
  const fake = fakeProcess()
  assert.deepEqual(await requestSideQuestion(fake.activeProcess, " \n", { cliVersion: null }), {
    response: SIDE_QUESTION_USAGE,
    synthetic: true,
  })
  assert.deepEqual(fake.writes, [])
  fake.assertClean()
})

test("sends only the native request and resolves its matching response", async () => {
  const fake = fakeProcess()
  const controller = new AbortController()
  const pending = requestSideQuestion(fake.activeProcess, " ping ", {
    ...options, abortSignal: controller.signal,
  })
  assert.equal(isSideQuestionPending(fake.activeProcess), true)
  assert.equal(fake.activeProcess.lineEmitter.listenerCount("line"), 0)
  assert.equal(fake.writes.length, 1)
  assert.match(fake.writes[0].request_id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(fake.writes[0], {
    type: "control_request",
    request_id: fake.writes[0].request_id,
    request: { subtype: "side_question", question: "ping" },
  })
  assert.equal(fake.answer(), true)
  assert.deepEqual(await pending, { response: "pong", synthetic: false })
  controller.abort()
  assert.equal(fake.writes.length, 1, "success must remove the abort handler")
  fake.assertClean(controller.signal)
})

test("unrelated stdout and progress remain buffered, not consumed by the helper", async () => {
  const fake = fakeProcess()
  const pending = requestSideQuestion(fake.activeProcess, "ping", options)
  const unrelated = [
    "not json", "null", "[]",
    JSON.stringify({ type: "assistant", message: { content: "main output" } }),
    JSON.stringify({ type: "control_request", request_id: "permission", request: { subtype: "can_use_tool" } }),
    JSON.stringify({ type: "system", subtype: "control_request_progress", request_id: fake.writes[0].request_id, status: "started" }),
    JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: "unrelated", error: "other failure" } }),
    JSON.stringify({ type: "control_response", response: null }),
  ]
  for (const line of unrelated) assert.equal(fake.receive(line), false)
  assert.equal(isSideQuestionPending(fake.activeProcess), true)
  assert.deepEqual(fake.skipped, unrelated)
  fake.answer()
  await pending
  assert.equal(fake.answer("late duplicate"), false)
  fake.assertClean()
})

test("only explicit history is forwarded and synthetic results are preserved", async () => {
  const fake = fakeProcess()
  const history = [{ question: "earlier aside", response: "earlier response" }]
  const pending = requestSideQuestion(fake.activeProcess, "follow-up", { ...options, history })
  assert.deepEqual(fake.writes[0].request, { subtype: "side_question", question: "follow-up", history })
  fake.answer("local answer", true)
  assert.deepEqual(await pending, { response: "local answer", synthetic: true })
  fake.assertClean()
})

test("CLI error and malformed success responses reject and clean up", async () => {
  for (const response of [
    { subtype: "error", error: "side questions unavailable" },
    { subtype: "success", response: { response: 123, synthetic: false } },
    { subtype: "success", response: { response: "missing synthetic" } },
    { subtype: "unexpected" },
  ]) {
    const fake = fakeProcess()
    const pending = requestSideQuestion(fake.activeProcess, "ping", options)
    assert.equal(fake.receive({
      type: "control_response",
      response: { ...response, request_id: fake.writes[0].request_id },
    }), true)
    await assert.rejects(pending, /side questions unavailable|invalid \/btw response/)
    assert.equal(fake.writes.length, 1)
    fake.assertClean()
  }
})

test("abort cancels only the matching request and leaves the process alive", async () => {
  const fake = fakeProcess()
  const controller = new AbortController()
  const pending = requestSideQuestion(fake.activeProcess, "ping", { ...options, abortSignal: controller.signal })
  const rejection = assert.rejects(pending, { name: "AbortError" })
  controller.abort()
  await rejection
  await setImmediate()
  assert.deepEqual(fake.writes[1], { type: "control_cancel_request", request_id: fake.writes[0].request_id })
  assert.equal(fake.proc.killed, false)
  assert.equal(fake.proc.stdin.writableEnded, false)
  assert.equal(fake.answer("too late"), false)
  fake.assertClean(controller.signal)

  const alreadyAborted = fakeProcess()
  await assert.rejects(requestSideQuestion(alreadyAborted.activeProcess, "ping", {
    ...options, abortSignal: controller.signal,
  }), { name: "AbortError" })
  assert.equal(alreadyAborted.writes.length, 0)
  alreadyAborted.assertClean(controller.signal)
})

test("timeout cancels and clears listeners", async () => {
  const fake = fakeProcess()
  await assert.rejects(requestSideQuestion(fake.activeProcess, "ping", {
    ...options, timeoutMs: 10,
  }), /timed out after 10ms/)
  await setImmediate()
  assert.equal(fake.writes.length, 2)
  assert.deepEqual(fake.writes[1], { type: "control_cancel_request", request_id: fake.writes[0].request_id })
  fake.assertClean()
})

test("process/stdout close and errors reject without cancelling a dead process", async () => {
  for (const [target, event] of [
    ["proc", "exit"], ["proc", "close"], ["proc", "error"],
    ["lineEmitter", "close"], ["lineEmitter", "error"], ["stdin", "error"],
  ] as const) {
    const fake = fakeProcess()
    const pending = requestSideQuestion(fake.activeProcess, "ping", options)
    const rejection = assert.rejects(pending, /closed before answering|broken pipe/)
    const emitter = target === "proc" ? fake.proc
      : target === "stdin" ? fake.proc.stdin : fake.activeProcess.lineEmitter
    emitter.emit(event, new Error("broken pipe"))
    await rejection
    assert.equal(fake.writes.length, 1)
    fake.assertClean()
  }
})

test("a running main turn does not block /btw; only a simultaneous side question is refused", async () => {
  const fake = fakeProcess()
  // A streaming turn keeps a `line` listener attached. Claude Code answers a
  // side question concurrently with the turn, so the request goes out anyway.
  const onLine = (): void => {}
  fake.activeProcess.lineEmitter.on("line", onLine)
  const during = requestSideQuestion(fake.activeProcess, "ping", options)
  assert.equal(fake.writes.length, 1)
  assert.equal(fake.writes[0].type, "control_request")

  await assert.rejects(requestSideQuestion(fake.activeProcess, "second", options), /current \/btw/)
  assert.equal(fake.writes.length, 1)
  assert.equal(fake.answer(), true, "the response must be routed by request id, not to the turn's listener")
  assert.equal((await during).response, "pong")
  assert.equal(fake.activeProcess.lineEmitter.listenerCount("line"), 1, "the turn's listener is untouched")
  fake.activeProcess.lineEmitter.off("line", onLine)
  fake.assertClean()
})

test("collectSideQuestionHistory pairs earlier /btw questions with their answers and drops the current one", () => {
  const reminder = "<system-reminder>\nplan mode\n</system-reminder>"
  const prompt = [
    { role: "user", content: [{ type: "text", text: "normal turn" }] },
    { role: "assistant", content: [{ type: "text", text: "normal answer" }] },
    { role: "user", content: [{ type: "text", text: "/btw first?" }, { type: "text", text: reminder }] },
    { role: "assistant", content: [{ type: "text", text: "one" }, { type: "text", text: "more" }] },
    { role: "user", content: "/btw" },
    { role: "assistant", content: SIDE_QUESTION_USAGE },
    { role: "user", content: "/btw unanswered?" },
    { role: "user", content: "/btw second?" },
    { role: "assistant", content: "two" },
    { role: "user", content: [{ type: "text", text: "/btw current?" }] },
  ]
  assert.deepEqual(collectSideQuestionHistory(prompt), [
    { question: "first?", response: "one\nmore" },
    { question: "second?", response: "two" },
  ])
  assert.deepEqual(collectSideQuestionHistory([{ role: "user", content: "/btw only?" }]), [])
  const many = Array.from({ length: 25 }, (_, index) => [
    { role: "user", content: `/btw q${index}` },
    { role: "assistant", content: `a${index}` },
  ]).flat()
  many.push({ role: "user", content: "/btw now?" })
  const capped = collectSideQuestionHistory(many)
  assert.equal(capped.length, 20)
  assert.equal(capped[0].question, "q5")
  assert.equal(capped[19].question, "q24")
})

test("interactive, old/unknown CLI, dead processes, and invalid deadlines never receive a request", async () => {
  for (const override of [
    { interactive: true }, { cliVersion: null }, { cliVersion: { ...cliVersion, patch: 257 } },
    { timeoutMs: 0 }, { timeoutMs: NaN }, { timeoutMs: Infinity }, { timeoutMs: 2 ** 31 },
  ]) {
    const fake = fakeProcess()
    await assert.rejects(requestSideQuestion(fake.activeProcess, "ping", { ...options, ...override }))
    assert.equal(fake.writes.length, 0)
    fake.assertClean()
  }
  for (const property of [{ killed: true }, { exitCode: 0 }, { signalCode: "SIGTERM" }, { stdout: null }, { stdin: null }]) {
    const fake = fakeProcess()
    Object.assign(fake.proc, property)
    await assert.rejects(requestSideQuestion(fake.activeProcess, "ping", options), /requires/)
    assert.equal(fake.writes.length, 0)
    assert.deepEqual(fake.activeProcess.lineEmitter.eventNames(), [])
    assert.equal(isSideQuestionPending(fake.activeProcess), false)
  }
})

test("a synchronous write failure cleans up and preserves existing error listeners", async () => {
  const fake = fakeProcess()
  const onError = (): void => {}
  fake.proc.on("error", onError)
  fake.proc.stdin.write = () => { throw new Error("write failed") }
  await assert.rejects(requestSideQuestion(fake.activeProcess, "ping", options), /write failed/)
  assert.deepEqual(fake.proc.listeners("error"), [onError])
  fake.proc.off("error", onError)
  fake.assertClean()
})

test("cancel write errors cannot escape after abort/timeout cleanup", async () => {
  for (const synchronous of [true, false]) {
    const fake = fakeProcess()
    const controller = new AbortController()
    const pending = requestSideQuestion(fake.activeProcess, "ping", { ...options, abortSignal: controller.signal })
    if (synchronous) {
      fake.proc.stdin.write = () => { throw new Error("cancel write failed") }
    } else {
      fake.proc.stdin._write = (_chunk, _encoding, callback) => {
        callback(new Error("cancel write failed"))
      }
    }
    const rejection = assert.rejects(pending, { name: "AbortError" })
    controller.abort()
    await rejection
    await setImmediate()
    fake.assertClean(controller.signal)
  }
})

function createSideQuestionCli() {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-side-question-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const eventsPath = join(cwd, "events.jsonl")
  writeFileSync(eventsPath, "")
  writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
const record = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({ ...event, pid: process.pid }) + "\\n")
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
if (process.argv.includes("--version")) {
  record({ type: "version" })
  process.stdout.write("2.1.258\\n")
  process.exit(0)
}
if (process.argv.includes("--help")) {
  process.stdout.write("--plugin-dir <path>\\n")
  process.exit(0)
}
record({ type: "spawn" })
let turns = 0
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const envelope = JSON.parse(line)
  record({ type: "input", envelope })
  if (envelope.type === "control_request" && envelope.request?.subtype === "side_question") {
    emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: envelope.request_id,
        response: { response: "Native aside after turn " + turns, synthetic: false },
      },
    })
    return
  }
  if (envelope.type !== "user") throw new Error("Unexpected fixture input")
  turns++
  emit({
    type: "assistant",
    session_id: "fake-side-question-session",
    message: {
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Normal answer " + turns }],
    },
  })
  emit({
    type: "result",
    subtype: "success",
    session_id: "fake-side-question-session",
    is_error: false,
    usage: { input_tokens: 11, output_tokens: 7 },
  })
})
`, { mode: 0o755 })

  const modelId = "claude-test-side-question"
  const sk = sessionKey(cwd, `${modelId}::tools::default::context=["claude-code",null]`)
  const model = createClaudeCode({
    cliPath,
    cwd,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    interactive: false,
    autoContinueIncompleteTurns: false,
  }).languageModel(modelId)
  const options: LanguageModelV3CallOptions = {
    prompt: [],
    tools: [{ type: "function", name: "read", inputSchema: { type: "object", properties: {} } }],
  }
  return {
    sk,
    events: () => readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map((line) =>
      JSON.parse(line) as {
        type: string
        pid: number
        envelope?: { type: string; request_id?: string; request?: unknown }
      },
    ),
    async turn(text: string) {
      options.prompt.push({ role: "user", content: [{ type: "text", text }] })
      const response = await model.doStream({ ...options, abortSignal: AbortSignal.timeout(5_000) })
      const parts: LanguageModelV3StreamPart[] = []
      for await (const part of response.stream) parts.push(part)
      const answer = parts.filter((part) => part.type === "text-delta").map((part) => part.delta).join("")
      options.prompt.push({ role: "assistant", content: [{ type: "text", text: answer }] })
      return { parts, answer }
    },
    async cleanup() {
      await deleteActiveProcessAndWait(sk)
      deleteClaudeSessionId(sk)
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

test("provider /btw uses native control response between normal turns on the same CLI process", {
  timeout: 20_000,
}, async () => {
  const fake = createSideQuestionCli()
  try {
    const first = await fake.turn("Start the main conversation.")
    assert.equal(first.answer, "Normal answer 1")
    const active = getActiveProcess(fake.sk)
    assert.ok(active)
    const sessionId = getClaudeSessionId(fake.sk)
    assert.ok(sessionId)
    assert.equal(active.lineEmitter.listenerCount("line"), 0)

    const aside = await fake.turn("/btw What changed?")
    assert.equal(aside.answer, "Native aside after turn 1")
    assert.deepEqual(aside.parts.map((part) => part.type), [
      "stream-start", "text-start", "text-delta", "text-end", "finish",
    ])
    const textParts = aside.parts.filter((part) =>
      part.type === "text-start" || part.type === "text-delta" || part.type === "text-end",
    )
    assert.equal(new Set(textParts.map((part) => part.id)).size, 1)
    const finish = aside.parts.find((part) => part.type === "finish")!
    assert.deepEqual(finish.finishReason, { unified: "stop", raw: "stop" })
    assert.deepEqual(finish.providerMetadata, {
      "claude-code": { path: "side-question", synthetic: false, usageUnavailable: true },
    })
    assert.equal(finish.usage.inputTokens.total, 0)
    assert.equal(finish.usage.outputTokens.total, undefined)
    assert.deepEqual(finish.usage.raw, {})
    assert.equal(getActiveProcess(fake.sk), active)
    assert.equal(getClaudeSessionId(fake.sk), sessionId)
    assert.equal(isSideQuestionPending(active), false)
    assert.equal(active.lineEmitter.listenerCount("line"), 0)
    assert.deepEqual(active.unattendedLines, [], "The control response must not enter the normal replay buffer")

    const next = await fake.turn("Continue the main conversation.")
    assert.equal(next.answer, "Normal answer 2")
    for (const turn of [first, next]) {
      assert.deepEqual(turn.parts.filter((part) => part.type === "error"), [])
      const finishes = turn.parts.filter((part) => part.type === "finish")
      assert.equal(finishes.length, 1)
      assert.equal(finishes[0].finishReason.unified, "stop")
      assert.equal(finishes[0].usage.inputTokens.total, 11)
      assert.equal(finishes[0].usage.outputTokens.total, 7)
    }
    assert.equal(getActiveProcess(fake.sk), active)
    assert.equal(getClaudeSessionId(fake.sk), sessionId)
    const events = fake.events()
    assert.equal(events.filter((event) => event.type === "spawn").length, 1)
    const inputs = events.filter((event) => event.type === "input")
    assert.deepEqual(inputs.map((event) => event.pid), [active.proc.pid, active.proc.pid, active.proc.pid])
    assert.deepEqual(inputs.map((event) => event.envelope?.type), ["user", "control_request", "user"])
    const control = inputs[1].envelope!
    assert.match(control.request_id!, /^[0-9a-f-]{36}$/)
    assert.deepEqual(control, {
      type: "control_request",
      request_id: control.request_id,
      request: { subtype: "side_question", question: "What changed?" },
    })
    const users = inputs.filter((event) => event.envelope?.type === "user")
    assert.match(JSON.stringify(users[0].envelope), /Start the main conversation/)
    assert.match(JSON.stringify(users[1].envelope), /Continue the main conversation/)
    assert.doesNotMatch(JSON.stringify(users), /\/btw|What changed\?|Native aside/)
  } finally {
    await fake.cleanup()
  }
})

test("provider /btw without a live session answers with a readable explanation without spawning", async () => {
  const fake = createSideQuestionCli()
  try {
    const { parts, answer } = await fake.turn("/btw What changed?")
    assert.match(answer, /needs a live Claude Code session.*Send a normal message/)
    assert.deepEqual(parts.map((part) => part.type), ["stream-start", "text-start", "text-delta", "text-end", "finish"])
    assert.equal(getActiveProcess(fake.sk), undefined)
    assert.equal(getClaudeSessionId(fake.sk), undefined)
    assert.deepEqual(fake.events(), [])
  } finally {
    await fake.cleanup()
  }
})

test("provider empty /btw renders usage without a live session or CLI invocation", async () => {
  const fake = createSideQuestionCli()
  try {
    const { parts, answer } = await fake.turn("/btw \n\t")
    assert.equal(answer, SIDE_QUESTION_USAGE)
    assert.deepEqual(parts.map((part) => part.type), [
      "stream-start", "text-start", "text-delta", "text-end", "finish",
    ])
    const finish = parts.find((part) => part.type === "finish")!
    assert.equal(finish.finishReason.unified, "stop")
    assert.deepEqual(finish.providerMetadata, {
      "claude-code": { path: "side-question", synthetic: true, usageUnavailable: true },
    })
    assert.equal(finish.usage.inputTokens.total, 0)
    assert.equal(finish.usage.outputTokens.total, undefined)
    assert.deepEqual(finish.usage.raw, {})
    assert.equal(getActiveProcess(fake.sk), undefined)
    assert.equal(getClaudeSessionId(fake.sk), undefined)
    assert.deepEqual(fake.events(), [])
  } finally {
    await fake.cleanup()
  }
})
