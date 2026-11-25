/**
 * The model behind the sidebar's `Subagents` section (`src/tui.ts`): which
 * subagents of one opencode session to show, in what state, in what order, and
 * the exact text of each row.
 *
 * Pure on purpose. It imports nothing, so the TUI bundle carries no logger (a
 * logger on the TUI's main thread writes to the terminal it is drawing on,
 * h #g193) and every rule here is testable without a terminal. The TUI half
 * only gathers the inputs and paints the segments this module returns.
 *
 * Measured on opencode 1.18.35 (h #g234), and each one shapes a rule below:
 *
 *   - A RUNNING `task` part carries no `state.metadata` in the TUI's store, so
 *     the child session id is not on the part until it completes. Rows are
 *     built from the child SESSIONS (`parentID` is the current session) and a
 *     part is matched to its child by the title opencode gives the child,
 *     `<description> (@<agent> subagent)`.
 *   - A background dispatch's part completes at once with a `<task id
 *     state="running">` envelope; the child's end arrives later as a synthetic
 *     user part `<task id="ses_..." state="completed">` in the parent (opencode
 *     2 writes `<subagent sessionID="..." state="...">`). That envelope is the
 *     authoritative end of a background child.
 *   - `metadata.model` on a finished part is what opencode ASKED for, not what
 *     ran: an agent's `forceModel`, its `reasoningEffort`, the dispatch form and
 *     the fallback chain all change the spawn without telling opencode. So the
 *     label prefers the spawn record the server half writes
 *     (`src/spawn-record-store.ts`) and falls back to the part.
 *
 * Read out of opencode 2.2.6 (h #g307), and each one shapes the shell rows:
 *
 *   - Every shell a session starts is in the TUI's per-location shell store
 *     (`data.shell.list(location)`) with `metadata.sessionID` naming the
 *     session: the model's shell tool, foreground or background alike, and a
 *     `!command` typed in the prompt (which also carries `background: true`).
 *     opencode's own TUI counts a session's shells off exactly that.
 *   - Nothing on a tool shell tells foreground from background: that lives on
 *     its job, which a TUI plugin cannot read. A foreground call is a RUNNING
 *     `shell` tool part with the same command, already shown on the progress
 *     line; a backgrounded one's part has completed while the shell runs on.
 *     So a running shell becomes a row only once no running part has its
 *     command (`createShellMemory`), and a foreground call never does.
 *   - A tool shell leaves the store when its job ends, and `shell.exited`
 *     (exit code and status) arrives just before; the memory keeps the end so
 *     the row can say how it went, for `FINISHED_TTL_MS` like a subagent.
 *
 * Read out of opencode 2.3.0 (`@opencode/core`, h #g321), and each one shapes
 * a subagent row there:
 *
 *   - Every subagent runs in the background and `subagent` has no
 *     `background` input. Its part completes as soon as the child is prompted,
 *     with `metadata: {sessionID, status: "running"}` (2.2.x wrote the same
 *     for a background call and `status: "completed"` for a foreground one), so
 *     a completed part whose metadata still says running is a background
 *     dispatch on any 2.x.
 *   - The parent gets a `<subagent sessionID state>` message each time the
 *     child goes idle, including after later work, so a child can run again
 *     after an envelope; and `state="running"` there is an idle child whose
 *     own background work is still going, which will report again.
 *
 * Read out of the opencode 2.4.1 binary and `@opencode/plugin` 2.4.0
 * (h #g327), and each one shapes the nested lines under a row:
 *
 *   - The report is `<background-result kind="subagent" sessionID="ses_..."
 *     state="..." description="...">` now, the same synthetic message with a
 *     new tag; `state="running"` still means the child is idle with work of
 *     its own going on. Every form is read (`completionsIn`).
 *   - A subagent's background shells belong to the subagent's session, not
 *     the viewed one, and its own subagents are sessions whose `parentID` is
 *     the subagent. Both run while the subagent itself reads idle, which is
 *     what used to make the row end and age out while its work went on. So a
 *     row is running while anything under it runs (`under`), and what runs is
 *     listed under it, indented as a tree (`nestedLines`).
 */

export type SubagentState = "running" | "done" | "error"

/** One child session as either major reports it. */
export interface ChildSessionInput {
  id: string
  title?: string
  agent?: string
  created?: number
  updated?: number
}

/** A `task` / `subagent` tool part in the parent, as either major reports it. */
export interface TaskPartInput {
  status?: string
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
  title?: string
  start?: number
  end?: number
}

/** A background child's end, read out of the parent's synthetic user parts. */
export interface CompletionInput {
  sessionID: string
  state: string
  at?: number
}

/** What the server half recorded about a session's real spawn. */
export interface SpawnRecordInput {
  model?: string
  effort?: string
  account?: string
  at?: number
}

export type ChildRunState = "busy" | "idle" | "unknown"

/**
 * A background shell of the session, as `createShellMemory` hands it over:
 * `status` is opencode's (`running`, `exited`, `timeout`, `killed`), or
 * `ended` when the shell left the store with no `shell.exited` seen.
 */
export interface ShellInput {
  id: string
  command: string
  status: string
  exit?: number
  started: number
  completed?: number
}

/**
 * One subagent's own work, one level down (h #g327): its child sessions, its
 * own `subagent` parts and the reports its children sent it, and its
 * background shells. What the host cannot read is simply empty.
 */
export interface NestedSessionInput {
  children: ChildSessionInput[]
  parts: TaskPartInput[]
  completions: CompletionInput[]
  shells?: ShellInput[]
}

export interface SidebarInput {
  children: ChildSessionInput[]
  parts: TaskPartInput[]
  completions: CompletionInput[]
  /** The session's background shells (opencode 2.2.6+); none on a host without a shell store. */
  shells?: ShellInput[]
  /**
   * What runs under one of the subagents, by its session id (opencode 2.x,
   * h #g327). Absent on a host that cannot say (opencode 1.x), which then
   * shows no nested lines at all.
   */
  nested?: (sessionID: string) => NestedSessionInput | undefined
  status: (sessionID: string) => ChildRunState
  record: (sessionID: string) => SpawnRecordInput | undefined
  /** When the TUI first saw a child stop, by session id. */
  stoppedAt: (sessionID: string) => number | undefined
  /** A child's spend so far in dollars, as the host's session record carries it (h #g246). */
  cost?: (sessionID: string) => number | undefined
  now: number
}

export interface SubagentRow {
  /** A background shell rather than a subagent: `agent` is `shell` and `description` its command. */
  kind?: "shell"
  /** The child session, absent while a dispatch has not created one yet, and on a shell. */
  sessionID?: string
  agent: string
  description: string
  background: boolean
  state: SubagentState
  /** `sonnet-5.5 · high · alpha`, empty when nothing is known. */
  label: string
  /** The effort piece of `label`, drawn in the theme's warning colour. */
  effort?: string
  /** Spend so far in dollars, right-aligned on the label's line while it fits; kept once finished. */
  cost?: number
  started: number
  finished?: number
  /**
   * Running only because of work under it: the subagent itself is idle, so
   * it has no turn for a progress line to measure (h #g327).
   */
  waiting?: boolean
  /**
   * What runs under a running subagent, as rows of their own (its background
   * shells and its own subagents, each with theirs): running first, then what
   * finished within `NESTED_FINISHED_TTL_MS`. Absent on a finished row, which
   * folds back to its single row.
   */
  under?: SubagentRow[]
}

/** One line under a row (h #g327): a nested shell or subagent, or the `+N more` that stands for the rest. */
export interface NestedLine {
  /** The tree in front of the glyph: `ROW_INDENT`, a rail per level and a branch, ` │ └ `. */
  lead: string
  /** The shell or subagent; absent on the `+N more` line. */
  row?: SubagentRow
  /** How many lines the cap left out, on the `+N more` line. */
  more?: number
  /** The muted tail: how long it has run, or how it ended. */
  tail: string
}

/** How long a finished subagent stays in the list, and how many of them. */
export const FINISHED_TTL_MS = 10 * 60_000
export const FINISHED_KEEP = 3
/**
 * A background child that reads idle with no envelope yet is still starting
 * for this long: opencode creates the session before it marks it busy.
 */
export const STARTING_GRACE_MS = 10_000
/** The usable width of a row in opencode 1.18.35's 42-column sidebar. */
export const SIDEBAR_ROW_WIDTH = 36
/**
 * What a row's second and third lines sit in by, under the glyph's cell. One
 * cell, not the two that would align them under the agent name, because the
 * cell is what lets `sonnet-5.5 · high · appical · $0.42` fit a row (h #g246).
 */
export const ROW_INDENT = " "
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
/**
 * How many lines a row shows under it before the rest fold into one `+N more`
 * line (h #g327), so a subagent with a dozen renders does not push every other
 * row off the sidebar.
 */
export const NESTED_LINES_KEEP = 3
/**
 * How long a finished shell or subagent stays under a row that is still
 * running: long enough to read how it ended, short enough that a long-lived
 * subagent does not collect a history under it.
 */
export const NESTED_FINISHED_TTL_MS = 60_000
/**
 * Levels of indentation drawn under a row. Deeper lines are drawn at this
 * depth, so a deep tree still leaves room on a 36-cell line for what runs.
 */
export const NESTED_INDENT_CAP = 3
/** How far down the session tree is walked at all, a bound on a cycle the host should never have. */
export const NESTED_DEPTH_MAX = 8

const TITLE_SUFFIX = /\s*\(@([^)\s]+) subagent\)\s*$/

/** `Fix the form (@implementor subagent)` -> description and agent. */
export function parseChildTitle(title: string | undefined): { description: string; agent?: string } {
  const text = (title ?? "").trim()
  const match = TITLE_SUFFIX.exec(text)
  if (!match) return { description: text }
  return { description: text.slice(0, match.index).trim(), agent: match[1] }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/**
 * The child session a part names: on either major's metadata, else the child a
 * resumed dispatch names in its own input (`task_id` on opencode 1,
 * `sessionID` on opencode 2). The input matters on opencode 1, where a running
 * part has no metadata yet: without it a child resumed in the foreground stays
 * matched to its earlier, finished part.
 */
export function partChildID(part: TaskPartInput): string | undefined {
  const metadata = part.metadata ?? {}
  const input = part.input ?? {}
  return (
    text(metadata.sessionId) ?? text(metadata.sessionID) ?? text(input.task_id) ?? text(input.sessionID)
  )
}

function partAgent(part: TaskPartInput): string | undefined {
  const input = part.input ?? {}
  return text(input.subagent_type) ?? text(input.agent)
}

function partDescription(part: TaskPartInput): string | undefined {
  return text(part.input?.description) ?? text(part.title)
}

/**
 * Whether the parent stopped waiting on this child while it runs on: asked for
 * (`background: true`), or a completed part whose metadata still says the
 * child is running, which is every dispatch on opencode 2.3.0 and later and a
 * background one on 2.0 to 2.2 (h #g321). A running part's metadata says
 * `running` too while the parent waits, so only a completed one counts.
 */
function partBackground(part: TaskPartInput): boolean {
  return (
    part.input?.background === true ||
    part.metadata?.background === true ||
    (part.status === "completed" && part.metadata?.status === "running")
  )
}

const COMPLETION_ENVELOPE =
  /<(task\s+id|subagent\s+sessionID)="(ses_[A-Za-z0-9]+)"\s+state="([a-z_]+)"/g
/**
 * opencode 2.4's report (h #g327): `<background-result kind="subagent"
 * sessionID="ses_..." state="..." description="...">`. Only the opening tag is
 * read, and each attribute on its own, so their order does not matter; the
 * description comes last and is not escaped, so nothing after the tag is
 * trusted.
 */
const BACKGROUND_RESULT = /<background-result\s+([^>]*)>/g

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)?.[1]
}

/**
 * Every background report a text names, in order. Each form opencode has
 * written: `<task id="ses_..." state="completed">` (1.x),
 * `<subagent sessionID="ses_..." state="completed">` (2.0 to 2.3) and
 * `<background-result kind="subagent" sessionID="ses_..." state="...">`
 * (2.4). A 1.x `running` envelope is the dispatch's own answer, not a report,
 * so it is skipped; a 2.x `state="running"` is the report of a child that went
 * idle with background work of its own still going (h #g321), kept so the row
 * keeps its spinner until the report that follows. A `<background-result>` of
 * another kind (a shell, an image) is not a subagent's and is skipped.
 */
export function completionsIn(value: string, at?: number): CompletionInput[] {
  const found: Array<CompletionInput & { index: number }> = []
  for (const match of value.matchAll(COMPLETION_ENVELOPE)) {
    if (match[3] === "running" && match[1].startsWith("task")) continue
    found.push({ sessionID: match[2], state: match[3], at, index: match.index ?? 0 })
  }
  for (const match of value.matchAll(BACKGROUND_RESULT)) {
    const tag = match[1]
    if (attribute(tag, "kind") !== "subagent") continue
    const sessionID = attribute(tag, "sessionID")
    const state = attribute(tag, "state")
    if (!sessionID || !/^ses_[A-Za-z0-9]+$/.test(sessionID) || !state || !/^[a-z_]+$/.test(state)) continue
    found.push({ sessionID, state, at, index: match.index ?? 0 })
  }
  return found.sort((a, b) => a.index - b.index).map(({ index: _index, ...completion }) => completion)
}

function endState(state: string): SubagentState {
  return state === "completed" ? "done" : "error"
}

/**
 * `claude-opus-5-5` -> `opus-5.5`, `claude-sonnet-4-5-20250929@alpha` ->
 * `sonnet-4.5`, `claude-opus-5-5-fast` -> `opus-5.5 fast`,
 * `claude-opus-5[1m]` -> `opus-5 1m`. Anything that is not a Claude id is
 * returned without its account marker and otherwise untouched.
 */
export function shortModelName(modelID: string | undefined): string | undefined {
  let id = text(modelID)
  if (!id) return undefined
  const at = id.indexOf("@")
  if (at > 0) id = id.slice(0, at)
  let suffix = ""
  const window = /\[(\d+[km])\]$/i.exec(id)
  if (window) {
    suffix += ` ${window[1].toLowerCase()}`
    id = id.slice(0, window.index)
  }
  if (id.endsWith("-fast")) {
    suffix = ` fast${suffix}`
    id = id.slice(0, -"-fast".length)
  }
  if (!id.startsWith("claude-")) return `${id}${suffix}`
  id = id.slice("claude-".length).replace(/-\d{8}$/, "")
  const match = /^([a-z]+)-(\d+)(?:-(\d+))?$/.exec(id)
  if (!match) return `${id}${suffix}`
  const version = match[3] === undefined ? match[2] : `${match[2]}.${match[3]}`
  return `${match[1]}-${version}${suffix}`
}

/**
 * The account a provider id names on a multi-account install
 * (`claude-code-alpha` -> `alpha`). A bare `claude-code` (one account) and a
 * provider that is not this plugin's name none: there is nothing to tell apart.
 */
export function accountFromProvider(providerID: string | undefined): string | undefined {
  const id = text(providerID)
  if (!id?.startsWith("claude-code-")) return undefined
  return id.slice("claude-code-".length) || undefined
}

/** `sonnet-5.5 · high · alpha`; pieces that are not known are left out. */
export function subagentLabel(
  record: SpawnRecordInput | undefined,
  part: TaskPartInput | undefined,
): string {
  const asked = part?.metadata?.model as { modelID?: unknown; providerID?: unknown } | undefined
  const askedModel = typeof asked?.modelID === "string" ? asked.modelID : undefined
  const askedProvider = typeof asked?.providerID === "string" ? asked.providerID : undefined
  const model = shortModelName(record?.model ?? askedModel)
  const effort = text(record?.effort)
  const account = record?.model ? text(record.account) : accountFromProvider(askedProvider)
  return [model, effort, account].filter(Boolean).join(" · ")
}

/**
 * `$0.42`, and never more than five cells under ten thousand dollars (`$12.4`,
 * `$123`), because the spend shares one 36-cell line with the model, the effort
 * and the account, and a cent is noise past ten dollars. A spend under a cent
 * reads `<$0.01` rather than a false zero, and nothing at all is nothing: no
 * record, nothing spent yet, or not a number.
 */
export function formatCost(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  if (value < 0.005) return "<$0.01"
  const digits = [2, 1, 0].map((places) => value.toFixed(places)).find((text) => text.length <= 4)
  return `$${digits ?? value.toFixed(0)}`
}

/** `12s`, `1m03s`, `1h02m`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const pad = (value: number) => String(value).padStart(2, "0")
  if (minutes < 60) return `${minutes}m${pad(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h${pad(minutes % 60)}m`
}

/**
 * Cut `value` to `width` cells with a trailing ellipsis. Counts code points,
 * which is a cell each for the text a task description holds; a wide glyph
 * can overrun by one cell and is left to the renderer's own clipping.
 */
export function truncate(value: string, width: number): string {
  const chars = Array.from(value.replace(/\s+/g, " ").trim())
  if (width <= 0) return ""
  if (chars.length <= width) return chars.join("")
  if (width === 1) return "…"
  return `${chars.slice(0, width - 1).join("").trimEnd()}…`
}

/**
 * The rows for one session: running first (oldest first), then finished
 * (newest first), at most `FINISHED_KEEP` of those and none older than
 * `FINISHED_TTL_MS`. Empty when nothing is worth showing, which is what makes
 * the section disappear.
 */
export function deriveSubagentRows(input: SidebarInput): SubagentRow[] {
  const rows = levelRows(input, input, 0, new Set())
  const running = rows
    .filter((row) => row.state === "running")
    .sort((a, b) => a.started - b.started)
  const finished = rows
    .filter((row) => row.state !== "running")
    .filter((row) => input.now - (row.finished ?? row.started) <= FINISHED_TTL_MS)
    .sort((a, b) => (b.finished ?? b.started) - (a.finished ?? a.started))
    .slice(0, FINISHED_KEEP)
  return [...running, ...finished]
}

/**
 * The rows of one level of the tree: the subagents of one session (each with
 * what runs under it), the dispatches it has no session for yet, and its
 * background shells. `depth` is 0 for the viewed session's own.
 */
function levelRows(
  input: SidebarInput,
  level: NestedSessionInput,
  depth: number,
  visited: Set<string>,
): SubagentRow[] {
  const completions = new Map<string, CompletionInput>()
  for (const completion of level.completions) completions.set(completion.sessionID, completion)

  const byChild = new Map<string, TaskPartInput>()
  const unmatched: TaskPartInput[] = []
  for (const part of level.parts) {
    const child = partChildID(part)
    if (child) byChild.set(child, part)
    else unmatched.push(part)
  }

  const rows: SubagentRow[] = []
  const seen = new Set<string>()
  for (const child of level.children) {
    if (seen.has(child.id)) continue
    seen.add(child.id)
    const parsed = parseChildTitle(child.title)
    let part = byChild.get(child.id)
    if (!part) {
      // A running part has no child id yet: match it on the title opencode
      // gave the child, agent and description both.
      const index = unmatched.findIndex(
        (candidate) =>
          partDescription(candidate) === parsed.description &&
          (parsed.agent === undefined || partAgent(candidate) === parsed.agent),
      )
      if (index >= 0) part = unmatched.splice(index, 1)[0]
    }
    const under = depth < NESTED_DEPTH_MAX ? nestedRows(input, child.id, depth + 1, visited) : []
    rows.push(rowFor(input, child, parsed, part, completions.get(child.id), under))
  }
  // A dispatch opencode has not created a session for yet: shown, not clickable.
  for (const part of unmatched) {
    if (part.status !== "pending" && part.status !== "running") continue
    const description = partDescription(part)
    const agent = partAgent(part)
    if (!description && !agent) continue
    rows.push({
      agent: agent ?? "subagent",
      description: description ?? "",
      background: partBackground(part),
      state: "running",
      label: subagentLabel(undefined, part),
      started: part.start ?? input.now,
    })
  }
  for (const shell of level.shells ?? []) rows.push(shellRow(shell, input.now))
  return rows
}

/**
 * What runs under one subagent, one level down and below (h #g327): running
 * first (oldest first), then what finished within `NESTED_FINISHED_TTL_MS`
 * (newest first). A session is walked once, so a cycle the host should never
 * report still ends.
 */
function nestedRows(input: SidebarInput, sessionID: string, depth: number, visited: Set<string>): SubagentRow[] {
  if (!input.nested || visited.has(sessionID)) return []
  visited.add(sessionID)
  const level = input.nested(sessionID)
  if (!level) return []
  const rows = levelRows(input, level, depth, visited)
  const running = rows.filter((row) => row.state === "running").sort((a, b) => a.started - b.started)
  const finished = rows
    .filter((row) => row.state !== "running")
    .filter((row) => input.now - (row.finished ?? row.started) <= NESTED_FINISHED_TTL_MS)
    .sort((a, b) => (b.finished ?? b.started) - (a.finished ?? a.started))
  return [...running, ...finished]
}

function rowFor(
  input: SidebarInput,
  child: ChildSessionInput,
  parsed: { description: string; agent?: string },
  part: TaskPartInput | undefined,
  completion: CompletionInput | undefined,
  under: SubagentRow[] = [],
): SubagentRow {
  const background = part ? partBackground(part) : false
  const started = part?.start ?? child.created ?? input.now
  const status = input.status(child.id)
  // A child dispatched again (resumed by its session id) after it reported:
  // that envelope ended the earlier dispatch, not this one.
  const current =
    completion && completion.at !== undefined && part?.start !== undefined && completion.at < part.start
      ? undefined
      : completion
  // opencode 2.3: idle, with its own background work still going (h #g321).
  const working = current?.state === "running"
  const ended = working ? undefined : current
  let state: SubagentState
  let finished: number | undefined
  if (
    part &&
    !background &&
    part.status !== "pending" &&
    part.status !== "running" &&
    status !== "busy"
  ) {
    state = part.status === "completed" ? "done" : "error"
    finished = part.end
  } else if (working || status === "busy") {
    // A child that reads busy is running, whatever its part or an earlier
    // report says: a completed part whose child still works (a host whose
    // dispatch shape this module does not know), or a child that runs again
    // after it reported (opencode 2.3 reports every time it goes idle).
    state = "running"
  } else if (ended) {
    state = endState(ended.state)
    finished = ended.at
  } else if (part && !background) {
    // pending or running: the parent is still waiting on this child.
    state = "running"
  } else if (status === "idle" && input.now - started < STARTING_GRACE_MS) {
    state = "running"
  } else if (status === "unknown" && background) {
    // Nothing says it stopped: a background child keeps its spinner until
    // its envelope arrives or opencode reports it idle.
    state = "running"
  } else {
    state = "done"
  }
  // Work under it still runs (h #g327): a background shell it started, or a
  // subagent it dispatched, outlives its own turn. The child is not done while
  // that goes on, whatever its last report or its status says.
  const underRunning = under.some((row) => row.state === "running")
  if (underRunning && state !== "running") {
    state = "running"
    finished = undefined
  }
  if (state !== "running" && finished === undefined) {
    finished = input.stoppedAt(child.id) ?? child.updated ?? started
  }
  const cost = input.cost?.(child.id)
  return {
    sessionID: child.id,
    agent: parsed.agent ?? (part ? partAgent(part) : undefined) ?? text(child.agent) ?? "subagent",
    description: (part ? partDescription(part) : undefined) ?? parsed.description,
    background,
    state,
    label: subagentLabel(input.record(child.id), part),
    effort: text(input.record(child.id)?.effort),
    ...(cost !== undefined ? { cost } : {}),
    started,
    finished,
    ...(underRunning && status !== "busy" ? { waiting: true } : {}),
    // A finished subagent folds back to its single row.
    ...(state === "running" && under.length > 0 ? { under } : {}),
  }
}

/** `exit 0`, `exit 2`, `timed out`, `killed`, or `ended` when no exit was seen. */
function shellOutcome(shell: ShellInput): string {
  if (shell.status === "timeout") return "timed out"
  if (shell.status === "killed") return "killed"
  if (shell.status === "exited" && typeof shell.exit === "number") return `exit ${shell.exit}`
  return "ended"
}

/**
 * A background shell's row: `shell` and its command on the first line, how
 * long it has run (or how it ended and after how long) on the second. Only an
 * exit code of 0 is a ✓; a shell that left without an exit seen is `ended`,
 * a ✓ too, because nothing says it failed and the store drops a shell only
 * when its job ends.
 */
function shellRow(shell: ShellInput, now: number): SubagentRow {
  const started = shell.started
  if (shell.status === "running") {
    return {
      kind: "shell",
      agent: "shell",
      description: shell.command,
      background: true,
      state: "running",
      label: formatElapsed(now - started),
      started,
    }
  }
  const finished = shell.completed ?? now
  const ok = shell.status === "ended" || (shell.status === "exited" && shell.exit === 0)
  return {
    kind: "shell",
    agent: "shell",
    description: shell.command,
    background: true,
    state: ok ? "done" : "error",
    label: `${shellOutcome(shell)} · ${formatElapsed(finished - started)}`,
    started,
    finished,
  }
}

/** One shell as the host's store reports it; `sessionID` is its `metadata.sessionID`. */
export interface ObservedShell {
  id: string
  sessionID?: string
  command: string
  status: string
  exit?: number
  started?: number
  completed?: number
}

/**
 * One running background job as opencode 2.4's TUI store lists it (`JobInfo`,
 * `data.job.list(sessionID)`, h #g327): the jobs of a session and of every
 * session below it, each owned by `sessionID` (a subagent's by the session that
 * dispatched it). Only backgrounded jobs are listed, and only while they run.
 */
export interface JobInput {
  kind?: string
  id?: string
  sessionID?: string
  status?: string
  title?: string
  time?: { started?: number; completed?: number }
  shellID?: string
  command?: string
  childSessionID?: string
  agent?: string
  description?: string
}

/**
 * The background shells a job list names under `viewedID`, for the shell
 * memory: every session's but the viewed one's own, which come from its
 * location's store as before (h #g307). A job is a background one by
 * construction, so none of these is a foreground call.
 */
export function shellsFromJobs(jobs: readonly JobInput[], viewedID: string): ObservedShell[] {
  const shells: ObservedShell[] = []
  for (const job of jobs) {
    if (job?.kind !== "shell" || (job.status !== undefined && job.status !== "running")) continue
    const owner = text(job.sessionID)
    const id = text(job.shellID) ?? text(job.id)
    const command = text(job.command) ?? text(job.title)
    if (!owner || owner === viewedID || !id || !command) continue
    shells.push({ id, sessionID: owner, command, status: "running", started: job.time?.started })
  }
  return shells
}

/**
 * The subagents a job list names, each under the session that dispatched it,
 * with the title opencode gives the child: what lets a subagent of a subagent
 * be listed before the TUI has loaded its session.
 */
export function childrenFromJobs(jobs: readonly JobInput[]): Array<{ parentID: string; child: ChildSessionInput }> {
  const found: Array<{ parentID: string; child: ChildSessionInput }> = []
  for (const job of jobs) {
    if (job?.kind !== "subagent" || (job.status !== undefined && job.status !== "running")) continue
    const parentID = text(job.sessionID)
    const id = text(job.childSessionID)
    if (!parentID || !id) continue
    const description = text(job.description) ?? text(job.title) ?? ""
    const agent = text(job.agent)
    found.push({
      parentID,
      child: {
        id,
        title: agent ? `${description} (@${agent} subagent)` : description,
        ...(agent ? { agent } : {}),
        ...(job.time?.started !== undefined ? { created: job.time.started } : {}),
      },
    })
  }
  return found
}

interface RememberedShell extends ShellInput {
  sessionID: string
  /** The store this shell was read from, so its absence is only read off that store. */
  scope: string
  /** Seen running with no running tool part for its command: a background shell. */
  shown: boolean
}

/** How many shells the memory holds at most, across every session it has seen. */
export const SHELL_MEMORY_CAP = 64

/**
 * What the sidebar knows about a session's shells beyond what the store holds
 * this instant: which of them ran in the background (and so are rows at all),
 * and how each one ended after the store let go of it.
 */
export interface ShellMemory {
  /**
   * The store's shells for one location, and the commands of the session's
   * tool calls still running: a running shell whose command is not one of them
   * is a background shell from then on. A remembered running shell of the same
   * scope that is gone from the list has ended.
   */
  observe(scope: string, shells: ObservedShell[], foreground: ReadonlySet<string>, now: number): void
  /** `shell.exited`: the code and the status, for a shell already seen. */
  exited(id: string, status: string, exit: number | undefined, now: number): void
  /** The session's background shells, for `SidebarInput.shells`. */
  forSession(sessionID: string, now: number): ShellInput[]
}

export function createShellMemory(): ShellMemory {
  const shells = new Map<string, RememberedShell>()
  const prune = (now: number) => {
    for (const [id, shell] of shells) {
      if (shell.status !== "running" && now - (shell.completed ?? now) > FINISHED_TTL_MS) shells.delete(id)
    }
    // Oldest first, and a running shell only when nothing finished is left to drop.
    while (shells.size > SHELL_MEMORY_CAP) {
      const victim =
        [...shells.values()].find((shell) => shell.status !== "running") ?? shells.values().next().value
      if (!victim) break
      shells.delete(victim.id)
    }
  }
  return {
    observe(scope, observed, foreground, now) {
      const listed = new Set<string>()
      for (const shell of observed) {
        const sessionID = text(shell.sessionID)
        const command = text(shell.command)
        if (!sessionID || !command) continue
        listed.add(shell.id)
        const known = shells.get(shell.id)
        const running = shell.status === "running"
        const entry: RememberedShell = {
          id: shell.id,
          sessionID,
          scope,
          command,
          status: shell.status,
          exit: shell.exit ?? known?.exit,
          started: known?.started ?? shell.started ?? now,
          completed: running ? undefined : (shell.completed ?? known?.completed ?? now),
          shown: (known?.shown ?? false) || (running && !foreground.has(command)),
        }
        shells.set(shell.id, entry)
      }
      for (const shell of shells.values()) {
        if (shell.scope !== scope || listed.has(shell.id) || shell.status !== "running") continue
        shell.status = "ended"
        shell.completed = now
      }
      prune(now)
    },
    exited(id, status, exit, now) {
      const shell = shells.get(id)
      if (!shell) return
      shell.status = status === "running" ? "exited" : status
      if (typeof exit === "number") shell.exit = exit
      shell.completed ??= now
    },
    forSession(sessionID, now) {
      prune(now)
      const found: ShellInput[] = []
      for (const shell of shells.values()) {
        if (shell.sessionID !== sessionID || !shell.shown) continue
        found.push({
          id: shell.id,
          command: shell.command,
          status: shell.status,
          ...(shell.exit !== undefined ? { exit: shell.exit } : {}),
          started: shell.started,
          ...(shell.completed !== undefined ? { completed: shell.completed } : {}),
        })
      }
      return found
    },
  }
}

/**
 * A run of text with the role the TUI maps onto a theme colour. `bar-done`
 * through `cost` are the progress line's and the spend (`src/progress-line.ts`,
 * h #g246), `bar-likely` and `bar-band` the estimate's band on the bar
 * (h #g251); `tier`, `reset` and `ok` are the `Accounts` line's plan tier,
 * reset time and under-threshold level (`src/account-sidebar.ts`, h #g248).
 */
export interface Segment {
  text: string
  role:
    | "spinner"
    | "done"
    | "error"
    | "agent"
    | "description"
    | "muted"
    | "effort"
    | "effort-faded"
    | "bar-done"
    | "bar-likely"
    | "bar-band"
    | "bar-over"
    | "bar-track"
    | "fraction"
    | "estimate"
    | "estimate-over"
    | "tool"
    | "cost"
    | "tier"
    | "reset"
    | "ok"
}

/**
 * The two lines of one row, laid out for `width` cells:
 *
 *     ⠋ implementor Fix the dispatch f…  bg
 *      sonnet-5.5 · high · alpha · $0.42
 *
 * The `bg` marker is right-aligned, the description takes what is left, and a
 * finished row is drawn in the muted role throughout apart from its glyph and
 * its spend. The second line sits `ROW_INDENT` in. The spend follows the label
 * after ` · ` while that fits; when it does not, the dot goes first (a space
 * is left), then the spend itself: the model is never cut to make room for a
 * number, and a label that was cut already has none.
 */
export function layoutRow(
  row: SubagentRow,
  width: number = SIDEBAR_ROW_WIDTH,
  frame = 0,
): { first: Segment[]; second: Segment[] } {
  const finished = row.state !== "running"
  const glyph =
    row.state === "running"
      ? SPINNER_FRAMES[frame % SPINNER_FRAMES.length]
      : row.state === "done"
        ? "✓"
        : "✗"
  const marker = row.background ? "bg" : ""
  const reserved = marker ? marker.length + 1 : 0
  const agentWidth = Math.max(1, Math.min(Array.from(row.agent).length, width - 2 - reserved - 6))
  const agent = truncate(row.agent, agentWidth)
  const room = width - 2 - Array.from(agent).length - 1 - reserved
  const description = room > 0 ? truncate(row.description, room) : ""
  const used = 2 + Array.from(agent).length + (description ? 1 + Array.from(description).length : 0)
  const first: Segment[] = [
    { text: glyph, role: row.state === "running" ? "spinner" : row.state === "done" ? "done" : "error" },
    { text: " ", role: "muted" },
    // A shell's name takes the running tool's colour, so it reads apart from a subagent's.
    { text: agent, role: finished ? "muted" : row.kind === "shell" ? "tool" : "agent" },
  ]
  if (description) {
    first.push({ text: " ", role: "muted" })
    first.push({ text: description, role: finished ? "muted" : "description" })
  }
  if (marker) {
    first.push({ text: " ".repeat(Math.max(1, width - used - marker.length)), role: "muted" })
    first.push({ text: marker, role: "muted" })
  }
  // The effort is the one piece in colour: it is what changes from one
  // subagent to the next and what costs the most, so it is the one to spot.
  const second: Segment[] = []
  const content = width - ROW_INDENT.length
  const pieces = row.label ? truncate(row.label, content).split(" · ") : []
  const labelWidth = pieces.reduce((sum, piece) => sum + Array.from(piece).length, 0) + 3 * Math.max(0, pieces.length - 1)
  const cost = formatCost(row.cost)
  const costWidth = cost ? Array.from(cost).length : 0
  // What stands between the label and the spend: ` · ` while that fits, a
  // space when only that does, nothing after no label, and no spend at all
  // when even a space will not fit it.
  let joiner: string | undefined
  if (cost) {
    if (pieces.length === 0) joiner = costWidth <= content ? "" : undefined
    else if (labelWidth + 3 + costWidth <= content) joiner = " · "
    else if (labelWidth + 1 + costWidth <= content) joiner = " "
  }
  if (pieces.length > 0 || joiner !== undefined) {
    const effortAt = row.effort ? pieces.indexOf(row.effort) : -1
    second.push({ text: ROW_INDENT, role: "muted" })
    pieces.forEach((piece, index) => {
      if (index > 0) second.push({ text: " · ", role: "muted" })
      const role = index !== effortAt ? "muted" : finished ? "effort-faded" : "effort"
      second.push({ text: piece, role })
    })
    if (cost && joiner !== undefined) {
      if (joiner) second.push({ text: joiner, role: "muted" })
      second.push({ text: cost, role: "cost" })
    }
  }
  return { first, second }
}

/**
 * The lines under a running row (h #g327), its tree walked depth first: each
 * shell or subagent on one line, a subagent's own work under it one level in.
 * At most `NESTED_LINES_KEEP` lines, then one `+N more` for the rest; the tree
 * glyphs are drawn over what is shown, so the last line shown at each level
 * closes it. Lines deeper than `NESTED_INDENT_CAP` are drawn at that depth.
 * Empty for a row with nothing under it, which is every finished row.
 */
export function nestedLines(row: SubagentRow, now: number): NestedLine[] {
  if (row.state !== "running" || !row.under?.length) return []
  // Every line with its parent line, -1 for the row itself.
  const flat: Array<{ row?: SubagentRow; parent: number; more?: number }> = []
  const walk = (rows: SubagentRow[], parent: number) => {
    for (const child of rows) {
      const index = flat.length
      flat.push({ row: child, parent })
      if (child.under?.length) walk(child.under, index)
    }
  }
  walk(row.under, -1)
  const shown = flat.length > NESTED_LINES_KEEP ? flat.slice(0, NESTED_LINES_KEEP) : flat
  if (shown.length < flat.length) shown.push({ parent: -1, more: flat.length - shown.length })
  const followed = (index: number) =>
    shown.some((line, other) => other > index && line.parent === shown[index].parent)
  return shown.map((line, index) => {
    const rails: string[] = []
    for (let ancestor = line.parent; ancestor >= 0; ancestor = shown[ancestor].parent) {
      rails.unshift(followed(ancestor) ? "│ " : "  ")
    }
    const kept = rails.slice(Math.max(0, rails.length - (NESTED_INDENT_CAP - 1)))
    const lead = `${ROW_INDENT}${kept.join("")}${followed(index) ? "├ " : "└ "}`
    if (line.more !== undefined) return { lead, more: line.more, tail: "" }
    return { lead, row: line.row, tail: nestedTail(line.row!, now) }
  })
}

/** A shell's own label (`12m03s`, `exit 0 · 40s`); a subagent's time running, or the time it ran. */
function nestedTail(row: SubagentRow, now: number): string {
  if (row.kind === "shell") return row.label
  return formatElapsed((row.finished ?? now) - row.started)
}

/**
 * One nested line, laid out for `width` cells:
 *
 *      ├ ⠋ shell ffmpeg -i in.mov…  12m03s bg
 *      └ ⠋ implementor Fix the f…    2m10s bg
 *
 * The tree lead and the tail are muted, the glyph and the name keep their
 * row's colours, and the description takes what is left. A finished line is
 * muted throughout apart from its glyph, as a finished row is.
 */
export function layoutNestedLine(line: NestedLine, width: number = SIDEBAR_ROW_WIDTH, frame = 0): Segment[] {
  const lead: Segment = { text: line.lead, role: "muted" }
  if (!line.row) return [lead, { text: truncate(`+${line.more ?? 0} more`, width - Array.from(line.lead).length), role: "muted" }]
  const row = line.row
  const finished = row.state !== "running"
  const glyph =
    row.state === "running" ? SPINNER_FRAMES[frame % SPINNER_FRAMES.length] : row.state === "done" ? "✓" : "✗"
  const tail = [line.tail, row.background ? "bg" : ""].filter(Boolean).join(" ")
  const leadWidth = Array.from(line.lead).length
  const tailWidth = tail ? Array.from(tail).length + 1 : 0
  const room = width - leadWidth - 2 - tailWidth
  const agent = truncate(row.agent, Math.max(1, Math.min(Array.from(row.agent).length, room - 5)))
  const left = room - Array.from(agent).length - 1
  const description = left > 0 ? truncate(row.description, left) : ""
  const used = leadWidth + 2 + Array.from(agent).length + (description ? 1 + Array.from(description).length : 0)
  const segments: Segment[] = [
    lead,
    { text: glyph, role: row.state === "running" ? "spinner" : row.state === "done" ? "done" : "error" },
    { text: " ", role: "muted" },
    { text: agent, role: finished ? "muted" : row.kind === "shell" ? "tool" : "agent" },
  ]
  if (description) {
    segments.push({ text: " ", role: "muted" })
    segments.push({ text: description, role: finished ? "muted" : "description" })
  }
  if (tail) {
    segments.push({ text: " ".repeat(Math.max(1, width - used - Array.from(tail).length)), role: "muted" })
    segments.push({ text: tail, role: "muted" })
  }
  return segments
}

/** The collapsed heading's count: `2 running` or `3 done`, shells counted with subagents. */
export function collapsedSummary(rows: SubagentRow[]): string {
  const running = rows.filter((row) => row.state === "running").length
  return running > 0 ? `${running} running` : `${rows.length} done`
}
