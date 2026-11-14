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

/**
 * A `claude` that writes half an answer, goes silent, and finishes after
 * `finishAfterMs` (or never, for `null`). It records every stdin line, so a
 * test can see the interrupt the plugin sends.
 */
function createFakeCli(finishAfterMs: number | null) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-result-fallback-sleep-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const record = join(cwd, "stdin.jsonl")
  writeFileSync(
    cliPath,
    `#!${process.execPath}
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.322\\n")
  process.exit(0)
}
const emit = (message) => process.stdout.write(JSON.stringify({ session_id: "fake-session", ...message }) + "\\n")
const text = (body) => emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: body } } })
let answered = false
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  fs.appendFileSync(${JSON.stringify(record)}, line + "\\n")
  if (answered) return
  answered = true
  emit({ type: "system", subtype: "init", tools: ["Read"] })
  text("half an answer")
  const after = ${JSON.stringify(finishAfterMs)}
  if (after === null) return
  setTimeout(() => {
    text(" and the rest")
    emit({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done",
      usage: { input_tokens: 1, output_tokens: 1 } })
  }, after)
})
`,
    { mode: 0o755 },
  )
  return {
    cwd,
    cliPath,
    stdinLines: (): any[] =>
      existsSync(record)
        ? readFileSync(record, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
  }
}

async function runTurn(
  fake: ReturnType<typeof createFakeCli>,
  fallbackMs: number,
  onFirstText?: () => void,
): Promise<{ parts: any[]; key: string }> {
  const modelId = "claude-test-result-fallback-sleep"
  const key = sessionKey(fake.cwd, `${modelId}::tools::default::context=["claude-code",null]`)
  const previous = process.env.CLAUDE_CODE_RESULT_FALLBACK_MS
  process.env.CLAUDE_CODE_RESULT_FALLBACK_MS = String(fallbackMs)
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
  const fake = createFakeCli(3_000)
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
  const fake = createFakeCli(null)
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
