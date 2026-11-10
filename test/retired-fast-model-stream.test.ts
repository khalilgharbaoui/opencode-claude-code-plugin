/**
 * A retired fast-mode id through a real `doStream` (h #g298): the argv a fake
 * `claude` is handed for `claude-opus-4-8-fast` (`--model claude-opus-4-8`, no
 * fast-mode settings, one WARN) against `claude-opus-5-5-fast` as the control.
 * The registry and resolver checks are in `test/retired-fast-model.test.ts`.
 *
 * POSIX-only: the fake CLI is a shebang script (`.github/windows-skipped-tests.txt`).
 *
 * Usage: npx tsx --test test/retired-fast-model-stream.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { detectCliVersion } from "../src/cli-version.js"
import { _resetFastModeWarnings } from "../src/fast-mode.js"
import { createClaudeCode } from "../src/index.js"
import { configureLogger, _resetLoggerForTests } from "../src/logger.js"
import { setOpencodeClient } from "../src/runtime-status.js"
import {
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  killAllActiveProcesses,
  sessionKey,
} from "../src/session-manager.js"

const RETIRED = "claude-opus-4-8-fast"

/** Everything the logger writes while `fn` runs, debug included. */
async function captureLogs(fn: () => unknown): Promise<string[]> {
  const lines: string[] = []
  const original = console.error
  console.error = (line: unknown) => {
    lines.push(String(line))
  }
  try {
    _resetLoggerForTests()
    configureLogger({ mode: "debug", level: "debug" })
    await fn()
  } finally {
    console.error = original
    _resetLoggerForTests()
  }
  return lines
}

const warnings = (lines: string[]) =>
  lines.filter((line) => /WARN/.test(line) && /fast-mode model id is retired/.test(line))

setOpencodeClient({ tool: { list: async () => ({ data: [] }) } })

const SESSION = "retired-fast-session"
const dir = mkdtempSync(join(tmpdir(), "opencode-retired-fast-"))
const cliPath = join(dir, "fake-claude.cjs")
const record = join(dir, "spawns.jsonl")

// One fake for the file, run by this Node directly (h #g286), answering the
// probes and one turn per process.
writeFileSync(
  cliPath,
  `#!${process.execPath}
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.322\\n")
  process.exit(0)
}
if (process.argv.includes("--help")) {
  process.stdout.write("Usage: claude [options]\\n")
  process.exit(0)
}
readline.createInterface({ input: process.stdin }).on("line", () => {
  fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)) + "\\n")
  const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n")
  out({ type: "system", subtype: "init", session_id: ${JSON.stringify(SESSION)}, tools: [] })
  out({
    type: "assistant",
    session_id: ${JSON.stringify(SESSION)},
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] },
  })
  out({
    type: "result",
    subtype: "success",
    session_id: ${JSON.stringify(SESSION)},
    is_error: false,
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
  })
})
`,
)
chmodSync(cliPath, 0o755)

before(async () => {
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (await detectCliVersion(cliPath)) return
  }
  throw new Error("the fake CLI never answered --version")
})

after(async () => {
  killAllActiveProcesses()
  rmSync(dir, { recursive: true, force: true })
})

function spawns(): string[][] {
  return existsSync(record)
    ? readFileSync(record, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
}

const argvValue = (argv: string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag)
  return at === -1 ? undefined : argv[at + 1]
}

async function runTurn(modelId: string): Promise<string[]> {
  const model = createClaudeCode({
    cliPath,
    baseCliPath: cliPath,
    cwd: dir,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    autoContinueIncompleteTurns: false,
    liveModelSwitch: false,
  }).languageModel(modelId)
  const before = spawns().length
  const { stream } = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
  } as any)
  const reader = stream.getReader()
  for (;;) {
    const { done } = await reader.read()
    if (done) break
  }
  const key = sessionKey(dir, `${modelId}::no-tools::default::context=["claude-code",null]`)
  await deleteActiveProcessAndWait(key)
  deleteClaudeSessionId(key)
  const after = spawns()
  assert.equal(after.length, before + 1, `${modelId} should spawn once`)
  return after[after.length - 1]!
}

test("a retired fast id spawns its model at standard speed with one WARN; a live one keeps fast mode", async () => {
  _resetFastModeWarnings()
  let retiredArgv: string[] = []
  const lines = await captureLogs(async () => {
    retiredArgv = await runTurn(RETIRED)
  })
  assert.equal(argvValue(retiredArgv, "--model"), "claude-opus-4-8")
  assert.ok(
    !retiredArgv.some((arg) => arg.includes("fastMode")),
    `no fast-mode settings expected, got ${JSON.stringify(retiredArgv)}`,
  )
  assert.equal(warnings(lines).length, 1)

  // The control: the same path still asks for fast mode on a live fast id.
  const liveArgv = await runTurn("claude-opus-5-5-fast")
  assert.equal(argvValue(liveArgv, "--model"), "claude-opus-5-5")
  assert.deepEqual(JSON.parse(argvValue(liveArgv, "--settings") ?? "null"), { fastMode: true })
})
