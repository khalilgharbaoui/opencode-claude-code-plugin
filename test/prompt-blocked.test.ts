/**
 * A message a `UserPromptSubmit` hook ended before the model saw it (h #g314).
 *
 * Claude Code writes one `system`/`informational` frame for it and then a
 * `success` result with no API call, so until this the plugin filed the turn
 * as an empty reply under a `no reply` note that said nothing failed. When the
 * blocked message was the replay of a conversation's history into a session
 * that had none, the session was recorded as the one that continues the
 * conversation, and every later message went to it with no history at all.
 *
 * The frames below are the ones measured on Claude Code 2.1.322 (and 2.1.314)
 * and 2.1.293 with a hook that blocks, copied in shape: the frame's `content`
 * and the result's `result` repeat the whole prompt, which is why every test
 * checks that a secret-like string in the prompt reaches neither the reply nor
 * the log.
 *
 * Usage: npx tsx --test test/prompt-blocked.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import {
  PROMPT_BLOCKED_MARKER,
  SILENT_TURN_MARKER,
  formatPromptBlockedNote,
  parsePromptBlock,
} from "../src/cli-events.js"
import { _resetServedConversations } from "../src/conversation-gap.js"
import { createClaudeCode } from "../src/index.js"
import { _resetLoggerForTests, configureLogger } from "../src/logger.js"
import {
  deleteClaudeSessionId,
  getActiveProcess,
  getClaudeSessionId,
  killAllActiveProcesses,
  sessionKey,
} from "../src/session-manager.js"
import { TURN_STATS_MARKER } from "../src/turn-stats.js"

after(() => {
  killAllActiveProcesses()
})

const SECRET = "FAKESECRET-0123456789abcdef"
const REASON = "probe-guard: blocked user prompt: it contains secret-like values"

const u = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] })
const a = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
})

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

/** 2.1.322's frame for `exit 2` from a hook, as measured. */
const blockedFrame = (prompt: string) => ({
  type: "system",
  subtype: "informational",
  content:
    "UserPromptSubmit operation blocked by hook:\n[/hooks/guard.sh]: " +
    REASON +
    "\n\n\nOriginal prompt: " +
    prompt,
  level: "warning",
  prevent_continuation: true,
  prompt_submit_outcome: { kind: "blocked_by_hook", prompt_kept: false, reason: REASON },
})

test("the 2.1.314+ frame is read off its outcome, never off its content", () => {
  const block = parsePromptBlock(blockedFrame(`hello ${SECRET}`) as any)
  assert.deepEqual(block, { kind: "blocked_by_hook", promptKept: false, reason: REASON })
  assert.doesNotMatch(JSON.stringify(block), new RegExp(SECRET))
})

test("2.1.293's frame, which carries no outcome, still reads as a block", () => {
  const frame: any = blockedFrame(`hello ${SECRET}`)
  delete frame.prompt_submit_outcome
  assert.deepEqual(parsePromptBlock(frame), { kind: "blocked_by_hook", promptKept: false })
})

test("every other frame is not a block", () => {
  assert.equal(parsePromptBlock({ type: "system", subtype: "init" } as any), null)
  assert.equal(
    parsePromptBlock({ type: "system", subtype: "informational", content: "Compacting" } as any),
    null,
  )
  assert.equal(
    parsePromptBlock({
      type: "system",
      subtype: "informational",
      prevent_continuation: true,
      content: "A Stop hook ended the turn",
    } as any),
    null,
  )
  assert.equal(
    parsePromptBlock({ type: "system", subtype: "informational", prompt_submit_outcome: {} } as any),
    null,
  )
  assert.equal(parsePromptBlock({ type: "result", subtype: "success" } as any), null)
})

test("a hook's reason is folded to one line and capped", () => {
  const long = parsePromptBlock({
    type: "system",
    subtype: "informational",
    prompt_submit_outcome: { kind: "blocked_by_hook", prompt_kept: false, reason: `a\n\n  b ${"x".repeat(500)}` },
  } as any)
  assert.ok(long?.reason)
  assert.ok(long.reason.startsWith("a b x"))
  assert.equal(long.reason.length, 300)
  assert.ok(long.reason.endsWith("..."))
})

test("a hook that stopped the turn kept the prompt, and says so", () => {
  const block = parsePromptBlock({
    type: "system",
    subtype: "informational",
    prompt_submit_outcome: { kind: "stopped_by_hook", prompt_kept: true },
  } as any)
  assert.deepEqual(block, { kind: "stopped_by_hook", promptKept: true })
  const note = formatPromptBlockedNote(block!, { midTurn: false, carriedHistory: false })
  assert.match(note, /stopped the turn on this message before Claude answered/)
})

test("the note has one shape per case and never an em dash", () => {
  const block = { kind: "blocked_by_hook", promptKept: false, reason: REASON }
  const own = formatPromptBlockedNote(block, { midTurn: false, carriedHistory: false })
  const replay = formatPromptBlockedNote(block, { midTurn: false, carriedHistory: true })
  const steered = formatPromptBlockedNote(block, { midTurn: true, carriedHistory: false })
  for (const note of [own, replay, steered]) {
    assert.ok(note.trimStart().startsWith(PROMPT_BLOCKED_MARKER), note)
    assert.match(note, new RegExp(REASON))
    assert.doesNotMatch(note, /—/)
  }
  assert.match(own, /nothing reached Claude and no model was called/)
  assert.match(replay, /earlier messages/)
  assert.match(replay, /next message replays them again/)
  assert.match(steered, /a message sent while Claude was working/)
  assert.match(steered, /the answer above did not see it/)
  const dropped = formatPromptBlockedNote(
    { kind: "dropped_by_hook", promptKept: false },
    { midTurn: false, carriedHistory: false },
  )
  assert.match(dropped, /A Claude Code plugin did not pass this message on/)
  assert.doesNotMatch(dropped, /\("/, "no reason, no quote")
})

// ---------------------------------------------------------------------------
// Through a real doStream
// ---------------------------------------------------------------------------

function fixture(settings: Record<string, unknown> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-prompt-blocked-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const record = join(cwd, "envelopes.jsonl")
  const allow = join(cwd, "allow")
  writeFileSync(
    cliPath,
    `#!${process.execPath}
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) {
  console.log("2.1.322")
  process.exit(0)
}
const session = "session-" + process.pid
const emit = (message) => console.log(JSON.stringify({ session_id: session, ...message }))
const REASON = ${JSON.stringify(REASON)}
const blockedContent = (prompt) =>
  "UserPromptSubmit operation blocked by hook:\\n[/hooks/guard.sh]: " + REASON +
  "\\n\\n\\nOriginal prompt: " + prompt
const result = (turns, text) => emit({ type: "result", subtype: "success", is_error: false,
  num_turns: turns, result: text, total_cost_usd: turns ? 0.001 : 0,
  usage: { input_tokens: turns, output_tokens: turns } })
const say = (text) => emit({ type: "assistant", message: { role: "assistant",
  stop_reason: "end_turn", content: [{ type: "text", text }] } })
let started = false
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const envelope = JSON.parse(line)
  if (envelope.type !== "user") return
  fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({
    pid: process.pid, argv: process.argv.slice(2), stdin: line,
  }) + "\\n")
  if (!started) {
    started = true
    emit({ type: "system", subtype: "init" })
  }
  const prompt = envelope.message.content.map((part) => part.text ?? "").join("\\n")
  const allowed = fs.existsSync(${JSON.stringify(allow)})
  if (prompt.includes("BLOCKME") && !allowed) {
    const content = blockedContent(prompt)
    emit({ type: "system", subtype: "informational", content, level: "warning",
      prevent_continuation: true,
      prompt_submit_outcome: { kind: "blocked_by_hook", prompt_kept: false, reason: REASON } })
    return result(0, content)
  }
  if (prompt.includes("LEGACYBLOCK")) {
    const content = blockedContent(prompt)
    emit({ type: "system", subtype: "informational", content, level: "warning",
      prevent_continuation: true })
    return result(0, content)
  }
  if (prompt.includes("STEER")) {
    say("working")
    emit({ type: "system", subtype: "informational", content: blockedContent("BLOCKME steered"),
      level: "warning", prevent_continuation: true,
      prompt_submit_outcome: { kind: "blocked_by_hook", prompt_kept: false, reason: REASON } })
    say("done after the steer")
    return result(2, "done after the steer")
  }
  say("answered by " + process.pid)
  result(1, "answered by " + process.pid)
})
`,
    { mode: 0o755 },
  )
  const modelId = "claude-haiku-4-5"
  const provider = createClaudeCode({
    cwd,
    cliPath,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    interactive: false,
    autoContinueIncompleteTurns: false,
    resumeAfterRestart: false,
    turnStats: true,
    ...settings,
  })
  const key = sessionKey(cwd, `${modelId}::tools::conversation::context=["claude-code","build"]`)
  const turn = async (prompt: unknown[], agent = "build") => {
    const options: LanguageModelV3CallOptions = {
      tools: [{ type: "function", name: "read", inputSchema: { type: "object" } }],
      providerOptions: {
        "claude-code": { opencodeSessionID: "conversation", opencodeAgent: agent },
      },
      prompt: prompt as any,
    }
    const response = await provider.languageModel(modelId).doStream(options)
    const parts: any[] = []
    for await (const part of response.stream) parts.push(part)
    const text = parts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("")
    const finish = parts.find((part) => part.type === "finish")
    const errors = parts.filter((part) => part.type === "error")
    return { text, finish, errors }
  }
  const envelopes = (): Array<{ pid: number; argv: string[]; stdin: string }> =>
    existsSync(record)
      ? readFileSync(record, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
  const cleanup = () => {
    killAllActiveProcesses()
    deleteClaudeSessionId(key)
    _resetServedConversations()
    rmSync(cwd, { recursive: true, force: true })
  }
  return { cwd, key, turn, envelopes, allowReplay: () => writeFileSync(allow, ""), cleanup }
}

const historyBlock = (stdin: string): string | null => {
  const start = stdin.indexOf("<conversation_history>")
  if (start < 0) return null
  return stdin.slice(start, stdin.indexOf("</conversation_history>"))
}

const lastText = (stdin: string): string => {
  const texts = JSON.parse(stdin).message.content.map((part: any) => part.text)
  return texts[texts.length - 1]
}

test("a blocked message fails the turn, names the hook, and the session goes on", {
  timeout: 60_000,
}, async () => {
  _resetServedConversations()
  const f = fixture()
  const logDir = mkdtempSync(join(tmpdir(), "opencode-prompt-blocked-log-"))
  const priorFile = process.env.OPENCODE_CLAUDE_CODE_LOG_FILE
  const priorDir = process.env.OPENCODE_CLAUDE_CODE_LOG_DIR
  try {
    process.env.OPENCODE_CLAUDE_CODE_LOG_FILE = "1"
    process.env.OPENCODE_CLAUDE_CODE_LOG_DIR = logDir
    configureLogger({ file: true, dir: logDir, level: "info", mode: "silent" })
    const blocked = await f.turn([u(`hello BLOCKME ${SECRET}`)])

    assert.deepEqual(blocked.finish.finishReason, { unified: "error", raw: "blocked_by_hook" })
    assert.equal(blocked.errors.length, 0, "the note is the account of it, not an error part")
    assert.ok(blocked.text.includes(PROMPT_BLOCKED_MARKER), blocked.text)
    assert.ok(blocked.text.includes(REASON), blocked.text)
    assert.match(blocked.text, /nothing reached Claude/)
    assert.ok(!blocked.text.includes(SILENT_TURN_MARKER), "not an empty reply")
    assert.ok(!blocked.text.includes(TURN_STATS_MARKER), "nothing was served, so no footer")
    assert.ok(!blocked.text.includes(SECRET), "the prompt is never echoed")
    assert.ok(!blocked.text.includes("Original prompt"))

    // The session had nothing to lose, so it stays: the next message goes to
    // the same process, bare, and the blocked one is not sent again.
    const sessionId = getClaudeSessionId(f.key)
    assert.ok(sessionId)
    const next = await f.turn([u(`hello BLOCKME ${SECRET}`), a(blocked.text), u("next")])
    assert.match(next.text, /answered by/)
    assert.deepEqual(next.finish.finishReason, { unified: "stop", raw: "stop" })
    const sent = f.envelopes()
    assert.equal(sent.length, 2)
    assert.equal(sent[1].pid, sent[0].pid, "the same process answered it")
    assert.equal(lastText(sent[1].stdin), "next")
    assert.equal(historyBlock(sent[1].stdin), null)
    assert.doesNotMatch(sent[1].stdin, /BLOCKME/)
  } finally {
    if (priorFile === undefined) delete process.env.OPENCODE_CLAUDE_CODE_LOG_FILE
    else process.env.OPENCODE_CLAUDE_CODE_LOG_FILE = priorFile
    if (priorDir === undefined) delete process.env.OPENCODE_CLAUDE_CODE_LOG_DIR
    else process.env.OPENCODE_CLAUDE_CODE_LOG_DIR = priorDir
    _resetLoggerForTests()
    f.cleanup()
  }
  const written = join(logDir, "plugin.log")
  const log = existsSync(written) ? readFileSync(written, "utf8") : ""
  rmSync(logDir, { recursive: true, force: true })
  const warned = log.split("\n").filter((line) => line.includes("before the model saw it"))
  assert.equal(warned.length, 1, log)
  assert.match(warned[0], /WARN/)
  assert.match(warned[0], /"kind":"blocked_by_hook"/)
  assert.ok(!log.includes(SECRET), "the prompt never reaches the log")
  assert.ok(!log.includes(REASON), "nor the hook's sentence")
})

test("a blocked replay drops the empty session, so the next message replays again", {
  timeout: 60_000,
}, async () => {
  _resetServedConversations()
  const f = fixture()
  try {
    // A key with no session and a conversation behind it: the thread is
    // replayed as text, and the hook blocks the replay.
    const history = [u(`one BLOCKME ${SECRET}`), a("A1"), u("two")]
    const blocked = await f.turn(history)
    const first = f.envelopes()[0]
    assert.ok(historyBlock(first.stdin), "the envelope was a replay")
    assert.deepEqual(blocked.finish.finishReason, { unified: "error", raw: "blocked_by_hook" })
    assert.ok(blocked.text.includes(PROMPT_BLOCKED_MARKER), blocked.text)
    assert.match(blocked.text, /earlier messages/)
    assert.match(blocked.text, /next message replays them again/)
    assert.ok(!blocked.text.includes(SECRET))

    // Nothing is left to record that session as the one that continues it.
    assert.equal(getClaudeSessionId(f.key), undefined)
    assert.equal(getActiveProcess(f.key), undefined)

    // The operator lets the replay through: the next message carries the
    // history again, into a fresh process.
    f.allowReplay()
    const next = await f.turn([...history, a(blocked.text), u("three")])
    assert.match(next.text, /answered by/)
    const sent = f.envelopes()
    assert.equal(sent.length, 2)
    assert.notEqual(sent[1].pid, first.pid, "a fresh process")
    const replay = historyBlock(sent[1].stdin)
    assert.ok(replay, sent[1].stdin.slice(0, 400))
    assert.match(replay, /User: one/)
    assert.match(replay, /Assistant: A1/)
    assert.ok(!replay.includes(PROMPT_BLOCKED_MARKER), "the note is never replayed as Claude's")
    assert.equal(lastText(sent[1].stdin), "three")
  } finally {
    f.cleanup()
  }
})

test("before 2.1.314 the frame has no outcome, and the turn still fails", {
  timeout: 60_000,
}, async () => {
  _resetServedConversations()
  const f = fixture()
  try {
    const blocked = await f.turn([u(`LEGACYBLOCK ${SECRET}`)])
    assert.deepEqual(blocked.finish.finishReason, { unified: "error", raw: "blocked_by_hook" })
    assert.ok(blocked.text.includes(PROMPT_BLOCKED_MARKER), blocked.text)
    assert.ok(!blocked.text.includes('("'), "no reason to quote")
    assert.ok(!blocked.text.includes(SECRET))
  } finally {
    f.cleanup()
  }
})

test("a message blocked inside a turn that went on gets a note, not a failure", {
  timeout: 60_000,
}, async () => {
  _resetServedConversations()
  const f = fixture()
  try {
    const steered = await f.turn([u("STEER please")])
    assert.deepEqual(steered.finish.finishReason, { unified: "stop", raw: "stop" })
    assert.match(steered.text, /working/)
    assert.match(steered.text, /done after the steer/)
    assert.ok(steered.text.includes(PROMPT_BLOCKED_MARKER), steered.text)
    assert.match(steered.text, /a message sent while Claude was working/)
    assert.ok(steered.text.includes(TURN_STATS_MARKER), "the turn was served")
    assert.ok(getClaudeSessionId(f.key), "the session is kept")
  } finally {
    f.cleanup()
  }
})

test("a blocked compaction writes no text and ends on an error", {
  timeout: 60_000,
}, async () => {
  _resetServedConversations()
  const f = fixture()
  try {
    const compacted = await f.turn(
      [u(`one BLOCKME ${SECRET}`), a("A1"), u("Summarise the conversation.")],
      "compaction",
    )
    assert.equal(compacted.finish.finishReason.unified, "error")
    assert.equal(compacted.finish.finishReason.raw, "blocked_by_hook")
    assert.equal(compacted.text, "", "a compaction's text is stored as the summary")
    assert.equal(compacted.errors.length, 1)
    assert.match(String(compacted.errors[0].error.message), /could not compact/)
    assert.match(String(compacted.errors[0].error.message), /UserPromptSubmit hook/)
    assert.ok(!String(compacted.errors[0].error.message).includes(SECRET))
  } finally {
    f.cleanup()
  }
})
