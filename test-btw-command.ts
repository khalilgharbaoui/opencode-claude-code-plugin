import assert from "node:assert/strict"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  answerToastMessage,
  asideParentOf,
  asideSessionTitle,
  BTW_NO_SESSION_MESSAGE,
  BtwHandledError,
  clearAsideSessions,
  handleBtwCommand,
  registerAsideSession,
  resolveAsideParent,
  type BtwSdkClient,
  type BtwToast,
} from "./src/btw-command.js"
import { createClaudeCode, registerSideQuestionCommand } from "./src/index.js"
import type { OpenCodeConfig } from "./src/opencode-types.js"
import {
  deleteActiveProcess,
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  findActiveProcessBySessionId,
  getActiveProcess,
  sessionKey,
  setActiveProcess,
  type ActiveProcess,
} from "./src/session-manager.js"
import { SIDE_QUESTION_USAGE } from "./src/side-question.js"

type Call = { method: string; args: unknown }

function fakeClient() {
  const calls: Call[] = []
  const sessions = new Map<string, { id: string; parentID?: string; title?: string }>()
  let counter = 0
  const client: BtwSdkClient = {
    session: {
      create: async ({ body }) => {
        const id = `ses_child_${++counter}`
        sessions.set(id, { id, ...body })
        calls.push({ method: "create", args: body })
        return { data: { id } }
      },
      get: async ({ path }) => {
        calls.push({ method: "get", args: path.id })
        const found = sessions.get(path.id)
        return found ? { data: found } : { error: { status: 404 } }
      },
      update: async ({ path, body }) => {
        calls.push({ method: "update", args: { id: path.id, ...body } })
        const found = sessions.get(path.id)
        if (found) found.title = body.title
        return {}
      },
      promptAsync: async ({ path, body }) => {
        calls.push({ method: "promptAsync", args: { id: path.id, ...body } })
        return {}
      },
    },
    tui: {
      // A method, not an arrow: the real SDK reads `this._client`, and the
      // first live run failed because the toast was called detached.
      async showToast(this: unknown, { body }) {
        assert.equal(this, client.tui, "SDK methods must be called on their namespace object")
        calls.push({ method: "toast", args: body })
        return {}
      },
    },
  }
  const toasts = () => calls.filter((call) => call.method === "toast").map((call) => call.args as BtwToast)
  const only = (method: string) => calls.filter((call) => call.method === method)
  return { client, calls, sessions, toasts, only }
}

function fakeActive(sessionID: string, key: string): ActiveProcess {
  const proc = Object.assign(new EventEmitter(), {
    pid: 4242,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: () => true,
    stdin: null,
    stdout: null,
  })
  const ap: ActiveProcess = {
    proc: proc as unknown as ChildProcess,
    lineEmitter: new EventEmitter(),
    opencodeSessionID: sessionID,
    opencodeModel: { providerID: "claude-code-work", modelID: "claude-opus-5@work" },
  }
  setActiveProcess(key, ap)
  return ap
}

function dropActive(key: string): void {
  try {
    deleteActiveProcess(key)
  } catch {
    // The fake process has no real handles; nothing to release.
  }
}

const input = (question: string, sessionID = "ses_parent") => ({ command: "btw", sessionID, arguments: question })

test("bare /btw shows the usage text as a toast and never opens a session", async () => {
  clearAsideSessions()
  const fake = fakeClient()
  await assert.rejects(handleBtwCommand(fake.client, input("   ")), BtwHandledError)
  assert.deepEqual(fake.toasts(), [{ title: "btw", message: SIDE_QUESTION_USAGE, variant: "warning", duration: 6_000 }])
  assert.equal(fake.only("create").length, 0)
  assert.equal(fake.only("promptAsync").length, 0)
})

test("/btw without a live process for the session explains itself and drops the prompt", async () => {
  clearAsideSessions()
  const fake = fakeClient()
  await assert.rejects(handleBtwCommand(fake.client, input("why?", "ses_nobody")), BtwHandledError)
  assert.equal(fake.toasts()[0].message, BTW_NO_SESSION_MESSAGE)
  assert.equal(fake.only("create").length, 0)
})

test("/btw opens one child session per parent, prompts it with the parent's model, and reuses it", async () => {
  clearAsideSessions()
  const key = "btw-test::parent"
  fakeActive("ses_parent", key)
  const fake = fakeClient()
  try {
    await assert.rejects(handleBtwCommand(fake.client, input("What did I ask?")), BtwHandledError)
    assert.deepEqual(fake.only("create").map((call) => call.args), [
      { parentID: "ses_parent", title: "@btw subagent · What did I ask?" },
    ])
    assert.deepEqual(fake.only("promptAsync").map((call) => call.args), [
      {
        id: "ses_child_1",
        model: { providerID: "claude-code-work", modelID: "claude-opus-5@work" },
        parts: [{ type: "text", text: "/btw What did I ask?" }],
      },
    ])
    assert.equal(asideParentOf("ses_child_1"), "ses_parent")
    assert.equal(fake.toasts().at(-1)?.variant, "info")

    await assert.rejects(handleBtwCommand(fake.client, input("And then?")), BtwHandledError)
    assert.equal(fake.only("create").length, 1, "the child is reused")
    assert.deepEqual(fake.only("update").map((call) => call.args), [
      { id: "ses_child_1", title: "@btw subagent · And then?" },
    ])
    assert.equal(fake.only("promptAsync").length, 2)
    assert.equal((fake.only("promptAsync")[1].args as { id: string }).id, "ses_child_1")

    // A deleted child is replaced, and the stale mapping is forgotten.
    fake.sessions.delete("ses_child_1")
    await assert.rejects(handleBtwCommand(fake.client, input("Still there?")), BtwHandledError)
    assert.equal(fake.only("create").length, 2)
    assert.equal(asideParentOf("ses_child_1"), undefined)
    assert.equal(asideParentOf("ses_child_2"), "ses_parent")
    assert.equal((fake.only("promptAsync")[2].args as { id: string }).id, "ses_child_2")
  } finally {
    dropActive(key)
    clearAsideSessions()
  }
})

test("/btw dispatch failures surface as an error toast and still drop the prompt", async () => {
  clearAsideSessions()
  const key = "btw-test::failing"
  fakeActive("ses_fail", key)
  const fake = fakeClient()
  fake.client.session!.promptAsync = async () => ({ error: { message: "boom" } })
  try {
    await assert.rejects(handleBtwCommand(fake.client, input("why?", "ses_fail")), /failed: boom/)
    assert.equal(fake.toasts().at(-1)?.variant, "error")
    assert.match(fake.toasts().at(-1)!.message, /boom/)
  } finally {
    dropActive(key)
    clearAsideSessions()
  }
})

test("resolveAsideParent prefers the in-memory map and falls back to opencode's parentID", async () => {
  clearAsideSessions()
  const fake = fakeClient()
  fake.sessions.set("ses_orphan", { id: "ses_orphan", parentID: "ses_root" })
  fake.sessions.set("ses_top", { id: "ses_top" })
  registerAsideSession("ses_known", "ses_mapped")
  assert.equal(await resolveAsideParent("ses_known", fake.client), "ses_mapped")
  assert.equal(fake.only("get").length, 0)
  assert.equal(await resolveAsideParent("ses_orphan", fake.client), "ses_root")
  assert.equal(asideParentOf("ses_orphan"), "ses_root", "the fallback result is remembered")
  assert.equal(await resolveAsideParent("ses_top", fake.client), undefined)
  assert.equal(await resolveAsideParent("ses_missing", fake.client), undefined)
  assert.equal(await resolveAsideParent("ses_missing", null), undefined)
  clearAsideSessions()
})

test("findActiveProcessBySessionId returns the most recently used process for a session", () => {
  const older = fakeActive("ses_dup", "btw-test::older")
  const newer = fakeActive("ses_dup", "btw-test::newer")
  try {
    assert.equal(findActiveProcessBySessionId("ses_dup"), newer)
    getActiveProcess("btw-test::older")
    assert.equal(findActiveProcessBySessionId("ses_dup"), older, "touching moves a process to the back of the LRU")
    assert.equal(findActiveProcessBySessionId("ses_other"), undefined)
  } finally {
    dropActive("btw-test::older")
    dropActive("btw-test::newer")
  }
})

test("titles and toast previews are flattened and truncated", () => {
  assert.equal(asideSessionTitle("  why\n\n is   this  "), "@btw subagent · why is this")
  const long = "x".repeat(100)
  assert.equal(asideSessionTitle(long), `@btw subagent · ${"x".repeat(57)}...`)
  assert.equal(answerToastMessage("a\nb"), "a b")
  assert.equal(answerToastMessage("y".repeat(300)), `${"y".repeat(277)}...`)
})

test("registerSideQuestionCommand reports ownership so a user-defined btw command is left alone", () => {
  const ours: OpenCodeConfig = {}
  assert.equal(registerSideQuestionCommand(ours), true)
  assert.equal(registerSideQuestionCommand(ours), false, "re-running config keeps the first registration")
  assert.equal(ours.command?.btw?.template, "/btw $ARGUMENTS")
  const theirs: OpenCodeConfig = { command: { btw: { template: "mine $ARGUMENTS" } } }
  assert.equal(registerSideQuestionCommand(theirs), false)
  assert.equal(theirs.command?.btw?.template, "mine $ARGUMENTS")
})

function createAsideCli() {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-btw-child-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const eventsPath = join(cwd, "events.jsonl")
  writeFileSync(eventsPath, "")
  writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
const record = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({ ...event, pid: process.pid }) + "\\n")
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.258\\n")
  process.exit(0)
}
record({ type: "spawn" })
let asides = 0
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const envelope = JSON.parse(line)
  record({ type: "input", envelope })
  if (envelope.type === "control_request" && envelope.request?.subtype === "side_question") {
    asides++
    emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: envelope.request_id,
        response: { response: "Aside " + asides + " from the parent process", synthetic: false },
      },
    })
    return
  }
  emit({
    type: "assistant",
    session_id: "fake-parent-session",
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Parent answer" }] },
  })
  emit({ type: "result", subtype: "success", session_id: "fake-parent-session", is_error: false, usage: { input_tokens: 3, output_tokens: 2 } })
})
`, { mode: 0o755 })
  const modelId = "claude-test-btw-child"
  const model = createClaudeCode({
    cliPath,
    cwd,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    interactive: false,
    autoContinueIncompleteTurns: false,
  }).languageModel(modelId)
  const keyFor = (sessionID: string) =>
    sessionKey(cwd, `${modelId}::tools::${sessionID}::context=["claude-code",null]`)
  const tools = [{ type: "function" as const, name: "read", inputSchema: { type: "object", properties: {} } }]
  return {
    keyFor,
    modelId,
    events: () => readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map((line) =>
      JSON.parse(line) as { type: string; pid: number; envelope?: { type: string; request?: Record<string, unknown> } },
    ),
    async turn(sessionID: string, prompt: LanguageModelV3CallOptions["prompt"]) {
      const response = await model.doStream({
        prompt,
        tools,
        providerOptions: { "claude-code": { opencodeSessionID: sessionID } },
        abortSignal: AbortSignal.timeout(5_000),
      })
      const parts: LanguageModelV3StreamPart[] = []
      for await (const part of response.stream) parts.push(part)
      const errors = parts.filter((part) => part.type === "error")
      const answer = parts.filter((part) => part.type === "text-delta").map((part) => part.delta).join("")
      return { parts, answer, errors }
    },
    async cleanup(sessionIDs: string[]) {
      for (const sessionID of sessionIDs) {
        await deleteActiveProcessAndWait(keyFor(sessionID))
        deleteClaudeSessionId(keyFor(sessionID))
      }
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

test("a btw child session asks the parent's live process, with earlier asides as history", {
  timeout: 20_000,
}, async () => {
  clearAsideSessions()
  const fake = createAsideCli()
  try {
    const parent = await fake.turn("ses_parent", [{ role: "user", content: [{ type: "text", text: "Start." }] }])
    assert.equal(parent.answer, "Parent answer")
    const parentProcess = getActiveProcess(fake.keyFor("ses_parent"))
    assert.ok(parentProcess)
    assert.equal(parentProcess.opencodeSessionID, "ses_parent")
    assert.deepEqual(parentProcess.opencodeModel, { providerID: "claude-code", modelID: fake.modelId })
    assert.equal(findActiveProcessBySessionId("ses_parent"), parentProcess)

    registerAsideSession("ses_child", "ses_parent")
    const first = await fake.turn("ses_child", [{ role: "user", content: [{ type: "text", text: "/btw First?" }] }])
    assert.deepEqual(first.errors, [])
    assert.equal(first.answer, "Aside 1 from the parent process")
    assert.equal(getActiveProcess(fake.keyFor("ses_child")), undefined, "the child never spawns a process")

    const second = await fake.turn("ses_child", [
      { role: "user", content: [{ type: "text", text: "/btw First?" }] },
      { role: "assistant", content: [{ type: "text", text: first.answer }] },
      { role: "user", content: [{ type: "text", text: "/btw Second?" }] },
    ])
    assert.deepEqual(second.errors, [])
    assert.equal(second.answer, "Aside 2 from the parent process")

    const events = fake.events()
    assert.equal(events.filter((event) => event.type === "spawn").length, 1)
    const inputs = events.filter((event) => event.type === "input")
    assert.deepEqual(inputs.map((event) => event.pid), Array(3).fill(parentProcess.proc.pid))
    assert.deepEqual(inputs.map((event) => event.envelope?.type), ["user", "control_request", "control_request"])
    assert.deepEqual(inputs[1].envelope?.request, { subtype: "side_question", question: "First?" })
    assert.deepEqual(inputs[2].envelope?.request, {
      subtype: "side_question",
      question: "Second?",
      history: [{ question: "First?", response: "Aside 1 from the parent process" }],
    })

    // A child whose parent has no process reports that, not a generic error.
    registerAsideSession("ses_lonely", "ses_gone")
    const lonely = await fake.turn("ses_lonely", [{ role: "user", content: [{ type: "text", text: "/btw Anyone?" }] }])
    assert.equal(lonely.errors.length, 1)
    assert.match(String((lonely.errors[0] as { error: unknown }).error), /parent conversation/)
  } finally {
    await fake.cleanup(["ses_parent", "ses_child", "ses_lonely"])
    clearAsideSessions()
  }
})
