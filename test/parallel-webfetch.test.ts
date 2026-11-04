/**
 * `parallelWebfetch` (h #g289): the proxy serves `webfetch` with
 * `readOnlyHint`, so Claude Code sends one reply's fetches together, and the
 * drain waits for the reply's `message_stop` while it holds only read-only
 * calls, so they leave in one opencode step.
 *
 *  - `applyReadOnlyHints` and `tools/list`: the hint on `webfetch` only, kept
 *    beside `_meta`, and nothing with the option off.
 *  - A fake `claude` streaming one reply through a real `doStream`: three
 *    fetches 400 ms apart are one step by default and not with the option
 *    off; a `bash` call drains without waiting for the reply to end; a reply
 *    that never stops is drained at `READ_ONLY_HOLD_CAP_MS`.
 *
 * Usage: npx tsx --test test/parallel-webfetch.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClaudeCode } from "../src/index.js"
import {
  ALWAYS_LOAD_META_KEY,
  DEFAULT_PROXY_TOOLS,
  READ_ONLY_PROXY_TOOLS,
  applyAlwaysLoad,
  applyReadOnlyHints,
  createProxyMcpServer,
} from "../src/proxy-mcp.js"
import { resolvePendingProxyCallById, snapshotPendingProxyCalls } from "../src/proxy-broker.js"
import { setOpencodeClient } from "../src/runtime-status.js"
import { killAllActiveProcesses } from "../src/session-manager.js"
import { READ_ONLY_HOLD_CAP_MS } from "../src/turn-controller.js"

setOpencodeClient({ tool: { list: async () => ({ data: [] }) } })

after(() => killAllActiveProcesses())

const readOnly = (tools: Array<{ name: string; annotations?: Record<string, unknown> }>) =>
  tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name)

test("applyReadOnlyHints marks webfetch only, and nothing when off", () => {
  assert.deepEqual([...READ_ONLY_PROXY_TOOLS], ["webfetch"])
  assert.deepEqual(readOnly(applyReadOnlyHints(DEFAULT_PROXY_TOOLS, true)), ["webfetch"])
  assert.equal(applyReadOnlyHints(DEFAULT_PROXY_TOOLS, false), DEFAULT_PROXY_TOOLS)
  // Kept beside alwaysLoad's _meta and any annotation already there, and the
  // shared defs are never mutated.
  const both = applyReadOnlyHints(applyAlwaysLoad(DEFAULT_PROXY_TOOLS, true), true)
  const webfetch = both.find((tool) => tool.name === "webfetch")!
  assert.equal(webfetch._meta?.[ALWAYS_LOAD_META_KEY], true)
  const titled = [{ name: "webfetch", description: "", inputSchema: {}, annotations: { title: "Fetch" } }]
  assert.deepEqual(applyReadOnlyHints(titled, true)[0].annotations, { title: "Fetch", readOnlyHint: true })
  assert.deepEqual(titled[0].annotations, { title: "Fetch" })
  assert.ok(DEFAULT_PROXY_TOOLS.every((tool) => tool.annotations === undefined))
})

test("tools/list serves the annotation on webfetch and none on the rest", async () => {
  const srv = await createProxyMcpServer(applyReadOnlyHints(DEFAULT_PROXY_TOOLS, true))
  try {
    const res = await fetch(srv.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${srv.authToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    const tools = ((await res.json()) as any).result.tools
    assert.deepEqual(tools.find((tool: any) => tool.name === "webfetch").annotations, {
      readOnlyHint: true,
    })
    assert.ok(tools.filter((tool: any) => tool.name !== "webfetch").every((tool: any) => !("annotations" in tool)))
  } finally {
    await srv.close()
  }
})

interface ScriptedCall {
  name: string
  args: Record<string, unknown>
  /** ms after the reply's `message_start`. */
  at: number
}

/**
 * A fake `claude` that streams one reply holding `calls`, sending each to its
 * proxy at `at` the way 2.1.314 does once the block closes, and writes
 * `message_stop` at `stopAt` (never when null). It records the tools it was
 * served and when it wrote `message_stop`.
 */
function createFakeCli(calls: ScriptedCall[], stopAt: number | null) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-parallel-webfetch-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const record = join(cwd, "seen.json")
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
for (let i = at + 1; at >= 0 && i < args.length && !args[i].startsWith("--"); i++) {
  try {
    const entry = JSON.parse(fs.readFileSync(args[i], "utf8")).mcpServers?.opencode_proxy
    if (entry) proxy = entry
  } catch {}
}
const SESSION = "fake-parallel-webfetch"
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
const event = (e) => emit({ type: "stream_event", session_id: SESSION, event: e })
const post = (method, params) =>
  fetch(proxy.url, {
    method: "POST",
    headers: { ...proxy.headers, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
const seen = {}
const save = () => fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(seen))
let handled = false
readline.createInterface({ input: process.stdin }).on("line", async () => {
  if (handled) return
  handled = true
  seen.tools = (await (await post("tools/list", {})).json()).result.tools
  save()
  emit({ type: "system", subtype: "init", session_id: SESSION, tools: [] })
  event({ type: "message_start", message: { role: "assistant" } })
  const calls = ${JSON.stringify(calls)}
  calls.forEach((call, index) => {
    setTimeout(() => {
      event({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: "toolu_" + index, name: "mcp__opencode_proxy__" + call.name, input: {} },
      })
      event({ type: "content_block_stop", index })
      void post("tools/call", { name: call.name, arguments: call.args }).catch(() => {})
    }, call.at)
  })
  const stopAt = ${JSON.stringify(stopAt)}
  if (stopAt !== null) {
    setTimeout(() => {
      event({ type: "message_stop" })
      seen.messageStopAt = Date.now()
      save()
    }, stopAt)
  }
})
`,
  )
  chmodSync(cliPath, 0o755)
  return {
    cliPath,
    cwd,
    seen: (): { tools?: any[]; messageStopAt?: number } =>
      existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : {},
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  }
}

const TOOLS = [
  { type: "function", name: "bash", description: "Run a command", inputSchema: { type: "object" } },
  { type: "function", name: "webfetch", description: "Fetch a URL", inputSchema: { type: "object" } },
]

const fetchCall = (path: string, at: number): ScriptedCall => ({
  name: "webfetch",
  args: { url: `http://127.0.0.1:9/${path}` },
  at,
})

/** One step of a real `doStream`: the tool calls it ended on and when it ended. */
async function runStep(
  calls: ScriptedCall[],
  stopAt: number | null,
  settings: Record<string, unknown> = {},
) {
  const fake = createFakeCli(calls, stopAt)
  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      baseCliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: ["Bash", "WebFetch"],
      autoContinueIncompleteTurns: false,
      ...settings,
    }).languageModel("claude-haiku-4-5")
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "fetch them" }] }],
      tools: TOOLS,
      abortSignal: AbortSignal.timeout(20_000),
    } as any)
    const parts: any[] = []
    for await (const part of stream as any) parts.push(part)
    const finishedAt = Date.now()
    const finish = parts.find((part) => part.type === "finish")
    return {
      finishReason: finish?.finishReason?.unified,
      toolCalls: parts.filter((part) => part.type === "tool-call").map((part) => JSON.parse(part.input)),
      finishedAt,
      seen: fake.seen(),
    }
  } finally {
    for (const call of snapshotPendingProxyCalls()) {
      resolvePendingProxyCallById(call.toolCallId, { kind: "text", text: "test cleanup" })
    }
    killAllActiveProcesses()
    fake.cleanup()
  }
}

test("by default three fetches of one reply leave in one step", async () => {
  const step = await runStep([fetchCall("a", 50), fetchCall("b", 450), fetchCall("c", 850)], 1000)
  assert.equal(step.finishReason, "tool-calls")
  assert.deepEqual(
    step.toolCalls.map((input) => input.url),
    ["http://127.0.0.1:9/a", "http://127.0.0.1:9/b", "http://127.0.0.1:9/c"],
  )
  assert.deepEqual(readOnly(step.seen.tools ?? []), ["webfetch"])
})

test("parallelWebfetch false serves no hint and drains the first fetch alone", async () => {
  const step = await runStep(
    [fetchCall("a", 50), fetchCall("b", 450), fetchCall("c", 850)],
    1000,
    { parallelWebfetch: false },
  )
  assert.equal(step.finishReason, "tool-calls")
  assert.deepEqual(step.toolCalls.map((input) => input.url), ["http://127.0.0.1:9/a"])
  assert.ok((step.seen.tools ?? []).length > 0)
  assert.ok((step.seen.tools ?? []).every((tool: any) => !("annotations" in tool)))
})

test("a bash call drains without waiting for the reply to end", async () => {
  const step = await runStep([{ name: "bash", args: { command: "echo hi" }, at: 50 }], 1500)
  assert.deepEqual(step.toolCalls.map((input) => input.command), ["echo hi"])
  // The step ended on the quiet window, well before the fake's message_stop.
  assert.equal(step.seen.messageStopAt, undefined)
})

test("a reply that never stops streaming is drained at the cap", async () => {
  const started = Date.now()
  const step = await runStep([fetchCall("a", 50)], null)
  assert.deepEqual(step.toolCalls.map((input) => input.url), ["http://127.0.0.1:9/a"])
  assert.ok(step.finishedAt - started >= READ_ONLY_HOLD_CAP_MS)
})
