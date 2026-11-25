/**
 * Background work under a subagent in the sidebar (h #g327), on opencode 2.4:
 * the report form opencode 2.4 writes, a subagent row that keeps running while
 * its own background shells or its own subagents run, those listed under it as
 * a tree, and the limits that keep it calm.
 *
 * The report text is built from the two templates read out of the opencode
 * 2.4.1 binary (`wj`, which wraps every background report, and `cf`, which
 * lists the work still running); the job shapes are `JobInfo` from
 * `@opencode/client` 2.4.0.
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  FINISHED_KEEP,
  FINISHED_TTL_MS,
  NESTED_FINISHED_TTL_MS,
  NESTED_INDENT_CAP,
  NESTED_LINES_KEEP,
  SIDEBAR_ROW_WIDTH,
  STARTING_GRACE_MS,
  childrenFromJobs,
  completionsIn,
  createShellMemory,
  deriveSubagentRows,
  layoutNestedLine,
  nestedLines,
  shellsFromJobs,
  type ChildRunState,
  type ChildSessionInput,
  type CompletionInput,
  type JobInput,
  type NestedSessionInput,
  type ShellInput,
  type SidebarInput,
  type SubagentRow,
  type TaskPartInput,
} from "../src/subagent-sidebar.js"

const NOW = 1_800_000_000_000
const PARENT = "ses_parent24"
const CHILD = "ses_df5c45133ffeSOZp13ZiV3UZhs"
const GRANDCHILD = "ses_grand24"

/** `wj(attributes, body)` as opencode 2.4.1 writes it. */
function backgroundResult(attributes: string, body: string): string {
  return `<background-result ${attributes}>\n${body}\n</background-result>`
}

/** The parent's report when its child went idle with a shell still running (2.4.1's `cf`). */
function reportRunning(child = CHILD, description = "Render the promo"): string {
  return backgroundResult(
    `kind="subagent" sessionID="${child}" state="running" description="${description}"`,
    "Captures started.\n\nBackground work still running:\n- shell (sh_capture): ffmpeg -i capture.mov out.mp4",
  )
}

function report(state: string, child = CHILD, description = "Render the promo"): string {
  return backgroundResult(`kind="subagent" sessionID="${child}" state="${state}" description="${description}"`, "Done.")
}

const child = (id: string, description: string, created: number, agent = "director"): ChildSessionInput => ({
  id,
  title: `${description} (@${agent} subagent)`,
  created,
})

/** A 2.3+ `subagent` part: completed at once, its metadata still saying the child runs. */
const part = (id: string, description: string, start: number, agent = "director"): TaskPartInput => ({
  status: "completed",
  input: { agent, description, prompt: "x" },
  metadata: { sessionID: id, status: "running" },
  start,
  end: start + 20,
})

const runningShell = (id: string, command: string, started: number): ShellInput => ({
  id,
  command,
  status: "running",
  started,
})

function sidebar(
  overrides: Partial<SidebarInput> & {
    statuses?: Record<string, ChildRunState>
    below?: Record<string, NestedSessionInput>
  } = {},
): SidebarInput {
  const { statuses = {}, below, ...rest } = overrides
  return {
    children: [],
    parts: [],
    completions: [],
    status: (id) => statuses[id] ?? "idle",
    record: () => undefined,
    stoppedAt: () => undefined,
    now: NOW,
    ...(below ? { nested: (id: string) => below[id] } : {}),
    ...rest,
  }
}

const level = (overrides: Partial<NestedSessionInput> = {}): NestedSessionInput => ({
  children: [],
  parts: [],
  completions: [],
  shells: [],
  ...overrides,
})

/** The text a laid-out line shows, its cells in order. */
const shown = (row: SubagentRow) => nestedLines(row, NOW).map((line) => layoutNestedLine(line).map((s) => s.text).join(""))

// --- A: the 2.4 report ------------------------------------------------------

test("completionsIn reads opencode 2.4's <background-result kind=\"subagent\"> report, every state", () => {
  const at = NOW - 1000
  assert.deepEqual(completionsIn(reportRunning(), at), [{ sessionID: CHILD, state: "running", at }])
  for (const state of ["completed", "error", "cancelled"]) {
    assert.deepEqual(completionsIn(report(state), at), [{ sessionID: CHILD, state, at }], state)
  }
})

test("completionsIn skips a background report that is not a subagent's, and reads the attributes in any order", () => {
  const shell = backgroundResult(`kind="shell" id="sh_capture" state="completed" command="ffmpeg -i a b"`, "exit 0")
  const image = backgroundResult(`kind="image" id="img_1" state="completed"`, "saved")
  assert.deepEqual(completionsIn(`${shell}\n${image}`), [])
  const reordered = `<background-result state="completed" sessionID="${CHILD}" kind="subagent">\nok\n</background-result>`
  assert.deepEqual(completionsIn(reordered), [{ sessionID: CHILD, state: "completed", at: undefined }])
  // A description quoting a tag or an attribute does not change what is read.
  const tricky = backgroundResult(
    `kind="subagent" sessionID="${CHILD}" state="completed" description="say state="running" and <subagent sessionID="x">`,
    "ok",
  )
  assert.deepEqual(completionsIn(tricky), [{ sessionID: CHILD, state: "completed", at: undefined }])
  // Not a session id, or no state: nothing.
  assert.deepEqual(completionsIn(`<background-result kind="subagent" sessionID="nope" state="completed">`), [])
  assert.deepEqual(completionsIn(`<background-result kind="subagent" sessionID="${CHILD}">`), [])
})

test("completionsIn keeps every older form, and reports every form in text order", () => {
  const text = [
    `<task id="ses_one" state="completed">`,
    report("completed", "ses_two"),
    `<subagent sessionID="ses_three" state="error">`,
    `<task id="ses_four" state="running">`,
  ].join("\n")
  assert.deepEqual(
    completionsIn(text).map((completion) => `${completion.sessionID}:${completion.state}`),
    ["ses_one:completed", "ses_two:completed", "ses_three:error"],
  )
})

test("a 2.4 running report keeps the row spinning, and its completed report ends it", () => {
  const start = NOW - 10 * 60_000
  const base = { children: [child(CHILD, "Render the promo", start)], parts: [part(CHILD, "Render the promo", start)] }
  const running = deriveSubagentRows(sidebar({ ...base, completions: completionsIn(reportRunning(), NOW - 60_000) }))
  assert.equal(running[0].state, "running")
  const ended = deriveSubagentRows(
    sidebar({
      ...base,
      completions: [...completionsIn(reportRunning(), NOW - 60_000), ...completionsIn(report("completed"), NOW - 1000)],
    }),
  )
  assert.equal(ended[0].state, "done")
  assert.equal(ended[0].finished, NOW - 1000)
})

// --- B: a subagent's own background shells -----------------------------------

test("the reported case: an idle child whose report said completed still runs while its shell runs, and lists it", () => {
  const start = NOW - 30 * 60_000
  const input = sidebar({
    children: [child(CHILD, "Render the promo", start)],
    parts: [part(CHILD, "Render the promo", start)],
    completions: completionsIn(report("completed"), NOW - 20 * 60_000),
    below: { [CHILD]: level({ shells: [runningShell("sh_capture", "ffmpeg -i capture.mov out.mp4", NOW - 25 * 60_000)] }) },
  })
  const [row] = deriveSubagentRows(input)
  assert.equal(row.state, "running")
  assert.equal(row.finished, undefined)
  assert.equal(row.waiting, true, "an idle child running only for its shell has no turn to measure")
  assert.equal(row.under?.length, 1)
  assert.equal(row.under?.[0].kind, "shell")
  const lines = nestedLines(row, NOW)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].lead, " └ ")
  assert.equal(lines[0].tail, "25m00s")
  const text = shown(row)[0]
  assert.ok(text.startsWith(" └ ⠋ shell ffmpeg"), text)
  assert.ok(text.endsWith("25m00s bg"), text)
  assert.ok(Array.from(text).length <= SIDEBAR_ROW_WIDTH)
})

test("without what runs under it the same child is done: opencode 1.x, or a host that cannot say, is unchanged", () => {
  const start = NOW - 30 * 60_000
  const base = {
    children: [child(CHILD, "Render the promo", start)],
    parts: [part(CHILD, "Render the promo", start)],
    completions: completionsIn(report("completed"), NOW - 5 * 60_000),
  }
  const [row] = deriveSubagentRows(sidebar(base))
  assert.equal(row.state, "done")
  assert.equal("under" in row, false)
  assert.equal("waiting" in row, false)
  // Nothing under it running, though the host can say: also done, and folded.
  const [quiet] = deriveSubagentRows(sidebar({ ...base, below: { [CHILD]: level() } }))
  assert.deepEqual(quiet, row)
})

test("a child that aged out of the list comes back while a shell it started runs", () => {
  const start = NOW - 3 * FINISHED_TTL_MS
  const base = {
    children: [child(CHILD, "Render the promo", start)],
    parts: [part(CHILD, "Render the promo", start)],
    completions: completionsIn(report("completed"), NOW - 2 * FINISHED_TTL_MS),
  }
  assert.deepEqual(deriveSubagentRows(sidebar(base)), [])
  const rows = deriveSubagentRows(
    sidebar({ ...base, below: { [CHILD]: level({ shells: [runningShell("sh_tts", "say -o vo.aiff", NOW - 60_000)] }) } }),
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].state, "running")
})

test("a busy child with its shell running is running and not waiting: its own turn has a progress line", () => {
  const start = NOW - 60_000
  const [row] = deriveSubagentRows(
    sidebar({
      children: [child(CHILD, "Render the promo", start)],
      parts: [part(CHILD, "Render the promo", start)],
      statuses: { [CHILD]: "busy" },
      below: { [CHILD]: level({ shells: [runningShell("sh_capture", "ffmpeg", NOW - 30_000)] }) },
    }),
  )
  assert.equal(row.state, "running")
  assert.equal("waiting" in row, false)
  assert.equal(row.under?.length, 1)
})

test("a shell that ended shows how it went while its child works on, then folds away", () => {
  const start = NOW - 30 * 60_000
  const ended: ShellInput = { id: "sh_capture", command: "ffmpeg", status: "exited", exit: 0, started: NOW - 20 * 60_000, completed: NOW - 10_000 }
  const base = {
    children: [child(CHILD, "Render the promo", start)],
    parts: [part(CHILD, "Render the promo", start)],
    completions: completionsIn(reportRunning(), NOW - 15 * 60_000),
  }
  // The shell's end woke the child: it is busy, and the shell's outcome is under it.
  const [woken] = deriveSubagentRows(sidebar({ ...base, statuses: { [CHILD]: "busy" }, below: { [CHILD]: level({ shells: [ended] }) } }))
  assert.equal(woken.state, "running")
  const text = shown(woken)[0]
  assert.ok(text.startsWith(" └ ✓ shell ffmpeg"), text)
  assert.ok(text.endsWith("exit 0 · 19m50s bg"), text)
  // Past the brief window the outcome folds away, the child still running.
  const later = { ...ended, completed: NOW - NESTED_FINISHED_TTL_MS - 1 }
  const [quiet] = deriveSubagentRows(sidebar({ ...base, statuses: { [CHILD]: "busy" }, below: { [CHILD]: level({ shells: [later] }) } }))
  assert.equal(quiet.state, "running")
  assert.equal("under" in quiet, false)
  // The child reported and went idle: the row is done and folds back to one row.
  const [done] = deriveSubagentRows(
    sidebar({
      ...base,
      completions: [...base.completions, ...completionsIn(report("completed"), NOW - 1000)],
      below: { [CHILD]: level({ shells: [ended] }) },
    }),
  )
  assert.equal(done.state, "done")
  assert.equal("under" in done, false)
  assert.deepEqual(nestedLines(done, NOW), [])
})

// --- C: subagents of subagents -----------------------------------------------

test("a subagent's own subagent is listed under it, its report read from its parent's messages", () => {
  const start = NOW - 20 * 60_000
  const top = {
    children: [child(CHILD, "Render the promo", start)],
    parts: [part(CHILD, "Render the promo", start)],
    completions: completionsIn(report("completed"), NOW - 10 * 60_000),
  }
  const input = sidebar({
    ...top,
    statuses: { [GRANDCHILD]: "busy" },
    below: {
      [CHILD]: level({
        children: [child(GRANDCHILD, "Write the voice-over", NOW - 5 * 60_000, "writer")],
        parts: [part(GRANDCHILD, "Write the voice-over", NOW - 5 * 60_000, "writer")],
      }),
      [GRANDCHILD]: level(),
    },
  })
  const [row] = deriveSubagentRows(input)
  assert.equal(row.state, "running")
  assert.equal(row.waiting, true)
  const nested = row.under?.[0]
  assert.equal(nested?.sessionID, GRANDCHILD, "a nested subagent keeps its session, so a click opens it")
  assert.equal(nested?.agent, "writer")
  assert.equal(nested?.background, true)
  const text = shown(row)[0]
  assert.ok(text.startsWith(" └ ⠋ writer Write the voic"), text)
  assert.ok(text.endsWith("5m00s bg"), text)

  // Its own report, in its parent's messages, ends it; the row then folds.
  const reported = sidebar({
    ...top,
    below: {
      [CHILD]: level({
        children: [child(GRANDCHILD, "Write the voice-over", NOW - 5 * 60_000, "writer")],
        parts: [part(GRANDCHILD, "Write the voice-over", NOW - 5 * 60_000, "writer")],
        completions: completionsIn(report("completed", GRANDCHILD), NOW - 2 * 60_000),
      }),
      [GRANDCHILD]: level(),
    },
  })
  const [after] = deriveSubagentRows(reported)
  assert.equal(after.state, "done")
  assert.equal("under" in after, false)
})

test("the tree is drawn with rails, running first, and a deep tree is set in no further than the cap", () => {
  const ids = ["ses_d1", "ses_d2", "ses_d3", "ses_d4", "ses_d5"]
  const below: Record<string, NestedSessionInput> = {}
  // CHILD -> d1 -> d2 -> d3 -> d4 -> d5, each busy, d5 with a shell; CHILD with a shell of its own.
  below[CHILD] = level({
    children: [child(ids[0], "Level one", NOW - 50_000, "a")],
    shells: [runningShell("sh_top", "sleep 90", NOW - 40_000)],
  })
  ids.forEach((id, index) => {
    below[id] = level({
      children: index + 1 < ids.length ? [child(ids[index + 1], `Level ${index + 2}`, NOW - 30_000 + index, "b")] : [],
      shells: index + 1 === ids.length ? [runningShell("sh_deep", "sleep 5", NOW - 1000)] : [],
    })
  })
  const statuses = Object.fromEntries(ids.map((id) => [id, "busy" as ChildRunState]))
  const [row] = deriveSubagentRows(
    sidebar({
      children: [child(CHILD, "Render the promo", NOW - 60_000)],
      parts: [part(CHILD, "Render the promo", NOW - 60_000)],
      statuses,
      below,
    }),
  )
  const lines = nestedLines(row, NOW)
  // Three lines and the rest folded: d1 (oldest running), d2, d3, then +N.
  assert.equal(lines.length, NESTED_LINES_KEEP + 1)
  assert.deepEqual(
    lines.map((line) => line.lead),
    [" ├ ", " │ └ ", " │   └ ", " └ "],
  )
  assert.equal(lines[3].more, 4, "d4, d5, d5's shell and CHILD's own shell are folded")
  for (const line of lines) assert.ok(Array.from(line.lead).length <= 1 + 2 * NESTED_INDENT_CAP, line.lead)
  for (const text of shown(row)) assert.ok(Array.from(text).length <= SIDEBAR_ROW_WIDTH, text)
  assert.equal(shown(row)[3], " └ +4 more")
})

test("a deep chain shows its first three levels and folds the rest, so no line is set in past the cap", () => {
  const ids = ["ses_e1", "ses_e2", "ses_e3", "ses_e4"]
  const below: Record<string, NestedSessionInput> = {}
  below[CHILD] = level({ children: [child(ids[0], "One", NOW - 10_000, "a")] })
  ids.forEach((id, index) => {
    below[id] = level({ children: index + 1 < ids.length ? [child(ids[index + 1], `Next ${index}`, NOW - 9_000, "a")] : [] })
  })
  const row: SubagentRow = deriveSubagentRows(
    sidebar({
      children: [child(CHILD, "Render", NOW - 60_000)],
      parts: [part(CHILD, "Render", NOW - 60_000)],
      statuses: Object.fromEntries(ids.map((id) => [id, "busy" as ChildRunState])),
      below,
    }),
  )[0]
  // Unfold everything: one subagent per level, four levels.
  const all: string[] = []
  const walk = (rows: SubagentRow[] | undefined, depth: number) => {
    for (const nested of rows ?? []) {
      all.push(`${depth}`)
      walk(nested.under, depth + 1)
    }
  }
  walk(row.under, 1)
  assert.deepEqual(all, ["1", "2", "3", "4"])
  // Depth first, three lines can reach level three at most, which is the cap.
  const lines = nestedLines(row, NOW)
  assert.deepEqual(lines.map((line) => line.lead), [" ├ ", " │ └ ", " │   └ ", " └ "])
  assert.equal(lines[3].more, 1)
  assert.equal(NESTED_INDENT_CAP, NESTED_LINES_KEEP)
})

test("a cycle the host should never report still ends", () => {
  const below: Record<string, NestedSessionInput> = {
    [CHILD]: level({ children: [child(GRANDCHILD, "Loop", NOW - 1000, "a")] }),
    [GRANDCHILD]: level({ children: [child(CHILD, "Back", NOW - 1000, "a")] }),
  }
  const rows = deriveSubagentRows(
    sidebar({
      children: [child(CHILD, "Render", NOW - 60_000)],
      statuses: { [CHILD]: "busy", [GRANDCHILD]: "busy" },
      below,
    }),
  )
  assert.equal(rows.length, 1)
  assert.ok(nestedLines(rows[0], NOW).length <= NESTED_LINES_KEEP + 1)
})

// --- D: calm ---------------------------------------------------------------

test("at most three nested lines, then one +N more line that closes the tree", () => {
  const shells = [1, 2, 3, 4, 5].map((n) => runningShell(`sh_${n}`, `render part ${n}`, NOW - n * 60_000))
  const [row] = deriveSubagentRows(
    sidebar({
      children: [child(CHILD, "Render the promo", NOW - 10 * 60_000)],
      parts: [part(CHILD, "Render the promo", NOW - 10 * 60_000)],
      below: { [CHILD]: level({ shells }) },
    }),
  )
  const lines = nestedLines(row, NOW)
  assert.equal(lines.length, NESTED_LINES_KEEP + 1)
  assert.deepEqual(lines.map((line) => line.lead), [" ├ ", " ├ ", " ├ ", " └ "])
  // Oldest running first.
  assert.deepEqual(lines.slice(0, 3).map((line) => line.row?.description), ["render part 5", "render part 4", "render part 3"])
  assert.equal(lines[3].more, 2)
  assert.deepEqual(layoutNestedLine(lines[3]), [
    { text: " └ ", role: "muted" },
    { text: "+2 more", role: "muted" },
  ])
  // Four lines fit without a +N line only up to the cap itself.
  const [three] = deriveSubagentRows(
    sidebar({
      children: [child(CHILD, "Render the promo", NOW - 10 * 60_000)],
      parts: [part(CHILD, "Render the promo", NOW - 10 * 60_000)],
      below: { [CHILD]: level({ shells: shells.slice(0, 3) }) },
    }),
  )
  assert.equal(nestedLines(three, NOW).length, 3)
  assert.equal(nestedLines(three, NOW).at(-1)?.lead, " └ ")
})

test("a row running only for the work under it never counts toward the finished cap", () => {
  const finished = [1, 2, 3, 4].map((n) => child(`ses_done${n}`, `Done ${n}`, NOW - n * 60_000))
  const completions: CompletionInput[] = finished.flatMap((entry, index) =>
    completionsIn(report("completed", entry.id), NOW - (index + 1) * 1000),
  )
  const rows = deriveSubagentRows(
    sidebar({
      children: [...finished, child(CHILD, "Render the promo", NOW - 30 * 60_000)],
      parts: [...finished.map((entry) => part(entry.id, entry.title!.split(" (")[0], entry.created!)), part(CHILD, "Render the promo", NOW - 30 * 60_000)],
      completions: [...completions, ...completionsIn(report("completed"), NOW - 20 * 60_000)],
      below: { [CHILD]: level({ shells: [runningShell("sh_capture", "ffmpeg", NOW - 25 * 60_000)] }) },
    }),
  )
  assert.equal(rows.filter((row) => row.state === "running").length, 1)
  assert.equal(rows.filter((row) => row.state !== "running").length, FINISHED_KEEP)
  assert.equal(rows[0].sessionID, CHILD)
})

test("a nested line keeps its row's colours, mutes a finished one, and never overruns the row", () => {
  const start = NOW - 30 * 60_000
  const [row] = deriveSubagentRows(
    sidebar({
      children: [child(CHILD, "Render the promo", start)],
      parts: [part(CHILD, "Render the promo", start)],
      statuses: { [CHILD]: "busy", [GRANDCHILD]: "busy" },
      below: {
        [CHILD]: level({
          children: [child(GRANDCHILD, "A description long enough to need cutting short here", NOW - 5 * 60_000, "implementor")],
          parts: [part(GRANDCHILD, "A description long enough to need cutting short here", NOW - 5 * 60_000, "implementor")],
          shells: [
            runningShell("sh_capture", "ffmpeg -i capture.mov -c:v libx264 -preset slow out.mp4", NOW - 2 * 3_600_000),
            { id: "sh_tts", command: "say -o vo.aiff", status: "exited", exit: 130, started: NOW - 3_900_000, completed: NOW - 5000 },
          ],
        }),
        [GRANDCHILD]: level(),
      },
    }),
  )
  const lines = nestedLines(row, NOW)
  assert.equal(lines.length, 3)
  const [first, second, third] = lines.map((line) => layoutNestedLine(line, SIDEBAR_ROW_WIDTH, 0))
  // Running first, oldest first: the shell, then the subagent; then the finished shell.
  assert.equal(first[1].role, "spinner")
  assert.equal(first[3].text, "shell")
  assert.equal(first[3].role, "tool")
  assert.equal(first.at(-1)?.text, "2h00m bg")
  assert.equal(second[3].text, "implementor")
  assert.equal(second[3].role, "agent")
  assert.equal(second[5].role, "description")
  assert.equal(third[1].text, "✗")
  assert.equal(third[1].role, "error")
  assert.ok(third.slice(2).every((segment) => segment.role === "muted"), "a finished line is muted apart from its glyph")
  assert.equal(third.at(-1)?.text, "exit 130 · 1h04m bg")
  for (const segments of [first, second, third]) {
    const width = segments.reduce((sum, segment) => sum + Array.from(segment.text).length, 0)
    assert.ok(width <= SIDEBAR_ROW_WIDTH, `${width}: ${segments.map((s) => s.text).join("")}`)
  }
})

test("a dispatch a subagent made with no session yet is listed under it while it starts", () => {
  const [row] = deriveSubagentRows(
    sidebar({
      children: [child(CHILD, "Render", NOW - 60_000)],
      parts: [part(CHILD, "Render", NOW - 60_000)],
      below: {
        [CHILD]: level({
          parts: [{ status: "running", input: { agent: "writer", description: "Write it" }, start: NOW - 2000 }],
        }),
      },
    }),
  )
  assert.equal(row.state, "running")
  assert.equal(row.under?.[0].agent, "writer")
  assert.equal(row.under?.[0].sessionID, undefined)
})

test("a child still inside its starting grace with nothing under it is running but not waiting", () => {
  const start = NOW - STARTING_GRACE_MS / 2
  const [row] = deriveSubagentRows(
    sidebar({
      children: [child(CHILD, "Render", start)],
      parts: [part(CHILD, "Render", start)],
      below: { [CHILD]: level() },
    }),
  )
  assert.equal(row.state, "running")
  assert.equal("waiting" in row, false)
})

// --- opencode 2.4's job list ---------------------------------------------------

/** `JobInfo` as `@opencode/client` 2.4.0 types it. */
const shellJob = (owner: string, shellID: string, command: string, started: number): JobInput => ({
  kind: "shell",
  id: shellID,
  sessionID: owner,
  status: "running",
  title: command,
  time: { started },
  shellID,
  command,
})

test("shellsFromJobs takes every running shell job below the viewed session, and none of its own", () => {
  const jobs: JobInput[] = [
    shellJob(CHILD, "sh_capture", "ffmpeg -i capture.mov out.mp4", NOW - 60_000),
    shellJob(GRANDCHILD, "sh_tts", "say -o vo.aiff", NOW - 30_000),
    shellJob(PARENT, "sh_own", "npm run dev", NOW - 10_000),
    { ...shellJob(CHILD, "sh_old", "sleep 1", NOW - 90_000), status: "completed" },
    { kind: "codemode", id: "job_1", sessionID: CHILD, status: "running", time: { started: NOW } },
    { kind: "shell", sessionID: CHILD, status: "running" },
  ]
  assert.deepEqual(shellsFromJobs(jobs, PARENT), [
    { id: "sh_capture", sessionID: CHILD, command: "ffmpeg -i capture.mov out.mp4", status: "running", started: NOW - 60_000 },
    { id: "sh_tts", sessionID: GRANDCHILD, command: "say -o vo.aiff", status: "running", started: NOW - 30_000 },
  ])
})

test("childrenFromJobs names a subagent of a subagent under the session that dispatched it", () => {
  const jobs: JobInput[] = [
    {
      kind: "subagent",
      id: GRANDCHILD,
      sessionID: CHILD,
      status: "running",
      title: "Write the voice-over",
      time: { started: NOW - 5000 },
      childSessionID: GRANDCHILD,
      agent: "writer",
      description: "Write the voice-over",
    },
    { kind: "subagent", sessionID: CHILD, status: "running" },
    shellJob(CHILD, "sh_capture", "ffmpeg", NOW),
  ]
  assert.deepEqual(childrenFromJobs(jobs), [
    {
      parentID: CHILD,
      child: { id: GRANDCHILD, title: "Write the voice-over (@writer subagent)", agent: "writer", created: NOW - 5000 },
    },
  ])
})

test("a job shell leaves the memory as ended when the job list lets go of it, with the exit opencode reported", () => {
  const memory = createShellMemory()
  const scope = `job\u0000${PARENT}`
  const none = new Set<string>()
  memory.observe(scope, shellsFromJobs([shellJob(CHILD, "sh_capture", "ffmpeg", NOW - 60_000)], PARENT), none, NOW - 1000)
  assert.deepEqual(memory.forSession(CHILD, NOW - 1000).map((shell) => shell.status), ["running"])
  memory.exited("sh_capture", "exited", 0, NOW - 500)
  memory.observe(scope, [], none, NOW)
  const [ended] = memory.forSession(CHILD, NOW)
  assert.equal(ended.status, "exited")
  assert.equal(ended.exit, 0)
  // One with no exit seen reads `ended`.
  memory.observe(scope, shellsFromJobs([shellJob(CHILD, "sh_tts", "say", NOW - 30_000)], PARENT), none, NOW)
  memory.observe(scope, [], none, NOW + 1000)
  assert.equal(memory.forSession(CHILD, NOW + 1000).find((shell) => shell.id === "sh_tts")?.status, "ended")
})
