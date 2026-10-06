/**
 * Whether a turn may move its conversation onto a `claude` process spawned
 * with the current opencode MCP server set, and what changed if so.
 *
 * The bridged config is content-addressed (`effectiveMcpConfig` /
 * `bridgedHash`), so a changed hash is the whole signal. What this module
 * adds is the boundary: a reused process may only be replaced on a fresh
 * user turn with nothing of the previous one still in the air. Everything
 * here is pure except the cooldown ledger, which is what keeps a server that
 * flaps from buying a respawn on every turn.
 */
import { log } from "./logger.js"

/**
 * Minimum gap between two hot-reload respawns of one conversation. A server
 * that flaps (connected, failed, connected) otherwise costs a kill and a
 * `--resume` spawn on every single turn, which is far more expensive than
 * running one turn with a tool set that is one server out of date. A real
 * second change is not lost, it lands on the first turn after the gap.
 */
export const DEFAULT_MCP_HOT_RELOAD_COOLDOWN_MS = 60_000

/**
 * Same shape as `MAX_CLAUDE_SESSION_ENTRIES`: the ledger is keyed by session
 * key and nothing in the ordinary lifecycle removes an entry, so it is capped
 * rather than left to grow under a long-lived `opencode serve`.
 */
const MAX_COOLDOWN_ENTRIES = 64

const lastReloadAt = new Map<string, number>()

export function resolveMcpHotReloadCooldownMs(): number {
  const raw = process.env.CLAUDE_CODE_MCP_HOT_RELOAD_COOLDOWN_MS
  if (raw === undefined) return DEFAULT_MCP_HOT_RELOAD_COOLDOWN_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_MCP_HOT_RELOAD_COOLDOWN_MS
  }
  return parsed
}

/** Record that a conversation just paid for a hot-reload respawn. */
export function noteMcpHotReload(sessionKey: string, now = Date.now()): void {
  lastReloadAt.delete(sessionKey)
  lastReloadAt.set(sessionKey, now)
  while (lastReloadAt.size > MAX_COOLDOWN_ENTRIES) {
    const oldest = lastReloadAt.keys().next()
    if (oldest.done) break
    lastReloadAt.delete(oldest.value)
  }
}

/** Test seam, and the reset a fresh plugin load wants. */
export function _resetMcpHotReloadState(): void {
  lastReloadAt.clear()
}

export type McpHotReloadVerdict =
  /** The feature is off, or the bridge is. */
  | "off"
  /** Nothing to replace: this turn is spawning anyway. */
  | "no-process"
  /** A one-shot `/compact` spawn, which never reuses a process. */
  | "skipped-compaction"
  /** The bridged server set is what the live process already has. */
  | "unchanged"
  /** A proxied call is still in the air; replacing the process would lose it. */
  | "deferred-proxy-calls"
  /** The live process is still working on a turn. */
  | "deferred-turn-in-flight"
  /** An ExitPlanMode approval is outstanding on this conversation. */
  | "deferred-plan-question"
  /** Changed again too soon after the last respawn; see the cooldown. */
  | "skipped-cooldown"
  /** Replace the process. */
  | "reload"

export interface McpHotReloadDecision {
  verdict: McpHotReloadVerdict
  reload: boolean
  /** Enabled server names the live process does not have. */
  joined: string[]
  /** Server names the live process has and opencode no longer enables. */
  left: string[]
}

export interface McpHotReloadInput {
  sessionKey: string
  /** `hotReloadMcp !== false && bridgeOpencodeMcp !== false`. */
  enabled: boolean
  hasActiveProcess: boolean
  compactionMode: boolean
  /**
   * Which transport the live process uses. Informational since #g200: the
   * PTY shim reports a real exit code and a fresh spawn resumes with
   * `--resume`, so a reload works the same on both.
   */
  interactive: boolean
  turnInFlight: boolean
  pendingProxyCalls: number
  planQuestionPending: boolean
  previousHash: string | null | undefined
  currentHash: string | null
  previousServers: readonly string[] | undefined
  currentServers: readonly string[]
  now?: number
  cooldownMs?: number
}

function difference(a: readonly string[], b: readonly string[]): string[] {
  const other = new Set(b)
  return a.filter((name) => !other.has(name)).sort()
}

/**
 * The verdict order is the point. "unchanged" is decided before every safety
 * gate, so an ordinary turn never logs a deferral it was never a candidate
 * for, and the gates are only consulted once something really did change.
 */
export function decideMcpHotReload(
  input: McpHotReloadInput,
): McpHotReloadDecision {
  const previousServers = input.previousServers ?? []
  const joined = difference(input.currentServers, previousServers)
  const left = difference(previousServers, input.currentServers)
  const decide = (verdict: McpHotReloadVerdict): McpHotReloadDecision => ({
    verdict,
    reload: verdict === "reload",
    joined,
    left,
  })

  if (!input.enabled) return decide("off")
  if (input.compactionMode) return decide("skipped-compaction")
  if (!input.hasActiveProcess) return decide("no-process")

  const previousHash = input.previousHash ?? null
  if (previousHash === input.currentHash) return decide("unchanged")

  if (input.pendingProxyCalls > 0) return decide("deferred-proxy-calls")
  if (input.turnInFlight) return decide("deferred-turn-in-flight")
  if (input.planQuestionPending) return decide("deferred-plan-question")

  const cooldownMs = input.cooldownMs ?? resolveMcpHotReloadCooldownMs()
  const last = lastReloadAt.get(input.sessionKey)
  if (cooldownMs > 0 && last !== undefined) {
    const now = input.now ?? Date.now()
    if (now - last < cooldownMs) return decide("skipped-cooldown")
  }

  return decide("reload")
}

/**
 * One INFO line per decision that is worth reading, naming the servers rather
 * than the hashes: an operator asking why Claude cannot see a server they just
 * connected needs the name, and `joined` / `left` is the answer. Verdicts that
 * mean "there was nothing to do" say nothing at all.
 */
export function logMcpHotReloadDecision(
  decision: McpHotReloadDecision,
  context: {
    sessionKey: string
    previousHash: string | null | undefined
    currentHash: string | null
  },
): void {
  if (
    decision.verdict === "off" ||
    decision.verdict === "no-process" ||
    decision.verdict === "skipped-compaction" ||
    decision.verdict === "unchanged"
  ) {
    return
  }
  const details = {
    sk: context.sessionKey,
    joined: decision.joined,
    left: decision.left,
    previousHash: context.previousHash ?? null,
    currentHash: context.currentHash,
  }
  if (decision.reload) {
    log.info("opencode MCP servers changed, respawning claude", details)
    return
  }
  log.info(`opencode MCP servers changed; holding off (${decision.verdict})`, details)
}
