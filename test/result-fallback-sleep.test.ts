/**
 * The wire-inactivity watchdog and a machine that slept (h #g316).
 *
 * On 2026-11-14 the watchdog fired 3 s into a dark wake, five minutes after it
 * was due: it counts wall-clock time, sleep included, so the Mac's sleep read
 * as a silent CLI and a subagent's turn was closed while its CLI was only
 * waiting for the network. The CLI then retried on its own and ran on for 28
 * minutes with nobody listening. A late fire now waits again, and a fire that
 * does close the turn interrupts the CLI.
 *
 * The sleep is faked by moving the watchdog's clock, never by blocking the
 * event loop, so nothing here races a deadline (h #g181).
 *
 * Usage: npx tsx --test test/result-fallback-sleep.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { STREAM_TIMEOUT_MARKER } from "../src/cli-events.js"
import { createClaudeCode } from "../src/index.js"
import { deleteActiveProcess, sessionKey } from "../src/session-manager.js"
import {
  _setResultFallbackClock,
  _setResultFallbackLateSlackMs,
} from "../src/turn-controller.js"

afterEach(() => {
  _setResultFallbackClock(null)
  _setResultFallbackLateSlackMs(null)
})

type Step =
  | { text: string }
  | { retry: number }
  | { wait: number }
  | { result: true }

/**
 * A `claude` that plays `steps` on its first message: text deltas, `api_retry`
 * frames shaped as 2.1.322 writes them, waits, and a `result`. A script with
 * no `result` goes silent for good. It records every stdin line and every
 * spawn, so a test can see an interrupt or a respawn.
 */
function createFakeCli(steps: Step[]) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-result-fallback-sleep-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const record = join(cwd, "stdin.jsonl")
  const spawns = join(cwd, "spawns.txt")
  writeFileSync(
    cliPath,
    `#!${process.execPath}
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.322\\n")
  process.exit(0)
}
if (process.argv.includes("--help")) process.exit(0)
fs.appendFileSync(${JSON.stringify(spawns)}, process.pid + "\\n")
const emit = (message) => process.stdout.write(JSON.stringify({ session_id: "fake-session", ...message }) + "\\n")
emit({ type: "system", subtype: "init", tools: ["Read"] })
const STEPS = ${JSON.stringify(steps)}
let answered = false
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  fs.appendFileSync(${JSON.stringify(record)}, line + "\\n")
  if (answered) return
  answered = true
  for (const step of STEPS) {
    if ("text" in step) emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: step.text } } })
    if ("retry" in step) emit({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: step.retry, error_status: 529, error: "overloaded" })
    if ("wait" in step) await new Promise((resolve) => setTimeout(resolve, step.wait))
    if ("result" in step) emit({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done", usage: { input_tokens: 1, output_tokens: 1 } })
  }
})
`,
    { mode: 0o755 },
  )
  const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [])
  return {
    cwd,
    cliPath,
    stdinLines: (): any[] => read(record).map((line) => JSON.parse(line)),
    spawnCount: (): number => read(spawns).length,
  }
}

async function runTurn(
  fake: ReturnType<typeof createFakeCli>,
  fallbackMs: number,
  onFirstText?: () => void,
  startWatchdogMs?: number,
): Promise<{ parts: any[]; key: string }> {
  const modelId = "claude-test-result-fallback-sleep"
  const key = sessionKey(fake.cwd, `${modelId}::tools::default::context=["claude-code",null]`)
  const previous = process.env.CLAUDE_CODE_RESULT_FALLBACK_MS
  const previousStart = process.env.CLAUDE_CODE_START_WATCHDOG_MS
  process.env.CLAUDE_CODE_RESULT_FALLBACK_MS = String(fallbackMs)
  if (startWatchdogMs !== undefined) process.env.CLAUDE_CODE_START_WATCHDOG_MS = String(startWatchdogMs)
  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: [],
      autoContinueIncompleteTurns: false,
    }).languageModel(modelId)
    const response = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      tools: [
        { type: "function", name: "read", description: "Read", inputSchema: { type: "object", properties: {} } },
      ],
      abortSignal: AbortSignal.timeout(60_000),
    } as any)
    const parts: any[] = []
    let sawText = false
    for await (const part of response.stream) {
      parts.push(part)
      if (!sawText && part.type === "text-delta") {
        sawText = true
        onFirstText?.()
      }
    }
    return { parts, key }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_RESULT_FALLBACK_MS
    else process.env.CLAUDE_CODE_RESULT_FALLBACK_MS = previous
    if (previousStart === undefined) delete process.env.CLAUDE_CODE_START_WATCHDOG_MS
    else process.env.CLAUDE_CODE_START_WATCHDOG_MS = previousStart
  }
}

const POSIX = {
  timeout: 60_000,
  skip: process.platform === "win32" ? "the fake-CLI harness is POSIX-only" : false,
} as const

const body = (parts: any[]) =>
  parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")

test("a watchdog that fires after a sleep waits again instead of closing the turn", POSIX, async () => {
  // Due at 2 s; the CLI finishes at 3 s. The clock jumps ten minutes the
  // moment the first text arrives, as a sleep makes it, so the fire at 2 s
  // looks ten minutes late and must wait a fresh 2 s, which the CLI beats.
  const fake = createFakeCli([{ text: "half an answer" }, { wait: 3_000 }, { text: " and the rest" }, { result: true }])
  let key = ""
  try {
    _setResultFallbackLateSlackMs(500)
    const turn = await runTurn(fake, 2_000, () => {
      const jump = 10 * 60_000
      _setResultFallbackClock(() => Date.now() + jump)
    })
    key = turn.key
    const said = body(turn.parts)
    assert.ok(!said.includes(STREAM_TIMEOUT_MARKER), said)
    assert.match(said, /half an answer and the rest/)
    const finish = turn.parts.find((part) => part.type === "finish")
    assert.deepEqual(finish.finishReason, { unified: "stop", raw: "stop" })
    assert.ok(
      !fake.stdinLines().some((line) => line.request?.subtype === "interrupt"),
      "nothing was interrupted",
    )
  } finally {
    if (key) deleteActiveProcess(key)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a watchdog that closes the turn interrupts the CLI it stopped listening to", POSIX, async () => {
  const fake = createFakeCli([{ text: "half an answer" }])
  let key = ""
  try {
    const turn = await runTurn(fake, 500)
    key = turn.key
    assert.ok(body(turn.parts).includes(STREAM_TIMEOUT_MARKER))

    let interrupts: any[] = []
    for (let waited = 0; waited < 10_000 && interrupts.length === 0; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      interrupts = fake
        .stdinLines()
        .filter((line) => line.type === "control_request" && line.request?.subtype === "interrupt")
    }
    assert.equal(interrupts.length, 1, JSON.stringify(fake.stdinLines()))
  } finally {
    if (key) deleteActiveProcess(key)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a retry the CLI announces holds the inactivity watchdog for that long", POSIX, async () => {
  // Due 1.5 s after the last line; the CLI says it will wait 3 s and answers
  // at 3.5 s. Without the announced wait the turn closes at 1.5 s.
  const fake = createFakeCli([
    { text: "half an answer" },
    { retry: 3_000 },
    { wait: 3_500 },
    { text: " and the rest" },
    { result: true },
  ])
  let key = ""
  try {
    const turn = await runTurn(fake, 1_500)
    key = turn.key
    const said = body(turn.parts)
    assert.ok(!said.includes(STREAM_TIMEOUT_MARKER), said)
    assert.match(said, /half an answer and the rest/)
  } finally {
    if (key) deleteActiveProcess(key)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a retry the CLI announces holds the start watchdog too, so nothing is respawned", POSIX, async () => {
  // No content yet, so only the start watchdog is armed: 1.5 s after the
  // envelope. The CLI announces a 3 s wait and answers at 3.5 s. Without the
  // announced wait the child is respawned at 1.5 s.
  const fake = createFakeCli([{ retry: 3_000 }, { wait: 3_500 }, { text: "the answer" }, { result: true }])
  let key = ""
  try {
    const turn = await runTurn(fake, 60_000, undefined, 1_500)
    key = turn.key
    assert.match(body(turn.parts), /the answer/)
    assert.equal(fake.spawnCount(), 1, "the child was never respawned")
  } finally {
    if (key) deleteActiveProcess(key)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a start watchdog that fires after a sleep waits again instead of respawning", POSIX, async () => {
  // Due 2 s after the envelope; the CLI answers 3 s after it. The clock jumps
  // ten minutes once the CLI has the envelope (so after the watchdog was
  // armed), as a sleep makes it, so the fire at 2 s looks late and waits a
  // fresh 2 s, to 4 s, which the answer beats by a second.
  const fake = createFakeCli([{ wait: 3_000 }, { text: "the answer" }, { result: true }])
  let key = ""
  const jump = setInterval(() => {
    if (fake.stdinLines().length === 0) return
    clearInterval(jump)
    const offset = 10 * 60_000
    _setResultFallbackClock(() => Date.now() + offset)
  }, 20)
  try {
    _setResultFallbackLateSlackMs(500)
    const turn = await runTurn(fake, 60_000, undefined, 2_000)
    key = turn.key
    assert.match(body(turn.parts), /the answer/)
    assert.equal(fake.spawnCount(), 1, "the child was never respawned")
  } finally {
    clearInterval(jump)
    if (key) deleteActiveProcess(key)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})
