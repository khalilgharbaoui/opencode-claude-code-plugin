/**
 * The model behind the sidebar's `Accounts` section (`src/tui.ts`): a line per
 * account this install runs, from the sidebar's first draw (h #g248), about
 * what is LEFT of the account's five-hour window (h #g266):
 * `appical · 5h 28% left · resets 18:00` (`appical · 5h 28% left · 2026-10-18
 * 01:20` for a reset on another day, h #g244, h #g246). Before any reading has
 * arrived it is `appical · Max 20x · no reading yet`.
 *
 * Pure, like `src/subagent-sidebar.ts`, and for the same reason: the TUI bundle
 * runs on the terminal's own thread, where a logger writes over the interface
 * (h #g193). It imports only the store's reader types and that module's pure
 * helpers.
 *
 * Which accounts: every account the server half registered at startup (the
 * configured list, or the one `default` account) plus any with a reading,
 * alphabetically.
 *
 * What an account's line is about: its five-hour window whenever the store
 * has one, because that is the window the operator asked to watch, and it is
 * the one that moves turn by turn now that every event carries every window's
 * reading (`unifiedWindows`, h #g266). A five-hour reading whose reset has
 * passed describes a window that is over, so the account has all of a fresh
 * one: `5h 100% left`, with no reset time, until the next reading. Under it, a
 * SECOND line, set in under the level, names any other window that is refused
 * or at `WARNING_PERCENT` or more (`7d limited · resets 10-30 12:00`), because
 * a full five-hour window on an account whose week is spent is not room to
 * work in; while that other window is refused, the five-hour level is drawn
 * muted. An account with no five-hour reading at all (the interactive
 * transport records only a refusal) gets today's choice: a refused window
 * first, else the fullest. `ok` is a window the CLI reported without a
 * utilization, which is how a CLI without `unifiedWindows` reports
 * headroom, and never `100% left`.
 *
 * Under an account whose stored claude.ai login ends within the warning
 * window the server half recorded with it (h #g301), one more detail line:
 * `login ends by 11-19 09:39` with the date in the warning colour, or, once
 * that date has passed, `login may have ended` in the error colour.
 *
 * Colours, by segment: the name in the text colour; the level in its state's
 * (`limited` in the error colour, 75% used and up in the warning colour, else
 * the success colour at full strength, `ok` included: the `ok` role, never
 * `done`, which is the finished row's faded success); the reset time in its own
 * (`reset`, the theme's info colour), so it reads apart from the level beside
 * it; the word `resets` and every separator muted; the tier in its own
 * (`tier`, the secondary colour).
 */
import {
  isLoginExpiryDue,
  isReadingCurrent,
  usagePercent,
  type AccountUsage,
  type KnownAccounts,
  type LoginExpiries,
  type LoginExpiry,
  type WindowUsage,
} from "./account-usage.js"
import { SIDEBAR_ROW_WIDTH, truncate, type Segment } from "./subagent-sidebar.js"

export interface AccountUsageLine {
  account: string
  /** The window the line is about; empty on a line with no current reading. */
  window: string
  /**
   * `limited` (refused), `warning` (at or past `WARNING_PERCENT` used), `ok`,
   * or `none` for an account no reading describes.
   */
  state: "limited" | "warning" | "ok" | "none"
  /** A second line under an account's first, about another window. */
  detail: boolean
  segments: Segment[]
}

/** Where a level takes the theme's warning colour, in percent USED: the CLI's own first warning level. */
export const WARNING_PERCENT = 75

/** What a line says for an account no reading describes. */
export const NO_READING_TEXT = "no reading yet"

/** The window an account's first line is about whenever the store has one. */
export const FIVE_HOUR_WINDOW = "five_hour"

/** The `window` a login line carries, so a caller can tell it from a usage line. */
export const LOGIN_LINE = "login"
/** The words ahead of a login's end, muted while the date takes the warning colour. */
const LOGIN_WORD = "login ends by "
/** What a login line says once its date has passed: the CLI's schema says "probably ended". */
export const LOGIN_ENDED_TEXT = "login may have ended"

/** The word ahead of a reset time, muted while the time takes its own colour. */
const RESET_WORD = "resets "
const SEPARATOR = " · "
/** The furthest a detail line is set in, so a long account name leaves it room. */
const MAX_DETAIL_INDENT = 12

const SHORT_WINDOWS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_opus: "7d opus",
  seven_day_sonnet: "7d sonnet",
  seven_day_overage_included: "7d extra",
  overage: "extra",
}

/** `five_hour` -> `5h`; an unknown window name is shown as itself, `unknown` as nothing. */
export function shortWindowName(window: string): string {
  if (window === "unknown") return ""
  return SHORT_WINDOWS[window] ?? window.replace(/_/g, " ")
}

/** What is left of a window, in whole percent: `0.72` used is 28. Never below zero. */
export function percentLeft(utilization: number): number {
  return Math.max(0, Math.round(100 - usagePercent(utilization)))
}

const pad = (value: number) => String(value).padStart(2, "0")

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/**
 * A reset time in local time, in the usage-limit note's own notation
 * (`formatLocalMinute` in `src/cli-events.ts`, which this module cannot import
 * because that one logs): `18:00` today, `2026-10-21 12:00` on another day,
 * and `10-21 12:00` with `year` off, which is what a line falls back on.
 */
export function formatResetClock(resetsAt: number, now: number, year = true): string {
  const when = new Date(resetsAt)
  const clock = `${pad(when.getHours())}:${pad(when.getMinutes())}`
  if (sameDay(when, new Date(now))) return clock
  const date = `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${clock}`
  return year ? `${when.getFullYear()}-${date}` : date
}

/**
 * How a line may say when its window resets, widest first: `resets 2026-10-18
 * 01:20`, then without the word, then without the year. A reset today is
 * `resets 01:20` only, since that always fits, and the interactive transport's
 * phrase has no year to drop. Empty when nothing is known.
 */
export function resetSpellings(entry: WindowUsage, now: number): string[] {
  if (entry.resetsAt !== undefined) {
    const full = formatResetClock(entry.resetsAt, now)
    if (sameDay(new Date(entry.resetsAt), new Date(now))) return [`${RESET_WORD}${full}`]
    return [`${RESET_WORD}${full}`, full, formatResetClock(entry.resetsAt, now, false)]
  }
  if (entry.resetsText) return [`${RESET_WORD}${entry.resetsText}`, entry.resetsText]
  return []
}

function stateOf(entry: WindowUsage): "limited" | "warning" | "ok" {
  if (entry.status === "rejected") return "limited"
  if (entry.utilization !== null && usagePercent(entry.utilization) >= WARNING_PERCENT) return "warning"
  return "ok"
}

function rank(entry: WindowUsage): number {
  if (entry.status === "rejected") return 1000
  if (entry.utilization === null) return -1
  return usagePercent(entry.utilization)
}

/** The most pressing current window, refused first, else the fullest; undefined when none is current. */
export function pressingWindow(
  windows: ReadonlyMap<string, WindowUsage>,
  now: number,
  except?: string,
): [string, WindowUsage] | undefined {
  let best: [string, WindowUsage] | undefined
  for (const [window, entry] of windows) {
    if (window === except || !isReadingCurrent(entry, now)) continue
    if (!best || rank(entry) > rank(best[1])) best = [window, entry]
  }
  return best
}

/** `5h 28% left`, `5h limited`, `7d ok`; no `entry` is a window whose reset has passed. */
function levelText(window: string, entry: WindowUsage | undefined): string {
  const short = shortWindowName(window)
  const prefix = short ? `${short} ` : ""
  if (!entry) return `${prefix}100% left`
  if (entry.status === "rejected") return `${prefix}limited`
  if (entry.utilization === null) return `${prefix}ok`
  return `${prefix}${percentLeft(entry.utilization)}% left`
}

interface LineDraft {
  account: string
  window: string
  state: AccountUsageLine["state"]
  detail: boolean
  /** The account's name, or the blank a detail line is set in by. */
  name: string
  /** `5h 28% left`, `7d limited`; empty on a line with no reading. */
  level: string
  /** Drawn muted rather than in its state's colour: another window has the account refused. */
  dimmed: boolean
  /** The plan tier, drawn only on a line with no reading. */
  tier?: string
  spellings: string[]
}

const cells = (value: string) => Array.from(value).length
const segmentsCells = (segments: Segment[]) => segments.reduce((sum, segment) => sum + cells(segment.text), 0)

function levelRole(draft: LineDraft): Segment["role"] {
  if (draft.dimmed) return "muted"
  return draft.state === "limited" ? "error" : draft.state === "warning" ? "effort" : "ok"
}

/**
 * Segments cut to `budget` cells: a run that does not fit is cut with `…`, and
 * a separator that does not fit ends the line, since nothing it would
 * introduce fits either. A separator or the word `resets` left at the end with
 * nothing after it goes too.
 */
function fitSegments(segments: Segment[], budget: number): Segment[] {
  const out: Segment[] = []
  let used = 0
  for (const segment of segments) {
    const length = cells(segment.text)
    if (used + length <= budget) {
      out.push(segment)
      used += length
      continue
    }
    if (segment.text !== SEPARATOR) {
      const cut = truncate(segment.text, budget - used)
      if (cut) out.push({ ...segment, text: cut })
    }
    break
  }
  while (out.length > 0 && [SEPARATOR, RESET_WORD].includes(out[out.length - 1].text)) out.pop()
  return out
}

/**
 * What follows the name: the level and the reset for a reading, each in its
 * own colour; the tier (while `withTier`) and `no reading yet` without one. A
 * detail line starts at its level, with no separator ahead of it.
 */
function tailSegments(draft: LineDraft, spelling: number, withTier: boolean): Segment[] {
  if (draft.state === "none") {
    const out: Segment[] = []
    if (withTier && draft.tier) out.push({ text: SEPARATOR, role: "muted" }, { text: draft.tier, role: "tier" })
    out.push({ text: SEPARATOR, role: "muted" }, { text: NO_READING_TEXT, role: "muted" })
    return out
  }
  const out: Segment[] = draft.detail ? [] : [{ text: SEPARATOR, role: "muted" }]
  out.push({ text: draft.level, role: levelRole(draft) })
  const reset = draft.spellings[Math.min(spelling, draft.spellings.length - 1)]
  if (reset) {
    out.push({ text: SEPARATOR, role: "muted" })
    if (reset.startsWith(RESET_WORD)) {
      out.push({ text: RESET_WORD, role: "muted" }, { text: reset.slice(RESET_WORD.length), role: "reset" })
    } else {
      out.push({ text: reset, role: "reset" })
    }
  }
  return out
}

function readingDraft(
  account: string,
  name: string,
  window: string,
  entry: WindowUsage | undefined,
  now: number,
  detail = false,
  dimmed = false,
): LineDraft {
  return {
    account,
    window,
    state: entry ? stateOf(entry) : "ok",
    detail,
    name,
    level: levelText(window, entry),
    dimmed,
    spellings: entry ? resetSpellings(entry, now) : [],
  }
}

/** The drafts for one account: none, one, or a five-hour line with another window under it. */
function accountDrafts(
  account: string,
  windows: ReadonlyMap<string, WindowUsage> | undefined,
  known: KnownAccounts,
  now: number,
  width: number,
): LineDraft[] {
  const name = truncate(account, Math.max(1, Math.floor(width / 2)))
  const fiveHour = windows?.get(FIVE_HOUR_WINDOW)
  const current = fiveHour && isReadingCurrent(fiveHour, now) ? fiveHour : undefined
  // A five-hour window that is over is a fresh one, for an account this
  // install runs; one only the old readings remember is not listed.
  const rolled = fiveHour !== undefined && !current && known.has(account)
  if (current || rolled) {
    const other = windows ? pressingWindow(windows, now, FIVE_HOUR_WINDOW) : undefined
    const otherState = other ? stateOf(other[1]) : "ok"
    const drafts = [readingDraft(account, name, FIVE_HOUR_WINDOW, current, now, false, otherState === "limited")]
    if (other && otherState !== "ok") {
      const indent = " ".repeat(Math.min(MAX_DETAIL_INDENT, cells(name) + cells(SEPARATOR)))
      drafts.push(readingDraft(account, indent, other[0], other[1], now, true))
    }
    return drafts
  }
  const pressing = windows ? pressingWindow(windows, now) : undefined
  if (pressing) return [readingDraft(account, name, pressing[0], pressing[1], now)]
  if (!known.has(account)) return []
  return [
    {
      account,
      window: "",
      state: "none",
      detail: false,
      name,
      level: "",
      dimmed: false,
      tier: known.get(account)?.tier,
      spellings: [],
    },
  ]
}

/**
 * The login line under an account (h #g301), set in like the account's other
 * detail line. The date is spelt with the year when the line has room for it
 * and without it otherwise; a login is at most weeks away, so the year is the
 * part to give up.
 */
function loginLine(account: string, record: LoginExpiry, now: number, width: number): AccountUsageLine {
  const name = truncate(account, Math.max(1, Math.floor(width / 2)))
  const indent = " ".repeat(Math.min(MAX_DETAIL_INDENT, cells(name) + cells(SEPARATOR)))
  const budget = Math.max(0, width - cells(indent))
  const ended = record.expiresAt <= now
  let tail: Segment[]
  if (ended) {
    tail = [{ text: LOGIN_ENDED_TEXT, role: "error" }]
  } else {
    const full = formatResetClock(record.expiresAt, now)
    const short = formatResetClock(record.expiresAt, now, false)
    const date = cells(LOGIN_WORD) + cells(full) <= budget ? full : short
    tail = [
      { text: LOGIN_WORD, role: "muted" },
      { text: date, role: "effort" },
    ]
  }
  return {
    account,
    window: LOGIN_LINE,
    state: ended ? "limited" : "warning",
    detail: true,
    segments: [{ text: indent, role: "muted" }, ...fitSegments(tail, budget)],
  }
}

/**
 * Every account with a reading or a registration, alphabetically, each laid out
 * for `width`. The reset is spelt the same way on every line, the widest
 * spelling in `resetSpellings` that fits all of them, so the column reads
 * alike; a line with no reading gives up its tier before it is cut, and a line
 * that fits nothing else is cut.
 */
export function accountUsageLines(
  usage: AccountUsage,
  now: number,
  width: number = SIDEBAR_ROW_WIDTH,
  known: KnownAccounts = new Map(),
  logins: LoginExpiries = new Map(),
): AccountUsageLine[] {
  const drafts: LineDraft[] = []
  const names = [...new Set([...usage.keys(), ...known.keys()])].sort()
  for (const account of names) drafts.push(...accountDrafts(account, usage.get(account), known, now, width))
  const budget = (draft: LineDraft) => Math.max(0, width - cells(draft.name))
  // The reset's spelling is decided over the lines that have one; a line with
  // no reading has nothing to spell and does not move the column.
  const spelt = drafts.filter((draft) => draft.state !== "none")
  const last = Math.max(0, ...spelt.map((draft) => draft.spellings.length - 1))
  let spelling = 0
  while (
    spelling < last &&
    spelt.some((draft) => segmentsCells(tailSegments(draft, spelling, true)) > budget(draft))
  ) {
    spelling += 1
  }
  const lines: AccountUsageLine[] = drafts.map((draft) => {
    const full = tailSegments(draft, spelling, true)
    const tail = segmentsCells(full) <= budget(draft) ? full : tailSegments(draft, spelling, false)
    return {
      account: draft.account,
      window: draft.window,
      state: draft.state,
      detail: draft.detail,
      segments: [{ text: draft.name, role: draft.detail ? "muted" : "agent" }, ...fitSegments(tail, budget(draft))],
    }
  })
  if (logins.size === 0) return lines
  // A login line goes under the last line of an account that is listed; an
  // account no other line lists (one removed from the config) gets none.
  const out: AccountUsageLine[] = []
  lines.forEach((line, index) => {
    out.push(line)
    if (lines[index + 1]?.account === line.account) return
    const record = logins.get(line.account)
    if (record && isLoginExpiryDue(record, now)) out.push(loginLine(line.account, record, now, width))
  })
  return out
}

/** The plain text of a line, for tests and the collapsed summary. */
export function lineText(line: AccountUsageLine): string {
  return line.segments.map((segment) => segment.text).join("")
}
