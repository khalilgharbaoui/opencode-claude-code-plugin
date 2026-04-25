import type { OpenCodeModel } from "./opencode-types.js"

const PROVIDER_ID = "claude-code"
const NPM = "opencode-claude-code-plugin"

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
  status?: OpenCodeModel["status"]
}): OpenCodeModel {
  return {
    id: opts.id,
    providerID: PROVIDER_ID,
    api: { id: opts.id, url: "", npm: NPM },
    name: opts.name,
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

// Per-token costs derived from Anthropic per-million-token pricing
const haikuCost = { input: 1e-6, output: 5e-6, cacheRead: 1e-7, cacheWrite: 1.25e-6 }
const sonnetCost = { input: 3e-6, output: 15e-6, cacheRead: 3e-7, cacheWrite: 3.75e-6 }
const opusCost = { input: 15e-6, output: 75e-6, cacheRead: 1.5e-6, cacheWrite: 18.75e-6 }

export const defaultModels: Record<string, OpenCodeModel> = {
  "claude-haiku-4-5": defineModel({
    id: "claude-haiku-4-5",
    name: "Claude Code Haiku 4.5",
    family: "haiku",
    reasoning: false,
    context: 200_000,
    output: 8_192,
    cost: haikuCost,
    releaseDate: "2024-10-22",
  }),
  "claude-sonnet-4-5": defineModel({
    id: "claude-sonnet-4-5",
    name: "Claude Code Sonnet 4.5",
    family: "sonnet",
    reasoning: true,
    context: 1_000_000,
    output: 16_384,
    cost: sonnetCost,
    releaseDate: "2025-04-14",
  }),
  "claude-sonnet-4-6": defineModel({
    id: "claude-sonnet-4-6",
    name: "Claude Code Sonnet 4.6",
    family: "sonnet",
    reasoning: true,
    context: 1_000_000,
    output: 16_384,
    cost: sonnetCost,
    releaseDate: "2025-06-19",
  }),
  "claude-opus-4-5": defineModel({
    id: "claude-opus-4-5",
    name: "Claude Code Opus 4.5",
    family: "opus",
    reasoning: true,
    context: 1_000_000,
    output: 16_384,
    cost: opusCost,
    releaseDate: "2025-04-14",
  }),
  "claude-opus-4-6": defineModel({
    id: "claude-opus-4-6",
    name: "Claude Code Opus 4.6",
    family: "opus",
    reasoning: true,
    context: 1_000_000,
    output: 16_384,
    cost: opusCost,
    releaseDate: "2025-06-19",
  }),
  "claude-opus-4-7": defineModel({
    id: "claude-opus-4-7",
    name: "Claude Code Opus 4.7",
    family: "opus",
    reasoning: true,
    context: 1_000_000,
    output: 16_384,
    cost: opusCost,
    releaseDate: "2025-07-16",
  }),
}
