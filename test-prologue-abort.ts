/**
 * An abort that arrives while a turn is still being PREPARED must stop it.
 *
 * `doStreamForHost` awaits a whole prologue before the `ReadableStream` its
 * abort handler used to live in even exists: the spawn cwd, the account
 * failover resolution, the plan-mode gate, opencode's MCP runtime status
 * (with the up-to-3-second wait for a server opencode 2 still reports as
 * `pending`), the `claude --version` probe behind its own 5-second deadline,
 * opencode's tool registry and a parent-session lookup, then, inside the
 * stream's `start`, the MCP hot-reload wait, the tool registry again, the
 * proxy MCP server, the skill bridge and an interrupt of a previous turn.
 * `addEventListener("abort")` on a signal that already aborted never fires,
 * so a stop inside any of those windows was observed by nobody and the turn
 * went on to spawn a `claude`, write the envelope and bill the answer.
 *
 * Every test here drives a REAL `doStream` against a fake `claude` and asserts
 * the negatives that matter: no child was spawned, nothing reached its stdin,
 * and no turn was marked in flight. See (h #g182), and (h #g26) for the
 * tool-boundary abort these must not disturb.
 *
 * Usage: npx tsx --test test-prologue-abort.ts
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { watchTurnAbort } from "./src/turn-abort.js"
import { createClaudeCode } from "./src/index.js"
import { MCP_PENDING_STATUS } from "./src/mcp-bridge.js"
import { getRuntimeMcpStatus, setOpencodeClient } from "./src/runtime-status.js"
import {
  deleteActiveProcess,
  getActiveProcess,
  isTurnInFlight,
  killAllActiveProcesses,
  sessionKey,
} from "./src/session-manager.js"

after(() => {
  killAllActiveProcesses()
})

// ---------------------------------------------------------------------------
// The watch itself
// ---------------------------------------------------------------------------

test("watchTurnAbort: a signal that already aborted still reaches its listener", async () => {
  const controller = new AbortController()
  controller.abort(new Error("stopped before the watch existed"))
  const watch = watchTurnAbort(controller.signal)

  assert.equal(watch.aborted, true)
  let ran = 0
  watch.onAbort(() => {
    ran += 1
  })
  assert.equal(ran, 1, "an already-aborted signal runs the listener at once")
  await watch.whenAborted
  assert.equal((watch.reason as Error).message, "stopped before the watch existed")
})

test("watchTurnAbort: a later abort fires every listener exactly once", async () => {
  const controller = new AbortController()
  const watch = watchTurnAbort(controller.signal)
  assert.equal(watch.aborted, false)

  const calls: string[] = []
  watch.onAbort(() => calls.push("first"))
  watch.onAbort(() => {
    throw new Error("a throwing listener must not take the others down")
  })
  watch.onAbort(() => calls.push("third"))

  controller.abort()
  await watch.whenAborted
  assert.deepEqual(calls, ["first", "third"])
  assert.equal(watch.aborted, true)

  // A listener registered afterwards runs immediately, and the signal firing
  // again (it cannot) would add nothing.
  watch.onAbort(() => calls.push("late"))
  assert.deepEqual(calls, ["first", "third", "late"])
})

test("watchTurnAbort: dispose drops the signal listener", async () => {
  const controller = new AbortController()
  const watch = watchTurnAbort(controller.signal)
  let ran = 0
  watch.onAbort(() => {
    ran += 1
  })
  watch.dispose()
  controller.abort()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(ran, 0)
  assert.equal(watch.aborted, false)
})

// ---------------------------------------------------------------------------
// The MCP connect wait stops waiting on an abort
// ---------------------------------------------------------------------------

test("the MCP connect wait ends on the turn's abort instead of burning its budget", async () => {
  let calls = 0
  setOpencodeClient({
    mcp: {
      status: async () => {
        calls += 1
        return { data: { slow: { status: MCP_PENDING_STATUS } } }
      },
    },
  })
  try {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 150)
    const started = Date.now()
    const status = await getRuntimeMcpStatus({
      waitForPendingMs: 10_000,
      signal: controller.signal,
    })
    const elapsed = Date.now() - started
    // The snapshot already in hand is what it returns, exactly as a status
    // call that stops answering mid-wait does.
    assert.deepEqual(status, { slow: MCP_PENDING_STATUS })
    assert.ok(elapsed < 5_000, `the wait stopped early (${elapsed}ms of a 10s budget)`)
    assert.ok(calls >= 1)
  } finally {
    setOpencodeClient({})
  }
})

// ---------------------------------------------------------------------------
// Real doStream turns against a fake claude
// ---------------------------------------------------------------------------

interface FakeCli {
  cliPath: string
  cwd: string
  /** argv of every real turn spawn (capability probes excluded). */
  spawns(): string[][]
  /** Every line this fake `claude` was asked to answer. */
  stdinLines(): string[]
}

/**
 * A fake `claude` that records what it was spawned with and what was written
 * to it. `versionDelayMs` stalls the `--version` probe, which is how a
 * prologue is slowed deterministically without touching the plugin's own
 * 5-second probe deadline (h #g181): the abort below lands hundreds of
 * milliseconds into it, so whether a loaded machine later kills the probe
 * changes nothing these tests assert.
 */
function createFakeCli(versionDelayMs = 0): FakeCli {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-prologue-abort-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const spawnLog = join(cwd, "spawns.ndjson")
  const stdinLog = join(cwd, "stdin.ndjson")
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
const args = process.argv.slice(2)

if (args.includes("--version")) {
  setTimeout(() => {
    process.stdout.write("2.1.280\\n")
    process.exit(0)
  }, ${versionDelayMs})
  return
}

// A capability probe (\`--help\` for an optional flag) is not a turn spawn and
// must never be counted as one.
if (!args.includes("--print")) {
  process.stdout.write("\\n")
  process.exit(0)
}

fs.appendFileSync(${JSON.stringify(spawnLog)}, JSON.stringify(args) + "\\n")
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  fs.appendFileSync(${JSON.stringify(stdinLog)}, line + "\\n")
  const envelope = JSON.parse(line)
  if (envelope.type === "control_request") return
  const sid = "fake-session-" + process.pid
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sid, tools: [] }) + "\\n")
  process.stdout.write(JSON.stringify({
    type: "assistant",
    session_id: sid,
    message: { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } },
  }) + "\\n")
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", session_id: sid, is_error: false,
    usage: { input_tokens: 1, output_tokens: 1 },
  }) + "\\n")
})
`,
  )
  chmodSync(cliPath, 0o755)
  const readLog = (path: string): string[] =>
    existsSync(path)
      ? readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0)
      : []
  return {
    cliPath,
    cwd,
    spawns: () => readLog(spawnLog).map((line) => JSON.parse(line) as string[]),
    stdinLines: () => readLog(stdinLog),
  }
}

const MODEL_ID = "claude-test-prologue-abort"

function keyFor(fake: FakeCli): string {
  return sessionKey(fake.cwd, `${MODEL_ID}::tools::default::context=["claude-code",null]`)
}

const TOOLS = [
  {
    type: "function",
    name: "read",
    description: "Read a file",
    inputSchema: { type: "object", properties: {} },
  },
]

function modelFor(fake: FakeCli, settings: Record<string, unknown> = {}) {
  return createClaudeCode({
    cliPath: fake.cliPath,
    cwd: fake.cwd,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    ...settings,
  }).languageModel(MODEL_ID)
}

/** Drive one turn and collect its parts; the stream must still terminate. */
async function runTurn(
  model: ReturnType<typeof modelFor>,
  callOptions: Record<string, unknown>,
): Promise<any[]> {
  const response = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    tools: TOOLS,
    ...callOptions,
  } as any)
  const parts: any[] = []
  for await (const part of response.stream) parts.push(part)
  return parts
}

function cleanup(fake: FakeCli) {
  deleteActiveProcess(keyFor(fake))
  rmSync(fake.cwd, { recursive: true, force: true })
}

test("control: with no abort the same fake CLI is spawned and written to", async () => {
  const fake = createFakeCli(300)
  try {
    const parts = await runTurn(modelFor(fake), {})
    assert.equal(fake.spawns().length, 1, "the turn really does spawn a claude")
    assert.equal(fake.stdinLines().length, 1, "and really does write the envelope")
    assert.ok(parts.some((part) => part.type === "finish"))
  } finally {
    cleanup(fake)
  }
})

test("aborted during the CLI version probe: nothing is spawned and nothing is written", async () => {
  const fake = createFakeCli(1_500)
  try {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    const started = Date.now()
    const parts = await runTurn(modelFor(fake), { abortSignal: controller.signal })
    const elapsed = Date.now() - started

    assert.deepEqual(fake.spawns(), [], "no claude was spawned for a turn that was stopped")
    assert.deepEqual(fake.stdinLines(), [], "the user message never reached the CLI")
    assert.equal(getActiveProcess(keyFor(fake)), undefined, "no process was registered")
    // The stream still terminates, and it ends the way an aborted turn with no
    // content already ends: closed, with no `finish` and no `error`.
    assert.deepEqual(
      parts.map((part) => part.type),
      ["stream-start"],
    )
    assert.ok(elapsed < 1_400, `the turn did not sit out the whole probe (${elapsed}ms)`)
  } finally {
    cleanup(fake)
  }
})

test("aborted with a signal that was already aborted: the turn never starts", async () => {
  const fake = createFakeCli()
  try {
    const controller = new AbortController()
    controller.abort()
    const parts = await runTurn(modelFor(fake), { abortSignal: controller.signal })

    assert.deepEqual(fake.spawns(), [])
    assert.deepEqual(fake.stdinLines(), [])
    assert.equal(getActiveProcess(keyFor(fake)), undefined)
    assert.deepEqual(
      parts.map((part) => part.type),
      ["stream-start"],
    )
  } finally {
    cleanup(fake)
  }
})

test("aborted during the MCP connect wait: nothing is spawned and nothing is written", async () => {
  const fake = createFakeCli()
  setOpencodeClient({
    mcp: {
      // Never leaves `pending`, so the turn would otherwise wait the whole
      // budget before planning its spawn.
      status: async () => ({ data: { slow: { status: MCP_PENDING_STATUS } } }),
    },
  })
  try {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 250)
    const started = Date.now()
    const parts = await runTurn(
      modelFor(fake, { bridgeOpencodeMcp: true, mcpConnectWaitMs: 10_000 }),
      { abortSignal: controller.signal },
    )
    const elapsed = Date.now() - started

    assert.deepEqual(fake.spawns(), [])
    assert.deepEqual(fake.stdinLines(), [])
    assert.equal(getActiveProcess(keyFor(fake)), undefined)
    assert.deepEqual(
      parts.map((part) => part.type),
      ["stream-start"],
    )
    assert.ok(elapsed < 5_000, `the wait was cut short by the abort (${elapsed}ms)`)
  } finally {
    setOpencodeClient({})
    cleanup(fake)
  }
})

test("aborted just before the envelope write: a reused process is left alone", async () => {
  const fake = createFakeCli()
  let listCalls = 0
  let releaseSecondList: (() => void) | null = null
  setOpencodeClient({
    tool: {
      list: async () => {
        listCalls += 1
        // The first turn resolves at once; the second hangs inside `setup()`,
        // which is the last await before this turn would write to the child.
        if (listCalls > 1) {
          await new Promise<void>((resolve) => {
            releaseSecondList = resolve
            // Bounded, so a build that drops the abort still finishes the turn
            // (and fails the assertions below) instead of hanging the suite.
            setTimeout(resolve, 2_000).unref?.()
          })
        }
        return {
          data: [
            { id: "task", description: "Run a subagent", parameters: { type: "object" } },
          ],
        }
      },
    },
  })
  const sk = keyFor(fake)
  try {
    const model = modelFor(fake, { proxyTools: ["Task"] })

    // Turn one: a real spawn, a real envelope, a real answer.
    const first = await runTurn(model, {})
    assert.ok(first.some((part) => part.type === "finish"))
    assert.equal(fake.spawns().length, 1)
    assert.equal(fake.stdinLines().length, 1)
    const reused = getActiveProcess(sk)
    assert.ok(reused, "the process stays alive for the next message")

    // Turn two: stopped while opencode's tool registry is still answering.
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    const response = await model.doStream({
      prompt: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "text", text: "and again" }] },
      ],
      tools: TOOLS,
      abortSignal: controller.signal,
    } as any)
    const parts: any[] = []
    for await (const part of response.stream) parts.push(part)

    assert.equal(fake.spawns().length, 1, "no second claude was spawned")
    assert.equal(fake.stdinLines().length, 1, "the second envelope was never written")
    assert.equal(getActiveProcess(sk), reused, "the reused process is untouched")
    assert.equal(isTurnInFlight(reused!), false, "no turn was marked in flight")
    assert.deepEqual(
      parts.map((part) => part.type),
      ["stream-start"],
    )
  } finally {
    releaseSecondList?.()
    setOpencodeClient({})
    cleanup(fake)
  }
})
