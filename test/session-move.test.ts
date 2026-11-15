/**
 * A session opencode moved to another working directory (h #g317).
 *
 * opencode 2 moves one session between directories (`session_move`, a lane's
 * worktree), and the session's directory is the spawn's cwd and the first
 * segment of its session key. Before this the next turn landed on a key
 * nothing had answered and replayed the whole thread as text. These drive real
 * `doStream` turns through a fake CLI, with two providers pinned to directory A
 * and directory B standing in for the move: same opencode session, same model,
 * same agent, another directory.
 *
 * The fake resumes a session only from a transcript filed under ITS OWN
 * directory's encoded name. The real CLI (2.1.322) also finds one filed under
 * another directory, but then keeps appending there, where neither the
 * restart lookup nor the interactive transport looks; refusing it here is what
 * proves the plugin copied the file across before resuming.
 *
 * POSIX only, like the other fake-CLI files.
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"

import { encodeCwd } from "../src/claude-session-bun.js"
import { detectCliVersion } from "../src/cli-version.js"
import { createClaudeCode } from "../src/index.js"
import { _setResumeStorePath, resumeStorePath } from "../src/session-resume-store.js"
import {
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  getActiveProcess,
  getClaudeSessionId,
  releaseIdleForHandover,
  sessionKey,
} from "../src/session-manager.js"

const POSIX = { skip: process.platform === "win32" ? "fake CLI is a POSIX script" : false }

const MODEL = "claude-test-session-move"
const SESSION = "claude-before-move"
const userText = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as any
const assistantText = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] }) as any

const BEFORE = [
  { role: "system", content: "You are a helpful assistant." },
  userText("The project codename is OSPREY. Reply OK."),
] as any
const AFTER = [...BEFORE, assistantText("OSPREY"), userText("What is the codename?")] as any

function createMoveCli(opts: { resumeAfterRestart?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "opencode-session-move-")))
  const dirA = join(root, "main")
  const dirB = join(root, "worktree")
  mkdirSync(dirA)
  mkdirSync(dirB)
  const configDir = join(root, "claude-config")
  const cliPath = join(root, "fake-claude.cjs")
  const eventsPath = join(root, "events.jsonl")
  writeFileSync(eventsPath, "")
  writeFileSync(
    cliPath,
    `#!${process.execPath}
const fs = require("node:fs")
const path = require("node:path")
const readline = require("node:readline")
const args = process.argv.slice(2)
const record = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + "\\n")
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
if (args.includes("--version")) { process.stdout.write("2.1.322\\n"); process.exit(0) }
if (args.includes("--help")) { process.stdout.write("\\n"); process.exit(0) }
const cwd = fs.realpathSync.native(process.cwd())
const transcript = (id) =>
  path.join(${JSON.stringify(configDir)}, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), id + ".jsonl")
const at = args.indexOf("--resume")
const sessionId = at >= 0 ? args[at + 1] : ${JSON.stringify(SESSION)}
record({ type: "spawn", args, cwd, sessionId })
if (at >= 0 && !fs.existsSync(transcript(sessionId))) {
  emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId,
    result: "No conversation found with session ID: " + sessionId })
  process.exit(1)
}
emit({ type: "system", subtype: "init", session_id: sessionId })
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const envelope = JSON.parse(line)
  if (envelope.type !== "user") return
  record({ type: "input", sessionId, cwd, envelope })
  fs.mkdirSync(path.dirname(transcript(sessionId)), { recursive: true })
  fs.appendFileSync(transcript(sessionId), JSON.stringify({ type: "user", cwd }) + "\\n")
  emit({ type: "assistant", session_id: sessionId, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "OSPREY" }] } })
  emit({ type: "result", subtype: "success", session_id: sessionId, is_error: false, usage: { input_tokens: 9, output_tokens: 4 } })
})
`,
    { mode: 0o755 },
  )
  _setResumeStorePath(join(root, "state", "claude-sessions.json"))

  const providerFor = (cwd: string) =>
    createClaudeCode({
      cliPath,
      cwd,
      configDir,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: [],
      interactive: false,
      autoContinueIncompleteTurns: false,
      liveModelSwitch: false,
      ...(opts.resumeAfterRestart === false ? { resumeAfterRestart: false } : {}),
    } as any)
  const providers = { [dirA]: providerFor(dirA), [dirB]: providerFor(dirB) }
  const key = (cwd: string, affinity = "ses_moved") =>
    sessionKey(cwd, `${MODEL}::tools::${affinity}::context=["claude-code",null]`)
  const transcriptIn = (cwd: string, id = SESSION) =>
    join(configDir, "projects", encodeCwd(cwd), `${id}.jsonl`)
  const events = () =>
    readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as any)

  return {
    dirA,
    dirB,
    key,
    transcriptIn,
    spawns: () => events().filter((event) => event.type === "spawn"),
    inputs: () => events().filter((event) => event.type === "input"),
    records: (): Record<string, { claudeSessionId: string }> => {
      try {
        return JSON.parse(readFileSync(resumeStorePath(), "utf8")).sessions ?? {}
      } catch {
        return {}
      }
    },
    async turn(cwd: string, prompt: any[], affinity = "ses_moved") {
      const call: LanguageModelV3CallOptions = {
        prompt,
        headers: { "x-session-affinity": affinity },
        tools: [{ type: "function", name: "read", inputSchema: { type: "object", properties: {} } }],
        abortSignal: AbortSignal.timeout(30_000),
      } as any
      const response = await providers[cwd].languageModel(MODEL).doStream(call)
      for await (const part of response.stream) {
        if (part.type === "error") throw (part as any).error
      }
    },
    async warm() {
      for (let attempt = 1; attempt <= 4; attempt++) {
        if (await detectCliVersion(cliPath)) return
      }
      throw new Error("the fake CLI never answered --version")
    },
    async cleanup() {
      for (const cwd of [dirA, dirB]) {
        for (const affinity of ["ses_moved", "ses_other", "default"]) {
          await deleteActiveProcessAndWait(key(cwd, affinity))
          deleteClaudeSessionId(key(cwd, affinity))
        }
      }
      _setResumeStorePath(null)
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const resumedId = (args: string[]) => {
  const at = args.indexOf("--resume")
  return at >= 0 ? args[at + 1] : undefined
}

const owners = (records: Record<string, { claudeSessionId: string }>) =>
  Object.entries(records)
    .filter(([, record]) => record.claudeSessionId === SESSION)
    .map(([k]) => k)

test("a session opencode moved to another directory continues its claude session there", {
  ...POSIX,
  timeout: 60_000,
}, async () => {
  const fake = createMoveCli()
  try {
    await fake.warm()
    await fake.turn(fake.dirA, [...BEFORE])
    const original = readFileSync(fake.transcriptIn(fake.dirA), "utf8")
    assert.ok(original.length > 0)

    await fake.turn(fake.dirB, [...AFTER])

    const spawns = fake.spawns()
    assert.equal(spawns.length, 2)
    assert.equal(spawns[1].cwd, fake.dirB, "the next child runs in the new directory")
    assert.equal(resumedId(spawns[1].args), SESSION, JSON.stringify(spawns[1].args))
    const sent = JSON.stringify(fake.inputs().at(-1)?.envelope)
    assert.ok(!sent.includes("conversation_history"), sent.slice(0, 400))
    assert.ok(sent.includes("What is the codename?"))

    // A copy under the new directory's name, appended to there; the original
    // is left exactly as it was.
    assert.equal(readFileSync(fake.transcriptIn(fake.dirA), "utf8"), original)
    const moved = readFileSync(fake.transcriptIn(fake.dirB), "utf8")
    assert.ok(moved.startsWith(original))
    assert.ok(moved.length > original.length)

    // One owner: the old directory's child is gone and its key keeps no claim.
    assert.equal(getActiveProcess(fake.key(fake.dirA)), undefined)
    assert.equal(getClaudeSessionId(fake.key(fake.dirA)), undefined)
    assert.equal(getClaudeSessionId(fake.key(fake.dirB)), SESSION)
    assert.deepEqual(owners(fake.records()), [fake.key(fake.dirB)])
  } finally {
    await fake.cleanup()
  }
})

test("the move is carried after an opencode restart too", { ...POSIX, timeout: 60_000 }, async () => {
  const fake = createMoveCli()
  try {
    await fake.warm()
    await fake.turn(fake.dirA, [...BEFORE])
    await releaseIdleForHandover()
    assert.equal(getClaudeSessionId(fake.key(fake.dirA)), undefined, "nothing survives in memory")

    await fake.turn(fake.dirB, [...AFTER])

    const spawns = fake.spawns()
    assert.equal(spawns.at(-1).cwd, fake.dirB)
    assert.equal(resumedId(spawns.at(-1).args), SESSION)
    assert.ok(!JSON.stringify(fake.inputs().at(-1)?.envelope).includes("conversation_history"))
    assert.ok(existsSync(fake.transcriptIn(fake.dirB)))
    assert.deepEqual(owners(fake.records()), [fake.key(fake.dirB)])
  } finally {
    await fake.cleanup()
  }
})

test("another opencode session in another directory is never carried", { ...POSIX, timeout: 60_000 }, async () => {
  const fake = createMoveCli()
  try {
    await fake.warm()
    await fake.turn(fake.dirA, [...BEFORE])
    await fake.turn(fake.dirB, [...AFTER], "ses_other")

    const last = fake.spawns().at(-1)
    assert.equal(resumedId(last.args), undefined, JSON.stringify(last.args))
    assert.ok(JSON.stringify(fake.inputs().at(-1)?.envelope).includes("conversation_history"))
    assert.equal(getClaudeSessionId(fake.key(fake.dirA)), SESSION, "the other session keeps its own")
    assert.ok(getActiveProcess(fake.key(fake.dirA)), "and its child")
  } finally {
    await fake.cleanup()
  }
})

test("with resumeAfterRestart off the move still replays, as a model change does", {
  ...POSIX,
  timeout: 60_000,
}, async () => {
  const fake = createMoveCli({ resumeAfterRestart: false })
  try {
    await fake.warm()
    await fake.turn(fake.dirA, [...BEFORE])
    await fake.turn(fake.dirB, [...AFTER])
    const last = fake.spawns().at(-1)
    assert.equal(resumedId(last.args), undefined)
    assert.ok(JSON.stringify(fake.inputs().at(-1)?.envelope).includes("conversation_history"))
  } finally {
    await fake.cleanup()
  }
})
