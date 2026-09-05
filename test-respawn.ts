/**
 * Regressions for the reused-process respawn path in src/session-manager.ts.
 *
 * These cover the pure helpers (`appendResumeIfNeeded`) and the
 * undefined-when-no-active-process branch of `respawnActiveProcess`, plus
 * real Node fixtures that check the respawned child's launch configuration.
 *
 * Usage:
 *   npx tsx --test test-respawn.ts
 */
import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  appendResumeIfNeeded,
  deleteActiveProcessAndWait,
  getActiveProcess,
  getClaudeSessionId,
  respawnActiveProcess,
  setClaudeSessionId,
  deleteClaudeSessionId,
  spawnClaudeProcess,
  bufferUnattendedLine,
  takeUnattendedLines,
  type ActiveProcess,
} from "./src/session-manager.js"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"

test("unattended output is capped by line count and UTF-8 bytes, including oversized single lines", () => {
  const active: ActiveProcess = { proc: {} as ChildProcess, lineEmitter: new EventEmitter() }
  for (let index = 0; index < 501; index++) bufferUnattendedLine(active, String(index))
  assert.equal(active.unattendedLines?.length, 500)
  assert.equal(active.unattendedLines?.[0], "1")
  assert.equal(takeUnattendedLines(active).dropped, 1)
  bufferUnattendedLine(active, "\u00e9".repeat(1_100_000))
  assert.deepEqual(takeUnattendedLines(active), { lines: [], dropped: 1 })
  assert.deepEqual(takeUnattendedLines(active), { lines: [], dropped: 0 })
})

function createNodeFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-respawn-"))
  const cliPath = join(cwd, "fixture.cjs")
  const configPath = join(cwd, "mcp.json")
  const promptPath = join(cwd, "system.txt")
  writeFileSync(configPath, JSON.stringify({ mcpServers: { preserved: { marker: "original MCP config" } } }))
  writeFileSync(promptPath, "original appended system prompt")
  writeFileSync(cliPath, `
const fs = require("node:fs")
const readline = require("node:readline")
const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const envelope = JSON.parse(line)
  if (envelope.lines) {
    process.stdout.write(envelope.lines.join("\\n") + "\\n")
    return
  }
  process.stdout.write(JSON.stringify({
    args,
    envelope,
    cwd: process.cwd(),
    effort: process.env.CLAUDE_CODE_EFFORT_LEVEL,
    config: JSON.parse(fs.readFileSync(value("--mcp-config"), "utf8")),
    prompt: fs.readFileSync(value("--append-system-prompt-file"), "utf8"),
  }) + "\\n")
})
process.stdout.write("ready\\n")
`)
  const args = [
    cliPath,
    "--mcp-config", configPath,
    "--append-system-prompt-file", promptPath,
    "--model", "claude-haiku-4-5",
  ]
  return { cwd, args, configPath, promptPath }
}

test("appendResumeIfNeeded: no-op when no claude session id is known", () => {
  const sk = `sk-noid-${Date.now()}`
  deleteClaudeSessionId(sk)
  const args = ["--print", "--model", "claude-fable-5"]
  assert.deepEqual(appendResumeIfNeeded(sk, args), args)
})

test("appendResumeIfNeeded: appends --resume when a conversation id is known", () => {
  const sk = `sk-withid-${Date.now()}`
  setClaudeSessionId(sk, "claude-conv-123")
  try {
    const args = ["--print", "--model", "claude-fable-5"]
    assert.deepEqual(appendResumeIfNeeded(sk, args), [
      "--print",
      "--model",
      "claude-fable-5",
      "--resume",
      "claude-conv-123",
    ])
  } finally {
    deleteClaudeSessionId(sk)
  }
})

test("appendResumeIfNeeded: does not append when --session-id is already present", () => {
  const sk = `sk-hasarg-${Date.now()}`
  setClaudeSessionId(sk, "claude-conv-456")
  try {
    const args = ["--print", "--session-id", "claude-conv-already"]
    assert.deepEqual(appendResumeIfNeeded(sk, args), args)
  } finally {
    deleteClaudeSessionId(sk)
  }
})

test("appendResumeIfNeeded: does not append when --resume is already present", () => {
  const sk = `sk-hasresume-${Date.now()}`
  setClaudeSessionId(sk, "claude-conv-457")
  try {
    const args = ["--print", "--resume", "claude-conv-already"]
    assert.deepEqual(appendResumeIfNeeded(sk, args), args)
  } finally {
    deleteClaudeSessionId(sk)
  }
})

test("appendResumeIfNeeded: does not mutate the input array", () => {
  const sk = `sk-immutable-${Date.now()}`
  setClaudeSessionId(sk, "claude-conv-789")
  try {
    const args = ["--print"]
    const snapshot = [...args]
    appendResumeIfNeeded(sk, args)
    assert.deepEqual(args, snapshot)
  } finally {
    deleteClaudeSessionId(sk)
  }
})

test("respawnActiveProcess: returns undefined when no active process exists for the key", () => {
  const sk = `sk-empty-${Date.now()}`
  // No setActiveProcess(spawnClaudeProcess(...)) was done for this key, so
  // there is nothing to respawn; the watchdog treats this as "give up".
  assert.equal(
    respawnActiveProcess(sk, "/usr/bin/env", ["--print"], process.cwd()),
    undefined,
  )
})

test("respawn preserves the original CLI args, config and prompt on a real child", {
  timeout: 10_000,
}, async () => {
  const fixture = createNodeFixture()
  const sk = `respawn-${fixture.cwd}`
  const original = spawnClaudeProcess(
    process.execPath,
    fixture.args,
    fixture.cwd,
    sk,
    undefined,
    "original-mcp-hash",
    fixture.promptPath,
    false,
    "high",
  )
  try {
    assert.deepEqual(
      await once(original.lineEmitter, "line", { signal: AbortSignal.timeout(5_000) }),
      ["ready"],
    )
    assert.deepEqual(original.cliArgs, fixture.args)
    const completions: NonNullable<ActiveProcess["pendingProxyCompletions"]> = new Map([
      ["pending-task", {
        call: { sessionKey: sk, toolCallId: "pending-task", toolName: "task", input: {}, channel: { closed: false } },
        result: { kind: "text", text: "completed once" },
        recoveryRequired: false,
      }],
    ])
    original.pendingProxyCompletions = completions
    setClaudeSessionId(sk, "existing-fixture-session")
    const originalExit = once(original.proc, "close", { signal: AbortSignal.timeout(5_000) })
    // A reattached doStream turn has no freshly built args. Respawn must use
    // the original process's args, not launch Node (or Claude) with just resume.
    const replacement = respawnActiveProcess(sk, process.execPath, [], fixture.cwd)
    assert.ok(replacement)
    assert.equal(replacement.pendingProxyCompletions, completions)
    assert.equal(original.pendingProxyCompletions, undefined)
    assert.notEqual(replacement.proc.pid, original.proc.pid)
    assert.deepEqual(
      await once(replacement.lineEmitter, "line", { signal: AbortSignal.timeout(5_000) }),
      ["ready"],
    )
    await originalExit

    const envelope = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "The task completed; continue from its result." }] },
    }
    const reply = once(replacement.lineEmitter, "line", { signal: AbortSignal.timeout(5_000) })
    replacement.proc.stdin!.write(JSON.stringify(envelope) + "\n")
    const [line] = await reply
    const received = JSON.parse(line)
    assert.deepEqual(received.args, [...fixture.args.slice(1), "--resume", "existing-fixture-session"])
    assert.deepEqual(received.envelope, envelope)
    assert.deepEqual(received.config, JSON.parse(readFileSync(fixture.configPath, "utf8")))
    assert.equal(received.prompt, "original appended system prompt")
    assert.equal(received.effort, "high")
    assert.equal(replacement.mcpHash, "original-mcp-hash")
    assert.equal(replacement.systemPromptFile, fixture.promptPath)
    assert.equal(getClaudeSessionId(sk), "existing-fixture-session")
    assert.equal(getActiveProcess(sk), replacement)
    assert.deepEqual(replacement.cliArgs, [...fixture.args, "--resume", "existing-fixture-session"])
  } finally {
    await deleteActiveProcessAndWait(sk)
    deleteClaudeSessionId(sk)
    rmSync(fixture.cwd, { recursive: true, force: true })
  }
})
