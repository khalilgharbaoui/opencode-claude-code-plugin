import { log } from "./logger.js"

/**
 * One turn's view of its own abort signal.
 *
 * `addEventListener("abort")` on a signal that has ALREADY aborted never
 * fires, and `doStreamForHost` awaits a whole prologue before the
 * `ReadableStream` its abort handler lives in even exists: the spawn cwd, the
 * account-failover resolution, opencode's tool registry, a session lookup,
 * the CLI version probe and (since 0.34.0) the up-to-3-second wait for an
 * opencode 2 MCP server still reported `pending`. A stop that landed in that
 * window was therefore observed by nobody, and the turn went on to spawn a
 * `claude`, write the envelope and bill the answer. See (h #g182).
 *
 * The watch is created before the prologue's first await and is the only thing
 * that listens to the signal, so from then on an abort is a FACT the turn can
 * read at any point (`aborted`), wait on (`whenAborted`) or subscribe to
 * (`onAbort`, which runs immediately when the signal already aborted) rather
 * than an event it has to have been listening for.
 */
export interface TurnAbortWatch {
  /** True from the instant the signal aborted, whether or not anyone listened. */
  readonly aborted: boolean
  /** The signal's own reason, for the log line. */
  readonly reason: unknown
  /**
   * Resolves on abort and never rejects, so a long prologue await can race it
   * and stop waiting. The work it raced keeps running: the CLI version probe's
   * answer is cached process-wide and one turn's stop must not poison it
   * (h #g181).
   */
  readonly whenAborted: Promise<void>
  /** Run `fn` on abort, or at once when the signal has already aborted. */
  onAbort(fn: () => void): void
  /** Drop the signal listener. Idempotent, and a no-op once the abort fired. */
  dispose(): void
}

export function watchTurnAbort(signal: AbortSignal | undefined): TurnAbortWatch {
  let aborted = signal?.aborted === true
  // Null means "no longer collecting": either the abort fired and every
  // listener has run, or the watch was disposed.
  let listeners: Array<() => void> | null = []
  let settle!: () => void
  const whenAborted = new Promise<void>((resolve) => {
    settle = resolve
  })

  const fire = () => {
    if (aborted && listeners === null) return
    aborted = true
    const pending = listeners ?? []
    listeners = null
    settle()
    for (const fn of pending) {
      try {
        fn()
      } catch (error) {
        // A throwing listener must not take the abort path down with it: the
        // turn is being stopped and the rest of the teardown still has to run.
        log.warn("turn abort listener threw", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  const onSignalAbort = () => fire()
  if (aborted) {
    // Already aborted when this turn started, so nothing will ever fire.
    listeners = null
    settle()
  } else {
    signal?.addEventListener("abort", onSignalAbort, { once: true })
  }

  return {
    get aborted() {
      return aborted
    },
    get reason() {
      return signal?.reason
    },
    whenAborted,
    onAbort(fn: () => void) {
      if (aborted) {
        fn()
        return
      }
      listeners?.push(fn)
    },
    dispose() {
      listeners = null
      signal?.removeEventListener("abort", onSignalAbort)
    },
  }
}
