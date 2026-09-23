import path from "node:path"

/**
 * A V1-shaped opencode client over opencode 2's plugin context.
 *
 * Several features ask opencode's SDK client for live state at call time: the
 * MCP runtime overlay (`mcp.status`), the tool registry (`tool.list`, which
 * gates the `question`-based features and feeds the `task` description
 * overlay), and a session's directory and parent (`session.get`, for serve-mode
 * cwd and for keeping account failover out of subagents). Every call site
 * already degrades when there is no client, which is exactly what V2 looked
 * like before this: those features quietly switched off.
 *
 * Rather than teach each call site a second API, this answers the same calls
 * in V1's response shapes (`{ data }` envelopes, V1 field names) from V2's
 * domains. Shapes read off `@opencode/client@2.0.11` `generated/types.d.ts`.
 * Anything V2 cannot answer is left out, so its caller takes its existing
 * no-client path.
 */

export interface V2ClientContext {
  readonly mcp?: {
    list?: () => Promise<{ data?: Array<{ name?: unknown; status?: { status?: unknown } }> }>
  }
  readonly tool?: {
    list?: () => Promise<ReadonlyArray<{ id?: unknown; name?: unknown; description?: unknown }>>
  }
  readonly session?: {
    get?: (input: { sessionID: string }) => Promise<unknown>
  }
  readonly agent?: {
    list?: () => Promise<{
      data?: Array<{ id?: unknown; name?: unknown; description?: unknown; mode?: unknown; hidden?: unknown }>
    }>
  }
}

/**
 * The agent list V1 carries inside its `task` description and the `task`
 * proxy overlay extracts (`extractAgentTypeList`). V2's `subagent`
 * description has no such list (measured on 2.0.11: 596 characters, no agent
 * names), which left Claude guessing names, the exact failure AGENTS.md
 * records for V1. Built from `agent.list()`: agents a subagent call may use.
 */
export function formatAgentTypeList(
  agents: ReadonlyArray<{ id?: unknown; name?: unknown; description?: unknown; mode?: unknown; hidden?: unknown }>,
): string | undefined {
  const lines = agents.flatMap((agent) => {
    if (agent.hidden === true || agent.mode === "primary") return []
    const name = typeof agent.id === "string" ? agent.id : agent.name
    if (typeof name !== "string" || name.length === 0) return []
    const blurb = typeof agent.description === "string" ? agent.description.trim() : ""
    return [`- ${name}: ${blurb || "(no description)"}`]
  })
  if (lines.length === 0) return undefined
  return `Available agent types and the tools they have access to:\n${lines.join("\n")}`
}

function describe(value: unknown): string {
  if (typeof value === "string") return value
  // V2 tools may carry `description` as a thunk. Only a plain string result
  // is usable; anything else (an Effect, a throw) is treated as empty.
  if (typeof value === "function") {
    try {
      const result = (value as () => unknown)()
      return typeof result === "string" ? result : ""
    } catch {
      return ""
    }
  }
  return ""
}

/** V2's `SessionInfo` in V1's `Session` terms: `directory` and `parentID`. */
export function toV1Session(info: unknown): Record<string, unknown> | undefined {
  if (!info || typeof info !== "object") return undefined
  const session = info as {
    parentID?: unknown
    subpath?: unknown
    location?: { directory?: unknown }
  }
  const root = session.location?.directory
  const directory =
    typeof root === "string"
      ? typeof session.subpath === "string" && session.subpath.length > 0
        ? path.resolve(root, session.subpath)
        : root
      : undefined
  return { ...(info as Record<string, unknown>), directory, parentID: session.parentID }
}

export function createV1ClientShim(ctx: V2ClientContext): Record<string, unknown> {
  const client: Record<string, unknown> = {}

  const mcpList = ctx.mcp?.list
  if (typeof mcpList === "function") {
    client.mcp = {
      // V1: `{ data: { [server]: { status } } }`. V2: `{ data: [{ name, status: { status } }] }`.
      status: async () => {
        const result = await mcpList.call(ctx.mcp)
        const data: Record<string, { status: string }> = {}
        for (const server of result?.data ?? []) {
          const status = server?.status?.status
          if (typeof server?.name === "string" && typeof status === "string") {
            data[server.name] = { status }
          }
        }
        return { data }
      },
    }
  }

  const toolList = ctx.tool?.list
  if (typeof toolList === "function") {
    client.tool = {
      // V1: `{ data: [{ id, description, parameters }] }`. V2 returns the tools
      // themselves, with an Effect schema for input rather than JSON Schema, so
      // `parameters` is empty; only `proxyOpencodeTools` reads it.
      list: async () => {
        const tools = await toolList.call(ctx.tool)
        const data = (tools ?? []).flatMap((tool) => {
          const id = typeof tool?.id === "string" ? tool.id : tool?.name
          return typeof id === "string"
            ? [{ id, description: describe(tool.description), parameters: {} }]
            : []
        })
        // The `task` proxy looks its live description up by V1's id; V2 calls
        // the same tool `subagent`, and its description names no agents.
        const subagent = data.find((tool) => tool.id === "subagent")
        if (subagent && !data.some((tool) => tool.id === "task")) {
          let agentList: string | undefined
          const agentApi = ctx.agent?.list
          if (typeof agentApi === "function") {
            try {
              agentList = formatAgentTypeList((await agentApi.call(ctx.agent))?.data ?? [])
            } catch {
              agentList = undefined
            }
          }
          const description = agentList
            ? `${subagent.description}\n\n${agentList}`
            : subagent.description
          data.push({ ...subagent, id: "task", description })
        }
        return { data }
      },
    }
  }

  const sessionGet = ctx.session?.get
  if (typeof sessionGet === "function") {
    client.session = {
      get: async (options: { path: { id: string } }) => ({
        data: toV1Session(await sessionGet.call(ctx.session, { sessionID: options.path.id })),
      }),
    }
  }

  return client
}
