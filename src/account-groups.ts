import { BASE_PROVIDER_ID, DEFAULT_ACCOUNT, normalizeAccountName } from "./accounts.js"
import { log } from "./logger.js"

/**
 * The account topology: which opencode providers are this install's accounts,
 * and which of them may see each other's conversations.
 *
 * Two separate jobs that share one input (the configured `accounts` list), and
 * they are here together because the second is meaningless without the first.
 *
 * **Which providers are accounts.** An account is a `CLAUDE_CONFIG_DIR` behind
 * its own opencode provider, `claude-code-<account>` (`src/accounts.ts`), and
 * the provider id is part of every session key's context blob. That is exactly
 * why a by-hand account switch used to replay the whole thread as text: the key
 * changed, so `findSiblingResumePoint` saw no sibling. Blanking the provider
 * element of the context blob makes the same opencode conversation one
 * conversation across accounts, the way blanking the model segment already
 * makes it one conversation across models (h #g215).
 *
 * It is blanked only for a provider id this install actually expanded, which is
 * what keeps a single-account install byte-identical: with no `accounts` option
 * there are no account providers, the map is empty, and nothing is blanked.
 *
 * **Which accounts may see each other.** `accountGroups` is the guard, and it
 * is OFF unless set. It maps an account name to a group name; everything not
 * listed, `default` included, is in one implicit group. A conversation is only
 * ever carried (the by-hand switch, the switch form, the override,
 * `crossAccountResume`) between accounts in the same group, and a switch ACROSS
 * groups sends the other account nothing at all: no transcript copy, and no
 * text replay either, because the replay is the same history by another route.
 *
 * The guard is about where a conversation's CONTENT is allowed to go on its
 * own. It is not a permission system and it cannot stop an operator typing a
 * secret into the other account by hand; what it stops is the plugin moving a
 * thread there because two providers happen to be configured side by side.
 */

/** The group every account that is not named in `accountGroups` belongs to. */
export const DEFAULT_ACCOUNT_GROUP = "default"

/** Account name -> group name. Empty is never stored; `null` means no guard. */
export type AccountGroups = Readonly<Record<string, string>>

function normalizeGroupName(value: string): string {
  return value.trim().toLowerCase()
}

const warnedUnknownAccounts = new Set<string>()
let warnedShape = false

/** Test seam. */
export function _resetAccountGroupWarnings(): void {
  warnedUnknownAccounts.clear()
  warnedShape = false
}

/**
 * Read the `accountGroups` option, or `null` for "no guard".
 *
 * Every refusal leaves the guard off for the entry it refused rather than
 * failing the turn: a mistyped safety option must not be able to stop a
 * conversation working, and it must not be able to read as if it took effect
 * either, which is why the doctor and the startup block print what was resolved
 * rather than what was written.
 *
 * - A value that is not a plain object of strings is ignored with one WARN.
 * - An account name that is not configured is ignored with one WARN per name,
 *   because the usual cause is a typo and the usual consequence of silently
 *   keeping it is a group that looks configured and guards nothing.
 * - An empty group name is ignored: it is indistinguishable from "unset", and
 *   the implicit default group is what unset already means.
 */
export function resolveAccountGroups(
  value: unknown,
  knownAccounts?: readonly string[],
): AccountGroups | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "object" || Array.isArray(value)) {
    if (!warnedShape) {
      warnedShape = true
      log.warn(
        "accountGroups must be an object mapping an account name to a group name; ignoring it",
        { type: Array.isArray(value) ? "array" : typeof value },
      )
    }
    return null
  }

  const known = knownAccounts
    ? new Set(knownAccounts.map((account) => normalizeAccountName(String(account))))
    : undefined
  const out: Record<string, string> = {}

  for (const [rawAccount, rawGroup] of Object.entries(value as Record<string, unknown>)) {
    const account = normalizeAccountName(rawAccount)
    if (!account) continue
    if (typeof rawGroup !== "string") {
      if (!warnedShape) {
        warnedShape = true
        log.warn(
          "accountGroups must be an object mapping an account name to a group name; ignoring it",
          { account, type: typeof rawGroup },
        )
      }
      continue
    }
    const group = normalizeGroupName(rawGroup)
    if (!group) continue
    if (known && !known.has(account)) {
      if (!warnedUnknownAccounts.has(account)) {
        warnedUnknownAccounts.add(account)
        log.warn("accountGroups names an account that is not configured; ignoring it", {
          account,
          group,
        })
      }
      continue
    }
    out[account] = group
  }

  return Object.keys(out).length > 0 ? out : null
}

/** The group an account is in. Anything unlisted is in the implicit default. */
export function accountGroup(
  account: string | undefined,
  groups: AccountGroups | null | undefined,
): string {
  const name = normalizeAccountName(account || DEFAULT_ACCOUNT)
  return groups?.[name] ?? DEFAULT_ACCOUNT_GROUP
}

/**
 * Whether a conversation may move between two accounts. With no groups
 * configured this is always true, which is what makes the guard opt-in.
 */
export function accountsShareGroup(
  a: string | undefined,
  b: string | undefined,
  groups: AccountGroups | null | undefined,
): boolean {
  if (!groups) return true
  return accountGroup(a, groups) === accountGroup(b, groups)
}

/** Every configured account in the same group as `account`, itself included. */
export function accountsInGroupOf(
  account: string | undefined,
  accounts: readonly string[] | undefined,
  groups: AccountGroups | null | undefined,
): string[] {
  const out: string[] = []
  for (const raw of accounts ?? []) {
    const name = normalizeAccountName(String(raw))
    if (!name || out.includes(name)) continue
    if (!accountsShareGroup(account, name, groups)) continue
    out.push(name)
  }
  return out
}

/**
 * `["appical=work", "hobby=private"]` for the startup block and the doctor.
 * Names only: a group name and an account name are both operator-chosen labels,
 * and the doctor table already prints a column of the latter.
 */
export function describeAccountGroups(groups: AccountGroups | null | undefined): string[] {
  if (!groups) return []
  return Object.entries(groups)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([account, group]) => `${account}=${group}`)
}

// ---------------------------------------------------------------------------
// Session keys: which provider element belongs to which account
// ---------------------------------------------------------------------------

/**
 * The opencode provider ids this install expanded for its accounts, mapped back
 * to the account each one serves.
 *
 * Empty for a single-account install, which is the whole reason this is a map
 * built from the configured list rather than a pattern match on the id: a
 * provider the operator named themselves must never be mistaken for an account
 * provider, and a session key written by a differently-configured opencode must
 * never have its provider element blanked by this one.
 */
export function accountProviderMap(
  accounts: readonly string[] | undefined,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of accounts ?? []) {
    const account = normalizeAccountName(String(raw))
    if (!account) continue
    out.set(`${BASE_PROVIDER_ID}-${account}`, account)
  }
  return out
}

const CONTEXT_PREFIX = "context="

/**
 * The context blob of a session key, or `undefined` for a key that has none (a
 * compaction key, or anything that is not a session key at all).
 *
 * The blob is the whole TAIL of the key rather than one `::` segment, because
 * an opencode agent name could in principle contain `::` and the existing
 * signature functions deliberately compare it whole.
 */
function sessionKeyContextBlob(sessionKey: string): string | undefined {
  const parts = sessionKey.split("::")
  if (parts.length < 5) return undefined
  if (parts[2] === "compaction") return undefined
  const withoutEffort = parts[parts.length - 1].startsWith("effort=")
    ? parts.slice(0, -1)
    : parts
  if (withoutEffort.length < 5) return undefined
  const tail = withoutEffort.slice(4).join("::")
  return tail.startsWith(CONTEXT_PREFIX) ? tail.slice(CONTEXT_PREFIX.length) : undefined
}

/** The provider element of a session key's context blob, if it has one. */
export function sessionKeyProvider(sessionKey: string): string | undefined {
  const blob = sessionKeyContextBlob(sessionKey)
  if (blob === undefined) return undefined
  try {
    const parsed = JSON.parse(blob)
    const first = Array.isArray(parsed) ? parsed[0] : undefined
    return typeof first === "string" ? first : undefined
  } catch {
    return undefined
  }
}

/** The account a session key was served under, for a key this install owns. */
export function sessionKeyAccount(
  sessionKey: string,
  providers: ReadonlyMap<string, string>,
): string | undefined {
  const provider = sessionKeyProvider(sessionKey)
  return provider === undefined ? undefined : providers.get(provider)
}

/**
 * The same session key with the provider element of its context blob blanked,
 * when that provider is one of this install's account providers.
 *
 * Returns the key untouched for every other provider, which is what keeps the
 * sibling signature exactly what it was on a single-account install.
 */
export function blankAccountProvider(
  sessionKey: string,
  providers: ReadonlyMap<string, string>,
): string {
  if (providers.size === 0) return sessionKey
  const blob = sessionKeyContextBlob(sessionKey)
  if (blob === undefined) return sessionKey
  let parsed: unknown
  try {
    parsed = JSON.parse(blob)
  } catch {
    return sessionKey
  }
  if (!Array.isArray(parsed)) return sessionKey
  const provider = parsed[0]
  if (typeof provider !== "string" || !providers.has(provider)) return sessionKey
  const blanked = [...parsed]
  blanked[0] = "*"
  const prefix = sessionKey.slice(0, sessionKey.length - blob.length)
  return `${prefix}${JSON.stringify(blanked)}`
}

// ---------------------------------------------------------------------------
// The note a blocked switch writes
// ---------------------------------------------------------------------------

/** Leading text of the `▌` note a switch across groups ends up writing. */
export const ACCOUNT_GROUP_MARKER = "▌ **account group:**"

/**
 * What the operator reads when they moved a conversation to an account in
 * another group.
 *
 * One note, its own text part, led by a marker registered in
 * `PLUGIN_NOTE_MARKERS`: the plugin wrote it and Claude never said it, so a
 * later transcript rebuild has to strip it exactly. It names both accounts and
 * both groups, because the only useful thing it can say is which two sides the
 * guard is holding apart, and it says the previous account still has the
 * conversation, because that is what makes switching back a real option.
 */
export function formatAccountGroupNote(input: {
  sourceAccount: string
  sourceGroup: string
  targetAccount: string
  targetGroup: string
}): string {
  const source = normalizeAccountName(input.sourceAccount || DEFAULT_ACCOUNT)
  const target = normalizeAccountName(input.targetAccount || DEFAULT_ACCOUNT)
  return (
    `\n${ACCOUNT_GROUP_MARKER} this conversation was running on the Claude account ` +
    `"${source}" (group "${input.sourceGroup}") and is now on "${target}" ` +
    `(group "${input.targetGroup}"), so none of it was carried over: accountGroups ` +
    `keeps a conversation inside one group. This account is starting fresh and sees ` +
    `only your latest message. The conversation is still on "${source}"; switch back ` +
    `to it to continue where you stopped.\n`
  )
}
