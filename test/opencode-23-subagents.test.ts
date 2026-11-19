/**
 * opencode 2.3.0 and later run every subagent in the background (h #g321).
 * Read out of `@opencode/core` 2.3.0 and the 2.3.0 to 2.3.2 binaries, against
 * 2.2.7: the `subagent` tool has no `background` input, every call answers
 * `The subagent is working in the background (sessionID: ses_...)`, its part
 * completes at once with `metadata: {sessionID, status: "running"}`, and the
 * parent gets a `<subagent sessionID state>` message each time the child goes
 * idle, with `state="running"` while the child's own background work goes on.
 *
 * Covers both halves: the sidebar row that shape makes (a background row, not a
 * foreground call that finished 20 ms after it started), and what the model is
 * told (no foreground, no `background` field, the right hints). 1.x and 2.0 to
 * 2.2 are asserted unchanged beside each.
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  FINISHED_KEEP,
  STARTING_GRACE_MS,
  completionsIn,
  deriveSubagentRows,
  type ChildRunState,
  type ChildSessionInput,
  type SidebarInput,
  type TaskPartInput,
} from "../src/subagent-sidebar.js"
import {
  ALWAYS_BACKGROUND_SUBAGENTS_SINCE,
  ALWAYS_BACKGROUND_TASK_TOOL_DEFS,
  BACKGROUND_TASK_TOOL_DEFS,
  DEFAULT_PROXY_TOOLS,
  TASK_BACKGROUND_NOTE_ALWAYS,
  TASK_BACKGROUND_NOTE_V2,
  TASK_BATCH_DESCRIPTION_ALWAYS_BACKGROUND,
  TASK_BATCH_TOOL_NAME,
  TASK_PROXY_NOTE,
  TASK_PROXY_NOTE_ALWAYS_BACKGROUND,
  applyBackgroundSubagentSupport,
  backgroundSubagentMode,
  dispatchesAlwaysInBackground,
  hostRunsEverySubagentInBackground,
  overlayTaskProxyDescription,
  type ProxyToolCall,
  type ProxyToolDef,
} from "../src/proxy-mcp.js"
import {
  BACKGROUND_SUBAGENT_HINT_ALWAYS,
  BACKGROUND_SUBAGENT_HINT_V2,
  SUBAGENT_DISPATCH_HINT,
  SUBAGENT_DISPATCH_HINT_ALWAYS_BACKGROUND,
  backgroundSubagentHint,
  subagentDispatchHint,
} from "../src/prompts.js"
import {
  _resetBackgroundTasks,
  backgroundTaskIdsIn,
  collectBackgroundTask,
  formatBackgroundCapRefusal,
  noteBackgroundDispatchResult,
  requestedBackgroundChildren,
  snapshotBackgroundTasks,
  withBackgroundRunningCount,
} from "../src/background-tasks.js"
import { setOpencodeClient } from "../src/runtime-status.js"
import { ensureProxyServer } from "../src/spawn-planning.js"
import { resolveSdkSettings } from "../src/v2.js"

const NOW = 1_800_000_000_000
const CHILD = "ses_child23"
const PARENT = "ses_parent23"

/** What `@opencode/core` 2.3.0's `backgroundResult` writes, verbatim. */
const DISPATCH_ANSWER_2_3 = [
  `The subagent is working in the background (sessionID: ${CHILD}). You will receive a <subagent> message when it goes idle, and again after each later round of work.`,
  "DO NOT sleep, poll, proactively check on its progress, or duplicate this subagent's work.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
  "To send it follow-ups or change its instructions while it runs, call subagent again with this sessionID.",
].join("\n")

function sidebar(overrides: Partial<SidebarInput> & { statuses?: Record<string, ChildRunState> } = {}): SidebarInput {
  const { statuses = {}, ...rest } = overrides
  return {
    children: [],
    parts: [],
    completions: [],
    status: (id) => statuses[id] ?? "unknown",
    record: () => undefined,
    stoppedAt: () => undefined,
    now: NOW,
    ...rest,
  }
}

const child = (id: string, description: string, created: number): ChildSessionInput => ({
  id,
  title: `${description} (@general subagent)`,
  created,
})

/** A 2.3 `subagent` part as the TUI store holds it: completed ~20 ms after it was created. */
const part23 = (id: string, description: string, start: number, sessionInput?: string): TaskPartInput => ({
  status: "completed",
  input: { agent: "general", description, prompt: "x", ...(sessionInput ? { sessionID: sessionInput } : {}) },
  metadata: { sessionID: id, status: "running", truncated: false },
  start,
  end: start + 20,
})

// --- the sidebar -----------------------------------------------------------

test("a 2.3 dispatch is a background row that spins while its child works", () => {
  const start = NOW - 60_000
  const rows = deriveSubagentRows(
    sidebar({ children: [child(CHILD, "Sleep one", start)], parts: [part23(CHILD, "Sleep one", start)], statuses: { [CHILD]: "busy" } }),
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].state, "running")
  assert.equal(rows[0].background, true)
  assert.equal(rows[0].finished, undefined)
})

test("a 2.3 child that reads idle is still starting inside the grace, and its report ends it", () => {
  const start = NOW - STARTING_GRACE_MS / 2
  const base = { children: [child(CHILD, "Sleep one", start)], parts: [part23(CHILD, "Sleep one", start)] }
  // opencode 2.3's TUI store answers `idle` for any session not in `active`.
  assert.equal(deriveSubagentRows(sidebar({ ...base, statuses: { [CHILD]: "idle" } }))[0].state, "running")

  const reported = NOW - 1_000
  const ended = deriveSubagentRows(
    sidebar({
      ...base,
      statuses: { [CHILD]: "idle" },
      completions: completionsIn(`<subagent sessionID="${CHILD}" state="completed" description="Sleep one">\nok\n</subagent>`, reported),
    }),
  )[0]
  assert.equal(ended.state, "done")
  assert.equal(ended.finished, reported, "finished when it reported, not when the call returned")
})

test("a 2.3 child that reported an error ends as one", () => {
  const start = NOW - 60_000
  const row = deriveSubagentRows(
    sidebar({
      children: [child(CHILD, "Sleep one", start)],
      parts: [part23(CHILD, "Sleep one", start)],
      statuses: { [CHILD]: "idle" },
      completions: completionsIn(`<subagent sessionID="${CHILD}" state="error" description="x">boom</subagent>`, NOW - 5),
    }),
  )[0]
  assert.equal(row.state, "error")
})

test("`state=\"running\"` keeps the spinner until the report that follows it", () => {
  const start = NOW - 120_000
  const base = { children: [child(CHILD, "Sleep two", start)], parts: [part23(CHILD, "Sleep two", start)] }
  const running = completionsIn(`<subagent sessionID="${CHILD}" state="running" description="Sleep two">\nstill going\n</subagent>`, NOW - 60_000)
  assert.deepEqual(running.map((entry) => entry.state), ["running"])
  // Idle, past the grace, with its own background work still going: running.
  const working = deriveSubagentRows(sidebar({ ...base, statuses: { [CHILD]: "idle" }, completions: running }))[0]
  assert.equal(working.state, "running")
  // The report after it ends the row at its own time.
  const done = completionsIn(`<subagent sessionID="${CHILD}" state="completed" description="Sleep two">two</subagent>`, NOW - 2_000)
  const ended = deriveSubagentRows(sidebar({ ...base, statuses: { [CHILD]: "idle" }, completions: [...running, ...done] }))[0]
  assert.equal(ended.state, "done")
  assert.equal(ended.finished, NOW - 2_000)
})

test("1.x's own `running` envelope is still the dispatch's answer, never a report", () => {
  assert.deepEqual(completionsIn(`<task id="${CHILD}" state="running">`, 1), [])
  assert.deepEqual(completionsIn(`<task id="${CHILD}" state="completed">`, 1).map((entry) => entry.state), ["completed"])
})

test("a 2.3 child that runs again after it reported shows running again", () => {
  const start = NOW - 600_000
  const reported = completionsIn(`<subagent sessionID="${CHILD}" state="completed" description="x">ok</subagent>`, NOW - 300_000)
  const base = { children: [child(CHILD, "Sleep one", start)], completions: reported }
  // Its own background work finished and it was prompted again: no new part, but busy.
  const rerun = deriveSubagentRows(sidebar({ ...base, parts: [part23(CHILD, "Sleep one", start)], statuses: { [CHILD]: "busy" } }))[0]
  assert.equal(rerun.state, "running")
  // A follow-up by its sessionID: a new part after the report, still inside the grace.
  const followUp = part23(CHILD, "Sleep one", NOW - 2_000, CHILD)
  const resumed = deriveSubagentRows(
    sidebar({ ...base, parts: [part23(CHILD, "Sleep one", start), followUp], statuses: { [CHILD]: "idle" } }),
  )[0]
  assert.equal(resumed.state, "running")
})

test("running 2.3 rows are never pushed out by newer finished rows", () => {
  const start = NOW - 400_000
  const children = [child("ses_a", "Sleep one", start), child("ses_b", "Sleep two", start)]
  const parts = [part23("ses_a", "Sleep one", start), part23("ses_b", "Sleep two", start)]
  const statuses: Record<string, ChildRunState> = { ses_a: "busy", ses_b: "busy" }
  for (let index = 0; index < FINISHED_KEEP + 1; index++) {
    const id = `ses_done${index}`
    const at = NOW - 10_000 + index
    children.push(child(id, `Done ${index}`, at - 1_000))
    parts.push({ status: "completed", input: { agent: "general", description: `Done ${index}` }, metadata: { sessionID: id, status: "completed" }, start: at - 1_000, end: at })
    statuses[id] = "idle"
  }
  const rows = deriveSubagentRows(sidebar({ children, parts, statuses }))
  assert.deepEqual(
    rows.filter((row) => row.state === "running").map((row) => row.description),
    ["Sleep one", "Sleep two"],
  )
  assert.equal(rows.filter((row) => row.state !== "running").length, FINISHED_KEEP)
})

test("2.2's foreground part is unchanged, and so is 2.2's running one", () => {
  const start = NOW - 60_000
  // 2.2.7 writes `status: "completed"` for a foreground call that finished.
  const foreground: TaskPartInput = {
    status: "completed",
    input: { agent: "general", description: "Look" },
    metadata: { sessionID: CHILD, status: "completed" },
    start,
    end: start + 30_000,
  }
  const done = deriveSubagentRows(sidebar({ children: [child(CHILD, "Look", start)], parts: [foreground], statuses: { [CHILD]: "idle" } }))[0]
  assert.equal(done.state, "done")
  assert.equal(done.background, false)
  assert.equal(done.finished, start + 30_000)
  // While the parent waits, `context.progress` already writes `status: "running"`:
  // a running part is a foreground call, not a background one.
  const waiting: TaskPartInput = { ...foreground, status: "running", metadata: { sessionID: CHILD, status: "running" }, end: undefined }
  const row = deriveSubagentRows(sidebar({ children: [child(CHILD, "Look", start)], parts: [waiting], statuses: { [CHILD]: "idle" } }))[0]
  assert.equal(row.background, false)
  assert.equal(row.state, "running")
})

test("a completed part whose child still reads busy stays a running row, then ends at the part", () => {
  const start = NOW - 60_000
  const shape: TaskPartInput = { status: "completed", input: { subagent_type: "general", description: "Look" }, metadata: { sessionId: CHILD }, start, end: start + 10 }
  const busy = deriveSubagentRows(sidebar({ children: [child(CHILD, "Look", start)], parts: [shape], statuses: { [CHILD]: "busy" } }))[0]
  assert.equal(busy.state, "running")
  const idle = deriveSubagentRows(sidebar({ children: [child(CHILD, "Look", start)], parts: [shape], statuses: { [CHILD]: "idle" } }))[0]
  assert.equal(idle.state, "done")
  assert.equal(idle.finished, start + 10)
})

// --- the version gate --------------------------------------------------------

test("2.3.0 is the first release that runs every subagent in the background", () => {
  assert.equal(ALWAYS_BACKGROUND_SUBAGENTS_SINCE, "2.3.0")
  for (const version of ["2.3.0", "2.3.2", "v2.3.1", "2.10.0", "3.0.0", "2.3.0-beta.1"]) {
    assert.equal(hostRunsEverySubagentInBackground(version), true, version)
  }
  for (const version of ["2.2.7", "2.0.22", "1.19.4", "", undefined, "local", "0.0.0-dev-1303"]) {
    assert.equal(hostRunsEverySubagentInBackground(version), false, String(version))
  }
})

test("the mode reads 1.x off its schema and opencode 2 off its version", () => {
  assert.equal(backgroundSubagentMode(undefined, "v1"), "unsupported")
  assert.equal(backgroundSubagentMode({ properties: { background: {} } }, "v1"), "optional")
  // A 1.x host never reaches the version rule, whatever it is handed.
  assert.equal(backgroundSubagentMode(undefined, "v1", "2.3.2"), "unsupported")
  assert.equal(backgroundSubagentMode(undefined, "v2"), "optional")
  assert.equal(backgroundSubagentMode(undefined, "v2", "2.2.7"), "optional")
  assert.equal(backgroundSubagentMode(undefined, "v2", "2.3.2"), "always")
})

// --- what the model is told ------------------------------------------------

function def(tools: ProxyToolDef[], name: string): ProxyToolDef {
  const found = tools.find((tool) => tool.name === name)
  assert.ok(found, `expected ${name}`)
  return found!
}

function fieldNames(tool: ProxyToolDef): string[] {
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, { items?: { properties?: Record<string, unknown> } }>
  if (tool.name === TASK_BATCH_TOOL_NAME) return Object.keys(properties.tasks?.items?.properties ?? {})
  return Object.keys(properties)
}

test("on 2.3 neither task nor any batch item offers `background`, and nothing says a call blocks", () => {
  const tools = applyBackgroundSubagentSupport(DEFAULT_PROXY_TOOLS, "always", "v2")
  for (const name of ["task", TASK_BATCH_TOOL_NAME]) {
    const tool = def(tools, name)
    assert.equal(fieldNames(tool).includes("background"), false, name)
    assert.ok(fieldNames(tool).includes("task_id"), `${name} keeps task_id for follow-ups`)
    assert.ok(tool.description.endsWith(TASK_BACKGROUND_NOTE_ALWAYS), name)
    assert.equal(/block/i.test(tool.description), false, `${name}: ${tool.description}`)
    assert.equal(/set `background: true`/.test(tool.description), false, name)
  }
  const task = def(tools, "task")
  assert.ok(task.description.includes(TASK_PROXY_NOTE_ALWAYS_BACKGROUND))
  assert.equal(task.description.includes(TASK_PROXY_NOTE), false)
  const batch = def(tools, TASK_BATCH_TOOL_NAME)
  assert.ok(batch.description.startsWith(TASK_BATCH_DESCRIPTION_ALWAYS_BACKGROUND))
  assert.equal(batch.description.includes("get all their results back together"), false)
  // The collect/cancel pair is registered, and asks for no `background: true`.
  assert.deepEqual(tools.slice(-2).map((tool) => tool.name), ["task_status", "task_cancel"])
  for (const tool of tools.slice(-2)) {
    assert.equal(tool.description.includes("background: true"), false, tool.name)
    assert.equal(tool.description.includes("foreground"), false, tool.name)
  }
  assert.deepEqual(tools.slice(-2), ALWAYS_BACKGROUND_TASK_TOOL_DEFS)
})

test("the agent-type list the overlay puts first survives the 2.3 rewrite", () => {
  const live = "Available agent types and the tools they have access to:\n- general: General-purpose agent.\n- explore: Fast agent."
  const overlaid = overlayTaskProxyDescription(DEFAULT_PROXY_TOOLS, live)
  const tools = applyBackgroundSubagentSupport(overlaid, "always", "v2")
  for (const name of ["task", TASK_BATCH_TOOL_NAME]) {
    const description = def(tools, name).description
    assert.ok(description.startsWith("Valid subagent_type values"), name)
    assert.ok(description.includes("- explore: Fast agent."), name)
  }
  assert.ok(def(tools, "task").description.includes(TASK_PROXY_NOTE_ALWAYS_BACKGROUND))
  assert.ok(def(tools, TASK_BATCH_TOOL_NAME).description.includes(TASK_BATCH_DESCRIPTION_ALWAYS_BACKGROUND))
})

test("2.0 to 2.2 and 1.x get exactly what they got before", () => {
  // The boolean form and its mode are the same thing.
  assert.deepEqual(
    applyBackgroundSubagentSupport(DEFAULT_PROXY_TOOLS, true, "v2"),
    applyBackgroundSubagentSupport(DEFAULT_PROXY_TOOLS, "optional", "v2"),
  )
  assert.deepEqual(
    applyBackgroundSubagentSupport(DEFAULT_PROXY_TOOLS, false, "v1"),
    applyBackgroundSubagentSupport(DEFAULT_PROXY_TOOLS, "unsupported", "v1"),
  )
  const optional = applyBackgroundSubagentSupport(DEFAULT_PROXY_TOOLS, true, "v2")
  const task = def(optional, "task")
  assert.ok(fieldNames(task).includes("background"))
  assert.ok(task.description.includes(TASK_PROXY_NOTE))
  assert.ok(task.description.endsWith(TASK_BACKGROUND_NOTE_V2))
  assert.deepEqual(optional.slice(-2), BACKGROUND_TASK_TOOL_DEFS)
  assert.equal(dispatchesAlwaysInBackground(optional), false)
  assert.equal(dispatchesAlwaysInBackground(applyBackgroundSubagentSupport(DEFAULT_PROXY_TOOLS, false, "v1")), false)
  assert.equal(dispatchesAlwaysInBackground(applyBackgroundSubagentSupport(DEFAULT_PROXY_TOOLS, "always", "v2")), true)
  assert.equal(dispatchesAlwaysInBackground([]), false)
})

test("the 2.3 hints name no foreground and no `background` field to set", () => {
  assert.equal(backgroundSubagentHint("v2", true), BACKGROUND_SUBAGENT_HINT_ALWAYS)
  assert.equal(backgroundSubagentHint("v2"), BACKGROUND_SUBAGENT_HINT_V2)
  assert.equal(BACKGROUND_SUBAGENT_HINT_ALWAYS.includes("Foreground is still the default"), false)
  assert.equal(BACKGROUND_SUBAGENT_HINT_ALWAYS.includes("background: true"), false)
  assert.ok(BACKGROUND_SUBAGENT_HINT_ALWAYS.includes("The subagent is working in the background (sessionID: ses_...)"))
  assert.ok(BACKGROUND_SUBAGENT_HINT_ALWAYS.includes('state="running"'))

  assert.equal(subagentDispatchHint(), SUBAGENT_DISPATCH_HINT)
  assert.equal(subagentDispatchHint(true), SUBAGENT_DISPATCH_HINT_ALWAYS_BACKGROUND)
  assert.notEqual(SUBAGENT_DISPATCH_HINT_ALWAYS_BACKGROUND, SUBAGENT_DISPATCH_HINT)
  assert.equal(SUBAGENT_DISPATCH_HINT_ALWAYS_BACKGROUND.includes("returns every result together"), false)
  assert.equal(SUBAGENT_DISPATCH_HINT_ALWAYS_BACKGROUND.includes("returned its result"), false)
  assert.ok(SUBAGENT_DISPATCH_HINT_ALWAYS_BACKGROUND.includes("returned its sessionID"))
})

// --- the result side -------------------------------------------------------

test("2.3's dispatch answer is read as a background dispatch, and the count goes after it", async () => {
  _resetBackgroundTasks()
  assert.deepEqual(backgroundTaskIdsIn(DISPATCH_ANSWER_2_3), [CHILD])
  setOpencodeClient({
    session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, parentID: PARENT, directory: "/tmp" } }),
      status: async () => ({ data: { [CHILD]: { type: "busy" } } }),
      messages: async () => ({ data: [] }),
      abort: async () => ({ data: true }),
    },
  })
  const result = { kind: "text" as const, text: DISPATCH_ANSWER_2_3 }
  noteBackgroundDispatchResult("k23", result)
  const counted = await withBackgroundRunningCount(result)
  assert.ok(counted.kind === "text" && counted.text.startsWith(DISPATCH_ANSWER_2_3))
  assert.match((counted as { text: string }).text, /Background subagents running now: 1 \(including this one\)\.$/)
})

test("on 2.3 the cap counts every dispatch and never offers a foreground", () => {
  assert.equal(requestedBackgroundChildren("task", { prompt: "x" }), 0)
  assert.equal(requestedBackgroundChildren("task", { prompt: "x" }, true), 1)
  assert.equal(requestedBackgroundChildren(TASK_BATCH_TOOL_NAME, { tasks: [{}, { background: false }, {}] }, true), 3)
  const refusal = formatBackgroundCapRefusal({ toolName: "task", cap: 2, running: 2, requested: 1, everyDispatch: true })
  assert.match(refusal, /Every subagent runs in the background on this opencode/)
  assert.equal(/foreground/.test(refusal), false)
  assert.match(formatBackgroundCapRefusal({ toolName: "task", cap: 2, running: 2, requested: 1 }), /foreground/)
})

test("over a real proxy server a 2.3 dispatch without `background` is refused at the cap", async () => {
  _resetBackgroundTasks()
  setOpencodeClient({
    session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, parentID: PARENT, directory: "/tmp" } }),
      status: async () => ({ data: { ses_busy23: { type: "busy" } } }),
      messages: async () => ({ data: [] }),
      abort: async () => ({ data: true }),
    },
  })
  noteBackgroundDispatchResult("k23cap", { kind: "text", text: DISPATCH_ANSWER_2_3.replace(CHILD, "ses_busy23") })
  const tools = applyBackgroundSubagentSupport(DEFAULT_PROXY_TOOLS, "always", "v2")
  const srv = await ensureProxyServer({ maxBackgroundSubagents: 1 } as never, tools, "k23cap", false, PARENT)
  const queued: string[] = []
  srv.calls.on("call", (call: ProxyToolCall) => {
    queued.push(call.toolName)
    call.resolve({ kind: "text", text: "dispatched" })
  })
  try {
    const response = await fetch(srv.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${srv.authToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "task", arguments: { description: "Probe", prompt: "Report.", subagent_type: "general" } },
      }),
    })
    const raw = await response.text()
    const json = JSON.parse(raw.split("\n").find((line) => line.startsWith("data:"))?.slice(5) ?? raw)
    assert.equal(json.result.isError, true)
    assert.match(json.result.content[0].text, /Every subagent runs in the background on this opencode/)
    assert.deepEqual(queued, [], "nothing reached opencode")
  } finally {
    await srv.close()
  }
})

test("task_status hands over a later round of a child that ran again, once", async () => {
  _resetBackgroundTasks()
  const reply = (text: string) => ({
    info: { role: "assistant", time: { created: 1, completed: 2 } },
    parts: [{ type: "text", text }],
  })
  const user = { info: { role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "go" }] }
  let messages: unknown[] = [user, reply("FIRST_ROUND")]
  setOpencodeClient({
    session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, parentID: PARENT, directory: "/tmp" } }),
      status: async () => ({ data: {} }),
      messages: async () => ({ data: messages }),
      abort: async () => ({ data: true }),
    },
  })
  const options = { sessionKey: "k23round", callerSessionId: PARENT }
  const text = async () => ((await collectBackgroundTask({ task_id: CHILD }, options)) as { text: string }).text

  assert.match(await text(), /FIRST_ROUND/)
  assert.match(await text(), /Already delivered/)
  // A follow-up ran and answered again: that answer was never handed over.
  messages = [user, reply("FIRST_ROUND"), user, reply("SECOND_ROUND")]
  const second = await text()
  assert.match(second, /SECOND_ROUND/)
  assert.equal(second.includes("Already delivered"), false)
  assert.match(await text(), /Already delivered/)
  // The doctor still lists the task id itself.
  assert.deepEqual(snapshotBackgroundTasks().find((ledger) => ledger.sessionKey === "k23round")?.collected, [CHILD])
})

// --- the version reaches the model ------------------------------------------

test("a V2 model is told the opencode version it serves", async () => {
  const settings = await resolveSdkSettings("claude-code", { cliPath: "claude" }, {}, "2.3.2")
  assert.equal(settings.hostVersion, "2.3.2")
  assert.equal(settings.hostApi, "v2")
  const unknown = await resolveSdkSettings("claude-code", { cliPath: "claude" }, {}, undefined)
  assert.equal("hostVersion" in unknown, false)
})

/**
 * End to end: a real `doStream` on a 2.3 host hands the CLI the 2.3 hints in
 * its appended prompt and a proxy whose `task` has no `background`, and a 2.2
 * host the 2.0 texts. The fake CLI asks its own proxy for `tools/list` before
 * it answers, the way Claude Code does at start.
 */
async function spawnFor(hostVersion: string) {
  const fsMod = await import("node:fs")
  const pathMod = await import("node:path")
  const osMod = await import("node:os")
  const cryptoMod = await import("node:crypto")
  const { createClaudeCode } = await import("../src/index.js")
  const { deleteActiveProcessAndWait, sessionKey, deleteClaudeSessionId } = await import("../src/session-manager.js")

  const id = cryptoMod.randomUUID().slice(0, 8)
  const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "oc-23-"))
  const cwd = pathMod.join(root, "project")
  fsMod.mkdirSync(cwd, { recursive: true })
  const cliPath = pathMod.join(root, `claude-23-${id}.cjs`)
  const outPath = pathMod.join(root, `out-${id}.json`)
  fsMod.writeFileSync(
    cliPath,
    `#!${process.execPath}
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) { process.stdout.write("2.1.293\\n"); process.exit(0) }
if (process.argv.includes("--help")) { process.stdout.write("Usage: claude [options]\\n"); process.exit(0) }
const argv = process.argv.slice(2)
async function toolsList() {
  const at = argv.indexOf("--mcp-config")
  for (const file of argv.slice(at + 1)) {
    if (file.startsWith("--")) break
    const server = Object.values(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers ?? {})[0]
    if (!server || !server.url) continue
    const headers = { ...(server.headers ?? {}), "Content-Type": "application/json", Accept: "application/json, text/event-stream" }
    const post = async (body) => {
      const raw = await (await fetch(server.url, { method: "POST", headers, body: JSON.stringify(body) })).text()
      const line = raw.split("\\n").find((entry) => entry.startsWith("data:"))
      return JSON.parse(line ? line.slice(5) : raw)
    }
    await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fake", version: "0" } } })
    return (await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).result.tools
  }
  return []
}
readline.createInterface({ input: process.stdin }).on("line", async () => {
  const tools = await toolsList()
  const promptAt = argv.indexOf("--append-system-prompt-file")
  fs.writeFileSync(${JSON.stringify(outPath)}, JSON.stringify({ tools, prompt: fs.readFileSync(argv[promptAt + 1], "utf8") }))
  const session_id = "fake-23-session"
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "assistant", session_id, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id, is_error: false, duration_ms: 1, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n")
})
`,
  )
  fsMod.chmodSync(cliPath, 0o755)

  const modelId = `claude-test-23-${id}`
  const sk = sessionKey(cwd, `${modelId}::tools::default::context=["claude-code",null]`)
  const saved = { HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME }
  process.env.HOME = root
  process.env.XDG_STATE_HOME = pathMod.join(root, "state")
  try {
    const model = createClaudeCode({
      cliPath,
      cwd,
      hostApi: "v2",
      hostVersion,
      proxyTools: ["Task"],
      bridgeOpencodeMcp: false,
      bridgeOpencodeSkills: false,
      proxyOpencodeMcpTools: false,
      autoContinueIncompleteTurns: false,
    } as never).languageModel(modelId)
    const response = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Say done." }] }],
      tools: [],
    } as never)
    for await (const _part of (response as { stream: AsyncIterable<unknown> }).stream) {
      // drain
    }
    return JSON.parse(fsMod.readFileSync(outPath, "utf8")) as { tools: ProxyToolDef[]; prompt: string }
  } finally {
    await deleteActiveProcessAndWait(sk)
    deleteClaudeSessionId(sk)
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

// POSIX only: the fake CLI is a shebang script made executable with `chmod`.
test("a 2.3 spawn is told every subagent runs in the background; a 2.2 spawn is not", { skip: process.platform === "win32" }, async () => {
  const on23 = await spawnFor("2.3.2")
  assert.ok(on23.prompt.includes(BACKGROUND_SUBAGENT_HINT_ALWAYS), "2.3 hint missing")
  assert.ok(on23.prompt.includes(SUBAGENT_DISPATCH_HINT_ALWAYS_BACKGROUND), "2.3 dispatch hint missing")
  assert.equal(on23.prompt.includes("Foreground is still the default"), false)
  const task23 = def(on23.tools, "task")
  assert.equal(fieldNames(task23).includes("background"), false)
  assert.equal(fieldNames(def(on23.tools, TASK_BATCH_TOOL_NAME)).includes("background"), false)
  assert.ok(task23.description.includes(TASK_BACKGROUND_NOTE_ALWAYS))
  assert.ok(on23.tools.some((tool) => tool.name === "task_status"))

  const on22 = await spawnFor("2.2.7")
  assert.ok(on22.prompt.includes(BACKGROUND_SUBAGENT_HINT_V2), "2.2 hint missing")
  assert.ok(on22.prompt.includes(SUBAGENT_DISPATCH_HINT))
  assert.equal(on22.prompt.includes(BACKGROUND_SUBAGENT_HINT_ALWAYS), false)
  const task22 = def(on22.tools, "task")
  assert.ok(fieldNames(task22).includes("background"))
  assert.ok(task22.description.includes(TASK_BACKGROUND_NOTE_V2))
})
