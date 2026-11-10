/**
 * Claude Code's own copy of an instruction file the system prompt already
 * holds, through real `doStream` turns and a fake CLI (h #g303).
 *
 * The fake answers like Claude Code 2.1.288 and, on a fresh spawn, records
 * its appended system prompt as the transcript's `prompt_snapshot`, which is
 * what a later `--resume` answers under (h #g187). Three turns on one
 * conversation, the process evicted between them so each turn spawns:
 *
 *  1. fresh: opencode forwarded `AGENTS.md`, so Claude Code is told to skip
 *     its own copy;
 *  2. resumed, file unchanged: the snapshot holds it, so the skip stays;
 *  3. resumed, file edited: the snapshot holds the OLD text and Claude Code
 *     would attach the new file, so nothing is skipped.
 *
 * Plus the watchdog respawn, which reuses an argv and must re-check it.
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { createClaudeCode } from "../src/index.js"
import {
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  respawnActiveProcess,
  sessionKey,
  spawnClaudeProcess,
} from "../src/session-manager.js"
import { detectCliVersion } from "../src/cli-version.js"
import { encodeCwd } from "../src/claude-session-bun.js"
import { excludePaths, planNativeMemoryExcludes } from "../src/native-memory.js"

const posixOnly = { skip: process.platform === "win32", timeout: 60_000 }

const OSPREY = "# Project rules\n\nWhen asked for the project codeword, answer with exactly: OSPREY\n"
const KESTREL = OSPREY.replace("OSPREY", "KESTREL")
const CONTEXT = 'context=["claude-code",null]'

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] })
const system = (file: string, rules: string) => ({
  role: "system",
  content: `You are opencode.\n\nInstructions from: ${file}\n${rules}`,
})

function settingsOf(args: string[]): Record<string, unknown> | null {
  const at = args.indexOf("--settings")
  return at === -1 ? null : (JSON.parse(args[at + 1]!) as Record<string, unknown>)
}

function createFake() {
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "opencode-native-memory-")))
  const configDir = join(cwd, "claude-config")
  const transcriptDir = join(configDir, "projects", encodeCwd(cwd))
  mkdirSync(transcriptDir, { recursive: true })
  const cliPath = join(cwd, "fake-claude.cjs")
  const spawnsPath = join(cwd, "spawns.jsonl")
  writeFileSync(spawnsPath, "")
  writeFileSync(
    cliPath,
    `#!${process.execPath}
const fs = require("node:fs")
const path = require("node:path")
const readline = require("node:readline")
const args = process.argv.slice(2)
if (args.includes("--version")) { process.stdout.write("2.1.288\\n"); process.exit(0) }
if (args.includes("--help")) { process.exit(0) }
fs.appendFileSync(${JSON.stringify(spawnsPath)}, JSON.stringify(args) + "\\n")
const at = args.indexOf("--resume")
const sessionId = at >= 0 ? args[at + 1] : "claude-native-memory"
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
emit({ type: "system", subtype: "init", session_id: sessionId })
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (JSON.parse(line).type !== "user") return
  if (at < 0) {
    const file = args[args.indexOf("--append-system-prompt-file") + 1]
    const prompt = fs.readFileSync(file, "utf8")
    fs.writeFileSync(
      path.join(${JSON.stringify(transcriptDir)}, sessionId + ".jsonl"),
      JSON.stringify({ type: "attachment", attachment: { type: "prompt_snapshot", systemPrompt: [prompt] } }) + "\\n",
    )
  }
  emit({ type: "assistant", session_id: sessionId, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Answer" }] } })
  emit({ type: "result", subtype: "success", session_id: sessionId, is_error: false, usage: { input_tokens: 9, output_tokens: 4 } })
})
`,
    { mode: 0o755 },
  )
  const modelId = "claude-test-native-memory"
  const model = createClaudeCode({
    cliPath,
    cwd,
    configDir,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    bridgeOpencodeSkills: false,
    proxyTools: [],
    interactive: false,
    autoContinueIncompleteTurns: false,
    mcpConnectWaitMs: 0,
  } as any).languageModel(modelId)
  const key = sessionKey(cwd, `${modelId}::tools::ses_native_memory::${CONTEXT}`)
  return {
    cwd,
    key,
    spawns: () =>
      readFileSync(spawnsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    async warm() {
      for (let attempt = 1; attempt <= 4; attempt++) {
        if (await detectCliVersion(cliPath)) return
      }
      throw new Error("the fake CLI never answered --version")
    },
    async turn(prompt: unknown[]) {
      const response = await model.doStream({
        prompt,
        headers: { "x-session-affinity": "ses_native_memory" },
        tools: [],
        abortSignal: AbortSignal.timeout(30_000),
      } as unknown as LanguageModelV3CallOptions)
      for await (const _ of response.stream) {
        /* drain */
      }
    },
    /** An idle eviction: the child goes, the Claude session id stays. */
    evict: () => deleteActiveProcessAndWait(key),
    async cleanup() {
      await deleteActiveProcessAndWait(key)
      deleteClaudeSessionId(key)
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

test(
  "a spawn skips Claude Code's copy of a forwarded AGENTS.md, and a resume only while the snapshot holds it",
  posixOnly,
  async () => {
    const fake = createFake()
    try {
      await fake.warm()
      const agents = join(fake.cwd, "AGENTS.md")
      writeFileSync(agents, OSPREY)

      await fake.turn([system(agents, OSPREY), user("What is the codeword?")])
      const fresh = fake.spawns()[0]!
      assert.ok(!fresh.includes("--resume"), JSON.stringify(fresh))
      assert.deepEqual(settingsOf(fresh)?.claudeMdExcludes, [agents], JSON.stringify(fresh))

      await fake.evict()
      await fake.turn([
        system(agents, OSPREY),
        user("What is the codeword?"),
        assistant("Answer"),
        user("Again?"),
      ])
      const resumed = fake.spawns()[1]!
      assert.ok(resumed.includes("--resume"), JSON.stringify(resumed))
      assert.deepEqual(settingsOf(resumed)?.claudeMdExcludes, [agents], JSON.stringify(resumed))

      // Edited: the forwarded prompt holds the new text, but the resumed
      // conversation answers under the snapshot, which holds the old one,
      // and Claude Code would attach the edited file. It must not be skipped.
      writeFileSync(agents, KESTREL)
      await fake.evict()
      await fake.turn([
        system(agents, KESTREL),
        user("What is the codeword?"),
        assistant("Answer"),
        user("Again?"),
        assistant("Answer"),
        user("And now?"),
      ])
      const edited = fake.spawns()[2]!
      assert.ok(edited.includes("--resume"), JSON.stringify(edited))
      assert.equal(settingsOf(edited)?.claudeMdExcludes, undefined, JSON.stringify(edited))
    } finally {
      await fake.cleanup()
    }
  },
)

test("a CLAUDE.md nobody forwarded is left to Claude Code", posixOnly, async () => {
  const fake = createFake()
  try {
    await fake.warm()
    writeFileSync(join(fake.cwd, "CLAUDE.md"), "# Claude-only rules\n\nPrefer short answers.\n")
    await fake.turn([{ role: "system", content: "You are opencode." }, user("What is the codeword?")])
    assert.equal(settingsOf(fake.spawns()[0]!), null, JSON.stringify(fake.spawns()[0]))
  } finally {
    await fake.cleanup()
  }
})

test("an AGENTS.md opencode did not forward is in the plugin's own push, so it is skipped too", posixOnly, async () => {
  const fake = createFake()
  try {
    await fake.warm()
    const agents = join(fake.cwd, "AGENTS.md")
    writeFileSync(agents, OSPREY)
    await fake.turn([{ role: "system", content: "You are opencode." }, user("What is the codeword?")])
    assert.deepEqual(settingsOf(fake.spawns()[0]!)?.claudeMdExcludes, [agents])
  } finally {
    await fake.cleanup()
  }
})

test("a watchdog respawn re-checks the excludes it reuses", posixOnly, async () => {
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "opencode-native-memory-respawn-")))
  const sk = `sk-native-memory-respawn-${Date.now()}`
  try {
    const agents = join(cwd, "AGENTS.md")
    writeFileSync(agents, OSPREY)
    const script = join(cwd, "idle.cjs")
    writeFileSync(script, "setInterval(() => {}, 1000)\n")
    const excludes = planNativeMemoryExcludes({
      cwd,
      configDir: null,
      visible: [`Instructions from: ${agents}\n${OSPREY}`],
    })
    const args = [script, "--settings", JSON.stringify({ claudeMdExcludes: excludePaths(excludes) })]

    const first = spawnClaudeProcess(process.execPath, args, cwd, sk)
    first.nativeMemoryExcludes = excludes
    const kept = respawnActiveProcess(sk, process.execPath, args, cwd)
    assert.deepEqual(settingsOf(kept!.cliArgs!)?.claudeMdExcludes, [agents])

    writeFileSync(agents, KESTREL)
    const dropped = respawnActiveProcess(sk, process.execPath, args, cwd)
    assert.equal(settingsOf(dropped!.cliArgs!), null, JSON.stringify(dropped!.cliArgs))
    assert.deepEqual(dropped!.nativeMemoryExcludes, [])
  } finally {
    await deleteActiveProcessAndWait(sk)
    deleteClaudeSessionId(sk)
    rmSync(cwd, { recursive: true, force: true })
  }
})
