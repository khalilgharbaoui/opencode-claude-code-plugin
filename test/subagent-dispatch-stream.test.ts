/**
 * The subagent dispatch form driven through a real `doStream` and a fake
 * `claude` (h #g227).
 *
 * Three things only an end-to-end run can say: that a dispatch really is held
 * and released on the same opencode turn, that a child session's spawn carries
 * the model, the effort and the account the operator picked, and that with the
 * option off the argv is byte-identical to what it is today.
 */
import { test, after } from "node:test"
import assert from "node:assert/strict"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClaudeCode } from "../src/index.js"
import { setOpencodeClient } from "../src/runtime-status.js"
import {
  deleteActiveProcess,
  killAllActiveProcesses,
  sessionKey,
} from "../src/session-manager.js"
import {
  SUBAGENT_DISPATCH_MARKER,
  SUBAGENT_DISPATCH_TOOL_CALL_PREFIX,
  _resetSubagentDispatchForTests,
} from "../src/subagent-dispatch.js"

// Every account runtime this file builds lands under a throwaway HOME, so no
// test writes a wrapper or a config dir into the real one.
const HOME = mkdtempSync(join(tmpdir(), "opencode-dispatch-home-"))
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

const PARENT_SESSION = "ses_parent"
const CHILD_SESSION = "ses_child"
const MODEL_ID = "claude-haiku-4-5"

const ALPHA_PROMPT = "ALPHA: build the parser."
const BETA_PROMPT = "BETA: draw the screen."

/** opencode's registry must carry `question`, or the form is never offered. */
setOpencodeClient({
  tool: {
    list: async () => ({ data: [{ id: "question", description: "", parameters: {} }] }),
  },
  session: {
    // Only the child is a child; the dispatching session is a root, which is
    // what keeps the form out of a subagent (the gate's `childSession`).
    get: async ({ path }: any) => ({
      data: path.id === CHILD_SESSION ? { parentID: PARENT_SESSION } : {},
    }),
  },
})

/**
 * A fake `claude` that dispatches two subagents of different types through the
 * proxy on its first turn, then answers plainly. Records every spawn's argv,
 * `CLAUDE_CODE_EFFORT_LEVEL` and `CLAUDE_CONFIG_DIR`.
 */
function createFakeCli() {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-dispatch-"))
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
      const config = JSON.parse(fs.readFileSync(args[i], "utf8"))
      const entry = config.mcpServers?.opencode_proxy
      proxyUrl = entry?.url ?? proxyUrl
      proxyHeaders = entry?.headers ?? proxyHeaders
    } catch {}
  }
}

const dispatch = process.env.FAKE_CLI_DISPATCH === "1"
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n")

const rl = readline.createInterface({ input: process.stdin })
let answered = false
rl.on("line", async (line) => {
  if (answered) return
  answered = true
  fs.appendFileSync(
    ${JSON.stringify(record)},
    JSON.stringify({
      argv: args,
      effort: process.env.CLAUDE_CODE_EFFORT_LEVEL ?? null,
      configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
      stdin: line,
    }) + "\\n",
  )
  emit({ type: "system", subtype: "init", session_id: "fake-session" })
  if (dispatch && proxyUrl) {
    await fetch(proxyUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...proxyHeaders },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "task_batch",
          arguments: {
            tasks: [
              { description: "parser", prompt: ${JSON.stringify(ALPHA_PROMPT)}, subagent_type: "implementor" },
              { description: "screen", prompt: ${JSON.stringify(BETA_PROMPT)}, subagent_type: "designer" },
            ],
          },
        },
      }),
    }).catch(() => undefined)
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
  return {
    cliPath,
    cwd,
    spawns: (): any[] =>
      existsSync(record)
        ? readFileSync(record, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [],
  }
}

async function drain(response: any): Promise<any[]> {
  const parts: any[] = []
  for await (const part of response.stream) parts.push(part)
  return parts
}

function buildModel(
  fake: ReturnType<typeof createFakeCli>,
  settings: Record<string, unknown> = {},
) {
  return createClaudeCode({
    cliPath: fake.cliPath,
    baseCliPath: fake.cliPath,
    cwd: fake.cwd,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: ["Task"],
    ...settings,
  }).languageModel(MODEL_ID)
}

function promptFor(sessionID: string, text: string) {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text }] }],
    providerOptions: { "claude-code": { opencodeSessionID: sessionID } },
    tools: [],
  }
}

function answerPrompt(
  sessionID: string,
  call: any,
  answers: string[],
  previous: any[] = [],
) {
  const input = JSON.parse(call.input)
  const body = input.questions
    .map((question: any, index: number) => `"${question.question}"="${answers[index] ?? ""}"`)
    .join(", ")
  return {
    prompt: [
      ...previous,
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: call.toolCallId, toolName: "question", input: call.input },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: call.toolCallId,
            toolName: "question",
            output: {
              type: "text",
              value: `User has answered your questions: ${body}. You can now continue with the user's answers in mind.`,
            },
          },
        ],
      },
    ],
    providerOptions: { "claude-code": { opencodeSessionID: sessionID } },
    tools: [],
  }
}

function parentKey(fake: ReturnType<typeof createFakeCli>) {
  return sessionKey(
    fake.cwd,
    `${MODEL_ID}::tools::${PARENT_SESSION}::context=["claude-code",null]`,
  )
}

function modelArg(argv: string[]): string | undefined {
  const at = argv.indexOf("--model")
  return at === -1 ? undefined : argv[at + 1]
}

test("with subagentDispatch off, a dispatch reaches opencode untouched", async () => {
  _resetSubagentDispatchForTests()
  const fake = createFakeCli()
  process.env.FAKE_CLI_DISPATCH = "1"
  try {
    const model = buildModel(fake)
    const parts = await drain(await model.doStream(promptFor(PARENT_SESSION, "go") as any))
    const calls = parts.filter((part) => part.type === "tool-call")
    assert.equal(calls.length, 2, "both tasks go straight out")
    assert.deepEqual(
      calls.map((call) => call.toolName),
      ["task", "task"],
    )
    assert.ok(!calls.some((call) => call.toolCallId.startsWith(SUBAGENT_DISPATCH_TOOL_CALL_PREFIX)))
    const finish = parts.find((part) => part.type === "finish")
    assert.equal(finish.finishReason.unified, "tool-calls")
  } finally {
    delete process.env.FAKE_CLI_DISPATCH
    deleteActiveProcess(parentKey(fake))
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("turning the option on changes no argv on a turn that dispatches nothing", async () => {
  _resetSubagentDispatchForTests()
  const off = createFakeCli()
  const on = createFakeCli()
  try {
    await drain(
      await buildModel(off).doStream(promptFor(PARENT_SESSION, "go") as any),
    )
    await drain(
      await buildModel(on, { subagentDispatch: "ask" }).doStream(
        promptFor(PARENT_SESSION, "go") as any,
      ),
    )
    // Everything that names a per-run temporary path differs by construction;
    // the rest of the command line is what this asserts.
    const scrub = (argv: string[]) =>
      argv.map((value) => (value.startsWith("/") ? "<path>" : value))
    assert.deepEqual(scrub(on.spawns()[0].argv), scrub(off.spawns()[0].argv))
    assert.equal(on.spawns()[0].effort, off.spawns()[0].effort)
    assert.equal(on.spawns()[0].configDir, off.spawns()[0].configDir)
  } finally {
    deleteActiveProcess(parentKey(off))
    deleteActiveProcess(parentKey(on))
    rmSync(off.cwd, { recursive: true, force: true })
    rmSync(on.cwd, { recursive: true, force: true })
  }
})

test("with subagentDispatch ask, the dispatch is held, asked about, then released", async () => {
  _resetSubagentDispatchForTests()
  const fake = createFakeCli()
  process.env.FAKE_CLI_DISPATCH = "1"
  try {
    const model = buildModel(fake, { subagentDispatch: "ask" })
    const first = await drain(await model.doStream(promptFor(PARENT_SESSION, "go") as any))
    const question = first.find((part) => part.type === "tool-call")
    assert.ok(question, "the dispatch turn must end on a question")
    assert.equal(question.toolName, "question")
    assert.ok(question.toolCallId.startsWith(SUBAGENT_DISPATCH_TOOL_CALL_PREFIX))
    // Exactly one question, which is the one-click common case.
    const input = JSON.parse(question.input)
    assert.equal(input.questions.length, 1)
    assert.equal(first.find((part) => part.type === "finish").finishReason.unified, "tool-calls")
    // No `task` call went out yet.
    assert.equal(first.filter((part) => part.type === "tool-call").length, 1)

    // The answer, on the next step of the same opencode turn.
    const second = await drain(
      await model.doStream(
        answerPrompt(PARENT_SESSION, question, ["claude-sonnet-5-5 / medium"]) as any,
      ),
    )
    const released = second.filter((part) => part.type === "tool-call")
    assert.deepEqual(
      released.map((call) => call.toolName),
      ["task", "task"],
    )
    assert.deepEqual(
      released.map((call) => JSON.parse(call.input).prompt),
      [ALPHA_PROMPT, BETA_PROMPT],
    )
    assert.equal(second.find((part) => part.type === "finish").finishReason.unified, "tool-calls")
    // The release spawns nothing: the CLI is parked inside its own MCP call.
    assert.equal(fake.spawns().length, 1)
  } finally {
    delete process.env.FAKE_CLI_DISPATCH
    deleteActiveProcess(parentKey(fake))
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("the chosen model and effort reach the child session's own spawn", async () => {
  _resetSubagentDispatchForTests()
  const fake = createFakeCli()
  process.env.FAKE_CLI_DISPATCH = "1"
  const childKey = sessionKey(
    fake.cwd,
    `claude-opus-5-5::tools::${CHILD_SESSION}::context=["claude-code","implementor"]::effort=max`,
  )
  try {
    const model = buildModel(fake, { subagentDispatch: "ask" })
    const first = await drain(await model.doStream(promptFor(PARENT_SESSION, "go") as any))
    const question = first.find((part) => part.type === "tool-call")

    // `Customise…`, then one row per type: the implementor on Opus at max and
    // the designer left alone.
    const second = await drain(
      await model.doStream(answerPrompt(PARENT_SESSION, question, ["Customise…"]) as any),
    )
    const typeForm = second.find((part) => part.type === "tool-call")
    assert.equal(typeForm.toolName, "question")
    assert.deepEqual(
      JSON.parse(typeForm.input).questions.map((entry: any) => entry.header),
      ["implementor", "designer"],
    )
    const third = await drain(
      await model.doStream(
        answerPrompt(PARENT_SESSION, typeForm, ["claude-opus-5-5 / max", "Default"]) as any,
      ),
    )
    assert.equal(third.filter((part) => part.type === "tool-call").length, 2)

    // Now the child itself: opencode starts a session whose first user message
    // is the task prompt and whose agent is the subagent type.
    delete process.env.FAKE_CLI_DISPATCH
    const childParts = await drain(
      await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: ALPHA_PROMPT }] }],
        providerOptions: {
          "claude-code": { opencodeSessionID: CHILD_SESSION, opencodeAgent: "implementor" },
        },
        tools: [],
      } as any),
    )
    assert.ok(childParts.some((part) => part.type === "finish"))

    const childSpawn = fake.spawns().at(-1)
    assert.equal(modelArg(childSpawn.argv), "claude-opus-5-5")
    assert.equal(childSpawn.effort, "max")
  } finally {
    delete process.env.FAKE_CLI_DISPATCH
    deleteActiveProcess(parentKey(fake))
    deleteActiveProcess(childKey)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("the child that was NOT chosen for keeps the spawn it would have had", async () => {
  _resetSubagentDispatchForTests()
  const fake = createFakeCli()
  process.env.FAKE_CLI_DISPATCH = "1"
  const designerKey = sessionKey(
    fake.cwd,
    `${MODEL_ID}::tools::ses_designer::context=["claude-code","designer"]`,
  )
  try {
    const model = buildModel(fake, { subagentDispatch: "ask" })
    const first = await drain(await model.doStream(promptFor(PARENT_SESSION, "go") as any))
    const question = first.find((part) => part.type === "tool-call")
    const second = await drain(
      await model.doStream(answerPrompt(PARENT_SESSION, question, ["Customise…"]) as any),
    )
    const typeForm = second.find((part) => part.type === "tool-call")
    await drain(
      await model.doStream(
        answerPrompt(PARENT_SESSION, typeForm, ["claude-opus-5-5 / max", "Default"]) as any,
      ),
    )

    delete process.env.FAKE_CLI_DISPATCH
    await drain(
      await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: BETA_PROMPT }] }],
        providerOptions: {
          "claude-code": { opencodeSessionID: "ses_designer", opencodeAgent: "designer" },
        },
        tools: [],
      } as any),
    )
    const spawn = fake.spawns().at(-1)
    assert.equal(modelArg(spawn.argv), MODEL_ID)
    assert.equal(spawn.effort, null)
  } finally {
    delete process.env.FAKE_CLI_DISPATCH
    deleteActiveProcess(parentKey(fake))
    deleteActiveProcess(designerKey)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a chosen account spawns that account's wrapper and config dir", async () => {
  _resetSubagentDispatchForTests()
  const fake = createFakeCli()
  process.env.FAKE_CLI_DISPATCH = "1"
  const childKey = sessionKey(
    fake.cwd,
    `${MODEL_ID}::tools::${CHILD_SESSION}::context=["claude-code","implementor"]`,
  )
  try {
    const model = buildModel(fake, {
      subagentDispatch: "ask",
      failoverAccounts: ["default", "worker"],
    })
    const first = await drain(await model.doStream(promptFor(PARENT_SESSION, "go") as any))
    const question = first.find((part) => part.type === "tool-call")
    const second = await drain(
      await model.doStream(answerPrompt(PARENT_SESSION, question, ["Customise…"]) as any),
    )
    const typeForm = second.find((part) => part.type === "tool-call")
    const headers = JSON.parse(typeForm.input).questions.map((entry: any) => entry.header)
    assert.deepEqual(headers, ["implementor", "designer", "Account"])
    await drain(
      await model.doStream(
        answerPrompt(PARENT_SESSION, typeForm, ["Default", "Default", "worker"]) as any,
      ),
    )

    delete process.env.FAKE_CLI_DISPATCH
    await drain(
      await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: ALPHA_PROMPT }] }],
        providerOptions: {
          "claude-code": { opencodeSessionID: CHILD_SESSION, opencodeAgent: "implementor" },
        },
        tools: [],
      } as any),
    )
    const spawn = fake.spawns().at(-1)
    // The POSIX wrapper carries the account; it exports the config dir itself,
    // so the recorded `CLAUDE_CONFIG_DIR` is the one the wrapper set.
    if (process.platform !== "win32") {
      assert.match(String(spawn.configDir), /\.claude-worker$/)
    }
  } finally {
    delete process.env.FAKE_CLI_DISPATCH
    deleteActiveProcess(parentKey(fake))
    deleteActiveProcess(childKey)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a dismissed form releases the dispatch and writes the note", async () => {
  _resetSubagentDispatchForTests()
  const fake = createFakeCli()
  process.env.FAKE_CLI_DISPATCH = "1"
  try {
    const model = buildModel(fake, { subagentDispatch: "ask" })
    const first = await drain(await model.doStream(promptFor(PARENT_SESSION, "go") as any))
    const question = first.find((part) => part.type === "tool-call")
    const second = await drain(
      await model.doStream({
        prompt: [
          { role: "user", content: [{ type: "text", text: "go" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: question.toolCallId,
                toolName: "question",
                input: question.input,
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: question.toolCallId,
                toolName: "question",
                output: { type: "error-text", value: "The user dismissed this question" },
              },
            ],
          },
        ],
        providerOptions: { "claude-code": { opencodeSessionID: PARENT_SESSION } },
        tools: [],
      } as any),
    )
    const text = second
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("")
    assert.ok(text.includes(SUBAGENT_DISPATCH_MARKER))
    assert.equal(second.filter((part) => part.type === "tool-call").length, 2)
  } finally {
    delete process.env.FAKE_CLI_DISPATCH
    deleteActiveProcess(parentKey(fake))
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})
