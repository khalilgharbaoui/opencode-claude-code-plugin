/**
 * The model probe against a fake `claude` that speaks the control protocol the
 * way 2.1.314 does (h #g279): what each probe spawn is given, that it never
 * sends a user message, that a partial answer writes nothing, the background
 * refresh's once-per-binary rule, and a real `doStream` whose agent forces a
 * model only the CLI's catalog knows.
 *
 * POSIX only: the fake is a `#!/usr/bin/env node` script made executable.
 *
 * Usage: npx tsx --test test/cli-model-probe.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CLI_MODEL_PROBE_ENV,
  REFUSAL_RETRY_MS,
  _resetCliModelCatalogForTests,
  activateCliModelCatalog,
  binaryIdentity,
  probeCliCatalog,
  readCatalogEntries,
  refreshCliModelCatalog,
  writeCatalogEntry,
} from "../src/cli-model-catalog.js"
import { _clearCache } from "../src/cli-version.js"
import { createClaudeCode } from "../src/index.js"
import { _resetAgentRegistryForTests, setAgentRegistry } from "../src/agent-models.js"
import { killAllActiveProcesses } from "../src/session-manager.js"
import { setOpencodeClient } from "../src/runtime-status.js"

let dir: string
const savedSeam = process.env[CLI_MODEL_PROBE_ENV]
const savedKey = process.env.ANTHROPIC_API_KEY

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-model-probe-"))
  _resetCliModelCatalogForTests(join(dir, "state", "cli-models.json"))
  _clearCache()
  delete process.env[CLI_MODEL_PROBE_ENV]
})

afterEach(() => {
  killAllActiveProcesses()
  _resetAgentRegistryForTests()
  setOpencodeClient({} as any)
  _resetCliModelCatalogForTests()
  _clearCache()
  if (savedSeam === undefined) delete process.env[CLI_MODEL_PROBE_ENV]
  else process.env[CLI_MODEL_PROBE_ENV] = savedSeam
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = savedKey
  rmSync(dir, { recursive: true, force: true })
})

interface FakeOptions {
  version?: string
  /** What the picker's `opus` alias resolves to. */
  opus?: string
  /** Known ids: display name, effort levels (null for none), window. */
  known?: Record<string, { name: string; efforts: string[] | null; window: number }>
  /** Ids the fake exits on without answering. */
  fail?: string[]
  /** Ids the fake goes silent on. */
  hang?: string[]
  /** Leave `claude_code_version` out of `initialize`, as 2.1.288 and 2.1.293 do. */
  noVersionInInit?: boolean
  /** Answer every control request with an error, as a CLI that lacks them would. */
  refuse?: boolean
}

function createFakeCli(options: FakeOptions = {}) {
  const cliPath = join(dir, "claude")
  const spawnLog = join(dir, "spawns.log")
  const stdinLog = join(dir, "stdin.log")
  const config = {
    version: options.version ?? "2.1.314",
    opus: options.opus ?? "claude-opus-5-5",
    known: options.known ?? {},
    fail: options.fail ?? [],
    hang: options.hang ?? [],
    noVersionInInit: options.noVersionInInit ?? false,
    refuse: options.refuse ?? false,
    spawnLog,
    stdinLog,
  }
  const source = `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
const C = ${JSON.stringify(config)}
const argv = process.argv.slice(2)
if (argv.includes("--version")) { process.stdout.write(C.version + " (Claude Code)\\n"); process.exit(0) }
const model = argv[argv.indexOf("--model") + 1]
fs.appendFileSync(C.spawnLog, JSON.stringify({ argv, apiKey: process.env.ANTHROPIC_API_KEY ?? null }) + "\\n")
if (C.fail.includes(model)) process.exit(3)
if (C.hang.includes(model)) { setInterval(() => {}, 1000); return }
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
const all = ["low", "medium", "high", "xhigh", "max"]
const picker = [
  { value: "opus", resolvedModel: C.opus, displayName: "Opus", description: "x", supportsEffort: true, supportedEffortLevels: all, supportsFastMode: true },
  { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku", description: "x", supportsEffort: true, supportedEffortLevels: all },
]
function rowFor(id) {
  if (picker.some((row) => row.resolvedModel === id)) return null
  const known = C.known[id]
  if (!known) return { value: id, resolvedModel: id, displayName: id, description: "Custom model", supportsEffort: true, supportedEffortLevels: all }
  return { value: id, resolvedModel: id, displayName: known.name, description: "x", ...(known.efforts ? { supportsEffort: true, supportedEffortLevels: known.efforts } : {}) }
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  fs.appendFileSync(C.stdinLog, JSON.stringify({ type: message.type, subtype: message.request?.subtype ?? null }) + "\\n")
  if (message.type === "control_request" && C.refuse) {
    emit({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "unsupported" } })
  } else if (message.type === "control_request" && message.request.subtype === "initialize") {
    const own = rowFor(model)
    emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {
      ...(C.noVersionInInit ? {} : { claude_code_version: C.version }), account: { tokenSource: "none" }, models: own ? [...picker, own] : picker } } })
  } else if (message.type === "control_request" && message.request.subtype === "get_context_usage") {
    const window = C.known[model]?.window ?? (model === C.opus || model === "claude-haiku-5-5" ? 1000000 : 200000)
    emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { rawMaxTokens: window, maxTokens: window } } })
  } else if (message.type === "user") {
    emit({ type: "system", subtype: "init", session_id: "s-" + process.pid })
    emit({ type: "assistant", session_id: "s-" + process.pid, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } })
    emit({ type: "result", subtype: "success", session_id: "s-" + process.pid, is_error: false, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } })
  }
})
`
  writeFileSync(cliPath, source)
  chmodSync(cliPath, 0o755)
  const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [])
  return {
    cliPath,
    spawns: () => lines(spawnLog).map((line) => JSON.parse(line) as { argv: string[]; apiKey: string | null }),
    stdin: () => lines(stdinLog).map((line) => JSON.parse(line) as { type: string; subtype: string | null }),
  }
}

const KNOWN = {
  "claude-opus-4-6": { name: "Opus 4.6", efforts: ["low", "medium", "high", "max"], window: 200_000 },
  "claude-sonnet-4-5": { name: "Sonnet 4.5", efforts: null, window: 200_000 },
  "claude-opus-4-7": { name: "Opus 4.7", efforts: ["low", "high"], window: 300_000 },
  "claude-opus-5-5": { name: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], window: 1_000_000 },
}

test("each probe spawn is --bare with no credential, is sent two control requests and never a message", async () => {
  const fake = createFakeCli({ known: KNOWN, opus: "claude-opus-9" })
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-reach-the-probe"
  const identity = binaryIdentity(fake.cliPath)!
  const outcome = await probeCliCatalog(fake.cliPath, identity, {
    ids: ["claude-opus-4-6", "claude-sonnet-4-5", "claude-opus-5-5", "claude-sonnet-9-9"],
  })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.spawns, 5, "four catalog ids, then the one the picker added")
  for (const spawn of fake.spawns()) {
    assert.equal(spawn.apiKey, null)
    assert.ok(spawn.argv.includes("--bare"))
    assert.ok(spawn.argv.includes("--input-format"))
  }
  assert.deepEqual(
    [...new Set(fake.stdin().map((line) => `${line.type}/${line.subtype}`))].sort(),
    ["control_request/get_context_usage", "control_request/initialize"],
  )
  const { models, added, cliVersion } = outcome.entry
  assert.equal(cliVersion, "2.1.314")
  assert.deepEqual(models["claude-opus-4-6"], {
    known: true,
    window: 200_000,
    efforts: ["low", "medium", "high", "max"],
    name: "Opus 4.6",
  })
  assert.deepEqual(models["claude-sonnet-4-5"]!.efforts, [])
  assert.equal(models["claude-sonnet-9-9"]!.known, false)
  assert.deepEqual(Object.keys(added), ["claude-opus-9"])
  assert.equal(added["claude-opus-9"]!.window, 1_000_000)
  assert.equal(added["claude-opus-9"]!.fast, true)
})

test("one spawn that never answers writes nothing, and a dead first one costs one spawn", async () => {
  const fake = createFakeCli({ known: KNOWN, fail: ["claude-opus-5-5"] })
  const identity = binaryIdentity(fake.cliPath)!
  const partial = await probeCliCatalog(fake.cliPath, identity, { ids: ["claude-opus-4-6", "claude-opus-5-5"] })
  assert.deepEqual(partial.ok, false)
  if (!partial.ok) assert.equal(partial.reason, "no-answer")

  const before = fake.spawns().length
  const first = await probeCliCatalog(fake.cliPath, identity, { ids: ["claude-opus-5-5", "claude-opus-4-6"] })
  assert.equal(first.ok, false)
  assert.equal(fake.spawns().length - before, 1)
})

test("a probe killed by its own deadline is a failure, not an answer", async () => {
  const fake = createFakeCli({ known: KNOWN, hang: ["claude-opus-4-7"] })
  const identity = binaryIdentity(fake.cliPath)!
  const outcome = await probeCliCatalog(fake.cliPath, identity, {
    ids: ["claude-opus-4-6", "claude-opus-4-7"],
    deadlineMs: 600,
  })
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.reason, "deadline")
})

test("the refresh probes once per binary, keeps the answer, and re-asks only for a new binary or version", async () => {
  const fake = createFakeCli({ known: KNOWN })
  const settings = { cliPath: fake.cliPath }
  let reloads = 0
  const first = await refreshCliModelCatalog(settings, { onLearned: () => void reloads++ })
  assert.equal(first.status, "learned")
  assert.equal(reloads, 1, "a changed catalog asks the host to reload its providers")
  const probes = fake.spawns().length
  assert.ok(probes >= 16, `every catalog id is asked about (${probes})`)
  const [stored] = readCatalogEntries()
  assert.equal(stored!.cliVersion, "2.1.314")
  assert.equal(stored!.models["claude-opus-4-7"]!.window, 300_000)

  // A new process: memory empty, the file there.
  _resetCliModelCatalogForTests(join(dir, "state", "cli-models.json"))
  _clearCache()
  const again = await refreshCliModelCatalog(settings)
  assert.equal(again.status, "current")
  assert.equal(fake.spawns().length, probes, "no probe for a binary already answered")

  // Same file, but the store says another version (a Windows `.cmd` shim stays the same file).
  writeCatalogEntry({ ...stored!, cliVersion: "2.1.1" })
  _resetCliModelCatalogForTests(join(dir, "state", "cli-models.json"))
  _clearCache()
  assert.equal((await refreshCliModelCatalog(settings)).status, "learned")
  assert.ok(fake.spawns().length > probes)
})

test("a CLI that sends no version in initialize is keyed on `claude --version`", async () => {
  const fake = createFakeCli({ known: KNOWN, noVersionInInit: true, version: "2.1.293" })
  const result = await refreshCliModelCatalog({ cliPath: fake.cliPath })
  assert.equal(result.status, "learned")
  assert.equal(readCatalogEntries()[0]!.cliVersion, "2.1.293")
})

test("a refusal is remembered for a day and a deadline kill is not", async () => {
  const fake = createFakeCli({ known: KNOWN, refuse: true })
  const settings = { cliPath: fake.cliPath }
  const first = await refreshCliModelCatalog(settings)
  assert.equal(first.status, "failed")
  assert.equal(fake.spawns().length, 1, "a CLI that cannot be probed costs one spawn")
  const [stored] = readCatalogEntries()
  assert.equal(stored!.refused, "request-refused")
  assert.equal(stored!.cliVersion, "2.1.314")
  assert.deepEqual(stored!.models, {})

  _resetCliModelCatalogForTests(join(dir, "state", "cli-models.json"))
  _clearCache()
  activateCliModelCatalog(settings)
  assert.deepEqual(await refreshCliModelCatalog(settings), {
    status: "current",
    cliVersion: "2.1.314",
    refused: "request-refused",
  })
  assert.equal(fake.spawns().length, 1, "no second spawn inside the day")

  writeCatalogEntry({ ...stored!, probedAt: Date.now() - REFUSAL_RETRY_MS - 1 })
  _resetCliModelCatalogForTests(join(dir, "state", "cli-models.json"))
  _clearCache()
  assert.equal((await refreshCliModelCatalog(settings)).status, "failed")
  assert.equal(fake.spawns().length, 2, "asked again once the day is over")

  rmSync(join(dir, "state"), { recursive: true, force: true })
  _resetCliModelCatalogForTests(join(dir, "state", "cli-models.json"))
  _clearCache()
  const hung = createFakeCli({ known: KNOWN, hang: ["claude-haiku-4-5"] })
  const killed = await refreshCliModelCatalog({ cliPath: hung.cliPath }, { deadlineMs: 400 })
  assert.equal(killed.status, "failed")
  if (killed.status === "failed") assert.equal(killed.reason, "deadline")
  assert.equal(readCatalogEntries().length, 0, "a busy machine is not an answer")
})

test("the refresh does nothing with the option off or the environment seam at 0", async () => {
  const fake = createFakeCli({ known: KNOWN })
  assert.deepEqual(await refreshCliModelCatalog({ cliPath: fake.cliPath, cliModelCatalog: false }), {
    status: "skipped",
    reason: "option-off",
  })
  _resetCliModelCatalogForTests(join(dir, "state", "cli-models.json"))
  process.env[CLI_MODEL_PROBE_ENV] = "0"
  assert.deepEqual(await refreshCliModelCatalog({ cliPath: fake.cliPath }), { status: "skipped", reason: "env-off" })
  assert.equal(fake.spawns().length, 0)
})

test("an agent may force a model only the CLI's catalog knows, through a real doStream", async () => {
  const fake = createFakeCli({ known: KNOWN, opus: "claude-opus-9" })
  setAgentRegistry({ scout: { mode: "subagent", forceModel: "claude-opus-9" } })
  const turn = async () => {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: dir,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: [],
    }).languageModel("claude-opus-4-7")
    const response = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      headers: { "x-session-affinity": `ses_force_${fake.spawns().length}` },
      providerOptions: { "claude-code": { opencodeAgent: "scout" } },
      tools: [{ type: "function", name: "read", description: "Read", inputSchema: { type: "object", properties: {} } }],
    } as any)
    for await (const _part of response.stream) {
      // drain
    }
    const spawn = fake.spawns().at(-1)!
    return spawn.argv[spawn.argv.indexOf("--model") + 1]
  }

  activateCliModelCatalog({ cliPath: fake.cliPath })
  assert.equal(await turn(), "claude-opus-4-7", "an id nothing registered is refused, as before")

  const identity = binaryIdentity(fake.cliPath)!
  const outcome = await probeCliCatalog(fake.cliPath, identity, { ids: ["claude-opus-4-7"] })
  assert.equal(outcome.ok, true)
  if (outcome.ok) writeCatalogEntry(outcome.entry)
  activateCliModelCatalog({ cliPath: fake.cliPath })
  killAllActiveProcesses()
  assert.equal(await turn(), "claude-opus-9")
})
