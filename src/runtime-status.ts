import type { RuntimeMcpStatus } from "./mcp-bridge.js"
import { log } from "./logger.js"

/**
 * Captured opencode SDK client from `PluginInput`. Lives in its own module
 * to break the cycle that would otherwise form between `index.ts` and
 * `claude-code-language-model.ts`. `null` until the plugin's `server`
 * factory runs (e.g. early provider lookups, direct AI-SDK use, tests).
 */
let opencodeClient:
  | { mcp?: { status?: () => Promise<{ data?: unknown; error?: unknown }> } }
  | null = null

export function setOpencodeClient(client: unknown): void {
  if (client && typeof client === "object") {
    opencodeClient = client as typeof opencodeClient
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
