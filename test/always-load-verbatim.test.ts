/**
 * What the plugin hands Claude Code so it neither defers the hot proxy tools
 * nor reads a message as typing (h #g276).
 *
 *  - `alwaysLoadProxyTools`: the proxy serves `_meta["anthropic/alwaysLoad"]`
 *    on bash, edit and write by default, on every tool with `true`, on none
 *    with `false`, and on the tools a list names.
 *  - `verbatimPrompts`: every text envelope carries `client_composed: true`
 *    by default, so a `/model x` or `@path` message reaches Claude as written;
 *    an envelope that continues a tool round never does, and `false` writes
 *    the envelope the plugin always wrote.
 *
 * The behaviour is read where it lands: the stdin line and the `tools/list`
 * reply a fake `claude` receives from a real `doStream`.
 *
 * Usage: npx tsx --test test/always-load-verbatim.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeAutoContinueMessage } from "../src/auto-continue.js"
import { createClaudeCode } from "../src/index.js"
import { getClaudeUserMessage } from "../src/message-builder.js"
import {
  ALWAYS_LOAD_META_KEY,
  DEFAULT_ALWAYS_LOAD_PROXY_TOOLS,
  DEFAULT_PROXY_TOOLS,
  applyAlwaysLoad,
  createProxyMcpServer,
} from "../src/proxy-mcp.js"
import { makeLateProxyResultMessage } from "../src/proxy-results.js"
import { setOpencodeClient } from "../src/runtime-status.js"
import { killAllActiveProcesses } from "../src/session-manager.js"
import { userEnvelope } from "../src/user-envelope.js"

setOpencodeClient({ tool: { list: async () => ({ data: [] }) } })

after(() => killAllActiveProcesses())

const alwaysLoaded = (tools: Array<{ name: string; _meta?: Record<string, unknown> }>) =>
  tools.filter((tool) => tool._meta?.[ALWAYS_LOAD_META_KEY] === true).map((tool) => tool.name)

test("userEnvelope stamps client_composed only when asked, and never on a tool round", () => {
  const text = [{ type: "text", text: "/model claude-sonnet-5-5" }]
  assert.equal(
    userEnvelope(text, false),
    JSON.stringify({ type: "user", message: { role: "user", content: text } }),
  )
  assert.deepEqual(JSON.parse(userEnvelope(text, true)), {
    type: "user",
    message: { role: "user", content: text },
    client_composed: true,
  })
  const toolRound = [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }]
  assert.equal(JSON.parse(userEnvelope(toolRound, true)).client_composed, undefined)
})

test("getClaudeUserMessage stamps the envelope only when verbatimPrompts is passed", () => {
  const prompt = [{ role: "user", content: [{ type: "text", text: "@notes.txt what is in it?" }] }] as any
  const plain = JSON.parse(getClaudeUserMessage(prompt))
  assert.equal(plain.client_composed, undefined)
  const verbatim = JSON.parse(getClaudeUserMessage(prompt, false, { verbatimPrompts: true }))
  assert.equal(verbatim.client_composed, true)
  assert.equal(verbatim.message.content.at(-1).text, "@notes.txt what is in it?")
  const empty = JSON.parse(getClaudeUserMessage([] as any, false, { verbatimPrompts: true }))
  assert.equal(empty.client_composed, true)
})

test("the nudge and a late proxy result follow the flag", () => {
  assert.equal(JSON.parse(makeAutoContinueMessage()).client_composed, undefined)
  assert.equal(JSON.parse(makeAutoContinueMessage(true)).client_composed, true)
  const entries = [
    {
      call: { toolName: "bash", toolCallId: "call_1" },
      result: { kind: "text", text: "see @src/index.ts" },
    },
  ] as any
  assert.equal(JSON.parse(makeLateProxyResultMessage(entries)).client_composed, undefined)
  assert.equal(JSON.parse(makeLateProxyResultMessage(entries, true)).client_composed, true)
})

test("applyAlwaysLoad marks bash, edit and write by default and leaves the dispatch tools deferred", () => {
  assert.deepEqual([...DEFAULT_ALWAYS_LOAD_PROXY_TOOLS], ["bash", "edit", "write"])
  assert.deepEqual(alwaysLoaded(applyAlwaysLoad(DEFAULT_PROXY_TOOLS, undefined)), [
    "bash",
    "write",
    "edit",
  ])
  assert.deepEqual(
    alwaysLoaded(applyAlwaysLoad(DEFAULT_PROXY_TOOLS, true)),
    DEFAULT_PROXY_TOOLS.map((tool) => tool.name),
  )
  assert.deepEqual(alwaysLoaded(applyAlwaysLoad(DEFAULT_PROXY_TOOLS, false)), [])
  assert.deepEqual(alwaysLoaded(applyAlwaysLoad(DEFAULT_PROXY_TOOLS, ["Task", "WebFetch"])), [
    "webfetch",
    "task",
  ])
  // Other metadata survives, and the shared defs are never mutated.
  const withMeta = [{ name: "bash", description: "", inputSchema: {}, _meta: { other: 1 } }]
  assert.deepEqual(applyAlwaysLoad(withMeta, undefined)[0]._meta, {
    other: 1,
    [ALWAYS_LOAD_META_KEY]: true,
  })
  assert.deepEqual(withMeta[0]._meta, { other: 1 })
  assert.ok(DEFAULT_PROXY_TOOLS.every((tool) => tool._meta === undefined))
})

test("tools/list serves _meta on a marked tool and nothing extra on the rest", async () => {
  const srv = await createProxyMcpServer(applyAlwaysLoad(DEFAULT_PROXY_TOOLS, undefined))
  try {
    const res = await fetch(srv.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${srv.authToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    const tools = ((await res.json()) as any).result.tools
    const bash = tools.find((tool: any) => tool.name === "bash")
    assert.deepEqual(bash._meta, { [ALWAYS_LOAD_META_KEY]: true })
    const task = tools.find((tool: any) => tool.name === "task")
    assert.equal("_meta" in task, false)
  } finally {
    await srv.close()
  }
})

/**
 * A fake `claude` that, on its first stdin line, records that line plus the
 * `tools/list` its proxy MCP server answers, then serves one turn.
 */
function createFakeCli() {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-always-load-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const record = join(cwd, "seen.jsonl")
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.314\\n")
  process.exit(0)
}
if (process.argv.includes("--help")) {
  process.stdout.write("Usage: claude [options]\\n")
  process.exit(0)
}
const args = process.argv.slice(2)
let proxy
const at = args.indexOf("--mcp-config")
if (at >= 0) {
  for (let i = at + 1; i < args.length && !args[i].startsWith("--"); i++) {
    try {
      const entry = JSON.parse(fs.readFileSync(args[i], "utf8")).mcpServers?.opencode_proxy
      if (entry) proxy = entry
    } catch {}
  }
}
let answered = false
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  if (answered) return
  answered = true
  let tools = null
  if (proxy) {
    const res = await fetch(proxy.url, {
      method: "POST",
      headers: { ...proxy.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    tools = (await res.json()).result.tools
  }
  fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ stdin: line, tools }) + "\\n")
  const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
  out({ type: "system", subtype: "init", session_id: "fake-session", tools: [] })
  out({
    type: "assistant",
    session_id: "fake-session",
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
  })
  out({
    type: "result",
    subtype: "success",
    session_id: "fake-session",
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
    seen: (): Array<{ stdin: string; tools: any[] | null }> =>
      existsSync(record)
        ? readFileSync(record, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
        : [],
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  }
}

const TOOLS = [
  { type: "function", name: "bash", description: "Run a command", inputSchema: { type: "object" } },
]

async function runTurn(settings: Record<string, unknown>, text: string) {
  const fake = createFakeCli()
  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      baseCliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: ["Bash", "Edit", "Write", "WebFetch"],
      autoContinueIncompleteTurns: false,
      ...settings,
    }).languageModel("claude-haiku-4-5")
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text }] }],
      tools: TOOLS,
      abortSignal: AbortSignal.timeout(20_000),
    } as any)
    const reader = stream.getReader()
    while (!(await reader.read()).done) {}
    const seen = fake.seen()
    assert.equal(seen.length, 1)
    return { envelope: JSON.parse(seen[0].stdin), tools: seen[0].tools ?? [] }
  } finally {
    fake.cleanup()
  }
}

test("by default the CLI gets a verbatim envelope and bash, edit and write always loaded", async () => {
  const { envelope, tools } = await runTurn({}, "/model claude-sonnet-5-5")
  assert.equal(envelope.client_composed, true)
  assert.equal(envelope.message.content.at(-1).text, "/model claude-sonnet-5-5")
  assert.deepEqual(alwaysLoaded(tools).sort(), ["bash", "edit", "write"])
  assert.ok(tools.some((tool: any) => tool.name === "webfetch" && !("_meta" in tool)))
})

test("verbatimPrompts and alwaysLoadProxyTools false hand the CLI what it always got", async () => {
  const { envelope, tools } = await runTurn(
    { verbatimPrompts: false, alwaysLoadProxyTools: false },
    "@notes.txt what is in it?",
  )
  assert.equal("client_composed" in envelope, false)
  assert.ok(tools.length > 0)
  assert.ok(tools.every((tool: any) => !("_meta" in tool)))
})

test("a list loads exactly the tools it names", async () => {
  const { tools } = await runTurn({ alwaysLoadProxyTools: ["WebFetch"] }, "hello")
  assert.deepEqual(alwaysLoaded(tools), ["webfetch"])
})
