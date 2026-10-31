import { loginCommandFor } from "./account-failover.js"
import { BASE_PROVIDER_ID, accountConfigDirPath, ensureAccountRuntime } from "./accounts.js"
import {
  checkClaudeLogin,
  loginProblem,
  loginSummary,
  type ClaudeLoginState,
} from "./claude-login.js"
import { log } from "./logger.js"
import type {
  V2Event,
  V2IntegrationDomain,
  V2IntegrationEditor,
} from "./opencode-v2-types.js"

/**
 * opencode 2's `/connect` entry for each Claude Code provider (h #g277).
 *
 * opencode 2.2.5 creates an integration for every provider, with the
 * provider's id, and gives one that declares no way to connect a single
 * method: "Manually enter API Key". The plugin never reads a stored key (the
 * Claude CLI holds the login), so that entry was a dead end, listed under the
 * raw id `claude-code`. Here each provider's entry gets its own name and one
 * `external` method, the shape opencode's built-in Claude Agent provider uses:
 * connecting records only that the operator chose it, never a token. What
 * connecting does is run `claude auth status` the way a turn would run
 * `claude`, mark the connection "Sign in required" when the CLI is missing or
 * logged out, and answer with one toast that names the login method or the
 * one command that fixes it.
 */
export const CONNECT_METHOD_ID = "claude-code-cli"
export const CONNECT_METHOD_LABEL = "Claude Code login (checked with claude auth status)"
/** The seed's entry when `accounts` replaced it: connect an account instead. */
export const SEED_INTEGRATION_NAME = "Claude Code (connect one of its accounts)"

export interface ConnectTarget {
  /** The provider id, which opencode 2 also gives the provider's integration. */
  id: string
  /** The provider's display name, so `/connect` and the picker agree. */
  name: string
  /** The planned provider settings: `cliPath`, `account`, `baseCliPath`, ... */
  settings: Record<string, unknown>
}

/**
 * Give each provider's integration its name and method. The editor holds only
 * what plugins declared, never the entry opencode derives from a provider
 * (`get` answers undefined for it on 2.2.5), and `update` creates the record:
 * once an integration declares a method, opencode stops offering the derived
 * API key one. Another plugin's methods on the same id are left alone.
 */
export function applyConnectEntries(
  editor: V2IntegrationEditor,
  targets: readonly ConnectTarget[],
): string[] {
  // With `accounts`, the seed provider is replaced by one per account, but the
  // config's `provider.claude-code` block still gives opencode an integration
  // of that id, offering the API key method. A record with no method leaves
  // it listed and disabled, which is what it is.
  if (!targets.some((target) => target.id === BASE_PROVIDER_ID)) {
    editor.update(BASE_PROVIDER_ID, (integration) => {
      integration.name = SEED_INTEGRATION_NAME
    })
  }
  for (const target of targets) {
    editor.update(target.id, (integration) => {
      integration.name = target.name
    })
    editor.method.update({
      integrationID: target.id,
      method: { id: CONNECT_METHOD_ID, type: "external", label: CONNECT_METHOD_LABEL },
    })
  }
  return targets.map((target) => target.id)
}

function targetAccount(target: ConnectTarget): string | undefined {
  return typeof target.settings.account === "string" ? target.settings.account : undefined
}

/** The command that logs this provider's account in. */
export function loginCommandForTarget(target: ConnectTarget): string {
  const account = targetAccount(target)
  return loginCommandFor(account ? accountConfigDirPath(account) : undefined)
}

/** The check for one provider: its binary or account wrapper, its environment. */
export async function checkTargetLogin(target: ConnectTarget): Promise<ClaudeLoginState> {
  const base = String(target.settings.baseCliPath ?? target.settings.cliPath ?? "claude")
  const account = targetAccount(target)
  let cliPath = base
  let configDir: string | undefined
  if (account) {
    const runtime = await ensureAccountRuntime(account, base)
    cliPath = runtime.cliPath
    if (runtime.accountInProcess) configDir = runtime.configDir
  }
  return checkClaudeLogin({
    cliPath,
    configDir,
    ignoreAnthropicApiKey: target.settings.ignoreAnthropicApiKey === true,
  })
}

/**
 * opencode 2 sets the plugin up once per location, all in one process, and
 * every location's subscription sees the same credential event. One check and
 * one toast answer all of them: checks are shared per connection for a few
 * seconds, and a connection is announced once. A connect always makes a new
 * connection (measured on 2.2.5: "Claude Code", "Claude Code 2", ...), so the
 * operator who logs in and connects again always gets a fresh check.
 */
export const CONNECT_COALESCE_MS = 5_000
const MAX_ANNOUNCED = 256

const recentChecks = new Map<string, { at: number; result: Promise<ClaudeLoginState> }>()
const announced = new Set<string>()

export function _resetConnectChecksForTests(): void {
  recentChecks.clear()
  announced.clear()
}

function coalescedCheck(
  key: string,
  target: ConnectTarget,
  check: (target: ConnectTarget) => Promise<ClaudeLoginState>,
  now: number,
): Promise<ClaudeLoginState> {
  const recent = recentChecks.get(key)
  if (recent && now - recent.at < CONNECT_COALESCE_MS) return recent.result
  for (const [old, entry] of recentChecks) {
    if (now - entry.at >= CONNECT_COALESCE_MS) recentChecks.delete(old)
  }
  const result = check(target).catch(
    (err): ClaudeLoginState => ({ status: "failed", reason: err instanceof Error ? err.message : String(err) }),
  )
  recentChecks.set(key, { at: now, result })
  return result
}

/** True the first time a key is seen; bounded, oldest forgotten first. */
function firstAnnouncement(key: string): boolean {
  if (announced.has(key)) return false
  announced.add(key)
  if (announced.size > MAX_ANNOUNCED) {
    const oldest = announced.values().next().value
    if (oldest !== undefined) announced.delete(oldest)
  }
  return true
}

export interface ConnectWiring {
  integration: V2IntegrationDomain
  /** The providers this location publishes, read when an event arrives. */
  targets: () => readonly ConnectTarget[]
  /** One toast in the TUI. */
  notify: (level: "success" | "warn", message: string) => void
  /** Seams for tests. */
  check?: (target: ConnectTarget) => Promise<ClaudeLoginState>
  now?: () => number
}

/**
 * Check one provider and put the answer on its active connection: a problem
 * marks it "Sign in required", a login clears that, and a failed check leaves
 * it as it was, because it says nothing about the login. `connected` is the
 * credential a connect just made, and is what gets announced; without it the
 * check is silent, and with no connection nothing is spawned at all, so an
 * operator who never used `/connect` pays nothing.
 */
export async function refreshConnection(
  wiring: ConnectWiring,
  target: ConnectTarget,
  connected?: string,
): Promise<ClaudeLoginState | undefined> {
  const connection = await wiring.integration.connection.active(target.id).catch(() => undefined)
  if (!connection && connected === undefined) return undefined
  const now = (wiring.now ?? Date.now)()
  const key = `${target.id}:${connected ?? connection?.id ?? connection?.type ?? "none"}`
  const state = await coalescedCheck(key, target, wiring.check ?? checkTargetLogin, now)
  const command = loginCommandForTarget(target)
  if (connection && state.status !== "failed") {
    await wiring.integration.connection
      .status({ integrationID: target.id, connection, status: loginProblem(state, command) })
      .catch((err) =>
        log.debug("opencode refused the connection status", {
          provider: target.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
  }
  if (connected !== undefined && firstAnnouncement(key)) {
    log.info("checked the claude login for /connect", { provider: target.id, status: state.status })
    const summary = loginSummary(state, target.name, command)
    wiring.notify(summary.level, summary.message)
  }
  return state
}

/** The integration a `credential.switched` event names: what connecting (or picking a connection) emits. */
export function switchedCredential(
  event: V2Event,
): { integrationID: string; credentialID: string } | undefined {
  if (event.type !== "credential.switched") return undefined
  const data = event.data as Record<string, unknown> | undefined
  const integrationID = data?.integrationID
  const credentialID = data?.credentialID
  if (typeof integrationID !== "string" || typeof credentialID !== "string") return undefined
  return { integrationID, credentialID }
}

/**
 * Answer every connect of one of this plugin's providers, until `signal`
 * aborts. Never throws: a feed that ends only stops the answers.
 */
export async function followConnectEvents(
  subscribe: (options: { signal?: AbortSignal }) => AsyncIterable<V2Event>,
  signal: AbortSignal,
  wiring: ConnectWiring,
): Promise<void> {
  try {
    for await (const event of subscribe({ signal })) {
      if (signal.aborted) break
      const switched = switchedCredential(event)
      if (!switched) continue
      const target = wiring.targets().find((candidate) => candidate.id === switched.integrationID)
      if (target) void refreshConnection(wiring, target, switched.credentialID).catch(() => undefined)
    }
  } catch (err) {
    if (!signal.aborted) {
      log.debug("opencode 2 credential events ended; /connect checks stop", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
