/**
 * A retired model through a real `doStream` (h #g302): a turn on
 * `claude-sonnet-4-5` hands a fake `claude` `--model claude-sonnet-5-5`, warns
 * once and records the replacement as what the session really runs (the
 * sidebar's model line); a `compactionModel` naming it spawns the replacement
 * too. The registry and resolver checks are in `test/retired-model.test.ts`.
 *
 * POSIX-only: the fake CLI is a shebang script (`.github/windows-skipped-tests.txt`).
 *
 * Usage: npx tsx --test test/retired-model-stream.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { _resetRetiredModelReports } from "../src/agent-models.js"
import { detectCliVersion } from "../src/cli-version.js"
import { createClaudeCode } from "../src/index.js"
import { configureLogger, _resetLoggerForTests } from "../src/logger.js"
import { setOpencodeClient } from "../src/runtime-status.js"
import {
  deleteActiveProcessAndWait,
  killAllActiveProcesses,
  snapshotActiveProcesses,
} from "../src/session-manager.js"
import { _setSpawnRecordStorePathForTests, createSpawnRecordReader } from "../src/spawn-record-store.js"

const RETIRED = "claude-sonnet-4-5"
const INSTEAD = "claude-sonnet-5-5"

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
  lines.filter((line) => /WARN/.test(line) && /is retired on the Claude API/.test(line))

setOpencodeClient({ tool: { list: async () => ({ data: [] }) } })

const SESSION = "retired-model-session"
const dir = mkdtempSync(join(tmpdir(), "opencode-retired-model-"))
const cliPath = join(dir, "fake-claude.cjs")
const record = join(dir, "spawns.jsonl")
const spawnRecords = join(dir, "session-spawns.json")

// One fake for the file, run by this Node directly (h #g286), answering the
// probes and one turn per line.
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

const savedCompactionEnv = process.env.CLAUDE_CODE_COMPACTION_MODEL

before(async () => {
  delete process.env.CLAUDE_CODE_COMPACTION_MODEL
  _setSpawnRecordStorePathForTests(spawnRecords)
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (await detectCliVersion(cliPath)) return
  }
  throw new Error("the fake CLI never answered --version")
})

after(async () => {
  if (savedCompactionEnv === undefined) delete process.env.CLAUDE_CODE_COMPACTION_MODEL
  else process.env.CLAUDE_CODE_COMPACTION_MODEL = savedCompactionEnv
  _setSpawnRecordStorePathForTests(null)
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

const TOOLS = [
  { type: "function", name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } },
]

async function runTurn(
  modelId: string,
  affinity: string,
  extra: { compactionModel?: string; opencodeAgent?: string } = {},
): Promise<string[]> {
  const model = createClaudeCode({
    cliPath,
    baseCliPath: cliPath,
    cwd: dir,
    bridgeOpencodeMcp: false,
    bridgeOpencodeSkills: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    autoContinueIncompleteTurns: false,
    liveModelSwitch: false,
    ...(extra.compactionModel ? { compactionModel: extra.compactionModel } : {}),
  }).languageModel(modelId)
  const before = spawns().length
  const { stream } = await model.doStream({
    prompt: [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "second" }] },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ],
    // A tool set, or the turn is a title request and never spawns.
    tools: TOOLS,
    headers: { "x-session-affinity": affinity },
    providerOptions: { "claude-code": { opencodeAgent: extra.opencodeAgent ?? "build" } },
  } as never)
  const reader = stream.getReader()
  for (;;) {
    const { done } = await reader.read()
    if (done) break
  }
  for (const active of snapshotActiveProcesses()) {
    if (active.sessionKey.includes(affinity)) await deleteActiveProcessAndWait(active.sessionKey)
  }
  const after = spawns()
  assert.equal(after.length, before + 1, `${modelId} should spawn once`)
  return after[after.length - 1]!
}

test("a retired model spawns its replacement with one WARN, and the spawn record names the replacement", async () => {
  _resetRetiredModelReports()
  let first: string[] = []
  let second: string[] = []
  const lines = await captureLogs(async () => {
    first = await runTurn(RETIRED, "ses_retired_one")
    second = await runTurn(RETIRED, "ses_retired_two")
  })
  assert.equal(argvValue(first, "--model"), INSTEAD)
  assert.equal(argvValue(second, "--model"), INSTEAD)
  const warned = warnings(lines)
  assert.equal(warned.length, 1, "one WARN per id per process")
  assert.match(warned[0]!, /runs as claude-sonnet-5-5/)

  const recorded = createSpawnRecordReader(() => spawnRecords).read().get("ses_retired_one")
  assert.equal(recorded?.model, INSTEAD, "the sidebar names the model that really runs")

  // The control: a live model is spawned as asked.
  const live = await runTurn(INSTEAD, "ses_live")
  assert.equal(argvValue(live, "--model"), INSTEAD)
})

test("a compactionModel naming the retired model spawns its replacement", async () => {
  const argv = await runTurn("claude-opus-5-5", "ses_compaction", {
    compactionModel: RETIRED,
    opencodeAgent: "compaction",
  })
  assert.equal(argvValue(argv, "--model"), INSTEAD)
})
