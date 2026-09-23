/**
 * The opencode 2.x entrypoint (src/v2.ts), driven offline through a fake V2
 * plugin context the same way the V1 tests drive `server(input)`. The live
 * probes that established each behaviour ran against a sandboxed opencode
 * 2.0.11 and are recorded in V2.md; these pin the wiring.
 *
 * Usage: npx tsx --test test-v2-entrypoint.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { accountProviderId, resolveAccounts } from "./src/accounts.js"
import { resolveOpencodeAgent } from "./src/claude-code-language-model.js"
import { getHostToolDialect, setHostToolDialect } from "./src/host-tools.js"
import { defaultModels } from "./src/models.js"
import type { V2ModelInfo, V2ProviderInfo } from "./src/opencode-v2-types.js"
import {
  OPENCODE_AGENT_HEADER,
  SESSION_AFFINITY_HEADER,
  V2_PLUGIN_PACKAGE,
  agentForRequest,
  configuredSeedSettings,
  createV2Setup,
  planV2Providers,
  resolveSdkSettings,
  toV2Model,
} from "./src/v2.js"

const PROXY_TOOLS = ["Bash", "Edit", "Write", "WebFetch", "Task"]

function fakeEditor() {
  const records = new Map<string, { provider: V2ProviderInfo; models: Map<string, V2ModelInfo> }>()
  return {
    records,
    editor: {
      list: () => [...records.values()],
      get: (id: string) => records.get(id),
      add: ({ info, models }: { info: V2ProviderInfo; models: readonly V2ModelInfo[] }) => {
        records.set(info.id, { provider: { ...info }, models: new Map(models.map((m) => [m.id, m])) })
      },
      update: (id: string, update: (provider: V2ProviderInfo) => void) => {
        const record = records.get(id)
        if (record) update(record.provider)
      },
      remove: (id: string) => {
        records.delete(id)
      },
      models: {
        set: (id: string, models: readonly V2ModelInfo[]) => {
          const record = records.get(id)
          if (record) record.models = new Map(models.map((m) => [m.id, m]))
        },
      },
    },
  }
}

function fakeContext(options: Record<string, unknown> = {}) {
  const transforms: Array<(editor: any) => void> = []
  const hooks: Record<string, Array<(event: any) => unknown>> = {}
  const disposed: string[] = []
  const registration = (name: string) => ({
    dispose: async () => {
      disposed.push(name)
    },
  })
  const ctx = {
    app: { version: "2.0.11" },
    location: { directory: process.cwd() },
    options,
    provider: {
      transform: async (callback: (editor: any) => void) => {
        transforms.push(callback)
        return registration("provider.transform")
      },
    },
    aisdk: {
      hook: async (name: string, callback: (event: any) => unknown) => {
        ;(hooks[name] ??= []).push(callback)
        return registration(`aisdk.${name}`)
      },
    },
    session: {
      hook: async (name: string, callback: (event: any) => unknown) => {
        ;(hooks[name] ??= []).push(callback)
        return registration(`session.${name}`)
      },
    },
  }
  return { ctx: ctx as any, transforms, hooks, disposed }
}

test("a model converts to V2's Model.Info with every required field", () => {
  const opus = defaultModels["claude-opus-5"]
  const model = toV2Model(opus, "claude-code", "claude-opus-5")
  assert.equal(model.id, "claude-opus-5")
  assert.equal(model.modelID, "claude-opus-5")
  assert.equal(model.providerID, "claude-code")
  assert.equal(model.package, V2_PLUGIN_PACKAGE)
  assert.deepEqual(model.capabilities, { tools: true, input: ["text", "image"], output: ["text"] })
  assert.deepEqual(model.cost, [
    { input: opus.cost.input, output: opus.cost.output, cache: opus.cost.cache },
  ])
  assert.equal(model.limit.context, opus.limit.context)
  assert.equal(model.time.released, Date.parse(opus.release_date!))
  assert.deepEqual(
    model.variants.map((variant) => variant.id),
    Object.keys(opus.variants ?? {}),
  )
  assert.deepEqual(model.variants[0].settings, opus.variants![model.variants[0].id])
})

test("no accounts plans one claude-code provider carrying every model", () => {
  const [plan, ...rest] = planV2Providers({ cliPath: "/opt/claude" }, PROXY_TOOLS)
  assert.equal(rest.length, 0)
  assert.equal(plan.info.id, "claude-code")
  assert.equal(plan.info.activation, "enabled")
  assert.equal(plan.info.package, V2_PLUGIN_PACKAGE)
  assert.equal(plan.info.settings?.cliPath, "/opt/claude")
  assert.deepEqual(plan.info.settings?.proxyTools, PROXY_TOOLS)
  assert.equal(plan.models.length, Object.keys(defaultModels).length)
})

test("accounts plan one provider per account, with @account model ids", () => {
  const accounts = resolveAccounts(["appical"])!
  const plans = planV2Providers({ accounts: ["appical"], cliPath: "/opt/claude" }, PROXY_TOOLS)
  assert.deepEqual(
    plans.map((plan) => plan.info.id),
    accounts.map(accountProviderId),
  )
  const appical = plans.find((plan) => plan.info.id === "claude-code-appical")!
  assert.equal(appical.info.settings?.account, "appical")
  assert.deepEqual(appical.info.settings?.failoverAccounts, accounts)
  assert.equal(appical.info.settings?.baseCliPath, "/opt/claude")
  assert.equal("accounts" in (appical.info.settings ?? {}), false)
  assert.ok(appical.models.every((model) => model.id.endsWith("@appical")))
})

test("seed settings come from V1 options, then V2 settings, then plugin options", () => {
  const config = {
    provider: {
      "claude-code": {
        options: { cliPath: "v1", proxyTools: ["Bash"], accounts: ["appical"] },
        settings: { cliPath: "v2" },
      },
    },
  }
  assert.deepEqual(configuredSeedSettings(config, undefined), {
    cliPath: "v2",
    proxyTools: ["Bash"],
    accounts: ["appical"],
  })
  assert.equal(configuredSeedSettings(config, { cliPath: "plugin" }).cliPath, "plugin")
  assert.deepEqual(configuredSeedSettings({}, undefined), {})
})

test("compaction and title requests keep the agent names the model keys on", () => {
  assert.equal(agentForRequest("compaction", "build"), "compaction")
  assert.equal(agentForRequest("title", "build"), "title")
  assert.equal(agentForRequest("primary", "build"), "build")
  assert.equal(agentForRequest("generate", "plan"), "plan")
})

test("the agent comes from providerOptions first, then the V2 header", () => {
  assert.equal(
    resolveOpencodeAgent(
      { [OPENCODE_AGENT_HEADER]: "from-header" },
      { "claude-code": { opencodeAgent: "from-options" } },
      "claude-code",
    ),
    "from-options",
  )
  assert.equal(
    resolveOpencodeAgent({ "X-Opencode-Agent": "compaction" }, undefined, "claude-code"),
    "compaction",
  )
  assert.equal(resolveOpencodeAgent(undefined, undefined, "claude-code"), undefined)
})

test("opencode's SDK options win over the planned copy, minus its transport keys", async () => {
  const settings = await resolveSdkSettings(
    "claude-code",
    { cliPath: "/planned", proxyTools: PROXY_TOOLS, accounts: ["x"] },
    {
      name: "claude-code",
      fetch: () => undefined,
      headers: {},
      body: undefined,
      cliPath: "/configured",
      reasoningEffort: "high",
    },
  )
  assert.equal(settings.cliPath, "/configured")
  assert.equal((settings as any).reasoningEffort, "high")
  assert.deepEqual(settings.proxyTools, PROXY_TOOLS)
  assert.equal(settings.providerID, "claude-code")
  for (const key of ["name", "fetch", "headers", "body", "accounts"]) {
    assert.equal(key in settings, false, key)
  }
})

test("setup publishes the provider, supplies the SDK, tags requests and cleans up", async () => {
  const previousDialect = getHostToolDialect()
  const created: any[] = []
  const setup = createV2Setup({
    createProvider: (settings) => {
      created.push(settings)
      return { languageModel: () => ({ specificationVersion: "v3" }) as any }
    },
    defaultProxyTools: PROXY_TOOLS,
    loadConfig: () => ({ provider: { "claude-code": { options: { cliPath: "/opt/claude" } } } }),
  })
  const { ctx, transforms, hooks, disposed } = fakeContext()
  try {
    const cleanup = await setup(ctx)
    assert.equal(getHostToolDialect(), "v2")

    const { editor, records } = fakeEditor()
    transforms[0](editor)
    const record = records.get("claude-code")!
    assert.equal(record.provider.package, V2_PLUGIN_PACKAGE)
    assert.equal(record.provider.settings?.cliPath, "/opt/claude")
    assert.ok(record.models.has("claude-haiku-4-5"))

    const event: any = {
      model: { providerID: "claude-code", id: "claude-haiku-4-5" },
      package: V2_PLUGIN_PACKAGE,
      options: { name: "claude-code" },
    }
    await hooks.sdk[0](event)
    assert.equal(typeof event.sdk?.languageModel, "function")
    assert.equal(created[0].cliPath, "/opt/claude")

    const other: any = { model: { providerID: "openai" }, package: "aisdk:@ai-sdk/openai", options: {} }
    await hooks.sdk[0](other)
    assert.equal(other.sdk, undefined, "another provider's SDK is left alone")

    const request: any = {
      sessionID: "ses_abc",
      agent: "build",
      kind: "compaction",
      model: { providerID: "claude-code", id: "claude-haiku-4-5" },
      headers: {},
    }
    await hooks["model.request"][0](request)
    assert.equal(request.headers[SESSION_AFFINITY_HEADER], "ses_abc")
    assert.equal(request.headers[OPENCODE_AGENT_HEADER], "compaction")

    const foreign: any = { ...request, model: { providerID: "openai", id: "gpt" }, headers: {} }
    await hooks["model.request"][0](foreign)
    assert.deepEqual(foreign.headers, {})

    await cleanup()
    assert.deepEqual(disposed.sort(), [
      "aisdk.sdk",
      "provider.transform",
      "session.model.request",
    ])
  } finally {
    setHostToolDialect(previousDialect)
  }
})

test("an account expansion replaces the seed provider in the editor", async () => {
  const previousDialect = getHostToolDialect()
  const setup = createV2Setup({
    createProvider: () => ({ languageModel: () => ({}) as any }),
    defaultProxyTools: PROXY_TOOLS,
    loadConfig: () => ({ provider: { "claude-code": { options: { accounts: ["appical"] } } } }),
  })
  const { ctx, transforms } = fakeContext()
  try {
    await setup(ctx)
    const { editor, records } = fakeEditor()
    editor.add({
      info: { id: "claude-code", name: "seed", activation: "auto", package: "" },
      models: [],
    })
    transforms[0](editor)
    assert.equal(records.has("claude-code"), false)
    assert.ok(records.has("claude-code-appical"))
  } finally {
    setHostToolDialect(previousDialect)
  }
})
