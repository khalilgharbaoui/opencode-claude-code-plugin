import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"

import { createClaudeCode } from "../src/index.js"
import { FORWARD_SETTLE_MS } from "../src/claude-code-language-model.js"
import { getTrailingUserMessages } from "../src/message-builder.js"
import {
  getPendingProxyCalls,
  markPendingProxyCallEmitted,
  queuePendingProxyCall,
  rejectAllPendingProxyCallsForSession,
} from "../src/proxy-broker.js"
import {
  deleteActiveProcess,
  deleteClaudeSessionId,
  sessionKey,
  setActiveProcess,
  setClaudeSessionId,
  type ActiveProcess,
} from "../src/session-manager.js"

const NOTICE =
  '<pty_exited>\n{"ptyID":"pty_persistent_1","sessionID":"ses_A","exitCode":1,"result":"error"}\nUse pty_read to inspect retained output.\n</pty_exited>'

const userText = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] })
const toolResult = (id: string, value: string) => ({
  role: "tool" as const,
  content: [{ type: "tool-result" as const, toolCallId: id, toolName: "bash", output: { type: "text" as const, value } }],
})
const assistantCalls = (...ids: string[]) => ({
  role: "assistant" as const,
  content: ids.map((id) => ({ type: "tool-call" as const, toolCallId: id, toolName: "bash", input: {} })),
})

test("trailing user messages are those after the last assistant message, tool results excluded", () => {
  const found = getTrailingUserMessages([
    userText("old"),
    assistantCalls("a"),
    toolResult("a", "done"),
    userText(NOTICE),
    userText("  "),
    userText("steered prompt"),
  ] as any)
  assert.equal(found.assistantIndex, 1)
  assert.deepEqual(found.messages, [
    [{ type: "text", text: NOTICE }],
    [{ type: "text", text: "steered prompt" }],
  ])
})

test("no assistant message means every user message is trailing; none at all is empty", () => {
  assert.deepEqual(getTrailingUserMessages([userText("first")] as any), {
    assistantIndex: -1,
    messages: [[{ type: "text", text: "first" }]],
  })
  assert.deepEqual(getTrailingUserMessages([userText("x"), assistantCalls("a"), toolResult("a", "r")] as any), {
    assistantIndex: 1,
    messages: [],
  })
})

/** Ends a turn the way the CLI would, so its watchdogs are cleared and the test does not wait them out. */
async function finishTurn(active: ActiveProcess, stream: ReadableStream<unknown>): Promise<void> {
  active.lineEmitter.emit("line", JSON.stringify({ type: "result", session_id: "forward-session", is_error: false }))
  const reader = stream.getReader()
  try {
    for (let part = await reader.read(); !part.done; part = await reader.read());
  } catch {
    // a stream the turn already errored out of is finished all the same
  }
}

async function eventually(label: string, predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`${label} did not settle`)
}

// loom:tc LDV-235
test("a notice that arrives beside a proxied tool result reaches the CLI once", async () => {
  const cwd = process.cwd()
  const modelId = "claude-test-forward-user-content"
  const sk = sessionKey(cwd, `${modelId}::tools::default::context=["claude-code",null]`)
  const writes: string[] = []
  const proc = Object.assign(new EventEmitter(), {
    stdin: { write: (line: string) => { writes.push(line); return true } },
    kill: () => true,
  }) as unknown as ChildProcess
  const active: ActiveProcess = { proc, lineEmitter: new EventEmitter(), unattendedLines: [] }
  const channel = { closed: false }
  const options: LanguageModelV3CallOptions = {
    tools: [{ type: "function", name: "bash", inputSchema: { type: "object" } }],
    prompt: [userText("Start."), assistantCalls("call-A", "call-B"), toolResult("call-A", "result A"), userText(NOTICE)] as any,
  }
  const model = createClaudeCode({
    cwd, cliPath: process.execPath, bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false, proxyTools: [], autoContinueIncompleteTurns: false,
  }).languageModel(modelId)
  try {
    setActiveProcess(sk, active)
    setClaudeSessionId(sk, "forward-session")
    for (const id of ["call-A", "call-B"]) {
      queuePendingProxyCall(sk, { id, toolName: "bash", input: {}, channel, resolve: () => {}, reject: () => {} })
      markPendingProxyCallEmitted(id)
    }

    const first = await model.doStream(options)
    await eventually("first result resolved and notice forwarded", () => writes.length === 1)
    const sent = JSON.parse(writes[0])
    assert.equal(sent.type, "user")
    assert.deepEqual(sent.message.content, [{ type: "text", text: NOTICE }])
    // The matched call resolves after the head start the message was given.
    await eventually("the matched call resolved", () => getPendingProxyCalls(sk).length === 1)
    assert.equal(getPendingProxyCalls(sk).length, 1, "the sibling call stays parked")

    // The sibling's result lands in a later opencode turn for the same assistant boundary.
    options.prompt.push(toolResult("call-B", "result B") as any)
    const second = await model.doStream(options)
    await eventually("second result resolved", () => getPendingProxyCalls(sk).length === 0)
    assert.equal(writes.length, 1, "the notice must not be sent again for the same boundary")

    // A user message that arrives at the next boundary is a new one and is sent.
    options.prompt.push(assistantCalls("call-C") as any, toolResult("call-C", "result C") as any, userText("second notice") as any)
    queuePendingProxyCall(sk, { id: "call-C", toolName: "bash", input: {}, channel, resolve: () => {}, reject: () => {} })
    markPendingProxyCallEmitted("call-C")
    const third = await model.doStream(options)
    await eventually("second notice forwarded", () => writes.length === 2)
    assert.deepEqual(JSON.parse(writes[1]).message.content, [{ type: "text", text: "second notice" }])
    await finishTurn(active, first.stream)
    await finishTurn(active, second.stream)
    await finishTurn(active, third.stream)
  } finally {
    rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
    deleteActiveProcess(sk)
    deleteClaudeSessionId(sk)
  }
})

// loom:tc LDV-235
test("a tool-result turn with no user message beside it writes nothing", async () => {
  const cwd = process.cwd()
  const modelId = "claude-test-forward-user-content-none"
  const sk = sessionKey(cwd, `${modelId}::tools::default::context=["claude-code",null]`)
  const writes: string[] = []
  const proc = Object.assign(new EventEmitter(), {
    stdin: { write: (line: string) => { writes.push(line); return true } },
    kill: () => true,
  }) as unknown as ChildProcess
  const active: ActiveProcess = { proc, lineEmitter: new EventEmitter(), unattendedLines: [] }
  const options: LanguageModelV3CallOptions = {
    tools: [{ type: "function", name: "bash", inputSchema: { type: "object" } }],
    prompt: [userText("Start."), assistantCalls("call-A"), toolResult("call-A", "result A")] as any,
  }
  const model = createClaudeCode({
    cwd, cliPath: process.execPath, bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false, proxyTools: [], autoContinueIncompleteTurns: false,
  }).languageModel(modelId)
  try {
    setActiveProcess(sk, active)
    setClaudeSessionId(sk, "forward-session-none")
    queuePendingProxyCall(sk, { id: "call-A", toolName: "bash", input: {}, channel: { closed: false }, resolve: () => {}, reject: () => {} })
    markPendingProxyCallEmitted("call-A")
    const only = await model.doStream(options)
    await eventually("result resolved", () => getPendingProxyCalls(sk).length === 0)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(writes.length, 0)
    await finishTurn(active, only.stream)
  } finally {
    rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
    deleteActiveProcess(sk)
    deleteClaudeSessionId(sk)
  }
})

test("the same cleaning as the envelope path applies to forwarded messages", () => {
  const reminder = "<dcp-system-reminder>use the compress tool now</dcp-system-reminder>"
  const prompt = [
    userText("Start."),
    assistantCalls("a"),
    toolResult("a", "done"),
    userText(`${NOTICE}\n\n${reminder}`),
  ] as any
  assert.deepEqual(getTrailingUserMessages(prompt).messages, [[{ type: "text", text: `${NOTICE}\n\n${reminder}` }]])
  assert.deepEqual(getTrailingUserMessages(prompt, { stripContextReminders: true }).messages, [
    [{ type: "text", text: NOTICE }],
  ])
})

// loom:tc LDV-235
test("the message is written to the CLI before the parked call is resolved", async () => {
  const cwd = process.cwd()
  const modelId = "claude-test-forward-user-content-order"
  const sk = sessionKey(cwd, `${modelId}::tools::default::context=["claude-code",null]`)
  const events: string[] = []
  const at: Record<string, number> = {}
  const proc = Object.assign(new EventEmitter(), {
    stdin: { write: () => { events.push("write"); at.write = Date.now(); return true } },
    kill: () => true,
  }) as unknown as ChildProcess
  const active: ActiveProcess = { proc, lineEmitter: new EventEmitter(), unattendedLines: [] }
  const options: LanguageModelV3CallOptions = {
    tools: [{ type: "function", name: "bash", inputSchema: { type: "object" } }],
    prompt: [userText("Start."), assistantCalls("call-A"), toolResult("call-A", "result A"), userText(NOTICE)] as any,
  }
  const model = createClaudeCode({
    cwd, cliPath: process.execPath, bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false, proxyTools: [], autoContinueIncompleteTurns: false,
  }).languageModel(modelId)
  try {
    setActiveProcess(sk, active)
    setClaudeSessionId(sk, "forward-session")
    queuePendingProxyCall(sk, {
      id: "call-A", toolName: "bash", input: {}, channel: { closed: false },
      resolve: () => { events.push("resolve"); at.resolve = Date.now() }, reject: () => {},
    })
    markPendingProxyCallEmitted("call-A")
    const response = await model.doStream(options)
    await eventually("resolved", () => events.includes("resolve"))
    assert.deepEqual(events, ["write", "resolve"])
    // The CLI reads stdin and the proxy response on separate paths: the message
    // gets a head start so it queues before the result is consumed.
    assert.ok(at.resolve - at.write >= 100, `resolved ${at.resolve - at.write} ms after the write`)
    await finishTurn(active, response.stream)
  } finally {
    rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
    deleteActiveProcess(sk)
    deleteClaudeSessionId(sk)
  }
})

// loom:tc LDV-235
test("an abort inside the head start leaves no completion for a call the CLI was told was rejected", async () => {
  const cwd = process.cwd()
  const modelId = "claude-test-forward-user-content-abort"
  const sk = sessionKey(cwd, `${modelId}::tools::default::context=["claude-code",null]`)
  const events: string[] = []
  const proc = Object.assign(new EventEmitter(), {
    stdin: { write: (line: string) => { events.push(JSON.parse(line).type === "user" ? "write" : "other"); return true } },
    kill: () => true,
  }) as unknown as ChildProcess
  const active: ActiveProcess = { proc, lineEmitter: new EventEmitter(), unattendedLines: [] }
  const abort = new AbortController()
  const options: LanguageModelV3CallOptions = {
    abortSignal: abort.signal,
    tools: [{ type: "function", name: "bash", inputSchema: { type: "object" } }],
    prompt: [userText("Start."), assistantCalls("call-A"), toolResult("call-A", "result A"), userText(NOTICE)] as any,
  }
  const model = createClaudeCode({
    cwd, cliPath: process.execPath, bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false, proxyTools: [], autoContinueIncompleteTurns: false,
  }).languageModel(modelId)
  try {
    setActiveProcess(sk, active)
    setClaudeSessionId(sk, "forward-session")
    queuePendingProxyCall(sk, {
      id: "call-A", toolName: "bash", input: {}, channel: { closed: false },
      resolve: () => { events.push("resolve") }, reject: () => { events.push("reject") },
    })
    markPendingProxyCallEmitted("call-A")
    const response = await model.doStream(options)
    await eventually("the message written", () => events.includes("write"))
    abort.abort()
    await new Promise((resolve) => setTimeout(resolve, FORWARD_SETTLE_MS + 150))
    assert.ok(!events.includes("resolve"), `the aborted call must not be resolved: ${JSON.stringify(events)}`)
    assert.equal(getPendingProxyCalls(sk).length, 0, "the abort released the call")
    assert.equal(active.pendingProxyCompletions?.size ?? 0, 0, "and no completion is kept for it")
    await finishTurn(active, response.stream)
  } finally {
    rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
    deleteActiveProcess(sk)
    deleteClaudeSessionId(sk)
  }
})

test("the interactive transport is never forwarded to: the write would supersede the parked turn", async () => {
  const cwd = process.cwd()
  const modelId = "claude-test-forward-user-content-pty"
  const sk = sessionKey(cwd, `${modelId}::tools::default::context=["claude-code",null]`)
  const writes: string[] = []
  const proc = Object.assign(new EventEmitter(), {
    stdin: { write: (line: string) => { writes.push(line); return true } },
    kill: () => true,
  }) as unknown as ChildProcess
  // The PTY shim's marker. Its stdin turns every write into a new TUI turn.
  const active: ActiveProcess = {
    proc,
    lineEmitter: new EventEmitter(),
    unattendedLines: [],
    interactiveControl: {
      turnRunning: () => true,
      interrupt: async () => true,
      flushTranscript: () => {},
    },
  }
  const channel = { closed: false }
  const model = createClaudeCode({
    cwd, cliPath: process.execPath, bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false, proxyTools: [], autoContinueIncompleteTurns: false,
  }).languageModel(modelId)
  try {
    setActiveProcess(sk, active)
    setClaudeSessionId(sk, "forward-session")
    queuePendingProxyCall(sk, { id: "call-P", toolName: "bash", input: {}, channel, resolve: () => {}, reject: () => {} })
    markPendingProxyCallEmitted("call-P")
    const result = await model.doStream({
      tools: [{ type: "function", name: "bash", inputSchema: { type: "object" } }],
      prompt: [userText("Start."), assistantCalls("call-P"), toolResult("call-P", "result P"), userText(NOTICE)] as any,
    })
    await eventually("the matched call resolved", () => getPendingProxyCalls(sk).length === 0)
    // Finished before asserting, so a failure cannot leave its watchdogs running.
    await finishTurn(active, result.stream)
    assert.deepEqual(writes, [], "nothing is written to the shim's stdin")
  } finally {
    rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
    deleteActiveProcess(sk)
    deleteClaudeSessionId(sk)
  }
})
