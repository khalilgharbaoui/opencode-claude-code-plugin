/**
 * The plugin's warnings, carried from its server half to its own sidebar half
 * on opencode 2, so they reach the screen there the way opencode 1's TUI shows
 * them as toasts (`src/tui-log-sink.ts`).
 *
 * opencode 2 runs a plugin's server half in a `serve --stdio` subprocess whose
 * stderr is a pipe nothing displays (measured on 2.0.22, h #g193), and its
 * plugin context has no toast route. What it does have is a channel between
 * the two halves of one plugin: the server half registers an RPC definition on
 * `ctx.rpc`, and every `events.emit` it makes travels on opencode's event bus
 * as `rpc.<id>.<event>`, where the sidebar half's `data.listen` sees it and
 * `ui.toast.show` can raise it. Measured on 2.0.31 (h #g253): every emit
 * reached the sidebar half and every toast rendered.
 *
 * Scoped to one opencode instance by construction, which a shared file under
 * `$XDG_STATE_HOME` would not be: every open opencode window would then toast
 * every other window's warnings.
 *
 * opencode 2 runs the server half's `setup` once per location, all in one
 * process (measured: the project directory and the home directory, both in
 * the TUI), so a warning is emitted on every live registration and the sidebar
 * half drops the copies by id.
 *
 * Imports nothing, and never throws or logs: the TUI bundle reads it.
 */

/** The RPC definition's id; events arrive as `rpc.<id>.<event>`. */
export const NOTICE_RPC_ID = "opencode-claude-code-plugin"

/** The one event the definition declares. */
export const NOTICE_EVENT = "notice"

/** The bus event type the sidebar half listens for. */
export const NOTICE_EVENT_TYPE = `rpc.${NOTICE_RPC_ID}.${NOTICE_EVENT}`

/**
 * Plain JSON Schema, which opencode's `Rpc.PortableDefinition` accepts beside
 * a Standard Schema: no schema library is needed at runtime.
 */
export const NOTICE_RPC_DEFINITION = {
  id: NOTICE_RPC_ID,
  methods: {},
  events: {
    [NOTICE_EVENT]: {
      schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          level: { type: "string", enum: ["warn", "error", "success"] },
          message: { type: "string" },
        },
        required: ["id", "level", "message"],
        additionalProperties: false,
      },
    },
  },
} as const

/** What one notice carries: a message only, never the log line's `data`. */
export interface PluginNotice {
  id: string
  /** `success` is not a log level: it answers an action the operator took (`/connect`, h #g277). */
  level: PluginNoticeLevel
  message: string
}

export type PluginNoticeLevel = "warn" | "error" | "success"

/** What a toast is titled, so the operator knows who is talking. */
export const TOAST_TITLE = "claude-code"

/** How long a warn/error toast stays up. Long enough to read a sentence. */
export const TOAST_DURATION_MS = 10_000

/**
 * A toast is one line in a corner, not a log viewer. The full text (and its
 * `data`) is in the plugin log file; this is the part that has to fit on
 * screen.
 */
export const MAX_TOAST_CHARS = 240

export function toastMessage(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim()
  if (flat.length <= MAX_TOAST_CHARS) return flat
  return `${flat.slice(0, MAX_TOAST_CHARS - 1)}…`
}

/** The notice for one warn/error line. `id` must be unique across processes. */
export function pluginNotice(id: string, level: PluginNoticeLevel, message: string): PluginNotice {
  return { id, level, message: toastMessage(message) }
}

/** A bus event's notice, or undefined for anything that is not exactly one. */
export function readPluginNotice(type: unknown, data: unknown): PluginNotice | undefined {
  if (type !== NOTICE_EVENT_TYPE) return undefined
  if (!data || typeof data !== "object") return undefined
  const { id, level, message } = data as Record<string, unknown>
  if (typeof id !== "string" || id.length === 0) return undefined
  if (level !== "warn" && level !== "error" && level !== "success") return undefined
  if (typeof message !== "string" || message.trim().length === 0) return undefined
  return { id, level, message: toastMessage(message) }
}

/** How many notice ids the sidebar half remembers to drop copies by. */
export const MAX_SEEN_NOTICES = 256

/**
 * The sidebar half's side: hands each notice to `show` once, however many
 * registrations emitted it. Never throws, whatever `show` does.
 */
export function createNoticeToaster(show: (notice: PluginNotice) => void): (type: unknown, data: unknown) => boolean {
  const seen = new Set<string>()
  return (type, data) => {
    const notice = readPluginNotice(type, data)
    if (!notice || seen.has(notice.id)) return false
    seen.add(notice.id)
    if (seen.size > MAX_SEEN_NOTICES) {
      const oldest = seen.values().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
    try {
      show(notice)
      return true
    } catch {
      return false
    }
  }
}
