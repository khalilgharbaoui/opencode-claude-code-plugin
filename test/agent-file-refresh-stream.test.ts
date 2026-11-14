/**
 * An edited agent file through a real `doStream` (h #g313): the registry is
 * built from a scratch agent directory the way the config hook builds it, a
 * turn spawns a fake `claude` on the file's `forceModel`, the file is edited,
 * and the next turn of the same session spawns on the new model, with no new
 * set-up of the plugin in between. The registry checks themselves are in
 * `test/agent-models.test.ts`.
 *
 * POSIX-only: the fake CLI is a shebang script (`.github/windows-skipped-tests.txt`).
 *
 * Usage: npx tsx --test test/agent-file-refresh-stream.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  _resetAgentRegistryForTests,
  _setAgentRegistryRecheckMs,
  installAgentRegistry,
} from "../src/agent-models.js"
import { detectCliVersion } from "../src/cli-version.js"
import { createClaudeCode } from "../src/index.js"
import { configureLogger, _resetLoggerForTests } from "../src/logger.js"
import { setOpencodeClient } from "../src/runtime-status.js"
import {
  deleteActiveProcessAndWait,
  killAllActiveProcesses,
  snapshotActiveProcesses,
} from "../src/session-manager.js"

setOpencodeClient({ tool: { list: async () => ({ data: [] }) } })

const SESSION = "agent-file-refresh-session"
const dir = mkdtempSync(join(tmpdir(), "opencode-agent-refresh-"))
const agents = join(dir, "agents")
const cliPath = join(dir, "fake-claude.cjs")
const record = join(dir, "spawns.jsonl")
mkdirSync(agents, { recursive: true })

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

let mtimeBump = 0

/** Write the agent file with an mtime no earlier write shares (see agent-models.test.ts). */
function writeDesigner(forceModel: string): void {
  const file = join(agents, "designer.md")
  writeFileSync(file, ["---", "mode: subagent", `forceModel: ${forceModel}`, "---", "Design things.", ""].join("\n"))
  const at = Math.floor(Date.now() / 1000) + ++mtimeBump * 10
  utimesSync(file, at, at)
}

before(async () => {
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (await detectCliVersion(cliPath)) return
  }
  throw new Error("the fake CLI never answered --version")
})

after(() => {
  _setAgentRegistryRecheckMs(null)
  _resetAgentRegistryForTests()
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

/** One designer turn in one session; the spawn's argv. */
async function designerTurn(text: string): Promise<string[]> {
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
  }).languageModel("claude-opus-5-5")
  const before = spawns().length
  const { stream } = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text }] }],
    // A tool set, or the turn is a title request and never spawns.
    tools: TOOLS,
    headers: { "x-session-affinity": "ses_designer_child" },
    providerOptions: { "claude-code": { opencodeAgent: "designer" } },
  } as never)
  const reader = stream.getReader()
  for (;;) {
    const { done } = await reader.read()
    if (done) break
  }
  for (const active of snapshotActiveProcesses()) {
    if (active.sessionKey.includes("ses_designer_child")) await deleteActiveProcessAndWait(active.sessionKey)
  }
  const after = spawns()
  assert.equal(after.length, before + 1, "one spawn per turn")
  return after[after.length - 1]!
}

test("an agent file edited between two turns spawns the next turn on the new forceModel", async () => {
  _resetAgentRegistryForTests()
  // Every turn looks, so the test does not wait out the two-second window.
  _setAgentRegistryRecheckMs(0)
  writeDesigner("claude-haiku-4-5")
  await installAgentRegistry({ directories: [agents], overlay: {} })

  const first = await designerTurn("first")
  assert.equal(argvValue(first, "--model"), "claude-haiku-4-5")

  writeDesigner("claude-fable-5-2")
  const lines: string[] = []
  const original = console.error
  console.error = (line: unknown) => {
    lines.push(String(line))
  }
  let second: string[] = []
  try {
    _resetLoggerForTests()
    configureLogger({ mode: "debug", level: "debug" })
    second = await designerTurn("second")
  } finally {
    console.error = original
    _resetLoggerForTests()
  }
  assert.equal(argvValue(second, "--model"), "claude-fable-5-2", "the edit applies without a new set-up")
  const notice = lines.find((line) => /agent files changed on disk/.test(line))
  assert.ok(notice, "and it is said")
  assert.match(notice!, /"agent":"designer","key":"forceModel","from":"claude-haiku-4-5","to":"claude-fable-5-2"/)

  // A third turn with nothing changed spawns the same model and says nothing.
  const third = await designerTurn("third")
  assert.equal(argvValue(third, "--model"), "claude-fable-5-2")
})
