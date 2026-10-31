/**
 * The operator's own Claude Code commands run as typed while `verbatimPrompts`
 * keeps every other message verbatim (h #g280, h #g281), read where it lands:
 * the stdin line a fake `claude` receives from a real `doStream`.
 *
 * The fake answers every message with a `system`/`init` listing a project
 * command, a plugin's command and the `model` built-in, the way a real
 * `claude` lists them, then a reply and a result. The project command has its
 * file, so it runs as typed from the very first message in the workspace; the
 * plugin's has none, so it waits for a `claude` there to report it; `/model`
 * and plain text always keep the mark.
 *
 * Usage: npx tsx --test test/verbatim-own-commands.test.ts
 */
import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClaudeCode } from "../src/index.js"
import { setOpencodeClient } from "../src/runtime-status.js"
import { killAllActiveProcesses } from "../src/session-manager.js"
import { _resetReportedCommandsForTests } from "../src/user-commands.js"

setOpencodeClient({ tool: { list: async () => ({ data: [] }) } })

afterEach(() => {
  killAllActiveProcesses()
  _resetReportedCommandsForTests()
})

const SUFFIX = Math.random().toString(36).slice(2, 8)
const COMMAND = `hello-probe-${SUFFIX}`
const PLUGIN_COMMAND = `probe-plugin-${SUFFIX}:explain`

function createFakeCli() {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-own-commands-cli-"))
  mkdirSync(join(cwd, ".claude", "commands"), { recursive: true })
  writeFileSync(
    join(cwd, ".claude", "commands", `${COMMAND}.md`),
    "---\ndescription: probe\ndisable-model-invocation: true\n---\nReply with HERON-4.\n",
  )
  const cliPath = join(cwd, "fake-claude.cjs")
  const record = join(cwd, "stdin.log")
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.314 (Claude Code)\\n")
  process.exit(0)
}
const SESSION = ${JSON.stringify(`claude-${cwd.split("-").pop()}`)}
const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let parsed
  try { parsed = JSON.parse(line) } catch { return }
  if (parsed.type !== "user") return
  fs.appendFileSync(${JSON.stringify(record)}, line + "\\n")
  out({
    type: "system",
    subtype: "init",
    session_id: SESSION,
    tools: [],
    slash_commands: [${JSON.stringify(COMMAND)}, ${JSON.stringify(PLUGIN_COMMAND)}, "model", "cost"],
  })
  out({
    type: "assistant",
    session_id: SESSION,
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
  })
  out({
    type: "result",
    subtype: "success",
    session_id: SESSION,
    is_error: false,
    num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
  })
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
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  }
}

type Fake = ReturnType<typeof createFakeCli>

/** One opencode conversation whose user messages are `texts`, in order. */
function conversation(texts: string[]) {
  const prompt: any[] = []
  texts.forEach((text, index) => {
    if (index > 0) prompt.push({ role: "assistant", content: [{ type: "text", text: "done" }] })
    prompt.push({ role: "user", content: [{ type: "text", text }] })
  })
  return prompt
}

async function turn(
  fake: Fake,
  affinity: string,
  texts: string[],
  settings: Record<string, unknown> = {},
) {
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
    prompt: conversation(texts),
    headers: { "x-session-affinity": affinity },
    // A call with no tools is a title request, answered by a stub.
    tools: [{ type: "function", name: "read", description: "Read a file", inputSchema: { type: "object" } }],
    abortSignal: AbortSignal.timeout(20_000),
  } as any)
  const reader = stream.getReader()
  while (!(await reader.read()).done) {}
  return fake.envelopes().at(-1)
}

test("an own command runs as typed from the first message in a folder; built-ins and text keep the mark", async () => {
  const fake = createFakeCli()
  try {
    // Nothing has run in this workspace yet. h #g280 kept the mark here, so a
    // `disable-model-invocation` command like this one did not run at all.
    const first = await turn(fake, "ses_own_a", [`/${COMMAND}`])
    assert.equal("client_composed" in first, false, "the definition file alone decides (h #g281)")
    assert.equal(first.message.content.at(-1).text, `/${COMMAND}`)

    const second = await turn(fake, "ses_own_a", [`/${COMMAND}`, `/${COMMAND} again`])
    assert.equal("client_composed" in second, false)
    assert.equal(second.message.content.at(-1).text, `/${COMMAND} again`)

    const builtin = await turn(fake, "ses_own_a", [
      `/${COMMAND}`,
      `/${COMMAND} again`,
      "/model claude-sonnet-5-5",
    ])
    assert.equal(builtin.client_composed, true)

    const plain = await turn(fake, "ses_own_a", [
      `/${COMMAND}`,
      `/${COMMAND} again`,
      "/model claude-sonnet-5-5",
      `tell me about /${COMMAND}`,
    ])
    assert.equal(plain.client_composed, true)

    const other = await turn(fake, "ses_own_b", [`/${COMMAND}`])
    assert.equal("client_composed" in other, false)
    assert.equal(fake.envelopes().length, 5)
  } finally {
    fake.cleanup()
  }
})

test("a plugin's command, which has no file to check, runs as typed once a claude in the folder reported it", async () => {
  const fake = createFakeCli()
  try {
    const first = await turn(fake, "ses_own_plugin", [`/${PLUGIN_COMMAND} card_declined`])
    assert.equal(first.client_composed, true, "nothing reported yet: fail closed")

    const second = await turn(fake, "ses_own_plugin", [
      `/${PLUGIN_COMMAND} card_declined`,
      `/${PLUGIN_COMMAND} again`,
    ])
    assert.equal("client_composed" in second, false)
  } finally {
    fake.cleanup()
  }
})

test("verbatimPrompts false sends every envelope unstamped, as before", async () => {
  const fake = createFakeCli()
  try {
    await turn(fake, "ses_own_off", [`/${COMMAND}`], { verbatimPrompts: false })
    await turn(fake, "ses_own_off", [`/${COMMAND}`, "/model claude-sonnet-5-5"], {
      verbatimPrompts: false,
    })
    const envelopes = fake.envelopes()
    assert.equal(envelopes.length, 2)
    for (const envelope of envelopes) assert.equal("client_composed" in envelope, false)
  } finally {
    fake.cleanup()
  }
})
