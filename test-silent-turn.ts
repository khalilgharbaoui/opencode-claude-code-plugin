/**
 * A turn that ends with no text and no tool call finishes as a clean `stop`,
 * so opencode records it as an ordinary reply and the operator sees a blank
 * assistant message. These tests cover the note that says so, and the much
 * longer list of turns it must stay out of.
 *
 * The frequency measurement that decided the design (note, no recovery nudge)
 * is in `docs/agents-history.md`. Everything here drives a real `doStream`
 * against a fake `claude`, because the half a pure test cannot see is whether
 * the note survives the failover, question, proxy and compaction branches that
 * return before the note's own site.
 *
 * Usage: npx tsx --test test-silent-turn.ts
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { isSilentTurn } from "./src/auto-continue.js"
import { SILENT_TURN_MARKER, formatSilentTurnNote } from "./src/cli-events.js"
import { createClaudeCode } from "./src/index.js"
import {
  deleteActiveProcess,
  killAllActiveProcesses,
  sessionKey,
} from "./src/session-manager.js"

// The compaction turn spawns under a session key this file cannot rebuild (it
// carries the compaction model), so its child outlives the per-test cleanup and
// holds the event loop open.
after(() => {
  killAllActiveProcesses()
})

/** A fake `claude` that replays a fixed line sequence on the first stdin write. */
function createFakeCli(lines: unknown[]) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-silent-turn-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const source = `#!/usr/bin/env node
const readline = require("node:readline")

if (process.argv.includes("--version")) {
  process.stdout.write("2.1.263\\n")
  process.exit(0)
}

const LINES = ${JSON.stringify(lines)}
const rl = readline.createInterface({ input: process.stdin })
let answered = false
rl.on("line", () => {
  if (answered) return
  answered = true
  for (const line of LINES) process.stdout.write(JSON.stringify(line) + "\\n")
})
`
  writeFileSync(cliPath, source)
  chmodSync(cliPath, 0o755)
  return { cliPath, cwd }
}

async function streamParts(
  lines: unknown[],
  settings: Record<string, unknown> = {},
  callOptions: Record<string, unknown> = {},
): Promise<any[]> {
  const fake = createFakeCli(lines)
  const modelId = "claude-test-silent-turn"
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
      ...callOptions,
    } as any)

    const parts: any[] = []
    for await (const part of response.stream) parts.push(part)
    return parts
  } finally {
    deleteActiveProcess(sk)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
}

function bodyOf(parts: any[]): string {
  return parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
}

const init = {
  type: "system",
  subtype: "init",
  session_id: "fake-session",
  tools: ["Read"],
}

const text = (body: string) => ({
  type: "stream_event",
  session_id: "fake-session",
  event: {
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: body },
  },
})

const thinking = (body: string) => ({
  type: "stream_event",
  session_id: "fake-session",
  event: {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: body },
  },
})

/** The real CLI always reports one, and the plugin treats it as authoritative. */
const endTurn = {
  type: "stream_event",
  session_id: "fake-session",
  event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
}

const successResult = {
  type: "result",
  subtype: "success",
  session_id: "fake-session",
  is_error: false,
  result: "",
  total_cost_usd: 0.001,
  duration_ms: 900,
  num_turns: 1,
  usage: { input_tokens: 10, output_tokens: 0 },
}

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

// ---------------------------------------------------------------------------
// the predicate
// ---------------------------------------------------------------------------

const silent = {
  enabled: undefined as boolean | "smart" | undefined,
  compactionMode: false,
  sawVisibleText: false,
  sawToolActivity: false,
  sawProxyActivity: false,
  isError: false,
}

test("isSilentTurn fires only on a clean turn that produced nothing visible", () => {
  assert.equal(isSilentTurn(silent), true)
  assert.equal(isSilentTurn({ ...silent, enabled: true }), true)
  assert.equal(isSilentTurn({ ...silent, enabled: "smart" }), true)

  assert.equal(isSilentTurn({ ...silent, sawVisibleText: true }), false)
  assert.equal(isSilentTurn({ ...silent, sawToolActivity: true }), false)
  assert.equal(isSilentTurn({ ...silent, sawProxyActivity: true }), false)
  assert.equal(isSilentTurn({ ...silent, isError: true }), false)
  assert.equal(isSilentTurn({ ...silent, aborted: true }), false)
  assert.equal(isSilentTurn({ ...silent, sawQuestion: true }), false)
  assert.equal(isSilentTurn({ ...silent, compactionMode: true }), false)
  // The operator said they do not want the plugin second-guessing turn ends.
  assert.equal(isSilentTurn({ ...silent, enabled: false }), false)
})

test("reasoning alone is still a silent turn, and the note says which shape it was", () => {
  // The Thinking row collapses to nothing useful; there is still no answer.
  assert.match(formatSilentTurnNote(true), /after thinking but never wrote an answer/)
  assert.match(formatSilentTurnNote(false), /without writing anything or calling a tool/)
  for (const hadReasoning of [true, false]) {
    assert.ok(formatSilentTurnNote(hadReasoning).trimStart().startsWith(SILENT_TURN_MARKER))
  }
})

// ---------------------------------------------------------------------------
// through a real doStream
// ---------------------------------------------------------------------------

test("a turn that says nothing and calls nothing gets the note", async () => {
  const parts = await streamParts([init, endTurn, successResult])
  const body = bodyOf(parts)
  assert.match(body, /▌ \*\*no reply:\*\* Claude Code finished the turn without writing anything/)
  assert.match(body, /send the message again, or rephrase it/)

  // Still a clean stop: nothing failed, so nothing may be reported as failed.
  const finish = parts.find((part) => part.type === "finish")
  assert.equal(finish.finishReason.unified, "stop")

  // Its own text part, which is what makes the transcript strip exact.
  const noteAt = parts.findIndex(
    (part) => part.type === "text-delta" && part.delta.includes(SILENT_TURN_MARKER),
  )
  assert.ok(noteAt > 0)
  assert.equal(parts[noteAt - 1].type, "text-start")
  assert.equal(parts[noteAt + 1].type, "text-end")
})

test("a turn that only thought gets the thinking wording", async () => {
  const parts = await streamParts([
    init,
    thinking("weighing it up"),
    blockStop(0),
    endTurn,
    successResult,
  ])
  assert.match(bodyOf(parts), /finished the turn after thinking but never wrote an answer/)
})

test("a turn with an answer gets no note", async () => {
  const parts = await streamParts([init, text("here you go"), endTurn, successResult])
  assert.equal(bodyOf(parts).includes(SILENT_TURN_MARKER), false)
})

test("even one character of text is an answer", async () => {
  const parts = await streamParts([init, text("."), endTurn, successResult])
  assert.equal(bodyOf(parts).includes(SILENT_TURN_MARKER), false)
})

test("a turn that called a CLI tool and then said nothing gets no note", async () => {
  const parts = await streamParts([
    init,
    assistantToolUse("toolu_read", "Read"),
    blockStop(),
    {
      type: "user",
      session_id: "fake-session",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_read", content: "file body" }],
      },
    },
    endTurn,
    successResult,
  ])
  // The operator watched a tool run. That is not an empty reply.
  assert.equal(bodyOf(parts).includes(SILENT_TURN_MARKER), false)
})

test("a failed result gets its own error note and not this one", async () => {
  const parts = await streamParts([
    init,
    endTurn,
    {
      type: "result",
      subtype: "error_during_execution",
      session_id: "fake-session",
      is_error: true,
      result: "",
      duration_ms: 500,
      num_turns: 1,
    },
  ])
  const body = bodyOf(parts)
  assert.match(body, /error_during_execution/)
  assert.equal(body.includes(SILENT_TURN_MARKER), false)
})

test("autoContinueIncompleteTurns: false suppresses the note", async () => {
  const parts = await streamParts([init, endTurn, successResult], {
    autoContinueIncompleteTurns: false,
  })
  assert.equal(bodyOf(parts).includes(SILENT_TURN_MARKER), false)
})

test("a compaction turn never gets the note", async () => {
  // `/compact` is detected from the opencode agent, and its reply is what
  // opencode stores as the summary, so a note there corrupts the summary.
  const parts = await streamParts([init, endTurn, successResult], {}, {
    providerOptions: { "claude-code": { opencodeAgent: "compaction" } },
  })
  assert.equal(bodyOf(parts).includes(SILENT_TURN_MARKER), false)
})

test("a turn ending on AskUserQuestion is waiting, not silent", async () => {
  const parts = await streamParts([
    init,
    {
      type: "stream_event",
      session_id: "fake-session",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_ask", name: "AskUserQuestion" },
      },
    },
    {
      type: "stream_event",
      session_id: "fake-session",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({
            questions: [{ question: "Which one?", header: "Pick", options: [{ label: "a" }] }],
          }),
        },
      },
    },
    blockStop(0),
    endTurn,
    successResult,
  ])
  const body = bodyOf(parts)
  assert.match(body, /Which one\?/)
  // Covered twice on purpose. The question text is rendered straight to the
  // controller and never reaches `noteVisibleText`, so the only reason this
  // case is not silent today is that `content_block_start` counts every
  // `tool_use` as tool activity, AskUserQuestion included. The `sawQuestion`
  // guard in the predicate (asserted above) is what survives a change there.
  assert.equal(body.includes(SILENT_TURN_MARKER), false)
})

test("the title stub is answered without a CLI turn, so it cannot get the note", async () => {
  const fake = createFakeCli([init, endTurn, successResult])
  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: [],
    }).languageModel("claude-test-silent-turn")
    // No `tools` is what marks a title request on the 1.x path.
    const response = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "rename a variable" }] }],
    } as any)
    const parts: any[] = []
    for await (const part of response.stream) parts.push(part)
    const body = bodyOf(parts)
    assert.ok(body.length > 0, "the stub must still produce a title")
    assert.equal(body.includes(SILENT_TURN_MARKER), false)
  } finally {
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})
