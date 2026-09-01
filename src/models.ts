import type { OpenCodeModel } from "./opencode-types.js"

const PROVIDER_ID = "claude-code"
const NPM = "@khalilgharbaoui/opencode-claude-code-plugin"

const reasoningVariants: Record<string, Record<string, unknown>> = {
  low: { reasoningEffort: "low" },
  medium: { reasoningEffort: "medium" },
  high: { reasoningEffort: "high" },
  xhigh: { reasoningEffort: "xhigh" },
  max: { reasoningEffort: "max" },
}

const baseCapabilities = {
  temperature: false,
  attachment: true,
  toolcall: true,
  input: { text: true, audio: false, image: true, video: false, pdf: false },
  output: { text: true, audio: false, image: false, video: false, pdf: false },
  interleaved: false as const,
}

function defineModel(opts: {
  id: string
  name: string
  family: string
  reasoning: boolean
  context: number
  output: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  releaseDate: string
  // List-price multiplier relative to Haiku (the cheapest model). Derived
  // exactly from published per-token pricing: input AND output ratios both come
  // out to haiku 1, sonnet 3, opus 5, fable/mythos 10. Rendered as an
  // `(N×)` suffix so it surfaces in opencode's model picker, which has no
  // dedicated multiplier field.
  // Display-only: model resolution keys off `id`.
  multiplier: number
  status?: OpenCodeModel["status"]
}): OpenCodeModel {
  return {
    id: opts.id,
    providerID: PROVIDER_ID,
    api: { id: opts.id, url: "", npm: NPM },
    name: `${opts.name} (${opts.multiplier}×)`,
    family: opts.family,
    capabilities: { ...baseCapabilities, reasoning: opts.reasoning },
    cost: {
      input: opts.cost.input,
      output: opts.cost.output,
      cache: { read: opts.cost.cacheRead, write: opts.cost.cacheWrite },
    },
    limit: { context: opts.context, output: opts.output },
    status: opts.status ?? "active",
    options: {},
    headers: {},
    release_date: opts.releaseDate,
    variants: opts.reasoning ? reasoningVariants : undefined,
  }
}

// Costs in US dollars per MILLION tokens, matching Anthropic's published
// pricing verbatim. This is the unit opencode and models.dev use: opencode
// divides by 1e6 itself when it multiplies a cost by a token count, so writing
// per-token values here under-reports session cost by exactly 1,000,000x.
// Compare models.dev's own entry for the same model:
// `anthropic/claude-haiku-4-5 -> {"input": 1, "output": 5, "cache_read": 0.1,
// "cache_write": 1.25}`.
//
// There is no long-context premium to model. Anthropic's pricing page states
// that Claude 4.6 and later ship the full 1M-token context window at standard
// pricing ("a 900k-token request is billed at the same per-token rate as a
// 9k-token request"), and caching/batch discounts apply unchanged across it.
// opencode 1.18.5 added optional `cost.tiers` / `cost.experimentalOver200K`
// fields for above-200K pricing; they stay unset here deliberately, because a
// tier would misreport the real price. Re-check only if Anthropic introduces
// one. Verified against the pricing docs 2026-07-26.
const haikuCost = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }
const sonnetCost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
// Opus 4.5+ standard pricing is $5/M in, $25/M out (the price cut at 4.5; held
// through 4.6/4.7/4.8/5). Cache read 0.1x input, cache write 1.25x input.
const opusCost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
// Fable 5 and Mythos 5 are the Mythos-class tier above Opus and share pricing
// ($10/M in, $50/M out). Cache read/write follow Anthropic's standard 0.1x / 1.25x
// input ratios (not separately published).
const fableCost = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }
// Fast mode bills the same per-token rates as the Mythos-class tier: $10/M in,
// $50/M out, cache read 1, cache write 12.5. Not an inference; this is the
// exact table the CLI itself applies for `speed: "fast"` on Opus 4.8 / Opus 5
// (`{inputTokens: 10, outputTokens: 50, promptCacheWriteTokens: 12.5,
// promptCacheReadTokens: 1}`). Kept as its own binding rather than reusing
// `fableCost` so a future divergence in either tier stays a one-line change.
// Verified against Claude Code 2.1.245, 2026-08-30.
const opusFastCost = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }

/**
 * Convert an OpenCodeModel to the flat config schema that OpenCode's
 * provider.ts config parser expects (model.temperature, model.reasoning,
 * model.cost.cache_read, model.modalities, etc.).
 */
export function toConfigModel(model: OpenCodeModel): Record<string, unknown> {
  const inputMods: string[] = []
  const outputMods: string[] = []
  for (const [k, v] of Object.entries(model.capabilities.input)) {
    if (v) inputMods.push(k)
  }
  for (const [k, v] of Object.entries(model.capabilities.output)) {
    if (v) outputMods.push(k)
  }

  return {
    id: model.api.id,
    name: model.name,
    status: model.status,
    family: model.family ?? "",
    release_date: model.release_date,

    temperature: model.capabilities.temperature,
    reasoning: model.capabilities.reasoning,
    attachment: model.capabilities.attachment,
    tool_call: model.capabilities.toolcall,
    modalities: { input: inputMods, output: outputMods },

    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cache_read: model.cost.cache.read,
      cache_write: model.cost.cache.write,
    },

    limit: model.limit,
    options: model.options,
    headers: model.headers,
    variants: model.variants,
  }
}

export const defaultModels: Record<string, OpenCodeModel> = {
  "claude-haiku-4-5": defineModel({
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    family: "haiku",
    reasoning: false,
    context: 200_000,
    output: 64_000,
    cost: haikuCost,
    multiplier: 1,
    releaseDate: "2025-10-01",
  }),
  "claude-sonnet-4-5": defineModel({
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    family: "sonnet",
    reasoning: true,
    context: 200_000,
    output: 64_000,
    cost: sonnetCost,
    multiplier: 3,
    releaseDate: "2025-09-29",
  }),
  "claude-sonnet-4-6": defineModel({
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    family: "sonnet",
    reasoning: true,
    context: 1_000_000,
    output: 128_000,
    cost: sonnetCost,
    multiplier: 3,
    releaseDate: "2025-06-19",
  }),
  "claude-sonnet-5": defineModel({
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    family: "sonnet",
    reasoning: true,
    context: 1_000_000,
    output: 128_000,
    cost: sonnetCost,
    multiplier: 3,
    releaseDate: "2026-06-30",
  }),
  "claude-opus-4-5": defineModel({
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    family: "opus",
    reasoning: true,
    context: 200_000,
    output: 64_000,
    cost: opusCost,
    multiplier: 5,
    releaseDate: "2025-11-01",
  }),
  "claude-opus-4-6": defineModel({
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    family: "opus",
    reasoning: true,
    context: 1_000_000,
    output: 128_000,
    cost: opusCost,
    multiplier: 5,
    releaseDate: "2025-06-19",
  }),
  "claude-opus-4-7": defineModel({
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    family: "opus",
    reasoning: true,
    context: 1_000_000,
    output: 128_000,
    cost: opusCost,
    multiplier: 5,
    releaseDate: "2025-07-16",
  }),
  "claude-opus-4-8": defineModel({
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    family: "opus",
    reasoning: true,
    context: 1_000_000,
    output: 128_000,
    cost: opusCost,
    multiplier: 5,
    releaseDate: "2026-05-28",
  }),
  // Fast mode. The `-fast` suffix is OUR marker, not a model name Anthropic
  // serves: `parseModelId` strips it before `--model` and turns it into
  // `--settings {"fastMode":true}` on the spawn. Retired `-fast` model strings
  // (`claude-opus-4-6-fast`) are a different thing and are not registered here.
  //
  // Only Opus 4.8 and Opus 5 qualify: the CLI gates fast mode on the resolved
  // model name containing `opus-4-8` or `opus-5`, so registering a fast entry
  // for any other model would produce a picker option that silently runs at
  // standard speed while displaying the 10x price.
  "claude-opus-4-8-fast": defineModel({
    id: "claude-opus-4-8-fast",
    name: "Claude Opus 4.8 Fast",
    family: "opus",
    reasoning: true,
    context: 1_000_000,
    output: 128_000,
    cost: opusFastCost,
    multiplier: 10,
    releaseDate: "2026-05-28",
  }),
  "claude-opus-5": defineModel({
    id: "claude-opus-5",
    name: "Claude Opus 5",
    family: "opus",
    reasoning: true,
    context: 1_000_000,
    output: 128_000,
    cost: opusCost,
    multiplier: 5,
    releaseDate: "2026-07-24",
  }),
  "claude-opus-5-fast": defineModel({
    id: "claude-opus-5-fast",
    name: "Claude Opus 5 Fast",
    family: "opus",
    reasoning: true,
    context: 1_000_000,
    output: 128_000,
    cost: opusFastCost,
    multiplier: 10,
    releaseDate: "2026-07-24",
  }),
  "claude-fable-5": defineModel({
    id: "claude-fable-5",
    name: "Claude Fable 5",
    family: "fable",
    reasoning: true,
    context: 1_000_000,
    output: 128_000,
    cost: fableCost,
    multiplier: 10,
    releaseDate: "2026-06-09",
  }),
  // Mythos 5 shares Fable 5's capabilities and pricing without the safety
  // classifiers; limited availability via Project Glasswing. `claude --model
  // claude-mythos-5` simply errors for accounts without access, so it's safe to
  // register unconditionally.
  "claude-mythos-5": defineModel({
    id: "claude-mythos-5",
    name: "Claude Mythos 5",
    family: "mythos",
    reasoning: true,
    context: 1_000_000,
    output: 128_000,
    cost: fableCost,
    multiplier: 10,
    releaseDate: "2026-06-09",
  }),
}

/** Marker this plugin appends to build a fast-mode model id. See below. */
const FAST_SUFFIX = "-fast"

/**
 * Split an opencode model id into the name the Claude CLI actually accepts
 * and whether fast mode was requested.
 *
 * Two suffixes can ride on one id and they are NOT interchangeable:
 *
 *   claude-opus-5-fast@work
 *   \_____________/\___/\__/
 *     CLI model    ours  accounts.ts's
 *
 * `@work` must survive: the per-account wrapper script strips it at spawn
 * time to pick a CLAUDE_CONFIG_DIR. `-fast` must not: the CLI has no such
 * model (`claude-opus-4-6-fast` is retired and `claude-opus-4-7-fast` errors
 * outright), so it becomes `--settings {"fastMode":true}` instead.
 *
 * The `defaultModels` lookup is the guard against a false positive. Only ids
 * we registered are treated as fast markers, so a user-defined model that
 * happens to end in `-fast` is passed through untouched rather than being
 * silently rewritten into a model name that does not exist.
 */
export function parseModelId(modelId: string): { model: string; fast: boolean } {
  const at = modelId.indexOf("@")
  const base = at === -1 ? modelId : modelId.slice(0, at)
  const account = at === -1 ? "" : modelId.slice(at)

  if (!base.endsWith(FAST_SUFFIX)) return { model: modelId, fast: false }
  if (!Object.hasOwn(defaultModels, base)) return { model: modelId, fast: false }

  return { model: base.slice(0, -FAST_SUFFIX.length) + account, fast: true }
}
