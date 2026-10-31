/**
 * What one opencode conversation has spent, so `maxBudgetUsd` can bound it.
 *
 * Nothing else bounds it. Claude Code's own `--max-budget-usd` counts one
 * process's spend and starts from zero on every `--resume` (measured on
 * 2.1.293, h #g245), and opencode's per-agent `steps` cannot see the tools
 * Claude runs itself, because they never end a step. This plugin is the one
 * layer that sees every `result` frame of a conversation, across respawns,
 * accounts and the subagents it dispatches.
 *
 * Two measured facts decide the shape:
 *
 *   - A headless `result`'s `total_cost_usd` is CUMULATIVE for the Claude
 *     session, not for the turn: three messages to one process reported
 *     $0.0094, $0.0160 and $0.0227, while each one's `usage` was its own.
 *     A `--resume` restores it (the resumed process's first result carried the
 *     earlier total plus its own call). So the spend a result adds is the
 *     difference from the last total seen for that Claude session id, and
 *     summing raw totals would count every earlier turn again on each one.
 *   - The interactive transport synthesizes its `result` per turn
 *     (`apiCallCostUsd` over that turn's calls, h #g208), so there the total
 *     IS the turn's spend. The caller says which convention its result has.
 *
 * A child session's spend counts toward its parent's budget, because the
 * subagents a conversation starts are part of what it costs. The link is the
 * child's opencode `parentID`, learned once per session in the prologue
 * (`fetchSessionParentId`) and kept here.
 *
 * In memory only and bounded: a restart starts every conversation's ledger
 * again. The first result a new process sees for a resumed Claude session
 * carries that session's restored total, which this counts in full, so a
 * resumed main conversation picks its earlier spend back up on its first turn.
 * Pure apart from the logger, and nothing here may throw into a turn.
 */
import { log } from "./logger.js"

export const BUDGET_MARKER = "▌ **budget:**"

/** `budgetWarnAt`'s default: a note at half the cap and at four fifths. */
export const DEFAULT_BUDGET_WARN_AT: readonly number[] = [50, 80]

/** Conversations kept; the oldest one touched goes first. */
const MAX_SESSIONS = 256
/** Claude session ids whose last cumulative total is kept. */
const MAX_CLAUDE_SESSIONS = 512

interface SessionSpend {
  /** Dollars this session's own turns spent. */
  own: number
  /** The parent opencode session, `null` for none, `undefined` until asked. */
  parent?: string | null
  /** The highest warn threshold (percent) already written for this session. */
  notedPercent: number
}

const sessions = new Map<string, SessionSpend>()
const lastTotals = new Map<string, number>()

function touch(session: string): SessionSpend {
  let entry = sessions.get(session)
  if (entry) {
    sessions.delete(session)
  } else {
    entry = { own: 0, notedPercent: 0 }
  }
  sessions.set(session, entry)
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next()
    if (oldest.done) break
    sessions.delete(oldest.value)
  }
  return entry
}

/**
 * `maxBudgetUsd` (and an agent's own): a positive, finite number of dollars,
 * or undefined for "no cap". Anything else is refused with one WARN naming
 * the option, because a typo'd cap is a cap that is silently not there.
 */
export function resolveBudgetUsd(value: unknown, option: string): number | undefined {
  if (value === undefined || value === null) return undefined
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0) return parsed
  log.warn("budget option refused: not a positive number of dollars", { option })
  return undefined
}

/**
 * `maxTurns` and `maxBackgroundSubagents`: a positive integer, or undefined.
 * Refused the same way as a budget.
 */
export function resolvePositiveInteger(value: unknown, option: string): number | undefined {
  if (value === undefined || value === null) return undefined
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  if (typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0) return parsed
  log.warn("cap option refused: not a positive whole number", { option })
  return undefined
}

/**
 * `budgetWarnAt`: percentages of the cap, each above 0 and below 100, sorted
 * and deduplicated. Unset is the default `[50, 80]`; an empty array turns the
 * warnings off and keeps the stop. A value that is not an array of such
 * numbers keeps the default and WARNs once.
 */
export function resolveBudgetWarnAt(value: unknown): number[] {
  if (value === undefined || value === null) return [...DEFAULT_BUDGET_WARN_AT]
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry > 0 && entry < 100)
  ) {
    log.warn("budgetWarnAt refused: expected percentages between 0 and 100", {
      option: "budgetWarnAt",
    })
    return [...DEFAULT_BUDGET_WARN_AT]
  }
  return [...new Set(value as number[])].sort((a, b) => a - b)
}

/**
 * The dollars one `result` frame adds. `cumulative` is true for a headless
 * result, whose `total_cost_usd` is the Claude session's running total; the
 * difference from the last total seen for that session id is the new spend.
 * A total lower than the last one (a session id reused for a fresh
 * conversation) or a session seen for the first time counts in full.
 */
export function costDelta(
  claudeSessionId: string | undefined,
  totalCostUsd: number,
  cumulative: boolean,
): number {
  return takeResultCost(claudeSessionId, totalCostUsd, cumulative).deltaUsd
}

/** What one `result` frame cost on its own; see `takeResultCost`. */
export interface ResultCost {
  deltaUsd: number
  /**
   * True when `deltaUsd` is a cumulative total that nothing earlier in this
   * process gave a baseline for. That is exactly right for a session that
   * started in this process, and may include the session's earlier turns when
   * it was resumed, because `--resume` restores the CLI's running total
   * (measured, h #g245). Only a caller that knows whether the process resumed
   * can tell the two apart; the ledger counts it in full either way.
   */
  noBaseline: boolean
}

/**
 * `costDelta` with its baseline answer kept. Moves the session's baseline, so
 * call it ONCE per `result` frame: the budget ledger and the `turnStats`
 * footer share one call (h #g257).
 *
 * `forkedFrom` names the session a rewound thread's fork was cut from
 * (h #g282). The fork's first total carries that session's whole running
 * total (measured on 2.1.314: $0.00935 before the cut, $0.00985 after the
 * fork's one turn of $0.000496), all of it spent and counted already, so the
 * parent's last total is the fork's baseline.
 */
export function takeResultCost(
  claudeSessionId: string | undefined,
  totalCostUsd: number,
  cumulative: boolean,
  forkedFrom?: string,
): ResultCost {
  if (!Number.isFinite(totalCostUsd) || totalCostUsd <= 0) return { deltaUsd: 0, noBaseline: false }
  if (!cumulative) return { deltaUsd: totalCostUsd, noBaseline: false }
  if (!claudeSessionId) return { deltaUsd: totalCostUsd, noBaseline: true }
  const previous =
    lastTotals.get(claudeSessionId) ?? (forkedFrom ? lastTotals.get(forkedFrom) : undefined)
  lastTotals.delete(claudeSessionId)
  lastTotals.set(claudeSessionId, totalCostUsd)
  while (lastTotals.size > MAX_CLAUDE_SESSIONS) {
    const oldest = lastTotals.keys().next()
    if (oldest.done) break
    lastTotals.delete(oldest.value)
  }
  if (previous === undefined) return { deltaUsd: totalCostUsd, noBaseline: true }
  // Lower than the last total: the session id now names a conversation whose
  // running total started over, so this total is the new spend.
  if (totalCostUsd < previous) return { deltaUsd: totalCostUsd, noBaseline: false }
  return { deltaUsd: totalCostUsd - previous, noBaseline: false }
}

/** Add one result's spend to a session's own total. */
export function recordSessionCost(session: string, deltaUsd: number): void {
  if (!(deltaUsd > 0)) return
  touch(session).own += deltaUsd
}

/** Whether this session's parent has been asked about yet. */
export function sessionParentKnown(session: string): boolean {
  return sessions.get(session)?.parent !== undefined
}

/** Remember a session's opencode parent, `null` when it has none. */
export function noteSessionParent(session: string, parent: string | null): void {
  touch(session).parent = parent && parent !== session ? parent : null
}

/** Whether this session is a subagent of another one this ledger knows. */
export function isChildSession(session: string): boolean {
  return typeof sessions.get(session)?.parent === "string"
}

/**
 * The conversation a session's spend belongs to: itself, or the top of its
 * parent chain. Bounded against a cycle, which opencode never builds but a
 * stale entry could.
 */
export function budgetRoot(session: string): string {
  let current = session
  const seen = new Set<string>([current])
  for (;;) {
    const parent = sessions.get(current)?.parent
    if (typeof parent !== "string" || seen.has(parent)) return current
    seen.add(parent)
    current = parent
  }
}

/** Dollars a conversation spent: its own turns and every descendant's. */
export function sessionSpend(root: string): number {
  let total = 0
  for (const [session, entry] of sessions) {
    if (entry.own > 0 && budgetRoot(session) === root) total += entry.own
  }
  return total
}

/**
 * The warn threshold a conversation has just crossed, or null. Only the
 * highest newly crossed one is returned, once: a result that jumps from 40%
 * to 85% writes one note for 80, not two. Reaching the cap itself counts as a
 * threshold of 100, so the turn that spends the last of the budget says the
 * next one will not start.
 */
export function takeCrossedThreshold(
  root: string,
  capUsd: number,
  warnAt: readonly number[],
): { percent: number; spentUsd: number } | null {
  const spentUsd = sessionSpend(root)
  const percentSpent = (spentUsd / capUsd) * 100
  const entry = touch(root)
  const crossed = [...warnAt, 100].filter(
    (threshold) => threshold <= percentSpent && threshold > entry.notedPercent,
  )
  if (crossed.length === 0) return null
  const percent = Math.max(...crossed)
  entry.notedPercent = percent
  return { percent, spentUsd }
}

export function formatUsd(value: number): string {
  if (value >= 100) return `$${value.toFixed(0)}`
  if (value >= 1) return `$${value.toFixed(2)}`
  return `$${value.toFixed(4)}`
}

/** The note a crossed threshold writes, in its own text part. */
export function formatBudgetWarnNote(percent: number, spentUsd: number, capUsd: number): string {
  if (percent >= 100) {
    return (
      `${BUDGET_MARKER} this conversation has spent ${formatUsd(spentUsd)} of its ` +
      `${formatUsd(capUsd)} \`maxBudgetUsd\`, so the next message will not start a turn. ` +
      `Raise \`maxBudgetUsd\` and relaunch opencode, or start a new session.`
    )
  }
  return (
    `${BUDGET_MARKER} this conversation has spent ${formatUsd(spentUsd)}, ${percent}% of ` +
    `its ${formatUsd(capUsd)} \`maxBudgetUsd\`, counting the subagents it started.`
  )
}

/** The note a turn the cap stopped writes instead of running. */
export function formatBudgetStopNote(spentUsd: number, capUsd: number): string {
  return (
    `${BUDGET_MARKER} this conversation has spent ${formatUsd(spentUsd)} against its ` +
    `${formatUsd(capUsd)} \`maxBudgetUsd\`, so this turn was not started and nothing was ` +
    `sent to Claude. Raise \`maxBudgetUsd\` in the provider options and relaunch opencode ` +
    `(plugin options are read once at startup), or start a new session.`
  )
}

/**
 * What one turn needs to keep the ledger, decided in its prologue. Absent
 * (null) unless `maxBudgetUsd` is set and the turn has a real opencode session,
 * so a default install never reaches anything below.
 */
export interface TurnBudget {
  /** The opencode session this turn runs in (its affinity). */
  session: string
  capUsd: number
  warnAt: readonly number[]
  /**
   * Whether this turn may write a warn note. False on compaction (the text is
   * stored as the summary), on a `doGenerate` turn (its text is a return
   * value) and in a child session (its text can become the parent's `task`
   * result). A turn that may not write one leaves the threshold untaken, so
   * the conversation's next turn that can write it does.
   */
  notes: boolean
  /** True for headless, whose `total_cost_usd` is the session's running total. */
  cumulative: boolean
}

/**
 * Record one `result` frame's spend against its session, and return it so the
 * `turnStats` footer reads the same figure (`takeResultCost` moves the
 * baseline). Never throws.
 */
export function recordResultCost(
  budget: TurnBudget,
  claudeSessionId: string | undefined,
  totalCostUsd: unknown,
  forkedFrom?: string,
): ResultCost | undefined {
  if (typeof totalCostUsd !== "number") return undefined
  const cost = takeResultCost(claudeSessionId, totalCostUsd, budget.cumulative, forkedFrom)
  recordSessionCost(budget.session, cost.deltaUsd)
  return cost
}

/** The warn note a `result` frame should write now, or null. */
export function takeBudgetNote(budget: TurnBudget): string | null {
  if (!budget.notes) return null
  const crossed = takeCrossedThreshold(budgetRoot(budget.session), budget.capUsd, budget.warnAt)
  return crossed ? formatBudgetWarnNote(crossed.percent, crossed.spentUsd, budget.capUsd) : null
}

/** One conversation's spend, for `/claude-code-doctor`. */
export interface BudgetSessionSnapshot {
  session: string
  spentUsd: number
  /** How many child sessions' spend is in `spentUsd`. */
  children: number
}

/** Read-only: every root conversation with spend, largest first. */
export function snapshotBudgets(): BudgetSessionSnapshot[] {
  const roots = new Map<string, BudgetSessionSnapshot>()
  for (const [session, entry] of sessions) {
    const root = budgetRoot(session)
    const row = roots.get(root) ?? { session: root, spentUsd: 0, children: 0 }
    row.spentUsd += entry.own
    if (root !== session && entry.own > 0) row.children++
    roots.set(root, row)
  }
  return [...roots.values()]
    .filter((row) => row.spentUsd > 0)
    .sort((a, b) => b.spentUsd - a.spentUsd)
}

export function _resetBudgetLedgerForTests(): void {
  sessions.clear()
  lastTotals.clear()
}
