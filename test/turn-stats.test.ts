/**
 * Per-turn cost and cache stats: the pure formatter, the `turnStats` option
 * default, and the strip that keeps the footer out of a rebuilt transcript.
 *
 * Usage: npx tsx --test test/turn-stats.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  ACCOUNT_BLOCK_MARKER,
  FAILOVER_MARKER,
  USAGE_LIMIT_MARKER,
} from "../src/account-failover.js"
import {
  COMPACT_BOUNDARY_MARKER,
  CONVERSATION_RESET_MARKER,
  RATE_LIMIT_MARKER,
  RESULT_ERROR_MARKER,
  SILENT_TURN_MARKER,
  STREAM_TIMEOUT_MARKER,
  UNATTENDED_REPLAY_MARKER,
} from "../src/cli-events.js"
import { BUDGET_MARKER } from "../src/budget-ledger.js"
import { createClaudeCode } from "../src/index.js"
import { killAllActiveProcesses, sessionKey, setClaudeSessionId } from "../src/session-manager.js"
import { filterSideQuestionHistory } from "../src/message-builder.js"
import { CONVERSATION_REWOUND_MARKER } from "../src/conversation-gap.js"
import { MODEL_FALLBACK_MARKER } from "../src/model-fallback.js"
import { STALE_BUILD_MARKER } from "../src/stale-build.js"
import {
  TURN_STATS_MARKER,
  extractTurnStats,
  formatCost,
  formatDuration,
  formatTokens,
  formatTurnStatsBlock,
  formatTurnStatsLine,
  footerCostUsd,
  turnStatsLogPayload,
} from "../src/turn-stats.js"
import type { ClaudeStreamMessage } from "../src/types.js"

const fullResult: ClaudeStreamMessage = {
  type: "result",
  subtype: "success",
  total_cost_usd: 0.01234,
  duration_ms: 4234,
  duration_api_ms: 3900,
  num_turns: 2,
  usage: {
    input_tokens: 1234,
    output_tokens: 812,
    cache_read_input_tokens: 45_120,
    cache_creation_input_tokens: 2048,
  },
  modelUsage: { "claude-opus-5": { inputTokens: 1234, outputTokens: 812 } },
  permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu_1" }],
}

test("extractTurnStats keeps everything the result line carries", () => {
  const stats = extractTurnStats(fullResult)
  assert.equal(stats.costUsd, 0.01234)
  assert.equal(stats.durationMs, 4234)
  assert.equal(stats.durationApiMs, 3900)
  assert.equal(stats.numTurns, 2)
  assert.equal(stats.inputTokens, 1234)
  assert.equal(stats.outputTokens, 812)
  assert.equal(stats.cacheReadTokens, 45_120)
  assert.equal(stats.cacheWriteTokens, 2048)
  assert.deepEqual(stats.modelUsage, {
    "claude-opus-5": { inputTokens: 1234, outputTokens: 812 },
  })
  assert.equal(stats.permissionDenials?.length, 1)
})

test("the footer reads as one compact line", () => {
  assert.equal(
    formatTurnStatsLine(extractTurnStats(fullResult)),
    `${TURN_STATS_MARKER} $0.0123 · 4.2 s · 2 CLI turns · in 1.2k · out 812 · cache read 45.1k · cache write 2.0k · 1 permission denial`,
  )
})

test("rounding keeps the digits that carry information", () => {
  assert.equal(formatCost(0.0001234), "$0.0001")
  assert.equal(formatCost(0), "$0.0000")
  assert.equal(formatCost(12.3456), "$12.35")
  assert.equal(formatCost(-1), "$0.00")

  assert.equal(formatDuration(430), "0.4 s")
  assert.equal(formatDuration(4234), "4.2 s")
  assert.equal(formatDuration(95_000), "1m 35s")

  assert.equal(formatTokens(0), "0")
  assert.equal(formatTokens(812), "812")
  assert.equal(formatTokens(1234), "1.2k")
  assert.equal(formatTokens(1_500_000), "1.5M")
})

test("missing and zero fields are dropped, not printed as zeroes", () => {
  const line = formatTurnStatsLine(
    extractTurnStats({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.002,
      duration_ms: 900,
      num_turns: 1,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }),
  )
  assert.equal(line, `${TURN_STATS_MARKER} $0.0020 · 0.9 s · 1 CLI turn · in 10 · out 5`)
  assert.equal(line!.includes("cache"), false)
  assert.equal(line!.includes("denial"), false)
})

test("a result with no usable numbers produces no footer at all", () => {
  assert.equal(formatTurnStatsLine(extractTurnStats({ type: "result" })), null)
  assert.equal(formatTurnStatsBlock(extractTurnStats({ type: "result" })), null)
})

test("the log payload is emitted whether or not the footer is", () => {
  const payload = turnStatsLogPayload(extractTurnStats(fullResult))
  assert.equal(payload.costUsd, 0.01234)
  assert.equal(payload.durationApiMs, 3900)
  assert.equal(payload.permissionDenials, 1)
  assert.deepEqual(payload.modelUsage, {
    "claude-opus-5": { inputTokens: 1234, outputTokens: 812 },
  })
  const empty = turnStatsLogPayload(extractTurnStats({ type: "result" }))
  assert.equal(empty.costUsd, null)
  assert.equal(empty.permissionDenials, 0)
})

test("the footer is stripped from a transcript rebuilt for the CLI", () => {
  const footer = formatTurnStatsBlock(extractTurnStats(fullResult))!
  const prompt = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "the answer" },
        { type: "text", text: footer },
      ],
    },
  ] as any

  const filtered = filterSideQuestionHistory(prompt)
  assert.equal(filtered.length, 2)
  assert.deepEqual((filtered[1] as any).content, [{ type: "text", text: "the answer" }])
})

test("every ▌ marker the plugin writes is stripped from a rebuilt transcript", () => {
  // The list lives in src/message-builder.ts and a marker missing from it is
  // silent: the note simply comes back to Claude as something it said. So
  // each one is asserted here, beside the footer that owns this file, rather
  // than only in the file that happens to format it (h #g108).
  const notes = [
    `${USAGE_LIMIT_MARKER} the Claude account "appical" is out of usage.`,
    `${RATE_LIMIT_MARKER} Claude Code rejected this request.`,
    `${ACCOUNT_BLOCK_MARKER} the Claude account "appical" is not logged in.`,
    `${FAILOVER_MARKER} moved to "default".`,
    `${STALE_BUILD_MARKER} restart opencode.`,
    `${SILENT_TURN_MARKER} claude said nothing.`,
    `${RESULT_ERROR_MARKER} the turn failed.`,
    `${STREAM_TIMEOUT_MARKER} the CLI went silent.`,
    `${COMPACT_BOUNDARY_MARKER} claude compacted itself.`,
    `${CONVERSATION_RESET_MARKER} claude cleared its conversation.`,
    `${UNATTENDED_REPLAY_MARKER} it said this between turns.`,
    `${MODEL_FALLBACK_MARKER} falling back.`,
    `${CONVERSATION_REWOUND_MARKER} the thread was edited or undone.`,
    `${TURN_STATS_MARKER} $0.0001`,
    `${BUDGET_MARKER} this conversation has spent $0.50, 50% of its $1.00 \`maxBudgetUsd\`.`,
  ]
  for (const note of notes) {
    const prompt = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "the answer" },
          // Its own text part, led by the marker: that is what makes the
          // strip exact instead of a guess at where a block ends.
          { type: "text", text: `\n${note}\n` },
        ],
      },
    ] as any
    assert.deepEqual(
      (filterSideQuestionHistory(prompt)[1] as any).content,
      [{ type: "text", text: "the answer" }],
      `not stripped: ${note.slice(0, 40)}`,
    )
  }
})

test("turnStats is off unless the provider option asks for it", () => {
  assert.equal((createClaudeCode({})("claude-sonnet-5") as any).config.turnStats, false)
  assert.equal(
    (createClaudeCode({ turnStats: true })("claude-sonnet-5") as any).config.turnStats,
    true,
  )
})

// ---- The footer's cost is this turn's, not the session's (h #g257) ---------

test("the footer prints what the result added, and nothing it cannot price", () => {
  assert.equal(footerCostUsd(undefined, false), undefined)
  assert.equal(footerCostUsd({ deltaUsd: 0.007, noBaseline: false }, true), 0.007)
  // A session that started in this process: its first total is its own cost.
  assert.equal(footerCostUsd({ deltaUsd: 0.033, noBaseline: true }, false), 0.033)
  // A resumed one: `--resume` restored the running total, so it may hold
  // every earlier turn of the conversation.
  assert.equal(footerCostUsd({ deltaUsd: 0.5, noBaseline: true }, true), undefined)
})

// The fake CLI is a shebang script made executable with chmod, which means
// nothing on Windows (.github/windows-skipped-tests.txt).
const POSIX_ONLY = process.platform === "win32" ? "the fake-CLI harness is POSIX-only" : false

/**
 * Two turns on one reused process against a fake CLI whose `total_cost_usd`
 * is cumulative, as a headless CLI's is. `resumeFirst` gives the key a Claude
 * session id first, so the spawn carries `--resume`, the way a turn after an
 * opencode restart does.
 */
async function footersOverTwoTurns(totals: number[], sessionId: string, resumeFirst: boolean) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-turn-cost-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const readline = require("node:readline")
if (process.argv.includes("--version")) { process.stdout.write("2.1.258\\n"); process.exit(0) }
if (process.argv.includes("--help")) { process.stdout.write("Usage: claude [options]\\n"); process.exit(0) }
const totals = ${JSON.stringify(totals)}
const session = ${JSON.stringify(sessionId)}
let turn = 0
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
readline.createInterface({ input: process.stdin }).on("line", () => {
  const total = totals[Math.min(turn, totals.length - 1)]
  turn += 1
  emit({ type: "system", subtype: "init", session_id: session })
  emit({ type: "assistant", session_id: session, message: { role: "assistant", content: [{ type: "text", text: "answer " + turn }] } })
  emit({ type: "result", subtype: "success", session_id: session, is_error: false, result: "answer " + turn, total_cost_usd: total, duration_ms: 1200, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } })
})
`,
  )
  chmodSync(cliPath, 0o755)
  const modelId = `claude-test-turn-cost-${sessionId}`
  const tools = [{ type: "function", name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }]
  const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
  const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] })
  try {
    if (resumeFirst) {
      setClaudeSessionId(sessionKey(cwd, `${modelId}::tools::default::context=["claude-code",null]`), sessionId)
    }
    const model = createClaudeCode({
      cliPath,
      cwd,
      turnStats: true,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: [],
    }).languageModel(modelId)
    const footerOf = async (prompt: any[]) => {
      const parts: any[] = []
      for await (const part of (await model.doStream({ prompt, tools } as any)).stream) parts.push(part)
      return parts
        .filter((part) => part.type === "text-delta" && String(part.delta).includes(TURN_STATS_MARKER))
        .map((part) => String(part.delta).trim())
        .join("")
    }
    const history = [user("earlier"), assistant("earlier answer")]
    const first = await footerOf([...history, user("first")])
    const second = await footerOf([...history, user("first"), assistant("answer 1"), user("second")])
    return { first, second }
  } finally {
    killAllActiveProcesses()
    rmSync(cwd, { recursive: true, force: true })
  }
}

test("a reused process's second footer prints that turn's cost, not the running total", { skip: POSIX_ONLY, timeout: 30_000 }, async () => {
  // The measured cumulative sequence (h #g245).
  const { first, second } = await footersOverTwoTurns([0.0330759, 0.0400318], "turn-cost-a", false)
  assert.match(first, /\$0\.0331/)
  assert.match(second, /\$0\.0070 ·/, second)
  assert.doesNotMatch(second, /\$0\.0400/, "the running total is what the footer printed before")
})

test("a resumed session's first footer leaves out a cost it cannot know, and prices the next turn", { skip: POSIX_ONLY, timeout: 30_000 }, async () => {
  const { first, second } = await footersOverTwoTurns([0.5, 0.55], "turn-cost-b", true)
  assert.ok(first.startsWith(TURN_STATS_MARKER), first)
  assert.doesNotMatch(first, /\$/, "the restored total may include every earlier turn")
  assert.match(first, /1\.2 s/, "the rest of the footer is still there")
  assert.match(second, /\$0\.0500 ·/, second)
})
