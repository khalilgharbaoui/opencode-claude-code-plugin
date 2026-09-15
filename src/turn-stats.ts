import type { ClaudeStreamMessage } from "./types.js"

/**
 * What a finished Claude CLI turn cost, and how much of its input came out of
 * the prompt cache.
 *
 * The CLI already reports all of it on the terminal `result` line, and until
 * now most of it was thrown away: `modelUsage` and `permission_denials` were
 * dropped outright, and the rest only reached `providerMetadata`, where
 * nothing in opencode's UI shows it. The numbers below are always logged at
 * INFO; the one-line footer is opt-in via the `turnStats` provider option,
 * because a cost line under every single reply is a preference, not a default.
 */
export interface TurnStats {
  costUsd?: number
  durationMs?: number
  durationApiMs?: number
  numTurns?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** Per-model totals, keyed by model id. Present from CLI 2.1.x on. */
  modelUsage?: Record<string, unknown>
  /** Tool calls the permission layer refused during the turn. */
  permissionDenials?: unknown[]
}

/**
 * Header of the footer block, and the marker `message-builder` strips by when
 * a transcript is rebuilt for a fresh Claude process. The footer is the
 * plugin's own accounting, never something the model said, so it must not come
 * back as model output on a resume. Kept as the first characters of its own
 * text part so the strip is exact.
 */
export const TURN_STATS_MARKER = "▌ **stats:**"

/**
 * Usage here is the turn total, not the last iteration `toUsage` prefers.
 * Those two answer different questions: `toUsage` feeds opencode's context
 * gauge, where summing every tool-use iteration would inflate the window and
 * trigger premature compaction, while a cost footer has to match the cost the
 * CLI reports, and that cost is cumulative over the whole turn.
 */
export function extractTurnStats(msg: ClaudeStreamMessage): TurnStats {
  const usage = msg.usage
  const stats: TurnStats = {}
  if (typeof msg.total_cost_usd === "number") stats.costUsd = msg.total_cost_usd
  if (typeof msg.duration_ms === "number") stats.durationMs = msg.duration_ms
  if (typeof msg.duration_api_ms === "number") stats.durationApiMs = msg.duration_api_ms
  if (typeof msg.num_turns === "number") stats.numTurns = msg.num_turns
  if (typeof usage?.input_tokens === "number") stats.inputTokens = usage.input_tokens
  if (typeof usage?.output_tokens === "number") stats.outputTokens = usage.output_tokens
  if (typeof usage?.cache_read_input_tokens === "number") {
    stats.cacheReadTokens = usage.cache_read_input_tokens
  }
  if (typeof usage?.cache_creation_input_tokens === "number") {
    stats.cacheWriteTokens = usage.cache_creation_input_tokens
  }
  if (msg.modelUsage && typeof msg.modelUsage === "object") stats.modelUsage = msg.modelUsage
  if (Array.isArray(msg.permission_denials)) stats.permissionDenials = msg.permission_denials
  return stats
}

/** Dollars, at the precision the number actually carries information at. */
export function formatCost(costUsd: number): string {
  if (!Number.isFinite(costUsd) || costUsd < 0) return "$0.00"
  return costUsd >= 1 ? `$${costUsd.toFixed(2)}` : `$${costUsd.toFixed(4)}`
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0.0 s"
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} s`
  const totalSeconds = Math.round(durationMs / 1000)
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`
}

export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0"
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`
  return `${(tokens / 1_000_000).toFixed(1)}M`
}

/**
 * One compact line, or null when the CLI reported nothing worth a line.
 *
 * Zero-valued cache counters are dropped rather than printed as `0`: a turn
 * with no cache activity should read as short, not as a row of zeroes. Cost,
 * duration and turn count are printed whenever the CLI sent them, including at
 * zero, because a genuinely free turn is information.
 */
export function formatTurnStatsLine(stats: TurnStats): string | null {
  const parts: string[] = []
  if (stats.costUsd !== undefined) parts.push(formatCost(stats.costUsd))
  if (stats.durationMs !== undefined) parts.push(formatDuration(stats.durationMs))
  if (stats.numTurns !== undefined) {
    parts.push(`${stats.numTurns} CLI ${stats.numTurns === 1 ? "turn" : "turns"}`)
  }
  if (stats.inputTokens !== undefined) parts.push(`in ${formatTokens(stats.inputTokens)}`)
  if (stats.outputTokens !== undefined) parts.push(`out ${formatTokens(stats.outputTokens)}`)
  if (stats.cacheReadTokens) parts.push(`cache read ${formatTokens(stats.cacheReadTokens)}`)
  if (stats.cacheWriteTokens) parts.push(`cache write ${formatTokens(stats.cacheWriteTokens)}`)
  if (stats.permissionDenials?.length) {
    const count = stats.permissionDenials.length
    parts.push(`${count} permission ${count === 1 ? "denial" : "denials"}`)
  }
  if (parts.length === 0) return null
  return `${TURN_STATS_MARKER} ${parts.join(" · ")}`
}

/** The footer as its own text part: a leading newline keeps it off the reply's last line. */
export function formatTurnStatsBlock(stats: TurnStats): string | null {
  const line = formatTurnStatsLine(stats)
  return line === null ? null : `\n${line}\n`
}

/** Flat payload for the INFO line, which is emitted whether or not the footer is. */
export function turnStatsLogPayload(stats: TurnStats): Record<string, unknown> {
  return {
    costUsd: stats.costUsd ?? null,
    durationMs: stats.durationMs ?? null,
    durationApiMs: stats.durationApiMs ?? null,
    numTurns: stats.numTurns ?? null,
    inputTokens: stats.inputTokens ?? null,
    outputTokens: stats.outputTokens ?? null,
    cacheReadTokens: stats.cacheReadTokens ?? null,
    cacheWriteTokens: stats.cacheWriteTokens ?? null,
    modelUsage: stats.modelUsage ?? null,
    permissionDenials: stats.permissionDenials?.length ?? 0,
  }
}
