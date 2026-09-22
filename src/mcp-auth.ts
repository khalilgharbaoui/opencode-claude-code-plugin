/**
 * Read opencode's MCP OAuth credential store and inject bearer tokens into
 * bridged remote MCP server configs.
 *
 * opencode stores MCP OAuth tokens in `~/.local/share/opencode/mcp-auth.json`
 * (mode 0600). Schema observed on opencode 1.18.31 (2026-09-18):
 *
 *   {
 *     "<server-name>": {
 *       "tokens"?: {
 *         "accessToken": string,
 *         "refreshToken"?: string,
 *         "expiresAt"?: number,   // Unix timestamp in seconds (float)
 *         "scope"?: string
 *       },
 *       "serverUrl"?: string,     // URL used to match the bridged server
 *       "clientInfo"?: object     // ignored here
 *     }
 *   }
 *
 * This module is intentionally self-contained and side-effect-free: all I/O is
 * done by the caller (bridgeOpencodeMcp), not here. The three exported
 * functions are pure and readily unit-testable without a real filesystem.
 *
 * Secret hygiene:
 *   - Tokens are NEVER logged.
 *   - The freshness key is a one-way truncated digest when no expiresAt
 *     is present, so the token cannot be recovered from it.
 */

import * as crypto from "node:crypto"

/** Seconds before expiry to treat the token as already expired. */
const EXPIRY_SKEW_SECONDS = 30

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface McpAuthTokens {
  accessToken: string
  refreshToken?: string
  /** Unix timestamp in seconds (float). Absent means non-expiring. */
  expiresAt?: number
  scope?: string
}

export interface McpAuthEntry {
  tokens?: McpAuthTokens
  /** The URL opencode used when it fetched this token. */
  serverUrl?: string
  clientInfo?: unknown
}

// ---------------------------------------------------------------------------
// selectBearerToken
// ---------------------------------------------------------------------------

/**
 * Given the parsed `mcp-auth.json` entries, find a valid (non-expired, URL-
 * matched) access token for `serverUrl`.
 *
 * Returns `null` if no matching, valid token exists. Degrading to null is
 * always safe: the server gets no Authorization header and the CLI fails with
 * a 401 just as it did before this feature existed.
 */
export function selectBearerToken(
  entries: Record<string, McpAuthEntry>,
  serverUrl: string,
): string | null {
  const nowSeconds = Date.now() / 1000

  for (const entry of Object.values(entries)) {
    // Must have a serverUrl to match against.
    if (!entry.serverUrl) continue
    if (entry.serverUrl !== serverUrl) continue

    // Must have tokens with an accessToken.
    if (!entry.tokens?.accessToken) continue

    // If expiresAt is present, enforce it with a skew margin.
    const { expiresAt, accessToken } = entry.tokens
    if (expiresAt !== undefined && expiresAt - nowSeconds < EXPIRY_SKEW_SECONDS) {
      continue // expired or about to expire
    }

    return accessToken
  }

  return null
}

// ---------------------------------------------------------------------------
// buildFreshnessKey
// ---------------------------------------------------------------------------

/**
 * Build a short key that changes whenever the token changes, so callers can
 * fold it into the bridge hash and force a CLI respawn on token rotation.
 *
 * - If `expiresAt` is known, use its string representation (cheap and
 *   sufficient: every token rotation produces a new expiry).
 * - Otherwise, use a truncated SHA-256 of the token (one-way, so the token
 *   cannot be recovered from the key).
 *
 * The key is NOT a secret and may be included in a debug hash.
 */
export function buildFreshnessKey(
  accessToken: string,
  expiresAt: number | undefined,
): string {
  if (expiresAt !== undefined) {
    return String(expiresAt)
  }
  return crypto
    .createHash("sha256")
    .update(accessToken)
    .digest("hex")
    .slice(0, 12)
}

// ---------------------------------------------------------------------------
// injectBearerHeaders
// ---------------------------------------------------------------------------

/**
 * Return a copy of a translated Claude CLI MCP server spec with an
 * `Authorization: Bearer <token>` header added.
 *
 * Rules:
 *   - If `Authorization` is already set (by the user's own config), it is
 *     left untouched — we never override an explicit value.
 *   - Existing headers are preserved and merged.
 *   - The original `server` object is NOT mutated.
 */
export function injectBearerHeaders(
  server: Record<string, unknown>,
  accessToken: string,
): Record<string, unknown> {
  const existingHeaders =
    server.headers && typeof server.headers === "object"
      ? (server.headers as Record<string, string>)
      : {}

  // If Authorization is already set, return a shallow copy with no change.
  if ("Authorization" in existingHeaders) {
    return { ...server }
  }

  return {
    ...server,
    headers: {
      ...existingHeaders,
      Authorization: `Bearer ${accessToken}`,
    },
  }
}
