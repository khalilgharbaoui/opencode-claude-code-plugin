/**
 * opencode 2's `/connect` entry and the turn-retry opt-out (src/v2-connect.ts,
 * src/v2.ts, h #g277). The fake integration editor behaves the way opencode
 * 2.2.5's does: it holds only what plugins declared, `get` answers undefined
 * for the entry opencode derives from a provider, and `update` creates a
 * record. The live runs that established that are in the history entry.
 *
 * Usage: npx tsx --test test/v2-connect.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import type { ClaudeLoginState } from "../src/claude-login.js"
import type { V2Event, V2IntegrationMethod } from "../src/opencode-v2-types.js"
import { createV2Setup } from "../src/v2.js"
import {
  CONNECT_METHOD_ID,
  CONNECT_METHOD_LABEL,
  SEED_INTEGRATION_NAME,
  _resetConnectChecksForTests,
  applyConnectEntries,
  followConnectEvents,
  loginCommandForTarget,
  refreshConnection,
  switchedCredential,
  type ConnectTarget,
  type ConnectWiring,
} from "../src/v2-connect.js"

const PROXY_TOOLS = ["Bash", "Edit", "Write", "WebFetch", "Task"]

beforeEach(() => _resetConnectChecksForTests())

function fakeIntegrationEditor() {
  const records = new Map<string, { ref: { id: string; name: string }; methods: V2IntegrationMethod[] }>()
  const editor = {
    get: (id: string) => records.get(id)?.ref,
    update: (id: string, update: (integration: { id: string; name: string }) => void) => {
      const record = records.get(id) ?? { ref: { id, name: id }, methods: [] }
      records.set(id, record)
      update(record.ref)
      record.ref.id = id
    },
    method: {
      list: (id: string) => records.get(id)?.methods ?? [],
      update: (input: { integrationID: string; method: V2IntegrationMethod }) => {
        const record = records.get(input.integrationID) ?? {
          ref: { id: input.integrationID, name: input.integrationID },
          methods: [],
        }
        records.set(input.integrationID, record)
        const index = record.methods.findIndex((m) => m.type === input.method.type && m.id === input.method.id)
        if (index === -1) record.methods.push(input.method)
        else record.methods[index] = input.method
      },
      remove: (id: string, method: V2IntegrationMethod) => {
        const record = records.get(id)
        if (record) record.methods = record.methods.filter((m) => m !== method)
      },
    },
  }
  return { records, editor }
}

function fakeIntegration(active: Record<string, { type: string; id: string; label: string }> = {}) {
  const statuses: Array<{ integrationID: string; connection: unknown; status: unknown }> = []
  const transforms: Array<(editor: any) => void> = []
  const asked: string[] = []
  return {
    statuses,
    transforms,
    asked,
    domain: {
      transform: async (callback: (editor: any) => void) => {
        transforms.push(callback)
        return { dispose: async () => undefined }
      },
      connection: {
        active: async (id: string) => {
          asked.push(id)
          return active[id]
        },
        status: async (input: { integrationID: string; connection: unknown; status: unknown }) => {
          statuses.push(input)
        },
      },
    },
  }
}

const TARGET: ConnectTarget = { id: "claude-code", name: "Claude Code", settings: { cliPath: "claude" } }
const WORK: ConnectTarget = {
  id: "claude-code-work",
  name: "Claude Code (Work)",
  settings: { cliPath: "/wrapper", baseCliPath: "claude", account: "work" },
}
const CONNECTION = { type: "credential", id: "cred_1", label: "Claude Code" }

function wiringFor(
  integration: ReturnType<typeof fakeIntegration>,
  states: ClaudeLoginState[],
  targets: ConnectTarget[] = [TARGET],
) {
  const notices: Array<{ level: string; message: string }> = []
  let checks = 0
  let clock = 1_000_000
  const wiring: ConnectWiring & { tick(ms: number): void } = {
    integration: integration.domain,
    targets: () => targets,
    notify: (level, message) => notices.push({ level, message }),
    check: async () => {
      checks += 1
      return states[Math.min(checks - 1, states.length - 1)]
    },
    now: () => clock,
    tick: (ms: number) => {
      clock += ms
    },
  }
  return { wiring, notices, checks: () => checks }
}

const IN: ClaudeLoginState = {
  status: "logged-in",
  auth: { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" },
}
const OUT: ClaudeLoginState = { status: "logged-out", auth: { loggedIn: false, authMethod: "none" } }

test("each provider's /connect entry gets its name and the external method, once", () => {
  const { records, editor } = fakeIntegrationEditor()
  applyConnectEntries(editor, [TARGET])
  applyConnectEntries(editor, [TARGET])
  const record = records.get("claude-code")!
  assert.equal(record.ref.name, "Claude Code")
  assert.deepEqual(record.methods, [{ id: CONNECT_METHOD_ID, type: "external", label: CONNECT_METHOD_LABEL }])
})

test("with accounts the seed's entry is kept, named, and offers nothing to connect", () => {
  const { records, editor } = fakeIntegrationEditor()
  applyConnectEntries(editor, [WORK])
  assert.deepEqual(records.get("claude-code")?.ref.name, SEED_INTEGRATION_NAME)
  assert.deepEqual(records.get("claude-code")?.methods, [])
  assert.equal(records.get("claude-code-work")?.methods.length, 1)
})

test("an account's fix names its config dir", () => {
  assert.equal(loginCommandForTarget(TARGET), "claude auth login")
  // `~/.claude-work` on POSIX; Windows spells the home directory its own way.
  assert.match(loginCommandForTarget(WORK), /^CLAUDE_CONFIG_DIR=\S*\.claude-work claude auth login$/)
  if (process.platform !== "win32") {
    assert.equal(loginCommandForTarget(WORK), "CLAUDE_CONFIG_DIR=~/.claude-work claude auth login")
  }
})

test("no connection and nothing to announce spawns nothing", async () => {
  const integration = fakeIntegration()
  const { wiring, checks, notices } = wiringFor(integration, [OUT])
  assert.equal(await refreshConnection(wiring, TARGET), undefined)
  assert.equal(checks(), 0)
  assert.deepEqual(integration.statuses, [])
  assert.deepEqual(notices, [])
})

test("a connection whose CLI logged out is marked, silently, at startup", async () => {
  const integration = fakeIntegration({ "claude-code": CONNECTION })
  const { wiring, notices } = wiringFor(integration, [OUT])
  await refreshConnection(wiring, TARGET)
  assert.deepEqual(integration.statuses, [
    {
      integrationID: "claude-code",
      connection: CONNECTION,
      status: { status: "needs_auth", message: "Claude Code is not logged in. Run `claude auth login` in a terminal." },
    },
  ])
  assert.deepEqual(notices, [], "a startup check never toasts")
})

test("a connect is answered once, however many locations saw it, and a login clears the mark", async () => {
  const integration = fakeIntegration({ "claude-code": CONNECTION })
  const first = wiringFor(integration, [IN])
  // A second location in the same process: its own wiring, the same event.
  const second = { ...first.wiring, notify: (level: "success" | "warn", message: string) => first.notices.push({ level, message }) }
  await Promise.all([
    refreshConnection(first.wiring, TARGET, "cred_1"),
    refreshConnection(second, TARGET, "cred_1"),
  ])
  assert.equal(first.checks(), 1)
  assert.deepEqual(first.notices, [
    { level: "success", message: "Claude Code: logged in with a Claude subscription (Max)." },
  ])
  assert.ok(integration.statuses.every((entry) => entry.status === undefined), "a login clears the mark")
})

test("connecting again after logging in checks again, whatever the clock says", async () => {
  const integration = fakeIntegration({ "claude-code": CONNECTION })
  const { wiring, notices, checks } = wiringFor(integration, [OUT, IN])
  await refreshConnection(wiring, TARGET, "cred_1")
  wiring.tick(1_000)
  await refreshConnection(wiring, TARGET, "cred_2")
  assert.equal(checks(), 2)
  assert.deepEqual(
    notices.map((notice) => notice.level),
    ["warn", "success"],
  )
  assert.match(notices[0].message, /not logged in\. Run `claude auth login` in a terminal\. Then connect again\./)
})

test("a check that failed leaves the connection alone and says so", async () => {
  const integration = fakeIntegration({ "claude-code": CONNECTION })
  const { wiring, notices } = wiringFor(integration, [{ status: "failed", reason: "no answer within 10 s" }])
  await refreshConnection(wiring, TARGET, "cred_1")
  assert.deepEqual(integration.statuses, [])
  assert.equal(notices[0].level, "warn")
  assert.match(notices[0].message, /could not check the login/)
})

test("only a credential switch of one of this plugin's providers is answered", async () => {
  const integration = fakeIntegration({ "claude-code": CONNECTION })
  const { wiring, notices, checks } = wiringFor(integration, [IN])
  const events: V2Event[] = [
    { type: "credential.updated", data: {} },
    { type: "credential.switched", data: { integrationID: "anthropic", credentialID: "cred_9" } },
    { type: "integration.updated", data: {} },
    { type: "credential.switched", data: { integrationID: "claude-code", credentialID: "cred_1" } },
  ]
  async function* feed() {
    for (const event of events) yield event
  }
  await followConnectEvents(() => feed(), new AbortController().signal, wiring)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(checks(), 1)
  assert.equal(notices.length, 1)
  assert.deepEqual(switchedCredential(events[3]), { integrationID: "claude-code", credentialID: "cred_1" })
  assert.equal(switchedCredential(events[0]), undefined)
  assert.equal(switchedCredential({ type: "credential.switched", data: { integrationID: "x" } }), undefined)
})

// ---------------------------------------------------------------------------
// Through createV2Setup
// ---------------------------------------------------------------------------

function setupContext(extra: Record<string, unknown> = {}) {
  const hooks: Record<string, Array<(event: any) => unknown>> = {}
  const ctx = {
    app: { version: "2.2.5" },
    location: { directory: process.cwd() },
    options: {},
    provider: { transform: async () => ({ dispose: async () => undefined }) },
    aisdk: {
      hook: async (name: string, callback: (event: any) => unknown) => {
        ;(hooks[name] ??= []).push(callback)
        return { dispose: async () => undefined }
      },
    },
    session: {
      hook: async (name: string, callback: (event: any) => unknown) => {
        ;(hooks[name] ??= []).push(callback)
        return { dispose: async () => undefined }
      },
    },
    ...extra,
  }
  return { ctx: ctx as any, hooks }
}

function setupWith(config: Record<string, unknown>) {
  return createV2Setup({
    createProvider: () => ({ languageModel: () => ({}) as any }),
    defaultProxyTools: PROXY_TOOLS,
    loadConfig: () => config,
  })
}

test("opencode's retry of a failed turn is declined for every claude-code provider and no other", async () => {
  const { ctx, hooks } = setupContext()
  const cleanup = await setupWith({})(ctx)
  assert.equal(hooks.retry?.length, 1)
  for (const providerID of ["claude-code", "claude-code-work"]) {
    const event: any = {
      sessionID: "ses_1",
      model: { providerID, id: "claude-haiku-5-5" },
      error: { type: "provider.unknown", message: "The Claude Code CLI exited with code 3" },
      attempt: 2,
      decision: { retry: true, delay: 2000 },
    }
    await hooks.retry[0](event)
    assert.deepEqual(event.decision, { retry: false }, providerID)
  }
  const other: any = {
    sessionID: "ses_2",
    model: { providerID: "anthropic", id: "claude-sonnet-5-5" },
    error: { type: "provider.rate_limit" },
    attempt: 2,
    decision: { retry: true, delay: 2000 },
  }
  await hooks.retry[0](other)
  assert.deepEqual(other.decision, { retry: true, delay: 2000 }, "another provider's retry is opencode's")
  await cleanup()
})

test("a host that refuses the retry hook still gets the rest of setup", async () => {
  const { ctx, hooks } = setupContext()
  const register = ctx.session.hook
  ctx.session.hook = async (name: string, callback: (event: any) => unknown) => {
    if (name === "retry") throw new Error("unknown hook: retry")
    return register(name, callback)
  }
  const cleanup = await setupWith({})(ctx)
  assert.equal(hooks.retry, undefined)
  assert.equal(hooks["model.request"]?.length, 1)
  assert.equal(hooks.sdk?.length, 1)
  await cleanup()
})

test("setup registers the /connect entry and checks only providers already connected", async () => {
  const integration = fakeIntegration()
  const { ctx } = setupContext({ integration: integration.domain })
  const cleanup = await setupWith({ provider: { "claude-code": { options: { accounts: ["default", "work"] } } } })(ctx)
  assert.equal(integration.transforms.length, 1)
  const { records, editor } = fakeIntegrationEditor()
  integration.transforms[0](editor)
  assert.deepEqual([...records.keys()].sort(), ["claude-code", "claude-code-default", "claude-code-work"])
  assert.equal(records.get("claude-code-work")?.ref.name, "Claude Code (Work)")
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(integration.asked.sort(), ["claude-code-default", "claude-code-work"])
  assert.deepEqual(integration.statuses, [], "nothing connected, so nothing was checked")
  await cleanup()
})

test("a host without the integration domain sets up as before", async () => {
  const { ctx, hooks } = setupContext()
  const cleanup = await setupWith({})(ctx)
  assert.equal(hooks.sdk?.length, 1)
  await cleanup()
})
