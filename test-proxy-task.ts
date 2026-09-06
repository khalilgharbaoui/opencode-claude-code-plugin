import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin, { createClaudeCode } from "./src/index.js"
import {
  createProxyMcpServer,
  DEFAULT_PROXY_TOOLS,
  disallowedToolFlags,
  isExpectedCleanupError,
  resolveProxyClientCeilingMs,
  SERVER_CLOSED_MESSAGE,
  type ProxyMcpServer,
} from "./src/proxy-mcp.js"
import {
  getPendingProxyCalls,
  markPendingProxyCallEmitted,
  onPendingProxyCall,
  queuePendingProxyCall,
  rejectAllPendingProxyCallsForSession,
  rejectPendingProxyCallById,
  resolvePendingProxyCallById,
  type PendingProxyCall,
} from "./src/proxy-broker.js"
import {
  deleteActiveProcess,
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  getActiveProcess,
  setActiveProcess,
  setClaudeSessionId,
  bufferUnattendedLine,
  type ActiveProcess,
  sessionKey,
} from "./src/session-manager.js"

const TASK_INPUT = {
  description: "Inspect provider flow",
  prompt: "Verify the provider delegates this task through opencode.",
  subagent_type: "general",
  task_id: "task-existing",
  command: "/delegate",
  background: true,
}
const PARALLEL_TASK_INPUT = {
  ...TASK_INPUT,
  description: "Inspect parallel flow",
  task_id: "task-parallel",
  background: false,
}

function modelProxyTools(settings: { proxyTools?: string[] } = {}) {
  const provider = createClaudeCode(settings)
  const model = provider.languageModel("claude-haiku-4-5") as unknown as {
    config: { proxyTools?: string[] }
  }
  return model.config.proxyTools
}

function createFakeTaskCli(
  mode:
    | "normal"
    | "race"
    | "batch"
    | "duplicate"
    | "error"
    | "abort"
    | "followup"
    | "late"
    | "late-queued"
    | "swallow"
    | "bookkeeping"
    | "bookkeeping-respawn"
    | "task_batch",
) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-proxy-task-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const eventsPath = join(cwd, "events.jsonl")
  const source = `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")

if (process.argv.includes("--version")) {
  process.stdout.write("2.1.142\\n")
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
      // A real MCP client replays the configured headers on every request;
      // the proxy server requires its bearer token, so do the same here.
      proxyHeaders = entry?.headers ?? proxyHeaders
    } catch {}
  }
}

if (!proxyUrl) {
  process.stderr.write("missing opencode proxy URL\\n")
  process.exit(2)
}

const mode = ${JSON.stringify(mode)}
const taskInput = ${JSON.stringify(TASK_INPUT)}
const secondTaskInput = ${JSON.stringify(PARALLEL_TASK_INPUT)}
const assistant = {
  type: "assistant",
  session_id: "fake-session",
  message: {
    role: "assistant",
    stop_reason: "end_turn",
    content: [
      { type: "text", text: "I found the relevant files and will delegate the focused check." },
      ...(mode === "task_batch"
        ? [{
            type: "tool_use",
            id: "claude-proxy-task-batch",
            name: "mcp__opencode_proxy__task_batch",
            input: { tasks: [taskInput, secondTaskInput] },
          }]
        : [{
            type: "tool_use",
            id: "claude-proxy-task",
            name: "mcp__opencode_proxy__task",
            input: taskInput,
          }]),
      ...(mode === "batch"
        ? [{
            type: "tool_use",
            id: "claude-proxy-task-2",
            name: "mcp__opencode_proxy__task",
            input: secondTaskInput,
          }]
        : []),
    ],
  },
}
const result = {
  type: "result",
  subtype: "success",
  session_id: "fake-session",
  duration_ms: 1,
  num_turns: 1,
  is_error: false,
  usage: { input_tokens: 1, output_tokens: 1 },
}

function emit(message) {
  process.stdout.write(JSON.stringify(message) + "\\n")
}

function emitAssistant() {
  if (mode === "abort") {
    emit({
      ...assistant,
      message: {
        ...assistant.message,
        content: assistant.message.content.filter((block) => block.type === "tool_use"),
      },
    })
    return
  }
  if (mode === "normal" || mode === "task_batch") {
    emit(assistant)
    return
  }

  emit({
    type: "stream_event",
    session_id: "fake-session",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  })
  emit({
    type: "stream_event",
    session_id: "fake-session",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text: "I found the relevant files and will delegate the focused check.",
      },
    },
  })
  emit({
    type: "stream_event",
    session_id: "fake-session",
    event: { type: "content_block_stop", index: 0 },
  })
  emit({
    type: "stream_event",
    session_id: "fake-session",
    event: {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "claude-proxy-task",
        name: "mcp__opencode_proxy__task",
      },
    },
  })
  emit({
    type: "stream_event",
    session_id: "fake-session",
    event: {
      type: "content_block_delta",
      index: 1,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(taskInput),
      },
    },
  })
  emit({
    type: "stream_event",
    session_id: "fake-session",
    event: { type: "content_block_stop", index: 1 },
  })
  emit({
    type: "stream_event",
    session_id: "fake-session",
    event: {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
    },
  })
  emit(assistant)
}

async function callTask(input = taskInput, id = 1, signal, name = "task") {
  const response = await fetch(proxyUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: recoveryMode ? "application/json, text/event-stream" : "application/json",
      ...proxyHeaders,
    },
    signal,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: name, arguments: input },
    }),
  })
  if (recoveryMode) {
    record({ type: "http-response", id, status: response.status, contentType: response.headers.get("content-type") })
  }
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const body = await response.text()
    const data = body.split("\\n").find((line) => line.startsWith("data: "))
    if (!data) throw new Error("SSE response had no JSON-RPC result")
    return JSON.parse(data.slice(6))
  }
  return response.json()
}

const recoveryMode = ["late", "late-queued", "swallow", "bookkeeping", "bookkeeping-respawn"].includes(mode)
const swallowMode = mode === "swallow" || mode.startsWith("bookkeeping")
const eventsPath = ${JSON.stringify(eventsPath)}
function record(event) {
  fs.appendFileSync(eventsPath, JSON.stringify(event) + "\\n")
}
function answer(text) {
  emit({
    ...assistant,
    message: {
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
    },
  })
  emit(result)
}
const resumed = args.includes("--resume")
if (recoveryMode) {
  emit({ type: "system", subtype: "init", session_id: "fake-session" })
  const promptIndex = args.indexOf("--append-system-prompt-file")
  record({
    type: "spawn",
    args,
    pid: process.pid,
    proxyUrl,
    resumed,
    prompt: promptIndex >= 0 ? fs.readFileSync(args[promptIndex + 1], "utf8") : null,
  })
}
const abandoned = new AbortController()
let secondTaskBody
let lateEnvelopeReceived = false
function finishQueuedTask() {
  if (secondTaskBody && lateEnvelopeReceived) {
    answer("Fresh answer after queued task: " + secondTaskBody.result.content[0].text)
  }
}
if (recoveryMode && !swallowMode) {
  // The test signals only after the provider stream has closed on tool-calls.
  process.once("SIGUSR2", () => {
    abandoned.abort()
    record({ type: "abandoned" })
    answer("Unattended narration after the task connection timed out.")
    if (mode === "late-queued") {
      void callTask(secondTaskInput, 2).then((body) => {
        secondTaskBody = body
        record({ type: "queued-result", body })
        finishQueuedTask()
      }).catch((error) => record({ type: "fixture-error", message: error.message }))
    }
  })
}

let handled = false
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (recoveryMode) {
    const envelope = JSON.parse(line)
    record({ type: "input", envelope, resumed })
    if (handled || resumed) {
      const content = envelope.message?.content
      const isCompletion = envelope.type === "user" &&
        envelope.message?.role === "user" && Array.isArray(content) &&
        content.length > 0 && content.every((block) => block.type === "text") &&
        content.some((block) => block.text.includes("subagent complete"))
      if (!isCompletion) {
        record({ type: "fixture-error", message: "Expected a plain user completion envelope" })
        return
      }
      lateEnvelopeReceived = true
      if (mode === "bookkeeping-respawn") {
        emit({ type: "system", subtype: "status", status: null })
        emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "old-call", content: "ack" }] } })
        return
      }
      if (mode === "late-queued") finishQueuedTask()
      else answer(resumed ? "Fresh answer after watchdog recovery." : "Fresh answer after late completion.")
      return
    }
    handled = true
    emitAssistant()
    void callTask(taskInput, 1, abandoned.signal).then((body) => {
      // A successful HTTP response alone does not prove the CLI resumed.
      record({ type: "swallowed-result", body })
      if (mode.startsWith("bookkeeping")) {
        emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "old-call", content: "ack" }] } })
      }
    }).catch((error) => {
      if (!abandoned.signal.aborted) record({ type: "fixture-error", message: error.message })
    })
    return
  }
  if (handled) return
  handled = true
  emitAssistant()
  if (mode === "abort") {
    void callTask().catch(() => {})
    return
  }
  if (mode === "race") {
    emit(result)
    setTimeout(() => void callTask().catch(() => {}), 25)
    return
  }
  if (mode === "error") {
    emit({ ...result, is_error: true, result: "fake task transport error" })
    return
  }
  if (mode === "batch") {
    void callTask().catch(() => {})
    setTimeout(() => void callTask(secondTaskInput, 2).catch(() => {}), 25)
    setTimeout(() => emit(result), 50)
    return
  }
  if (mode === "duplicate") {
    void callTask().catch(() => {})
    setTimeout(() => emit(result), 30)
    setTimeout(() => emit(result), 40)
    return
  }
  if (mode === "task_batch") {
    // One MCP call carrying two tasks; the plugin fans it out and the
    // gathered result comes back on this single HTTP response.
    void callTask({ tasks: [taskInput, secondTaskInput] }, 1, undefined, "task_batch")
      .then((body) => {
        emit({
          type: "assistant",
          session_id: "fake-session",
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [{
              type: "text",
              text: "Batch received: " + body.result.content[0].text,
            }],
          },
        })
        emit({ ...result, num_turns: 2 })
      })
      .catch(() => {})
    setTimeout(() => emit(result), 100)
    return
  }
  if (mode === "followup") {
    void callTask()
      .then((body) => {
        emit({
          type: "assistant",
          session_id: "fake-session",
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [{
              type: "text",
              text: "Parent received: " + body.result.content[0].text,
            }],
          },
        })
        emit({ ...result, num_turns: 2 })
      })
      .catch(() => {})
    setTimeout(() => emit(result), 100)
    return
  }
  void callTask().catch(() => {})
  setTimeout(() => emit(result), 100)
})
`
  writeFileSync(cliPath, source)
  chmodSync(cliPath, 0o755)
  return { cliPath, cwd, eventsPath }
}

async function streamTaskBoundary(
  mode: "normal" | "race" | "batch" | "duplicate" | "error" | "task_batch",
) {
  const fake = createFakeTaskCli(mode)
  const modelId = `claude-test-task-${mode}`
  const sk = sessionKey(fake.cwd, `${modelId}::tools::default::context=["claude-code",null]`)

  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: ["Task"],
    }).languageModel(modelId)
    const response = await model.doStream({
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "Delegate the focused provider check." }],
        },
      ],
      tools: [
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
    return {
      parts,
      pending: getPendingProxyCalls(sk).map((call) => ({ ...call })),
    }
  } finally {
    for (const call of getPendingProxyCalls(sk)) {
      resolvePendingProxyCallById(call.toolCallId, {
        kind: "text",
        text: "test cleanup",
      })
    }
    deleteActiveProcess(sk)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
}

function assertNativeTaskBoundary(
  parts: any[],
  pending: any[],
  expectedInputs = [TASK_INPUT],
) {
  const taskCalls = parts.filter(
    (part) => part.type === "tool-call" && part.toolName === "task",
  )
  assert.equal(taskCalls.length, expectedInputs.length)
  assert.ok(taskCalls.every((call) => call.providerExecuted === false))
  assert.deepEqual(
    taskCalls.map((call) => JSON.parse(call.input)),
    expectedInputs,
  )

  const finishes = parts.filter((part) => part.type === "finish")
  assert.equal(finishes.length, 1)
  assert.equal(finishes[0].finishReason.unified, "tool-calls")

  const textIndex = parts.findIndex((part) => part.type === "text-delta")
  const taskIndex = parts.indexOf(taskCalls[0])
  assert.ok(textIndex >= 0)
  assert.ok(textIndex < taskIndex)

  assert.equal(pending.length, expectedInputs.length)
  assert.ok(pending.every((call) => call.toolName === "task"))
  assert.deepEqual(
    pending.map((call) => call.input),
    expectedInputs,
  )
}

async function postRpc(
  srv: ProxyMcpServer,
  request: Record<string, unknown>,
) {
  const response = await fetch(srv.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // The proxy endpoint requires the per-server bearer token.
      authorization: `Bearer ${srv.authToken}`,
    },
    body: JSON.stringify(request),
  })
  if (response.status === 204) return { status: 204, body: null }
  return { status: response.status, body: await response.json() as any }
}

function waitForBrokerCalls(sessionKey: string, count: number) {
  return new Promise<PendingProxyCall[]>((resolve) => {
    const calls: PendingProxyCall[] = []
    const unsubscribe = onPendingProxyCall(sessionKey, (call) => {
      calls.push(call)
      if (calls.length !== count) return
      unsubscribe()
      resolve(calls)
    })
  })
}

async function eventually(description: string, ready: () => boolean) {
  const deadline = performance.now() + 5_000
  while (!ready()) {
    assert.ok(performance.now() < deadline, `Timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function collectRecoveryStream(
  stream: ReadableStream<LanguageModelV3StreamPart>,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const parts: LanguageModelV3StreamPart[] = []
        for await (const part of stream) parts.push(part)
        return parts
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Recovery stream did not finish within 5s"))
        }, 5_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function exerciseTaskRecovery(mode: "late" | "late-queued" | "swallow" | "bookkeeping" | "bookkeeping-respawn") {
  const swallowMode = mode === "swallow" || mode.startsWith("bookkeeping")
  const fake = createFakeTaskCli(mode)
  const modelId = `claude-test-task-${mode}`
  const sk = sessionKey(fake.cwd, `${modelId}::tools::default::context=["claude-code",null]`)
  const previousWatchdog = process.env.CLAUDE_CODE_START_WATCHDOG_MS
  // Leave ample room for the Node fixture to start, even under the full suite.
  process.env.CLAUDE_CODE_START_WATCHDOG_MS = "500"
  const events = () => existsSync(fake.eventsPath)
    ? readFileSync(fake.eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    : []
  const options: LanguageModelV3CallOptions = {
    prompt: [{
      role: "user",
      content: [{ type: "text", text: "Delegate the focused provider check." }],
    }],
    tools: [{
      type: "function",
      name: "task",
      description: "Delegate work to an opencode subagent",
      inputSchema: { type: "object", properties: {} },
    }],
  }
  const addResult = (
    call: Extract<LanguageModelV3StreamPart, { type: "tool-call" }>,
    text: string,
  ) => {
    options.prompt.push({
      role: "assistant",
      content: [{
        type: "tool-call",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: JSON.parse(call.input),
      }],
    }, {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text", value: text },
      }],
    })
  }

  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: ["Task"],
      autoContinueIncompleteTurns: false,
    }).languageModel(modelId)
    const firstResponse = await model.doStream(options)
    const firstParts = await collectRecoveryStream(firstResponse.stream)
    assertNativeTaskBoundary(firstParts, getPendingProxyCalls(sk))
    const taskCall = firstParts.find((part) => part.type === "tool-call")!
    const originalProcess = getActiveProcess(sk)!
    assert.ok(originalProcess)
    assert.equal(originalProcess.lineEmitter.listenerCount("line"), 0)
    const originalCall = getPendingProxyCalls(sk)[0]
    assert.equal(originalCall.channel?.closed, false)
    assert.equal(originalCall.emitted, true)

    if (!swallowMode) {
      assert.equal(originalProcess.proc.kill("SIGUSR2"), true)
      await eventually("disconnected HTTP channel and buffered terminal result", () =>
        originalCall.channel?.closed === true &&
        (originalProcess.unattendedLines ?? []).some((line) => JSON.parse(line).type === "result"),
      )
      assert.equal(getPendingProxyCalls(sk)[0].toolCallId, taskCall.toolCallId)
      assert.equal(events().filter((event) => event.type === "abandoned").length, 1)
      if (mode === "late-queued") {
        await eventually("a task queued with no stream listener", () => getPendingProxyCalls(sk).length === 2)
        const queued = getPendingProxyCalls(sk)[1]
        assert.deepEqual(queued.input, PARALLEL_TASK_INPUT)
        assert.notEqual(queued.emitted, true)
        assert.equal(queued.channel?.closed, false)
      }
    }

    addResult(taskCall, "subagent complete")
    const secondResponse = await model.doStream(options)
    const secondParts = await collectRecoveryStream(secondResponse.stream)
    if (mode === "bookkeeping-respawn") {
      const errors = secondParts.filter((part) => part.type === "error")
      assert.equal(errors.length, 1)
      assert.match(String(errors[0].error), /start watchdog timeout/)
      assert.equal(secondParts.filter((part) => part.type === "finish").length, 0)
      assert.equal(getActiveProcess(sk), undefined)
      assert.equal(getPendingProxyCalls(sk).length, 0)
      const recorded = events()
      assert.equal(recorded.filter((event) => event.type === "spawn").length, 2)
      assert.equal(recorded.filter((event) => event.type === "input").length, 2)
      assert.equal(recorded.filter((event) => event.type === "swallowed-result").length, 1)
      assert.deepEqual(recorded.filter((event) => event.type === "fixture-error"), [])
      return
    }
    const secondText = secondParts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("")
    if (!swallowMode) {
      assert.ok(secondText.startsWith("Unattended narration after the task connection timed out."))
      assert.equal(secondText.split("Unattended narration").length - 1, 1)
    }

    let finalParts = secondParts
    if (mode === "late-queued") {
      assertNativeTaskBoundary(secondParts, getPendingProxyCalls(sk), [PARALLEL_TASK_INPUT])
      const queuedCall = secondParts.find((part) => part.type === "tool-call")!
      assert.notEqual(queuedCall.toolCallId, taskCall.toolCallId)
      assert.equal(getPendingProxyCalls(sk)[0].emitted, true)
      addResult(queuedCall, "queued subagent complete")
      const finalResponse = await model.doStream(options)
      finalParts = await collectRecoveryStream(finalResponse.stream)
      assert.equal(
        [...firstParts, ...secondParts, ...finalParts].filter((part) =>
          part.type === "tool-call" && part.toolCallId === queuedCall.toolCallId,
        ).length,
        1,
      )
      assert.equal(events().filter((event) => event.type === "queued-result").length, 1)
    }

    const finalText = finalParts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("")
    const expectedAnswer = swallowMode
      ? "Fresh answer after watchdog recovery."
      : mode === "late-queued"
        ? "Fresh answer after queued task: queued subagent complete"
        : "Fresh answer after late completion."
    assert.ok(finalText.endsWith(expectedAnswer), `Expected fresh completion, received: ${finalText}`)
    assert.equal(finalParts.filter((part) => part.type === "tool-call").length, 0)
    assert.equal(finalParts.filter((part) => part.type === "error").length, 0)
    const finishes = finalParts.filter((part) => part.type === "finish")
    assert.equal(finishes.length, 1)
    assert.equal(finishes[0].finishReason.unified, "stop")
    const answerIndex = finalParts.findIndex((part) =>
      part.type === "text-delta" && part.delta.includes(expectedAnswer),
    )
    assert.ok(answerIndex >= 0 && answerIndex < finalParts.indexOf(finishes[0]))
    assert.equal(getPendingProxyCalls(sk).length, 0)

    const recorded = events()
    assert.deepEqual(recorded.filter((event) => event.type === "fixture-error"), [])
    const httpResponses = recorded.filter((event) => event.type === "http-response")
    assert.equal(httpResponses.length, mode === "late-queued" ? 2 : 1)
    for (const response of httpResponses) {
      assert.equal(response.status, 200)
      assert.match(response.contentType, /text\/event-stream/)
    }
    const inputs = recorded.filter((event) => event.type === "input")
    assert.equal(inputs.length, 2, "Only the original prompt and one completion envelope reach stdin")
    const completion = inputs[1].envelope
    assert.equal(completion.type, "user")
    assert.equal(completion.message.role, "user")
    assert.ok(completion.message.content.every((block: { type: string }) => block.type === "text"))
    const completionText = completion.message.content.map((block: { text: string }) => block.text).join("")
    assert.ok(completionText.includes(taskCall.toolCallId))
    assert.ok(completionText.includes("task"))
    assert.ok(completionText.includes("subagent complete"))
    assert.match(completionText, /do not re-run/i)
    assert.doesNotMatch(JSON.stringify(completion), /"tool_result"|"tool_use_id"/)
    const spawns = recorded.filter((event) => event.type === "spawn")
    if (swallowMode) {
      const swallowed = recorded.filter((event) => event.type === "swallowed-result")
      assert.equal(swallowed.length, 1)
      assert.equal(swallowed[0].body.result.content[0].text, "subagent complete")
      assert.equal(recorded.filter((event) => event.type === "abandoned").length, 0)
      assert.equal(spawns.length, 2)
      assert.equal(inputs[1].resumed, true)
      assert.notEqual(spawns[1].pid, spawns[0].pid)
      assert.deepEqual(spawns[1].args, [...spawns[0].args, "--resume", "fake-session"])
      assert.equal(spawns[1].proxyUrl, spawns[0].proxyUrl)
      assert.ok(spawns[0].prompt)
      assert.equal(spawns[1].prompt, spawns[0].prompt)
      assert.equal(getActiveProcess(sk)?.proxyServer, originalProcess.proxyServer)
    } else {
      assert.equal(spawns.length, 1, "A disconnected HTTP call does not require a respawn")
      assert.equal(getActiveProcess(sk)?.proc, originalProcess.proc)
    }
  } finally {
    if (previousWatchdog === undefined) delete process.env.CLAUDE_CODE_START_WATCHDOG_MS
    else process.env.CLAUDE_CODE_START_WATCHDOG_MS = previousWatchdog
    rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
    await deleteActiveProcessAndWait(sk)
    deleteClaudeSessionId(sk)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
}

test("late Task result replays unattended narration without finishing before the fresh answer", {
  timeout: 20_000,
}, () => exerciseTaskRecovery("late"))

test("Task queued while unattended is emitted exactly once and resolved on the following turn", {
  timeout: 20_000,
}, () => exerciseTaskRecovery("late-queued"))

test("silently swallowed HTTP Task result recovers through a resumed completion envelope", {
  timeout: 20_000,
}, () => exerciseTaskRecovery("swallow"))

test("tool-result bookkeeping does not disarm the recovery watchdog", {
  timeout: 20_000,
}, () => exerciseTaskRecovery("bookkeeping"))

test("bookkeeping-only output after respawn still reaches the second watchdog deadline", {
  timeout: 20_000,
}, () => exerciseTaskRecovery("bookkeeping-respawn"))

for (const ordering of ["buffered-terminal", "delayed-terminal", "close-after-resolution"] as const) {
  test(`recovery consumes each completion once: ${ordering}`, async () => {
    const cwd = process.cwd()
    const modelId = `claude-test-recovery-${ordering}`
    const sk = sessionKey(cwd, `${modelId}::tools::default::context=["claude-code",null]`)
    const writes: string[] = []
    const proc = Object.assign(new EventEmitter(), {
      stdin: { write: (line: string) => { writes.push(line); return true } },
      kill: () => true,
    }) as unknown as ChildProcess
    const active: ActiveProcess = { proc, lineEmitter: new EventEmitter(), unattendedLines: [] }
    const terminal = { type: "result", session_id: "recovery-session", is_error: false }
    const emit = (message: unknown) => active.lineEmitter.emit("line", JSON.stringify(message))
    const options: LanguageModelV3CallOptions = {
      tools: [{ type: "function", name: "task", inputSchema: { type: "object" } }],
      prompt: [{ role: "user", content: [{ type: "text", text: "Delegate." }] }],
    }
    const appendResult = (id: string, text: string) => {
      options.prompt.push({
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: id, toolName: "task", input: {} }],
      }, {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: id, toolName: "task", output: { type: "text", value: text } }],
      })
    }
    const firstId = `${ordering}-A`
    const secondId = `${ordering}-B`
    const channel = { closed: ordering !== "close-after-resolution" }
    let resolutions = 0
    try {
      setActiveProcess(sk, active)
      setClaudeSessionId(sk, "recovery-session")
      queuePendingProxyCall(sk, {
        id: firstId, toolName: "task", input: {}, channel,
        resolve: () => {
          resolutions++
          if (ordering === "close-after-resolution") queueMicrotask(() => { channel.closed = true })
        },
        reject: () => {},
      })
      markPendingProxyCallEmitted(firstId)
      appendResult(firstId, "completion A")
      const model = createClaudeCode({
        cwd, cliPath: process.execPath, bridgeOpencodeMcp: false,
        proxyOpencodeMcpTools: false, proxyTools: [], autoContinueIncompleteTurns: false,
      }).languageModel(modelId)
      if (ordering !== "close-after-resolution") {
        // This call arrived while opencode executed A, before A's old terminal.
        queuePendingProxyCall(sk, {
          id: secondId, toolName: "task", input: {}, channel: { closed: true },
          resolve: () => { resolutions++ }, reject: () => {},
        })
        const boundary = await model.doStream(options)
        const parts = await collectRecoveryStream(boundary.stream)
        assert.deepEqual(parts.filter((part) => part.type === "tool-call").map((part) => part.toolCallId), [secondId])
        assert.equal(writes.length, 0)
        assert.equal(active.pendingProxyCompletions?.size, 1)
        if (ordering === "buffered-terminal") bufferUnattendedLine(active, JSON.stringify(terminal))
        appendResult(secondId, "completion B")
      }
      const response = await model.doStream(options)
      const collected = collectRecoveryStream(response.stream)
      await eventually("tool results resolved", () => getPendingProxyCalls(sk).length === 0)
      if (ordering !== "buffered-terminal") {
        assert.equal(writes.length, 0)
        emit(terminal)
      }
      await eventually("one recovery envelope", () => writes.length === 1)
      assert.equal(active.lineEmitter.listenerCount("line"), 1, "Old terminal must not finish the recovered stream")
      assert.equal(active.pendingProxyCompletions?.size, 0)
      const completion = JSON.parse(writes[0]).message.content[0].text as string
      assert.equal(completion.split(firstId).length - 1, 1)
      assert.ok(completion.includes("completion A"))
      if (ordering !== "close-after-resolution") {
        assert.equal(completion.split(secondId).length - 1, 1)
        assert.ok(completion.includes("completion B"))
      }
      emit({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Fresh recovered answer." }] } })
      emit(terminal)
      const parts = await collected
      assert.equal(parts.filter((part) => part.type === "finish").length, 1)
      assert.equal(parts.filter((part) => part.type === "error" || part.type === "tool-call").length, 0)
      assert.ok(parts.some((part) => part.type === "text-delta" && part.delta === "Fresh recovered answer."))
      assert.equal(writes.length, 1, "The fresh terminal must not submit stale recovery again")
      assert.equal(resolutions, ordering === "close-after-resolution" ? 1 : 2)
    } finally {
      rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
      deleteActiveProcess(sk)
      deleteClaudeSessionId(sk)
    }
  })
}

test("default provider proxies Task through opencode", () => {
  assert.deepEqual(modelProxyTools(), [
    "Bash",
    "Edit",
    "Write",
    "WebFetch",
    "Task",
  ])
})

test("explicit proxyTools overrides preserve custom selection and empty opt-out", () => {
  assert.deepEqual(modelProxyTools({ proxyTools: ["Task"] }), ["Task"])
  assert.deepEqual(modelProxyTools({ proxyTools: [] }), [])
})

test("opencode provider registration defaults Task without overriding proxyTools", async () => {
  const hooks = await plugin.server({})
  assert.equal("tool" in hooks, false)

  const defaults: any = {}
  await hooks.config?.(defaults)
  assert.deepEqual(defaults.provider["claude-code"].options.proxyTools, [
    "Bash",
    "Edit",
    "Write",
    "WebFetch",
    "Task",
  ])

  const explicit: any = {
    provider: {
      "claude-code": {
        options: { proxyTools: [] },
      },
    },
  }
  await hooks.config?.(explicit)
  assert.deepEqual(explicit.provider["claude-code"].options.proxyTools, [])
})

test("parent and child calls retain distinct opencode session affinity", async () => {
  const hooks = await plugin.server({})
  const parentOutput: any = {}
  const childOutput: any = {}

  await hooks["chat.params"]?.(
    {
      sessionID: "session-parent",
      agent: "build",
      model: { providerID: "claude-code" } as any,
    },
    parentOutput,
  )
  await hooks["chat.params"]?.(
    {
      sessionID: "session-child",
      agent: "general",
      model: { providerID: "claude-code" } as any,
    },
    childOutput,
  )

  assert.equal(parentOutput.options.opencodeSessionID, "session-parent")
  assert.equal(childOutput.options.opencodeSessionID, "session-child")
  assert.notEqual(
    parentOutput.options.opencodeSessionID,
    childOutput.options.opencodeSessionID,
  )
})

test("Task proxy schema matches current opencode TaskTool fields", () => {
  const task = DEFAULT_PROXY_TOOLS.find((tool) => tool.name === "task")
  assert.ok(task)

  const properties = task.inputSchema.properties as Record<
    string,
    Record<string, unknown>
  >
  assert.deepEqual(Object.keys(properties).sort(), [
    "background",
    "command",
    "description",
    "prompt",
    "subagent_type",
    "task_id",
  ])
  assert.equal(properties.background.type, "boolean")
  assert.deepEqual(task.inputSchema.required, [
    "description",
    "prompt",
    "subagent_type",
  ])
})

test("proxy MCP initializes, lists Task, and resolves it through the broker", async () => {
  const task = DEFAULT_PROXY_TOOLS.find((tool) => tool.name === "task")
  assert.ok(task)
  assert.deepEqual(disallowedToolFlags([task]), ["Agent"])

  const brokerSession = `proxy-http-${Date.now()}`
  const server = await createProxyMcpServer([task])
  const forwardCall = (call: any) => queuePendingProxyCall(brokerSession, call)
  server.calls.on("call", forwardCall)
  try {
    const generatedConfig = JSON.parse(readFileSync(server.configPath(), "utf8"))
    // The client-side ceiling written into --mcp-config tracks the largest
    // effective server-side deadline (task's 60-min default here), so
    // Claude's remote-HTTP MCP client never aborts before the broker does.
    assert.equal(
      generatedConfig.mcpServers.opencode_proxy.timeout,
      resolveProxyClientCeilingMs(undefined),
    )
    assert.equal(resolveProxyClientCeilingMs(undefined), 60 * 60 * 1000)

    const initialized = await postRpc(server, {
      jsonrpc: "2.0",
      id: "initialize-1",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "integration-test", version: "1.0.0" },
      },
    })
    assert.equal(initialized.body.id, "initialize-1")
    assert.equal(initialized.body.result.serverInfo.name, "opencode_proxy")

    const notification = await postRpc(server, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    })
    assert.equal(notification.status, 204)

    const listed = await postRpc(server, {
      jsonrpc: "2.0",
      id: "list-1",
      method: "tools/list",
    })
    assert.equal(listed.body.id, "list-1")
    assert.deepEqual(
      listed.body.result.tools.map((tool: any) => tool.name),
      ["task"],
    )

    const brokerCalls = waitForBrokerCalls(brokerSession, 1)
    const callResponse = postRpc(server, {
      jsonrpc: "2.0",
      id: "task-1",
      method: "tools/call",
      params: { name: "task", arguments: TASK_INPUT },
    })
    const [call] = await brokerCalls

    assert.equal(call.toolName, "task")
    assert.deepEqual(call.input, TASK_INPUT)
    assert.equal(getPendingProxyCalls(brokerSession)[0].toolCallId, call.toolCallId)
    assert.equal(
      resolvePendingProxyCallById(call.toolCallId, {
        kind: "text",
        text: "subagent complete",
      }),
      true,
    )

    const completed = await callResponse
    assert.equal(completed.body.id, "task-1")
    assert.equal(completed.body.result.content[0].text, "subagent complete")
    assert.equal(getPendingProxyCalls(brokerSession).length, 0)
  } finally {
    server.calls.off("call", forwardCall)
    rejectAllPendingProxyCallsForSession(brokerSession, new Error("test cleanup"))
    await server.close()
  }
})

test("cleanup rejections classify as notice-level, unknown errors as warn", () => {
  assert.equal(isExpectedCleanupError(SERVER_CLOSED_MESSAGE), true)
  assert.equal(
    isExpectedCleanupError(
      "Proxy tool 'task' timed out after 1800000ms waiting for opencode to resolve the call",
    ),
    true,
  )
  assert.equal(
    isExpectedCleanupError(
      "Pending proxy call 'task' (call-1) was orphaned by a new user turn; rejecting",
    ),
    true,
  )
  assert.equal(
    isExpectedCleanupError(
      "Provider stream was aborted before pending proxy calls were emitted",
    ),
    true,
  )
  assert.equal(isExpectedCleanupError("ECONNRESET"), false)
  assert.equal(isExpectedCleanupError("Unexpected token in JSON"), false)
})

test("closing the server rejects a pending call with the cleanup message", async () => {
  const task = DEFAULT_PROXY_TOOLS.find((tool) => tool.name === "task")
  assert.ok(task)

  const server = await createProxyMcpServer([task])
  const callReceived = new Promise<void>((resolve) => {
    server.calls.once("call", () => resolve())
  })
  const callResponse = postRpc(server, {
    jsonrpc: "2.0",
    id: "close-1",
    method: "tools/call",
    params: { name: "task", arguments: TASK_INPUT },
  })
  await callReceived
  await server.close()

  const rejected = await callResponse
  assert.equal(rejected.body.id, "close-1")
  // tools/call failures are MCP results with isError, never JSON-RPC error
  // envelopes (Claude CLI rejects those as schema-invalid).
  assert.equal(rejected.body.result.isError, true)
  assert.equal(rejected.body.result.content[0].text, SERVER_CLOSED_MESSAGE)
  assert.equal(isExpectedCleanupError(rejected.body.result.content[0].text), true)
})

test("parallel proxy calls preserve success and error correlation", async () => {
  const task = DEFAULT_PROXY_TOOLS.find((tool) => tool.name === "task")
  assert.ok(task)

  const brokerSession = `proxy-batch-${Date.now()}`
  const server = await createProxyMcpServer([task])
  const forwardCall = (call: any) => queuePendingProxyCall(brokerSession, call)
  server.calls.on("call", forwardCall)
  try {
    const inputs = [
      { ...TASK_INPUT, description: "Successful batch call" },
      { ...TASK_INPUT, description: "Tool error batch call" },
      { ...TASK_INPUT, description: "Rejected batch call" },
    ]
    const brokerCalls = waitForBrokerCalls(brokerSession, inputs.length)
    const responses = inputs.map((input, index) =>
      postRpc(server, {
        jsonrpc: "2.0",
        id: `batch-${index}`,
        method: "tools/call",
        params: { name: "task", arguments: input },
      }),
    )
    const calls = await brokerCalls
    assert.equal(getPendingProxyCalls(brokerSession).length, inputs.length)

    const byDescription = new Map(
      calls.map((call) => [call.input.description, call]),
    )
    for (const input of inputs) {
      assert.deepEqual(byDescription.get(input.description)?.input, input)
    }
    const successful = byDescription.get("Successful batch call")!
    const toolError = byDescription.get("Tool error batch call")!
    const rejected = byDescription.get("Rejected batch call")!

    rejectPendingProxyCallById(
      rejected.toolCallId,
      new Error("broker call rejecting as orphaned by test"),
    )
    resolvePendingProxyCallById(successful.toolCallId, {
      kind: "text",
      text: "batch complete",
    })
    resolvePendingProxyCallById(toolError.toolCallId, {
      kind: "error",
      message: "subagent failed",
    })

    const [successResponse, toolErrorResponse, rejectedResponse] =
      await Promise.all(responses)
    assert.equal(successResponse.body.id, "batch-0")
    assert.equal(successResponse.body.result.content[0].text, "batch complete")
    assert.equal(toolErrorResponse.body.id, "batch-1")
    assert.equal(toolErrorResponse.body.result.isError, true)
    assert.equal(
      toolErrorResponse.body.result.content[0].text,
      "subagent failed",
    )
    assert.equal(rejectedResponse.body.id, "batch-2")
    assert.equal(rejectedResponse.body.result.isError, true)
    assert.equal(
      rejectedResponse.body.result.content[0].text,
      "broker call rejecting as orphaned by test",
    )
    assert.equal(getPendingProxyCalls(brokerSession).length, 0)
  } finally {
    server.calls.off("call", forwardCall)
    rejectAllPendingProxyCallsForSession(brokerSession, new Error("test cleanup"))
    await server.close()
  }
})

test("normal text plus Task result closes on native tool boundary", async () => {
  const result = await streamTaskBoundary("normal")
  assertNativeTaskBoundary(result.parts, result.pending)
})

test("result before delayed Task call still closes on native tool boundary", async () => {
  const result = await streamTaskBoundary("race")
  assertNativeTaskBoundary(result.parts, result.pending)
})

test("parallel Task calls drain in one native tool boundary", async () => {
  const result = await streamTaskBoundary("batch")
  assertNativeTaskBoundary(result.parts, result.pending, [
    TASK_INPUT,
    PARALLEL_TASK_INPUT,
  ])
})

// task_batch (from @broskees' 68ed142, adapted): the CLI serialises MCP
// calls, so one batch call is the only way two subagents run at once. The
// plugin fans it out as child `task` calls in one stream finish and gathers
// their results back onto the parent id on the next turn.
test("task_batch fans out into child task calls and gathers their results onto the parent", {
  timeout: 15_000,
}, async () => {
  const fake = createFakeTaskCli("task_batch")
  const modelId = "claude-test-task-batch"
  const sk = sessionKey(fake.cwd, `${modelId}::tools::default::context=["claude-code",null]`)
  const tools = [{
    type: "function",
    name: "task",
    description: "Delegate work to an opencode subagent",
    inputSchema: { type: "object", properties: {} },
  }]
  const firstPrompt = [{
    role: "user",
    content: [{ type: "text", text: "Run both checks at the same time." }],
  }]
  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: ["Task"],
    }).languageModel(modelId)

    const firstResponse = await model.doStream({ prompt: firstPrompt, tools } as any)
    const firstParts: any[] = []
    for await (const part of firstResponse.stream) firstParts.push(part)

    const pending = getPendingProxyCalls(sk)
    assert.equal(pending.length, 1, "one broker entry: the parent batch")
    assert.equal(pending[0].toolName, "task_batch")
    assert.equal(pending[0].emitted, true)
    const parent = pending[0].toolCallId

    const children = firstParts.filter((part) => part.type === "tool-call")
    assert.deepEqual(
      children.map((call) => [call.toolCallId, call.toolName, call.providerExecuted]),
      [[`${parent}_task_0`, "task", false], [`${parent}_task_1`, "task", false]],
      "N ordinary opencode task calls, ids derived from the parent",
    )
    assert.deepEqual(children.map((call) => JSON.parse(call.input)), [TASK_INPUT, PARALLEL_TASK_INPUT])
    assert.deepEqual(
      firstParts.filter((part) => part.type === "tool-input-start").map((part) => [part.id, part.toolName]),
      [[`${parent}_task_0`, "task"], [`${parent}_task_1`, "task"]],
      "opencode learns each child's name from its own input-start",
    )
    const finishes = firstParts.filter((part) => part.type === "finish")
    assert.equal(finishes.length, 1)
    assert.equal(finishes[0].finishReason.unified, "tool-calls", "both children in ONE tool boundary is what makes them concurrent")

    // opencode runs both children as one step and hands back both results.
    const secondResponse = await model.doStream({
      prompt: [
        ...firstPrompt,
        {
          role: "assistant",
          content: children.map((call) => ({
            type: "tool-call",
            toolCallId: call.toolCallId,
            toolName: "task",
            input: JSON.parse(call.input),
          })),
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: `${parent}_task_0`, toolName: "task", output: { type: "text", value: "alpha done" } },
            { type: "tool-result", toolCallId: `${parent}_task_1`, toolName: "task", output: { type: "text", value: "beta done" } },
          ],
        },
      ],
      tools,
    } as any)
    const secondParts: any[] = []
    for await (const part of secondResponse.stream) secondParts.push(part)

    const text = secondParts.filter((part) => part.type === "text-delta").map((part) => part.delta).join("")
    assert.equal(
      text,
      "Batch received: ## task 1 of 2: Inspect provider flow (general)\nalpha done\n\n## task 2 of 2: Inspect parallel flow (general)\nbeta done",
      "the CLI gets one labelled result for its one call",
    )
    assert.equal(secondParts.filter((part) => part.type === "tool-call").length, 0, "nothing re-emitted")
    const secondFinish = secondParts.filter((part) => part.type === "finish")
    assert.equal(secondFinish.length, 1)
    assert.equal(secondFinish[0].finishReason.unified, "stop")
    assert.equal(getPendingProxyCalls(sk).length, 0, "the parent resolved")
  } finally {
    rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
    deleteActiveProcess(sk)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("proxyTools Task brings task_batch along, once", () => {
  const names = (list: string[]) =>
    ((createClaudeCode({ proxyTools: list }).languageModel("claude-haiku-4-5") as any).resolvedProxyTools() as { name: string }[]).map((t) => t.name)
  assert.deepEqual(names(["Task"]), ["task", "task_batch"])
  assert.deepEqual(names(["Task", "task_batch", "TASK"]), ["task", "task_batch"])
  assert.deepEqual(names(["Bash"]), ["bash"], "only task carries the companion")
})

test("duplicate Claude results still produce one native Task completion", async () => {
  const result = await streamTaskBoundary("duplicate")
  assertNativeTaskBoundary(result.parts, result.pending)
})

test("error result does not wait for a missing proxy call", async () => {
  const result = await streamTaskBoundary("error")
  assert.equal(result.pending.length, 0)
  assert.equal(
    result.parts.filter((part) => part.type === "tool-call").length,
    0,
  )
  const finishes = result.parts.filter((part) => part.type === "finish")
  assert.equal(finishes.length, 1)
  assert.equal(finishes[0].finishReason.unified, "stop")
})

test("immediate abort rejects a buffered Task call", async () => {
  const fake = createFakeTaskCli("abort")
  const modelId = "claude-test-task-abort"
  const sk = sessionKey(fake.cwd, `${modelId}::tools::default::context=["claude-code",null]`)
  const abortController = new AbortController()
  const brokerCalls = waitForBrokerCalls(sk, 1)

  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: ["Task"],
    }).languageModel(modelId)
    const response = await model.doStream({
      abortSignal: abortController.signal,
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "Delegate without narration." }],
        },
      ],
      tools: [
        {
          type: "function",
          name: "task",
          description: "Delegate work to an opencode subagent",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    } as any)
    const partsPromise = (async () => {
      const parts: any[] = []
      for await (const part of response.stream) parts.push(part)
      return parts
    })()

    await brokerCalls
    assert.equal(getPendingProxyCalls(sk).length, 1)
    abortController.abort()

    const parts = await partsPromise
    assert.equal(
      parts.filter((part) => part.type === "tool-call").length,
      0,
    )
    assert.equal(getPendingProxyCalls(sk).length, 0)
  } finally {
    rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
    deleteActiveProcess(sk)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("parent tool-result turn defers MCP hot reload and continues the same Claude process", {
  timeout: 10_000,
}, async () => {
  const fake = createFakeTaskCli("followup")
  const modelId = "claude-test-task-followup"
  const sk = sessionKey(fake.cwd, `${modelId}::tools::default::context=["claude-code",null]`)
  const configPath = join(fake.cwd, "opencode.json")

  mkdirSync(join(fake.cwd, ".git"))
  writeFileSync(
    configPath,
    JSON.stringify({
      mcp: {
        changing: {
          type: "local",
          command: ["node", "first-server.cjs"],
        },
      },
    }),
  )

  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: true,
      proxyOpencodeMcpTools: false,
      proxyTools: ["Task"],
    }).languageModel(modelId)
    const tools = [
      {
        type: "function",
        name: "task",
        description: "Delegate work to an opencode subagent",
        inputSchema: { type: "object", properties: {} },
      },
    ]
    const firstPrompt = [
      {
        role: "user",
        content: [{ type: "text", text: "Delegate the focused provider check." }],
      },
    ]
    const firstResponse = await model.doStream({
      prompt: firstPrompt,
      tools,
    } as any)
    const firstParts: any[] = []
    for await (const part of firstResponse.stream) firstParts.push(part)

    const taskCall = firstParts.find(
      (part) => part.type === "tool-call" && part.toolName === "task",
    )
    assert.ok(taskCall)
    assert.equal(taskCall.providerExecuted, false)
    assert.equal(getPendingProxyCalls(sk).length, 1)

    let unmatchedRejected = false
    const unmatchedToolCallId = "parallel-task-still-running"
    queuePendingProxyCall(sk, {
      id: unmatchedToolCallId,
      toolName: "task",
      input: {
        description: "Parallel sibling",
        prompt: "Keep running until a later tool-result turn.",
        subagent_type: "explore",
      },
      resolve() {},
      reject() {
        unmatchedRejected = true
      },
    })
    // This sibling was already dispatched by an earlier opencode turn.
    markPendingProxyCallEmitted(unmatchedToolCallId)
    assert.equal(getPendingProxyCalls(sk).length, 2)

    writeFileSync(
      configPath,
      JSON.stringify({
        mcp: {
          changing: {
            type: "local",
            command: ["node", "second-server.cjs"],
          },
        },
      }),
    )

    const secondResponse = await model.doStream({
      prompt: [
        ...firstPrompt,
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: taskCall.toolCallId,
              toolName: "task",
              input: taskCall.input,
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: taskCall.toolCallId,
              toolName: "task",
              output: { type: "text", value: "subagent complete" },
            },
          ],
        },
      ],
      tools,
    } as any)
    const secondParts: any[] = []
    for await (const part of secondResponse.stream) secondParts.push(part)

    const continuationText = secondParts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("")
    assert.equal(continuationText, "Parent received: subagent complete")
    const finishes = secondParts.filter((part) => part.type === "finish")
    assert.equal(finishes.length, 1)
    assert.equal(finishes[0].finishReason.unified, "stop")
    assert.equal(unmatchedRejected, false)
    assert.deepEqual(
      getPendingProxyCalls(sk).map((call) => call.toolCallId),
      [unmatchedToolCallId],
    )
  } finally {
    rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
    deleteActiveProcess(sk)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})
