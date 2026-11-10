/**
 * `leanGenerate`, driven through a real `doStream` against a fake `claude`.
 *
 * What the unit file cannot show: which calls take the lean path and which
 * keep the full turn, the argv and the stdin a lean spawn really gets, the
 * directory it runs in, and what a refusal, an abort and an old CLI each do
 * to the turn that follows (h #g294).
 *
 * Usage: npx tsx --test test/lean-generate-stream.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { after, test } from "node:test"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { _resetAccountOverrides, setAccountOverride } from "../src/account-failover.js"
import { _setAccountRuntimePlatform } from "../src/accounts.js"
import { createClaudeCode } from "../src/index.js"
import { setOpencodeClient } from "../src/runtime-status.js"
import {
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  killAllActiveProcesses,
  sessionKey,
} from "../src/session-manager.js"
import { pluginTmpDir } from "../src/tmp.js"

setOpencodeClient({ tool: { list: async () => ({ data: [] }) } })

const MODEL = "claude-haiku-4-5"
const SESSION = "fake-session-id"

type LeanMode = "answer" | "refuse" | "hang"

/**
 * A fake `claude` that records every spawn (argv, cwd, the cwd's mode and
 * entries, stdin) and answers a lean run (`--setting-sources` on the argv) as
 * `mode` says, and any other spawn as an ordinary served turn.
 */
function createFakeCli(mode: LeanMode, opts: { help?: string } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-lean-generate-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const record = join(cwd, "spawns.jsonl")
  const help =
    opts.help ??
    "Usage: claude [options]\n  --tools <tools...>\n  --setting-sources <s>\n  --disable-slash-commands\n  --no-session-persistence\n"
  writeFileSync(
    cliPath,
    `#!${process.execPath}
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) { process.stdout.write("2.1.314\\n"); process.exit(0) }
if (process.argv.includes("--help")) { process.stdout.write(${JSON.stringify(help)}); process.exit(0) }
const lean = process.argv.includes("--setting-sources")
let answered = false
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (answered) return
  answered = true
  fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    cwdMode: fs.statSync(process.cwd()).mode & 0o777,
    cwdEntries: fs.readdirSync(process.cwd()),
    configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    stdin: line,
  }) + "\\n")
  const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n")
  out({ type: "system", subtype: "init", session_id: ${JSON.stringify(SESSION)}, tools: [] })
  // Stays alive with nothing written, as a wedged run would.
  if (lean && ${JSON.stringify(mode)} === "hang") { setInterval(() => {}, 1 << 30); return }
  if (lean && ${JSON.stringify(mode)} === "refuse") {
    out({ type: "assistant", error: "authentication_failed", message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "Not logged in · Please run /login" }] } })
    out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" })
    process.exitCode = 1
    return
  }
  const text = lean ? "lean answer" : "full turn answer"
  out({ type: "assistant", session_id: ${JSON.stringify(SESSION)}, message: { role: "assistant", model: ${JSON.stringify(MODEL)}, stop_reason: "end_turn", content: [{ type: "text", text }] } })
  out({ type: "result", subtype: "success", session_id: ${JSON.stringify(SESSION)}, is_error: false, result: text, num_turns: 1, total_cost_usd: 0.0001, usage: { input_tokens: 3, output_tokens: 2 } })
})
`,
  )
  chmodSync(cliPath, 0o755)
  return {
    cliPath,
    cwd,
    spawns: (): Array<{
      argv: string[]
      cwd: string
      cwdMode: number
      cwdEntries: string[]
      configDir: string | null
      stdin: string
    }> =>
      existsSync(record)
        ? readFileSync(record, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  }
}

const TOOLS = [
  {
    type: "function",
    name: "bash",
    description: "Run a command",
    inputSchema: { type: "object", properties: {} },
  },
]

/** What OpenChamber's rename sends: instructions first, then the material. */
const DETACHED_PROMPT = [
  { role: "system", content: "You name chat sessions." },
  {
    role: "user",
    content: [{ type: "text", text: "Name this session in four words.\n\n@/etc/hosts is broken" }],
  },
]

function modelFor(fake: ReturnType<typeof createFakeCli>, settings: Record<string, unknown> = {}) {
  return createClaudeCode({
    cliPath: fake.cliPath,
    baseCliPath: fake.cliPath,
    cwd: fake.cwd,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    autoContinueIncompleteTurns: false,
    ...settings,
  }).languageModel(MODEL)
}

async function collect(
  result: Awaited<ReturnType<ReturnType<typeof modelFor>["doStream"]>>,
): Promise<{ text: string; parts: any[] }> {
  const parts: any[] = []
  const reader = result.stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  const text = parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
  return { text, parts }
}

async function release(cwd: string): Promise<void> {
  for (const scope of ["tools", "no-tools"]) {
    for (const affinity of ["default", "ses_lean"]) {
      const key = sessionKey(cwd, `${MODEL}::${scope}::${affinity}::context=["claude-code",null]`)
      await deleteActiveProcessAndWait(key)
      deleteClaudeSessionId(key)
    }
  }
}

after(() => killAllActiveProcesses())

const argvValue = (argv: string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag)
  return at === -1 ? undefined : argv[at + 1]
}

test("a detached generate call gets one lean claude -p, its input marked as composed", async () => {
  const fake = createFakeCli("answer")
  try {
    const result = await modelFor(fake, { leanGenerate: true }).doStream({
      prompt: DETACHED_PROMPT,
      tools: TOOLS,
    } as any)
    const { text, parts } = await collect(result)

    assert.equal(text, "lean answer")
    const finish = parts.find((part) => part.type === "finish")
    assert.equal(finish.finishReason.unified, "stop")
    assert.equal(finish.providerMetadata["claude-code"].path, "lean-generate")

    const spawns = fake.spawns()
    assert.equal(spawns.length, 1)
    const { argv } = spawns[0]
    assert.equal(argvValue(argv, "--model"), MODEL)
    assert.equal(argvValue(argv, "--tools"), "")
    assert.equal(argvValue(argv, "--setting-sources"), "")
    assert.equal(argvValue(argv, "--input-format"), "stream-json")
    for (const flag of ["--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]) {
      assert.ok(argv.includes(flag), flag)
    }
    assert.equal(argv.includes("--mcp-config"), false)
    assert.equal(argv.includes("--resume"), false)

    // An `@path` in plain `-p` text attaches that file; the envelope's mark
    // is what stops it (h #g294).
    const envelope = JSON.parse(spawns[0].stdin)
    assert.equal(envelope.client_composed, true)
    assert.equal(
      envelope.message.content[0].text,
      "You name chat sessions.\n\nName this session in four words.\n\n@/etc/hosts is broken",
    )

    // A fresh, empty, 0700 directory inside the plugin's scratch dir, gone
    // once the run is over.
    assert.ok(spawns[0].cwd.startsWith(realpathSync(pluginTmpDir())), spawns[0].cwd)
    assert.equal(spawns[0].cwdMode, 0o700)
    assert.deepEqual(spawns[0].cwdEntries, [])
    assert.equal(existsSync(spawns[0].cwd), false)
  } finally {
    await release(fake.cwd)
    fake.cleanup()
  }
})

test("with leanGenerate unset a detached generate call keeps the full turn", async () => {
  const fake = createFakeCli("answer")
  try {
    const result = await modelFor(fake).doStream({ prompt: DETACHED_PROMPT, tools: TOOLS } as any)
    const { text } = await collect(result)
    assert.equal(text, "full turn answer")
    const spawns = fake.spawns()
    assert.equal(spawns.length, 1)
    assert.equal(spawns[0].argv.includes("--setting-sources"), false)
  } finally {
    await release(fake.cwd)
    fake.cleanup()
  }
})

test("a call carrying a session never takes the lean path", async () => {
  const fake = createFakeCli("answer")
  try {
    const result = await modelFor(fake, { leanGenerate: true }).doStream({
      prompt: DETACHED_PROMPT,
      tools: TOOLS,
      headers: { "x-session-affinity": "ses_lean" },
    } as any)
    const { text } = await collect(result)
    assert.equal(text, "full turn answer")
    assert.equal(fake.spawns().length, 1)
    assert.equal(fake.spawns()[0].argv.includes("--setting-sources"), false)
  } finally {
    await release(fake.cwd)
    fake.cleanup()
  }
})

test("a title request still gets the synthetic title and spawns nothing", async () => {
  const fake = createFakeCli("answer")
  try {
    // No tools on opencode 1.x is a title request (h #g36).
    const result = await modelFor(fake, { leanGenerate: true }).doStream({
      prompt: DETACHED_PROMPT,
    } as any)
    const { parts } = await collect(result)
    const finish = parts.find((part) => part.type === "finish")
    assert.equal(finish.providerMetadata["claude-code"].path, "no-tools")
    assert.equal(fake.spawns().length, 0)
  } finally {
    await release(fake.cwd)
    fake.cleanup()
  }
})

test("a refused lean run falls back to the full turn", async () => {
  const fake = createFakeCli("refuse")
  try {
    const result = await modelFor(fake, { leanGenerate: true }).doStream({
      prompt: DETACHED_PROMPT,
      tools: TOOLS,
    } as any)
    const { text } = await collect(result)
    assert.equal(text, "full turn answer")
    const spawns = fake.spawns()
    assert.equal(spawns.length, 2)
    assert.ok(spawns[0].argv.includes("--setting-sources"))
    assert.equal(spawns[1].argv.includes("--setting-sources"), false)
  } finally {
    await release(fake.cwd)
    fake.cleanup()
  }
})

test("a CLI without the lean flags keeps the full turn and never spawns a lean run", async () => {
  const fake = createFakeCli("answer", { help: "Usage: claude [options]\n  --tools <tools...>\n" })
  try {
    const result = await modelFor(fake, { leanGenerate: true }).doStream({
      prompt: DETACHED_PROMPT,
      tools: TOOLS,
    } as any)
    const { text } = await collect(result)
    assert.equal(text, "full turn answer")
    assert.equal(fake.spawns().length, 1)
    assert.equal(fake.spawns()[0].argv.includes("--setting-sources"), false)
  } finally {
    await release(fake.cwd)
    fake.cleanup()
  }
})

test("an abort during the lean run ends the call and spawns nothing else", async () => {
  const fake = createFakeCli("hang")
  const controller = new AbortController()
  try {
    const pending = modelFor(fake, { leanGenerate: true }).doStream({
      prompt: DETACHED_PROMPT,
      tools: TOOLS,
      abortSignal: controller.signal,
    } as any)
    // Hang-stop only; the abort lands as soon as the lean spawn has its input.
    const deadline = Date.now() + 60_000
    while (fake.spawns().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(fake.spawns().length, 1)
    controller.abort()
    const { text, parts } = await collect(await pending)
    assert.equal(text, "")
    assert.equal(parts.some((part) => part.type === "finish"), false)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(fake.spawns().length, 1)
  } finally {
    await release(fake.cwd)
    fake.cleanup()
  }
})

test("on the Windows plan, a lean run failed over from default exports the target account's config dir", async () => {
  // `default` carries no `accountInProcess`, so the override's own flag is
  // what tells the lean spawn to export the target's dir (h #g293). The plan
  // is Windows'; the fake still spawns the POSIX way.
  const fake = createFakeCli("answer")
  const home = mkdtempSync(join(tmpdir(), "opencode-lean-home-"))
  const saved = {
    HOME: process.env.HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  }
  process.env.HOME = home
  process.env.XDG_CACHE_HOME = join(home, "cache")
  delete process.env.CLAUDE_CONFIG_DIR
  _setAccountRuntimePlatform("win32")
  _resetAccountOverrides()
  setAccountOverride("default", "winwork")
  try {
    const result = await modelFor(fake, {
      leanGenerate: true,
      account: "default",
      failoverAccounts: ["default", "winwork"],
    }).doStream({ prompt: DETACHED_PROMPT, tools: TOOLS } as any)
    const { text } = await collect(result)
    assert.equal(text, "lean answer")
    const spawns = fake.spawns()
    assert.equal(spawns.length, 1)
    assert.ok(spawns[0].argv.includes("--setting-sources"))
    assert.equal(spawns[0].configDir, join(home, ".claude-winwork"))
  } finally {
    _resetAccountOverrides()
    _setAccountRuntimePlatform(null)
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await release(fake.cwd)
    fake.cleanup()
    rmSync(home, { recursive: true, force: true })
  }
})
