/**
 * The model behind the sidebar's progress lines (`src/tui.ts`, h #g246,
 * h #g247): one for the session on screen, under a `Main Progress` heading
 * above `Subagents`, and one under each RUNNING subagent row:
 *
 *     Main Progress
 *     ⠋ ▰▰▰▰▱▱▱▱▱▱  1m02s/~2m30s · bash
 *     Subagents
 *     ⠋ implementor Fix the dispatch form…
 *      sonnet-5.5 · high · alpha · $0.42
 *      ▰▰▰▱▱▱▱▱▱▱  45s/~2m10s · read
 *
 * What the bar means, in order of what the session has:
 *
 *   - With a todo list it is the fraction of items completed and the line
 *     says which, `2/4`, beside the elapsed. opencode 1.x's TUI store holds
 *     every session's list (the CLI's TaskCreate family reaches it as
 *     `todowrite`, h #g85); opencode 2.x exposes none to a TUI plugin. A bar
 *     is never full before the last item is done and never empty once the
 *     first is.
 *   - Else, with history for this agent and model, it is the turn's elapsed
 *     over its estimated total (`src/turn-model.ts`: a log-normal fitted to
 *     the recorded turns, conditioned on this one having run this long, read
 *     through the calibration of the model's own past errors), and the line
 *     says both, `1m02s/~2m30s`. The bar draws the estimate's band as well:
 *     the cells covered even if the turn runs to the band's far end in the
 *     full colour, the rest of the cells covered at the estimate in a softer
 *     one, and the track the turn has covered if it ends at the band's near
 *     end a little brighter than the rest of the track:
 *
 *         ▰▰▰▰▰▰▱▱▱▱      sure ▰▰▰▰ · likely ▰▰ · band ▱▱ · track ▱▱
 *
 *     Nothing on the bar ever steps back within a turn (`createFillMemory`),
 *     though the total it is drawn against can rise, which it does while a
 *     foreground subagent has longer left than the session's own estimate
 *     (`floorByChildren`). Past every recorded turn it is full in the
 *     warning colour and the total shown is the usual one.
 *   - Else there is no bar: the spinner says the session works, and a bar
 *     that could not fill would say nothing the spinner does not.
 *   - The rest is the turn's own record: elapsed since the last user message
 *     (else since the TUI first saw the session busy), the tool calls made
 *     since it, and the tool running now.
 *   - A turn that ended lingers `PROGRESS_LINGER_MS` with its final state, the
 *     bar filled and ✓ or ✗ off the last reply's error, then the line leaves.
 *     A subagent row's line leaves with the row's spinner.
 *
 * Pure, like `src/subagent-sidebar.ts` and for the same reason: the TUI bundle
 * runs on the terminal's own thread, where a logger writes over the interface
 * (h #g193). It imports only that module's text helpers and the estimate's
 * type.
 */
import {
  ROW_INDENT,
  SIDEBAR_ROW_WIDTH,
  SPINNER_FRAMES,
  formatElapsed,
  truncate,
  type ChildRunState,
  type Segment,
} from "./subagent-sidebar.js"
import type { TurnEstimate } from "./turn-model.js"

/** The bar's width in cells. */
export const BAR_WIDTH = 10
/** How long a finished turn's line stays, showing its final state. */
export const PROGRESS_LINGER_MS = 15_000
export const BAR_DONE = "▰"
export const BAR_TODO = "▱"

export interface ProgressToolCall {
  name?: string
  status?: string
}

export interface ProgressMessage {
  role: string
  created?: number
  /** The message ended in an error (an assistant message's `error`). */
  error?: boolean
  /** The message's tool calls, in order. */
  tools: ProgressToolCall[]
  /** A user message's length in characters (`promptChars`); absent when unknown. */
  chars?: number
}

export interface ProgressTodo {
  status?: string
}

/** What a session's own store holds that its progress line is measured from. */
export interface ProgressSource {
  messages: ProgressMessage[]
  todos: ProgressTodo[]
}

export interface ProgressPlan {
  done: number
  total: number
}

export interface ProgressMeasure {
  /** The todo list's completed count over its total; absent without a list. */
  plan?: ProgressPlan
  /** The last user message's time, which is when the turn started. */
  startedAt?: number
  /** The length of the message that started the turn, the estimate's kernel input. */
  chars?: number
  /** Tool calls since that message. */
  calls: number
  /** The tool running now, if one is. */
  tool?: string
  /** The newest reply since that message ended in an error. */
  failed: boolean
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function cells(value: string): number {
  return Array.from(value).length
}

/**
 * The messages a line is measured from: the last user message and everything
 * after it, all of them when there is none. A host hands `measureProgress`
 * only these, so it reads the tool parts of the turn on screen and a long
 * session's earlier messages cost nothing per tick.
 */
export function turnMessages<T>(messages: readonly T[], isUser: (message: T) => boolean): readonly T[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isUser(messages[index])) return index === 0 ? messages : messages.slice(index)
  }
  return messages
}

/**
 * The facts a line is built from. The turn is everything after the last user
 * message (all of it when there is none); the tool running now is the newest
 * call only while it is still pending or running; a todo marked `cancelled`
 * is not part of the plan.
 */
export function measureProgress(source: ProgressSource): ProgressMeasure {
  const messages = source.messages
  let turnStart = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      turnStart = index
      break
    }
  }
  let calls = 0
  let tool: string | undefined
  let failed = false
  for (let index = turnStart + 1; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role !== "assistant") continue
    failed = message.error === true
    for (const call of message.tools) {
      calls += 1
      const running = call.status === "running" || call.status === "pending"
      tool = running ? text(call.name) : undefined
    }
  }
  let total = 0
  let done = 0
  for (const todo of source.todos) {
    if (todo.status === "cancelled") continue
    total += 1
    if (todo.status === "completed") done += 1
  }
  return {
    plan: total > 0 ? { done, total } : undefined,
    startedAt: turnStart >= 0 ? messages[turnStart].created : undefined,
    chars: turnStart >= 0 ? messages[turnStart].chars : undefined,
    calls,
    tool,
    failed,
  }
}

/** One line, ready to lay out. */
export interface ProgressView {
  state: "running" | "done" | "error"
  plan?: ProgressPlan
  /** The turn's estimated total from its agent and model's history; the host attaches it while the turn runs. */
  estimate?: TurnEstimate
  elapsedMs: number
  calls: number
  tool?: string
}

/**
 * The line for the session on screen. Running while opencode reports the
 * session busy; after it stopped, its final state for `PROGRESS_LINGER_MS`
 * from the stop; otherwise nothing. A stop older than the turn's own start is
 * an earlier turn's and shows nothing either.
 */
export function sessionProgress(
  measure: ProgressMeasure,
  input: { status: ChildRunState; busySince?: number; stoppedAt?: number; now: number },
): ProgressView | undefined {
  const startedAt = measure.startedAt ?? input.busySince
  if (input.status === "busy") {
    return {
      state: "running",
      plan: measure.plan,
      elapsedMs: Math.max(0, input.now - (startedAt ?? input.now)),
      calls: measure.calls,
      tool: measure.tool,
    }
  }
  if (input.stoppedAt === undefined) return undefined
  if (startedAt !== undefined && input.stoppedAt < startedAt) return undefined
  if (input.now - input.stoppedAt > PROGRESS_LINGER_MS) return undefined
  return {
    state: measure.failed ? "error" : "done",
    plan: measure.plan,
    elapsedMs: Math.max(0, input.stoppedAt - (startedAt ?? input.stoppedAt)),
    calls: measure.calls,
    tool: undefined,
  }
}

/**
 * The line under a running subagent row. The row's own state says it runs,
 * and the turn's start falls back to the row's, which is the dispatch.
 */
export function rowProgress(measure: ProgressMeasure, input: { started: number; now: number }): ProgressView {
  const startedAt = measure.startedAt ?? input.started
  return {
    state: "running",
    plan: measure.plan,
    elapsedMs: Math.max(0, input.now - startedAt),
    calls: measure.calls,
    tool: measure.tool,
  }
}

/** What the TUI remembers about a session's status, for the two inputs no store carries. */
export interface StatusMemory {
  /** When the TUI first saw the session busy, this run. */
  busySince?: number
  /** When the TUI saw it go idle after that. */
  stoppedAt?: number
}

/** How many sessions the watch and the fill memory remember; the oldest observed is forgotten first. */
export const STATUS_WATCH_CAP = 256

/**
 * Status transitions as the TUI observes them. Busy after anything else dates
 * the run and forgets the earlier stop; idle after busy dates the stop; an
 * unchanged status, and `unknown`, change nothing. Both dates are kept until
 * the next run starts, which is what lets a finished line linger.
 */
export function createStatusWatch() {
  const seen = new Map<string, { status: ChildRunState } & StatusMemory>()
  return {
    observe(sessionID: string, status: ChildRunState, now: number): StatusMemory {
      let entry = seen.get(sessionID)
      if (!entry) {
        entry = { status: "unknown" }
        if (seen.size >= STATUS_WATCH_CAP) {
          const oldest = seen.keys().next().value
          if (oldest !== undefined) seen.delete(oldest)
        }
        seen.set(sessionID, entry)
      }
      if (status === "busy" && entry.status !== "busy") {
        entry.busySince = now
        entry.stoppedAt = undefined
      } else if (status === "idle" && entry.status === "busy") {
        entry.stoppedAt = now
      }
      if (status !== "unknown") entry.status = status
      return { busySince: entry.busySince, stoppedAt: entry.stoppedAt }
    },
  }
}

/**
 * The fill a session's bar has reached this turn, so the bar only ever
 * advances within a turn: the estimate's total rises as the turn outlasts
 * recorded ones, and a cell that went dark again would read as work undone.
 * Keyed by the turn's own start, so a new turn starts the bar over.
 */
export function createFillMemory() {
  const held = new Map<string, { turn: number; fill: number }>()
  const hold = (key: string, turn: number, fill: number): number => {
    const entry = held.get(key)
    if (entry && entry.turn === turn) {
      entry.fill = Math.max(entry.fill, fill)
      return entry.fill
    }
    if (!entry && held.size >= STATUS_WATCH_CAP) {
      const oldest = held.keys().next().value
      if (oldest !== undefined) held.delete(oldest)
    }
    held.set(key, { turn, fill })
    return fill
  }
  return {
    hold,
    /**
     * The same hold for a whole estimate: its fill and both edges of its band,
     * each at its highest this turn, so neither the lit cells nor the band's
     * reach ever step back while the total rises. The total is not held: it
     * is the text, and the text says what the model says now. Each edge at
     * its highest stays on its side of the fill, because it is on that side
     * at every moment (elapsed over a longer total, and over a shorter one).
     */
    holdEstimate(sessionID: string, turn: number, estimate: TurnEstimate): TurnEstimate {
      const fill = hold(sessionID, turn, estimate.fill)
      if (!estimate.band) return { ...estimate, fill }
      const sure = hold(`${sessionID}\u0000sure`, turn, estimate.band.sure)
      const maybe = hold(`${sessionID}\u0000maybe`, turn, estimate.band.maybe)
      return {
        ...estimate,
        fill,
        band: { ...estimate.band, sure: Math.min(sure, fill), maybe: Math.max(maybe, fill) },
      }
    },
  }
}

/**
 * How many cells a plan fills: proportional and rounded, but never the whole
 * bar before the last item is done and never none once the first is, so the
 * bar can only say "finished" when the list does.
 */
export function filledCells(plan: ProgressPlan, width: number = BAR_WIDTH): number {
  if (plan.total <= 0 || plan.done <= 0) return 0
  if (plan.done >= plan.total) return width
  return Math.min(width - 1, Math.max(1, Math.round((plan.done / plan.total) * width)))
}

/**
 * How many cells an estimate fills: proportional and rounded, never the
 * whole bar while recorded turns remain to outlast, because the full bar is
 * the `over` state's and must always mean the same thing.
 */
export function estimateCells(estimate: TurnEstimate, width: number = BAR_WIDTH): number {
  if (estimate.over) return width
  return Math.min(width - 1, Math.max(0, Math.round(estimate.fill * width)))
}

/** Where an estimate's band falls on the bar, as cell counts from the left. */
export interface EstimateCells {
  /** Lit in the full colour: covered even if the turn runs to the band's far end. */
  sure: number
  /** Lit, past `sure` in a softer colour: covered at the estimate itself (`estimateCells`). */
  likely: number
  /** Track past `likely` drawn brighter: covered if the turn ends at the band's near end. */
  band: number
}

/**
 * An estimate's cells, band included. The lit count is `estimateCells`
 * exactly, so the band only recolours cells and the bar still reads as it
 * did: never full before `over`, which is the warning colour's alone. Only
 * the band's track may reach the last cell, because a brighter `▱` is not a
 * full bar: it says the turn may end any moment now. An estimate without a
 * band (none to draw, or `over`) is its lit cells alone.
 */
export function estimateBandCells(estimate: TurnEstimate, width: number = BAR_WIDTH): EstimateCells {
  const likely = estimateCells(estimate, width)
  if (estimate.over || !estimate.band) return { sure: likely, likely, band: likely }
  const sure = Math.min(likely, Math.max(0, Math.round(estimate.band.sure * width)))
  const band = Math.max(likely, Math.min(width, Math.round(estimate.band.maybe * width)))
  return { sure, likely, band }
}

/** How far before the TUI's own start of a turn the server half may have marked it. */
export const TURN_PROGRESS_SLACK_MS = 1_000

/**
 * The output a running turn has generated so far, from the live channel's
 * record for its session (`src/turn-progress-store.ts`, h #g251), or
 * undefined when the record is an earlier turn's. The server half marks a
 * turn when opencode asks it for the reply, which is after the message that
 * started the turn was stored, so this turn's record started no earlier
 * than the TUI's start of it, less a little slack. A message steered in
 * mid-turn restarts the TUI's turn and not the server's, so the record's
 * count, which runs from the server's start, is not read against it. A turn
 * the TUI dates from no message has nothing to check against and reads
 * nothing.
 */
export function liveOutput(record: { turn: number; out: number } | undefined, startedAt: number | undefined): number | undefined {
  if (!record || startedAt === undefined) return undefined
  return record.turn >= startedAt - TURN_PROGRESS_SLACK_MS ? record.out : undefined
}

/**
 * A turn parked in a foreground subagent cannot end before the subagent does
 * (h #g251), because its `task` call returns the child's answer. So each
 * running foreground child's remaining time, read off the child's own
 * estimate, floors the parent's: the total at least the parent's elapsed
 * plus the child's remaining median, each edge of the band at least the
 * elapsed plus the child's remaining edge. A `task_batch` waits for every
 * child it started, so the longest of each wins. The parent's record already
 * holds the time its turns usually spend in children, so the floor only
 * moves an estimate that a child is visibly outlasting.
 *
 * A child past its own record (`over`) has no remaining time to offer and
 * floors nothing, and an `over` parent stays over: it is past every recorded
 * turn of its own. The host applies this before the fill memory's hold, so a
 * rising floor lowers nothing on the bar.
 */
export function floorByChildren(estimate: TurnEstimate, elapsedMs: number, children: readonly ProgressView[]): TurnEstimate {
  if (estimate.over) return estimate
  let median = 0
  let low = 0
  let high = 0
  for (const child of children) {
    const own = child.estimate
    if (child.state !== "running" || !own || own.over) continue
    const left = (ms: number) => Math.max(0, ms - child.elapsedMs)
    median = Math.max(median, left(own.totalMs))
    low = Math.max(low, left(own.band?.lowMs ?? own.totalMs))
    high = Math.max(high, left(own.band?.highMs ?? own.totalMs))
  }
  const elapsed = Math.max(0, elapsedMs)
  const totalMs = Math.max(estimate.totalMs, elapsed + median)
  const band = estimate.band
  if (totalMs === estimate.totalMs && (!band || (band.lowMs >= elapsed + low && band.highMs >= elapsed + high))) {
    return estimate
  }
  const fill = totalMs > 0 ? elapsed / totalMs : 0
  if (!band) return { ...estimate, totalMs, fill }
  const lowMs = Math.min(totalMs, Math.max(band.lowMs, elapsed + low))
  const highMs = Math.max(totalMs, band.highMs, elapsed + high)
  return {
    ...estimate,
    totalMs,
    fill,
    band: {
      lowMs,
      highMs,
      sure: highMs > 0 ? elapsed / highMs : 0,
      maybe: lowMs > 0 ? Math.min(1, elapsed / lowMs) : 0,
    },
  }
}

/** Moved to the rows' module, which a shell row's label needs it in; re-exported so older imports resolve. */
export { formatElapsed }

/** The three runs of one line: what leads it, the bar's cells (one segment each, none without a bar), the rest. */
export interface ProgressLayout {
  lead: Segment[]
  bar: Segment[]
  tail: Segment[]
}

/**
 * One line laid out for `width` cells:
 *
 *     ⠋ ▰▰▰▰▰▱▱▱▱▱  2/4 · 1m03s · bash       (a plan; lead "glyph": the session's own)
 *      ▰▰▰▱▱▱▱▱▱▱  45s/~2m10s · read         (an estimate; lead "indent": under a row)
 *     ⠋ 12s · 3 calls · bash                  (neither: no bar)
 *
 * The bar is one segment per cell, and two spaces follow it, not one: the
 * maintainer read one as the glyphs running into the time (h #g246). A plan's
 * fraction and an estimate's `elapsed/~total` each take the call count's
 * place. When the line is too wide the call count goes first, then the tool's
 * name is cut, then the tool goes. An ended line keeps no tool (nothing runs),
 * and its bar is full, ✓ or ✗ leading it. Under a row the line sits
 * `ROW_INDENT` in, beside the row's model line (`layoutRow`).
 */
export function layoutProgressLine(
  view: ProgressView,
  lead: "glyph" | "indent",
  width: number = SIDEBAR_ROW_WIDTH,
  frame = 0,
): ProgressLayout {
  const ended = view.state !== "running"
  const endedRole: Segment["role"] = view.state === "error" ? "error" : "done"
  const leadSegments: Segment[] =
    lead === "indent"
      ? [{ text: ROW_INDENT, role: "muted" }]
      : [
          view.state === "running"
            ? { text: SPINNER_FRAMES[frame % SPINNER_FRAMES.length], role: "spinner" }
            : { text: view.state === "done" ? "✓" : "✗", role: endedRole },
          { text: " ", role: "muted" },
        ]
  // A plan outranks an estimate, and an ended line is its final state.
  const estimate = !ended && !view.plan ? view.estimate : undefined
  const bar: Segment[] = []
  const cellsOf = (segment: (cell: number) => Segment) => {
    for (let cell = 0; cell < BAR_WIDTH; cell += 1) bar.push(segment(cell))
  }
  if (ended) {
    cellsOf(() => ({ text: BAR_DONE, role: endedRole }))
  } else if (view.plan) {
    const filled = filledCells(view.plan)
    cellsOf((cell) => (cell < filled ? { text: BAR_DONE, role: "bar-done" } : { text: BAR_TODO, role: "bar-track" }))
  } else if (estimate) {
    const cells = estimateBandCells(estimate)
    cellsOf((cell) =>
      estimate.over
        ? { text: BAR_DONE, role: "bar-over" }
        : cell < cells.sure
          ? { text: BAR_DONE, role: "bar-done" }
          : cell < cells.likely
            ? { text: BAR_DONE, role: "bar-likely" }
            : cell < cells.band
              ? { text: BAR_TODO, role: "bar-band" }
              : { text: BAR_TODO, role: "bar-track" },
    )
  }

  const required: Segment[] = []
  if (view.plan) {
    required.push({ text: `${view.plan.done}/${view.plan.total}`, role: ended ? "muted" : "fraction" })
    required.push({ text: formatElapsed(view.elapsedMs), role: "muted" })
  } else if (estimate) {
    required.push({
      text: `${formatElapsed(view.elapsedMs)}/~${formatElapsed(estimate.totalMs)}`,
      role: estimate.over ? "estimate-over" : "estimate",
    })
  } else {
    required.push({ text: formatElapsed(view.elapsedMs), role: "muted" })
  }
  const calls: Segment | undefined =
    !view.plan && !estimate && view.calls > 0
      ? { text: `${view.calls} call${view.calls === 1 ? "" : "s"}`, role: "muted" }
      : undefined
  const tool: Segment | undefined = !ended && view.tool ? { text: view.tool, role: "tool" } : undefined
  // The two spaces after the bar are the 2.
  const budget =
    width - leadSegments.reduce((sum, segment) => sum + cells(segment.text), 0) - (bar.length > 0 ? BAR_WIDTH + 2 : 0)
  const widthOf = (pieces: Segment[]) =>
    pieces.reduce((sum, piece) => sum + cells(piece.text), 0) + 3 * Math.max(0, pieces.length - 1)
  let pieces = [...required, ...(calls ? [calls] : []), ...(tool ? [tool] : [])]
  if (widthOf(pieces) > budget && calls) pieces = [...required, ...(tool ? [tool] : [])]
  if (widthOf(pieces) > budget && tool) {
    const room = budget - widthOf(required) - 3
    pieces = room >= 2 ? [...required, { text: truncate(tool.text, room), role: "tool" }] : required
  }
  const tail: Segment[] = bar.length > 0 ? [{ text: "  ", role: "muted" }] : []
  pieces.forEach((piece, index) => {
    if (index > 0) tail.push({ text: " · ", role: "muted" })
    tail.push(piece)
  })
  return { lead: leadSegments, bar, tail }
}

/** The plain text of a laid-out line, for tests. */
export function progressLineText(layout: ProgressLayout): string {
  return [...layout.lead, ...layout.bar, ...layout.tail].map((segment) => segment.text).join("")
}
