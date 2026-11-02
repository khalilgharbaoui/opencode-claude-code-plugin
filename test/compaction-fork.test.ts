/**
 * `/compact` on a fork of the conversation's own Claude session
 * (`forkCompaction`, h #g284): the fork's argv, which conversation it finds,
 * every refusal, the cost baseline, then a fake CLI driving real `doStream`
 * turns through a forked compaction, the option off, a failed fork and a
 * conversation still writing.
 *
 * Usage: npx tsx --test test/compaction-fork.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import {
  _resetServedConversations,
  findServedConversation,
  recordServedConversation,
} from "../src/conversation-gap.js"
import {
  COMPACTION_FORK_INSTRUCTION,
  compactionForkArgs,
  planCompactionFork,
} from "../src/compaction-fork.js"
import {
  compactionForkSource,
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  getClaudeSessionId,
  rewindForkSource,
  sessionKey,
} from "../src/session-manager.js"
import { takeResultCost } from "../src/budget-ledger.js"
import { detectCliVersion } from "../src/cli-version.js"
import { encodeCwd } from "../src/claude-session-bun.js"
import { createClaudeCode } from "../src/index.js"

const u = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] })
const a = (text: string) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }] })
const p = (messages: unknown[]) => messages as any

// ---------------------------------------------------------------------------
// The fork's argv
// ---------------------------------------------------------------------------

test("the fork keeps the conversation's model and tool set and drops what lets it act", () => {
  const conversation = [
    "--print", "--output-format", "stream-json", "--input-format", "stream-json",
    "--include-partial-messages", "--verbose",
    "--model", "claude-opus-5-5", "--effort", "high",
    "--resume", "S-old",
    "--mcp-config", "/tmp/proxy.json", "/tmp/bridge.json",
    "--strict-mcp-config",
    "--disallowedTools", "Bash", "Edit", "Write",
    "--thinking-display", "summarized",
    "--append-system-prompt-file", "/tmp/prompt.md",
    "--plugin-dir", "/tmp/skills",
    "--max-turns", "4", "--max-budget-usd", "2",
    "--dangerously-skip-permissions",
  ]
  const args = compactionForkArgs(conversation, "S1")
  assert.deepEqual(args, [
    "--print", "--output-format", "stream-json", "--input-format", "stream-json",
    "--include-partial-messages", "--verbose",
    "--model", "claude-opus-5-5",
    "--disallowedTools", "Bash", "Edit", "Write",
    "--thinking-display", "summarized",
    "--plugin-dir", "/tmp/skills",
    "--strict-mcp-config",
    "--permission-mode", "dontAsk",
    "--resume", "S1", "--fork-session",
  ])
})

test("a read-only conversation keeps its own posture rather than dontAsk", () => {
  const args = compactionForkArgs(
    ["--print", "--model", "m", "--restricted", "--permission-prompts", "none", "--disallowedTools", "Bash"],
    "S1",
  )
  assert.ok(args.includes("--restricted"))
  assert.ok(!args.includes("dontAsk"), args.join(" "))
  assert.equal(args.at(-3), "--resume")
})

test("a compaction fork's parent is its cost baseline; a plain spawn has none", () => {
  const args = compactionForkArgs(["--print", "--model", "m"], "S1")
  assert.equal(compactionForkSource(args), "S1")
  assert.equal(rewindForkSource(args), undefined, "not a rewind: no cut")
  assert.equal(compactionForkSource(["--print", "--resume", "S1"]), undefined)
  // The fork's first total restores the parent's 0.30; its own turn is 0.02.
  takeResultCost("S1", 0.3, true)
  assert.equal(takeResultCost("F1", 0.32, true, "S1").deltaUsd.toFixed(2), "0.02")
})

// ---------------------------------------------------------------------------
// Which conversation
// ---------------------------------------------------------------------------

const KEY = (affinity: string, agent = "build", cwd = "/w") =>
  `${cwd}::claude-opus-5-5::tools::${affinity}::context=["claude-code","${agent}"]`
const COMPACT = [u("one"), a("A1"), u("two"), a("A2"), u("Provide a detailed summary.")]

test("the served conversation is found by shape, so a re-rendered reply still matches", () => {
  _resetServedConversations()
  recordServedConversation(KEY("ses_a"), p([u("one"), a("A1"), u("two")]))
  // The compaction request arrives on another model: opencode flattens the
  // replies differently, which the shape chain does not see.
  const prompt = [u("one"), a("A1 flattened"), u("two"), a("A2"), u("Provide a detailed summary.")]
  assert.equal(findServedConversation(p(prompt), () => true), KEY("ses_a"))
  // A user message past the recorded chain is a conversation that moved on.
  assert.equal(
    findServedConversation(p([...prompt.slice(0, 4), u("three"), a("A3"), u("summary")]), () => true),
    undefined,
  )
})

test("the newest matching key wins, and the filter is honoured", () => {
  _resetServedConversations()
  recordServedConversation(KEY("ses_a", "plan"), p([u("one"), a("A1"), u("two")]))
  recordServedConversation(KEY("ses_a", "build"), p([u("one"), a("A1"), u("two")]))
  assert.equal(findServedConversation(p(COMPACT), () => true), KEY("ses_a", "build"))
  assert.equal(
    findServedConversation(p(COMPACT), (key) => key.includes('"plan"')),
    KEY("ses_a", "plan"),
  )
})

function planInputs(dir: string, overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    interactive: false,
    cwd: "/w",
    affinity: "ses_a",
    prompt: p(COMPACT),
    cliPath: "/bin/claude",
    transcriptDir: dir,
    lookupClaudeSessionId: (key: string) => (key === KEY("ses_a") ? "S1" : undefined),
    lookupProcess: (key: string) =>
      key === KEY("ses_a")
        ? { cliPath: "/bin/claude", cliArgs: ["--print", "--model", "claude-opus-5-5", "--dangerously-skip-permissions"] }
        : undefined,
    isWriting: () => false,
    cliSupportsFork: async () => true,
    ...overrides,
  }
}

test("a compaction forks the conversation it belongs to, and refuses every case it cannot serve", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-compaction-fork-plan-"))
  try {
    writeFileSync(join(dir, "S1.jsonl"), "{}\n")
    _resetServedConversations()
    recordServedConversation(KEY("ses_a"), p([u("one"), a("A1"), u("two")]))
    recordServedConversation(KEY("ses_b"), p([u("one"), a("A1"), u("two")]))
    recordServedConversation(KEY("ses_a", "build", "/other"), p([u("one"), a("A1"), u("two")]))

    const plan = await planCompactionFork(planInputs(dir))
    assert.ok("fork" in plan, JSON.stringify(plan))
    assert.equal(plan.fork.sourceKey, KEY("ses_a"), "this session and cwd, not another")
    assert.equal(plan.fork.claudeSessionId, "S1")
    assert.equal(plan.fork.model, "claude-opus-5-5")
    assert.deepEqual(plan.fork.cliArgs.slice(-3), ["--resume", "S1", "--fork-session"])

    const refused = async (overrides: Record<string, unknown>) => {
      const result = await planCompactionFork(planInputs(dir, overrides))
      return "refused" in result ? result.refused : "forked"
    }
    assert.equal(await refused({ enabled: false }), "option-off")
    assert.equal(await refused({ interactive: true }), "interactive-transport")
    assert.equal(await refused({ affinity: "default" }), "no-opencode-session")
    assert.equal(await refused({ affinity: "ses_c" }), "no-matching-conversation")
    assert.equal(
      await refused({ prompt: p([u("other"), a("X"), u("summary")]) }),
      "no-matching-conversation",
    )
    assert.equal(await refused({ lookupClaudeSessionId: () => undefined }), "no-claude-session")
    assert.equal(await refused({ lookupProcess: () => undefined }), "conversation-process-gone")
    assert.equal(await refused({ isWriting: () => true }), "conversation-still-writing")
    assert.equal(await refused({ cliPath: "/bin/other-account" }), "another-claude-binary")
    assert.equal(
      await refused({ lookupProcess: () => ({ cliPath: "/bin/claude", cliArgs: ["--print"] }) }),
      "conversation-model-unknown",
    )
    assert.equal(await refused({ transcriptDir: join(dir, "missing") }), "transcript-gone")
    assert.equal(await refused({ cliSupportsFork: async () => false }), "cli-too-old")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Through a real doStream
// ---------------------------------------------------------------------------

const POSIX_ONLY = process.platform === "win32" ? "the fake-CLI harness is POSIX-only" : false
const E2E = { timeout: 60_000, skip: POSIX_ONLY } as const

function fixture(options: { settings?: Record<string, unknown> } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-compaction-fork-"))
  const configDir = join(cwd, "claude-config")
  const transcripts = join(configDir, "projects", encodeCwd(cwd))
  const cliPath = join(cwd, "fake-claude.cjs")
  const events = join(cwd, "events.jsonl")
  const failFork = join(cwd, "fail-fork")
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
  process.stdout.write("2.1.314\\n")
  process.exit(0)
}
if (args.includes("--help")) {
  process.stdout.write("  --fork-session   When resuming, create a new session ID\\n")
  process.exit(0)
}
const arg = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined)
const file = (id) => path.join(DIR, id + ".jsonl")
const read = (id) =>
  fs.existsSync(file(id))
    ? fs.readFileSync(file(id), "utf8").split("\\n").filter(Boolean).map((line) => JSON.parse(line))
    : []
const lastTotal = (records) => records.reduce((total, r) => (typeof r.total === "number" ? r.total : total), 0)
fs.mkdirSync(DIR, { recursive: true })
const resume = arg("--resume")
const fork = args.includes("--fork-session")
const sessionId = fork ? "fork-" + process.pid : resume || "sess-" + process.pid
let total = 0
if (fork) {
  const parent = read(resume)
  fs.writeFileSync(file(sessionId), parent.map((r) => JSON.stringify({ ...r, sessionId })).join("\\n") + "\\n")
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
  if (fork && fs.existsSync(${JSON.stringify(failFork)})) {
    emit({ type: "assistant", session_id: sessionId, error: "rate_limit", message: {
      role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
      content: [{ type: "text", text: "You've hit your session limit" }] }, is_api_error_message: true })
    emit({ type: "result", subtype: "success", session_id: sessionId, is_error: true, num_turns: 1,
      result: "You've hit your session limit", total_cost_usd: total, usage: { input_tokens: 0, output_tokens: 0 } })
    return
  }
  n += 2
  const reply = sessionId + "-r" + n
  total = Math.round((total + 0.01) * 1e6) / 1e6
  fs.appendFileSync(file(sessionId),
    JSON.stringify({ type: "user", uuid: sessionId + "-p" + n, sessionId }) + "\\n" +
    JSON.stringify({ type: "assistant", uuid: reply, sessionId, total }) + "\\n")
  const text = fork ? "SUMMARY of " + resume : "answered " + reply
  emit({ type: "assistant", uuid: reply, session_id: sessionId, message: {
    role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } })
  emit({ type: "result", subtype: "success", session_id: sessionId, is_error: false, num_turns: 1,
    total_cost_usd: total, duration_ms: 1200, usage: { input_tokens: 1, output_tokens: 1 } })
})
`,
    { mode: 0o755 },
  )

  const modelId = "claude-test-compaction-fork"
  const provider = createClaudeCode({
    cwd,
    cliPath,
    configDir,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    interactive: false,
    autoContinueIncompleteTurns: false,
    compactionModel: "claude-test-compactor",
    resumeAfterRestart: false,
    forkCompaction: true,
    ...options.settings,
  } as any)
  const key = sessionKey(cwd, `${modelId}::tools::ses_compact::context=["claude-code",null]`)
  const compactionKey = sessionKey(cwd, `claude-test-compactor::compaction::ses_compact`)
  const lines = () =>
    readFileSync(events, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as any)

  const run = async (prompt: unknown[], compaction: boolean) => {
    const options: LanguageModelV3CallOptions = {
      prompt: p(prompt),
      headers: { "x-session-affinity": "ses_compact" },
      tools: [{ type: "function", name: "read", inputSchema: { type: "object", properties: {} } }],
      ...(compaction ? { providerOptions: { "claude-code": { opencodeAgent: "compaction" } } } : {}),
      abortSignal: AbortSignal.timeout(30_000),
    } as any
    const response = await provider.languageModel(modelId).doStream(options)
    const parts: LanguageModelV3StreamPart[] = []
    for await (const part of response.stream) parts.push(part)
    const text = parts
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("")
    const finish = parts.find((part) => part.type === "finish") as any
    return { parts, text, finish }
  }

  return {
    key,
    transcripts,
    failFork,
    spawns: () => lines().filter((e) => e.type === "spawn"),
    inputs: () => lines().filter((e) => e.type === "input"),
    turn: (prompt: unknown[]) => run(prompt, false),
    compact: (prompt: unknown[]) => run(prompt, true),
    async warm() {
      for (let attempt = 1; attempt <= 4; attempt++) {
        if (await detectCliVersion(cliPath)) return
      }
      throw new Error("the fake CLI never answered --version")
    },
    async settle() {
      // The fork is retired after its turn, off the stream's critical path.
      for (let i = 0; i < 50 && getClaudeSessionId(compactionKey); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    },
    async cleanup() {
      await deleteActiveProcessAndWait(key)
      await deleteActiveProcessAndWait(compactionKey)
      deleteClaudeSessionId(key)
      deleteClaudeSessionId(compactionKey)
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

const T1 = [u("one: the ticket is PLAT-7731")]
const T2 = [...T1, a("A1"), u("two")]
const INSTRUCTION = "Provide a detailed prompt for continuing our conversation above."

test("a compaction runs on a fork of the conversation's session, on its model, and leaves no trace", E2E, async () => {
  _resetServedConversations()
  const f = fixture()
  try {
    await f.warm()
    await f.turn(T1)
    await f.turn(T2)
    const parent = f.spawns()[0]
    const parentId = parent.sessionId as string
    const parentFile = join(f.transcripts, `${parentId}.jsonl`)
    const before = readFileSync(parentFile, "utf8")

    const compacted = await f.compact([...T2, a("A2"), u(INSTRUCTION)])
    const fork = f.spawns()[1]
    assert.equal(argAfter(fork.args, "--resume"), parentId)
    assert.ok(fork.args.includes("--fork-session"))
    assert.equal(argAfter(fork.args, "--model"), "claude-test-compaction-fork", "the conversation's model")
    assert.equal(argAfter(fork.args, "--permission-mode"), "dontAsk")
    assert.ok(fork.args.includes("--strict-mcp-config"))
    assert.ok(!fork.args.includes("--mcp-config"), fork.args.join(" "))
    assert.ok(!fork.args.includes("--dangerously-skip-permissions"), fork.args.join(" "))

    // The fork holds the conversation: no transcript, just the instruction.
    const sent = sentText(f.inputs().at(-1)!.stdin)
    assert.doesNotMatch(sent, /conversation_transcript|PLAT-7731/)
    assert.equal(sent, `${INSTRUCTION}\n${COMPACTION_FORK_INSTRUCTION}`)
    assert.equal(compacted.text, `SUMMARY of ${parentId}`)
    assert.equal(compacted.finish.finishReason.unified, "stop")
    assert.equal(compacted.finish.providerMetadata["claude-code"].compactionModel, "claude-test-compaction-fork")
    assert.equal(compacted.finish.providerMetadata["claude-code"].compactionForked, true)
    assert.doesNotMatch(compacted.text, /▌/, "no note of any kind on a compaction")

    // One owner: the conversation keeps its own session, its file untouched,
    // and the fork's copy is gone once the compaction is over.
    await f.settle()
    assert.equal(getClaudeSessionId(f.key), parentId)
    assert.equal(readFileSync(parentFile, "utf8"), before)
    assert.deepEqual(readdirSync(f.transcripts), [`${parentId}.jsonl`])

    // The conversation carries on, on its own process.
    await f.turn([...T2, a("A2"), u(INSTRUCTION), a("SUMMARY"), u("three")])
    const last = f.inputs().at(-1)!
    assert.equal(last.pid, parent.pid)
    assert.equal(f.spawns().length, 2)
  } finally {
    await f.cleanup()
  }
})

test("forkCompaction off keeps today's transcript on the compaction model", E2E, async () => {
  _resetServedConversations()
  const f = fixture({ settings: { forkCompaction: false } })
  try {
    await f.warm()
    await f.turn(T1)
    await f.turn(T2)
    await f.compact([...T2, a("A2"), u(INSTRUCTION)])
    const spawn = f.spawns()[1]
    assert.equal(argAfter(spawn.args, "--model"), "claude-test-compactor")
    assert.ok(!spawn.args.includes("--resume"), spawn.args.join(" "))
    assert.match(f.inputs().at(-1)!.stdin, /conversation_transcript/)
    assert.match(f.inputs().at(-1)!.stdin, /PLAT-7731/)
  } finally {
    await f.cleanup()
  }
})

test("a conversation with no live process compacts from the transcript", E2E, async () => {
  _resetServedConversations()
  const f = fixture()
  try {
    await f.warm()
    await f.turn(T1)
    await f.turn(T2)
    await deleteActiveProcessAndWait(f.key)
    await f.compact([...T2, a("A2"), u(INSTRUCTION)])
    const spawn = f.spawns().at(-1)!
    assert.equal(argAfter(spawn.args, "--model"), "claude-test-compactor")
    assert.match(f.inputs().at(-1)!.stdin, /conversation_transcript/)
  } finally {
    await f.cleanup()
  }
})

test("a failed fork stores no summary, finishes as an error, and still cleans up", E2E, async () => {
  _resetServedConversations()
  const f = fixture()
  try {
    await f.warm()
    await f.turn(T1)
    await f.turn(T2)
    const parentId = f.spawns()[0].sessionId as string
    writeFileSync(f.failFork, "")
    const compacted = await f.compact([...T2, a("A2"), u(INSTRUCTION)])
    assert.equal(compacted.text, "", "nothing opencode could store as the summary")
    assert.equal(compacted.finish.finishReason.unified, "error")
    assert.ok(compacted.parts.some((part) => part.type === "error"))
    await f.settle()
    assert.equal(getClaudeSessionId(f.key), parentId)
    assert.deepEqual(readdirSync(f.transcripts), [`${parentId}.jsonl`])
    assert.ok(existsSync(join(f.transcripts, `${parentId}.jsonl`)))
  } finally {
    await f.cleanup()
  }
})
