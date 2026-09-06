import assert from "node:assert/strict"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  BTW_NO_SESSION_MESSAGE,
  BTW_TURN_TOO_LONG_MESSAGE,
  BtwHandledError,
  clearAsideSinks,
  clearPendingSideQuestionAnswers,
  emitAsideInline,
  fetchAsideHistory,
  formatInlineAside,
  formatInlineAsideAsk,
  handleBtwCommand,
  INLINE_ASIDE_MARKER,
  registerAsideSink,
  rememberSideQuestionAnswer,
  settleSessionBusy,
  takeSideQuestionAnswer,
  waitForAsideProcess,
  type BtwSdkClient,
  type BtwSdkMessage,
  type BtwToast,
} from "./src/btw-command.js"
import { filterSideQuestionHistory } from "./src/message-builder.js"
import { createClaudeCode, registerSideQuestionCommand } from "./src/index.js"
import type { OpenCodeConfig } from "./src/opencode-types.js"
import {
  deleteActiveProcess,
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  findActiveProcessBySessionId,
  getActiveProcess,
  sessionKey,
  setActiveProcess,
  type ActiveProcess,
} from "./src/session-manager.js"
import { SIDE_QUESTION_USAGE } from "./src/side-question.js"

type Call = { method: string; args: unknown }

function fakeClient(messages: Record<string, BtwSdkMessage[]> = {}, withStatus = true) {
  const calls: Call[] = []
  const status: Record<string, { type: string }> = {}
  const client: BtwSdkClient = {
    session: {
      // Methods, not arrows: the real SDK reads `this._client`, and the first
      // live run of the toast failed because it was called detached.
      async messages(this: unknown, { path }) {
        assert.equal(this, client.session, "SDK methods must be called on their namespace object")
        calls.push({ method: "messages", args: path.id })
        return { data: messages[path.id] ?? [] }
      },
      ...(withStatus
        ? {
            async status(this: unknown) {
              assert.equal(this, client.session, "SDK methods must be called on their namespace object")
              calls.push({ method: "status", args: undefined })
              return { data: { ...status } }
            },
          }
        : {}),
    },
    tui: {
      async showToast(this: unknown, { body }) {
        assert.equal(this, client.tui, "SDK methods must be called on their namespace object")
        calls.push({ method: "toast", args: body })
        return {}
      },
    },
  }
  const toasts = () => calls.filter((call) => call.method === "toast").map((call) => call.args as BtwToast)
  const only = (method: string) => calls.filter((call) => call.method === method)
  return { client, calls, toasts, only, status }
}

function fakeActive(sessionID: string, key: string): ActiveProcess {
  const proc = Object.assign(new EventEmitter(), {
    pid: 4242,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: () => true,
    stdin: null,
    stdout: null,
  })
  const ap: ActiveProcess = {
    proc: proc as unknown as ChildProcess,
    lineEmitter: new EventEmitter(),
    opencodeSessionID: sessionID,
    asideTransport: { cliPath: "claude", interactive: false },
  }
  setActiveProcess(key, ap)
  return ap
}

function dropActive(key: string): void {
  try {
    deleteActiveProcess(key)
  } catch {
    // The fake process has no real handles; nothing to release.
  }
}

const input = (question: string, sessionID = "ses_parent") => ({ command: "btw", sessionID, arguments: question })

test("bare /btw shows the usage text as a toast and drops the prompt", async () => {
  clearPendingSideQuestionAnswers()
  const fake = fakeClient()
  await assert.rejects(handleBtwCommand(fake.client, input("   ")), BtwHandledError)
  assert.deepEqual(fake.toasts(), [{ title: "btw", message: SIDE_QUESTION_USAGE, variant: "warning", duration: 6_000 }])
  assert.equal(takeSideQuestionAnswer("ses_parent", ""), undefined)
})

test("/btw without a live process lets the message through so the turn can explain", async () => {
  clearPendingSideQuestionAnswers()
  const fake = fakeClient()
  await handleBtwCommand(fake.client, input("why?", "ses_nobody"), { pollMs: 5, settleMs: 20 })
  assert.deepEqual(fake.toasts(), [])
  assert.equal(takeSideQuestionAnswer("ses_nobody", "why?"), undefined)
})

test("/btw typed before the turn's process is tagged waits for it instead of being queued", async () => {
  clearPendingSideQuestionAnswers()
  const key = "btw-test::late"
  const fake = fakeClient()
  fake.status.ses_late = { type: "busy" }
  const appear = setTimeout(() => fakeActive("ses_late", key), 30)
  const goIdle = setTimeout(() => {
    fake.status.ses_late = { type: "idle" }
  }, 150)
  try {
    await handleBtwCommand(fake.client, input("why?", "ses_late"), {
      pollMs: 5,
      settleMs: 20,
      spawnWaitMs: 5_000,
      timeoutMs: 5_000,
    })
    const early = takeSideQuestionAnswer("ses_late", "why?")
    assert.ok(early, "the aside is sent as soon as the process exists, not skipped")
    await assert.rejects(early, /headless Claude Code transport/, "the fake process has no stdin")
    assert.deepEqual(fake.toasts(), [], "a busy turn is not announced; the answer itself lands in the conversation")
  } finally {
    clearTimeout(appear)
    clearTimeout(goIdle)
    dropActive(key)
    clearPendingSideQuestionAnswers()
  }
})

test("/btw during a turn that never produces a claude process gives up rather than holding the message", async () => {
  clearPendingSideQuestionAnswers()
  const fake = fakeClient()
  fake.status.ses_elsewhere = { type: "busy" }
  await handleBtwCommand(fake.client, input("why?", "ses_elsewhere"), { pollMs: 5, settleMs: 10, spawnWaitMs: 40 })
  assert.deepEqual(fake.toasts(), [], "the turn belongs to another provider; nothing to say")
  assert.equal(takeSideQuestionAnswer("ses_elsewhere", "why?"), undefined)
})

test("a status that has not registered the turn yet does not skip the hold", async () => {
  const key = "btw-test::settle"
  const active = fakeActive("ses_settle", key)
  const fake = fakeClient()
  const flip = setTimeout(() => {
    fake.status.ses_settle = { type: "busy" }
  }, 20)
  try {
    assert.equal(await settleSessionBusy(fake.client, "ses_settle", active, { pollMs: 5, settleMs: 2_000 }), true)
    delete fake.status.ses_settle
    assert.equal(await settleSessionBusy(fake.client, "ses_settle", active, { pollMs: 5, settleMs: 20 }), false)
    assert.equal(await waitForAsideProcess(fake.client, "ses_settle", { pollMs: 5, settleMs: 20 }), active)
  } finally {
    clearTimeout(flip)
    dropActive(key)
  }
})

test("/btw whose early request cannot be sent still lets the message through", async () => {
  clearPendingSideQuestionAnswers()
  const key = "btw-test::no-stdin"
  fakeActive("ses_nostdin", key)
  const fake = fakeClient()
  try {
    // The fake process has no stdin, so requestSideQuestion rejects. The
    // rejection is remembered (and handled) and the queued turn asks again.
    await handleBtwCommand(fake.client, input("why?", "ses_nostdin"), { pollMs: 5, settleMs: 20 })
    const early = takeSideQuestionAnswer("ses_nostdin", "why?")
    assert.ok(early)
    await assert.rejects(early, /headless Claude Code transport/)
    assert.deepEqual(fake.toasts(), [], "an idle process gets no toast; the transcript shows the answer")
  } finally {
    dropActive(key)
    clearPendingSideQuestionAnswers()
  }
})

test("a turn that never ends makes /btw give up with a warning instead of queueing behind it", async () => {
  clearPendingSideQuestionAnswers()
  const key = "btw-test::endless"
  fakeActive("ses_endless", key)
  const fake = fakeClient()
  fake.status.ses_endless = { type: "busy" }
  try {
    await assert.rejects(
      handleBtwCommand(fake.client, input("why?", "ses_endless"), { pollMs: 5, timeoutMs: 20 }),
      BtwHandledError,
    )
    assert.equal(fake.toasts().at(-1)?.message, BTW_TURN_TOO_LONG_MESSAGE)
    assert.equal(fake.toasts().at(-1)?.variant, "warning")
  } finally {
    dropActive(key)
    clearPendingSideQuestionAnswers()
  }
})

test("without a status route the hook falls back to the process's own listener count", async () => {
  clearPendingSideQuestionAnswers()
  const key = "btw-test::nostatus"
  const active = fakeActive("ses_nostatus", key)
  const fake = fakeClient({}, false)
  try {
    const listener = () => undefined
    active.lineEmitter.on("line", listener)
    await handleBtwCommand(fake.client, input("why?", "ses_nostatus"), { pollMs: 5, timeoutMs: 20 })
    assert.deepEqual(fake.toasts(), [], "busy per the listener, and still nothing to announce")
    active.lineEmitter.off("line", listener)
  } finally {
    dropActive(key)
    clearPendingSideQuestionAnswers()
  }
})

test("an aside sink belongs to the stream that registered it", () => {
  clearAsideSinks()
  const written: string[] = []
  const first = registerAsideSink("ses_sink", (text) => {
    written.push(`first:${text}`)
    return true
  })
  assert.equal(emitAsideInline("ses_sink", "a"), true)
  const second = registerAsideSink("ses_sink", (text) => {
    written.push(`second:${text}`)
    return true
  })
  // The previous turn's cleanup must not take the current turn's sink away.
  first()
  assert.equal(emitAsideInline("ses_sink", "b"), true)
  second()
  assert.equal(emitAsideInline("ses_sink", "c"), false, "no stream is open")
  assert.deepEqual(written, ["first:a", "second:b"])
  // A closed stream reports it rather than throwing, so the toast can stand in.
  registerAsideSink("ses_sink", () => false)
  assert.equal(emitAsideInline("ses_sink", "d"), false)
  registerAsideSink("ses_sink", () => {
    throw new Error("stream is gone")
  })
  assert.equal(emitAsideInline("ses_sink", "e"), false)
  clearAsideSinks()
})

test("an aside written into a turn is marked so a rebuilt transcript drops it", () => {
  const block = formatInlineAside("  what   did i say?  ", "  You said pineapple.\n\nTwice.  ")
  assert.equal(block.trimStart().startsWith(INLINE_ASIDE_MARKER), true, "the marker leads the part")
  assert.match(block, /what did i say\?/)
  assert.match(block, /You said pineapple\./)
  assert.deepEqual(
    block.trim().split("\n").filter((line) => !line.startsWith("▌")),
    [],
    "every line carries the bar, so it runs down the whole block",
  )
  assert.match(block, /^▌ Twice\.$/m, "a blank line inside the answer keeps the bar")
  const kept = filterSideQuestionHistory([
    user("Start."),
    { role: "assistant", content: [{ type: "text", text: "Main answer" }, { type: "text", text: block }] },
    user("Next."),
  ] as never)
  assert.deepEqual(kept.map((message) => message.role), ["user", "assistant", "user"])
  assert.deepEqual(
    (kept[1] as { content: { text: string }[] }).content.map((part) => part.text),
    ["Main answer"],
    "only Claude's own text is replayed",
  )
})

test("the receipt quotes the question back, marks it sent, and is dropped like the answer", () => {
  const ask = formatInlineAsideAsk("  what   did i say?  ")
  assert.equal(ask.trimStart().startsWith(INLINE_ASIDE_MARKER), true, "the same marker leads it, so the same strip covers it")
  assert.match(ask, /what did i say\?/, "the operator sees what was sent, since the prompt box is already cleared")
  assert.match(ask, /sent to Claude on the side/)
  assert.deepEqual(
    ask.trim().split("\n").filter((line) => !line.startsWith("▌")),
    [],
    "the bar runs down the receipt too",
  )
  assert.doesNotMatch(ask, /answering|asking/i, "the note stays true once the answer lands below it")
  assert.match(ask, /^▌ \*sent to Claude on the side\*$/m, "the note has its own line, so the question is not crowded")

  const long = formatInlineAsideAsk("q".repeat(400))
  assert.equal(long.includes("q".repeat(400)), true, "the receipt is the only readback of the question, so it is never cut")
  assert.doesNotMatch(long, /\.\.\./, "nothing is elided")

  const kept = filterSideQuestionHistory([
    user("Start."),
    {
      role: "assistant",
      content: [
        { type: "text", text: "Main answer" },
        { type: "text", text: ask },
        { type: "text", text: formatInlineAside("what did i say?", "You said pineapple.") },
      ],
    },
    user("Next."),
  ] as never)
  assert.deepEqual(
    (kept[1] as { content: { text: string }[] }).content.map((part) => part.text),
    ["Main answer"],
    "receipt and answer both stay out of Claude's prompt",
  )
})

test("an aside written before the bar replaced the blockquote is still dropped", () => {
  const kept = filterSideQuestionHistory([
    user("Start."),
    {
      role: "assistant",
      content: [
        { type: "text", text: "Main answer" },
        { type: "text", text: "\n> **btw:** old shape\n>\n> Old answer.\n" },
      ],
    },
    user("Next."),
  ] as never)
  assert.deepEqual(
    (kept[1] as { content: { text: string }[] }).content.map((part) => part.text),
    ["Main answer"],
    "a conversation that predates the bar keeps its asides out of Claude's prompt",
  )
})

test("remembered answers are per session, per question, consumed once, and expire", async () => {
  clearPendingSideQuestionAnswers()
  const answer = Promise.resolve({ response: "yes", synthetic: false })
  rememberSideQuestionAnswer("ses_a", "  why?  ", answer, 1_000)
  assert.equal(takeSideQuestionAnswer("ses_b", "why?", 1_000), undefined)
  assert.equal(takeSideQuestionAnswer("ses_a", "how?", 1_000), undefined, "a different question drops the entry")
  rememberSideQuestionAnswer("ses_a", "why?", answer, 1_000)
  assert.equal(takeSideQuestionAnswer("ses_a", "why?", 1_000 + 10 * 60_000 + 1), undefined, "expired")
  rememberSideQuestionAnswer("ses_a", "why?", answer, 1_000)
  assert.equal(takeSideQuestionAnswer("ses_a", "why?", 2_000), answer)
  assert.equal(takeSideQuestionAnswer("ses_a", "why?", 2_000), undefined, "consumed")
  // A harness may append trailing metadata to the message text (opencode-dcp
  // does), so the turn's question can be longer than the hook's.
  rememberSideQuestionAnswer("ses_a", "why?", answer, 1_000)
  assert.equal(takeSideQuestionAnswer("ses_a", "why?\n\n<dcp-message-id>m0003</dcp-message-id>", 2_000), answer)
  for (let index = 0; index < 40; index++) rememberSideQuestionAnswer(`ses_${index}`, "q", answer, 5_000)
  assert.equal(takeSideQuestionAnswer("ses_0", "q", 5_000), undefined, "capped: the oldest entries are dropped")
  assert.equal(takeSideQuestionAnswer("ses_39", "q", 5_000), answer)
  clearPendingSideQuestionAnswers()
})

test("fetchAsideHistory reads earlier /btw pairs from opencode and ignores everything else", async () => {
  const fake = fakeClient({
    ses_hist: [
      { info: { role: "user" }, parts: [{ type: "text", text: "Start." }] },
      { info: { role: "assistant" }, parts: [{ type: "tool", tool: "read" }, { type: "text", text: "Done." }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "/btw First?" }, { type: "text", text: "<system-reminder>x</system-reminder>" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "Aside one" }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "/btw" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: SIDE_QUESTION_USAGE }] },
    ],
  })
  assert.deepEqual(await fetchAsideHistory(fake.client, "ses_hist", "Second?"), [{ question: "First?", response: "Aside one" }])
  assert.deepEqual(await fetchAsideHistory(fake.client, "ses_none", "Second?"), [])
  assert.deepEqual(await fetchAsideHistory(null, "ses_hist", "Second?"), [])
  fake.client.session!.messages = async () => {
    throw new Error("offline")
  }
  assert.deepEqual(await fetchAsideHistory(fake.client, "ses_hist", "Second?"), [], "a failed read is not fatal")
})

test("findActiveProcessBySessionId returns the most recently used process for a session", () => {
  const older = fakeActive("ses_dup", "btw-test::older")
  const newer = fakeActive("ses_dup", "btw-test::newer")
  try {
    assert.equal(findActiveProcessBySessionId("ses_dup"), newer)
    getActiveProcess("btw-test::older")
    assert.equal(findActiveProcessBySessionId("ses_dup"), older, "touching moves a process to the back of the LRU")
    assert.equal(findActiveProcessBySessionId("ses_other"), undefined)
  } finally {
    dropActive("btw-test::older")
    dropActive("btw-test::newer")
  }
})

test("registerSideQuestionCommand reports ownership so a user-defined btw command is left alone", () => {
  const ours: OpenCodeConfig = {}
  assert.equal(registerSideQuestionCommand(ours), true)
  assert.equal(registerSideQuestionCommand(ours), false, "re-running config keeps the first registration")
  assert.equal(ours.command?.btw?.template, "/btw $ARGUMENTS")
  const theirs: OpenCodeConfig = { command: { btw: { template: "mine $ARGUMENTS" } } }
  assert.equal(registerSideQuestionCommand(theirs), false)
  assert.equal(theirs.command?.btw?.template, "mine $ARGUMENTS")
})

function createAsideCli() {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-btw-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const eventsPath = join(cwd, "events.jsonl")
  writeFileSync(eventsPath, "")
  writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
const record = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({ ...event, pid: process.pid }) + "\\n")
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.258\\n")
  process.exit(0)
}
if (process.argv.includes("--help")) {
  process.stdout.write("--plugin-dir <path>\\n")
  process.exit(0)
}
record({ type: "spawn" })
let asides = 0
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const envelope = JSON.parse(line)
  record({ type: "input", envelope })
  if (envelope.type === "control_request" && envelope.request?.subtype === "side_question") {
    asides++
    emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: envelope.request_id,
        response: { response: "Aside " + asides + ": " + envelope.request.question, synthetic: false },
      },
    })
    return
  }
  const answer = () => {
    emit({
      type: "assistant",
      session_id: "fake-session",
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Main answer" }] },
    })
    emit({ type: "result", subtype: "success", session_id: "fake-session", is_error: false, usage: { input_tokens: 3, output_tokens: 2 } })
  }
  // "SLOW" keeps the turn's stream open long enough for a test to write an
  // aside into it, which is what happens for real while a turn is streaming.
  if (line.includes("SLOW")) setTimeout(answer, 1500)
  else answer()
})
`, { mode: 0o755 })
  const modelId = "claude-test-btw"
  const model = createClaudeCode({
    cliPath,
    cwd,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    interactive: false,
    autoContinueIncompleteTurns: false,
  }).languageModel(modelId)
  const keyFor = (sessionID: string) =>
    sessionKey(cwd, `${modelId}::tools::${sessionID}::context=["claude-code",null]`)
  const tools = [{ type: "function" as const, name: "read", inputSchema: { type: "object", properties: {} } }]
  return {
    keyFor,
    modelId,
    events: () => readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map((line) =>
      JSON.parse(line) as { type: string; pid: number; envelope?: { type: string; request?: Record<string, unknown> } },
    ),
    async turn(sessionID: string, prompt: LanguageModelV3CallOptions["prompt"]) {
      const response = await model.doStream({
        prompt,
        tools,
        providerOptions: { "claude-code": { opencodeSessionID: sessionID } },
        abortSignal: AbortSignal.timeout(5_000),
      })
      const parts: LanguageModelV3StreamPart[] = []
      for await (const part of response.stream) parts.push(part)
      const errors = parts.filter((part) => part.type === "error")
      const answer = parts.filter((part) => part.type === "text-delta").map((part) => part.delta).join("")
      const finish = parts.find((part) => part.type === "finish")
      return { parts, answer, errors, finish }
    },
    async cleanup(sessionIDs: string[]) {
      for (const sessionID of sessionIDs) {
        await deleteActiveProcessAndWait(keyFor(sessionID))
        deleteClaudeSessionId(keyFor(sessionID))
      }
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] })
const assistant = (text: string) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }] })

test("the hook asks early while the turn is busy, and the queued /btw turn answers from that without asking again", {
  timeout: 20_000,
}, async () => {
  clearPendingSideQuestionAnswers()
  const fake = createAsideCli()
  const fakeSdk = fakeClient()
  try {
    const first = await fake.turn("ses_main", [user("Start.")])
    assert.equal(first.answer, "Main answer")
    const active = getActiveProcess(fake.keyFor("ses_main"))
    assert.ok(active)
    assert.equal(active.opencodeSessionID, "ses_main")
    assert.equal(active.asideTransport?.interactive, false)
    assert.match(active.asideTransport?.cliPath ?? "", /fake-claude\.cjs$/)

    // opencode reports the session busy (a tool may be running with no stream
    // attached, so the process's own listener count is not consulted).
    fakeSdk.status.ses_main = { type: "busy" }
    let released = false
    // Busy with no stream open to write into, which is what a tool step looks
    // like: the answer has nowhere to go yet, so the message is held and
    // carries it once the turn ends.
    const hook = handleBtwCommand(fakeSdk.client, input("First?", "ses_main"), { pollMs: 5, inlineWaitMs: 0 }).then(() => {
      released = true
    })
    const early = await (async () => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const found = takeSideQuestionAnswer("ses_main", "First?")
        if (found) return found
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      return undefined
    })()
    assert.ok(early, "the early answer is remembered while the turn is still running")
    rememberSideQuestionAnswer("ses_main", "First?", early)
    const earlyResult = await early
    assert.equal(earlyResult.response, "Aside 1: First?")
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(fakeSdk.toasts(), [], "the answer is never toasted; it lands in the conversation")
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(released, false, "the /btw message is held back while the turn runs")

    // The turn ends: the hook lets opencode create the message, which runs at once.
    fakeSdk.status.ses_main = { type: "idle" }
    await hook
    assert.equal(released, true)
    const queued = await fake.turn("ses_main", [user("Start."), assistant("Main answer"), user("/btw First?")])
    assert.deepEqual(queued.errors, [])
    assert.equal(queued.answer, "Aside 1: First?")
    assert.equal((queued.finish as any)?.providerMetadata?.["claude-code"]?.path, "side-question")
    assert.equal(fake.events().filter((event) => event.envelope?.type === "control_request").length, 1, "answered from the early request")

    // A follow-up typed while idle: the hook asks at once, the turn takes it, with history.
    await handleBtwCommand(fakeSdk.client, input("Second?", "ses_main"), { pollMs: 5, settleMs: 20 })
    assert.deepEqual(fakeSdk.toasts(), [], "still nothing toasted")
    const followUp = await fake.turn("ses_main", [
      user("Start."), assistant("Main answer"), user("/btw First?"), assistant("Aside 1: First?"), user("/btw Second?"),
    ])
    assert.deepEqual(followUp.errors, [])
    assert.equal(followUp.answer, "Aside 2: Second?")

    // No early answer at all (a client that bypasses commands): the idle process is asked directly, with history.
    const direct = await fake.turn("ses_main", [
      user("Start."), assistant("Main answer"), user("/btw First?"), assistant("Aside 1: First?"),
      user("/btw Second?"), assistant("Aside 2: Second?"), user("/btw Third?"),
    ])
    assert.equal(direct.answer, "Aside 3: Third?")

    const inputs = fake.events().filter((event) => event.type === "input")
    assert.deepEqual(inputs.map((event) => event.envelope?.type), ["user", "control_request", "control_request", "control_request"])
    assert.deepEqual(inputs[1].envelope?.request, { subtype: "side_question", question: "First?" })
    assert.deepEqual(inputs[3].envelope?.request, {
      subtype: "side_question",
      question: "Third?",
      history: [
        { question: "First?", response: "Aside 1: First?" },
        { question: "Second?", response: "Aside 2: Second?" },
      ],
    })
    assert.equal(fake.events().filter((event) => event.type === "spawn").length, 1, "asides never spawn")

    // A conversation with no live process gets a readable explanation, not an error.
    const lonely = await fake.turn("ses_lonely", [user("/btw Anyone?")])
    assert.deepEqual(lonely.errors, [])
    assert.equal(lonely.answer, BTW_NO_SESSION_MESSAGE)
    assert.equal(getActiveProcess(fake.keyFor("ses_lonely")), undefined)
  } finally {
    fakeSdk.status.ses_main = { type: "idle" }
    await fake.cleanup(["ses_main", "ses_lonely"])
    clearPendingSideQuestionAnswers()
  }
})

test("an answer that arrives while a turn is streaming is written into that turn's own reply", {
  timeout: 30_000,
}, async () => {
  clearPendingSideQuestionAnswers()
  clearAsideSinks()
  const fake = createAsideCli()
  const fakeSdk = fakeClient()
  try {
    // A first turn only so the conversation has a live process to ask.
    assert.equal((await fake.turn("ses_inline", [user("Start.")])).answer, "Main answer")
    fakeSdk.status.ses_inline = { type: "busy" }

    const streaming = fake.turn("ses_inline", [user("Start."), assistant("Main answer"), user("SLOW next.")])
    await assert.rejects(
      // Bounded so a missing sink fails on the assertions below rather than
      // hanging on a conversation this test never marks idle.
      handleBtwCommand(fakeSdk.client, input("What did i say?", "ses_inline"), {
        pollMs: 5,
        inlinePollMs: 5,
        inlineWaitMs: 3_000,
        timeoutMs: 3_000,
      }),
      BtwHandledError,
      "the message is dropped because the answer is already in the conversation",
    )
    const turn = await streaming
    assert.deepEqual(turn.errors, [])
    assert.match(turn.answer, /▌ \*\*btw:\*\* What did i say\?/)
    assert.match(
      turn.answer,
      /▌ \*\*btw:\*\* What did i say\?\n▌ \*sent to Claude on the side\*/,
      "the receipt names the question it took, since no /btw message is ever created to show it",
    )
    assert.match(turn.answer, /Aside 1: What did i say\?/)
    assert.match(turn.answer, /Main answer/, "the turn still delivers its own reply")
    assert.ok(
      turn.answer.indexOf("sent to Claude on the side") < turn.answer.indexOf("Aside 1:"),
      "a receipt that landed after its own answer would read backwards",
    )
    assert.ok(
      turn.parts.filter((part) => part.type === "text-start").length >= 3,
      "receipt and answer are blocks of their own, so each marker leads a part",
    )
    assert.deepEqual(fakeSdk.toasts(), [], "nothing is toasted: the conversation itself carries the answer")
    assert.equal(emitAsideInline("ses_inline", "late"), false, "the sink goes with the stream")
  } finally {
    fakeSdk.status.ses_inline = { type: "idle" }
    await fake.cleanup(["ses_inline"])
    clearAsideSinks()
    clearPendingSideQuestionAnswers()
  }
})
