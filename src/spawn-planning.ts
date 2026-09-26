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
    const bridged = bridgeOpencodeMcp(cwd, runtimeStatus, excludeServers)
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

/**
 * Resolve ProxyToolDef[] for opencode's MCP-backed tools so they go
 * through the in-process proxy instead of being bridged into Claude CLI's
 * `--mcp-config`. Routing through the proxy keeps a single execution site
 * (opencode), so the call is permission-prompted and rendered as an
 * opencode tool call.
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
 *
 * Returns null when the feature is off or nothing matched, which leaves
 * every server on the direct bridge.
 */
export function resolvedProxyMcpTools(
  config: ClaudeCodeConfig,
  allEnabledServerNames: string[],
  modelTools: readonly ModelToolEntry[] | undefined,
  taken?: ReadonlySet<string>,
): McpProxyToolResolution | null {
  if (config.proxyOpencodeMcpTools !== true) return null
  if (config.bridgeOpencodeMcp === false) return null
  if (allEnabledServerNames.length === 0) return null

  const resolution = resolveMcpProxyToolDefs({
    serverNames: allEnabledServerNames,
    tools: modelTools,
    taken,
  })
  if (resolution.defs.length === 0) {
    // WARN, not NOTICE: only warn and error are alwaysStderr in
    // src/logger.ts, so a NOTICE would be invisible to the very operator
    // who opted in and is entitled to know their MCP calls are still
    // going direct, and so still are not permission-prompted by opencode.
    log.warn(
      "proxyOpencodeMcpTools is on but no MCP tool was found in opencode's" +
        " tool set; those servers stay on the direct bridge this spawn",
      { servers: allEnabledServerNames, modelTools: modelTools?.length ?? 0 },
    )
    return null
  }
  log.debug("routing opencode MCP tools through the proxy", {
    servers: [...resolution.coveredServers],
    tools: resolution.defs.map((def) => def.name),
  })
  return resolution
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
  return {
    resolved: items !== undefined,
    taskDescription: items?.find((item) => item.id === "task")?.description,
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
): Promise<ProxyMcpServer> {
  const timeoutOverrides = config.proxyToolTimeoutMs
  const interceptors = new Map<string, ProxyToolInterceptor>()
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
