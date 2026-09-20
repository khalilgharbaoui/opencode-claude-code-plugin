/**
 * The wire-inactivity watchdog as opencode sees it. A CLI that produces output
 * and then goes quiet without a `result` used to close the turn on a log line
 * alone, so the reply simply stopped. The note is what says why.
 *
 * The fake `claude` here never sends a terminal `result` and keeps stdin open,
 * so the only thing that can end the stream is the fallback timer.
 *
 * Usage: npx tsx --test test-result-fallback.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { STREAM_TIMEOUT_MARKER, formatStreamTimeoutNote } from "./src/cli-events.js"
import { createClaudeCode } from "./src/index.js"
import { filterSideQuestionHistory } from "./src/message-builder.js"
import { deleteActiveProcess, sessionKey } from "./src/session-manager.js"

/** Replays a fixed line sequence, then stays alive and silent forever. */
function createSilentFakeCli(lines: unknown[]) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-result-fallback-"))
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

const init = { type: "system", subtype: "init", session_id: "fake-session", tools: ["Read"] }

const text = (body: string) => ({
  type: "stream_event",
  session_id: "fake-session",
  event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: body } },
})

async function streamParts(lines: unknown[], fallbackMs: number): Promise<any[]> {
  const fake = createSilentFakeCli(lines)
  const modelId = "claude-test-result-fallback"
  const sk = sessionKey(
    fake.cwd,
    `${modelId}::tools::default::context=["claude-code",null]`,
  )
  const previous = process.env.CLAUDE_CODE_RESULT_FALLBACK_MS
  process.env.CLAUDE_CODE_RESULT_FALLBACK_MS = String(fallbackMs)
  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: [],
    }).languageModel(modelId)

    const response = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
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
    if (previous === undefined) delete process.env.CLAUDE_CODE_RESULT_FALLBACK_MS
    else process.env.CLAUDE_CODE_RESULT_FALLBACK_MS = previous
    deleteActiveProcess(sk)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
}

test("a CLI that goes silent after content says so, and the stream closes", async () => {
  const parts = await streamParts([init, text("half an ans")], 400)

  const notes = parts.filter(
    (part) => part.type === "text-delta" && part.delta.includes(STREAM_TIMEOUT_MARKER),
  )
  assert.equal(notes.length, 1, "exactly one stream-timeout note")
  assert.match(notes[0].delta, /went silent for 1s/)
  assert.match(notes[0].delta, /closed without a result/)

  // Its own text part, which is what makes the transcript strip exact.
  const noteIndex = parts.indexOf(notes[0])
  assert.equal(parts[noteIndex - 1].type, "text-start")
  assert.equal(parts[noteIndex + 1].type, "text-end")

  // The model's own text is untouched.
  const body = parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
  assert.match(body, /half an ans/)

  // The stream really ended rather than hanging until the test timeout.
  assert.ok(parts.some((part) => part.type === "finish"))
})

test("the note is stripped from a rebuilt transcript", () => {
  const prompt = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "half an ans" },
        { type: "text", text: formatStreamTimeoutNote(60_000) },
      ],
    },
  ] as any

  const filtered = filterSideQuestionHistory(prompt)
  assert.equal(filtered.length, 2)
  assert.deepEqual((filtered[1] as any).content, [{ type: "text", text: "half an ans" }])
})

test("the note rounds the silence to whole seconds, never to zero", () => {
  assert.match(formatStreamTimeoutNote(60_000), /60s/)
  assert.match(formatStreamTimeoutNote(5_000), /5s/)
  assert.match(formatStreamTimeoutNote(10), /1s/)
})
