/**
 * `maxBudgetUsd`, `maxTurns` and `maxBudgetUsd` on an agent, through a fake
 * `claude` and a real `doStream` (h #g245).
 *
 * The fake reports a CUMULATIVE `total_cost_usd` on every result, the shape a
 * headless `claude` really has (measured on 2.1.293), and logs every spawn's
 * argv and every message it is sent, so "the turn ended before anything was
 * spawned or sent" is read off the fake rather than inferred.
 *
 * Usage: npx tsx --test test/budget.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClaudeCode } from "../src/index.js"
import { _resetAgentRegistryForTests, setAgentRegistry } from "../src/agent-models.js"
import { BUDGET_MARKER, _resetBudgetLedgerForTests } from "../src/budget-ledger.js"
import { setOpencodeClient } from "../src/runtime-status.js"
import { getActiveProcess, killAllActiveProcesses, sessionKey } from "../src/session-manager.js"
import { _clearCache } from "../src/cli-version.js"

const MODEL_ID = "claude-test-budget"

afterEach(() => {
  killAllActiveProcesses()
  _resetBudgetLedgerForTests()
  _resetAgentRegistryForTests()
  // `setOpencodeClient` ignores null; a client with no routes is "no client".
  setOpencodeClient({} as any)
})

/**
 * A fake `claude` answering message N with a result whose `total_cost_usd` is
 * `totals[N]`: the Claude session's running total, as the CLI reports it.
 */
function createFakeCli(totals: number[]) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-budget-"))
  const cliPath = join(dir, "fake-claude.cjs")
  const spawnLog = join(dir, "spawns.log")
  const messageLog = join(dir, "messages.log")
  const source = `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.293\\n")
  process.exit(0)
}
if (process.argv.includes("--help")) {
  process.stdout.write("  --max-turns <n>\\n  --max-budget-usd <amount>\\n")
  process.exit(0)
}
fs.appendFileSync(${JSON.stringify(spawnLog)}, JSON.stringify(process.argv.slice(2)) + "\\n")
const TOTALS = ${JSON.stringify(totals)}
// Unique per fake, as a real Claude session id is: the ledger keys the
// running total by it.
const SESSION = ${JSON.stringify(`claude-${dir.split("-").pop()}`)}
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
let index = 0
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let parsed
  try { parsed = JSON.parse(line) } catch { return }
  if (parsed.type !== "user") return
  fs.appendFileSync(${JSON.stringify(messageLog)}, "message\\n")
  const total = TOTALS[Math.min(index, TOTALS.length - 1)]
  index++
  emit({ type: "system", subtype: "init", session_id: SESSION })
  emit({
    type: "assistant",
    session_id: SESSION,
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "answer " + index }] },
  })
  emit({
    type: "result",
    subtype: "success",
    session_id: SESSION,
    is_error: false,
    num_turns: 1,
    total_cost_usd: total,
    usage: { input_tokens: 10, output_tokens: 5 },
  })
})
`
  writeFileSync(cliPath, source)
  chmodSync(cliPath, 0o755)
  const lines = (path: string) =>
    existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []
  return {
    cliPath,
    cwd: dir,
    spawns: () => lines(spawnLog).map((line) => JSON.parse(line) as string[]),
    messages: () => lines(messageLog).length,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

type Fake = ReturnType<typeof createFakeCli>

/** A conversation of `turns` user messages, so every turn after the first continues it. */
function conversation(turns: number) {
  const prompt: any[] = []
  for (let index = 1; index <= turns; index++) {
    prompt.push({ role: "user", content: [{ type: "text", text: `message ${index}` }] })
    if (index < turns) {
      prompt.push({ role: "assistant", content: [{ type: "text", text: `answer ${index}` }] })
    }
  }
  return prompt
}

const TOOLS = [
  {
    type: "function",
    name: "read",
    description: "Read a file",
    inputSchema: { type: "object", properties: {} },
  },
]

function model(fake: Fake, settings: Record<string, unknown> = {}) {
  return createClaudeCode({
    cliPath: fake.cliPath,
    cwd: fake.cwd,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    maxBudgetUsd: 1,
    ...settings,
  }).languageModel(MODEL_ID)
}

async function turn(
  fake: Fake,
  affinity: string,
  turns: number,
  extra: Record<string, unknown> = {},
  settings: Record<string, unknown> = {},
) {
  const response = await model(fake, settings).doStream({
    prompt: conversation(turns),
    headers: { "x-session-affinity": affinity },
    tools: TOOLS,
    ...extra,
  } as any)
  const parts: any[] = []
  for await (const part of response.stream) parts.push(part)
  return parts
}

const textOf = (parts: any[]) =>
  parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
const notesIn = (parts: any[]) =>
  parts.filter((part) => part.type === "text-delta" && part.delta.startsWith(BUDGET_MARKER))
const finishOf = (parts: any[]) => parts.find((part) => part.type === "finish")

test("50%, then 80%, then the cap, then the next turn ends before anything is sent", async () => {
  const fake = createFakeCli([0.6, 0.85, 1.05, 1.2])
  try {
    const first = await turn(fake, "ses_budget", 1)
    assert.equal(notesIn(first).length, 1)
    assert.match(notesIn(first)[0].delta, /\$0\.6000, 50% of its \$1\.00/)
    assert.ok(textOf(first).includes("answer 1"))
    assert.equal(finishOf(first).finishReason.unified, "stop")

    const second = await turn(fake, "ses_budget", 2)
    assert.equal(notesIn(second).length, 1)
    assert.match(notesIn(second)[0].delta, /\$0\.8500, 80% of its/)

    const third = await turn(fake, "ses_budget", 3)
    assert.equal(notesIn(third).length, 1)
    assert.match(notesIn(third)[0].delta, /the next message will not start a turn/)
    assert.equal(fake.messages(), 3)

    const fourth = await turn(fake, "ses_budget", 4)
    assert.equal(fake.messages(), 3, "the stopped turn sent Claude nothing")
    assert.equal(fake.spawns().length, 1, "and spawned nothing")
    assert.equal(notesIn(fourth).length, 1)
    assert.match(notesIn(fourth)[0].delta, /\$1\.05 against its \$1\.00 `maxBudgetUsd`/)
    assert.deepEqual(finishOf(fourth).finishReason, { unified: "error", raw: "budget_exceeded" })
    assert.equal(textOf(fourth).includes("answer"), false)
  } finally {
    fake.cleanup()
  }
})

test("a reused process's cumulative totals are counted once, not summed", async () => {
  // 0.30 then 0.45: the second turn spent 0.15, so the conversation is at 45%
  // and no note is due. Summing raw totals would read 75% and write the 50 note.
  const fake = createFakeCli([0.3, 0.45])
  try {
    assert.equal(notesIn(await turn(fake, "ses_delta", 1)).length, 0)
    assert.equal(notesIn(await turn(fake, "ses_delta", 2)).length, 0)
  } finally {
    fake.cleanup()
  }
})

test("no maxBudgetUsd is no ledger, no note and no stop", async () => {
  const fake = createFakeCli([5, 10, 20])
  try {
    for (let index = 1; index <= 3; index++) {
      const parts = await turn(fake, "ses_off", index, {}, { maxBudgetUsd: undefined })
      assert.equal(notesIn(parts).length, 0)
      assert.equal(finishOf(parts).finishReason.unified, "stop")
    }
    assert.equal(fake.messages(), 3)
  } finally {
    fake.cleanup()
  }
})

test("a doGenerate turn over the cap gets the error finish and no note", async () => {
  const fake = createFakeCli([1.5])
  try {
    await turn(fake, "ses_generate", 1)
    const result: any = await model(fake).doGenerate({
      prompt: conversation(2),
      headers: { "x-session-affinity": "ses_generate" },
      tools: TOOLS,
    } as any)
    assert.deepEqual(result.finishReason, { unified: "error", raw: "budget_exceeded" })
    const body = (result.content ?? []).map((part: any) => part.text ?? "").join("")
    assert.equal(body.includes(BUDGET_MARKER), false)
    assert.equal(fake.messages(), 1)
  } finally {
    fake.cleanup()
  }
})

test("a doGenerate turn never writes a warn note into its return value", async () => {
  const fake = createFakeCli([0.6])
  try {
    const result: any = await model(fake).doGenerate({
      prompt: conversation(1),
      headers: { "x-session-affinity": "ses_generate_warn" },
      tools: TOOLS,
    } as any)
    const body = (result.content ?? []).map((part: any) => part.text ?? "").join("")
    assert.equal(body.includes(BUDGET_MARKER), false)
    assert.ok(body.includes("answer 1"))
  } finally {
    fake.cleanup()
  }
})

test("compaction still runs over the cap, so a summary is always possible", async () => {
  const fake = createFakeCli([1.5])
  try {
    await turn(fake, "ses_compact", 1)
    const parts = await turn(fake, "ses_compact", 2, {
      providerOptions: { "claude-code": { opencodeAgent: "compaction" } },
    })
    assert.equal(notesIn(parts).length, 0)
    assert.ok(textOf(parts).includes("answer"))
    assert.equal(fake.messages(), 2, "the compaction spawn was sent its prompt")
  } finally {
    fake.cleanup()
  }
})

test("a child's spend counts against its parent and a child never gets a note", async () => {
  setOpencodeClient({
    session: {
      get: async ({ path }: any) => ({
        data: { id: path.id, parentID: path.id === "ses_kid" ? "ses_root" : undefined },
      }),
    },
  } as any)
  const parent = createFakeCli([0.3])
  const child = createFakeCli([0.6, 0.9])
  try {
    assert.equal(notesIn(await turn(parent, "ses_root", 1)).length, 0)
    // 0.30 + 0.60: the conversation crossed 80%, but the child may not say so.
    const kid = await turn(child, "ses_kid", 1)
    assert.equal(notesIn(kid).length, 0)
    assert.ok(textOf(kid).includes("answer 1"))

    // Still under the cap at 0.90, so this turn runs and takes it to 1.20.
    assert.ok(textOf(await turn(child, "ses_kid", 2)).includes("answer 2"))

    // Over the cap: the child's next turn stops with an error part rather
    // than a note, so its parent's `task` result says why.
    const stopped = await turn(child, "ses_kid", 3)
    assert.equal(child.messages(), 2)
    assert.equal(textOf(stopped), "")
    const error = stopped.find((part) => part.type === "error")
    assert.match(String(error?.error?.message), /`maxBudgetUsd`/)
    assert.deepEqual(finishOf(stopped).finishReason, { unified: "error", raw: "budget_exceeded" })
  } finally {
    parent.cleanup()
    child.cleanup()
  }
})

test("an agent's maxTurns and maxBudgetUsd reach the argv and the session key", async () => {
  setAgentRegistry({
    explorer: { mode: "subagent", maxTurns: "4", maxBudgetUsd: "0.5" },
  })
  _clearCache()
  const fake = createFakeCli([0.01])
  try {
    await turn(fake, "ses_caps", 1, {
      providerOptions: { "claude-code": { opencodeAgent: "explorer" } },
    })
    const argv = fake.spawns()[0]!
    assert.deepEqual(argv.slice(argv.indexOf("--max-turns"), argv.indexOf("--max-turns") + 2), [
      "--max-turns",
      "4",
    ])
    assert.deepEqual(
      argv.slice(argv.indexOf("--max-budget-usd"), argv.indexOf("--max-budget-usd") + 2),
      ["--max-budget-usd", "0.5"],
    )
    const key = sessionKey(
      fake.cwd,
      `${MODEL_ID}::tools::ses_caps::context=${JSON.stringify([
        "claude-code",
        "explorer",
        "maxTurns=4",
        "maxBudgetUsd=0.5",
      ])}`,
    )
    assert.ok(getActiveProcess(key), "the caps are part of the session key")
  } finally {
    fake.cleanup()
  }
})

test("a main agent's maxBudgetUsd is refused, its maxTurns is kept", async () => {
  setAgentRegistry({ build: { mode: "primary", maxTurns: 8, maxBudgetUsd: 2 } })
  _clearCache()
  const fake = createFakeCli([0.01])
  try {
    await turn(fake, "ses_main", 1, {
      providerOptions: { "claude-code": { opencodeAgent: "build" } },
    })
    const argv = fake.spawns()[0]!
    assert.ok(argv.includes("--max-turns"))
    assert.equal(argv.includes("--max-budget-usd"), false)
  } finally {
    fake.cleanup()
  }
})

test("an agent with no caps spawns with neither flag and the key it always had", async () => {
  _clearCache()
  const fake = createFakeCli([0.01])
  try {
    await turn(fake, "ses_plain", 1, {}, { maxBudgetUsd: undefined })
    const argv = fake.spawns()[0]!
    assert.equal(argv.includes("--max-turns"), false)
    assert.equal(argv.includes("--max-budget-usd"), false)
    const key = sessionKey(
      fake.cwd,
      `${MODEL_ID}::tools::ses_plain::context=${JSON.stringify(["claude-code", null])}`,
    )
    assert.ok(getActiveProcess(key))
  } finally {
    fake.cleanup()
  }
})
