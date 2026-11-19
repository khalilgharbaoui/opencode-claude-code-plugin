/**
 * A Claude Code command or skill the CLI listed reaches it as a command
 * (h #g322), read where it lands: the stdin line a fake `claude` receives from
 * a real `doStream`.
 *
 * The store holds what the probe would have read for the fake's folder and
 * config dir: a plugin skill, two plugins sharing a short name, and a
 * built-in. The fake itself never reports anything, so every result here is
 * the first message in the folder, which is where h #g281's report rule kept
 * a plugin's colon name stamped.
 *
 * Usage: npx tsx --test test/claude-commands-stream.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { _resetClaudeCommandStoreForTests, writeCommandEntry } from "../src/claude-commands.js"
import { createClaudeCode } from "../src/index.js"
import { setOpencodeClient } from "../src/runtime-status.js"
import { killAllActiveProcesses } from "../src/session-manager.js"
import { _resetReportedCommandsForTests } from "../src/user-commands.js"

setOpencodeClient({ tool: { list: async () => ({ data: [] }) } })

const SUFFIX = Math.random().toString(36).slice(2, 8)
const CARDS = `cards-${SUFFIX}`
const PLUGIN_SKILL = `stripe-${SUFFIX}:${CARDS}`
const SHARED = `release-${SUFFIX}`

let savedConfigDir: string | undefined

beforeEach(() => {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
})

afterEach(() => {
  killAllActiveProcesses()
  _resetReportedCommandsForTests()
  _resetClaudeCommandStoreForTests()
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
})

function createFakeCli() {
  const root = mkdtempSync(join(tmpdir(), "opencode-claude-commands-cli-"))
  const cwd = join(root, "project")
  const configDir = join(root, "config")
  mkdirSync(cwd, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  // The turn reads its config dir the way a spawn would: `CLAUDE_CONFIG_DIR`.
  process.env.CLAUDE_CONFIG_DIR = configDir
  _resetClaudeCommandStoreForTests(join(root, "state", "claude-commands.json"))
  writeCommandEntry({
    configDir,
    cwd,
    probedAt: 1,
    commands: [
      { name: PLUGIN_SKILL, description: "(stripe) cards" },
      { name: `one-${SUFFIX}:${SHARED}` },
      { name: `two-${SUFFIX}:${SHARED}` },
      { name: "model", builtin: true },
    ],
  })
  const cliPath = join(root, "fake-claude.cjs")
  const record = join(root, "stdin.log")
  writeFileSync(
    cliPath,
    `#!${process.execPath}
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.322 (Claude Code)\\n")
  process.exit(0)
}
const SESSION = ${JSON.stringify(`claude-${SUFFIX}`)}
const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let parsed
  try { parsed = JSON.parse(line) } catch { return }
  if (parsed.type !== "user") return
  fs.appendFileSync(${JSON.stringify(record)}, line + "\\n")
  out({ type: "system", subtype: "init", session_id: SESSION, tools: [], slash_commands: ["model"] })
  out({
    type: "assistant",
    session_id: SESSION,
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
  })
  out({ type: "result", subtype: "success", session_id: SESSION, is_error: false, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } })
})
`,
  )
  chmodSync(cliPath, 0o755)
  return {
    cliPath,
    cwd,
    envelopes: (): any[] =>
      existsSync(record)
        ? readFileSync(record, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

type Fake = ReturnType<typeof createFakeCli>

async function turn(fake: Fake, affinity: string, text: string, settings: Record<string, unknown> = {}) {
  const model = createClaudeCode({
    cliPath: fake.cliPath,
    cwd: fake.cwd,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    autoContinueIncompleteTurns: false,
    ...settings,
  }).languageModel("claude-haiku-5-5")
  const { stream } = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text }] }],
    headers: { "x-session-affinity": affinity },
    // A call with no tools is a title request, answered by a stub.
    tools: [{ type: "function", name: "read", description: "Read a file", inputSchema: { type: "object" } }],
    abortSignal: AbortSignal.timeout(60_000),
  } as any)
  const reader = stream.getReader()
  while (!(await reader.read()).done) {}
  killAllActiveProcesses()
  return fake.envelopes().at(-1)
}

test("a listed plugin skill runs as typed on the first message in a folder, under its full name or its short one", async () => {
  const fake = createFakeCli()
  try {
    const picked = await turn(fake, "ses_cc_a", `/${PLUGIN_SKILL} visa`)
    assert.equal("client_composed" in picked, false, "listed by the probe: no report needed")
    assert.equal(picked.message.content.at(-1).text, `/${PLUGIN_SKILL} visa`)

    const typed = await turn(fake, "ses_cc_b", `/${CARDS} visa`)
    assert.equal("client_composed" in typed, false)
    assert.equal(typed.message.content.at(-1).text, `/${PLUGIN_SKILL} visa`, "the short name goes out as the full one")
  } finally {
    fake.cleanup()
  }
})

test("an ambiguous or unknown short name, and a built-in, leave exactly as typed and stamped", async () => {
  const fake = createFakeCli()
  try {
    for (const [affinity, text] of [
      ["ses_cc_c", `/${SHARED} now`],
      ["ses_cc_d", `/unknown-${SUFFIX} now`],
      ["ses_cc_e", "/model claude-sonnet-5-5"],
    ]) {
      const envelope = await turn(fake, affinity!, text!)
      assert.equal(envelope.client_composed, true, text)
      assert.equal(envelope.message.content.at(-1).text, text)
    }
  } finally {
    fake.cleanup()
  }
})

test("claudeCommands: false leaves every message as typed; verbatimPrompts: false still gets the full name", async () => {
  const fake = createFakeCli()
  try {
    const off = await turn(fake, "ses_cc_f", `/${CARDS} visa`, { claudeCommands: false })
    assert.equal(off.client_composed, true)
    assert.equal(off.message.content.at(-1).text, `/${CARDS} visa`)
    const offFull = await turn(fake, "ses_cc_g", `/${PLUGIN_SKILL} visa`, { claudeCommands: false })
    assert.equal(offFull.client_composed, true, "no list, no report: h #g281's rule")

    const unstamped = await turn(fake, "ses_cc_h", `/${CARDS} visa`, { verbatimPrompts: false })
    assert.equal("client_composed" in unstamped, false)
    assert.equal(unstamped.message.content.at(-1).text, `/${PLUGIN_SKILL} visa`)
  } finally {
    fake.cleanup()
  }
})
