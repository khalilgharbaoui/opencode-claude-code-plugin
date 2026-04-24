import type { LanguageModelV3 } from "@ai-sdk/provider"
import { ClaudeCodeLanguageModel } from "./claude-code-language-model.js"
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

  const createModel = (modelId: string): LanguageModelV3 => {
    return new ClaudeCodeLanguageModel(modelId, {
      provider: providerName,
      cliPath,
      // Keep undefined unless explicitly configured so the model resolves cwd
      // lazily at request time instead of freezing process.cwd() at provider
      // initialization time.
      cwd: settings.cwd,
      skipPermissions: settings.skipPermissions ?? true,
      permissionMode: settings.permissionMode,
      mcpConfig: settings.mcpConfig,
      strictMcpConfig: settings.strictMcpConfig,
      bridgeOpencodeMcp: settings.bridgeOpencodeMcp ?? true,
      controlRequestBehavior: settings.controlRequestBehavior ?? "allow",
      controlRequestToolBehaviors: settings.controlRequestToolBehaviors,
      controlRequestDenyMessage: settings.controlRequestDenyMessage,
      proxyTools: settings.proxyTools,
    })
  }

  const provider = function (modelId: string) {
    return createModel(modelId)
  } as ClaudeCodeProvider

  provider.specificationVersion = "v3"
  provider.languageModel = createModel

  return provider
}

export { ClaudeCodeLanguageModel } from "./claude-code-language-model.js"
export { bridgeOpencodeMcp } from "./mcp-bridge.js"
export type {
  ClaudeCodeConfig,
  ClaudeCodeProviderSettings,
  ClaudeStreamMessage,
} from "./types.js"
