/**
 * The TUI half of the package: a `Subagents` section at the bottom of
 * opencode's session sidebar listing the current session's subagents, running
 * first, each with a spinner (or ✓ / ✗), its agent type, its task description,
 * a `bg` marker for background ones, a muted line saying what it really runs
 * as with its spend so far (`sonnet-5.5 · high · alpha · $0.42`), and
 * while it runs a progress line (`▰▰▰▱▱▱▱▱▱▱  45s/~2m10s · read`).
 * Clicking a row opens that subagent's session; opencode's own `up` key goes
 * back to the parent.
 *
 * Above it, under a `Main Progress` heading, the same line for the session on
 * screen while its turn runs and for a moment after it ends (h #g246). The
 * bar is a todo list's fraction when the session has one, else the turn's
 * elapsed over the total its agent and model's own recorded turns predict,
 * with the band that prediction carries (`src/turn-model.ts` over
 * `src/turn-history.ts`, h #g247, h #g251), else nothing; the rest is
 * elapsed, calls and the running tool. `src/progress-line.ts` decides all of
 * it.
 *
 * Below it, in the same slot, an `Accounts` section: one line per account
 * this install runs, from the first draw (h #g248): its current usage reading
 * (`appical · 5h 72% · resets 18:00`) from the store the server half writes
 * on every `rate_limit_event`, or its plan tier and `no reading yet` until
 * one arrives (`src/account-usage.ts`, laid out by `src/account-sidebar.ts`,
 * h #g244). It shares the slot rather than claiming a second one, so neither
 * major has a second registration to accept.
 *
 * Always on: there is no option. One module serves both majors (h #g234):
 *
 *   - opencode 1.x loads TUI plugins from `tui.json`'s `plugin` list, never
 *     from `opencode.json`'s, resolves a package to `exports["./tui"]`, and
 *     wants a default export `{ id, tui }` with no `server`.
 *   - opencode 2.x resolves the SAME `plugins` entry it already has
 *     (`<repo>/dist`) to `<dir>/tui`, and wants `{ id, setup }`. 1.x ignores a
 *     `setup` key and 2.x a `tui` key, so the default export carries both.
 *
 * Everything that decides WHAT to show lives in `src/subagent-sidebar.ts`
 * and `src/progress-line.ts` (pure, tested). Each major gets a thin adapter
 * that gathers those modules' inputs from its own TUI state and supplies its
 * own theme colours; the sections themselves are drawn by one renderer.
 * Nothing in here may throw into the host or log: on the TUI's own thread
 * stderr is the screen (h #g193), so every failure degrades to drawing less.
 */
import { RGBA } from "@opentui/core"
import { createElement, createTextNode, effect, insert, insertNode, setProp } from "@opentui/solid"
import { createMemo, createSignal, onCleanup } from "solid-js"
import {
  SIDEBAR_ROW_WIDTH,
  SPINNER_FRAMES,
  collapsedSummary,
  completionsIn,
  deriveSubagentRows,
  layoutRow,
  partChildID,
  type ChildRunState,
  type ChildSessionInput,
  type CompletionInput,
  type Segment,
  type SidebarInput,
  type SubagentRow,
  type TaskPartInput,
} from "./subagent-sidebar.js"
import {
  createFillMemory,
  createStatusWatch,
  floorByChildren,
  layoutProgressLine,
  liveOutput,
  measureProgress,
  rowProgress,
  sessionProgress,
  turnMessages,
  type ProgressMeasure,
  type ProgressMessage,
  type ProgressSource,
  type ProgressToolCall,
  type ProgressView,
} from "./progress-line.js"
import { createSpawnRecordReader, type SpawnRecord } from "./spawn-record-store.js"
import { createTurnHistoryReader, promptChars, sessionTag, turnHistoryKey, type TurnHistory } from "./turn-history.js"
import { buildTurnModel, type TurnModel } from "./turn-model.js"
import { createTurnProgressReader, type TurnProgress } from "./turn-progress-store.js"
import { createAccountUsageReader, type AccountUsage, type KnownAccounts } from "./account-usage.js"
import { accountUsageLines, type AccountUsageLine } from "./account-sidebar.js"
import { TOAST_DURATION_MS, TOAST_TITLE, createNoticeToaster } from "./plugin-notice.js"

export const SUBAGENTS_TUI_PLUGIN_ID = "opencode-claude-code-plugin.subagents"

/** After opencode 1.x's own sidebar sections (files is 500). */
const SECTION_ORDER = 900
const SPINNER_INTERVAL_MS = 100
/** How often the spawn records and the finished rows' fade are rechecked. */
const REFRESH_INTERVAL_MS = 1500
/** The refresh while something runs: the progress lines' elapsed moves by the second. */
const PROGRESS_TICK_MS = 1000
/** The spinner counter wraps here, a multiple of the spinner's frame count, so it never skips at the wrap. */
const FRAME_WRAP = SPINNER_FRAMES.length * 600

/** The tool names a subagent dispatch has: `task` on 1.x, `subagent` on 2.x. */
const TASK_TOOLS = new Set(["task", "subagent"])

type Color = RGBA

/** The colours the section paints with, whatever theme shape the host has. */
export interface SidebarColors {
  text: Color
  muted: Color
  spinner: Color
  done: Color
  /** An account's level under the warning threshold, `ok` included: the success colour at full strength (h #g248). */
  ok: Color
  error: Color
  /** The effort on a row's second line: the theme's warning colour. */
  effort: Color
  effortFaded: Color
  hover: Color
  /** A bar's filled cells: the theme's success colour. */
  barDone: Color
  /**
   * An estimate's cells covered at the estimate but not past the band's far
   * end: the success colour faded toward muted, like a finished row's ✓.
   */
  barLikely: Color
  /**
   * The track an estimate covers if the turn ends at the band's near end:
   * muted with a little of the success colour, brighter than the rest.
   */
  barBand: Color
  /** The track still to go: the muted colour pulled toward the background. */
  barTrack: Color
  /** `2/4`: the text colour, drawn bold; an estimate's `1m02s/~2m30s` takes it unbolded. */
  fraction: Color
  /** The tool running now: the theme's info colour. */
  tool: Color
  /** A subagent's spend so far: the theme's secondary colour. */
  cost: Color
  /** An account's plan tier, on a line with no reading yet: the secondary colour, like the spend. */
  tier: Color
  /**
   * When an account's window resets: the info colour, like the running tool,
   * so the time reads apart from the level beside it (h #g248).
   */
  reset: Color
}

/**
 * Which colour each segment role takes. A `Record` over the role union, so a
 * role added to `Segment` without a colour here fails the typecheck rather
 * than drawing muted by accident.
 */
const ROLE_COLOR: Record<Segment["role"], keyof SidebarColors> = {
  spinner: "spinner",
  done: "done",
  ok: "ok",
  error: "error",
  agent: "text",
  description: "text",
  muted: "muted",
  effort: "effort",
  "effort-faded": "effortFaded",
  "bar-done": "barDone",
  "bar-likely": "barLikely",
  "bar-band": "barBand",
  // Past every recorded turn: the warning colour, which the effort already takes.
  "bar-over": "effort",
  "bar-track": "barTrack",
  fraction: "fraction",
  estimate: "fraction",
  "estimate-over": "effort",
  tool: "tool",
  cost: "cost",
  tier: "tier",
  reset: "reset",
}

/** What one major has to supply; the renderer below does everything else. */
interface SidebarHost {
  colors(): SidebarColors
  /** The inputs for one parent session, minus the clock and the records. */
  gather(parentID: string): Pick<SidebarInput, "children" | "parts" | "completions" | "status" | "stoppedAt" | "cost">
  /** A session's own messages and todo list, what its progress line is measured from. */
  progress(sessionID: string): ProgressSource
  navigate(sessionID: string): void
}

function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/**
 * `a` moved `weight` of the way to `b`, so a finished glyph reads as muted.
 * Works in whatever scale the host's RGBA uses, because it only ever hands
 * the class back values it read from the same class.
 */
function mix(a: Color, b: Color, weight: number): Color {
  return attempt(
    () =>
      RGBA.fromValues(
        a.r + (b.r - a.r) * weight,
        a.g + (b.g - a.g) * weight,
        a.b + (b.b - a.b) * weight,
        a.a,
      ),
    a,
  )
}

function roleColor(colors: SidebarColors, role: Segment["role"]): Color {
  return colors[ROLE_COLOR[role] ?? "muted"]
}

const EMPTY_SOURCE: ProgressSource = { messages: [], todos: [] }

/** What one sidebar shows for its session: the rows, each running row's line, and the session's own. */
interface SidebarView {
  rows: SubagentRow[]
  lines: Map<string, ProgressView>
  progress?: ProgressView
}

const EMPTY_VIEW: SidebarView = { rows: [], lines: new Map() }

/**
 * The sections, their clocks and the store readers, for one host. Returns
 * the slot renderer and a disposer.
 */
function createSidebar(host: SidebarHost) {
  const [frame, setFrame] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())
  const records = createSpawnRecordReader()
  let recordMap: Map<string, SpawnRecord> = attempt(() => records.read(), new Map())
  // How long turns of each agent and model took before (h #g247), what the
  // bar is drawn from when the session has no todo list. The server half
  // writes it at every served `result`.
  const history = createTurnHistoryReader()
  let historyMap: TurnHistory = attempt(() => history.read(), new Map())
  // The model over the whole store (src/turn-model.ts, h #g251), built once
  // per change to it because that is when its calibration is fitted, then
  // read once per line per tick.
  let turnModel: TurnModel | undefined = attempt(() => buildTurnModel(historyMap), undefined)
  // What each running turn has generated so far, which only the server half
  // sees: it writes the total as each API call ends (h #g251). Read on the
  // second hand like the others; the clock re-derives the lines.
  const liveProgress = createTurnProgressReader()
  let progressMap: Map<string, TurnProgress> = attempt(() => liveProgress.read(), new Map())
  const [recordVersion, setRecordVersion] = createSignal(0)
  // What the TUI itself remembers about each session's status (h #g246): when
  // it first saw a run and when it saw the stop, for the one line whose turn
  // no message dates and for the linger after a turn.
  const watch = createStatusWatch()
  // And the fill each bar has reached this turn, so an estimate's bar never
  // steps back while its total rises.
  const fills = createFillMemory()
  // The `Accounts` lines (h #g244): every account's last usage reading, from
  // the store the server half writes on each `rate_limit_event`, and the
  // accounts it registered there at startup (h #g248). Their own clock value,
  // so a tick that only rechecks the readings does not re-derive the subagent
  // rows, which walk the session's messages.
  const usageReader = createAccountUsageReader()
  const [usage, setUsage] = createSignal<AccountUsage>(attempt(() => usageReader.read(), new Map()))
  const [known, setKnown] = createSignal<KnownAccounts>(attempt(() => usageReader.known(), new Map()))
  const [usageNow, setUsageNow] = createSignal(Date.now())

  // One spinner clock and one refresh clock for every mounted section, each
  // running only while something needs it: nothing ticks while no subagent is
  // listed, and the spinner stops the moment the last one finishes.
  const sectionsRunning = new Set<symbol>()
  const sectionsShowing = new Set<symbol>()
  // Every mounted sidebar, whatever it shows: a usage reading arrives with no
  // event the TUI can see, so the one `stat` that finds it runs while a
  // sidebar is on screen, and nothing runs once none is.
  const sectionsMounted = new Set<symbol>()
  let spinner: ReturnType<typeof setInterval> | undefined
  let refresh: ReturnType<typeof setInterval> | undefined
  let refreshPeriod = 0
  const refreshTick = () => {
    if (sectionsShowing.size > 0) {
      const next = attempt(() => records.read(), recordMap)
      const nextHistory = attempt(() => history.read(), historyMap)
      if (next !== recordMap || nextHistory !== historyMap) {
        if (nextHistory !== historyMap) turnModel = attempt(() => buildTurnModel(nextHistory), turnModel)
        recordMap = next
        historyMap = nextHistory
        setRecordVersion((value) => value + 1)
      }
      progressMap = attempt(() => liveProgress.read(), progressMap)
      setNow(Date.now())
    }
    // The reader hands back the same map while the file is unchanged, and
    // the clock moves once a minute (a reset is shown to the minute), so
    // an idle tick re-lays nothing out.
    setUsage(attempt(() => usageReader.read(), usage()))
    setKnown(attempt(() => usageReader.known(), known()))
    const minute = Math.floor(Date.now() / 60_000) * 60_000
    if (minute !== usageNow()) setUsageNow(minute)
  }
  const syncClocks = () => {
    if (sectionsRunning.size > 0 && !spinner) {
      spinner = setInterval(() => setFrame((value) => (value + 1) % FRAME_WRAP), SPINNER_INTERVAL_MS)
    } else if (sectionsRunning.size === 0 && spinner) {
      clearInterval(spinner)
      spinner = undefined
    }
    const wanted = sectionsShowing.size > 0 || sectionsMounted.size > 0
    // While something runs the refresh is also the progress lines' second
    // hand; otherwise it is the slower recheck of the records and the fades.
    const period = sectionsRunning.size > 0 ? PROGRESS_TICK_MS : REFRESH_INTERVAL_MS
    if (wanted && (!refresh || refreshPeriod !== period)) {
      if (refresh) clearInterval(refresh)
      refreshPeriod = period
      refresh = setInterval(refreshTick, period)
    } else if (!wanted && refresh) {
      clearInterval(refresh)
      refresh = undefined
      refreshPeriod = 0
    }
  }

  const progressOf = (sessionID: string): ProgressSource =>
    attempt(() => host.progress(sessionID), EMPTY_SOURCE)

  /**
   * A running line's estimate (h #g247, h #g250, h #g251): the session's
   * recorded agent and model name the key, the turn's prompt length and the
   * effort weight its record, the session's own earlier turns are its
   * session level, its tool calls and the output the server half saw it
   * generate condition it beside the elapsed, its running foreground
   * subagents floor it, and the fill and the band are held so nothing on the
   * bar steps back within the turn. No spawn record, or too little record
   * for the key and its agent's other models, is no estimate, and the line
   * then draws no bar.
   */
  const estimateFor = (
    sessionID: string,
    measure: ProgressMeasure,
    view: ProgressView,
    agentFallback?: string,
    children: readonly ProgressView[] = [],
  ): ProgressView => {
    if (view.state !== "running" || !turnModel) return view
    const record = recordMap.get(sessionID)
    if (!record?.model) return view
    const tag = sessionTag(sessionID)
    const estimate = turnModel.estimate(turnHistoryKey(record.agent ?? agentFallback, record.model), {
      elapsedMs: view.elapsedMs,
      chars: measure.chars,
      effort: record.effort,
      calls: measure.calls,
      out: liveOutput(tag ? progressMap.get(tag) : undefined, measure.startedAt),
      session: tag,
      now: Date.now(),
    })
    if (!estimate) return view
    const turn = measure.startedAt ?? 0
    return { ...view, estimate: fills.holdEstimate(sessionID, turn, floorByChildren(estimate, view.elapsedMs, children)) }
  }

  const deriveView = (sessionID: string): SidebarView => {
    recordVersion()
    // The clock signal is what re-runs this every second; the time itself is
    // read fresh, because a change in the host's store re-runs it between
    // ticks too, when the signal can be a tick stale.
    now()
    const clock = Date.now()
    const gathered = host.gather(sessionID)
    const rows = deriveSubagentRows({
      ...gathered,
      record: (id) => recordMap.get(id),
      now: clock,
    })
    const lines = new Map<string, ProgressView>()
    // The running foreground children's lines: the session's turn waits in
    // their `task` calls, so it cannot end before they do.
    const waitedOn: ProgressView[] = []
    for (const row of rows) {
      if (row.state !== "running" || !row.sessionID) continue
      const measure = measureProgress(progressOf(row.sessionID))
      const line = estimateFor(row.sessionID, measure, rowProgress(measure, { started: row.started, now: clock }), row.agent)
      lines.set(row.sessionID, line)
      if (!row.background) waitedOn.push(line)
    }
    const status = gathered.status(sessionID)
    const memory = watch.observe(sessionID, status, clock)
    const measure = measureProgress(progressOf(sessionID))
    const session = sessionProgress(measure, {
      status,
      busySince: memory.busySince,
      stoppedAt: gathered.stoppedAt(sessionID) ?? memory.stoppedAt,
      now: clock,
    })
    const progress = session ? estimateFor(sessionID, measure, session, undefined, waitedOn) : undefined
    return { rows, lines, progress }
  }

  const styled = (segment: Segment): OpentuiNode => {
    // The fraction is the one bold piece; `b` is a text chunk like `span`.
    const span = createElement(segment.role === "fraction" ? "b" : "span")
    insertNode(span, createTextNode(segment.text))
    effect(() => setProp(span, "style", { fg: roleColor(host.colors(), segment.role) }))
    return span
  }

  /** One progress line; only the spinner glyph follows the spinner clock, the bar moves with the second hand. */
  const buildProgressLine = (view: ProgressView, lead: "glyph" | "indent"): OpentuiNode => {
    const line = createElement("text")
    setProp(line, "wrapMode", "none")
    const layout = layoutProgressLine(view, lead, SIDEBAR_ROW_WIDTH)
    layout.lead.forEach((segment, index) => {
      if (index === 0 && lead === "glyph" && view.state === "running") {
        const span = createElement("span")
        insert(span, () => SPINNER_FRAMES[frame() % SPINNER_FRAMES.length])
        effect(() => setProp(span, "style", { fg: roleColor(host.colors(), segment.role) }))
        insertNode(line, span)
      } else {
        insertNode(line, styled(segment))
      }
    })
    for (const segment of layout.bar) insertNode(line, styled(segment))
    for (const segment of layout.tail) insertNode(line, styled(segment))
    return line
  }

  const buildRow = (row: SubagentRow, progress: ProgressView | undefined): OpentuiNode => {
    const box = createElement("box")
    const layout = layoutRow(row, SIDEBAR_ROW_WIDTH)
    const first = createElement("text")
    setProp(first, "wrapMode", "none")
    layout.first.forEach((segment, index) => {
      const span = createElement("span")
      if (index === 0 && row.state === "running") {
        insert(span, () => SPINNER_FRAMES[frame() % SPINNER_FRAMES.length])
      } else {
        insertNode(span, createTextNode(segment.text))
      }
      effect(() => setProp(span, "style", { fg: roleColor(host.colors(), segment.role) }))
      insertNode(first, span)
    })
    insertNode(box, first)
    if (layout.second.length > 0) {
      // One line of spans, like the first, so the effort and the spend can
      // take their own colours.
      const second = createElement("text")
      setProp(second, "wrapMode", "none")
      for (const segment of layout.second) insertNode(second, styled(segment))
      insertNode(box, second)
    }
    if (progress) insertNode(box, attempt(() => buildProgressLine(progress, "indent"), createElement("box")))
    if (row.sessionID) {
      const sessionID = row.sessionID
      setProp(box, "onMouseDown", () => attempt(() => host.navigate(sessionID), undefined))
      setProp(box, "onMouseOver", () =>
        attempt(() => setProp(box, "backgroundColor", host.colors().hover), undefined),
      )
      setProp(box, "onMouseOut", () =>
        attempt(() => setProp(box, "backgroundColor", "transparent"), undefined),
      )
    }
    return box
  }

  const buildHeading = (label: string): OpentuiNode => {
    const title = createElement("text")
    const bold = createElement("b")
    insertNode(bold, createTextNode(label))
    insertNode(title, bold)
    effect(() => setProp(title, "fg", host.colors().text))
    return title
  }

  const buildSection = (
    view: SidebarView,
    expanded: () => boolean,
    setExpanded: (next: (value: boolean) => boolean) => boolean,
  ): OpentuiNode => {
    const list = view.rows
    const section = createElement("box")
    // Heading, styled like opencode 1.x's own MCP and Todo sections: a bold
    // title, and with more than two rows a caret that folds the list away
    // behind a one-line summary.
    const header = createElement("box")
    setProp(header, "flexDirection", "row")
    setProp(header, "gap", 1)
    setProp(header, "onMouseDown", () => list.length > 2 && setExpanded((value) => !value))
    if (list.length > 2) {
      const caret = createElement("text")
      insert(caret, () => (expanded() ? "▼" : "▶"))
      effect(() => setProp(caret, "fg", host.colors().text))
      insertNode(header, caret)
    }
    const title = buildHeading("Subagents")
    const summary = createElement("span")
    insert(summary, () => (expanded() ? "" : ` (${collapsedSummary(list)})`))
    effect(() => setProp(summary, "style", { fg: host.colors().muted }))
    insertNode(title, summary)
    insertNode(header, title)
    insertNode(section, header)

    const body = createElement("box")
    insert(body, () =>
      expanded() || list.length <= 2
        ? list.map((row) => buildRow(row, row.sessionID ? view.lines.get(row.sessionID) : undefined))
        : null,
    )
    insertNode(section, body)
    return section
  }

  /**
   * The `Main Progress` heading and the session's own line, rebuilt as the
   * line changes. `Main`, because right above `Subagents` a bare `Progress`
   * read as theirs (the maintainer, in their own pane, h #g246).
   */
  const buildProgress = (progress: () => ProgressView | undefined): OpentuiNode => {
    const section = createElement("box")
    insertNode(section, buildHeading("Main Progress"))
    const body = createElement("box")
    insert(body, () => {
      const view = progress()
      return view ? attempt(() => buildProgressLine(view, "glyph"), null) : null
    })
    insertNode(section, body)
    return section
  }

  const buildAccounts = (lines: AccountUsageLine[]): OpentuiNode => {
    const section = createElement("box")
    insertNode(section, buildHeading("Accounts"))
    for (const line of lines) {
      const text = createElement("text")
      setProp(text, "wrapMode", "none")
      for (const segment of line.segments) insertNode(text, styled(segment))
      insertNode(section, text)
    }
    return section
  }

  const render = (sessionID: () => string | undefined): OpentuiNode => {
    const root = createElement("box")
    const progressBox = createElement("box")
    const subagentsBox = createElement("box")
    const accountsBox = createElement("box")
    insertNode(root, progressBox)
    insertNode(root, subagentsBox)
    insertNode(root, accountsBox)
    const key = Symbol("subagents-section")
    sectionsMounted.add(key)
    const [expanded, setExpanded] = createSignal(true)
    const view = createMemo(() => {
      const parentID = sessionID()
      if (!parentID) return EMPTY_VIEW
      return attempt(() => deriveView(parentID), EMPTY_VIEW)
    })
    effect(() => {
      const { rows, progress } = view()
      const running = rows.some((row) => row.state === "running") || progress?.state === "running"
      if (running) sectionsRunning.add(key)
      else sectionsRunning.delete(key)
      if (rows.length > 0 || progress) sectionsShowing.add(key)
      else sectionsShowing.delete(key)
      syncClocks()
    })
    onCleanup(() => {
      sectionsRunning.delete(key)
      sectionsShowing.delete(key)
      sectionsMounted.delete(key)
      syncClocks()
    })
    // The heading is built once per run; only the line under it follows the clock.
    const hasProgress = createMemo(() => view().progress !== undefined)
    insert(progressBox, () =>
      hasProgress() ? attempt(() => buildProgress(() => view().progress), null) : null,
    )
    insert(subagentsBox, () => {
      const current = view()
      if (current.rows.length === 0) return null
      return attempt(() => buildSection(current, expanded, setExpanded), null)
    })
    const accountLines = createMemo(() =>
      attempt(() => accountUsageLines(usage(), usageNow(), SIDEBAR_ROW_WIDTH, known()), [] as AccountUsageLine[]),
    )
    insert(accountsBox, () => {
      const lines = accountLines()
      if (lines.length === 0) return null
      return attempt(() => buildAccounts(lines), null)
    })
    syncClocks()
    return root
  }

  const dispose = () => {
    sectionsRunning.clear()
    sectionsShowing.clear()
    sectionsMounted.clear()
    syncClocks()
  }
  return { render, dispose }
}

// ---------------------------------------------------------------------------
// opencode 1.x
// ---------------------------------------------------------------------------

// The structural slice of opencode 1.x's `TuiPluginApi` this module reads.
// Hand-written, like `src/opencode-types.ts`, so nothing is imported from
// `@opencode-ai/plugin`.
interface V1SessionInfo {
  id: string
  parentID?: string
  title?: string
  agent?: string
  time?: { created?: number; updated?: number }
  cost?: number
}
interface V1Message {
  id: string
  role: string
  time?: { created?: number }
  error?: unknown
}
interface V1Part {
  type: string
  tool?: string
  synthetic?: boolean
  text?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    metadata?: Record<string, unknown>
    title?: string
    time?: { start?: number; end?: number }
  }
}
interface V1Api {
  state: {
    session: {
      get(sessionID: string): V1SessionInfo | undefined
      messages(sessionID: string): ReadonlyArray<V1Message> | undefined
      status(sessionID: string): { type?: string } | undefined
      /** The session's todo list, as its own Todo section reads it. */
      todo?(sessionID: string): ReadonlyArray<{ status?: string }> | undefined
    }
    part(messageID: string): ReadonlyArray<V1Part> | undefined
  }
  theme: {
    current: {
      text: Color
      textMuted: Color
      accent: Color
      success: Color
      warning: Color
      error: Color
      backgroundElement: Color
      backgroundPanel?: Color
      info?: Color
      primary?: Color
      secondary?: Color
    }
  }
  route: { navigate(name: string, params?: Record<string, unknown>): void }
  event: { on(type: string, handler: (event: { properties?: any }) => void): () => void }
  client?: { session?: { children?: (input: { sessionID: string }) => Promise<{ data?: V1SessionInfo[] }> } }
  slots: { register(plugin: { order?: number; slots: Record<string, (ctx: unknown, props: any) => OpentuiNode> }): string }
  lifecycle?: { onDispose(fn: () => void): () => void }
}

export function registerV1(api: V1Api): void {
  // Child sessions seen per parent. 1.x has no session list in its TUI state,
  // so they come from its events, from a one-off `children` fetch the first
  // time a parent is shown (a TUI started after the dispatch still lists
  // them), and from finished parts' metadata.
  const childrenByParent = new Map<string, Map<string, ChildSessionInput>>()
  const fetched = new Set<string>()
  const stoppedAt = new Map<string, number>()
  const lastStatus = new Map<string, string>()
  const [version, setVersion] = createSignal(0)
  const bump = () => setVersion((value) => value + 1)

  const remember = (info: V1SessionInfo | undefined) => {
    if (!info?.id || !info.parentID) return false
    let children = childrenByParent.get(info.parentID)
    if (!children) {
      children = new Map()
      childrenByParent.set(info.parentID, children)
    }
    children.set(info.id, {
      id: info.id,
      title: info.title,
      agent: info.agent,
      created: info.time?.created,
      updated: info.time?.updated,
    })
    return true
  }

  const unsubscribe: Array<() => void> = []
  const listen = (type: string, handler: (properties: any) => void) => {
    const off = attempt(
      () => api.event.on(type, (event) => attempt(() => handler(event?.properties ?? {}), undefined)),
      undefined,
    )
    if (off) unsubscribe.push(off)
  }
  listen("session.created", (properties) => remember(properties.info) && bump())
  listen("session.updated", (properties) => remember(properties.info) && bump())
  listen("session.deleted", (properties) => {
    const info = properties.info as V1SessionInfo | undefined
    if (info?.parentID && childrenByParent.get(info.parentID)?.delete(info.id)) bump()
  })
  listen("session.status", (properties) => {
    const id = properties.sessionID as string | undefined
    const type = properties.status?.type as string | undefined
    if (!id || !type) return
    const previous = lastStatus.get(id)
    lastStatus.set(id, type)
    if (type === "idle" && previous && previous !== "idle") stoppedAt.set(id, Date.now())
    if (type !== "idle") stoppedAt.delete(id)
    // A session going busy with nothing listed has no clock to notice it.
    bump()
  })

  const fetchChildren = (parentID: string) => {
    if (fetched.has(parentID)) return
    fetched.add(parentID)
    const session = api.client?.session
    if (!session?.children) return
    void Promise.resolve()
      .then(() => session.children!.call(session, { sessionID: parentID }))
      .then((response) => {
        let changed = false
        for (const info of response?.data ?? []) changed = remember(info) || changed
        if (changed) bump()
      })
      .catch(() => undefined)
  }

  const host: SidebarHost = {
    colors() {
      const theme = api.theme.current
      const muted = theme.textMuted
      return {
        text: theme.text,
        muted,
        spinner: theme.accent,
        done: mix(theme.success, muted, 0.45),
        ok: theme.success ?? theme.accent,
        error: mix(theme.error, muted, 0.35),
        effort: theme.warning ?? muted,
        effortFaded: mix(theme.warning ?? muted, muted, 0.45),
        hover: theme.backgroundElement,
        barDone: theme.success ?? theme.accent,
        barLikely: mix(theme.success ?? theme.accent, muted, 0.45),
        barBand: mix(muted, theme.success ?? theme.accent, 0.3),
        barTrack: mix(muted, theme.backgroundPanel ?? theme.backgroundElement, 0.5),
        fraction: theme.text,
        tool: theme.info ?? theme.accent,
        cost: theme.secondary ?? theme.primary ?? muted,
        tier: theme.secondary ?? theme.primary ?? muted,
        reset: theme.info ?? theme.accent,
      }
    },
    gather(parentID) {
      version()
      fetchChildren(parentID)
      const parts: TaskPartInput[] = []
      const completions: CompletionInput[] = []
      for (const message of api.state.session.messages(parentID) ?? []) {
        const messageParts = api.state.part(message.id) ?? []
        if (message.role === "assistant") {
          for (const part of messageParts) {
            if (part.type !== "tool" || !TASK_TOOLS.has(part.tool ?? "")) continue
            const state = part.state ?? {}
            parts.push({
              status: state.status,
              input: state.input,
              metadata: state.metadata,
              title: state.title,
              start: state.time?.start,
              end: state.time?.end,
            })
          }
        } else if (message.role === "user") {
          // A background child's end is a synthetic user part in the parent.
          for (const part of messageParts) {
            if (part.type !== "text" || part.synthetic !== true || !part.text) continue
            completions.push(...completionsIn(part.text, message.time?.created))
          }
        }
      }
      const known = new Map(childrenByParent.get(parentID) ?? [])
      for (const part of parts) {
        const id = partChildID(part)
        if (!id || known.has(id)) continue
        const info = attempt(() => api.state.session.get(id), undefined)
        known.set(id, {
          id,
          title: info?.title,
          agent: info?.agent,
          created: info?.time?.created ?? part.start,
          updated: info?.time?.updated,
        })
      }
      return {
        children: [...known.values()],
        parts,
        completions,
        status: (id: string): ChildRunState => {
          const type = attempt(() => api.state.session.status(id)?.type, undefined)
          if (type === "busy" || type === "retry") return "busy"
          if (type === "idle") return "idle"
          return "unknown"
        },
        stoppedAt: (id: string) => stoppedAt.get(id),
        cost: (id: string) => attempt(() => api.state.session.get(id)?.cost, undefined),
      }
    },
    progress(sessionID) {
      const messages: ProgressMessage[] = []
      // The turn only: the parts of every earlier message are never read.
      const turn = turnMessages(api.state.session.messages(sessionID) ?? [], (message) => message.role === "user")
      for (const message of turn) {
        const tools: ProgressToolCall[] = []
        const texts: string[] = []
        for (const part of api.state.part(message.id) ?? []) {
          if (message.role === "assistant" && part.type === "tool") tools.push({ name: part.tool, status: part.state?.status })
          // Every text part, synthetic ones included: a background child's
          // end starts a turn too, and the server counts its envelope.
          if (message.role === "user" && part.type === "text" && typeof part.text === "string") texts.push(part.text)
        }
        messages.push({
          role: message.role,
          created: message.time?.created,
          error: message.error !== undefined && message.error !== null,
          tools,
          chars: message.role === "user" ? promptChars(texts) : undefined,
        })
      }
      const todos = attempt(() => api.state.session.todo?.(sessionID), undefined) ?? []
      return { messages, todos: todos.map((todo) => ({ status: todo.status })) }
    },
    navigate(sessionID) {
      api.route.navigate("session", { sessionID })
    },
  }

  const sidebar = createSidebar(host)
  api.slots.register({
    order: SECTION_ORDER,
    slots: {
      sidebar_content(_ctx: unknown, props: { session_id: string }) {
        return sidebar.render(() => props.session_id)
      },
    },
  })
  api.lifecycle?.onDispose(() => {
    for (const off of unsubscribe) attempt(off, undefined)
    sidebar.dispose()
  })
}

// ---------------------------------------------------------------------------
// opencode 2.x
// ---------------------------------------------------------------------------

// The structural slice of opencode 2.x's TUI `Context` this module reads,
// measured on 2.0.22 (h #g234). Its sessions carry `parentID`, its status is
// `"running" | "idle"`, an assistant message holds its tool calls inline as
// `content[]` items named `subagent` (with `metadata.sessionID` set while the
// call still runs, unlike 1.x), and a background child's end is a message of
// type `synthetic` whose text is `<subagent sessionID="..." state="...">`.
// It hands a TUI plugin no todo list (h #g246), so a 2.x bar is the history's
// estimate or nothing (h #g247).
interface V2Session {
  id: string
  parentID?: string
  title?: string
  agent?: string
  time?: { created?: number; updated?: number }
}
interface V2Message {
  type?: string
  text?: string
  time?: { created?: number }
  error?: unknown
  content?: Array<{
    type?: string
    name?: string
    text?: string
    time?: { created?: number; completed?: number }
    state?: { status?: string; input?: Record<string, unknown>; metadata?: Record<string, unknown> }
  }>
}
type V2Shade = Record<string, Color>
interface V2Context {
  data: {
    session: {
      list(): V2Session[] | undefined
      status(sessionID: string): string
      /** A child's own spend; a root's is its family's sum, which is not read. */
      cost?(sessionID: string): number
      message: { list(sessionID: string): V2Message[] | undefined }
    }
    /**
     * Every bus event, the plugin's own RPC events included (2.0.31,
     * h #g253): how the server half's warnings arrive (`src/plugin-notice.ts`).
     */
    listen?(handler: (event: { details?: { type?: unknown; data?: unknown } }) => void): () => void
  }
  theme: {
    text: {
      base: Color
      muted: Color
      feedback: { success: V2Shade; warning?: V2Shade; error: V2Shade; info?: V2Shade }
    }
    background: { base?: Color; raised: { base: Color } }
    hue: { accent: V2Shade; interactive?: V2Shade }
  }
  themeMode?: "dark" | "light"
  ui: {
    router: { navigate(destination: { type: "session"; sessionID: string }): void }
    slot(claim: { append: string; render: (input: { sessionID: string }) => OpentuiNode }): () => void
    toast?: {
      show(options: { title?: string; message: string; variant?: "info" | "success" | "warning" | "error"; duration?: number }): void
    }
  }
}

export function setupV2(context: V2Context): () => void {
  const host: SidebarHost = {
    colors() {
      const theme = context.theme
      const muted = theme.text.muted
      // The accent and interactive hues at the shade that reads on this mode's background.
      const shade = context.themeMode === "light" ? "500" : "200"
      const accent = theme.hue.accent[shade] ?? theme.text.base
      return {
        text: theme.text.base,
        muted,
        spinner: accent,
        done: mix(theme.text.feedback.success.muted ?? theme.text.feedback.success.base, muted, 0.45),
        ok: theme.text.feedback.success.base ?? accent,
        error: mix(theme.text.feedback.error.muted ?? theme.text.feedback.error.base, muted, 0.35),
        effort: theme.text.feedback.warning?.base ?? muted,
        effortFaded: mix(theme.text.feedback.warning?.base ?? muted, muted, 0.45),
        hover: theme.background.raised.base,
        barDone: theme.text.feedback.success.base ?? accent,
        barLikely: mix(theme.text.feedback.success.base ?? accent, muted, 0.45),
        barBand: mix(muted, theme.text.feedback.success.base ?? accent, 0.3),
        barTrack: mix(muted, theme.background.base ?? theme.background.raised.base, 0.5),
        fraction: theme.text.base,
        tool: theme.text.feedback.info?.base ?? accent,
        cost: theme.hue.interactive?.[shade] ?? accent,
        tier: theme.hue.interactive?.[shade] ?? accent,
        reset: theme.text.feedback.info?.base ?? accent,
      }
    },
    gather(parentID) {
      const children: ChildSessionInput[] = (context.data.session.list() ?? [])
        .filter((session) => session.parentID === parentID)
        .map((session) => ({
          id: session.id,
          title: session.title,
          agent: session.agent,
          created: session.time?.created,
          updated: session.time?.updated,
        }))
      const parts: TaskPartInput[] = []
      const completions: CompletionInput[] = []
      for (const message of context.data.session.message.list(parentID) ?? []) {
        if (message.type === "assistant") {
          for (const item of message.content ?? []) {
            if (item.type !== "tool" || !TASK_TOOLS.has(item.name ?? "")) continue
            parts.push({
              status: item.state?.status,
              input: item.state?.input,
              metadata: item.state?.metadata,
              start: item.time?.created,
              end: item.time?.completed,
            })
          }
        } else if (message.type === "synthetic" && message.text) {
          completions.push(...completionsIn(message.text, message.time?.created))
        }
      }
      return {
        children,
        parts,
        completions,
        status: (id: string): ChildRunState => {
          const status = attempt(() => context.data.session.status(id), undefined)
          if (status === "running") return "busy"
          if (status === "idle") return "idle"
          return "unknown"
        },
        stoppedAt: () => undefined,
        cost: (id: string) => attempt(() => context.data.session.cost?.(id), undefined),
      }
    },
    progress(sessionID) {
      const messages: ProgressMessage[] = []
      // The turn only, as on 1.x; a synthetic message starts one like a user's.
      const turn = turnMessages(
        context.data.session.message.list(sessionID) ?? [],
        (message) => message.type === "user" || message.type === "synthetic",
      )
      for (const message of turn) {
        const tools: ProgressToolCall[] = []
        const texts: string[] = []
        for (const item of message.content ?? []) {
          if (message.type === "assistant" && item.type === "tool") tools.push({ name: item.name, status: item.state?.status })
          if (message.type === "user" && item.type === "text" && typeof item.text === "string") texts.push(item.text)
        }
        if (message.type === "synthetic" && message.text) texts.push(message.text)
        const starts = message.type === "user" || message.type === "synthetic"
        messages.push({
          // A synthetic message (a background child's end) prompts the parent
          // like a user message does: it starts a turn.
          role: message.type === "synthetic" ? "user" : (message.type ?? ""),
          created: message.time?.created,
          error: message.error !== undefined && message.error !== null,
          tools,
          chars: starts ? promptChars(texts) : undefined,
        })
      }
      return { messages, todos: [] }
    },
    navigate(sessionID) {
      context.ui.router.navigate({ type: "session", sessionID })
    },
  }

  const sidebar = createSidebar(host)
  const release = attempt(
    () =>
      context.ui.slot({
        append: "sidebar.content",
        render: (input) => sidebar.render(() => input.sessionID),
      }),
    undefined,
  )
  // The server half's warnings, and its answer to `/connect`, which opencode 2
  // gives no other way to the screen (`src/plugin-notice.ts`). Once each, however many of the plugin's
  // locations emitted them.
  const toastNotice = createNoticeToaster((notice) =>
    context.ui.toast?.show({
      title: TOAST_TITLE,
      message: notice.message,
      variant: notice.level === "error" ? "error" : notice.level === "success" ? "success" : "warning",
      duration: TOAST_DURATION_MS,
    }),
  )
  const stopNotices = attempt(
    () => context.data.listen?.((event) => void toastNotice(event?.details?.type, event?.details?.data)),
    undefined,
  )
  return () => {
    if (release) attempt(release, undefined)
    if (stopNotices) attempt(stopNotices, undefined)
    sidebar.dispose()
  }
}

const tui = async (api: V1Api): Promise<void> => {
  attempt(() => registerV1(api), undefined)
}

const setup = (context: V2Context): (() => void) | void =>
  attempt(() => setupV2(context), undefined)

export default { id: SUBAGENTS_TUI_PLUGIN_ID, tui, setup }
