/**
 * The turn-history store the progress estimate is drawn from (h #g247,
 * h #g251): the store's round trip, bounds and discipline; the counts both
 * halves share (the prompt's length, the turn's tool calls, where a turn
 * starts, whether it ended on a failed tool, the session tag); the
 * turn-start registry and the output each API call adds to it and to the
 * live channel; and a real `doStream` through a fake CLI writing one sample
 * keyed on the agent and model it spawned. The estimate itself is
 * `test/turn-model.test.ts`, the channel's store
 * `test/turn-progress-store.test.ts`.
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  MAX_TURN_KEYS,
  MAX_TURN_SAMPLES,
  TURN_SAMPLE_MAX_AGE_MS,
  _setTurnHistoryStorePathForTests,
  createTurnHistoryReader,
  lastToolResultFailed,
  markTurnStart,
  newestPromptChars,
  noteTurnOutput,
  promptChars,
  recordTurnSample,
  sessionTag,
  startsTurn,
  takeTurnStart,
  turnHistoryKey,
  turnHistoryStorePath,
  turnToolCalls,
  type TurnSample,
} from "../src/turn-history.js"
import { _setTurnProgressStorePathForTests } from "../src/turn-progress-store.js"

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-turn-history-"))
  _setTurnHistoryStorePathForTests(join(dir, "state", "turn-history.json"))
  return dir
}

const onDisk = () => JSON.parse(readFileSync(turnHistoryStorePath(), "utf8"))
const NOW = 1_800_000_000_000
const sample = (ms: number, over: Partial<TurnSample> = {}): TurnSample => ({ ms, at: NOW, ...over })

test("turnHistoryKey is the agent and the model, `main` when the turn has no agent", () => {
  assert.equal(turnHistoryKey("build", "claude-opus-5-5"), "build/claude-opus-5-5")
  assert.equal(turnHistoryKey("explore", "claude-haiku-5-5"), "explore/claude-haiku-5-5")
  assert.equal(turnHistoryKey(undefined, "claude-opus-5-5"), "main/claude-opus-5-5")
  assert.equal(turnHistoryKey("", "claude-opus-5-5"), "main/claude-opus-5-5")
})

test("sessionTag is a stable eight-hex-digit hash of the session id, never the id, and nothing for no session", () => {
  const tag = sessionTag("ses_0123456789abcdefABCDEF")
  assert.match(tag ?? "", /^[0-9a-f]{8}$/)
  assert.equal(sessionTag("ses_0123456789abcdefABCDEF"), tag, "the same id is the same tag on both halves")
  assert.notEqual(sessionTag("ses_0123456789abcdefABCDEG"), tag, "a different id is a different tag")
  assert.ok(!"ses_0123456789abcdefABCDEF".includes(tag!), "the tag is not a piece of the id")
  // FNV-1a's published test vectors: the empty input's offset basis is never
  // reached (no id is no tag), and "a" hashes to 0xe40c292c.
  assert.equal(sessionTag("a"), "e40c292c")
  assert.equal(sessionTag(undefined), undefined)
  assert.equal(sessionTag(""), undefined)
  assert.equal(sessionTag("default"), undefined, "the affinity of a turn opencode did not tag")
})

test("promptChars counts the text with the host's injected blocks taken off, and no text at all is unknown", () => {
  assert.equal(promptChars(["hello world"]), 11)
  assert.equal(promptChars(["hello <system-reminder>\nlong\n</system-reminder> world"]), 12)
  assert.equal(promptChars(["go<dcp-message-id>m0141</dcp-message-id>"]), 2)
  assert.equal(promptChars(["<dcp-system-reminder>only this</dcp-system-reminder>"]), 0)
  assert.equal(promptChars(["  padded  ", "two"]), 9)
  assert.equal(promptChars([]), undefined)
})

test("newestPromptChars reads the last user message, and startsTurn tells a fresh prompt from a continuation", () => {
  const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
  const assistant = { role: "assistant", content: [{ type: "text", text: "a much longer reply than the prompt" }] }
  const tool = { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", output: { type: "text", value: "x" } }] }
  assert.equal(newestPromptChars([user("first"), assistant, user("second one")]), 10)
  assert.equal(newestPromptChars([user("first"), assistant, tool]), 5)
  assert.equal(newestPromptChars([{ role: "user", content: "plain string" }]), 12)
  assert.equal(newestPromptChars([{ role: "user", content: [{ type: "file", data: "..." }] }]), undefined)
  assert.equal(newestPromptChars([]), undefined)

  assert.equal(startsTurn([user("hello")]), true)
  assert.equal(startsTurn([user("hello"), assistant, user("again")]), true)
  // A tool result continues the turn that made the call.
  assert.equal(startsTurn([user("hello"), assistant, tool]), false)
  // So does a user message the host promoted beside one.
  assert.equal(startsTurn([user("hello"), assistant, tool, user("steer")]), false)
  assert.equal(startsTurn([user("hello"), assistant]), false)
  assert.equal(startsTurn([]), false)
  // Told which calls are still parked: a tool result for one of them is a
  // continuation, a tool result for none of them is the prompt after an
  // interrupted turn, which starts one (h #g251).
  assert.equal(startsTurn([user("hello"), assistant, tool, user("steer")], new Set(["t1"])), false)
  assert.equal(startsTurn([user("hello"), assistant, tool, user("after the interrupt")], new Set(["t9"])), true)
  assert.equal(startsTurn([user("hello"), assistant, tool, user("after the interrupt")], new Set()), true)
  assert.equal(startsTurn([user("hello"), assistant, tool], new Set()), false, "no user message, no turn")
})

test("lastToolResultFailed reads the newest tool result of this turn, past a steered message and never before the turn's start", () => {
  const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
  const assistant = { role: "assistant", content: [{ type: "tool-call", toolCallId: "t", toolName: "bash", input: {} }] }
  const result = (output: unknown) => ({ role: "tool", content: [{ type: "tool-result", toolCallId: "t", output }] })
  const ok = result({ type: "text", value: "fine" })
  const failed = result({ type: "error-text", value: "boom" })
  assert.equal(lastToolResultFailed([user("go"), assistant, failed], 1), true)
  assert.equal(lastToolResultFailed([user("go"), assistant, result({ type: "error-json", value: {} })], 1), true)
  assert.equal(lastToolResultFailed([user("go"), assistant, result({ type: "execution-denied", reason: "no" })], 1), true)
  assert.equal(lastToolResultFailed([user("go"), assistant, ok], 1), false)
  // The newest result decides, and a steered message is looked past.
  assert.equal(lastToolResultFailed([user("go"), assistant, failed, assistant, ok], 1), false)
  assert.equal(lastToolResultFailed([user("go"), assistant, failed, user("steer")], 1), true)
  // A tool message from before the turn started is not this turn's.
  assert.equal(lastToolResultFailed([user("go"), assistant, failed, user("next")], 4), false)
  // A plain-string output, a message with no results, and no tool message at all.
  assert.equal(lastToolResultFailed([user("go"), assistant, result("text")], 1), false)
  assert.equal(lastToolResultFailed([user("go"), assistant, { role: "tool", content: [] }], 1), false)
  assert.equal(lastToolResultFailed([user("go"), assistant], 0), false)
})

test("a turn's start is taken once, the newest mark on a key wins, and it carries where the prompt stood", () => {
  _setTurnHistoryStorePathForTests(null)
  markTurnStart("key-a", { at: 1_000, chars: 42 })
  markTurnStart("key-a", { at: 2_000 })
  assert.deepEqual(takeTurnStart("key-a"), { at: 2_000 })
  assert.equal(takeTurnStart("key-a"), undefined, "a second result in the same turn finds nothing")
  assert.equal(takeTurnStart("never-marked"), undefined)
  markTurnStart("key-b", { at: 3_000, chars: 7, promptLength: 5, ...({ out: 99 } as object) })
  assert.deepEqual(takeTurnStart("key-b"), { at: 3_000, chars: 7, promptLength: 5 }, "a new turn starts with no output")
})

test("each API call's output is added to the turn and written to the live channel under the session's tag", () => {
  const dir = scratch()
  const channel = join(dir, "state", "turn-progress.json")
  _setTurnProgressStorePathForTests(channel)
  try {
    const tag = sessionTag("ses_live")!
    markTurnStart("key-live", { at: NOW, session: tag })
    noteTurnOutput("key-live", 41, NOW + 1_000)
    assert.deepEqual(JSON.parse(readFileSync(channel, "utf8")).turns[tag], { turn: NOW, out: 41, at: NOW + 1_000 })
    noteTurnOutput("key-live", 959, NOW + 2_000)
    assert.deepEqual(JSON.parse(readFileSync(channel, "utf8")).turns[tag], { turn: NOW, out: 1_000, at: NOW + 2_000 })
    assert.equal(takeTurnStart("key-live")?.out, 1_000, "the sample is given the same total")
    // No turn marked (a compaction, a `default` affinity), no session to write
    // under, or an unusable count: nothing changes.
    noteTurnOutput("never-marked", 5, NOW + 3_000)
    markTurnStart("key-untagged", { at: NOW })
    noteTurnOutput("key-untagged", 5, NOW + 3_000)
    noteTurnOutput("key-untagged", Number.NaN, NOW + 3_000)
    assert.equal(takeTurnStart("key-untagged")?.out, 5)
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(channel, "utf8")).turns), [tag])
  } finally {
    _setTurnProgressStorePathForTests(null)
    _setTurnHistoryStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a sample round-trips with nothing but its eight fields, `failed` is written only when true, and a session is only ever a tag", () => {
  const dir = scratch()
  try {
    const tag = sessionTag("ses_round_trip")!
    assert.equal(
      recordTurnSample("build/claude-opus-5-5", {
        ms: 61_230.4,
        chars: 420,
        effort: "high",
        calls: 3.2,
        out: 5_321.4,
        failed: false,
        session: tag,
        at: NOW,
        ...({ prompt: "secret", sessionKey: "/x" } as object),
      } as TurnSample),
      true,
    )
    const [entry] = onDisk().turns["build/claude-opus-5-5"]
    assert.deepEqual(entry, { ms: 61_230, chars: 420, effort: "high", calls: 3, out: 5_321, session: tag, at: NOW })
    assert.deepEqual(Object.keys(entry).sort(), ["at", "calls", "chars", "effort", "ms", "out", "session"])
    assert.equal(recordTurnSample("build/claude-opus-5-5", { ms: 1, out: -1, at: NOW }), false)
    assert.equal(recordTurnSample("build/claude-opus-5-5", { ms: 6_077, calls: 1, failed: true, at: NOW + 1 }), true)
    assert.deepEqual(onDisk().turns["build/claude-opus-5-5"][1], { ms: 6_077, calls: 1, failed: true, at: NOW + 1 })
    // An unusable sample is not written, and says so.
    assert.equal(recordTurnSample("build/claude-opus-5-5", { ms: -1, at: NOW }), false)
    assert.equal(recordTurnSample("build/claude-opus-5-5", { ms: 1, calls: -1, at: NOW }), false)
    assert.equal(recordTurnSample("build/claude-opus-5-5", { ms: 1, at: NOW, ...({ failed: "yes" } as object) } as TurnSample), false)
    // A raw session id is refused: the store holds a tag of it or nothing.
    assert.equal(recordTurnSample("build/claude-opus-5-5", { ms: 1, session: "ses_round_trip", at: NOW }), false)
    assert.equal(recordTurnSample("", { ms: 1, at: NOW }), false)
    assert.equal(onDisk().turns["build/claude-opus-5-5"].length, 2)
  } finally {
    _setTurnHistoryStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the file is 0600 in a 0700 directory, because the state directory is shared", { skip: process.platform === "win32" }, () => {
  const dir = scratch()
  try {
    recordTurnSample("build/claude-opus-5-5", sample(1_000))
    assert.equal(statSync(turnHistoryStorePath()).mode & 0o777, 0o600)
    assert.equal(statSync(join(dir, "state")).mode & 0o777, 0o700)
  } finally {
    _setTurnHistoryStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a second writer's keys survive a write, and the store is bounded per key, in keys, and by age", () => {
  const dir = scratch()
  try {
    mkdirSync(join(dir, "state"), { recursive: true })
    const turns: Record<string, unknown> = {
      "explore/claude-haiku-5-5": [{ ms: 9_000, at: NOW - 10 }],
      "plan/claude-opus-5-5": [{ ms: 9_000, at: NOW - TURN_SAMPLE_MAX_AGE_MS - 1 }],
      "junk/claude-opus-5-5": [{ ms: "fast", at: NOW }, "not a sample", { ms: 1, at: NOW, chars: -5 }],
      "": [{ ms: 1, at: NOW }],
    }
    writeFileSync(turnHistoryStorePath(), JSON.stringify({ version: 1, turns }))
    recordTurnSample("build/claude-opus-5-5", sample(61_000))
    assert.deepEqual(Object.keys(onDisk().turns).sort(), ["build/claude-opus-5-5", "explore/claude-haiku-5-5"])

    for (let index = 0; index < MAX_TURN_SAMPLES + 5; index += 1) {
      recordTurnSample("build/claude-opus-5-5", sample(1_000 + index, { at: NOW + index + 1 }))
    }
    const kept = onDisk().turns["build/claude-opus-5-5"]
    assert.equal(kept.length, MAX_TURN_SAMPLES)
    assert.equal(kept[kept.length - 1].ms, 1_000 + MAX_TURN_SAMPLES + 4, "the newest is kept")
    assert.equal(kept[0].at, NOW + 6, "the oldest went first")

    for (let index = 0; index < MAX_TURN_KEYS + 3; index += 1) {
      recordTurnSample(`agent-${index}/claude-opus-5-5`, sample(1_000, { at: NOW + 1_000 + index }))
    }
    const keys = Object.keys(onDisk().turns)
    assert.equal(keys.length, MAX_TURN_KEYS)
    assert.ok(keys.includes(`agent-${MAX_TURN_KEYS + 2}/claude-opus-5-5`), "the key written last is kept")
    assert.ok(!keys.includes("explore/claude-haiku-5-5"), "the key with the oldest samples went first")
  } finally {
    _setTurnHistoryStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the reader re-parses only a changed file and treats a broken one as empty", () => {
  const dir = scratch()
  try {
    const reader = createTurnHistoryReader()
    assert.equal(reader.read().size, 0, "no file yet")
    recordTurnSample("build/claude-opus-5-5", sample(61_000, { effort: "low" }))
    const first = reader.read()
    assert.equal(first.get("build/claude-opus-5-5")?.[0].effort, "low")
    assert.equal(reader.read(), first, "an unchanged file returns the same map")

    writeFileSync(turnHistoryStorePath(), "{ half written")
    assert.equal(reader.read().size, 0)
  } finally {
    _setTurnHistoryStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("turnToolCalls counts the turn's tool calls since the message that started it, a steered message included", () => {
  const call = { type: "tool-call", toolCallId: "t", toolName: "bash", input: {} }
  const prompt = [
    { role: "user", content: [{ type: "text", text: "earlier" }] },
    { role: "assistant", content: [call] },
    { role: "tool", content: [] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: [{ type: "text", text: "now" }] },
    { role: "assistant", content: [call, call] },
    { role: "tool", content: [] },
    { role: "assistant", content: [{ type: "text", text: "and" }, call] },
    { role: "tool", content: [] },
    { role: "user", content: [{ type: "text", text: "steered" }] },
  ]
  assert.equal(turnToolCalls(prompt), 3, "the earlier turn's call is not counted, and the steered message does not restart the count")
  assert.equal(turnToolCalls(prompt.slice(0, 5)), 0, "a fresh message has made none")
  assert.equal(turnToolCalls(prompt.slice(0, 7)), 2)
  assert.equal(turnToolCalls([]), 0)
  // Told where the turn started (the prompt's length when it was marked), the
  // count is from there: here the turn that started after the first reply,
  // whose prompt ends in an interrupted call's result before the new message.
  const interrupted = [
    { role: "user", content: [{ type: "text", text: "earlier" }] },
    { role: "assistant", content: [call] },
    { role: "tool", content: [] },
    { role: "user", content: [{ type: "text", text: "after the interrupt" }] },
    { role: "assistant", content: [call, call] },
    { role: "tool", content: [] },
  ]
  assert.equal(turnToolCalls(interrupted, 4), 2)
  assert.equal(turnToolCalls(interrupted), 3, "without the start, the plain rule reads the tool message as a continuation")
  assert.equal(turnToolCalls(interrupted, 40), 3, "a start past the prompt's end (a compaction between) falls back to the rule")
})

// The fake CLI is a shebang script made executable with chmod, which means
// nothing on Windows (see .github/windows-skipped-tests.txt).
test("a real turn records its duration under the agent and model it spawned, with the prompt's length, the effort, its tool calls, its output, that it ended on a failed one, and its session's tag", { skip: process.platform === "win32" }, async () => {
  const dir = scratch()
  const savedHome = process.env.HOME
  const savedState = process.env.XDG_STATE_HOME
  const { createClaudeCode } = await import("../src/index.js")
  const { deleteActiveProcessAndWait, snapshotActiveProcesses } = await import("../src/session-manager.js")
  const cwd = join(dir, "project")
  mkdirSync(cwd, { recursive: true })
  const cliPath = join(dir, "fake-claude.cjs")
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) { process.stdout.write("2.1.293\\n"); process.exit(0) }
if (process.argv.includes("--help")) { process.stdout.write("Usage: claude\\n"); process.exit(0) }
const session_id = "fake-turn-history"
const emit = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
require("node:readline").createInterface({ input: process.stdin }).on("line", () => {
  emit({ type: "system", subtype: "init", session_id })
  // One CLI-executed call the CLI refuses, then the reply: the sample counts
  // the call and is marked failed, as the haiku child of h #g251 was.
  emit({ type: "assistant", session_id, message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_read_1", name: "Read", input: { file_path: "/x" } }] } })
  emit({ type: "user", session_id, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read_1", is_error: true, content: "Read is disabled for this session" }] } })
  emit({ type: "assistant", session_id, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } })
  // Each call's real output count, in the shape 2.1.293 sends it. Both come
  // after the content frames because a stream_event turns the parser's
  // partial mode on, and this fake streams no partial content blocks.
  emit({ type: "stream_event", session_id, event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 120 } } })
  emit({ type: "stream_event", session_id, event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 30 } } })
  setTimeout(() => {
    emit({ type: "result", subtype: "success", session_id, is_error: false, usage: { input_tokens: 1, output_tokens: 1 } })
  }, 80)
})
`,
  )
  chmodSync(cliPath, 0o755)
  process.env.HOME = dir
  process.env.XDG_STATE_HOME = join(dir, "xdg-state")
  const modelId = "claude-sonnet-5-5"
  const affinity = "ses_turn_history"
  try {
    const model = createClaudeCode({
      cliPath,
      cwd,
      bridgeOpencodeMcp: false,
      bridgeOpencodeSkills: false,
      proxyTools: [],
      autoContinueIncompleteTurns: false,
    }).languageModel(modelId)
    const started = Date.now()
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello world <system-reminder>ignored</system-reminder>" }] }],
      // A tool set, or the turn is a title request and never spawns.
      tools: [{ type: "function", name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
      headers: { "x-session-affinity": affinity },
      providerOptions: { "claude-code": { reasoningEffort: "high", opencodeAgent: "build" } },
    } as never)
    for await (const _part of (result as { stream: AsyncIterable<unknown> }).stream) {
      // drain
    }
    const elapsed = Date.now() - started
    const turns = onDisk().turns
    assert.deepEqual(Object.keys(turns), [`build/${modelId}`])
    const [entry] = turns[`build/${modelId}`]
    assert.ok(entry.ms >= 80 && entry.ms <= elapsed, `the sample's duration is the turn's: ${entry.ms} of ${elapsed}`)
    assert.equal(entry.chars, 11, "the prompt's length, the reminder block taken off")
    assert.equal(entry.effort, "high")
    assert.equal(entry.calls, 1, "the step's own CLI-executed call is counted")
    assert.equal(entry.failed, true, "the CLI's own refusal of the call is the turn's last tool result")
    assert.equal(entry.session, sessionTag(affinity), "the conversation, as the tag the TUI computes from the same id")
    assert.ok(!JSON.stringify(entry).includes(affinity), "never the session id itself")
    assert.equal(entry.out, 150, "both calls' output, off their message_delta events")
    assert.ok(entry.at >= started)
    // The live channel saw the same total as the turn ran, under the same tag.
    const channel = JSON.parse(
      readFileSync(join(dir, "xdg-state", "opencode-claude-code-plugin", "turn-progress.json"), "utf8"),
    )
    const live = channel.turns[sessionTag(affinity)!]
    assert.equal(live.out, 150)
    assert.ok(live.turn >= started && live.turn <= entry.at, "the turn's start, as the server half marked it")
    assert.ok(!JSON.stringify(channel).includes(affinity), "never the session id itself")
  } finally {
    for (const active of snapshotActiveProcesses()) {
      if (active.sessionKey.includes(affinity)) await deleteActiveProcessAndWait(active.sessionKey)
    }
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedState === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = savedState
    _setTurnHistoryStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a turn that ended on an API error the CLI gave up on records no sample", { skip: process.platform === "win32" }, async () => {
  const dir = scratch()
  const savedHome = process.env.HOME
  const savedState = process.env.XDG_STATE_HOME
  const { createClaudeCode } = await import("../src/index.js")
  const { deleteActiveProcessAndWait, snapshotActiveProcesses } = await import("../src/session-manager.js")
  const cwd = join(dir, "project")
  mkdirSync(cwd, { recursive: true })
  const cliPath = join(dir, "fake-claude.cjs")
  // The 529 shape Claude Code 2.1.314 writes once its own retries are spent
  // (h #g281): a `<synthetic>` reply, then `success` with `is_error: true`.
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) { process.stdout.write("2.1.314\\n"); process.exit(0) }
if (process.argv.includes("--help")) { process.stdout.write("Usage: claude\\n"); process.exit(0) }
const session_id = "fake-turn-history-529"
const said = "API Error: 529 Overloaded."
const emit = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
require("node:readline").createInterface({ input: process.stdin }).on("line", () => {
  emit({ type: "system", subtype: "init", session_id })
  emit({ type: "assistant", session_id, error: "server_error", is_api_error_message: true, api_error_status: 529, message: { model: "<synthetic>", role: "assistant", stop_reason: "stop_sequence", content: [{ type: "text", text: said }] } })
  emit({ type: "result", subtype: "success", session_id, is_error: true, api_error_status: 529, terminal_reason: "api_error", result: said, usage: { input_tokens: 0, output_tokens: 0 } })
})
`,
  )
  chmodSync(cliPath, 0o755)
  process.env.HOME = dir
  process.env.XDG_STATE_HOME = join(dir, "xdg-state")
  const affinity = "ses_turn_history_529"
  try {
    const model = createClaudeCode({
      cliPath,
      cwd,
      bridgeOpencodeMcp: false,
      bridgeOpencodeSkills: false,
      proxyTools: [],
    }).languageModel("claude-sonnet-5-5")
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [{ type: "function", name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
      headers: { "x-session-affinity": affinity },
      providerOptions: { "claude-code": { opencodeAgent: "build" } },
    } as never)
    let finish: { finishReason?: { unified?: string } } | undefined
    for await (const part of (result as { stream: AsyncIterable<{ type: string }> }).stream) {
      if (part.type === "finish") finish = part as typeof finish
    }
    assert.equal(finish?.finishReason?.unified, "error")
    assert.equal(existsSync(turnHistoryStorePath()), false, "a failed turn says nothing about a served one's length")
  } finally {
    for (const active of snapshotActiveProcesses()) {
      if (active.sessionKey.includes(affinity)) await deleteActiveProcessAndWait(active.sessionKey)
    }
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedState === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = savedState
    _setTurnHistoryStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
