/**
 * The CLI-event work as opencode actually sees it: a fake `claude` emits the
 * stream lines and the assertions are on the AI SDK parts that come out of
 * `doStream`.
 *
 * The unit tests in `test-cli-events.ts` and `test-turn-stats.ts` cover the
 * parsers and formatters; this file covers the wiring, which is the half a
 * pure test cannot see: whether a failed CLI tool reaches opencode with the
 * error flag, whether a failing result subtype still finishes as `stop`, and
 * whether the stats footer is gated on the option.
 *
 * Usage: npx tsx --test test-cli-events-stream.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  _resetHookEventReports,
  _resetRateLimitReports,
  _resetSystemInitReports,
  _resetToolProgressReports,
  _resetUnrecognizedModelReports,
  snapshotHookFailures,
} from "./src/cli-events.js"
import { createClaudeCode } from "./src/index.js"
import { deleteActiveProcess, sessionKey } from "./src/session-manager.js"

/**
 * A fake `claude` that replays a fixed line sequence on the first stdin write,
 * optionally writing `stderrText` first. Stdout then waits a beat, because the
 * two pipes are not ordered with each other and a stderr diagnostic has to be
 * seen before the turn it belongs to finishes.
 */
function createFakeCli(lines: unknown[], stderrText = "", lineDelayMs = 0) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-cli-events-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const source = `#!/usr/bin/env node
const readline = require("node:readline")

if (process.argv.includes("--version")) {
  process.stdout.write("2.1.263\\n")
  process.exit(0)
}

const LINES = ${JSON.stringify(lines)}
const STDERR = ${JSON.stringify(stderrText)}
const LINE_DELAY_MS = ${JSON.stringify(lineDelayMs)}
const rl = readline.createInterface({ input: process.stdin })
let answered = false
rl.on("line", () => {
  if (answered) return
  answered = true
  const replay = () => {
    if (!LINE_DELAY_MS) {
      for (const line of LINES) process.stdout.write(JSON.stringify(line) + "\\n")
      return
    }
    // Paced replay, for the watchdog fixtures: the gap between two lines is
    // the thing under test, so they cannot all arrive in one tick.
    let index = 0
    const next = () => {
      if (index >= LINES.length) return
      process.stdout.write(JSON.stringify(LINES[index++]) + "\\n")
      setTimeout(next, LINE_DELAY_MS)
    }
    next()
  }
  if (!STDERR) return replay()
  process.stderr.write(STDERR)
  setTimeout(replay, 100)
})
`
  writeFileSync(cliPath, source)
  chmodSync(cliPath, 0o755)
  return { cliPath, cwd }
}

async function streamParts(
  lines: unknown[],
  settings: Record<string, unknown> = {},
  stderrText = "",
  lineDelayMs = 0,
): Promise<any[]> {
  _resetRateLimitReports()
  _resetSystemInitReports()
  _resetUnrecognizedModelReports()
  _resetHookEventReports()
  _resetToolProgressReports()
  const fake = createFakeCli(lines, stderrText, lineDelayMs)
  const modelId = "claude-test-cli-events"
  const sk = sessionKey(
    fake.cwd,
    `${modelId}::tools::default::context=["claude-code",null]`,
  )
  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: [],
      ...settings,
    }).languageModel(modelId)

    const response = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      // Presence of tools is what selects the real streaming path.
      tools: [
        {
          type: "function",
          name: "read",
          description: "Read a file",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    } as any)

    const parts: any[] = []
    for await (const part of response.stream) parts.push(part)
    return parts
  } finally {
    deleteActiveProcess(sk)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
}

const init = { type: "system", subtype: "init", session_id: "fake-session", tools: ["Read"] }

function assistantToolUse(id: string, name: string) {
  return {
    type: "stream_event",
    session_id: "fake-session",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name },
    },
  }
}

function blockStop(index = 0) {
  return {
    type: "stream_event",
    session_id: "fake-session",
    event: { type: "content_block_stop", index },
  }
}

const successResult = {
  type: "result",
  subtype: "success",
  session_id: "fake-session",
  is_error: false,
  result: "done",
  total_cost_usd: 0.0123,
  duration_ms: 4200,
  duration_api_ms: 4000,
  num_turns: 2,
  usage: {
    input_tokens: 1234,
    output_tokens: 812,
    cache_read_input_tokens: 45_120,
    cache_creation_input_tokens: 2048,
  },
  modelUsage: { "claude-opus-5": { inputTokens: 1234, outputTokens: 812 } },
  permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu_denied" }],
}

const text = (body: string) => ({
  type: "stream_event",
  session_id: "fake-session",
  event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: body } },
})

/**
 * The real CLI always reports a stop reason, and the plugin treats one as
 * authoritative. Without it these fixtures fall through to the auto-continue
 * keyword heuristic, which nudges the fake for more output it will never send.
 */
const endTurn = {
  type: "stream_event",
  session_id: "fake-session",
  event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
}

/** Only warn and error reach stderr unconditionally, which is the point here. */
async function captureStderr<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = []
  const original = process.stderr.write
  process.stderr.write = ((chunk: any) => {
    lines.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    return { value: await run(), lines }
  } finally {
    process.stderr.write = original
  }
}

test("an MCP entry the CLI skipped warns through a real doStream and changes nothing else", async () => {
  const initWithSkip = {
    ...init,
    mcp_servers: [],
    mcp_server_errors: [
      {
        name: "opencode_proxy",
        type: "invalid_config",
        message: "Skipped - MCP server \"opencode_proxy\" failed validation",
      },
    ],
  }

  const captured = await captureStderr(() =>
    streamParts([initWithSkip, text("hello"), endTurn, successResult]),
  )

  const warning = captured.lines.join("")
  assert.match(warning, /skipped the plugin's own MCP server "opencode_proxy"/)
  assert.match(warning, /every proxied tool call this session will fail/)

  // The diagnostic is a warning and nothing more: the turn still finishes as an
  // ordinary stop with the model's text, and no `▌` note is injected.
  const parts = captured.value
  const body = parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
  assert.equal(body, "hello")
  const finish = parts.find((part) => part.type === "finish")
  assert.equal(finish.finishReason.unified, "stop")
})

test("a model the CLI does not recognise warns through a real doStream and changes nothing else", async () => {
  // The line Claude Code 2.1.280 writes for `claude-sonnet-5-5` (2026-09-30).
  const captured = await captureStderr(() =>
    streamParts(
      [init, text("hello"), endTurn, successResult],
      {},
      '[claude-code:unrecognized_model] {"model":"claude-sonnet-5-5","query_source":"sdk"}\n',
    ),
  )

  const warning = captured.lines.join("")
  assert.match(warning, /does not recognise the model "claude-sonnet-5-5"/)
  const parts = captured.value
  const body = parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
  assert.equal(body, "hello", "the turn itself is untouched")
  assert.equal(parts.find((part) => part.type === "finish").finishReason.unified, "stop")
})

test("a CLI tool that failed reaches opencode flagged as an error", async () => {
  const parts = await streamParts([
    init,
    assistantToolUse("toolu_fail", "Read"),
    blockStop(),
    {
      type: "user",
      session_id: "fake-session",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_fail",
            content: "ENOENT: no such file",
            is_error: true,
          },
        ],
      },
    },
    text("sorry"),
    endTurn,
    successResult,
  ])

  const result = parts.find(
    (part) => part.type === "tool-result" && part.toolCallId === "toolu_fail",
  )
  assert.ok(result, "the failed tool result must still be forwarded")
  // Without the flag this is undefined and the AI SDK emits an ordinary
  // `tool-result`, so opencode renders a failed CLI tool as a success whose
  // output happens to be an error message.
  assert.equal(result.isError, true)
  assert.deepEqual(result.result.metadata, { error: true })
})

test("a CLI tool that succeeded is not flagged", async () => {
  const parts = await streamParts([
    init,
    assistantToolUse("toolu_ok", "Read"),
    blockStop(),
    {
      type: "user",
      session_id: "fake-session",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_ok", content: "file body" }],
      },
    },
    endTurn,
    successResult,
  ])

  const result = parts.find(
    (part) => part.type === "tool-result" && part.toolCallId === "toolu_ok",
  )
  assert.ok(result)
  assert.equal(result.isError, undefined)
  assert.deepEqual(result.result.metadata, {})
})

test("a failing result subtype ends the turn as an error, naming the subtype", async () => {
  const parts = await streamParts([
    init,
    text("partial work"),
    endTurn,
    {
      type: "result",
      subtype: "error_max_turns",
      session_id: "fake-session",
      is_error: true,
      result: "",
      duration_ms: 1000,
      num_turns: 8,
    },
  ])

  const finish = parts.find((part) => part.type === "finish")
  // Previously this was an unconditional `stop`, so opencode recorded a failed
  // turn as an ordinary reply.
  assert.equal(finish.finishReason.unified, "error")
  assert.equal(finish.finishReason.raw, "error_max_turns")
  assert.equal(finish.providerMetadata["claude-code"].resultSubtype, "error_max_turns")

  const body = parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
  assert.match(body, /error_max_turns/)
  assert.match(body, /internal turn limit/)
})

test("a successful turn still finishes as a clean stop", async () => {
  const parts = await streamParts([init, text("done"), endTurn, successResult])
  const finish = parts.find((part) => part.type === "finish")
  assert.equal(finish.finishReason.unified, "stop")
  assert.equal(finish.providerMetadata["claude-code"].resultSubtype, undefined)
})

test("modelUsage and permission denials reach providerMetadata", async () => {
  const parts = await streamParts([init, text("done"), endTurn, successResult])
  const meta = parts.find((part) => part.type === "finish").providerMetadata["claude-code"]
  assert.deepEqual(meta.modelUsage, {
    "claude-opus-5": { inputTokens: 1234, outputTokens: 812 },
  })
  assert.equal(meta.numTurns, 2)
  assert.equal(meta.durationApiMs, 4000)
  // Names and ids only: a denial's tool_input can be a whole file payload.
  assert.deepEqual(meta.permissionDenials, [
    { tool_name: "Bash", tool_use_id: "toolu_denied" },
  ])
})

test("the stats footer appears only when turnStats is on", async () => {
  const off = await streamParts([init, text("done"), endTurn, successResult])
  const offText = off
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
  assert.equal(offText.includes("**stats:**"), false)

  const on = await streamParts([init, text("done"), endTurn, successResult], { turnStats: true })
  const onText = on
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
  assert.match(onText, /▌ \*\*stats:\*\* \$0\.0123 · 4\.2 s · 2 CLI turns/)
  assert.match(onText, /cache read 45\.1k · cache write 2\.0k/)

  // Its own text part, which is what makes the transcript strip exact.
  const footerStart = on.findIndex(
    (part) => part.type === "text-delta" && part.delta.includes("**stats:**"),
  )
  assert.ok(footerStart > 0)
  assert.equal(on[footerStart - 1].type, "text-start")
})

test("a failed turn gets no stats footer even with turnStats on", async () => {
  const parts = await streamParts(
    [
      init,
      text("partial"),
      endTurn,
      {
        type: "result",
        subtype: "error_during_execution",
        session_id: "fake-session",
        is_error: true,
        result: "",
        total_cost_usd: 0.5,
        duration_ms: 1000,
        num_turns: 1,
      },
    ],
    { turnStats: true },
  )
  const body = parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
  assert.equal(body.includes("**stats:**"), false)
  assert.match(body, /error_during_execution/)
})

test("a rate-limit rejection is written into the transcript", async () => {
  const parts = await streamParts([
    init,
    {
      type: "rate_limit_event",
      session_id: "fake-session",
      rate_limit_info: {
        status: "rejected",
        rateLimitType: "five_hour",
        overageStatus: "rejected",
        overageDisabledReason: "org_level_disabled",
      },
    },
    text("cannot continue"),
    endTurn,
    successResult,
  ])
  const body = parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
  assert.match(body, /▌ \*\*rate limit:\*\*/)
  assert.match(body, /out of usage in the 5-hour window/)
  assert.match(body, /wait for the window to reset/)
})

test("a CLI self-compaction is announced in the transcript", async () => {
  const parts = await streamParts([
    init,
    {
      type: "system",
      subtype: "compact_boundary",
      session_id: "fake-session",
      compact_metadata: { trigger: "auto", pre_tokens: 180_000, post_tokens: 40_000 },
    },
    text("carrying on"),
    endTurn,
    successResult,
  ])
  const body = parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
  assert.match(body, /▌ \*\*context compacted:\*\* Claude Code compacted its own context on its own/)
  assert.match(body, /180,000 tokens to 40,000/)
})

test("a conversation reset is announced and forgets the old conversation's blocks", async () => {
  // The sequence `/clear` produced on Claude Code 2.1.280 (2026-09-23): a
  // `conversation_reset` naming the OLD session, then a fresh `system/init`
  // under a new one. The tool block left open before it is the hazard: block
  // indices restart, so the new conversation's first block is index 0 again.
  const parts = await streamParts([
    init,
    assistantToolUse("toolu_orphan", "Read"),
    {
      type: "conversation_reset",
      new_conversation_id: "conv-after-clear",
      uuid: "reset-uuid",
      session_id: "fake-session",
    },
    { ...init, session_id: "fresh-session" },
    {
      type: "stream_event",
      session_id: "fresh-session",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      type: "stream_event",
      session_id: "fresh-session",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fresh start" } },
    },
    blockStop(0),
    endTurn,
    { ...successResult, session_id: "fresh-session", result: "fresh start" },
  ])
  const body = parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
  assert.match(body, /▌ \*\*claude code reset:\*\* Claude Code cleared its conversation/)
  assert.match(body, /fresh start/)
  assert.equal(
    parts.some((part) => part.type === "tool-call" && part.toolCallId === "toolu_orphan"),
    false,
    "the old conversation's open tool block must not come back as a tool call",
  )
})

test("a reset frame without a conversation id is ignored, as the CLI ignores it", async () => {
  const parts = await streamParts([
    init,
    { type: "conversation_reset", uuid: "reset-uuid", session_id: "fake-session" },
    text("still here"),
    endTurn,
    successResult,
  ])
  const body = parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
  assert.doesNotMatch(body, /claude code reset/)
  assert.match(body, /still here/)
})

/**
 * The hook frames below are the real shapes a plugin spawn receives. Measured
 * on Claude Code 2.1.280 on 2026-10-01: the `SessionStart` family is emitted
 * with no extra flag (the CLI's own gate always allows `SessionStart` and
 * `Setup`; everything else waits for `--include-hook-events`, which the plugin
 * never passes), and it arrives before `system`/`init`.
 */
const hookStarted = {
  type: "system",
  subtype: "hook_started",
  hook_id: "hook-0000-0000",
  hook_name: "SessionStart:startup",
  hook_event: "SessionStart",
  uuid: "uuid-0000-0000",
  session_id: "fake-session",
}

const hookFailed = {
  type: "system",
  subtype: "hook_response",
  hook_id: "hook-0000-0000",
  hook_name: "SessionStart:startup",
  hook_event: "SessionStart",
  output: "probe-hook-stdout\nprobe-hook-stderr\n",
  stdout: "probe-hook-stdout\n",
  stderr: "probe-hook-stderr\n",
  exit_code: 3,
  outcome: "error",
  uuid: "uuid-0000-0001",
  session_id: "fake-session",
}

test("a hook that failed warns through a real doStream and writes nothing into the turn", async () => {
  const captured = await captureStderr(() =>
    streamParts([hookStarted, hookFailed, init, text("hello"), endTurn, successResult]),
  )

  const warning = captured.lines.join("")
  assert.match(warning, /"SessionStart:startup" hook \(SessionStart\) exited 3/)
  assert.match(warning, /probe-hook-stderr/)
  // The hook's stdout is what the CLI splices into the model's context.
  assert.equal(warning.includes("probe-hook-stdout"), false)

  // Everything else about the turn is unchanged: the model's text, an
  // ordinary stop, and no `▌` note, because a broken hook belongs to the
  // session rather than to this answer.
  const parts = captured.value
  const body = parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
  assert.equal(body, "hello")
  assert.equal(body.includes("▌"), false)
  const finish = parts.find((part) => part.type === "finish")
  assert.equal(finish?.finishReason.unified, "stop")

  // And the doctor can still retrieve it, which the WARN alone cannot do:
  // it reaches stderr and a log file that is off by default.
  const kept = snapshotHookFailures()
  assert.equal(kept.length, 1)
  assert.equal(kept[0].hookEvent, "SessionStart")
  assert.equal(kept[0].exitCode, 3)
})

test("a hook that succeeded is silent all the way through", async () => {
  const succeeded = { ...hookFailed, exit_code: 0, outcome: "success", stderr: "" }
  const captured = await captureStderr(() =>
    streamParts([hookStarted, succeeded, init, text("hello"), endTurn, successResult]),
  )
  assert.equal(captured.lines.join(""), "")
  assert.equal(snapshotHookFailures().length, 0)
})

/**
 * The frame a long CLI-executed tool produces. The watchdog assertion is the
 * point: `CLAUDE_CODE_RESULT_FALLBACK_MS` is set below the gaps this fixture
 * leaves, so without a line arriving in between the turn would be closed with
 * the stream-timeout note instead of finishing.
 */
function heartbeat(elapsed: number) {
  return {
    type: "tool_progress",
    tool_use_id: `toolu_fake0001-heartbeat-${elapsed / 30 - 1}`,
    tool_name: "Bash",
    parent_tool_use_id: "toolu_fake0001",
    elapsed_time_seconds: elapsed,
    heartbeat: true,
    uuid: `uuid-hb-${elapsed}`,
    session_id: "fake-session",
  }
}

test("a tool_progress heartbeat keeps a long CLI tool alive and adds nothing to the turn", async () => {
  const original = process.env.CLAUDE_CODE_RESULT_FALLBACK_MS
  // Shorter than the fake's own pacing below, so a turn that stops counting
  // heartbeats as activity fails this test rather than merely slowing down.
  process.env.CLAUDE_CODE_RESULT_FALLBACK_MS = "400"
  try {
    const parts = await streamParts(
      [
        init,
        assistantToolUse("toolu_fake0001", "Bash"),
        blockStop(0),
        heartbeat(30),
        heartbeat(60),
        heartbeat(90),
        text("done"),
        endTurn,
        successResult,
      ],
      {},
      "",
      250,
    )

    const body = parts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("")
    assert.equal(body, "done", "the turn must reach its own result")
    assert.equal(body.includes("stream timeout"), false)
    assert.equal(body.includes("▌"), false)

    // No stream part is derived from a progress frame: opencode has no
    // registry entry for one and a tool row is already open for the Bash.
    const names = new Set(parts.map((part) => part.type))
    assert.equal(names.has("tool-input-start"), true, "the Bash row is the real one")
    const finish = parts.find((part) => part.type === "finish")
    assert.equal(finish?.finishReason.unified, "stop")
  } finally {
    if (original === undefined) delete process.env.CLAUDE_CODE_RESULT_FALLBACK_MS
    else process.env.CLAUDE_CODE_RESULT_FALLBACK_MS = original
  }
})
