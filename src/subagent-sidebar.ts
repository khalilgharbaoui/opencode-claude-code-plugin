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

export interface SidebarInput {
  children: ChildSessionInput[]
  parts: TaskPartInput[]
  completions: CompletionInput[]
  status: (sessionID: string) => ChildRunState
  record: (sessionID: string) => SpawnRecordInput | undefined
  /** When the TUI first saw a child stop, by session id. */
  stoppedAt: (sessionID: string) => number | undefined
  now: number
}

export interface SubagentRow {
  /** The child session, absent while a dispatch has not created one yet. */
  sessionID?: string
  agent: string
  description: string
  background: boolean
  state: SubagentState
  /** `sonnet-5.5 · high · alpha`, empty when nothing is known. */
  label: string
  started: number
  finished?: number
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
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

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

/** The child session a part names, on either major's metadata. */
export function partChildID(part: TaskPartInput): string | undefined {
  const metadata = part.metadata ?? {}
  return text(metadata.sessionId) ?? text(metadata.sessionID)
}

function partAgent(part: TaskPartInput): string | undefined {
  const input = part.input ?? {}
  return text(input.subagent_type) ?? text(input.agent)
}

function partDescription(part: TaskPartInput): string | undefined {
  return text(part.input?.description) ?? text(part.title)
}

function partBackground(part: TaskPartInput): boolean {
  return part.input?.background === true || part.metadata?.background === true
}

const COMPLETION_ENVELOPE =
  /<(?:task\s+id|subagent\s+sessionID)="(ses_[A-Za-z0-9]+)"\s+state="([a-z_]+)"/g

/**
 * Every background end a text names, in order. Both majors' envelopes:
 * `<task id="ses_..." state="completed">` (1.x) and
 * `<subagent sessionID="ses_..." state="completed">` (2.x). `running` is the
 * dispatch's own answer, not an end, so it is skipped.
 */
export function completionsIn(value: string, at?: number): CompletionInput[] {
  const found: CompletionInput[] = []
  for (const match of value.matchAll(COMPLETION_ENVELOPE)) {
    if (match[2] === "running") continue
    found.push({ sessionID: match[1], state: match[2], at })
  }
  return found
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
  const completions = new Map<string, CompletionInput>()
  for (const completion of input.completions) completions.set(completion.sessionID, completion)

  const byChild = new Map<string, TaskPartInput>()
  const unmatched: TaskPartInput[] = []
  for (const part of input.parts) {
    const child = partChildID(part)
    if (child) byChild.set(child, part)
    else unmatched.push(part)
  }

  const rows: SubagentRow[] = []
  const seen = new Set<string>()
  for (const child of input.children) {
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
    rows.push(rowFor(input, child, parsed, part, completions.get(child.id)))
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

function rowFor(
  input: SidebarInput,
  child: ChildSessionInput,
  parsed: { description: string; agent?: string },
  part: TaskPartInput | undefined,
  completion: CompletionInput | undefined,
): SubagentRow {
  const background = part ? partBackground(part) : false
  const started = part?.start ?? child.created ?? input.now
  const status = input.status(child.id)
  let state: SubagentState
  let finished: number | undefined
  if (part && !background && part.status !== "pending" && part.status !== "running") {
    state = part.status === "completed" ? "done" : "error"
    finished = part.end
  } else if (completion) {
    state = endState(completion.state)
    finished = completion.at
  } else if (status === "busy") {
    state = "running"
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
  if (state !== "running" && finished === undefined) {
    finished = input.stoppedAt(child.id) ?? child.updated ?? started
  }
  return {
    sessionID: child.id,
    agent: parsed.agent ?? (part ? partAgent(part) : undefined) ?? text(child.agent) ?? "subagent",
    description: (part ? partDescription(part) : undefined) ?? parsed.description,
    background,
    state,
    label: subagentLabel(input.record(child.id), part),
    started,
    finished,
  }
}

/** A run of text with the role the TUI maps onto a theme colour. */
export interface Segment {
  text: string
  role: "spinner" | "done" | "error" | "agent" | "description" | "muted"
}

/**
 * The two lines of one row, laid out for `width` cells:
 *
 *     ⠋ implementor Fix the dispatch f…  bg
 *       sonnet-5.5 · high · alpha
 *
 * The `bg` marker is right-aligned, the description takes what is left, and a
 * finished row is drawn in the muted role throughout apart from its glyph.
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
    { text: agent, role: finished ? "muted" : "agent" },
  ]
  if (description) {
    first.push({ text: " ", role: "muted" })
    first.push({ text: description, role: finished ? "muted" : "description" })
  }
  if (marker) {
    first.push({ text: " ".repeat(Math.max(1, width - used - marker.length)), role: "muted" })
    first.push({ text: marker, role: "muted" })
  }
  const second: Segment[] = row.label
    ? [{ text: `  ${truncate(row.label, width - 2)}`, role: "muted" }]
    : []
  return { first, second }
}

/** The collapsed heading's count: `2 running` or `3 done`. */
export function collapsedSummary(rows: SubagentRow[]): string {
  const running = rows.filter((row) => row.state === "running").length
  return running > 0 ? `${running} running` : `${rows.length} done`
}
