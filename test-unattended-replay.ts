/**
 * Regression for the unattended-stdout replay path in
 * src/claude-code-language-model.ts. When a reused Claude CLI subprocess
 * emitted output while no turn was listening (e.g. the previous turn's
 * stream already closed), that output is replayed as narration at the start
 * of the next turn. The replay loop must reuse a single open text block
 * across all replayed deltas — like the live streaming path does — instead
 * of opening a fresh block per delta, which shreds the message mid-word.
 *
 * Usage:
 *   npx tsx --test test-unattended-replay.ts
 */
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { UNATTENDED_REPLAY_MARKER } from "./src/cli-events.js"
import { createClaudeCode } from "./src/index.js"
import { filterSideQuestionHistory } from "./src/message-builder.js"

function createFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-unattended-replay-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const readline = require("node:readline")
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.258\\n")
  process.exit(0)
}
let turn = 0
readline.createInterface({ input: process.stdin }).on("line", () => {
  turn++
  if (turn === 1) {
    process.stdout.write(JSON.stringify({
      type: "assistant",
      session_id: "fake-session",
      message: { role: "assistant", content: [{ type: "text", text: "First answer." }] },
    }) + "\\n")
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "fake-session" }) + "\\n")
    // Written after this turn's stream has already closed on the plugin
    // side — nobody is listening, so this becomes "unattended" output that
    // the next turn must replay.
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "ver" } }) + "\\n")
      process.stdout.write(JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "ification call timed out (likely a st" } }) + "\\n")
      process.stdout.write(JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "alled permission prompt)" } }) + "\\n")
    }, 200)
    return
  }
  process.stdout.write(JSON.stringify({
    type: "assistant",
    session_id: "fake-session",
    message: { role: "assistant", content: [{ type: "text", text: "Second answer." }] },
  }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "fake-session" }) + "\\n")
  process.exit(0)
})
`,
  )
  chmodSync(cliPath, 0o755)
  return { cwd, cliPath }
}

async function runTurn(model: any, prompt: any[]) {
  const response = await model.doStream({
    prompt,
    tools: [
      {
        type: "function",
        name: "bash",
        description: "Run a command",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  } as any)
  const parts: any[] = []
  for await (const part of response.stream) parts.push(part)
  return parts
}

test("a reused process's unattended output replays as a single text block, not one per delta", {
  timeout: 10_000,
}, async () => {
  const fixture = createFixture()
  try {
    const model = createClaudeCode({
      cliPath: fixture.cliPath,
      cwd: fixture.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: [],
    }).languageModel("claude-test-unattended-replay")

    await runTurn(model, [{ role: "user", content: [{ type: "text", text: "First message." }] }])
    // Give the fake CLI time to emit its between-turns output while nobody
    // is listening, before the next turn attaches a new listener.
    await new Promise((resolve) => setTimeout(resolve, 500))

    // Prior conversation turns must be present, or doStream treats this as a
    // brand new session and tears down the still-running process before
    // reusing it — deleteActiveProcess(sk) is unconditional otherwise.
    const parts = await runTurn(model, [
      { role: "user", content: [{ type: "text", text: "First message." }] },
      { role: "assistant", content: [{ type: "text", text: "First answer." }] },
      { role: "user", content: [{ type: "text", text: "Second message." }] },
    ])

    const replayFragments = ["ver", "ification call timed out", "alled permission prompt"]
    const replayDeltas = parts.filter(
      (part) => part.type === "text-delta" && replayFragments.some((fragment) => String(part.delta).includes(fragment)),
    )
    assert.equal(replayDeltas.length, replayFragments.length, "expected all three replayed fragments to show up as deltas")

    const replayIds = new Set(replayDeltas.map((part) => part.id))
    assert.equal(replayIds.size, 1, `expected every replayed delta to share one text block id, got ${replayIds.size}`)

    const [replayId] = replayIds
    const startsForReplayBlock = parts.filter((part) => part.type === "text-start" && part.id === replayId)
    const endsForReplayBlock = parts.filter((part) => part.type === "text-end" && part.id === replayId)
    assert.equal(startsForReplayBlock.length, 1, "the replay block must open exactly once")
    assert.equal(endsForReplayBlock.length, 1, "the replay block must close exactly once")

    // The replay is not an answer to this turn's message, so the block has to
    // say so and has to be strippable. Without the marker the operator reads
    // the previous turn's trailing sentence as this reply's first line, and a
    // transcript rebuild hands it back to Claude as its own answer to the
    // wrong message. Measured live on CLI 2.1.286 (h #g189).
    const replayBlockDeltas = parts.filter(
      (part) => part.type === "text-delta" && part.id === replayId,
    )
    assert.ok(replayBlockDeltas.length > 0, "the replay block must carry deltas")
    assert.ok(
      String(replayBlockDeltas[0].delta).trimStart().startsWith(UNATTENDED_REPLAY_MARKER),
      `the replay block must open with ${UNATTENDED_REPLAY_MARKER}, got ${JSON.stringify(String(replayBlockDeltas[0].delta).slice(0, 80))}`,
    )
  } finally {
    rmSync(fixture.cwd, { recursive: true, force: true })
  }
})

test("a replayed between-turns block is stripped from a rebuilt transcript", () => {
  const replayed = replayedBlockText()
  const prompt = [
    { role: "user" as const, content: [{ type: "text" as const, text: "First message." }] },
    {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: replayed },
        { type: "text" as const, text: "Second answer." },
      ],
    },
    { role: "user" as const, content: [{ type: "text" as const, text: "Third message." }] },
  ]

  const filtered = filterSideQuestionHistory(prompt as any) as any[]
  const assistant = filtered.find((message) => message.role === "assistant")
  const texts = (assistant?.content ?? []).map((part: any) => part.text)
  assert.deepEqual(
    texts,
    ["Second answer."],
    "the marker-led replay part must be dropped and the real reply kept",
  )
})

/** The exact shape `doStream` enqueues: the note, then the replayed text. */
function replayedBlockText(): string {
  return `${UNATTENDED_REPLAY_MARKER} The Claude Code CLI wrote this after the previous turn had already finished, so it is not an answer to the message above.\n\nTask completed.`
}
