import type { LanguageModelV3 } from "@ai-sdk/provider"
import { ClaudeCodeLanguageModel } from "./claude-code-language-model.js"
import { defaultModels, toConfigModel } from "./models.js"
import type {
  OpenCodeConfig,
  OpenCodeModel,
  OpenCodePlugin,
  OpenCodeProvider,
} from "./opencode-types.js"
import type { ClaudeCodeProviderSettings } from "./types.js"
import {
  BASE_PROVIDER_ID,
  accountDisplayName,
  accountModelSuffix,
  accountProviderId,
  ensureAccountRuntime,
  resolveAccounts,
} from "./accounts.js"
import {
  type AgentRecord,
  agentDirectories,
  getDefaultSubagentModel,
  readAgentMarkdownRecords,
  setAgentRegistry,
  setDefaultSubagentModel,
} from "./agent-models.js"
import { cleanupStaleUnscopedInstall } from "./cleanup-stale.js"
import { configureLogger, log } from "./logger.js"
import { handleBtwCommand, type BtwSdkClient } from "./btw-command.js"
import { registerBundledSkillPath } from "./skill-bridge.js"
import { getOpencodeClient } from "./runtime-status.js"
import {
  getOpencodeProjectDirectory,
  isUsableDirectory,
  setOpencodeClient,
  setOpencodeProjectDirectory,
} from "./runtime-status.js"
import {
  logStartupDiagnostics,
  pickOpencodeVersion,
  type DiagnosticsProviderEntry,
} from "./startup-diagnostics.js"

export interface ClaudeCodeProvider {
  specificationVersion: "v3"
  (modelId: string): LanguageModelV3
  languageModel(modelId: string): LanguageModelV3
}

// Picks the best directory from opencode's plugin context (`directory` /
// `worktree`). Result is handed to runtime-status so it's available as a
// *fallback* at spawn time only when `process.cwd()` is unusable (macOS
// GUI launches at `/`). Never baked into provider config — see #4.
function pickOpencodeDirectory(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const ctx = input as { directory?: unknown; worktree?: unknown }
  if (isUsableDirectory(ctx.directory)) return ctx.directory
  if (isUsableDirectory(ctx.worktree)) return ctx.worktree
  return undefined
}

let warnedAnthropicApiKey = false
let warnedPlanModeNoExit = false

// `Question` is deliberately absent: enabling it disables Claude Code's
// built-in AskUserQuestion (via --disallowedTools) and replaces the
// stop-and-wait deny/markdown path with an in-turn blocking form. That is a
// behavior trade against the issue-#8 guarantee, so it stays opt-in until it
// has the same live mileage Task had before v0.10.0 flipped it on. Users opt
// in by listing it in `proxyTools`; see README "Question proxy tool".
export const DEFAULT_PROXY_TOOL_NAMES = [
  "Bash",
  "Edit",
  "Write",
  "WebFetch",
  "Task",
]

/**
 * Registers `/btw` unless the user defined their own. Returns whether the
 * registration is ours: the command hook only intercepts `btw` in that case,
 * so a user-defined command keeps opencode's normal behaviour end to end.
 */
export function registerSideQuestionCommand(config: OpenCodeConfig): boolean {
  config.command ??= {}
  if (config.command.btw) return false
  config.command.btw = {
    template: "/btw $ARGUMENTS",
    description: "Ask a side question in the live Claude Code session without changing its context",
  }
  return true
}

let ownsSideQuestionCommand = false

// One-time heads-up: an API key in the environment makes Claude Code bill
// pay-as-you-go (Console) instead of the logged-in Pro/Max subscription, which
// silently bypasses the Agent SDK plan credit. Surfaced once per process.
function warnIfAnthropicApiKey(ignore: boolean | undefined): void {
  if (warnedAnthropicApiKey) return
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return
  warnedAnthropicApiKey = true
  if (ignore) {
    log.warn(
      "ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN detected; stripping it from claude spawns (ignoreAnthropicApiKey) so requests use your subscription auth, not pay-as-you-go API billing.",
    )
  } else {
    log.warn(
      "ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN detected; claude may bill as pay-as-you-go API usage instead of your subscription / Agent SDK credit. Set provider option `ignoreAnthropicApiKey: true` to force subscription auth.",
    )
  }
}

// Plan mode is enforced (buildCliArgs drops the skip-permissions flag for it),
// so the read-only guarantee holds. The cost is that headless Claude Code is
// not offered an `ExitPlanMode` tool, measured on 2.1.258, so nothing can
// release plan mode mid-session and approving a plan in chat will not let
// Claude write. Say so once per process rather than let it look like a hang.
export function _resetPlanModeWarningForTests(): void {
  warnedPlanModeNoExit = false
}

export function warnIfPlanModeCannotExit(permissionMode: string | undefined): void {
  if (permissionMode !== "plan") return
  if (warnedPlanModeNoExit) return
  warnedPlanModeNoExit = true
  log.warn(
    "permissionMode \"plan\" is enforced: claude cannot edit files or run commands, and --dangerously-skip-permissions is deliberately not passed so it stays that way. Headless Claude Code is not offered an ExitPlanMode tool, so nothing releases plan mode mid-session; approving a plan in chat does not unlock writes. Leaving plan mode means changing the config and restarting opencode.",
    { permissionMode, measuredOn: "claude-code 2.1.258" },
  )
}

export function createClaudeCode(
  settings: ClaudeCodeProviderSettings = {},
): ClaudeCodeProvider {
  if (settings.logging) {
    configureLogger({
      file: settings.logging.file ?? false,
      dir: settings.logging.dir ?? null,
      mode: settings.logging.mode ?? "silent",
      level: settings.logging.level ?? "info",
    })
  }
  warnIfAnthropicApiKey(settings.ignoreAnthropicApiKey)
  warnIfPlanModeCannotExit(settings.permissionMode)
  const cliPath =
    settings.cliPath ?? process.env.CLAUDE_CLI_PATH ?? "claude"
  const providerName = settings.providerID ?? settings.name ?? "claude-code"
  const proxyTools = settings.proxyTools ?? [...DEFAULT_PROXY_TOOL_NAMES]

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
      extraDisallowedTools: settings.extraDisallowedTools,
      proxyToolTimeoutMs: settings.proxyToolTimeoutMs,
      planModeQuestion: settings.planModeQuestion ?? false,
      webSearch: settings.webSearch,
      hotReloadMcp: settings.hotReloadMcp ?? true,
      proxyOpencodeMcpTools: settings.proxyOpencodeMcpTools ?? true,
      multiStepContinuation: settings.multiStepContinuation ?? true,
      autoContinueIncompleteTurns:
        settings.autoContinueIncompleteTurns ?? "smart",
      compactionModel: settings.compactionModel,
      ignoreAnthropicApiKey: settings.ignoreAnthropicApiKey,
      idleProcessTimeoutMs: settings.idleProcessTimeoutMs,
      bridgeOpencodeSkills: settings.bridgeOpencodeSkills === true,
      interactive: settings.interactive,
      interactiveBypass: settings.interactiveBypass,
      interactiveAllowTools: settings.interactiveAllowTools,
      interactiveSystemPrompt: settings.interactiveSystemPrompt,
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
  // Consumed by the config hook (agent registry), not by the language model.
  delete result.defaultSubagentModel
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
export function configModelsForProvider(
  providerModels: OpenCodeProvider["models"],
  providerID: string,
  modelSuffix?: string,
): Record<string, Record<string, unknown>> {
  const models: Record<string, Record<string, unknown>> = {}

  for (const [id, model] of Object.entries(defaultModels)) {
    const modelId = modelSuffix ? `${id}@${modelSuffix}` : id
    const existing = providerModels[id] ?? providerModels[modelId]
    const existingVariants =
      existing && typeof (existing as { variants?: unknown }).variants === "object"
        ? ((existing as { variants?: Record<string, Record<string, unknown>> }).variants ?? {})
        : {}
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
      variants: {
        ...(model.variants ?? {}),
        ...existingVariants,
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
    proxyTools: [...DEFAULT_PROXY_TOOL_NAMES],
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
    // models is intentionally omitted: both callers overwrite it with
    // configModelsForProvider(), which emits the flat config schema
    // opencode's config-path loader parses (and merges user variants).
  }
}

/**
 * Narrow opencode's full provider map down to the ones this plugin owns
 * (`claude-code` plus every `claude-code-<account>` expansion) so startup
 * diagnostics never report another provider's options.
 */
export function claudeCodeProviders(
  providers: Record<string, DiagnosticsProviderEntry> | undefined,
): Record<string, DiagnosticsProviderEntry> {
  const out: Record<string, DiagnosticsProviderEntry> = {}
  for (const [id, entry] of Object.entries(providers ?? {})) {
    if (id === PROVIDER_ID || id.startsWith(`${PROVIDER_ID}-`)) out[id] = entry
  }
  return out
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
 * Record what every known agent asked for, so `resolveAgentModel` and
 * `resolveAgentEffort` can answer at spawn time without the language model
 * needing to see opencode's config.
 *
 * Runs BEFORE `expandAccountProviders`, which deletes the seed provider entry
 * once it has expanded it: `defaultSubagentModel` has to be read while it is
 * still there.
 *
 * Purely observational. It defines no agents and changes no agent's config;
 * an agent this plugin never heard of is simply absent from the registry,
 * which is what keeps opencode's built-ins out of the override path.
 */
async function buildAgentRegistry(config: OpenCodeConfig): Promise<void> {
  const options = config.provider?.[PROVIDER_ID]?.options
  const configured = options?.defaultSubagentModel
  setDefaultSubagentModel(
    typeof configured === "string" ? configured : undefined,
  )

  // Markdown agents may or may not reach a plugin's config hook (undocumented
  // either way), so they are read from disk and then overlaid with whatever
  // config does carry, which is authoritative when both describe one agent.
  const records: Record<string, AgentRecord> = await readAgentMarkdownRecords(
    agentDirectories(
      process.env.HOME ?? process.env.USERPROFILE,
      getOpencodeProjectDirectory(),
    ),
  )

  for (const [name, agent] of Object.entries(config.agent ?? {})) {
    const bag = (agent.options ?? {}) as Record<string, unknown>
    const pick = (key: string): string | undefined => {
      const value = agent[key] ?? bag[key]
      return typeof value === "string" ? value : undefined
    }

    records[name] = {
      mode: pick("mode") ?? records[name]?.mode,
      model: pick("model") ?? records[name]?.model,
      forceModel: pick("forceModel") ?? records[name]?.forceModel,
      reasoningEffort:
        pick("reasoningEffort") ?? records[name]?.reasoningEffort,
    }
  }

  setAgentRegistry(records)
  log.debug("agent registry built", {
    agents: Object.keys(records).length,
    defaultSubagentModel: getDefaultSubagentModel(),
  })
}

const server: OpenCodePlugin = async (input) => {
  cleanupStaleUnscopedInstall()

  const opencodeVersion = pickOpencodeVersion(input)

  // Capture the SDK client so the language model can query opencode's
  // in-memory MCP state per-turn for the runtime overlay. `input` is
  // `unknown` here (kept loose since opencode adds fields over time);
  // narrow defensively.
  if (input && typeof input === "object" && "client" in input) {
    setOpencodeClient((input as { client?: unknown }).client)
  }

  // Capture opencode's project-aware directory as a *fallback* used at
  // Claude CLI spawn time only when `process.cwd()` is unusable. Rescues
  // macOS GUI launches at `/` without freezing the value into provider
  // config, so opencode workspace switches mid-session still take effect.
  // See `resolveSpawnCwd` in runtime-status.ts and issue #4.
  setOpencodeProjectDirectory(pickOpencodeDirectory(input))

  return {
    config: async (config) => {
      if (registerSideQuestionCommand(config)) ownsSideQuestionCommand = true
      // The bundled `claude-code-plugin` skill: opencode lists it for every
      // provider via skills.paths; the spawn path also stages it as a
      // --plugin-dir so Claude's own Skill tool can load it.
      registerBundledSkillPath(config)
      config.provider ??= {}

      await buildAgentRegistry(config)

      const expanded = await expandAccountProviders(config)
      if (expanded) {
        logStartupDiagnostics(
          claudeCodeProviders(config.provider),
          opencodeVersion,
        )
        return
      }

      const existing = config.provider[PROVIDER_ID]
      config.provider[PROVIDER_ID] = {
        ...existing,
        ...(await providerConfig(existing)),
        models: configModelsForProvider(
          (existing?.models ?? {}) as OpenCodeProvider["models"],
          PROVIDER_ID,
        ),
      }
      logStartupDiagnostics(
        claudeCodeProviders(config.provider),
        opencodeVersion,
      )
    },
    // No `event` hook: MCP config drift is detected at turn start by the
    // hot-reload check in `claude-code-language-model.ts`, which respawns
    // claude safely between turns. Eviction on `global.disposed` would kill
    // an in-flight stream and abort the user's current turn.
    provider: {
      id: PROVIDER_ID,
      models: async (provider) => defaultModelsForProvider(provider.models),
    },
    // Inject opencode's agent name into providerOptions so the language
    // model can distinguish /compact (and title) calls from normal turns.
    // Without this, every no-tools call looks like a title request and
    // gets short-circuited to a synthetic stub.
    // /btw is asked from here, the moment the command is typed, busy or not.
    // The message itself still goes through: opencode queues it behind the
    // running turn and the aside branch in the language model then answers it
    // from the early answer, so the exchange is kept in this conversation.
    "command.execute.before": async (input) => {
      if (input.command !== "btw" || !ownsSideQuestionCommand) return
      await handleBtwCommand(getOpencodeClient() as BtwSdkClient | null, input)
    },
    "chat.params": async (input, output) => {
      const providerID = input.model?.providerID ?? input.provider?.info?.id
      // The hook fires for every provider opencode is configured with, not
      // just ours — keep this at debug to avoid log spam on non-claude-code
      // calls.
      log.debug("chat.params hook fired", {
        agent: input.agent,
        providerID,
        sessionID: input.sessionID,
      })
      if (typeof providerID !== "string") return
      if (providerID !== PROVIDER_ID && !providerID.startsWith(`${PROVIDER_ID}-`)) return

      // Inject sessionID BEFORE the agent guard so session isolation works
      // even when input.agent is absent (older opencode, provider-switch
      // edge paths). resolveSessionAffinity reads this as a fallback when
      // the x-session-affinity header is missing.
      if (typeof input.sessionID === "string" && input.sessionID.length > 0) {
        output.options ??= {}
        ;(output.options as Record<string, unknown>).opencodeSessionID = input.sessionID
      }

      if (!input.agent) return
      // opencode wraps the entire `output.options` bag under the providerID
      // via ProviderTransform.providerOptions(model, options) → { [providerID]: options }
      // before handing it to the language model as `providerOptions`. So we
      // write fields at the TOP LEVEL of output.options, not nested under
      // providerID — otherwise the model sees providerOptions[id][id].opencodeAgent.
      output.options ??= {}
      ;(output.options as Record<string, unknown>).opencodeAgent = input.agent
      log.debug("chat.params tagged providerOptions", {
        agent: input.agent,
        sessionID: input.sessionID,
        providerID,
      })
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
export {
  type AgentRecord,
  getAgentRegistry,
  getDefaultSubagentModel,
  resolveAgentModel,
} from "./agent-models.js"
export { defaultModels } from "./models.js"
export type {
  ClaudeCodeConfig,
  ClaudeCodeProviderSettings,
  ClaudeStreamMessage,
} from "./types.js"
export type { OpenCodeHooks, OpenCodeModel, OpenCodePlugin } from "./opencode-types.js"
