/**
 * Background shells in the sidebar's `Subagents` section (h #g307): which of a
 * session's shells become rows, how a row reads while the shell runs and after
 * it ends, and what the memory keeps once opencode's store lets go of one.
 *
 * The inputs are shaped like opencode 2.2.6's TUI store: `ShellInfo` with
 * `metadata.sessionID` (and `background: true` on a `!command`), a running
 * `shell` tool part carrying the same command while a call is in the
 * foreground, and `shell.exited` with the exit code just before the store
 * drops a tool shell.
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { test } from "node:test"

import { formatElapsed as formatElapsedFromProgress } from "../src/progress-line.js"
import {
  FINISHED_TTL_MS,
  SHELL_MEMORY_CAP,
  collapsedSummary,
  createShellMemory,
  deriveSubagentRows,
  formatElapsed,
  layoutRow,
  type ObservedShell,
  type ShellInput,
  type SidebarInput,
} from "../src/subagent-sidebar.js"

const NOW = 1_800_000_000_000
const SESSION = "ses_parent"
const SCOPE = `/repo\u0000${SESSION}`
const BUILD = "while kill -0 74655 2>/dev/null; do sleep 20; done"

const none = new Set<string>()

function shell(overrides: Partial<ObservedShell> = {}): ObservedShell {
  return {
    id: "sh_build",
    sessionID: SESSION,
    command: BUILD,
    status: "running",
    started: NOW - 12 * 60_000,
    ...overrides,
  }
}

function rows(shells: ShellInput[], now = NOW, extra: Partial<SidebarInput> = {}) {
  return deriveSubagentRows({
    children: [],
    parts: [],
    completions: [],
    shells,
    status: () => "unknown",
    record: () => undefined,
    stoppedAt: () => undefined,
    now,
    ...extra,
  })
}

test("a shell running with no running tool part for its command is a background row", () => {
  const memory = createShellMemory()
  memory.observe(SCOPE, [shell()], none, NOW)
  const [row, ...rest] = rows(memory.forSession(SESSION, NOW))
  assert.equal(rest.length, 0)
  assert.equal(row.kind, "shell")
  assert.equal(row.agent, "shell")
  assert.equal(row.description, BUILD)
  assert.equal(row.state, "running")
  assert.equal(row.background, true)
  assert.equal(row.sessionID, undefined, "a shell row is not a session to open")
  assert.equal(row.label, "12m00s")
})

test("a foreground shell call is never a row, not while it runs and not after it ends", () => {
  const memory = createShellMemory()
  const foreground = new Set([BUILD])
  memory.observe(SCOPE, [shell()], foreground, NOW)
  assert.deepEqual(memory.forSession(SESSION, NOW), [])
  memory.exited("sh_build", "exited", 0, NOW + 1_000)
  memory.observe(SCOPE, [], none, NOW + 2_000)
  assert.deepEqual(memory.forSession(SESSION, NOW + 2_000), [])
})

test("a foreground call moved to the background becomes a row once its tool part has completed", () => {
  const memory = createShellMemory()
  memory.observe(SCOPE, [shell()], new Set([BUILD]), NOW)
  assert.equal(memory.forSession(SESSION, NOW).length, 0)
  // The part answered `moved to the background`; the shell runs on.
  memory.observe(SCOPE, [shell()], none, NOW + 1_000)
  const listed = memory.forSession(SESSION, NOW + 1_000)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].status, "running")
  assert.equal(listed[0].started, NOW - 12 * 60_000, "the shell's own start, not when it was first seen")
})

test("a !command (no tool part, background: true) is a row at once", () => {
  const memory = createShellMemory()
  memory.observe(SCOPE, [shell({ id: "sh_bang", command: "npm run build" })], none, NOW)
  assert.equal(rows(memory.forSession(SESSION, NOW))[0].description, "npm run build")
})

test("shell.exited says how it ended, and the row keeps that after the store drops the shell", () => {
  const memory = createShellMemory()
  memory.observe(SCOPE, [shell()], none, NOW)
  memory.exited("sh_build", "exited", 0, NOW + 60_000)
  memory.observe(SCOPE, [], none, NOW + 61_000)
  const [row] = rows(memory.forSession(SESSION, NOW + 61_000), NOW + 61_000)
  assert.equal(row.state, "done")
  assert.equal(row.label, "exit 0 · 13m00s")
  assert.equal(row.finished, NOW + 60_000)
})

test("a non-zero exit, a timeout and a kill are each a ✗ with their own word", () => {
  for (const [status, exit, word] of [
    ["exited", 2, "exit 2"],
    ["timeout", undefined, "timed out"],
    ["killed", undefined, "killed"],
  ] as const) {
    const memory = createShellMemory()
    memory.observe(SCOPE, [shell()], none, NOW)
    memory.exited("sh_build", status, exit, NOW + 5_000)
    const [row] = rows(memory.forSession(SESSION, NOW + 5_000), NOW + 5_000)
    assert.equal(row.state, "error", status)
    assert.ok(row.label.startsWith(`${word} · `), `${status}: ${row.label}`)
  }
})

test("an exit the store still holds is read off the store when no event was seen", () => {
  const memory = createShellMemory()
  memory.observe(SCOPE, [shell()], none, NOW)
  memory.observe(SCOPE, [shell({ status: "exited", exit: 1, completed: NOW + 3_000 })], none, NOW + 4_000)
  const [row] = rows(memory.forSession(SESSION, NOW + 4_000), NOW + 4_000)
  assert.equal(row.state, "error")
  assert.equal(row.label, "exit 1 · 12m03s")
})

test("a shell gone from the store with no exit seen has ended: a ✓ saying ended, dated when it was missed", () => {
  const memory = createShellMemory()
  memory.observe(SCOPE, [shell()], none, NOW)
  memory.observe(SCOPE, [], none, NOW + 30_000)
  const [row] = rows(memory.forSession(SESSION, NOW + 30_000), NOW + 30_000)
  assert.equal(row.state, "done")
  assert.equal(row.label, "ended · 12m30s")
})

test("a finished shell row goes after the finished-row lifetime, like a subagent's", () => {
  const memory = createShellMemory()
  memory.observe(SCOPE, [shell()], none, NOW)
  memory.exited("sh_build", "exited", 0, NOW)
  memory.observe(SCOPE, [], none, NOW)
  assert.equal(rows(memory.forSession(SESSION, NOW + FINISHED_TTL_MS), NOW + FINISHED_TTL_MS).length, 1)
  assert.equal(memory.forSession(SESSION, NOW + FINISHED_TTL_MS + 1).length, 0)
})

test("one session's view never ends another session's shell, and lists only its own", () => {
  const memory = createShellMemory()
  memory.observe(SCOPE, [shell()], none, NOW)
  const other = `/repo\u0000ses_other`
  memory.observe(other, [shell({ id: "sh_other", sessionID: "ses_other", command: "sleep 600" })], none, NOW)
  memory.observe(other, [], none, NOW + 1_000)
  const mine = memory.forSession(SESSION, NOW + 1_000)
  assert.equal(mine.length, 1)
  assert.equal(mine[0].status, "running")
  assert.deepEqual(memory.forSession("ses_other", NOW + 1_000).map((entry) => entry.status), ["ended"])
})

test("a shell with no owner or no command is ignored, and an exit for a shell never seen changes nothing", () => {
  const memory = createShellMemory()
  memory.observe(SCOPE, [shell({ sessionID: undefined }), shell({ id: "sh_blank", command: "  " })], none, NOW)
  memory.exited("sh_unknown", "exited", 0, NOW)
  assert.deepEqual(memory.forSession(SESSION, NOW), [])
})

test("the memory keeps at most its cap, dropping finished shells before running ones", () => {
  const memory = createShellMemory()
  const running = Array.from({ length: SHELL_MEMORY_CAP }, (_, index) =>
    shell({ id: `sh_run_${index}`, command: `job ${index}` }),
  )
  memory.observe(SCOPE, running, none, NOW)
  memory.observe(`${SCOPE}-b`, [shell({ id: "sh_done", status: "exited", exit: 0, completed: NOW })], none, NOW)
  const listed = memory.forSession(SESSION, NOW)
  assert.equal(listed.length, SHELL_MEMORY_CAP)
  assert.ok(listed.every((entry) => entry.status === "running"))
})

test("shell rows sort with subagent rows: running by start, then finished newest first", () => {
  const memory = createShellMemory()
  memory.observe(SCOPE, [shell({ started: NOW - 5_000 })], none, NOW)
  const derived = rows(memory.forSession(SESSION, NOW), NOW, {
    children: [{ id: "ses_child", title: "Fix it (@implementor subagent)", created: NOW - 60_000 }],
    status: () => "busy",
  })
  assert.deepEqual(derived.map((row) => row.agent), ["implementor", "shell"])
  assert.equal(collapsedSummary(derived), "2 running")
})

test("layoutRow draws a running shell's name in the running tool's colour, with the bg marker and its elapsed", () => {
  const memory = createShellMemory()
  memory.observe(SCOPE, [shell()], none, NOW)
  const layout = layoutRow(rows(memory.forSession(SESSION, NOW))[0], 36, 0)
  assert.equal(layout.first[2].text, "shell")
  assert.equal(layout.first[2].role, "tool")
  assert.equal(layout.first.at(-1)?.text, "bg")
  assert.equal(layout.first.map((segment) => segment.text).join("").length, 36)
  assert.deepEqual(
    layout.second.map((segment) => [segment.text, segment.role]),
    [[" ", "muted"], ["12m00s", "muted"]],
  )
})

test("layoutRow mutes a finished shell's name and keeps its outcome on the second line", () => {
  const memory = createShellMemory()
  memory.observe(SCOPE, [shell()], none, NOW)
  memory.exited("sh_build", "exited", 0, NOW)
  const layout = layoutRow(rows(memory.forSession(SESSION, NOW))[0], 36, 0)
  assert.equal(layout.first[0].text, "✓")
  assert.equal(layout.first[2].role, "muted")
  assert.equal(layout.second.map((segment) => segment.text).join(""), " exit 0 · 12m00s")
})

test("formatElapsed lives with the rows now and is still exported from the progress line", () => {
  assert.equal(formatElapsedFromProgress, formatElapsed)
  assert.equal(formatElapsed(63_000), "1m03s")
})
