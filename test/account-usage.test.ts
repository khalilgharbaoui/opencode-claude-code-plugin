/**
 * The account usage store and the decisions made off it (h #g244): one
 * reading per account per window, written on every `rate_limit_event`, and
 * the thresholds a `▌ **usage:**` note already announced in that window.
 *
 * Every test points the store at its own scratch file, so nothing here can
 * touch the operator's `$XDG_STATE_HOME` even outside `npm test`.
 *
 * Usage: npx tsx --test test/account-usage.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_USAGE_SWITCH_AT,
  DEFAULT_USAGE_WARN_THRESHOLDS,
  UNTIMED_READING_TTL_MS,
  USAGE_READING_MAX_AGE_MS,
  _setAccountUsageStorePathForTests,
  accountUsageAtOrOver,
  applyReading,
  createAccountUsageReader,
  isReadingCurrent,
  markUsageNoted,
  pendingCrossings,
  recordRateLimitObservation,
  recordUsageReading,
  registerKnownAccounts,
  resolveUsageSwitchAt,
  resolveUsageWarnThresholds,
  snapshotAccountUsage,
  snapshotKnownAccounts,
  usageCrossings,
  usagePercent,
  usageReadingsFromObservation,
  type WindowUsage,
} from "../src/account-usage.js"
import {
  USAGE_MARKER,
  _resetAccountOverrides,
  _resetAccountLimitMemory,
  formatUsageNote,
  nextUsageSwitchAccount,
} from "../src/account-failover.js"

const DIR = mkdtempSync(join(tmpdir(), "opencode-account-usage-"))
let fileIndex = 0
let file = ""

beforeEach(() => {
  file = join(DIR, `state-${fileIndex++}`, "account-usage.json")
  _setAccountUsageStorePathForTests(file)
})

after(() => {
  _setAccountUsageStorePathForTests(null)
  rmSync(DIR, { recursive: true, force: true })
})

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const HOUR = 60 * 60 * 1000

function entry(over: Partial<WindowUsage> = {}): WindowUsage {
  return {
    utilization: 0.5,
    resetsAt: NOW + HOUR,
    status: "allowed",
    observedAt: NOW,
    noted: [],
    ...over,
  }
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

test("usageWarnThresholds: unset is the default, junk is dropped, [] turns the notes off", () => {
  assert.deepEqual(resolveUsageWarnThresholds(undefined), [...DEFAULT_USAGE_WARN_THRESHOLDS])
  assert.deepEqual(DEFAULT_USAGE_WARN_THRESHOLDS, [50, 75, 90, 95])
  assert.deepEqual(resolveUsageWarnThresholds([90, 50, 50, 0, -1, 101, "80", Number.NaN]), [50, 90])
  assert.deepEqual(resolveUsageWarnThresholds([]), [])
})

test("usageSwitchAt: unset and junk are the default, false and 0 are never", () => {
  assert.equal(DEFAULT_USAGE_SWITCH_AT, 90)
  assert.equal(resolveUsageSwitchAt(undefined), 90)
  assert.equal(resolveUsageSwitchAt("80"), 90)
  assert.equal(resolveUsageSwitchAt(150), 90)
  assert.equal(resolveUsageSwitchAt(80), 80)
  assert.equal(resolveUsageSwitchAt(false), null)
  assert.equal(resolveUsageSwitchAt(0), null)
})

// ---------------------------------------------------------------------------
// The CLI's unit, and readings that are not current
// ---------------------------------------------------------------------------

test("utilization is the CLI's fraction: 0.9 is exactly 90 percent", () => {
  assert.equal(usagePercent(0.9), 90)
  assert.equal(usagePercent(0.75), 75)
  assert.equal(usagePercent(0.761), 76.1)
})

test("a reading is current until its reset, and a reading with no reset for a bounded time", () => {
  assert.equal(isReadingCurrent(entry(), NOW), true)
  assert.equal(isReadingCurrent(entry({ resetsAt: NOW - 1 }), NOW), false)
  const untimed = entry({ resetsAt: undefined, observedAt: NOW })
  assert.equal(isReadingCurrent(untimed, NOW + UNTIMED_READING_TTL_MS - 1), true)
  assert.equal(isReadingCurrent(untimed, NOW + UNTIMED_READING_TTL_MS), false)
})

// ---------------------------------------------------------------------------
// Crossings and their dedup, as pure functions
// ---------------------------------------------------------------------------

test("a reading crosses every threshold at or under it that no note announced yet", () => {
  assert.deepEqual(pendingCrossings(entry({ utilization: 0.76 }), [50, 75, 90, 95], NOW), [50, 75])
  assert.deepEqual(pendingCrossings(entry({ utilization: 0.75 }), [75], NOW), [75])
  assert.deepEqual(
    pendingCrossings(entry({ utilization: 0.91, noted: [50, 75] }), [50, 75, 90, 95], NOW),
    [90],
  )
  assert.deepEqual(
    pendingCrossings(entry({ utilization: 0.91, noted: [50, 75, 90] }), [50, 75, 90, 95], NOW),
    [],
  )
})

test("unknown utilization, a rejection and a window that is over cross nothing", () => {
  // An `allowed` event with headroom carries no utilization at all: unknown,
  // never zero, and never a crossing.
  assert.deepEqual(pendingCrossings(entry({ utilization: null }), [50], NOW), [])
  // A window that ran out gets the usage-limit note, not this one.
  assert.deepEqual(pendingCrossings(entry({ utilization: 1, status: "rejected" }), [50], NOW), [])
  assert.deepEqual(pendingCrossings(entry({ utilization: 0.99, resetsAt: NOW - 1 }), [50], NOW), [])
})

test("what was noted carries over to a new reading only while the previous one is current", () => {
  const previous = entry({ utilization: 0.76, noted: [50, 75] })
  const same = applyReading(previous, { utilization: 0.8, resetsAt: NOW + HOUR, status: "allowed_warning" }, NOW)
  assert.deepEqual(same.noted, [50, 75])
  // The reset passed: a new window, and every crossing may be said again.
  const later = NOW + 2 * HOUR
  const next = applyReading(previous, { utilization: 0.6, resetsAt: later + 5 * HOUR, status: "allowed" }, later)
  assert.deepEqual(next.noted, [])
  assert.deepEqual(pendingCrossings(next, [50, 75], later), [50])
})

test("a reading keeps exactly what the CLI said, with an unknown utilization as null", () => {
  const reading = applyReading(undefined, { utilization: null, status: "allowed" }, NOW)
  assert.deepEqual(reading, { utilization: null, status: "allowed", observedAt: NOW, noted: [] })
  const text = applyReading(
    undefined,
    { utilization: null, resetsText: "3pm (Europe/Amsterdam)", status: "rejected" },
    NOW,
  )
  assert.equal(text.resetsText, "3pm (Europe/Amsterdam)")
  // A timed reset makes the phrase redundant.
  const both = applyReading(
    undefined,
    { utilization: null, resetsAt: NOW + HOUR, resetsText: "3pm", status: "rejected" },
    NOW,
  )
  assert.equal(both.resetsText, undefined)
})

// ---------------------------------------------------------------------------
// The store on disk
// ---------------------------------------------------------------------------

test("store round trip: a reading written is read back, 0600 in a 0700 directory", () => {
  const written = recordUsageReading("appical", "five_hour", {
    utilization: 0.72,
    resetsAt: NOW + HOUR,
    status: "allowed_warning",
  }, NOW)
  assert.ok(written)
  // POSIX modes mean nothing on Windows (see .github/windows-skipped-tests.txt);
  // the round trip itself runs everywhere.
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(statSync(join(file, "..")).mode & 0o777, 0o700)
  }

  const raw = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(raw.version, 1)
  assert.deepEqual(raw.accounts.appical.five_hour, {
    utilization: 0.72,
    resetsAt: NOW + HOUR,
    status: "allowed_warning",
    observedAt: NOW,
    noted: [],
  })

  // A fresh process: the cache is forgotten, the file is the answer.
  _setAccountUsageStorePathForTests(file)
  const snapshot = snapshotAccountUsage(NOW)
  assert.equal(snapshot.get("appical")?.get("five_hour")?.utilization, 0.72)
})

test("the file holds account names, window names, numbers and times, and nothing else", () => {
  recordUsageReading("appical", "seven_day", { utilization: 0.9, resetsAt: NOW + HOUR, status: "allowed_warning" }, NOW)
  markUsageNoted("appical", "seven_day", [50, 75, 90], NOW)
  const raw = JSON.parse(readFileSync(file, "utf8"))
  assert.deepEqual(Object.keys(raw).sort(), ["accounts", "version"])
  assert.deepEqual(Object.keys(raw.accounts.appical.seven_day).sort(), [
    "noted",
    "observedAt",
    "resetsAt",
    "status",
    "utilization",
  ])
  assert.deepEqual(raw.accounts.appical.seven_day.noted, [50, 75, 90])
})

test("the accounts registered at startup sit beside the readings, are replaced on each registration, and ride a reading's write", () => {
  recordUsageReading("appical", "five_hour", { utilization: 0.4, resetsAt: NOW + HOUR, status: "allowed" }, NOW)
  assert.equal(registerKnownAccounts([{ account: "appical", tier: "Max 20x" }, { account: "default" }], NOW), true)
  const reader = createAccountUsageReader(() => file, () => NOW)
  assert.deepEqual([...reader.known()], [["appical", { tier: "Max 20x", at: NOW }], ["default", { at: NOW }]])
  assert.equal(reader.read().get("appical")?.get("five_hour")?.utilization, 0.4, "the readings are untouched")
  assert.equal(reader.known(), reader.known(), "an unchanged file hands back the same map")
  // A reading or a mark written later carries the registration with it.
  recordUsageReading("default", "five_hour", { utilization: null, resetsAt: NOW + HOUR, status: "allowed" }, NOW + 1)
  markUsageNoted("appical", "five_hour", [50], NOW + 2)
  assert.deepEqual([...snapshotKnownAccounts(NOW + 2).keys()], ["appical", "default"])
  // The next registration is the configured set, not a merge: a removed account leaves, a tier can change.
  registerKnownAccounts([{ account: "default", tier: "Pro" }], NOW + 3)
  assert.deepEqual([...snapshotKnownAccounts(NOW + 3)], [["default", { tier: "Pro", at: NOW + 3 }]])
  assert.equal(snapshotAccountUsage(NOW + 3).get("appical")?.get("five_hour")?.noted[0], 50, "the readings survive it")
  // The file holds names, tier labels and times under `known`, and nothing else.
  const raw = JSON.parse(readFileSync(file, "utf8"))
  assert.deepEqual(Object.keys(raw).sort(), ["accounts", "known", "version"])
  assert.deepEqual(Object.keys(raw.known.default).sort(), ["at", "tier"])
})

test("a registration that changes nothing is not rewritten, and junk names, tiers and shapes are dropped", () => {
  registerKnownAccounts([{ account: "appical", tier: "Max 20x" }], NOW)
  const ino = statSync(file).ino
  assert.equal(registerKnownAccounts([{ account: "appical", tier: "Max 20x" }], NOW + 1), true)
  assert.equal(statSync(file).ino, ino, "the same list is not written again")
  registerKnownAccounts(
    [
      { account: "Appical Work", tier: "Max 20x" },
      { account: "ok", tier: "sk-ant-secret!" },
      { account: "fine", tier: "Pro" },
    ],
    NOW + 2,
  )
  assert.deepEqual(
    [...snapshotKnownAccounts(NOW + 2)],
    [["ok", { at: NOW + 2 }], ["fine", { tier: "Pro", at: NOW + 2 }]],
  )
  // A `known` another writer mangled reads as nothing registered; the readings beside it still read.
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      accounts: { fine: { five_hour: entry() } },
      known: { fine: { at: "soon" }, 7: [] },
    }),
  )
  assert.deepEqual([...snapshotKnownAccounts(NOW)], [])
  assert.equal(snapshotAccountUsage(NOW).get("fine")?.get("five_hour")?.utilization, 0.5)
  writeFileSync(file, JSON.stringify({ version: 1, accounts: {}, known: "nope" }))
  assert.deepEqual([...snapshotKnownAccounts(NOW)], [])
})

test("two writers merge: neither erases the other's account or window", () => {
  recordUsageReading("appical", "five_hour", { utilization: 0.5, resetsAt: NOW + HOUR, status: "allowed" }, NOW)
  // Another opencode process writes the same file from its own empty cache.
  const other = JSON.parse(readFileSync(file, "utf8"))
  other.accounts.default = {
    seven_day: { utilization: 0.3, resetsAt: NOW + HOUR, status: "allowed", observedAt: NOW, noted: [] },
  }
  writeFileSync(file, JSON.stringify(other))
  recordUsageReading("appical", "seven_day", { utilization: 0.6, resetsAt: NOW + HOUR, status: "allowed" }, NOW)

  const raw = JSON.parse(readFileSync(file, "utf8"))
  assert.deepEqual(Object.keys(raw.accounts).sort(), ["appical", "default"])
  assert.deepEqual(Object.keys(raw.accounts.appical).sort(), ["five_hour", "seven_day"])
  assert.equal(raw.accounts.default.seven_day.utilization, 0.3)
})

test("a crossing another process already announced is not announced again", () => {
  recordUsageReading("appical", "five_hour", { utilization: 0.76, resetsAt: NOW + HOUR, status: "allowed_warning" }, NOW)
  assert.deepEqual(usageCrossings("appical", [50, 75], NOW)[0]?.crossed, [50, 75])
  // Another process says it and marks it on disk; this process's cache still
  // thinks both are pending.
  const raw = JSON.parse(readFileSync(file, "utf8"))
  raw.accounts.appical.five_hour.noted = [50, 75]
  writeFileSync(file, JSON.stringify(raw))
  assert.deepEqual(usageCrossings("appical", [50, 75], NOW), [])
})

test("marking a threshold noted is what dedups the next turn, and survives a restart", () => {
  recordUsageReading("appical", "five_hour", { utilization: 0.76, resetsAt: NOW + HOUR, status: "allowed_warning" }, NOW)
  assert.equal(markUsageNoted("appical", "five_hour", [50, 75], NOW), true)
  assert.deepEqual(usageCrossings("appical", [50, 75, 90], NOW), [])
  // A new reading in the same window keeps what was said.
  recordUsageReading("appical", "five_hour", { utilization: 0.91, resetsAt: NOW + HOUR, status: "allowed_warning" }, NOW)
  _setAccountUsageStorePathForTests(file)
  assert.deepEqual(usageCrossings("appical", [50, 75, 90], NOW)[0]?.crossed, [90])
})

test("a reset passing clears the window's crossings", () => {
  recordUsageReading("appical", "five_hour", { utilization: 0.8, resetsAt: NOW + HOUR, status: "allowed_warning" }, NOW)
  markUsageNoted("appical", "five_hour", [50, 75], NOW)
  // Past the reset nothing is pending, because the reading is over.
  assert.deepEqual(usageCrossings("appical", [50, 75], NOW + 2 * HOUR), [])
  // The new window's first reading starts with nothing noted.
  const fresh = recordUsageReading(
    "appical",
    "five_hour",
    { utilization: 0.55, resetsAt: NOW + 7 * HOUR, status: "allowed" },
    NOW + 2 * HOUR,
  )
  assert.deepEqual(fresh?.noted, [])
  assert.deepEqual(usageCrossings("appical", [50, 75], NOW + 2 * HOUR)[0]?.crossed, [50])
})

test("a malformed, half-written or wrongly shaped file is an empty store, and is replaced on the next write", () => {
  mkdirSync(join(file, ".."), { recursive: true })
  for (const body of ["", "{", "null", "[]", '{"accounts":[]}', '{"accounts":{"appical":"x"}}']) {
    writeFileSync(file, body)
    _setAccountUsageStorePathForTests(file)
    assert.equal(snapshotAccountUsage(NOW).size, 0, `body ${JSON.stringify(body)}`)
  }
  recordUsageReading("appical", "five_hour", { utilization: 0.4, resetsAt: NOW + HOUR, status: "allowed" }, NOW)
  assert.equal(snapshotAccountUsage(NOW).get("appical")?.get("five_hour")?.utilization, 0.4)
})

test("entries of the wrong shape are dropped one by one, and names are checked", () => {
  recordUsageReading("seed", "five_hour", { utilization: null, status: "allowed" }, NOW)
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      accounts: {
        appical: {
          five_hour: { utilization: 0.5, resetsAt: NOW + HOUR, status: "allowed", observedAt: NOW, noted: [50, "x", 500] },
          seven_day: { utilization: "lots", status: "allowed", observedAt: NOW },
          "../etc": { utilization: 0.5, status: "allowed", observedAt: NOW },
        },
        "Not A Name": { five_hour: { utilization: 0.5, status: "allowed", observedAt: NOW } },
      },
    }),
  )
  _setAccountUsageStorePathForTests(file)
  const usage = snapshotAccountUsage(NOW)
  assert.deepEqual([...usage.keys()], ["appical"])
  assert.deepEqual([...usage.get("appical")!.keys()], ["five_hour"])
  assert.deepEqual(usage.get("appical")!.get("five_hour")!.noted, [50])
  assert.equal(recordUsageReading("Not A Name", "five_hour", { utilization: 0.1, status: "allowed" }, NOW), null)
})

test("a reading not refreshed in over a week is dropped", () => {
  recordUsageReading("appical", "five_hour", { utilization: 0.4, resetsAt: NOW + HOUR, status: "allowed" }, NOW)
  const later = NOW + USAGE_READING_MAX_AGE_MS + 1
  recordUsageReading("default", "five_hour", { utilization: 0.1, resetsAt: later + HOUR, status: "allowed" }, later)
  const raw = JSON.parse(readFileSync(file, "utf8"))
  assert.deepEqual(Object.keys(raw.accounts), ["default"])
})

test("accountUsageAtOrOver reads current windows only, and a rejection counts", () => {
  recordUsageReading("appical", "five_hour", { utilization: 0.91, resetsAt: NOW + HOUR, status: "allowed_warning" }, NOW)
  recordUsageReading("default", "five_hour", { utilization: null, resetsAt: NOW + HOUR, status: "rejected" }, NOW)
  recordUsageReading("other", "five_hour", { utilization: 0.5, resetsAt: NOW + HOUR, status: "allowed" }, NOW)
  assert.equal(accountUsageAtOrOver("appical", 90, NOW), true)
  assert.equal(accountUsageAtOrOver("appical", 90, NOW + 2 * HOUR), false)
  assert.equal(accountUsageAtOrOver("default", 90, NOW), true)
  assert.equal(accountUsageAtOrOver("other", 90, NOW), false)
  assert.equal(accountUsageAtOrOver("unseen", 90, NOW), false)
})

test("the TUI reader re-parses only when the file changed", () => {
  const reader = createAccountUsageReader(() => file, () => NOW)
  assert.equal(reader.read().size, 0)
  recordUsageReading("appical", "five_hour", { utilization: 0.4, resetsAt: Date.now() + HOUR, status: "allowed" })
  const first = reader.read()
  assert.equal(first.get("appical")?.get("five_hour")?.utilization, 0.4)
  assert.equal(reader.read(), first, "an unchanged file hands back the same map")
  rmSync(file)
  assert.equal(reader.read().size, 0)
})

// ---------------------------------------------------------------------------
// The switch's target and the note
// ---------------------------------------------------------------------------

test("a switch at a threshold never moves onto an account that is no better off", () => {
  _resetAccountOverrides()
  _resetAccountLimitMemory()
  recordUsageReading("alpha", "five_hour", { utilization: 0.95, resetsAt: NOW + HOUR, status: "allowed_warning" }, NOW)
  recordUsageReading("beta", "five_hour", { utilization: 0.2, resetsAt: NOW + HOUR, status: "allowed" }, NOW)
  assert.equal(nextUsageSwitchAccount(["alpha", "beta"], new Set(["appical"]), 90, NOW), "beta")
  assert.equal(nextUsageSwitchAccount(["alpha"], new Set(["appical"]), 90, NOW), undefined)
  assert.equal(nextUsageSwitchAccount(["alpha", "beta"], new Set(["beta"]), 90, NOW), undefined)
})

test("the usage note names the account, the window, the percent and the local reset", () => {
  const resetsAt = new Date(2026, 9, 17, 18, 0).getTime()
  const note = formatUsageNote({
    account: "appical",
    windows: [{ window: "five_hour", percent: 76, resetsAt }],
  })
  assert.ok(note.trimStart().startsWith(USAGE_MARKER))
  assert.match(note, /"appical" has used 76% of the 5-hour window, which resets at 2026-10-17 18:00\./)
  assert.doesNotMatch(note, /pick a model|move to/)

  const moved = formatUsageNote({
    account: "appical",
    windows: [{ window: "five_hour", percent: 91, resetsAt }],
    movedTo: { target: "default", until: resetsAt },
  })
  assert.match(moved, /New turns move to the "default" account until 2026-10-17 18:00\./)

  const named = formatUsageNote({
    account: "appical",
    windows: [
      { window: "five_hour", percent: 91, resetsAt },
      { window: "seven_day", percent: 50, resetsText: "Monday" },
    ],
    candidates: ["default"],
  })
  assert.match(named, /91% of the 5-hour window, which resets at 2026-10-17 18:00; and 50% of /)
  assert.match(named, /resets Monday/)
  assert.match(named, /pick a model from .*"default"/)
})

// ---------------------------------------------------------------------------
// unifiedWindows: every window's own reading (h #g266)
// ---------------------------------------------------------------------------

test("an event's unifiedWindows gives the limiting window its utilization and every other window a reading of its own", () => {
  const readings = usageReadingsFromObservation(
    {
      window: "five_hour",
      status: "allowed",
      resetsAt: NOW + HOUR,
      windows: {
        five_hour: { utilization: 0.31, resetsAt: NOW + HOUR },
        seven_day: { utilization: 0.62, resetsAt: NOW + 72 * HOUR },
      },
    },
    () => undefined,
    NOW,
  )
  assert.deepEqual(readings, [
    ["five_hour", { utilization: 0.31, resetsAt: NOW + HOUR, status: "allowed" }],
    ["seven_day", { utilization: 0.62, resetsAt: NOW + 72 * HOUR, status: "allowed" }],
  ])
})

test("the top level's own utilization and reset win for the limiting window", () => {
  const [limiting] = usageReadingsFromObservation(
    {
      window: "five_hour",
      status: "allowed_warning",
      utilization: 0.9,
      resetsAt: NOW + HOUR,
      windows: { five_hour: { utilization: 0.89, resetsAt: NOW + HOUR + 60_000 } },
    },
    () => undefined,
    NOW,
  )
  assert.deepEqual(limiting, ["five_hour", { utilization: 0.9, resetsAt: NOW + HOUR, status: "allowed_warning" }])
})

test("an event without unifiedWindows records only the limiting window, as before", () => {
  assert.deepEqual(
    usageReadingsFromObservation({ window: "five_hour", status: "allowed", resetsAt: NOW + HOUR }, () => undefined, NOW),
    [["five_hour", { utilization: null, resetsAt: NOW + HOUR, status: "allowed" }]],
  )
  // No limiting window and no windows: nothing to record.
  assert.deepEqual(usageReadingsFromObservation({ status: "allowed" }, () => undefined, NOW), [])
})

test("a window still refused from an earlier event stays refused while it reads at or past its cap", () => {
  const refused = entry({ status: "rejected", utilization: null, resetsAt: NOW + 72 * HOUR })
  const observation = {
    window: "five_hour",
    status: "allowed",
    windows: {
      five_hour: { utilization: 0.2, resetsAt: NOW + HOUR },
      seven_day: { utilization: 1, resetsAt: NOW + 72 * HOUR },
    },
  }
  const previous = (window: string) => (window === "seven_day" ? refused : undefined)
  assert.equal(usageReadingsFromObservation(observation, previous, NOW)[1][1].status, "rejected")
  // Under its cap it is no longer refused.
  observation.windows.seven_day.utilization = 0.97
  assert.equal(usageReadingsFromObservation(observation, previous, NOW)[1][1].status, "allowed")
  // A refusal whose reset has passed is over.
  const lapsed = entry({ status: "rejected", utilization: null, resetsAt: NOW - 1 })
  observation.windows.seven_day.utilization = 1
  assert.equal(
    usageReadingsFromObservation(observation, () => lapsed, NOW)[1][1].status,
    "allowed",
  )
})

test("recordRateLimitObservation writes every window in one go and keeps what each had already announced", () => {
  recordUsageReading("appical", "seven_day", { utilization: 0.8, resetsAt: NOW + 72 * HOUR, status: "allowed_warning" }, NOW)
  markUsageNoted("appical", "seven_day", [50, 75], NOW)
  assert.equal(
    recordRateLimitObservation(
      "appical",
      {
        window: "five_hour",
        status: "allowed",
        resetsAt: NOW + HOUR,
        windows: {
          five_hour: { utilization: 0.4, resetsAt: NOW + HOUR },
          seven_day: { utilization: 0.81, resetsAt: NOW + 72 * HOUR },
        },
      },
      NOW + 1,
    ),
    true,
  )
  const windows = snapshotAccountUsage(NOW + 1).get("appical")
  assert.equal(windows?.get("five_hour")?.utilization, 0.4)
  assert.equal(windows?.get("seven_day")?.utilization, 0.81)
  assert.deepEqual(windows?.get("seven_day")?.noted, [50, 75])
  // The 50% crossing of the five-hour window is now knowable, and nothing else is pending.
  assert.deepEqual(
    usageCrossings("appical", DEFAULT_USAGE_WARN_THRESHOLDS, NOW + 1).map((crossing) => [crossing.window, crossing.crossed]),
    [],
  )
  recordRateLimitObservation("appical", { windows: { five_hour: { utilization: 0.55, resetsAt: NOW + HOUR } } }, NOW + 2)
  assert.deepEqual(
    usageCrossings("appical", DEFAULT_USAGE_WARN_THRESHOLDS, NOW + 2).map((crossing) => [crossing.window, crossing.crossed]),
    [["five_hour", [50]]],
  )
  // Nothing usable is not a write.
  assert.equal(recordRateLimitObservation("appical", { status: "allowed" }, NOW + 3), false)
  assert.equal(recordRateLimitObservation("Not A Name", { window: "five_hour", status: "allowed" }, NOW + 3), false)
})
