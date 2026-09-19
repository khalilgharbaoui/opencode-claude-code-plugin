/**
 * Tests for the opt-in `compress` proxy tool: the in-process interceptor
 * path in src/proxy-mcp.ts, the summary/restart store in
 * src/compression-store.ts, and the system-prompt note it drives.
 *
 * Usage:
 *   npx tsx --test test-compress-tool.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import * as http from "node:http"
import { readFileSync, unlinkSync } from "node:fs"

import {
  createProxyMcpServer,
  DEFAULT_PROXY_TOOLS,
  resolveProxyOpencodeToolDefs,
  type ProxyMcpServer,
  type ProxyToolDef,
  type ProxyToolCall,
  type ProxyToolInterceptor,
} from "./src/proxy-mcp.js"
import {
  clearCompression,
  consumeCompressionRestart,
  getCompressionSummary,
  storeCompressionSummary,
} from "./src/compression-store.js"
import { buildAppendedSystemPrompt } from "./src/claude-code-language-model.js"
import { DEFAULT_PROXY_TOOL_NAMES } from "./src/index.js"
import { deleteClaudeSessionId, setClaudeSessionId } from "./src/session-manager.js"

/** The proxy endpoint requires a bearer token; see test-proxy-mcp.ts. */
function post(
  srv: ProxyMcpServer,
  body: unknown,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request(
      srv.url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload).toString(),
          Authorization: `Bearer ${srv.authToken}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) })
          } catch {
            resolve({ status: res.statusCode ?? 0, json: text })
          }
        })
      },
    )
    req.on("error", reject)
    req.write(payload)
    req.end()
  })
}

async function withServer<T>(
  interceptors: Map<string, ProxyToolInterceptor>,
  fn: (srv: ProxyMcpServer) => Promise<T>,
): Promise<T> {
  const srv = await createProxyMcpServer(DEFAULT_PROXY_TOOLS, undefined, interceptors)
  try {
    return await fn(srv)
  } finally {
    await srv.close()
  }
}

test("intercepted tools/call is answered in-process, never queued for opencode", async () => {
  const seen: string[] = []
  const interceptors = new Map<string, ProxyToolInterceptor>([
    ["compress", () => ({ kind: "text", text: "Summary stored." })],
  ])

  await withServer(interceptors, async (srv) => {
    srv.calls.on("call", (call: ProxyToolCall) => {
      seen.push(call.toolName)
      call.resolve({ kind: "text", text: "should never happen" })
    })

    const res = await post(srv, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "compress", arguments: { summary: "did the thing" } },
    })

    assert.equal(res.json.id, 11)
    assert.equal(res.json.error, undefined)
    assert.equal(res.json.result.isError, false)
    assert.match(res.json.result.content[0].text, /Summary stored/)
    assert.deepEqual(seen, [], "interceptor must not reach the broker")
  })
})

// Same rule as every other tools/call path: Claude CLI validates the
// response against the MCP result schema and rejects JSON-RPC error
// envelopes as malformed. The fork version this came from wrote
// `error: {code: -32000}` here, which the CLI would have thrown out.
test("throwing interceptor returns an MCP result with isError, not a JSON-RPC error", async () => {
  const interceptors = new Map<string, ProxyToolInterceptor>([
    [
      "compress",
      () => {
        throw new Error("store unavailable")
      },
    ],
  ])

  await withServer(interceptors, async (srv) => {
    const res = await post(srv, {
      jsonrpc: "2.0",
      id: "req-c",
      method: "tools/call",
      params: { name: "compress", arguments: { summary: "x" } },
    })

    assert.equal(res.status, 200)
    assert.equal(res.json.id, "req-c")
    assert.equal(res.json.error, undefined, "must not be a JSON-RPC error envelope")
    assert.equal(res.json.result.isError, true)
    assert.match(res.json.result.content[0].text, /store unavailable/)
  })
})

test("interceptors leave non-intercepted tools on the broker path", async () => {
  const interceptors = new Map<string, ProxyToolInterceptor>([
    ["compress", () => ({ kind: "text", text: "unused" })],
  ])

  await withServer(interceptors, async (srv) => {
    srv.calls.on("call", (call: ProxyToolCall) => {
      call.resolve({ kind: "text", text: `broker ran ${call.toolName}` })
    })

    const res = await post(srv, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "bash", arguments: { command: "echo hi" } },
    })

    assert.match(res.json.result.content[0].text, /broker ran bash/)
  })
})

// Same call as `Question`: it resets the model's whole working context, so
// it stays something the operator asks for by name in `proxyTools`.
test("compress is in the tool catalogue but off by default", () => {
  const compress = DEFAULT_PROXY_TOOLS.find((t) => t.name === "compress")
  assert.ok(compress, "compress must be defined so proxyTools can name it")
  assert.deepEqual(compress.inputSchema.required, ["summary"])
  assert.equal(
    DEFAULT_PROXY_TOOL_NAMES.some((n) => n.toLowerCase() === "compress"),
    false,
    "compress must stay opt-in",
  )
})

// The fork version cleared the summary inside deleteClaudeSessionId, which
// the reset path calls — so the summary was wiped microseconds before the
// fresh spawn read it and the whole feature did nothing.
test("summary survives the session reset that the compress call triggers", () => {
  const key = "test::compress::survives"
  setClaudeSessionId(key, "claude-session-abc")
  storeCompressionSummary(key, "resolved: shipped the parser fix")

  deleteClaudeSessionId(key)

  assert.equal(getCompressionSummary(key), "resolved: shipped the parser fix")
  clearCompression(key)
})

test("restart is consumed once; the summary stays behind", () => {
  const key = "test::compress::once"
  storeCompressionSummary(key, "summary text")

  assert.equal(consumeCompressionRestart(key), true, "first turn resets")
  assert.equal(consumeCompressionRestart(key), false, "later turns must not")
  assert.equal(
    getCompressionSummary(key),
    "summary text",
    "the summary is prior context for every spawn that follows",
  )

  clearCompression(key)
  assert.equal(getCompressionSummary(key), undefined)
})

test("consumeCompressionRestart is false for a key that never compressed", () => {
  assert.equal(consumeCompressionRestart("test::compress::unknown"), false)
})

function readPrompt(path: string | undefined): string {
  assert.ok(path, "expected a system prompt file")
  const content = readFileSync(path, "utf8")
  unlinkSync(path)
  return content
}

test("system prompt only advertises compress when it is enabled", () => {
  const off = readPrompt(buildAppendedSystemPrompt("/tmp", false, []))
  assert.match(off, /The `compress` tool is NOT available/)

  const on = readPrompt(
    buildAppendedSystemPrompt("/tmp", false, [], { compressEnabled: true }),
  )
  assert.match(on, /mcp__opencode_proxy__compress/)
  assert.doesNotMatch(on, /`compress` tool is NOT available/)
})

test("stored summary is prepended ahead of the runtime note", () => {
  const content = readPrompt(
    buildAppendedSystemPrompt("/tmp", false, ["workspace context"], {
      compressEnabled: true,
      compressionSummary: "we rewrote the broker timeout resolver",
    }),
  )

  const summaryAt = content.indexOf("we rewrote the broker timeout resolver")
  const noteAt = content.indexOf("Runtime environment: Claude Code CLI")
  assert.ok(summaryAt >= 0, "summary must be present")
  assert.ok(noteAt >= 0, "runtime note must be present")
  assert.ok(summaryAt < noteAt, "summary reads as prior context, so it comes first")
})

test("a blank summary is not injected", () => {
  const content = readPrompt(
    buildAppendedSystemPrompt("/tmp", false, [], {
      compressEnabled: true,
      compressionSummary: "   ",
    }),
  )
  assert.doesNotMatch(content, /context was compressed/)
})

// --- forwarding opencode's own tools (`proxyOpencodeTools`) -----------------
//
// opencode-dcp declares a `compress` tool directly rather than through an MCP
// server, so `resolvedProxyMcpTools` (which matches `<server>` /
// `<server>_<tool>`) never forwards it and the model could not obey dcp's
// "you MUST use the `compress` tool now" reminder. These cover the allowlist
// and, most importantly, what happens when both compress tools want the name.

/** A stand-in for what `client.tool.list()` returns on opencode 1.18.31. */
const REGISTRY = [
  { id: "bash", description: "run a command", parameters: { type: "object" } },
  {
    id: "compress",
    description: "compress opencode's conversation",
    parameters: {
      type: "object",
      properties: { instructions: { type: "string" } },
      required: ["instructions"],
    },
  },
]

test("proxyOpencodeTools forwards a named opencode tool with its own schema", () => {
  const defs = resolveProxyOpencodeToolDefs({
    requested: ["compress"],
    items: REGISTRY,
  })

  assert.deepEqual(
    defs.map((d) => d.name),
    ["compress"],
  )
  assert.equal(defs[0].description, "compress opencode's conversation")
  assert.deepEqual(defs[0].inputSchema.required, ["instructions"])
})

test("proxyOpencodeTools is off by default and matches names case-insensitively", () => {
  assert.deepEqual(resolveProxyOpencodeToolDefs({ items: REGISTRY }), [])
  assert.deepEqual(resolveProxyOpencodeToolDefs({ requested: [], items: REGISTRY }), [])

  const defs = resolveProxyOpencodeToolDefs({
    requested: ["Compress"],
    items: REGISTRY,
  })
  assert.deepEqual(
    defs.map((d) => d.name),
    ["compress"],
    "the emitted name is opencode's id, whatever case the operator wrote",
  )
})

test("an unknown name is skipped, and an unreachable registry forwards nothing", () => {
  assert.deepEqual(
    resolveProxyOpencodeToolDefs({ requested: ["nope"], items: REGISTRY }),
    [],
  )
  // Registry silence must not be read as "the tool is gone": nothing is
  // forwarded, and the spawn carries on with its static defs.
  assert.deepEqual(
    resolveProxyOpencodeToolDefs({ requested: ["compress"], items: undefined }),
    [],
  )
})

test("the name collision resolves to the plugin's own compress, not opencode's", () => {
  // Both want the MCP name `compress`. The plugin's def is an interceptor:
  // ensureProxyServer answers it in-process, so a forwarded def sharing the
  // name could never reach opencode at all. It is dropped instead of
  // shadowing, and the operator is told.
  const pluginCompress = DEFAULT_PROXY_TOOLS.find((t) => t.name === "compress")
  assert.ok(pluginCompress)

  const defs = resolveProxyOpencodeToolDefs({
    requested: ["compress"],
    items: REGISTRY,
    taken: new Set([pluginCompress.name]),
  })
  assert.deepEqual(defs, [], "the forwarded def loses the contested name")

  // Nothing else in the list is affected by the collision.
  const alongside = resolveProxyOpencodeToolDefs({
    requested: ["compress", "bash"],
    items: REGISTRY,
    taken: new Set(["compress"]),
  })
  assert.deepEqual(
    alongside.map((d) => d.name),
    ["bash"],
  )
})

test("a forwarded compress is NOT answered by the plugin's interceptor", async () => {
  // The second half of the collision, and the one a def-level check cannot
  // see: with only opencode's `compress` forwarded there is no plugin def to
  // collide with, so an interceptor keyed on the name alone would still
  // answer it in-process and opencode would never run the tool. Registering
  // the interceptor is therefore the caller's decision, not the name's.
  const forwardedOnly: ProxyToolDef[] = [
    { name: "compress", description: "opencode's own", inputSchema: { type: "object" } },
  ]
  const queued: string[] = []

  // interceptCompress === false is what the spawn path passes when the
  // plugin's own def is absent: no interceptors at all.
  const srv = await createProxyMcpServer(forwardedOnly, undefined, new Map())
  srv.calls.on("call", (call: ProxyToolCall) => {
    queued.push(call.toolName)
    call.resolve({ kind: "text", text: "opencode ran it" })
  })
  try {
    const res = await post(srv, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "compress", arguments: { topic: "t" } },
    })
    assert.deepEqual(queued, ["compress"], "it must reach opencode through the broker")
    const text = JSON.stringify(res.json)
    assert.match(text, /opencode ran it/)
    assert.doesNotMatch(
      text,
      /Summary stored/,
      "the in-process reset reply would mean the wrong compress answered",
    )
  } finally {
    await srv.close()
  }
})

test("the runtime note describes whichever compress is actually reachable", () => {
  const forwarded = readPrompt(
    buildAppendedSystemPrompt("/tmp", false, [], {
      opencodeCompressEnabled: true,
    }),
  )
  assert.match(forwarded, /mcp__opencode_proxy__compress/)
  assert.match(
    forwarded,
    /compresses opencode's stored conversation, NOT this Claude Code session/,
    "the two compress different windows and the model must not confuse them",
  )

  // When both are somehow live the plugin's own def holds the name, so the
  // note must describe the session reset, matching the def-level precedence.
  const both = readPrompt(
    buildAppendedSystemPrompt("/tmp", false, [], {
      compressEnabled: true,
      opencodeCompressEnabled: true,
    }),
  )
  assert.match(both, /The reset happens at the start of your NEXT turn/)
  assert.doesNotMatch(both, /NOT this Claude Code session/)
})
