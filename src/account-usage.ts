/**
 * What each account's usage windows looked like the last time the CLI said,
 * so the operator hears about a window filling up BEFORE it runs out
 * (`usageWarnThresholds`, `usageSwitchAt`, h #g244).
 *
 * ## Where the numbers come from
 *
 * The headless CLI emits `{type:"rate_limit_event", rate_limit_info:{status,
 * rateLimitType, resetsAt, utilization, ...}}` whenever its view of the
 * account's limits CHANGES (h #g194). Before this module the plugin kept only
 * a REJECTED one (`rememberAccountLimit`), so the first thing an operator saw
 * was the limit itself. Every event is a reading now, keyed account -> window.
 *
 * Two measured facts shape the record:
 *
 *   - `utilization` is a FRACTION, not a percent. Read off the live plugin log
 *     on 2026-10-16 and 2026-10-17 (CLI 2.1.293): `allowed_warning` events
 *     carrying `0.75` and `0.9`, which the existing NOTICE already rendered as
 *     "75% used" and "90% used". It is stored exactly as the CLI sent it.
 *   - An `allowed` event on an account with headroom carries NO utilization at
 *     all (`utilization: null` in the CLI's own frame, absent after parsing).
 *     That is "unknown", never zero: a null reading crosses no threshold and
 *     the sidebar shows `ok`, not `0%`.
 *
 * The same event also carries `unifiedWindows` (h #g266), which the plugin did
 * not read before: every subscription window's own utilization and reset, on
 * every event, and the CLI emits an event whenever one of them moves by a
 * rounded percent. So the five-hour and seven-day windows have numbers while
 * the top level says nothing, and a reading follows the account turn by turn
 * (`recordRateLimitObservation`). A window absent from it keeps the old rule.
 *
 * The interactive transport has no event, so the only thing it records is a
 * limit reply: status `rejected`, utilization unknown, and whatever reset the
 * reply's own text names (`limitFactsFromText`, h #g208).
 *
 * ## A window's crossings, and when they clear
 *
 * Each window keeps `noted`, the thresholds (in percent) a `▌ **usage:**` note
 * already announced, so a reused process's next turn, another session on the
 * same account and a restarted opencode all stay quiet about a crossing that
 * was already said. `noted` carries over to a new reading for as long as the
 * PREVIOUS reading is still current, and is cleared once its reset has passed:
 * the reset is what ends a window, and comparing two `resetsAt` values for
 * equality would re-announce a crossing every time the CLI rounded the reset
 * differently. A reading with no reset time (the interactive transport's) is
 * current for `UNTIMED_READING_TTL_MS`.
 *
 * ## Which accounts exist
 *
 * A reading arrives on an account's first turn, so until then the sidebar had
 * nothing to list for it, and an account whose last window had reset vanished
 * from it (h #g248). The server half now registers every configured account
 * at startup (`registerKnownAccounts`, called by `registerSidebarAccounts` in
 * `src/account-tier.ts`): the name and the plan tier read off its own
 * `.claude.json`, under `known` beside the readings. That list is REPLACED on
 * each startup, because it is the configured set and not an observation, and
 * the readings are never touched by it.
 *
 * ## When each account's login ends
 *
 * Since Claude Code 2.1.318 every numbered `result` carries
 * `credential_expires_at`, an ISO 8601 instant: the end of the stored
 * claude.ai login's REFRESH chain, which renewing the access token does not
 * move (h #g301). Absent for an API key, a token from the environment and
 * any other provider, and from an older CLI. `logins` keeps the newest one
 * per account, beside the readings, so the sidebar and `/claude-code-doctor`
 * can show it and a `▌ **login:**` note can say it once, BEFORE a turn fails
 * on `authentication_failed`. A result without the field changes nothing.
 * `notedFor` is the date a note was already written for: a new login is a
 * new date, which may be warned about again.
 *
 * ## File and failure
 *
 * `$XDG_STATE_HOME/opencode-claude-code-plugin/account-usage.json`, the fifth
 * file the plugin writes there, with the same discipline as the resume and
 * spawn stores (h #g197, h #g234): merge-on-write so two opencode processes do
 * not erase each other, atomic rename, `0600` in a `0700` directory, bounded,
 * and an unreadable or half-written file is an empty store. It holds account
 * NAMES, window names, plan tier labels (`Max 20x`), numbers and times, and
 * nothing else: a login's end is a date, never a token.
 *
 * Imports nothing that logs, because the TUI bundle reads it on the terminal's
 * own thread (h #g193): every function here is silent and never throws.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** One reading of one window, as the CLI reported it. */
export interface UsageReading {
  /** The CLI's fraction (0.75 is 75%), or null when the event carried none. */
  utilization: number | null
  /** Epoch ms the window resets at, when the CLI said. */
  resetsAt?: number
  /**
   * The TUI's own reset phrase (`3pm (Europe/Amsterdam)`), for a limit that
   * reached us only as text. Shown only when `resetsAt` is unknown.
   */
  resetsText?: string
  /** `allowed`, `allowed_warning` or `rejected`, as the CLI sent it. */
  status: string
}

export interface WindowUsage extends UsageReading {
  /** Epoch ms this reading was recorded. */
  observedAt: number
  /** Thresholds, in percent, a note already announced in this window. */
  noted: number[]
}

/** account -> window (the CLI's `rateLimitType`) -> reading. */
export type AccountUsage = Map<string, Map<string, WindowUsage>>

/** What the startup registration knows about an account before any reading. */
export interface KnownAccount {
  /** `Max 20x`, `Pro`, ...: the plan tier off the account's own `.claude.json`, when readable. */
  tier?: string
  /** Epoch ms the registration that wrote this entry ran. */
  at: number
}

/** account -> what the server half registered about it at startup. */
export type KnownAccounts = Map<string, KnownAccount>

/** What the CLI last said about when an account's stored claude.ai login ends. */
export interface LoginExpiry {
  /** Epoch ms of the CLI's `credential_expires_at`. */
  expiresAt: number
  /** Epoch ms a result last reported it. */
  observedAt: number
  /**
   * `loginExpiryWarnDays` as the server half that recorded this resolved it,
   * so the sidebar (which cannot read provider options) shows the line from
   * the same day the note is due. 0 is off.
   */
  warnDays: number
  /** The `expiresAt` a `▌ **login:**` note was already written for. */
  notedFor?: number
}

/** account -> its login's end. */
export type LoginExpiries = Map<string, LoginExpiry>

export const DEFAULT_USAGE_WARN_THRESHOLDS: readonly number[] = [50, 75, 90, 95]
export const DEFAULT_USAGE_SWITCH_AT = 90

/**
 * How long a reading with no reset time stays current. The only such reading
 * is the interactive transport's limit reply, and the window it names is the
 * five-hour one (`limitFactsFromText`), so five hours is the longest that
 * reading could still be true.
 */
export const UNTIMED_READING_TTL_MS = 5 * 60 * 60 * 1000

/** A reading not refreshed in this long is dropped: past every window's reset. */
export const USAGE_READING_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000

/**
 * How many days before a login's end the note is due and the sidebar line
 * shows, by default. Claude Code's own `-p` text warning starts here too
 * (`7 + 3` days in 2.1.322): the date is the server's, or a 30-day estimate
 * from sign-in, and the real end can be up to `LOGIN_EARLY_END_DAYS` sooner,
 * so ten days out leaves at least a week of notice (h #g301).
 */
export const DEFAULT_LOGIN_EXPIRY_WARN_DAYS = 10

/** How much sooner than its date a login may really end, per the CLI's own schema. */
export const LOGIN_EARLY_END_DAYS = 3

/** The longest a stored login was measured to last: past this, a record says nothing current. */
export const LOGIN_RECORD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * How long an unchanged login record goes without a write: a result per turn
 * would otherwise rewrite the file the TUI re-parses on every change.
 */
export const LOGIN_RECORD_REFRESH_MS = 60 * 60 * 1000

export const DAY_MS = 24 * 60 * 60 * 1000

export const MAX_USAGE_ACCOUNTS = 32
export const MAX_USAGE_WINDOWS = 8

const NAME = /^[a-z0-9_-]{1,64}$/
const STATUS = /^[a-z_]{1,32}$/
/** A plan tier label as `src/account-tier.ts` renders one: `Max 20x`, `Pro`. */
const TIER = /^[A-Za-z0-9][A-Za-z0-9 ]{0,23}$/
const MAX_RESETS_TEXT = 80

let pathOverride: string | null = null
let cache: { path: string; usage: AccountUsage } | null = null
let loginCache: { path: string; logins: LoginExpiries } | null = null

export function accountUsageStorePath(): string {
  if (pathOverride) return pathOverride
  const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(stateRoot, "opencode-claude-code-plugin", "account-usage.json")
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function validEntry(value: unknown): WindowUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  if (!finite(entry.observedAt)) return null
  if (typeof entry.status !== "string" || !STATUS.test(entry.status)) return null
  if (entry.utilization !== null && !finite(entry.utilization)) return null
  if (entry.resetsAt !== undefined && !finite(entry.resetsAt)) return null
  if (
    entry.resetsText !== undefined &&
    (typeof entry.resetsText !== "string" || entry.resetsText.length > MAX_RESETS_TEXT)
  ) {
    return null
  }
  const noted = Array.isArray(entry.noted)
    ? [...new Set(entry.noted.filter((t): t is number => finite(t) && t > 0 && t <= 100))].sort(
        (a, b) => a - b,
      )
    : []
  return {
    utilization: entry.utilization as number | null,
    ...(entry.resetsAt === undefined ? {} : { resetsAt: entry.resetsAt as number }),
    ...(entry.resetsText === undefined ? {} : { resetsText: entry.resetsText as string }),
    status: entry.status,
    observedAt: entry.observedAt,
    noted,
  }
}

/** The file's two maps: the readings, and the accounts registered at startup. */
interface StoreFile {
  usage: AccountUsage
  known: KnownAccounts
  logins: LoginExpiries
}

const emptyStore = (): StoreFile => ({ usage: new Map(), known: new Map(), logins: new Map() })

function readKnown(parsed: Record<string, unknown>): KnownAccounts {
  const out: KnownAccounts = new Map()
  const known = parsed.known
  if (!known || typeof known !== "object" || Array.isArray(known)) return out
  for (const [account, raw] of Object.entries(known as Record<string, unknown>)) {
    if (out.size >= MAX_USAGE_ACCOUNTS) break
    if (!NAME.test(account) || !raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    if (!finite(record.at)) continue
    const tier = typeof record.tier === "string" && TIER.test(record.tier) ? record.tier : undefined
    out.set(account, { ...(tier ? { tier } : {}), at: record.at })
  }
  return out
}

function validLogin(value: unknown): LoginExpiry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!finite(record.expiresAt) || !finite(record.observedAt)) return null
  const warnDays = finite(record.warnDays) && record.warnDays >= 0 ? record.warnDays : DEFAULT_LOGIN_EXPIRY_WARN_DAYS
  return {
    expiresAt: record.expiresAt,
    observedAt: record.observedAt,
    warnDays,
    ...(finite(record.notedFor) ? { notedFor: record.notedFor } : {}),
  }
}

function readLogins(parsed: Record<string, unknown>, now: number): LoginExpiries {
  const out: LoginExpiries = new Map()
  const logins = parsed.logins
  if (!logins || typeof logins !== "object" || Array.isArray(logins)) return out
  for (const [account, raw] of Object.entries(logins as Record<string, unknown>)) {
    if (out.size >= MAX_USAGE_ACCOUNTS) break
    if (!NAME.test(account)) continue
    const record = validLogin(raw)
    if (record && record.observedAt >= now - LOGIN_RECORD_MAX_AGE_MS) out.set(account, record)
  }
  return out
}

function boundedLogins(logins: LoginExpiries, now: number): LoginExpiries {
  return new Map(
    [...logins.entries()]
      .filter(([, record]) => record.observedAt >= now - LOGIN_RECORD_MAX_AGE_MS)
      .sort((a, b) => a[1].observedAt - b[1].observedAt)
      .slice(-MAX_USAGE_ACCOUNTS),
  )
}

function parseStore(file: string, now: number): StoreFile {
  const out = emptyStore()
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out
    out.known = readKnown(parsed as Record<string, unknown>)
    out.logins = readLogins(parsed as Record<string, unknown>, now)
    const accounts = (parsed as Record<string, unknown>).accounts
    if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return out
    const cutoff = now - USAGE_READING_MAX_AGE_MS
    for (const [account, windows] of Object.entries(accounts as Record<string, unknown>)) {
      if (!NAME.test(account) || !windows || typeof windows !== "object") continue
      const kept = new Map<string, WindowUsage>()
      for (const [window, raw] of Object.entries(windows as Record<string, unknown>)) {
        if (!NAME.test(window)) continue
        const entry = validEntry(raw)
        if (entry && entry.observedAt >= cutoff) kept.set(window, entry)
      }
      if (kept.size > 0) out.usage.set(account, kept)
    }
  } catch {
    // ENOENT before the first event, or a file another process is renaming
    // into place: the empty store is the answer.
  }
  return out
}

function readStore(file: string, now: number): AccountUsage {
  return parseStore(file, now).usage
}

function newestObserved(windows: Map<string, WindowUsage>): number {
  let newest = 0
  for (const entry of windows.values()) newest = Math.max(newest, entry.observedAt)
  return newest
}

function bounded(usage: AccountUsage, now: number): AccountUsage {
  const cutoff = now - USAGE_READING_MAX_AGE_MS
  const accounts = [...usage.entries()]
    .map(([account, windows]) => {
      const kept = [...windows.entries()]
        .filter(([, entry]) => entry.observedAt >= cutoff)
        .sort((a, b) => a[1].observedAt - b[1].observedAt)
        .slice(-MAX_USAGE_WINDOWS)
      return [account, new Map(kept)] as const
    })
    .filter(([, windows]) => windows.size > 0)
    .sort((a, b) => newestObserved(a[1]) - newestObserved(b[1]))
    .slice(-MAX_USAGE_ACCOUNTS)
  return new Map(accounts)
}

function writeStore(file: string, usage: AccountUsage, known: KnownAccounts, logins: LoginExpiries): boolean {
  const accounts: Record<string, Record<string, WindowUsage>> = {}
  for (const [account, windows] of usage) accounts[account] = Object.fromEntries(windows)
  // `known` is written once something registered, and `logins` once a result
  // carried a login's end; a file neither touched keeps its old shape.
  const registered = {
    ...(known.size > 0 ? { known: Object.fromEntries(known) } : {}),
    ...(logins.size > 0 ? { logins: Object.fromEntries(logins) } : {}),
  }
  try {
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, accounts, ...registered }), { mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/** This process's view, loaded from disk once and kept current by its own writes. */
function cached(now: number): AccountUsage {
  const file = accountUsageStorePath()
  if (!cache || cache.path !== file) cache = { path: file, usage: readStore(file, now) }
  return cache.usage
}

/** Re-read the file into the cache, for a decision another process may have made. */
function refreshed(now: number): AccountUsage {
  const file = accountUsageStorePath()
  cache = { path: file, usage: readStore(file, now) }
  return cache.usage
}

/**
 * Whether a reading still describes the window it was taken in: its reset is
 * ahead, or, with no reset time, it is younger than `UNTIMED_READING_TTL_MS`.
 */
export function isReadingCurrent(entry: WindowUsage, now: number = Date.now()): boolean {
  if (entry.resetsAt !== undefined) return entry.resetsAt > now
  return now - entry.observedAt < UNTIMED_READING_TTL_MS
}

/**
 * The record a new reading leaves behind. The thresholds already announced
 * carry over only while the previous reading is still current; once its reset
 * has passed, the window has turned over and every crossing may be said again.
 */
export function applyReading(
  previous: WindowUsage | undefined,
  reading: UsageReading,
  now: number = Date.now(),
): WindowUsage {
  const carried = previous && isReadingCurrent(previous, now) ? previous.noted : []
  return {
    utilization: finite(reading.utilization) ? reading.utilization : null,
    ...(finite(reading.resetsAt) ? { resetsAt: reading.resetsAt } : {}),
    ...(reading.resetsText && !finite(reading.resetsAt)
      ? { resetsText: reading.resetsText.slice(0, MAX_RESETS_TEXT) }
      : {}),
    status: STATUS.test(reading.status) ? reading.status : "unknown",
    observedAt: now,
    noted: [...carried],
  }
}

/** The CLI's fraction as a percent, to one decimal so `0.9` is exactly 90. */
export function usagePercent(utilization: number): number {
  return Math.round(utilization * 1000) / 10
}

/**
 * The thresholds this reading crosses that no note announced yet. None for a
 * reading that is no longer current, one whose utilization is unknown, and a
 * rejection: a window that ran out gets the `▌ **usage limit:**` note instead.
 */
export function pendingCrossings(
  entry: WindowUsage,
  thresholds: readonly number[],
  now: number = Date.now(),
): number[] {
  if (!isReadingCurrent(entry, now)) return []
  if (entry.utilization === null || entry.status === "rejected") return []
  const percent = usagePercent(entry.utilization)
  return [...new Set(thresholds)]
    .filter((threshold) => percent >= threshold && !entry.noted.includes(threshold))
    .sort((a, b) => a - b)
}

/**
 * `usageWarnThresholds`: percents above 0 and up to 100, deduplicated and
 * sorted. Unset is the default list; an explicit empty list turns the notes off.
 */
export function resolveUsageWarnThresholds(value: unknown): number[] {
  if (!Array.isArray(value)) return [...DEFAULT_USAGE_WARN_THRESHOLDS]
  return [...new Set(value.filter((t): t is number => finite(t) && t > 0 && t <= 100))].sort(
    (a, b) => a - b,
  )
}

/**
 * `usageSwitchAt`: a percent above 0 and up to 100, or null for "never". `false`
 * and `0` turn it off; anything unusable is the default.
 */
export function resolveUsageSwitchAt(value: unknown): number | null {
  if (value === false || value === 0) return null
  if (finite(value) && value > 0 && value <= 100) return value
  return DEFAULT_USAGE_SWITCH_AT
}

/**
 * Record one reading. Returns the record left behind, or null when the account
 * or window name is unusable or the write failed (the in-process view still
 * takes the reading, so this turn's note is not lost to a read-only disk).
 */
export function recordUsageReading(
  account: string,
  window: string,
  reading: UsageReading,
  now: number = Date.now(),
): WindowUsage | null {
  if (!NAME.test(account) || !NAME.test(window)) return null
  const file = accountUsageStorePath()
  const store = parseStore(file, now)
  const merged = store.usage
  const previous = merged.get(account)?.get(window) ?? cached(now).get(account)?.get(window)
  const entry = applyReading(previous, reading, now)
  const windows = merged.get(account) ?? new Map<string, WindowUsage>()
  windows.set(window, entry)
  merged.set(account, windows)
  const kept = bounded(merged, now)
  cache = { path: file, usage: kept }
  return writeStore(file, kept, store.known, store.logins) ? entry : null
}

/**
 * One `rate_limit_event` as the stream parser hands it over, times in epoch
 * ms: the window that limits the account (`window`, with the `status`,
 * `utilization` and reset the CLI attached to it) and `windows`, every
 * window's own reading off the event's `unifiedWindows` (h #g266).
 */
export interface RateLimitObservation {
  window?: string
  status?: string
  utilization?: number
  resetsAt?: number
  windows?: Readonly<Record<string, { utilization: number; resetsAt?: number }>>
}

/**
 * The readings one event leaves, window by window. The limiting window takes
 * the event's status, and its utilization from the top level when the CLI put
 * one there, else from `windows`, which is where a window with headroom has
 * one. Every other window in `windows` is `allowed`, because the status
 * describes only the limiting window, with one exception: a refusal from an
 * earlier event that is still current stays a refusal while the window reads
 * at or past its cap, since two windows can be out at once and an event names
 * only one of them.
 */
export function usageReadingsFromObservation(
  observation: RateLimitObservation,
  previous: (window: string) => WindowUsage | undefined,
  now: number = Date.now(),
): Array<[string, UsageReading]> {
  const out: Array<[string, UsageReading]> = []
  const windows = observation.windows ?? {}
  const limiting = observation.window
  if (limiting && observation.status) {
    const own = windows[limiting]
    out.push([
      limiting,
      {
        utilization: finite(observation.utilization)
          ? observation.utilization
          : own && finite(own.utilization)
            ? own.utilization
            : null,
        resetsAt: finite(observation.resetsAt) ? observation.resetsAt : own?.resetsAt,
        status: observation.status,
      },
    ])
  }
  for (const [window, own] of Object.entries(windows)) {
    if (window === limiting || !finite(own.utilization)) continue
    const before = previous(window)
    const stillRefused =
      before !== undefined && before.status === "rejected" && isReadingCurrent(before, now) && own.utilization >= 1
    out.push([window, { utilization: own.utilization, resetsAt: own.resetsAt, status: stillRefused ? "rejected" : "allowed" }])
  }
  return out
}

/**
 * Record every reading one event carries, in one write. Returns false when
 * there was nothing usable to record or the write failed (the in-process view
 * still takes the readings, as `recordUsageReading`'s does).
 */
export function recordRateLimitObservation(
  account: string,
  observation: RateLimitObservation,
  now: number = Date.now(),
): boolean {
  if (!NAME.test(account)) return false
  const file = accountUsageStorePath()
  const store = parseStore(file, now)
  const merged = store.usage
  const windows = merged.get(account) ?? new Map<string, WindowUsage>()
  const previous = (window: string) => windows.get(window) ?? cached(now).get(account)?.get(window)
  const readings = usageReadingsFromObservation(observation, previous, now).filter(([window]) => NAME.test(window))
  if (readings.length === 0) return false
  for (const [window, reading] of readings) windows.set(window, applyReading(previous(window), reading, now))
  merged.set(account, windows)
  const kept = bounded(merged, now)
  cache = { path: file, usage: kept }
  return writeStore(file, kept, store.known, store.logins)
}

/** Mark thresholds announced, on the window's newest reading. */
export function markUsageNoted(
  account: string,
  window: string,
  thresholds: readonly number[],
  now: number = Date.now(),
): boolean {
  if (!NAME.test(account) || !NAME.test(window) || thresholds.length === 0) return false
  const file = accountUsageStorePath()
  const store = parseStore(file, now)
  const merged = store.usage
  const entry = merged.get(account)?.get(window) ?? cached(now).get(account)?.get(window)
  if (!entry) return false
  const updated = {
    ...entry,
    noted: [...new Set([...entry.noted, ...thresholds])].sort((a, b) => a - b),
  }
  const windows = merged.get(account) ?? new Map<string, WindowUsage>()
  windows.set(window, updated)
  merged.set(account, windows)
  const kept = bounded(merged, now)
  cache = { path: file, usage: kept }
  return writeStore(file, kept, store.known, store.logins)
}

/** Whether two registrations name the same accounts with the same tiers. */
function sameKnown(a: KnownAccounts, b: KnownAccounts): boolean {
  if (a.size !== b.size) return false
  for (const [account, record] of a) {
    const other = b.get(account)
    if (!other || other.tier !== record.tier) return false
  }
  return true
}

/**
 * Every account this install is configured with, from the process starting
 * up, so the sidebar lists them all before any reading arrives (h #g248). The
 * list REPLACES the one on disk rather than merging into it: it is the
 * configured set, not an accumulated observation, and merging would keep an
 * account the operator removed on screen until it aged out. The readings are
 * untouched. Nothing is written while the file already says the same, so a
 * second pass (opencode 2 runs its provider transform more than once) costs
 * one read. Returns false only when a write was needed and failed.
 */
export function registerKnownAccounts(
  accounts: ReadonlyArray<{ account: string; tier?: string }>,
  now: number = Date.now(),
): boolean {
  const file = accountUsageStorePath()
  const store = parseStore(file, now)
  const known: KnownAccounts = new Map()
  for (const entry of accounts) {
    if (known.size >= MAX_USAGE_ACCOUNTS) break
    if (!NAME.test(entry.account)) continue
    const tier = entry.tier && TIER.test(entry.tier) ? entry.tier : undefined
    known.set(entry.account, { ...(tier ? { tier } : {}), at: now })
  }
  if (sameKnown(store.known, known)) return true
  return writeStore(file, bounded(store.usage, now), known, store.logins)
}

/** The accounts registered at startup, read fresh off disk. For `/claude-code-doctor`. */
export function snapshotKnownAccounts(now: number = Date.now()): KnownAccounts {
  return parseStore(accountUsageStorePath(), now).known
}

export interface UsageCrossing {
  window: string
  entry: WindowUsage
  /** Newly crossed thresholds, in percent, ascending. */
  crossed: number[]
}

/**
 * Every window of `account` with a threshold to announce. Answered from this
 * process's view, which costs no I/O on an ordinary turn; only when something
 * looks pending is the file re-read, so a crossing another opencode process
 * already announced is not announced twice.
 */
export function usageCrossings(
  account: string,
  thresholds: readonly number[],
  now: number = Date.now(),
): UsageCrossing[] {
  if (thresholds.length === 0) return []
  const collect = (usage: AccountUsage): UsageCrossing[] => {
    const out: UsageCrossing[] = []
    for (const [window, entry] of usage.get(account) ?? []) {
      const crossed = pendingCrossings(entry, thresholds, now)
      if (crossed.length > 0) out.push({ window, entry, crossed })
    }
    return out
  }
  if (collect(cached(now)).length === 0) return []
  return collect(refreshed(now))
}

/**
 * Whether any current window of `account` is at or over `percent`, or was
 * refused outright. What a switch at a threshold reads, so it never moves new
 * turns onto an account that is no better off.
 */
export function accountUsageAtOrOver(
  account: string,
  percent: number,
  now: number = Date.now(),
): boolean {
  for (const entry of cached(now).get(account)?.values() ?? []) {
    if (!isReadingCurrent(entry, now)) continue
    if (entry.status === "rejected") return true
    if (entry.utilization !== null && usagePercent(entry.utilization) >= percent) return true
  }
  return false
}

/** Every recorded reading, read fresh off disk. For `/claude-code-doctor`. */
export function snapshotAccountUsage(now: number = Date.now()): AccountUsage {
  return refreshed(now)
}

/**
 * `loginExpiryWarnDays`: days before a login's end, above 0 and at most the
 * longest login measured (30). Unset or unusable is the default; `false` and
 * `0` turn the note and the sidebar line off.
 */
export function resolveLoginExpiryWarnDays(value: unknown): number {
  if (value === false || value === 0) return 0
  if (finite(value) && value > 0 && value <= 30) return value
  return DEFAULT_LOGIN_EXPIRY_WARN_DAYS
}

/** This process's view of the logins, loaded once and kept current by its own writes. */
function cachedLogins(now: number): LoginExpiries {
  const file = accountUsageStorePath()
  if (!loginCache || loginCache.path !== file) loginCache = { path: file, logins: parseStore(file, now).logins }
  return loginCache.logins
}

function refreshedLogins(now: number): LoginExpiries {
  const file = accountUsageStorePath()
  loginCache = { path: file, logins: parseStore(file, now).logins }
  return loginCache.logins
}

/**
 * Record the login end a `result` reported for `account` (epoch ms), with the
 * warning window the turn's provider resolved. A note already written for the
 * same date carries over. An unchanged record is rewritten at most once per
 * `LOGIN_RECORD_REFRESH_MS`, so a turn costs no write. Returns the record, or
 * null for an unusable name or date.
 */
export function recordLoginExpiry(
  account: string,
  expiresAt: number,
  warnDays: number,
  now: number = Date.now(),
): LoginExpiry | null {
  if (!NAME.test(account) || !finite(expiresAt) || !finite(warnDays) || warnDays < 0) return null
  const seen = cachedLogins(now).get(account)
  if (
    seen &&
    seen.expiresAt === expiresAt &&
    seen.warnDays === warnDays &&
    now - seen.observedAt < LOGIN_RECORD_REFRESH_MS
  ) {
    return seen
  }
  const file = accountUsageStorePath()
  const store = parseStore(file, now)
  const previous = store.logins.get(account) ?? seen
  const record: LoginExpiry = {
    expiresAt,
    observedAt: now,
    warnDays,
    ...(previous?.notedFor !== undefined ? { notedFor: previous.notedFor } : {}),
  }
  store.logins.set(account, record)
  const logins = boundedLogins(store.logins, now)
  loginCache = { path: file, logins }
  writeStore(file, bounded(store.usage, now), store.known, logins)
  return record
}

/** Whether a login is inside its warning window: from `warnDays` before its end, and after it. */
export function isLoginExpiryDue(record: LoginExpiry, now: number = Date.now()): boolean {
  return record.warnDays > 0 && record.expiresAt - now <= record.warnDays * DAY_MS
}

/**
 * Whether a note was already written for this login. The date is the one
 * stored at sign-in, so it does not move; an hour's slack keeps a rounding
 * difference from reading as a new login, which is weeks apart.
 */
export function isLoginNoted(record: LoginExpiry): boolean {
  return record.notedFor !== undefined && Math.abs(record.notedFor - record.expiresAt) < LOGIN_RECORD_REFRESH_MS
}

/**
 * The login record of `account` when a `▌ **login:**` note is due: inside its
 * warning window and not yet said for this date. Answered from this process's
 * view, which costs no I/O on an ordinary turn; only when one looks due is
 * the file re-read, so a note another opencode process already wrote is not
 * written twice.
 */
export function pendingLoginNote(account: string, now: number = Date.now()): LoginExpiry | undefined {
  const due = (logins: LoginExpiries) => {
    const record = logins.get(account)
    return record && isLoginExpiryDue(record, now) && !isLoginNoted(record) ? record : undefined
  }
  if (!due(cachedLogins(now))) return undefined
  return due(refreshedLogins(now))
}

/** Mark the login ending at `expiresAt` announced for `account`. */
export function markLoginNoted(account: string, expiresAt: number, now: number = Date.now()): boolean {
  if (!NAME.test(account) || !finite(expiresAt)) return false
  const file = accountUsageStorePath()
  const store = parseStore(file, now)
  const record = store.logins.get(account) ?? cachedLogins(now).get(account)
  if (!record) return false
  store.logins.set(account, { ...record, notedFor: expiresAt })
  const logins = boundedLogins(store.logins, now)
  loginCache = { path: file, logins }
  return writeStore(file, bounded(store.usage, now), store.known, logins)
}

/** Every account's login end, read fresh off disk. For `/claude-code-doctor`. */
export function snapshotLoginExpiries(now: number = Date.now()): LoginExpiries {
  return refreshedLogins(now)
}

/**
 * A reader that re-parses the file only when it changed, for the TUI's
 * refresh clock: an unchanged file costs one `stat`. The `ino` is read
 * exactly: as a number, an NTFS file id above 2^53 loses its low bits, and
 * two writes inside one timestamp tick, of the same size, read back as the
 * same file on Windows (h #g286).
 */
export function createAccountUsageReader(
  file: () => string = accountUsageStorePath,
  now: () => number = Date.now,
) {
  let identity = ""
  let store = emptyStore()
  const refresh = () => {
    const path = file()
    let next = ""
    try {
      const stats = statSync(path, { bigint: true })
      next = `${stats.mtimeNs}:${stats.size}:${stats.ino}`
    } catch {
      next = "missing"
    }
    if (next !== identity) {
      identity = next
      store = next === "missing" ? emptyStore() : parseStore(path, now())
    }
  }
  return {
    read(): AccountUsage {
      refresh()
      return store.usage
    },
    /** The accounts registered at startup, with their tiers: the same map while the file is unchanged. */
    known(): KnownAccounts {
      refresh()
      return store.known
    },
    /** Each account's login end, as the last result on it said: the same map while the file is unchanged. */
    logins(): LoginExpiries {
      refresh()
      return store.logins
    },
  }
}

/** Test-only. Points the store at another file and forgets the cache. */
export function _setAccountUsageStorePathForTests(path: string | null): void {
  pathOverride = path
  cache = null
  loginCache = null
}
