/**
 * Claude CLI stream events the plugin used to drop: `rate_limit_event`,
 * `system`/`init`, `system`/`compact_boundary`, and a `result` whose subtype
 * is not `success`.
 *
 * Every payload here is the shape read out of the CLI's own zod schemas in the
 * installed 2.1.263 bundle, so a parser that stops matching is a real drift
 * signal and not a fixture that went stale on its own.
 *
 * Usage: npx tsx --test test-cli-events.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  API_KEY_SOURCES,
  COMPACT_BOUNDARY_MARKER,
  RATE_LIMIT_MARKER,
  RESULT_ERROR_MARKER,
  _resetRateLimitReports,
  _resetSystemInitReports,
  apiKeySourceWarning,
  describeRateLimit,
  describeResultFailure,
  formatCompactBoundaryNote,
  formatResetsAt,
  formatResultFailureNote,
  isRateLimitRejected,
  parseCompactBoundary,
  parseRateLimitEvent,
  parseMcpServerErrors,
  parseSystemInit,
  rateLimitKey,
  reportCompactBoundary,
  reportRateLimitEvent,
  reportSystemInit,
  describeMcpServerError,
  snapshotMcpServerErrors,
} from "./src/cli-events.js"
import { _resetLoggerForTests, configureLogger } from "./src/logger.js"
import type { ClaudeStreamMessage } from "./src/types.js"

/** Capture what reaches the TUI: only warn/error are unconditionally on stderr. */
function captureStderr<T>(run: () => T): { value: T; lines: string[] } {
  const lines: string[] = []
  const original = console.error
  console.error = (line: unknown) => {
    lines.push(String(line))
  }
  try {
    return { value: run(), lines }
  } finally {
    console.error = original
  }
}

const rejected: ClaudeStreamMessage = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "rejected",
    rateLimitType: "five_hour",
    resetsAt: 1_757_000_000,
    overageStatus: "rejected",
    overageDisabledReason: "org_level_disabled",
    isUsingOverage: false,
  },
}

test("parseRateLimitEvent reads the documented rate_limit_info shape", () => {
  const info = parseRateLimitEvent(rejected)
  assert.equal(info?.status, "rejected")
  assert.equal(info?.rateLimitType, "five_hour")
  assert.equal(info?.overageDisabledReason, "org_level_disabled")
  assert.equal(info?.resetsAt, 1_757_000_000)
  assert.equal(parseRateLimitEvent({ type: "result" }), null)
  assert.equal(parseRateLimitEvent({ type: "rate_limit_event" }), null)
})

test("formatResetsAt reads unix seconds and tolerates milliseconds", () => {
  assert.equal(formatResetsAt(1_757_000_000), "2025-09-04T15:33:20.000Z")
  assert.equal(formatResetsAt(1_757_000_000_000), "2025-09-04T15:33:20.000Z")
  assert.equal(formatResetsAt(undefined), undefined)
})

test("a rejection warns, explains the reason, and says what can be done", () => {
  const report = describeRateLimit(parseRateLimitEvent(rejected)!)
  assert.equal(report?.level, "warn")
  assert.match(report!.message, /out of usage in the 5-hour window/)
  assert.match(report!.message, /extra usage is disabled for your organization/)
  assert.match(report!.message, /Resets at 2025-09-04T15:33:20\.000Z/)
  assert.match(report!.message, /wait for the window to reset/)
  assert.ok(report!.transcript?.startsWith(`\n${RATE_LIMIT_MARKER} `))
})

test("an overage rejection on an allowed request is not a rejection", () => {
  // Measured on CLI 2.1.280 (2026-09-23) on a turn that was served: extra
  // usage being disabled for the org is a steady state, not a refusal.
  const served = parseRateLimitEvent({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      rateLimitType: "five_hour",
      resetsAt: 1_790_186_400,
      isUsingOverage: false,
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled",
    },
  })!
  assert.equal(isRateLimitRejected(served), false)
  const report = describeRateLimit(served)
  assert.notEqual(report?.level, "warn")
  assert.equal(report?.transcript, null)

  assert.equal(isRateLimitRejected({ ...served, status: "allowed_warning" }), false)
  assert.equal(isRateLimitRejected({ ...served, status: "rejected" }), true)
  // With no verdict of its own, an overage rejection still counts.
  assert.equal(isRateLimitRejected({ overageStatus: "rejected" }), true)
})

test("a warning state is a notice with nothing in the transcript", () => {
  const report = describeRateLimit(
    parseRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.82 },
    })!,
  )
  assert.equal(report?.level, "notice")
  assert.match(report!.message, /82% used/)
  assert.equal(report!.transcript, null)
})

test("rate limits warn once per identity per process", () => {
  _resetLoggerForTests()
  _resetRateLimitReports()
  configureLogger({ file: false, mode: "silent", level: "info" })

  const first = captureStderr(() => reportRateLimitEvent(rejected))
  assert.ok(first.value?.includes(RATE_LIMIT_MARKER), "the first rejection is surfaced")
  assert.equal(first.lines.length, 1, "and warns in the TUI")

  const second = captureStderr(() => reportRateLimitEvent(rejected))
  assert.equal(second.value, null, "the same rejection is not repeated")
  assert.equal(second.lines.length, 0)

  const other = captureStderr(() =>
    reportRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "seven_day" },
    }),
  )
  assert.ok(other.value, "a different window is its own warning")
  assert.equal(other.lines.length, 1)
  _resetLoggerForTests()
})

test("rateLimitKey separates the window, the overage status and the reason", () => {
  assert.notEqual(
    rateLimitKey({ status: "rejected", rateLimitType: "five_hour" }),
    rateLimitKey({ status: "rejected", rateLimitType: "seven_day" }),
  )
  assert.notEqual(
    rateLimitKey({ status: "rejected", overageDisabledReason: "out_of_credits" }),
    rateLimitKey({ status: "rejected", overageDisabledReason: "org_level_disabled" }),
  )
})

const init: ClaudeStreamMessage = {
  type: "system",
  subtype: "init",
  apiKeySource: "ANTHROPIC_API_KEY",
  permissionMode: "default",
  model: "claude-opus-5",
  claude_code_version: "2.1.263",
  tools: ["Bash", "Read", "Write"],
  mcp_servers: [
    { name: "github", status: "connected" },
    { name: "slack", status: "failed" },
  ],
}

test("parseSystemInit reads the init fields worth reporting", () => {
  const info = parseSystemInit(init)
  assert.equal(info?.apiKeySource, "ANTHROPIC_API_KEY")
  assert.equal(info?.permissionMode, "default")
  assert.equal(info?.model, "claude-opus-5")
  assert.equal(info?.cliVersion, "2.1.263")
  assert.equal(info?.toolCount, 3)
  assert.deepEqual(info?.mcpServers, [
    { name: "github", status: "connected" },
    { name: "slack", status: "failed" },
  ])
  assert.equal(parseSystemInit({ type: "system", subtype: "compact_boundary" }), null)
  assert.deepEqual(info?.mcpServerErrors, [], "the key is omitted when nothing was skipped")
})

/**
 * Verbatim from a live 2.1.280 probe: `claude -p --output-format stream-json
 * --verbose --mcp-config bad-mcp.json --strict-mcp-config`, where bad-mcp.json
 * declared a `url` entry with no `type` and an entry with an invented `type`.
 * Both servers were absent from `mcp_servers`, which was `[]`.
 */
const initWithSkips: ClaudeStreamMessage = {
  type: "system",
  subtype: "init",
  apiKeySource: "none",
  claude_code_version: "2.1.280",
  tools: ["Bash"],
  mcp_servers: [],
  mcp_server_errors: [
    {
      name: "no_type_entry",
      type: "url_missing_type",
      message:
        'Skipped - MCP server "no_type_entry" has a "url" but no "type"; add "type": "http" (or "sse" / "ws") to this entry',
    },
    { name: "bogus", type: "unknown_type", message: 'Skipped - unknown MCP server type "nonsense_type" for server "bogus"' },
  ],
}

test("mcp_server_errors is parsed off the init frame and survives junk", () => {
  const errors = parseMcpServerErrors(initWithSkips)
  assert.equal(errors.length, 2)
  assert.deepEqual(
    errors.map((error) => [error.name, error.type]),
    [
      ["no_type_entry", "url_missing_type"],
      ["bogus", "unknown_type"],
    ],
  )
  // The key is optional, so its absence is the common case and never an error.
  assert.deepEqual(parseMcpServerErrors(init), [])
  assert.deepEqual(parseMcpServerErrors({ type: "system", subtype: "init" }), [])
  // Defensive: a future CLI that changes the element shape must not throw.
  assert.deepEqual(
    parseMcpServerErrors({ type: "system", subtype: "init", mcp_server_errors: "nope" as never }),
    [],
  )
  const partial = parseMcpServerErrors({
    type: "system",
    subtype: "init",
    mcp_server_errors: [{}, null as never, { name: "x" }],
  })
  assert.deepEqual(partial, [
    { name: "unknown", type: "unknown", message: "" },
    { name: "x", type: "unknown", message: "" },
  ])
})

test("a skipped server says what to fix, and the plugin's own proxy says more", () => {
  const theirs = describeMcpServerError({
    name: "github",
    type: "url_missing_type",
    message: "Skipped - ...",
  })
  assert.match(theirs, /skipped MCP server "github"/)
  assert.match(theirs, /has a `url` but no `type`/)
  assert.match(theirs, /Fix the entry in your MCP config/)

  // The plugin writes its own --mcp-config, so this one is never the user's
  // fault and the consequence is every proxied tool call, not a few tools.
  const ours = describeMcpServerError({
    name: "opencode_proxy",
    type: "invalid_config",
    message: "Skipped - ...",
  })
  assert.match(ours, /plugin's own MCP server/)
  assert.match(ours, /every proxied tool call this session will fail/)
  assert.doesNotMatch(ours, /your own MCP settings\./)

  // An unrecognised category is a generic skip, as the CLI's schema instructs.
  const unknown = describeMcpServerError({ name: "x", type: "brand_new_thing", message: "" })
  assert.match(unknown, /\(brand_new_thing\)/)
  assert.doesNotMatch(unknown, /because/)
})

test("a skipped server warns once per identity per process and is kept for the doctor", () => {
  _resetLoggerForTests()
  _resetSystemInitReports()
  configureLogger({ file: false, mode: "silent", level: "info" })

  const first = captureStderr(() => reportSystemInit(initWithSkips, {}))
  assert.equal(first.lines.length, 2, "one warning per skipped entry, and no MCP-status noise")
  assert.ok(first.lines.some((line) => line.includes("no_type_entry")))
  assert.ok(first.lines.some((line) => line.includes("bogus")))

  const second = captureStderr(() => reportSystemInit(initWithSkips, {}))
  assert.equal(second.lines.length, 0, "a respawn must not repeat the warning")

  // The WARN only reaches stderr and a log file that is off by default, so the
  // doctor needs its own copy or the diagnostic is unretrievable.
  assert.deepEqual(
    snapshotMcpServerErrors().map((error) => error.name),
    ["no_type_entry", "bogus"],
  )
  _resetSystemInitReports()
  assert.deepEqual(snapshotMcpServerErrors(), [])
  _resetLoggerForTests()
})

test("apiKeySourceWarning fires for a key and stays quiet for the subscription", () => {
  assert.equal(apiKeySourceWarning("oauth", false), null)
  assert.equal(apiKeySourceWarning("none", false), null)
  assert.equal(apiKeySourceWarning(undefined, false), null)
  for (const source of API_KEY_SOURCES) {
    assert.ok(apiKeySourceWarning(source, false), `expected a warning for ${source}`)
  }
  assert.match(apiKeySourceWarning("ANTHROPIC_API_KEY", false)!, /ignoreAnthropicApiKey: true/)
  // Already stripping the env vars, so the key came from the CLI's own config
  // and the option is not the fix to suggest.
  assert.match(apiKeySourceWarning("ANTHROPIC_API_KEY", true)!, /claude config/)
})

test("init warns once per failed MCP server and once per api key source", () => {
  _resetLoggerForTests()
  _resetSystemInitReports()
  configureLogger({ file: false, mode: "silent", level: "info" })

  const first = captureStderr(() => reportSystemInit(init, {}))
  assert.equal(first.lines.length, 2, "one for the failed MCP server, one for the API key")
  assert.ok(first.lines.some((line) => line.includes('"slack" is failed')))
  assert.ok(first.lines.some((line) => line.includes("apiKeySource: ANTHROPIC_API_KEY")))
  assert.equal(
    first.lines.some((line) => line.includes("github")),
    false,
    "a connected server is not a warning",
  )

  const second = captureStderr(() => reportSystemInit(init, {}))
  assert.equal(second.lines.length, 0, "a respawn must not repeat either warning")
  _resetLoggerForTests()
})

test("compact_boundary is parsed from either spelling of its metadata", () => {
  const streamShape = parseCompactBoundary({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "auto", pre_tokens: 180_000, post_tokens: 40_000 },
  })
  assert.deepEqual(streamShape, { trigger: "auto", preTokens: 180_000, postTokens: 40_000 })

  const transcriptShape = parseCompactBoundary({
    type: "system",
    subtype: "compact_boundary",
    compactMetadata: { trigger: "manual" },
  })
  assert.deepEqual(transcriptShape, {
    trigger: "manual",
    preTokens: undefined,
    postTokens: undefined,
  })

  assert.equal(parseCompactBoundary({ type: "system", subtype: "init" }), null)
})

test("a compaction the CLI did on its own is announced in the transcript", () => {
  _resetLoggerForTests()
  configureLogger({ file: false, mode: "silent", level: "info" })
  const note = reportCompactBoundary({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "auto", pre_tokens: 180_000, post_tokens: 40_000 },
  })
  assert.ok(note?.includes(COMPACT_BOUNDARY_MARKER))
  assert.match(note!, /on its own \(180,000 tokens to 40,000\)/)
  assert.equal(reportCompactBoundary({ type: "result" }), null)
  assert.match(
    formatCompactBoundaryNote({ trigger: "manual" }),
    /on a manual request\. Earlier detail/,
  )
  _resetLoggerForTests()
})

test("a failing result subtype is named, a successful one is not", () => {
  assert.equal(describeResultFailure({ type: "result", subtype: "success" }), null)
  assert.equal(describeResultFailure({ type: "result" }), null)
  assert.equal(describeResultFailure({ type: "assistant", subtype: "error_max_turns" }), null)

  const known = describeResultFailure({ type: "result", subtype: "error_max_turns" })
  assert.match(known!, /error_max_turns/)
  assert.match(known!, /internal turn limit/)

  const unknown = describeResultFailure({ type: "result", subtype: "error_from_a_future_cli" })
  assert.equal(unknown, "Claude Code ended the turn with `error_from_a_future_cli`.")
  assert.ok(formatResultFailureNote(known!).startsWith(`\n${RESULT_ERROR_MARKER} `))
})
