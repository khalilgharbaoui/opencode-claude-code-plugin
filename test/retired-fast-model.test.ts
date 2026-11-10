/**
 * A retired fast-mode id (h #g298): `claude-opus-4-8-fast`, whose fast mode
 * Anthropic removed on 2026-11-30 (Claude Code 2.1.316's CHANGELOG: a fast
 * request on Opus 4.8 then "return[s] an error and do[es] not fall back").
 *
 * It is no longer registered, and every place the plugin resolves a model
 * itself still takes it and runs Opus 4.8 at standard speed with one WARN:
 * `parseModelId`, `qualifyModelName` (so `forceModel`, `defaultSubagentModel`
 * and `fallbackModels`), and through a fake CLI the argv a real `doStream`
 * hands `claude`, against a live fast id as the control.
 *
 * Usage: npx tsx --test test/retired-fast-model.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  isRegisteredModelName,
  qualifyModelName,
  resolveAgentModel,
} from "../src/agent-models.js"
import { detectCliVersion } from "../src/cli-version.js"
import { _resetFastModeWarnings, reportRetiredFastModel } from "../src/fast-mode.js"
import { createClaudeCode } from "../src/index.js"
import { configureLogger, _resetLoggerForTests } from "../src/logger.js"
import { resolveFallbackChain } from "../src/model-fallback.js"
import {
  defaultModels,
  parseModelId,
  RETIRED_FAST_MODELS,
  retiredFastModel,
} from "../src/models.js"
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

test("the retired fast id is no longer registered, and the live fast ids still are", () => {
  assert.equal(Object.hasOwn(defaultModels, RETIRED), false)
  assert.deepEqual(RETIRED_FAST_MODELS[RETIRED], {
    removedOn: "2026-11-30",
    instead: "claude-opus-5-5-fast",
  })
  for (const live of [
    "claude-opus-5-fast",
    "claude-opus-5-5-fast",
    "claude-fable-5-2-fast",
    "claude-mythos-5-2-fast",
  ]) {
    assert.ok(Object.hasOwn(defaultModels, live), live)
    assert.equal(retiredFastModel(live), null, live)
  }
  // The base model is untouched: only its fast mode went away.
  assert.ok(Object.hasOwn(defaultModels, "claude-opus-4-8"))
})

test("parseModelId strips a retired fast id's marker and asks for no fast mode", () => {
  assert.deepEqual(parseModelId(RETIRED), { model: "claude-opus-4-8", fast: false })
  assert.deepEqual(parseModelId(`${RETIRED}@work`), { model: "claude-opus-4-8@work", fast: false })
  // A live fast id is unchanged.
  assert.deepEqual(parseModelId("claude-opus-5-5-fast@work"), {
    model: "claude-opus-5-5@work",
    fast: true,
  })
})

test("retiredFastModel reads through the account marker", () => {
  assert.deepEqual(retiredFastModel(`${RETIRED}@work`), {
    model: RETIRED,
    removedOn: "2026-11-30",
    instead: "claude-opus-5-5-fast",
  })
  assert.equal(retiredFastModel("claude-opus-4-8"), null)
  assert.equal(retiredFastModel("claude-something-fast"), null)
})

test("reportRetiredFastModel warns once per id per process and names the replacement", async () => {
  _resetFastModeWarnings()
  const lines = await captureLogs(() => {
    assert.equal(reportRetiredFastModel(RETIRED), true)
    assert.equal(reportRetiredFastModel(`${RETIRED}@work`), true)
    assert.equal(reportRetiredFastModel("claude-opus-5-5-fast"), false)
    assert.equal(reportRetiredFastModel("claude-opus-4-8"), false)
  })
  const warned = warnings(lines)
  assert.equal(warned.length, 1)
  assert.match(warned[0]!, /claude-opus-5-5-fast/)
  assert.match(warned[0]!, /2026-11-30/)
})

test("config naming the retired id still resolves it, where opencode's own completion does not", () => {
  // `forceModel`, `defaultSubagentModel` and `fallbackModels` all go through
  // `qualifyModelName`, which keeps the caller's account marker.
  assert.equal(qualifyModelName(RETIRED, "claude-opus-5@work"), `${RETIRED}@work`)
  assert.equal(
    resolveAgentModel("designer", "claude-opus-5", {
      records: { designer: { mode: "subagent", forceModel: RETIRED } },
    }),
    RETIRED,
  )
  assert.equal(
    resolveAgentModel("helper", "claude-opus-5", {
      records: { helper: { mode: "subagent" } },
      defaultSubagentModel: RETIRED,
    }),
    RETIRED,
  )
  assert.deepEqual(
    resolveFallbackChain("builder", "claude-opus-5", {
      records: { builder: { mode: "primary", fallbackModels: [RETIRED] } },
    }),
    [RETIRED],
  )
  // A per-call subagent model is completed only from registered ids (h #g255),
  // because opencode no longer has this one to resolve.
  assert.equal(isRegisteredModelName(RETIRED), false)
  // An id that never existed is still refused.
  assert.equal(qualifyModelName("claude-opus-4-7-fast", "claude-opus-5"), null)
})

// ---------------------------------------------------------------------------
// Through a real doStream
// ---------------------------------------------------------------------------

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
