/**
 * The proxied `bash` def offers `background` on opencode 2, and only there
 * (h #g308).
 *
 * Every opencode 2 release has `background` on its `shell` tool (2.0.22 to
 * 2.2.6, read out of the published `@opencode/core` and the installed binary),
 * and `src/host-tools.ts` already passes the field through. opencode 1.19.4's
 * `bash` has no such field. So the overlay is keyed on the host dialect the
 * model was built for, the way `liveTaskSupportsBackground` answers V2:
 *
 *  - on V2 the served `bash` def gains a `background` boolean whose
 *    description says what comes back at once and what arrives later;
 *  - on V1 the served def is byte-identical to the shared default;
 *  - the shared `DEFAULT_PROXY_TOOLS` is never mutated;
 *  - a `background: true` call reaches opencode 2 as `shell` with
 *    `background: true`.
 *
 * The last two are read where they land: the `tools/list` a fake `claude`
 * receives from a real `doStream`, and the tool-call part that stream emits.
 *
 * Usage: npx tsx --test test/shell-background.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { detectCliVersion } from "../src/cli-version.js"
import { createClaudeCode } from "../src/index.js"
import {
  DEFAULT_PROXY_TOOLS,
  SHELL_BACKGROUND_PROPERTY,
  applyShellBackgroundSupport,
} from "../src/proxy-mcp.js"
import { resolvePendingProxyCallById, snapshotPendingProxyCalls } from "../src/proxy-broker.js"
import { setOpencodeClient } from "../src/runtime-status.js"
import { killAllActiveProcesses } from "../src/session-manager.js"

setOpencodeClient({ tool: { list: async () => ({ data: [] }) } })

const bashOf = (tools: Array<{ name: string; inputSchema?: any }>) =>
  tools.find((tool) => tool.name === "bash")

const bashProperties = (tools: Array<{ name: string; inputSchema?: any }>) =>
  Object.keys(bashOf(tools)?.inputSchema?.properties ?? {})

test("on opencode 2 the bash def gains background, and nothing else changes", () => {
  const before = JSON.stringify(DEFAULT_PROXY_TOOLS)
  const served = applyShellBackgroundSupport(DEFAULT_PROXY_TOOLS, "v2")

  assert.deepEqual(bashProperties(served), ["command", "description", "timeout", "background"])
  assert.deepEqual(bashOf(served)?.inputSchema.properties.background, SHELL_BACKGROUND_PROPERTY)
  assert.deepEqual(bashOf(served)?.inputSchema.required, ["command"])
  assert.equal(bashOf(served)?.description, bashOf(DEFAULT_PROXY_TOOLS)?.description)
  // Every other def is the same object, in the same order.
  served.forEach((tool, index) => {
    if (tool.name !== "bash") assert.equal(tool, DEFAULT_PROXY_TOOLS[index])
  })
  // The shared defs are never mutated.
  assert.equal(JSON.stringify(DEFAULT_PROXY_TOOLS), before)
  assert.equal("background" in (bashOf(DEFAULT_PROXY_TOOLS)?.inputSchema.properties ?? {}), false)
})

test("on opencode 1 the list comes back as it went in", () => {
  assert.equal(applyShellBackgroundSupport(DEFAULT_PROXY_TOOLS, "v1"), DEFAULT_PROXY_TOOLS)
  const noBash = DEFAULT_PROXY_TOOLS.filter((tool) => tool.name !== "bash")
  assert.equal(applyShellBackgroundSupport(noBash, "v2"), noBash)
})

test("the field says what comes back at once, what arrives later, and not to poll", () => {
  const description = SHELL_BACKGROUND_PROPERTY.description
  assert.equal(SHELL_BACKGROUND_PROPERTY.type, "boolean")
  // opencode 2.2.6's own immediate answer and its completion message.
  assert.match(description, /shell ID/)
  assert.match(description, /Output is streaming to/)
  assert.match(description, /<shell id="\.\.\." state="\.\.\." command="\.\.\.">/)
  assert.match(description, /Do NOT sleep, poll or loop/)
  // Short: Claude Code truncates long MCP descriptions, so it stays front-loaded.
  assert.ok(description.length < 600, `${description.length} characters`)
})

/**
 * One fake `claude` for the whole file. On its first stdin line it records
 * the `tools/list` its proxy answers into its cwd, then streams one
 * `mcp__opencode_proxy__bash` tool_use and sends that call, with the
 * arguments the test left in `call.json` in the same cwd.
 */
const shared = mkdtempSync(join(tmpdir(), "opencode-shell-background-"))
const cliPath = join(shared, "fake-claude.cjs")
writeFileSync(
  cliPath,
  `#!${process.execPath}
const fs = require("node:fs")
const path = require("node:path")
const readline = require("node:readline")
if (process.argv.includes("--version")) { process.stdout.write("2.1.322\\n"); process.exit(0) }
if (process.argv.includes("--help")) { process.stdout.write("Usage: claude [options]\\n"); process.exit(0) }
const args = process.argv.slice(2)
let proxy
const at = args.indexOf("--mcp-config")
for (let i = at + 1; at >= 0 && i < args.length && !args[i].startsWith("--"); i++) {
  try {
    const entry = JSON.parse(fs.readFileSync(args[i], "utf8")).mcpServers?.opencode_proxy
    if (entry) proxy = entry
  } catch {}
}
const SESSION = "fake-shell-background"
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
const event = (e) => emit({ type: "stream_event", session_id: SESSION, event: e })
const post = (method, params) =>
  fetch(proxy.url, {
    method: "POST",
    headers: { ...proxy.headers, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
let handled = false
readline.createInterface({ input: process.stdin }).on("line", async () => {
  if (handled) return
  handled = true
  const tools = (await (await post("tools/list", {})).json()).result.tools
  fs.writeFileSync(path.join(process.cwd(), "seen.json"), JSON.stringify({ tools }))
  emit({ type: "system", subtype: "init", session_id: SESSION, tools: [] })
  event({ type: "message_start", message: { role: "assistant" } })
  const call = JSON.parse(fs.readFileSync(path.join(process.cwd(), "call.json"), "utf8"))
  event({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_bash_bg", name: "mcp__opencode_proxy__bash", input: {} },
  })
  event({ type: "content_block_stop", index: 0 })
  void post("tools/call", { name: "bash", arguments: call }).catch(() => {})
})
`,
  { mode: 0o755 },
)

// Resolved up front so no test races the probe deadline (h #g181, h #g286).
// Not on Windows, where the shebang shim cannot run and its tests are skipped.
before(async () => {
  if (process.platform === "win32") return
  assert.equal((await detectCliVersion(cliPath))?.raw, "2.1.322")
})

after(() => {
  killAllActiveProcesses()
  rmSync(shared, { recursive: true, force: true })
})

// POSIX-only for the reason every fake-CLI test is: the shim is a shebang
// script made executable with its mode.
const POSIX_ONLY = { skip: process.platform === "win32", timeout: 60_000 }

/** One step of a real `doStream` on a model built for `hostApi`. */
async function runStep(hostApi: "v1" | "v2", call: Record<string, unknown>) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-shell-background-turn-"))
  writeFileSync(join(cwd, "call.json"), JSON.stringify(call))
  try {
    const model = createClaudeCode({
      cliPath,
      baseCliPath: cliPath,
      cwd,
      bridgeOpencodeMcp: false,
      bridgeOpencodeSkills: false,
      proxyOpencodeMcpTools: false,
      proxyTools: ["Bash", "Edit", "Write"],
      autoContinueIncompleteTurns: false,
      ...(hostApi === "v2" ? { hostApi: "v2" } : {}),
    } as any).languageModel("claude-haiku-5-5")
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "start the dev server" }] }],
      tools: [
        { type: "function", name: hostApi === "v2" ? "shell" : "bash", description: "Run", inputSchema: { type: "object" } },
      ],
      abortSignal: AbortSignal.timeout(60_000),
    } as any)
    const parts: any[] = []
    for await (const part of stream as any) parts.push(part)
    const seen = join(cwd, "seen.json")
    return {
      finishReason: parts.find((part) => part.type === "finish")?.finishReason?.unified,
      toolCalls: parts.filter((part) => part.type === "tool-call"),
      tools: (existsSync(seen) ? JSON.parse(readFileSync(seen, "utf8")).tools : []) as any[],
    }
  } finally {
    for (const pending of snapshotPendingProxyCalls()) {
      resolvePendingProxyCallById(pending.toolCallId, { kind: "text", text: "test cleanup" })
    }
    killAllActiveProcesses()
    rmSync(cwd, { recursive: true, force: true })
  }
}

test("a V2 model serves background on bash, and the call reaches opencode as shell", POSIX_ONLY, async () => {
  const step = await runStep("v2", { command: "sleep 15; echo bg-done", background: true })
  assert.deepEqual(bashProperties(step.tools), ["command", "description", "timeout", "background"])
  assert.deepEqual(bashOf(step.tools)?.inputSchema.properties.background, SHELL_BACKGROUND_PROPERTY)

  assert.equal(step.finishReason, "tool-calls")
  assert.equal(step.toolCalls.length, 1)
  assert.equal(step.toolCalls[0].toolName, "shell")
  assert.deepEqual(JSON.parse(step.toolCalls[0].input), {
    command: "sleep 15; echo bg-done",
    background: true,
  })
})

test("a V1 model serves the bash def it always did", POSIX_ONLY, async () => {
  const step = await runStep("v1", { command: "echo hi" })
  const served = bashOf(step.tools)
  const original = bashOf(DEFAULT_PROXY_TOOLS)
  // Byte-identical to the shared default, bar the always-load mark (h #g276).
  assert.deepEqual(served?.inputSchema, original?.inputSchema)
  assert.equal(served?.description, original?.description)
  assert.equal(step.toolCalls[0]?.toolName, "bash")
})
