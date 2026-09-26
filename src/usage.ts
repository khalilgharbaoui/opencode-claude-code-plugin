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
  // Prefer the last iteration's counters over cumulative totals.
  // CLI usage is the sum across all internal tool-use iterations;
  // using it directly inflates context size and triggers premature compaction.
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

export function toFinishReason(
  reason: "stop" | "tool-calls" | "error" = "stop",
): LanguageModelV3FinishReason {
  return {
    unified: reason,
    raw: reason,
  }
}
