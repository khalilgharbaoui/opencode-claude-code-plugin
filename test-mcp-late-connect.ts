/**
 * An MCP server that connects after a `claude` process was spawned.
 *
 * Two halves, matching the two things that go wrong:
 *
 *  1. The first spawn. opencode 2 answers its MCP status call immediately and
 *     reports a server it is still connecting to as `pending`; the overlay
 *     used to read that as "not connected" and drop it. `MCP_PENDING_STATUS`
 *     and `getRuntimeMcpStatus`'s bounded wait are the fix, and the pure
 *     tests here pin both. opencode 1 cannot reach this state at all: its
 *     five `McpStatus` variants are all decisions and `GET /mcp` blocks.
 *
 *  2. A later turn. A reused process keeps the `--mcp-config` it was spawned
 *     with, so a server that joined afterwards needs the conversation moved
 *     onto a new process. `decideMcpHotReload` owns when that is allowed, and
 *     the fake-CLI tests at the bottom drive a real `doStream` twice over one
 *     session key and assert on the argv each spawn actually received.
 *
 * Usage: npx tsx --test test-mcp-late-connect.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { MCP_PENDING_STATUS, mergeOpencodeMcp } from "./src/mcp-bridge.js"
import {
  DEFAULT_MCP_CONNECT_WAIT_MS,
  getRuntimeMcpStatus,
  pendingMcpServers,
  resolveMcpConnectWaitMs,
  setOpencodeClient,
} from "./src/runtime-status.js"
import {
  DEFAULT_MCP_HOT_RELOAD_COOLDOWN_MS,
  _resetMcpHotReloadState,
  decideMcpHotReload,
  noteMcpHotReload,
  resolveMcpHotReloadCooldownMs,
} from "./src/mcp-hot-reload.js"
import { createClaudeCode } from "./src/index.js"
import { deleteActiveProcess, getActiveProcess, sessionKey } from "./src/session-manager.js"

// ---------------------------------------------------------------------------
// The overlay: `pending` is not a refusal
// ---------------------------------------------------------------------------

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeJson(p: string, obj: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(obj, null, 2))
}

async function withIsolatedEnv<T>(fn: (xdgRoot: string) => Promise<T> | T): Promise<T> {
  const xdgRoot = mkTmp("oc-mcp-late-xdg-")
  const original: Record<string, string | undefined> = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    OPENCODE_WORKTREE: process.env.OPENCODE_WORKTREE,
    HOME: process.env.HOME,
  }
  process.env.XDG_CONFIG_HOME = xdgRoot
  delete process.env.OPENCODE_CONFIG
  delete process.env.OPENCODE_CONFIG_DIR
  delete process.env.OPENCODE_WORKTREE
  process.env.HOME = xdgRoot
  try {
    return await fn(xdgRoot)
  } finally {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fs.rmSync(xdgRoot, { recursive: true, force: true })
  }
}

const serverSpec = { type: "local", command: ["fixture", "--stdio"] }

test("a pending server keeps its disk value; the other statuses are unchanged", async () => {
  await withIsolatedEnv((root) => {
    writeJson(path.join(root, "opencode/opencode.json"), {
      mcp: {
        joining: serverSpec,
        live: serverSpec,
        broken: serverSpec,
        off: serverSpec,
      },
    })
    const merged = mergeOpencodeMcp(root, {
      joining: MCP_PENDING_STATUS,
      live: "connected",
      broken: "failed",
      off: "disabled",
    })
    assert.deepEqual(merged.enabledServerNames.sort(), ["joining", "live"])
  })
})

test("a pending server that disk config disables stays disabled", async () => {
  await withIsolatedEnv((root) => {
    writeJson(path.join(root, "opencode/opencode.json"), {
      mcp: { joining: { ...serverSpec, enabled: false } },
    })
    const merged = mergeOpencodeMcp(root, { joining: MCP_PENDING_STATUS })
    assert.deepEqual(merged.enabledServerNames, [])
  })
})

test("the hash moves when a pending server resolves, which is what arms the hot reload", async () => {
  await withIsolatedEnv((root) => {
    writeJson(path.join(root, "opencode/opencode.json"), { mcp: { joining: serverSpec } })
    const pending = mergeOpencodeMcp(root, { joining: MCP_PENDING_STATUS })
    const connected = mergeOpencodeMcp(root, { joining: "connected" })
    const failed = mergeOpencodeMcp(root, { joining: "failed" })
    // `pending` leaves the disk entry untouched, `connected` writes an
    // explicit `enabled: true`, so even those two differ. A hash that moved
    // is the signal; it is never asked to mean more than "re-plan the spawn".
    assert.notEqual(pending.hash, connected.hash)
    assert.notEqual(pending.hash, failed.hash)
    assert.deepEqual(failed.enabledServerNames, [])
  })
})

// ---------------------------------------------------------------------------
// The bounded wait
// ---------------------------------------------------------------------------

test("resolveMcpConnectWaitMs: 0 disables, garbage falls back to the default", () => {
  assert.equal(resolveMcpConnectWaitMs(undefined), DEFAULT_MCP_CONNECT_WAIT_MS)
  assert.equal(resolveMcpConnectWaitMs(0), 0)
  assert.equal(resolveMcpConnectWaitMs(250), 250)
  assert.equal(resolveMcpConnectWaitMs(-1), DEFAULT_MCP_CONNECT_WAIT_MS)
  assert.equal(resolveMcpConnectWaitMs(Number.NaN), DEFAULT_MCP_CONNECT_WAIT_MS)
  assert.equal(resolveMcpConnectWaitMs("500"), DEFAULT_MCP_CONNECT_WAIT_MS)
})

test("pendingMcpServers names only the undecided ones", () => {
  assert.deepEqual(
    pendingMcpServers({ a: MCP_PENDING_STATUS, b: "connected", c: "failed" }),
    ["a"],
  )
})

/** A captured SDK client whose `mcp.status()` walks a fixed script of replies. */
function scriptedClient(script: Array<Record<string, string>>) {
  let calls = 0
  return {
    calls: () => calls,
    client: {
      mcp: {
        status: async () => {
          const data = script[Math.min(calls, script.length - 1)]
          calls += 1
          return { data: Object.fromEntries(
            Object.entries(data).map(([name, status]) => [name, { status }]),
          ) }
        },
      },
    },
  }
}

async function withClient<T>(client: unknown, fn: () => Promise<T>): Promise<T> {
  setOpencodeClient(client)
  try {
    return await fn()
  } finally {
    // `setOpencodeClient` ignores non-objects, so an empty object is how a
    // test hands the next one a client that answers nothing.
    setOpencodeClient({})
  }
}

test("the wait returns as soon as nothing is pending", async () => {
  const scripted = scriptedClient([
    { slow: MCP_PENDING_STATUS },
    { slow: MCP_PENDING_STATUS },
    { slow: "connected" },
  ])
  const status = await withClient(scripted.client, () =>
    getRuntimeMcpStatus({ waitForPendingMs: 5000 }),
  )
  assert.deepEqual(status, { slow: "connected" })
  assert.equal(scripted.calls(), 3)
})

test("the wait is bounded, and what it saw last is what plans the spawn", async () => {
  const scripted = scriptedClient([{ slow: MCP_PENDING_STATUS }])
  const started = Date.now()
  const status = await withClient(scripted.client, () =>
    getRuntimeMcpStatus({ waitForPendingMs: 250 }),
  )
  const elapsed = Date.now() - started
  assert.deepEqual(status, { slow: MCP_PENDING_STATUS })
  assert.ok(elapsed >= 250, `expected the budget to elapse, waited ${elapsed}ms`)
  assert.ok(elapsed < 5000, `expected a bounded wait, waited ${elapsed}ms`)
})

test("a zero budget takes exactly one status call", async () => {
  const scripted = scriptedClient([{ slow: MCP_PENDING_STATUS }])
  const status = await withClient(scripted.client, () =>
    getRuntimeMcpStatus({ waitForPendingMs: 0 }),
  )
  assert.deepEqual(status, { slow: MCP_PENDING_STATUS })
  assert.equal(scripted.calls(), 1)
})

test("nothing pending costs one status call even with a budget", async () => {
  const scripted = scriptedClient([{ live: "connected" }])
  const status = await withClient(scripted.client, () =>
    getRuntimeMcpStatus({ waitForPendingMs: 5000 }),
  )
  assert.deepEqual(status, { live: "connected" })
  assert.equal(scripted.calls(), 1)
})

test("no captured client means no overlay, waiting or not", async () => {
  const status = await withClient({}, () =>
    getRuntimeMcpStatus({ waitForPendingMs: 5000 }),
  )
  assert.equal(status, undefined)
})

// ---------------------------------------------------------------------------
// The hot-reload decision
// ---------------------------------------------------------------------------

function decision(overrides: Record<string, unknown> = {}) {
  _resetMcpHotReloadState()
  return decideMcpHotReload({
    sessionKey: "sk-test",
    enabled: true,
    hasActiveProcess: true,
    compactionMode: false,
    interactive: false,
    turnInFlight: false,
    pendingProxyCalls: 0,
    planQuestionPending: false,
    previousHash: "old",
    currentHash: "new",
    previousServers: ["kept"],
    currentServers: ["kept", "joined"],
    ...(overrides as any),
  })
}

test("a changed server set at a clean boundary reloads, and names what moved", () => {
  const result = decision({
    previousServers: ["kept", "gone"],
    currentServers: ["kept", "joined"],
  })
  assert.equal(result.verdict, "reload")
  assert.equal(result.reload, true)
  assert.deepEqual(result.joined, ["joined"])
  assert.deepEqual(result.left, ["gone"])
})

test("an unchanged hash never reloads, whatever else is true of the turn", () => {
  for (const extra of [
    {},
    { pendingProxyCalls: 3 },
    { turnInFlight: true },
    { interactive: true },
  ]) {
    const result = decision({ previousHash: "same", currentHash: "same", ...extra })
    assert.equal(result.verdict, "unchanged")
    assert.equal(result.reload, false)
  }
})

test("both sides of a null hash compare equal, so a bridge that found nothing is quiet", () => {
  const result = decision({ previousHash: undefined, currentHash: null, currentServers: [] })
  assert.equal(result.verdict, "unchanged")
})

test("every unsafe boundary holds the reload off, in its own words", () => {
  assert.equal(decision({ enabled: false }).verdict, "off")
  assert.equal(decision({ compactionMode: true }).verdict, "skipped-compaction")
  assert.equal(decision({ hasActiveProcess: false }).verdict, "no-process")
  assert.equal(decision({ interactive: true }).verdict, "skipped-interactive")
  assert.equal(decision({ pendingProxyCalls: 1 }).verdict, "deferred-proxy-calls")
  assert.equal(decision({ turnInFlight: true }).verdict, "deferred-turn-in-flight")
  assert.equal(decision({ planQuestionPending: true }).verdict, "deferred-plan-question")
  for (const held of [
    "off",
    "skipped-compaction",
    "no-process",
    "skipped-interactive",
    "deferred-proxy-calls",
    "deferred-turn-in-flight",
    "deferred-plan-question",
  ]) {
    assert.equal(
      decideMcpHotReload({
        sessionKey: "sk-test",
        enabled: held !== "off",
        hasActiveProcess: held !== "no-process",
        compactionMode: held === "skipped-compaction",
        interactive: held === "skipped-interactive",
        turnInFlight: held === "deferred-turn-in-flight",
        pendingProxyCalls: held === "deferred-proxy-calls" ? 1 : 0,
        planQuestionPending: held === "deferred-plan-question",
        previousHash: "old",
        currentHash: "new",
        previousServers: [],
        currentServers: ["joined"],
      }).reload,
      false,
      `${held} must not reload`,
    )
  }
})

test("a flapping server does not buy a respawn on every turn", () => {
  _resetMcpHotReloadState()
  const input = {
    sessionKey: "sk-flap",
    enabled: true,
    hasActiveProcess: true,
    compactionMode: false,
    interactive: false,
    turnInFlight: false,
    pendingProxyCalls: 0,
    planQuestionPending: false,
    previousServers: [] as string[],
    currentServers: ["flaky"],
    cooldownMs: 60_000,
  }
  assert.equal(
    decideMcpHotReload({ ...input, previousHash: "a", currentHash: "b", now: 1_000 }).verdict,
    "reload",
  )
  noteMcpHotReload("sk-flap", 1_000)
  // Same conversation, changed again a second later: held.
  assert.equal(
    decideMcpHotReload({ ...input, previousHash: "b", currentHash: "a", now: 2_000 }).verdict,
    "skipped-cooldown",
  )
  // Another conversation is unaffected; the ledger is per session key.
  assert.equal(
    decideMcpHotReload({
      ...input,
      sessionKey: "sk-other",
      previousHash: "b",
      currentHash: "a",
      now: 2_000,
    }).verdict,
    "reload",
  )
  // Past the gap, a change that is still there lands.
  assert.equal(
    decideMcpHotReload({ ...input, previousHash: "b", currentHash: "a", now: 62_000 }).verdict,
    "reload",
  )
})

test("a zero cooldown turns the flap guard off", () => {
  _resetMcpHotReloadState()
  noteMcpHotReload("sk-nocooldown", 1_000)
  assert.equal(
    decideMcpHotReload({
      sessionKey: "sk-nocooldown",
      enabled: true,
      hasActiveProcess: true,
      compactionMode: false,
      interactive: false,
      turnInFlight: false,
      pendingProxyCalls: 0,
      planQuestionPending: false,
      previousHash: "a",
      currentHash: "b",
      previousServers: [],
      currentServers: ["x"],
      now: 1_100,
      cooldownMs: 0,
    }).verdict,
    "reload",
  )
})

test("resolveMcpHotReloadCooldownMs: env override, and garbage falls back", () => {
  const original = process.env.CLAUDE_CODE_MCP_HOT_RELOAD_COOLDOWN_MS
  try {
    delete process.env.CLAUDE_CODE_MCP_HOT_RELOAD_COOLDOWN_MS
    assert.equal(resolveMcpHotReloadCooldownMs(), DEFAULT_MCP_HOT_RELOAD_COOLDOWN_MS)
    process.env.CLAUDE_CODE_MCP_HOT_RELOAD_COOLDOWN_MS = "0"
    assert.equal(resolveMcpHotReloadCooldownMs(), 0)
    process.env.CLAUDE_CODE_MCP_HOT_RELOAD_COOLDOWN_MS = "1500"
    assert.equal(resolveMcpHotReloadCooldownMs(), 1500)
    process.env.CLAUDE_CODE_MCP_HOT_RELOAD_COOLDOWN_MS = "soon"
    assert.equal(resolveMcpHotReloadCooldownMs(), DEFAULT_MCP_HOT_RELOAD_COOLDOWN_MS)
  } finally {
    if (original === undefined) delete process.env.CLAUDE_CODE_MCP_HOT_RELOAD_COOLDOWN_MS
    else process.env.CLAUDE_CODE_MCP_HOT_RELOAD_COOLDOWN_MS = original
  }
})

// ---------------------------------------------------------------------------
// Two real turns through a fake CLI
// ---------------------------------------------------------------------------

/**
 * A fake `claude` that appends the argv of every spawn to a shared file and
 * then answers the turn. The argv file is the whole oracle here: it is what
 * tells a reused process from a replacement, and which `--mcp-config` paths
 * each one was handed.
 */
function createArgvRecordingCli(root: string) {
  const cliPath = path.join(root, "fake-claude.cjs")
  const argvLog = path.join(root, "argv.ndjson")
  fs.writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.280\\n")
  process.exit(0)
}
const args = process.argv.slice(2)
// Capability probes (\`--help\` for an optional flag) are not turn spawns and
// must not land in the argv log, or every assertion here counts them too.
if (!args.includes("--print")) {
  process.stdout.write("\\n")
  process.exit(0)
}
const configs = []
for (let i = args.indexOf("--mcp-config") + 1; i > 0 && i < args.length; i++) {
  if (args[i].startsWith("--")) break
  configs.push(args[i])
}
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify({
  args,
  resume: args.includes("--resume"),
  servers: configs.flatMap((p) => {
    try { return Object.keys(JSON.parse(fs.readFileSync(p, "utf8")).mcpServers || {}) }
    catch { return [] }
  }),
}) + "\\n")
let turn = 0
readline.createInterface({ input: process.stdin }).on("line", () => {
  turn += 1
  const sid = "fake-session-" + process.pid
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sid, tools: [] }) + "\\n")
  process.stdout.write(JSON.stringify({
    type: "assistant",
    session_id: sid,
    message: { content: [{ type: "text", text: "ok " + turn }], usage: { input_tokens: 1, output_tokens: 1 } },
  }) + "\\n")
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", session_id: sid, is_error: false,
    usage: { input_tokens: 1, output_tokens: 1 },
  }) + "\\n")
})
`,
  )
  fs.chmodSync(cliPath, 0o755)
  return {
    cliPath,
    spawns: () =>
      fs.existsSync(argvLog)
        ? fs
            .readFileSync(argvLog, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { args: string[]; resume: boolean; servers: string[] })
        : [],
  }
}

/**
 * Drive `doStream` once with `status` as opencode's MCP runtime answer. The
 * same model id and cwd every time, so every turn lands on one session key
 * and the second one reuses the first one's process unless something moved it.
 */
async function runTurn(input: {
  cwd: string
  cliPath: string
  status: Record<string, string>
  modelId: string
  settings?: Record<string, unknown>
  /**
   * Whether this turn carries earlier messages. A prompt holding a single
   * user message is a NEW conversation to `doStream`, which drops the cached
   * process and its Claude session id before any of this is reached, so a
   * second turn that forgot its history would test nothing at all.
   */
  prior?: boolean
}): Promise<void> {
  const client = {
    mcp: {
      status: async () => ({
        data: Object.fromEntries(
          Object.entries(input.status).map(([name, status]) => [name, { status }]),
        ),
      }),
    },
  }
  setOpencodeClient(client)
  const model = createClaudeCode({
    cliPath: input.cliPath,
    cwd: input.cwd,
    proxyTools: [],
    proxyOpencodeMcpTools: false,
    // The wait is exercised by its own tests above; these turns are about the
    // reuse boundary and must not spend a budget on a scripted status.
    mcpConnectWaitMs: 0,
    ...input.settings,
  }).languageModel(input.modelId)
  const prompt = input.prior
    ? [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "text", text: "ok 1" }] },
        { role: "user", content: [{ type: "text", text: "go again" }] },
      ]
    : [{ role: "user", content: [{ type: "text", text: "go" }] }]
  const response = await model.doStream({
    prompt,
    tools: [
      {
        type: "function",
        name: "read",
        description: "Read a file",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  } as any)
  for await (const _part of response.stream) {
    void _part
  }
}

async function withTwoTurnFixture(
  fn: (ctx: {
    cwd: string
    cliPath: string
    modelId: string
    sk: string
    spawns: () => Array<{ args: string[]; resume: boolean; servers: string[] }>
  }) => Promise<void>,
): Promise<void> {
  _resetMcpHotReloadState()
  await withIsolatedEnv(async (root) => {
    const cwd = mkTmp("oc-mcp-late-cwd-")
    // The server lives in the isolated global config, so nothing on the
    // machine running this can add or remove one.
    writeJson(path.join(root, "opencode/opencode.json"), { mcp: { joining: serverSpec } })
    const fake = createArgvRecordingCli(cwd)
    const modelId = `claude-mcp-late-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    const sk = sessionKey(cwd, `${modelId}::tools::default::context=["claude-code",null]`)
    try {
      await fn({ cwd, cliPath: fake.cliPath, modelId, sk, spawns: fake.spawns })
    } finally {
      deleteActiveProcess(sk)
      setOpencodeClient({})
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
}

test("a server that connects between turns reaches the next spawn, with --resume", async () => {
  await withTwoTurnFixture(async (ctx) => {
    await runTurn({ ...ctx, status: { joining: "failed" } })
    const first = ctx.spawns()
    assert.equal(first.length, 1, "the first turn spawns once")
    assert.deepEqual(first[0].servers, [], "a failed server is not bridged")
    assert.equal(first[0].resume, false)

    await runTurn({ ...ctx, status: { joining: "connected" }, prior: true })
    const spawns = ctx.spawns()
    assert.equal(spawns.length, 2, "the second turn moves onto a new process")
    assert.deepEqual(spawns[1].servers, ["joining"], "the new process has the server")
    assert.equal(spawns[1].resume, true, "and resumes the conversation")
  })
})

test("an unchanged server set reuses the process and spawns nothing", async () => {
  await withTwoTurnFixture(async (ctx) => {
    await runTurn({ ...ctx, status: { joining: "connected" } })
    await runTurn({ ...ctx, status: { joining: "connected" }, prior: true })
    const spawns = ctx.spawns()
    assert.equal(spawns.length, 1, "one spawn for both turns")
    assert.deepEqual(spawns[0].servers, ["joining"])
  })
})

test("hotReloadMcp: false keeps the first process and its first config", async () => {
  await withTwoTurnFixture(async (ctx) => {
    const settings = { hotReloadMcp: false }
    await runTurn({ ...ctx, status: { joining: "failed" }, settings })
    await runTurn({ ...ctx, status: { joining: "connected" }, settings, prior: true })
    const spawns = ctx.spawns()
    assert.equal(spawns.length, 1)
    assert.deepEqual(spawns[0].servers, [])
  })
})

test("a turn still in flight on the live process is not a boundary", async () => {
  await withTwoTurnFixture(async (ctx) => {
    await runTurn({ ...ctx, status: { joining: "failed" } })
    const active = getActiveProcess(ctx.sk)
    assert.ok(active, "the first turn left a reusable process")
    // The fake CLI settles its turn on the terminal `result`, so mark the
    // child busy by hand: this is the state a `/btw` or a second doStream
    // arriving mid-turn would find.
    active.turnInFlight = true
    await runTurn({ ...ctx, status: { joining: "connected" }, prior: true })
    assert.equal(ctx.spawns().length, 1, "no respawn while the child is working")
    active.turnInFlight = false
  })
})

test("the cooldown holds a second change off, and the first one still landed", async () => {
  await withTwoTurnFixture(async (ctx) => {
    await runTurn({ ...ctx, status: { joining: "failed" } })
    await runTurn({ ...ctx, status: { joining: "connected" }, prior: true })
    assert.equal(ctx.spawns().length, 2, "the first change respawned")
    await runTurn({ ...ctx, status: { joining: "failed" }, prior: true })
    assert.equal(ctx.spawns().length, 2, "the flap back did not")
  })
})
