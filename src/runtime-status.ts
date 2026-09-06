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
 * 2. Live `process.cwd()` when it's a real directory. Restores the lazy
 *    resolution that lets opencode's project-aware behavior (chdir on
 *    workspace switch, project-per-shell on terminal launch) flow
 *    through without restarting the plugin.
 * 3. Captured project directory from plugin init. Rescues macOS GUI
 *    launches where `process.cwd()` is `/`.
 * 4. Final fallback to `process.cwd()` (returns `/` in the pathological
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
): string {
  if (configured) return configured
  if (isUsableDirectory(live)) return live
  return captured ?? live
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
