import type { LanguageModelV3 } from "@ai-sdk/provider"
import {
  BASE_PROVIDER_ID,
  accountDisplayName,
  accountModelSuffix,
  accountProviderId,
  ensureAccountRuntime,
  resolveAccounts,
} from "./accounts.js"
import { log } from "./logger.js"
import { defaultModels } from "./models.js"
import type { OpenCodeModel } from "./opencode-types.js"
import { BTW_COMMAND_DESCRIPTION } from "./btw-command.js"
import { DOCTOR_COMMAND, DOCTOR_COMMAND_DESCRIPTION } from "./doctor.js"
import type {
  V2Cleanup,
  V2CommandInvocation,
  V2Context,
  V2Delivery,
  V2Event,
  V2ModelInfo,
  V2ProviderInfo,
  V2Registration,
  V2RequestKind,
} from "./opencode-v2-types.js"
import {
  isUsableDirectory,
  setOpencodeClient,
  setOpencodeProjectDirectory,
} from "./runtime-status.js"
import { createV1ClientShim, type V2ClientContext } from "./v2-client.js"
import {
  deleteActiveProcessesForSession,
  ensureProcessExitCleanup,
} from "./session-manager.js"
import { readBundledSkillInfos } from "./skill-bridge.js"
import { logStartupDiagnostics } from "./startup-diagnostics.js"
import type { ClaudeCodeProviderSettings } from "./types.js"

/**
 * opencode 2.x entrypoint. V1 calls the default export's `server()`, V2 calls
 * its `setup(ctx)`; the two never run in the same process, and nothing here
 * translates one API into the other.
 *
 * The provider is split across two V2 surfaces where V1 had one hook:
 * `provider.transform` publishes the metadata (providers and models) and the
 * `aisdk` `sdk` hook hands opencode the object that builds the language model.
 * opencode never imports `package` itself: `AISDK.language` only checks that it
 * carries the `aisdk:` prefix and then asks the `sdk` hooks for the SDK, which
 * is how its own bundled providers work too. So the name below is a label, not
 * something that has to resolve.
 */
export const V2_PLUGIN_PACKAGE = "aisdk:@khalilgharbaoui/opencode-claude-code-plugin"

/** The same header opencode 1.x sets itself, so the language model needs no V2 branch to read it. */
export const SESSION_AFFINITY_HEADER = "x-session-affinity"

/**
 * V1 tags the opencode agent into `providerOptions` from `chat.params`. V2's
 * `model.request` hook can only set headers, so the agent travels as one.
 */
export const OPENCODE_AGENT_HEADER = "x-opencode-agent"

// Keys the plugin itself consumes. They configure the provider set, not a
// language model, so they are never passed to `createClaudeCode`.
const PLUGIN_ONLY_SETTINGS = ["accounts", "defaultSubagentModel"]

// Keys opencode adds to the SDK options on its own (`prepareOptions` in the
// V2 aisdk runtime). None of them means anything to the Claude CLI.
const OPENCODE_SDK_OPTION_KEYS = ["fetch", "headers", "body", "name"]

export function isClaudeCodeProviderId(providerID: string | undefined): boolean {
  if (typeof providerID !== "string") return false
  return providerID === BASE_PROVIDER_ID || providerID.startsWith(`${BASE_PROVIDER_ID}-`)
}

/**
 * The agent name the language model keys its special paths on. V2 tells the
 * request kind apart from the agent, so a compaction or title call arrives with
 * the session's ordinary agent; map the kind back onto the names V1 used, which
 * are what `isCompactionCall` and the title stub already test for.
 */
export function agentForRequest(kind: V2RequestKind, agent: string): string {
  if (kind === "compaction") return "compaction"
  if (kind === "title") return "title"
  return agent
}

function releasedAt(date: string | undefined): number {
  const ms = date ? Date.parse(date) : Number.NaN
  return Number.isFinite(ms) ? ms : 0
}

function modalities(flags: Record<string, boolean | undefined>): string[] {
  return Object.entries(flags)
    .filter(([, enabled]) => enabled === true)
    .map(([name]) => name)
}

/** One registry entry in V2's `Model.Info` shape. */
export function toV2Model(
  model: OpenCodeModel,
  providerID: string,
  modelId: string,
): V2ModelInfo {
  return {
    id: modelId,
    modelID: modelId,
    providerID,
    name: model.name,
    family: model.family,
    capabilities: {
      tools: model.capabilities.toolcall,
      input: modalities(model.capabilities.input),
      output: modalities(model.capabilities.output),
    },
    variants: Object.entries(model.variants ?? {}).map(([id, settings]) => ({
      id,
      settings: { ...settings },
    })),
    time: { released: releasedAt(model.release_date) },
    cost: [
      {
        input: model.cost.input,
        output: model.cost.output,
        cache: { read: model.cost.cache.read, write: model.cost.cache.write },
      },
    ],
    status: model.status ?? "active",
    enabled: true,
    limit: { context: model.limit.context, output: model.limit.output },
    package: V2_PLUGIN_PACKAGE,
  }
}

export function v2ModelsForProvider(providerID: string, modelSuffix?: string): V2ModelInfo[] {
  return Object.entries(defaultModels).map(([id, model]) =>
    toV2Model(model, providerID, modelSuffix ? `${id}@${modelSuffix}` : id),
  )
}

export interface V2ProviderPlan {
  info: V2ProviderInfo
  models: V2ModelInfo[]
}

function stripPluginOnly(settings: Record<string, unknown> | undefined): Record<string, unknown> {
  const result = { ...(settings ?? {}) }
  for (const key of PLUGIN_ONLY_SETTINGS) delete result[key]
  return result
}

/**
 * The providers to publish, from the `claude-code` settings the operator
 * configured. Mirrors V1's config hook: no `accounts` means one `claude-code`
 * provider, and a list means one `claude-code-<account>` provider per entry
 * with the seed removed. The account wrapper script is not built here because
 * provider transforms are synchronous; `resolveSdkSettings` builds it when the
 * model is first asked for.
 */
export function planV2Providers(
  seedSettings: Record<string, unknown> | undefined,
  defaultProxyTools: readonly string[],
): V2ProviderPlan[] {
  const base: Record<string, unknown> = {
    cliPath: "claude",
    proxyTools: [...defaultProxyTools],
    ...stripPluginOnly(seedSettings),
  }
  const accounts = resolveAccounts(seedSettings?.accounts)

  if (!accounts) {
    return [
      {
        info: {
          id: BASE_PROVIDER_ID,
          name: "Claude Code",
          activation: "enabled",
          package: V2_PLUGIN_PACKAGE,
          settings: { ...base, providerID: BASE_PROVIDER_ID },
        },
        models: v2ModelsForProvider(BASE_PROVIDER_ID),
      },
    ]
  }

  return accounts.map((account) => {
    const providerID = accountProviderId(account)
    return {
      info: {
        id: providerID,
        name: accountDisplayName(account),
        activation: "enabled",
        package: V2_PLUGIN_PACKAGE,
        settings: {
          ...base,
          account,
          // The resolved list, so this account's language model can offer the
          // others when it runs out of usage (src/account-failover.ts).
          failoverAccounts: accounts,
          providerID,
          // Kept separately because the wrapper replaces `cliPath`, and a
          // failover builds another account's wrapper on the same base.
          baseCliPath: String(base.cliPath ?? "claude"),
        },
      },
      models: v2ModelsForProvider(providerID, accountModelSuffix(account)),
    }
  })
}

/**
 * The settings `createClaudeCode` is called with. What opencode hands the hook
 * wins over the planned copy: by then its config plugin has merged the
 * operator's provider settings over ours, and model or variant settings sit on
 * top of that. The planned copy fills what opencode's lacks, which is
 * everything for an account provider the config never names. opencode's own
 * transport keys are removed first. An account provider's wrapper is built
 * here, once per SDK, since it writes a script to disk.
 */
export async function resolveSdkSettings(
  providerID: string,
  planned: Record<string, unknown> | undefined,
  eventOptions: Record<string, unknown>,
): Promise<ClaudeCodeProviderSettings> {
  const fromEvent = { ...eventOptions }
  for (const key of OPENCODE_SDK_OPTION_KEYS) delete fromEvent[key]
  const merged: Record<string, unknown> = {
    ...stripPluginOnly({ ...(planned ?? {}), ...fromEvent }),
    providerID,
    // The only place a model is told it serves opencode 2.
    hostApi: "v2",
  }

  const account = typeof merged.account === "string" ? merged.account : undefined
  if (account) {
    const base = String(merged.baseCliPath ?? merged.cliPath ?? "claude")
    const runtime = await ensureAccountRuntime(account, base)
    Object.assign(merged, runtime, { baseCliPath: base })
  }

  return merged as ClaudeCodeProviderSettings
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * The `claude-code` settings the operator configured, as the provider set is
 * planned. This cannot come from the provider editor: opencode 2 applies the
 * config file's provider block through its own `opencode.config.provider`
 * plugin, after plugin transforms, so config overrides plugin defaults and a
 * plugin never sees it (measured on 2.0.11: `accounts` was absent from the
 * seed record). So it is read from the same on-disk layers opencode reads.
 *
 * Both config shapes are accepted, because V2 promises to keep reading V1
 * files: V1's `options` and V2's `settings`, the latter winning. The V2-native
 * home for plugin-level settings, the plugin's own `options` in the `plugins`
 * array, wins over both.
 */
export function configuredSeedSettings(
  config: Record<string, unknown>,
  pluginOptions: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const provider = plainObject(plainObject(config.provider)?.[BASE_PROVIDER_ID])
  return {
    ...(plainObject(provider?.options) ?? {}),
    ...(plainObject(provider?.settings) ?? {}),
    ...(pluginOptions ?? {}),
  }
}

/**
 * Whether `setup` is really running inside opencode 2. opencode 1.18 calls a
 * dual export's `setup` as well as its `server` (measured on 1.18.32), with its
 * own smaller v2-compat context that has no `provider` or `session` domain.
 * Registering anything there would put a second provider path next to the one
 * `server()` already built, so a context without every domain we use, or one
 * that names a 1.x version, gets nothing.
 */
export function isOpencodeV2Context(ctx: unknown): ctx is V2Context {
  const context = plainObject(ctx)
  if (!context) return false
  const version = plainObject(context.app)?.version
  if (typeof version === "string") {
    const major = Number.parseInt(version.replace(/^v/, ""), 10)
    if (Number.isFinite(major) && major < 2) return false
  }
  const hasHook = (domain: unknown, name: "transform" | "hook") =>
    typeof plainObject(domain)?.[name] === "function"
  return (
    hasHook(context.provider, "transform") &&
    hasHook(context.aisdk, "hook") &&
    hasHook(context.session, "hook")
  )
}

/**
 * What a command sends as the session's next message: the same text V1's
 * config template produces (`/<name> $ARGUMENTS`), so the language model's
 * existing `/btw` and doctor branches answer it unchanged.
 */
export function commandPromptText(command: string, args: string | undefined): string {
  const rest = (args ?? "").trim()
  return rest ? `/${command} ${rest}` : `/${command}`
}

/** The session a V2 `session.deleted` event names (`data.sessionID`). */
export function deletedSessionIdV2(event: V2Event | undefined): string | undefined {
  if (!event || event.type !== "session.deleted") return undefined
  const id = event.data?.sessionID
  return typeof id === "string" && id.length > 0 ? id : undefined
}

async function releaseDeletedSessions(
  subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<V2Event>,
  signal: AbortSignal,
): Promise<void> {
  try {
    for await (const event of subscribe({ signal })) {
      if (signal.aborted) break
      const sessionID = deletedSessionIdV2(event)
      if (!sessionID) continue
      const released = deleteActiveProcessesForSession(sessionID)
      if (released.length > 0) {
        log.info("released claude state for deleted session", { sessionID, released })
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      log.warn("opencode 2 event subscription ended; deleted sessions keep their claude process until idle eviction", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

export interface V2SetupDeps {
  /** `createClaudeCode`, passed in so this module never imports the entrypoint. */
  createProvider: (settings: ClaudeCodeProviderSettings) => {
    languageModel(modelId: string): LanguageModelV3
  }
  defaultProxyTools: readonly string[]
  /** The merged on-disk opencode config for a directory (`loadMergedOpencodeConfig`). */
  loadConfig: (directory: string) => Record<string, unknown>
  /**
   * V1's registry builder, reused so the same agents are eligible for
   * `forceModel`, `defaultSubagentModel` and `reasoningEffort` on both majors:
   * markdown agents on disk plus the config's `agent` block. Not V2's
   * `agent.list()`, which includes opencode's built-ins; those must never be
   * rewritten (src/agent-models.ts).
   */
  buildAgentRegistry?: (config: Record<string, unknown>) => Promise<void>
}

export function createV2Setup(deps: V2SetupDeps): (ctx: V2Context) => Promise<V2Cleanup> {
  return async (ctx) => {
    if (!isOpencodeV2Context(ctx)) {
      log.debug("setup called outside opencode 2; leaving it to server()", {
        version: (ctx as { app?: { version?: unknown } } | undefined)?.app?.version,
      })
      return () => undefined
    }
    ensureProcessExitCleanup()
    // The live-state calls (MCP status, tool registry, session lookups) are
    // answered in V1's shapes, so their callers need no V2 branch.
    setOpencodeClient(createV1ClientShim(ctx as unknown as V2ClientContext))
    const directory = ctx.location?.directory
    setOpencodeProjectDirectory(isUsableDirectory(directory) ? directory : undefined)

    if (deps.buildAgentRegistry) {
      try {
        const config = deps.loadConfig(directory ?? process.cwd())
        // V1's builder reads `provider.claude-code.options`; hand it the seed
        // settings in that slot whichever config shape they came from.
        await deps.buildAgentRegistry({
          ...config,
          provider: {
            ...(plainObject(config.provider) ?? {}),
            [BASE_PROVIDER_ID]: {
              options: configuredSeedSettings(config, plainObject(ctx.options)),
            },
          },
        })
      } catch (err) {
        log.warn("failed to build the agent registry for opencode 2", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const planned = new Map<string, Record<string, unknown>>()
    const registrations: V2Registration[] = []

    registrations.push(
      await ctx.provider.transform((editor) => {
        const seed = editor.get(BASE_PROVIDER_ID)
        // Whatever the editor already holds is plugin-level (ours from an
        // earlier pass, or another plugin's); the operator's config wins.
        const seedSettings = {
          ...(seed?.provider.settings ?? {}),
          ...configuredSeedSettings(
            deps.loadConfig(directory ?? process.cwd()),
            plainObject(ctx.options),
          ),
        }
        const plans = planV2Providers(seedSettings, deps.defaultProxyTools)
        planned.clear()

        for (const plan of plans) {
          planned.set(plan.info.id, plan.info.settings ?? {})
          if (editor.get(plan.info.id)) {
            editor.update(plan.info.id, (provider) => {
              provider.name = plan.info.name
              provider.activation = plan.info.activation
              provider.package = plan.info.package
              provider.settings = plan.info.settings
            })
            editor.models.set(plan.info.id, plan.models)
          } else {
            editor.add({ info: plan.info, models: plan.models })
          }
        }

        // An account expansion replaces the seed, exactly as V1 deletes it.
        if (seed && !plans.some((plan) => plan.info.id === BASE_PROVIDER_ID)) {
          editor.remove(BASE_PROVIDER_ID)
        }

        logStartupDiagnostics(
          Object.fromEntries(
            plans.map((plan) => [plan.info.id, { name: plan.info.name, options: plan.info.settings }]),
          ),
          ctx.app?.version,
        )
      }),
    )

    registrations.push(
      await ctx.aisdk.hook("sdk", async (event) => {
        const providerID = event.model.providerID
        if (!isClaudeCodeProviderId(providerID)) return
        const settings = await resolveSdkSettings(providerID, planned.get(providerID), event.options)
        event.sdk = deps.createProvider(settings)
        log.debug("v2 sdk created", { providerID, cliPath: settings.cliPath })
      }),
    )

    registrations.push(
      await ctx.session.hook("model.request", (event) => {
        if (!isClaudeCodeProviderId(event.model.providerID)) return
        event.headers[SESSION_AFFINITY_HEADER] = event.sessionID
        event.headers[OPENCODE_AGENT_HEADER] = agentForRequest(event.kind, event.agent)
      }),
    )

    // `/btw` and `/claude-code-doctor`. V1 injects templates into the user's
    // config and has to guard against clobbering a command of the same name;
    // here they are real commands, and the config's own commands are applied
    // after plugin transforms, so a user-defined one still wins.
    const prompt = ctx.session.prompt
    if (ctx.command?.transform && typeof prompt === "function") {
      const send = (
        input: V2CommandInvocation,
        command: string,
        delivery: V2Delivery,
      ): Promise<void> =>
        prompt
          .call(ctx.session, {
            ...input.prompt,
            sessionID: input.sessionID,
            text: commandPromptText(command, input.prompt.text),
            delivery,
          })
          .then(() => undefined)
      registrations.push(
        await ctx.command.transform((editor) => {
          editor.add({
            name: DOCTOR_COMMAND,
            description: DOCTOR_COMMAND_DESCRIPTION,
            execute: (input) => send(input, DOCTOR_COMMAND, input.delivery),
          })
          // Always queued. A `/btw` steered into a running turn becomes that
          // turn's next step, the one carrying the results of the tools opencode
          // just ran, and answering the aside there swallows the continuation
          // (the failure V1's hold exists to prevent). Queued, the aside branch
          // answers it from the idle process once the turn is over. V1's
          // answer-inside-the-running-turn needs a session-status route V2's
          // plugin session domain does not offer.
          editor.add({
            name: "btw",
            description: BTW_COMMAND_DESCRIPTION,
            execute: (input) => send(input, "btw", "queue"),
          })
        }),
      )
    }

    // The bundled `claude-code-plugin` skill, listed by opencode for every
    // provider. V1 adds its directory to the config's `skills.paths`; V2 has no
    // config hook, so it is registered directly. A skill of the same id that
    // opencode already found (the operator's own copy) is left alone.
    const bundledSkills = readBundledSkillInfos()
    if (typeof ctx.skill?.transform === "function" && bundledSkills.length > 0) {
      registrations.push(
        await ctx.skill.transform((editor) => {
          const added: string[] = []
          for (const skill of bundledSkills) {
            if (editor.get(skill.id)) continue
            editor.add(skill)
            added.push(skill.id)
          }
          log.debug("v2 bundled skills registered", { added })
        }),
      )
    }

    // Release a deleted session's `claude` child, proxy server and session id
    // at once, as V1's `event` hook does.
    const events = new AbortController()
    if (typeof ctx.event?.subscribe === "function") {
      void releaseDeletedSessions(ctx.event.subscribe.bind(ctx.event), events.signal)
    }

    log.info("claude-code plugin set up for opencode 2", {
      opencode: ctx.app?.version,
      directory,
    })

    return async () => {
      events.abort()
      for (const registration of registrations.splice(0)) {
        await registration.dispose().catch(() => undefined)
      }
    }
  }
}
