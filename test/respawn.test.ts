/**
 * Regressions for the reused-process respawn path in src/session-manager.ts.
 *
 * These cover the pure helpers (`appendResumeIfNeeded`) and the
 * undefined-when-no-active-process branch of `respawnActiveProcess`, plus
 * real Node fixtures that check the respawned child's launch configuration.
 *
 * Usage:
 *   npx tsx --test test/respawn.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { once } from "node:events"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  appendResumeIfNeeded,
  deleteActiveProcessAndWait,
  getActiveProcess,
  getClaudeSessionId,
  isTurnInFlight,
  killAllActiveProcesses,
  noteTurnStarted,
  respawnActiveProcess,
  setClaudeSessionId,
  deleteClaudeSessionId,
  spawnClaudeProcess,
  bufferUnattendedLine,
  takeUnattendedLines,
  type ActiveProcess,
} from "../src/session-manager.js"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import { createClaudeCode } from "../src/index.js"
import { START_WATCHDOG_INIT_MARGIN_MS, startWatchdogDelayMs } from "../src/turn-controller.js"

test("unattended output is capped by line count and UTF-8 bytes, including oversized single lines", () => {
  const active: ActiveProcess = { proc: {} as ChildProcess, lineEmitter: new EventEmitter() }
  for (let index = 0; index < 501; index++) bufferUnattendedLine(active, String(index))
  assert.equal(active.unattendedLines?.length, 500)
  assert.equal(active.unattendedLines?.[0], "1")
  assert.equal(takeUnattendedLines(active).dropped, 1)
  bufferUnattendedLine(active, "\u00e9".repeat(1_100_000))
  assert.deepEqual(takeUnattendedLines(active), { lines: [], dropped: 1 })
  assert.deepEqual(takeUnattendedLines(active), { lines: [], dropped: 0 })
})

function createNodeFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-respawn-"))
  const cliPath = join(cwd, "fixture.cjs")
  const configPath = join(cwd, "mcp.json")
  const promptPath = join(cwd, "system.txt")
  writeFileSync(configPath, JSON.stringify({ mcpServers: { preserved: { marker: "original MCP config" } } }))
  writeFileSync(promptPath, "original appended system prompt")
  writeFileSync(cliPath, `
const fs = require("node:fs")
const readline = require("node:readline")
const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const envelope = JSON.parse(line)
  if (envelope.lines) {
    process.stdout.write(envelope.lines.join("\\n") + "\\n")
    return
  }
  process.stdout.write(JSON.stringify({
    args,
    envelope,
    cwd: process.cwd(),
    effort: process.env.CLAUDE_CODE_EFFORT_LEVEL,
    config: JSON.parse(fs.readFileSync(value("--mcp-config"), "utf8")),
    prompt: fs.readFileSync(value("--append-system-prompt-file"), "utf8"),
  }) + "\\n")
})
process.stdout.write("ready\\n")
`)
  const args = [
    cliPath,
    "--mcp-config", configPath,
    "--append-system-prompt-file", promptPath,
    "--model", "claude-haiku-4-5",
  ]
  return { cwd, args, configPath, promptPath }
}

test("appendResumeIfNeeded: no-op when no claude session id is known", () => {
  const sk = `sk-noid-${Date.now()}`
  deleteClaudeSessionId(sk)
  const args = ["--print", "--model", "claude-fable-5"]
  assert.deepEqual(appendResumeIfNeeded(sk, args), args)
})

test("appendResumeIfNeeded: appends --resume when a conversation id is known", () => {
  const sk = `sk-withid-${Date.now()}`
  setClaudeSessionId(sk, "claude-conv-123")
  try {
    const args = ["--print", "--model", "claude-fable-5"]
    assert.deepEqual(appendResumeIfNeeded(sk, args), [
      "--print",
      "--model",
      "claude-fable-5",
      "--resume",
      "claude-conv-123",
    ])
  } finally {
    deleteClaudeSessionId(sk)
  }
})

test("appendResumeIfNeeded: does not append when --session-id is already present", () => {
  const sk = `sk-hasarg-${Date.now()}`
  setClaudeSessionId(sk, "claude-conv-456")
  try {
    const args = ["--print", "--session-id", "claude-conv-already"]
    assert.deepEqual(appendResumeIfNeeded(sk, args), args)
  } finally {
    deleteClaudeSessionId(sk)
  }
})

test("appendResumeIfNeeded: does not append when --resume is already present", () => {
  const sk = `sk-hasresume-${Date.now()}`
  setClaudeSessionId(sk, "claude-conv-457")
  try {
    const args = ["--print", "--resume", "claude-conv-already"]
    assert.deepEqual(appendResumeIfNeeded(sk, args), args)
  } finally {
    deleteClaudeSessionId(sk)
  }
})

test("appendResumeIfNeeded: does not mutate the input array", () => {
  const sk = `sk-immutable-${Date.now()}`
  setClaudeSessionId(sk, "claude-conv-789")
  try {
    const args = ["--print"]
    const snapshot = [...args]
    appendResumeIfNeeded(sk, args)
    assert.deepEqual(args, snapshot)
  } finally {
    deleteClaudeSessionId(sk)
  }
})

// The start watchdog respawns in the middle of a turn and re-sends its
// envelope at once. Turn state is keyed by ActiveProcess, so without the
// handoff abort, LRU eviction and the idle timer all read the busy
// replacement as idle (@broskees' b719497).
test("respawnActiveProcess preserves an in-flight turn on the replacement", async () => {
  const sk = `sk-inflight-${Date.now()}`
  const args = ["-e", "setInterval(() => {}, 1000)"]
  const old = spawnClaudeProcess(process.execPath, args, process.cwd(), sk)
  noteTurnStarted(old)
  try {
    const replacement = respawnActiveProcess(sk, process.execPath, args, process.cwd())
    assert.ok(replacement)
    assert.notEqual(replacement, old)
    assert.equal(isTurnInFlight(replacement), true)
    assert.equal(getActiveProcess(sk), replacement)
  } finally {
    await deleteActiveProcessAndWait(sk)
    deleteClaudeSessionId(sk)
  }
})

test("respawnActiveProcess leaves an idle replacement idle", async () => {
  const sk = `sk-idle-respawn-${Date.now()}`
  const args = ["-e", "setInterval(() => {}, 1000)"]
  spawnClaudeProcess(process.execPath, args, process.cwd(), sk)
  try {
    const replacement = respawnActiveProcess(sk, process.execPath, args, process.cwd())
    assert.ok(replacement)
    assert.equal(isTurnInFlight(replacement), false)
  } finally {
    await deleteActiveProcessAndWait(sk)
    deleteClaudeSessionId(sk)
  }
})

test("respawnActiveProcess: returns undefined when no active process exists for the key", () => {
  const sk = `sk-empty-${Date.now()}`
  // No setActiveProcess(spawnClaudeProcess(...)) was done for this key, so
  // there is nothing to respawn; the watchdog treats this as "give up".
  assert.equal(
    respawnActiveProcess(sk, "/usr/bin/env", ["--print"], process.cwd()),
    undefined,
  )
})

test("respawn preserves the original CLI args, config and prompt on a real child", {
  timeout: 10_000,
}, async () => {
  const fixture = createNodeFixture()
  const sk = `respawn-${fixture.cwd}`
  const original = spawnClaudeProcess(
    process.execPath,
    fixture.args,
    fixture.cwd,
    sk,
    undefined,
    "original-mcp-hash",
    fixture.promptPath,
    false,
    "high",
  )
  try {
    assert.deepEqual(
      await once(original.lineEmitter, "line", { signal: AbortSignal.timeout(5_000) }),
      ["ready"],
    )
    assert.deepEqual(original.cliArgs, fixture.args)
    const completions: NonNullable<ActiveProcess["pendingProxyCompletions"]> = new Map([
      ["pending-task", {
        call: { sessionKey: sk, toolCallId: "pending-task", toolName: "task", input: {}, channel: { closed: false } },
        result: { kind: "text", text: "completed once" },
        recoveryRequired: false,
      }],
    ])
    original.pendingProxyCompletions = completions
    setClaudeSessionId(sk, "existing-fixture-session")
    const originalExit = once(original.proc, "close", { signal: AbortSignal.timeout(5_000) })
    // A reattached doStream turn has no freshly built args. Respawn must use
    // the original process's args, not launch Node (or Claude) with just resume.
    const replacement = respawnActiveProcess(sk, process.execPath, [], fixture.cwd)
    assert.ok(replacement)
    assert.equal(replacement.pendingProxyCompletions, completions)
    assert.equal(original.pendingProxyCompletions, undefined)
    assert.notEqual(replacement.proc.pid, original.proc.pid)
    assert.deepEqual(
      await once(replacement.lineEmitter, "line", { signal: AbortSignal.timeout(5_000) }),
      ["ready"],
    )
    await originalExit

    const envelope = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "The task completed; continue from its result." }] },
    }
    const reply = once(replacement.lineEmitter, "line", { signal: AbortSignal.timeout(5_000) })
    replacement.proc.stdin!.write(JSON.stringify(envelope) + "\n")
    const [line] = await reply
    const received = JSON.parse(line)
    assert.deepEqual(received.args, [...fixture.args.slice(1), "--resume", "existing-fixture-session"])
    assert.deepEqual(received.envelope, envelope)
    assert.deepEqual(received.config, JSON.parse(readFileSync(fixture.configPath, "utf8")))
    assert.equal(received.prompt, "original appended system prompt")
    assert.equal(received.effort, "high")
    assert.equal(replacement.mcpHash, "original-mcp-hash")
    assert.equal(replacement.systemPromptFile, fixture.promptPath)
    assert.equal(getClaudeSessionId(sk), "existing-fixture-session")
    assert.equal(getActiveProcess(sk), replacement)
    assert.deepEqual(replacement.cliArgs, [...fixture.args, "--resume", "existing-fixture-session"])
  } finally {
    await deleteActiveProcessAndWait(sk)
    deleteClaudeSessionId(sk)
    rmSync(fixture.cwd, { recursive: true, force: true })
  }
})

/**
 * Drive one doStream turn against a fake CLI that answers with a partial text
 * block, writes to stderr, and then exits non-zero without ever emitting the
 * terminal `result` line.
 */
async function streamCrashingTurn(options: { exitDelayMs: number; abort?: boolean }) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-crash-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const readline = require("node:readline")
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.258\\n")
  process.exit(0)
}
let answered = false
readline.createInterface({ input: process.stdin }).on("line", () => {
  if (answered) return
  answered = true
  process.stdout.write(JSON.stringify({
    type: "assistant",
    session_id: "fake-session",
    message: { role: "assistant", content: [{ type: "text", text: "Half an answ" }] },
  }) + "\\n")
  process.stderr.write("fatal: the CLI ran out of memory\\n")
  setTimeout(() => process.exit(3), ${options.exitDelayMs})
})
`,
  )
  chmodSync(cliPath, 0o755)

  const controller = new AbortController()
  try {
    const model = createClaudeCode({
      cliPath,
      cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: [],
    }).languageModel("claude-test-crash")
    const response = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Answer briefly." }] }],
      tools: [
        {
          type: "function",
          name: "bash",
          description: "Run a command",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      ...(options.abort ? { abortSignal: controller.signal } : {}),
    } as any)

    const parts: any[] = []
    for await (const part of response.stream) {
      parts.push(part)
      // Abort as soon as the partial answer lands, before the child dies.
      if (options.abort && part.type === "text-delta") controller.abort()
    }
    return parts as any[]
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

// A child that dies mid-turn used to finish the stream with reason `stop` and
// empty usage, so a crashed CLI read as a short but successful answer. The
// stderr tail retained on the ActiveProcess is usually the only record of why.
test("a child that dies without a result ends the turn as an error", async () => {
  const parts = await streamCrashingTurn({ exitDelayMs: 40 })

  const errors = parts.filter((part) => part.type === "error")
  assert.equal(
    errors.length,
    1,
    `expected one error part, got ${JSON.stringify(parts.map((part) => part.type))}`,
  )
  const message = String((errors[0] as any).error?.message ?? "")
  assert.match(message, /exited with code 3/)
  assert.match(message, /ran out of memory/)

  const finish = parts.find((part) => part.type === "finish") as any
  assert.ok(finish, "the stream must still finish")
  assert.equal(finish.finishReason.unified, "error")

  // The partial answer the CLI did produce is still delivered.
  assert.ok(
    parts.some(
      (part) => part.type === "text-delta" && String(part.delta).includes("Half an answ"),
    ),
  )
})

// An abort is not a crash: the operator asked for it, and the CLI may well
// exit before the interrupt's own `result` line lands.
test("an aborted turn is not reported as a crash", async () => {
  const parts = await streamCrashingTurn({ exitDelayMs: 300, abort: true })

  assert.deepEqual(
    parts.filter((part) => part.type === "error"),
    [],
    "an abort must not surface as a child crash",
  )
  const finish = parts.find((part) => part.type === "finish") as any
  if (finish) assert.notEqual(finish.finishReason.unified, "error")
})

// ---- The start watchdog before a child's `system`/`init` (h #g256) --------
//
// Claude Code writes `system`/`init` only after every MCP server connected or
// hit `MCP_TIMEOUT` (measured on 2.1.293), and the plugin gives every spawn a
// 120 s `MCP_TIMEOUT`. A 90 s watchdog therefore killed healthy children that
// were still waiting on a server: after a wake from sleep, every spawn for
// three minutes, twice each.

test("the start watchdog waits out the MCP timeout plus a margin until a child's init", () => {
  assert.equal(START_WATCHDOG_INIT_MARGIN_MS, 30_000)
  assert.equal(startWatchdogDelayMs(90_000, true, 120_000), 150_000, "the default spawn")
  assert.equal(startWatchdogDelayMs(90_000, false, 120_000), 90_000, "after init, or a reused process")
  assert.equal(startWatchdogDelayMs(300_000, true, 120_000), 300_000, "a longer configured delay still wins")
  assert.equal(startWatchdogDelayMs(90_000, true, 30_000), 90_000, "the CLI's own 30 s needs no extra time")
  assert.equal(startWatchdogDelayMs(1_000, true, 1), 30_001)
})

/**
 * One doStream turn against a fake CLI that is slow to start. `late-init`
 * writes nothing at all for `initDelayMs` after the envelope (a child still
 * waiting on an MCP server), then answers. `silent-after-init` writes its
 * `init` at once and then nothing, and answers only when respawned with
 * `--resume`. Every spawn is recorded with its time and whether it resumed.
 */
async function streamSlowStartTurn(mode: "late-init" | "silent-after-init", initDelayMs = 0) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-slow-start-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const eventsPath = join(cwd, "spawns.jsonl")
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.258\\n")
  process.exit(0)
}
if (process.argv.includes("--help")) {
  process.stdout.write("Usage: claude [options]\\n")
  process.exit(0)
}
const resumed = process.argv.includes("--resume")
fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({ at: Date.now(), resumed }) + "\\n")
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
const init = () => emit({ type: "system", subtype: "init", session_id: "fake-slow-start" })
function answer(text) {
  init()
  emit({ type: "assistant", session_id: "fake-slow-start", message: { role: "assistant", content: [{ type: "text", text }] } })
  emit({ type: "result", subtype: "success", session_id: "fake-slow-start", is_error: false, result: text, duration_ms: 1, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } })
}
readline.createInterface({ input: process.stdin }).on("line", () => {
  if (${JSON.stringify(mode)} === "late-init") {
    setTimeout(() => answer("Answered after the MCP wait."), ${initDelayMs})
    return
  }
  if (resumed) answer("Answered by the respawn.")
  else init()
})
`,
  )
  chmodSync(cliPath, 0o755)

  const previous = {
    watchdog: process.env.CLAUDE_CODE_START_WATCHDOG_MS,
    mcpTimeout: process.env.MCP_TIMEOUT,
  }
  // A one-second configured delay, and an MCP timeout so short that the
  // margin alone decides the pre-init delay: 30.001 s, far past this test.
  process.env.CLAUDE_CODE_START_WATCHDOG_MS = "1000"
  process.env.MCP_TIMEOUT = "1"
  try {
    const model = createClaudeCode({
      cliPath,
      cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: [],
    }).languageModel(`claude-test-slow-start-${mode}`)
    const response = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Answer briefly." }] }],
      tools: [{ type: "function", name: "bash", description: "Run a command", inputSchema: { type: "object", properties: {} } }],
    } as any)
    const parts: any[] = []
    for await (const part of response.stream) parts.push(part)
    const spawns = readFileSync(eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    return { parts, spawns }
  } finally {
    // These fakes wait on stdin for good; left running they hold the file open.
    killAllActiveProcesses()
    if (previous.watchdog === undefined) delete process.env.CLAUDE_CODE_START_WATCHDOG_MS
    else process.env.CLAUDE_CODE_START_WATCHDOG_MS = previous.watchdog
    if (previous.mcpTimeout === undefined) delete process.env.MCP_TIMEOUT
    else process.env.MCP_TIMEOUT = previous.mcpTimeout
    rmSync(cwd, { recursive: true, force: true })
  }
}

test("a child still waiting on its MCP servers is not respawned before its init", { timeout: 30_000 }, async () => {
  // Silent for 2.5 configured delays: the old watchdog respawned it at 1 s,
  // the respawn waited again, and the turn ended as an error at 2 s.
  const { parts, spawns } = await streamSlowStartTurn("late-init", 2_500)
  assert.equal(spawns.length, 1, "spawned once, never respawned")
  assert.deepEqual(parts.filter((part) => part.type === "error"), [])
  assert.ok(
    parts.some((part) => part.type === "text-delta" && String(part.delta).includes("Answered after the MCP wait.")),
    `expected the answer, got ${JSON.stringify(parts.map((part) => part.type))}`,
  )
  assert.notEqual(parts.find((part) => part.type === "finish")?.finishReason.unified, "error")
})

test("after its init a silent child is respawned one configured delay later", { timeout: 30_000 }, async () => {
  const { parts, spawns } = await streamSlowStartTurn("silent-after-init")
  assert.equal(spawns.length, 2, "the silent child was respawned once")
  assert.equal(spawns[0].resumed, false)
  assert.equal(spawns[1].resumed, true, "the respawn resumes the conversation")
  const waited = spawns[1].at - spawns[0].at
  assert.ok(waited >= 900, `respawned after ${waited} ms, before the configured delay`)
  assert.ok(waited < 15_000, `respawned after ${waited} ms: the pre-init delay was not given up at init`)
  assert.ok(parts.some((part) => part.type === "text-delta" && String(part.delta).includes("Answered by the respawn.")))
  assert.deepEqual(parts.filter((part) => part.type === "error"), [])
})
