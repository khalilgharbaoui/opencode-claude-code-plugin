/**
 * A rewound thread continues a copy of its Claude session cut at the last turn
 * both versions still share (`forkOnRewind`, h #g282): the checkpoints
 * `src/conversation-gap.ts` records, `planRewindFork` and every refusal, the
 * argv pieces, the cost baseline, then a fake CLI driving real `doStream`
 * turns through an edit, a regenerate, two undos and every fallback.
 *
 * Usage: npx tsx --test test/rewind-fork.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import {
  _resetServedConversations,
  classifyConversationChange,
  CONVERSATION_REWOUND_MARKER,
  forgetConversationCheckpoints,
  forgetServedConversation,
  formatConversationRewoundNote,
  MAX_CONVERSATION_CHECKPOINTS,
  moveServedConversation,
  recordServedConversation,
  restoreConversationCheckpoints,
  type RewoundConversation,
} from "../src/conversation-gap.js"
import { planRewindFork, transcriptHoldsEntry } from "../src/rewind-fork.js"
import {
  appendResumeIfNeeded,
  buildCliArgs,
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  getClaudeSessionId,
  rewindForkSource,
  sessionKey,
  setClaudeSessionId,
} from "../src/session-manager.js"
import { takeResultCost } from "../src/budget-ledger.js"
import { cliSupportsResumeSessionAt, detectCliVersion, type CliVersion } from "../src/cli-version.js"
import { encodeCwd } from "../src/claude-session-bun.js"
import { createClaudeCode } from "../src/index.js"

const u = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] })
const a = (text: string) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }] })
const call = (id: string) => ({
  role: "assistant" as const,
  content: [{ type: "tool-call" as const, toolCallId: id, toolName: "bash", input: { command: "ls" } }],
})
const result = (id: string, output: string) => ({
  role: "tool" as const,
  content: [{ type: "tool-result" as const, toolCallId: id, toolName: "bash", output: { type: "text", value: output } }],
})
const p = (messages: unknown[]) => messages as any
const v = (patch: number): CliVersion => ({ major: 2, minor: 1, patch, raw: `2.1.${patch}` })

const rewound = (key: string, prompt: unknown[]): RewoundConversation => {
  const change = classifyConversationChange(key, p(prompt))
  assert.equal(change?.kind, "rewound", JSON.stringify(change))
  return change as RewoundConversation
}

// ---------------------------------------------------------------------------
// Checkpoints on their own
// ---------------------------------------------------------------------------

test("an edited message is offered the checkpoint of the last turn it still has", () => {
  _resetServedConversations()
  recordServedConversation("k", p([u("one")]), { claudeSessionId: "S1", messageUuid: "a1" })
  recordServedConversation("k", p([u("one"), a("A1"), u("two")]), { claudeSessionId: "S1", messageUuid: "a2" })
  recordServedConversation("k", p([u("one"), a("A1"), u("two"), a("A2"), u("three")]), {
    claudeSessionId: "S1",
    messageUuid: "a3",
  })

  const change = rewound("k", [u("one"), a("A1"), u("two"), a("A2"), u("three, edited")])
  assert.equal(change.checkpoint?.claudeSessionId, "S1")
  assert.equal(change.checkpoint?.messageUuid, "a2", "the turn whose reply the thread now ends on")
  assert.equal(change.checkpoint?.anchor, 3)
  assert.deepEqual(
    change.checkpoint?.kept.map((c) => c.messageUuid),
    ["a1", "a2"],
    "the removed turn's checkpoint does not survive",
  )
})

test("a regenerate and an undo of several turns both find the turn they end on", () => {
  _resetServedConversations()
  recordServedConversation("k", p([u("one")]), { claudeSessionId: "S1", messageUuid: "a1" })
  recordServedConversation("k", p([u("one"), a("A1"), u("two")]), { claudeSessionId: "S1", messageUuid: "a2" })
  // Regenerate: the same thread asked again, the reply to "two" gone.
  assert.equal(rewound("k", [u("one"), a("A1"), u("two")]).checkpoint?.messageUuid, "a1")

  recordServedConversation("k", p([u("one"), a("A1"), u("two"), a("A2"), u("three")]), {
    claudeSessionId: "S1",
    messageUuid: "a3",
  })
  // Undo two exchanges and ask something else.
  assert.equal(rewound("k", [u("one"), a("A1"), u("other")]).checkpoint?.messageUuid, "a1")
})

test("no checkpoint is offered where the thread no longer matches what the session holds", () => {
  _resetServedConversations()
  recordServedConversation("k", p([u("one")]), { claudeSessionId: "S1", messageUuid: "a1" })
  recordServedConversation("k", p([u("one"), a("A1"), u("two")]), { claudeSessionId: "S1", messageUuid: "a2" })
  recordServedConversation("k", p([u("one"), a("A1"), u("two"), a("A2"), u("three")]), {
    claudeSessionId: "S1",
    messageUuid: "a3",
  })
  // The second message was replaced and answered elsewhere: the history ends
  // on a user message this session never had, so no cut gives this thread.
  const change = rewound("k", [u("one"), a("A1"), u("two, elsewhere"), a("A2'"), u("four")])
  assert.equal(change.checkpoint, undefined)
})

test("a turn that recorded no checkpoint offers none, and the rewind still stands", () => {
  _resetServedConversations()
  recordServedConversation("k", p([u("one")]))
  recordServedConversation("k", p([u("one"), a("A1"), u("two")]))
  const change = rewound("k", [u("one"), a("A1"), u("two, edited")])
  assert.equal(change.checkpoint, undefined)
  assert.equal(change.removedUserMessages, 1)
})

test("the anchor is the turn's user message, so its in-flight tool steps may render differently later", () => {
  _resetServedConversations()
  recordServedConversation("k", p([u("one")]), { claudeSessionId: "S1", messageUuid: "a1" })
  // The turn made a proxied call: its result arrived with the step in flight
  // rendered as a call and its tool result.
  recordServedConversation("k", p([u("one"), a("A1"), u("two"), call("t1"), result("t1", "out")]), {
    claudeSessionId: "S1",
    messageUuid: "a2",
  })
  recordServedConversation(
    "k",
    p([u("one"), a("A1"), u("two"), call("t1"), result("t1", "out"), a("A2"), u("three")]),
    { claudeSessionId: "S1", messageUuid: "a3" },
  )
  // The regenerate comes back with that turn rendered as one message.
  const change = rewound("k", [u("one"), a("A1"), u("two"), a("A2, merged")])
  assert.equal(change.checkpoint?.messageUuid, "a2")
})

test("a second result for the same question replaces the checkpoint, and the list is capped", () => {
  _resetServedConversations()
  recordServedConversation("k", p([u("one")]), { claudeSessionId: "S1", messageUuid: "first" })
  recordServedConversation("k", p([u("one")]), { claudeSessionId: "S1", messageUuid: "after-nudge" })
  recordServedConversation("k", p([u("one"), a("A1"), u("two")]), { claudeSessionId: "S1", messageUuid: "a2" })
  const change = rewound("k", [u("one"), a("A1"), u("two, edited")])
  assert.equal(change.checkpoint?.messageUuid, "after-nudge")
  assert.equal(change.checkpoint?.kept.length, 1)

  _resetServedConversations()
  const thread: unknown[] = []
  for (let i = 0; i <= MAX_CONVERSATION_CHECKPOINTS; i++) {
    thread.push(u(`q${i}`))
    recordServedConversation("k", p(thread), { claudeSessionId: "S1", messageUuid: `a${i}` })
    thread.push(a(`A${i}`))
  }
  // The oldest checkpoint went: an undo back to it replays.
  assert.equal(rewound("k", [u("q0"), a("A0"), u("other")]).checkpoint, undefined)
  assert.equal(rewound("k", [u("q0"), a("A0"), u("q1"), a("A1"), u("other")]).checkpoint?.messageUuid, "a1")
})

test("restored checkpoints outlive the dropped session, and read no rewind until the next result", () => {
  _resetServedConversations()
  recordServedConversation("k", p([u("one")]), { claudeSessionId: "S1", messageUuid: "a1" })
  recordServedConversation("k", p([u("one"), a("A1"), u("two")]), { claudeSessionId: "S1", messageUuid: "a2" })
  const { checkpoint } = rewound("k", [u("one"), a("A1"), u("other")])
  forgetServedConversation("k")
  restoreConversationCheckpoints("k", checkpoint!.kept)
  assert.equal(classifyConversationChange("k", p([u("one"), a("A1"), u("other")])), null)

  // The fork's own turn records what it was asked; the kept checkpoint stays.
  recordServedConversation("k", p([u("one"), a("A1"), u("other")]), { claudeSessionId: "S2", messageUuid: "b2" })
  const again = rewound("k", [u("one"), a("A1"), u("other, edited")])
  assert.deepEqual(again.checkpoint && [again.checkpoint.claudeSessionId, again.checkpoint.messageUuid], ["S1", "a1"])
})

test("the CLI's own compaction drops the checkpoints; a move carries them; a forget drops them", () => {
  _resetServedConversations()
  recordServedConversation("k", p([u("one")]), { claudeSessionId: "S1", messageUuid: "a1" })
  recordServedConversation("k", p([u("one"), a("A1"), u("two")]), { claudeSessionId: "S1", messageUuid: "a2" })
  moveServedConversation("k", "k2")
  assert.equal(rewound("k2", [u("one"), a("A1"), u("other")]).checkpoint?.messageUuid, "a1")
  forgetConversationCheckpoints("k2")
  assert.equal(rewound("k2", [u("one"), a("A1"), u("other")]).checkpoint, undefined)
  forgetServedConversation("k2")
  assert.equal(classifyConversationChange("k2", p([u("one"), a("A1"), u("other")])), null)
})

test("the note says which way the session was replaced, behind the same marker", () => {
  for (const how of ["forked", "replayed"] as const) {
    const note = formatConversationRewoundNote(how)
    assert.ok(note.trimStart().startsWith(CONVERSATION_REWOUND_MARKER), note)
    assert.match(note, /edited or undone/)
  }
  assert.match(formatConversationRewoundNote("forked"), /copy of that session cut at the last turn/)
  assert.match(formatConversationRewoundNote(), /replays the thread/)
})

// ---------------------------------------------------------------------------
// The plan and every refusal
// ---------------------------------------------------------------------------

function planFixture() {
  const dir = mkdtempSync(join(tmpdir(), "opencode-rewind-plan-"))
  writeFileSync(
    join(dir, "S1.jsonl"),
    '{"type":"user","uuid":"u1","sessionId":"S1"}\n{"type":"assistant","parentUuid":"u1","uuid":"a1","sessionId":"S1"}\n',
  )
  const change: RewoundConversation = {
    kind: "rewound",
    sharedMessages: 2,
    removedMessages: 1,
    removedUserMessages: 1,
    checkpoint: { claudeSessionId: "S1", messageUuid: "a1", anchor: 1, kept: [] },
  }
  let versionAsked = 0
  const plan = (overrides: Partial<Parameters<typeof planRewindFork>[0]> = {}) =>
    planRewindFork({
      change,
      enabled: true,
      interactive: false,
      cliVersion: async () => {
        versionAsked++
        return v(314)
      },
      transcriptPath: (id) => join(dir, `${id}.jsonl`),
      ...overrides,
    })
  return { dir, change, plan, versionAsked: () => versionAsked }
}

test("the plan forks at the checkpoint, and refuses with a token for every reason it cannot", async () => {
  const f = planFixture()
  try {
    assert.deepEqual(await f.plan(), {
      kind: "fork",
      claudeSessionId: "S1",
      messageUuid: "a1",
      keptMessages: 1,
      kept: [],
    })
    assert.deepEqual(await f.plan({ enabled: false }), { kind: "replay", reason: "option-off" })
    assert.deepEqual(await f.plan({ interactive: true }), { kind: "replay", reason: "interactive-transport" })
    const { checkpoint: _, ...bare } = f.change
    assert.deepEqual(await f.plan({ change: bare }), { kind: "replay", reason: "no-checkpoint" })
    assert.deepEqual(await f.plan({ cliVersion: async () => v(280) }), { kind: "replay", reason: "cli-too-old" })
    assert.deepEqual(await f.plan({ cliVersion: async () => null }), { kind: "replay", reason: "cli-too-old" })
    assert.deepEqual(await f.plan({ transcriptPath: () => join(f.dir, "gone.jsonl") }), {
      kind: "replay",
      reason: "transcript-gone",
    })
    writeFileSync(join(f.dir, "S1.jsonl"), '{"type":"assistant","parentUuid":"a1","uuid":"a9"}\n')
    assert.deepEqual(await f.plan(), { kind: "replay", reason: "entry-gone" })
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test("a refused plan never waits on the version probe", async () => {
  const f = planFixture()
  try {
    await f.plan({ enabled: false })
    await f.plan({ interactive: true })
    const { checkpoint: _, ...bare } = f.change
    await f.plan({ change: bare })
    assert.equal(f.versionAsked(), 0)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test("the entry check reads a record's own uuid, never a parentUuid naming it", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-rewind-entry-"))
  try {
    const file = join(dir, "t.jsonl")
    writeFileSync(file, '{"type":"assistant","parentUuid":"x1","uuid":"x2"}\n')
    assert.equal(transcriptHoldsEntry(file, "x2"), true)
    assert.equal(transcriptHoldsEntry(file, "x1"), false)
    assert.equal(transcriptHoldsEntry(join(dir, "missing.jsonl"), "x2"), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the cut is gated on the oldest CLI measured reading it from the cache", () => {
  assert.equal(cliSupportsResumeSessionAt(null), false)
  assert.equal(cliSupportsResumeSessionAt(v(287)), false)
  assert.equal(cliSupportsResumeSessionAt(v(288)), true)
  assert.equal(cliSupportsResumeSessionAt(v(314)), true)
})

// ---------------------------------------------------------------------------
// The argv, the respawn and the cost baseline
// ---------------------------------------------------------------------------

test("the fork's argv carries the cut, and a respawn after init continues the fork itself", () => {
  const key = sessionKey("/tmp/rewind-argv", "model::tools::ses_argv::context=[\"claude-code\",null]")
  deleteClaudeSessionId(key)
  const args = buildCliArgs({
    sessionKey: key,
    skipPermissions: true,
    forkFromClaudeSessionId: "S1",
    forkAtMessageUuid: "a2",
  })
  const at = args.indexOf("--resume")
  assert.deepEqual(args.slice(at, at + 5), ["--resume", "S1", "--fork-session", "--resume-session-at", "a2"])
  assert.equal(rewindForkSource(args), "S1")
  assert.equal(rewindForkSource(buildCliArgs({ sessionKey: key, skipPermissions: true, forkFromClaudeSessionId: "S1" })), undefined)
  assert.equal(rewindForkSource(undefined), undefined)

  // Before `init` there is nothing of the fork to continue: re-fork the parent.
  assert.deepEqual(appendResumeIfNeeded(key, args), args)
  // After it, the key owns the fork: resume that, with no cut and no fork flag.
  setClaudeSessionId(key, "S2")
  const respawned = appendResumeIfNeeded(key, args)
  assert.ok(!respawned.includes("--fork-session"), respawned.join(" "))
  assert.ok(!respawned.includes("--resume-session-at"), respawned.join(" "))
  assert.ok(!respawned.includes("a2"), respawned.join(" "))
  assert.deepEqual(respawned.slice(respawned.indexOf("--resume"), respawned.indexOf("--resume") + 2), ["--resume", "S2"])
  assert.equal(rewindForkSource(respawned), undefined)
  deleteClaudeSessionId(key)
})

test("a fork's first total is priced from its parent's last one", () => {
  takeResultCost("rewind-parent", 0.00935163, true)
  const fork = takeResultCost("rewind-fork", 0.00984758, true, "rewind-parent")
  assert.equal(fork.noBaseline, false)
  assert.ok(Math.abs(fork.deltaUsd - 0.00049595) < 1e-9, String(fork.deltaUsd))
  // The fork's own baseline wins from then on.
  const next = takeResultCost("rewind-fork", 0.01, true, "rewind-parent")
  assert.ok(Math.abs(next.deltaUsd - 0.00015242) < 1e-9, String(next.deltaUsd))
  // A parent this process never priced leaves the old rule: counted in full.
  assert.deepEqual(takeResultCost("rewind-orphan", 0.5, true, "never-seen"), { deltaUsd: 0.5, noBaseline: true })
})

// ---------------------------------------------------------------------------
// Through a real doStream: a fake CLI that cuts and forks as 2.1.314 does
// ---------------------------------------------------------------------------

const POSIX_ONLY = process.platform === "win32" ? "the fake-CLI harness is POSIX-only" : false
const E2E = { timeout: 60_000, skip: POSIX_ONLY } as const

function fixture(options: { version?: string; settings?: Record<string, unknown> } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-rewind-fork-"))
  const configDir = join(cwd, "claude-config")
  const transcripts = join(configDir, "projects", encodeCwd(cwd))
  const cliPath = join(cwd, "fake-claude.cjs")
  const events = join(cwd, "events.jsonl")
  const failFork = join(cwd, "fail-fork")
  const compactNext = join(cwd, "compact-next")
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
  process.stdout.write(${JSON.stringify(options.version ?? "2.1.314")} + "\\n")
  process.exit(0)
}
if (args.includes("--help")) process.exit(0)
const arg = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined)
const file = (id) => path.join(DIR, id + ".jsonl")
const read = (id) =>
  fs.existsSync(file(id))
    ? fs.readFileSync(file(id), "utf8").split("\\n").filter(Boolean).map((line) => JSON.parse(line))
    : []
const lastTotal = (records) => records.reduce((total, r) => (typeof r.total === "number" ? r.total : total), 0)
fs.mkdirSync(DIR, { recursive: true })
const resume = arg("--resume")
const cut = arg("--resume-session-at")
const fork = args.includes("--fork-session")
const sessionId = fork ? "fork-" + process.pid : resume || "sess-" + process.pid
let total = 0
if (fork) {
  const parent = read(resume)
  const end = cut ? parent.findIndex((r) => r.uuid === cut) : parent.length - 1
  if ((cut && end < 0) || fs.existsSync(${JSON.stringify(failFork)})) {
    record({ type: "spawn", pid: process.pid, args, sessionId, failed: true })
    process.stderr.write("No message found with message.uuid of: " + cut + "\\n")
    emit({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0,
      session_id: sessionId, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } })
    process.exit(1)
  }
  const kept = parent.slice(0, end + 1).map((r) => ({ ...r, sessionId }))
  fs.writeFileSync(file(sessionId), kept.map((r) => JSON.stringify(r)).join("\\n") + "\\n")
  // The CLI restores the parent's whole running total, cut turns included.
  total = lastTotal(parent)
} else if (resume) {
  total = lastTotal(read(resume))
}
record({ type: "spawn", pid: process.pid, args, sessionId })
emit({ type: "system", subtype: "init", session_id: sessionId })
let n = read(sessionId).length
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const envelope = JSON.parse(line)
  if (envelope.type !== "user") return
  record({ type: "input", pid: process.pid, sessionId, stdin: line })
  if (fs.existsSync(${JSON.stringify(compactNext)})) {
    fs.unlinkSync(${JSON.stringify(compactNext)})
    emit({ type: "system", subtype: "compact_boundary", session_id: sessionId,
      compact_metadata: { trigger: "auto", pre_tokens: 1000 } })
  }
  n += 2
  const reply = sessionId + "-r" + n
  total = Math.round((total + 0.01) * 1e6) / 1e6
  fs.appendFileSync(file(sessionId),
    JSON.stringify({ type: "user", uuid: sessionId + "-p" + n, sessionId }) + "\\n" +
    JSON.stringify({ type: "assistant", uuid: reply, sessionId, total }) + "\\n")
  emit({ type: "assistant", uuid: reply, session_id: sessionId, message: {
    role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "answered " + reply }] } })
  emit({ type: "result", subtype: "success", session_id: sessionId, is_error: false, num_turns: 1,
    total_cost_usd: total, duration_ms: 1200, usage: { input_tokens: 1, output_tokens: 1 } })
})
`,
    { mode: 0o755 },
  )

  const modelId = "claude-test-rewind-fork"
  const provider = createClaudeCode({
    cwd,
    cliPath,
    configDir,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    interactive: false,
    autoContinueIncompleteTurns: false,
    // Nothing here depends on the store, and a single-file run must not write
    // the operator's.
    resumeAfterRestart: false,
    ...options.settings,
  } as any)
  const key = sessionKey(cwd, `${modelId}::tools::ses_rewind::context=["claude-code",null]`)
  const lines = () =>
    readFileSync(events, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as any)

  return {
    key,
    transcripts,
    failFork,
    compactNext,
    spawns: () => lines().filter((e) => e.type === "spawn"),
    inputs: () => lines().filter((e) => e.type === "input"),
    async turn(prompt: unknown[]) {
      const options: LanguageModelV3CallOptions = {
        prompt: p(prompt),
        headers: { "x-session-affinity": "ses_rewind" },
        tools: [{ type: "function", name: "read", inputSchema: { type: "object", properties: {} } }],
        abortSignal: AbortSignal.timeout(30_000),
      } as any
      const response = await provider.languageModel(modelId).doStream(options)
      const parts: LanguageModelV3StreamPart[] = []
      for await (const part of response.stream) parts.push(part)
      const text = parts
        .filter((part) => part.type === "text-delta")
        .map((part) => (part as { delta: string }).delta)
        .join("")
      return { parts, text }
    },
    async warm() {
      for (let attempt = 1; attempt <= 4; attempt++) {
        if (await detectCliVersion(cliPath)) return
      }
      throw new Error("the fake CLI never answered --version")
    },
    async cleanup() {
      await deleteActiveProcessAndWait(key)
      deleteClaudeSessionId(key)
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
const countNotes = (text: string) => text.split(CONVERSATION_REWOUND_MARKER).length - 1

const T1 = [u("one")]
const T2 = [...T1, a("A1"), u("two")]
const T3 = [...T2, a("A2"), u("three")]
const T4 = [...T3, a("A3"), u("four")]

test("an edited message continues a copy of the session cut at the turn before it", E2E, async () => {
  _resetServedConversations()
  const f = fixture()
  try {
    await f.warm()
    await f.turn(T1)
    await f.turn(T2)
    await f.turn(T3)
    const [first] = f.spawns()
    assert.equal(f.spawns().length, 1, "three turns on one process")
    const parent = first.sessionId as string
    const parentTranscript = readFileSync(join(f.transcripts, `${parent}.jsonl`), "utf8")

    const edited = await f.turn([...T2, a("A2"), u("three, edited")])
    const spawns = f.spawns()
    assert.equal(spawns.length, 2, "the rewound turn spawned once")
    const forked = spawns[1]
    assert.equal(argAfter(forked.args, "--resume"), parent)
    assert.ok(forked.args.includes("--fork-session"), forked.args.join(" "))
    assert.equal(argAfter(forked.args, "--resume-session-at"), `${parent}-r4`, "the reply to \"two\"")

    // Nothing is replayed: the copy already holds "one" and "two" and their
    // replies, and nothing of "three".
    const sent = f.inputs().at(-1)!.stdin as string
    assert.doesNotMatch(sent, /conversation_history|missed_conversation/)
    assert.equal(sentText(sent), "three, edited")
    assert.equal(countNotes(edited.text), 1, edited.text)
    assert.match(edited.text, /copy of that session cut at the last turn/)

    // The fork is this key's conversation now, the parent's file untouched.
    assert.equal(getClaudeSessionId(f.key), forked.sessionId)
    assert.equal(readFileSync(join(f.transcripts, `${parent}.jsonl`), "utf8"), parentTranscript)

    // And the next turn is an ordinary one on the same process.
    const next = await f.turn([...T2, a("A2"), u("three, edited"), a("A3'"), u("four")])
    assert.equal(f.spawns().length, 2)
    assert.equal(f.inputs().at(-1)!.pid, forked.pid)
    assert.equal(sentText(f.inputs().at(-1)!.stdin), "four")
    assert.equal(countNotes(next.text), 0)
  } finally {
    await f.cleanup()
  }
})

test("a regenerated reply forks at the turn before it", E2E, async () => {
  _resetServedConversations()
  const f = fixture()
  try {
    await f.warm()
    await f.turn(T1)
    await f.turn(T2)
    const parent = f.spawns()[0].sessionId as string
    await f.turn(T2)
    const forked = f.spawns()[1]
    assert.equal(argAfter(forked.args, "--resume-session-at"), `${parent}-r2`)
    assert.equal(sentText(f.inputs().at(-1)!.stdin), "two")
  } finally {
    await f.cleanup()
  }
})

test("a second undo further back forks the original session at its earlier turn", E2E, async () => {
  _resetServedConversations()
  const f = fixture()
  try {
    await f.warm()
    await f.turn(T1)
    await f.turn(T2)
    await f.turn(T3)
    await f.turn(T4)
    const parent = f.spawns()[0].sessionId as string

    // Undo "three" and "four", ask again, carry on a turn on the fork.
    await f.turn([...T2, a("A2"), u("three again")])
    const fork1 = f.spawns()[1]
    assert.equal(argAfter(fork1.args, "--resume-session-at"), `${parent}-r4`)
    await f.turn([...T2, a("A2"), u("three again"), a("A3'"), u("four again")])
    assert.equal(f.spawns().length, 2)

    // Then undo back past the first fork: the checkpoint it kept is the
    // ORIGINAL session's, whose transcript the fork never touched.
    await f.turn([...T1, a("A1"), u("two again")])
    const fork2 = f.spawns()[2]
    assert.equal(argAfter(fork2.args, "--resume"), parent)
    assert.equal(argAfter(fork2.args, "--resume-session-at"), `${parent}-r2`)
    assert.equal(sentText(f.inputs().at(-1)!.stdin), "two again")
  } finally {
    await f.cleanup()
  }
})

test("forkOnRewind: false replays the thread into a fresh session, as before", E2E, async () => {
  _resetServedConversations()
  const f = fixture({ settings: { forkOnRewind: false } })
  try {
    await f.warm()
    await f.turn(T1)
    await f.turn(T2)
    const edited = await f.turn([...T1, a("A1"), u("two, edited")])
    const spawn = f.spawns().at(-1)!
    assert.ok(!spawn.args.includes("--resume"), spawn.args.join(" "))
    assert.match(f.inputs().at(-1)!.stdin, /<conversation_history>/)
    assert.match(edited.text, /replays the thread/)
  } finally {
    await f.cleanup()
  }
})

test("a transcript that is gone, an older CLI and the CLI's own compaction all replay", E2E, async () => {
  _resetServedConversations()
  const gone = fixture()
  try {
    await gone.warm()
    await gone.turn(T1)
    await gone.turn(T2)
    rmSync(join(gone.transcripts, `${gone.spawns()[0].sessionId}.jsonl`))
    await gone.turn([...T1, a("A1"), u("two, edited")])
    assert.ok(!gone.spawns().at(-1)!.args.includes("--resume"))
    assert.match(gone.inputs().at(-1)!.stdin, /<conversation_history>/)
  } finally {
    await gone.cleanup()
  }

  _resetServedConversations()
  const old = fixture({ version: "2.1.287" })
  try {
    await old.warm()
    await old.turn(T1)
    await old.turn(T2)
    await old.turn([...T1, a("A1"), u("two, edited")])
    assert.ok(!old.spawns().at(-1)!.args.includes("--resume"))
    assert.match(old.inputs().at(-1)!.stdin, /<conversation_history>/)
  } finally {
    await old.cleanup()
  }

  _resetServedConversations()
  const compacted = fixture()
  try {
    await compacted.warm()
    await compacted.turn(T1)
    writeFileSync(compacted.compactNext, "")
    await compacted.turn(T2)
    await compacted.turn([...T1, a("A1"), u("two, edited")])
    assert.ok(!compacted.spawns().at(-1)!.args.includes("--resume"))
    assert.match(compacted.inputs().at(-1)!.stdin, /<conversation_history>/)
  } finally {
    await compacted.cleanup()
  }
})

test("a fork the CLI refuses maps no session, and the next turn replays", E2E, async () => {
  _resetServedConversations()
  const f = fixture()
  try {
    await f.warm()
    await f.turn(T1)
    await f.turn(T2)
    writeFileSync(f.failFork, "")
    await f.turn([...T1, a("A1"), u("two, edited")])
    assert.equal(f.spawns().at(-1)!.failed, true)
    assert.equal(getClaudeSessionId(f.key), undefined, "the id of a fork that never started")

    unlinkSync(f.failFork)
    await f.turn([...T1, a("A1"), u("two, edited")])
    const spawn = f.spawns().at(-1)!
    assert.ok(!spawn.args.includes("--resume"), spawn.args.join(" "))
    assert.match(f.inputs().at(-1)!.stdin, /<conversation_history>/)
  } finally {
    await f.cleanup()
  }
})

test("the fork turn's footer prices that turn, not the parent's running total", E2E, async () => {
  _resetServedConversations()
  const f = fixture({ settings: { turnStats: true } })
  try {
    await f.warm()
    await f.turn(T1)
    await f.turn(T2)
    await f.turn(T3)
    // The fake's totals run 0.01, 0.02, 0.03; the fork restores 0.03 and its
    // own turn takes it to 0.04. Without the parent's total as its baseline,
    // a `--resume` spawn with no baseline prints no cost at all.
    const edited = await f.turn([...T2, a("A2"), u("three, edited")])
    assert.ok(f.spawns().at(-1)!.args.includes("--resume-session-at"))
    assert.match(edited.text, /\$0\.0100 ·/, edited.text)
    assert.doesNotMatch(edited.text, /\$0\.0400/)
  } finally {
    await f.cleanup()
  }
})
