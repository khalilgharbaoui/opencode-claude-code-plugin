/**
 * What the plugin answers on the Claude CLI's control channel, for the
 * subtypes that are not `can_use_tool`.
 *
 * The one that matters is `elicitation`. It is reachable in this plugin's
 * mode: measured on Claude Code 2.1.288, a `--print --input-format stream-json
 * --output-format stream-json` session with a bridged stdio MCP server hands
 * that server's `elicitation/create` to the client as a control request, so
 * any opencode-configured MCP server that elicits reaches it on a default
 * install. The CLI coerces a response that fails its `{action}` schema into
 * `{action:"cancel"}` (measured with `{}` and with `{action:"bogus"}`), so the
 * old blind `{}` did not stall a turn; what it did was decide silently.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  _resetElicitationReports,
  handleControlRequest,
} from "../src/control-request.js"
import {
  _resetLogSinkForTests,
  setLogSink,
  setTuiHostForTests,
  type LogSinkEntry,
} from "../src/logger.js"

function fakeProc(): { proc: any; written: string[] } {
  const written: string[] = []
  return {
    written,
    proc: { stdin: { write: (line: string) => written.push(line) } } as any,
  }
}

/**
 * The sink only receives anything while the logger believes a TUI owns the
 * terminal, so both seams are set together and reset together.
 */
function captureLogs(): { entries: LogSinkEntry[]; restore: () => void } {
  const entries: LogSinkEntry[] = []
  setTuiHostForTests(true)
  setLogSink({
    log: (entry) => {
      entries.push(entry)
    },
    toast: () => {},
  })
  return { entries, restore: () => _resetLogSinkForTests() }
}

function parseResponses(written: string[]): any[] {
  return written.map((line) => JSON.parse(line))
}

test("an MCP elicitation is declined under the CLI's documented schema", () => {
  _resetElicitationReports()
  const { proc, written } = fakeProc()

  const handled = handleControlRequest(
    {} as any,
    {
      type: "control_request",
      request_id: "req-1",
      request: {
        subtype: "elicitation",
        mcp_server_name: "elicit",
        mode: "form",
      },
    } as any,
    proc,
  )

  assert.equal(handled, true)
  const [payload] = parseResponses(written)
  assert.equal(payload.type, "control_response")
  assert.equal(payload.response.subtype, "success")
  assert.equal(payload.response.request_id, "req-1")
  // `decline`, never `accept`: accepting would fabricate the operator's input.
  assert.deepEqual(payload.response.response, { action: "decline" })
})

test("the elicitation warning names the server and fires once per server", () => {
  _resetElicitationReports()
  const { entries, restore } = captureLogs()
  try {
    const { proc } = fakeProc()
    const request = {
      type: "control_request",
      request_id: "req-a",
      request: { subtype: "elicitation", mcp_server_name: "elicit", mode: "form" },
    } as any

    handleControlRequest({} as any, request, proc)
    handleControlRequest({} as any, { ...request, request_id: "req-b" }, proc)
    handleControlRequest(
      {} as any,
      {
        type: "control_request",
        request_id: "req-c",
        request: { subtype: "elicitation", mcp_server_name: "other", mode: "url" },
      } as any,
      proc,
    )

    const warnings = entries.filter((entry) => entry.level === "warn")
    assert.equal(warnings.length, 2, JSON.stringify(warnings))
    assert.match(warnings[0].message, /asked for operator input and was declined/)
    assert.equal((warnings[0].data as any)?.server, "elicit")
    assert.equal((warnings[0].data as any)?.mode, "form")
    assert.equal((warnings[1].data as any)?.server, "other")
    assert.equal((warnings[1].data as any)?.mode, "url")
  } finally {
    restore()
  }
})

test("an elicitation with no server name still answers and warns", () => {
  _resetElicitationReports()
  const { entries, restore } = captureLogs()
  try {
    const { proc, written } = fakeProc()
    handleControlRequest(
      {} as any,
      {
        type: "control_request",
        request_id: "req-2",
        request: { subtype: "elicitation" },
      } as any,
      proc,
    )
    assert.deepEqual(parseResponses(written)[0].response.response, { action: "decline" })
    const warning = entries.find((entry) => entry.level === "warn")
    assert.equal((warning?.data as any)?.server, "unknown")
    assert.equal((warning?.data as any)?.mode, "form")
  } finally {
    restore()
  }
})

/**
 * `hook_callback` and `mcp_message` keep the blind empty ack, and that is
 * correct rather than unfinished: both are gated on an SDK `initialize`
 * control request this plugin never sends. `hook_callback` carries a
 * `callback_id` minted when a host registers hooks through `initialize`
 * (`createHookCallback`, keyed on the CLI's own `sdkHostHookGeneration`), and
 * `mcp_message` only serves servers named in `initialize.sdkMcpServers` or
 * added with `mcp_set_servers`. This plugin bridges MCP servers through
 * `--mcp-config` instead, so neither is ever sent to it.
 */
test("unhandled control request subtypes keep the empty success ack", () => {
  for (const subtype of ["hook_callback", "mcp_message", "something_new"]) {
    const { proc, written } = fakeProc()
    const handled = handleControlRequest(
      {} as any,
      { type: "control_request", request_id: "r", request: { subtype } } as any,
      proc,
    )
    assert.equal(handled, true, subtype)
    assert.deepEqual(parseResponses(written)[0].response.response, {}, subtype)
  }
})

test("a non-control-request message is not handled", () => {
  const { proc, written } = fakeProc()
  assert.equal(
    handleControlRequest({} as any, { type: "assistant" } as any, proc),
    false,
  )
  assert.equal(written.length, 0)
})
