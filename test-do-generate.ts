/**
 * `doGenerate`, driven end to end against a fake `claude`.
 *
 * `doGenerate` used to be a second copy of `doStreamForHost`'s line parser
 * with no test of its own, which is how it drifted: no inactivity watchdog, no
 * `/claude-code-doctor`, no proxy wiring, no auto-continue. It is now
 * `doStream` aggregated (`doGenerateViaStream`), so these tests exist to pin
 * what the deleted copy guaranteed and the stream path must keep doing:
 *
 *  - a plain text answer, with the session id, usage and metadata it reported
 *  - a CLI-executed tool call, in the tools scope, with the proxy off
 *  - the title stub, answered without spawning anything at all
 *  - a compaction call, on its own lean spawn and its own model
 *  - the issue-#29 gate: a tool result this CLI never issued reaches the
 *    prompt as `<opencode_tool_result>` text, never as a `tool_result` block
 *  - the opencode 2 tool vocabulary, applied once: `bash` leaves as `shell`
 *
 * Usage: npx tsx --test test-do-generate.ts
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClaudeCode } from "./src/index.js"
import { setOpencodeClient } from "./src/runtime-status.js"
import {
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  killAllActiveProcesses,
  sessionKey,
} from "./src/session-manager.js"
import { synthesizeTitle } from "./src/title.js"

/** The live tool registry is consulted on every turn; answer it with nothing. */
setOpencodeClient({ tool: { list: async () => ({ data: [] }) } })

const MODEL = "claude-haiku-4-5"
const COMPACTION_MODEL = "claude-haiku-4-5"

/**
 * A fake `claude` that answers one turn with whatever lines the test asked
 * for, and appends its argv plus the stdin envelope it was handed. Both
 * `--version` and `--help` are answered and exit, because the version gate and
 * the `--plugin-dir` probe run before any turn does.
 */
function createFakeCli(lines: unknown[]) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-do-generate-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const record = join(cwd, "spawns.jsonl")
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")

if (process.argv.includes("--version")) {
  process.stdout.write("2.1.280\\n")
  process.exit(0)
}
if (process.argv.includes("--help")) {
  process.stdout.write("Usage: claude [options]\\n  --plugin-dir <path>  Load a plugin\\n")
  process.exit(0)
}

const LINES = ${JSON.stringify(lines)}
let answered = false
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (answered) return
  answered = true
  fs.appendFileSync(
    ${JSON.stringify(record)},
    JSON.stringify({ argv: process.argv.slice(2), stdin: line }) + "\\n",
  )
  for (const l of LINES) process.stdout.write(JSON.stringify(l) + "\\n")
})
`,
  )
  chmodSync(cliPath, 0o755)
  return {
    cliPath,
    cwd,
    spawns: (): Array<{ argv: string[]; stdin: string }> =>
      existsSync(record)
        ? readFileSync(record, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  }
}

const SESSION = "fake-session-id"

/** The frames a served turn emits: init, some content, then the result. */
function servedLines(content: unknown[]): unknown[] {
  return [
    { type: "system", subtype: "init", session_id: SESSION, tools: [] },
    {
      type: "assistant",
      session_id: SESSION,
      message: { role: "assistant", model: MODEL, stop_reason: "end_turn", content },
    },
    {
      type: "result",
      subtype: "success",
      session_id: SESSION,
      is_error: false,
      duration_ms: 12,
      duration_api_ms: 9,
      num_turns: 1,
      total_cost_usd: 0.0004,
      usage: { input_tokens: 11, output_tokens: 7 },
    },
  ]
}

const TOOLS = [
  {
    type: "function",
    name: "bash",
    description: "Run a command",
    inputSchema: { type: "object", properties: {} },
  },
]

function modelFor(
  fake: ReturnType<typeof createFakeCli>,
  settings: Record<string, unknown> = {},
) {
  return createClaudeCode({
    cliPath: fake.cliPath,
    baseCliPath: fake.cliPath,
    cwd: fake.cwd,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    autoContinueIncompleteTurns: false,
    ...settings,
  }).languageModel(MODEL)
}

/** Every session key a test in this file can leave a process or id under. */
async function release(cwd: string): Promise<void> {
  for (const key of [
    sessionKey(cwd, `${MODEL}::tools::default::context=["claude-code",null]`),
    sessionKey(cwd, `${MODEL}::no-tools::default::context=["claude-code",null]`),
    sessionKey(cwd, `${COMPACTION_MODEL}::compaction::default`),
  ]) {
    await deleteActiveProcessAndWait(key)
    deleteClaudeSessionId(key)
  }
}

const prompt = [{ role: "user", content: [{ type: "text", text: "say hello" }] }]

// Every spawn here is a real child of the test process: a key this file did
// not predict would keep the runner alive after the last assertion.
after(() => killAllActiveProcesses())

const argvValue = (argv: string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag)
  return at === -1 ? undefined : argv[at + 1]
}

test("doGenerate returns a plain text answer with the turn's session id, usage and metadata", async () => {
  const fake = createFakeCli(servedLines([{ type: "text", text: "hello there" }]))
  try {
    const result = await modelFor(fake).doGenerate({ prompt, tools: TOOLS } as any)

    assert.equal(result.content.length, 1)
    assert.deepEqual(result.content[0], {
      type: "text",
      text: "hello there",
      providerMetadata: result.providerMetadata,
    } as any)
    assert.equal(result.finishReason.unified, "stop")
    assert.equal(result.usage.inputTokens?.total, 11)
    assert.equal(result.usage.outputTokens?.total, 7)
    // The deleted copy reported the claude session id as the response id, and
    // put the same three fields in the metadata. Both still hold.
    assert.equal(result.response?.id, SESSION)
    const meta = (result.providerMetadata as any)["claude-code"]
    assert.equal(meta.sessionId, SESSION)
    assert.equal(meta.costUsd, 0.0004)
    assert.equal(meta.durationMs, 12)
    // The request body is the envelope the CLI was handed, as before.
    assert.match(String((result.request as any).body.text), /say hello/)
    assert.equal(fake.spawns().length, 1)
  } finally {
    await release(fake.cwd)
    fake.cleanup()
  }
})

test("doGenerate returns a CLI-executed tool call in the tools scope with the proxy off", async () => {
  const fake = createFakeCli(
    servedLines([
      { type: "text", text: "running it" },
      {
        type: "tool_use",
        id: "toolu_bash_1",
        name: "Bash",
        input: { command: "echo hi", description: "Say hi" },
      },
    ]),
  )
  try {
    const result = await modelFor(fake).doGenerate({ prompt, tools: TOOLS } as any)

    const calls = result.content.filter((part) => part.type === "tool-call") as any[]
    assert.equal(calls.length, 1)
    assert.equal(calls[0].toolName, "bash")
    assert.equal(calls[0].toolCallId, "toolu_bash_1")
    assert.deepEqual(JSON.parse(calls[0].input), {
      command: "echo hi",
      description: "Say hi",
    })
    // The CLI ran it; opencode only renders the row.
    assert.equal(calls[0].providerExecuted, true)
    // A CLI-executed tool is not work for the outer loop, so the turn still
    // ends on `stop`, exactly as the deleted copy ended it.
    assert.equal(result.finishReason.unified, "stop")
    // Proxy off means no bridged MCP config on the spawn.
    assert.equal(fake.spawns()[0].argv.includes("--mcp-config"), false)
  } finally {
    await release(fake.cwd)
    fake.cleanup()
  }
})

test("doGenerate answers a title request with the synthetic stub and spawns nothing", async () => {
  const fake = createFakeCli(servedLines([{ type: "text", text: "unreachable" }]))
  try {
    const result = await modelFor(fake).doGenerate({ prompt } as any)

    assert.deepEqual(
      result.content.map((part) => (part as any).text),
      [synthesizeTitle(prompt as any)],
    )
    assert.equal(result.finishReason.unified, "stop")
    assert.equal(result.usage.inputTokens?.total, 0)
    assert.equal(result.usage.outputTokens?.total, 0)
    assert.deepEqual((result.providerMetadata as any)["claude-code"], {
      synthetic: true,
      path: "no-tools",
    })
    assert.equal((result.request as any).body.text, "")
    // A title costs nothing because it never reaches the CLI.
    assert.equal(fake.spawns().length, 0)
  } finally {
    await release(fake.cwd)
    fake.cleanup()
  }
})

test("doGenerate runs a compaction call on the compaction model's lean spawn", async () => {
  const fake = createFakeCli(servedLines([{ type: "text", text: "the summary" }]))
  try {
    const result = await modelFor(fake).doGenerate({
      prompt: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "second" }] },
        { role: "user", content: [{ type: "text", text: "summarize this" }] },
      ],
      tools: TOOLS,
      providerOptions: { "claude-code": { opencodeAgent: "compaction" } },
    } as any)

    assert.deepEqual(
      result.content.map((part) => (part as any).text),
      ["the summary"],
    )
    const spawn = fake.spawns()[0]
    assert.equal(argvValue(spawn.argv, "--model"), COMPACTION_MODEL)
    // Compaction gets no MCP, no proxy and no skills staged.
    assert.equal(spawn.argv.includes("--mcp-config"), false)
    assert.equal(spawn.argv.includes("--plugin-dir"), false)
    assert.equal(
      (result.providerMetadata as any)["claude-code"].compactionModel,
      COMPACTION_MODEL,
    )
  } finally {
    await release(fake.cwd)
    fake.cleanup()
  }
})

test("doGenerate sends an opencode-side tool result as text, never as a tool_result block", async () => {
  const fake = createFakeCli(servedLines([{ type: "text", text: "noted" }]))
  try {
    await modelFor(fake).doGenerate({
      prompt: [
        { role: "user", content: [{ type: "text", text: "run it" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_opencode_ran_this",
              toolName: "bash",
              input: { command: "echo hi" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_opencode_ran_this",
              toolName: "bash",
              output: { type: "text", value: "hi" },
            },
          ],
        },
        { role: "user", content: [{ type: "text", text: "and now?" }] },
      ],
      tools: TOOLS,
    } as any)

    // Nothing wired a proxy for this key, so this CLI process issued no
    // tool_use at all and the id cannot be paired (issue #29).
    const stdin = fake.spawns()[0].stdin
    assert.equal(stdin.includes('<opencode_tool_result tool=\\"bash\\">'), true, stdin)
    assert.equal(stdin.includes('"type":"tool_result"'), false)
  } finally {
    await release(fake.cwd)
    fake.cleanup()
  }
})

test("doGenerate on a V2 host returns the tool call in opencode 2's vocabulary", async () => {
  const fake = createFakeCli(
    servedLines([
      {
        type: "tool_use",
        id: "toolu_bash_v2",
        name: "Bash",
        input: { command: "echo hi", description: "Say hi", timeout: 5000 },
      },
    ]),
  )
  try {
    const result = await modelFor(fake, { hostApi: "v2" }).doGenerate({
      prompt,
      tools: TOOLS,
    } as any)

    const calls = result.content.filter((part) => part.type === "tool-call") as any[]
    assert.equal(calls.length, 1)
    assert.equal(calls[0].toolName, "shell")
    assert.equal(calls[0].toolCallId, "toolu_bash_v2")
    // V2's shell takes no `description`, and the rename happens exactly once.
    assert.deepEqual(JSON.parse(calls[0].input), { command: "echo hi", timeout: 5000 })
  } finally {
    await release(fake.cwd)
    fake.cleanup()
  }
})
