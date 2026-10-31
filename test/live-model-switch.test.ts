/**
 * A model or reasoning effort change applied to the live `claude` process with
 * `set_model` and `apply_flag_settings` instead of a respawn (h #g278).
 *
 * The unit half drives `planLiveSwitch`, the `--effort` spawn form, the
 * version gate, `findLiveSwitchSource`'s refusals and the proxy server's
 * rebind. The end-to-end half drives real `doStream` turns through a fake CLI
 * that answers (or refuses, or ignores) the control requests, and reads what
 * it was spawned with and what it was sent.
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"

import { planLiveSwitch } from "../src/live-switch.js"
import {
  buildCliArgs,
  claudeSpawnEnv,
  deleteActiveProcess,
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  findLiveSwitchSource,
  getActiveProcess,
  getClaudeSessionId,
  noteTurnStarted,
  sessionKey,
  setActiveProcess,
  noteTurnLine,
  setClaudeSessionId,
  type ActiveProcess,
} from "../src/session-manager.js"
import { cliSupportsLiveModelSwitch, detectCliVersion } from "../src/cli-version.js"
import { ensureProxyServer, rebindProxyServer } from "../src/spawn-planning.js"
import { getPendingProxyCalls, rejectAllPendingProxyCallsForSession } from "../src/proxy-broker.js"
import { _setResumeStorePath } from "../src/session-resume-store.js"
import { encodeCwd } from "../src/claude-session-bun.js"
import { createClaudeCode } from "../src/index.js"

const CONTEXT = 'context=["claude-code",null]'
const userText = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as any
const assistantText = (text: string) =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as any
const BEFORE = [userText("The codename is MARLIN. Reply OK.")] as any
const AFTER = [...BEFORE, assistantText("OK"), userText("What is the codename?")] as any

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

const switchable = { model: "claude-a", fast: false, effortFlag: true }

test("planLiveSwitch sends only what changed", () => {
  assert.deepEqual(
    planLiveSwitch({ liveSwitch: switchable, effort: "high" }, { model: "claude-b", fast: false, effort: "high" }),
    { kind: "switch", setModel: "claude-b" },
  )
  assert.deepEqual(
    planLiveSwitch({ liveSwitch: switchable, effort: "high" }, { model: "claude-a", fast: false, effort: "low" }),
    { kind: "switch", effortLevel: "low" },
  )
  assert.deepEqual(
    planLiveSwitch({ liveSwitch: switchable, effort: "high" }, { model: "claude-b", fast: false, effort: "max" }),
    { kind: "switch", setModel: "claude-b", effortLevel: "max" },
  )
  // `minimal` is the plugin's own step and lands on the CLI's `low`.
  assert.deepEqual(
    planLiveSwitch({ liveSwitch: switchable, effort: "low" }, { model: "claude-a", fast: false, effort: "minimal" }),
    { kind: "switch" },
  )
})

test("planLiveSwitch refuses what a control request cannot change", () => {
  const reason = (child: Parameters<typeof planLiveSwitch>[0], target: Parameters<typeof planLiveSwitch>[1]) => {
    const plan = planLiveSwitch(child, target)
    return plan.kind === "refuse" ? plan.reason : "switch"
  }
  assert.equal(reason({ effort: "high" }, { model: "claude-b", fast: false, effort: "high" }), "not-switchable")
  assert.equal(
    reason({ liveSwitch: switchable, effort: "high" }, { model: "claude-b", fast: true, effort: "high" }),
    "fast-mode-differs",
  )
  // Clearing an effort falls to the model's default, not to what a spawn with
  // no effort would inherit, and setting one beside an inherited shell export
  // would lose to it: both respawn.
  assert.equal(
    reason({ liveSwitch: switchable, effort: undefined }, { model: "claude-a", fast: false, effort: "high" }),
    "effort-unset",
  )
  assert.equal(
    reason({ liveSwitch: switchable, effort: "high" }, { model: "claude-a", fast: false, effort: undefined }),
    "effort-unset",
  )
  // An effort carried by CLAUDE_CODE_EFFORT_LEVEL beats `apply_flag_settings`.
  assert.equal(
    reason(
      { liveSwitch: { ...switchable, effortFlag: false }, effort: "high" },
      { model: "claude-a", fast: false, effort: "low" },
    ),
    "effort-not-a-flag",
  )
})

test("a spawn that can switch live carries its effort as --effort and drops the shell's variable", () => {
  const args = buildCliArgs({ sessionKey: "k", skipPermissions: true, model: "claude-a", effort: "high" })
  assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "high"])
  assert.equal(buildCliArgs({ sessionKey: "k", skipPermissions: true, model: "claude-a" }).includes("--effort"), false)

  const saved = process.env.CLAUDE_CODE_EFFORT_LEVEL
  process.env.CLAUDE_CODE_EFFORT_LEVEL = "max"
  try {
    assert.equal("CLAUDE_CODE_EFFORT_LEVEL" in claudeSpawnEnv({ effort: "high", effortViaFlag: true }), false)
    assert.equal(claudeSpawnEnv({ effort: "high" }).CLAUDE_CODE_EFFORT_LEVEL, "high")
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = saved
  }
})

test("the live switch is gated at 2.1.288, the oldest CLI it was run on", () => {
  const v = (patch: number) => ({ major: 2, minor: 1, patch, raw: `2.1.${patch}` })
  assert.equal(cliSupportsLiveModelSwitch(null), false)
  assert.equal(cliSupportsLiveModelSwitch(v(287)), false)
  assert.equal(cliSupportsLiveModelSwitch(v(288)), true)
  assert.equal(cliSupportsLiveModelSwitch(v(314)), true)
})

function fakeProcess(extra: Partial<ActiveProcess> = {}): ActiveProcess {
  return {
    proc: { exitCode: null, signalCode: null, killed: false, kill() {}, on() {}, off() {} } as any,
    lineEmitter: new EventEmitter(),
    liveSwitch: { model: "claude-a", fast: false, effortFlag: true },
    effort: "high",
    ...extra,
  }
}

test("findLiveSwitchSource finds this conversation's one idle child and refuses the rest", () => {
  const cwd = "/tmp/live-switch-units"
  const key = (model: string, effort?: string, affinity = "ses_live", context = CONTEXT) =>
    sessionKey(cwd, `${model}::tools::${affinity}::${context}`) + (effort ? `::effort=${effort}` : "")
  const used: string[] = []
  const put = (k: string, ap: ActiveProcess, session = true) => {
    used.push(k)
    setActiveProcess(k, ap)
    if (session) setClaudeSessionId(k, `claude-${used.length}`)
    return ap
  }
  try {
    assert.deepEqual(findLiveSwitchSource(key("claude-b", "high")), { kind: "none" })

    const child = put(key("claude-a", "high"), fakeProcess())
    const found = findLiveSwitchSource(key("claude-b", "low"))
    assert.equal(found.kind, "source")
    assert.equal(found.kind === "source" && found.fromKey, key("claude-a", "high"))

    // Never another account, another opencode session, another TTL, or the
    // shared `default` affinity: all of them differ in more than model and effort.
    assert.deepEqual(findLiveSwitchSource(key("claude-b@work", "high")), { kind: "none" })
    assert.deepEqual(findLiveSwitchSource(key("claude-b", "high", "ses_other")), { kind: "none" })
    assert.deepEqual(
      findLiveSwitchSource(key("claude-b", "high", "ses_live", 'context=["claude-code",null,"1h"]')),
      { kind: "none" },
    )
    assert.deepEqual(findLiveSwitchSource(key("claude-b", "high", "default")), { kind: "none" })

    const refusal = (target = key("claude-b", "low")) => {
      const result = findLiveSwitchSource(target)
      return result.kind === "refused" ? result.reason : result.kind
    }
    noteTurnStarted(child)
    assert.equal(refusal(), "busy")
    noteTurnLine(child, JSON.stringify({ type: "result", subtype: "success" }))
    assert.equal(refusal(), "source")

    child.liveSwitch = undefined
    assert.equal(refusal(), "not-switchable")
    child.liveSwitch = { model: "claude-a", fast: false, effortFlag: true }
    child.interactiveControl = { turnRunning: () => false } as any
    assert.equal(refusal(), "interactive-transport")
    delete child.interactiveControl

    deleteClaudeSessionId(key("claude-a", "high"))
    assert.equal(refusal(), "no-session")
    setClaudeSessionId(key("claude-a", "high"), "claude-1")

    // A key that already has a conversation of its own is not a switch at all.
    setClaudeSessionId(key("claude-b", "low"), "claude-own")
    used.push(key("claude-b", "low"))
    assert.equal(refusal(), "none")
    deleteClaudeSessionId(key("claude-b", "low"))

    put(key("claude-c"), fakeProcess())
    assert.equal(refusal(), "several-children")
  } finally {
    for (const k of used) {
      deleteActiveProcess(k)
      deleteClaudeSessionId(k)
    }
  }
})

test("a rebound proxy server queues its calls under the child's new key", async () => {
  const server = await ensureProxyServer({ provider: "claude-code" } as any, [], "live-key-a", false)
  try {
    assert.equal(rebindProxyServer(server, "live-key-b"), true)
    server.calls.emit("call", {
      id: "live-call-1",
      toolName: "bash",
      input: {},
      resolve() {},
      reject() {},
    })
    assert.equal(getPendingProxyCalls("live-key-a").length, 0)
    assert.equal(getPendingProxyCalls("live-key-b").length, 1)
  } finally {
    rejectAllPendingProxyCallsForSession("live-key-b", new Error("test over"))
    await server.close()
  }
})

// ---------------------------------------------------------------------------
// End to end: real doStream turns through a fake CLI.
// ---------------------------------------------------------------------------

function createLiveCli(options: {
  version?: string
  control?: "answer" | "refuse" | "silent"
  liveModelSwitch?: boolean
} = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-live-switch-"))
  const configDir = join(cwd, "claude-config")
  const cliPath = join(cwd, "fake-claude.cjs")
  const eventsPath = join(cwd, "events.jsonl")
  writeFileSync(eventsPath, "")
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
const args = process.argv.slice(2)
const record = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + "\\n")
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
if (args.includes("--version")) {
  process.stdout.write(${JSON.stringify((options.version ?? "2.1.314") + "\n")})
  process.exit(0)
}
if (args.includes("--help")) process.exit(0)
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
const sessionId = flag("--resume") ?? "claude-live-1"
let model = flag("--model")
let effort = flag("--effort") ?? process.env.CLAUDE_CODE_EFFORT_LEVEL ?? null
record({ type: "spawn", pid: process.pid, args, sessionId, effortEnv: process.env.CLAUDE_CODE_EFFORT_LEVEL ?? null })
const mode = ${JSON.stringify(options.control ?? "answer")}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (message.type === "control_request") {
    const request = message.request
    record({ type: "control", pid: process.pid, request })
    const ok = (response) => emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id, ...(response ? { response } : {}) } })
    if (request.subtype === "interrupt") return ok()
    if (mode === "silent") return
    if (mode === "refuse") return emit({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "not now" } })
    if (request.subtype === "set_model") { model = request.model; return ok({ model }) }
    if (request.subtype === "apply_flag_settings") { effort = request.settings.effortLevel; return ok() }
    return ok()
  }
  if (message.type !== "user") return
  record({ type: "input", pid: process.pid, sessionId })
  emit({ type: "system", subtype: "init", session_id: sessionId, model })
  emit({ type: "assistant", session_id: sessionId, message: { role: "assistant", model, stop_reason: "end_turn", content: [{ type: "text", text: "model=" + model + " effort=" + effort }] } })
  emit({ type: "result", subtype: "success", session_id: sessionId, is_error: false, usage: { input_tokens: 9, output_tokens: 4 } })
})
`,
    { mode: 0o755 },
  )
  _setResumeStorePath(join(cwd, "state", "claude-sessions.json"))

  const provider = createClaudeCode({
    cliPath,
    cwd,
    configDir,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    interactive: false,
    autoContinueIncompleteTurns: false,
    ...(options.liveModelSwitch === undefined ? {} : { liveModelSwitch: options.liveModelSwitch }),
  } as any)

  const keys = new Set<string>()
  const key = (modelId: string, effort?: string) => {
    const k = sessionKey(cwd, `${modelId}::tools::ses_live::${CONTEXT}`) + (effort ? `::effort=${effort}` : "")
    keys.add(k)
    return k
  }
  const events = () =>
    readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as any)

  return {
    key,
    events,
    spawns: () => events().filter((event) => event.type === "spawn"),
    controls: () =>
      events()
        .filter((event) => event.type === "control" && event.request.subtype !== "interrupt")
        .map((event) => event.request),
    writeTranscript(id: string) {
      const dir = join(configDir, "projects", encodeCwd(cwd))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${id}.jsonl`), "")
    },
    async turn(modelId: string, prompt: any[], effort?: string) {
      key(modelId, effort)
      const call: LanguageModelV3CallOptions = {
        prompt,
        headers: { "x-session-affinity": "ses_live" },
        tools: [{ type: "function", name: "read", inputSchema: { type: "object", properties: {} } }],
        abortSignal: AbortSignal.timeout(30_000),
        ...(effort ? { providerOptions: { "claude-code": { reasoningEffort: effort } } } : {}),
      } as any
      const response = await provider.languageModel(modelId).doStream(call)
      let text = ""
      for await (const part of response.stream as AsyncIterable<LanguageModelV3StreamPart>) {
        if (part.type === "error") throw (part as any).error
        if (part.type === "text-delta") text += part.delta
      }
      return text
    },
    async warm() {
      for (let attempt = 1; attempt <= 4; attempt++) {
        if (await detectCliVersion(cliPath)) return
      }
      throw new Error("the fake CLI never answered --version")
    },
    async cleanup() {
      for (const k of keys) {
        await deleteActiveProcessAndWait(k)
        deleteClaudeSessionId(k)
      }
      _setResumeStorePath(null)
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function eventually(what: string, check: () => boolean, ms = 5_000) {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test("a model change is applied to the live claude process instead of respawning it", {
  timeout: 60_000,
}, async () => {
  const fake = createLiveCli()
  try {
    await fake.warm()
    await fake.turn("claude-live-first", BEFORE)
    const text = await fake.turn("claude-live-second", AFTER)

    assert.equal(fake.spawns().length, 1, "one child for the whole conversation")
    assert.deepEqual(fake.controls(), [{ subtype: "set_model", model: "claude-live-second" }])
    assert.match(text, /model=claude-live-second/)

    const moved = getActiveProcess(fake.key("claude-live-second"))
    assert.equal(moved?.proc.pid, fake.spawns()[0].pid, "the same child, under the new key")
    assert.equal(moved?.sessionKey, fake.key("claude-live-second"))
    assert.equal(getActiveProcess(fake.key("claude-live-first")), undefined)
    assert.equal(getClaudeSessionId(fake.key("claude-live-second")), "claude-live-1")
    assert.equal(getClaudeSessionId(fake.key("claude-live-first")), undefined, "moved, not copied")
    const args = moved!.cliArgs!
    assert.equal(args[args.indexOf("--model") + 1], "claude-live-second", "a watchdog respawn keeps the new model")
  } finally {
    await fake.cleanup()
  }
})

test("an effort change is applied with apply_flag_settings, and the spawn's effort is a flag", {
  timeout: 60_000,
}, async () => {
  const saved = process.env.CLAUDE_CODE_EFFORT_LEVEL
  // A shell export would beat a live change; the spawn has to drop it.
  process.env.CLAUDE_CODE_EFFORT_LEVEL = "max"
  const fake = createLiveCli()
  try {
    await fake.warm()
    await fake.turn("claude-live-first", BEFORE, "high")
    const [spawn] = fake.spawns()
    assert.deepEqual(spawn.args.slice(spawn.args.indexOf("--effort"), spawn.args.indexOf("--effort") + 2), [
      "--effort",
      "high",
    ])
    assert.equal(spawn.effortEnv, null, "CLAUDE_CODE_EFFORT_LEVEL is not passed to a flag-effort spawn")

    const text = await fake.turn("claude-live-first", AFTER, "low")
    assert.equal(fake.spawns().length, 1)
    assert.deepEqual(fake.controls(), [{ subtype: "apply_flag_settings", settings: { effortLevel: "low" } }])
    assert.match(text, /effort=low/)
    const moved = getActiveProcess(fake.key("claude-live-first", "low"))!
    assert.equal(moved.effort, "low")
    assert.equal(moved.cliArgs![moved.cliArgs!.indexOf("--effort") + 1], "low")
    assert.equal(getActiveProcess(fake.key("claude-live-first", "high")), undefined)
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = saved
    await fake.cleanup()
  }
})

test("a model and effort change together are both applied to the one child", { timeout: 60_000 }, async () => {
  const fake = createLiveCli()
  try {
    await fake.warm()
    await fake.turn("claude-live-first", BEFORE, "high")
    const text = await fake.turn("claude-live-second", AFTER, "max")
    assert.equal(fake.spawns().length, 1)
    assert.deepEqual(fake.controls(), [
      { subtype: "set_model", model: "claude-live-second" },
      { subtype: "apply_flag_settings", settings: { effortLevel: "max" } },
    ])
    assert.match(text, /model=claude-live-second effort=max/)
  } finally {
    await fake.cleanup()
  }
})

test("a refused set_model falls back to today's respawn with --resume", { timeout: 60_000 }, async () => {
  const fake = createLiveCli({ control: "refuse" })
  try {
    await fake.warm()
    await fake.turn("claude-live-first", BEFORE)
    fake.writeTranscript("claude-live-1")
    const text = await fake.turn("claude-live-second", AFTER)

    const spawns = fake.spawns()
    assert.equal(spawns.length, 2)
    const args: string[] = spawns[1].args
    assert.deepEqual(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2), ["--resume", "claude-live-1"])
    assert.equal(args[args.indexOf("--model") + 1], "claude-live-second")
    assert.match(text, /model=claude-live-second/)
    // Sent a request it did not confirm, so it may be half-switched: stopped.
    await eventually("the first child to exit", () => !isAlive(spawns[0].pid))
  } finally {
    await fake.cleanup()
  }
})

test("an unanswered control request times out and the child is replaced", { timeout: 60_000 }, async () => {
  const saved = process.env.CLAUDE_CODE_LIVE_SWITCH_TIMEOUT_MS
  process.env.CLAUDE_CODE_LIVE_SWITCH_TIMEOUT_MS = "300"
  const fake = createLiveCli({ control: "silent" })
  try {
    await fake.warm()
    await fake.turn("claude-live-first", BEFORE, "high")
    const started = Date.now()
    const text = await fake.turn("claude-live-first", AFTER, "low")
    assert.ok(Date.now() - started < 10_000, "the timeout, not the default 10 s")
    const spawns = fake.spawns()
    assert.equal(spawns.length, 2)
    assert.deepEqual(spawns[1].args.slice(spawns[1].args.indexOf("--effort"), spawns[1].args.indexOf("--effort") + 2), [
      "--effort",
      "low",
    ])
    assert.ok(spawns[1].args.includes("--resume"), "the conversation is carried, as it always was")
    assert.match(text, /effort=low/)
    await eventually("the first child to exit", () => !isAlive(spawns[0].pid))
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_LIVE_SWITCH_TIMEOUT_MS
    else process.env.CLAUDE_CODE_LIVE_SWITCH_TIMEOUT_MS = saved
    await fake.cleanup()
  }
})

test("liveModelSwitch: false keeps the respawn and the env-var effort exactly", { timeout: 60_000 }, async () => {
  const fake = createLiveCli({ liveModelSwitch: false })
  try {
    await fake.warm()
    await fake.turn("claude-live-first", BEFORE, "high")
    await fake.turn("claude-live-first", AFTER, "low")
    const spawns = fake.spawns()
    assert.equal(spawns.length, 2)
    assert.equal(spawns[0].args.includes("--effort"), false)
    assert.equal(spawns[0].effortEnv, "high")
    assert.equal(spawns[1].effortEnv, "low")
    assert.deepEqual(fake.controls(), [])
  } finally {
    await fake.cleanup()
  }
})

test("a CLI older than 2.1.288 is never sent --effort or a control request", { timeout: 60_000 }, async () => {
  const fake = createLiveCli({ version: "2.1.287" })
  try {
    await fake.warm()
    await fake.turn("claude-live-first", BEFORE, "high")
    await fake.turn("claude-live-first", AFTER, "low")
    const spawns = fake.spawns()
    assert.equal(spawns.length, 2)
    assert.equal(spawns[0].args.includes("--effort"), false)
    assert.equal(spawns[0].effortEnv, "high")
    assert.deepEqual(fake.controls(), [])
  } finally {
    await fake.cleanup()
  }
})

test("an effort set where there was none respawns, so a shell export cannot win silently", {
  timeout: 60_000,
}, async () => {
  const fake = createLiveCli()
  try {
    await fake.warm()
    await fake.turn("claude-live-first", BEFORE)
    await fake.turn("claude-live-first", AFTER, "high")
    const spawns = fake.spawns()
    assert.equal(spawns.length, 2)
    assert.deepEqual(fake.controls(), [])
    assert.ok(spawns[1].args.includes("--resume"))
    assert.equal(spawns[1].args[spawns[1].args.indexOf("--effort") + 1], "high")
  } finally {
    await fake.cleanup()
  }
})
