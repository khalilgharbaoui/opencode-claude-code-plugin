/**
 * `/claude-code-doctor`: the pure report formatter against a fixed report, the
 * command-registration guard, the parser, the loopback auth self-check, and
 * the strip that keeps the whole exchange out of a rebuilt transcript.
 *
 * Usage: npx tsx --test test-doctor.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  DOCTOR_COMMAND,
  DOCTOR_MARKER,
  checkProxyAuth,
  formatDoctorReport,
  parseDoctorCommand,
  parseDoctorCommandContent,
  type DoctorReport,
} from "./src/doctor.js"
import { EventEmitter } from "node:events"
import { registerDoctorCommand } from "./src/index.js"
import { filterSideQuestionHistory } from "./src/message-builder.js"
import {
  deleteActiveProcess,
  describeSessionKey,
  setActiveProcess,
  snapshotActiveProcesses,
} from "./src/session-manager.js"

const report: DoctorReport = {
  plugin: "0.18.3",
  opencode: "1.18.29",
  claudeCli: { path: "/usr/local/bin/claude", version: "2.1.263 (Claude Code)" },
  cwd: { resolved: "/Users/you/code/app", source: "process" },
  providers: ["claude-code-default", "claude-code-work"],
  accounts: ["default", "work"],
  proxyTools: ["Bash", "Edit", "Write", "WebFetch", "Task"],
  mcpServers: ["github"],
  transport: "headless",
  planModeQuestion: false,
  turnStats: true,
  anthropicApiKeyInEnv: false,
  processes: [
    {
      sessionKey: "/Users/you/code/app::claude-opus-5::full::ses_abc::context=[]",
      session: "ses_abc",
      model: "claude-opus-5",
      compaction: false,
      pid: 4242,
      inFlight: true,
      ageMs: 125_000,
      effort: "high",
      attached: true,
      proxyUrl: "http://127.0.0.1:51234/mcp",
      lastStderr: "warning: something happened\n",
    },
  ],
  pendingCalls: [
    { sessionKey: "sk", toolCallId: "call_1", toolName: "task", ageMs: 30_000, deadlineMs: 3_600_000, emitted: true, channelClosed: false },
  ],
  proxyServers: [{ url: "http://127.0.0.1:51234/mcp", auth: { status: "ok", code: 401 } }],
}

test("the report names every field a bug report needs, and nothing secret", () => {
  const text = formatDoctorReport(report)
  assert.ok(text.startsWith(DOCTOR_MARKER), "must lead with the strippable marker")

  for (const expected of [
    "| plugin | 0.18.3 |",
    "| opencode | 1.18.29 |",
    "| claude CLI | `/usr/local/bin/claude` (2.1.263 (Claude Code)) |",
    "| cwd | `/Users/you/code/app` (process) |",
    "| providers | claude-code-default, claude-code-work |",
    "| accounts | default, work |",
    "| proxyTools | Bash, Edit, Write, WebFetch, Task |",
    "| MCP servers (on disk) | github |",
    "| transport | headless |",
    "| turnStats | true |",
    "| ANTHROPIC_API_KEY in env | no |",
    "| ses_abc | claude-opus-5 | 4242 | yes | 2m | high |",
    "| task | `call_1` | 30.0s | 1h 0m |",
    "| http://127.0.0.1:51234/mcp | 401, good |",
    "warning: something happened",
  ]) {
    assert.ok(text.includes(expected), `report is missing: ${expected}`)
  }

  // Nothing that identifies a credential may appear, by value or by name.
  assert.equal(/authToken|bearer|sk-ant|Authorization/i.test(text), false)
})

test("an empty runtime reads as empty rather than as broken", () => {
  const text = formatDoctorReport({
    ...report,
    processes: [],
    pendingCalls: [],
    proxyServers: [],
    providers: [],
    accounts: [],
    proxyTools: [],
    mcpServers: [],
  })
  assert.ok(text.includes("None. The next message in a Claude Code session spawns one."))
  assert.ok(text.includes("None running."))
  assert.ok(text.includes("| providers | none |"))
  assert.equal(text.includes("Last stderr"), false)
})

test("an unauthenticated proxy is called out as unsafe, not reported as fine", () => {
  const text = formatDoctorReport({
    ...report,
    proxyServers: [{ url: "http://127.0.0.1:1/mcp", auth: { status: "unsafe", code: 200 } }],
  })
  assert.match(text, /200, UNSAFE/)
  assert.match(text, /Restart every opencode window/)
})

test("checkProxyAuth calls initialize unauthenticated and reads 401 as good", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = []
  const fake = (async (url: any, init: any) => {
    seen.push({ url: String(url), init })
    return new Response("", { status: 401 })
  }) as unknown as typeof fetch

  const ok = await checkProxyAuth("http://127.0.0.1:51234/mcp", fake)
  assert.deepEqual(ok, { status: "ok", code: 401 })
  assert.equal(seen[0]!.init.method, "POST")
  const headers = seen[0]!.init.headers as Record<string, string>
  assert.equal(headers["content-type"], "application/json")
  assert.equal(headers.host, "127.0.0.1:51234")
  assert.equal("origin" in headers, false, "an Origin would make the probe meaningless")
  assert.equal("authorization" in headers, false, "the probe must be unauthenticated")
  assert.match(String(seen[0]!.init.body), /"method":"initialize"/)
  assert.equal(
    /tools\/call/.test(String(seen[0]!.init.body)),
    false,
    "a tools/call probe would execute something",
  )

  const unsafe = await checkProxyAuth(
    "http://127.0.0.1:51234/mcp",
    (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
  )
  assert.deepEqual(unsafe, { status: "unsafe", code: 200 })

  const down = await checkProxyAuth(
    "http://127.0.0.1:51234/mcp",
    (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch,
  )
  assert.equal(down.status, "unreachable")
})

test("the command is parsed only off the newest user message", () => {
  assert.deepEqual(parseDoctorCommandContent(`/${DOCTOR_COMMAND}`), { rest: "" })
  assert.deepEqual(parseDoctorCommandContent(`/${DOCTOR_COMMAND} verbose`), { rest: "verbose" })
  assert.equal(parseDoctorCommandContent("tell me about /claude-code-doctor"), null)
  assert.equal(parseDoctorCommandContent(null), null)

  // opencode appends reminder blocks as extra text parts on the same message.
  assert.deepEqual(
    parseDoctorCommandContent([
      { type: "text", text: `/${DOCTOR_COMMAND}` },
      { type: "text", text: "<system-reminder>be careful</system-reminder>" },
    ]),
    { rest: "" },
  )

  assert.equal(
    parseDoctorCommand([
      { role: "user", content: `/${DOCTOR_COMMAND}` },
      { role: "assistant", content: "report" },
    ]),
    null,
    "a historical report must not re-run",
  )
  assert.deepEqual(
    parseDoctorCommand([
      { role: "assistant", content: "hi" },
      { role: "user", content: `/${DOCTOR_COMMAND}` },
    ]),
    { rest: "" },
  )
})

test("registration never overwrites a user-defined command of the same name", () => {
  const fresh: any = {}
  assert.equal(registerDoctorCommand(fresh), true)
  assert.equal(fresh.command[DOCTOR_COMMAND].template, `/${DOCTOR_COMMAND} $ARGUMENTS`)
  assert.equal(DOCTOR_COMMAND.includes(" "), false, "opencode splits a command name on space")

  const mine: any = { command: { [DOCTOR_COMMAND]: { template: "mine" } } }
  assert.equal(registerDoctorCommand(mine), false)
  assert.equal(mine.command[DOCTOR_COMMAND].template, "mine")
})

test("the doctor exchange is kept out of a transcript rebuilt for the CLI", () => {
  const prompt = [
    { role: "user", content: [{ type: "text", text: "real question" }] },
    { role: "assistant", content: [{ type: "text", text: "real answer" }] },
    { role: "user", content: [{ type: "text", text: `/${DOCTOR_COMMAND}` }] },
    { role: "assistant", content: [{ type: "text", text: formatDoctorReport(report) }] },
    { role: "user", content: [{ type: "text", text: "next question" }] },
  ] as any

  const filtered = filterSideQuestionHistory(prompt)
  assert.deepEqual(
    filtered.map((message: any) => message.content[0]?.text),
    ["real question", "real answer", "next question"],
  )
})

test("snapshotActiveProcesses reports age, in-flight state and a stderr tail if one exists", () => {
  const key = "/w::claude-opus-5::full::ses_snap::context=[]"
  const entry: any = {
    proc: { pid: 777, kill: () => true },
    lineEmitter: new EventEmitter(),
    // What `spawnClaudeProcess` stamps on every child; without it the report
    // can only say "unknown".
    startedAt: Date.now() - 5_000,
    effort: "max",
    turnInFlight: true,
    opencodeSessionID: "ses_snap",
    proxyServer: { url: "http://127.0.0.1:9/mcp", close: async () => {} },
    // Written by nothing in this lane; read defensively so the report works
    // whether or not the field exists on the running build.
    lastStderr: "boom\n",
  }
  setActiveProcess(key, entry)
  try {
    const row = snapshotActiveProcesses().find((candidate) => candidate.sessionKey === key)
    assert.ok(row)
    assert.equal(row!.session, "ses_snap")
    assert.equal(row!.model, "claude-opus-5")
    assert.equal(row!.pid, 777)
    assert.equal(row!.inFlight, true)
    assert.equal(row!.effort, "max")
    assert.ok(row!.ageMs !== undefined && row!.ageMs >= 5_000, "age comes from startedAt")
    assert.equal(row!.attached, false)
    assert.equal(row!.proxyUrl, "http://127.0.0.1:9/mcp")
    assert.equal(row!.lastStderr, "boom\n")

    // A build carrying neither field must still produce a usable row.
    delete entry.startedAt
    delete entry.lastStderr
    const bare = snapshotActiveProcesses().find((candidate) => candidate.sessionKey === key)
    assert.equal(bare!.ageMs, undefined)
    assert.equal(bare!.lastStderr, undefined)
  } finally {
    deleteActiveProcess(key)
  }
})

test("describeSessionKey pulls the model and opencode session back out", () => {
  assert.deepEqual(describeSessionKey("/w::claude-opus-5::full::ses_abc::context=[]"), {
    cwd: "/w",
    model: "claude-opus-5",
    session: "ses_abc",
    compaction: false,
  })
  assert.deepEqual(describeSessionKey("/w::claude-haiku-4-5::compaction::ses_abc"), {
    cwd: "/w",
    model: "claude-haiku-4-5",
    session: "ses_abc",
    compaction: true,
  })
  assert.equal(describeSessionKey("garbage").model, "unknown")
})
