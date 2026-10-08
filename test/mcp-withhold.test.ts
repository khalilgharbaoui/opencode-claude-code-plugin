/**
 * Which opencode MCP servers a spawn gets when `proxyOpencodeMcpTools` is on.
 *
 * Per server: proxied when this agent's tool set holds one of its tools,
 * withheld when opencode has it `connected` but gave this agent none of its
 * tools, and bridged directly only when opencode is not running it. The case
 * that motivated it: an `explore` subagent gets no MCP tools from opencode, so
 * every server used to be bridged straight into its own `claude`, which then
 * started its own copy of each one before `system/init` (31.5 s against 2.1 s
 * on Claude Code 2.1.293) and handed the subagent servers opencode had
 * deliberately withheld from it.
 *
 * Usage: npx tsx --test test/mcp-withhold.test.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { decideMcpServerRoute, resolvedProxyMcpTools } from "../src/spawn-planning.js"
import { setOpencodeClient } from "../src/runtime-status.js"
import type { ClaudeCodeConfig } from "../src/types.js"

// ---------------------------------------------------------------------------
// The per-server decision
// ---------------------------------------------------------------------------

test("a server with a def is proxied, whatever opencode says about it", () => {
  for (const status of ["connected", "failed", "pending", undefined]) {
    assert.equal(
      decideMcpServerRoute({ covered: true, inToolSet: true, status, toolSetKnown: true }),
      "proxy",
    )
  }
})

test("a connected server this agent was given no tool from is withheld", () => {
  assert.equal(
    decideMcpServerRoute({
      covered: false,
      inToolSet: false,
      status: "connected",
      toolSetKnown: true,
    }),
    "withhold",
  )
})

test("a server opencode is not running keeps the direct bridge, for every non-connected status", () => {
  // opencode 1's four refusals, opencode 2's `pending`, and a server the
  // status map does not mention at all.
  for (const status of [
    "failed",
    "needs_auth",
    "needs_client_registration",
    "disabled",
    "pending",
    undefined,
  ]) {
    assert.equal(
      decideMcpServerRoute({ covered: false, inToolSet: false, status, toolSetKnown: true }),
      "bridge",
      `status ${String(status)}`,
    )
  }
})

test("a granted server whose tools all collided stays bridged rather than withheld", () => {
  assert.equal(
    decideMcpServerRoute({
      covered: false,
      inToolSet: true,
      status: "connected",
      toolSetKnown: true,
    }),
    "bridge",
  )
})

test("nothing is withheld when the tool set says nothing about MCP", () => {
  assert.equal(
    decideMcpServerRoute({
      covered: false,
      inToolSet: false,
      status: "connected",
      toolSetKnown: false,
    }),
    "bridge",
  )
})

// ---------------------------------------------------------------------------
// The whole spawn's routing
// ---------------------------------------------------------------------------

function tool(name: string) {
  return { type: "function", name, description: name, inputSchema: { type: "object" } }
}

const ON: ClaudeCodeConfig = { provider: "claude-code", proxyOpencodeMcpTools: true }

test("an explore-shaped agent: connected servers withheld, the rest bridged", () => {
  const routing = resolvedProxyMcpTools(
    ON,
    ["slack", "obsidian", "joining", "unlisted"],
    [tool("read"), tool("grep"), tool("glob")],
    new Set(),
    { slack: "connected", obsidian: "connected", joining: "pending" },
  )
  assert.ok(routing)
  assert.equal(routing.resolution.defs.length, 0)
  assert.deepEqual(routing.withheld, ["slack", "obsidian"])
  assert.deepEqual(routing.bridged, ["joining", "unlisted"])
  assert.deepEqual([...(routing.excludeServers ?? [])].sort(), ["obsidian", "slack"])
})

test("the main agent keeps exactly what it had: every server with tools is proxied", () => {
  const routing = resolvedProxyMcpTools(
    ON,
    ["slack", "obsidian"],
    [tool("read"), tool("slack_channels_list"), tool("obsidian_get_note")],
    new Set(["bash"]),
    { slack: "connected", obsidian: "connected" },
  )
  assert.ok(routing)
  assert.deepEqual(
    routing.resolution.defs.map((def) => def.name),
    ["slack_channels_list", "obsidian_get_note"],
  )
  assert.deepEqual(routing.withheld, [])
  assert.deepEqual(routing.bridged, [])
  assert.deepEqual([...(routing.excludeServers ?? [])].sort(), ["obsidian", "slack"])
})

test("a subagent allowed one server gets that one, proxied, and nothing else", () => {
  const routing = resolvedProxyMcpTools(
    ON,
    ["slack", "postgres"],
    [tool("read"), tool("postgres_query")],
    new Set(),
    { slack: "connected", postgres: "connected" },
  )
  assert.ok(routing)
  assert.deepEqual(routing.resolution.defs.map((def) => def.name), ["postgres_query"])
  assert.deepEqual(routing.withheld, ["slack"])
  assert.deepEqual(routing.bridged, [])
})

test("with no status map (no SDK client) every uncovered server stays bridged, as before", () => {
  const routing = resolvedProxyMcpTools(ON, ["slack", "obsidian"], [tool("read")], new Set())
  assert.ok(routing)
  assert.deepEqual(routing.withheld, [])
  assert.deepEqual(routing.bridged, ["slack", "obsidian"])
  assert.equal(routing.excludeServers, undefined)
})

test("V2 Code Mode withholds nothing, because MCP tools ride inside execute", () => {
  const routing = resolvedProxyMcpTools(
    { ...ON, hostApi: "v2" },
    ["slack"],
    [tool("read"), tool("execute")],
    new Set(),
    { slack: "connected" },
  )
  assert.ok(routing)
  assert.deepEqual(routing.withheld, [])
  assert.deepEqual(routing.bridged, ["slack"])
})

test("an absent or empty tool set withholds nothing", () => {
  for (const tools of [undefined, []]) {
    const routing = resolvedProxyMcpTools(ON, ["slack"], tools, new Set(), {
      slack: "connected",
    })
    assert.ok(routing)
    assert.deepEqual(routing.withheld, [])
    assert.deepEqual(routing.bridged, ["slack"])
  }
})

test("a granted server whose only tool collided with a proxy tool is not withheld", () => {
  const routing = resolvedProxyMcpTools(
    ON,
    ["bash"],
    [tool("read"), tool("bash")],
    new Set(["bash"]),
    { bash: "connected" },
  )
  assert.ok(routing)
  assert.deepEqual(routing.withheld, [])
  assert.deepEqual(routing.bridged, ["bash"])
})

test("the option off decides nothing, so the bridge carries every server", () => {
  assert.equal(
    resolvedProxyMcpTools(
      { provider: "claude-code" },
      ["slack"],
      [tool("read")],
      new Set(),
      { slack: "connected" },
    ),
    null,
  )
  assert.equal(
    resolvedProxyMcpTools(
      { ...ON, bridgeOpencodeMcp: false },
      ["slack"],
      [tool("read")],
      new Set(),
      { slack: "connected" },
    ),
    null,
  )
})

// ---------------------------------------------------------------------------
// What a real spawn's `--mcp-config` holds
// ---------------------------------------------------------------------------

/**
 * Spawn one real turn with `servers` enabled on disk, `status` as opencode's
 * MCP runtime answer and `toolNames` as the agent's tool set, then return the
 * server names of every bridged `--mcp-config` file the CLI was given and how
 * many of the configs were the proxy's own.
 */
async function bridgedForSpawn(input: {
  servers: string[]
  status: Record<string, string>
  toolNames: string[]
  proxyOpencodeMcpTools: boolean
}): Promise<{ bridged: string[]; proxyConfigs: number }> {
  const { createClaudeCode } = await import("../src/index.js")
  const { sessionKey, deleteActiveProcessAndWait, deleteClaudeSessionId } = await import(
    "../src/session-manager.js"
  )
  const id = crypto.randomUUID().slice(0, 8)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-mcp-withhold-"))
  const cwd = path.join(root, "project")
  fs.mkdirSync(cwd, { recursive: true })
  fs.mkdirSync(path.join(root, "opencode"), { recursive: true })
  fs.writeFileSync(
    path.join(root, "opencode", "opencode.json"),
    JSON.stringify({
      mcp: Object.fromEntries(
        input.servers.map((name) => [
          name,
          { type: "remote", url: `https://${name}.invalid/mcp`, enabled: true },
        ]),
      ),
    }),
  )

  const cliPath = path.join(root, `claude-${id}.cjs`)
  const argvPath = path.join(root, `argv-${id}.json`)
  fs.writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) { process.stdout.write("2.1.258\\n"); process.exit(0) }
if (process.argv.includes("--help")) { process.stdout.write("Usage: claude [options]\\n"); process.exit(0) }
fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)))
readline.createInterface({ input: process.stdin }).on("line", () => {
  const session_id = "fake-mcp-withhold-session"
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "assistant", session_id, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id, is_error: false, duration_ms: 1, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n")
})
`,
  )
  fs.chmodSync(cliPath, 0o755)

  const saved = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    OPENCODE_WORKTREE: process.env.OPENCODE_WORKTREE,
    HOME: process.env.HOME,
  }
  process.env.XDG_CONFIG_HOME = root
  process.env.HOME = root
  delete process.env.OPENCODE_CONFIG
  delete process.env.OPENCODE_CONFIG_DIR
  delete process.env.OPENCODE_WORKTREE
  setOpencodeClient({
    mcp: {
      status: async () => ({
        data: Object.fromEntries(
          Object.entries(input.status).map(([name, status]) => [name, { status }]),
        ),
      }),
    },
  })

  const modelId = `claude-test-mcp-withhold-${id}`
  const sk = sessionKey(cwd, `${modelId}::tools::default::context=["claude-code",null]`)
  try {
    const model = createClaudeCode({
      cliPath,
      cwd,
      proxyOpencodeMcpTools: input.proxyOpencodeMcpTools,
      proxyTools: [],
      bridgeOpencodeSkills: false,
      autoContinueIncompleteTurns: false,
      mcpConnectWaitMs: 0,
    }).languageModel(modelId)
    const response = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Say done." }] }],
      tools: input.toolNames.map(tool),
    } as any)
    for await (const _ of response.stream) {
      /* drain */
    }

    const argv = JSON.parse(fs.readFileSync(argvPath, "utf8")) as string[]
    // `--mcp-config <configs...>` is variadic: every argument after the flag
    // belongs to it until the next option.
    const paths: string[] = []
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] !== "--mcp-config") continue
      for (let j = i + 1; j < argv.length && !argv[j]!.startsWith("--"); j += 1) {
        paths.push(argv[j]!)
      }
    }
    let proxyConfigs = 0
    const bridged: string[] = []
    for (const configPath of paths) {
      const names = Object.keys(
        (JSON.parse(fs.readFileSync(configPath, "utf8")).mcpServers ?? {}) as Record<
          string,
          unknown
        >,
      )
      if (names.includes("opencode_proxy")) proxyConfigs += 1
      else bridged.push(...names)
    }
    return { bridged: bridged.sort(), proxyConfigs }
  } finally {
    await deleteActiveProcessAndWait(sk)
    deleteClaudeSessionId(sk)
    setOpencodeClient({})
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
}

// One test, not several: the helper swaps `XDG_CONFIG_HOME`, `HOME` and the
// captured SDK client for the duration of a spawn, so concurrent top-level
// tests could read each other's. Distinct server names per scenario, because
// the bridged config file is content-addressed and reused when present.
test(
  "a spawn omits a connected server its agent was not given, and keeps one opencode is not running",
  { skip: process.platform === "win32", timeout: 30_000 },
  async () => {
    // The subagent: built-in tools only. `ex-conn` is connected in opencode,
    // so it is withheld; `ex-pend` is still connecting and `ex-unlisted` is
    // not in the status map, so both keep the direct bridge.
    const subagent = await bridgedForSpawn({
      servers: ["ex-conn", "ex-pend", "ex-unlisted"],
      status: { "ex-conn": "connected", "ex-pend": "pending" },
      toolNames: ["read", "grep"],
      proxyOpencodeMcpTools: true,
    })
    assert.deepEqual(subagent, { bridged: ["ex-pend", "ex-unlisted"], proxyConfigs: 0 })

    // The main agent: every server's tools are present, so every server is
    // proxied and nothing is bridged. Exactly what it got before.
    const main = await bridgedForSpawn({
      servers: ["mn-a", "mn-b"],
      status: { "mn-a": "connected", "mn-b": "connected" },
      toolNames: ["read", "mn-a_thing", "mn-b_thing"],
      proxyOpencodeMcpTools: true,
    })
    assert.deepEqual(main, { bridged: [], proxyConfigs: 1 })

    // The option off (the default): nothing is decided, everything opencode
    // has enabled is bridged, the connected server included.
    const off = await bridgedForSpawn({
      servers: ["off-conn", "off-pend"],
      status: { "off-conn": "connected", "off-pend": "pending" },
      toolNames: ["read"],
      proxyOpencodeMcpTools: false,
    })
    assert.deepEqual(off, { bridged: ["off-conn", "off-pend"], proxyConfigs: 0 })
  },
)
