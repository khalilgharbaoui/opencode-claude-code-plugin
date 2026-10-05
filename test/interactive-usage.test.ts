/**
 * The interactive transport's token counting.
 *
 * The fixtures under `test/fixtures/` are the `assistant` records of two REAL
 * Claude Code 2.1.280 sessions, captured on 2026-09-30. Ids, record types,
 * `stop_reason` and above all `usage` are verbatim; only the prose, thinking
 * and tool inputs are redacted. `interactive-turn.jsonl` is a four-tool turn
 * driven through this plugin's own interactive transport under Bun
 * (5 API calls written as 10 records); `interactive-synthetic-error.jsonl` is
 * the single `<synthetic>` record the CLI writes for "Login expired".
 *
 * The truth for the first fixture, from the CLI's own `cost-state` record of
 * that session: 653 output tokens, 42 input, 137,736 cache read, 16,696 cache
 * write. Summing per RECORD instead of per CALL reports 1,306 output, exactly
 * double.
 */
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import {
  ClaudeSession,
  TurnUsageAccumulator,
  isApiCallRecord,
} from "../src/claude-session-bun.js"
import { extractTurnStats } from "../src/turn-stats.js"
import { lastCallContextUsage, toUsage } from "../src/usage.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const TURN_FIXTURE = path.join(here, "fixtures", "interactive-turn.jsonl")
const SYNTHETIC_FIXTURE = path.join(
  here,
  "fixtures",
  "interactive-synthetic-error.jsonl",
)

// The session's own `cost-state` record for the captured turn.
const TRUTH = {
  apiCalls: 5,
  records: 10,
  outputTokens: 653,
  inputTokens: 42,
  cacheReadTokens: 137736,
  cacheWriteTokens: 16696,
  thinkingTokens: 280,
}
// What summing over records instead of calls reports.
const OVER_COUNTED_OUTPUT = 1306
// The newest real call, which is the conversation's context occupancy.
const LAST_CALL = { input: 8, cacheRead: 31263, cacheWrite: 167, output: 80 }

function readRecords(fixture: string): any[] {
  return fs
    .readFileSync(fixture, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

/**
 * Drive the REAL `tailTurn` over a fixture: point the session's transcript
 * path at a scratch file and stub the PTY, which is the only Bun-only part of
 * the path. The fixture lands in the file when the prompt is submitted (the
 * Enter after the paste), as the CLI writes it: a turn starts reading at the
 * transcript's end, so records already there belong to an earlier turn.
 * Everything else (the poll loop, the cursor, the terminal-stop detection and
 * the usage aggregation) runs unmodified.
 */
async function tailFixture(
  fixture: string,
): Promise<{ lines: string[]; result: any }> {
  const session = new ClaudeSession({
    cwd: here,
    pollMs: 1,
    submitMinMs: 0,
    submitConfirmMs: 50,
    stopSettleMs: 20,
    turnTimeoutMs: 5000,
  })
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-usage-"))
  const transcript = path.join(scratch, "session.jsonl")
  fs.writeFileSync(transcript, "")
  const anySession = session as any
  anySession.jsonlPath = transcript
  anySession.proc = {
    terminal: {
      write: (data: string) => {
        if (data === "\r" && fs.statSync(transcript).size === 0) {
          fs.writeFileSync(transcript, fs.readFileSync(fixture, "utf8"))
        }
      },
    },
  }
  const lines: string[] = []
  try {
    const result = await session.tailTurn("prompt", (raw) => lines.push(raw))
    return { lines, result }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// The fixture itself: one call is several records, each repeating that call's
// final usage. This is what makes a per-record sum wrong.
// ---------------------------------------------------------------------------

test("a captured turn writes one record per content block, all sharing the call's usage", () => {
  const records = readRecords(TURN_FIXTURE)
  assert.equal(records.length, TRUTH.records)

  const byId = new Map<string, any[]>()
  for (const record of records) {
    const id = record.message.id
    if (!byId.has(id)) byId.set(id, [])
    byId.get(id)!.push(record)
  }
  assert.equal(byId.size, TRUTH.apiCalls)

  for (const [id, group] of byId) {
    assert.ok(group.length > 1, `${id} should span several records`)
    const first = JSON.stringify(group[0].message.usage)
    for (const record of group) {
      assert.equal(
        JSON.stringify(record.message.usage),
        first,
        `${id} records must carry identical usage`,
      )
    }
  }

  const perRecord = records.reduce(
    (sum, record) => sum + (record.message.usage?.output_tokens ?? 0),
    0,
  )
  assert.equal(perRecord, OVER_COUNTED_OUTPUT)
})

// ---------------------------------------------------------------------------
// TurnUsageAccumulator
// ---------------------------------------------------------------------------

test("the accumulator counts each API call once and reports the turn's real output", () => {
  const usage = new TurnUsageAccumulator()
  for (const record of readRecords(TURN_FIXTURE)) usage.add(record)

  assert.equal(usage.callCount, TRUTH.apiCalls)
  const total = usage.turnTotal
  assert.equal(total.output_tokens, TRUTH.outputTokens)
  assert.notEqual(total.output_tokens, OVER_COUNTED_OUTPUT)
  assert.equal(total.input_tokens, TRUTH.inputTokens)
  assert.equal(total.cache_read_input_tokens, TRUTH.cacheReadTokens)
  assert.equal(total.cache_creation_input_tokens, TRUTH.cacheWriteTokens)
  assert.equal(total.output_tokens_details.thinking_tokens, TRUTH.thinkingTokens)
  assert.equal(
    total.cache_creation.ephemeral_1h_input_tokens,
    TRUTH.cacheWriteTokens,
  )
  assert.equal(total.cache_creation.ephemeral_5m_input_tokens, 0)
})

test("the accumulator's last call is the newest call's context, not the turn sum", () => {
  const usage = new TurnUsageAccumulator()
  for (const record of readRecords(TURN_FIXTURE)) usage.add(record)

  const last = usage.lastCall
  assert.equal(last.input_tokens, LAST_CALL.input)
  assert.equal(last.cache_read_input_tokens, LAST_CALL.cacheRead)
  assert.equal(last.cache_creation_input_tokens, LAST_CALL.cacheWrite)
  assert.equal(last.output_tokens, LAST_CALL.output)
  // The context side of a five-call turn is a fraction of the sum.
  assert.ok(last.cache_read_input_tokens < TRUTH.cacheReadTokens / 4)
})

test("the turn total carries no iterations while the last call keeps its own", () => {
  const usage = new TurnUsageAccumulator()
  for (const record of readRecords(TURN_FIXTURE)) usage.add(record)
  // A sum of calls has no single response's iteration list; `toUsage` falls
  // back to the flat counters when it is absent.
  assert.equal(usage.turnTotal.iterations, undefined)
  assert.deepEqual(usage.lastCall.iterations, [])
})

test("an all-zero <synthetic> record is not an API call", () => {
  const [synthetic] = readRecords(SYNTHETIC_FIXTURE)
  assert.equal(synthetic.message.model, "<synthetic>")
  assert.equal(synthetic.message.stop_reason, "stop_sequence")
  assert.equal(isApiCallRecord(synthetic), false)

  const usage = new TurnUsageAccumulator()
  for (const record of readRecords(TURN_FIXTURE)) usage.add(record)
  const before = JSON.stringify(usage.turnTotal)
  const lastBefore = JSON.stringify(usage.lastCall)

  usage.add(synthetic)
  assert.equal(usage.callCount, TRUTH.apiCalls)
  assert.equal(JSON.stringify(usage.turnTotal), before)
  assert.equal(JSON.stringify(usage.lastCall), lastBefore)
})

test("the accumulator ignores records that are not assistant frames", () => {
  const usage = new TurnUsageAccumulator()
  usage.add({ type: "user", message: { content: "hi" } })
  usage.add({ type: "attachment" })
  usage.add(null)
  usage.add({ type: "assistant" })
  assert.equal(usage.callCount, 0)
  assert.equal(usage.turnTotal, null)
  assert.equal(usage.lastCall, null)
})

test("two records with no message id are two calls, not one", () => {
  const usage = new TurnUsageAccumulator()
  usage.add({
    type: "assistant",
    uuid: "a",
    message: { usage: { input_tokens: 5, output_tokens: 11 } },
  })
  usage.add({
    type: "assistant",
    uuid: "b",
    message: { usage: { input_tokens: 5, output_tokens: 13 } },
  })
  assert.equal(usage.callCount, 2)
  assert.equal(usage.turnTotal.output_tokens, 24)
  assert.equal(usage.lastCall.output_tokens, 13)
})

// ---------------------------------------------------------------------------
// tailTurn, driven over the fixture with the PTY stubbed out.
// ---------------------------------------------------------------------------

test("tailTurn re-emits every record and reports the turn's real output", async () => {
  const { lines, result } = await tailFixture(TURN_FIXTURE)

  // The raw lines are the transport's whole point: the stream parser sees
  // every record, unchanged, and builds its own `lastCallUsage` from them.
  assert.equal(lines.length, TRUTH.records)
  assert.equal(result.stopReason, "end_turn")
  assert.equal(result.callCount, TRUTH.apiCalls)
  assert.equal(result.usage.output_tokens, TRUTH.outputTokens)
  assert.notEqual(result.usage.output_tokens, OVER_COUNTED_OUTPUT)
  assert.equal(result.usage.input_tokens, TRUTH.inputTokens)
  assert.equal(result.usage.cache_read_input_tokens, TRUTH.cacheReadTokens)
  assert.equal(result.lastCallUsage.cache_read_input_tokens, LAST_CALL.cacheRead)
})

test("tailTurn reports no usage for a turn whose only record is synthetic", async () => {
  const { lines, result } = await tailFixture(SYNTHETIC_FIXTURE)
  assert.equal(lines.length, 1)
  // The synthetic record still ends the turn: its stop_reason is terminal.
  assert.equal(result.stopReason, "stop_sequence")
  assert.equal(result.callCount, 0)
  assert.equal(result.usage, null)
  assert.equal(result.lastCallUsage, null)
})

// ---------------------------------------------------------------------------
// What the finish and the stats line make of it. One convention, shared with
// the headless path: `lastCallContextUsage`.
// ---------------------------------------------------------------------------

test("the finish reports the last call's context and the turn's real output", async () => {
  const { result } = await tailFixture(TURN_FIXTURE)
  // `state.lastCallUsage` is what the stream parser derives from the same
  // records the transport just re-emitted, which is the accumulator's last
  // call: both apply the same all-zero guard to the same frames.
  const usage = toUsage(lastCallContextUsage(result.lastCallUsage, result.usage))

  assert.equal(usage.inputTokens.noCache, LAST_CALL.input)
  assert.equal(usage.inputTokens.cacheRead, LAST_CALL.cacheRead)
  assert.equal(usage.inputTokens.cacheWrite, LAST_CALL.cacheWrite)
  assert.equal(
    usage.inputTokens.total,
    LAST_CALL.input + LAST_CALL.cacheRead + LAST_CALL.cacheWrite,
  )
  // Output is the turn's, not the last call's and not the per-record sum.
  assert.equal(usage.outputTokens.total, TRUTH.outputTokens)
})

test("turnStats stays on the turn totals so the line matches the bill", async () => {
  const { result } = await tailFixture(TURN_FIXTURE)
  const stats = extractTurnStats({
    type: "result",
    subtype: "success",
    usage: result.usage,
    total_cost_usd: 0.0504726,
  } as any)

  assert.ok(stats)
  assert.equal(stats!.outputTokens, TRUTH.outputTokens)
  assert.equal(stats!.inputTokens, TRUTH.inputTokens)
  assert.equal(stats!.cacheReadTokens, TRUTH.cacheReadTokens)
  assert.equal(stats!.cacheWriteTokens, TRUTH.cacheWriteTokens)
})
