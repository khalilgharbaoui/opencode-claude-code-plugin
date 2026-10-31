/**
 * A per-call subagent model on opencode 2, through a real `doStream` and a fake
 * `claude` (h #g254): what the child's own spawn runs as once the parent named
 * a model for it, what the `accountGroups` guard refuses, and what the subagent
 * dispatch form leaves alone.
 *
 * The parent's fake CLI makes one proxied call, given in FAKE_CLI_TOOL_CALL;
 * every spawn records its argv, `CLAUDE_CODE_EFFORT_LEVEL` and, when it made a
 * call, the proxy's answer.
 *
 * Usage: npx tsx --test test/task-model-stream.test.ts
 */
import "./isolate.js"
import { after, beforeEach, test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClaudeCode } from "../src/index.js"
import { _resetAgentRegistryForTests, setAgentRegistry } from "../src/agent-models.js"
import { rejectAllPendingProxyCallsForSession } from "../src/proxy-broker.js"
import { setOpencodeClient } from "../src/runtime-status.js"
import { killAllActiveProcesses, listClaudeSessionKeys } from "../src/session-manager.js"
import { _resetSubagentDispatchForTests, SUBAGENT_DISPATCH_TOOL_CALL_PREFIX } from "../src/subagent-dispatch.js"
import { _resetTaskModelForTests } from "../src/task-model.js"

const HOME = mkdtempSync(join(tmpdir(), "opencode-task-model-home-"))
const originalHome = process.env.HOME
const originalCache = process.env.XDG_CACHE_HOME
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.HOME = HOME
process.env.XDG_CACHE_HOME = join(HOME, "cache")
delete process.env.CLAUDE_CONFIG_DIR

after(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalCache === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = originalCache
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  killAllActiveProcesses()
  rmSync(HOME, { recursive: true, force: true })
})

const PARENT = "ses_parent"
const PARENT_MODEL = "claude-haiku-4-5"
const PARSER = "PARSER: build the parser."
const SCREEN = "SCREEN: draw the screen."
/** What opencode 2's own `subagent` tool sends a child (h #g229). */
const wrapped = (prompt: string) => `You are a subagent spawned by another session.\n${prompt}`

setOpencodeClient({
  tool: {
    list: async () => ({ data: [{ id: "question", description: "", parameters: {} }] }),
  },
  session: {
    get: async ({ path }: any) => ({ data: path.id === PARENT ? {} : { parentID: PARENT } }),
  },
})

beforeEach(() => {
  _resetTaskModelForTests()
  _resetSubagentDispatchForTests()
  _resetAgentRegistryForTests()
  // An agent that rewrites both the model and the effort of every turn it runs.
  setAgentRegistry({
    implementor: { mode: "subagent", forceModel: "claude-sonnet-5-5", reasoningEffort: "low" },
  })
})

function createFakeCli() {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-task-model-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const record = join(cwd, "spawns.jsonl")
  const source = `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.293 (Claude Code)\\n")
  process.exit(0)
}
const args = process.argv.slice(2)
let proxyUrl
let proxyHeaders = {}
const configIndex = args.indexOf("--mcp-config")
if (configIndex >= 0) {
  for (let i = configIndex + 1; i < args.length; i++) {
    if (args[i].startsWith("--")) break
    try {
      const entry = JSON.parse(fs.readFileSync(args[i], "utf8")).mcpServers?.opencode_proxy
      proxyUrl = entry?.url ?? proxyUrl
      proxyHeaders = entry?.headers ?? proxyHeaders
    } catch {}
  }
}
const call = process.env.FAKE_CLI_TOOL_CALL
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
const rl = readline.createInterface({ input: process.stdin })
let answered = false
rl.on("line", async (line) => {
  if (answered) return
  answered = true
  const write = (entry) => fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(entry) + "\\n")
  // Written at once, so a spawn's record never waits behind its own call.
  // \`--effort\` where the spawn can switch live (h #g278), the env var otherwise.
  const effort = (args.includes("--effort") ? args[args.indexOf("--effort") + 1] : process.env.CLAUDE_CODE_EFFORT_LEVEL) ?? null
  write({ kind: "spawn", argv: args, effort, stdin: line })
  emit({ type: "system", subtype: "init", session_id: "fake-session" })
  if (call && proxyUrl) {
    // Bounded: an accepted call stays parked in the broker until opencode
    // resolves it, which this test never does; a refused one answers at once.
    const answer = fetch(proxyUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...proxyHeaders },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: JSON.parse(call) }),
    }).then((res) => res.text()).catch((err) => String(err))
    const settled = await Promise.race([answer, new Promise((resolve) => setTimeout(() => resolve(null), 1500))])
    write({ kind: "answer", answer: settled })
  }
  emit({
    type: "assistant",
    session_id: "fake-session",
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] },
  })
  emit({
    type: "result",
    subtype: "success",
    session_id: "fake-session",
    duration_ms: 1,
    num_turns: 1,
    is_error: false,
    usage: { input_tokens: 1, output_tokens: 1 },
  })
})
`
  writeFileSync(cliPath, source)
  chmodSync(cliPath, 0o755)
  const records = (kind: string): any[] =>
    existsSync(record)
      ? readFileSync(record, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((entry) => entry.kind === kind)
      : []
  return {
    cliPath,
    cwd,
    spawns: () => records("spawn"),
    answers: () => records("answer"),
  }
}

async function drain(response: any): Promise<any[]> {
  const parts: any[] = []
  for await (const part of response.stream) parts.push(part)
  return parts
}

function provider(fake: ReturnType<typeof createFakeCli>, settings: Record<string, unknown> = {}) {
  return createClaudeCode({
    cliPath: fake.cliPath,
    baseCliPath: fake.cliPath,
    cwd: fake.cwd,
    hostApi: "v2",
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: ["Task"],
    ...settings,
  })
}

async function runParent(
  fake: ReturnType<typeof createFakeCli>,
  call: { name: string; arguments: Record<string, unknown> },
  settings: Record<string, unknown> = {},
): Promise<any[]> {
  process.env.FAKE_CLI_TOOL_CALL = JSON.stringify(call)
  try {
    return await drain(
      await provider(fake, settings).languageModel(PARENT_MODEL).doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
        providerOptions: { "claude-code": { opencodeSessionID: PARENT } },
        // opencode 2's own subagent tool, which the proxied `task` becomes.
        tools: [{ type: "function", name: "subagent", description: "Delegate", inputSchema: { type: "object", properties: {} } }],
      } as any),
    )
  } finally {
    delete process.env.FAKE_CLI_TOOL_CALL
  }
}

/**
 * A child session's turn, on the model opencode created it with. Its spawn is
 * found by the newest message it was sent, because the parent's fake is still
 * running beside it and records on its own clock.
 */
async function runChild(
  fake: ReturnType<typeof createFakeCli>,
  input: { session: string; model: string; prompt: any[]; effort?: string },
): Promise<{ model: string | undefined; effort: string | null }> {
  // The last line only: it is plain text, so it reads the same inside the
  // JSON envelope the spawn received.
  const marker = String(input.prompt.at(-1).content[0].text).split("\n").at(-1)!
  await drain(
    await provider(fake).languageModel(input.model).doStream({
      prompt: input.prompt,
      providerOptions: {
        "claude-code": {
          opencodeSessionID: input.session,
          opencodeAgent: "implementor",
          ...(input.effort ? { reasoningEffort: input.effort } : {}),
        },
      },
      tools: [],
    } as any),
  )
  const spawn = fake.spawns().filter((entry) => String(entry.stdin).includes(marker)).at(-1)
  assert.ok(spawn, `no spawn received "${marker}"`)
  const at = spawn.argv.indexOf("--model")
  return { model: at === -1 ? undefined : spawn.argv[at + 1], effort: spawn.effort }
}

function cleanup(fake: ReturnType<typeof createFakeCli>) {
  for (const key of listClaudeSessionKeys()) {
    rejectAllPendingProxyCallsForSession(key, new Error("test cleanup"))
  }
  killAllActiveProcesses()
  rmSync(fake.cwd, { recursive: true, force: true })
}

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })

test("an explicit model and variant beat the agent's forceModel and reasoningEffort; its sibling keeps them", { timeout: 30_000 }, async () => {
  const fake = createFakeCli()
  try {
    const parent = await runParent(fake, {
      name: "task_batch",
      arguments: {
        tasks: [
          { description: "parser", prompt: PARSER, subagent_type: "implementor", model: "claude-code/claude-opus-5-5#high" },
          { description: "screen", prompt: SCREEN, subagent_type: "implementor" },
        ],
      },
    })
    const calls = parent.filter((part) => part.type === "tool-call").map((part) => JSON.parse(part.input))
    assert.deepEqual(calls.map((input) => input.model ?? null), ["claude-code/claude-opus-5-5#high", null])

    // opencode creates the first child on the model it was asked for, with the
    // variant's effort; the second inherits the parent's model.
    assert.deepEqual(
      await runChild(fake, { session: "ses_parser", model: "claude-opus-5-5", prompt: [user(wrapped(PARSER))], effort: "high" }),
      { model: "claude-opus-5-5", effort: "high" },
    )
    assert.deepEqual(
      await runChild(fake, { session: "ses_screen", model: PARENT_MODEL, prompt: [user(wrapped(SCREEN))] }),
      { model: "claude-sonnet-5-5", effort: "low" },
      "the task that named nothing is rewritten exactly as before",
    )
  } finally {
    cleanup(fake)
  }
})

test("a request opencode did not honour changes nothing in the child", { timeout: 30_000 }, async () => {
  const fake = createFakeCli()
  try {
    await runParent(fake, {
      name: "task",
      arguments: { description: "parser", prompt: PARSER, subagent_type: "implementor", model: "claude-code/claude-opus-5-5" },
    })
    assert.deepEqual(
      await runChild(fake, { session: "ses_parser", model: PARENT_MODEL, prompt: [user(wrapped(PARSER))] }),
      { model: "claude-sonnet-5-5", effort: "low" },
    )
  } finally {
    cleanup(fake)
  }
})

test("a resumed child named with a model keeps it; with no variant the agent's effort still applies", { timeout: 30_000 }, async () => {
  const fake = createFakeCli()
  try {
    await runParent(fake, {
      name: "task",
      arguments: {
        description: "again",
        prompt: "Carry on.",
        subagent_type: "implementor",
        task_id: "ses_resumed",
        model: "claude-code/claude-opus-5-5",
      },
    })
    assert.deepEqual(
      await runChild(fake, {
        session: "ses_resumed",
        model: "claude-opus-5-5",
        prompt: [user("The original task."), { role: "assistant", content: [{ type: "text", text: "done" }] }, user("Carry on.")],
      }),
      { model: "claude-opus-5-5", effort: "low" },
    )
  } finally {
    cleanup(fake)
  }
})

test("accountGroups refuses a model on another group's account before anything reaches opencode", { timeout: 30_000 }, async () => {
  const fake = createFakeCli()
  try {
    const parent = await runParent(
      fake,
      {
        name: "task",
        arguments: { description: "parser", prompt: PARSER, subagent_type: "implementor", model: "claude-code-work/claude-opus-5-5@work" },
      },
      { account: "default", failoverAccounts: ["default", "work"], accountGroups: { work: "job" } },
    )
    assert.equal(parent.filter((part) => part.type === "tool-call").length, 0, "nothing was dispatched")
    const answer = JSON.parse(fake.answers().at(-1).answer)
    assert.equal(answer.result.isError, true)
    assert.match(answer.result.content[0].text, /outside this conversation's account group/)
  } finally {
    cleanup(fake)
  }
})

test("subagentDispatchCrossGroup lets the same model through", { timeout: 30_000 }, async () => {
  const fake = createFakeCli()
  try {
    const parent = await runParent(
      fake,
      {
        name: "task",
        arguments: { description: "parser", prompt: PARSER, subagent_type: "implementor", model: "claude-code-work/claude-opus-5-5@work" },
      },
      {
        account: "default",
        failoverAccounts: ["default", "work"],
        accountGroups: { work: "job" },
        subagentDispatchCrossGroup: true,
      },
    )
    const calls = parent.filter((part) => part.type === "tool-call").map((part) => JSON.parse(part.input))
    assert.deepEqual(calls.map((input) => input.model), ["claude-code-work/claude-opus-5-5@work"])
  } finally {
    cleanup(fake)
  }
})

test("with subagentDispatch ask, only the tasks that name no model are asked about", { timeout: 30_000 }, async () => {
  const named = { description: "screen", prompt: SCREEN, subagent_type: "designer", model: "claude-code/claude-opus-5-5" }
  const fake = createFakeCli()
  try {
    const onlyNamed = await runParent(fake, { name: "task", arguments: named }, { subagentDispatch: "ask" })
    const onlyNamedCalls = onlyNamed.filter((part) => part.type === "tool-call")
    assert.equal(
      onlyNamedCalls.some((part) => String(part.toolCallId).startsWith(SUBAGENT_DISPATCH_TOOL_CALL_PREFIX)),
      false,
      "a dispatch whose every task names its model raises no form",
    )
    assert.equal(JSON.parse(onlyNamedCalls[0].input).model, "claude-code/claude-opus-5-5")
  } finally {
    cleanup(fake)
  }

  const mixedFake = createFakeCli()
  try {
    const mixed = await runParent(
      mixedFake,
      {
        name: "task_batch",
        arguments: { tasks: [named, { description: "parser", prompt: PARSER, subagent_type: "implementor" }] },
      },
      { subagentDispatch: "ask" },
    )
    const form = mixed.find(
      (part) => part.type === "tool-call" && String(part.toolCallId).startsWith(SUBAGENT_DISPATCH_TOOL_CALL_PREFIX),
    )
    assert.ok(form, "the unnamed task is still asked about")
    assert.match(form.input, /implementor/)
    assert.doesNotMatch(form.input, /designer/, "the named one is not")
  } finally {
    cleanup(mixedFake)
  }
})

test("a bare model id is completed to this conversation's own provider, and its child keeps it (h #g255)", { timeout: 30_000 }, async () => {
  const fake = createFakeCli()
  try {
    const parent = await runParent(fake, {
      name: "task",
      arguments: { description: "parser", prompt: PARSER, subagent_type: "implementor", model: "claude-opus-5-5#high" },
    })
    const calls = parent.filter((part) => part.type === "tool-call").map((part) => JSON.parse(part.input))
    assert.deepEqual(calls.map((input) => input.model), ["claude-code/claude-opus-5-5#high"], "opencode receives the completed reference")
    assert.deepEqual(
      await runChild(fake, { session: "ses_parser", model: "claude-opus-5-5", prompt: [user(wrapped(PARSER))], effort: "high" }),
      { model: "claude-opus-5-5", effort: "high" },
      "and the child it starts takes the request over the agent's forceModel and reasoningEffort",
    )
  } finally {
    cleanup(fake)
  }
})

test("on another account the completion carries that account's marker, and accountGroups lets it through", { timeout: 30_000 }, async () => {
  const fake = createFakeCli()
  try {
    const parent = await runParent(
      fake,
      { name: "task", arguments: { description: "parser", prompt: PARSER, subagent_type: "implementor", model: "claude-opus-5-5" } },
      { providerID: "claude-code-work", account: "work", failoverAccounts: ["default", "work"], accountGroups: { work: "job" } },
    )
    const calls = parent.filter((part) => part.type === "tool-call").map((part) => JSON.parse(part.input))
    assert.deepEqual(calls.map((input) => input.model), ["claude-code-work/claude-opus-5-5@work"])
  } finally {
    cleanup(fake)
  }
})
