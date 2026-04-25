import type { LanguageModelV3 } from "@ai-sdk/provider"
import { ClaudeCodeLanguageModel } from "./claude-code-language-model.js"
import { defaultModels } from "./models.js"
import type { OpenCodePlugin, OpenCodeProvider } from "./opencode-types.js"
import type { ClaudeCodeProviderSettings } from "./types.js"

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
  const providerName = settings.name ?? "claude-code"
  const proxyTools = settings.proxyTools ?? ["Bash", "Edit", "Write", "WebFetch"]

  const createModel = (modelId: string): LanguageModelV3 => {
    return new ClaudeCodeLanguageModel(modelId, {
      provider: providerName,
      cliPath,
      cwd: settings.cwd,
      skipPermissions: settings.skipPermissions ?? true,
      permissionMode: settings.permissionMode,
      mcpConfig: settings.mcpConfig,
      strictMcpConfig: settings.strictMcpConfig,
      bridgeOpencodeMcp: settings.bridgeOpencodeMcp ?? true,
      controlRequestBehavior: settings.controlRequestBehavior ?? "allow",
      controlRequestToolBehaviors: settings.controlRequestToolBehaviors,
      controlRequestDenyMessage: settings.controlRequestDenyMessage,
      proxyTools,
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

const PROVIDER_ID = "claude-code"
const PACKAGE_NPM = "opencode-claude-code-plugin"

function pluginEntrypoint(): string {
  return import.meta.url.startsWith("file:") ? import.meta.url : PACKAGE_NPM
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

function defaultModelsForProvider(providerModels: OpenCodeProvider["models"]) {
  const models = Object.fromEntries(
    Object.entries(defaultModels).map(([id, model]) => {
      const existing = providerModels[id]
      return [
        id,
        {
          ...model,
          api: {
            ...model.api,
            npm: existing?.api?.npm ?? model.api.npm,
            url: existing?.api?.url ?? model.api.url,
          },
        },
      ]
    }),
  )

  for (const [id, model] of Object.entries(providerModels)) {
    if (!(id in models)) models[id] = model
  }

  return models
}

function providerConfig(existing?: {
  name?: string
  npm?: string
  options?: Record<string, unknown>
  models?: Record<string, unknown>
}) {
  return {
    name: existing?.name,
    npm: existing?.npm ?? pluginEntrypoint(),
    options: {
      cliPath: "claude",
      proxyTools: ["Bash", "Edit", "Write", "WebFetch"],
      ...(existing?.options ?? {}),
    },
    models: mergeDefaultVariants(existing?.models),
  }
}

const server: OpenCodePlugin = async () => ({
  config: async (config) => {
    config.provider ??= {}
    const existing = config.provider[PROVIDER_ID]
    config.provider[PROVIDER_ID] = {
      ...existing,
      ...providerConfig(existing),
    }
  },
  provider: {
    id: PROVIDER_ID,
    models: async (provider) => defaultModelsForProvider(provider.models),
  },
})

export default {
  id: "opencode-claude-code-plugin",
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
