import type { RuntimeMcpStatus } from "./mcp-bridge.js"
import { log } from "./logger.js"

/**
 * Captured opencode runtime context (SDK client + project directory) from
 * `PluginInput`. Lives in its own module to break the cycle that would
 * otherwise form between `index.ts` and `claude-code-language-model.ts`.
 * Values are `null`/`undefined` until the plugin's `server` factory runs
 * (e.g. early provider lookups, direct AI-SDK use, tests).
 */
type OpencodeClient = {
  mcp?: {
    status?: () => Promise<{ data?: unknown; error?: unknown }>
  }
  tool?: {
    list?: (options: {
      query: { provider: string; model: string; directory?: string }
    }) => Promise<{ data?: unknown; error?: unknown }>
  }
  session?: {
    /** `GET /session/{id}` — the returned Session carries `directory`. */
    get?: (options: {
      path: { id: string }
      query?: { directory?: string }
    }) => Promise<{ data?: unknown; error?: unknown }>
    /** `GET /session/status`: sessions missing from the map are idle. */
    status?: () => Promise<{ data?: unknown; error?: unknown }>
  }
}

let opencodeClient: OpencodeClient | null = null

export function setOpencodeClient(client: unknown): void {
  if (client && typeof client === "object") {
    opencodeClient = client as OpencodeClient
  }
}

/**
 * The captured SDK client, untyped: callers narrow to the surface they use
 * (this module's `OpencodeClient` only mirrors the MCP/tool routes).
 */
export function getOpencodeClient(): unknown {
  return opencodeClient
}

/**
 * Captured opencode project directory from `PluginInput.directory` (with
 * `worktree` as secondary signal). Used as a *fallback* at Claude CLI
 * spawn time only when `process.cwd()` is unusable (macOS GUI launches
 * where launchd hands the process `cwd=/`).
 *
 * IMPORTANT: never bake this into provider config (`mergedOptions.cwd`).
 * Doing so freezes the value at plugin init and breaks workspace
 * switching mid-session, because subsequent workspace changes in
 * opencode's UI never get reflected in `this.config.cwd`. See issue #4.
 */
let opencodeProjectDirectory: string | undefined

export function setOpencodeProjectDirectory(dir: string | undefined): void {
  opencodeProjectDirectory = dir
}

export function getOpencodeProjectDirectory(): string | undefined {
  return opencodeProjectDirectory
}

export function isUsableDirectory(d: unknown): d is string {
  return typeof d === "string" && d.length > 1 && d !== "/"
}

/**
 * Resolve the cwd for a Claude CLI subprocess spawn. Priority:
 *
 * 1. Explicit `configured` value (`options.cwd` from `opencode.json`).
 *    Users who pinned a directory keep their override unconditionally.
 * 2. The opencode session's own `directory` (resolved per-call from the
 *    `x-session-affinity` id via the SDK). Authoritative for
 *    `opencode serve` / web-UI mode, where one long-lived server process
 *    handles many projects and `process.cwd()` is the server's launch
 *    dir — not the session's project. Equals `process.cwd()` in the TUI,
 *    so it does not regress that path.
 * 3. Live `process.cwd()` when it's a real directory. Lazy resolution
 *    that lets opencode's project-aware behavior (chdir on workspace
 *    switch, project-per-shell on terminal launch) flow through.
 * 4. Captured project directory from plugin init. Rescues macOS GUI
 *    launches where `process.cwd()` is `/`.
 * 5. Final fallback to `process.cwd()` (returns `/` in the pathological
 *    case where neither override nor capture is available).
 */
export function resolveSpawnCwd(configured: string | undefined): string {
  return resolveSpawnCwdFrom(
    configured,
    process.cwd(),
    opencodeProjectDirectory,
  )
}

export function resolveSpawnCwdFrom(
  configured: string | undefined,
  live: string,
  captured: string | undefined,
  sessionDir?: string,
): string {
  if (configured) return configured
  if (isUsableDirectory(sessionDir)) return sessionDir
  if (isUsableDirectory(live)) return live
  return captured ?? live
}

/**
 * Resolve the spawn cwd for a specific opencode session. Looks up the
 * session's `directory` via the SDK (keyed by the `x-session-affinity`
 * id opencode sets on LLM calls) and feeds it into `resolveSpawnCwdFrom`
 * as tier 2. Falls back cleanly to the non-session resolution when the
 * id is absent ("default"), no SDK client is captured, or the lookup
 * fails — so the TUI / direct-AI-SDK / test paths are unaffected.
 */
export async function resolveSpawnCwdForSession(
  configured: string | undefined,
  sessionID: string | undefined,
): Promise<string> {
  // An explicit pin wins unconditionally — skip the lookup entirely.
  if (configured) return configured
  const sessionDir = sessionID
    ? await fetchSessionDirectory(sessionID)
    : undefined
  return resolveSpawnCwdFrom(
    configured,
    process.cwd(),
    opencodeProjectDirectory,
    sessionDir,
  )
}

/**
 * Fetch an opencode session's project directory via `GET /session/{id}`.
 * Returns `undefined` on any failure (no client, "default"/empty id,
 * rejected call, malformed response, unusable directory) so callers fall
 * back to `process.cwd()`-based resolution. No caching: a session's
 * directory can change (workspace switch) and the call is a cheap
 * localhost round-trip relative to spawning Claude.
 */
export async function fetchSessionDirectory(
  sessionID: string,
): Promise<string | undefined> {
  if (!sessionID || sessionID === "default") return undefined
  const client = opencodeClient
  if (!client?.session?.get) return undefined
  try {
    const res = await client.session.get({ path: { id: sessionID } })
    const data = (res as { data?: unknown }).data
    if (!data || typeof data !== "object") return undefined
    const dir = (data as { directory?: unknown }).directory
    return isUsableDirectory(dir) ? dir : undefined
  } catch (err) {
    log.warn("failed to fetch opencode session directory", {
      sessionID,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

/**
 * The id of the session that spawned this one, or undefined when it is a
 * top-level session (or the lookup is unavailable). Read off the same
 * `GET /session/{id}` response `fetchSessionDirectory` uses, kept separate
 * because the two are needed at different points in a turn.
 *
 * Account failover is the only caller: a subagent must never be shown the
 * switch form. It follows its parent's account for free, because the override
 * is scoped to the account rather than the session.
 */
export async function fetchSessionParentId(
  sessionID: string,
): Promise<string | undefined> {
  if (!sessionID || sessionID === "default") return undefined
  const client = opencodeClient
  if (!client?.session?.get) return undefined
  try {
    const res = await client.session.get({ path: { id: sessionID } })
    const data = (res as { data?: unknown }).data
    if (!data || typeof data !== "object") return undefined
    const parentID = (data as { parentID?: unknown }).parentID
    return typeof parentID === "string" && parentID.length > 0
      ? parentID
      : undefined
  } catch (err) {
    log.warn("failed to fetch opencode session parent", {
      sessionID,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

export type SessionRunState = "busy" | "idle" | "unknown"

/**
 * Whether opencode still considers this session to be running a turn.
 * `unknown` when there is no client or the route is missing, which every
 * caller must treat as "do not act": a wrong guess here is worse than no
 * answer.
 */
export async function fetchSessionRunState(
  sessionID: string,
): Promise<SessionRunState> {
  if (!sessionID || sessionID === "default") return "unknown"
  const status = opencodeClient?.session?.status
  if (!status) return "unknown"
  try {
    const res = await status.call(opencodeClient!.session)
    const data = (res as { data?: unknown }).data
    if (!data || typeof data !== "object") return "unknown"
    const entry = (data as Record<string, unknown>)[sessionID]
    if (!entry || typeof entry !== "object") return "idle"
    const type = (entry as { type?: unknown }).type
    return type === "idle" ? "idle" : "busy"
  } catch (err) {
    log.debug("failed to read opencode session status", {
      sessionID,
      error: err instanceof Error ? err.message : String(err),
    })
    return "unknown"
  }
}

/**
 * The session's run state, given a moment to settle. opencode 1.18.32 aborts
 * the provider signal of every step that ends in tool calls, roughly a second
 * after the finish, while it runs the tool; that looks exactly like an
 * operator abort at the signal. The session stays busy through the tool run
 * and goes idle when the turn really stops, so one `busy` reading inside the
 * window is enough to tell them apart, and the poll exists because an abort
 * can arrive before opencode has updated the map.
 */
export async function settleSessionRunState(
  sessionID: string,
  options: { pollMs?: number; windowMs?: number } = {},
): Promise<SessionRunState> {
  const pollMs = options.pollMs ?? 150
  const windowMs = options.windowMs ?? 1_500
  const started = Date.now()
  let last: SessionRunState = "unknown"
  for (;;) {
    const state = await fetchSessionRunState(sessionID)
    if (state === "busy") return "busy"
    if (state !== "unknown") last = state
    if (Date.now() - started >= windowMs) return last
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/**
 * Snapshot opencode's current MCP runtime status so the bridge can overlay
 * UI-toggled state on top of disk config. Returns `undefined` on any
 * failure (no client captured, status call rejected, malformed response)
 * so the bridge falls back to disk-only.
 */
export async function getRuntimeMcpStatus(): Promise<
  RuntimeMcpStatus | undefined
> {
  const client = opencodeClient
  if (!client?.mcp?.status) return undefined
  try {
    const res = await client.mcp.status()
    const data = (res as { data?: unknown }).data
    if (!data || typeof data !== "object") return undefined
    const out: RuntimeMcpStatus = {}
    for (const [name, entry] of Object.entries(data as Record<string, unknown>)) {
      if (entry && typeof entry === "object") {
        const status = (entry as { status?: unknown }).status
        if (typeof status === "string") out[name] = status
      }
    }
    return out
  } catch (err) {
    log.warn("failed to fetch opencode MCP runtime status", {
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

export interface OpencodeToolListItem {
  id: string
  description: string
  parameters: Record<string, unknown>
}

/**
 * Fetch opencode's full tool catalog (built-ins + MCP-bridged) with JSON
 * Schema parameters via `client.tool.list()`. The provider/model query
 * narrows the schema variants opencode returns; in practice MCP-origin
 * tool schemas are model-agnostic, so any registered (provider, model)
 * works as the query target. Returns `undefined` on any failure so callers
 * can fall back to direct-bridge behavior.
 */
export async function fetchOpencodeToolList(
  provider: string,
  model: string,
  directory?: string,
): Promise<OpencodeToolListItem[] | undefined> {
  const client = opencodeClient
  if (!client?.tool?.list) return undefined
  try {
    const res = await client.tool.list({
      query: { provider, model, ...(directory ? { directory } : {}) },
    })
    const data = (res as { data?: unknown }).data
    if (!Array.isArray(data)) return undefined
    const out: OpencodeToolListItem[] = []
    for (const entry of data as unknown[]) {
      if (!entry || typeof entry !== "object") continue
      const e = entry as Record<string, unknown>
      const id = typeof e.id === "string" ? e.id : null
      const description =
        typeof e.description === "string" ? e.description : ""
      const parameters =
        e.parameters && typeof e.parameters === "object"
          ? (e.parameters as Record<string, unknown>)
          : {}
      if (!id) continue
      out.push({ id, description, parameters })
    }
    return out
  } catch (err) {
    log.warn("failed to fetch opencode tool list", {
      provider,
      model,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}
