import type { LanguageModelV3 } from "@ai-sdk/provider"
import { ClaudeCodeLanguageModel } from "./claude-code-language-model.js"
import { defaultModels } from "./models.js"
import type { OpenCodePlugin, OpenCodeProvider } from "./opencode-types.js"
import type { ClaudeCodeProviderSettings } from "./types.js"
import {
  BASE_PROVIDER_ID,
  accountDisplayName,
  accountModelSuffix,
  accountProviderId,
  ensureAccountRuntime,
  resolveAccounts,
} from "./accounts.js"

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
  const mergedOptions = {
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

  for (const account of accounts) {
    const providerID = accountProviderId(account)
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
      models: defaultModelsForProvider(
        (existing?.models ?? seed?.models ?? {}) as OpenCodeProvider["models"],
        providerID,
        modelSuffix,
      ),
    }
  }

  delete config.provider[PROVIDER_ID]
  return true
}

const server: OpenCodePlugin = async () => ({
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
  provider: {
    id: PROVIDER_ID,
    models: async (provider) => defaultModelsForProvider(provider.models),
  },
})

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
