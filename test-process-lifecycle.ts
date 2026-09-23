/**
 * Process lifetime as opencode sees it, and the events that end a proxied
 * call. The plugin listens to the `claude` process, the stream and the
 * protocol instead of inferring failure from elapsed time, so a `task` call
 * has no deadline; these tests pin the events that release a call instead,
 * and for each one they check BOTH registries a call lives in: the proxy
 * server's open HTTP request (`pendingCallIds`) and the broker's entry
 * (`getPendingProxyCalls`). With no deadline, an entry either of those
 * forgets to drop would be permanent.
 *
 *   - the next user message in the chat (a call the previous turn left
 *     pending is orphaned, and the CLI is told so),
 *   - an abort, after content and while opencode is running the tool
 *     (the CLI is interrupted and its parked request is answered),
 *   - the child exiting, mid-turn or between turns,
 *   - the session being deleted in opencode,
 *   - opencode itself exiting (`test-session-manager.ts`, `killAllActiveProcesses`).
 *
 * A normal result completing a call is pinned in `test-proxy-task.ts`, and
 * the late-result recovery for a CLI that hung up on its own request in the
 * same file; nothing here changes either.
 *
 * Usage:
 *   npx tsx --test test-process-lifecycle.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"

import plugin, { createClaudeCode, extractDeletedSessionId } from "./src/index.js"
import {
  _setProxyDeadlineRecheckMs,
  createProxyMcpServer,
  DEFAULT_PROXY_TOOLS,
  SERVER_CLOSED_MESSAGE,
  type ProxyMcpServer,
  type ProxyToolCall,
} from "./src/proxy-mcp.js"
import { getPendingProxyCalls, onPendingProxyCall, queuePendingProxyCall } from "./src/proxy-broker.js"
import { setOpencodeClient } from "./src/runtime-status.js"
import {
  deleteActiveProcess,
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  getActiveProcess,
  getClaudeSessionId,
  isIdleProcessEvictionScheduled,
  isTurnInFlight,
  sessionKey,
  setActiveProcess,
  setClaudeSessionId,
  snapshotActiveProcesses,
  type ActiveProcess,
} from "./src/session-manager.js"

test("extractDeletedSessionId reads the deleted session's own record and nothing else", () => {
  const deleted = { type: "session.deleted", properties: { info: { id: "ses_gone" } } }
  assert.equal(extractDeletedSessionId(deleted), "ses_gone")
  // opencode wraps the bus payload; both shapes are accepted.
  assert.equal(extractDeletedSessionId({ payload: deleted }), "ses_gone")
  assert.equal(extractDeletedSessionId({ type: "session.updated", properties: { info: { id: "ses_x" } } }), undefined)
  assert.equal(extractDeletedSessionId({ type: "session.deleted", properties: { sessionID: "ses_x" } }), undefined)
  assert.equal(extractDeletedSessionId({ type: "session.deleted", properties: { info: { id: "" } } }), undefined)
  assert.equal(extractDeletedSessionId(undefined), undefined)
})

function fakeProcess(onKill: () => void, opencodeSessionID?: string): ActiveProcess {
  const proc = new EventEmitter() as ChildProcess
  Object.assign(proc, {
    exitCode: null,
    signalCode: null,
    kill() {
      onKill()
      Object.defineProperty(proc, "exitCode", { configurable: true, value: 0 })
      proc.emit("exit", 0, null)
      return true
    },
  })
  return { proc, lineEmitter: new EventEmitter(), proxyServer: null, opencodeSessionID }
}

const TASK_INPUT = { description: "Check the flow", prompt: "Verify it.", subagent_type: "general" }

/** A real `tools/call` for `task`, authenticated, that stays open until released. */
function parkTaskRequest(server: ProxyMcpServer): Promise<any> {
  return fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${server.authToken}` },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "parked", method: "tools/call",
      params: { name: "task", arguments: TASK_INPUT },
    }),
  }).then((response) => response.json())
}

test("the event hook releases a deleted session's processes and parked calls, and leaves every other session alone", async () => {
  const hooks = await plugin.server({ directory: process.cwd() })
  assert.ok(hooks.event, "the plugin subscribes to bus events")
  const stamp = Date.now()
  const cwd = `/tmp/lifecycle-${stamp}`
  const keyFor = (session: string) =>
    sessionKey(cwd, `claude-opus-5::tools::${session}::context=["claude-code",null]`)
  const killed: string[] = []
  const gone = keyFor("ses_gone")
  const kept = keyFor("ses_kept")
  const shared = keyFor("default")
  // The deleted chat's CLI is parked in a real `task` request on a real
  // proxy server, wired to the broker the way the language model wires it.
  const server = await createProxyMcpServer(DEFAULT_PROXY_TOOLS.filter((t) => t.name === "task"))
  server.calls.on("call", (call: ProxyToolCall) => queuePendingProxyCall(gone, call))
  const goneProcess = fakeProcess(() => killed.push(gone), "ses_gone")
  goneProcess.proxyServer = server
  setActiveProcess(gone, goneProcess)
  setActiveProcess(kept, fakeProcess(() => killed.push(kept), "ses_kept"))
  setActiveProcess(shared, fakeProcess(() => killed.push(shared)))
  setClaudeSessionId(gone, "claude-gone")
  setClaudeSessionId(kept, "claude-kept")
  const queued = new Promise<void>((resolve) => server.calls.once("call", () => resolve()))
  const request = parkTaskRequest(server)
  await queued
  assert.equal(server.pendingCallIds().length, 1)
  assert.equal(getPendingProxyCalls(gone).length, 1)
  try {
    await hooks.event!({ event: { type: "session.updated", properties: { info: { id: "ses_gone" } } } })
    assert.deepEqual(killed, [], "only a deletion releases anything")
    assert.equal(server.pendingCallIds().length, 1)

    await hooks.event!({ event: { type: "session.deleted", properties: { info: { id: "ses_gone" } } } })
    assert.deepEqual(killed, [gone])
    assert.equal(getActiveProcess(gone), undefined)
    assert.equal(getClaudeSessionId(gone), undefined, "a deleted session never resumes")
    assert.equal(getPendingProxyCalls(gone).length, 0, "broker entry released")
    const answer = await request
    assert.equal(answer.result.isError, true)
    assert.equal(answer.result.content[0].text, SERVER_CLOSED_MESSAGE)
    assert.deepEqual(server.pendingCallIds(), [], "HTTP entry released")
    assert.ok(getActiveProcess(kept))
    assert.equal(getClaudeSessionId(kept), "claude-kept")
    assert.ok(getActiveProcess(shared), "the shared default bucket is never matched")

    // The session id "default" is the fallback affinity, not a session.
    await hooks.event!({ event: { type: "session.deleted", properties: { info: { id: "default" } } } })
    assert.ok(getActiveProcess(shared))
  } finally {
    for (const key of [gone, kept, shared]) {
      deleteActiveProcess(key)
      deleteClaudeSessionId(key)
    }
    await server.close()
  }
})

/** A stand-in headless `claude` that answers one turn and stays alive. */
function fakeAnsweringCli(): { cwd: string; cliPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-lifecycle-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const readline = require("node:readline")
if (process.argv.includes("--version")) { process.stdout.write("2.1.258\\n"); process.exit(0) }
if (process.argv.includes("--help")) { process.stdout.write("Usage: claude [options]\\n"); process.exit(0) }
readline.createInterface({ input: process.stdin }).on("line", () => {
  const session_id = "fake-session"
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id }) + "\\n")
  process.stdout.write(JSON.stringify({
    type: "assistant", session_id,
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
  }) + "\\n")
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", session_id, is_error: false, duration_ms: 1, num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
  }) + "\\n")
})
`,
  )
  chmodSync(cliPath, 0o755)
  return { cwd, cliPath }
}

async function completeOneTurn(settings: { idleProcessTimeoutMs?: number }) {
  const fake = fakeAnsweringCli()
  const modelId = `claude-test-idle-${settings.idleProcessTimeoutMs ?? "default"}`
  const sk = sessionKey(fake.cwd, `${modelId}::tools::default::context=["claude-code",null]`)
  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: [],
      autoContinueIncompleteTurns: false,
      ...settings,
    }).languageModel(modelId)
    const response = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Say done." }] }],
      tools: [{ type: "function", name: "bash", description: "Run", inputSchema: { type: "object", properties: {} } }],
    } as any)
    const parts: any[] = []
    for await (const part of response.stream) parts.push(part)
    assert.equal(parts.find((part) => part.type === "finish")?.finishReason.unified, "stop")
    // Read-only: `getActiveProcess` counts as reuse and would disarm the timer.
    assert.ok(
      snapshotActiveProcesses().some((snapshot) => snapshot.sessionKey === sk),
      "the worker is retained for the next turn",
    )
    return isIdleProcessEvictionScheduled(sk)
  } finally {
    await deleteActiveProcessAndWait(sk)
    deleteClaudeSessionId(sk)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
}

// The timer is armed by a completed turn, which is the caller-facing
// boundary: it is armed only when the option is set, and never for 0 or unset.
test("a completed turn arms idle eviction only when idleProcessTimeoutMs is set", async () => {
  assert.equal(await completeOneTurn({}), false)
  assert.equal(await completeOneTurn({ idleProcessTimeoutMs: 0 }), false)
  assert.equal(await completeOneTurn({ idleProcessTimeoutMs: 900_000 }), true)
})

// --- what ends a proxied call --------------------------------------------------

/**
 * A stand-in `claude` that, on its first turn, narrates, issues one `task`
 * proxy call over HTTP and then parks inside it like the real CLI does. It
 * records what happens to that HTTP call, answers an `interrupt` control
 * request with the CLI's own error result, answers a later user envelope
 * with a fresh reply, and in the `exit-*` modes dies while the call is open.
 */
function parkedTaskCli(mode: "park" | "exit-mid-turn" | "exit-between-turns") {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-lifecycle-task-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const eventsPath = join(cwd, "events.jsonl")
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) { process.stdout.write("2.1.258\\n"); process.exit(0) }
if (process.argv.includes("--help")) { process.stdout.write("Usage: claude [options]\\n"); process.exit(0) }
const args = process.argv.slice(2)
let proxyUrl, proxyHeaders = {}
const configIndex = args.indexOf("--mcp-config")
if (configIndex >= 0) {
  for (let index = configIndex + 1; index < args.length && !args[index].startsWith("--"); index++) {
    try {
      const entry = JSON.parse(fs.readFileSync(args[index], "utf8")).mcpServers?.opencode_proxy
      proxyUrl = entry?.url ?? proxyUrl
      proxyHeaders = entry?.headers ?? proxyHeaders
    } catch {}
  }
}
if (!proxyUrl) { process.stderr.write("missing opencode proxy URL\\n"); process.exit(2) }
const mode = ${JSON.stringify(mode)}
const session_id = "fake-session"
const record = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + "\\n")
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
const result = (extra) => emit({
  type: "result", subtype: "success", session_id, is_error: false, duration_ms: 1, num_turns: 1,
  usage: { input_tokens: 1, output_tokens: 1 }, ...extra,
})
let handled = false
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const envelope = JSON.parse(line)
  if (envelope.type === "control_request" && envelope.request?.subtype === "interrupt") {
    record({ type: "interrupt" })
    result({ subtype: "error_during_execution", is_error: true, result: "interrupted" })
    return
  }
  if (envelope.type !== "user") return
  if (handled) {
    record({ type: "input", envelope })
    emit({ type: "assistant", session_id, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "second answer" }] } })
    result({})
    return
  }
  handled = true
  emit({ type: "system", subtype: "init", session_id })
  emit({
    type: "assistant", session_id,
    message: {
      role: "assistant", stop_reason: "tool_use",
      content: [
        { type: "text", text: "Delegating." },
        { type: "tool_use", id: "claude-proxy-task", name: "mcp__opencode_proxy__task", input: ${JSON.stringify(TASK_INPUT)} },
      ],
    },
  })
  fetch(proxyUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...proxyHeaders },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "task", arguments: ${JSON.stringify(TASK_INPUT)} } }),
  })
    .then((response) => response.json())
    .then((body) => record({ type: "http", body }))
    .catch((error) => record({ type: "http-error", message: error.message }))
  if (mode === "exit-mid-turn") setTimeout(() => process.exit(0), 30)
  if (mode === "exit-between-turns") setTimeout(() => process.exit(0), 300)
})
`,
  )
  chmodSync(cliPath, 0o755)
  const events = () =>
    existsSync(eventsPath)
      ? readFileSync(eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      : []
  return { cwd, cliPath, events }
}

const TASK_TOOL = { type: "function", name: "task", description: "Delegate", inputSchema: { type: "object", properties: {} } }

function firstTurn(text = "Delegate the check."): LanguageModelV3CallOptions {
  return { prompt: [{ role: "user", content: [{ type: "text", text }] }], tools: [TASK_TOOL] } as any
}

/** The chat continues with a fresh user message instead of a tool result. */
function nextUserTurn(): LanguageModelV3CallOptions {
  return {
    prompt: [
      { role: "user", content: [{ type: "text", text: "Delegate the check." }] },
      { role: "assistant", content: [{ type: "text", text: "Delegating." }] },
      { role: "user", content: [{ type: "text", text: "Never mind, answer directly." }] },
    ],
    tools: [TASK_TOOL],
  } as any
}

async function collect(stream: ReadableStream<LanguageModelV3StreamPart>, limitMs = 8_000) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const parts: LanguageModelV3StreamPart[] = []
        for await (const part of stream) parts.push(part)
        return parts
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`stream did not finish within ${limitMs}ms`)), limitMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function eventually(description: string, ready: () => boolean, limitMs = 5_000) {
  const deadline = Date.now() + limitMs
  while (!ready()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function brokerCall(sk: string) {
  return new Promise<void>((resolve) => {
    const off = onPendingProxyCall(sk, () => { off(); resolve() })
  })
}

type Ctx = {
  model: ReturnType<ReturnType<typeof createClaudeCode>["languageModel"]>
  sk: string
  events: () => any[]
  /** The proxy server behind the parked call: captured while the process is
   * still registered, so its HTTP side can be checked after it is gone. */
  server: () => ProxyMcpServer
}

async function withParkedTaskCli(
  mode: Parameters<typeof parkedTaskCli>[0],
  run: (ctx: Ctx) => Promise<void>,
  // The affinity these turns run under. `default` is the no-affinity
  // fallback, so a test that needs opencode's session status must name a
  // real session and send it as the `x-session-affinity` header.
  session = "default",
  settings: Record<string, unknown> = {},
) {
  const fake = parkedTaskCli(mode)
  const modelId = `claude-test-lifecycle-${mode}`
  const sk = sessionKey(fake.cwd, `${modelId}::tools::${session}::context=["claude-code",null]`)
  let captured: ProxyMcpServer | undefined
  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: ["Task"],
      autoContinueIncompleteTurns: false,
      ...settings,
    }).languageModel(modelId)
    await run({
      model,
      sk,
      events: fake.events,
      server: () => {
        captured ??= getActiveProcess(sk)?.proxyServer ?? undefined
        assert.ok(captured, "a proxy server is attached to the spawned process")
        return captured
      },
    })
  } finally {
    await deleteActiveProcessAndWait(sk)
    deleteClaudeSessionId(sk)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
}

const textOf = (parts: LanguageModelV3StreamPart[]) =>
  parts.filter((part) => part.type === "text-delta").map((part: any) => part.delta).join("")

/** Both registries empty, and the CLI's parked request answered with `pattern`. */
async function assertReleased(ctx: Ctx, pattern: RegExp) {
  await eventually("the broker entry to be released", () => getPendingProxyCalls(ctx.sk).length === 0)
  await eventually("the HTTP entry to be released", () => ctx.server().pendingCallIds().length === 0)
  await eventually("the CLI to record its answered HTTP call", () => ctx.events().some((event) => event.type === "http"))
  const http = ctx.events().find((event) => event.type === "http")
  assert.equal(http.body.result.isError, true)
  assert.match(http.body.result.content[0].text, pattern)
}

test("a task call the previous turn left pending is released by the next user message, and the CLI is told", {
  timeout: 15_000,
}, () => withParkedTaskCli("park", async (ctx) => {
  const { model, sk, events } = ctx
  const first = await collect((await model.doStream(firstTurn())).stream)
  assert.equal(first.filter((part) => part.type === "tool-call").length, 1, "the call reached opencode")
  assert.equal((first.find((part) => part.type === "finish") as any)?.finishReason.unified, "tool-calls")
  assert.equal(getPendingProxyCalls(sk).length, 1, "nothing on the clock will ever reap this")
  assert.equal(ctx.server().pendingCallIds().length, 1)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(getPendingProxyCalls(sk).length, 1, "still pending: no deadline fired")
  assert.equal(isTurnInFlight(getActiveProcess(sk)!), true, "the CLI is parked inside the call")

  // The operator moves on instead of letting opencode deliver a result.
  const second = await collect((await model.doStream(nextUserTurn())).stream)
  await assertReleased(ctx, /orphaned by a new user turn/)
  assert.ok(events().some((event) => event.type === "interrupt"), "the parked turn was interrupted first")
  assert.ok(textOf(second).includes("second answer"), textOf(second))
  assert.equal((second.find((part) => part.type === "finish") as any)?.finishReason.unified, "stop")
  assert.equal(isTurnInFlight(getActiveProcess(sk)!), false)
}))

test("an abort after content interrupts the CLI and releases its pending call at once", {
  timeout: 15_000,
}, () => withParkedTaskCli("park", async (ctx) => {
  const { model, sk, events } = ctx
  const abort = new AbortController()
  const queued = brokerCall(sk)
  const response = await model.doStream({ ...firstTurn(), abortSignal: abort.signal })
  const collecting = collect(response.stream)
  await queued
  ctx.server()
  // The narration already streamed, so this is a mid-turn abort: the CLI is
  // sent an interrupt and answers with its own result, on which the turn ends.
  abort.abort()
  const parts = await collecting
  await eventually("the interrupt to reach the CLI", () => events().some((event) => event.type === "interrupt"))
  await eventually("the CLI's interrupt result to settle the turn", () => !isTurnInFlight(getActiveProcess(sk)!))
  assert.equal(parts.filter((part) => part.type === "error").length, 0, "an abort is not a crash")
  // Released by the abort itself, before any further message arrives.
  await assertReleased(ctx, /stream was aborted while proxy tool calls were pending/)
  assert.ok(getActiveProcess(sk), "the process stays alive for the next message")

  const second = await collect((await model.doStream(nextUserTurn())).stream)
  assert.ok(textOf(second).includes("second answer"), textOf(second))
  assert.equal(getPendingProxyCalls(sk).length, 0)
}))

test("an abort while opencode is running the tool, with the stream already closed, releases the parked call", {
  timeout: 15_000,
}, () => withParkedTaskCli("park", async (ctx) => {
  const { model, sk, events } = ctx
  const abort = new AbortController()
  const first = await collect((await model.doStream({ ...firstTurn(), abortSignal: abort.signal })).stream)
  assert.equal((first.find((part) => part.type === "finish") as any)?.finishReason.unified, "tool-calls")
  assert.equal(getPendingProxyCalls(sk).length, 1)
  assert.equal(ctx.server().pendingCallIds().length, 1)
  assert.equal(getActiveProcess(sk)!.lineEmitter.listenerCount("line"), 0, "the tool boundary is detached")

  // opencode is running the subagent; the operator presses Esc.
  abort.abort()
  await eventually("the interrupt to reach the parked CLI", () => events().some((event) => event.type === "interrupt"))
  await assertReleased(ctx, /stream was aborted while opencode was running its proxy tool calls/)
  await eventually("the CLI's interrupt result to settle the turn", () => !isTurnInFlight(getActiveProcess(sk)!))
  assert.ok(getActiveProcess(sk), "the process stays alive for the next message")

  const second = await collect((await model.doStream(nextUserTurn())).stream)
  assert.ok(textOf(second).includes("second answer"), textOf(second))
}))

/** A real opencode session id, so the status lookup is actually consulted. */
const BUSY_SESSION = "ses_busy_boundary"

test("an abort at a tool boundary while opencode is still running the turn keeps the call", {
  timeout: 15_000,
}, () => withParkedTaskCli("park", async (ctx) => {
  const { model, sk, events } = ctx
  // opencode 1.18.32 aborts the provider signal of every step that ends in
  // tool calls, about a second after the finish, while it runs the tool.
  // Measured on 2026-09-23: 348 of 938 proxied calls, and every call in a
  // plugin-only config. Releasing there rejected calls that were working and
  // told the model the user had refused. The session is still busy then, and
  // idle only when the operator really stopped the turn.
  setOpencodeClient({
    session: { status: async () => ({ data: { [BUSY_SESSION]: { type: "running" } } }) },
  })
  try {
    const abort = new AbortController()
    const first = await collect(
      (await model.doStream({
        ...firstTurn(),
        abortSignal: abort.signal,
        headers: { "x-session-affinity": BUSY_SESSION },
      } as any)).stream,
    )
    assert.equal((first.find((part) => part.type === "finish") as any)?.finishReason.unified, "tool-calls")
    assert.equal(getPendingProxyCalls(sk).length, 1)

    abort.abort()
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    assert.equal(getPendingProxyCalls(sk).length, 1, "the call opencode is running must survive")
    assert.equal(ctx.server().pendingCallIds().length, 1, "and its HTTP request with it")
    assert.equal(
      events().some((event) => event.type === "interrupt"),
      false,
      "the CLI must not be interrupted while its tool call is still being served",
    )
  } finally {
    setOpencodeClient(null)
  }
}, BUSY_SESSION))

const PROMPT_SESSION = "ses_permission_prompt"

test("a call past its deadline waits while opencode is still serving it, then ends", {
  timeout: 15_000,
}, () => withParkedTaskCli("park", async (ctx) => {
  const { model, sk } = ctx
  // Measured 2026-09-23: three `bash` calls waited 24, 34 and 10.5 minutes on
  // opencode's permission prompt and each was rejected at its 10-minute
  // deadline; the approval then arrived as a late result that cancelled
  // Claude's next call. opencode reports the session busy while a prompt is
  // open (measured on 1.18.32), so the deadline must not end the call then.
  let state: "running" | "idle" = "running"
  setOpencodeClient({
    session: {
      status: async () => ({ data: state === "idle" ? {} : { [PROMPT_SESSION]: { type: state } } }),
    },
  })
  _setProxyDeadlineRecheckMs(100)
  try {
    const first = await collect(
      (await model.doStream({
        ...firstTurn(),
        headers: { "x-session-affinity": PROMPT_SESSION },
      } as any)).stream,
    )
    assert.equal((first.find((part) => part.type === "finish") as any)?.finishReason.unified, "tool-calls")
    assert.equal(getPendingProxyCalls(sk).length, 1)

    // Four times the 200 ms deadline, with a recheck every 100 ms.
    await new Promise((resolve) => setTimeout(resolve, 800))
    assert.equal(getPendingProxyCalls(sk).length, 1, "a call opencode is still serving must survive its deadline")
    assert.equal(ctx.server().pendingCallIds().length, 1, "on the HTTP side too")

    // The operator is gone and the turn stopped: the deadline applies again.
    state = "idle"
    await assertReleased(ctx, /timed out after 200ms/)
  } finally {
    setOpencodeClient(null)
    _setProxyDeadlineRecheckMs(null)
  }
}, PROMPT_SESSION, { proxyToolTimeoutMs: { task: 200 } }))

test("a CLI that dies mid-call ends the turn as an error and releases the call on both sides", {
  timeout: 15_000,
}, () => withParkedTaskCli("exit-mid-turn", async (ctx) => {
  const { model, sk } = ctx
  const queued = brokerCall(sk)
  const response = await model.doStream(firstTurn())
  const collecting = collect(response.stream)
  await queued
  const server = ctx.server()
  assert.equal(server.pendingCallIds().length, 1)
  const parts = await collecting
  const errors = parts.filter((part) => part.type === "error")
  assert.equal(errors.length, 1, JSON.stringify(parts.map((part) => part.type)))
  assert.match(String((errors[0] as any).error?.message), /exited with code 0/)
  assert.equal((parts.find((part) => part.type === "finish") as any)?.finishReason.unified, "error")
  assert.equal(getPendingProxyCalls(sk).length, 0, "broker entry released")
  await eventually("the HTTP entry to be released", () => server.pendingCallIds().length === 0)
  await eventually("the dead child to be forgotten", () => getActiveProcess(sk) === undefined)
}))

test("a CLI that dies between turns releases the call it left pending on both sides, with no turn attached", {
  timeout: 15_000,
}, () => withParkedTaskCli("exit-between-turns", async (ctx) => {
  const { model, sk } = ctx
  const parts = await collect((await model.doStream(firstTurn())).stream)
  assert.equal((parts.find((part) => part.type === "finish") as any)?.finishReason.unified, "tool-calls")
  assert.equal(getPendingProxyCalls(sk).length, 1)
  const server = ctx.server()
  assert.equal(server.pendingCallIds().length, 1)
  const process = getActiveProcess(sk)!
  assert.equal(process.lineEmitter.listenerCount("line"), 0, "nobody is listening for this process now")
  await eventually("the child to exit", () => process.proc.exitCode !== null)
  await eventually("its broker entry to be released", () => getPendingProxyCalls(sk).length === 0)
  await eventually("its HTTP entry to be released", () => server.pendingCallIds().length === 0)
  assert.equal(getActiveProcess(sk), undefined)
}))
