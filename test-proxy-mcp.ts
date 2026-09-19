/**
 * Integration tests for src/proxy-mcp.ts — the in-process MCP HTTP server.
 *
 * These stand up a real `createProxyMcpServer` on an ephemeral port and
 * drive it over plain HTTP, so they exercise the actual JSON-RPC framing
 * (including the catch-block error envelope).
 *
 * Usage:
 *   npx tsx --test test-proxy-mcp.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import * as http from "node:http"
import * as fs from "node:fs"
import {
  createProxyMcpServer,
  buildProxyTimeoutError,
  resolveProxyCallTimeoutMs,
  resolveProxyClientCeilingMs,
  overlayQuestionProxyDescription,
  filterQuestionProxyByOpencodeSupport,
  resolveMcpProxyToolDefs,
  formatTaskBatchResults,
  taskBatchChildToolCallId,
  taskBatchInputError,
  taskBatchTasks,
  TASK_BATCH_TOOL_NAME,
  DEFAULT_PROXY_TOOLS,
  PROXY_DEFAULT_TIMEOUT_MS,
  PROXY_NO_DEADLINE_MS,
  MAX_PROXY_TIMEOUT_MS,
  SERVER_CLOSED_MESSAGE,
  type ProxyMcpServer,
  type ProxyToolCall,
  type ProxyToolResult,
} from "./src/proxy-mcp.js"

/**
 * Low-level POST. `headers` REPLACES the default header set, so the
 * security tests below can omit Authorization, send a foreign Host, add an
 * Origin, or use a non-JSON Content-Type. `rawBody` bypasses JSON encoding
 * for the malformed-payload case.
 */
function post(
  url: string,
  body: unknown,
  opts: { headers?: Record<string, string>; rawBody?: string } = {},
): Promise<{
  status: number
  json: any
}> {
  return new Promise((resolve, reject) => {
    const payload = opts.rawBody ?? JSON.stringify(body)
    const req = http.request(
      url,
      {
        method: "POST",
        headers: opts.headers ?? {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload).toString(),
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

/** The happy path: a correctly authenticated JSON-RPC POST. */
function authedPost(srv: ProxyMcpServer, body: unknown) {
  const payload = JSON.stringify(body)
  return post(srv.url, body, {
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload).toString(),
      Authorization: `Bearer ${srv.authToken}`,
    },
  })
}

async function withServer<T>(
  fn: (srv: ProxyMcpServer) => Promise<T>,
): Promise<T> {
  const srv = await createProxyMcpServer(DEFAULT_PROXY_TOOLS)
  try {
    return await fn(srv)
  } finally {
    await srv.close()
  }
}

// Regression for the 2026-07-04 "malformed result that failed schema
// validation" bug: Claude CLI validates tools/call responses against the
// MCP result schema and rejects JSON-RPC error envelopes. Every tools/call
// error path (broker rejection, error result, unknown tool) must return
// an MCP result with `isError: true`, and must echo the request id.
test("tools/call broker rejection returns an MCP result with isError, echoing the id", async () => {
  await withServer(async (srv) => {
    // Reject every incoming call immediately, simulating a broker
    // rejection (the same path a 10-min timeout takes).
    srv.calls.on("call", (call: ProxyToolCall) => {
      call.reject(new Error("simulated broker rejection"))
    })

    const res = await authedPost(srv, {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "bash", arguments: { command: "echo hi" } },
    })

    assert.equal(res.status, 200)
    assert.equal(res.json.jsonrpc, "2.0")
    assert.equal(res.json.id, 42, "response must echo the request id")
    assert.equal(res.json.error, undefined, "must not be a JSON-RPC error envelope")
    assert.ok(res.json.result, "expected an MCP result envelope")
    assert.equal(res.json.result.isError, true)
    assert.match(
      res.json.result.content[0].text,
      /simulated broker rejection/,
    )
  })
})

test("tools/call with kind:error result returns an MCP result with isError", async () => {
  await withServer(async (srv) => {
    srv.calls.on("call", (call: ProxyToolCall) => {
      const result: ProxyToolResult = {
        kind: "error",
        message: "opencode tool execution failed",
      }
      call.resolve(result)
    })

    const res = await authedPost(srv, {
      jsonrpc: "2.0",
      id: "req-7",
      method: "tools/call",
      params: { name: "bash", arguments: {} },
    })

    assert.equal(res.json.id, "req-7")
    assert.equal(res.json.error, undefined)
    assert.equal(res.json.result.isError, true)
    assert.match(
      res.json.result.content[0].text,
      /opencode tool execution failed/,
    )
  })
})

test("tools/call for an unknown tool returns an MCP result with isError", async () => {
  await withServer(async (srv) => {
    const res = await authedPost(srv, {
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "nonexistent_tool", arguments: {} },
    })
    assert.equal(res.json.id, 99)
    assert.equal(res.json.error, undefined)
    assert.equal(res.json.result.isError, true)
    assert.match(res.json.result.content[0].text, /Unknown proxy tool/)
  })
})

test("tools/call success preserves isError:false and the result text", async () => {
  await withServer(async (srv) => {
    srv.calls.on("call", (call: ProxyToolCall) => {
      call.resolve({ kind: "text", text: "done" })
    })
    const res = await authedPost(srv, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "bash", arguments: {} },
    })
    assert.equal(res.json.result.isError, false)
    assert.equal(res.json.result.content[0].text, "done")
  })
})

test("malformed JSON still responds (with null id when unparseable)", async () => {
  await withServer(async (srv) => {
    // Send invalid JSON so parsing throws before requestId is set. The
    // request is otherwise well-formed and authenticated, so it reaches
    // the parser rather than being rejected by the entry guards.
    const res = await post(srv.url, null, {
      rawBody: "{not json",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength("{not json").toString(),
        Authorization: `Bearer ${srv.authToken}`,
      },
    })

    // When the body never parsed, null id is the only honest answer and
    // is correct JSON-RPC (no request id was ever seen).
    assert.equal(res.json.id, null)
    assert.ok(res.json.error)
  })
})

test("tools/list exposes the default proxy defs", async () => {
  await withServer(async (srv) => {
    const res = await authedPost(srv, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    })
    const names = res.json.result.tools.map((t: any) => t.name)
    assert.ok(names.includes("question"))
    assert.ok(names.includes("task"))
    assert.ok(names.includes("bash"))
  })
})

// --- per-tool proxy timeouts ------------------------------------------------

const MIN = 60 * 1000

test("resolveProxyCallTimeoutMs: unknown tool uses the flat 10-min default", () => {
  assert.equal(
    resolveProxyCallTimeoutMs("edit", undefined, undefined),
    PROXY_DEFAULT_TIMEOUT_MS,
  )
})

test("resolveProxyCallTimeoutMs: task and task_batch have no deadline by default", () => {
  // A subagent runs as long as it runs; the call waits for it. Abandoned
  // calls are released by lifecycle events, not by the clock.
  assert.equal(resolveProxyCallTimeoutMs("task", undefined, undefined), PROXY_NO_DEADLINE_MS)
  assert.equal(
    resolveProxyCallTimeoutMs(TASK_BATCH_TOOL_NAME, undefined, undefined),
    PROXY_NO_DEADLINE_MS,
  )
  assert.equal(PROXY_NO_DEADLINE_MS, 0)
})

test("resolveProxyCallTimeoutMs: a 0 override disables a tool's deadline", () => {
  assert.equal(resolveProxyCallTimeoutMs("edit", undefined, { edit: 0 }), 0)
  assert.equal(resolveProxyCallTimeoutMs("question", undefined, { Question: 0 }), 0)
})

test("resolveProxyClientCeilingMs covers the largest effective deadline", () => {
  // No overrides: task has no deadline, and the CLI rejects `timeout: 0`,
  // so the client ceiling is the largest value it (and Node's timers) accept.
  assert.equal(resolveProxyClientCeilingMs(undefined), MAX_PROXY_TIMEOUT_MS)
  // Once every unlimited tool has a positive override, the ceiling tracks
  // the largest effective deadline so Claude's HTTP MCP client never aborts
  // before the broker deadline fires.
  assert.equal(
    resolveProxyClientCeilingMs({ task: 90 * MIN, task_batch: 90 * MIN }),
    90 * MIN,
  )
  // ...and it is the per-tool default that counts when it is the largest.
  assert.equal(
    resolveProxyClientCeilingMs({ task: 5 * MIN, task_batch: 5 * MIN, bash: 1 * MIN }),
    30 * MIN,
  )
  // One unlimited tool is enough to need the maximum: overriding `task`
  // alone leaves `task_batch` without a deadline.
  assert.equal(resolveProxyClientCeilingMs({ task: 90 * MIN }), MAX_PROXY_TIMEOUT_MS)
  // A 0 override on any tool does the same.
  assert.equal(
    resolveProxyClientCeilingMs({ task: 5 * MIN, task_batch: 5 * MIN, bash: 0 }),
    MAX_PROXY_TIMEOUT_MS,
  )
  // Absurd values are clamped to Node's timer max; invalid ones are ignored.
  assert.equal(
    resolveProxyClientCeilingMs({ task: 2 ** 40, task_batch: 2 ** 40 }),
    MAX_PROXY_TIMEOUT_MS,
  )
  assert.equal(
    resolveProxyClientCeilingMs({ task: 5 * MIN, task_batch: 5 * MIN, bash: -1, edit: NaN }),
    30 * MIN,
  )
})

test("resolveProxyCallTimeoutMs: user override replaces the default", () => {
  assert.equal(
    resolveProxyCallTimeoutMs("task", undefined, { task: 5 * MIN }),
    5 * MIN,
  )
})

test("resolveProxyCallTimeoutMs: override key is case-insensitive", () => {
  // Users configure proxyTools with capitalised names ("Task", "Bash"); the
  // override map must match regardless of case.
  assert.equal(
    resolveProxyCallTimeoutMs("task", undefined, { Task: 7 * MIN }),
    7 * MIN,
  )
  assert.equal(
    resolveProxyCallTimeoutMs("bash", undefined, { Bash: 9 * MIN }),
    9 * MIN,
  )
})

test("resolveProxyCallTimeoutMs: bash input.timeout only ever raises", () => {
  // The bash proxy def advertises a `timeout` field; the proxy must not
  // undercut a build the caller explicitly asked to run long.
  assert.equal(
    resolveProxyCallTimeoutMs("bash", { timeout: 25 * MIN }, undefined),
    25 * MIN,
  )
  // A smaller input.timeout never lowers the resolved deadline.
  assert.equal(
    resolveProxyCallTimeoutMs("bash", { timeout: 1000 }, { bash: 5 * MIN }),
    5 * MIN,
  )
  // And it raises above an override too.
  assert.equal(
    resolveProxyCallTimeoutMs("bash", { timeout: 12 * MIN }, { bash: 5 * MIN }),
    12 * MIN,
  )
})

test("resolveProxyCallTimeoutMs: invalid overrides are ignored", () => {
  // Negative / NaN / Infinity must not replace the default: a misformed
  // config entry should never collapse a deadline, nor silently remove one.
  assert.equal(
    resolveProxyCallTimeoutMs("edit", undefined, { edit: -100 }),
    PROXY_DEFAULT_TIMEOUT_MS,
  )
  assert.equal(
    resolveProxyCallTimeoutMs("edit", undefined, { edit: NaN as any }),
    PROXY_DEFAULT_TIMEOUT_MS,
  )
  assert.equal(
    resolveProxyCallTimeoutMs("edit", undefined, { edit: Infinity }),
    PROXY_DEFAULT_TIMEOUT_MS,
  )
  assert.equal(
    resolveProxyCallTimeoutMs("question", undefined, { question: -1 }),
    30 * MIN,
  )
  assert.equal(
    resolveProxyCallTimeoutMs("task", undefined, { task: "60" as any }),
    PROXY_NO_DEADLINE_MS,
  )
})

test("resolveProxyCallTimeoutMs: a bash input.timeout restores a deadline the override disabled", () => {
  // The floor only ever raises, and a disabled deadline is the lowest value
  // there is, so the caller's own timeout wins over `bash: 0`.
  assert.equal(
    resolveProxyCallTimeoutMs("bash", { timeout: 30_000 }, { bash: 0 }),
    30_000,
  )
  assert.equal(resolveProxyCallTimeoutMs("bash", undefined, { bash: 0 }), 0)
})

test("resolveProxyCallTimeoutMs: absurd values are clamped to Node's timer max", () => {
  // Node setTimeout overflows past 2^31-1 ms (~24.85 days), firing at ~1ms.
  // Both an override and a bash input.timeout above the cap must clamp.
  assert.equal(
    resolveProxyCallTimeoutMs("task", undefined, { task: 2 ** 33 }),
    MAX_PROXY_TIMEOUT_MS,
  )
  assert.equal(
    resolveProxyCallTimeoutMs("bash", { timeout: 2 ** 33 }, undefined),
    MAX_PROXY_TIMEOUT_MS,
  )
})

test("buildProxyTimeoutError: generic message keeps the catch-block substrings", () => {
  // proxy-mcp's catch block classifies "timed out after" + "waiting for
  // opencode to resolve" as expected cleanup (notice, not warn). The Task
  // variant must keep both substrings too.
  const generic = buildProxyTimeoutError("bash", 600000)
  assert.match(generic.message, /timed out after 600000ms/)
  assert.match(generic.message, /waiting for opencode to resolve/)
  assert.doesNotMatch(generic.message, /wake-up/)
})

test("buildProxyTimeoutError: task message warns against scheduling a wake-up", () => {
  const task = buildProxyTimeoutError("task", 3600000)
  assert.match(task.message, /timed out after 3600000ms/)
  assert.match(task.message, /waiting for opencode to resolve/)
  assert.match(task.message, /may still be running/)
  assert.match(task.message, /wake-up/)
})

test("buildProxyTimeoutError: task guidance is case-insensitive on the tool name", () => {
  // Config / call sites use mixed casing ("Task"); the matcher lowercases.
  const task = buildProxyTimeoutError("Task", 60000)
  assert.match(task.message, /wake-up/)
  // And a non-task tool with unusual casing stays generic.
  const generic = buildProxyTimeoutError("BASH", 60000)
  assert.doesNotMatch(generic.message, /wake-up/)
})

test("tools/call timeout uses the per-tool override and surfaces the task-specific text", async () => {
  // Stand up a server with a tiny Task deadline and never resolve the call,
  // so the proxy-mcp timer fires and we see the real error envelope that
  // Claude would receive.
  const srv = await createProxyMcpServer(DEFAULT_PROXY_TOOLS, { task: 50 })
  try {
    // Intentionally do NOT attach a calls listener — let the deadline fire.
    const res = await authedPost(srv, {
      jsonrpc: "2.0",
      id: "timeout-1",
      method: "tools/call",
      params: {
        name: "task",
        arguments: { description: "x", subagent_type: "gpt", prompt: "y" },
      },
    })
    assert.equal(res.json.id, "timeout-1")
    assert.equal(res.json.result.isError, true)
    const text = res.json.result.content[0].text
    assert.match(text, /timed out after 50ms/)
    assert.match(text, /wake-up/)
  } finally {
    await srv.close()
  }
})

test("tools/call bash timeout honours input.timeout over a shorter override", async () => {
  // Override says 40ms but the call asks for a 30s bash timeout — the
  // effective deadline must be 30s, so the call must NOT time out within a
  // short window. Resolve it ourselves to end the test promptly.
  const srv = await createProxyMcpServer(DEFAULT_PROXY_TOOLS, { bash: 40 })
  try {
    let resolved = false
    srv.calls.on("call", (call: ProxyToolCall) => {
      // Defer resolution past the 40ms override deadline to prove the
      // input.timeout (30s) is what governs.
      setTimeout(() => {
        resolved = true
        call.resolve({ kind: "text", text: "built" })
      }, 120)
    })
    const res = await authedPost(srv, {
      jsonrpc: "2.0",
      id: "bash-1",
      method: "tools/call",
      params: { name: "bash", arguments: { command: "xcodebuild ...", timeout: 30000 } },
    })
    assert.equal(resolved, true, "call should resolve, not time out")
    assert.equal(res.json.result.isError, false)
    assert.equal(res.json.result.content[0].text, "built")
  } finally {
    await srv.close()
  }
})

// --- question proxy: version gate + description overlay ---------------------

test("question gets a 30-min default deadline (a human has to read the form)", () => {
  assert.equal(
    resolveProxyCallTimeoutMs("question", undefined, undefined),
    30 * MIN,
  )
})

test("resolveProxyClientCeilingMs is always a positive, timer-safe value", () => {
  // The ceiling is written into Claude's --mcp-config entry. It can never be
  // 0 (the CLI rejects the server config) and never above Node's timer max,
  // whatever the overrides say.
  for (const overrides of [undefined, {}, { task: 0 }, { task: 2 ** 40 }, { bash: 1 }]) {
    const ceiling = resolveProxyClientCeilingMs(overrides)
    assert.ok(ceiling > 0, `ceiling must be positive for ${JSON.stringify(overrides)}`)
    assert.ok(ceiling <= MAX_PROXY_TIMEOUT_MS)
    assert.ok(ceiling >= 30 * MIN, "never below the longest positive per-tool default")
  }
})

test("tools/call with no deadline stays pending instead of timing out on the next tick", async () => {
  // A zero deadline must mean "no timer", not `setTimeout(fn, 0)`: the
  // latter rejects the call immediately with "timed out after 0ms".
  const srv = await createProxyMcpServer(DEFAULT_PROXY_TOOLS)
  try {
    let settled: string | null = null
    const callReceived = new Promise<void>((resolve) => srv.calls.once("call", () => resolve()))
    const response = authedPost(srv, {
      jsonrpc: "2.0",
      id: "unlimited-1",
      method: "tools/call",
      params: {
        name: "task",
        arguments: { description: "x", subagent_type: "general", prompt: "y" },
      },
    }).then((res) => {
      settled = String(res.json.result.content[0].text)
      return res
    })
    await callReceived
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(settled, null, "an unlimited call must not be rejected by a timer")
    // Closing the server is one of the lifecycle events that releases it.
    await srv.close()
    const res = await response
    assert.equal(res.json.id, "unlimited-1")
    assert.equal(res.json.result.isError, true)
    assert.equal(res.json.result.content[0].text, SERVER_CLOSED_MESSAGE)
  } finally {
    await srv.close()
  }
})

// --- JSON-only long calls -----------------------------------------------------
//
// Claude's MCP client used to abandon a silent JSON reply at its own HTTP
// timers (~300 s) whatever the per-tool deadline said. SSE clients got
// immediate headers and keepalive comments in 0.15.0; a client that only
// accepts JSON now gets the same liveness as a chunked JSON body.

/** POST and hand back the response as soon as its headers arrive. */
function openPost(
  srv: ProxyMcpServer,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<http.IncomingMessage> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(
      srv.url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload).toString(),
          Authorization: `Bearer ${srv.authToken}`,
          ...extraHeaders,
        },
      },
      resolve,
    )
    req.on("error", reject)
    req.end(payload)
  })
}

function readAll(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    res.on("data", (c: Buffer) => chunks.push(c))
    res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    res.on("error", reject)
  })
}

test("a JSON-only tools/call gets its headers and keepalive whitespace before the result", async () => {
  const srv = await createProxyMcpServer(DEFAULT_PROXY_TOOLS, undefined, undefined, { keepaliveMs: 20 })
  try {
    let call: ProxyToolCall | undefined
    srv.calls.once("call", (c: ProxyToolCall) => { call = c })
    const res = await openPost(srv, {
      jsonrpc: "2.0",
      id: "json-keepalive-1",
      method: "tools/call",
      params: { name: "bash", arguments: { command: "sleep 600" } },
    })
    // Headers are in hand while the call is still pending, with no
    // Content-Length: chunked is what lets whitespace precede the result.
    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers["content-type"]), /^application\/json/)
    assert.equal(res.headers["content-length"], undefined)
    assert.equal(res.headers["transfer-encoding"], "chunked")
    assert.ok(call, "the call reached the broker before the reply finished")

    const chunks: string[] = []
    res.setEncoding("utf8")
    res.on("data", (chunk: string) => chunks.push(chunk))
    await new Promise((r) => setTimeout(r, 90))
    assert.ok(
      chunks.length > 0 && chunks.every((chunk) => chunk.trim() === ""),
      `expected only keepalive whitespace before the result, got ${JSON.stringify(chunks)}`,
    )

    call!.resolve({ kind: "text", text: "late but fine" })
    await new Promise<void>((resolve) => res.once("end", resolve))
    const parsed = JSON.parse(chunks.join(""))
    assert.equal(parsed.id, "json-keepalive-1")
    assert.equal(parsed.result.isError, false)
    assert.equal(parsed.result.content[0].text, "late but fine")
  } finally {
    await srv.close()
  }
})

test("a JSON-only tools/call that fails after its headers went out still ends as valid JSON", async () => {
  const srv = await createProxyMcpServer(DEFAULT_PROXY_TOOLS, undefined, undefined, { keepaliveMs: 10 })
  try {
    srv.calls.once("call", (c: ProxyToolCall) => {
      setTimeout(() => c.reject(new Error("simulated late broker rejection")), 40)
    })
    const res = await openPost(srv, {
      jsonrpc: "2.0",
      id: "json-keepalive-err",
      method: "tools/call",
      params: { name: "bash", arguments: { command: "false" } },
    })
    assert.equal(res.statusCode, 200)
    const body = await readAll(res)
    assert.match(body, /^\s+\{/, "keepalive whitespace precedes the envelope")
    const parsed = JSON.parse(body)
    assert.equal(parsed.id, "json-keepalive-err")
    assert.equal(parsed.error, undefined, "still an MCP result, never a JSON-RPC error envelope")
    assert.equal(parsed.result.isError, true)
    assert.match(parsed.result.content[0].text, /simulated late broker rejection/)
  } finally {
    await srv.close()
  }
})

test("a JSON-only client that hangs up stops its keepalive and the result is dropped, not thrown", async () => {
  const srv = await createProxyMcpServer(DEFAULT_PROXY_TOOLS, undefined, undefined, { keepaliveMs: 10 })
  try {
    const callReceived = new Promise<ProxyToolCall>((resolve) => srv.calls.once("call", resolve))
    const res = await openPost(srv, {
      jsonrpc: "2.0",
      id: "json-keepalive-gone",
      method: "tools/call",
      params: { name: "bash", arguments: { command: "sleep 600" } },
    })
    const call = await callReceived
    assert.equal(call.channel?.closed, false)
    res.destroy()
    await new Promise((r) => setTimeout(r, 50))
    // The reply channel is what the language model reads before answering;
    // the entry itself stays so a late result can still be recovered.
    assert.equal(call.channel?.closed, true)
    // Resolving now must not throw into the server (no write to a dead socket).
    call.resolve({ kind: "text", text: "nobody is listening" })
    await new Promise((r) => setTimeout(r, 30))
  } finally {
    await srv.close()
  }
})

test("protocol methods keep the single-shot JSON reply with a Content-Length", async () => {
  // Only broker-backed tools/call replies are streamed; initialize and
  // tools/list are answered in one write as before.
  await withServer(async (srv) => {
    for (const body of [
      { jsonrpc: "2.0", id: "init", method: "initialize", params: {} },
      { jsonrpc: "2.0", id: "list", method: "tools/list" },
    ]) {
      const res = await openPost(srv, body)
      assert.equal(res.statusCode, 200)
      assert.ok(res.headers["content-length"], `${body.method} must carry a Content-Length`)
      assert.equal(res.headers["transfer-encoding"], undefined)
      const parsed = JSON.parse(await readAll(res))
      assert.equal(parsed.id, body.id)
      assert.ok(parsed.result)
    }
  })
})

test("an SSE client still gets the event-stream reply", async () => {
  await withServer(async (srv) => {
    srv.calls.once("call", (c: ProxyToolCall) => c.resolve({ kind: "text", text: "over sse" }))
    const res = await openPost(
      srv,
      { jsonrpc: "2.0", id: "sse-1", method: "tools/call", params: { name: "bash", arguments: { command: "true" } } },
      { Accept: "application/json, text/event-stream" },
    )
    assert.match(String(res.headers["content-type"]), /^text\/event-stream/)
    const body = await readAll(res)
    const data = body.split("\n").find((line) => line.startsWith("data: "))
    assert.ok(data, "SSE reply carries the JSON-RPC result as a data line")
    assert.equal(JSON.parse(data!.slice(6)).result.content[0].text, "over sse")
  })
})

test("filterQuestionProxyByOpencodeSupport drops the def on older opencode", () => {
  const tools = DEFAULT_PROXY_TOOLS
  assert.ok(tools.some((t) => t.name === "question"))
  const kept = filterQuestionProxyByOpencodeSupport(tools, true)
  assert.ok(kept.some((t) => t.name === "question"))
  const dropped = filterQuestionProxyByOpencodeSupport(tools, false)
  assert.equal(
    dropped.some((t) => t.name === "question"),
    false,
    "no registry entry means a forwarded call would render as invalid",
  )
  // Only `question` is gated; everything else survives untouched.
  assert.ok(dropped.some((t) => t.name === "task"))
  assert.ok(dropped.some((t) => t.name === "bash"))
})

test("overlayQuestionProxyDescription prefers opencode's live description", () => {
  const overlaid = overlayQuestionProxyDescription(
    DEFAULT_PROXY_TOOLS,
    "LIVE question description from opencode",
  )
  const question = overlaid.find((t) => t.name === "question")
  assert.ok(question)
  assert.ok(question.description.startsWith("LIVE question description"))
  // The disambiguation note must survive, it is what tells the model the
  // built-in AskUserQuestion is disabled.
  assert.ok(question.description.includes("AskUserQuestion is disabled"))
})

test("overlayQuestionProxyDescription is a no-op without a live description", () => {
  const before = DEFAULT_PROXY_TOOLS.find((t) => t.name === "question")
  const after = overlayQuestionProxyDescription(
    DEFAULT_PROXY_TOOLS,
    undefined,
  ).find((t) => t.name === "question")
  assert.equal(after?.description, before?.description)
})

// ---------------------------------------------------------------------------
// Entry-guard security tests.
//
// This endpoint executes bash/edit/write through opencode's executor, so an
// unauthenticated caller on loopback would have arbitrary command execution
// as the user. These pin every guard in front of the JSON-RPC body parser.
// ---------------------------------------------------------------------------

const LIST_REQ = { jsonrpc: "2.0", id: 1, method: "tools/list" }

function jsonHeaders(
  payload: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload).toString(),
    ...extra,
  }
}

test("security: a correctly authenticated request is accepted", async () => {
  await withServer(async (srv) => {
    const res = await authedPost(srv, LIST_REQ)
    assert.equal(res.status, 200)
    assert.ok(res.json.result.tools.length > 0)
  })
})

test("security: a wrong bearer token of equal length is rejected with 401", async () => {
  await withServer(async (srv) => {
    // Same length as the real token, so this exercises timingSafeEqual
    // rather than the cheap length short-circuit in front of it.
    const forged = "0".repeat(srv.authToken.length)
    assert.equal(forged.length, srv.authToken.length)
    const payload = JSON.stringify(LIST_REQ)
    const res = await post(srv.url, LIST_REQ, {
      headers: jsonHeaders(payload, { Authorization: `Bearer ${forged}` }),
    })
    assert.equal(res.status, 401)
  })
})

test("security: a short/garbage bearer token is rejected with 401", async () => {
  await withServer(async (srv) => {
    const payload = JSON.stringify(LIST_REQ)
    const res = await post(srv.url, LIST_REQ, {
      headers: jsonHeaders(payload, { Authorization: "Bearer nope" }),
    })
    assert.equal(res.status, 401)
  })
})

test("security: an absent Authorization header is rejected with 401", async () => {
  await withServer(async (srv) => {
    const payload = JSON.stringify(LIST_REQ)
    const res = await post(srv.url, LIST_REQ, { headers: jsonHeaders(payload) })
    assert.equal(res.status, 401)
  })
})

test("security: a foreign Host header is rejected with 403 (DNS rebinding)", async () => {
  await withServer(async (srv) => {
    const payload = JSON.stringify(LIST_REQ)
    const res = await post(srv.url, LIST_REQ, {
      headers: jsonHeaders(payload, {
        Host: "attacker.example",
        Authorization: `Bearer ${srv.authToken}`,
      }),
    })
    assert.equal(res.status, 403)
  })
})

test("security: any Origin header is rejected with 403 (browser context)", async () => {
  await withServer(async (srv) => {
    const payload = JSON.stringify(LIST_REQ)
    const res = await post(srv.url, LIST_REQ, {
      headers: jsonHeaders(payload, {
        Origin: "https://attacker.example",
        Authorization: `Bearer ${srv.authToken}`,
      }),
    })
    assert.equal(res.status, 403)
  })
})

test("security: text/plain is rejected with 415 (CORS simple-request bypass)", async () => {
  await withServer(async (srv) => {
    // text/plain is a CORS "simple request" content type, so a cross-origin
    // page can send it with no preflight. Requiring application/json forces
    // a preflight that then fails.
    const payload = JSON.stringify(LIST_REQ)
    const res = await post(srv.url, LIST_REQ, {
      headers: {
        "Content-Type": "text/plain",
        "Content-Length": Buffer.byteLength(payload).toString(),
        Authorization: `Bearer ${srv.authToken}`,
      },
    })
    assert.equal(res.status, 415)
  })
})

test("security: a Content-Type with charset parameters is still accepted", async () => {
  await withServer(async (srv) => {
    const payload = JSON.stringify(LIST_REQ)
    const res = await post(srv.url, LIST_REQ, {
      headers: jsonHeaders(payload, {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${srv.authToken}`,
      }),
    })
    assert.equal(res.status, 200)
  })
})

test("security: the 401 path answers without reading the request body", async () => {
  await withServer(async (srv) => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        srv.url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Declare a large body that we never finish sending, and send
            // no Authorization. If the handler read the body before
            // authenticating it would block here and no response would
            // ever arrive.
            "Content-Length": "10000000",
          },
        },
        (res) => {
          clearTimeout(timer)
          res.resume()
          resolve(res.statusCode ?? 0)
          req.destroy()
        },
      )
      const timer = setTimeout(() => {
        req.destroy()
        reject(
          new Error(
            "no response while the body was still incomplete — the handler appears to read the body before authenticating",
          ),
        )
      }, 5000)
      req.on("error", () => {})
      req.write("{") // one byte; req.end() is deliberately never called
    })
    assert.equal(status, 401)
  })
})

test("security: the generated MCP config carries the token, 0600, and never in the URL", async () => {
  await withServer(async (srv) => {
    const cfgPath = srv.configPath()
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"))
    const entry = cfg.mcpServers[srv.serverName]

    assert.equal(entry.type, "http")
    assert.equal(entry.headers.Authorization, `Bearer ${srv.authToken}`)

    // The file now holds a secret, so its mode is load-bearing -- ON POSIX.
    // Node does not implement owner/group/other mode bits on Windows, where
    // this commonly reads back 0o666 and confidentiality instead depends on
    // the inherited ACL of os.tmpdir(). Asserting 0o600 there would be a
    // test that cannot pass, and claiming it in the README would be a
    // guarantee we do not provide.
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(cfgPath).mode & 0o777, 0o600)
    }

    // A token in the URL would leak into logs and process listings.
    assert.ok(!srv.url.includes(srv.authToken))
    assert.ok(!entry.url.includes(srv.authToken))
  })
})

// A rejected request must not leave the connection usable. Without an
// explicit close, a peer can declare a large Content-Length, send one byte,
// take the 401, and hold the socket -- and `server.close()` does NOT reap
// connections that are still sending, so shutdown would block behind an
// unauthenticated caller for Node's five-minute request timeout.
//
// This test deliberately never finishes the body. An earlier version of the
// suite masked the defect by destroying the socket client-side as soon as the
// response arrived, which is exactly the cleanup the server must not depend on.
test("security: rejecting an unauthenticated request does not leave shutdown hostage to an unfinished body", async () => {
  const net = await import("node:net")
  const srv = await createProxyMcpServer(DEFAULT_PROXY_TOOLS)
  const { port } = new URL(srv.url)

  const sock = net.connect({ host: "127.0.0.1", port: Number(port) })
  await new Promise<void>((resolve) => sock.once("connect", () => resolve()))

  // Announce a large body, then send a single byte and stop.
  sock.write(
    "POST /mcp HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${port}\r\n` +
      "Content-Type: application/json\r\n" +
      "Content-Length: 1048576\r\n" +
      "\r\n" +
      "{",
  )

  const status = await new Promise<string>((resolve) => {
    sock.once("data", (chunk) => resolve(chunk.toString("utf8").split("\r\n")[0]))
  })
  assert.match(status, /401/, "the unauthenticated request should be rejected")

  // The body is still unfinished here, on purpose. close() must not hang.
  const closed = srv.close().then(() => "closed" as const)
  const timedOut = new Promise<"hung">((resolve) =>
    setTimeout(() => resolve("hung"), 4000).unref(),
  )
  assert.equal(await Promise.race([closed, timedOut]), "closed")

  sock.destroy()
})

test("security: a client using only the generated config's header is accepted (round-trip)", async () => {
  await withServer(async (srv) => {
    // Proves config generation and request validation agree: read the
    // header out of the file Claude is handed, and use nothing else.
    const cfg = JSON.parse(fs.readFileSync(srv.configPath(), "utf8"))
    const auth = cfg.mcpServers[srv.serverName].headers.Authorization
    const payload = JSON.stringify(LIST_REQ)
    const res = await post(srv.url, LIST_REQ, {
      headers: jsonHeaders(payload, { Authorization: auth }),
    })
    assert.equal(res.status, 200)
    assert.ok(res.json.result.tools.length > 0)
  })
})

test("security: two servers get distinct tokens, and one's token is rejected by the other", async () => {
  const a = await createProxyMcpServer(DEFAULT_PROXY_TOOLS)
  const b = await createProxyMcpServer(DEFAULT_PROXY_TOOLS)
  try {
    assert.notEqual(a.authToken, b.authToken)
    const payload = JSON.stringify(LIST_REQ)
    const res = await post(b.url, LIST_REQ, {
      headers: jsonHeaders(payload, { Authorization: `Bearer ${a.authToken}` }),
    })
    assert.equal(res.status, 401)
  } finally {
    await a.close()
    await b.close()
  }
})

// ---------------------------------------------------------------------------
// SSE reply channel. Claude Code's MCP client aborts a tools/call request
// that has produced no bytes for about five minutes (measured on 2.1.258),
// which is how a long `task` ended up answered to a client that had already
// given up. A client that accepts text/event-stream must get headers and a
// first byte immediately and the JSON-RPC result as the final event.
// ---------------------------------------------------------------------------

type SseCapture = {
  status: number
  contentType: string
  chunks: Array<{ at: number; text: string }>
  done: Promise<void>
  destroy(): void
}

function openSse(srv: ProxyMcpServer, body: unknown): Promise<SseCapture> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(
      srv.url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload).toString(),
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${srv.authToken}`,
        },
      },
      (res) => {
        const capture: SseCapture = {
          status: res.statusCode ?? 0,
          contentType: String(res.headers["content-type"] ?? ""),
          chunks: [],
          done: new Promise<void>((done) => {
            res.on("end", done)
            res.on("close", done)
          }),
          destroy: () => req.destroy(),
        }
        res.on("data", (chunk: Buffer) => {
          capture.chunks.push({ at: Date.now(), text: chunk.toString("utf8") })
        })
        resolve(capture)
      },
    )
    req.on("error", reject)
    req.write(payload)
    req.end()
  })
}

function lastSseMessage(capture: SseCapture): any {
  const text = capture.chunks.map((c) => c.text).join("")
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .pop()
  assert.ok(data, `no data line in SSE body: ${JSON.stringify(text)}`)
  return JSON.parse(data.slice("data: ".length))
}

test("tools/call answers over SSE when the client accepts it: first byte before the result, envelope last", async () => {
  await withServer(async (srv) => {
    let pending: ProxyToolCall | null = null
    srv.calls.on("call", (call: ProxyToolCall) => {
      pending = call
    })
    const capture = await openSse(srv, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "bash", arguments: {} },
    })
    assert.equal(capture.status, 200)
    assert.match(capture.contentType, /^text\/event-stream/)
    // Headers resolved the request already; the open comment is the first
    // byte and must land while the call is still pending.
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(pending, "call was queued")
    assert.ok(capture.chunks.length >= 1, "a first byte arrived before the result")
    assert.match(capture.chunks[0].text, /^: open/)
    const resolvedAt = Date.now()
    pending!.resolve({ kind: "text", text: "done late" })
    await capture.done
    const envelope = lastSseMessage(capture)
    assert.equal(envelope.id, 7)
    assert.equal(envelope.result.isError, false)
    assert.equal(envelope.result.content[0].text, "done late")
    assert.ok(capture.chunks[0].at <= resolvedAt)
  })
})

test("tools/call over SSE: a broker rejection still arrives as an MCP result with isError", async () => {
  await withServer(async (srv) => {
    srv.calls.on("call", (call: ProxyToolCall) => {
      setTimeout(() => call.reject(new Error("boom")), 20)
    })
    const capture = await openSse(srv, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "bash", arguments: {} },
    })
    await capture.done
    const envelope = lastSseMessage(capture)
    assert.equal(envelope.id, 8)
    assert.equal(envelope.result.isError, true)
    assert.equal(envelope.result.content[0].text, "boom")
    assert.equal(envelope.error, undefined)
  })
})

test("tools/call without event-stream in Accept still gets a plain JSON body", async () => {
  await withServer(async (srv) => {
    srv.calls.on("call", (call: ProxyToolCall) => {
      call.resolve({ kind: "text", text: "json" })
    })
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "bash", arguments: {} },
    })
    const res = await post(srv.url, null, {
      rawBody: payload,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload).toString(),
        Accept: "application/json",
        Authorization: `Bearer ${srv.authToken}`,
      },
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.result.content[0].text, "json")
  })
})

test("a client that drops the request flips the call's channel to closed; a late resolve is harmless", async () => {
  await withServer(async (srv) => {
    let pending: ProxyToolCall | null = null
    srv.calls.on("call", (call: ProxyToolCall) => {
      pending = call
    })
    const capture = await openSse(srv, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "task", arguments: {} },
    })
    await new Promise((r) => setTimeout(r, 30))
    assert.ok(pending, "call was queued")
    assert.equal(pending!.channel?.closed, false)
    capture.destroy()
    // The server sees the socket close on the next turn of the loop.
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(pending!.channel?.closed, true)
    // Resolving now must neither throw nor keep the server from closing.
    pending!.resolve({ kind: "text", text: "nobody home" })
    await new Promise((r) => setTimeout(r, 30))
  })
})

// --- task_batch (from @broskees' 68ed142, adapted) --------------------------
//
// Claude Code emits several proxy tool_use blocks in one assistant message but
// sends the MCP requests one at a time, so two `task` calls in one response
// run serially. `task_batch` is one call the plugin fans out into N opencode
// `task` calls inside one tool boundary, which opencode runs concurrently.

test("task_batch is a default proxy def that reuses the task input shape", async () => {
  const batch = DEFAULT_PROXY_TOOLS.find((t) => t.name === TASK_BATCH_TOOL_NAME)
  const task = DEFAULT_PROXY_TOOLS.find((t) => t.name === "task")
  assert.ok(batch && task)
  const items = (batch!.inputSchema as any).properties.tasks.items
  assert.equal(items.properties, (task!.inputSchema as any).properties, "same object: one source of truth for the task fields")
  assert.deepEqual(items.required, (task!.inputSchema as any).required)
  assert.equal((batch!.inputSchema as any).properties.tasks.minItems, 2)
  await withServer(async (srv) => {
    const res = await authedPost(srv, { jsonrpc: "2.0", id: 1, method: "tools/list" })
    const names = res.json.result.tools.map((t: any) => t.name)
    assert.ok(names.includes(TASK_BATCH_TOOL_NAME))
  })
})

test("task_batch input validation names the first problem", () => {
  const good = { description: "d", prompt: "p", subagent_type: "general" }
  assert.equal(taskBatchInputError({ tasks: [good, good] }), null)
  assert.match(taskBatchInputError(undefined)!, /at least two/)
  assert.match(taskBatchInputError({ tasks: [good] })!, /at least two/)
  assert.match(taskBatchInputError({ tasks: [good, "nope"] })!, /tasks\[1\] must be an object/)
  assert.match(taskBatchInputError({ tasks: [good, { ...good, prompt: 7 }] })!, /tasks\[1\]\.prompt must be a string/)
  assert.deepEqual(taskBatchTasks({ tasks: [good, good] }), [good, good])
  assert.deepEqual(taskBatchTasks({ tasks: [good] }), [], "an invalid batch fans out to nothing")
  assert.equal(taskBatchChildToolCallId("abc-123", 1), "abc-123_task_1")
  assert.match(taskBatchChildToolCallId("abc-123", 0), /^[A-Za-z0-9_-]+$/, "ids survive AI SDK normalisation")
})

test("task_batch shares the task deadline and its timeout guidance", () => {
  assert.equal(
    resolveProxyCallTimeoutMs(TASK_BATCH_TOOL_NAME, undefined, undefined),
    resolveProxyCallTimeoutMs("task", undefined, undefined),
  )
  assert.equal(resolveProxyCallTimeoutMs("Task_Batch", undefined, { task_batch: 5 * MIN }), 5 * MIN)
  const err = buildProxyTimeoutError(TASK_BATCH_TOOL_NAME, 1234)
  assert.match(err.message, /timed out after 1234ms waiting for opencode to resolve/)
  assert.match(err.message, /the subagents/)
  assert.match(err.message, /wake-up/)
})

test("tools/call rejects a bad task_batch as an MCP error result without queueing it", async () => {
  await withServer(async (srv) => {
    const seen: ProxyToolCall[] = []
    srv.calls.on("call", (call: ProxyToolCall) => { seen.push(call) })
    const res = await authedPost(srv, {
      jsonrpc: "2.0",
      id: "batch-bad",
      method: "tools/call",
      params: { name: TASK_BATCH_TOOL_NAME, arguments: { tasks: [{ description: "only one", prompt: "p", subagent_type: "general" }] } },
    })
    assert.equal(res.json.id, "batch-bad")
    assert.equal(res.json.result.isError, true)
    assert.match(res.json.result.content[0].text, /at least two/)
    assert.equal(seen.length, 0, "nothing reached the broker")
  })
})

test("formatTaskBatchResults labels every child in order and never drops a gap", () => {
  const task = (description: string) => ({ description, prompt: "p", subagent_type: "general" })
  const ok = formatTaskBatchResults([
    { task: task("first"), result: { kind: "text", text: "alpha" } },
    { task: task("second"), result: { kind: "text", text: "beta" } },
  ])
  assert.equal(ok.kind, "text")
  assert.equal((ok as any).isError, undefined)
  assert.equal(
    (ok as { text: string }).text,
    "## task 1 of 2: first (general)\nalpha\n\n## task 2 of 2: second (general)\nbeta",
  )
  const mixed = formatTaskBatchResults([
    { task: task("first"), result: { kind: "error", message: "boom" } },
    { task: task("second"), result: null },
    { task: task("third"), result: { kind: "text", text: "gamma", isError: true } },
  ])
  assert.equal((mixed as any).isError, true)
  const text = (mixed as { text: string }).text
  assert.match(text, /## task 1 of 3: first \(general\)\n\[error\] boom/)
  assert.match(text, /## task 2 of 3: second \(general\)\n\[missing\] opencode returned no result/)
  assert.match(text, /## task 3 of 3: third \(general\)\n\[error\] gamma/)
})

// --- resolveMcpProxyToolDefs -------------------------------------------
//
// Discovery source regression. These pin the fix for the option that
// defaulted to true and routed nothing: opencode's tool registry
// (`client.tool.list()` / `GET /experimental/tool`) enumerates built-ins
// plus plugin-declared tools only, so an MCP-shaped id is never in it. The
// AI SDK `tools` array opencode hands `doStream` is downstream of the merge
// that adds MCP tools, so it is the only place a provider plugin sees them.
// Measured live on opencode 1.18.31: registry 14 ids, none MCP; the same
// server's model tool set carried 14 `codebase-memory-mcp_*` entries.

const modelTool = (name: string, extra: Record<string, unknown> = {}) => ({
  type: "function" as const,
  name,
  description: `desc for ${name}`,
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  ...extra,
})

test("MCP tools are discovered from the model tool set, not the registry", () => {
  const { defs, coveredServers } = resolveMcpProxyToolDefs({
    serverNames: ["codebase-memory-mcp", "figma"],
    tools: [
      // The built-ins opencode's registry route does return. None of these
      // may be forwarded: that is what `proxyOpencodeTools` is for.
      modelTool("bash"),
      modelTool("read"),
      modelTool("task"),
      modelTool("compress"),
      modelTool("codebase-memory-mcp_list_projects"),
      modelTool("codebase-memory-mcp_search_graph"),
      modelTool("figma_get_metadata"),
    ],
  })
  assert.deepEqual(
    defs.map((def) => def.name),
    [
      "codebase-memory-mcp_list_projects",
      "codebase-memory-mcp_search_graph",
      "figma_get_metadata",
    ],
  )
  assert.deepEqual([...coveredServers].sort(), ["codebase-memory-mcp", "figma"])
  // The schema travels, so Claude sees the real argument shape.
  assert.deepEqual(defs[0].inputSchema, {
    type: "object",
    properties: { q: { type: "string" } },
  })
  assert.equal(defs[0].description, "desc for codebase-memory-mcp_list_projects")
})

test("a registry-shaped tool list yields nothing, which is the bug being fixed", () => {
  // Verbatim the 14 ids `GET /experimental/tool/ids` returned on 1.18.31
  // while five MCP servers were connected.
  const registryIds = [
    "invalid", "question", "bash", "read", "glob", "grep", "edit", "write",
    "task", "webfetch", "todowrite", "websearch", "skill", "apply_patch",
  ]
  const { defs, coveredServers } = resolveMcpProxyToolDefs({
    serverNames: ["figma", "codebase-memory-mcp", "obsidian"],
    tools: registryIds.map((id) => modelTool(id)),
  })
  assert.deepEqual(defs, [])
  assert.equal(coveredServers.size, 0)
})

test("the longest server name wins, so a prefix server cannot steal its tools", () => {
  const { defs, coveredServers } = resolveMcpProxyToolDefs({
    serverNames: ["slack", "slack_intl"],
    tools: [modelTool("slack_intl_send"), modelTool("slack_send")],
  })
  assert.deepEqual(defs.map((def) => def.name), ["slack_intl_send", "slack_send"])
  assert.deepEqual([...coveredServers].sort(), ["slack", "slack_intl"])
})

test("coveredServers names only matched servers, so an unmatched one is not stranded", () => {
  // The caller excludes coveredServers from `--mcp-config`. Excluding an
  // enabled server with no def would drop it from the direct bridge without
  // putting it on the proxy, leaving it reachable by neither route.
  const { defs, coveredServers } = resolveMcpProxyToolDefs({
    serverNames: ["figma", "obsidian"],
    tools: [modelTool("figma_get_metadata")],
  })
  assert.deepEqual(defs.map((def) => def.name), ["figma_get_metadata"])
  assert.deepEqual([...coveredServers], ["figma"])
  assert.equal(coveredServers.has("obsidian"), false)
})

test("an empty or absent model tool set resolves to nothing", () => {
  assert.deepEqual(resolveMcpProxyToolDefs({ serverNames: ["figma"] }).defs, [])
  assert.deepEqual(
    resolveMcpProxyToolDefs({ serverNames: ["figma"], tools: [] }).defs,
    [],
  )
  assert.deepEqual(
    resolveMcpProxyToolDefs({ serverNames: [], tools: [modelTool("figma_x")] }).defs,
    [],
  )
})

test("a name another proxy def already holds is dropped, not duplicated", () => {
  const { defs, coveredServers } = resolveMcpProxyToolDefs({
    serverNames: ["figma"],
    tools: [modelTool("figma_get_metadata"), modelTool("figma_use")],
    taken: new Set(["figma_use"]),
  })
  assert.deepEqual(defs.map((def) => def.name), ["figma_get_metadata"])
  assert.deepEqual([...coveredServers], ["figma"])
})

test("non-function and unnamed entries are skipped", () => {
  const { defs } = resolveMcpProxyToolDefs({
    serverNames: ["figma"],
    tools: [
      { type: "provider", name: "figma_native" } as any,
      { type: "function", name: "   " } as any,
      { type: "function" } as any,
      modelTool("figma_ok"),
      // A duplicate name must not produce two defs of the same tool.
      modelTool("figma_ok"),
    ],
  })
  assert.deepEqual(defs.map((def) => def.name), ["figma_ok"])
})
