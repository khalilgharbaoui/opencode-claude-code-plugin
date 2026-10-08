/**
 * opencode's MCP OAuth credential store, read so a bridged remote server can
 * carry the token opencode already holds for it.
 *
 * The problem: when the operator authenticates a remote MCP server through
 * opencode's own OAuth flow, opencode reports it `connected` and the bridge
 * passes it to `claude --mcp-config` with no credential at all. The Claude
 * CLI then reports it `needs-auth` on every `system`/`init` frame, the
 * server's tools are unavailable to the model for the whole session, and the
 * plugin WARNs once per server per process (`MCP server "<name>" is
 * needs-auth in Claude Code`). One live turn on 1.18.34 produced 25 distinct
 * such WARNs in the same millisecond, which is what the TUI toast burst guard
 * exists to survive (h #g193).
 *
 * **This module reads a secret, so every rule here is load-bearing.**
 *
 * - It is off unless `bridgeMcpOauthTokens` is true. The operator
 *   authenticated that server *to opencode*; handing the token to a second
 *   program, which then lets a model drive calls with it, is their decision
 *   to make and not a default. Every other option in this plugin that widens
 *   what a credential or a tool can reach is opt-in for the same reason.
 * - A token is NEVER logged, never put in a message, never put in `data`, and
 *   nothing derived from one reaches the bridge hash (see
 *   `buildFreshnessKey`).
 * - A token is only ever matched by opencode's own key for it, which is the
 *   MCP server's name, and only when the entry's `serverUrl` also equals the
 *   configured URL. Measured on this machine's real store (1.18.35,
 *   2026-10-08): all three entries are keyed by a configured server name and
 *   each entry's `serverUrl` equals that same server's configured `url`. A
 *   URL-only match would hand server A's token to server B whenever two
 *   servers share a URL, which is exactly the case where the two are
 *   different accounts against one host.
 * - A server with no usable token is bridged UNCHANGED, never dropped. The
 *   feature is purely additive: with it off, or with no token, the spawn is
 *   byte-identical to what it is today.
 *
 * Store shape, confirmed on opencode 1.18.35 (file written 2026-10-03, mode
 * 0600, structure read without reading any value):
 *
 *   {
 *     "<mcp server name>": {
 *       "tokens"?: {
 *         "accessToken": string,
 *         "refreshToken"?: string,
 *         "expiresAt"?: number,   // Unix seconds
 *         "scope"?: string
 *       },
 *       "serverUrl"?: string,
 *       "clientInfo"?: { clientId, clientSecret?, clientIdIssuedAt }
 *     }
 *   }
 *
 * An entry mid-handshake has `serverUrl` and `clientInfo` but no `tokens`;
 * one of the three real entries is in exactly that state, which is why "an
 * entry exists" can never mean "this server needs a token from us".
 *
 * **opencode 2 does not have this file.** 2.0.22 stores MCP credentials in a
 * `credential` table inside `opencode.db` and exposes a typed
 * `Integration`/`Credential` plugin domain instead; `mcp-auth` does not
 * appear in the binary at all. So this is a V1-only path and it answers
 * "nothing" on V2, which is the correct answer rather than a gap to paper
 * over by opening a SQLite file the host owns.
 *
 * Neither major has a route that returns a token: 1.18.35's SDK has
 * `/mcp/{name}/auth`, `/auth/callback` and `/auth/authenticate`, and all
 * three answer with an authorization URL or an `McpStatus`, never a
 * credential. Reading the file is the only way, and that is a large part of
 * why this is opt-in.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { log } from "./logger.js"

/**
 * Treat a token as already expired this many seconds before it really is. A
 * spawn that wins the race by two seconds would hand the CLI a credential
 * that dies inside the first tool call.
 */
const EXPIRY_SKEW_SECONDS = 30

export interface McpAuthTokens {
  accessToken: string
  refreshToken?: string
  /** Unix seconds. Absent means opencode recorded no expiry. */
  expiresAt?: number
  scope?: string
}

export interface McpAuthEntry {
  tokens?: McpAuthTokens
  /** The URL opencode held this token against. */
  serverUrl?: string
  clientInfo?: unknown
}

export type McpAuthStore = Record<string, McpAuthEntry>

/** Why a bridged server did not get a token. Never carries the token. */
export type BearerRefusal = "no-entry" | "url-mismatch" | "no-token" | "expired"

export type BearerLookup =
  | { token: string; expiresAt?: number }
  | { token: null; refusal: BearerRefusal }

/**
 * Where opencode 1.x keeps its state. `XDG_DATA_HOME` wins, as it does for
 * opencode itself.
 */
export function opencodeStateDir(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(dataHome, "opencode")
}

/**
 * Read `<stateDir>/mcp-auth.json`.
 *
 * Every failure is an empty store, because the only thing a failure can mean
 * for this feature is "no token available", and that is the state the bridge
 * already handles. Nothing here throws and nothing here logs the contents.
 *
 * The `lstat` guard is the same discipline the plugin applies to its own
 * scratch directory (h #g158), applied in the other direction: this is a file
 * the plugin does not own and is about to copy a credential out of. A symlink
 * at that path, or a path the current user does not own, is a way to choose
 * which token the plugin hands to the CLI, so both are refused. An attacker
 * who can write there already owns the session, so this is cheap insurance
 * rather than a boundary, but refusing costs one syscall.
 */
export function readMcpAuthStore(stateDir: string): McpAuthStore {
  const file = path.join(stateDir, "mcp-auth.json")
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile()) {
      log.debug("ignoring opencode MCP auth store that is not a regular file", { path: file })
      return {}
    }
    if (typeof stat.uid === "number" && typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      log.debug("ignoring opencode MCP auth store owned by another user", { path: file })
      return {}
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      log.debug("opencode MCP auth store has an unexpected shape", { path: file })
      return {}
    }
    return parsed as McpAuthStore
  } catch {
    // Absent is the normal case: no remote server has ever been
    // OAuth-authenticated through opencode on this machine.
    return {}
  }
}

/**
 * The access token opencode holds for one bridged server, or why there is
 * none.
 *
 * Both the name and the URL have to agree. The name is opencode's own key, so
 * it is the identity; the URL is the cross-check that the entry is still
 * about the server the config now describes, which is what stops a stale
 * entry from a server that was repointed at a different host.
 */
export function selectBearerToken(
  store: McpAuthStore,
  serverName: string,
  serverUrl: string,
  now: number = Date.now(),
): BearerLookup {
  const entry = Object.prototype.hasOwnProperty.call(store, serverName)
    ? store[serverName]
    : undefined
  if (!entry || typeof entry !== "object") return { token: null, refusal: "no-entry" }
  if (!entry.serverUrl || entry.serverUrl !== serverUrl) {
    return { token: null, refusal: "url-mismatch" }
  }
  const accessToken = entry.tokens?.accessToken
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return { token: null, refusal: "no-token" }
  }
  const expiresAt = entry.tokens?.expiresAt
  if (typeof expiresAt === "number" && expiresAt - now / 1000 < EXPIRY_SKEW_SECONDS) {
    return { token: null, refusal: "expired" }
  }
  return { token: accessToken, expiresAt: typeof expiresAt === "number" ? expiresAt : undefined }
}

/**
 * A per-server key that changes when the token does, folded into the bridge
 * hash so a rotation respawns the CLI instead of leaving a dead credential in
 * a long-lived child.
 *
 * **It is the expiry and nothing else.** The fork derived it from a truncated
 * SHA-256 of the token when no expiry was recorded, which is one-way but is
 * still a confirmation oracle for a secret, and the bridge hash is logged and
 * read by the hot-reload diff. A refresh always moves the expiry, so the
 * expiry is the whole signal in practice: all three entries in this machine's
 * real store carry one. A token with no recorded expiry gets a constant, so
 * its rotation is picked up by the next fresh spawn rather than by a respawn,
 * which is the old behaviour and costs nothing derived from the secret.
 */
export function buildFreshnessKey(expiresAt: number | undefined): string {
  return expiresAt === undefined ? "no-expiry" : String(expiresAt)
}

/** Whether any header already carries authorization, whatever its casing. */
function hasAuthorizationHeader(headers: Record<string, unknown>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === "authorization")
}

/**
 * A copy of a translated Claude CLI server spec carrying the bearer token.
 *
 * An `Authorization` header the operator wrote themselves always wins, and
 * the match is case-insensitive because HTTP header names are: the fork's
 * exact-case `"Authorization" in headers` would have added a second
 * authorization header beside a lowercase one the operator set.
 */
export function injectBearerHeaders(
  server: Record<string, unknown>,
  accessToken: string,
): Record<string, unknown> {
  const existing =
    server.headers && typeof server.headers === "object" && !Array.isArray(server.headers)
      ? (server.headers as Record<string, unknown>)
      : {}
  if (hasAuthorizationHeader(existing)) return { ...server }
  return {
    ...server,
    headers: { ...existing, Authorization: `Bearer ${accessToken}` },
  }
}
