/**
 * Mapping the Claude CLI's own counters onto the AI SDK's usage and finish
 * shapes.
 *
 * Split out of `claude-code-language-model.ts` verbatim. Neither function
 * ever read `this`, so both became free functions unchanged and the class
 * keeps its `toUsage` / `toFinishReason` methods as one-line delegates (the
 * turn controller binds them).
 */
import type {
  LanguageModelV3FinishReason,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import type { ClaudeStreamMessage } from "./types.js"

export function toUsage(rawUsage?: ClaudeStreamMessage["usage"]): LanguageModelV3Usage {
  // `iterations` is the API's per-request list of server-side sampling
  // iterations, normally empty. It is NOT a per-tool-loop breakdown of the
  // turn: the CLI's `result.usage` sums every API call and copies `iterations`
  // from the last response only. When one is present its last entry is that
  // request's effective context. The turn sum is kept out of here by
  // `lastCallContextUsage` below.
  const iter = rawUsage?.iterations
  const effective = iter?.length ? iter[iter.length - 1] : rawUsage
  // Claude CLI reports input_tokens as non-cached input only.
  // OpenCode expects total = noCache + cacheRead + cacheWrite.
  const noCache = effective?.input_tokens ?? 0
  const cacheRead = effective?.cache_read_input_tokens ?? 0
  const cacheWrite = effective?.cache_creation_input_tokens ?? 0
  return {
    inputTokens: {
      total: noCache + cacheRead + cacheWrite,
      noCache,
      cacheRead: cacheRead || undefined,
      cacheWrite: cacheWrite || undefined,
    },
    outputTokens: {
      total: effective?.output_tokens,
      text: effective?.output_tokens,
      reasoning: undefined,
    },
    raw: rawUsage as any,
  }
}

/**
 * The usage a finish reports, which opencode reads as the context the
 * conversation occupies and compacts on. The `result`'s usage is summed over
 * every API call of the turn, so a tool-heavy turn read as several times its
 * real context. The input side comes from the last real call instead (its
 * last `iterations` entry when it has one, as the CLI's own context gauge
 * does); output stays the turn total, as the interactive transport reports it.
 *
 * No call seen means the result's usage exactly as before, and no result yet
 * (a mid-turn proxied-tool boundary) means nothing, as before.
 */
export function lastCallContextUsage(
  lastCallUsage: ClaudeStreamMessage["usage"],
  turnTotalUsage: ClaudeStreamMessage["usage"],
): ClaudeStreamMessage["usage"] {
  if (!lastCallUsage || !turnTotalUsage) return turnTotalUsage
  const iterations = lastCallUsage.iterations
  const context = iterations?.length ? iterations[iterations.length - 1] : lastCallUsage
  return {
    input_tokens: context.input_tokens,
    cache_read_input_tokens: context.cache_read_input_tokens,
    cache_creation_input_tokens: context.cache_creation_input_tokens,
    output_tokens: turnTotalUsage.output_tokens,
  }
}

export function toFinishReason(
  reason: "stop" | "tool-calls" | "error" = "stop",
): LanguageModelV3FinishReason {
  return {
    unified: reason,
    raw: reason,
  }
}
