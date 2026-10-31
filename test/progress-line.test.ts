/**
 * The model behind the sidebar's progress lines (h #g246, h #g247, h #g251):
 * what a line measures, when the session's own line shows and lingers, a
 * plan's and an estimate's cells, the band an estimate draws, the fill memory
 * that keeps a bar from stepping back, the width fit, and what the TUI
 * remembers about a session's status.
 *
 * The estimate itself is `src/turn-model.ts`' and is tested in
 * `test/turn-model.test.ts`; here a view carries one and the line is laid out
 * from it.
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  BAR_WIDTH,
  PROGRESS_LINGER_MS,
  STATUS_WATCH_CAP,
  TURN_PROGRESS_SLACK_MS,
  createFillMemory,
  createStatusWatch,
  estimateBandCells,
  estimateCells,
  filledCells,
  floorByChildren,
  formatElapsed,
  layoutProgressLine,
  liveOutput,
  measureProgress,
  progressLineText,
  rowProgress,
  sessionProgress,
  turnMessages,
  type ProgressMessage,
  type ProgressSource,
  type ProgressView,
} from "../src/progress-line.js"
import { SIDEBAR_ROW_WIDTH, SPINNER_FRAMES } from "../src/subagent-sidebar.js"

const NOW = 1_800_000_000_000

const user = (created: number, chars?: number): ProgressMessage => ({ role: "user", created, tools: [], chars })
const assistant = (
  created: number,
  tools: Array<[string, string]> = [],
  error = false,
): ProgressMessage => ({
  role: "assistant",
  created,
  error,
  tools: tools.map(([name, status]) => ({ name, status })),
})

const source = (messages: ProgressMessage[], todos: Array<string | undefined> = []): ProgressSource => ({
  messages,
  todos: todos.map((status) => ({ status })),
})

test("turnMessages is the last user message and what follows, or everything without one", () => {
  const isUser = (message: ProgressMessage) => message.role === "user"
  const thread = [user(1), assistant(2), user(3), assistant(4), assistant(5)]
  assert.deepEqual(turnMessages(thread, isUser), thread.slice(2))
  // A conversation whose last message is the user's is a turn of one.
  assert.deepEqual(turnMessages([user(1), assistant(2), user(3)], isUser), [user(3)])
  // No user message at all, or the first one: the whole thread, the same array.
  const replies = [assistant(1), assistant(2)]
  assert.equal(turnMessages(replies, isUser), replies)
  const fromStart = [user(1), assistant(2)]
  assert.equal(turnMessages(fromStart, isUser), fromStart)
  assert.deepEqual(turnMessages([], isUser), [])
  // What it hands over measures the same as the whole thread does.
  const whole = measureProgress(source(thread))
  assert.deepEqual(measureProgress(source([...turnMessages(thread, isUser)])), whole)
})

test("measureProgress dates the turn from the last user message, keeps its length, and counts the calls after it", () => {
  const measure = measureProgress(
    source([
      user(NOW - 90_000, 2_000),
      assistant(NOW - 89_000, [["read", "completed"], ["bash", "completed"]]),
      user(NOW - 60_000, 420),
      assistant(NOW - 59_000, [["grep", "completed"]]),
      assistant(NOW - 30_000, [["edit", "completed"], ["bash", "running"]]),
    ]),
  )
  assert.equal(measure.startedAt, NOW - 60_000)
  assert.equal(measure.chars, 420)
  assert.equal(measure.calls, 3)
  assert.equal(measure.tool, "bash")
  assert.equal(measure.failed, false)
  assert.equal(measure.plan, undefined)
  // A message of unknown length is unknown, not zero.
  assert.equal(measureProgress(source([user(1)])).chars, undefined)
})

test("measureProgress names a tool only while the newest call still runs", () => {
  const done = measureProgress(source([user(1), assistant(2, [["bash", "running"], ["read", "completed"]])]))
  assert.equal(done.tool, undefined)
  const pending = measureProgress(source([user(1), assistant(2, [["read", "completed"], ["bash", "pending"]])]))
  assert.equal(pending.tool, "bash")
  const unnamed = measureProgress(source([user(1), { role: "assistant", tools: [{ status: "running" }] }]))
  assert.equal(unnamed.tool, undefined)
  assert.equal(unnamed.calls, 1)
})

test("measureProgress reads the failure off the newest reply and the plan off the todo list", () => {
  const failed = measureProgress(
    source([user(1), assistant(2, [], true), assistant(3, [], false), assistant(4, [], true)], [
      "completed",
      "in_progress",
      "pending",
      "cancelled",
      "completed",
    ]),
  )
  assert.equal(failed.failed, true)
  assert.deepEqual(failed.plan, { done: 2, total: 4 })
  // An earlier reply's error is not this turn's.
  const recovered = measureProgress(source([user(1), assistant(2, [], true), assistant(3, [], false)]))
  assert.equal(recovered.failed, false)
  // Every item cancelled is no plan at all.
  assert.equal(measureProgress(source([], ["cancelled", "cancelled"])).plan, undefined)
})

test("measureProgress with no user message at all takes the whole transcript as the turn", () => {
  const measure = measureProgress(source([assistant(5, [["bash", "completed"]]), assistant(6, [["read", "running"]])]))
  assert.equal(measure.startedAt, undefined)
  assert.equal(measure.chars, undefined)
  assert.equal(measure.calls, 2)
  assert.equal(measure.tool, "read")
})

test("sessionProgress runs while busy, elapsed from the turn's start, else from when the TUI saw it busy", () => {
  const measure = measureProgress(source([user(NOW - 63_000), assistant(NOW - 62_000, [["bash", "running"]])]))
  const running = sessionProgress(measure, { status: "busy", now: NOW })
  assert.deepEqual(running, {
    state: "running",
    plan: undefined,
    elapsedMs: 63_000,
    calls: 1,
    tool: "bash",
  })
  const undated = sessionProgress(measureProgress(source([])), { status: "busy", busySince: NOW - 4_000, now: NOW })
  assert.equal(undated?.elapsedMs, 4_000)
  // Busy with nothing dating it at all: the line still shows, at zero.
  assert.equal(sessionProgress(measureProgress(source([])), { status: "busy", now: NOW })?.elapsedMs, 0)
})

test("sessionProgress lingers a finished turn with its final state, then leaves", () => {
  const ok = measureProgress(source([user(NOW - 130_000), assistant(NOW - 100_000, [["bash", "completed"]])]))
  const lingering = sessionProgress(ok, { status: "idle", stoppedAt: NOW - PROGRESS_LINGER_MS, now: NOW })
  assert.deepEqual(lingering, {
    state: "done",
    plan: undefined,
    elapsedMs: 130_000 - PROGRESS_LINGER_MS,
    calls: 1,
    tool: undefined,
  })
  const failed = measureProgress(source([user(NOW - 130_000), assistant(NOW - 100_000, [], true)]))
  assert.equal(sessionProgress(failed, { status: "idle", stoppedAt: NOW - 1_000, now: NOW })?.state, "error")
  // Past the linger, nothing.
  assert.equal(sessionProgress(ok, { status: "idle", stoppedAt: NOW - PROGRESS_LINGER_MS - 1, now: NOW }), undefined)
  // Idle with no stop the TUI saw: nothing to linger.
  assert.equal(sessionProgress(ok, { status: "idle", now: NOW }), undefined)
  assert.equal(sessionProgress(ok, { status: "unknown", now: NOW }), undefined)
})

test("sessionProgress never lingers a stop older than the turn it would describe", () => {
  // A new prompt just arrived (its message is newer than the last stop) and
  // opencode has not marked the session busy yet: no line, rather than the
  // old turn's with a negative elapsed.
  const measure = measureProgress(source([user(NOW - 500)]))
  assert.equal(sessionProgress(measure, { status: "idle", stoppedAt: NOW - 2_000, now: NOW }), undefined)
})

test("rowProgress runs by the row's say-so, dated from its own turn, else from the dispatch", () => {
  const measure = measureProgress(source([user(NOW - 45_000), assistant(NOW - 44_000, [["read", "running"]])]))
  assert.deepEqual(rowProgress(measure, { started: NOW - 50_000, now: NOW }), {
    state: "running",
    plan: undefined,
    elapsedMs: 45_000,
    calls: 1,
    tool: "read",
  })
  // A child whose messages the TUI does not hold is dated from the dispatch.
  const unseen = rowProgress(measureProgress(source([])), { started: NOW - 50_000, now: NOW })
  assert.equal(unseen.elapsedMs, 50_000)
  assert.equal(unseen.calls, 0)
})

test("createStatusWatch remembers a run's start and its stop, both ways, and forgets the oldest session", () => {
  const watch = createStatusWatch()
  assert.deepEqual(watch.observe("ses_a", "idle", 1), { busySince: undefined, stoppedAt: undefined })
  assert.deepEqual(watch.observe("ses_a", "busy", 10), { busySince: 10, stoppedAt: undefined })
  // Still busy: the start holds.
  assert.deepEqual(watch.observe("ses_a", "busy", 20), { busySince: 10, stoppedAt: undefined })
  assert.deepEqual(watch.observe("ses_a", "idle", 30), { busySince: 10, stoppedAt: 30 })
  // Still idle: the stop holds, which is what the linger reads.
  assert.deepEqual(watch.observe("ses_a", "idle", 40), { busySince: 10, stoppedAt: 30 })
  // A new run forgets the stop.
  assert.deepEqual(watch.observe("ses_a", "busy", 50), { busySince: 50, stoppedAt: undefined })
  // Unknown says nothing: it neither starts nor stops a run.
  assert.deepEqual(watch.observe("ses_a", "unknown", 60), { busySince: 50, stoppedAt: undefined })
  assert.deepEqual(watch.observe("ses_a", "idle", 70), { busySince: 50, stoppedAt: 70 })
  // Busy straight from unknown is a start too.
  assert.deepEqual(watch.observe("ses_b", "busy", 5), { busySince: 5, stoppedAt: undefined })

  const capped = createStatusWatch()
  for (let index = 0; index < STATUS_WATCH_CAP; index += 1) capped.observe(`ses_${index}`, "busy", index)
  capped.observe("ses_new", "busy", 1_000)
  // The second observed is still remembered; the first was forgotten for the
  // newcomer, so it reads as never seen.
  assert.deepEqual(capped.observe("ses_1", "idle", 2_000), { busySince: 1, stoppedAt: 2_000 })
  assert.deepEqual(capped.observe("ses_0", "idle", 2_000), { busySince: undefined, stoppedAt: undefined })
})

test("createFillMemory only ever advances a bar within a turn, and starts over with the next", () => {
  const fills = createFillMemory()
  assert.equal(fills.hold("ses_a", 100, 0.3), 0.3)
  // The estimate's total rose and the raw fill fell: the bar holds.
  assert.equal(fills.hold("ses_a", 100, 0.2), 0.3)
  assert.equal(fills.hold("ses_a", 100, 0.5), 0.5)
  // A new turn, a new bar.
  assert.equal(fills.hold("ses_a", 200, 0.1), 0.1)
  // Another session is its own.
  assert.equal(fills.hold("ses_b", 100, 0.05), 0.05)

  const capped = createFillMemory()
  for (let index = 0; index < STATUS_WATCH_CAP; index += 1) capped.hold(`ses_${index}`, 1, 0.9)
  capped.hold("ses_new", 1, 0.9)
  assert.equal(capped.hold("ses_1", 1, 0.1), 0.9, "the second observed is still held")
  assert.equal(capped.hold("ses_0", 1, 0.1), 0.1, "the first was forgotten for the newcomer")
})

test("holdEstimate holds an estimate's fill and both edges of its band within a turn, and lets the total say what the model says now", () => {
  const fills = createFillMemory()
  const first = fills.holdEstimate("ses_a", 100, {
    totalMs: 100_000,
    fill: 0.3,
    over: false,
    band: { lowMs: 60_000, highMs: 150_000, sure: 0.2, maybe: 0.5 },
  })
  assert.deepEqual(first.band, { lowMs: 60_000, highMs: 150_000, sure: 0.2, maybe: 0.5 })
  // The total rose, so every share fell: the bar holds each at its highest,
  // and the text, which is the total and the band's times, is the model's now.
  const later = fills.holdEstimate("ses_a", 100, {
    totalMs: 200_000,
    fill: 0.25,
    over: false,
    band: { lowMs: 120_000, highMs: 300_000, sure: 0.15, maybe: 0.4 },
  })
  assert.equal(later.totalMs, 200_000)
  assert.deepEqual([later.fill, later.band?.sure, later.band?.maybe], [0.3, 0.2, 0.5])
  assert.deepEqual([later.band?.lowMs, later.band?.highMs], [120_000, 300_000])
  // A new turn starts over.
  const next = fills.holdEstimate("ses_a", 200, {
    totalMs: 50_000,
    fill: 0.1,
    over: false,
    band: { lowMs: 40_000, highMs: 80_000, sure: 0.06, maybe: 0.12 },
  })
  assert.deepEqual([next.fill, next.band?.sure, next.band?.maybe], [0.1, 0.06, 0.12])
  // An estimate with no band holds its fill alone, in the same memory as the plain hold.
  assert.deepEqual(fills.holdEstimate("ses_a", 200, { totalMs: 50_000, fill: 1, over: true }), {
    totalMs: 50_000,
    fill: 1,
    over: true,
  })
  assert.equal(fills.hold("ses_a", 200, 0.5), 1)
})

test("filledCells rounds, but is never full before the last item nor empty after the first", () => {
  assert.equal(filledCells({ done: 0, total: 4 }), 0)
  assert.equal(filledCells({ done: 4, total: 4 }), BAR_WIDTH)
  assert.equal(filledCells({ done: 5, total: 4 }), BAR_WIDTH)
  assert.equal(filledCells({ done: 1, total: 3 }), 3)
  assert.equal(filledCells({ done: 2, total: 3 }), 7)
  assert.equal(filledCells({ done: 1, total: 20 }), 1)
  assert.equal(filledCells({ done: 19, total: 20 }), BAR_WIDTH - 1)
  assert.equal(filledCells({ done: 1, total: 1 }), BAR_WIDTH)
  assert.equal(filledCells({ done: 0, total: 0 }), 0)
})

test("estimateCells rounds the fill, is never full until the turn is over every recorded one, and is full then", () => {
  assert.equal(estimateCells({ totalMs: 1, fill: 0, over: false }), 0)
  assert.equal(estimateCells({ totalMs: 1, fill: 0.04, over: false }), 0)
  assert.equal(estimateCells({ totalMs: 1, fill: 0.05, over: false }), 1)
  assert.equal(estimateCells({ totalMs: 1, fill: 0.42, over: false }), 4)
  assert.equal(estimateCells({ totalMs: 1, fill: 0.97, over: false }), BAR_WIDTH - 1)
  assert.equal(estimateCells({ totalMs: 1, fill: 1, over: false }), BAR_WIDTH - 1)
  assert.equal(estimateCells({ totalMs: 1, fill: 1, over: true }), BAR_WIDTH)
})

test("estimateBandCells splits the lit cells at the band's far end and lights the track to its near end, and only the track may reach the last cell", () => {
  const banded = (fill: number, sure: number, maybe: number) => ({
    totalMs: 1,
    fill,
    over: false,
    band: { lowMs: 1, highMs: 1, sure, maybe },
  })
  assert.deepEqual(estimateBandCells(banded(0.42, 0.25, 0.71)), { sure: 3, likely: 4, band: 7 })
  // The lit count is estimateCells' exactly, so never full before over.
  assert.deepEqual(estimateBandCells(banded(0.97, 0.9, 1)), { sure: 9, likely: BAR_WIDTH - 1, band: BAR_WIDTH })
  // An edge on the wrong side of the fill is clamped to it.
  assert.deepEqual(estimateBandCells(banded(0.42, 0.6, 0.3)), { sure: 4, likely: 4, band: 4 })
  assert.deepEqual(estimateBandCells(banded(0, 0, 0)), { sure: 0, likely: 0, band: 0 })
  // No band, and over: the lit cells alone.
  assert.deepEqual(estimateBandCells({ totalMs: 1, fill: 0.42, over: false }), { sure: 4, likely: 4, band: 4 })
  assert.deepEqual(estimateBandCells({ ...banded(1, 0.9, 1), over: true }), {
    sure: BAR_WIDTH,
    likely: BAR_WIDTH,
    band: BAR_WIDTH,
  })
})

test("floorByChildren keeps a parked parent's estimate at least as long as its foreground children have left", () => {
  // Fifty seconds into a turn expected to take 100 s, ending between 80 s and 140 s.
  const parent = {
    totalMs: 100_000,
    fill: 50_000 / 100_000,
    over: false,
    band: { lowMs: 80_000, highMs: 140_000, sure: 50_000 / 140_000, maybe: 50_000 / 80_000 },
  }
  const child = (elapsedMs: number, totalMs: number, band?: { lowMs: number; highMs: number }, over = false): ProgressView => ({
    state: "running",
    elapsedMs,
    calls: 0,
    estimate: {
      totalMs,
      fill: elapsedMs / totalMs,
      over,
      ...(band ? { band: { ...band, sure: elapsedMs / band.highMs, maybe: Math.min(1, elapsedMs / band.lowMs) } } : {}),
    },
  })
  // A child with less left than the parent changes nothing, the same object back.
  const short = child(10_000, 30_000, { lowMs: 20_000, highMs: 40_000 })
  assert.equal(floorByChildren(parent, 50_000, [short]), parent)
  // A child with 120 s left (90 s to 180 s) raises the total and both edges,
  // and the shares follow from the elapsed.
  const long = child(30_000, 150_000, { lowMs: 120_000, highMs: 210_000 })
  const floored = floorByChildren(parent, 50_000, [long])
  assert.deepEqual(floored, {
    totalMs: 170_000,
    fill: 50_000 / 170_000,
    over: false,
    band: { lowMs: 140_000, highMs: 230_000, sure: 50_000 / 230_000, maybe: Math.min(1, 50_000 / 140_000) },
  })
  // A batch waits for every child it started: the longest of each wins.
  assert.deepEqual(floorByChildren(parent, 50_000, [short, long]), floored)
  // A child past its own record, a finished one, or one with no estimate floors nothing.
  assert.equal(floorByChildren(parent, 50_000, [child(30_000, 150_000, undefined, true)]), parent)
  assert.equal(floorByChildren(parent, 50_000, [{ ...long, state: "done" }]), parent)
  assert.equal(floorByChildren(parent, 50_000, [{ state: "running", elapsedMs: 1, calls: 0 }]), parent)
  // An over parent stays over.
  const over = { totalMs: 40_000, fill: 1, over: true }
  assert.equal(floorByChildren(over, 50_000, [long]), over)
  // A parent with no band is floored in its total, and a child with none
  // floors every edge with its median.
  assert.deepEqual(floorByChildren({ totalMs: 100_000, fill: 0.5, over: false }, 50_000, [long]), {
    totalMs: 170_000,
    fill: 50_000 / 170_000,
    over: false,
  })
  const plain = floorByChildren(parent, 50_000, [child(30_000, 150_000)])
  assert.deepEqual([plain.band?.lowMs, plain.band?.highMs], [170_000, 170_000])
})

test("liveOutput reads the live channel's count only off this turn's record", () => {
  const record = { turn: NOW, out: 5_000 }
  assert.equal(liveOutput(record, NOW - 300), 5_000, "marked after the message that started the turn")
  assert.equal(liveOutput(record, NOW + TURN_PROGRESS_SLACK_MS), 5_000, "within the slack")
  assert.equal(liveOutput(record, NOW + TURN_PROGRESS_SLACK_MS + 1), undefined, "an earlier turn's, or a steered message's restart")
  assert.equal(liveOutput(undefined, NOW), undefined)
  assert.equal(liveOutput(record, undefined), undefined, "no start to check against")
})

test("formatElapsed reads as seconds, then minutes and seconds, then hours and minutes", () => {
  assert.equal(formatElapsed(0), "0s")
  assert.equal(formatElapsed(999), "0s")
  assert.equal(formatElapsed(12_400), "12s")
  assert.equal(formatElapsed(63_000), "1m03s")
  assert.equal(formatElapsed(59 * 60_000 + 59_999), "59m59s")
  assert.equal(formatElapsed(3_720_000), "1h02m")
  assert.equal(formatElapsed(-5_000), "0s")
})

const view = (overrides: Partial<ProgressView> = {}): ProgressView => ({
  state: "running",
  elapsedMs: 63_000,
  calls: 12,
  tool: "bash",
  ...overrides,
})

const roles = (segments: { role: string }[]) => segments.map((segment) => segment.role)
const cells = (value: string) => Array.from(value).length

test("layoutProgressLine draws a plan as the fraction's cells, with the fraction in place of the call count", () => {
  const laid = layoutProgressLine(view({ plan: { done: 2, total: 4 } }), "glyph", SIDEBAR_ROW_WIDTH, 3)
  assert.equal(progressLineText(laid), `${SPINNER_FRAMES[3]} ▰▰▰▰▰▱▱▱▱▱  2/4 · 1m03s · bash`)
  assert.ok(cells(progressLineText(laid)) <= SIDEBAR_ROW_WIDTH)
  assert.deepEqual(roles(laid.lead), ["spinner", "muted"])
  assert.deepEqual(roles(laid.bar), [...Array(5).fill("bar-done"), ...Array(5).fill("bar-track")])
  assert.deepEqual(
    laid.tail.map((segment) => [segment.text, segment.role]),
    [["  ", "muted"], ["2/4", "fraction"], [" · ", "muted"], ["1m03s", "muted"], [" · ", "muted"], ["bash", "tool"]],
  )
})

test("layoutProgressLine draws an estimate as elapsed over the total, in the estimate's own role", () => {
  const laid = layoutProgressLine(view({ estimate: { totalMs: 150_000, fill: 0.42, over: false } }), "indent")
  assert.equal(progressLineText(laid), " ▰▰▰▰▱▱▱▱▱▱  1m03s/~2m30s · bash")
  assert.ok(cells(progressLineText(laid)) <= SIDEBAR_ROW_WIDTH)
  assert.deepEqual(roles(laid.lead), ["muted"])
  assert.deepEqual(roles(laid.bar), [...Array(4).fill("bar-done"), ...Array(6).fill("bar-track")])
  assert.deepEqual(
    laid.tail.map((segment) => [segment.text, segment.role]),
    [["  ", "muted"], ["1m03s/~2m30s", "estimate"], [" · ", "muted"], ["bash", "tool"]],
  )
  // Past every recorded turn: the bar is full in the over role and the slot says how far over the usual.
  const over = layoutProgressLine(view({ estimate: { totalMs: 40_000, fill: 1, over: true } }), "glyph")
  assert.equal(progressLineText(over), "⠋ ▰▰▰▰▰▰▰▰▰▰  1m03s/~40s · bash")
  assert.ok(over.bar.every((segment) => segment.role === "bar-over"))
  assert.equal(over.tail.find((segment) => segment.text === "1m03s/~40s")?.role, "estimate-over")
  // A plan outranks an estimate.
  const both = layoutProgressLine(view({ plan: { done: 2, total: 4 }, estimate: { totalMs: 150_000, fill: 0.42, over: false } }), "glyph")
  assert.equal(progressLineText(both), "⠋ ▰▰▰▰▰▱▱▱▱▱  2/4 · 1m03s · bash")
})

test("layoutProgressLine draws an estimate's band as colours on the same glyphs: sure, likely, the band's track, the rest", () => {
  const band = { lowMs: 90_000, highMs: 250_000, sure: 0.25, maybe: 0.7 }
  const laid = layoutProgressLine(view({ estimate: { totalMs: 150_000, fill: 0.42, over: false, band } }), "indent")
  assert.equal(progressLineText(laid), " ▰▰▰▰▱▱▱▱▱▱  1m03s/~2m30s · bash", "a band only recolours: the text is a plain estimate's")
  assert.deepEqual(roles(laid.bar), [
    ...Array(3).fill("bar-done"),
    "bar-likely",
    ...Array(3).fill("bar-band"),
    ...Array(3).fill("bar-track"),
  ])
  // Over, a plan and an ended line draw no band, whatever the estimate carried.
  const over = layoutProgressLine(view({ estimate: { totalMs: 40_000, fill: 1, over: true, band } }), "glyph")
  assert.ok(over.bar.every((segment) => segment.role === "bar-over"))
  const planned = layoutProgressLine(view({ plan: { done: 2, total: 4 }, estimate: { totalMs: 150_000, fill: 0.42, over: false, band } }), "glyph")
  assert.deepEqual(roles(planned.bar), [...Array(5).fill("bar-done"), ...Array(5).fill("bar-track")])
  const ended = layoutProgressLine(view({ state: "done", estimate: { totalMs: 150_000, fill: 0.42, over: false, band } }), "glyph")
  assert.ok(ended.bar.every((segment) => segment.role === "done"))
})

test("layoutProgressLine draws no bar with neither a plan nor an estimate, with the call count, and under a row as an indent", () => {
  const laid = layoutProgressLine(view(), "indent", SIDEBAR_ROW_WIDTH, 0)
  assert.equal(progressLineText(laid), " 1m03s · 12 calls · bash")
  assert.deepEqual(laid.bar, [])
  assert.deepEqual(roles(laid.lead), ["muted"])
  assert.equal(laid.tail[0]?.text, "1m03s", "no bar, no gap after it")
  assert.equal(laid.tail.find((segment) => segment.text === "bash")?.role, "tool")
  assert.equal(progressLineText(layoutProgressLine(view({ calls: 1 }), "glyph")), "⠋ 1m03s · 1 call · bash")
  assert.equal(progressLineText(layoutProgressLine(view({ calls: 0, tool: undefined }), "indent")), " 1m03s")
})

test("layoutProgressLine fits the width by giving up the call count, then cutting the tool, then dropping it", () => {
  // Too wide: the call count goes.
  const long = layoutProgressLine(view({ calls: 123, tool: "codebase-memory-mcp_search_graph" }), "glyph")
  assert.equal(progressLineText(long), "⠋ 1m03s · codebase-memory-mcp_searc…")
  assert.ok(cells(progressLineText(long)) <= SIDEBAR_ROW_WIDTH, progressLineText(long))
  // With a bar, less room: the tool is cut shorter, the elapsed never.
  const mcp = layoutProgressLine(
    view({ tool: "codebase-memory-mcp_search_graph", estimate: { totalMs: 150_000, fill: 0.3, over: false } }),
    "glyph",
  )
  const text = progressLineText(mcp)
  assert.ok(cells(text) <= SIDEBAR_ROW_WIDTH, text)
  assert.equal(text, "⠋ ▰▰▰▱▱▱▱▱▱▱  1m03s/~2m30s · codeba…")
  assert.equal(mcp.tail.at(-1)?.role, "tool")
  // No room for even two cells of a tool: it goes, the required pieces stay.
  const narrow = layoutProgressLine(view({ plan: { done: 1, total: 2 }, tool: "bash" }), "glyph", 26)
  assert.equal(progressLineText(narrow), "⠋ ▰▰▰▰▰▱▱▱▱▱  1/2 · 1m03s")
})

test("layoutProgressLine draws an ended line filled, faded, with its glyph and no tool, whatever it estimated", () => {
  const done = layoutProgressLine(
    view({ state: "done", calls: 12, tool: undefined, estimate: { totalMs: 150_000, fill: 0.42, over: false } }),
    "glyph",
  )
  assert.equal(progressLineText(done), "✓ ▰▰▰▰▰▰▰▰▰▰  1m03s · 12 calls")
  assert.deepEqual(roles(done.lead), ["done", "muted"])
  assert.ok(done.bar.every((segment) => segment.role === "done"))
  const failed = layoutProgressLine(view({ state: "error", plan: { done: 2, total: 4 }, tool: "bash" }), "glyph")
  assert.equal(progressLineText(failed), "✗ ▰▰▰▰▰▰▰▰▰▰  2/4 · 1m03s")
  assert.equal(failed.lead[0].role, "error")
  assert.ok(failed.bar.every((segment) => segment.role === "error"))
  // The fraction is no longer the one bright piece once the line has ended.
  assert.equal(failed.tail.find((segment) => segment.text === "2/4")?.role, "muted")
})

test("layoutProgressLine draws a complete plan full while the session still runs", () => {
  const laid = layoutProgressLine(view({ plan: { done: 4, total: 4 }, tool: "bash" }), "glyph")
  assert.equal(progressLineText(laid), "⠋ ▰▰▰▰▰▰▰▰▰▰  4/4 · 1m03s · bash")
  assert.ok(laid.bar.every((segment) => segment.role === "bar-done"))
})
