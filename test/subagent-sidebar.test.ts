/**
 * The model behind the sidebar's `Subagents` section (h #g234): which rows,
 * in which state and order, and the exact text of each.
 *
 * The inputs are shaped like what opencode 1.18.35's TUI store measurably
 * holds: a RUNNING `task` part with no `state.metadata`, a finished one whose
 * `metadata.model` is what opencode asked for rather than what ran, a
 * background part that completes at once, the synthetic `<task ...
 * state="completed">` push that ends a background child, and child sessions
 * titled `<description> (@<agent> subagent)`.
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  FINISHED_KEEP,
  FINISHED_TTL_MS,
  SIDEBAR_ROW_WIDTH,
  SPINNER_FRAMES,
  STARTING_GRACE_MS,
  accountFromProvider,
  collapsedSummary,
  completionsIn,
  deriveSubagentRows,
  layoutRow,
  parseChildTitle,
  shortModelName,
  subagentLabel,
  truncate,
  type ChildRunState,
  type ChildSessionInput,
  type SidebarInput,
  type SpawnRecordInput,
  type SubagentRow,
  type TaskPartInput,
} from "../src/subagent-sidebar.js"

const NOW = 1_800_000_000_000

function input(overrides: Partial<SidebarInput> & {
  statuses?: Record<string, ChildRunState>
  records?: Record<string, SpawnRecordInput>
  stopped?: Record<string, number>
} = {}): SidebarInput {
  const { statuses = {}, records = {}, stopped = {}, ...rest } = overrides
  return {
    children: [],
    parts: [],
    completions: [],
    status: (id) => statuses[id] ?? "unknown",
    record: (id) => records[id],
    stoppedAt: (id) => stopped[id],
    now: NOW,
    ...rest,
  }
}

const child = (id: string, description: string, agent: string, created: number): ChildSessionInput => ({
  id,
  title: `${description} (@${agent} subagent)`,
  created,
})

const runningPart = (description: string, agent: string, start: number): TaskPartInput => ({
  status: "running",
  input: { description, prompt: "x", subagent_type: agent },
  start,
})

const finishedPart = (
  id: string,
  description: string,
  agent: string,
  start: number,
  end: number,
  status = "completed",
): TaskPartInput => ({
  status,
  input: { description, prompt: "x", subagent_type: agent },
  metadata: {
    parentSessionId: "ses_parent",
    sessionId: id,
    model: { providerID: "claude-code-default", modelID: "claude-opus-5-5" },
  },
  title: description,
  start,
  end,
})

const backgroundPart = (id: string, description: string, agent: string, start: number): TaskPartInput => ({
  status: "completed",
  input: { description, prompt: "x", subagent_type: agent, background: true },
  metadata: {
    sessionId: id,
    background: true,
    model: { providerID: "claude-code-alpha", modelID: "claude-haiku-4-5" },
  },
  start,
  end: start + 50,
})

test("parseChildTitle reads opencode's subagent title and leaves anything else whole", () => {
  assert.deepEqual(parseChildTitle("Fix the form (@implementor subagent)"), {
    description: "Fix the form",
    agent: "implementor",
  })
  assert.deepEqual(parseChildTitle("A title with (parens) inside (@explore subagent)"), {
    description: "A title with (parens) inside",
    agent: "explore",
  })
  assert.deepEqual(parseChildTitle("Plain title"), { description: "Plain title" })
  assert.deepEqual(parseChildTitle(undefined), { description: "" })
})

test("completionsIn reads both majors' envelopes and skips the dispatch's own running answer", () => {
  const text = [
    '<task id="ses_a1" state="running">',
    '<task id="ses_b2" state="completed">\n<summary>Background task completed</summary>',
    '<subagent sessionID="ses_c3" state="cancelled" description="x">',
    '<task id="not_a_session" state="completed">',
  ].join("\n")
  assert.deepEqual(completionsIn(text, 5), [
    { sessionID: "ses_b2", state: "completed", at: 5 },
    { sessionID: "ses_c3", state: "cancelled", at: 5 },
  ])
})

test("shortModelName shortens Claude ids and leaves other providers' ids alone", () => {
  assert.equal(shortModelName("claude-opus-5-5"), "opus-5.5")
  assert.equal(shortModelName("claude-sonnet-4-5-20250929"), "sonnet-4.5")
  assert.equal(shortModelName("claude-haiku-4-5@alpha"), "haiku-4.5")
  assert.equal(shortModelName("claude-opus-5-5-fast"), "opus-5.5 fast")
  assert.equal(shortModelName("claude-opus-5[1m]"), "opus-5 1m")
  assert.equal(shortModelName("claude-fable-5-1"), "fable-5.1")
  assert.equal(shortModelName("gpt-5.5"), "gpt-5.5")
  assert.equal(shortModelName(""), undefined)
  assert.equal(shortModelName(undefined), undefined)
})

test("accountFromProvider names an account only on a multi-account provider id", () => {
  assert.equal(accountFromProvider("claude-code-alpha"), "alpha")
  assert.equal(accountFromProvider("claude-code-default"), "default")
  assert.equal(accountFromProvider("claude-code"), undefined)
  assert.equal(accountFromProvider("anthropic"), undefined)
})

test("the label prefers what really spawned over what opencode asked for", () => {
  const part = finishedPart("ses_1", "d", "implementor", 1, 2)
  // opencode asked for opus on the default account; the plugin ran sonnet at high.
  assert.equal(
    subagentLabel({ model: "claude-sonnet-5-5", effort: "high", account: "default" }, part),
    "sonnet-5.5 · high · default",
  )
  // No record yet: opencode's own view, with no effort, which it never knows.
  assert.equal(subagentLabel(undefined, part), "opus-5.5 · default")
  // A single-account record carries no account, and the label shows none.
  assert.equal(subagentLabel({ model: "claude-opus-5-5", effort: "max" }, part), "opus-5.5 · max")
  // Nothing known at all: an empty label, so the row has no second line.
  assert.equal(subagentLabel(undefined, runningPart("d", "a", 1)), "")
})

test("truncate cuts on code points with an ellipsis and collapses whitespace", () => {
  assert.equal(truncate("short", 10), "short")
  assert.equal(truncate("exactly ten", 11), "exactly ten")
  assert.equal(truncate("Survey docs for stale links", 22), "Survey docs for stale…")
  assert.equal(truncate("trailing space cut", 16), "trailing space…")
  assert.equal(truncate("multi\n  line   text", 40), "multi line text")
  assert.equal(truncate("anything", 1), "…")
  assert.equal(truncate("anything", 0), "")
})

test("a running foreground child is matched to its part by title, with no metadata on the part", () => {
  const rows = deriveSubagentRows(
    input({
      children: [child("ses_fg", "Fix the form", "implementor", NOW - 5000)],
      parts: [runningPart("Fix the form", "implementor", NOW - 5100)],
      statuses: { ses_fg: "busy" },
      records: { ses_fg: { model: "claude-sonnet-5-5", effort: "high" } },
    }),
  )
  assert.equal(rows.length, 1)
  assert.deepEqual(
    { ...rows[0] },
    {
      sessionID: "ses_fg",
      agent: "implementor",
      description: "Fix the form",
      background: false,
      state: "running",
      label: "sonnet-5.5 · high",
      effort: "high",
      started: NOW - 5100,
      finished: undefined,
    },
  )
})

test("a foreground part ends the row with the part's own status, error included", () => {
  const rows = deriveSubagentRows(
    input({
      children: [child("ses_ok", "Done one", "general", NOW - 9000), child("ses_bad", "Failed one", "general", NOW - 8000)],
      parts: [
        finishedPart("ses_ok", "Done one", "general", NOW - 9000, NOW - 3000),
        finishedPart("ses_bad", "Failed one", "general", NOW - 8000, NOW - 2000, "error"),
      ],
      statuses: { ses_ok: "idle", ses_bad: "idle" },
    }),
  )
  assert.deepEqual(
    rows.map((row) => [row.sessionID, row.state, row.finished]),
    [
      ["ses_bad", "error", NOW - 2000],
      ["ses_ok", "done", NOW - 3000],
    ],
  )
})

test("a background child runs until its completion envelope, whatever its part says", () => {
  const base = {
    children: [child("ses_bg", "Survey docs", "explore", NOW - 60_000)],
    parts: [backgroundPart("ses_bg", "Survey docs", "explore", NOW - 60_000)],
  }
  const running = deriveSubagentRows(input({ ...base, statuses: { ses_bg: "busy" } }))
  assert.equal(running[0].state, "running")
  assert.equal(running[0].background, true)
  assert.equal(running[0].label, "haiku-4.5 · alpha")

  const done = deriveSubagentRows(
    input({
      ...base,
      statuses: { ses_bg: "idle" },
      completions: [{ sessionID: "ses_bg", state: "completed", at: NOW - 1000 }],
    }),
  )
  assert.equal(done[0].state, "done")
  assert.equal(done[0].finished, NOW - 1000)

  const cancelled = deriveSubagentRows(
    input({ ...base, completions: [{ sessionID: "ses_bg", state: "cancelled", at: NOW - 1000 }] }),
  )
  assert.equal(cancelled[0].state, "error")
})

test("a background child that has not been marked busy yet keeps its spinner", () => {
  const started = NOW - (STARTING_GRACE_MS - 1000)
  const fresh = deriveSubagentRows(
    input({
      children: [child("ses_bg", "Survey docs", "explore", started)],
      parts: [backgroundPart("ses_bg", "Survey docs", "explore", started)],
      statuses: { ses_bg: "idle" },
    }),
  )
  assert.equal(fresh[0].state, "running")
  // Nothing has reported on it at all: still running until something does.
  const silent = deriveSubagentRows(
    input({
      children: [child("ses_bg", "Survey docs", "explore", NOW - 60_000)],
      parts: [backgroundPart("ses_bg", "Survey docs", "explore", NOW - 60_000)],
    }),
  )
  assert.equal(silent[0].state, "running")
  // Idle well past the grace with no envelope: it finished and the push is late.
  const idle = deriveSubagentRows(
    input({
      children: [child("ses_bg", "Survey docs", "explore", NOW - 60_000)],
      parts: [backgroundPart("ses_bg", "Survey docs", "explore", NOW - 60_000)],
      statuses: { ses_bg: "idle" },
      stopped: { ses_bg: NOW - 2000 },
    }),
  )
  assert.equal(idle[0].state, "done")
  assert.equal(idle[0].finished, NOW - 2000)
})

test("a dispatch with no session yet is shown, not clickable, and a finished stray part is not", () => {
  const rows = deriveSubagentRows(
    input({
      parts: [
        { status: "pending", input: { description: "Queued", subagent_type: "general" }, start: NOW - 10 },
        { status: "completed", input: { description: "Old", subagent_type: "general" }, start: NOW - 100, end: NOW - 50 },
      ],
    }),
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sessionID, undefined)
  assert.equal(rows[0].description, "Queued")
  assert.equal(rows[0].state, "running")
})

test("running rows come first oldest first, then finished newest first, capped and aged out", () => {
  const children: ChildSessionInput[] = []
  const parts: TaskPartInput[] = []
  const statuses: Record<string, ChildRunState> = {}
  for (const [id, start] of [["ses_r2", NOW - 2000], ["ses_r1", NOW - 9000]] as const) {
    children.push(child(id, id, "general", start))
    parts.push(runningPart(id, "general", start))
    statuses[id] = "busy"
  }
  const ends = [NOW - 1000, NOW - 4000, NOW - 3000, NOW - 2000, NOW - FINISHED_TTL_MS - 1]
  ends.forEach((end, index) => {
    const id = `ses_f${index}`
    children.push(child(id, id, "general", end - 500))
    parts.push(finishedPart(id, id, "general", end - 500, end))
    statuses[id] = "idle"
  })
  const rows = deriveSubagentRows(input({ children, parts, statuses }))
  assert.deepEqual(
    rows.map((row) => row.sessionID),
    ["ses_r1", "ses_r2", "ses_f0", "ses_f3", "ses_f2"],
  )
  assert.equal(rows.filter((row) => row.state !== "running").length, FINISHED_KEEP)
})

test("no subagents means no rows, which is what hides the section", () => {
  assert.deepEqual(deriveSubagentRows(input()), [])
})

test("a child seen twice is listed once", () => {
  const rows = deriveSubagentRows(
    input({
      children: [child("ses_x", "Same", "general", NOW - 10), child("ses_x", "Same", "general", NOW - 10)],
      statuses: { ses_x: "busy" },
    }),
  )
  assert.equal(rows.length, 1)
})

const row = (overrides: Partial<SubagentRow> = {}): SubagentRow => ({
  sessionID: "ses_1",
  agent: "implementor",
  description: "Fix the dispatch form wording",
  background: false,
  state: "running",
  label: "sonnet-5.5 · high · alpha",
  effort: "high",
  started: NOW,
  ...overrides,
})

const flat = (segments: { text: string }[]) => segments.map((segment) => segment.text).join("")

test("layoutRow fits the sidebar, right-aligns bg, and puts the label on a muted second line", () => {
  const foreground = layoutRow(row(), SIDEBAR_ROW_WIDTH, 0)
  assert.equal(flat(foreground.first), "⠋ implementor Fix the dispatch form…")
  assert.ok(Array.from(flat(foreground.first)).length <= SIDEBAR_ROW_WIDTH)
  assert.equal(flat(foreground.second), "  sonnet-5.5 · high · alpha")
  assert.deepEqual(
    foreground.first.map((segment) => segment.role),
    ["spinner", "muted", "agent", "muted", "description"],
  )
  // Only the effort is in colour; the separators, model and account stay muted.
  assert.deepEqual(
    foreground.second.map((segment) => [segment.text, segment.role]),
    [["  ", "muted"], ["sonnet-5.5", "muted"], [" · ", "muted"], ["high", "effort"], [" · ", "muted"], ["alpha", "muted"]],
  )

  const background = layoutRow(row({ agent: "explore", description: "Survey docs for stale links", background: true }))
  assert.equal(flat(background.first), "⠋ explore Survey docs for stale…  bg")
  assert.equal(Array.from(flat(background.first)).length, SIDEBAR_ROW_WIDTH)
})

test("layoutRow draws a finished row muted apart from its glyph, and the spinner follows the frame", () => {
  const done = layoutRow(row({ state: "done" }))
  assert.equal(done.first[0].text, "✓")
  assert.equal(done.first[0].role, "done")
  assert.ok(done.first.slice(1).every((segment) => segment.role === "muted"))
  assert.equal(layoutRow(row({ state: "error" })).first[0].text, "✗")
  assert.equal(layoutRow(row(), SIDEBAR_ROW_WIDTH, 3).first[0].text, SPINNER_FRAMES[3])
  assert.deepEqual(layoutRow(row({ label: "" })).second, [])
})

test("layoutRow fades the effort on a finished row, and colours nothing when the effort is unknown", () => {
  const roleOf = (laid: ReturnType<typeof layoutRow>, text: string) =>
    laid.second.find((segment) => segment.text === text)?.role
  assert.equal(roleOf(layoutRow(row({ state: "done" })), "high"), "effort-faded")
  assert.equal(roleOf(layoutRow(row({ state: "error" })), "high"), "effort-faded")
  const unknown = layoutRow(row({ label: "haiku-4.5 · alpha", effort: undefined }))
  assert.ok(unknown.second.every((segment) => segment.role === "muted"))
  // A label cut short past the effort leaves nothing to colour, never a wrong piece.
  const cut = layoutRow(row({ label: "sonnet-5.5 · high · alpha" }), 12)
  assert.ok(cut.second.every((segment) => segment.role === "muted" || segment.text === "high"))
})

test("a row's effort comes from the spawn record, the same source as its label", () => {
  const rows = deriveSubagentRows(
    input({
      children: [child("ses_e", "Effort check", "explore", NOW - 100)],
      statuses: { ses_e: "busy" },
      records: { ses_e: { model: "claude-haiku-5-5", effort: "low", account: "alpha" } },
    }),
  )
  assert.equal(rows[0]?.effort, "low")
  assert.match(rows[0]?.label ?? "", / · low · /)
})

test("layoutRow keeps a very long agent name from pushing the description off the row", () => {
  const laid = layoutRow(row({ agent: "an-extremely-long-custom-agent-name-indeed", background: true }))
  const line = flat(laid.first)
  assert.ok(Array.from(line).length <= SIDEBAR_ROW_WIDTH, line)
  assert.ok(line.endsWith("bg"), line)
  assert.ok(line.includes("…"), line)
})

test("collapsedSummary counts what is running, else what is done", () => {
  assert.equal(collapsedSummary([row(), row(), row({ state: "done" })]), "2 running")
  assert.equal(collapsedSummary([row({ state: "done" }), row({ state: "error" })]), "2 done")
})
