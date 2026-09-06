export type ModelID = string
export type ProviderID = string

export type OpenCodeModel = {
  id: ModelID
  providerID: ProviderID
  api: {
    id: string
    url: string
    npm: string
  }
  name: string
  family?: string
  capabilities: {
    temperature: boolean
    reasoning: boolean
    attachment: boolean
    toolcall: boolean
    input: {
      text: boolean
      audio: boolean
      image: boolean
      video: boolean
      pdf: boolean
    }
    output: {
      text: boolean
      audio: boolean
      image: boolean
      video: boolean
      pdf: boolean
    }
    // opencode widened this between 1.18.5 and 1.18.18: `reasoning_details`
    // became `reasoning_text`, and bare strings are now accepted. This is a
    // hand-written mirror of opencode's schema, so it drifts silently:
    // re-check it when auditing a new opencode version. Audited clean at
    // 1.18.29 on 2026-09-07. Note the type below is deliberately a BLEND of
    // two upstream schemas (v1 config for `release_date` and the flat
    // provider entry, v2 runtime for nested `capabilities`/`interleaved`),
    // so do not "correct" it by copying either one wholesale. See AGENTS.md.
    interleaved:
      | boolean
      | string
      | { field: "reasoning" | "reasoning_content" | "reasoning_text" | string }
  }
  cost: {
    input: number
    output: number
    cache: {
      read: number
      write: number
    }
  }
  limit: {
    context: number
    input?: number
    output: number
  }
  status: "alpha" | "beta" | "deprecated" | "active"
  options: Record<string, unknown>
  headers: Record<string, string>
  release_date: string
  variants?: Record<string, Record<string, unknown>>
}

export type OpenCodeProvider = {
  id: ProviderID
  name?: string
  source?: string
  options?: Record<string, unknown>
  models: Record<string, OpenCodeModel>
}

export type OpenCodeConfig = {
  command?: Record<string, {
    template: string
    description?: string
    agent?: string
    model?: string
    variant?: string
    subtask?: boolean
  }>
  provider?: Record<
    string,
    {
      name?: string
      npm?: string
      env?: string[]
      options?: Record<string, unknown>
      models?: Record<string, unknown>
    }
  >
  // Agent definitions. Kept loose (opencode adds agent fields over time) and
  // only ever added to: `expandAccountAgents` never overwrites an entry the
  // user defined.
  agent?: Record<string, Record<string, unknown>>
  // Extra skill roots opencode scans for `**/SKILL.md` (absolute or `~/`
  // paths). The plugin adds its bundled skills directory here.
  skills?: { paths?: string[]; urls?: string[] }
}

/**
 * Bus events surface to plugins. Shape mirrors what opencode core publishes
 * via `GlobalBus.emit("event", { directory, payload: { type, properties } })`
 * but kept loose since opencode adds events over time and this plugin only
 * reacts to a small subset (currently just `global.disposed`).
 */
export type OpenCodeEvent = {
  type?: string
  payload?: { type?: string; properties?: Record<string, unknown> }
  [key: string]: unknown
}

/**
 * Input shape for the `chat.params` hook. opencode passes the agent name
 * for the current call ("default", "compaction", "title", etc.), the
 * resolved model, and the user message. Output is the mutable params bag
 * the hook can adjust before opencode forwards them to the LM.
 *
 * The plugin injects `input.agent` as `opencodeAgent` and `input.sessionID`
 * as `opencodeSessionID` into `output.options` so the language model can
 * read them from `providerOptions[providerID]` on every LLM request.
 * `opencodeSessionID` serves as a fallback affinity token when the
 * `x-session-affinity` request header is absent (provider switch
 * mid-session, title synthesis paths, older opencode versions).
 */
export type OpenCodeChatParamsInput = {
  sessionID?: string
  agent?: string
  model?: OpenCodeModel & { providerID: ProviderID }
  // Matches opencode SDK ProviderContext: { source, info, options }.
  // The provider id lives at provider.info.id, not provider.id.
  provider?: { source?: string; info?: { id?: ProviderID }; options?: Record<string, unknown> }
  message?: unknown
}

export type OpenCodeChatParamsOutput = {
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  options?: Record<string, unknown>
}

export type OpenCodeHooks = {
  config?: (input: OpenCodeConfig) => Promise<void>
  provider?: {
    id: string
    models?: (provider: OpenCodeProvider) => Promise<Record<string, OpenCodeModel>>
  }
  // Called for every bus event opencode publishes. Optional; this plugin
  // doesn't currently subscribe — MCP config drift is handled at turn start.
  event?: (input: { event: OpenCodeEvent }) => Promise<void>
  "chat.params"?: (
    input: OpenCodeChatParamsInput,
    output: OpenCodeChatParamsOutput,
  ) => Promise<void>
  // Fires as soon as a slash command is submitted, even while the session is
  // busy; the resulting prompt is what gets queued, not the hook. Throwing
  // drops that prompt (opencode answers the command route with a 500 the
  // TUI ignores). Used for /btw.
  "command.execute.before"?: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: unknown[] },
  ) => Promise<void>
}

export type OpenCodePlugin = (input: unknown, options?: Record<string, unknown>) => Promise<OpenCodeHooks>
