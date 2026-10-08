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
 *   npx tsx --test test/background-subagents.test.ts
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
  TASK_BACKGROUND_NOTE_V2,
  TASK_BATCH_TOOL_NAME,
  TASK_INPUT_PROPERTIES,
  TASK_PROXY_NOTE,
  type ProxyMcpServer,
  type ProxyToolCall,
  type ProxyToolDef,
} from "../src/proxy-mcp.js"
import {
  BACKGROUND_SUBAGENT_HINT,
  BACKGROUND_SUBAGENT_HINT_V2,
  backgroundSubagentHint,
} from "../src/prompts.js"
import {
  backgroundTaskIdsIn,
  cancelBackgroundTask,
  clearBackgroundTasks,
  collectBackgroundTask,
  countRunningBackgroundTasks,
  hasCollectedBackgroundTask,
  noteBackgroundDispatchResult,
  isBackgroundTaskRunning,
  recordBackgroundSubagentGate,
  snapshotBackgroundSubagentGate,
  snapshotBackgroundTasks,
  _resetBackgroundTasks,
  TASK_CANCEL_TOOL_NAME,
  TASK_STATUS_TOOL_NAME,
} from "../src/background-tasks.js"
import { createV1ClientShim } from "../src/v2-client.js"
import { ensureProxyServer } from "../src/spawn-planning.js"
import { setOpencodeClient } from "../src/runtime-status.js"
import {
  deleteActiveProcessesForSession,
  killAllActiveProcesses,
  setClaudeSessionId,
} from "../src/session-manager.js"
import { DEFAULT_PROXY_TOOL_NAMES } from "../src/index.js"

const PARENT = "ses_parent"
const CHILD = "ses_child"

/** A fake opencode client with only the routes the two tools use. */
function fakeClient(options: {
  parentID?: string
  status?: Record<string, { type: string }>
  messages?: unknown[]
  onAbort?: (id: string) => void
  abortThrows?: boolean
  /** What opencode's abort route answered; `false` means nothing was stopped. */
  abortResult?: boolean
  /** Leave `session.status` out entirely, the way the V2 client shim does. */
  noStatusRoute?: boolean
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
          return { data: options.messages ?? [] }
        },
        abort: async ({ path }: { path: { id: string } }) => {
          calls.push(`abort:${path.id}`)
          if (options.abortThrows) throw new Error("nope")
          options.onAbort?.(path.id)
          return { data: options.abortResult ?? true }
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

// --- opencode 2 ----------------------------------------------------------

// V2's `subagent` answers a background dispatch in prose and delivers the
// completion as `<subagent sessionID=...>`, so a note telling the model to
// look for `<task id=...>` would leave it with no id to pass to either tool.
test("the V2 note describes V2's own envelopes", () => {
  const tools = applyBackgroundSubagentSupport(DEFAULT_PROXY_TOOLS, true, "v2")
  assert.ok(taskDef(tools, "task").description.includes(TASK_BACKGROUND_NOTE_V2))
  assert.ok(taskDef(tools, TASK_BATCH_TOOL_NAME).description.includes(TASK_BACKGROUND_NOTE_V2))
  assert.equal(taskDef(tools, "task").description.includes(TASK_BACKGROUND_NOTE), false)
  assert.match(TASK_BACKGROUND_NOTE_V2, /background: true/)
  assert.match(TASK_BACKGROUND_NOTE_V2, /sessionID: ses_/)
  assert.match(TASK_BACKGROUND_NOTE_V2, /<subagent sessionID/)
  assert.match(TASK_BACKGROUND_NOTE_V2, /task_status/)
  assert.match(TASK_BACKGROUND_NOTE_V2, /task_cancel/)
  // V1 is the default and must be untouched by the new argument.
  assert.ok(
    taskDef(applyBackgroundSubagentSupport(DEFAULT_PROXY_TOOLS, true), "task").description.includes(
      TASK_BACKGROUND_NOTE,
    ),
  )
})

// Neither envelope is the same on both majors, so the id's own description
// cannot name only one of them.
test("the task_id description names where the id comes from on both majors", () => {
  for (const def of BACKGROUND_TASK_TOOL_DEFS) {
    const taskId = (def.inputSchema.properties as Record<string, { description: string }>).task_id
    assert.match(taskId.description, /opencode 1\.x/)
    assert.match(taskId.description, /opencode 2/)
  }
})

// The same rule, for the field that turns a dispatch into a background one.
// It is shared by `task` and every `task_batch` item and is built with no
// dialect in hand, so like `task_id` it names both. Measured on 2.0.22
// (h #g230): the live schema said only `<task id="..." state="running">`,
// which that host never sends.
test("the background field description names both majors' envelopes", () => {
  const background = TASK_INPUT_PROPERTIES.background.description
  assert.match(background, /opencode 1\.x/)
  assert.match(background, /opencode 2/)
  assert.match(background, /state="running"/)
  assert.match(background, /sessionID: ses_/)

  // And it must stay that way once the V2 tool set has been built, which is
  // what the model actually reads: the `task` schema and every `task_batch`
  // item carry the same text.
  const tools = applyBackgroundSubagentSupport(DEFAULT_PROXY_TOOLS, true, "v2")
  const task = taskDef(tools, "task").inputSchema.properties as Record<
    string,
    { description: string }
  >
  assert.match(task.background.description, /sessionID: ses_/)
  const batch = taskDef(tools, TASK_BATCH_TOOL_NAME).inputSchema
    .properties as {
    tasks: { items: { properties: Record<string, { description: string }> } }
  }
  assert.match(batch.tasks.items.properties.background.description, /sessionID: ses_/)
})

// The system prompt is the other place the model is told what a background
// dispatch answers with, and it is chosen where the dialect is known, so it
// gets a V2 twin rather than naming both. Before this it handed a V2 model
// V1's envelope and told it the `id` in it was the task_id: there is no such
// id on that host, so neither task_status nor task_cancel was reachable.
test("the background system hint describes this host's own envelopes", () => {
  assert.equal(backgroundSubagentHint("v1"), BACKGROUND_SUBAGENT_HINT)
  assert.equal(backgroundSubagentHint("v2"), BACKGROUND_SUBAGENT_HINT_V2)

  assert.match(BACKGROUND_SUBAGENT_HINT, /<task id="ses_\.\.\." state="running">/)
  assert.equal(BACKGROUND_SUBAGENT_HINT.includes("<subagent sessionID"), false)

  // V2's two envelopes, and nothing of V1's.
  assert.match(
    BACKGROUND_SUBAGENT_HINT_V2,
    /The subagent is working in the background \(sessionID: ses_\.\.\.\)/,
  )
  assert.match(BACKGROUND_SUBAGENT_HINT_V2, /<subagent sessionID="\.\.\." state="completed">/)
  assert.equal(BACKGROUND_SUBAGENT_HINT_V2.includes('<task id='), false)
  assert.equal(BACKGROUND_SUBAGENT_HINT_V2.includes('state="running"'), false)

  // Both still name the two recovery tools and still forbid polling.
  for (const hint of [BACKGROUND_SUBAGENT_HINT, BACKGROUND_SUBAGENT_HINT_V2]) {
    assert.match(hint, /mcp__opencode_proxy__task_status/)
    assert.match(hint, /mcp__opencode_proxy__task_cancel/)
    assert.match(hint, /background: true/)
    assert.match(hint, /progress poll/)
  }
})

// V2's plugin session domain is a `Pick` of the HTTP client that does not
// include `active`, so `fetchSessionRunState` can only answer `unknown` there.
// The transcript is then the only signal, and reading it wrong would report a
// half-written answer as the subagent's result.
test("with no run-state route the transcript decides whether it is running", () => {
  const running = [{ role: "assistant", completed: false, error: undefined, text: "half" }]
  const done = [{ role: "assistant", completed: true, error: undefined, text: "all" }]
  const failed = [{ role: "assistant", completed: false, error: "boom", text: "" }]

  assert.equal(isBackgroundTaskRunning("unknown", running), true)
  assert.equal(isBackgroundTaskRunning("unknown", done), false)
  assert.equal(isBackgroundTaskRunning("unknown", failed), false, "an error is a finished task")
  assert.equal(isBackgroundTaskRunning("unknown", []), false, "nothing to read yet")

  // `busy` and `idle` stay authoritative in both directions: an interrupted
  // turn leaves an assistant message that never completed, and calling that
  // running would park the model on a task nothing will finish.
  assert.equal(isBackgroundTaskRunning("busy", done), true)
  assert.equal(isBackgroundTaskRunning("idle", running), false)
})

test("a V2 host collects, reports running, and cancels through the client shim", async () => {
  _resetBackgroundTasks()
  const interrupted: string[] = []
  let completed = false
  const client = createV1ClientShim({
    session: {
      get: async ({ sessionID }) => ({
        id: sessionID,
        parentID: PARENT,
        location: { directory: "/tmp" },
      }),
      context: async () => [
        { id: "m1", type: "user", time: { created: 1 }, text: "go" },
        {
          id: "m2",
          type: "assistant",
          time: { created: 2, ...(completed ? { completed: 3 } : {}) },
          content: [{ type: "text", text: "V2_BACKGROUND_RESULT" }],
        },
      ],
      interrupt: async ({ sessionID }) => {
        interrupted.push(sessionID)
        return { interrupted: true }
      },
    },
  })
  setOpencodeClient(client)
  const options = { sessionKey: "k", callerSessionId: PARENT }

  const running = await collectBackgroundTask({ task_id: CHILD }, options)
  assert.match((running as { text: string }).text, /state="running"/)
  assert.equal(
    /V2_BACKGROUND_RESULT/.test((running as { text: string }).text),
    false,
    "a half-written answer must never be handed over as the result",
  )

  completed = true
  const collected = await collectBackgroundTask({ task_id: CHILD }, options)
  assert.match((collected as { text: string }).text, /V2_BACKGROUND_RESULT/)
  assert.equal(hasCollectedBackgroundTask("k", CHILD), true)

  const cancelled = await cancelBackgroundTask({ task_id: CHILD }, options)
  assert.deepEqual(interrupted, [CHILD])
  assert.match((cancelled as { text: string }).text, /state="cancelled"/)
  assert.equal(hasCollectedBackgroundTask("k", CHILD), false)
})

// The parent guard is the thing that keeps one conversation out of another's
// transcript, and on V2 it runs off the shimmed `session.get`.
test("the parent guard still fails closed on a V2 client shim", async () => {
  _resetBackgroundTasks()
  const client = createV1ClientShim({
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, parentID: "ses_somebody_else" }),
      context: async () => [
        { id: "m", type: "assistant", time: { created: 1, completed: 2 }, content: [{ type: "text", text: "secret" }] },
      ],
      interrupt: async () => ({ interrupted: true }),
    },
  })
  setOpencodeClient(client)
  const options = { sessionKey: "k", callerSessionId: PARENT }
  const collected = await collectBackgroundTask({ task_id: CHILD }, options)
  assert.equal(collected.kind, "error")
  assert.equal(/secret/.test(JSON.stringify(collected)), false)
  assert.equal((await cancelBackgroundTask({ task_id: CHILD }, options)).kind, "error")
})

// A host whose abort route answers `false` stopped nothing.
test("a cancel opencode answered false never reads as one that happened", async () => {
  _resetBackgroundTasks()
  const { client } = fakeClient({ parentID: PARENT, status: {}, abortResult: false })
  setOpencodeClient(client)
  const result = await cancelBackgroundTask(
    { task_id: CHILD },
    { sessionKey: "k", callerSessionId: PARENT },
  )
  assert.equal(result.kind, "error")
  assert.match((result as { message: string }).message, /Could not cancel/)
})

// A V1 host with no status route at all takes the same fallback as V2.
test("a 1.x client without session.status still tells running from finished", async () => {
  _resetBackgroundTasks()
  const { client } = fakeClient({
    parentID: PARENT,
    noStatusRoute: true,
    messages: [assistantMessage("NOT_DONE_YET", false)],
  })
  setOpencodeClient(client)
  const result = await collectBackgroundTask(
    { task_id: CHILD },
    { sessionKey: "k", callerSessionId: PARENT },
  )
  assert.match((result as { text: string }).text, /state="running"/)
  assert.equal(/NOT_DONE_YET/.test((result as { text: string }).text), false)
})

// --- what the doctor reads ----------------------------------------------

test("the gate is recorded for the doctor, and read-only", () => {
  _resetBackgroundTasks()
  assert.equal(snapshotBackgroundSubagentGate(), undefined, "nothing until a turn plans tools")
  recordBackgroundSubagentGate(
    { supported: true, hostApi: "v2", registryResolved: false },
    1_000,
  )
  assert.deepEqual(snapshotBackgroundSubagentGate(), {
    supported: true,
    hostApi: "v2",
    registryResolved: false,
    at: 1_000,
  })
  const snapshot = snapshotBackgroundSubagentGate()!
  snapshot.supported = false
  assert.equal(snapshotBackgroundSubagentGate()!.supported, true, "a copy, not the record")
})

test("the doctor's ledger snapshot names collected and cancelled tasks", async () => {
  _resetBackgroundTasks()
  const { client } = fakeClient({
    parentID: PARENT,
    status: {},
    messages: [assistantMessage("done")],
  })
  setOpencodeClient(client)
  const options = { sessionKey: "k", callerSessionId: PARENT }

  await collectBackgroundTask({ task_id: "ses_a" }, options)
  await cancelBackgroundTask({ task_id: "ses_b" }, options)
  assert.deepEqual(snapshotBackgroundTasks(), [
    { sessionKey: "k", collected: ["ses_a"], cancelled: ["ses_b"] },
  ])

  // A cancel drops the collected mark, so nothing can later claim delivery,
  // but the doctor still shows the cancel.
  await collectBackgroundTask({ task_id: "ses_b" }, options)
  await cancelBackgroundTask({ task_id: "ses_b" }, options)
  const [ledger] = snapshotBackgroundTasks()
  assert.deepEqual(ledger!.collected, ["ses_a"])
  assert.deepEqual(ledger!.cancelled, ["ses_b"])

  // And a released conversation leaves neither behind.
  clearBackgroundTasks("k")
  assert.deepEqual(snapshotBackgroundTasks(), [])
})

// --- how many are running now --------------------------------------------

test("a background dispatch is read off both majors' envelopes, and nothing else", () => {
  assert.deepEqual(backgroundTaskIdsIn('<task id="ses_v1" state="running">\nqueued\n</task>'), [
    "ses_v1",
  ])
  assert.deepEqual(
    backgroundTaskIdsIn("The subagent is working in the background (sessionID: ses_v2)."),
    ["ses_v2"],
  )
  // A task_batch result is its children's results joined.
  assert.deepEqual(
    backgroundTaskIdsIn(
      '[1] <task id="ses_one" state="running"></task>\n[2] <task id="ses_two" state="running"></task>',
    ),
    ["ses_one", "ses_two"],
  )
  // A foreground answer, a completion push and prose that merely mentions an
  // id are not dispatches.
  assert.deepEqual(backgroundTaskIdsIn('<task id="ses_fg" state="completed">done</task>'), [])
  assert.deepEqual(backgroundTaskIdsIn("see sessionID: ses_x for details"), [])
})

test("only an accepted dispatch is remembered", async () => {
  _resetBackgroundTasks()
  setOpencodeClient(fakeClient({ status: {} }).client)
  const envelope = '<task id="ses_err" state="running"></task>'
  noteBackgroundDispatchResult("k", { kind: "error", message: envelope })
  noteBackgroundDispatchResult("k", { kind: "text", text: envelope, isError: true })
  assert.deepEqual(await countRunningBackgroundTasks(), { running: 0, started: 0, unreadable: 0 })
})

test("the running count asks the same question task_status does and consumes nothing", async () => {
  _resetBackgroundTasks()
  const { client, calls } = fakeClient({
    parentID: PARENT,
    status: { ses_busy: { type: "busy" }, ses_busy2: { type: "busy" } },
    messages: [assistantMessage("RESULT_TEXT")],
  })
  setOpencodeClient(client)
  for (const id of ["ses_busy", "ses_busy2", "ses_done", "ses_cancelled"]) {
    noteBackgroundDispatchResult("k", { kind: "text", text: `<task id="${id}" state="running">` })
  }
  await cancelBackgroundTask({ task_id: "ses_cancelled" }, { sessionKey: "k", callerSessionId: PARENT })
  calls.length = 0

  assert.deepEqual(await countRunningBackgroundTasks(), { running: 2, started: 4, unreadable: 0 })
  // Read-only: no abort, nothing collected, and the cancelled one not asked about.
  assert.equal(calls.some((call) => call.startsWith("abort:")), false)
  assert.equal(calls.some((call) => call.endsWith(":ses_cancelled")), false)
  assert.equal(hasCollectedBackgroundTask("k", "ses_done"), false)
  // The run state answered, so no transcript was fetched for the count.
  assert.equal(calls.some((call) => call.startsWith("messages:")), false)

  // Collect-once still holds after a count: the first collect gets the result.
  const first = await collectBackgroundTask(
    { task_id: "ses_done" },
    { sessionKey: "k", callerSessionId: PARENT },
  )
  assert.match((first as { text: string }).text, /RESULT_TEXT/)
})

test("with no run-state route the transcript decides, and an unreadable one is said so", async () => {
  _resetBackgroundTasks()
  setOpencodeClient(
    fakeClient({ noStatusRoute: true, messages: [assistantMessage("half", false)] }).client,
  )
  noteBackgroundDispatchResult("k", {
    kind: "text",
    text: "The subagent is working in the background (sessionID: ses_v2run)",
  })
  assert.deepEqual(await countRunningBackgroundTasks(), { running: 1, started: 1, unreadable: 0 })

  // Neither route answers: counted, never guessed as running.
  setOpencodeClient({ session: { get: async () => ({ data: {} }) } })
  assert.deepEqual(await countRunningBackgroundTasks(), { running: 0, started: 1, unreadable: 1 })
})

test("the count outlives the conversation that started the subagent", async () => {
  _resetBackgroundTasks()
  setOpencodeClient(fakeClient({ status: { ses_long: { type: "busy" } } }).client)
  noteBackgroundDispatchResult("k", { kind: "text", text: '<task id="ses_long" state="running">' })
  // opencode owns the child, so a released conversation does not stop it.
  clearBackgroundTasks("k")
  assert.deepEqual(await countRunningBackgroundTasks(), { running: 1, started: 1, unreadable: 0 })
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

/**
 * The wiring, end to end: a real `doStream` on a V2 host must put the V2 hint
 * in the file the CLI is actually handed, and a V1 host the V1 one. The two
 * constants above can both be right while the selector is passed the wrong
 * dialect, which is how the V1 text reached a 2.0.22 spawn in the first place.
 */
async function backgroundHintInSpawnedPrompt(hostApi: "v1" | "v2") {
  const fsMod = await import("node:fs")
  const pathMod = await import("node:path")
  const osMod = await import("node:os")
  const cryptoMod = await import("node:crypto")
  const { createClaudeCode } = await import("../src/index.js")
  const { deleteActiveProcessAndWait, sessionKey, deleteClaudeSessionId } =
    await import("../src/session-manager.js")

  const id = cryptoMod.randomUUID().slice(0, 8)
  const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "oc-bg-hint-"))
  const cwd = pathMod.join(root, "project")
  fsMod.mkdirSync(cwd, { recursive: true })
  const cliPath = pathMod.join(root, `bg-hint-claude-${id}.cjs`)
  const argvPath = pathMod.join(root, `bg-hint-argv-${id}.json`)
  fsMod.writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) { process.stdout.write("2.1.293\\n"); process.exit(0) }
if (process.argv.includes("--help")) { process.stdout.write("Usage: claude [options]\\n"); process.exit(0) }
fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)))
readline.createInterface({ input: process.stdin }).on("line", () => {
  const session_id = "fake-bg-hint-session"
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "assistant", session_id, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id, is_error: false, duration_ms: 1, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n")
})
`,
  )
  fsMod.chmodSync(cliPath, 0o755)

  const modelId = `claude-test-bg-hint-${id}`
  const sk = sessionKey(cwd, `${modelId}::tools::default::context=["claude-code",null]`)
  // A real turn finishes successfully here, so give it a throwaway HOME and
  // state dir: run outside `npm test`'s scratch `XDG_STATE_HOME` this would
  // otherwise write the operator's own resume store (h #g116).
  const saved = { HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME }
  process.env.HOME = root
  process.env.XDG_STATE_HOME = pathMod.join(root, "state")
  try {
    const model = createClaudeCode({
      cliPath,
      cwd,
      hostApi,
      proxyTools: ["Task"],
      bridgeOpencodeMcp: false,
      bridgeOpencodeSkills: false,
      proxyOpencodeMcpTools: false,
      autoContinueIncompleteTurns: false,
    }).languageModel(modelId)
    const response = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Say done." }] }],
      tools: [],
    } as never)
    for await (const _part of (response as { stream: AsyncIterable<unknown> }).stream) {
      // drain
    }
    const argv: string[] = JSON.parse(fsMod.readFileSync(argvPath, "utf8"))
    const flag = argv.indexOf("--append-system-prompt-file")
    assert.ok(flag >= 0, "no appended system prompt file")
    return fsMod.readFileSync(argv[flag + 1]!, "utf8")
  } finally {
    await deleteActiveProcessAndWait(sk)
    deleteClaudeSessionId(sk)
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

// POSIX-only for the reason every fake-CLI file in
// `.github/windows-skipped-tests.txt` is: the shim is a shebang script made
// executable with `chmod`, and neither means anything on Windows. The rest of
// this file is portable and runs there, so the gate is on the one test rather
// than on the file.
test("a V2 spawn is handed the V2 background hint, a V1 spawn the V1 one", { skip: process.platform === "win32" }, async () => {
  // `liveTaskSupportsBackground` answers true for V2 without a registry, so
  // this turn reaches the supported branch with no opencode client at all.
  const v2 = await backgroundHintInSpawnedPrompt("v2")
  assert.ok(v2.includes(BACKGROUND_SUBAGENT_HINT_V2), "V2 hint missing from the V2 spawn")
  assert.equal(v2.includes(BACKGROUND_SUBAGENT_HINT), false, "V1 hint reached a V2 spawn")

  // V1 with no registry reports no background support at all, which is the
  // measured default (h #g172), so it carries neither hint. That is the whole
  // point of the gate and is asserted here so the V2 case cannot be read as
  // "the hint is just always V2 now".
  const v1 = await backgroundHintInSpawnedPrompt("v1")
  assert.equal(v1.includes(BACKGROUND_SUBAGENT_HINT_V2), false)
  assert.equal(v1.includes(BACKGROUND_SUBAGENT_HINT), false)
})
