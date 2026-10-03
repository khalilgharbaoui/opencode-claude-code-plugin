import { type LogLevel, type LogSink, type LogSinkEntry, setLogSink } from "./logger.js"

/**
 * The `LogSink` that keeps plugin WARN/ERROR lines off a full-screen TUI's
 * screen without making them invisible.
 *
 * opencode 1.18.34 runs a plugin inside the TUI's own worker thread, where
 * stderr is the terminal the TUI is drawing on, so `console.error` paints raw
 * text over the interface and it stays there until a redraw. Measured live: two
 * skill-bridge WARNs and a proxy deadline WARN covered a session's input box.
 *
 * Both of the routes used here are opencode's documented plugin channels:
 *
 * - `client.app.log` (`POST /log`) is the plugin logging channel. Every line
 *   that would have hit stderr goes there, so `DEBUG=opencode-claude-code`
 *   still shows everything, just in opencode's log rather than on the screen.
 * - `client.tui.showToast` (`POST /tui/show-toast`) is how a plugin reaches the
 *   operator. Only warn and error toast, and only once per message text per
 *   process: some WARNs repeat on every spawn (the skill-bridge name clash is
 *   the measured one) and a toast per turn would be its own noise.
 *
 * Nothing here may throw into the caller and nothing here may log. A failed
 * `app.log` or `showToast` is swallowed: the line is already in the plugin's
 * own log file when file logging is on, and a logging channel that reports its
 * own failures through itself is a loop.
 */

type SdkResult = Promise<unknown> | undefined

/** opencode's `/log` body. Read off `@opencode-ai/sdk@1.18.34` `AppLogData`. */
interface AppLogBody {
  service: string
  level: "debug" | "info" | "warn" | "error"
  message: string
  extra?: Record<string, unknown>
}

/** opencode's `/tui/show-toast` body, same source (`TuiShowToastData`). */
interface ShowToastBody {
  title?: string
  message: string
  variant: "info" | "success" | "warning" | "error"
  duration?: number
}

export interface LogSinkClient {
  app?: {
    log?: (options: { body: AppLogBody }) => SdkResult
  }
  tui?: {
    showToast?: (options: { body: ShowToastBody }) => SdkResult
  }
}

/** The `service` every line is filed under in opencode's log. */
export const LOG_SERVICE_NAME = "opencode-claude-code"

/** What a toast is titled, so the operator knows who is talking. */
export const TOAST_TITLE = "claude-code"

/** How long a warn/error toast stays up. Long enough to read a sentence. */
export const TOAST_DURATION_MS = 10_000

/**
 * A toast is one line in a corner, not a log viewer. The full text (and its
 * `data`) is in opencode's log and in the plugin log file; this is the part
 * that has to fit on screen.
 */
export const MAX_TOAST_CHARS = 240

/**
 * opencode's `/log` level enum has no `notice`, so that is the one level that
 * has to be mapped rather than passed through. It sits below `warn` and above
 * `info`, and the plugin's NOTICE lines (the ready block, the preset override
 * notes) are informational, so `info` is the honest home for them.
 */
const APP_LOG_LEVEL: Record<LogLevel, AppLogBody["level"]> = {
  debug: "debug",
  info: "info",
  notice: "info",
  warn: "warn",
  error: "error",
}

export function toastMessage(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim()
  if (flat.length <= MAX_TOAST_CHARS) return flat
  return `${flat.slice(0, MAX_TOAST_CHARS - 1)}…`
}

export function appLogBody(entry: LogSinkEntry): AppLogBody {
  return {
    service: LOG_SERVICE_NAME,
    level: APP_LOG_LEVEL[entry.level],
    message: entry.message,
    ...(entry.data && Object.keys(entry.data).length > 0 ? { extra: entry.data } : {}),
  }
}

export function toastBody(entry: LogSinkEntry): ShowToastBody {
  return {
    title: TOAST_TITLE,
    message: toastMessage(entry.message),
    variant: entry.level === "error" ? "error" : "warning",
    duration: TOAST_DURATION_MS,
  }
}

/** Swallow everything: a rejection here must not become an unhandled one. */
function fireAndForget(call: () => SdkResult): void {
  try {
    const result = call()
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      void (result as Promise<unknown>).catch(() => undefined)
    }
  } catch {
    // intentionally silent: see the module comment
  }
}

/**
 * A sink over opencode's SDK client, or `null` when the client can answer
 * neither route. Returning `null` matters: it leaves the logger buffering for a
 * client that can, rather than registering a sink that drops every line.
 *
 * The calls keep their receiver (`client.app.log(...)`, not a detached
 * reference): the generated SDK methods are class members that use `this`.
 */
export function createOpencodeLogSink(client: unknown): LogSink | null {
  if (!client || typeof client !== "object") return null
  const sdk = client as LogSinkClient
  const canLog = typeof sdk.app?.log === "function"
  const canToast = typeof sdk.tui?.showToast === "function"
  if (!canLog && !canToast) return null
  return {
    log(entry) {
      if (!canLog) return
      fireAndForget(() => sdk.app!.log!({ body: appLogBody(entry) }))
    },
    toast(entry) {
      if (!canToast) return
      fireAndForget(() => sdk.tui!.showToast!({ body: toastBody(entry) }))
    },
  }
}

/**
 * Point the logger at opencode's own channels. Called from the plugin entry as
 * soon as the SDK client is captured, so the buffered startup lines flush
 * immediately. Answers whether a sink was installed.
 */
export function registerOpencodeLogSink(client: unknown): boolean {
  const sink = createOpencodeLogSink(client)
  if (!sink) return false
  setLogSink(sink)
  return true
}
