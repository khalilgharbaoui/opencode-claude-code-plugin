/**
 * The running count the MODEL gets on a background dispatch: one trailing
 * line on opencode's accepted `task` / `task_batch` result saying how many
 * background subagents are running now, so it can see the load it adds to.
 *
 * Two layers:
 *
 *  - `withBackgroundRunningCount` over a fake opencode SDK client: both
 *    majors' envelopes, a batch, every result it must leave alone, the budget,
 *    an unreadable child, the concurrency bound, and collect-once.
 *  - A real `doStream` over a fake CLI that calls the proxied `task` /
 *    `task_batch` over HTTP and echoes what it got back, which is the only
 *    thing that proves the line reaches Claude and reaches it once.
 *
 * Its own file because `setOpencodeClient` is process-wide and cannot be
 * unset, and node's test runner gives each file its own process.
 *
 * Usage:
 *   npx tsx --test test/background-running-count.test.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  backgroundTaskIdsIn,
  collectBackgroundTask,
  countRunningBackgroundTasks,
  formatBackgroundRunningLine,
  hasCollectedBackgroundTask,
  noteBackgroundDispatchResult,
  withBackgroundRunningCount,
  _resetBackgroundTasks,
} from "../src/background-tasks.js"
import {
  formatTaskBatchResults,
  TASK_BACKGROUND_NOTE,
  TASK_BACKGROUND_NOTE_V2,
  type ProxyToolResult,
} from "../src/proxy-mcp.js"
import { BACKGROUND_SUBAGENT_HINT, BACKGROUND_SUBAGENT_HINT_V2 } from "../src/prompts.js"
import { setOpencodeClient } from "../src/runtime-status.js"

const PARENT = "ses_parent"
const LINE = "Background subagents running now:"

function v1Envelope(id: string): string {
  return `<task id="${id}" state="running">\nThe subagent is running in the background.\n</task>`
}

function v2Envelope(id: string): string {
  return `The subagent is working in the background (sessionID: ${id})`
}

function assistantMessage(text: string, completed = true) {
  return {
    info: { role: "assistant", time: { created: 1, ...(completed ? { completed: 2 } : {}) } },
    parts: [{ type: "text", text }],
  }
}

/** A fake opencode client: per-session run state, transcript and call log. */
function fakeClient(options: {
  status?: Record<string, { type: string }>
  noStatusRoute?: boolean
  messages?: Record<string, unknown[]>
  messagesThrow?: boolean
  /** Delay every `session.get`, in ms; `Infinity` never answers. */
  getDelayMs?: number
}) {
  const calls: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  const delay = async () => {
    const ms = options.getDelayMs ?? 0
    if (ms === Infinity) return new Promise<never>(() => {})
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms))
  }
  return {
    calls,
    maxInFlight: () => maxInFlight,
    client: {
      session: {
        get: async ({ path }: { path: { id: string } }) => {
          calls.push(`get:${path.id}`)
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          try {
            await delay()
          } finally {
            inFlight--
          }
          return { data: { id: path.id, parentID: PARENT, directory: "/tmp" } }
        },
        ...(options.noStatusRoute
          ? {}
          : {
              status: async () => {
                calls.push("status")
                return { data: options.status ?? {} }
              },
            }),
        messages: async ({ path }: { path: { id: string } }) => {
          calls.push(`messages:${path.id}`)
          if (options.messagesThrow) throw new Error("gone")
          return { data: options.messages?.[path.id] ?? [] }
        },
        abort: async ({ path }: { path: { id: string } }) => {
          calls.push(`abort:${path.id}`)
          return { data: true }
        },
      },
    },
  }
}

function started(...ids: string[]): void {
  for (const id of ids) noteBackgroundDispatchResult("k", { kind: "text", text: v1Envelope(id) })
}

/** What the plugin does with opencode's result: record, then extend. */
async function dispatch(result: ProxyToolResult, budgetMs?: number) {
  noteBackgroundDispatchResult("k", result)
  return withBackgroundRunningCount(result, budgetMs)
}

// --- the line itself -----------------------------------------------------

test("a V1 background dispatch ends with the running count, and its id still parses", async () => {
  _resetBackgroundTasks()
  const { client, calls } = fakeClient({
    status: { ses_busy: { type: "busy" }, ses_idle: { type: "idle" } },
  })
  setOpencodeClient(client)
  started("ses_busy", "ses_idle")
  calls.length = 0

  const text = v1Envelope("ses_new")
  const out = await dispatch({ kind: "text", text })
  assert.equal(out.kind, "text")
  const outText = (out as { text: string }).text
  assert.equal(outText, `${text}\n\n${LINE} 2 (including this one).`)
  assert.ok(outText.startsWith(text), "opencode's text comes first, unchanged")
  assert.deepEqual(backgroundTaskIdsIn(outText), ["ses_new"])
  // The new id is not looked up: opencode just said it is running.
  assert.equal(calls.some((call) => call.endsWith(":ses_new")), false)
})

test("a V2 background dispatch gets the line, read off the transcript", async () => {
  _resetBackgroundTasks()
  setOpencodeClient(
    fakeClient({
      noStatusRoute: true,
      messages: { ses_v2run: [assistantMessage("half", false)] },
    }).client,
  )
  noteBackgroundDispatchResult("k", { kind: "text", text: v2Envelope("ses_v2run") })

  const text = v2Envelope("ses_v2new")
  const out = (await dispatch({ kind: "text", text })) as { text: string }
  assert.equal(out.text, `${text}\n\n${LINE} 2 (including this one).`)
  assert.deepEqual(backgroundTaskIdsIn(out.text), ["ses_v2new"])
})

test("a task_batch result gets ONE line counting every child it started", async () => {
  _resetBackgroundTasks()
  setOpencodeClient(fakeClient({ status: { ses_other: { type: "busy" } } }).client)
  started("ses_other")

  const batch = formatTaskBatchResults([
    { task: { description: "a", subagent_type: "general" }, result: { kind: "text", text: v1Envelope("ses_a") } },
    { task: { description: "b", subagent_type: "general" }, result: { kind: "text", text: v1Envelope("ses_b") } },
  ])
  const out = (await dispatch(batch)) as { text: string }
  assert.equal(out.text.split(LINE).length - 1, 1, "one line per batch")
  assert.ok(out.text.endsWith(`${LINE} 3 (including the 2 just started).`))
  assert.deepEqual(backgroundTaskIdsIn(out.text), ["ses_a", "ses_b"])
})

test("a child that still reads idle is counted, and one that reads busy is not counted twice", async () => {
  _resetBackgroundTasks()
  setOpencodeClient(fakeClient({ status: { ses_new: { type: "idle" } } }).client)
  let out = (await dispatch({ kind: "text", text: v1Envelope("ses_new") })) as { text: string }
  assert.ok(out.text.endsWith(`${LINE} 1 (including this one).`), out.text)

  _resetBackgroundTasks()
  setOpencodeClient(fakeClient({ status: { ses_new: { type: "busy" } } }).client)
  out = (await dispatch({ kind: "text", text: v1Envelope("ses_new") })) as { text: string }
  assert.ok(out.text.endsWith(`${LINE} 1 (including this one).`), out.text)
})

test("foreground answers, errors and failed results are returned untouched, with no lookup", async () => {
  _resetBackgroundTasks()
  const { client, calls } = fakeClient({ status: { ses_busy: { type: "busy" } } })
  setOpencodeClient(client)
  started("ses_busy")
  calls.length = 0

  const untouched: ProxyToolResult[] = [
    { kind: "text", text: '<task id="ses_fg" state="completed">\n<task_result>done</task_result>\n</task>' },
    { kind: "text", text: "plain foreground subagent answer" },
    { kind: "error", message: v1Envelope("ses_err") },
    { kind: "text", text: v1Envelope("ses_failed"), isError: true },
  ]
  for (const result of untouched) {
    assert.equal(await withBackgroundRunningCount(result), result)
  }
  assert.deepEqual(calls, [], "nothing was asked of opencode")
})

test("a task_batch with a failed child still records and counts the children that started", async () => {
  _resetBackgroundTasks()
  setOpencodeClient(fakeClient({ status: {} }).client)
  const batch = formatTaskBatchResults([
    { task: { description: "a", subagent_type: "general" }, result: { kind: "text", text: v1Envelope("ses_a") } },
    { task: { description: "b", subagent_type: "general" }, result: { kind: "error", message: "boom" } },
    // A failed child's own text is never read, envelope or not.
    { task: { description: "c", subagent_type: "general" }, result: { kind: "text", text: v1Envelope("ses_bad"), isError: true } },
    { task: { description: "d", subagent_type: "general" }, result: null },
    { task: { description: "e", subagent_type: "general" }, result: { kind: "text", text: v2Envelope("ses_e") } },
  ])
  assert.equal((batch as { isError?: boolean }).isError, true, "the batch as a whole is an error")

  const out = (await dispatch(batch)) as { text: string; isError?: boolean }
  assert.equal(out.isError, true, "still reported as an error")
  assert.ok(out.text.endsWith(`${LINE} 2 (including the 2 just started).`), out.text)
  assert.equal(out.text.split(LINE).length - 1, 1, "one line per batch")
  const { started: recorded } = await countRunningBackgroundTasks()
  assert.equal(recorded, 2, "ses_a and ses_e recorded, ses_bad not")
})

// --- bounded and cheap ---------------------------------------------------

test("a lookup that overruns the budget omits the line instead of delaying the dispatch", async () => {
  _resetBackgroundTasks()
  setOpencodeClient(fakeClient({ getDelayMs: Infinity }).client)
  started("ses_hung")

  const text = v1Envelope("ses_new")
  const begin = performance.now()
  const out = await dispatch({ kind: "text", text }, 100)
  const elapsed = performance.now() - begin
  assert.equal((out as { text: string }).text, text)
  assert.ok(elapsed < 1_000, `waited ${Math.round(elapsed)} ms against a 100 ms budget`)
})

test("an unreadable child omits the line rather than reporting a count that is too low", async () => {
  _resetBackgroundTasks()
  setOpencodeClient(fakeClient({ noStatusRoute: true, messagesThrow: true }).client)
  started("ses_gone")

  const text = v2Envelope("ses_new")
  const out = await dispatch({ kind: "text", text })
  assert.equal((out as { text: string }).text, text)
})

test("lookups run with bounded concurrency", async () => {
  _resetBackgroundTasks()
  const fake = fakeClient({ status: {}, getDelayMs: 10 })
  setOpencodeClient(fake.client)
  started(...Array.from({ length: 12 }, (_, index) => `ses_${index}`))

  const out = (await dispatch({ kind: "text", text: v1Envelope("ses_new") }, 5_000)) as { text: string }
  assert.ok(out.text.endsWith(`${LINE} 1 (including this one).`), out.text)
  assert.ok(fake.maxInFlight() <= 4, `max in flight ${fake.maxInFlight()}`)
  assert.ok(fake.maxInFlight() >= 2, "still concurrent")
})

test("the count consumes nothing: collect-once still hands the result over once", async () => {
  _resetBackgroundTasks()
  const { client, calls } = fakeClient({
    status: { ses_done: { type: "idle" } },
    messages: { ses_done: [assistantMessage("RESULT_TEXT")] },
  })
  setOpencodeClient(client)
  started("ses_done")

  await dispatch({ kind: "text", text: v1Envelope("ses_new") })
  assert.equal(hasCollectedBackgroundTask("k", "ses_done"), false)
  assert.equal(calls.some((call) => call.startsWith("abort:")), false)

  const options = { sessionKey: "k", callerSessionId: PARENT }
  const first = (await collectBackgroundTask({ task_id: "ses_done" }, options)) as { text: string }
  assert.match(first.text, /RESULT_TEXT/)
  const second = (await collectBackgroundTask({ task_id: "ses_done" }, options)) as { text: string }
  assert.match(second.text, /Already delivered/)
})

test("the line's wording", () => {
  assert.equal(formatBackgroundRunningLine(0, 1), `\n\n${LINE} 1 (including this one).`)
  assert.equal(formatBackgroundRunningLine(4, 3), `\n\n${LINE} 7 (including the 3 just started).`)
})

test("every background note and hint says the count is information, not a reason to wait", () => {
  for (const text of [
    TASK_BACKGROUND_NOTE,
    TASK_BACKGROUND_NOTE_V2,
    BACKGROUND_SUBAGENT_HINT,
    BACKGROUND_SUBAGENT_HINT_V2,
  ]) {
    assert.match(text, /running now/)
    assert.match(text, /never a reason to poll/)
  }
})

// --- end to end through a real doStream ---------------------------------

const TASK_INPUT = {
  description: "Inspect provider flow",
  prompt: "Inspect the provider flow.",
  subagent_type: "general",
  background: true,
}
const SECOND_TASK_INPUT = { ...TASK_INPUT, description: "Inspect parallel flow" }

/**
 * Turn one: the fake CLI calls the proxied `task` (or `task_batch`) over the
 * real proxy MCP server. Turn two hands it opencode's background envelopes;
 * the CLI answers with exactly the text it got back, so the stream shows what
 * Claude would have read.
 */
async function dispatchThroughDoStream(mode: "task" | "task_batch"): Promise<string> {
  const fsMod = await import("node:fs")
  const pathMod = await import("node:path")
  const osMod = await import("node:os")
  const cryptoMod = await import("node:crypto")
  const { createClaudeCode } = await import("../src/index.js")
  const { deleteActiveProcessAndWait, sessionKey, deleteClaudeSessionId } =
    await import("../src/session-manager.js")
  const { getPendingProxyCalls, rejectAllPendingProxyCallsForSession } =
    await import("../src/proxy-broker.js")

  const id = cryptoMod.randomUUID().slice(0, 8)
  const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "oc-bg-count-"))
  const cwd = pathMod.join(root, "project")
  fsMod.mkdirSync(cwd, { recursive: true })
  const cliPath = pathMod.join(root, `bg-count-claude-${id}.cjs`)
  const call =
    mode === "task"
      ? { name: "task", tool: "mcp__opencode_proxy__task", input: TASK_INPUT }
      : {
          name: "task_batch",
          tool: "mcp__opencode_proxy__task_batch",
          input: { tasks: [TASK_INPUT, SECOND_TASK_INPUT] },
        }
  fsMod.writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) { process.stdout.write("2.1.293\\n"); process.exit(0) }
if (process.argv.includes("--help")) { process.stdout.write("Usage: claude [options]\\n"); process.exit(0) }
const args = process.argv.slice(2)
let proxyUrl
let proxyHeaders = {}
const configIndex = args.indexOf("--mcp-config")
for (let index = configIndex + 1; configIndex >= 0 && index < args.length; index++) {
  if (args[index].startsWith("--")) break
  try {
    const entry = JSON.parse(fs.readFileSync(args[index], "utf8")).mcpServers?.opencode_proxy
    proxyUrl = entry?.url ?? proxyUrl
    proxyHeaders = entry?.headers ?? proxyHeaders
  } catch {}
}
const call = ${JSON.stringify(call)}
const session_id = "fake-bg-count-session"
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
const result = { type: "result", subtype: "success", session_id, is_error: false, duration_ms: 1, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }
let handled = false
readline.createInterface({ input: process.stdin }).on("line", () => {
  if (handled) return
  handled = true
  emit({ type: "system", subtype: "init", session_id })
  emit({ type: "assistant", session_id, message: { role: "assistant", stop_reason: "tool_use", content: [
    { type: "text", text: "Dispatching." },
    { type: "tool_use", id: "claude-bg-count-call", name: call.tool, input: call.input },
  ] } })
  fetch(proxyUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...proxyHeaders },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: call.name, arguments: call.input } }),
  }).then((response) => response.json()).then((body) => {
    emit({ type: "assistant", session_id, message: { role: "assistant", stop_reason: "end_turn", content: [
      { type: "text", text: "RECEIVED<<" + body.result.content[0].text + ">>" },
    ] } })
    emit({ ...result, num_turns: 2 })
  }).catch(() => {})
  setTimeout(() => emit(result), 100)
})
`,
  )
  fsMod.chmodSync(cliPath, 0o755)

  const modelId = `claude-test-bg-count-${mode}-${id}`
  const sk = sessionKey(cwd, `${modelId}::tools::default::context=["claude-code",null]`)
  const saved = { HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME }
  process.env.HOME = root
  process.env.XDG_STATE_HOME = pathMod.join(root, "state")
  const tools = [{
    type: "function",
    name: "task",
    description: "Delegate work to an opencode subagent",
    inputSchema: { type: "object", properties: {} },
  }]
  const firstPrompt = [{ role: "user", content: [{ type: "text", text: "Start it in the background." }] }]
  try {
    const model = createClaudeCode({
      cliPath,
      cwd,
      proxyTools: ["Task"],
      bridgeOpencodeMcp: false,
      bridgeOpencodeSkills: false,
      proxyOpencodeMcpTools: false,
      autoContinueIncompleteTurns: false,
    }).languageModel(modelId)

    const first = await model.doStream({ prompt: firstPrompt, tools } as never)
    const firstParts: any[] = []
    for await (const part of (first as { stream: AsyncIterable<unknown> }).stream) firstParts.push(part)
    const calls = firstParts.filter((part) => part.type === "tool-call")
    assert.equal(calls.length, mode === "task" ? 1 : 2)
    assert.equal(getPendingProxyCalls(sk).length, 1)

    const envelopes = ["ses_e2e_a", "ses_e2e_b"].map(v1Envelope)
    const second = await model.doStream({
      prompt: [
        ...firstPrompt,
        {
          role: "assistant",
          content: calls.map((part) => ({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: "task",
            input: JSON.parse(part.input),
          })),
        },
        {
          role: "tool",
          content: calls.map((part, index) => ({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: "task",
            output: { type: "text", value: envelopes[index] },
          })),
        },
      ],
      tools,
    } as never)
    const secondParts: any[] = []
    for await (const part of (second as { stream: AsyncIterable<unknown> }).stream) secondParts.push(part)
    return secondParts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("")
  } finally {
    rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
    await deleteActiveProcessAndWait(sk)
    deleteClaudeSessionId(sk)
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    fsMod.rmSync(root, { recursive: true, force: true })
  }
}

// POSIX-only for the reason every fake-CLI test is: the shim is a shebang
// script made executable with `chmod`.
test("a background task dispatch reaches Claude with the line, once", { skip: process.platform === "win32", timeout: 20_000 }, async () => {
  _resetBackgroundTasks()
  setOpencodeClient(fakeClient({ status: { ses_prior: { type: "busy" } } }).client)
  started("ses_prior")
  const text = await dispatchThroughDoStream("task")
  assert.match(text, /^RECEIVED<</)
  assert.equal(text.split(LINE).length - 1, 1, text)
  assert.ok(text.endsWith(`${LINE} 2 (including this one).>>`), text)
  assert.deepEqual(backgroundTaskIdsIn(text), ["ses_e2e_a"])
})

test("a background task_batch dispatch reaches Claude with one line for the batch", { skip: process.platform === "win32", timeout: 20_000 }, async () => {
  _resetBackgroundTasks()
  setOpencodeClient(fakeClient({ status: {} }).client)
  const text = await dispatchThroughDoStream("task_batch")
  assert.equal(text.split(LINE).length - 1, 1, text)
  assert.ok(text.endsWith(`${LINE} 2 (including the 2 just started).>>`), text)
  assert.deepEqual(backgroundTaskIdsIn(text), ["ses_e2e_a", "ses_e2e_b"])
})
