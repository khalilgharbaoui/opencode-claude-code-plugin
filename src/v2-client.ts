import path from "node:path"

/**
 * A V1-shaped opencode client over opencode 2's plugin context.
 *
 * Several features ask opencode's SDK client for live state at call time: the
 * MCP runtime overlay (`mcp.status`), the tool registry (`tool.list`, which
 * gates the `question`-based features and feeds the `task` description
 * overlay), a session's directory and parent (`session.get`, for serve-mode
 * cwd and for keeping account failover out of subagents), and a background
 * subagent's transcript and abort (`session.messages` / `session.abort`, for
 * `task_status` and `task_cancel`). Every call site already degrades when
 * there is no client, which is exactly what V2 looked like before this: those
 * features quietly switched off.
 *
 * Rather than teach each call site a second API, this answers the same calls
 * in V1's response shapes (`{ data }` envelopes, V1 field names) from V2's
 * domains. Shapes read off `@opencode/client@2.0.16` `generated/types.d.ts`
 * and the `SessionDomain` the plugin API actually hands a plugin
 * (`@opencode/plugin@2.0.16` `dist/promise/session.d.ts`), which is a `Pick`
 * of the HTTP client: `create`, `get`, `switchAgent`, `switchModel`, `prompt`,
 * `generate`, `command`, `synthetic`, `interrupt`, `update`, `move`, `wait`,
 * `context`. Anything V2 cannot answer is left out, so its caller takes its
 * existing no-client path. `session.status` is one of those: V2's
 * all-sessions run-state map is `session.active`, which that `Pick` does not
 * include, so `fetchSessionRunState` stays `unknown` on V2 and its callers
 * fall back (`isBackgroundTaskRunning` reads the transcript instead).
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
    /**
     * `GET /api/session/:sessionID/context`, V2's nearest thing to V1's
     * `GET /session/{id}/message`: "the active context messages for a session
     * (all messages after the last compaction)". Returns the array itself, not
     * a `{ data }` envelope.
     */
    context?: (input: { sessionID: string }) => Promise<unknown>
    /** `POST /api/session/:sessionID/interrupt`, V2's session abort. */
    interrupt?: (input: { sessionID: string }) => Promise<unknown>
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

/**
 * V2's session messages in V1's `{ info, parts }` shape, for
 * `fetchSessionReplies`.
 *
 * V2 has no `role`: the message kind is the discriminator (`SessionMessageInfo`
 * is a union over `type`), and "assistant" and "user" are two of its members,
 * so the type doubles as the role and every other kind simply never matches an
 * assistant lookup. An assistant's text lives in `content` entries of
 * `type: "text"` rather than in `parts`; the other kinds carry a plain `text`
 * string. Errors are `{ type, message }` where V1 had `{ name, data.message }`.
 *
 * V1's synthetic-part filter needs no counterpart: V2 makes a synthetic
 * message its own kind (`type: "synthetic"`), which is not an assistant reply.
 */
export function toV1Messages(messages: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(messages)) return []
  return messages.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const message = entry as {
      type?: unknown
      time?: unknown
      text?: unknown
      error?: { type?: unknown; message?: unknown }
      content?: unknown
    }
    const parts = Array.isArray(message.content)
      ? (message.content as unknown[]).flatMap((part) => {
          if (!part || typeof part !== "object") return []
          const piece = part as { type?: unknown; text?: unknown }
          return piece.type === "text" && typeof piece.text === "string"
            ? [{ type: "text", text: piece.text }]
            : []
        })
      : typeof message.text === "string"
        ? [{ type: "text", text: message.text }]
        : []
    const error = message.error
    const info: Record<string, unknown> = {
      role: typeof message.type === "string" ? message.type : "",
      time: message.time && typeof message.time === "object" ? message.time : {},
      ...(error && typeof error === "object"
        ? {
            error: {
              name: typeof error.type === "string" ? error.type : "error",
              data: { message: typeof error.message === "string" ? error.message : undefined },
            },
          }
        : {}),
    }
    return [{ info, parts }]
  })
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
  const sessionContext = ctx.session?.context
  const sessionInterrupt = ctx.session?.interrupt
  const session: Record<string, unknown> = {}
  if (typeof sessionGet === "function") {
    session.get = async (options: { path: { id: string } }) => ({
      data: toV1Session(await sessionGet.call(ctx.session, { sessionID: options.path.id })),
    })
  }
  if (typeof sessionContext === "function") {
    // V1: `{ data: [{ info, parts }] }`. V2 returns the messages themselves,
    // flat, with `type` where V1 had `role` and `content` where it had `parts`.
    session.messages = async (options: { path: { id: string } }) => ({
      data: toV1Messages(await sessionContext.call(ctx.session, { sessionID: options.path.id })),
    })
  }
  if (typeof sessionInterrupt === "function") {
    // V1's abort answers `200: boolean`; V2's interrupt answers
    // `{ interrupted: boolean }`. Both say whether anything was stopped, so
    // the boolean travels in V1's slot and a refused cancel stays refused.
    session.abort = async (options: { path: { id: string } }) => {
      const result = await sessionInterrupt.call(ctx.session, { sessionID: options.path.id })
      const interrupted = (result as { interrupted?: unknown } | undefined)?.interrupted
      return { data: typeof interrupted === "boolean" ? interrupted : true }
    }
  }
  if (Object.keys(session).length > 0) client.session = session

  return client
}
