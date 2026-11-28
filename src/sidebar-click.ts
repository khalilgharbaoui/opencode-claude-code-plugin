/**
 * What a click on a running shell in the sidebar does on opencode 2.4
 * (h #g328): it opens opencode's OWN view of that shell's output, the dialog
 * opencode shows from the Shell tab of a session's composer panel.
 *
 * Read out of the opencode 2.4.2 binary, and each one shapes a step below:
 *
 *   - The view is reachable only through the Shell tab, which lists the
 *     running shells of the session on screen, in the store's order
 *     (`data.shell.listBySession`). So the session that started the shell is
 *     opened first, unless it is the one on screen.
 *   - `session.child.first` with the input `"shell"` opens the composer panel
 *     on that tab; `composer.shell.down` moves the selection one row down
 *     (wrapping), `composer.shell.select` opens the selected shell's output,
 *     and `composer.shell.up` moves it one row up, or on the top row closes
 *     the panel. All four are keymap commands a plugin can run with
 *     `keymap.dispatch`, and `keymap.commands()` says which are reachable.
 *   - The tab keeps its selected row when the panel closes and when another
 *     session is opened (the session view, and the tab with it, stays
 *     mounted; a shorter list only pulls the row up to its last one). Measured:
 *     stepping down from the top opened the wrong shell's output the second
 *     time. Nothing tells a plugin which row is selected, but `up` on the top
 *     row closes the panel, which `keymap.commands()` shows. So the opener
 *     first walks the selection to the top on the session on screen, then
 *     opens the target's tab and steps down from there.
 *   - Closing the panel of a subagent's session opens its parent instead, so
 *     that walk is done before the target is opened, never on the target. The
 *     sidebar is drawn on the session a click comes from.
 *   - Opening a session syncs it and redraws the session view, and the panel's
 *     commands exist only once it is drawn, so each step waits until the
 *     command it runs is reachable, for at most `SHELL_VIEW_WAIT_MS`.
 *
 * Pure apart from the host it is handed, and it never throws: a step the host
 * refuses leaves the screen where the last step put it (the session, or its
 * Shell tab, which lists the shell), and it never opens a shell's output
 * unless it knows the selected row is the clicked shell.
 */
import { shellTabIndex, type ObservedShell } from "./subagent-sidebar.js"

/** How long a click keeps trying to reach the shell's output. */
export const SHELL_VIEW_WAIT_MS = 2_000
/** How often it looks again while it waits. */
export const SHELL_VIEW_POLL_MS = 25

export const OPEN_SHELL_TAB = "session.child.first"
export const NEXT_SHELL = "composer.shell.down"
export const PREVIOUS_SHELL = "composer.shell.up"
export const VIEW_SHELL_OUTPUT = "composer.shell.select"

/** What the opener needs from opencode's TUI. */
export interface ShellViewHost {
  /** The session on screen, `""` for another page, undefined when the host cannot say. */
  currentSession(): string | undefined
  navigate(sessionID: string): void
  /** Whether a keymap command can run now; true when the host cannot say. */
  reachable(id: string): boolean
  dispatch(id: string, input?: string): void
  /** The shells opencode's store holds for that session, in its order. */
  shells(sessionID: string): readonly ObservedShell[]
  now(): number
  later(run: () => void, ms: number): void
}

/**
 * How far a click got: the shell's output, the target's Shell tab (the shell
 * listed, the selection unknown), the session that started it, or nowhere
 * because a newer click took over.
 */
export type ShellViewResult = "output" | "tab" | "session" | "superseded"

export interface ShellViewOptions {
  waitMs?: number
  pollMs?: number
}

type Phase = "reset" | "walk" | "target" | "tab"

/** How many shells of that session the Shell tab lists. */
function runningCount(shells: readonly ObservedShell[], sessionID: string): number {
  return shells.filter((shell) => shell.sessionID === sessionID && shell.status === "running").length
}

/**
 * One opener per sidebar: a click starts a new attempt and ends any earlier
 * one still waiting, so two quick clicks never both drive the panel.
 */
export function createShellViewOpener(host: ShellViewHost, options: ShellViewOptions = {}) {
  const waitMs = options.waitMs ?? SHELL_VIEW_WAIT_MS
  const pollMs = options.pollMs ?? SHELL_VIEW_POLL_MS
  let generation = 0
  const guard = <T>(run: () => T, fallback: T): T => {
    try {
      return run()
    } catch {
      return fallback
    }
  }
  const reachable = (id: string) => guard(() => host.reachable(id), false)
  const dispatch = (id: string, input?: string) => guard(() => host.dispatch(id, input), undefined)
  const current = () => guard(() => host.currentSession(), undefined)
  const shells = (sessionID: string) => guard(() => host.shells(sessionID), [] as readonly ObservedShell[])

  return function open(target: { sessionID: string; shellID: string }): Promise<ShellViewResult> {
    const mine = ++generation
    return new Promise((resolve) => {
      const deadline = guard(() => host.now(), 0) + waitMs
      let phase: Phase = "reset"
      // Whether the Shell tab's selection is known to be on its top row.
      let atTop = false
      let walked = 0
      let walkLimit = 0
      let opened = false
      let navigated = false
      let reached: ShellViewResult = "session"
      const onTarget = () => {
        const shown = current()
        return shown === undefined || shown === target.sessionID
      }
      const again = (ms: number) => {
        if (!guard(() => (host.later(tick, ms), true), false)) resolve(reached)
      }
      function tick() {
        if (mine !== generation) return resolve("superseded")
        if (guard(() => host.now(), deadline) > deadline) return resolve(reached)
        if (phase === "reset") {
          const shown = current()
          // A host that cannot say which session is on screen cannot be walked.
          if (shown === undefined || shown === "") {
            phase = "target"
            return again(0)
          }
          walkLimit = runningCount(shells(shown), shown)
          // An empty list pulls the selection up to the top row by itself.
          if (walkLimit === 0) {
            atTop = true
            phase = "target"
            return again(0)
          }
          if (!reachable(OPEN_SHELL_TAB)) return again(pollMs)
          dispatch(OPEN_SHELL_TAB, "shell")
          phase = "walk"
          return again(pollMs)
        }
        if (phase === "walk") {
          const open = reachable(VIEW_SHELL_OUTPUT)
          if (!opened) {
            if (!open) return again(pollMs)
            opened = true
          } else if (!open) {
            // `up` on the top row closed the panel: the selection is on the top row.
            atTop = true
            phase = "target"
            return again(0)
          }
          // One more than the rows above the selection can be: then give up on knowing it.
          if (walked > walkLimit) {
            phase = "target"
            return again(0)
          }
          dispatch(PREVIOUS_SHELL)
          walked++
          return again(pollMs)
        }
        if (phase === "target") {
          // Opened once: always when another session is on screen, and when the
          // host cannot say which is, because opening the one on screen is harmless.
          if (!navigated && current() !== target.sessionID) {
            navigated = true
            guard(() => host.navigate(target.sessionID), undefined)
            return again(pollMs)
          }
          if (!onTarget()) return again(pollMs)
          if (!reachable(OPEN_SHELL_TAB)) return again(pollMs)
          dispatch(OPEN_SHELL_TAB, "shell")
          reached = "tab"
          phase = "tab"
          return again(pollMs)
        }
        // Somewhere else by now (the operator moved on): leave it there.
        if (!onTarget()) return resolve(reached)
        const listed = shells(target.sessionID)
        const index = shellTabIndex(listed, target.sessionID, target.shellID)
        if (index < 0 || !reachable(VIEW_SHELL_OUTPUT)) return again(pollMs)
        // With one shell listed its row is the only one; otherwise only a
        // selection walked to the top says where the clicked shell is.
        if (!atTop && runningCount(listed, target.sessionID) > 1) return resolve(reached)
        for (let step = 0; step < index; step++) dispatch(NEXT_SHELL)
        dispatch(VIEW_SHELL_OUTPUT)
        resolve("output")
      }
      again(0)
    })
  }
}
