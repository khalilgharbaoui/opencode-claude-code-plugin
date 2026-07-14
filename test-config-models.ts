import assert from "node:assert/strict"
import { test } from "node:test"
import { configModelsForProvider, createClaudeCode } from "./src/index.js"
import { defaultModels } from "./src/models.js"
import type { OpenCodeProvider } from "./src/opencode-types.js"

// Regression guard for PR #7: opencode runs the `provider.models` hook before
// extending the provider DB from config. For plugin-only providers like
// claude-code (absent from the models-dev catalog) that hook bails, so the
// config-path output produced here must carry the real metadata — otherwise
// the context-usage indicator renders 0 / no cost / no model name.

test("configModelsForProvider emits real metadata, not schema defaults", () => {
  const models = configModelsForProvider({}, "claude-code")

  const opus = models["claude-opus-4-8"] as Record<string, unknown>
  assert.ok(opus, "claude-opus-4-8 should be present")

  const limit = opus.limit as { context: number; output: number }
  assert.ok(limit.context > 0, "limit.context must be populated")
  assert.ok(limit.output > 0, "limit.output must be populated")

  const cost = opus.cost as { input: number; output: number }
  assert.ok(cost.input > 0, "cost.input must be populated")
  assert.ok(cost.output > 0, "cost.output must be populated")

  assert.equal(opus.family, "opus")
  assert.equal(opus.name, "Claude Opus 4.8 (5×)")
  assert.ok(typeof opus.release_date === "string" && opus.release_date.length > 0)
  assert.equal(opus.reasoning, true)

  const variants = opus.variants as Record<string, unknown>
  assert.ok(variants && typeof variants === "object", "variants must be present")
  assert.ok("max" in variants, "default reasoning variants must be carried")
})

test("configModelsForProvider registers claude-fable-5 with real metadata", () => {
  const models = configModelsForProvider({}, "claude-code")

  const fable = models["claude-fable-5"] as Record<string, unknown>
  assert.ok(fable, "claude-fable-5 should be present")

  assert.equal(fable.family, "fable")
  assert.equal(fable.name, "Claude Fable 5 (10×)")
  assert.equal(fable.reasoning, true)

  const limit = fable.limit as { context: number; output: number }
  assert.ok(limit.context > 0, "limit.context must be populated")
  assert.ok(limit.output > 0, "limit.output must be populated")

  const cost = fable.cost as { input: number; output: number }
  assert.ok(cost.input > 0, "cost.input must be populated")
  assert.ok(cost.output > 0, "cost.output must be populated")

  const variants = fable.variants as Record<string, unknown>
  assert.ok(variants && "max" in variants, "reasoning variants must be carried")
})

test("configModelsForProvider registers claude-mythos-5 with real metadata", () => {
  const models = configModelsForProvider({}, "claude-code")

  const mythos = models["claude-mythos-5"] as Record<string, unknown>
  assert.ok(mythos, "claude-mythos-5 should be present")

  assert.equal(mythos.family, "mythos")
  assert.equal(mythos.name, "Claude Mythos 5 (10×)")
  assert.equal(mythos.reasoning, true)

  const limit = mythos.limit as { context: number; output: number }
  assert.ok(limit.context > 0, "limit.context must be populated")
  assert.ok(limit.output > 0, "limit.output must be populated")

  const cost = mythos.cost as { input: number; output: number }
  assert.ok(cost.input > 0, "cost.input must be populated")
  assert.ok(cost.output > 0, "cost.output must be populated")

  const variants = mythos.variants as Record<string, unknown>
  assert.ok(variants && "max" in variants, "reasoning variants must be carried")
})

test("configModelsForProvider registers Fable and Mythos 5.1 metadata", () => {
  const models = configModelsForProvider({}, "claude-code")

  for (const [id, name, family] of [
    ["claude-fable-5-1", "Claude Fable 5.1 (10×)", "fable"],
    ["claude-mythos-5-1", "Claude Mythos 5.1 (10×)", "mythos"],
  ] as const) {
    const model = models[id] as Record<string, unknown>
    assert.ok(model, `${id} should be present`)
    assert.equal(model.name, name)
    assert.equal(model.family, family)
    assert.equal(model.release_date, "2026-09-01")
    assert.equal(model.reasoning, true)
    assert.deepEqual(model.limit, { context: 1_000_000, output: 128_000 })
    assert.deepEqual(
      model.cost,
      { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
      id,
    )
    assert.ok(
      "max" in (model.variants as Record<string, unknown>),
      `${id} must carry the reasoning variants`,
    )
  }
})

test("configModelsForProvider registers Sonnet 5 and Opus 5 metadata", () => {
  const models = configModelsForProvider({}, "claude-code")

  const sonnet = models["claude-sonnet-5"] as Record<string, unknown>
  assert.equal(sonnet.name, "Claude Sonnet 5 (3×)")
  assert.equal(sonnet.family, "sonnet")
  assert.equal(sonnet.release_date, "2026-06-30")
  assert.equal(sonnet.reasoning, true)
  assert.deepEqual(sonnet.limit, { context: 1_000_000, output: 128_000 })
  // Dollars per million tokens, the unit opencode/models.dev expect.
  assert.deepEqual(sonnet.cost, {
    input: 3,
    output: 15,
    cache_read: 0.3,
    cache_write: 3.75,
  })

  const opus = models["claude-opus-5"] as Record<string, unknown>
  assert.equal(opus.name, "Claude Opus 5 (5×)")
  assert.equal(opus.family, "opus")
  assert.equal(opus.release_date, "2026-07-24")
  assert.equal(opus.reasoning, true)
  assert.deepEqual(opus.limit, { context: 1_000_000, output: 128_000 })
  assert.deepEqual(opus.cost, {
    input: 5,
    output: 25,
    cache_read: 0.5,
    cache_write: 6.25,
  })

  assert.ok("max" in (sonnet.variants as Record<string, unknown>))
  assert.ok("max" in (opus.variants as Record<string, unknown>))
})

// Fast mode is only registered for the two models the CLI actually gates it
// on, and it is priced at the Mythos-class rate ($10/$50 per MTok), which is
// the exact table the CLI applies for `speed: "fast"`. A fast entry priced at
// standard Opus rates would under-report every fast turn by half.
test("configModelsForProvider registers the fast Opus entries at fast pricing", () => {
  const models = configModelsForProvider({}, "claude-code")

  for (const [id, name, releaseDate] of [
    ["claude-opus-4-8-fast", "Claude Opus 4.8 Fast (10×)", "2026-05-28"],
    ["claude-opus-5-fast", "Claude Opus 5 Fast (10×)", "2026-07-24"],
  ] as const) {
    const model = models[id] as Record<string, unknown>
    assert.ok(model, `${id} should be present`)
    assert.equal(model.name, name)
    assert.equal(model.family, "opus")
    assert.equal(model.release_date, releaseDate)
    assert.equal(model.reasoning, true)
    assert.deepEqual(model.limit, { context: 1_000_000, output: 128_000 })
    assert.deepEqual(
      model.cost,
      { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
      id,
    )
    assert.ok(
      "max" in (model.variants as Record<string, unknown>),
      `${id} must carry the reasoning variants`,
    )
  }
})

test("configModelsForProvider registers fast entries only for fast-capable models", () => {
  const models = configModelsForProvider({}, "claude-code")
  const fastIds = Object.keys(models).filter((id) => id.endsWith("-fast"))

  // The CLI gates fast mode on the model name containing `opus-4-8` or
  // `opus-5`. Anything else would render a 10x price tag on a model that
  // silently runs at standard speed.
  assert.deepEqual(fastIds.sort(), ["claude-opus-4-8-fast", "claude-opus-5-fast"])
})

test("fast model ids survive the per-account suffix expansion", () => {
  const models = configModelsForProvider({}, "claude-code-work", "work")

  const model = models["claude-opus-5-fast@work"] as Record<string, unknown>
  assert.ok(model, "account-suffixed fast id must be emitted")
  assert.equal(model.id, "claude-opus-5-fast@work")
  assert.deepEqual(model.cost, {
    input: 10,
    output: 50,
    cache_read: 1,
    cache_write: 12.5,
  })
})

// Context and max-output values are published per model and had drifted: the
// 4.5-generation entries claimed a 1M context they never had, and every
// pre-Sonnet-5 entry carried a placeholder 16,384 output cap. Pin the real
// numbers so a future edit can't quietly reintroduce either.
test("configModelsForProvider reports the published context and output limits", () => {
  const models = configModelsForProvider({}, "claude-code")
  const limitOf = (id: string) => (models[id] as Record<string, unknown>).limit

  // 4.5 generation: 200k context, 64k output. Not 1M.
  assert.deepEqual(limitOf("claude-haiku-4-5"), { context: 200_000, output: 64_000 })
  assert.deepEqual(limitOf("claude-sonnet-4-5"), { context: 200_000, output: 64_000 })
  assert.deepEqual(limitOf("claude-opus-4-5"), { context: 200_000, output: 64_000 })

  // 4.6 and later: full 1M context, 128k output.
  for (const id of [
    "claude-sonnet-4-6",
    "claude-sonnet-5",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-fable-5",
    "claude-fable-5-1",
    "claude-mythos-5",
    "claude-mythos-5-1",
  ]) {
    assert.deepEqual(limitOf(id), { context: 1_000_000, output: 128_000 }, id)
  }
})

test("configModelsForProvider preserves user-defined variants for default models", () => {
  const userConfig = {
    "claude-opus-4-8": { variants: { custom: { reasoningEffort: "low" } } },
  } as unknown as OpenCodeProvider["models"]

  const models = configModelsForProvider(userConfig, "claude-code")
  const variants = (models["claude-opus-4-8"] as Record<string, unknown>)
    .variants as Record<string, unknown>

  // user variant survives the merge...
  assert.ok("custom" in variants, "user-defined variant must be preserved")
  // ...alongside the plugin defaults.
  assert.ok("max" in variants, "default variants must still be present")
})

test("configModelsForProvider passes through user models not in defaults", () => {
  const userConfig = {
    "my-custom-model": { ...defaultModels["claude-opus-4-8"], id: "my-custom-model" },
  } as unknown as OpenCodeProvider["models"]

  const models = configModelsForProvider(userConfig, "claude-code")
  assert.ok(models["my-custom-model"], "user-only model must be emitted")
})

test("createClaudeCode passes idle process timeout to language models", () => {
  const model = createClaudeCode({ idleProcessTimeoutMs: 900_000 })(
    "claude-sonnet-5",
  )

  assert.equal((model as any).config.idleProcessTimeoutMs, 900_000)
})
