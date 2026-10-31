/**
 * The session budget's ledger (`src/budget-ledger.ts`, h #g245): what one
 * opencode conversation spent, its subagents included, read off the CLI's own
 * `total_cost_usd`. A headless total is CUMULATIVE for the Claude session
 * (measured on 2.1.293: three messages to one process reported $0.0331,
 * $0.0400 and $0.0470), so the ledger takes the difference from the last total
 * it saw for that session id.
 *
 * Usage: npx tsx --test test/budget-ledger.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"

import {
  BUDGET_MARKER,
  DEFAULT_BUDGET_WARN_AT,
  _resetBudgetLedgerForTests,
  budgetRoot,
  costDelta,
  formatBudgetStopNote,
  formatBudgetWarnNote,
  formatUsd,
  isChildSession,
  noteSessionParent,
  recordResultCost,
  recordSessionCost,
  resolveBudgetUsd,
  resolveBudgetWarnAt,
  resolvePositiveInteger,
  sessionParentKnown,
  sessionSpend,
  snapshotBudgets,
  takeBudgetNote,
  takeCrossedThreshold,
  type TurnBudget,
} from "../src/budget-ledger.js"

beforeEach(() => _resetBudgetLedgerForTests())

const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`)

test("a cumulative total adds only what it grew by since the last one", () => {
  // The measured sequence, one process, three messages.
  close(costDelta("claude-a", 0.0330759, true), 0.0330759)
  close(costDelta("claude-a", 0.0400318, true), 0.0400318 - 0.0330759)
  close(costDelta("claude-a", 0.046983, true), 0.046983 - 0.0400318)
  // A result refused with no API call repeats the total: nothing was spent.
  close(costDelta("claude-a", 0.046983, true), 0)
})

test("each Claude session keeps its own running total", () => {
  close(costDelta("claude-a", 0.5, true), 0.5)
  close(costDelta("claude-b", 0.2, true), 0.2)
  close(costDelta("claude-a", 0.7, true), 0.2)
  close(costDelta("claude-b", 0.25, true), 0.05)
})

test("a total that went DOWN is a fresh count and is taken in full", () => {
  close(costDelta("claude-a", 0.5, true), 0.5)
  // A process that started its own count from zero under the same id.
  close(costDelta("claude-a", 0.1, true), 0.1)
  close(costDelta("claude-a", 0.15, true), 0.05)
})

test("a per-turn total (the interactive transport) is the turn's spend", () => {
  close(costDelta("claude-a", 0.3, false), 0.3)
  close(costDelta("claude-a", 0.3, false), 0.3)
  // And it never seeds the cumulative tracker for the same id.
  close(costDelta("claude-a", 0.4, true), 0.4)
})

test("no total, zero, a negative or a non-number adds nothing", () => {
  close(costDelta("claude-a", 0, true), 0)
  close(costDelta("claude-a", -1, true), 0)
  close(costDelta("claude-a", Number.NaN, true), 0)
  const budget: TurnBudget = {
    session: "ses_a",
    capUsd: 1,
    warnAt: [50],
    notes: true,
    cumulative: true,
  }
  recordResultCost(budget, "claude-a", undefined)
  recordResultCost(budget, "claude-a", "0.5")
  close(sessionSpend("ses_a"), 0)
})

test("a child's spend counts toward the conversation that started it", () => {
  noteSessionParent("ses_parent", null)
  noteSessionParent("ses_child", "ses_parent")
  noteSessionParent("ses_grandchild", "ses_child")
  recordSessionCost("ses_parent", 0.4)
  recordSessionCost("ses_child", 0.25)
  recordSessionCost("ses_grandchild", 0.1)
  recordSessionCost("ses_other", 0.9)

  assert.equal(budgetRoot("ses_grandchild"), "ses_parent")
  close(sessionSpend("ses_parent"), 0.75)
  close(sessionSpend("ses_other"), 0.9)
  assert.equal(isChildSession("ses_child"), true)
  assert.equal(isChildSession("ses_parent"), false)
  assert.equal(sessionParentKnown("ses_parent"), true)
  assert.equal(sessionParentKnown("ses_never_asked"), false)

  const rows = snapshotBudgets()
  assert.deepEqual(
    rows.map((row) => [row.session, row.children]),
    [
      ["ses_other", 0],
      ["ses_parent", 2],
    ],
  )
})

test("a parent cycle cannot hang the root walk", () => {
  noteSessionParent("ses_a", "ses_b")
  noteSessionParent("ses_b", "ses_a")
  assert.ok(["ses_a", "ses_b"].includes(budgetRoot("ses_a")))
  // A session named as its own parent is not a child.
  noteSessionParent("ses_self", "ses_self")
  assert.equal(isChildSession("ses_self"), false)
})

test("each warn threshold is written once, and a jump writes only the highest", () => {
  recordSessionCost("ses_a", 0.55)
  assert.deepEqual(takeCrossedThreshold("ses_a", 1, [50, 80]), { percent: 50, spentUsd: 0.55 })
  assert.equal(takeCrossedThreshold("ses_a", 1, [50, 80]), null)

  recordSessionCost("ses_b", 0.9)
  assert.equal(takeCrossedThreshold("ses_b", 1, [50, 80])?.percent, 80)
  assert.equal(takeCrossedThreshold("ses_b", 1, [50, 80]), null)
})

test("reaching the cap is its own threshold, written once", () => {
  recordSessionCost("ses_a", 0.85)
  assert.equal(takeCrossedThreshold("ses_a", 1, [50, 80])?.percent, 80)
  recordSessionCost("ses_a", 0.2)
  assert.equal(takeCrossedThreshold("ses_a", 1, [50, 80])?.percent, 100)
  recordSessionCost("ses_a", 0.2)
  assert.equal(takeCrossedThreshold("ses_a", 1, [50, 80]), null)
  // With the warnings turned off, the cap still says the next turn will not start.
  recordSessionCost("ses_b", 1.2)
  assert.equal(takeCrossedThreshold("ses_b", 1, [])?.percent, 100)
})

test("a turn that may not write a note leaves the threshold for one that may", () => {
  noteSessionParent("ses_child", "ses_parent")
  const child: TurnBudget = {
    session: "ses_child",
    capUsd: 1,
    warnAt: [50, 80],
    notes: false,
    cumulative: true,
  }
  recordResultCost(child, "claude-child", 0.6)
  assert.equal(takeBudgetNote(child), null)

  const parent: TurnBudget = { ...child, session: "ses_parent", notes: true }
  const note = takeBudgetNote(parent)
  assert.ok(note?.startsWith(BUDGET_MARKER))
  assert.match(note!, /\$0\.6000, 50% of its \$1\.00 `maxBudgetUsd`/)
  assert.equal(takeBudgetNote(parent), null)
})

test("the notes name the spend, the cap and the operator's one move", () => {
  const warn = formatBudgetWarnNote(80, 0.84, 1)
  assert.ok(warn.startsWith(BUDGET_MARKER))
  assert.match(warn, /counting the subagents it started/)

  const reached = formatBudgetWarnNote(100, 1.02, 1)
  assert.match(reached, /the next message will not start a turn/)
  assert.match(reached, /Raise `maxBudgetUsd` and relaunch opencode, or start a new session/)

  const stop = formatBudgetStopNote(1.02, 1)
  assert.ok(stop.startsWith(BUDGET_MARKER))
  assert.match(stop, /\$1\.02 against its \$1\.00 `maxBudgetUsd`/)
  assert.match(stop, /nothing was sent to Claude/)
  assert.match(stop, /relaunch opencode/)
  assert.match(stop, /start a new session/)
  for (const text of [warn, reached, stop]) assert.equal(text.includes("\u2014"), false)
})

test("dollars are printed with the digits that carry information", () => {
  assert.equal(formatUsd(0.0094), "$0.0094")
  assert.equal(formatUsd(2.5), "$2.50")
  assert.equal(formatUsd(250), "$250")
})

test("the option resolvers refuse what is not a cap, and say so", () => {
  assert.equal(resolveBudgetUsd(undefined, "maxBudgetUsd"), undefined)
  assert.equal(resolveBudgetUsd(5, "maxBudgetUsd"), 5)
  assert.equal(resolveBudgetUsd("2.5", "maxBudgetUsd"), 2.5)
  assert.equal(resolveBudgetUsd(0, "maxBudgetUsd"), undefined)
  assert.equal(resolveBudgetUsd(-1, "maxBudgetUsd"), undefined)
  assert.equal(resolveBudgetUsd("five", "maxBudgetUsd"), undefined)

  assert.equal(resolvePositiveInteger(3, "maxBackgroundSubagents"), 3)
  assert.equal(resolvePositiveInteger("3", "maxBackgroundSubagents"), 3)
  assert.equal(resolvePositiveInteger(2.5, "maxBackgroundSubagents"), undefined)
  assert.equal(resolvePositiveInteger(0, "maxBackgroundSubagents"), undefined)

  assert.deepEqual(resolveBudgetWarnAt(undefined), [...DEFAULT_BUDGET_WARN_AT])
  assert.deepEqual(resolveBudgetWarnAt([90, 25, 90]), [25, 90])
  assert.deepEqual(resolveBudgetWarnAt([]), [])
  assert.deepEqual(resolveBudgetWarnAt([0, 50]), [50, 80])
  assert.deepEqual(resolveBudgetWarnAt("50"), [50, 80])
  assert.deepEqual(resolveBudgetWarnAt([100]), [50, 80])
})
