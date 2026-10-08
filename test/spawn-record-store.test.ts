/**
 * What each opencode session really spawned as, written by the server half and
 * read by the TUI's `Subagents` section (h #g234).
 *
 * The store half drives `recordSessionSpawn` and `createSpawnRecordReader`
 * against a scratch file. The end-to-end half drives a real `doStream` through
 * a fake CLI with an agent override and a requested effort, and reads back the
 * record the turn wrote: the model and effort the CLI was actually spawned
 * with, not the ones opencode asked for.
 */
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  MAX_SPAWN_RECORDS,
  SPAWN_RECORD_MAX_AGE_MS,
  _setSpawnRecordStorePathForTests,
  createSpawnRecordReader,
  recordSessionSpawn,
  spawnRecordStorePath,
} from "../src/spawn-record-store.js"

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-spawn-records-"))
  _setSpawnRecordStorePathForTests(join(dir, "state", "session-spawns.json"))
  return dir
}

const onDisk = () => JSON.parse(readFileSync(spawnRecordStorePath(), "utf8"))

test("a spawn is written once, rewritten only when it changes, and never for default", () => {
  const dir = scratch()
  try {
    const now = Date.now()
    assert.equal(recordSessionSpawn("ses_a", { model: "claude-sonnet-5-5", effort: "high" }, now), true)
    assert.equal(recordSessionSpawn("ses_a", { model: "claude-sonnet-5-5", effort: "high" }, now + 1), false)
    assert.equal(recordSessionSpawn("ses_a", { model: "claude-sonnet-5-5", effort: "max" }, now + 2), true)
    assert.equal(recordSessionSpawn("default", { model: "claude-opus-5-5" }), false)
    assert.equal(recordSessionSpawn("", { model: "claude-opus-5-5" }), false)
    assert.equal(recordSessionSpawn("ses_b", { model: "" }), false)
    assert.deepEqual(onDisk(), {
      version: 1,
      sessions: { ses_a: { model: "claude-sonnet-5-5", effort: "max", at: now + 2 } },
    })
  } finally {
    _setSpawnRecordStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the file is 0600 in a 0700 directory, because the state directory is shared", { skip: process.platform === "win32" }, () => {
  const dir = scratch()
  try {
    recordSessionSpawn("ses_a", { model: "claude-opus-5-5" })
    assert.equal(statSync(spawnRecordStorePath()).mode & 0o777, 0o600)
    assert.equal(statSync(join(dir, "state")).mode & 0o777, 0o700)
  } finally {
    _setSpawnRecordStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("nothing but a model, an effort, an account and a time is ever written", () => {
  const dir = scratch()
  try {
    recordSessionSpawn("ses_a", { model: "claude-opus-5-5", account: "alpha", ...({ prompt: "secret", cwd: "/x" } as object) } as any)
    const record = onDisk().sessions.ses_a
    assert.deepEqual(Object.keys(record).sort(), ["account", "at", "model"])
  } finally {
    _setSpawnRecordStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a second writer's sessions survive a write, and the store is bounded", () => {
  const dir = scratch()
  try {
    const now = Date.now()
    mkdirSync(join(dir, "state"), { recursive: true })
    const sessions: Record<string, unknown> = {
      ses_other: { model: "claude-haiku-4-5", at: now - 10 },
      ses_ancient: { model: "claude-haiku-4-5", at: now - SPAWN_RECORD_MAX_AGE_MS - 1 },
      ses_junk: { model: 42, at: now },
    }
    writeFileSync(spawnRecordStorePath(), JSON.stringify({ version: 1, sessions }))
    recordSessionSpawn("ses_mine", { model: "claude-opus-5-5" }, now)
    assert.deepEqual(Object.keys(onDisk().sessions).sort(), ["ses_mine", "ses_other"])

    for (let index = 0; index < MAX_SPAWN_RECORDS + 5; index++) {
      recordSessionSpawn(`ses_${index}`, { model: "claude-opus-5-5" }, now + index + 1)
    }
    const kept = Object.keys(onDisk().sessions)
    assert.equal(kept.length, MAX_SPAWN_RECORDS)
    assert.ok(kept.includes(`ses_${MAX_SPAWN_RECORDS + 4}`), "the newest is kept")
    assert.ok(!kept.includes("ses_other"), "the oldest went first")
  } finally {
    _setSpawnRecordStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the reader re-parses only a changed file and treats a broken one as empty", () => {
  const dir = scratch()
  try {
    const reader = createSpawnRecordReader()
    assert.equal(reader.read().size, 0, "no file yet")
    recordSessionSpawn("ses_a", { model: "claude-opus-5-5", effort: "low" })
    const first = reader.read()
    assert.equal(first.get("ses_a")?.effort, "low")
    assert.equal(reader.read(), first, "an unchanged file returns the same map")

    writeFileSync(spawnRecordStorePath(), "{ half written")
    assert.equal(reader.read().size, 0)
  } finally {
    _setSpawnRecordStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

// The fake CLI is a shebang script made executable with chmod, which means
// nothing on Windows (see .github/windows-skipped-tests.txt).
test("a real turn records the model and effort it spawned, not the ones it was asked for", { skip: process.platform === "win32" }, async () => {
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
const session_id = "fake-spawn-record"
const emit = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
require("node:readline").createInterface({ input: process.stdin }).on("line", () => {
  emit({ type: "system", subtype: "init", session_id })
  emit({ type: "assistant", session_id, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } })
  emit({ type: "result", subtype: "success", session_id, is_error: false, usage: { input_tokens: 1, output_tokens: 1 } })
})
`,
  )
  chmodSync(cliPath, 0o755)
  process.env.HOME = dir
  process.env.XDG_STATE_HOME = join(dir, "xdg-state")
  const modelId = "claude-sonnet-5-5"
  const affinity = "ses_spawn_record"
  try {
    const model = createClaudeCode({
      cliPath,
      cwd,
      bridgeOpencodeMcp: false,
      bridgeOpencodeSkills: false,
      proxyTools: [],
      autoContinueIncompleteTurns: false,
    }).languageModel(modelId)
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      // A tool set, or the turn is a title request and never spawns.
      tools: [{ type: "function", name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
      headers: { "x-session-affinity": affinity },
      providerOptions: { "claude-code": { reasoningEffort: "high" } },
    } as never)
    for await (const _part of (result as { stream: AsyncIterable<unknown> }).stream) {
      // drain
    }
    assert.equal(
      snapshotActiveProcesses().filter((active) => active.sessionKey.includes(affinity)).length,
      1,
      "the turn spawned exactly one process",
    )
    const record = onDisk().sessions[affinity]
    assert.equal(record.model, modelId)
    assert.equal(record.effort, "high")
    assert.equal(record.account, undefined, "a single-account install names no account")
  } finally {
    // Only this test's own process: other files' processes are not ours to end.
    for (const active of snapshotActiveProcesses()) {
      if (active.sessionKey.includes(affinity)) await deleteActiveProcessAndWait(active.sessionKey)
    }
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedState === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = savedState
    _setSpawnRecordStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
