/**
 * Usage before the limit, as opencode sees it (h #g244): a fake `claude`
 * replays a `rate_limit_event` and a served answer, and the assertions are on
 * the parts that come out of a real `doStream`, the store left behind and the
 * account the NEXT turn spawns on.
 *
 * The pure half (the store, crossings, dedup, the note's wording) is in
 * `test/account-usage.test.ts`.
 *
 * Usage: npx tsx --test test/account-usage-stream.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { after, test } from "node:test"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ensureAccountRuntime } from "../src/accounts.js"
import {
  USAGE_MARKER,
  _resetAccountLimitMemory,
  _resetAccountOverrides,
} from "../src/account-failover.js"
import { _setAccountUsageStorePathForTests, snapshotAccountUsage } from "../src/account-usage.js"
import { _resetRateLimitReports, _resetSystemInitReports } from "../src/cli-events.js"
import { createClaudeCode } from "../src/index.js"
import { setOpencodeClient } from "../src/runtime-status.js"
import { killAllActiveProcesses } from "../src/session-manager.js"

// Account runtimes are generated under HOME; keep them out of the operator's.
const HOME = mkdtempSync(join(tmpdir(), "opencode-usage-home-"))
const originalHome = process.env.HOME
const originalCache = process.env.XDG_CACHE_HOME
process.env.HOME = HOME
process.env.XDG_CACHE_HOME = join(HOME, "cache")

after(() => {
  killAllActiveProcesses()
  _setAccountUsageStorePathForTests(null)
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalCache === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = originalCache
  rmSync(HOME, { recursive: true, force: true })
})

const HOUR_S = 60 * 60

type Plan = Record<string, Record<string, unknown> | null>

/**
 * A fake `claude` that answers EVERY stdin message (a reused process's turns)
 * and, before each answer, emits the `rate_limit_info` the plan file holds for
 * the account it runs as, or no event at all for `null`. The plan is re-read
 * per turn, so a test can change what the CLI reports between turns.
 */
function createFakeCli() {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-usage-cli-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const planFile = join(cwd, "plan.json")
  const record = join(cwd, "spawns.jsonl")
  const source = `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.293\\n")
  process.exit(0)
}
const account = process.env.CLAUDE_CONFIG_DIR
  ? require("node:path").basename(process.env.CLAUDE_CONFIG_DIR).replace(/^\\.claude-/, "")
  : "default"
const rl = readline.createInterface({ input: process.stdin })
rl.on("line", (line) => {
  if (line.includes('"control_request"') || line.includes('"control_response"')) return
  fs.appendFileSync(
    ${JSON.stringify(record)},
    JSON.stringify({ pid: process.pid, account, argv: process.argv.slice(2) }) + "\\n",
  )
  const plan = JSON.parse(fs.readFileSync(${JSON.stringify(planFile)}, "utf8"))
  const info = plan[account] ?? null
  const session = account + "-session"
  const out = [{ type: "system", subtype: "init", session_id: session, tools: [] }]
  if (info) out.push({ type: "rate_limit_event", session_id: session, rate_limit_info: info })
  out.push(
    {
      type: "stream_event",
      session_id: session,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answered by " + account } },
    },
    { type: "stream_event", session_id: session, event: { type: "message_delta", delta: { stop_reason: "end_turn" } } },
    {
      type: "result",
      subtype: "success",
      session_id: session,
      is_error: false,
      result: "answered by " + account,
      duration_ms: 10,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  )
  for (const frame of out) process.stdout.write(JSON.stringify(frame) + "\\n")
})
`
  writeFileSync(cliPath, source)
  chmodSync(cliPath, 0o755)
  return {
    cliPath,
    cwd,
    plan(next: Plan) {
      writeFileSync(planFile, JSON.stringify(next))
    },
    /** One entry per process that answered a turn, in the order they started. */
    spawns(): Array<{ pid: number; account: string; argv: string[] }> {
      const turns = existsSync(record)
        ? readFileSync(record, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : []
      const seen = new Set<number>()
      return turns.filter((turn) => !seen.has(turn.pid) && seen.add(turn.pid))
    },
  }
}

function warning(utilization: number, rateLimitType = "five_hour") {
  return {
    status: "allowed_warning",
    rateLimitType,
    utilization,
    resetsAt: Math.floor(Date.now() / 1000) + 3 * HOUR_S,
  }
}

const MODEL_ID = "claude-test-usage@appical"

async function buildModel(
  fake: ReturnType<typeof createFakeCli>,
  extra: Record<string, unknown> = {},
) {
  const runtime = await ensureAccountRuntime("appical", fake.cliPath)
  return createClaudeCode({
    cliPath: runtime.cliPath,
    baseCliPath: fake.cliPath,
    configDir: runtime.configDir,
    account: "appical",
    failoverAccounts: ["default", "appical"],
    cwd: fake.cwd,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    ...extra,
  }).languageModel(MODEL_ID)
}

async function drain(response: any): Promise<any[]> {
  const parts: any[] = []
  for await (const part of response.stream) parts.push(part)
  return parts
}

function textOf(parts: any[]): string {
  return parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
}

function usageNotes(parts: any[]): string[] {
  return parts
    .filter((part) => part.type === "text-delta" && part.delta.trimStart().startsWith(USAGE_MARKER))
    .map((part) => part.delta)
}

function finishOf(parts: any[]): any {
  return parts.find((part) => part.type === "finish")
}

/** A request with no tools is a title request (h #g36), answered by a stub. */
const TOOLS = [
  {
    type: "function",
    name: "read",
    description: "Read a file",
    inputSchema: { type: "object", properties: {} },
  },
]

const first = [{ role: "user", content: [{ type: "text", text: "first" }] }]
const second = [
  ...first,
  { role: "assistant", content: [{ type: "text", text: "answered" }] },
  { role: "user", content: [{ type: "text", text: "second" }] },
]

async function withFake(run: (fake: ReturnType<typeof createFakeCli>) => Promise<void>) {
  _resetAccountOverrides()
  _resetAccountLimitMemory()
  _resetRateLimitReports()
  _resetSystemInitReports()
  setOpencodeClient({ tool: { list: async () => ({ data: [] }) } })
  const fake = createFakeCli()
  _setAccountUsageStorePathForTests(join(fake.cwd, "state", "account-usage.json"))
  try {
    await run(fake)
  } finally {
    killAllActiveProcesses()
    _resetAccountOverrides()
    _resetAccountLimitMemory()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
}

test("a warning at 76% writes the 50 and 75 crossings in one note, once, and a reused process's next turn says nothing", async () => {
  await withFake(async (fake) => {
    fake.plan({ appical: warning(0.76) })
    const model = await buildModel(fake)

    const one = await drain(await model.doStream({ prompt: first, tools: TOOLS } as any))
    const notes = usageNotes(one)
    assert.equal(notes.length, 1, textOf(one))
    assert.match(notes[0], /"appical" has used 76% of the 5-hour window, which resets at \d{4}-\d\d-\d\d \d\d:\d\d\./)
    // Its own text part, after Claude's answer, and the turn still finishes as served.
    const noteStart = one.findIndex((part) => part.type === "text-delta" && part.delta === notes[0])
    const answer = one.findIndex((part) => part.type === "text-delta" && part.delta.includes("answered by appical"))
    assert.ok(answer < noteStart)
    assert.notEqual(one[noteStart].id, one[answer].id)
    assert.equal(finishOf(one).finishReason.unified, "stop")
    // Two accounts, nothing at the switch threshold: no account named.
    assert.doesNotMatch(notes[0], /pick a model|move to/)

    const stored = snapshotAccountUsage().get("appical")?.get("five_hour")
    assert.equal(stored?.utilization, 0.76)
    assert.equal(stored?.status, "allowed_warning")
    assert.deepEqual(stored?.noted, [50, 75])

    // The CLI reports when its view CHANGES, so the reused child's next turn
    // carries no event; the reading stands and nothing is repeated.
    fake.plan({ appical: null })
    const two = await drain(await model.doStream({ prompt: second, tools: TOOLS } as any))
    assert.deepEqual(usageNotes(two), [])
    assert.match(textOf(two), /answered by appical/)
    assert.equal(fake.spawns().length, 1, "the second turn reused the process")
  })
})

test("an allowed event with no utilization is recorded as unknown and says nothing", async () => {
  await withFake(async (fake) => {
    // Measured 2026-10-17 on the appical account: headroom, utilization null.
    fake.plan({
      appical: {
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: null,
        resetsAt: Math.floor(Date.now() / 1000) + HOUR_S,
        overageStatus: "rejected",
      },
    })
    const model = await buildModel(fake)
    const parts = await drain(await model.doStream({ prompt: first, tools: TOOLS } as any))
    assert.deepEqual(usageNotes(parts), [])
    const stored = snapshotAccountUsage().get("appical")?.get("five_hour")
    assert.equal(stored?.utilization, null)
    assert.equal(stored?.status, "allowed")
  })
})

test("the same event's unifiedWindows gives every window a number, so the sidebar can say what is left", async () => {
  await withFake(async (fake) => {
    // The shape 2.1.293's schema documents (h #g266): headroom at the top
    // level, every window's own reading under `unifiedWindows`.
    const fiveHourReset = Math.floor(Date.now() / 1000) + 2 * HOUR_S
    const weekReset = Math.floor(Date.now() / 1000) + 72 * HOUR_S
    fake.plan({
      appical: {
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: null,
        resetsAt: fiveHourReset,
        unifiedWindows: {
          five_hour: { utilization: 0.31, resetsAt: fiveHourReset },
          seven_day: { utilization: 0.12, resetsAt: weekReset },
        },
      },
    })
    const model = await buildModel(fake)
    const parts = await drain(await model.doStream({ prompt: first, tools: TOOLS } as any))
    const windows = snapshotAccountUsage().get("appical")
    assert.equal(windows?.get("five_hour")?.utilization, 0.31)
    assert.equal(windows?.get("five_hour")?.status, "allowed")
    assert.equal(windows?.get("five_hour")?.resetsAt, fiveHourReset * 1000)
    assert.equal(windows?.get("seven_day")?.utilization, 0.12)
    assert.equal(windows?.get("seven_day")?.status, "allowed")
    assert.equal(windows?.get("seven_day")?.resetsAt, weekReset * 1000)
    // Under every threshold, so nothing is said.
    assert.deepEqual(usageNotes(parts), [])
  })
})

test("at 91% with accountFailover auto, new turns move to the other account and the note says so", async () => {
  await withFake(async (fake) => {
    fake.plan({ appical: warning(0.91), default: null })
    const model = await buildModel(fake, { accountFailover: "auto" })

    const one = await drain(await model.doStream({ prompt: first, tools: TOOLS } as any))
    const notes = usageNotes(one)
    assert.equal(notes.length, 1, textOf(one))
    assert.match(notes[0], /91% of the 5-hour window/)
    assert.match(notes[0], /New turns move to the "default" account until \d{4}-\d\d-\d\d \d\d:\d\d\./)
    // The turn that crossed was served and finishes as served, on its own account.
    assert.equal(finishOf(one).finishReason.unified, "stop")
    assert.match(textOf(one), /answered by appical/)
    assert.deepEqual(snapshotAccountUsage().get("appical")?.get("five_hour")?.noted, [50, 75, 90])

    const two = await drain(await model.doStream({ prompt: second, tools: TOOLS } as any))
    assert.match(textOf(two), /answered by default/)
    assert.deepEqual(usageNotes(two), [])
    const spawns = fake.spawns()
    assert.deepEqual(spawns.map((spawn) => spawn.account), ["appical", "default"])
    const modelArg = spawns[1].argv[spawns[1].argv.indexOf("--model") + 1]
    assert.doesNotMatch(modelArg, /@/, "the account marker comes off the model id")
  })
})

test("at 91% with accountFailover off, the note names the other account and nothing moves", async () => {
  await withFake(async (fake) => {
    fake.plan({ appical: warning(0.91), default: null })
    const model = await buildModel(fake, { accountFailover: "off" })

    const one = await drain(await model.doStream({ prompt: first, tools: TOOLS } as any))
    const notes = usageNotes(one)
    assert.equal(notes.length, 1)
    assert.match(notes[0], /To keep working past the limit, pick a model from the "default" account\./)
    assert.doesNotMatch(notes[0], /New turns move/)
    // Never the form after a served turn.
    assert.equal(one.some((part) => part.type === "tool-call"), false)

    fake.plan({ appical: null, default: null })
    const two = await drain(await model.doStream({ prompt: second, tools: TOOLS } as any))
    assert.match(textOf(two), /answered by appical/)
    assert.deepEqual(fake.spawns().map((spawn) => spawn.account), ["appical"])
  })
})

test("at 91% with accountFailover ask, the note names the other account and no form is raised", async () => {
  await withFake(async (fake) => {
    setOpencodeClient({
      tool: { list: async () => ({ data: [{ id: "question", description: "", parameters: {} }] }) },
    })
    fake.plan({ appical: warning(0.91) })
    const model = await buildModel(fake, { accountFailover: "ask" })
    const one = await drain(await model.doStream({ prompt: first, tools: TOOLS } as any))
    assert.match(usageNotes(one)[0] ?? "", /pick a model from the "default" account/)
    assert.equal(one.some((part) => part.type === "tool-call"), false)
    assert.equal(finishOf(one).finishReason.unified, "stop")
  })
})

test("a compaction turn writes no note and leaves the crossing for the next turn that can say it", async () => {
  await withFake(async (fake) => {
    fake.plan({ appical: warning(0.76) })
    const model = await buildModel(fake)
    const compaction = await drain(
      await model.doStream({
        prompt: first,
        tools: TOOLS,
        providerOptions: { "claude-code": { opencodeAgent: "compaction" } },
      } as any),
    )
    assert.deepEqual(usageNotes(compaction), [])
    // The reading is a fact about the account and is kept.
    const stored = snapshotAccountUsage().get("appical")?.get("five_hour")
    assert.equal(stored?.utilization, 0.76)
    assert.deepEqual(stored?.noted, [])

    fake.plan({ appical: null })
    const next = await drain(await model.doStream({ prompt: first, tools: TOOLS } as any))
    assert.equal(usageNotes(next).length, 1)
  })
})

test("a child session writes no note", async () => {
  await withFake(async (fake) => {
    setOpencodeClient({
      tool: { list: async () => ({ data: [] }) },
      session: {
        get: async ({ path }: { path: { id: string } }) => ({
          data: { id: path.id, parentID: "ses_parent", directory: fake.cwd },
        }),
      },
    })
    fake.plan({ appical: warning(0.76) })
    const model = await buildModel(fake)
    const parts = await drain(
      await model.doStream({
        prompt: first,
        tools: TOOLS,
        headers: { "x-session-affinity": "ses_child_usage" },
      } as any),
    )
    assert.match(textOf(parts), /answered by appical/)
    assert.deepEqual(usageNotes(parts), [])
    assert.deepEqual(snapshotAccountUsage().get("appical")?.get("five_hour")?.noted, [])
  })
})

test("usageWarnThresholds [] and usageSwitchAt false turn the notes and the switch off", async () => {
  await withFake(async (fake) => {
    fake.plan({ appical: warning(0.96), default: null })
    const model = await buildModel(fake, {
      accountFailover: "auto",
      usageWarnThresholds: [],
      usageSwitchAt: false,
    })
    const one = await drain(await model.doStream({ prompt: first, tools: TOOLS } as any))
    assert.deepEqual(usageNotes(one), [])
    // The reading is still recorded, for the sidebar and the doctor.
    assert.equal(snapshotAccountUsage().get("appical")?.get("five_hour")?.utilization, 0.96)
    const two = await drain(await model.doStream({ prompt: second, tools: TOOLS } as any))
    assert.match(textOf(two), /answered by appical/)
  })
})
