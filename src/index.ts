import type { LanguageModelV3 } from "@ai-sdk/provider"
import { ClaudeCodeLanguageModel } from "./claude-code-language-model.js"
import { defaultModels, passthroughModel, toConfigModel } from "./models.js"
import type {
  OpenCodeConfig,
  OpenCodeEvent,
  OpenCodeModel,
  OpenCodePlugin,
  OpenCodeProvider,
} from "./opencode-types.js"
import { DEFAULT_PROXY_TOOL_NAMES } from "./types.js"
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
  parseFallbackModelList,
  readAgentMarkdownRecords,
  setAgentRegistry,
  setDefaultSubagentCacheTtl,
  setDefaultSubagentModel,
  setProviderFallbackModels,
} from "./agent-models.js"
import { cleanupStaleUnscopedInstall } from "./cleanup-stale.js"
import { DOCTOR_COMMAND, DOCTOR_COMMAND_DESCRIPTION } from "./doctor.js"
import { configureLogger, log } from "./logger.js"
import { registerOpencodeLogSink } from "./tui-log-sink.js"
import {
  BTW_COMMAND_DESCRIPTION,
  handleBtwCommand,
  type BtwSdkClient,
} from "./btw-command.js"
import {
  isUnknownPreset,
  resolvePermissionPreset,
  type ResolvedPermissionPreset,
} from "./permission-presets.js"
import { registerBundledSkillPath } from "./skill-bridge.js"
import {
  deleteActiveProcessesForSession,
  ensureProcessExitCleanup,
} from "./session-manager.js"
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
import { loadMergedOpencodeConfig } from "./mcp-bridge.js"
import { createV2Setup } from "./v2.js"

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

// Defined in `types.ts` so `permission-presets.ts` and the two diagnostics
// modules can read it without importing this file, and re-exported here
// unchanged because it is part of the package's public surface.
export { DEFAULT_PROXY_TOOL_NAMES } from "./types.js"

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
    description: BTW_COMMAND_DESCRIPTION,
  }
  return true
}

/**
 * Registers `/claude-code-doctor` unless the user defined their own command of
 * that name. Unlike `/btw` there is no hook to guard: the command is a plain
 * template and the language model answers the message it produces, so leaving
 * a user definition alone here is the whole guard.
 *
 * The name carries no slash. opencode invokes a command as `/<key>` and takes
 * everything after the first space as `$ARGUMENTS`, so `claude-code doctor`
 * would be the command `claude-code` with the argument `doctor`.
 */
export function registerDoctorCommand(config: OpenCodeConfig): boolean {
  config.command ??= {}
  if (config.command[DOCTOR_COMMAND]) return false
  config.command[DOCTOR_COMMAND] = {
    template: `/${DOCTOR_COMMAND} $ARGUMENTS`,
    description: DOCTOR_COMMAND_DESCRIPTION,
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
      "ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN detected; claude may bill as pay-as-you-go API usage instead of your subscription. Set provider option `ignoreAnthropicApiKey: true` to force subscription auth.",
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

export function warnIfPlanModeCannotExit(
  permissionMode: string | undefined,
  transport?: { transport?: string; interactive?: boolean },
): void {
  if (permissionMode !== "plan") return
  // The interactive TUI offers `ExitPlanMode`, and its approval dialog goes to
  // the operator (h #g201), so plan mode can be left there. `auto` usually
  // lands on headless, which keeps the warning.
  const interactive =
    transport?.transport === "interactive" ||
    (transport?.transport === undefined && transport?.interactive === true)
  if (interactive) return
  if (warnedPlanModeNoExit) return
  warnedPlanModeNoExit = true
  log.warn(
    "permissionMode \"plan\" is enforced: claude cannot edit files or run commands, and --dangerously-skip-permissions is deliberately not passed so it stays that way. Headless Claude Code is not offered an ExitPlanMode tool, so nothing releases plan mode mid-session; approving a plan in chat does not unlock writes. Leaving plan mode means changing the config and restarting opencode.",
    { permissionMode, measuredOn: "claude-code 2.1.258" },
  )
}

/**
 * Resolve `permissionPreset` for this provider, reporting what it replaced.
 *
 * The result is applied over the operator's settings by `createClaudeCode`,
 * which is the one funnel both opencode majors reach the language model
 * through, so a preset needs wiring in exactly one place.
 *
 * Every override is logged at NOTICE, and an unrecognised preset name is a
 * WARN plus no preset at all. A safety option must never be approximated: a
 * typo'd `"readonly"` silently running at full permissions is worse than one
 * that says so.
 */
export function applyPermissionPreset(
  settings: ClaudeCodeProviderSettings,
  defaultProxyTools: readonly string[],
): ResolvedPermissionPreset | null {
  const resolved = resolvePermissionPreset(settings, defaultProxyTools)
  if (resolved === null) return null
  if (isUnknownPreset(resolved)) {
    log.warn(
      "unknown permissionPreset; no preset applied and every permission" +
        " setting is left exactly as configured",
      { permissionPreset: resolved.unknown, known: ["read-only"] },
    )
    return null
  }
  log.notice(`permission preset "${resolved.preset}" applied`, {
    permissionMode: resolved.permissionMode,
    skipPermissions: resolved.skipPermissions,
    proxyTools: resolved.proxyTools,
    disallowedTools: resolved.extraDisallowedTools,
    controlRequestBehavior: resolved.controlRequestBehavior,
  })
  for (const line of resolved.overridden) {
    log.notice(`permission preset "${resolved.preset}" overrode ${line}`)
  }
  return resolved
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
  const preset = applyPermissionPreset(settings, DEFAULT_PROXY_TOOL_NAMES)
  // A preset drops any configured `permissionMode`, so the plan-mode warning
  // would be about a mode this provider is not running in.
  warnIfPlanModeCannotExit(preset ? undefined : settings.permissionMode, settings)
  const cliPath =
    settings.cliPath ?? process.env.CLAUDE_CLI_PATH ?? "claude"
  const providerName = settings.providerID ?? settings.name ?? "claude-code"
  const proxyTools =
    preset?.proxyTools ?? settings.proxyTools ?? [...DEFAULT_PROXY_TOOL_NAMES]

  const createModel = (modelId: string): LanguageModelV3 => {
    return new ClaudeCodeLanguageModel(modelId, {
      provider: providerName,
      cliPath,
      hostApi: settings.hostApi,
      cwd: settings.cwd,
      account: settings.account,
      configDir: settings.configDir,
      failoverAccounts: settings.failoverAccounts,
      baseCliPath: settings.baseCliPath ?? cliPath,
      // Passed through, with no default applied here: the form is opt-in and
      // `isAccountFailoverQuestionActive` asks for an explicit `"ask"`, so an
      // unset option must stay unset rather than being written to one mode or
      // the other in only one of the two entry points (h #g194).
      accountFailover: settings.accountFailover,
      providerID: settings.providerID,
      skipPermissions: preset?.skipPermissions ?? settings.skipPermissions ?? true,
      permissionMode: preset?.permissionMode ?? settings.permissionMode,
      permissionPreset: preset?.preset,
      mcpConfig: settings.mcpConfig,
      strictMcpConfig: settings.strictMcpConfig,
      bridgeOpencodeMcp: settings.bridgeOpencodeMcp ?? true,
      controlRequestBehavior:
        preset?.controlRequestBehavior ?? settings.controlRequestBehavior ?? "allow",
      controlRequestToolBehaviors: preset
        ? undefined
        : settings.controlRequestToolBehaviors,
      controlRequestDenyMessage: settings.controlRequestDenyMessage,
      proxyTools,
      proxyOpencodeTools: settings.proxyOpencodeTools,
      stripContextReminders: settings.stripContextReminders === true,
      extraDisallowedTools:
        preset?.extraDisallowedTools ?? settings.extraDisallowedTools,
      proxyToolTimeoutMs: settings.proxyToolTimeoutMs,
      planModeQuestion: settings.planModeQuestion ?? false,
      webSearch: settings.webSearch,
      hotReloadMcp: settings.hotReloadMcp ?? true,
      mcpConnectWaitMs: settings.mcpConnectWaitMs,
      proxyOpencodeMcpTools: settings.proxyOpencodeMcpTools === true,
      multiStepContinuation: settings.multiStepContinuation ?? true,
      autoContinueIncompleteTurns:
        settings.autoContinueIncompleteTurns ?? "smart",
      compactionModel: settings.compactionModel,
      ignoreAnthropicApiKey: settings.ignoreAnthropicApiKey,
      idleProcessTimeoutMs: settings.idleProcessTimeoutMs,
      bridgeOpencodeSkills: settings.bridgeOpencodeSkills === true,
      bridgeSkipNativeSkills: settings.bridgeSkipNativeSkills !== false,
      turnStats: settings.turnStats === true,
      forkSessions: settings.forkSessions === true,
      resumeAfterRestart: settings.resumeAfterRestart !== false,
      resumeAcrossModelChanges: settings.resumeAcrossModelChanges !== false,
      transport: settings.transport,
      interactive: settings.interactive,
      interactiveBypass: settings.interactiveBypass,
      interactiveAllowTools: settings.interactiveAllowTools,
      interactiveSystemPrompt: settings.interactiveSystemPrompt,
      interactiveUserInstructions: settings.interactiveUserInstructions,
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
      models[id] = completeUserModel(id, model, providerID)
    }
  }

  return models
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * A user model id this plugin does not register, in the flat config schema.
 *
 * A full runtime-shaped entry (`capabilities`, nested `cost.cache`) converts as
 * before. Anything else is what opencode's config schema actually allows, a
 * partial entry in the flat shape, and it is overlaid on `passthroughModel`'s
 * complete template rather than converted, because converting a partial entry
 * threw `undefined is not an object (evaluating 'model.capabilities.input')`
 * inside the config hook and took the whole provider registration with it
 * (found 2026-09-27 while probing the fallback chain). Nested `cost`, `limit`
 * and `variants` merge key by key so a partial `limit: { context }` keeps the
 * template's `output`.
 */
function completeUserModel(
  id: string,
  entry: unknown,
  providerID: string,
): Record<string, unknown> {
  const record = isRecord(entry) ? entry : {}
  const runtimeShaped =
    isRecord(record.capabilities) &&
    isRecord(record.capabilities.input) &&
    isRecord(record.capabilities.output) &&
    isRecord(record.cost) &&
    isRecord(record.cost.cache) &&
    isRecord(record.api)
  if (runtimeShaped) {
    return toConfigModel({ ...(record as unknown as OpenCodeModel), providerID })
  }
  const base = toConfigModel({ ...passthroughModel(id), providerID })
  log.warn("provider model entry is partial; completing it from the pass-through template", {
    providerID,
    model: id,
    declared: Object.keys(record),
  })
  const merged: Record<string, unknown> = { ...base, ...record, id }
  for (const key of ["cost", "limit", "variants"] as const) {
    merged[key] = {
      ...(isRecord(base[key]) ? base[key] : {}),
      ...(isRecord(record[key]) ? record[key] : {}),
    }
  }
  return merged
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
      // The pre-wrapper binary, kept because `runtime` replaces `cliPath`
      // with the account's wrapper and a failover has to build ANOTHER
      // account's wrapper on top of the same base (src/account-failover.ts).
      baseCliPath: cliPath,
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
            // The resolved list, so this account's language model can offer
            // the others when it runs out of usage. `accounts` itself stays
            // stripped by cleanProviderOptions.
            failoverAccounts: accounts,
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
export async function buildAgentRegistry(config: OpenCodeConfig): Promise<void> {
  const options = config.provider?.[PROVIDER_ID]?.options
  const configured = options?.defaultSubagentModel
  setDefaultSubagentModel(
    typeof configured === "string" ? configured : undefined,
  )
  const configuredTtl = options?.defaultSubagentCacheTtl
  setDefaultSubagentCacheTtl(
    typeof configuredTtl === "string" ? configuredTtl : undefined,
  )
  setProviderFallbackModels(parseFallbackModelList(options?.fallbackModels))

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

    // A list, unlike the four scalars, so it cannot go through `pick`, and an
    // empty declaration must not erase what the markdown file said.
    const declaredChain = parseFallbackModelList(
      (agent as Record<string, unknown>).fallbackModels ?? bag.fallbackModels,
    )

    records[name] = {
      mode: pick("mode") ?? records[name]?.mode,
      model: pick("model") ?? records[name]?.model,
      forceModel: pick("forceModel") ?? records[name]?.forceModel,
      reasoningEffort:
        pick("reasoningEffort") ?? records[name]?.reasoningEffort,
      cacheTtl: pick("cacheTtl") ?? records[name]?.cacheTtl,
      fallbackModels: declaredChain.length
        ? declaredChain
        : records[name]?.fallbackModels,
      prompt: pick("prompt") ?? records[name]?.prompt,
    }
  }

  setAgentRegistry(records)
  log.debug("agent registry built", {
    agents: Object.keys(records).length,
    defaultSubagentModel: getDefaultSubagentModel(),
  })
}

/**
 * The opencode session id a `session.deleted` bus event names, or undefined
 * for any other event. opencode publishes `{ type, properties: { info } }`
 * under `payload`, and the deleted session's own record is `properties.info`.
 */
export function extractDeletedSessionId(event: OpenCodeEvent | undefined): string | undefined {
  const payload = event?.payload ?? event
  if (!payload || payload.type !== "session.deleted") return undefined
  const properties = payload.properties as { info?: { id?: unknown } } | undefined
  const id = properties?.info?.id
  return typeof id === "string" && id.length > 0 ? id : undefined
}

const server: OpenCodePlugin = async (input) => {
  cleanupStaleUnscopedInstall()
  // Retained `claude` children would otherwise outlive a hard opencode exit,
  // reparented to init. Armed once per process however often this runs.
  ensureProcessExitCleanup()

  const opencodeVersion = pickOpencodeVersion(input)

  // Capture the SDK client so the language model can query opencode's
  // in-memory MCP state per-turn for the runtime overlay. `input` is
  // `unknown` here (kept loose since opencode adds fields over time);
  // narrow defensively.
  if (input && typeof input === "object" && "client" in input) {
    const client = (input as { client?: unknown }).client
    setOpencodeClient(client)
    // Before anything else that could warn: inside opencode's TUI this is the
    // only route a WARN has that does not paint raw text over the interface,
    // and registering it here flushes whatever was already buffered (the
    // stale-install sweep, the API-key heads-up). Outside a TUI the logger
    // never consults it and stderr behaves exactly as before.
    registerOpencodeLogSink(client)
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
      registerDoctorCommand(config)
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
    // Only `session.deleted` is acted on. MCP config drift is still detected
    // at turn start by the hot-reload check in `claude-code-language-model.ts`,
    // which respawns claude safely between turns, and eviction on
    // `global.disposed` would kill an in-flight stream and abort the user's
    // current turn. A deleted session has no turn left to abort, and its
    // `claude` child would otherwise linger until the idle timer or LRU
    // pressure took it, with its session id kept for a resume that never comes.
    event: async ({ event }) => {
      const sessionID = extractDeletedSessionId(event)
      if (!sessionID) return
      const released = deleteActiveProcessesForSession(sessionID)
      if (released.length > 0) {
        log.info("released claude state for deleted session", { sessionID, released })
      }
    },
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

// One package, both opencode majors: 1.x calls `server()`, 2.x calls
// `setup(ctx)`. This is the documented dual shape from opencode's V1 migration
// guide, and V1 has accepted an object entrypoint since 1.18.29. See V2.md.
export default {
  id: "@khalilgharbaoui/opencode-claude-code-plugin",
  server,
  setup: createV2Setup({
    createProvider: createClaudeCode,
    defaultProxyTools: DEFAULT_PROXY_TOOL_NAMES,
    loadConfig: (directory) => loadMergedOpencodeConfig(directory, "v2"),
    buildAgentRegistry: (config) => buildAgentRegistry(config as OpenCodeConfig),
  }),
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
