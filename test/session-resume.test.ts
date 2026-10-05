/**
 * Resuming a conversation's Claude session after opencode restarts
 * (`src/session-resume-store.ts`), instead of replaying the thread as text.
 *
 * The unit half drives the store against a scratch file. The end-to-end half
 * drives two real `doStream` turns through a fake CLI with the in-memory
 * session id dropped between them, which is exactly what a new opencode
 * process sees, and checks the second spawn's argv and envelope.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"

import {
  _setResumeStorePath,
  findResumePoint,
  forgetResumePoint,
  MAX_RESUME_RECORDS,
  recordResumePoint,
  resumeStorePath,
} from "../src/session-resume-store.js"
import { encodeCwd } from "../src/claude-session-bun.js"
import {
  _forgetClaudeSessionIdInMemory,
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  getClaudeSessionId,
  sessionKey,
} from "../src/session-manager.js"
import { detectCliVersion } from "../src/cli-version.js"
import { createClaudeCode } from "../src/index.js"

const CLI = "/opt/claude/claude"
const userText = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as any
const assistantText = (text: string) =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as any

/** What the last turn before the restart was asked to continue. */
const BEFORE = [
  { role: "system", content: "You are a helpful assistant." },
  userText("Explain the cache."),
  assistantText("The cache stores the prompt prefix."),
  userText("Now explain resuming."),
] as any

/** The same conversation after the restart: plus Claude's reply, plus new input. */
const AFTER = [...BEFORE, assistantText("Resuming continues a session."), userText("Shorter, please.")] as any

function scratchStore(): { dir: string; transcript: (id: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), "opencode-resume-store-"))
  _setResumeStorePath(join(dir, "state", "claude-sessions.json"))
  return { dir, transcript: (id) => join(dir, `${id}.jsonl`) }
}

function find(key: string, prompt: any, transcript: (id: string) => string, cliPath = CLI) {
  return findResumePoint({ sessionKey: key, prompt, cliPath, transcriptPath: transcript })
}

test("a recorded conversation is found again by a new process", () => {
  const { dir, transcript } = scratchStore()
  try {
    recordResumePoint("key-a", "claude-1", BEFORE, CLI)
    writeFileSync(transcript("claude-1"), "")
    // A new process: the cache is dropped and the file is read back.
    _setResumeStorePath(resumeStorePath())
    assert.deepEqual(find("key-a", AFTER, transcript), { claudeSessionId: "claude-1", matched: 3 })
    // 0600, because the keys carry working directories.
    assert.equal(statSync(resumeStorePath()).mode & 0o777, 0o600)
  } finally {
    _setResumeStorePath(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("every mismatch falls back to the replay", () => {
  const { dir, transcript } = scratchStore()
  try {
    recordResumePoint("key-a", "claude-1", BEFORE, CLI)
    writeFileSync(transcript("claude-1"), "")

    assert.equal(find("key-b", AFTER, transcript), undefined, "another session key")
    assert.equal(find("key-a", AFTER, transcript, "/opt/other/claude"), undefined, "another binary")

    const edited = [...AFTER]
    edited[1] = userText("Explain the cache, briefly.")
    assert.equal(find("key-a", edited, transcript), undefined, "an edited message")

    const reverted = BEFORE.slice(0, 2)
    assert.equal(find("key-a", reverted, transcript), undefined, "a reverted conversation")

    const extraUser = [...BEFORE, userText("And again."), assistantText("ok"), userText("Next.")]
    assert.equal(find("key-a", extraUser, transcript), undefined, "a user message after the recorded chain")

    const openToolRound = [
      ...BEFORE,
      assistantText("Running it."),
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "bash", output: "x" }] },
    ] as any
    assert.equal(find("key-a", openToolRound, transcript), undefined, "a tool round trip in flight")

    rmSync(transcript("claude-1"))
    assert.equal(find("key-a", AFTER, transcript), undefined, "the transcript is gone")
  } finally {
    _setResumeStorePath(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a forgotten key is gone from disk too", () => {
  const { dir, transcript } = scratchStore()
  try {
    recordResumePoint("key-a", "claude-1", BEFORE, CLI)
    writeFileSync(transcript("claude-1"), "")
    forgetResumePoint("key-a")
    _setResumeStorePath(resumeStorePath())
    assert.equal(find("key-a", AFTER, transcript), undefined)
  } finally {
    _setResumeStorePath(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("two processes keep each other's records, and the store is capped", () => {
  const { dir } = scratchStore()
  try {
    recordResumePoint("key-a", "claude-1", BEFORE, CLI)
    // Another process wrote key-b after this one loaded the file.
    const file = resumeStorePath()
    const onDisk = JSON.parse(readFileSync(file, "utf8"))
    onDisk.sessions["key-b"] = { ...onDisk.sessions["key-a"], claudeSessionId: "claude-2" }
    writeFileSync(file, JSON.stringify(onDisk))
    recordResumePoint("key-c", "claude-3", BEFORE, CLI)
    const keys = Object.keys(JSON.parse(readFileSync(file, "utf8")).sessions)
    assert.deepEqual(keys.sort(), ["key-a", "key-b", "key-c"])

    for (let i = 0; i < MAX_RESUME_RECORDS + 5; i++) {
      recordResumePoint(`bulk-${i}`, `claude-bulk-${i}`, BEFORE, CLI)
    }
    const after = Object.keys(JSON.parse(readFileSync(file, "utf8")).sessions)
    assert.equal(after.length, MAX_RESUME_RECORDS)
    assert.ok(after.includes(`bulk-${MAX_RESUME_RECORDS + 4}`), "the newest survives the cap")
  } finally {
    _setResumeStorePath(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a malformed store is an empty one, never an error", () => {
  const { dir, transcript } = scratchStore()
  try {
    mkdirSync(join(dir, "state"), { recursive: true })
    writeFileSync(resumeStorePath(), "{not json")
    _setResumeStorePath(resumeStorePath())
    assert.equal(find("key-a", AFTER, transcript), undefined)
    recordResumePoint("key-a", "claude-1", BEFORE, CLI)
    assert.ok(JSON.parse(readFileSync(resumeStorePath(), "utf8")).sessions["key-a"])
  } finally {
    _setResumeStorePath(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// End to end: a real doStream before and after a simulated restart.
// ---------------------------------------------------------------------------

const CONTEXT = 'context=["claude-code",null]'

function createResumeCli(options: { resumeAfterRestart?: boolean }) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-session-resume-"))
  const configDir = join(cwd, "claude-config")
  const cliPath = join(cwd, "fake-claude.cjs")
  const eventsPath = join(cwd, "events.jsonl")
  writeFileSync(eventsPath, "")
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
const args = process.argv.slice(2)
const record = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + "\\n")
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
if (args.includes("--version")) {
  process.stdout.write("2.1.288\\n")
  process.exit(0)
}
if (args.includes("--help")) {
  process.exit(0)
}
const at = args.indexOf("--resume")
const sessionId = at >= 0 ? args[at + 1] : "claude-before-restart"
record({ type: "spawn", args, sessionId })
emit({ type: "system", subtype: "init", session_id: sessionId })
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const envelope = JSON.parse(line)
  if (envelope.type !== "user") return
  record({ type: "input", sessionId, envelope })
  emit({ type: "assistant", session_id: sessionId, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Answer" }] } })
  emit({ type: "result", subtype: "success", session_id: sessionId, is_error: false, usage: { input_tokens: 9, output_tokens: 4 } })
})
`,
    { mode: 0o755 },
  )
  _setResumeStorePath(join(cwd, "state", "claude-sessions.json"))

  const modelId = "claude-test-session-resume"
  const model = createClaudeCode({
    cliPath,
    cwd,
    configDir,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    interactive: false,
    autoContinueIncompleteTurns: false,
    ...(options.resumeAfterRestart === undefined ? {} : { resumeAfterRestart: options.resumeAfterRestart }),
  } as any).languageModel(modelId)
  const key = sessionKey(cwd, `${modelId}::tools::ses_restart::${CONTEXT}`)

  return {
    key,
    events: () =>
      readFileSync(eventsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as any),
    /** The transcript the CLI would have written, which the store checks for. */
    writeTranscript(id: string) {
      const dir = join(configDir, "projects", encodeCwd(cwd))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${id}.jsonl`), "")
    },
    async turn(prompt: any[]) {
      const call: LanguageModelV3CallOptions = {
        prompt,
        headers: { "x-session-affinity": "ses_restart" },
        tools: [{ type: "function", name: "read", inputSchema: { type: "object", properties: {} } }],
        abortSignal: AbortSignal.timeout(30_000),
      } as any
      const response = await model.doStream(call)
      const parts: LanguageModelV3StreamPart[] = []
      for await (const part of response.stream) parts.push(part)
      return parts
    },
    /** What a new opencode process knows: nothing in memory, no child. */
    async restart() {
      await deleteActiveProcessAndWait(key)
      _forgetClaudeSessionIdInMemory(key)
      _setResumeStorePath(join(cwd, "state", "claude-sessions.json"))
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
      _setResumeStorePath(null)
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

test("after a restart the conversation resumes its claude session instead of replaying", {
  timeout: 60_000,
}, async () => {
  const fake = createResumeCli({})
  try {
    await fake.warm()
    await fake.turn([...BEFORE])
    assert.equal(getClaudeSessionId(fake.key), "claude-before-restart")
    fake.writeTranscript("claude-before-restart")

    await fake.restart()
    assert.equal(getClaudeSessionId(fake.key), undefined)
    await fake.turn([...AFTER])

    const spawns = fake.events().filter((event) => event.type === "spawn")
    assert.equal(spawns.length, 2)
    const args: string[] = spawns[1].args
    const at = args.indexOf("--resume")
    assert.deepEqual(args.slice(at, at + 2), ["--resume", "claude-before-restart"])

    const sent = JSON.stringify(fake.events().filter((event) => event.type === "input").at(-1).envelope)
    assert.ok(!sent.includes("conversation_history"), sent.slice(0, 400))
    assert.ok(sent.includes("Shorter, please."))
  } finally {
    await fake.cleanup()
  }
})

test("without the transcript on disk the restart replays as before", { timeout: 60_000 }, async () => {
  const fake = createResumeCli({})
  try {
    await fake.warm()
    await fake.turn([...BEFORE])
    await fake.restart()
    await fake.turn([...AFTER])
    const spawns = fake.events().filter((event) => event.type === "spawn")
    assert.ok(!spawns[1].args.includes("--resume"))
    const sent = JSON.stringify(fake.events().filter((event) => event.type === "input").at(-1).envelope)
    assert.ok(sent.includes("Explain the cache."), "the history is replayed")
  } finally {
    await fake.cleanup()
  }
})

test("resumeAfterRestart: false never writes the store", { timeout: 60_000 }, async () => {
  const fake = createResumeCli({ resumeAfterRestart: false })
  try {
    await fake.warm()
    await fake.turn([...BEFORE])
    assert.equal(existsSync(resumeStorePath()), false)
    fake.writeTranscript("claude-before-restart")
    await fake.restart()
    await fake.turn([...AFTER])
    const spawns = fake.events().filter((event) => event.type === "spawn")
    assert.ok(!spawns[1].args.includes("--resume"))
  } finally {
    await fake.cleanup()
  }
})
