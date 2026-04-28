import type { LanguageModelV3 } from "@ai-sdk/provider"
import { ClaudeCodeLanguageModel } from "./claude-code-language-model.js"
import { defaultModels, toConfigModel } from "./models.js"
import type { OpenCodeModel, OpenCodePlugin, OpenCodeProvider } from "./opencode-types.js"
import type { ClaudeCodeProviderSettings } from "./types.js"
import {
  BASE_PROVIDER_ID,
  accountDisplayName,
  accountModelSuffix,
  accountProviderId,
  ensureAccountRuntime,
  resolveAccounts,
} from "./accounts.js"
import { evictAllSessions } from "./session-manager.js"
import { log } from "./logger.js"
import { setOpencodeClient } from "./runtime-status.js"

export interface ClaudeCodeProvider {
  specificationVersion: "v3"
  (modelId: string): LanguageModelV3
  languageModel(modelId: string): LanguageModelV3
}

export function createClaudeCode(
  settings: ClaudeCodeProviderSettings = {},
): ClaudeCodeProvider {
  const cliPath =
    settings.cliPath ?? process.env.CLAUDE_CLI_PATH ?? "claude"
  const providerName = settings.providerID ?? settings.name ?? "claude-code"
  const proxyTools = settings.proxyTools ?? ["Bash", "Edit", "Write", "WebFetch"]

  const createModel = (modelId: string): LanguageModelV3 => {
    return new ClaudeCodeLanguageModel(modelId, {
      provider: providerName,
      cliPath,
      cwd: settings.cwd,
      account: settings.account,
      configDir: settings.configDir,
      providerID: settings.providerID,
      skipPermissions: settings.skipPermissions ?? true,
      permissionMode: settings.permissionMode,
      mcpConfig: settings.mcpConfig,
      strictMcpConfig: settings.strictMcpConfig,
      bridgeOpencodeMcp: settings.bridgeOpencodeMcp ?? true,
      controlRequestBehavior: settings.controlRequestBehavior ?? "allow",
      controlRequestToolBehaviors: settings.controlRequestToolBehaviors,
      controlRequestDenyMessage: settings.controlRequestDenyMessage,
      proxyTools,
      webSearch: settings.webSearch,
      hotReloadMcp: settings.hotReloadMcp ?? true,
    })
  }

  const provider = function (modelId: string) {
    return createModel(modelId)
  } as ClaudeCodeProvider

  provider.specificationVersion = "v3"
  provider.languageModel = createModel

  return provider
}

// ---------------------------------------------------------------------------
// OpenCode plugin interface
// ---------------------------------------------------------------------------

const PROVIDER_ID = BASE_PROVIDER_ID
const PACKAGE_NPM = "@khalilgharbaoui/opencode-claude-code-plugin"

function pluginEntrypoint(): string {
  return import.meta.url.startsWith("file:") ? import.meta.url : PACKAGE_NPM
}

function cleanProviderOptions(
  options: Record<string, unknown> = {},
): Record<string, unknown> {
  const result = { ...options }
  delete result.accounts
  return result
}

function mergeDefaultVariants(models: Record<string, unknown> = {}) {
  const result = { ...models } as Record<string, Record<string, unknown>>

  for (const [id, model] of Object.entries(defaultModels)) {
    if (!model.variants) continue

    const existing =
      result[id] && typeof result[id] === "object" ? result[id] : {}
    const variants =
      existing.variants && typeof existing.variants === "object"
        ? (existing.variants as Record<string, Record<string, unknown>>)
        : {}

    result[id] = {
      ...existing,
      variants: {
        ...model.variants,
        ...variants,
      },
    }
  }

  return result
}

function defaultModelsForProvider(
  providerModels: OpenCodeProvider["models"],
  providerID = PROVIDER_ID,
  modelSuffix?: string,
) {
  const models = Object.fromEntries(
    Object.entries(defaultModels).map(([id, model]) => {
      const modelId = modelSuffix ? `${id}@${modelSuffix}` : id
      const existing = providerModels[id] ?? providerModels[modelId]
      return [
        modelId,
        {
          ...model,
          id: modelId,
          providerID,
          api: {
            ...model.api,
            id: modelId,
            npm: existing?.api?.npm ?? model.api.npm,
            url: existing?.api?.url ?? model.api.url,
          },
        },
      ]
    }),
  )

  for (const [id, model] of Object.entries(providerModels)) {
    if (!(id in models)) {
      models[id] = {
        ...model,
        providerID,
      }
    }
  }

  return models
}

/**
 * Build models in OpenCode's config schema format (flat properties like
 * `temperature`, `reasoning`, `cost.cache_read`, `modalities`, etc.)
 * so the config-path provider loader parses them correctly.
 */
function configModelsForProvider(
  providerModels: OpenCodeProvider["models"],
  providerID: string,
  modelSuffix?: string,
): Record<string, Record<string, unknown>> {
  const models: Record<string, Record<string, unknown>> = {}

  for (const [id, model] of Object.entries(defaultModels)) {
    const modelId = modelSuffix ? `${id}@${modelSuffix}` : id
    const existing = providerModels[id] ?? providerModels[modelId]
    const full: OpenCodeModel = {
      ...model,
      id: modelId,
      providerID,
      api: {
        ...model.api,
        id: modelId,
        npm: existing?.api?.npm ?? model.api.npm,
        url: existing?.api?.url ?? model.api.url,
      },
    }
    models[modelId] = toConfigModel(full)
  }

  for (const [id, model] of Object.entries(providerModels)) {
    if (!(id in models)) {
      models[id] = toConfigModel({ ...model, providerID } as OpenCodeModel)
    }
  }

  return models
}

async function providerConfig(
  existing: {
    name?: string
    npm?: string
    options?: Record<string, unknown>
    models?: Record<string, unknown>
  } | undefined,
  providerID = PROVIDER_ID,
  optionDefaults: Record<string, unknown> = {},
  displayName?: string,
) {
  const mergedOptions: Record<string, unknown> = {
    cliPath: "claude",
    proxyTools: ["Bash", "Edit", "Write", "WebFetch"],
    ...optionDefaults,
    ...cleanProviderOptions(existing?.options),
    providerID,
  }

  const cliPath = String(mergedOptions.cliPath ?? "claude")
  const account =
    typeof mergedOptions.account === "string" ? mergedOptions.account : undefined
  const runtime = account
    ? await ensureAccountRuntime(account, cliPath)
    : { cliPath }

  return {
    name: displayName ?? existing?.name,
    npm: existing?.npm ?? pluginEntrypoint(),
    options: {
      ...mergedOptions,
      ...runtime,
    },
    models: mergeDefaultVariants(existing?.models),
  }
}

async function expandAccountProviders(config: {
  provider?: Record<
    string,
    {
      name?: string
      npm?: string
      options?: Record<string, unknown>
      models?: Record<string, unknown>
    }
  >
}): Promise<boolean> {
  const seed = config.provider?.[PROVIDER_ID]
  const accounts = resolveAccounts(seed?.options?.accounts)

  if (!accounts) return false

  config.provider ??= {}

  const seedOptions = cleanProviderOptions(seed?.options)
  let expandedCount = 0

  for (const account of accounts) {
    const providerID = accountProviderId(account)
    try {
      const existing = config.provider[providerID]
      const modelSuffix = accountModelSuffix(account)

      config.provider[providerID] = {
        ...existing,
        ...(await providerConfig(
          existing,
          providerID,
          {
            ...seedOptions,
            account,
          },
          accountDisplayName(account),
        )),
        models: configModelsForProvider(
          (existing?.models ?? seed?.models ?? {}) as OpenCodeProvider["models"],
          providerID,
          modelSuffix,
        ),
      }
      expandedCount++
    } catch (err) {
      log.error("failed to expand account provider", {
        account,
        providerID,
        error: String(err),
      })
    }
  }

  if (expandedCount > 0) {
    delete config.provider[PROVIDER_ID]
  }

  return expandedCount > 0
}

/**
 * Pull the bus event `type` regardless of which envelope opencode used
 * (top-level `{type}` vs the nested `{payload:{type}}` shape from
 * `GlobalBus.emit`). Loose by design — opencode adds events over time and
 * we only care about the few we explicitly handle.
 */
function readEventType(ev: unknown): string | undefined {
  if (!ev || typeof ev !== "object") return undefined
  const e = ev as Record<string, unknown>
  if (typeof e.type === "string") return e.type
  const payload = e.payload
  if (payload && typeof payload === "object") {
    const t = (payload as Record<string, unknown>).type
    if (typeof t === "string") return t
  }
  return undefined
}

const server: OpenCodePlugin = async (input) => {
  // Capture the SDK client so the language model can query opencode's
  // in-memory MCP state per-turn for the runtime overlay. `input` is
  // `unknown` here (kept loose since opencode adds fields over time);
  // narrow defensively.
  if (input && typeof input === "object" && "client" in input) {
    setOpencodeClient((input as { client?: unknown }).client)
  }

  return {
  config: async (config) => {
    config.provider ??= {}

    const expanded = await expandAccountProviders(config)
    if (expanded) return

    const existing = config.provider[PROVIDER_ID]
    config.provider[PROVIDER_ID] = {
      ...existing,
      ...(await providerConfig(existing)),
    }
  },
  event: async ({ event }) => {
    if (readEventType(event) === "global.disposed") {
      // opencode invalidated its config — most commonly a UI MCP toggle or
      // `updateGlobal()` writing the global config file. Drop cached claude
      // subprocesses so the next user turn re-spawns with the fresh
      // bridged MCP config. Stored claude session ids are preserved by
      // evictAllSessions so the conversation continues seamlessly via
      // `--session-id`.
      evictAllSessions("global.disposed")
    }
  },
  provider: {
    id: PROVIDER_ID,
    models: async (provider) => defaultModelsForProvider(provider.models),
  },
  }
}

export default {
  id: "@khalilgharbaoui/opencode-claude-code-plugin",
  server,
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { ClaudeCodeLanguageModel } from "./claude-code-language-model.js"
export { bridgeOpencodeMcp } from "./mcp-bridge.js"
export { defaultModels } from "./models.js"
export type {
  ClaudeCodeConfig,
  ClaudeCodeProviderSettings,
  ClaudeStreamMessage,
} from "./types.js"
export type { OpenCodeHooks, OpenCodeModel, OpenCodePlugin } from "./opencode-types.js"
