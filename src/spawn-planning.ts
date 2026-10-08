/**
 * Spawn planning: what a single `claude` spawn gets before it starts.
 * Which `--mcp-config` files, which proxy tool definitions, what opencode's
 * live tool registry says, which config dir the skill bridge reads, whether
 * the plan-mode approval bridge is live, and the proxy MCP server itself.
 *
 * Split out of `claude-code-language-model.ts` verbatim. These were private
 * methods whose only use of `this` was `this.config` (and `this.modelId` in
 * the registry fetch), so they take those as arguments now and the class
 * delegates to them with its original signatures.
 */
import type { ClaudeCodeConfig } from "./types.js"
import { shouldStripContextReminders } from "./message-builder.js"
import { accountConfigDirPath } from "./accounts.js"
import type { FailoverSpawn } from "./account-failover.js"
import { isPlanModeQuestionActive } from "./plan-mode-question.js"
import { bridgeOpencodeMcp, type RuntimeMcpStatus } from "./mcp-bridge.js"
import {
  fetchOpencodeToolList,
  type OpencodeToolListItem,
} from "./runtime-status.js"
import { storeCompressionSummary } from "./compression-store.js"
import {
  cancelBackgroundTask,
  collectBackgroundTask,
  TASK_CANCEL_TOOL_NAME,
  TASK_STATUS_TOOL_NAME,
} from "./background-tasks.js"
import {
  createProxyMcpServer,
  resolveMcpProxyToolDefs,
  DEFAULT_PROXY_TOOLS,
  TASK_BATCH_TOOL_NAME,
  type McpProxyToolResolution,
  type ModelToolEntry,
  type ProxyMcpServer,
  type ProxyToolCall,
  type ProxyToolDef,
  type ProxyToolInterceptor,
} from "./proxy-mcp.js"
import { queuePendingProxyCall } from "./proxy-broker.js"
import { log } from "./logger.js"

/** One per-turn snapshot of opencode's live tool registry. */
export interface LiveToolInfo {
  /** False when nothing answered (no SDK client, fetch failed). */
  resolved: boolean
  taskDescription: string | undefined
  /**
   * opencode's JSON Schema for its own `task` tool. The background gate reads
   * it (`liveTaskSupportsBackground`): the presence of a `background` property
   * is how a 1.x host publishes whether it will run one.
   */
  taskParameters: Record<string, unknown> | undefined
  questionDescription: string | undefined
  hasQuestion: boolean
  /**
   * The raw registry entries behind the fields above, so `proxyOpencodeTools`
   * can be resolved from the same single fetch rather than a second one.
   */
  items?: OpencodeToolListItem[]
}

/**
 * Build the combined `--mcp-config` list and return both the list and the
 * hash of the bridged opencode MCP block (or null when bridging is off /
 * yields nothing). The hash is used to detect mid-session config changes
 * and respawn the underlying claude process.
 *
 * `runtimeStatus` is a snapshot of opencode's `client.mcp.status()`. When
 * provided it overlays opencode's UI-toggled state on top of disk config
 * so `/mcps` toggles propagate without a config file write.
 */
export function effectiveMcpConfig(
  config: ClaudeCodeConfig,
  cwd: string,
  proxyConfigPath?: string,
  runtimeStatus?: RuntimeMcpStatus,
  excludeServers?: ReadonlySet<string>,
): {
  paths: string[]
  bridgedHash: string | null
  allEnabledServerNames: string[]
} {
  const paths = Array.isArray(config.mcpConfig)
    ? config.mcpConfig.slice()
    : config.mcpConfig
      ? [config.mcpConfig]
      : []
  let bridgedHash: string | null = null
  let allEnabledServerNames: string[] = []
  if (config.bridgeOpencodeMcp !== false) {
    const bridged = bridgeOpencodeMcp(cwd, runtimeStatus, excludeServers, config.hostApi, {
      oauthTokens: config.bridgeMcpOauthTokens === true,
    })
    if (bridged) {
      if (bridged.path) paths.push(bridged.path)
      bridgedHash = bridged.hash
      allEnabledServerNames = bridged.allEnabledServerNames
    }
  }
  if (proxyConfigPath) paths.push(proxyConfigPath)
  return { paths, bridgedHash, allEnabledServerNames }
}

/** Resolve ProxyToolDef[] for the configured proxyTools names. */
export function resolvedProxyTools(
  config: ClaudeCodeConfig,
): ProxyToolDef[] | null {
  const names = config.proxyTools
  if (!names || names.length === 0) return null
  const defsByName = new Map(
    DEFAULT_PROXY_TOOLS.map((t) => [t.name.toLowerCase(), t]),
  )
  const picked: ProxyToolDef[] = []
  const seen = new Set<string>()
  const unknown: string[] = []
  const pick = (def: ProxyToolDef) => {
    if (seen.has(def.name)) return
    seen.add(def.name)
    picked.push(def)
  }
  for (const n of names) {
    const def = defsByName.get(String(n).toLowerCase())
    if (!def) {
      unknown.push(String(n))
      continue
    }
    pick(def)
    // `task_batch` rides along with `task`: it is the same dispatch path for
    // two or more subagents at once (TASK_BATCH_PROXY_NOTE), and a
    // `proxyTools` list that names `Task` should not have to know it exists.
    if (def.name === "task") {
      const batch = defsByName.get(TASK_BATCH_TOOL_NAME)
      if (batch) pick(batch)
    }
  }
  // A typo used to vanish here. Silence is the wrong response: unknown
  // names are not proxied, so the matching Claude built-in stays enabled
  // and unmediated, and if *every* name is unknown the whole turn runs
  // with no proxy at all (issue #26).
  if (unknown.length > 0) {
    const known = [...defsByName.keys()].join(", ")
    if (picked.length === 0) {
      log.warn(
        "no proxyTools entry was recognised; nothing will be proxied this turn",
        { unknown, known },
      )
    } else {
      log.warn("ignoring unknown proxyTools entries", { unknown, known })
    }
  }
  return picked.length > 0 ? picked : null
}

/** Where one opencode MCP server goes for this spawn. */
export type McpServerRoute = "proxy" | "withhold" | "bridge"

/**
 * The per-server decision, with `proxyOpencodeMcpTools` on. Pure.
 *
 *  - `proxy`: a def was built for at least one of its tools, so opencode runs
 *    it and the proxy serves it. Unchanged.
 *  - `withhold`: none of its tools is in this agent's tool set, and opencode
 *    reports it `connected`. opencode has the server and chose not to give it
 *    to this agent (an `explore` subagent gets no MCP tools at all), so the
 *    spawn leaves it out of `--mcp-config` entirely. Bridging it would hand the
 *    agent a server opencode withheld, and make its `claude` start its own copy
 *    of every such server before `system/init`: measured on 2.1.293, 31.5 s
 *    against 2.1 s for a subagent whose bridged `slack` and `obsidian` both
 *    ended `failed` in the child.
 *  - `bridge`: everything else. A server with a tool in the set that is not
 *    covered (every tool collided with a name another proxy tool holds) was
 *    granted to the agent, and a server opencode is NOT running (`pending`,
 *    absent from the status map, no status map at all) has nobody else to run
 *    it. That is what the direct-bridge fallback was always for. A `failed`,
 *    `needs_auth` or `disabled` server is also `bridge` here, and the runtime
 *    overlay in `mergeOpencodeMcp` then drops it before anything is written,
 *    exactly as before.
 *
 * `toolSetKnown` false means withholding is not decided from this tool set at
 * all: no tools array, or V2 Code Mode, where MCP tools reach the agent
 * through the aggregate `execute` runner rather than as individual entries, so
 * their absence says nothing about what opencode granted.
 */
export function decideMcpServerRoute(input: {
  covered: boolean
  inToolSet: boolean
  status: string | undefined
  toolSetKnown: boolean
}): McpServerRoute {
  if (input.covered) return "proxy"
  if (input.inToolSet) return "bridge"
  if (input.toolSetKnown && input.status === "connected") return "withhold"
  return "bridge"
}

/** What `resolvedProxyMcpTools` decided for every enabled server this spawn. */
export interface McpServerRouting {
  /** The proxy defs and the servers they cover. Empty when nothing matched. */
  resolution: McpProxyToolResolution
  /** Connected in opencode, granted no tools: left out of this spawn. */
  withheld: string[]
  /** Not covered and not withheld: on the direct bridge, as before. */
  bridged: string[]
  /**
   * What `effectiveMcpConfig` must leave out of `--mcp-config`: the covered
   * servers plus the withheld ones. Undefined when there is nothing to leave
   * out, so the bridge is called exactly as it was without the option.
   */
  excludeServers: ReadonlySet<string> | undefined
}

/**
 * Resolve ProxyToolDef[] for opencode's MCP-backed tools so they go
 * through the in-process proxy instead of being bridged into Claude CLI's
 * `--mcp-config`, and decide per server what happens to the rest
 * (`decideMcpServerRoute`). Routing through the proxy keeps a single
 * execution site (opencode), so the call is permission-prompted and rendered
 * as an opencode tool call.
 *
 * Opt-in (`proxyOpencodeMcpTools: true`) and off by default. It used to
 * default to true while finding nothing, because it discovered tools via
 * `client.tool.list()`, which enumerates opencode's `ToolRegistry` and not
 * the MCP tools merged into the model's tool set afterwards. Discovery now
 * reads that merged set, the `tools` array opencode passes `doStream`, so
 * the option does what it says. Turning it on by default at the same time
 * would have silently moved every existing user's MCP traffic off the
 * working direct bridge, so the default went to false instead: today's
 * behaviour is preserved exactly and crossing over is the operator's call.
 * With it off nothing here runs and every enabled server is bridged, which
 * is also why withholding is part of this option and not of the bridge.
 *
 * Returns null when the feature is off, which leaves every server on the
 * direct bridge.
 */
export function resolvedProxyMcpTools(
  config: ClaudeCodeConfig,
  allEnabledServerNames: string[],
  modelTools: readonly ModelToolEntry[] | undefined,
  taken?: ReadonlySet<string>,
  runtimeStatus?: RuntimeMcpStatus,
): McpServerRouting | null {
  if (config.proxyOpencodeMcpTools !== true) return null
  if (config.bridgeOpencodeMcp === false) return null
  if (allEnabledServerNames.length === 0) return null

  const resolution = resolveMcpProxyToolDefs({
    serverNames: allEnabledServerNames,
    tools: modelTools,
    taken,
  })
  const codeMode =
    config.hostApi === "v2" && (modelTools?.some((tool) => tool.name === "execute") ?? false)
  const toolSetKnown = (modelTools?.length ?? 0) > 0 && !codeMode

  const withheld: string[] = []
  const bridged: string[] = []
  for (const server of allEnabledServerNames) {
    const route = decideMcpServerRoute({
      covered: resolution.coveredServers.has(server),
      inToolSet: resolution.matchedServers.has(server),
      status: runtimeStatus?.[server],
      toolSetKnown,
    })
    if (route === "withhold") withheld.push(server)
    else if (route === "bridge") bridged.push(server)
  }

  if (codeMode && resolution.defs.length === 0) {
    // WARN: an operator who opted in on V2 Code Mode gets none of what the
    // option is for, and the fix is a config change only they can make.
    log.warn(
      "proxyOpencodeMcpTools cannot route V2 Code Mode's MCP tools, which reach the" +
        " model through execute; for Code Mode, explicitly allowlist execute in" +
        " proxyOpencodeTools and use bridgeOpencodeMcp: false with strictMcpConfig: true",
      { servers: allEnabledServerNames },
    )
  }
  if (withheld.length > 0 || bridged.length > 0) {
    // INFO, never WARN: a subagent opencode gives no MCP tools is the ordinary
    // case and happens on every such spawn, and inside a TUI a WARN is a toast
    // (h #g193). The line is still what tells the operator which servers this
    // agent was not given and which ones still go direct.
    log.info("proxyOpencodeMcpTools: MCP servers outside this agent's tool set", {
      proxied: [...resolution.coveredServers],
      withheld,
      bridged,
      modelTools: modelTools?.length ?? 0,
      statusKnown: runtimeStatus !== undefined,
    })
  } else {
    log.debug("routing opencode MCP tools through the proxy", {
      servers: [...resolution.coveredServers],
      tools: resolution.defs.map((def) => def.name),
    })
  }

  const exclude = new Set<string>([...resolution.coveredServers, ...withheld])
  return {
    resolution,
    withheld,
    bridged,
    excludeServers: exclude.size > 0 ? exclude : undefined,
  }
}

/**
 * Live tool info derived from a single `client.tool.list()` fetch:
 *
 * - `taskDescription`: opencode's `task` tool description exactly as the
 *   registry renders it for native models, including the "Available
 *   agent types" list. Overlaid onto the static `task` proxy def so
 *   Claude sees the same subagent catalog native models see, instead
 *   of hunting through config files.
 * - `questionDescription` / `hasQuestion`: opencode's `question` tool
 *   description and whether the registry has the entry at all. Older
 *   builds lack it, in which case a `mcp__opencode_proxy__question`
 *   call resolves to `⚙ invalid`; the version gate drops the def.
 *
 * Returns undefined/false when the SDK client is unavailable (direct
 * AI-SDK use, tests) so the static defs stand. `resolved` distinguishes
 * "the registry answered and has no `question` entry" from "nobody
 * answered": only the former is a real version-gate signal.
 */
export async function fetchLiveToolInfo(
  config: ClaudeCodeConfig,
  modelId: string,
): Promise<LiveToolInfo> {
  const items = await fetchOpencodeToolList(
    config.provider,
    modelId,
    config.cwd,
  )
  const question = items?.find((item) => item.id === "question")
  const task = items?.find((item) => item.id === "task")
  return {
    resolved: items !== undefined,
    taskDescription: task?.description,
    taskParameters: task?.parameters,
    questionDescription: question?.description,
    hasQuestion: !!question,
    items,
  }
}

/**
 * Whether dcp-style context reminders should be stripped from this turn's
 * messages. Config-only and synchronous, so it can be answered before the
 * spawn block resolves anything: `userMsg` is built well ahead of it.
 */
export function stripContextRemindersEnabled(
  config: ClaudeCodeConfig,
): boolean {
  return shouldStripContextReminders({
    enabled: config.stripContextReminders,
    proxyTools: config.proxyTools,
    proxyOpencodeTools: config.proxyOpencodeTools,
  })
}

/**
 * Arguments the skill bridge needs beyond `cwd` / `cliPath`: which
 * `CLAUDE_CONFIG_DIR` this spawn reads its native skills from, and whether
 * to drop the ones it already loads. A failover moves the spawn to another
 * account, and therefore to that account's config dir.
 */
export function skillBridgeSpawn(
  config: ClaudeCodeConfig,
  failover: FailoverSpawn,
): {
  configDir: string | undefined
  skipNative: boolean
} {
  return {
    configDir:
      failover.failedOver && failover.target
        ? accountConfigDirPath(failover.target)
        : config.configDir,
    skipNative: config.bridgeSkipNativeSkills !== false,
  }
}

/** Share one lazy registry request within a turn without making it stale. */
export function createLiveToolInfoLoader(
  config: ClaudeCodeConfig,
  modelId: string,
): () => Promise<LiveToolInfo> {
  let pending: Promise<LiveToolInfo> | undefined
  return () => {
    pending ??= fetchLiveToolInfo(config, modelId)
    return pending
  }
}

/**
 * Whether the ExitPlanMode approval bridge is live for this turn: the
 * operator opted in AND opencode's registry actually has the `question`
 * tool. Without the registry entry the emitted tool-call would render as
 * `⚙ invalid` and wedge the turn, so the plugin keeps the text path.
 */
export async function resolvePlanModeQuestion(
  config: ClaudeCodeConfig,
  compactionMode: boolean,
  loadLiveToolInfo: () => Promise<LiveToolInfo>,
): Promise<boolean> {
  if (compactionMode || config.planModeQuestion !== true) return false
  const info = await loadLiveToolInfo()
  const active = isPlanModeQuestionActive({
    configured: config.planModeQuestion,
    opencodeHasQuestion: info.hasQuestion,
    compactionMode,
  })
  if (!active) {
    // Same reasoning as the question proxy's version-gate log: a silent
    // fallback to the text path looks from the outside like the setting
    // was ignored.
    log.info("plan-mode question gate", {
      opencodeHasQuestion: info.hasQuestion,
      registryResolved: info.resolved,
      active,
    })
  }
  return active
}

/**
 * Create a proxy MCP server for a single active Claude process/session.
 * The process lifecycle owns the server lifecycle via session-manager.
 */
export async function ensureProxyServer(
  config: ClaudeCodeConfig,
  tools: ProxyToolDef[],
  sessionKeyForCalls: string,
  // Whether the `compress` in `tools` is the PLUGIN's def rather than
  // opencode's forwarded one. Keying the interceptor on the name alone
  // would answer a forwarded `compress` in-process and opencode would
  // never see the call: the same name, the wrong tool, silently. The
  // caller knows which list the def came from, so it decides.
  interceptCompress: boolean,
  // The opencode session this Claude conversation serves, so a background
  // collect or cancel can refuse a task that is not this conversation's.
  // Undefined outside a real opencode turn (direct AI-SDK use, tests).
  callerSessionId?: string,
): Promise<ProxyMcpServer> {
  const timeoutOverrides = config.proxyToolTimeoutMs
  const interceptors = new Map<string, ProxyToolInterceptor>()
  // Background collect/cancel act on opencode's session state, not on the
  // workspace, and opencode has no tools of these names to execute, so they
  // are answered in-process like `compress` rather than queued for the host.
  // Registered only when the def survived the capability gate.
  if (tools.some((t) => t.name === TASK_STATUS_TOOL_NAME)) {
    const opts = { sessionKey: sessionKeyForCalls, callerSessionId }
    interceptors.set(TASK_STATUS_TOOL_NAME, (input) => collectBackgroundTask(input, opts))
    interceptors.set(TASK_CANCEL_TOOL_NAME, (input) => cancelBackgroundTask(input, opts))
  }
  if (interceptCompress && tools.some((t) => t.name === "compress")) {
    interceptors.set("compress", (input) => {
      const summary = typeof input.summary === "string" ? input.summary.trim() : ""
      if (!summary) {
        return {
          kind: "error",
          message:
            "compress needs a non-empty `summary`: it becomes the only" +
            " prior context after the reset. Nothing was compressed.",
        }
      }
      storeCompressionSummary(sessionKeyForCalls, summary)
      log.info("compress stored summary; session resets next turn", {
        sessionKey: sessionKeyForCalls,
        summaryLength: summary.length,
      })
      return {
        kind: "text",
        text:
          "Summary stored. Finish this turn as normal; the next turn starts" +
          " a fresh Claude Code session with this summary as its only prior" +
          " context.",
      }
    })
  }
  const srv = await createProxyMcpServer(tools, timeoutOverrides, interceptors)
  srv.calls.on("call", (call: ProxyToolCall) => {
    queuePendingProxyCall(sessionKeyForCalls, call, timeoutOverrides)
  })
  return srv
}
