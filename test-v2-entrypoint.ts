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
import { createClaudeCode } from "./src/index.js"
import { defaultModels } from "./src/models.js"
import type { V2ModelInfo, V2ProviderInfo } from "./src/opencode-v2-types.js"
import {
  OPENCODE_AGENT_HEADER,
  SESSION_AFFINITY_HEADER,
  V2_PLUGIN_PACKAGE,
  agentForRequest,
  commandPromptText,
  configuredSeedSettings,
  createV2Setup,
  deletedSessionIdV2,
  isOpencodeV2Context,
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
  {
    const cleanup = await setup(ctx)

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
    // The model itself carries the vocabulary; nothing process-wide does.
    assert.equal(created[0].hostApi, "v2")

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
  }
})

test("an account expansion replaces the seed provider in the editor", async () => {
  const setup = createV2Setup({
    createProvider: () => ({ languageModel: () => ({}) as any }),
    defaultProxyTools: PROXY_TOOLS,
    loadConfig: () => ({ provider: { "claude-code": { options: { accounts: ["appical"] } } } }),
  })
  const { ctx, transforms } = fakeContext()
  await setup(ctx)
  const { editor, records } = fakeEditor()
  editor.add({
    info: { id: "claude-code", name: "seed", activation: "auto", package: "" },
    models: [],
  })
  transforms[0](editor)
  assert.equal(records.has("claude-code"), false)
  assert.ok(records.has("claude-code-appical"))
})

test("setup called by opencode 1.x registers nothing", async () => {
  // opencode 1.18.32 calls a dual export's `setup` as well as `server`, with a
  // smaller context of its own. The build that set a process-wide dialect here
  // turned every V1 tool call into a V2 name, and V1 rejected them all.
  const created: unknown[] = []
  const setup = createV2Setup({
    createProvider: (settings) => {
      created.push(settings)
      return { languageModel: () => ({}) as any }
    },
    defaultProxyTools: PROXY_TOOLS,
    loadConfig: () => ({}),
  })

  const v1Shaped = { app: { version: "1.18.32" }, aisdk: { hook: async () => ({}) }, skill: {} }
  assert.equal(isOpencodeV2Context(v1Shaped), false)
  const cleanup = await setup(v1Shaped as any)
  await cleanup()
  assert.deepEqual(created, [])

  // A 1.x version is refused even if every domain happens to be there.
  const { ctx, transforms, hooks } = fakeContext()
  ctx.app.version = "1.18.32"
  assert.equal(isOpencodeV2Context(ctx), false)
  await setup(ctx)
  assert.equal(transforms.length, 0)
  assert.deepEqual(Object.keys(hooks), [])

  assert.equal(isOpencodeV2Context(fakeContext().ctx), true)
  assert.equal(isOpencodeV2Context(undefined), false)
})

test("a V2 title request gets the synthetic stub even though it carries tools", async () => {
  // Measured on 2.0.11: the title request arrives with the whole tool set, so
  // the V1 "no tools means title" test missed it and every new session spawned
  // a second `claude`. The CLI path points nowhere: a spawn would fail here.
  const model = createClaudeCode({
    hostApi: "v2",
    cliPath: "/nonexistent/claude",
    bridgeOpencodeMcp: false,
    proxyTools: [],
  }).languageModel("claude-haiku-4-5")
  const result = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Fix the login bug" }] }],
    tools: [{ type: "function", name: "read", description: "", inputSchema: { type: "object" } }],
    headers: { [OPENCODE_AGENT_HEADER]: "title", [SESSION_AFFINITY_HEADER]: "ses_title" },
  } as any)
  const parts: any[] = []
  for await (const part of result.stream as any) parts.push(part)
  const finish = parts.find((part) => part.type === "finish")
  assert.equal(finish.providerMetadata?.["claude-code"]?.synthetic, true)
  assert.ok(parts.some((part) => part.type === "text-delta" && part.delta.length > 0))
})

test("command text matches V1's template output", () => {
  assert.equal(commandPromptText("btw", "  what is x?  "), "/btw what is x?")
  assert.equal(commandPromptText("claude-code-doctor", ""), "/claude-code-doctor")
  assert.equal(commandPromptText("btw", undefined), "/btw")
})

test("a V2 session.deleted event names its session in data.sessionID", () => {
  assert.equal(deletedSessionIdV2({ type: "session.deleted", data: { sessionID: "ses_1" } }), "ses_1")
  assert.equal(deletedSessionIdV2({ type: "session.updated", data: { sessionID: "ses_1" } }), undefined)
  assert.equal(deletedSessionIdV2({ type: "session.deleted", data: {} }), undefined)
  assert.equal(deletedSessionIdV2(undefined), undefined)
})

test("setup registers /btw and the doctor, and /btw is always queued", async () => {
  const { ctx } = fakeContext()
  const added: any[] = []
  const prompts: any[] = []
  ctx.command = {
    transform: async (callback: (editor: any) => void) => {
      callback({ add: (definition: any) => added.push(definition) })
      return { dispose: async () => undefined }
    },
  }
  ctx.session.prompt = async (input: any) => {
    prompts.push(input)
    return {}
  }
  const setup = createV2Setup({
    createProvider: () => ({ languageModel: () => ({}) as any }),
    defaultProxyTools: PROXY_TOOLS,
    loadConfig: () => ({}),
  })
  await setup(ctx)

  assert.deepEqual(added.map((definition) => definition.name).sort(), ["btw", "claude-code-doctor"])
  const btw = added.find((definition) => definition.name === "btw")
  const doctor = added.find((definition) => definition.name === "claude-code-doctor")

  await btw.execute({ sessionID: "ses_1", prompt: { text: "why?", files: [] }, delivery: "steer" })
  assert.deepEqual(prompts[0], { text: "/btw why?", files: [], sessionID: "ses_1", delivery: "queue" })

  await doctor.execute({ sessionID: "ses_1", prompt: { text: "" }, delivery: "steer" })
  assert.deepEqual(prompts[1], { text: "/claude-code-doctor", sessionID: "ses_1", delivery: "steer" })
})

test("setup subscribes to events and stops listening on cleanup", async () => {
  const { ctx } = fakeContext()
  let signal: AbortSignal | undefined
  ctx.event = {
    subscribe: (options: { signal?: AbortSignal }) => {
      signal = options.signal
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "session.deleted", data: { sessionID: "ses_gone" } }
          await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve()))
        },
      }
    },
  }
  const setup = createV2Setup({
    createProvider: () => ({ languageModel: () => ({}) as any }),
    defaultProxyTools: PROXY_TOOLS,
    loadConfig: () => ({}),
  })
  const cleanup = await setup(ctx)
  assert.ok(signal, "subscribe must be given an abort signal")
  assert.equal(signal!.aborted, false)
  await cleanup()
  assert.equal(signal!.aborted, true)
})
