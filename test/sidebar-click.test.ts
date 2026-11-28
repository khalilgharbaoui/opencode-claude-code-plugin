/**
 * What a click on a sidebar row or nested line opens (h #g328): a subagent's
 * session, or a running shell's output in opencode 2.4's own view.
 *
 * The fake TUI below follows what was read out of the opencode 2.4.2 binary
 * and measured live: the Shell tab lists the running shells of the session on
 * screen in store order; `session.child.first` with `"shell"` opens it;
 * `composer.shell.down` wraps; `composer.shell.up` on the top row closes the
 * panel, which on a subagent's session opens its parent instead; the selected
 * row survives a close and a change of session, only pulled up to the last
 * row of a shorter list; and a subagent's session opens with its panel up on
 * the Subagents tab.
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  NEXT_SHELL,
  OPEN_SHELL_TAB,
  PREVIOUS_SHELL,
  VIEW_SHELL_OUTPUT,
  createShellViewOpener,
  type ShellViewHost,
} from "../src/sidebar-click.js"
import {
  clickTarget,
  deriveSubagentRows,
  nestedLines,
  shellTabIndex,
  type ChildRunState,
  type ChildSessionInput,
  type NestedSessionInput,
  type ObservedShell,
  type ShellInput,
  type SidebarInput,
  type SubagentRow,
  type TaskPartInput,
} from "../src/subagent-sidebar.js"

const NOW = 1_800_000_000_000
const ROOT = "ses_root28"
const NESTER = "ses_nester28"
const GENERAL = "ses_general28"

const child = (id: string, description: string, created: number, agent: string): ChildSessionInput => ({
  id,
  title: `${description} (@${agent} subagent)`,
  created,
})

const part = (id: string, description: string, start: number, agent: string): TaskPartInput => ({
  status: "completed",
  input: { agent, description, prompt: "x" },
  metadata: { sessionID: id, status: "running" },
  start,
  end: start + 20,
})

const running = (id: string, command: string, started: number): ShellInput => ({ id, command, status: "running", started })

const level = (overrides: Partial<NestedSessionInput> = {}): NestedSessionInput => ({
  children: [],
  parts: [],
  completions: [],
  shells: [],
  ...overrides,
})

function sidebar(
  overrides: Partial<SidebarInput> & { statuses?: Record<string, ChildRunState>; below?: Record<string, NestedSessionInput> } = {},
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
    sessionID: ROOT,
    ...(below ? { nested: (id: string) => below[id] } : {}),
    ...rest,
  }
}

/**
 * The scratch run's tree (h #g328): the root dispatched `nester`, which runs a
 * shell and dispatched `general`, which runs a shell of its own.
 */
function nestedTree(extra: Partial<SidebarInput> = {}): SubagentRow {
  const [row] = deriveSubagentRows(
    sidebar({
      children: [child(NESTER, "Nested parent", NOW - 60_000, "nester")],
      parts: [part(NESTER, "Nested parent", NOW - 60_000, "nester")],
      below: {
        [NESTER]: level({
          children: [child(GENERAL, "Nested child", NOW - 55_000, "general")],
          parts: [part(GENERAL, "Nested child", NOW - 55_000, "general")],
          shells: [running("sh_nester", "sleep 900; echo nester-done", NOW - 58_000)],
        }),
        [GENERAL]: level({ shells: [running("sh_general", "sleep 880; echo general-done", NOW - 50_000)] }),
      },
      ...extra,
    }),
  )
  return row
}

test("a top-level subagent row and a nested subagent line each open their own session", () => {
  const row = nestedTree()
  assert.deepEqual(clickTarget(row, ROOT), { kind: "session", sessionID: NESTER })
  const lines = nestedLines(row, NOW)
  const general = lines.find((line) => line.row?.agent === "general")
  assert.deepEqual(clickTarget(general?.row, ROOT), { kind: "session", sessionID: GENERAL })
})

test("a nested shell opens its output in the session that started it, at any depth", () => {
  const lines = nestedLines(nestedTree(), NOW)
  const shells = lines.filter((line) => line.row?.kind === "shell")
  assert.equal(shells.length, 2)
  assert.deepEqual(
    shells.map((line) => clickTarget(line.row, ROOT)),
    [
      { kind: "shell", sessionID: NESTER, shellID: "sh_nester" },
      { kind: "shell", sessionID: GENERAL, shellID: "sh_general" },
    ],
  )
})

test("a top-level shell row is the viewed session's own", () => {
  const rows = deriveSubagentRows(sidebar({ shells: [running("sh_build", "npm run build", NOW - 5_000)] }))
  assert.equal(rows[0].owner, ROOT)
  assert.equal(rows[0].shellID, "sh_build")
  assert.deepEqual(clickTarget(rows[0], ROOT), { kind: "shell", sessionID: ROOT, shellID: "sh_build" })
  // A host that never said which session it draws: the viewed one is still known at the click.
  const [anonymous] = deriveSubagentRows(sidebar({ sessionID: undefined, shells: [running("sh_build", "npm run build", NOW - 5_000)] }))
  assert.equal("owner" in anonymous, false)
  assert.deepEqual(clickTarget(anonymous, ROOT), { kind: "shell", sessionID: ROOT, shellID: "sh_build" })
  assert.equal(clickTarget(anonymous, undefined), undefined)
})

test("an ended shell has left opencode's store: its own session opens, or nothing when that is on screen", () => {
  const ended: ShellInput = { id: "sh_done", command: "make", status: "exited", exit: 0, started: NOW - 30_000, completed: NOW - 10_000 }
  const [row] = deriveSubagentRows(
    sidebar({
      children: [child(NESTER, "Nested parent", NOW - 60_000, "nester")],
      parts: [part(NESTER, "Nested parent", NOW - 60_000, "nester")],
      statuses: { [NESTER]: "busy" },
      below: { [NESTER]: level({ shells: [ended] }) },
    }),
  )
  const [line] = nestedLines(row, NOW)
  assert.equal(line.row?.state, "done")
  assert.deepEqual(clickTarget(line.row, ROOT), { kind: "session", sessionID: NESTER })
  const [own] = deriveSubagentRows(sidebar({ shells: [ended] }))
  assert.equal(clickTarget(own, ROOT), undefined)
})

test("a dispatch with no session yet and the `+N more` line open nothing", () => {
  const [pending] = deriveSubagentRows(
    sidebar({ parts: [{ status: "running", input: { agent: "general", description: "Not yet", prompt: "x" }, start: NOW }] }),
  )
  assert.equal(pending.sessionID, undefined)
  assert.equal(clickTarget(pending, ROOT), undefined)
  assert.equal(clickTarget(undefined, ROOT), undefined)
})

test("the tab index counts only that session's running shells, in store order", () => {
  const store: ObservedShell[] = [
    { id: "sh_a", sessionID: ROOT, command: "a", status: "running" },
    { id: "sh_other", sessionID: NESTER, command: "b", status: "running" },
    { id: "sh_old", sessionID: ROOT, command: "c", status: "exited" },
    { id: "sh_c", sessionID: ROOT, command: "d", status: "running" },
  ]
  assert.equal(shellTabIndex(store, ROOT, "sh_a"), 0)
  assert.equal(shellTabIndex(store, ROOT, "sh_c"), 1)
  assert.equal(shellTabIndex(store, ROOT, "sh_old"), -1)
  assert.equal(shellTabIndex(store, ROOT, "sh_other"), -1)
})

// ---------------------------------------------------------------------------
// The opener against a fake opencode 2.4.2 TUI
// ---------------------------------------------------------------------------

interface FakeOptions {
  route: string
  parents?: Record<string, string>
  shells: ObservedShell[]
  selected?: number
  /** The host has no `router.current()`. */
  blindRoute?: boolean
  /** The host has no `keymap.commands()`. */
  blindCommands?: boolean
  /** `keymap.dispatch` throws for these ids. */
  failing?: string[]
}

function fakeTui(options: FakeOptions) {
  const state = {
    route: options.route,
    open: false,
    tab: "subagents" as "subagents" | "shell",
    selected: options.selected ?? 0,
    output: undefined as string | undefined,
    routes: [options.route] as string[],
    dispatched: [] as string[],
  }
  const parents = options.parents ?? {}
  const listed = () => options.shells.filter((shell) => shell.sessionID === state.route && shell.status === "running")
  const clamp = () => {
    const length = listed().length
    if (state.selected >= length) state.selected = Math.max(0, length - 1)
  }
  const show = (sessionID: string) => {
    state.route = sessionID
    state.routes.push(sessionID)
    // A subagent's session opens with its panel up on the Subagents tab; a root's closed.
    state.open = parents[sessionID] !== undefined
    state.tab = "subagents"
    clamp()
  }
  const shellTabActive = () => state.open && state.tab === "shell"
  const queue: Array<() => void> = []
  let clock = NOW
  const host: ShellViewHost = {
    currentSession: () => (options.blindRoute ? undefined : state.route),
    navigate: (sessionID) => show(sessionID),
    reachable(id) {
      if (options.blindCommands) return true
      if (id === OPEN_SHELL_TAB) return true
      return shellTabActive()
    },
    dispatch(id, input) {
      state.dispatched.push(input ? `${id}:${input}` : id)
      if (options.failing?.includes(id)) throw new Error("refused")
      if (id === OPEN_SHELL_TAB && input === "shell") {
        state.open = true
        state.tab = "shell"
        clamp()
      } else if (!shellTabActive()) {
        return
      } else if (id === NEXT_SHELL) {
        const length = listed().length
        if (length > 0) state.selected = (state.selected + 1) % length
      } else if (id === PREVIOUS_SHELL) {
        if (state.selected > 0) state.selected--
        else if (parents[state.route]) show(parents[state.route])
        else state.open = false
      } else if (id === VIEW_SHELL_OUTPUT) {
        state.output = listed()[state.selected]?.id
      }
    },
    shells: () => options.shells,
    now: () => clock,
    later(run, ms) {
      clock += Math.max(ms, 1)
      queue.push(run)
    },
  }
  const drain = async <T>(pending: Promise<T>): Promise<T> => {
    for (let turn = 0; turn < 10_000 && queue.length > 0; turn++) queue.shift()!()
    return pending
  }
  return { state, host, drain }
}

const shellOf = (id: string, sessionID: string, command = id): ObservedShell => ({ id, sessionID, command, status: "running" })

test("a nested shell: the subagent's session opens on its Shell tab and the shell's output opens", async () => {
  const tui = fakeTui({ route: ROOT, parents: { [NESTER]: ROOT }, shells: [shellOf("sh_nester", NESTER)] })
  const open = createShellViewOpener(tui.host)
  assert.equal(await tui.drain(open({ sessionID: NESTER, shellID: "sh_nester" })), "output")
  assert.equal(tui.state.route, NESTER)
  assert.equal(tui.state.output, "sh_nester")
})

test("the measured bug: a selection left on another row still opens the clicked shell's output", async () => {
  const shells = [shellOf("sh_first", ROOT), shellOf("sh_second", ROOT), shellOf("sh_third", ROOT)]
  // The second row was opened last time, and the tab kept it.
  const tui = fakeTui({ route: ROOT, shells, selected: 1 })
  const open = createShellViewOpener(tui.host)
  assert.equal(await tui.drain(open({ sessionID: ROOT, shellID: "sh_third" })), "output")
  assert.equal(tui.state.output, "sh_third")
  assert.equal(tui.state.route, ROOT)
  for (const start of [0, 1, 2]) {
    for (const [index, shell] of shells.entries()) {
      const again = fakeTui({ route: ROOT, shells, selected: start })
      assert.equal(await again.drain(createShellViewOpener(again.host)({ sessionID: ROOT, shellID: shell.id })), "output")
      assert.equal(again.state.output, shell.id, `row ${index} from a selection on row ${start}`)
    }
  }
})

test("the walk to the top row runs on the session on screen, never on the subagent's, so its parent never opens", async () => {
  const shells = [
    shellOf("sh_root_a", ROOT),
    shellOf("sh_root_b", ROOT),
    shellOf("sh_child_a", GENERAL),
    shellOf("sh_child_b", GENERAL),
    shellOf("sh_child_c", GENERAL),
  ]
  const tui = fakeTui({ route: ROOT, parents: { [GENERAL]: NESTER, [NESTER]: ROOT }, shells, selected: 1 })
  assert.equal(await tui.drain(createShellViewOpener(tui.host)({ sessionID: GENERAL, shellID: "sh_child_c" })), "output")
  assert.equal(tui.state.output, "sh_child_c")
  assert.deepEqual(tui.state.routes, [ROOT, GENERAL], "opened the subagent once, and nothing else")
})

test("with nothing listed on screen the selection is already on the top row, so no walk is needed", async () => {
  const shells = [shellOf("sh_g1", GENERAL), shellOf("sh_g2", GENERAL)]
  const tui = fakeTui({ route: ROOT, parents: { [GENERAL]: ROOT }, shells })
  assert.equal(await tui.drain(createShellViewOpener(tui.host)({ sessionID: GENERAL, shellID: "sh_g2" })), "output")
  assert.equal(tui.state.output, "sh_g2")
  assert.equal(tui.state.dispatched.includes(PREVIOUS_SHELL), false)
})

test("a host that cannot say which session is on screen gets the Shell tab, never a guessed shell's output", async () => {
  const shells = [shellOf("sh_g1", GENERAL), shellOf("sh_g2", GENERAL)]
  const tui = fakeTui({ route: ROOT, parents: { [GENERAL]: ROOT }, shells, selected: 1, blindRoute: true })
  assert.equal(await tui.drain(createShellViewOpener(tui.host)({ sessionID: GENERAL, shellID: "sh_g1" })), "tab")
  assert.equal(tui.state.route, GENERAL)
  assert.equal(tui.state.output, undefined)
  assert.equal(tui.state.tab, "shell")
  // One shell listed is its only row, so that one is still opened.
  const single = fakeTui({ route: ROOT, parents: { [GENERAL]: ROOT }, shells: [shellOf("sh_g1", GENERAL)], blindRoute: true })
  assert.equal(await single.drain(createShellViewOpener(single.host)({ sessionID: GENERAL, shellID: "sh_g1" })), "output")
  assert.equal(single.state.output, "sh_g1")
})

test("a host that cannot list reachable commands never opens a guessed shell either", async () => {
  const shells = [shellOf("sh_a", ROOT), shellOf("sh_b", ROOT)]
  const tui = fakeTui({ route: ROOT, shells, selected: 1, blindCommands: true })
  const result = await tui.drain(createShellViewOpener(tui.host)({ sessionID: ROOT, shellID: "sh_a" }))
  assert.equal(result, "tab")
  assert.equal(tui.state.output, undefined)
})

test("a shell the store does not hold yet leaves the Shell tab up when the wait runs out", async () => {
  const tui = fakeTui({ route: ROOT, parents: { [NESTER]: ROOT }, shells: [shellOf("sh_other", NESTER)] })
  const result = await tui.drain(createShellViewOpener(tui.host, { waitMs: 200 })({ sessionID: NESTER, shellID: "sh_missing" }))
  assert.equal(result, "tab")
  assert.equal(tui.state.route, NESTER)
  assert.equal(tui.state.output, undefined)
})

test("a newer click ends an earlier one still waiting", async () => {
  const tui = fakeTui({ route: ROOT, parents: { [NESTER]: ROOT, [GENERAL]: NESTER }, shells: [shellOf("sh_n", NESTER), shellOf("sh_g", GENERAL)] })
  const open = createShellViewOpener(tui.host)
  const first = open({ sessionID: NESTER, shellID: "sh_n" })
  const second = open({ sessionID: GENERAL, shellID: "sh_g" })
  assert.equal(await tui.drain(first), "superseded")
  assert.equal(await second, "output")
  assert.equal(tui.state.output, "sh_g")
})

test("a refused command never throws out of the click", async () => {
  const tui = fakeTui({ route: ROOT, parents: { [NESTER]: ROOT }, shells: [shellOf("sh_n", NESTER)], failing: [OPEN_SHELL_TAB] })
  const result = await tui.drain(createShellViewOpener(tui.host, { waitMs: 200 })({ sessionID: NESTER, shellID: "sh_n" }))
  assert.equal(result, "tab")
  assert.equal(tui.state.route, NESTER, "the subagent's session is still open")
  const throwing: ShellViewHost = {
    currentSession: () => {
      throw new Error("x")
    },
    navigate: () => {
      throw new Error("x")
    },
    reachable: () => {
      throw new Error("x")
    },
    dispatch: () => {
      throw new Error("x")
    },
    shells: () => {
      throw new Error("x")
    },
    now: () => {
      throw new Error("x")
    },
    later: () => {
      throw new Error("x")
    },
  }
  assert.equal(await createShellViewOpener(throwing)({ sessionID: NESTER, shellID: "sh_n" }), "session")
})
