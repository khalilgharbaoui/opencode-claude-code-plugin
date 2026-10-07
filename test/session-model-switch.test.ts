/**
 * Carrying one opencode conversation's Claude session across a model or
 * reasoning-effort change (issue #91, h #g215).
 *
 * Both are in the session key, so changing either used to land a live
 * conversation on a key nothing had ever answered and replay the whole thread
 * as text. Neither is a reason to start a new Claude conversation: `--model`
 * and `CLAUDE_CODE_EFFORT_LEVEL` are both spawn-time, and the CLI applies
 * either to a transcript it resumes (measured on 2.1.288).
 *
 * The unit half drives `modelSiblingSignature`, `findSiblingResumePoint` and
 * `transferClaudeSession` against a scratch store. The end-to-end half drives
 * two real `doStream` turns through a fake CLI, swapping the model between
 * them, and reads the second spawn's argv and envelope.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"

import {
  continuesRecordedConversation,
  conversationDigests,
  modelSiblingSignature,
} from "../src/session-fork.js"
import {
  _setResumeStorePath,
  findSiblingResumePoint,
  recordResumePoint,
  resumeStorePath,
} from "../src/session-resume-store.js"
import { encodeCwd } from "../src/claude-session-bun.js"
import {
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  getClaudeSessionId,
  sessionKey,
  setClaudeSessionId,
  transferClaudeSession,
} from "../src/session-manager.js"
import { detectCliVersion } from "../src/cli-version.js"
import { createClaudeCode } from "../src/index.js"
import { _resetLoggerForTests, configureLogger } from "../src/logger.js"

const CLI = "/opt/claude/claude"
const CONTEXT = 'context=["claude-code",null]'
const userText = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as any
const assistantText = (text: string) =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as any

/** What the turn before the switch was asked to continue. */
const BEFORE = [
  { role: "system", content: "You are a helpful assistant." },
  userText("The project codename is MARLIN. Reply OK."),
] as any

/** The same conversation after the switch: plus Claude's reply, plus new input. */
const AFTER = [...BEFORE, assistantText("OK"), userText("What is the codename?")] as any

const keyFor = (model: string, affinity = "ses_switch", effort?: string) =>
  sessionKey("/work", `${model}::tools::${affinity}::${CONTEXT}`) +
  (effort ? `::effort=${effort}` : "")

// ---------------------------------------------------------------------------
// modelSiblingSignature
// ---------------------------------------------------------------------------

test("modelSiblingSignature blanks the model and drops the effort tail, and nothing else", () => {
  const haiku = keyFor("claude-haiku-4-5")
  const sonnet = keyFor("claude-sonnet-4-5")
  const haikuHigh = keyFor("claude-haiku-4-5", "ses_switch", "high")

  assert.equal(modelSiblingSignature(haiku), modelSiblingSignature(sonnet))
  assert.equal(modelSiblingSignature(haiku), modelSiblingSignature(haikuHigh))
  assert.ok(modelSiblingSignature(haiku)!.includes("*"), "the model segment is blanked")

  // Everything else still has to match, which is what keeps an unrelated
  // conversation out however well its content lines up.
  for (const other of [
    keyFor("claude-haiku-4-5", "ses_other"),
    sessionKey("/elsewhere", `claude-haiku-4-5::tools::ses_switch::${CONTEXT}`),
    sessionKey("/work", `claude-haiku-4-5::no-tools::ses_switch::${CONTEXT}`),
    sessionKey("/work", `claude-haiku-4-5::tools::ses_switch::context=["claude-code","worker"]`),
  ]) {
    assert.notEqual(modelSiblingSignature(other), modelSiblingSignature(haiku), other)
  }

  // Compaction is out on both sides, and so is anything that is not a key.
  assert.equal(modelSiblingSignature(sessionKey("/work", "m::compaction::ses_switch")), null)
  assert.equal(modelSiblingSignature("/work::model"), null)
  assert.equal(modelSiblingSignature(""), null)
})

// ---------------------------------------------------------------------------
// findSiblingResumePoint
// ---------------------------------------------------------------------------

function scratchStore(): { dir: string; transcript: (id: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), "opencode-model-switch-"))
  _setResumeStorePath(join(dir, "state", "claude-sessions.json"))
  return { dir, transcript: (id) => join(dir, `${id}.jsonl`) }
}

function findSibling(
  key: string,
  prompt: any,
  transcript: (id: string) => string,
  overrides: { cliPath?: string; isBusy?: (key: string) => boolean } = {},
) {
  return findSiblingResumePoint({
    sessionKey: key,
    prompt,
    cliPath: overrides.cliPath ?? CLI,
    transcriptPath: transcript,
    isBusy: overrides.isBusy ?? (() => false),
  })
}

test("a conversation answered under another model is found from the new model's key", () => {
  const { dir, transcript } = scratchStore()
  try {
    recordResumePoint(keyFor("claude-haiku-4-5"), "claude-1", BEFORE, CLI)
    writeFileSync(transcript("claude-1"), "")
    _setResumeStorePath(resumeStorePath())

    const found = findSibling(keyFor("claude-sonnet-4-5"), AFTER, transcript)
    assert.deepEqual(found, {
      claudeSessionId: "claude-1",
      siblingKey: keyFor("claude-haiku-4-5"),
      // One: the system message is not part of the conversation digest chain.
      matched: 1,
    })

    // The same conversation at another effort level is the same sibling.
    assert.equal(
      findSibling(keyFor("claude-haiku-4-5", "ses_switch", "high"), AFTER, transcript)
        ?.claudeSessionId,
      "claude-1",
    )
  } finally {
    _setResumeStorePath(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("every refusal falls back to the replay", () => {
  const { dir, transcript } = scratchStore()
  const sibling = keyFor("claude-haiku-4-5")
  const current = keyFor("claude-sonnet-4-5")
  try {
    recordResumePoint(sibling, "claude-1", BEFORE, CLI)
    writeFileSync(transcript("claude-1"), "")

    // Never across accounts: a transcript lives under one config dir and
    // `--resume` cannot cross them (h #g98).
    assert.equal(
      findSibling(current, AFTER, transcript, { cliPath: "/opt/other/claude" }),
      undefined,
      "another claude binary",
    )

    // Never a transcript that may still be written to: this hands the id to a
    // key that is about to spawn a child on it.
    assert.equal(
      findSibling(current, AFTER, transcript, { isBusy: (key) => key === sibling }),
      undefined,
      "a busy sibling",
    )

    // Never another opencode session, directory, scope or agent.
    for (const foreign of [
      keyFor("claude-sonnet-4-5", "ses_other"),
      sessionKey("/elsewhere", `claude-sonnet-4-5::tools::ses_switch::${CONTEXT}`),
      sessionKey("/work", `claude-sonnet-4-5::no-tools::ses_switch::${CONTEXT}`),
    ]) {
      assert.equal(findSibling(foreign, AFTER, transcript), undefined, foreign)
    }

    // Never a compaction key, on either side.
    assert.equal(
      findSibling(sessionKey("/work", "m::compaction::ses_switch"), AFTER, transcript),
      undefined,
      "a compaction key",
    )

    // Never itself.
    assert.equal(findSibling(sibling, AFTER, transcript), undefined, "its own key")

    // Never a conversation that is not this one.
    const edited = [...AFTER]
    edited[1] = userText("The project codename is PELICAN. Reply OK.")
    assert.equal(findSibling(current, edited, transcript), undefined, "an edited message")
    assert.equal(
      findSibling(current, BEFORE.slice(0, 1), transcript),
      undefined,
      "a reverted conversation",
    )
    assert.equal(
      findSibling(
        current,
        [...BEFORE, assistantText("OK"), { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "bash", output: "x" }] }] as any,
        transcript,
      ),
      undefined,
      "a tool round trip in flight",
    )

    rmSync(transcript("claude-1"))
    assert.equal(findSibling(current, AFTER, transcript), undefined, "the transcript is gone")
  } finally {
    _setResumeStorePath(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("with several siblings recorded, the freshest wins", () => {
  const { dir, transcript } = scratchStore()
  try {
    recordResumePoint(keyFor("claude-haiku-4-5"), "claude-old", BEFORE, CLI)
    writeFileSync(transcript("claude-old"), "")
    recordResumePoint(keyFor("claude-opus-5"), "claude-new", BEFORE, CLI)
    writeFileSync(transcript("claude-new"), "")
    assert.equal(
      findSibling(keyFor("claude-sonnet-4-5"), AFTER, transcript)?.claudeSessionId,
      "claude-new",
    )
  } finally {
    _setResumeStorePath(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a refusal names itself, so the replay NOTICE can say why", () => {
  const { dir, transcript } = scratchStore()
  try {
    recordResumePoint(keyFor("claude-haiku-4-5"), "claude-1", BEFORE, CLI)
    writeFileSync(transcript("claude-1"), "")
    const reasons: string[] = []
    findSiblingResumePoint({
      sessionKey: keyFor("claude-sonnet-4-5"),
      prompt: AFTER,
      cliPath: CLI,
      transcriptPath: transcript,
      isBusy: () => true,
      onRefused: (reason) => reasons.push(reason),
    })
    assert.deepEqual(reasons, ["sibling-still-writing"])
    // A token, not a sentence: `/claude-code-doctor bundle` only lets an
    // allowlisted `reason` through when it is a short machine token.
    assert.match(reasons[0], /^[A-Za-z0-9][\w.:@+/-]*$/)
  } finally {
    _setResumeStorePath(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a sibling survives opencode handing the same reply in two shapes", () => {
  const { dir, transcript } = scratchStore()
  // Measured on opencode 1.18.35 (h #g215): a stored assistant message reaches
  // the provider as `reasoning + text` for the model that produced it and as a
  // flattened leading `text` part for every other model. Same reply, two
  // shapes, and a flattened reasoning part is indistinguishable from reply
  // text, so a strict content chain can never match across a model change.
  const asReasoning = {
    role: "assistant",
    content: [
      { type: "reasoning", text: "The user told me the codename is MARLIN." },
      { type: "text", text: "OK" },
    ],
  } as any
  const asFlattenedText = {
    role: "assistant",
    content: [
      { type: "text", text: "The user told me the codename is MARLIN." },
      { type: "text", text: "OK" },
    ],
  } as any
  const recordedUnder = [...BEFORE, asReasoning, userText("What is the codename?")] as any
  const askedUnder = [
    ...BEFORE,
    asFlattenedText,
    userText("What is the codename?"),
    assistantText("MARLIN"),
    userText("Once more?"),
  ] as any
  try {
    recordResumePoint(keyFor("claude-haiku-4-5"), "claude-1", recordedUnder, CLI)
    writeFileSync(transcript("claude-1"), "")
    assert.equal(
      findSibling(keyFor("claude-sonnet-4-5"), askedUnder, transcript)?.claudeSessionId,
      "claude-1",
      "the shape chain sees through the reshuffle",
    )
    // The strict chain still does not, which is why the weaker one is scoped
    // to this lookup and `findResumePoint` keeps comparing the strict one.
    assert.equal(
      continuesRecordedConversation(conversationDigests(recordedUnder), askedUnder),
      false,
    )
    // And the shape is still an identity: a changed USER message is refused.
    const edited = [...askedUnder]
    edited[1] = userText("The project codename is PELICAN. Reply OK.")
    assert.equal(findSibling(keyFor("claude-sonnet-4-5"), edited, transcript), undefined)
  } finally {
    _setResumeStorePath(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a record written before the shape existed is no sibling candidate", () => {
  const { dir, transcript } = scratchStore()
  try {
    recordResumePoint(keyFor("claude-haiku-4-5"), "claude-1", BEFORE, CLI)
    writeFileSync(transcript("claude-1"), "")
    const file = resumeStorePath()
    const onDisk = JSON.parse(readFileSync(file, "utf8"))
    for (const record of Object.values(onDisk.sessions as Record<string, any>)) {
      delete record.shape
    }
    writeFileSync(file, JSON.stringify(onDisk))
    _setResumeStorePath(file)
    assert.equal(findSibling(keyFor("claude-sonnet-4-5"), AFTER, transcript), undefined)
  } finally {
    _setResumeStorePath(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// transferClaudeSession
// ---------------------------------------------------------------------------

test("a transfer moves the id and its resume record, and never copies them", () => {
  const { dir } = scratchStore()
  const from = keyFor("claude-haiku-4-5")
  const to = keyFor("claude-sonnet-4-5")
  try {
    setClaudeSessionId(from, "claude-1")
    recordResumePoint(from, "claude-1", BEFORE, CLI)

    assert.equal(transferClaudeSession(from, to), "claude-1")
    assert.equal(getClaudeSessionId(from), undefined, "the source keeps no claim")
    assert.equal(getClaudeSessionId(to), "claude-1")
    const stored = JSON.parse(readFileSync(resumeStorePath(), "utf8")).sessions
    assert.ok(stored[to], "the record followed the id")
    assert.equal(stored[from], undefined, "and is gone from the source")

    // Refused where there is nothing to move, where the destination already
    // has a conversation of its own, and for a no-op.
    assert.equal(transferClaudeSession(from, to), undefined, "nothing to move")
    setClaudeSessionId(from, "claude-2")
    assert.equal(transferClaudeSession(from, to), undefined, "destination is taken")
    assert.equal(getClaudeSessionId(from), "claude-2", "and the source is left alone")
    assert.equal(transferClaudeSession(to, to), undefined, "same key")
  } finally {
    deleteClaudeSessionId(from)
    deleteClaudeSessionId(to)
    _setResumeStorePath(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// End to end: two real doStream turns with the model swapped between them.
// ---------------------------------------------------------------------------

function createSwitchCli(options: {
  resumeAcrossModelChanges?: boolean
  resumeAfterRestart?: boolean
} = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-model-switch-e2e-"))
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
const sessionId = at >= 0 ? args[at + 1] : "claude-first-model"
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
    ...(options.resumeAcrossModelChanges === undefined
      ? {}
      : { resumeAcrossModelChanges: options.resumeAcrossModelChanges }),
    ...(options.resumeAfterRestart === undefined
      ? {}
      : { resumeAfterRestart: options.resumeAfterRestart }),
  } as any)

  const keys: string[] = []
  const remember = (k: string) => {
    if (!keys.includes(k)) keys.push(k)
    return k
  }
  const key = (modelId: string, affinity = "ses_switch") =>
    remember(sessionKey(cwd, `${modelId}::tools::${affinity}::${CONTEXT}`))
  /** A compaction turn spawns its own child under its own key, and nothing
   *  kills a headless one, so the fixture has to reap it too. */
  const compactionKey = (modelId: string, affinity = "ses_switch") =>
    remember(sessionKey(cwd, `${modelId}::compaction::${affinity}`))

  return {
    key,
    compactionKey,
    events: () =>
      readFileSync(eventsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as any),
    spawns: () =>
      readFileSync(eventsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as any)
        .filter((event) => event.type === "spawn"),
    lastInput: () =>
      JSON.stringify(
        readFileSync(eventsPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as any)
          .filter((event) => event.type === "input")
          .at(-1)?.envelope,
      ),
    /** The transcript the CLI would have written, which the store checks for. */
    writeTranscript(id: string) {
      const dir = join(configDir, "projects", encodeCwd(cwd))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${id}.jsonl`), "")
    },
    async turn(
      modelId: string,
      prompt: any[],
      extra: { affinity?: string; providerOptions?: Record<string, unknown> } = {},
    ) {
      const affinity = extra.affinity ?? "ses_switch"
      key(modelId, affinity)
      const call: LanguageModelV3CallOptions = {
        prompt,
        headers: { "x-session-affinity": affinity },
        tools: [{ type: "function", name: "read", inputSchema: { type: "object", properties: {} } }],
        abortSignal: AbortSignal.timeout(30_000),
        ...(extra.providerOptions ? { providerOptions: extra.providerOptions } : {}),
      } as any
      const response = await provider.languageModel(modelId).doStream(call)
      const parts: LanguageModelV3StreamPart[] = []
      for await (const part of response.stream) {
        if (part.type === "error") throw (part as any).error
        parts.push(part)
      }
      return parts
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

const FIRST = "claude-test-switch-first"
const SECOND = "claude-test-switch-second"

test("a model change continues the same claude conversation instead of replaying it", {
  timeout: 60_000,
}, async () => {
  const fake = createSwitchCli()
  try {
    await fake.warm()
    await fake.turn(FIRST, [...BEFORE])
    assert.equal(getClaudeSessionId(fake.key(FIRST)), "claude-first-model")
    fake.writeTranscript("claude-first-model")

    await fake.turn(SECOND, [...AFTER])

    const spawns = fake.spawns()
    assert.equal(spawns.length, 2)
    const args: string[] = spawns[1].args
    const at = args.indexOf("--resume")
    assert.deepEqual(
      args.slice(at, at + 2),
      ["--resume", "claude-first-model"],
      "the second model resumes the first model's conversation",
    )
    const model = args.indexOf("--model")
    assert.equal(args[model + 1], SECOND, "under the new model")

    const sent = fake.lastInput()
    assert.ok(!sent.includes("conversation_history"), sent.slice(0, 400))
    assert.ok(sent.includes("What is the codename?"))

    // A move, not a copy: the first model's key keeps no claim on it.
    assert.equal(getClaudeSessionId(fake.key(FIRST)), undefined)
  } finally {
    await fake.cleanup()
  }
})

test("the carry-over never crosses opencode sessions", { timeout: 60_000 }, async () => {
  const fake = createSwitchCli()
  try {
    await fake.warm()
    await fake.turn(FIRST, [...BEFORE])
    fake.writeTranscript("claude-first-model")

    // Same content, same cwd, another opencode session: a replay, because
    // that is a FORK and `forkSessions` owns it (off by default).
    await fake.turn(SECOND, [...AFTER], { affinity: "ses_other" })
    const args: string[] = fake.spawns()[1].args
    assert.ok(!args.includes("--resume"))
    assert.ok(fake.lastInput().includes("conversation_history"), "the thread is replayed")
    assert.equal(getClaudeSessionId(fake.key(FIRST)), "claude-first-model", "untouched")
  } finally {
    await fake.cleanup()
  }
})

test("resumeAcrossModelChanges: false replays, as before", { timeout: 60_000 }, async () => {
  const fake = createSwitchCli({ resumeAcrossModelChanges: false })
  try {
    await fake.warm()
    await fake.turn(FIRST, [...BEFORE])
    fake.writeTranscript("claude-first-model")
    await fake.turn(SECOND, [...AFTER])
    assert.ok(!fake.spawns()[1].args.includes("--resume"), JSON.stringify(fake.spawns()[1].args))
    assert.equal(getClaudeSessionId(fake.key(FIRST)), "claude-first-model", "nothing was taken")
    assert.ok(fake.lastInput().includes("conversation_history"))
  } finally {
    await fake.cleanup()
  }
})

test("a compaction turn never takes a sibling's conversation", { timeout: 60_000 }, async () => {
  const fake = createSwitchCli()
  try {
    await fake.warm()
    await fake.turn(FIRST, [...BEFORE])
    fake.writeTranscript("claude-first-model")

    // A compaction turn spawns under the COMPACTION model's own key
    // (`claude-haiku-4-5` by default), not the turn's model.
    fake.compactionKey("claude-haiku-4-5")
    await fake.turn(SECOND, [...AFTER], {
      providerOptions: { "claude-code": { opencodeAgent: "compaction" } },
    })
    const args: string[] = fake.spawns()[1].args
    assert.ok(!args.includes("--resume"), "a compaction spawn is always fresh")
    assert.equal(
      getClaudeSessionId(fake.key(FIRST)),
      "claude-first-model",
      "and leaves the real conversation where it is",
    )
  } finally {
    await fake.cleanup()
  }
})

test("a turn that does replay says so once, at NOTICE, with the reason", {
  timeout: 60_000,
}, async () => {
  // Read off the log FILE, because that is where an operator reads it: a
  // NOTICE only reaches stderr or opencode's log channel in debug mode, and
  // the suite deliberately runs with file logging off (h #g116), so this test
  // turns it on for a scratch directory of its own.
  const logDir = mkdtempSync(join(tmpdir(), "opencode-model-switch-log-"))
  const fake = createSwitchCli({ resumeAcrossModelChanges: false })
  // The suite forces `OPENCODE_CLAUDE_CODE_LOG_FILE=0` and the env var beats
  // the config, so turning file logging on means setting it. Pointed at a
  // scratch dir and restored in `finally`, so this can never append to the
  // operator's real `plugin.log` (h #g116).
  const priorFile = process.env.OPENCODE_CLAUDE_CODE_LOG_FILE
  const priorDir = process.env.OPENCODE_CLAUDE_CODE_LOG_DIR
  try {
    await fake.warm()
    await fake.turn(FIRST, [...BEFORE])
    fake.writeTranscript("claude-first-model")
    process.env.OPENCODE_CLAUDE_CODE_LOG_FILE = "1"
    process.env.OPENCODE_CLAUDE_CODE_LOG_DIR = logDir
    configureLogger({ file: true, dir: logDir, level: "info", mode: "silent" })
    await fake.turn(SECOND, [...AFTER])
  } finally {
    if (priorFile === undefined) delete process.env.OPENCODE_CLAUDE_CODE_LOG_FILE
    else process.env.OPENCODE_CLAUDE_CODE_LOG_FILE = priorFile
    if (priorDir === undefined) delete process.env.OPENCODE_CLAUDE_CODE_LOG_DIR
    else process.env.OPENCODE_CLAUDE_CODE_LOG_DIR = priorDir
    _resetLoggerForTests()
    await fake.cleanup()
  }
  const written = join(logDir, "plugin.log")
  const lines = (existsSync(written) ? readFileSync(written, "utf8") : "")
    .split("\n")
    .filter((line) => line.includes("replaying the conversation as text"))
  rmSync(logDir, { recursive: true, force: true })
  assert.equal(lines.length, 1, lines.join("\n"))
  assert.match(lines[0], /NOTICE/)
  assert.match(lines[0], /no-session-recorded/)
})
