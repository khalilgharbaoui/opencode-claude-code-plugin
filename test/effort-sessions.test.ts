import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { ChildProcess } from "node:child_process"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { createClaudeCode } from "../src/index.js"
import {
  deleteActiveProcess,
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  effortSessionKey,
  getActiveProcess,
  getClaudeSessionId,
  invalidateOtherEffortSessions,
  setActiveProcess,
  setClaudeSessionId,
  sessionKey,
  type ActiveProcess,
} from "../src/session-manager.js"
import { queuePendingProxyCall, resolvePendingProxyCallById } from "../src/proxy-broker.js"
import { createExitPlanModeQuestionCall, hasExitPlanModeQuestions } from "../src/plan-mode-question.js"
import { getCompressionSummary, storeCompressionSummary } from "../src/compression-store.js"
import { requestSideQuestion } from "../src/side-question.js"

function fakeActive() {
  let killed = false
  const active: ActiveProcess = {
    proc: { kill: () => { killed = true; return true } } as ChildProcess,
    lineEmitter: new EventEmitter(),
  }
  return { active, killed: () => killed }
}

test("effort invalidation kills the process and carries the claude session to the new effort", () => {
  const base = "effort-invalidation"
  const high = effortSessionKey(base, "high")
  const low = effortSessionKey(base, "low")
  const first = fakeActive()
  setActiveProcess(high, first.active)
  setClaudeSessionId(high, "old-high")
  storeCompressionSummary(high, "outdated summary")
  try {
    invalidateOtherEffortSessions(base, "high")
    assert.equal(getActiveProcess(high), first.active)
    assert.equal(getClaudeSessionId(high), "old-high")
    assert.equal(first.killed(), false)

    // Effort is fixed per child, so the PROCESS has to go. The conversation
    // does not: the id moves to the key this turn will use, so the spawn
    // resumes it at the new effort instead of replaying the thread (issue #91).
    invalidateOtherEffortSessions(base, "low")
    assert.equal(first.killed(), true)
    assert.equal(getActiveProcess(high), undefined)
    assert.equal(getClaudeSessionId(high), undefined, "the old effort key keeps no claim on it")
    assert.equal(getClaudeSessionId(low), "old-high", "carried to the new effort key")
    assert.equal(getCompressionSummary(high), undefined)

    // Back to high: the id follows again, and the key it came from is empty.
    invalidateOtherEffortSessions(base, "high")
    assert.equal(getClaudeSessionId(low), undefined)
    assert.equal(getClaudeSessionId(high), "old-high")

    // A destination that already has a conversation of its own is never
    // overwritten, and the stale sibling is released rather than carried.
    setClaudeSessionId(base, "no-explicit-effort")
    invalidateOtherEffortSessions(base, "high")
    assert.equal(getClaudeSessionId(base), undefined)
    assert.equal(getClaudeSessionId(high), "old-high")
  } finally {
    for (const key of [base, high, low]) {
      deleteActiveProcess(key)
      deleteClaudeSessionId(key)
    }
  }
})

test("effort transition preserves an in-flight native side question", async () => {
  const base = "effort-side-question"
  const high = effortSessionKey(base, "high")
  const first = fakeActive()
  first.active.proc = Object.assign(new EventEmitter(), {
    stdout: {},
    stdin: Object.assign(new EventEmitter(), {
      writable: true,
      write: (_line: string, callback?: () => void) => { callback?.(); return true },
    }),
    kill: () => true,
  }) as unknown as ChildProcess
  setActiveProcess(high, first.active)
  setClaudeSessionId(high, "aside-high")
  const abort = new AbortController()
  const pending = requestSideQuestion(first.active, "question", {
    cliVersion: { major: 2, minor: 1, patch: 258 }, abortSignal: abort.signal, timeoutMs: 1000,
  })
  const rejected = assert.rejects(pending, /abort/i)
  try {
    assert.throws(() => invalidateOtherEffortSessions(base, "low"), /pending work/)
    assert.equal(getActiveProcess(high), first.active)
    assert.equal(getClaudeSessionId(high), "aside-high")
  } finally {
    abort.abort()
    await rejected
    deleteActiveProcess(high)
    deleteClaudeSessionId(high)
  }
})

for (const busy of ["proxy", "completion", "approval", "stream"] as const) {
  test(`effort transition refuses to destroy pending ${busy} work`, () => {
    const base = `effort-pending-${busy}`
    const high = effortSessionKey(base, "high")
    const first = fakeActive()
    setActiveProcess(high, first.active)
    setClaudeSessionId(high, "pending-high")
    const call = {
      sessionKey: high, toolCallId: `pending-${busy}`, toolName: "task", input: {},
    }
    if (busy === "proxy") {
      queuePendingProxyCall(high, {
        id: call.toolCallId, toolName: call.toolName, input: {}, resolve() {}, reject() {},
      })
    } else if (busy === "completion") {
      first.active.pendingProxyCompletions = new Map([[call.toolCallId, {
        call, result: { kind: "text", text: "finished" }, recoveryRequired: true,
      }]])
    } else if (busy === "approval") {
      createExitPlanModeQuestionCall(high, "exit-plan", "plan")
    } else {
      first.active.lineEmitter.on("line", () => {})
    }
    try {
      assert.throws(() => invalidateOtherEffortSessions(base, "low"), /pending work/)
      assert.equal(getActiveProcess(high), first.active)
      assert.equal(getClaudeSessionId(high), "pending-high")
      assert.equal(first.killed(), false)
      if (busy === "approval") assert.equal(hasExitPlanModeQuestions(high), true)
      // Continuation at the original effort is not blocked or invalidated.
      invalidateOtherEffortSessions(base, "high")
      assert.equal(getActiveProcess(high), first.active)
    } finally {
      resolvePendingProxyCallById(call.toolCallId, { kind: "text", text: "cleanup" })
      deleteActiveProcess(high)
      deleteClaudeSessionId(high)
    }
  })
}

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-effort-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  writeFileSync(cliPath, `#!/usr/bin/env node
const readline = require("node:readline")
if (process.argv.includes("--version")) {
  console.log("2.1.258")
  process.exit(0)
}
const emit = (message) => console.log(JSON.stringify(message))
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const envelope = JSON.parse(line)
  if (envelope.type !== "user") return
  emit({ type: "assistant", session_id: String(process.pid), message: {
    role: "assistant", stop_reason: "end_turn",
    content: [{ type: "text", text: "answer " + process.env.CLAUDE_CODE_EFFORT_LEVEL }],
  } })
  emit({ type: "result", subtype: "success", session_id: String(process.pid),
    is_error: false, usage: { input_tokens: 1, output_tokens: 1 } })
})
`, { mode: 0o755 })
  const modelId = "claude-haiku-4-5"
  const provider = createClaudeCode({
    cwd, cliPath, bridgeOpencodeMcp: false, proxyOpencodeMcpTools: false,
    proxyTools: [], interactive: false, autoContinueIncompleteTurns: false,
  })
  const base = sessionKey(cwd, `${modelId}::tools::conversation::context=["claude-code","worker"]`)
  const options: LanguageModelV3CallOptions = {
    tools: [{ type: "function", name: "read", inputSchema: { type: "object" } }],
    providerOptions: { "claude-code": { opencodeSessionID: "conversation", opencodeAgent: "worker" } },
    prompt: [{ role: "user", content: [{ type: "text", text: "first high request" }] }],
  }
  return { cwd, modelId, provider, base, options }
}

for (const method of ["doStream", "doGenerate"] as const) {
  test(`${method}: synthetic title, completed turn and /btw do not retire another effort`, async () => {
    const { cwd, modelId, provider, base, options } = fixture()
    const high = effortSessionKey(base, "high")
    const first = fakeActive()
    setActiveProcess(high, first.active)
    setClaudeSessionId(high, "keep-high")
    options.providerOptions!["claude-code"].reasoningEffort = "low"
    try {
      for (const request of [
        { ...options, tools: undefined },
        { ...options, prompt: [...options.prompt, { role: "assistant" as const, content: [{ type: "text" as const, text: "finished" }] }] },
        { ...options, prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "/btw" }] }] },
      ]) {
        const response = await provider.languageModel(modelId)[method](request)
        if ("stream" in response) {
          for await (const part of response.stream) if (part.type === "error") throw part.error
        }
        assert.equal(getActiveProcess(high), first.active)
        assert.equal(getClaudeSessionId(high), "keep-high")
        assert.equal(first.killed(), false)
      }
    } finally {
      deleteActiveProcess(high)
      deleteClaudeSessionId(high)
      await deleteActiveProcessAndWait(effortSessionKey(base, "low"))
      deleteClaudeSessionId(effortSessionKey(base, "low"))
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test(`${method}: effort switch rejects before touching a pending tool session`, async () => {
    const { cwd, modelId, provider, base, options } = fixture()
    const high = effortSessionKey(base, "high")
    const first = fakeActive()
    setActiveProcess(high, first.active)
    setClaudeSessionId(high, "pending-high")
    const id = `pending-integration-${method}`
    queuePendingProxyCall(high, { id, toolName: "task", input: {}, resolve() {}, reject() {} })
    options.providerOptions!["claude-code"].reasoningEffort = "low"
    options.prompt.push(
      { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "task", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "task", output: { type: "text", value: "result" } }] },
    )
    try {
      await assert.rejects(provider.languageModel(modelId)[method](options), /pending work/)
      assert.equal(getActiveProcess(high), first.active)
      assert.equal(getClaudeSessionId(high), "pending-high")
      assert.equal(first.killed(), false)
    } finally {
      resolvePendingProxyCallById(id, { kind: "text", text: "cleanup" })
      deleteActiveProcess(high)
      deleteClaudeSessionId(high)
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test(`${method}: high -> low -> high carries one claude conversation across both switches`, { timeout: 15_000 }, async () => {
    const { cwd, modelId, provider, base, options } = fixture()
    const high = effortSessionKey(base, "high")
    const low = effortSessionKey(base, "low")
    // The Claude conversation the previous turn left behind. Every switch
    // below has to resume exactly that, never start a new one. The id itself
    // changes across the fixture because the fake CLI reports its own pid as
    // the session id on every spawn (a real `--resume` keeps the id), so what
    // is asserted is the argv the switch spawned with.
    let previousClaudeSessionId: string | undefined
    try {
      for (const [index, effort] of ["high", "low", "high", "high"].entries()) {
        options.providerOptions!["claude-code"].reasoningEffort = effort
        const previous = getActiveProcess(high)
        // Separate model instances must share the same transition boundary.
        const model = provider.languageModel(modelId)
        const response = await model[method](options)
        if ("stream" in response) {
          for await (const part of response.stream) {
            if (part.type === "error") throw part.error
          }
        }
        const body = JSON.stringify(response.request?.body)
        const currentKey = effortSessionKey(base, effort as "high" | "low")
        assert.ok(getClaudeSessionId(currentKey), "the fixture must establish a remembered transcript")
        if (method === "doStream") assert.ok(getActiveProcess(currentKey), "streaming must leave a reusable process")
        if (index === 1) {
          // The high child is gone (effort is spawn-time) and so is high's
          // claim on the conversation: it moved to the low key, and the low
          // spawn continues it instead of replaying the thread (issue #91).
          assert.equal(getActiveProcess(high), undefined)
          assert.equal(getClaudeSessionId(high), undefined)
          assert.doesNotMatch(body, /conversation_history/)
          const args = getActiveProcess(low)?.cliArgs ?? []
          assert.ok(args.includes("--resume"), "the low-effort spawn resumes")
          assert.ok(
            args.includes(previousClaudeSessionId!),
            "and resumes exactly the conversation the high turn left behind",
          )
          assert.ok(
            args.includes("--model"),
            "the model still rides on the resumed spawn",
          )
        }
        if (index === 2) {
          // And back, with the low turn's answer still in the Claude
          // transcript rather than re-sent as text.
          assert.equal(getActiveProcess(low), undefined)
          assert.equal(getClaudeSessionId(low), undefined)
          assert.doesNotMatch(body, /conversation_history/)
          assert.doesNotMatch(body, /low-effort detail to remember/)
          const args = getActiveProcess(high)?.cliArgs ?? []
          assert.ok(args.includes("--resume"), "the high-effort spawn resumes it")
          assert.ok(
            args.includes(previousClaudeSessionId!),
            "and resumes exactly the conversation the low turn left behind",
          )
        }
        if (index === 3 && method === "doStream") {
          assert.equal(getActiveProcess(high), previous)
          assert.doesNotMatch(body, /conversation_history/)
        }
        previousClaudeSessionId = getClaudeSessionId(currentKey)
        options.prompt.push(
          { role: "assistant", content: [{ type: "text", text: effort === "low" ? "low-effort detail to remember" : "high answer" }] },
          { role: "user", content: [{ type: "text", text: `next request ${index}` }] },
        )
      }
    } finally {
      for (const key of [high, low]) {
        await deleteActiveProcessAndWait(key)
        deleteClaudeSessionId(key)
      }
      rmSync(cwd, { recursive: true, force: true })
    }
  })
}

test("effort changes leave other agent, provider, account, model and conversation contexts alive", { timeout: 15_000 }, async () => {
  const { cwd, modelId, provider, base, options } = fixture()
  const otherBases = [
    base.replace('"worker"', '"other-agent"'),
    base.replace('"claude-code"', '"claude-code-work"'),
    base.replace(modelId, `${modelId}@work`),
    base.replace(modelId, "claude-opus-5"),
    base.replace("::conversation::", "::another-conversation::"),
    base.replace("::tools::", "::no-tools::"),
    base.replace(cwd, `${cwd}/other`),
  ]
  const others = otherBases.map((other) => {
    const key = effortSessionKey(other, "high")
    const fake = fakeActive()
    fake.active.lineEmitter.on("line", () => {})
    setActiveProcess(key, fake.active)
    setClaudeSessionId(key, "untouched")
    return { key, ...fake }
  })
  const high = effortSessionKey(base, "high")
  setClaudeSessionId(high, "stale-high")
  options.providerOptions!["claude-code"].reasoningEffort = "low"
  try {
    const response = await provider.languageModel(modelId).doStream(options)
    for await (const part of response.stream) if (part.type === "error") throw part.error
    assert.equal(getClaudeSessionId(high), undefined)
    for (const other of others) {
      assert.equal(getActiveProcess(other.key), other.active)
      assert.equal(getClaudeSessionId(other.key), "untouched")
      assert.equal(other.killed(), false)
    }
  } finally {
    await deleteActiveProcessAndWait(effortSessionKey(base, "low"))
    deleteClaudeSessionId(effortSessionKey(base, "low"))
    deleteClaudeSessionId(high)
    for (const other of others) {
      deleteActiveProcess(other.key)
      deleteClaudeSessionId(other.key)
    }
    rmSync(cwd, { recursive: true, force: true })
  }
})
