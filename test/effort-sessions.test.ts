import "./isolate.js"
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
  findBusySpawnVariant,
  getActiveProcess,
  getClaudeSessionId,
  invalidateOtherSpawnVariants,
  setActiveProcess,
  setClaudeSessionId,
  sessionKey,
  spawnIdentity,
  type ActiveProcess,
} from "../src/session-manager.js"
import { markPendingProxyCallEmitted, queuePendingProxyCall, resolvePendingProxyCallById } from "../src/proxy-broker.js"
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
    invalidateOtherSpawnVariants(effortSessionKey(base, "high"))
    assert.equal(getActiveProcess(high), first.active)
    assert.equal(getClaudeSessionId(high), "old-high")
    assert.equal(first.killed(), false)

    // Effort is fixed per child, so the PROCESS has to go. The conversation
    // does not: the id moves to the key this turn will use, so the spawn
    // resumes it at the new effort instead of replaying the thread (issue #91).
    invalidateOtherSpawnVariants(effortSessionKey(base, "low"))
    assert.equal(first.killed(), true)
    assert.equal(getActiveProcess(high), undefined)
    assert.equal(getClaudeSessionId(high), undefined, "the old effort key keeps no claim on it")
    assert.equal(getClaudeSessionId(low), "old-high", "carried to the new effort key")
    assert.equal(getCompressionSummary(high), undefined)

    // Back to high: the id follows again, and the key it came from is empty.
    invalidateOtherSpawnVariants(effortSessionKey(base, "high"))
    assert.equal(getClaudeSessionId(low), undefined)
    assert.equal(getClaudeSessionId(high), "old-high")

    // A destination that already has a conversation of its own is never
    // overwritten, and the stale sibling is released rather than carried.
    setClaudeSessionId(base, "no-explicit-effort")
    invalidateOtherSpawnVariants(effortSessionKey(base, "high"))
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
    assert.throws(() => invalidateOtherSpawnVariants(effortSessionKey(base, "low")), /pending work/)
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
      assert.throws(() => invalidateOtherSpawnVariants(effortSessionKey(base, "low")), /pending work/)
      assert.equal(getActiveProcess(high), first.active)
      assert.equal(getClaudeSessionId(high), "pending-high")
      assert.equal(first.killed(), false)
      if (busy === "approval") assert.equal(hasExitPlanModeQuestions(high), true)
      // Continuation at the original effort is not blocked or invalidated.
      invalidateOtherSpawnVariants(effortSessionKey(base, "high"))
      assert.equal(getActiveProcess(high), first.active)
    } finally {
      resolvePendingProxyCallById(call.toolCallId, { kind: "text", text: "cleanup" })
      deleteActiveProcess(high)
      deleteClaudeSessionId(high)
    }
  })
}

const conversationBase = (cwd: string) =>
  sessionKey(cwd, 'claude-opus-5::tools::conversation::context=["claude-code","worker"]')
const withSpawnSettings = (base: string, ...settings: string[]) =>
  base.replace('"worker"]', `"worker",${settings.map((setting) => JSON.stringify(setting)).join(",")}]`)

test("spawnIdentity drops effort and spawn settings and keeps what names the conversation", () => {
  const base = conversationBase("/repo")
  for (const key of [
    base,
    effortSessionKey(base, "high"),
    withSpawnSettings(base, "1h"),
    effortSessionKey(withSpawnSettings(base, "5m", "maxTurns=4", "maxBudgetUsd=2"), "low"),
  ]) {
    assert.equal(spawnIdentity(key), base, key)
  }
  for (const other of [
    base.replace('"worker"', '"plan"'),
    base.replace('"claude-code"', '"claude-code-work"'),
    base.replace("claude-opus-5", "claude-sonnet-5"),
    base.replace("::conversation::", "::another-conversation::"),
    base.replace("::tools::", "::no-tools::"),
    sessionKey("/repo", "claude-opus-5::compaction::conversation"),
  ]) {
    assert.notEqual(spawnIdentity(other), base, other)
  }
})

test("a cache TTL or CLI cap change retires the old child and carries its conversation (issue #140)", () => {
  const base = conversationBase("/ttl-carry")
  const withTtl = effortSessionKey(withSpawnSettings(base, "1h"), "high")
  const withCap = withSpawnSettings(base, "maxTurns=4")
  const first = fakeActive()
  setActiveProcess(withTtl, first.active)
  setClaudeSessionId(withTtl, "ttl-conversation")
  try {
    // The agent lost its `cacheTtl` and `reasoningEffort`: a different base
    // key, which the effort-only invalidation never looked at.
    invalidateOtherSpawnVariants(base)
    assert.equal(first.killed(), true, "the old child does not keep running beside the new one")
    assert.equal(getActiveProcess(withTtl), undefined)
    assert.equal(getClaudeSessionId(withTtl), undefined)
    assert.equal(getClaudeSessionId(base), "ttl-conversation")

    invalidateOtherSpawnVariants(withCap)
    assert.equal(getClaudeSessionId(base), undefined)
    assert.equal(getClaudeSessionId(withCap), "ttl-conversation")
  } finally {
    for (const key of [base, withTtl, withCap]) {
      deleteActiveProcess(key)
      deleteClaudeSessionId(key)
    }
  }
})

test("the cleanup still refuses to retire a TTL variant parked in a proxied call", () => {
  const base = conversationBase("/ttl-pending")
  const withTtl = withSpawnSettings(base, "1h")
  const first = fakeActive()
  setActiveProcess(withTtl, first.active)
  setClaudeSessionId(withTtl, "parked-ttl")
  const id = "pending-ttl-call"
  queuePendingProxyCall(withTtl, { id, toolName: "bash", input: {}, resolve() {}, reject() {} })
  try {
    assert.throws(() => invalidateOtherSpawnVariants(base), /pending work/)
    assert.equal(first.killed(), false)
    assert.equal(getActiveProcess(withTtl), first.active)
    assert.equal(getClaudeSessionId(withTtl), "parked-ttl")
    assert.equal(getClaudeSessionId(base), undefined)
  } finally {
    resolvePendingProxyCallById(id, { kind: "text", text: "cleanup" })
    deleteActiveProcess(withTtl)
    deleteClaudeSessionId(withTtl)
  }
})

test("findBusySpawnVariant names a mid-turn spawn of the same conversation under any model or setting", () => {
  const base = conversationBase("/busy-variant")
  const requested = effortSessionKey(base, "low")
  const variants = [
    effortSessionKey(base, "high"),
    withSpawnSettings(base, "1h"),
    base.replace("claude-opus-5", "claude-sonnet-5"),
  ]
  const unrelated = [
    base.replace('"worker"', '"plan"'),
    base.replace('"claude-code"', '"claude-code-work"'),
    base.replace("claude-opus-5", "claude-opus-5@work"),
    base.replace("::conversation::", "::another-conversation::"),
    base.replace("::tools::", "::no-tools::"),
  ]
  const live = [...variants, ...unrelated].map((key) => {
    const fake = fakeActive()
    setActiveProcess(key, fake.active)
    return { key, ...fake }
  })
  try {
    assert.equal(findBusySpawnVariant(requested), undefined, "an idle variant takes nothing")
    for (const { key, active } of live) {
      active.lineEmitter.on("line", () => {})
      assert.equal(
        findBusySpawnVariant(requested),
        variants.includes(key) ? key : undefined,
        key,
      )
      active.lineEmitter.removeAllListeners("line")
    }
    // A turn already on a busy key stays there.
    const own = fakeActive()
    own.active.lineEmitter.on("line", () => {})
    setActiveProcess(requested, own.active)
    live[0].active.lineEmitter.on("line", () => {})
    assert.equal(findBusySpawnVariant(requested), undefined)
    // The shared bucket is no one conversation, so nothing is routed in it.
    const shared = base.replace("::conversation::", "::default::")
    assert.equal(findBusySpawnVariant(effortSessionKey(shared, "low")), undefined)
  } finally {
    for (const key of [requested, ...variants, ...unrelated]) deleteActiveProcess(key)
  }
})

test("resumeAcrossModelChanges: false releases the old spawn's conversation instead of carrying it", () => {
  const base = conversationBase("/no-carry")
  const high = effortSessionKey(base, "high")
  const withTtl = withSpawnSettings(base, "1h")
  const first = fakeActive()
  setActiveProcess(high, first.active)
  setClaudeSessionId(high, "released")
  try {
    invalidateOtherSpawnVariants(withTtl, { carryConversation: false })
    assert.equal(first.killed(), true)
    assert.equal(getClaudeSessionId(high), undefined)
    assert.equal(getClaudeSessionId(withTtl), undefined, "nothing is carried, so the new spawn replays")
  } finally {
    for (const key of [high, withTtl]) {
      deleteActiveProcess(key)
      deleteClaudeSessionId(key)
    }
  }
})

/** A child the routed turn can talk to: it takes writes and reports kills. */
function scriptedActive() {
  let killed = false
  const active: ActiveProcess = {
    proc: Object.assign(new EventEmitter(), {
      stdin: { write: () => true },
      kill: () => { killed = true; return true },
    }) as unknown as ChildProcess,
    lineEmitter: new EventEmitter(),
    unattendedLines: [],
  }
  return { active, killed: () => killed }
}

/**
 * Runs a tool-result turn against a child parked in call `id`, and ends it the
 * way the CLI would once the call is answered. Returns what the call got.
 */
async function answerParkedCall(
  run: () => Promise<unknown>,
  active: ActiveProcess,
  answered: () => boolean,
): Promise<unknown> {
  const pending = run()
  for (let attempt = 0; attempt < 200 && !answered(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(answered(), "the parked call got this turn's tool result")
  active.lineEmitter.emit("line", JSON.stringify({ type: "result", session_id: "parked", is_error: false }))
  const response = await pending
  if (response && typeof response === "object" && "stream" in response) {
    for await (const part of (response as { stream: ReadableStream<{ type: string; error?: unknown }> }).stream) {
      if (part.type === "error") throw part.error
    }
  }
  return response
}

function fixture(settings: Record<string, unknown> = {}) {
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
    ...settings,
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

  test(`${method}: an effort switch mid-turn finishes that turn on the old child, then applies (h #g271)`, { timeout: 15_000 }, async () => {
    const { cwd, modelId, provider, base, options } = fixture()
    const high = effortSessionKey(base, "high")
    const low = effortSessionKey(base, "low")
    const first = scriptedActive()
    setActiveProcess(high, first.active)
    setClaudeSessionId(high, "pending-high")
    const id = `pending-integration-${method}`
    let delivered: unknown
    queuePendingProxyCall(high, {
      id, toolName: "read", input: {}, channel: { closed: false },
      resolve(result) { delivered = result }, reject() {},
    })
    markPendingProxyCallEmitted(id)
    options.providerOptions!["claude-code"].reasoningEffort = "low"
    options.prompt.push(
      { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "read", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "read", output: { type: "text", value: "result" } }] },
    )
    try {
      await answerParkedCall(() => provider.languageModel(modelId)[method](options), first.active, () => delivered !== undefined)
      assert.equal(first.killed(), false, "the turn in flight was not cut")
      assert.equal(getActiveProcess(high), first.active)
      assert.equal(getActiveProcess(low), undefined, "and nothing spawned beside it")

      // The next fresh message finds the old child idle: it goes, and the new
      // effort's spawn resumes the same conversation.
      options.prompt.push(
        { role: "assistant", content: [{ type: "text", text: "read it" }] },
        { role: "user", content: [{ type: "text", text: "next request" }] },
      )
      const held = getClaudeSessionId(high)
      assert.ok(held, "the old key still holds the conversation after its turn")
      const next = await provider.languageModel(modelId)[method](options)
      if ("stream" in next) for await (const part of next.stream) if (part.type === "error") throw part.error
      assert.equal(first.killed(), true)
      assert.equal(getActiveProcess(high), undefined)
      const args = getActiveProcess(low)?.cliArgs ?? []
      assert.ok(args.includes("--resume"), "the new effort's spawn resumes")
      assert.ok(args.includes(held!), "exactly the conversation the old child held")
      assert.doesNotMatch(JSON.stringify(next.request?.body), /conversation_history/)
    } finally {
      resolvePendingProxyCallById(id, { kind: "text", text: "cleanup" })
      deleteActiveProcess(high)
      deleteClaudeSessionId(high)
      await deleteActiveProcessAndWait(low)
      deleteClaudeSessionId(low)
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

test("doStream: dropping the agent's cacheTtl and effort leaves one child, resuming the same conversation (issue #140)", { timeout: 15_000 }, async () => {
  const { cwd, modelId, provider, base, options } = fixture()
  // What the previous turn ran under, while the agent still declared
  // `cacheTtl: 1h` and `reasoningEffort: high`.
  const before = effortSessionKey(withSpawnSettings(base, "1h"), "high")
  const first = fakeActive()
  setActiveProcess(before, first.active)
  setClaudeSessionId(before, "ttl-conversation")
  options.prompt.push(
    { role: "assistant", content: [{ type: "text", text: "high answer" }] },
    { role: "user", content: [{ type: "text", text: "next request" }] },
  )
  try {
    const response = await provider.languageModel(modelId).doStream(options)
    for await (const part of response.stream) if (part.type === "error") throw part.error
    assert.equal(first.killed(), true, "the old child is ended before the new one spawns")
    assert.equal(getActiveProcess(before), undefined)
    assert.equal(getClaudeSessionId(before), undefined)
    const args = getActiveProcess(base)?.cliArgs ?? []
    assert.ok(args.includes("--resume"), "the new child resumes")
    assert.ok(args.includes("ttl-conversation"), "the conversation the old child held")
    assert.doesNotMatch(JSON.stringify(response.request?.body), /conversation_history/)
  } finally {
    await deleteActiveProcessAndWait(base)
    deleteClaudeSessionId(base)
    deleteActiveProcess(before)
    deleteClaudeSessionId(before)
    rmSync(cwd, { recursive: true, force: true })
  }
})

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
    // A busy child on another model of this same conversation would take the
    // turn instead (h #g271), so that one is idle here. It must survive the
    // effort change all the same.
    if (!other.includes("::claude-opus-5::")) fake.active.lineEmitter.on("line", () => {})
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

test("doStream: a model change mid-turn finishes that turn on the old model's child (h #g271)", { timeout: 15_000 }, async () => {
  const { cwd, modelId, provider, base, options } = fixture()
  const otherModel = base.replace(`::${modelId}::`, "::claude-sonnet-4-5::")
  const first = scriptedActive()
  setActiveProcess(otherModel, first.active)
  setClaudeSessionId(otherModel, "pending-sonnet")
  const id = "pending-model-change"
  let delivered: unknown
  queuePendingProxyCall(otherModel, {
    id, toolName: "read", input: {}, channel: { closed: false },
    resolve(result) { delivered = result }, reject() {},
  })
  markPendingProxyCallEmitted(id)
  options.prompt.push(
    { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "read", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "read", output: { type: "text", value: "result" } }] },
  )
  try {
    await answerParkedCall(() => provider.languageModel(modelId).doStream(options), first.active, () => delivered !== undefined)
    assert.equal(first.killed(), false)
    assert.equal(getActiveProcess(otherModel), first.active)
    assert.equal(getActiveProcess(base), undefined, "no second child beside the busy one")
  } finally {
    resolvePendingProxyCallById(id, { kind: "text", text: "cleanup" })
    deleteActiveProcess(otherModel)
    deleteClaudeSessionId(otherModel)
    await deleteActiveProcessAndWait(base)
    deleteClaudeSessionId(base)
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("doStream: with resumeAcrossModelChanges false an effort change replays instead of resuming", { timeout: 15_000 }, async () => {
  const { cwd, modelId, provider, base, options } = fixture({ resumeAcrossModelChanges: false })
  const high = effortSessionKey(base, "high")
  const low = effortSessionKey(base, "low")
  const first = fakeActive()
  setActiveProcess(high, first.active)
  setClaudeSessionId(high, "not-carried")
  options.providerOptions!["claude-code"].reasoningEffort = "low"
  options.prompt.push(
    { role: "assistant", content: [{ type: "text", text: "high answer" }] },
    { role: "user", content: [{ type: "text", text: "next request" }] },
  )
  try {
    const response = await provider.languageModel(modelId).doStream(options)
    for await (const part of response.stream) if (part.type === "error") throw part.error
    assert.equal(first.killed(), true, "the old child still goes")
    assert.equal(getClaudeSessionId(high), undefined)
    assert.ok(!(getActiveProcess(low)?.cliArgs ?? []).includes("not-carried"), "its conversation is not resumed")
    assert.match(JSON.stringify(response.request?.body), /conversation_history/)
  } finally {
    await deleteActiveProcessAndWait(low)
    deleteClaudeSessionId(low)
    deleteActiveProcess(high)
    deleteClaudeSessionId(high)
    rmSync(cwd, { recursive: true, force: true })
  }
})
