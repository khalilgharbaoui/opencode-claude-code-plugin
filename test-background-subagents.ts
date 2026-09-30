/**
 * Tests for background (fire-and-collect) opencode subagents.
 *
 * Three layers, matching where the feature actually lives:
 *
 *  - The capability gate (`liveTaskSupportsBackground`,
 *    `applyBackgroundSubagentSupport`): what the model is shown on a host that
 *    runs background subagents and on one that does not. The negative case is
 *    the important one. On a default opencode 1.18.33 a `background: true`
 *    call is rejected outright with "Background subagents require
 *    OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true", so an advertised field
 *    the host will refuse is a lost dispatch, not a harmless extra.
 *  - The collect/cancel interceptors over a fake opencode SDK client: start,
 *    collect, collect again, cancel, and the parent guard.
 *  - The same two tools over a real proxy MCP server, which is the only thing
 *    that proves they are answered in-process and never queued for opencode
 *    (opencode has no tools of these names to run).
 *
 * Usage:
 *   npx tsx --test test-background-subagents.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import * as http from "node:http"

import {
  applyBackgroundSubagentSupport,
  liveTaskSupportsBackground,
  BACKGROUND_TASK_TOOL_DEFS,
  DEFAULT_PROXY_TOOLS,
  TASK_BACKGROUND_NOTE,
  TASK_BATCH_TOOL_NAME,
  TASK_PROXY_NOTE,
  type ProxyMcpServer,
  type ProxyToolCall,
  type ProxyToolDef,
} from "./src/proxy-mcp.js"
import {
  cancelBackgroundTask,
  clearBackgroundTasks,
  collectBackgroundTask,
  hasCollectedBackgroundTask,
  _resetBackgroundTasks,
  TASK_CANCEL_TOOL_NAME,
  TASK_STATUS_TOOL_NAME,
} from "./src/background-tasks.js"
import { ensureProxyServer } from "./src/spawn-planning.js"
import { setOpencodeClient } from "./src/runtime-status.js"
import {
  deleteActiveProcessesForSession,
  killAllActiveProcesses,
  setClaudeSessionId,
} from "./src/session-manager.js"
import { DEFAULT_PROXY_TOOL_NAMES } from "./src/index.js"

const PARENT = "ses_parent"
const CHILD = "ses_child"

/** A fake opencode client with only the routes the two tools use. */
function fakeClient(options: {
  parentID?: string
  status?: Record<string, { type: string }>
  messages?: unknown[]
  onAbort?: (id: string) => void
  abortThrows?: boolean
}) {
  const calls: string[] = []
  return {
    calls,
    client: {
      session: {
        get: async ({ path }: { path: { id: string } }) => {
          calls.push(`get:${path.id}`)
          return { data: { id: path.id, parentID: options.parentID, directory: "/tmp" } }
        },
        status: async () => {
          calls.push("status")
          return { data: options.status ?? {} }
        },
        messages: async ({ path }: { path: { id: string } }) => {
          calls.push(`messages:${path.id}`)
          return { data: options.messages ?? [] }
        },
        abort: async ({ path }: { path: { id: string } }) => {
          calls.push(`abort:${path.id}`)
          if (options.abortThrows) throw new Error("nope")
          options.onAbort?.(path.id)
          return { data: true }
        },
      },
    },
  }
}

function assistantMessage(text: string, completed = true, error?: unknown) {
  return {
    info: {
      role: "assistant",
      time: { created: 1, ...(completed ? { completed: 2 } : {}) },
      ...(error ? { error } : {}),
    },
    parts: [{ type: "text", text }],
  }
}

function taskDef(tools: ProxyToolDef[], name: string): ProxyToolDef {
  const def = tools.find((t) => t.name === name)
  assert.ok(def, `expected a ${name} def`)
  return def!
}

function taskProperties(def: ProxyToolDef): Record<string, unknown> {
  return (def.inputSchema.properties ?? {}) as Record<string, unknown>
}

function batchItemProperties(def: ProxyToolDef): Record<string, unknown> {
  const tasks = taskProperties(def).tasks as { items?: { properties?: unknown } }
  return (tasks?.items?.properties ?? {}) as Record<string, unknown>
}

// --- the capability gate -------------------------------------------------

test("liveTaskSupportsBackground reads the host's own advertised task schema", () => {
  assert.equal(
    liveTaskSupportsBackground({
      properties: { description: {}, prompt: {}, subagent_type: {}, background: {} },
    }),
    true,
  )
  assert.equal(
    liveTaskSupportsBackground({
      properties: { description: {}, prompt: {}, subagent_type: {}, task_id: {}, command: {} },
    }),
    false,
    "the five properties a default 1.18.33 publishes are the unsupported case",
  )
  assert.equal(liveTaskSupportsBackground(undefined), false, "no registry answer means no")
  assert.equal(liveTaskSupportsBackground({}), false)
  assert.equal(liveTaskSupportsBackground({ properties: "nope" as unknown }), false)
})

// V2 describes tool inputs with Effect schemas, so the V1-shaped client shim
// reports `parameters: {}` for every V2 tool. Reading it would say
// "unsupported" on the one host where background is unconditional.
test("V2 is supported without consulting the registry", () => {
  assert.equal(liveTaskSupportsBackground(undefined, "v2"), true)
  assert.equal(liveTaskSupportsBackground({}, "v2"), true)
  assert.equal(liveTaskSupportsBackground({ properties: {} }, "v2"), true)
})

test("an unsupported host never sees `background` in any task schema", () => {
  const tools = applyBackgroundSubagentSupport(DEFAULT_PROXY_TOOLS, false)
  assert.equal("background" in taskProperties(taskDef(tools, "task")), false)
  assert.equal(
    "background" in batchItemProperties(taskDef(tools, TASK_BATCH_TOOL_NAME)),
    false,
    "task_batch items take the same input as task, so the strip must reach them",
  )
  // The other fields must survive the strip untouched.
  const props = taskProperties(taskDef(tools, "task"))
  assert.deepEqual(
    Object.keys(props).sort(),
    ["command", "description", "prompt", "subagent_type", "task_id"],
  )
  assert.deepEqual(taskDef(tools, "task").inputSchema.required, [
    "description",
    "prompt",
    "subagent_type",
  ])
  assert.equal(
    tools.some((t) => t.name === TASK_STATUS_TOOL_NAME || t.name === TASK_CANCEL_TOOL_NAME),
    false,
    "collect/cancel are meaningless with nothing to collect",
  )
})

test("a supported host gets the field, the note and the collect/cancel pair", () => {
  const tools = applyBackgroundSubagentSupport(DEFAULT_PROXY_TOOLS, true)
  assert.equal("background" in taskProperties(taskDef(tools, "task")), true)
  assert.equal("background" in batchItemProperties(taskDef(tools, TASK_BATCH_TOOL_NAME)), true)
  assert.ok(taskDef(tools, "task").description.includes(TASK_BACKGROUND_NOTE))
  assert.ok(taskDef(tools, TASK_BATCH_TOOL_NAME).description.includes(TASK_BACKGROUND_NOTE))
  for (const def of BACKGROUND_TASK_TOOL_DEFS) {
    assert.ok(tools.some((t) => t.name === def.name), `expected ${def.name}`)
  }
})

// The static note is what an unsupported host's model reads, so a stray
// mention of `background` there would send it straight at the refusal the
// gate exists to prevent.
test("TASK_PROXY_NOTE never mentions background; TASK_BACKGROUND_NOTE carries it", () => {
  assert.equal(/background/i.test(TASK_PROXY_NOTE), false)
  assert.match(TASK_BACKGROUND_NOTE, /background: true/)
  assert.match(TASK_BACKGROUND_NOTE, /state="running"/)
  assert.match(TASK_BACKGROUND_NOTE, /task_status/)
  assert.match(TASK_BACKGROUND_NOTE, /task_cancel/)
})

// They ride with `task` exactly as `task_batch` does. Naming them in
// `proxyTools` must stay impossible, or an operator could turn on a collect
// for a host that runs nothing to collect.
test("the background tools are not nameable in proxyTools", () => {
  for (const def of BACKGROUND_TASK_TOOL_DEFS) {
    assert.equal(
      DEFAULT_PROXY_TOOLS.some((t) => t.name === def.name),
      false,
      `${def.name} must not be resolvable by name`,
    )
    assert.equal(
      DEFAULT_PROXY_TOOL_NAMES.some((n) => n.toLowerCase() === def.name),
      false,
    )
  }
})

test("the gate is a no-op when task is not proxied at all", () => {
  const bashOnly = DEFAULT_PROXY_TOOLS.filter((t) => t.name === "bash")
  assert.deepEqual(applyBackgroundSubagentSupport(bashOnly, true), bashOnly)
  assert.deepEqual(applyBackgroundSubagentSupport(bashOnly, false), bashOnly)
})

// --- collect and cancel --------------------------------------------------

test("collect reports a running task without claiming a result", async () => {
  _resetBackgroundTasks()
  const { client } = fakeClient({
    parentID: PARENT,
    status: { [CHILD]: { type: "running" } },
    messages: [assistantMessage("half done", false)],
  })
  setOpencodeClient(client)
  const result = await collectBackgroundTask(
    { task_id: CHILD },
    { sessionKey: "k", callerSessionId: PARENT },
  )
  assert.equal(result.kind, "text")
  assert.match((result as { text: string }).text, /state="running"/)
  assert.equal(hasCollectedBackgroundTask("k", CHILD), false)
})

test("collect returns the result once, then reports it as already delivered", async () => {
  _resetBackgroundTasks()
  const { client } = fakeClient({
    parentID: PARENT,
    status: {},
    messages: [assistantMessage("BACKGROUND_MARKER_OK")],
  })
  setOpencodeClient(client)
  const options = { sessionKey: "k", callerSessionId: PARENT }

  const first = await collectBackgroundTask({ task_id: CHILD }, options)
  assert.match((first as { text: string }).text, /BACKGROUND_MARKER_OK/)
  assert.match((first as { text: string }).text, /state="completed"/)
  assert.equal(hasCollectedBackgroundTask("k", CHILD), true)

  // opencode's own push notification and this tool are two delivery paths for
  // one answer; the second must not paste the output again.
  const second = await collectBackgroundTask({ task_id: CHILD }, options)
  assert.match((second as { text: string }).text, /Already delivered/)
  assert.equal(/BACKGROUND_MARKER_OK/.test((second as { text: string }).text), false)
})

test("a failed subagent collects as an error, not as an answer", async () => {
  _resetBackgroundTasks()
  const { client } = fakeClient({
    parentID: PARENT,
    status: {},
    messages: [assistantMessage("", true, { name: "ProviderError", data: { message: "boom" } })],
  })
  setOpencodeClient(client)
  const result = await collectBackgroundTask(
    { task_id: CHILD },
    { sessionKey: "k", callerSessionId: PARENT },
  )
  assert.equal((result as { isError?: boolean }).isError, true)
  assert.match((result as { text: string }).text, /state="error"/)
  assert.match((result as { text: string }).text, /boom/)
})

test("cancel aborts the child session and forgets any collected mark", async () => {
  _resetBackgroundTasks()
  const aborted: string[] = []
  const { client } = fakeClient({
    parentID: PARENT,
    status: { [CHILD]: { type: "running" } },
    messages: [assistantMessage("done")],
    onAbort: (id) => aborted.push(id),
  })
  setOpencodeClient(client)
  const options = { sessionKey: "k", callerSessionId: PARENT }

  const result = await cancelBackgroundTask({ task_id: CHILD }, options)
  assert.deepEqual(aborted, [CHILD])
  assert.match((result as { text: string }).text, /state="cancelled"/)
  assert.match((result as { text: string }).text, /Stopped/)
  assert.equal(hasCollectedBackgroundTask("k", CHILD), false)
})

test("a cancel opencode refused never reads as one that happened", async () => {
  _resetBackgroundTasks()
  const { client } = fakeClient({ parentID: PARENT, status: {}, abortThrows: true })
  setOpencodeClient(client)
  const result = await cancelBackgroundTask(
    { task_id: CHILD },
    { sessionKey: "k", callerSessionId: PARENT },
  )
  assert.equal(result.kind, "error")
  assert.match((result as { message: string }).message, /Could not cancel/)
})

// A turn that does not know its own opencode session cannot check the parent,
// so the guard fails closed: otherwise the model could abort any session id.
test("with no caller session id neither tool reads or aborts anything", async () => {
  for (const callerSessionId of [undefined, "default"]) {
    _resetBackgroundTasks()
    const { client, calls } = fakeClient({
      parentID: PARENT,
      status: {},
      messages: [assistantMessage("secret")],
    })
    setOpencodeClient(client)
    const options = { sessionKey: "k", callerSessionId }

    const collected = await collectBackgroundTask({ task_id: CHILD }, options)
    assert.equal(collected.kind, "error", String(callerSessionId))
    assert.match((collected as { message: string }).message, /Cannot check that task_id/)
    const cancelled = await cancelBackgroundTask({ task_id: CHILD }, options)
    assert.equal(cancelled.kind, "error", String(callerSessionId))
    assert.equal(
      calls.some((c) => c.startsWith("messages:") || c.startsWith("abort:")),
      false,
      "refused before reading or aborting anything",
    )
  }
})

// Without this guard any session id the model could name would read back
// another conversation's transcript.
test("neither tool touches a session that is not this conversation's subagent", async () => {
  _resetBackgroundTasks()
  const { client, calls } = fakeClient({
    parentID: "ses_somebody_else",
    status: {},
    messages: [assistantMessage("secret")],
  })
  setOpencodeClient(client)
  const options = { sessionKey: "k", callerSessionId: PARENT }

  const collected = await collectBackgroundTask({ task_id: CHILD }, options)
  assert.equal(collected.kind, "error")
  assert.match((collected as { message: string }).message, /not a subagent of this conversation/)

  const cancelled = await cancelBackgroundTask({ task_id: CHILD }, options)
  assert.equal(cancelled.kind, "error")

  assert.equal(
    calls.some((c) => c.startsWith("messages:") || c.startsWith("abort:")),
    false,
    "the guard must refuse before reading or aborting anything",
  )
})

test("a missing task_id is refused before any lookup", async () => {
  _resetBackgroundTasks()
  const { client, calls } = fakeClient({ parentID: PARENT })
  setOpencodeClient(client)
  for (const tool of [collectBackgroundTask, cancelBackgroundTask]) {
    const result = await tool({}, { sessionKey: "k", callerSessionId: PARENT })
    assert.equal(result.kind, "error")
    assert.match((result as { message: string }).message, /task_id is required/)
  }
  assert.deepEqual(calls, [])
})

// --- the ledger must not outlive its conversation ------------------------

test("a deleted opencode session and a host exit both clear the ledger", async () => {
  _resetBackgroundTasks()
  const { client } = fakeClient({
    parentID: PARENT,
    status: {},
    messages: [assistantMessage("done")],
  })
  setOpencodeClient(client)

  // The key shape deleteActiveProcessesForSession matches on:
  // `<cwd>::<model>::<scope>::<affinity>::context=[...]`.
  const key = `/tmp::claude-haiku-4-5::main::${PARENT}::context=["claude-code",null]`
  setClaudeSessionId(key, "claude-session-1")
  await collectBackgroundTask({ task_id: CHILD }, { sessionKey: key, callerSessionId: PARENT })
  assert.equal(hasCollectedBackgroundTask(key, CHILD), true)

  deleteActiveProcessesForSession(PARENT)
  assert.equal(hasCollectedBackgroundTask(key, CHILD), false)

  // And again for the exit hook, which sweeps by active process key.
  await collectBackgroundTask({ task_id: CHILD }, { sessionKey: key, callerSessionId: PARENT })
  clearBackgroundTasks(key)
  assert.equal(hasCollectedBackgroundTask(key, CHILD), false)
  killAllActiveProcesses()
})

// --- over a real proxy MCP server ---------------------------------------

function post(srv: ProxyMcpServer, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request(
      srv.url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload).toString(),
          Authorization: `Bearer ${srv.authToken}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) })
          } catch {
            resolve({ status: res.statusCode ?? 0, json: text })
          }
        })
      },
    )
    req.on("error", reject)
    req.write(payload)
    req.end()
  })
}

// The whole point of a background collect is that it comes back now. If it
// went to the broker it would sit behind the same queue every other proxied
// call uses, waiting for an opencode tool that does not exist.
test("task_status and task_cancel are answered in-process, never queued", async () => {
  _resetBackgroundTasks()
  const { client } = fakeClient({
    parentID: PARENT,
    status: {},
    messages: [assistantMessage("COLLECTED_OVER_HTTP")],
  })
  setOpencodeClient(client)

  const tools = applyBackgroundSubagentSupport(DEFAULT_PROXY_TOOLS, true)
  const srv = await ensureProxyServer({} as never, tools, "k", false, PARENT)
  const queued: string[] = []
  srv.calls.on("call", (call: ProxyToolCall) => {
    queued.push(call.toolName)
    call.resolve({ kind: "text", text: "should never happen" })
  })
  try {
    const status = await post(srv, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: TASK_STATUS_TOOL_NAME, arguments: { task_id: CHILD } },
    })
    assert.equal(status.json.error, undefined, "MCP results only, never JSON-RPC errors")
    assert.equal(status.json.result.isError, false)
    assert.match(status.json.result.content[0].text, /COLLECTED_OVER_HTTP/)

    const cancel = await post(srv, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: TASK_CANCEL_TOOL_NAME, arguments: { task_id: CHILD } },
    })
    assert.equal(cancel.json.error, undefined)
    assert.match(cancel.json.result.content[0].text, /state="cancelled"/)

    assert.deepEqual(queued, [], "neither tool may reach the broker")

    // And both are advertised, so Claude can find them.
    const list = await post(srv, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })
    const names = list.json.result.tools.map((t: { name: string }) => t.name)
    assert.ok(names.includes(TASK_STATUS_TOOL_NAME))
    assert.ok(names.includes(TASK_CANCEL_TOOL_NAME))
  } finally {
    await srv.close()
  }
})

// An unsupported host registers no interceptor, so a stray call must fall
// through to the unknown-tool path rather than being silently answered.
test("an unsupported host registers neither interceptor", async () => {
  const tools = applyBackgroundSubagentSupport(DEFAULT_PROXY_TOOLS, false)
  const srv = await ensureProxyServer({} as never, tools, "k", false, PARENT)
  try {
    const res = await post(srv, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: TASK_STATUS_TOOL_NAME, arguments: { task_id: CHILD } },
    })
    assert.equal(res.json.error, undefined)
    assert.equal(res.json.result.isError, true)
  } finally {
    await srv.close()
  }
})
