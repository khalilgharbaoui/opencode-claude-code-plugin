/**
 * `/claude-code-doctor`: the pure report formatter against a fixed report, the
 * command-registration guard, the parser, the loopback auth self-check, and
 * the strip that keeps the whole exchange out of a rebuilt transcript.
 *
 * Usage: npx tsx --test test/doctor.test.ts
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
} from "../src/doctor.js"
import {
  PLAN_USAGE_MAX_CHARS,
  parsePlanUsage,
  wantsPlanUsage,
  fetchPlanUsage,
} from "../src/plan-usage.js"
import { EventEmitter } from "node:events"
import { registerDoctorCommand } from "../src/index.js"
import { filterSideQuestionHistory } from "../src/message-builder.js"
import {
  deleteActiveProcess,
  describeSessionKey,
  setActiveProcess,
  snapshotActiveProcesses,
} from "../src/session-manager.js"

/** 2026-09-22 20:56 local, the shape of the stale process that started #g192. */
const LOADED_AT = new Date(2026, 8, 22, 20, 56).getTime()

const report: DoctorReport = {
  plugin: "0.18.3",
  build: {
    loaded: {
      version: "0.18.3",
      entryPath: "/Users/you/code/plugin/dist/index.js",
      mtimeMs: 1_000,
      size: 100,
      loadedAt: LOADED_AT,
    },
    onDisk: { version: "0.18.3", mtimeMs: 1_000, size: 100 },
    stale: null,
    verdict: "current",
  },
  opencode: "1.18.29",
  claudeCli: { path: "/usr/local/bin/claude", version: "2.1.263 (Claude Code)" },
  cwd: { resolved: "/Users/you/code/app", source: "process" },
  providers: ["claude-code-default", "claude-code-work"],
  accounts: ["default", "work"],
  accountGroups: ["work=work"],
  proxyTools: ["Bash", "Edit", "Write", "WebFetch", "Task"],
  mcpServers: ["github"],
  permissionPresets: [
    { provider: "claude-code-default", preset: "none", applied: false, overrides: [] },
    {
      provider: "claude-code-work",
      preset: "read-only",
      applied: true,
      overrides: ["skipPermissions: forced to false; the CLI exits with ..."],
    },
  ],
  transport: "headless",
  transportInUse: "headless",
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
      transport: "headless",
      proxyUrl: "http://127.0.0.1:51234/mcp",
      lastStderr: "warning: something happened\n",
    },
  ],
  pendingCalls: [
    { sessionKey: "sk", toolCallId: "call_1", toolName: "task", ageMs: 30_000, deadlineMs: 3_600_000, emitted: true, channelClosed: false },
  ],
  proxyServers: [{ url: "http://127.0.0.1:51234/mcp", auth: { status: "ok", code: 401 } }],
  mcpServerErrors: [],
  pluginLoadFailures: [],
  hookFailures: [],
  planUsage: { status: "not-requested" },
  backgroundSubagents: { gate: undefined, ledgers: [] },
}

test("the report names every field a bug report needs, and nothing secret", () => {
  const text = formatDoctorReport(report)
  assert.ok(text.startsWith(DOCTOR_MARKER), "must lead with the strippable marker")

  for (const expected of [
    "| plugin | 0.18.3 |",
    "| plugin build | 0.18.3, loaded 2026-09-22 20:56, current |",
    "| opencode | 1.18.29 |",
    "| claude CLI | `/usr/local/bin/claude` (2.1.263 (Claude Code)) |",
    "| cwd | `/Users/you/code/app` (process) |",
    "| providers | claude-code-default, claude-code-work |",
    "| accounts | default, work |",
    "| proxyTools | Bash, Edit, Write, WebFetch, Task |",
    "| MCP servers (on disk) | github |",
    "| permissionPreset | claude-code-default: none, claude-code-work: read-only |",
    "| transport | headless; this conversation: headless |",
    "| turnStats | true |",
    "| ANTHROPIC_API_KEY in env | no |",
    "| ses_abc | claude-opus-5 | headless | 4242 | yes | 2m | high |",
    "| task | `call_1` | 30.0s | 1h 0m |",
    "| http://127.0.0.1:51234/mcp | 401, good |",
    "warning: something happened",
  ]) {
    assert.ok(text.includes(expected), `report is missing: ${expected}`)
  }

  // Nothing that identifies a credential may appear, by value or by name.
  assert.equal(/authToken|bearer|sk-ant|Authorization/i.test(text), false)
})

// --- the plugin build row -------------------------------------------------

// The row the operator reads when a fix they installed is not taking effect.
// It is built from an unthrottled read that marks no session (`describe`), so
// running the doctor can never consume the note a conversation is owed; that
// half is asserted in test/stale-build.test.ts, which owns the watch.
test("the plugin build row names the verdict, and never the entry file", () => {
  const stale = (over: Partial<DoctorReport["build"]>): string =>
    formatDoctorReport({ ...report, build: { ...report.build, ...over } })

  assert.ok(
    stale({
      onDisk: { version: "0.36.5", mtimeMs: 2_000, size: 120 },
      stale: {
        kind: "version",
        loadedVersion: "0.18.3",
        onDiskVersion: "0.36.5",
        loadedAt: LOADED_AT,
      },
      verdict: "version",
    }).includes(
      "| plugin build | 0.18.3, loaded 2026-09-22 20:56; on disk 0.36.5. Restart opencode to run it |",
    ),
  )

  const rebuiltAt = new Date(2026, 9, 3, 14, 21).getTime()
  assert.ok(
    stale({
      onDisk: { version: "0.18.3", mtimeMs: rebuiltAt, size: 120 },
      stale: {
        kind: "rebuilt",
        loadedVersion: "0.18.3",
        onDiskVersion: "0.18.3",
        loadedAt: LOADED_AT,
        rebuiltAt,
      },
      verdict: "rebuilt",
    }).includes("the same version was rebuilt on disk at 2026-10-03 14:21. Restart opencode"),
  )

  // A disk we could not read is its own answer. It must never read as stale
  // (a deleted package cache is not evidence of anything) and must never read
  // as current either.
  const unreadable = stale({ onDisk: undefined, stale: null, verdict: "unreadable" })
  assert.ok(unreadable.includes("the build on disk could not be read"))
  assert.equal(unreadable.includes("Restart opencode"), false)

  // No path in any of the four, so a bundle has nothing new to redact.
  for (const text of [formatDoctorReport(report), unreadable]) {
    assert.equal(text.includes("dist/index.js"), false)
  }
})

// --- background subagents ------------------------------------------------

test("background subagents: not read yet is an answer, not a no", () => {
  const text = formatDoctorReport(report)
  assert.ok(text.includes("**Background subagents**"), text)
  assert.ok(text.includes("Not read yet this process"), text)
  // A gate nobody has read must never print as if the host refused.
  assert.equal(text.includes("| `background` offered to Claude | no |"), false)
  assert.ok(
    text.includes("No background task has been collected or cancelled by this process."),
    text,
  )
})

test("an unsupported 1.x host is told the flag is opencode's, not the plugin's", () => {
  const text = formatDoctorReport({
    ...report,
    backgroundSubagents: {
      gate: { supported: false, hostApi: "v1", registryResolved: true, at: Date.now() - 5_000 },
      ledgers: [],
    },
  })
  assert.ok(text.includes("| `background` offered to Claude | no |"), text)
  assert.ok(text.includes("| `task_status` / `task_cancel` | not registered |"), text)
  assert.ok(text.includes("| decided from | opencode's live `task` schema |"), text)
  assert.ok(text.includes("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"), text)
  assert.ok(text.includes("restart"), "the variable is read at opencode's own startup")
})

// A registry that never answered is not the same as a host that said no, and
// the difference is exactly what an operator needs to debug it.
test("a registry that did not answer says so rather than blaming the host", () => {
  const text = formatDoctorReport({
    ...report,
    backgroundSubagents: {
      gate: { supported: false, hostApi: "v1", registryResolved: false, at: Date.now() },
      ledgers: [],
    },
  })
  assert.ok(text.includes("did not answer"), text)
})

test("on opencode 2 the report says the registry is not consulted", () => {
  const text = formatDoctorReport({
    ...report,
    backgroundSubagents: {
      gate: { supported: true, hostApi: "v2", registryResolved: false, at: Date.now() },
      ledgers: [],
    },
  })
  assert.ok(text.includes("| opencode API | v2 |"), text)
  assert.ok(text.includes("| `background` offered to Claude | yes |"), text)
  assert.ok(text.includes("unconditionally"), text)
  // The 1.x env-var advice must never appear on a host that has no such flag.
  assert.equal(text.includes("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"), false)
})

test("collected and cancelled tasks are listed per opencode session", () => {
  const text = formatDoctorReport({
    ...report,
    backgroundSubagents: {
      gate: { supported: true, hostApi: "v1", registryResolved: true, at: Date.now() },
      ledgers: [
        {
          sessionKey: "/Users/you/code/app::claude-opus-5::full::ses_abc::context=[]",
          collected: ["ses_child1"],
          cancelled: ["ses_child2"],
        },
        // A key with nothing on it must not take a row.
        { sessionKey: "/x::m::full::ses_empty::context=[]", collected: [], cancelled: [] },
      ],
    },
  })
  assert.ok(text.includes("| ses_abc | ses_child1 | ses_child2 |"), text)
  assert.equal(text.includes("ses_empty"), false)
})

// The report is pasted into bug reports, so the whole-report secret check has
// to hold with the new section populated too.
test("the background section adds nothing secret", () => {
  const text = formatDoctorReport({
    ...report,
    backgroundSubagents: {
      gate: { supported: true, hostApi: "v2", registryResolved: true, at: Date.now() },
      ledgers: [
        { sessionKey: "/x::m::full::ses_abc::context=[]", collected: ["ses_c"], cancelled: [] },
      ],
    },
  })
  assert.equal(/authToken|bearer|sk-ant|Authorization/i.test(text), false)
})

test("skipped MCP entries get their own section, and only when there are some", () => {
  // The clean case must not print an empty table: a skipped entry is an
  // exception, and a permanent empty section trains people to skip the report.
  assert.equal(formatDoctorReport(report).includes("Claude Code skipped"), false)

  const text = formatDoctorReport({
    ...report,
    mcpServerErrors: [
      { name: "github", type: "url_missing_type", message: "Skipped - no type" },
      { name: "opencode_proxy", type: "invalid_config", message: "" },
    ],
  })
  assert.ok(text.includes("**MCP config entries Claude Code skipped**"), text)
  assert.ok(text.includes("| github | `url_missing_type` | Skipped - no type |"), text)
  assert.ok(text.includes("| opencode_proxy | `invalid_config` | no detail |"), text)
})

test("plugins Claude Code did not load get their own section, and only when there are some", () => {
  assert.equal(formatDoctorReport(report).includes("did not load"), false)
  const text = formatDoctorReport({
    ...report,
    pluginLoadFailures: [
      { kind: "error", plugin: "probe-dep@inline", type: "dependency-unsatisfied", message: "Dependency missing" },
      { kind: "warning", plugin: "workspace@settings", type: "suppressed", message: "" },
    ],
  })
  assert.ok(text.includes("**Plugins Claude Code did not load**"), text)
  assert.ok(text.includes("| probe-dep@inline | error | `dependency-unsatisfied` | Dependency missing |"), text)
  assert.ok(text.includes("| workspace@settings | warning | `suppressed` | no detail |"), text)
})

test("hooks that failed get their own section, with their stderr and not their stdout", () => {
  assert.equal(formatDoctorReport(report).includes("Hooks Claude Code ran"), false)

  const text = formatDoctorReport({
    ...report,
    hookFailures: [
      {
        hookName: "SessionStart:startup",
        hookEvent: "SessionStart",
        exitCode: 3,
        outcome: "error",
        stderr: "probe-hook-stderr",
      },
      {
        hookName: "PreToolUse:Bash",
        hookEvent: "PreToolUse",
        exitCode: undefined,
        outcome: "error",
        stderr: "",
      },
    ],
  })
  assert.ok(text.includes("**Hooks Claude Code ran that failed**"), text)
  assert.ok(
    text.includes("| SessionStart:startup | SessionStart | 3 | error | probe-hook-stderr |"),
    text,
  )
  assert.ok(text.includes("| PreToolUse:Bash | PreToolUse | n/a | error | nothing |"), text)
  // The hook's stdout is model context; the report says so and never holds it.
  assert.ok(text.includes("its stdout is spliced into the model's context"), text)
})

test("plan usage is off unless asked for, and says how to ask", () => {
  const text = formatDoctorReport(report)
  assert.ok(text.includes("**Plan usage**"), text)
  assert.ok(text.includes("/claude-code-doctor usage"), "the default must say how to get it")
  // The cost that is not tokens has to be stated, or nobody can consent to it.
  assert.ok(text.includes("SessionStart"), text)
})

test("plan usage renders the CLI's own text, and a failure does not eat the report", () => {
  const ok = formatDoctorReport({
    ...report,
    planUsage: {
      status: "ok",
      text: "Current session: 82% used\nCurrent week (all models): 57% used",
      costUsd: 0,
      numTurns: 0,
    },
  })
  assert.ok(ok.includes("Current session: 82% used"), ok)
  assert.ok(ok.includes("```text"), "quoted, not reinterpreted")

  const failed = formatDoctorReport({
    ...report,
    planUsage: { status: "failed", error: "spawn claude ENOENT" },
  })
  assert.ok(failed.includes("Could not read it from the CLI: spawn claude ENOENT"), failed)
  // The rest of the report still has to be there.
  assert.ok(failed.includes("| plugin | 0.18.3 |"), failed)
})

test("only the documented argument asks for plan usage", () => {
  for (const argument of ["usage", "cost", "stats", "limits", " USAGE ", "Cost"]) {
    assert.equal(wantsPlanUsage(argument), true, argument)
  }
  for (const argument of ["", "everything", "usages", "plan usage"]) {
    assert.equal(wantsPlanUsage(argument), false, argument)
  }
})

/**
 * The reply shape measured on 2.1.280: `num_turns: 0`, `total_cost_usd: 0` and
 * `local_command: "cost"`, which is what makes the probe free.
 */
const planUsageReply = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 0,
  duration_api_ms: 0,
  total_cost_usd: 0,
  local_command: "cost",
  result: "You are currently using your subscription\n\nCurrent session: 82% used",
})

test("parsePlanUsage reads the free reply and refuses anything it cannot trust", () => {
  const parsed = parsePlanUsage(planUsageReply)
  assert.equal(parsed.status, "ok")
  assert.ok(parsed.status === "ok" && parsed.text.includes("Current session: 82% used"))
  assert.equal(parsed.status === "ok" && parsed.costUsd, 0)
  assert.equal(parsed.status === "ok" && parsed.numTurns, 0)

  // Leading noise on its own lines is tolerated: the result object is last.
  const noisy = parsePlanUsage(`some warning\n${planUsageReply}`)
  assert.equal(noisy.status, "ok")

  for (const bad of ["", "   ", "not json at all", "{}", '{"type":"result"}']) {
    assert.equal(parsePlanUsage(bad).status, "failed", JSON.stringify(bad))
  }

  const errored = parsePlanUsage(
    JSON.stringify({ type: "result", is_error: true, result: "not logged in" }),
  )
  assert.equal(errored.status, "failed")
  assert.ok(errored.status === "failed" && errored.error.includes("not logged in"))
})

test("a runaway reply is truncated rather than filling the report", () => {
  const huge = JSON.stringify({ type: "result", result: "x".repeat(PLAN_USAGE_MAX_CHARS + 500) })
  const parsed = parsePlanUsage(huge)
  assert.equal(parsed.status, "ok")
  assert.ok(parsed.status === "ok" && parsed.text.endsWith("[truncated]"))
  assert.ok(parsed.status === "ok" && parsed.text.length < PLAN_USAGE_MAX_CHARS + 100)
})

test("fetchPlanUsage asks for /cost as json and never throws", async () => {
  const calls: Array<{ cliPath: string; args: string[] }> = []
  const ok = await fetchPlanUsage("/usr/local/bin/claude", {
    runImpl: async (cliPath, args) => {
      calls.push({ cliPath, args })
      return planUsageReply
    },
  })
  assert.equal(ok.status, "ok")
  assert.deepEqual(calls, [
    {
      cliPath: "/usr/local/bin/claude",
      args: ["-p", "/cost", "--output-format", "json"],
    },
  ])

  // A CLI that is missing, wedged or killed by the timeout is a row, not a crash.
  const thrown = await fetchPlanUsage("/nope", {
    runImpl: async () => {
      throw new Error("spawn /nope ENOENT")
    },
  })
  assert.equal(thrown.status, "failed")
  assert.ok(thrown.status === "failed" && thrown.error.includes("ENOENT"))
})

test("fetchPlanUsage spawns with the turn spawn's env, key strip included", async () => {
  // `-p` is a full CLI start, so it must not auto-update the binary behind the
  // version cache, and `ignoreAnthropicApiKey` must hold here as on a turn.
  const saved = {
    DISABLE_AUTOUPDATER: process.env.DISABLE_AUTOUPDATER,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  }
  delete process.env.DISABLE_AUTOUPDATER
  process.env.ANTHROPIC_API_KEY = "sk-test-not-a-real-key"
  try {
    const envs: Array<Record<string, string | undefined>> = []
    const runImpl = async (
      _cliPath: string,
      _args: string[],
      _timeoutMs: number,
      env: Record<string, string | undefined>,
    ) => {
      envs.push(env)
      return planUsageReply
    }
    await fetchPlanUsage("claude", { runImpl })
    await fetchPlanUsage("claude", { runImpl, ignoreAnthropicApiKey: true })
    assert.equal(envs[0].DISABLE_AUTOUPDATER, "1")
    assert.equal(envs[0].ANTHROPIC_API_KEY, "sk-test-not-a-real-key", "kept unless asked")
    assert.equal(envs[1].DISABLE_AUTOUPDATER, "1")
    assert.equal(envs[1].ANTHROPIC_API_KEY, undefined, "stripped like a turn's spawn")
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test("an applied preset lists the options it replaced", () => {
  const text = formatDoctorReport(report)
  assert.ok(text.includes("**Permission preset overrides**"), text)
  assert.ok(text.includes("`claude-code-work` (read-only) replaced:"), text)
  assert.ok(text.includes("- skipPermissions: forced to false"), text)
  // The provider that has no preset gets no override block of its own.
  assert.equal(text.includes("`claude-code-default` (none)"), false)
})

test("an unrecognised preset is never shown as if it took effect", () => {
  const text = formatDoctorReport({
    ...report,
    permissionPresets: [
      { provider: "claude-code", preset: "readonly", applied: false, overrides: [] },
    ],
  })
  assert.ok(
    text.includes("| permissionPreset | claude-code: readonly (unknown, nothing applied) |"),
    text,
  )
  assert.equal(text.includes("**Permission preset overrides**"), false)
})

test("a pending call with no deadline reads as none, not as 0.0s", () => {
  const text = formatDoctorReport({
    ...report,
    pendingCalls: [{ ...report.pendingCalls[0]!, toolCallId: "call_2", deadlineMs: 0 }],
  })
  assert.ok(text.includes("| task | `call_2` | 30.0s | none |"), text)
})

test("an empty runtime reads as empty rather than as broken", () => {
  const text = formatDoctorReport({
    ...report,
    processes: [],
    pendingCalls: [],
    proxyServers: [],
    providers: [],
    accounts: [],
    accountGroups: [],
    proxyTools: [],
    mcpServers: [],
    permissionPresets: [],
  })
  assert.ok(text.includes("None. The next message in a Claude Code session spawns one."))
  assert.ok(text.includes("None running."))
  assert.ok(text.includes("| providers | none |"))
  assert.ok(text.includes("| permissionPreset | none |"))
  assert.equal(text.includes("**Permission preset overrides**"), false)
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

test("the transport row says what was asked for and what this conversation is on", () => {
  const plain = formatDoctorReport(report)
  assert.match(plain, /\| transport \| headless; this conversation: headless \|/)
  assert.doesNotMatch(plain, /measured on/, "no PTY requested or running: no measured-version row")

  const auto = formatDoctorReport({
    ...report,
    transport: "auto",
    interactiveMeasured: { measured: "2.1.288", unmeasured: false },
  })
  assert.match(auto, /auto \(headless until claude refuses `--print`\); this conversation: headless/)
  assert.match(auto, /\| interactive transport measured on \| Claude Code 2\.1\.288 \|/)

  const newer = formatDoctorReport({
    ...report,
    transport: "interactive",
    transportInUse: "interactive",
    claudeCli: { ...report.claudeCli, version: "2.1.300" },
    interactiveMeasured: { measured: "2.1.288", unmeasured: true },
    processes: [{ ...report.processes[0], transport: "interactive" }],
  })
  assert.match(newer, /this CLI, 2\.1\.300, is newer and unmeasured/)
  assert.match(newer, /\| ses_abc \| claude-opus-5 \| interactive \|/)
})
