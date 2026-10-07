/**
 * The plan tier of a Claude account, read off disk and shown beside the
 * account in opencode's provider list.
 *
 * With several `accounts` configured, the picker says "Claude Code (Work)" and
 * "Claude Code (Personal)" and nothing about what either of them can actually
 * spend. The tier is the one fact that changes how an operator picks, and the
 * CLI already keeps it in plain JSON next to its login, so reading it costs no
 * token, no spawn and no network call.
 *
 * ## Where it comes from
 *
 * Claude Code writes `<CLAUDE_CONFIG_DIR>/.claude.json`, whose `oauthAccount`
 * block carries, among other things, `organizationType` and
 * `organizationRateLimitTier`. Measured on 2.1.288. Those two are exactly what
 * the CLI's own code derives its plan from: its `subscriptionType` is a map
 * over `organization_type` (`claude_max` -> `max`, `claude_pro` -> `pro`,
 * `claude_enterprise` -> `enterprise`, `claude_team` -> `team`), and the 5x/20x
 * split it uses for its own limits and upsells is read from
 * `organization_rate_limit_tier` (`default_claude_max_5x` /
 * `default_claude_max_20x`). So this module derives the label the same way the
 * CLI does rather than inventing a vocabulary.
 *
 * ## What it must never do
 *
 * Read-only, and only these two fields. The same block holds `accountUuid`,
 * `emailAddress`, `organizationUuid`, `organizationName` and `displayName`; a
 * provider's display name is rendered in the picker and written into logs and
 * diagnostics, so none of them may be in it. There is no token anywhere in
 * this file (credentials live in the OS keychain or `.credentials.json`, which
 * is never opened here), and an unreadable, missing, malformed or unrecognised
 * file is simply no label.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import { DEFAULT_ACCOUNT, accountConfigDirPath, expandHome, normalizeAccountName } from "./accounts.js"
import { log } from "./logger.js"

/** The CLI's own `organization_type` -> plan map, read out of 2.1.288. */
const ORGANIZATION_TYPE_LABELS: Record<string, string> = {
  claude_max: "Max",
  claude_pro: "Pro",
  claude_team: "Team",
  claude_enterprise: "Enterprise",
  claude_free: "Free",
}

/** The CLI's own rate-limit tiers, which is where the 5x/20x split lives. */
const RATE_LIMIT_TIER_LABELS: Record<string, string> = {
  default_claude_max_5x: "5x",
  default_claude_max_20x: "20x",
}

/** One parse per config dir per process: provider expansion runs repeatedly. */
const tierCache = new Map<string, string | null>()

/** Test-only. */
export function _resetAccountTierCache(): void {
  tierCache.clear()
}

/**
 * Where an account's `.claude.json` lives. For a configured account that is
 * its own `~/.claude-<name>`; for the default account it is whatever
 * `CLAUDE_CONFIG_DIR` says, falling back to `~/.claude`.
 */
export function accountTierConfigDir(account: string): string {
  const configured = accountConfigDirPath(account)
  if (configured) return configured
  const fromEnv = process.env.CLAUDE_CONFIG_DIR
  return fromEnv && fromEnv.trim() ? expandHome(fromEnv.trim()) : expandHome("~/.claude")
}

/**
 * The plan tier for an account, as a short label ("Max 20x", "Pro", "Team"),
 * or undefined when it cannot be read or cannot be recognised. Never throws:
 * a display name is not worth failing provider registration over.
 */
export function readAccountTier(account: string): string | undefined {
  const normalized = normalizeAccountName(account) || DEFAULT_ACCOUNT
  const configDir = accountTierConfigDir(normalized)

  const cached = tierCache.get(configDir)
  if (cached !== undefined) return cached ?? undefined

  const label = readTierFromConfigDir(configDir, normalized === DEFAULT_ACCOUNT)
  tierCache.set(configDir, label ?? null)
  return label
}

function readTierFromConfigDir(
  configDir: string,
  allowLegacyFallback: boolean,
): string | undefined {
  // The current location first. `~/.claude.json` is where Claude Code kept
  // this before the config dir existed, and an install that has not been
  // rewritten since still has only that one, so the default account falls
  // back to it. A configured account never does: its directory is this
  // plugin's own and a file in the home directory does not describe it.
  const candidates = [path.join(configDir, ".claude.json")]
  if (allowLegacyFallback) candidates.push(expandHome("~/.claude.json"))

  for (const candidate of candidates) {
    const oauth = readOauthAccount(candidate)
    if (!oauth) continue
    const label = tierLabel(oauth)
    if (label) return label
  }
  return undefined
}

function readOauthAccount(file: string): Record<string, unknown> | undefined {
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    // Missing, unreadable, or a directory. All three are "no label".
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return undefined
    const oauth = (parsed as Record<string, unknown>).oauthAccount
    return oauth && typeof oauth === "object"
      ? (oauth as Record<string, unknown>)
      : undefined
  } catch {
    // A config file Claude Code is halfway through writing. Say nothing.
    log.debug("could not parse a Claude config file for its plan tier", { file })
    return undefined
  }
}

/**
 * "Max 20x" / "Max" / "Pro" / "Team" / "Enterprise", or undefined for an
 * organization type this does not know. Unknown is deliberately silent rather
 * than passed through: the raw value is an internal enum, and a picker entry
 * reading `Claude Code (Work, claude_something_new)` is worse than one that
 * says nothing.
 */
export function tierLabel(oauthAccount: Record<string, unknown>): string | undefined {
  const organizationType = oauthAccount.organizationType
  if (typeof organizationType !== "string") return undefined
  const base = ORGANIZATION_TYPE_LABELS[organizationType]
  if (!base) return undefined

  if (base !== "Max") return base

  const rateLimitTier = oauthAccount.organizationRateLimitTier
  const multiple =
    typeof rateLimitTier === "string" ? RATE_LIMIT_TIER_LABELS[rateLimitTier] : undefined
  return multiple ? `${base} ${multiple}` : base
}
