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
  input: { text: true, audio: false, image: true, video: false, pdf: true },
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
  // out to haiku 1, sonnet 3 (sonnet 5 and 5.5: 2), opus 5 (opus 5.5: 4),
  // fable/mythos 10. Rendered
  // as an `(N×)` suffix so it surfaces in opencode's model picker, which has no
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

/**
 * The complete model a user-declared id that this plugin does not know is
 * built on. opencode's config schema makes every model field optional, so a
 * `provider.claude-code.models` entry is usually partial (a name, a limit, a
 * variant), and `toConfigModel` on a partial entry used to throw inside the
 * config hook, which silently unregistered the whole provider. Costs are zero
 * because they are unknown, the name is the id, and the window is the 4.5
 * generation's, the conservative choice; the entry's own fields overlay all of
 * it. The id still passes straight through to `claude --model`.
 */
export function passthroughModel(id: string): OpenCodeModel {
  return {
    id,
    providerID: PROVIDER_ID,
    api: { id, url: "", npm: NPM },
    name: id,
    family: "",
    capabilities: { ...baseCapabilities, reasoning: true },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200_000, output: 64_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "",
    variants: reasoningVariants,
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
// Every model here but Haiku 5.5 is billed at one rate across its whole
// context window. Anthropic's pricing page states that Claude 4.6 and later
// ship the full 1M-token window at standard pricing ("a 900k-token request is
// billed at the same per-token rate as a 9k-token request"), and caching/batch
// discounts apply unchanged across it.
//
// Haiku 5.5 is the exception and the pricing page carves it out by name: a
// prompt over 100,000 tokens pays five times the rate. opencode's own config
// schema cannot express that, because the only tier field it offers is
// `cost.context_over_200k`, whose threshold is fixed at 200K; filling it in
// would be right above 200K and still wrong between 100K and 200K while
// implying the plugin models the tier. So the catalog `cost` below stays the
// base table for every model, and the premium lives in `LONG_PROMPT_COSTS`,
// which only `apiCallCostUsd` reads. Verified against the pricing docs
// 2026-10-07 and against Claude Code 2.1.293's own catalog.
const haikuCost = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }
// Haiku 5.5 is a tenth of Haiku 4.5 on every axis: $0.10/M in, $0.50/M out,
// cache read $0.01, 5-minute cache write $0.125. Launched 2026-10-07 and known
// to Claude Code from 2.1.293 (`pricing: "haiku_55"`), where it is also the
// default Haiku.
const haiku55Cost = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }
const haiku55LongPromptCost = { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }
const sonnetCost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
// Sonnet 5 and Sonnet 5.5 are $2/M in, $10/M out, cache read $0.20, 5-minute
// cache write $2.50. For Sonnet 5 that was announced as introductory pricing
// through 2026-08-31, and the increase to $3/$15 scheduled for 2026-09-01 was
// cancelled: Anthropic's pricing page footnote reads "is now the standard
// price ... will not occur". Sonnet 5.5 launched at the same rates on
// 2026-09-28. Verified against the pricing page 2026-09-30.
const sonnet5Cost = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }
// Opus 4.5+ standard pricing is $5/M in, $25/M out (the price cut at 4.5; held
// through 4.6/4.7/4.8/5). Cache read 0.1x input, cache write 1.25x input.
const opusCost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
// Fable 5 and Mythos 5 are the Mythos-class tier above Opus and share pricing
// ($10/M in, $50/M out). Cache read/write follow Anthropic's standard 0.1x / 1.25x
// input ratios (not separately published).
const fableCost = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }
// Fable 5.1 and Mythos 5.1 keep the same input/output and cache-write rates,
// but Anthropic cut cache reads to $0.25/M (one quarter of the 5.0 price).
const fable51Cost = { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }
// Fast mode bills the same per-token rates as the Mythos-class tier: $10/M in,
// $50/M out, cache read 1, cache write 12.5. Not an inference; this is the
// exact table the CLI itself applies for `speed: "fast"` on Opus 4.8 / Opus 5
// (`{inputTokens: 10, outputTokens: 50, promptCacheWriteTokens: 12.5,
// promptCacheReadTokens: 1}`). Kept as its own binding rather than reusing
// `fableCost` so a future divergence in either tier stays a one-line change.
// Verified against Claude Code 2.1.245, 2026-08-30.
const opusFastCost = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }
// Opus 5.5 is the first Opus priced below the $5/$25 line: $4/M in, $20/M
// out. Cache writes keep the 1.25x input ratio ($5/M) but cache reads are
// $0.20/M, 0.05x input rather than the usual 0.1x, so this cannot be derived
// from `opusCost` by scaling. Fast mode is exactly double across the board
// ($8/M in, $40/M out, cache read 0.4, cache write 10). Both tables are the
// ones Claude Code bakes in for the model (`tier_4_20_cache_read_0_20` and
// its dedicated fast-mode entry), matching the 2026-09-22 announcement.
// Verified against Claude Code 2.1.280, 2026-09-22.
const opus55Cost = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }
const opus55FastCost = { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 }

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

/**
 * The per-model rate that replaces the catalog's whole cost table once a call's
 * prompt crosses `aboveTokens`, for the models Anthropic prices by prompt
 * length. Read out of Claude Code 2.1.293's own catalog
 * (`haiku_55.long_prompt`) and matching the published pricing page.
 *
 * `aboveTokens` is compared against the prompt the way the CLI compares it:
 * `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`,
 * strictly greater, and the whole call then prices at this table rather than
 * only the tokens past the line.
 *
 * Deliberately separate from `defaultModels`: `OpenCodeModel` is a structural
 * mirror of what opencode accepts from `provider.models()`, and opencode has
 * no field for a 100K threshold, so this must not ride on it.
 */
const LONG_PROMPT_COSTS: Record<
  string,
  { aboveTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number } }
> = {
  "claude-haiku-5-5": { aboveTokens: 100_000, cost: haiku55LongPromptCost },
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
  // Haiku 5.5 needs Claude Code 2.1.293+, the release that added it and made
  // it the default Haiku; an older CLI runs it on fallback limits and says so
  // on stderr, which `reportUnrecognizedModel` turns into a warning. Unlike
  // Haiku 4.5 it reasons: the CLI's catalog gives it `effort`, `max_effort`,
  // `xhigh_effort` and `adaptive_thinking`, and Anthropic's migration note says
  // manual `budget_tokens` is a 400 and adaptive thinking is on by default. The
  // plugin never sends `budget_tokens`, so nothing here special-cases it, the
  // same as Opus 5.5's `rejects_disabled_thinking`. No `-fast` entry: the
  // catalog gives it no `fast_mode` capability.
  //
  // The multiplier is 0.1 because it is exactly a tenth of Haiku 4.5 on input,
  // output, cache read and cache write alike, and Haiku 4.5's $1/$5 is the 1x
  // anchor every other entry here is already measured against. Re-anchoring the
  // whole table on Haiku 5.5 would change every model's displayed number for no
  // gain in accuracy.
  "claude-haiku-5-5": defineModel({
    id: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    family: "haiku",
    reasoning: true,
    context: 1_000_000,
    output: 128_000,
    cost: haiku55Cost,
    multiplier: 0.1,
    releaseDate: "2026-10-07",
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
    cost: sonnet5Cost,
    multiplier: 2,
    releaseDate: "2026-06-30",
  }),
  // Sonnet 5.5 runs on any recent Claude Code, but 2.1.284 is the first
  // release that knows it: an older CLI serves it on fallback limits (200k
  // context, an estimated cost) and says so on stderr, which
  // `reportUnrecognizedModel` turns into a warning. No `-fast` entry: the CLI
  // gates fast mode on Opus names.
  "claude-sonnet-5-5": defineModel({
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    family: "sonnet",
    reasoning: true,
    context: 1_000_000,
    output: 128_000,
    cost: sonnet5Cost,
    multiplier: 2,
    releaseDate: "2026-09-28",
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
  // Only Opus 4.8, Opus 5 and Opus 5.5 qualify: the CLI gates fast mode on
  // the resolved model name containing `opus-4-8` or `opus-5` (which
  // `claude-opus-5-5` satisfies too, and 2.1.280's model catalog lists
  // `fast_mode` for it outright), so registering a fast entry for any other
  // model would produce a picker option that silently runs at standard speed
  // while displaying the fast price.
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
  // Opus 5.5 needs Claude Code 2.1.280+: the API rejects it from an older CLI
  // with a 400 naming that floor, which the plugin surfaces as a turn error.
  // Thinking cannot be switched off for it (the CLI's catalog marks it
  // `rejects_disabled_thinking`); the plugin never asks for that, so nothing
  // here has to special-case it.
  "claude-opus-5-5": defineModel({
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    family: "opus",
    reasoning: true,
    context: 1_000_000,
    output: 128_000,
    cost: opus55Cost,
    multiplier: 4,
    releaseDate: "2026-09-22",
  }),
  "claude-opus-5-5-fast": defineModel({
    id: "claude-opus-5-5-fast",
    name: "Claude Opus 5.5 Fast",
    family: "opus",
    reasoning: true,
    context: 1_000_000,
    output: 128_000,
    cost: opus55FastCost,
    multiplier: 8,
    releaseDate: "2026-09-22",
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
  "claude-fable-5-1": defineModel({
    id: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    family: "fable",
    reasoning: true,
    context: 1_000_000,
    output: 128_000,
    cost: fable51Cost,
    multiplier: 10,
    releaseDate: "2026-09-01",
  }),
  // Mythos 5 and 5.1 share the corresponding Fable models' capabilities and
  // pricing without the safety classifiers; limited availability via Project
  // Glasswing. `claude --model` simply errors for accounts without access, so
  // they are safe to register unconditionally.
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
  "claude-mythos-5-1": defineModel({
    id: "claude-mythos-5-1",
    name: "Claude Mythos 5.1",
    family: "mythos",
    reasoning: true,
    context: 1_000_000,
    output: 128_000,
    cost: fable51Cost,
    multiplier: 10,
    releaseDate: "2026-09-01",
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

/** Anthropic's published price of one web search, in dollars. */
const WEB_SEARCH_USD = 0.01

/**
 * What one API call cost at list price, in dollars, from its own `usage` and
 * the model that served it: the figure a headless `result` carries as
 * `total_cost_usd`, which the interactive transport has to rebuild because the
 * TUI writes no per-turn cost (its `cost-state` record is a session total,
 * written only now and then).
 *
 * Measured on Claude Code 2.1.288 (h #g208): summed over a turn's distinct
 * calls this equals, to the last digit, the `costUSD` the CLI's own
 * `cost-state` gives that model. A 1-hour cache write is twice the input
 * price, a 5-minute one is the catalog's `cache.write`, and a fast-mode call
 * (`usage.speed === "fast"`) is priced from its `-fast` entry. `model` is the
 * transcript's own field (`claude-haiku-4-5-20251001`), so a dated, `[1m]` or
 * `@account` spelling resolves to its catalog entry; a model the catalog does
 * not know returns null rather than a guess.
 *
 * A model Anthropic prices by prompt length (Haiku 5.5, from 2.1.293) swaps
 * its WHOLE table for the long-prompt one once the call's prompt crosses the
 * threshold; see `LONG_PROMPT_COSTS` and `longPromptCost`.
 */
export function apiCallCostUsd(model: unknown, usage: any): number | null {
  if (typeof model !== "string" || !usage || typeof usage !== "object") return null
  const base = model.replace(/@.*$/, "").replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "")
  const entry =
    (usage.speed === "fast" ? defaultModels[`${base}${FAST_SUFFIX}`] : undefined) ??
    defaultModels[base]
  if (!entry) return null
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)
  const cost = longPromptCost(base, usage, count) ?? entry.cost
  const split = usage.cache_creation
  const write1h = split ? count(split.ephemeral_1h_input_tokens) : 0
  const write5m = split ? count(split.ephemeral_5m_input_tokens) : count(usage.cache_creation_input_tokens)
  const perMillion =
    count(usage.input_tokens) * cost.input +
    count(usage.output_tokens) * cost.output +
    count(usage.cache_read_input_tokens) * cost.cache.read +
    write5m * cost.cache.write +
    write1h * cost.input * 2
  return perMillion / 1_000_000 + count(usage.server_tool_use?.web_search_requests) * WEB_SEARCH_USD
}

/**
 * The long-prompt table for this call, in `OpenCodeModel["cost"]` shape, or
 * null when the model has no such tier or the prompt stayed under it.
 *
 * The comparison is the CLI's own, read out of 2.1.293: the three prompt-side
 * counters added together, strictly greater than the threshold. Output tokens
 * are not part of it, and a call that crosses the line prices every one of its
 * tokens at this table, not only the ones past it.
 */
function longPromptCost(
  base: string,
  usage: any,
  count: (value: unknown) => number,
): OpenCodeModel["cost"] | null {
  const tier = LONG_PROMPT_COSTS[base]
  if (!tier) return null
  const promptTokens =
    count(usage.input_tokens) +
    count(usage.cache_read_input_tokens) +
    count(usage.cache_creation_input_tokens)
  if (promptTokens <= tier.aboveTokens) return null
  return {
    input: tier.cost.input,
    output: tier.cost.output,
    cache: { read: tier.cost.cacheRead, write: tier.cost.cacheWrite },
  }
}
