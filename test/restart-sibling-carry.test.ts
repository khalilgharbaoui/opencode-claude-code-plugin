/**
 * The first model or effort change after an opencode RESTART (h #g274).
 *
 * `test/session-model-switch.test.ts` and `test/effort-sessions.test.ts` swap
 * the model or the effort inside one process, where the sibling's Claude
 * session id is still in memory. After a restart it is not: the only thing
 * that knows which Claude session answered the conversation is the resume
 * record on disk. These drive two real `doStream` turns through a fake CLI
 * with everything in memory dropped between them (what a new opencode process,
 * or a handover to another copy of the plugin, sees) and change the model or
 * the effort on the second turn.
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"

import { _setResumeStorePath, resumeStorePath } from "../src/session-resume-store.js"
import { encodeCwd } from "../src/claude-session-bun.js"
import {
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  effortSessionKey,
  getActiveProcess,
  getClaudeSessionId,
  releaseIdleForHandover,
  sessionKey,
} from "../src/session-manager.js"
import { detectCliVersion } from "../src/cli-version.js"
import { createClaudeCode } from "../src/index.js"

const CONTEXT = 'context=["claude-code",null]'
const userText = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as any
const assistantText = (text: string) =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as any

/** What the last turn before the restart was asked to continue. */
const BEFORE = [
  { role: "system", content: "You are a helpful assistant." },
  userText("The project codename is MARLIN. Reply OK."),
] as any

/** The same conversation after the restart: plus Claude's reply, plus new input. */
const AFTER = [...BEFORE, assistantText("MARLIN"), userText("What is the codename?")] as any

/** And one more exchange, for switching back. */
const LATER = [...AFTER, assistantText("MARLIN"), userText("Spell it backwards.")] as any

const FIRST = "claude-test-restart-first"
const SECOND = "claude-test-restart-second"
const SESSION = "claude-before-restart"

type Effort = "low" | "high"

function createRestartCli() {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-restart-carry-"))
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
const sessionId = at >= 0 ? args[at + 1] : ${JSON.stringify(SESSION)}
record({ type: "spawn", args, sessionId, effort: process.env.CLAUDE_CODE_EFFORT_LEVEL || null })
emit({ type: "system", subtype: "init", session_id: sessionId })
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const envelope = JSON.parse(line)
  if (envelope.type !== "user") return
  record({ type: "input", sessionId, envelope })
  emit({ type: "assistant", session_id: sessionId, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "MARLIN" }] } })
  emit({ type: "result", subtype: "success", session_id: sessionId, is_error: false, usage: { input_tokens: 9, output_tokens: 4 } })
})
`,
    { mode: 0o755 },
  )
  _setResumeStorePath(join(cwd, "state", "claude-sessions.json"))

  const provider = createClaudeCode({
    cliPath,
    cwd,
    configDir,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    interactive: false,
    autoContinueIncompleteTurns: false,
  } as any)

  const keys: string[] = []
  const key = (modelId: string, effort?: Effort) => {
    const k = effortSessionKey(sessionKey(cwd, `${modelId}::tools::ses_restart::${CONTEXT}`), effort)
    if (!keys.includes(k)) keys.push(k)
    return k
  }
  const events = () =>
    readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as any)

  return {
    key,
    spawns: () => events().filter((event) => event.type === "spawn"),
    lastInput: () =>
      JSON.stringify(events().filter((event) => event.type === "input").at(-1)?.envelope),
    /** Every resume record on disk, by session key. */
    records: (): Record<string, { claudeSessionId: string }> => {
      try {
        return JSON.parse(readFileSync(resumeStorePath(), "utf8")).sessions ?? {}
      } catch {
        return {}
      }
    },
    /** The transcript the CLI would have written, which the store checks for. */
    writeTranscript(id: string) {
      const dir = join(configDir, "projects", encodeCwd(cwd))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${id}.jsonl`), "")
    },
    async turn(modelId: string, prompt: any[], effort?: Effort) {
      key(modelId, effort)
      const call: LanguageModelV3CallOptions = {
        prompt,
        headers: { "x-session-affinity": "ses_restart" },
        tools: [{ type: "function", name: "read", inputSchema: { type: "object", properties: {} } }],
        abortSignal: AbortSignal.timeout(30_000),
        ...(effort ? { providerOptions: { "claude-code": { reasoningEffort: effort } } } : {}),
      } as any
      const response = await provider.languageModel(modelId).doStream(call)
      for await (const part of response.stream) {
        if (part.type === "error") throw (part as any).error
      }
    },
    /**
     * What a new opencode process starts with: no `claude` children and
     * nothing in memory, the resume records on disk untouched. A handover to
     * another copy of the plugin leaves exactly this behind (h #g269), so the
     * handover's own release is the restart.
     */
    async restart() {
      await releaseIdleForHandover()
      for (const k of keys) {
        assert.equal(getActiveProcess(k), undefined, `no child survives the restart: ${k}`)
        assert.equal(getClaudeSessionId(k), undefined, `no id survives in memory: ${k}`)
      }
    },
    async warm() {
      for (let attempt = 1; attempt <= 4; attempt++) {
        if (await detectCliVersion(cliPath)) return
      }
      throw new Error("the fake CLI never answered --version")
    },
    async cleanup() {
      for (const k of keys) {
        await deleteActiveProcessAndWait(k)
        deleteClaudeSessionId(k)
      }
      _setResumeStorePath(null)
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

/** The keys on disk that name this one Claude conversation. One owner, always. */
function owners(records: Record<string, { claudeSessionId: string }>, id = SESSION): string[] {
  return Object.entries(records)
    .filter(([, record]) => record.claudeSessionId === id)
    .map(([k]) => k)
}

function resumedId(args: string[]): string | undefined {
  const at = args.indexOf("--resume")
  return at >= 0 ? args[at + 1] : undefined
}

test("the first model change after a restart continues the claude session instead of replaying", {
  timeout: 60_000,
}, async () => {
  const fake = createRestartCli()
  try {
    await fake.warm()
    await fake.turn(FIRST, [...BEFORE])
    fake.writeTranscript(SESSION)
    assert.deepEqual(owners(fake.records()), [fake.key(FIRST)])

    await fake.restart()
    await fake.turn(SECOND, [...AFTER])

    const spawns = fake.spawns()
    assert.equal(spawns.length, 2)
    const args: string[] = spawns[1].args
    assert.equal(resumedId(args), SESSION, `the new model resumes: ${JSON.stringify(args)}`)
    assert.equal(args[args.indexOf("--model") + 1], SECOND, "under the new model")
    const sent = fake.lastInput()
    assert.ok(!sent.includes("conversation_history"), sent.slice(0, 400))
    assert.ok(sent.includes("What is the codename?"))

    // A move, never a copy: the old model's key keeps no claim, in memory or
    // on disk, so the next restart cannot hand the transcript to two keys.
    assert.equal(getClaudeSessionId(fake.key(FIRST)), undefined)
    assert.equal(getClaudeSessionId(fake.key(SECOND)), SESSION)
    assert.deepEqual(owners(fake.records()), [fake.key(SECOND)])

    // And back again, now that the id is in memory: still the one conversation.
    await fake.turn(FIRST, [...LATER])
    assert.equal(resumedId(fake.spawns()[2].args), SESSION)
    assert.ok(!fake.lastInput().includes("conversation_history"))
    assert.deepEqual(owners(fake.records()), [fake.key(FIRST)])
  } finally {
    await fake.cleanup()
  }
})

test("the first effort change after a restart continues the claude session instead of replaying", {
  timeout: 60_000,
}, async () => {
  const fake = createRestartCli()
  try {
    await fake.warm()
    await fake.turn(FIRST, [...BEFORE], "high")
    fake.writeTranscript(SESSION)
    assert.deepEqual(owners(fake.records()), [fake.key(FIRST, "high")])

    await fake.restart()
    await fake.turn(FIRST, [...AFTER], "low")

    const spawns = fake.spawns()
    assert.equal(spawns.length, 2)
    assert.equal(resumedId(spawns[1].args), SESSION, `the new effort resumes: ${JSON.stringify(spawns[1].args)}`)
    assert.equal(spawns[1].effort, "low", "at the new effort")
    const sent = fake.lastInput()
    assert.ok(!sent.includes("conversation_history"), sent.slice(0, 400))
    assert.ok(sent.includes("What is the codename?"))

    assert.equal(getClaudeSessionId(fake.key(FIRST, "high")), undefined)
    assert.equal(getClaudeSessionId(fake.key(FIRST, "low")), SESSION)
    assert.deepEqual(owners(fake.records()), [fake.key(FIRST, "low")])

    await fake.turn(FIRST, [...LATER], "high")
    assert.equal(resumedId(fake.spawns()[2].args), SESSION)
    assert.equal(fake.spawns()[2].effort, "high")
    assert.ok(!fake.lastInput().includes("conversation_history"))
    assert.deepEqual(owners(fake.records()), [fake.key(FIRST, "high")])
  } finally {
    await fake.cleanup()
  }
})

test("a model and effort change together after a restart continues it too", {
  timeout: 60_000,
}, async () => {
  const fake = createRestartCli()
  try {
    await fake.warm()
    await fake.turn(FIRST, [...BEFORE], "high")
    fake.writeTranscript(SESSION)

    await fake.restart()
    await fake.turn(SECOND, [...AFTER], "low")

    const spawn = fake.spawns()[1]
    assert.equal(resumedId(spawn.args), SESSION, JSON.stringify(spawn.args))
    assert.equal(spawn.args[spawn.args.indexOf("--model") + 1], SECOND)
    assert.equal(spawn.effort, "low")
    assert.ok(!fake.lastInput().includes("conversation_history"))
    assert.deepEqual(owners(fake.records()), [fake.key(SECOND, "low")])
  } finally {
    await fake.cleanup()
  }
})

for (const change of ["model", "effort"] as const) {
  test(`after a restart a ${change} change still replays when the sibling's transcript is gone`, {
    timeout: 60_000,
  }, async () => {
    const fake = createRestartCli()
    try {
      await fake.warm()
      await fake.turn(FIRST, [...BEFORE], "high")
      // No transcript written: `findSiblingResumePoint` refuses it.

      await fake.restart()
      await fake.turn(change === "model" ? SECOND : FIRST, [...AFTER], change === "model" ? "high" : "low")

      const spawn = fake.spawns()[1]
      assert.equal(resumedId(spawn.args), undefined, JSON.stringify(spawn.args))
      assert.ok(fake.lastInput().includes("conversation_history"), "the thread is replayed")
    } finally {
      await fake.cleanup()
    }
  })
}

test("after a restart an edited conversation still replays instead of taking the sibling's session", {
  timeout: 60_000,
}, async () => {
  const fake = createRestartCli()
  try {
    await fake.warm()
    await fake.turn(FIRST, [...BEFORE], "high")
    fake.writeTranscript(SESSION)

    await fake.restart()
    const edited = [
      BEFORE[0],
      userText("The project codename is PIKE. Reply OK."),
      assistantText("MARLIN"),
      userText("What is the codename?"),
    ]
    await fake.turn(FIRST, edited, "low")

    const spawn = fake.spawns()[1]
    assert.equal(resumedId(spawn.args), undefined, JSON.stringify(spawn.args))
    assert.ok(fake.lastInput().includes("conversation_history"), "the thread is replayed")
  } finally {
    await fake.cleanup()
  }
})
