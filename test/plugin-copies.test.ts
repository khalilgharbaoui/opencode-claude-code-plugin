/**
 * A rebuild applying without a restart on opencode 2 (h #g269): the process's
 * list of plugin copies and which one serves a turn (`src/plugin-copies.ts`),
 * the hand-over a copy does for another (`src/session-manager.ts`), the routed
 * provider the V2 entry hands opencode (`src/v2.ts`), and the stale-build note
 * going quiet for a build the process already loaded (`src/stale-build.ts`).
 *
 * Usage: npx tsx --test test/plugin-copies.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import {
  ROUTED_TURN_LIMIT_MS,
  _pluginCopiesForTests,
  _resetPluginCopiesForTests,
  processLoadedBuild,
  registerPluginCopy,
  routeTurn,
  unregisterPluginCopy,
  type PluginCopy,
  type PluginCopyTurn,
} from "../src/plugin-copies.js"
import { queuePendingProxyCall, rejectAllPendingProxyCallsForSession } from "../src/proxy-broker.js"
import type { ProxyToolCall, ProxyToolResult } from "../src/proxy-mcp.js"
import {
  deleteActiveProcess,
  deleteClaudeSessionId,
  getActiveProcess,
  getClaudeSessionId,
  noWorkInFlightHere,
  releaseIdleForHandover,
  sessionHeldHere,
  setClaudeSessionId,
  spawnClaudeProcess,
} from "../src/session-manager.js"
import { recordResumePoint, resumeStorePath } from "../src/session-resume-store.js"
import { createStaleBuildWatch, type OnDiskBuild } from "../src/stale-build.js"
import { _resetTaskModelForTests, noteExplicitTaskModels } from "../src/task-model.js"
import { _resetSessionEventRelayForTests, noteRelayMemberServing } from "../src/session-event-relay.js"
import { SESSION_AFFINITY_HEADER, V2_PLUGIN_PACKAGE, createV2Setup } from "../src/v2.js"

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const TURN: PluginCopyTurn = {
  directory: "/tmp/copies",
  providerID: "claude-code",
  modelId: "claude-haiku-4-5",
  sdkOptions: {},
}

/** One part, then done: which copy served the turn. */
function streamOf(name: string): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      controller.enqueue(name)
      controller.close()
    },
  })
}

function fakeModel(name: string): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: name,
    modelId: "claude-haiku-4-5",
    supportedUrls: {},
    doStream: async () => ({ stream: streamOf(name) }) as any,
    doGenerate: async () => ({ content: [{ type: "text", text: name }] }) as any,
  }
}

interface FakeCopy {
  copy: PluginCopy
  released: Array<string | undefined>
  setQuiet(quiet: boolean): void
  hold(sessionID: string): void
}

function fakeCopy(
  name: string,
  options: { quiet?: boolean; modelFails?: boolean; broken?: boolean } = {},
): FakeCopy {
  let quiet = options.quiet ?? true
  const held = new Set<string>()
  const released: Array<string | undefined> = []
  const copy: PluginCopy = {
    id: name,
    version: name,
    build: { entryPath: "/x/dist/index.js", mtimeMs: name.length, size: 100 },
    disposed: false,
    holds(sessionID) {
      if (options.broken) throw new Error("broken copy")
      return held.has(sessionID)
    },
    quiet() {
      if (options.broken) throw new Error("broken copy")
      return quiet
    },
    async release(sessionID) {
      released.push(sessionID)
      if (options.broken) throw new Error("broken copy")
    },
    async modelFor() {
      if (options.modelFails) throw new Error("no such provider")
      return fakeModel(name)
    },
  }
  return {
    copy,
    released,
    setQuiet: (next) => (quiet = next),
    hold: (sessionID) => held.add(sessionID),
  }
}

/** Route one turn the calling copy `own` was asked for, without reading it. */
function routeOpen(own: PluginCopy, sessionID: string | undefined, now?: () => number) {
  return routeTurn({
    own,
    turn: TURN,
    sessionID,
    runHere: async () => ({ stream: streamOf(`${own.version} here`) }),
    runOn: (model) => model.doStream({} as any) as Promise<{ stream: ReadableStream<string> }>,
    now,
  })
}

async function readAll(stream: ReadableStream<string>): Promise<string> {
  let out = ""
  for await (const part of stream as unknown as AsyncIterable<string>) out += part
  return out
}

/** Route and read one turn: which copy served it. */
async function served(own: PluginCopy, sessionID?: string): Promise<string> {
  return readAll((await routeOpen(own, sessionID)).stream)
}

function fresh(): void {
  _resetPluginCopiesForTests()
  // A copy that ran a `claude` stays in the list when disposed; the hand-over
  // tests below spawn real children.
  _resetSessionEventRelayForTests()
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test("with no copy registered a turn runs here, its result untouched", async () => {
  fresh()
  const own = fakeCopy("a").copy
  const result = { stream: streamOf("x") }
  const routed = await routeTurn({
    own,
    turn: TURN,
    sessionID: "ses_1",
    runHere: async () => result,
    runOn: async () => ({ stream: streamOf("elsewhere") }),
  })
  assert.equal(routed, result)
})

test("the first copy registered is active and serves its own turns", async () => {
  fresh()
  const a = fakeCopy("a")
  registerPluginCopy(a.copy)
  assert.equal(_pluginCopiesForTests().active, a.copy)
  assert.equal(await served(a.copy, "ses_1"), "a here")
  assert.equal(await served(a.copy), "a here", "a turn without a session too")
})

test("a newer copy takes over at the first turn that finds every older copy quiet", async () => {
  fresh()
  const a = fakeCopy("a")
  const b = fakeCopy("b")
  registerPluginCopy(a.copy)
  registerPluginCopy(b.copy)
  assert.equal(await served(a.copy, "ses_1"), "b")
  assert.equal(_pluginCopiesForTests().active, b.copy)
  assert.deepEqual(a.released, [undefined, "ses_1"], "every idle child at the switch, then the session's")
  assert.deepEqual(b.released, [])
  assert.equal(await served(b.copy, "ses_2"), "b here", "the newer copy's own model serves directly")
})

test("while an older copy has work in flight the active copy keeps serving", async () => {
  fresh()
  const a = fakeCopy("a", { quiet: false })
  const b = fakeCopy("b")
  registerPluginCopy(a.copy)
  registerPluginCopy(b.copy)
  assert.equal(await served(a.copy, "ses_1"), "a here")
  assert.equal(_pluginCopiesForTests().active, a.copy)
  a.setQuiet(true)
  assert.equal(await served(a.copy, "ses_1"), "b")
})

test("a session an older copy still holds is finished there; every other session moves", async () => {
  fresh()
  const a = fakeCopy("a")
  const b = fakeCopy("b")
  const c = fakeCopy("c")
  registerPluginCopy(a.copy)
  registerPluginCopy(b.copy)
  b.hold("ses_parked")
  registerPluginCopy(c.copy)
  assert.equal(await served(a.copy, "ses_parked"), "b", "the holder, though c is active")
  assert.equal(_pluginCopiesForTests().active, c.copy)
  assert.equal(await served(a.copy, "ses_other"), "c")
  assert.ok(c.released.includes("ses_parked"), "everyone but the holder lets go of the session")
  assert.ok(!b.released.includes("ses_parked"))
})

test("a routed turn holds the switch back until its stream ends", async () => {
  fresh()
  const a = fakeCopy("a")
  registerPluginCopy(a.copy)
  const first = await routeOpen(a.copy, "ses_1")
  registerPluginCopy(fakeCopy("b").copy)
  // a reads quiet (its child is not writing yet), but the turn was routed to it.
  assert.equal(await served(a.copy, "ses_2"), "a here")
  assert.equal(await readAll(first.stream), "a here")
  assert.equal(await served(a.copy, "ses_3"), "b")
})

test("a cancelled stream ends its routed turn too", async () => {
  fresh()
  const a = fakeCopy("a")
  registerPluginCopy(a.copy)
  const first = await routeOpen(a.copy, "ses_1")
  registerPluginCopy(fakeCopy("b").copy)
  await first.stream.cancel("stopped")
  assert.equal(await served(a.copy, "ses_2"), "b")
})

test("a routed turn older than the limit stops holding the switch back", async () => {
  fresh()
  let clock = 1_000
  const now = () => clock
  const a = fakeCopy("a")
  registerPluginCopy(a.copy)
  await routeOpen(a.copy, "ses_1", now)
  registerPluginCopy(fakeCopy("b").copy)
  assert.equal(await readAll((await routeOpen(a.copy, "ses_2", now)).stream), "a here")
  clock += ROUTED_TURN_LIMIT_MS + 1
  assert.equal(await readAll((await routeOpen(a.copy, "ses_3", now)).stream), "b")
})

test("a disposed copy is never switched to, and the newest live one is", async () => {
  fresh()
  const a = fakeCopy("a")
  const b = fakeCopy("b")
  registerPluginCopy(a.copy)
  registerPluginCopy(b.copy)
  b.copy.disposed = true
  assert.equal(await served(a.copy, "ses_1"), "a here")
  registerPluginCopy(fakeCopy("c").copy)
  assert.equal(await served(a.copy, "ses_1"), "c")
})

test("a copy that cannot build the model leaves the turn here", async () => {
  fresh()
  const a = fakeCopy("a")
  registerPluginCopy(a.copy)
  registerPluginCopy(fakeCopy("b", { modelFails: true }).copy)
  assert.equal(await served(a.copy, "ses_1"), "a here")
})

test("a broken copy costs the others nothing, and is never taken for quiet", async () => {
  fresh()
  const broken = fakeCopy("a", { broken: true })
  const b = fakeCopy("b")
  registerPluginCopy(broken.copy)
  registerPluginCopy(b.copy)
  assert.equal(await served(b.copy, "ses_1"), "a", "a copy that cannot say it is quiet stays active")
  assert.equal(_pluginCopiesForTests().active, broken.copy)
})

test("unregistering the active copy lets the next turn pick the newest", async () => {
  fresh()
  const a = fakeCopy("a")
  const b = fakeCopy("b", { quiet: false })
  registerPluginCopy(a.copy)
  registerPluginCopy(b.copy)
  unregisterPluginCopy(a.copy)
  assert.equal(_pluginCopiesForTests().active, undefined)
  assert.equal(await served(a.copy, "ses_1"), "b")
  assert.deepEqual(_pluginCopiesForTests().copies, [b.copy])
})

test("processLoadedBuild matches only a live copy imported from exactly that build", () => {
  fresh()
  const a = fakeCopy("a").copy
  registerPluginCopy(a)
  const build = { entryPath: "/x/dist/index.js", version: "a", mtimeMs: 1, size: 100 }
  assert.equal(processLoadedBuild(build), true)
  assert.equal(processLoadedBuild({ ...build, mtimeMs: 2 }), false)
  assert.equal(processLoadedBuild({ ...build, version: "b" }), false)
  assert.equal(processLoadedBuild({ ...build, entryPath: "/y/dist/index.js" }), false)
  a.disposed = true
  assert.equal(processLoadedBuild(build), false)
})

// ---------------------------------------------------------------------------
// The hand-over a copy does (src/session-manager.ts)
// ---------------------------------------------------------------------------

const keyOf = (sessionID: string, model = "claude-haiku-4-5") =>
  `/tmp/copies::${model}::tools::${sessionID}::context=["claude-code","build"]`

let callCounter = 0
function parkCall(key: string): ProxyToolCall {
  const call: ProxyToolCall = {
    id: `copies-call-${++callCounter}`,
    toolName: "bash",
    input: {},
    resolve: (_result: ProxyToolResult) => undefined,
    reject: () => undefined,
  }
  queuePendingProxyCall(key, call)
  return call
}

function idleChild(key: string) {
  return spawnClaudeProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], process.cwd(), key)
}

test("a parked call or a turn in flight holds a session; an idle child and the default bucket never", async () => {
  const key = keyOf("ses_held")
  const child = idleChild(key)
  try {
    assert.equal(sessionHeldHere("ses_held"), false, "an idle child")
    child.turnInFlight = true
    assert.equal(sessionHeldHere("ses_held"), true, "a turn in flight")
    child.turnInFlight = false
    parkCall(key)
    assert.equal(sessionHeldHere("ses_held"), true, "a parked call")
    assert.equal(sessionHeldHere("ses_other"), false)
    assert.equal(sessionHeldHere("default"), false)
  } finally {
    rejectAllPendingProxyCallsForSession(key, new Error("done"))
    deleteActiveProcess(key)
    child.proc.kill()
  }
})

test("a turn in flight anywhere, a pending call or an unclaimed task model each keep a copy busy", async () => {
  assert.equal(noWorkInFlightHere(), true)
  const key = keyOf("ses_busy")
  const child = idleChild(key)
  try {
    assert.equal(noWorkInFlightHere(), true, "an idle child is quiet")
    child.turnInFlight = true
    assert.equal(noWorkInFlightHere(), false)
    child.turnInFlight = false
    parkCall(key)
    assert.equal(noWorkInFlightHere(), false)
    rejectAllPendingProxyCallsForSession(key, new Error("done"))
    assert.equal(noWorkInFlightHere(), true)
  } finally {
    deleteActiveProcess(key)
    child.proc.kill()
  }
  const now = Date.now()
  noteExplicitTaskModels("ses_parent", [{ model: "claude-code/claude-haiku-4-5", prompt: "go" }], now)
  assert.equal(noWorkInFlightHere(), false, "a child has not claimed its model yet")
  _resetTaskModelForTests()
  assert.equal(noWorkInFlightHere(), true)
})

test("releasing a session stops its idle child and forgets it in memory, but keeps the resume record", async () => {
  const key = keyOf("ses_move")
  const otherKey = keyOf("ses_stay")
  const child = idleChild(key)
  const other = idleChild(otherKey)
  setClaudeSessionId(key, "11111111-1111-4111-8111-111111111111")
  recordResumePoint(
    key,
    "11111111-1111-4111-8111-111111111111",
    [{ role: "user", content: [{ type: "text", text: "hello" }] }] as any,
    "claude",
  )
  try {
    const exited = new Promise((resolve) => child.proc.once("exit", resolve))
    assert.deepEqual(await releaseIdleForHandover("ses_move"), [key])
    await exited
    assert.equal(getActiveProcess(key), undefined)
    assert.equal(getClaudeSessionId(key), undefined)
    const onDisk = JSON.parse(readFileSync(resumeStorePath(), "utf8")).sessions
    assert.equal(onDisk[key]?.claudeSessionId, "11111111-1111-4111-8111-111111111111")
    assert.ok(getActiveProcess(otherKey), "another session is untouched")
  } finally {
    deleteClaudeSessionId(key)
    deleteActiveProcess(otherKey)
    other.proc.kill()
  }
})

test("releasing leaves a key with work in flight alone, and with no session names every idle key", async () => {
  const busyKey = keyOf("ses_busy_release")
  const idleKey = keyOf("ses_idle_release")
  const busy = idleChild(busyKey)
  const idle = idleChild(idleKey)
  parkCall(busyKey)
  try {
    assert.deepEqual(await releaseIdleForHandover(), [idleKey])
    assert.ok(getActiveProcess(busyKey), "a parked call keeps its child")
    assert.equal(getActiveProcess(idleKey), undefined)
    assert.deepEqual(await releaseIdleForHandover("default"), [], "the shared bucket is never matched")
  } finally {
    rejectAllPendingProxyCallsForSession(busyKey, new Error("done"))
    deleteActiveProcess(busyKey)
    busy.proc.kill()
    idle.proc.kill()
  }
})

// ---------------------------------------------------------------------------
// The V2 entry (src/v2.ts)
// ---------------------------------------------------------------------------

function fakeContext() {
  const transforms: Array<(editor: any) => void> = []
  const hooks: Record<string, Array<(event: any) => unknown>> = {}
  const registration = () => ({ dispose: async () => undefined })
  const ctx = {
    app: { version: "2.1.4" },
    location: { directory: process.cwd() },
    options: {},
    provider: {
      transform: async (callback: (editor: any) => void) => {
        transforms.push(callback)
        return registration()
      },
    },
    aisdk: {
      hook: async (name: string, callback: (event: any) => unknown) => {
        ;(hooks[name] ??= []).push(callback)
        return registration()
      },
    },
    session: {
      hook: async (name: string, callback: (event: any) => unknown) => {
        ;(hooks[name] ??= []).push(callback)
        return registration()
      },
    },
  }
  return { ctx: ctx as any, transforms, hooks }
}

function fakeEditor() {
  const records = new Map<string, any>()
  return {
    list: () => [...records.values()],
    get: (id: string) => records.get(id),
    add: ({ info, models }: any) => records.set(info.id, { provider: { ...info }, models }),
    update: (id: string, update: (provider: any) => void) => update(records.get(id).provider),
    remove: (id: string) => records.delete(id),
    models: { set: () => undefined },
  }
}

async function setUpWithModel(model: LanguageModelV3) {
  const setup = createV2Setup({
    createProvider: () => {
      const provider = Object.assign((modelId: string) => provider.languageModel(modelId), {
        specificationVersion: "v3" as const,
        languageModel: () => model,
      })
      return provider
    },
    defaultProxyTools: ["Bash"],
    loadConfig: () => ({}),
  })
  const { ctx, transforms, hooks } = fakeContext()
  const cleanup = await setup(ctx)
  transforms[0](fakeEditor())
  const event: any = {
    model: { providerID: "claude-code", id: "claude-haiku-4-5" },
    package: V2_PLUGIN_PACKAGE,
    options: { name: "claude-code" },
  }
  await hooks.sdk[0](event)
  return { cleanup, sdk: event.sdk }
}

const callFor = (sessionID: string) => ({ prompt: [], headers: { [SESSION_AFFINITY_HEADER]: sessionID } }) as any

test("setup registers this copy, and the SDK it hands opencode is routed and keeps its shape", async () => {
  fresh()
  const { cleanup, sdk } = await setUpWithModel(fakeModel("inner"))
  try {
    const [copy] = _pluginCopiesForTests().copies
    assert.ok(copy, "this copy joined the process's list")
    assert.equal(_pluginCopiesForTests().active, copy)
    assert.equal(typeof sdk, "function")
    assert.equal(sdk.specificationVersion, "v3")
    const model = sdk.languageModel("claude-haiku-4-5") as LanguageModelV3
    assert.equal(model.provider, "inner")
    assert.equal(await readAll((await model.doStream(callFor("ses_1"))).stream as any), "inner")
    assert.equal(((await sdk("claude-haiku-4-5").doGenerate(callFor("ses_1"))) as any).content[0].text, "inner")
  } finally {
    await cleanup()
  }
})

test("a turn the first copy is called for runs on a newer copy once this one is quiet", async () => {
  fresh()
  const { cleanup, sdk } = await setUpWithModel(fakeModel("first"))
  try {
    const newer = fakeCopy("newer")
    registerPluginCopy(newer.copy)
    const model = sdk.languageModel("claude-haiku-4-5") as LanguageModelV3
    assert.equal(await readAll((await model.doStream(callFor("ses_1"))).stream as any), "newer")
    assert.equal(_pluginCopiesForTests().active, newer.copy)
  } finally {
    await cleanup()
  }
})

test("disposing every setup of a copy that never ran a claude takes it out; a new setup brings it back", async () => {
  fresh()
  const first = await setUpWithModel(fakeModel("inner"))
  const [copy] = _pluginCopiesForTests().copies
  await first.cleanup()
  assert.equal(copy.disposed, true)
  assert.deepEqual(_pluginCopiesForTests().copies, [])
  const second = await setUpWithModel(fakeModel("inner"))
  try {
    assert.deepEqual(_pluginCopiesForTests().copies, [copy], "the same module, set up again")
    assert.equal(copy.disposed, false)
  } finally {
    await second.cleanup()
  }
})

test("a disposed copy that ran a claude stays, and can still build its model to finish what it holds", async () => {
  fresh()
  const first = await setUpWithModel(fakeModel("inner"))
  const [copy] = _pluginCopiesForTests().copies
  noteRelayMemberServing()
  await first.cleanup()
  assert.equal(copy.disposed, true)
  assert.deepEqual(_pluginCopiesForTests().copies, [copy], "it may still hold a parked call")
  const model = await copy.modelFor({
    directory: process.cwd(),
    providerID: "claude-code",
    modelId: "claude-haiku-4-5",
    sdkOptions: { name: "claude-code" },
  })
  assert.equal(model.provider, "inner", "the live check found a disposed holder that could not")
  _resetSessionEventRelayForTests()
})

// ---------------------------------------------------------------------------
// The stale-build note (src/stale-build.ts)
// ---------------------------------------------------------------------------

test("a build another copy of this process already loaded is no reason to restart, throttled or not", () => {
  let loadedElsewhere = false
  const warned: unknown[] = []
  const onDisk: OnDiskBuild = { version: "0.63.0", mtimeMs: 2, size: 200 }
  const watch = createStaleBuildWatch({
    loaded: { version: "0.62.1", entryPath: "/x/dist/index.js", mtimeMs: 1, size: 100, loadedAt: 0 },
    readOnDisk: () => onDisk,
    now: () => 0,
    warn: (data) => warned.push(data),
    loadedElsewhere: (build) => loadedElsewhere && build === onDisk,
  })
  assert.equal(watch.check()?.kind, "version")
  assert.equal(warned.length, 1)
  loadedElsewhere = true
  assert.equal(watch.check(), null, "inside the throttle, as soon as the copy registers")
  const fresh = createStaleBuildWatch({
    loaded: { version: "0.62.1", entryPath: "/x/dist/index.js", mtimeMs: 1, size: 100, loadedAt: 0 },
    readOnDisk: () => onDisk,
    now: () => 0,
    warn: (data) => warned.push(data),
    loadedElsewhere: () => true,
  })
  assert.equal(fresh.check(), null)
  assert.equal(warned.length, 1, "and no WARN for it")
})
