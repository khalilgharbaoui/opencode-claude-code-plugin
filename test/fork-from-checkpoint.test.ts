/**
 * A new opencode session forked from a turn another session served ("fork
 * from here", `/fork`) continues a copy of that session's Claude conversation
 * cut at the turn (`forkFromCheckpoint`, h #g305): `findForkCheckpoint` and
 * every refusal, `lastReplyText`, then a fake CLI driving real `doStream` turns
 * over two opencode sessions.
 *
 * Usage: npx tsx --test test/fork-from-checkpoint.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import {
  _resetServedConversations,
  CONVERSATION_REWOUND_MARKER,
  findForkCheckpoint,
  recordServedConversation,
} from "../src/conversation-gap.js"
import { lastReplyText } from "../src/message-builder.js"
import {
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  getClaudeSessionId,
  sessionKey,
} from "../src/session-manager.js"
import { detectCliVersion } from "../src/cli-version.js"
import { encodeCwd } from "../src/claude-session-bun.js"
import { TURN_STATS_MARKER } from "../src/turn-stats.js"
import { createClaudeCode } from "../src/index.js"

const u = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] })
const a = (text: string) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }] })
const p = (messages: unknown[]) => messages as any

const key = (affinity: string, model = "m", context = '["claude-code","build"]') =>
  `/tmp/fork-cp::${model}::tools::${affinity}::context=${context}`
const KA = key("ses_a")
const KB = key("ses_b")
const CLI = "/bin/claude-a"

/** A's three served turns, each checkpointed with the reply Claude wrote. */
function serveParent(parentKey = KA, cliPath = CLI, replies = ["R1", "R2", "R3"]) {
  const t1 = [u("one")]
  const t2 = [...t1, a(replies[0]), u("two")]
  const t3 = [...t2, a(replies[1]), u("three")]
  recordServedConversation(parentKey, p(t1), { claudeSessionId: "S1", messageUuid: "e1", cliPath, replyText: replies[0] })
  recordServedConversation(parentKey, p(t2), { claudeSessionId: "S1", messageUuid: "e2", cliPath, replyText: replies[1] })
  recordServedConversation(parentKey, p(t3), { claudeSessionId: "S1", messageUuid: "e3", cliPath, replyText: replies[2] })
}

const find = (prompt: unknown[], overrides: Partial<Parameters<typeof findForkCheckpoint>[0]> = {}) =>
  findForkCheckpoint({
    sessionKey: KB,
    prompt: p(prompt),
    cliPath: CLI,
    replyText: lastReplyText(p(prompt)),
    isBusy: () => false,
    ...overrides,
  })

// ---------------------------------------------------------------------------
// The match on its own
// ---------------------------------------------------------------------------

test("a fork from a served turn finds that turn's checkpoint in the sibling session", () => {
  _resetServedConversations()
  serveParent()
  const found = find([u("one"), a("R1"), u("two"), a("R2"), u("in the fork")])
  assert.equal(found?.parentKey, KA)
  assert.equal(found?.checkpoint.claudeSessionId, "S1")
  assert.equal(found?.checkpoint.messageUuid, "e2", "the reply to \"two\"")
  assert.equal(found?.checkpoint.anchor, 3)
  assert.deepEqual(
    found?.checkpoint.kept.map((kept) => kept.messageUuid),
    ["e1", "e2"],
    "the parent's checkpoints up to the cut come along, the later one does not",
  )

  // The first turn and the parent's newest turn are both places to cut.
  assert.equal(find([u("one"), a("R1"), u("fork")])?.checkpoint.messageUuid, "e1")
  assert.equal(
    find([u("one"), a("R1"), u("two"), a("R2"), u("three"), a("R3"), u("fork")])?.checkpoint.messageUuid,
    "e3",
  )
})

test("the match is strict: an earlier reply or the last one differing is another conversation", () => {
  _resetServedConversations()
  serveParent()
  // Same user messages, a different first reply: the shape matches, the
  // conversation does not, and the cut would hand this session the wrong one.
  assert.equal(find([u("one"), a("R1, elsewhere"), u("two"), a("R2"), u("fork")]), null)
  // The reply the thread ends on is compared by its last text block.
  assert.equal(find([u("one"), a("R1"), u("two"), a("R2, regenerated"), u("fork")]), null)
  // An edited user message is not this turn either.
  assert.equal(find([u("one"), a("R1"), u("two, edited"), a("R2"), u("fork")]), null)
})

test("every refusal findForkParent makes holds, and each is checked on its own", () => {
  _resetServedConversations()
  serveParent()
  const thread = [u("one"), a("R1"), u("two"), a("R2"), u("fork")]
  assert.ok(find(thread), "the control matches")

  // Not a sibling: another model, agent, effort or directory.
  assert.equal(find(thread, { sessionKey: key("ses_b", "other-model") }), null)
  assert.equal(find(thread, { sessionKey: key("ses_b", "m", '["claude-code","plan"]') }), null)
  assert.equal(find(thread, { sessionKey: `${KB}::effort=high` }), null)
  assert.equal(find(thread, { sessionKey: KB.replace("/tmp/fork-cp", "/tmp/elsewhere") }), null)
  // A compaction key can neither fork nor be forked.
  assert.equal(find(thread, { sessionKey: "/tmp/fork-cp::m::compaction::ses_b" }), null)
  // The key itself: that is a rewind, not a fork.
  assert.equal(find(thread, { sessionKey: KA }), null)
  // Another binary is another account's transcript.
  assert.equal(find(thread, { cliPath: "/bin/claude-other" }), null)
  // The parent mid-turn.
  assert.equal(find(thread, { isBusy: (k) => k === KA }), null)
  // A tool result past the last reply is a round trip in flight.
  assert.equal(
    find([
      ...thread.slice(0, 4),
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t", toolName: "bash", output: { type: "text", value: "x" } }] },
      u("fork"),
    ]),
    null,
  )
  // A thread with no reply yet has nowhere to cut.
  assert.equal(find([u("one")]), null)
  // Nothing to compare the reply by.
  assert.equal(find(thread, { replyText: undefined }), null)
})

test("a checkpoint recorded without the reply's text, or without a binary, never serves a fork", () => {
  _resetServedConversations()
  recordServedConversation(KA, p([u("one")]), { claudeSessionId: "S1", messageUuid: "e1", cliPath: CLI })
  assert.equal(find([u("one"), a("R1"), u("fork")]), null)
  _resetServedConversations()
  recordServedConversation(KA, p([u("one")]), { claudeSessionId: "S1", messageUuid: "e1", replyText: "R1" })
  assert.equal(find([u("one"), a("R1"), u("fork")]), null)
})

test("a busy parent is skipped for an idle one holding the same turn, newest first", () => {
  _resetServedConversations()
  const KC = key("ses_c")
  serveParent(KA)
  serveParent(KC)
  const thread = [u("one"), a("R1"), u("fork")]
  assert.equal(find(thread)?.parentKey, KC, "the newest record")
  assert.equal(find(thread, { isBusy: (k) => k === KC })?.parentKey, KA)
})

test("the reply text a fork is matched by leaves plugin notes and reasoning out", () => {
  const reply = {
    role: "assistant",
    content: [
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "the answer" },
      { type: "text", text: `\n${TURN_STATS_MARKER} $0.0010 · 1.0 s\n` },
    ],
  }
  assert.equal(lastReplyText(p([u("q"), reply, u("next")])), "the answer")
  const endsOnTool = {
    role: "assistant",
    content: [
      { type: "text", text: "let me look" },
      { type: "tool-call", toolCallId: "t", toolName: "bash", input: {} },
    ],
  }
  assert.equal(lastReplyText(p([u("q"), endsOnTool, u("next")])), undefined)
  assert.equal(lastReplyText(p([u("q")])), undefined)
})

// ---------------------------------------------------------------------------
// Through a real doStream: a fake CLI that cuts and forks as 2.1.322 does
// ---------------------------------------------------------------------------

const POSIX_ONLY = process.platform === "win32" ? "the fake-CLI harness is POSIX-only" : false
const E2E = { timeout: 60_000, skip: POSIX_ONLY } as const

function fixture(options: { settings?: Record<string, unknown> } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-fork-checkpoint-"))
  const configDir = join(cwd, "claude-config")
  const transcripts = join(configDir, "projects", encodeCwd(cwd))
  const cliPath = join(cwd, "fake-claude.cjs")
  const events = join(cwd, "events.jsonl")
  writeFileSync(events, "")
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const readline = require("node:readline")
const args = process.argv.slice(2)
const DIR = ${JSON.stringify(transcripts)}
const record = (event) => fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify(event) + "\\n")
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
if (args.includes("--version")) {
  process.stdout.write("2.1.322\\n")
  process.exit(0)
}
if (args.includes("--help")) process.exit(0)
const arg = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined)
const file = (id) => path.join(DIR, id + ".jsonl")
const read = (id) =>
  fs.existsSync(file(id))
    ? fs.readFileSync(file(id), "utf8").split("\\n").filter(Boolean).map((line) => JSON.parse(line))
    : []
fs.mkdirSync(DIR, { recursive: true })
const resume = arg("--resume")
const cut = arg("--resume-session-at")
const fork = args.includes("--fork-session")
const sessionId = fork ? "fork-" + process.pid : resume || "sess-" + process.pid
if (fork) {
  const parent = read(resume)
  const end = cut ? parent.findIndex((r) => r.uuid === cut) : parent.length - 1
  const kept = parent.slice(0, end + 1).map((r) => ({ ...r, sessionId }))
  fs.writeFileSync(file(sessionId), kept.map((r) => JSON.stringify(r)).join("\\n") + "\\n")
}
record({ type: "spawn", pid: process.pid, args, sessionId })
emit({ type: "system", subtype: "init", session_id: sessionId })
let n = read(sessionId).length
let total = 0
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const envelope = JSON.parse(line)
  if (envelope.type !== "user") return
  record({ type: "input", pid: process.pid, sessionId, stdin: line })
  n += 2
  const reply = sessionId + "-r" + n
  total = Math.round((total + 0.01) * 1e6) / 1e6
  fs.appendFileSync(file(sessionId),
    JSON.stringify({ type: "user", uuid: sessionId + "-p" + n, sessionId }) + "\\n" +
    JSON.stringify({ type: "assistant", uuid: reply, sessionId }) + "\\n")
  emit({ type: "assistant", uuid: reply, session_id: sessionId, message: {
    role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "answered " + reply }] } })
  emit({ type: "result", subtype: "success", session_id: sessionId, is_error: false, num_turns: 1,
    total_cost_usd: total, duration_ms: 1200, usage: { input_tokens: 1, output_tokens: 1 } })
})
`,
    { mode: 0o755 },
  )

  const modelId = "claude-test-fork-checkpoint"
  const provider = createClaudeCode({
    cwd,
    cliPath,
    configDir,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    interactive: false,
    autoContinueIncompleteTurns: false,
    resumeAfterRestart: false,
    ...options.settings,
  } as any)
  const keyFor = (affinity: string) => sessionKey(cwd, `${modelId}::tools::${affinity}::context=["claude-code",null]`)
  const lines = () =>
    readFileSync(events, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as any)

  return {
    keyFor,
    transcripts,
    spawns: () => lines().filter((e) => e.type === "spawn"),
    inputs: () => lines().filter((e) => e.type === "input"),
    async turn(affinity: string, prompt: unknown[]) {
      const callOptions: LanguageModelV3CallOptions = {
        prompt: p(prompt),
        headers: { "x-session-affinity": affinity },
        tools: [{ type: "function", name: "read", inputSchema: { type: "object", properties: {} } }],
        abortSignal: AbortSignal.timeout(30_000),
      } as any
      const response = await provider.languageModel(modelId).doStream(callOptions)
      const parts: LanguageModelV3StreamPart[] = []
      for await (const part of response.stream) parts.push(part)
      return parts
        .filter((part) => part.type === "text-delta")
        .map((part) => (part as { delta: string }).delta)
        .join("")
    },
    async warm() {
      for (let attempt = 1; attempt <= 4; attempt++) {
        if (await detectCliVersion(cliPath)) return
      }
      throw new Error("the fake CLI never answered --version")
    },
    async cleanup() {
      for (const affinity of ["ses_a", "ses_b"]) {
        await deleteActiveProcessAndWait(keyFor(affinity))
        deleteClaudeSessionId(keyFor(affinity))
      }
      _resetServedConversations()
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

const argAfter = (args: string[], name: string) =>
  args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined
const sentText = (stdin: string) =>
  (JSON.parse(stdin).message.content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")

/** Three turns on session A, returning its thread with the real replies. */
async function serveA(f: ReturnType<typeof fixture>) {
  const t1 = [u("one")]
  const r1 = await f.turn("ses_a", t1)
  const t2 = [...t1, a(r1), u("two")]
  const r2 = await f.turn("ses_a", t2)
  const t3 = [...t2, a(r2), u("three")]
  const r3 = await f.turn("ses_a", t3)
  return { t1, t2, t3, r1, r2, r3 }
}

test("a session forked from a served turn continues a copy of the parent's session cut there", E2E, async () => {
  _resetServedConversations()
  const f = fixture()
  try {
    await f.warm()
    const { t2, t3, r1, r2, r3 } = await serveA(f)
    const parent = f.spawns()[0].sessionId as string
    const parentTranscript = readFileSync(join(f.transcripts, `${parent}.jsonl`), "utf8")

    // Fork before "three": the copied history ends on the reply to "two".
    const forkThread = [...t2, a(r2), u("in the fork")]
    const forkReply = await f.turn("ses_b", forkThread)
    const forked = f.spawns()[1]
    assert.equal(f.spawns().length, 2)
    assert.equal(argAfter(forked.args, "--resume"), parent)
    assert.ok(forked.args.includes("--fork-session"), forked.args.join(" "))
    assert.equal(argAfter(forked.args, "--resume-session-at"), `${parent}-r4`, "the reply to \"two\"")
    const sent = f.inputs().at(-1)!.stdin as string
    assert.doesNotMatch(sent, /conversation_history|missed_conversation/)
    assert.equal(sentText(sent), "in the fork")
    assert.equal(forkReply.split(CONVERSATION_REWOUND_MARKER).length - 1, 0, "a fork is not a rewind")
    assert.equal(getClaudeSessionId(f.keyFor("ses_b")), forked.sessionId)
    assert.equal(readFileSync(join(f.transcripts, `${parent}.jsonl`), "utf8"), parentTranscript)

    // Both sessions carry on, each on its own process with only its message.
    await f.turn("ses_b", [...forkThread, a(forkReply), u("fork again")])
    assert.equal(f.inputs().at(-1)!.pid, forked.pid)
    assert.equal(sentText(f.inputs().at(-1)!.stdin), "fork again")
    await f.turn("ses_a", [...t3, a(r3), u("four")])
    assert.equal(f.inputs().at(-1)!.pid, f.spawns()[0].pid)
    assert.equal(sentText(f.inputs().at(-1)!.stdin), "four")
    assert.equal(f.spawns().length, 2)

    // An undo in the fork to before the fork point cuts the PARENT's session,
    // because its checkpoints came along.
    await f.turn("ses_b", [u("one"), a(r1), u("other")])
    const undone = f.spawns().at(-1)!
    assert.equal(argAfter(undone.args, "--resume"), parent)
    assert.equal(argAfter(undone.args, "--resume-session-at"), `${parent}-r2`)
    assert.equal(sentText(f.inputs().at(-1)!.stdin), "other")
  } finally {
    await f.cleanup()
  }
})

test("a fork whose replies differ from every served turn replays, as before", E2E, async () => {
  _resetServedConversations()
  const f = fixture()
  try {
    await f.warm()
    const { r1 } = await serveA(f)
    await f.turn("ses_b", [u("one"), a(r1), u("two"), a("a reply nobody served"), u("fork")])
    const spawn = f.spawns().at(-1)!
    assert.ok(!spawn.args.includes("--resume"), spawn.args.join(" "))
    assert.match(f.inputs().at(-1)!.stdin, /<conversation_history>/)
  } finally {
    await f.cleanup()
  }
})

test("forkFromCheckpoint: false replays a fork as text", E2E, async () => {
  _resetServedConversations()
  const f = fixture({ settings: { forkFromCheckpoint: false } })
  try {
    await f.warm()
    const { t2, r2 } = await serveA(f)
    await f.turn("ses_b", [...t2, a(r2), u("in the fork")])
    const spawn = f.spawns().at(-1)!
    assert.ok(!spawn.args.includes("--resume"), spawn.args.join(" "))
    assert.match(f.inputs().at(-1)!.stdin, /<conversation_history>/)
  } finally {
    await f.cleanup()
  }
})

test("a fork of the parent's transcript gone from disk replays", E2E, async () => {
  _resetServedConversations()
  const f = fixture()
  try {
    await f.warm()
    const { t2, r2 } = await serveA(f)
    rmSync(join(f.transcripts, `${f.spawns()[0].sessionId}.jsonl`))
    await f.turn("ses_b", [...t2, a(r2), u("in the fork")])
    const spawn = f.spawns().at(-1)!
    assert.ok(!spawn.args.includes("--resume"), spawn.args.join(" "))
    assert.match(f.inputs().at(-1)!.stdin, /<conversation_history>/)
  } finally {
    await f.cleanup()
  }
})
