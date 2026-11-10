/**
 * A login about to end, as opencode sees it (h #g301): a fake `claude` puts
 * `credential_expires_at` on its `result` the way 2.1.318+ does, and the
 * assertions are on the parts that come out of a real `doStream` and on the
 * store left behind.
 *
 * The pure half (the parser, the store, the dedup, the note's wording) is in
 * `test/login-expiry.test.ts`.
 *
 * Usage: npx tsx --test test/login-expiry-stream.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ensureAccountRuntime } from "../src/accounts.js"
import {
  LOGIN_MARKER,
  USAGE_MARKER,
  _resetAccountLimitMemory,
  _resetAccountOverrides,
} from "../src/account-failover.js"
import { _setAccountUsageStorePathForTests, snapshotLoginExpiries } from "../src/account-usage.js"
import { _resetRateLimitReports, _resetSystemInitReports } from "../src/cli-events.js"
import { createClaudeCode } from "../src/index.js"
import { setOpencodeClient } from "../src/runtime-status.js"
import { killAllActiveProcesses } from "../src/session-manager.js"

// Account runtimes are generated under HOME; keep them out of the operator's.
const HOME = mkdtempSync(join(tmpdir(), "opencode-login-home-"))
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

const DAY_MS = 24 * 60 * 60 * 1000

interface AccountPlan {
  /** What the result's `credential_expires_at` says, or absent for none. */
  expires?: string
  /** A `rate_limit_info` to emit before the answer. */
  rateLimit?: Record<string, unknown>
  /** End the turn on a failed result. */
  fail?: boolean
}

/**
 * A fake `claude` that answers EVERY stdin message (a reused process's turns)
 * and puts the plan's `credential_expires_at` on each result, re-reading the
 * plan per turn so a test can change it between turns.
 */
function createFakeCli() {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-login-cli-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const planFile = join(cwd, "plan.json")
  const record = join(cwd, "spawns.jsonl")
  const source = `#!${process.execPath}
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.322\\n")
  process.exit(0)
}
const account = process.env.CLAUDE_CONFIG_DIR
  ? require("node:path").basename(process.env.CLAUDE_CONFIG_DIR).replace(/^\\.claude-/, "")
  : "default"
const rl = readline.createInterface({ input: process.stdin })
rl.on("line", (line) => {
  if (line.includes('"control_request"') || line.includes('"control_response"')) return
  fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, account }) + "\\n")
  const plan = JSON.parse(fs.readFileSync(${JSON.stringify(planFile)}, "utf8"))[account] ?? {}
  const session = account + "-session"
  const out = [{ type: "system", subtype: "init", session_id: session, tools: [] }]
  if (plan.rateLimit) out.push({ type: "rate_limit_event", session_id: session, rate_limit_info: plan.rateLimit })
  out.push(
    {
      type: "stream_event",
      session_id: session,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answered by " + account } },
    },
    { type: "stream_event", session_id: session, event: { type: "message_delta", delta: { stop_reason: "end_turn" } } },
  )
  const result = {
    type: "result",
    subtype: "success",
    session_id: session,
    is_error: plan.fail === true,
    result: plan.fail ? "API Error: 500" : "answered by " + account,
    duration_ms: 10,
    num_turns: 1,
    result_index: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
  }
  if (plan.expires) result.credential_expires_at = plan.expires
  out.push(result)
  for (const frame of out) process.stdout.write(JSON.stringify(frame) + "\\n")
})
`
  writeFileSync(cliPath, source)
  chmodSync(cliPath, 0o755)
  return {
    cliPath,
    cwd,
    plan(next: Record<string, AccountPlan>) {
      writeFileSync(planFile, JSON.stringify(next))
    },
    spawns(): number {
      if (!existsSync(record)) return 0
      return new Set(
        readFileSync(record, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line).pid),
      ).size
    },
  }
}

const MODEL_ID = "claude-test-login@appical"

async function buildModel(fake: ReturnType<typeof createFakeCli>, extra: Record<string, unknown> = {}) {
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

const textOf = (parts: any[]) =>
  parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")

const notesLed = (parts: any[], marker: string) =>
  parts.filter((part) => part.type === "text-delta" && part.delta.trimStart().startsWith(marker))

const finishOf = (parts: any[]) => parts.find((part) => part.type === "finish")

/** A request with no tools is a title request (h #g36), answered by a stub. */
const TOOLS = [
  { type: "function", name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } },
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

const isoIn = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString()

test("a login ending in 9 days writes one note naming the account and its login command, once", async () => {
  await withFake(async (fake) => {
    const expires = isoIn(9)
    fake.plan({ appical: { expires } })
    const model = await buildModel(fake)

    const one = await drain(await model.doStream({ prompt: first, tools: TOOLS } as any))
    const notes = notesLed(one, LOGIN_MARKER)
    assert.equal(notes.length, 1, textOf(one))
    assert.match(
      notes[0].delta,
      /the Claude account "appical" stays signed in until about \d{4}-\d\d-\d\d \d\d:\d\d, in (8|9) days, and the login can end up to 3 days sooner\./,
    )
    assert.match(notes[0].delta, /Log in again with `CLAUDE_CONFIG_DIR=~\/\.claude-appical claude auth login` before then/)
    // Its own text part, after Claude's answer, and the turn still finishes as served.
    const answer = one.find((part) => part.type === "text-delta" && part.delta.includes("answered by appical"))
    assert.ok(one.indexOf(answer) < one.indexOf(notes[0]))
    assert.notEqual(answer.id, notes[0].id)
    assert.equal(finishOf(one).finishReason.unified, "stop")

    const stored = snapshotLoginExpiries().get("appical")
    assert.equal(stored?.expiresAt, Date.parse(expires))
    assert.equal(stored?.notedFor, Date.parse(expires))
    assert.equal(stored?.warnDays, 10)

    // The reused process's next turn reports the same date and says nothing.
    const two = await drain(await model.doStream({ prompt: second, tools: TOOLS } as any))
    assert.deepEqual(notesLed(two, LOGIN_MARKER), [])
    assert.match(textOf(two), /answered by appical/)
    assert.equal(fake.spawns(), 1, "the second turn reused the process")
  })
})

test("a login 20 days out is recorded and says nothing", async () => {
  await withFake(async (fake) => {
    fake.plan({ appical: { expires: isoIn(20) } })
    const model = await buildModel(fake)
    const parts = await drain(await model.doStream({ prompt: first, tools: TOOLS } as any))
    assert.deepEqual(notesLed(parts, LOGIN_MARKER), [])
    assert.ok(snapshotLoginExpiries().get("appical"))
  })
})

test("a result without the field (an API key, a CLI before 2.1.318) changes nothing", async () => {
  await withFake(async (fake) => {
    fake.plan({ appical: {} })
    const model = await buildModel(fake)
    const parts = await drain(await model.doStream({ prompt: first, tools: TOOLS } as any))
    assert.deepEqual(notesLed(parts, LOGIN_MARKER), [])
    assert.equal(snapshotLoginExpiries().size, 0)
  })
})

test("a compaction turn records the date, writes no note, and leaves it for the next turn", async () => {
  await withFake(async (fake) => {
    fake.plan({ appical: { expires: isoIn(5) } })
    const model = await buildModel(fake)
    const compaction = await drain(
      await model.doStream({
        prompt: first,
        tools: TOOLS,
        providerOptions: { "claude-code": { opencodeAgent: "compaction" } },
      } as any),
    )
    assert.deepEqual(notesLed(compaction, LOGIN_MARKER), [])
    // The date is a fact about the account and is kept; the note is not said.
    const stored = snapshotLoginExpiries().get("appical")
    assert.ok(stored, "the compaction turn's result recorded the date")
    assert.equal(stored.notedFor, undefined)

    const next = await drain(await model.doStream({ prompt: first, tools: TOOLS } as any))
    assert.equal(notesLed(next, LOGIN_MARKER).length, 1)
  })
})

test("doGenerate and a child session write no note", async () => {
  await withFake(async (fake) => {
    fake.plan({ appical: { expires: isoIn(5) } })
    const model = await buildModel(fake)
    const generated = await model.doGenerate({ prompt: first, tools: TOOLS } as any)
    const text = generated.content
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text)
      .join("")
    assert.doesNotMatch(text, /login:/)

    setOpencodeClient({
      tool: { list: async () => ({ data: [] }) },
      session: {
        get: async ({ path }: { path: { id: string } }) => ({
          data: { id: path.id, parentID: "ses_parent", directory: fake.cwd },
        }),
      },
    })
    const child = await drain(
      await model.doStream({
        prompt: first,
        tools: TOOLS,
        headers: { "x-session-affinity": "ses_child_login" },
      } as any),
    )
    assert.match(textOf(child), /answered by appical/)
    assert.deepEqual(notesLed(child, LOGIN_MARKER), [])
    assert.equal(snapshotLoginExpiries().get("appical")?.notedFor, undefined)
  })
})

test("a failed turn writes no note, and loginExpiryWarnDays false turns it off", async () => {
  await withFake(async (fake) => {
    fake.plan({ appical: { expires: isoIn(5), fail: true } })
    const model = await buildModel(fake)
    const failed = await drain(await model.doStream({ prompt: first, tools: TOOLS } as any))
    assert.deepEqual(notesLed(failed, LOGIN_MARKER), [])
  })
  await withFake(async (fake) => {
    fake.plan({ appical: { expires: isoIn(5) } })
    const model = await buildModel(fake, { loginExpiryWarnDays: false })
    const parts = await drain(await model.doStream({ prompt: first, tools: TOOLS } as any))
    assert.deepEqual(notesLed(parts, LOGIN_MARKER), [])
    // Recorded with its window off, so the sidebar shows no line either.
    assert.equal(snapshotLoginExpiries().get("appical")?.warnDays, 0)
  })
})

test("a usage crossing and a login on one turn are two notes in two parts", async () => {
  await withFake(async (fake) => {
    fake.plan({
      appical: {
        expires: isoIn(2),
        rateLimit: {
          status: "allowed_warning",
          rateLimitType: "five_hour",
          utilization: 0.76,
          resetsAt: Math.floor(Date.now() / 1000) + 3 * 60 * 60,
        },
      },
    })
    const model = await buildModel(fake)
    const parts = await drain(await model.doStream({ prompt: first, tools: TOOLS } as any))
    const usage = notesLed(parts, USAGE_MARKER)
    const login = notesLed(parts, LOGIN_MARKER)
    assert.equal(usage.length, 1)
    assert.equal(login.length, 1)
    assert.notEqual(usage[0].id, login[0].id)
    assert.match(login[0].delta, /can be signed out any day now/)
  })
})
