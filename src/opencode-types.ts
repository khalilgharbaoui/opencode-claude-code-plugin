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
    interleaved: boolean | { field: "reasoning_content" | "reasoning_details" }
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

export type OpenCodeHooks = {
  config?: (input: OpenCodeConfig) => Promise<void>
  provider?: {
    id: string
    models?: (provider: OpenCodeProvider) => Promise<Record<string, OpenCodeModel>>
  }
  // Called for every bus event opencode publishes. Optional; this plugin
  // doesn't currently subscribe — MCP config drift is handled at turn start.
  event?: (input: { event: OpenCodeEvent }) => Promise<void>
}

export type OpenCodePlugin = (input: unknown, options?: Record<string, unknown>) => Promise<OpenCodeHooks>
