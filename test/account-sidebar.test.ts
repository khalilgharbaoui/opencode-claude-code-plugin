/**
 * The sidebar's `Accounts` lines (`src/account-sidebar.ts`, h #g244, h #g248,
 * h #g266): what is left of each account's five-hour window, the second line a
 * refused or nearly spent weekly window adds under it, how each reads, which
 * colour each piece takes, that every account registered at startup is listed
 * from the first draw, and that an account the store knows nothing about is
 * not.
 *
 * Usage: npx tsx --test test/account-sidebar.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  NO_READING_TEXT,
  accountUsageLines,
  formatResetClock,
  lineText,
  percentLeft,
  pressingWindow,
  resetSpellings,
  shortWindowName,
  type AccountUsageLine,
} from "../src/account-sidebar.js"
import type { AccountUsage, KnownAccounts, WindowUsage } from "../src/account-usage.js"
import { SIDEBAR_ROW_WIDTH } from "../src/subagent-sidebar.js"

const NOW = new Date(2026, 9, 17, 15, 30).getTime()
const AT_18 = new Date(2026, 9, 17, 18, 0).getTime()
const TOMORROW = new Date(2026, 9, 18, 1, 20).getTime()
const OCT_21 = new Date(2026, 9, 21, 12, 0).getTime()

function reading(over: Partial<WindowUsage> = {}): WindowUsage {
  return { utilization: 0.72, resetsAt: AT_18, status: "allowed_warning", observedAt: NOW, noted: [], ...over }
}

function usage(entries: Record<string, Record<string, WindowUsage>>): AccountUsage {
  return new Map(
    Object.entries(entries).map(([account, windows]) => [account, new Map(Object.entries(windows))]),
  )
}

/** What the server half registered at startup. */
function known(entries: Record<string, { tier?: string }>): KnownAccounts {
  return new Map(Object.entries(entries).map(([account, record]) => [account, { ...record, at: NOW }]))
}

const roleOf = (line: AccountUsageLine, text: string) => line.segments.find((segment) => segment.text === text)?.role
const painted = (line: AccountUsageLine) => line.segments.map((segment) => [segment.text, segment.role])

test("one line per account: name, what is left of the five-hour window, and the local reset", () => {
  const lines = accountUsageLines(usage({ appical: { five_hour: reading() } }), NOW)
  assert.equal(lines.length, 1)
  assert.equal(lineText(lines[0]), "appical · 5h 28% left · resets 18:00")
  assert.equal(lines[0].state, "ok")
  assert.equal(lines[0].detail, false)
})

test("what is left is whole percent, never below zero", () => {
  assert.equal(percentLeft(0.72), 28)
  assert.equal(percentLeft(0), 100)
  assert.equal(percentLeft(0.9), 10)
  // The CLI documents utilization above 1 for usage past a window's cap.
  assert.equal(percentLeft(1.2), 0)
})

test("a reset on another day carries its date in the usage note's notation, with or without the year", () => {
  assert.equal(formatResetClock(OCT_21, NOW), "2026-10-21 12:00")
  assert.equal(formatResetClock(OCT_21, NOW, false), "10-21 12:00")
  assert.equal(formatResetClock(AT_18, NOW), "18:00")
  assert.deepEqual(resetSpellings(reading({ resetsAt: OCT_21 }), NOW), [
    "resets 2026-10-21 12:00",
    "2026-10-21 12:00",
    "10-21 12:00",
  ])
  assert.deepEqual(resetSpellings(reading(), NOW), ["resets 18:00"])
  assert.deepEqual(resetSpellings(reading({ resetsAt: undefined, resetsText: "6pm" }), NOW), ["resets 6pm", "6pm"])
  assert.deepEqual(resetSpellings(reading({ resetsAt: undefined }), NOW), [])
})

test("a reset on another day fits the row by dropping the word, then the year, the same way on every line", () => {
  const appical = (over: Partial<WindowUsage> = {}) => ({ five_hour: reading({ resetsAt: TOMORROW, ...over }) })
  // `resets 2026-10-18 01:20` would be 47 cells with the name, the date alone 40; without the year it fits.
  assert.equal(lineText(accountUsageLines(usage({ appical: appical() }), NOW)[0]), "appical · 5h 28% left · 10-18 01:20")
  // Given the room, the word stays.
  assert.equal(
    lineText(accountUsageLines(usage({ appical: appical() }), NOW, 60)[0]),
    "appical · 5h 28% left · resets 2026-10-18 01:20",
  )
  // One line that needs the shortest spelling takes the year off every line, so the column reads alike.
  const two = accountUsageLines(
    usage({ appical: appical(), default: appical({ utilization: null, status: "allowed" }) }),
    NOW,
  )
  assert.deepEqual(two.map(lineText), ["appical · 5h 28% left · 10-18 01:20", "default · 5h ok · 10-18 01:20"])
  // A reset today keeps its word beside them: it always fits.
  const mixed = accountUsageLines(usage({ appical: appical(), default: { five_hour: reading() } }), NOW)
  assert.deepEqual(mixed.map(lineText), ["appical · 5h 28% left · 10-18 01:20", "default · 5h 28% left · resets 18:00"])
})

test("window names are short, an unknown one is shown as itself and `unknown` as nothing", () => {
  assert.equal(shortWindowName("five_hour"), "5h")
  assert.equal(shortWindowName("seven_day"), "7d")
  assert.equal(shortWindowName("seven_day_opus"), "7d opus")
  assert.equal(shortWindowName("brand_new"), "brand new")
  assert.equal(shortWindowName("unknown"), "")
})

test("the most pressing window is the refused one first, else the fullest, and can leave one out", () => {
  const windows = new Map([
    ["five_hour", reading({ utilization: 0.4 })],
    ["seven_day", reading({ utilization: 0.81 })],
  ])
  assert.equal(pressingWindow(windows, NOW)?.[0], "seven_day")
  windows.set("seven_day_opus", reading({ utilization: null, status: "rejected" }))
  assert.equal(pressingWindow(windows, NOW)?.[0], "seven_day_opus")
  windows.set("five_hour", reading({ utilization: null, status: "rejected" }))
  assert.equal(pressingWindow(windows, NOW, "five_hour")?.[0], "seven_day_opus")
})

test("a refusal reads `limited`, the interactive transport's included, with whatever reset it named", () => {
  const lines = accountUsageLines(
    usage({
      appical: { five_hour: reading({ utilization: null, status: "rejected" }) },
      default: {
        unknown: reading({ utilization: null, status: "rejected", resetsAt: undefined, resetsText: "6pm" }),
      },
    }),
    NOW,
  )
  assert.deepEqual(lines.map(lineText), ["appical · 5h limited · resets 18:00", "default · limited · resets 6pm"])
  assert.deepEqual(lines.map((line) => line.state), ["limited", "limited"])
  assert.equal(roleOf(lines[0], "5h limited"), "error")
})

test("the level and the reset time are different roles, and the word `resets` stays muted", () => {
  const [line] = accountUsageLines(usage({ appical: { five_hour: reading() } }), NOW)
  assert.deepEqual(painted(line), [
    ["appical", "agent"],
    [" · ", "muted"],
    ["5h 28% left", "ok"],
    [" · ", "muted"],
    ["resets ", "muted"],
    ["18:00", "reset"],
  ])
  // A refusal colours the level, never the time: the time is what the operator waits for.
  const [limited] = accountUsageLines(
    usage({ appical: { five_hour: reading({ utilization: null, status: "rejected" }) } }),
    NOW,
  )
  assert.deepEqual(painted(limited).slice(2), [
    ["5h limited", "error"],
    [" · ", "muted"],
    ["resets ", "muted"],
    ["18:00", "reset"],
  ])
  // With the word dropped, the whole date and time is the reset's.
  const [dated] = accountUsageLines(usage({ appical: { five_hour: reading({ resetsAt: TOMORROW }) } }), NOW)
  assert.deepEqual(painted(dated).slice(3), [[" · ", "muted"], ["10-18 01:20", "reset"]])
  // The interactive transport's phrase splits the same way, given the room; at the row's width it is cut.
  const phrase = usage({ appical: { five_hour: reading({ resetsAt: undefined, resetsText: "6pm (Europe/Amsterdam)" }) } })
  const [phrased] = accountUsageLines(phrase, NOW, 60)
  assert.deepEqual(painted(phrased).slice(4), [["resets ", "muted"], ["6pm (Europe/Amsterdam)", "reset"]])
  assert.equal(lineText(accountUsageLines(phrase, NOW)[0]), "appical · 5h 28% left · 6pm (Europe…")
})

test("every account registered at startup is listed from the first draw: its tier and `no reading yet` until one arrives", () => {
  const lines = accountUsageLines(
    usage({ appical: { five_hour: reading() } }),
    NOW,
    SIDEBAR_ROW_WIDTH,
    known({ default: { tier: "Max 20x" }, appical: { tier: "Max 5x" } }),
  )
  assert.deepEqual(lines.map(lineText), ["appical · 5h 28% left · resets 18:00", "default · Max 20x · no reading yet"])
  assert.deepEqual(lines.map((line) => line.state), ["ok", "none"])
  assert.equal(lines[1].window, "")
  assert.deepEqual(painted(lines[1]), [
    ["default", "agent"],
    [" · ", "muted"],
    ["Max 20x", "tier"],
    [" · ", "muted"],
    [NO_READING_TEXT, "muted"],
  ])
  // An account with a reading shows the reading, never its tier.
  assert.equal(roleOf(lines[0], "Max 5x"), undefined)
  // Without a tier the line says only that no reading has arrived.
  assert.equal(
    lineText(accountUsageLines(new Map(), NOW, SIDEBAR_ROW_WIDTH, known({ default: {} }))[0]),
    "default · no reading yet",
  )
  // An account the store knows only from a reading (one from before this install registered any) is still listed.
  assert.deepEqual(
    accountUsageLines(usage({ old: { five_hour: reading() } }), NOW, SIDEBAR_ROW_WIDTH, known({ default: {} })).map(lineText),
    ["default · no reading yet", "old · 5h 28% left · resets 18:00"],
  )
})

test("a registered account whose five-hour window has reset has all of a fresh one, with no reset time", () => {
  const over = accountUsageLines(
    usage({ appical: { five_hour: reading({ resetsAt: NOW - 1, utilization: 0.97 }) } }),
    NOW,
    SIDEBAR_ROW_WIDTH,
    known({ appical: { tier: "Max 20x" } }),
  )
  assert.deepEqual(over.map(lineText), ["appical · 5h 100% left"])
  assert.equal(over[0].state, "ok")
  assert.equal(over[0].window, "five_hour")
  assert.equal(roleOf(over[0], "5h 100% left"), "ok")
  // A refusal that has reset is over too.
  assert.deepEqual(
    accountUsageLines(
      usage({ appical: { five_hour: reading({ resetsAt: NOW - 1, utilization: null, status: "rejected" }) } }),
      NOW,
      SIDEBAR_ROW_WIDTH,
      known({ appical: {} }),
    ).map(lineText),
    ["appical · 5h 100% left"],
  )
})

test("a registered account whose only window has reset reads `no reading yet` again, and gives up its tier before it is cut", () => {
  const over = accountUsageLines(
    usage({ appical: { seven_day: reading({ resetsAt: NOW - 1 }) } }),
    NOW,
    SIDEBAR_ROW_WIDTH,
    known({ appical: { tier: "Max 20x" } }),
  )
  assert.deepEqual(over.map(lineText), ["appical · Max 20x · no reading yet"])
  assert.equal(over[0].state, "none")
  // `appical-work · Max 20x · no reading yet` is 39 cells; at 30 the tier goes and the rest stays whole.
  const tight = accountUsageLines(new Map(), NOW, 30, known({ "appical-work": { tier: "Max 20x" } }))
  assert.equal(lineText(tight[0]), "appical-work · no reading yet")
  // A line with no reading does not move the reset column of the lines that have one.
  const mixed = accountUsageLines(
    usage({ appical: { five_hour: reading({ resetsAt: TOMORROW }) } }),
    NOW,
    SIDEBAR_ROW_WIDTH,
    known({ workstation: { tier: "Enterprise" } }),
  )
  assert.deepEqual(mixed.map(lineText), ["appical · 5h 28% left · 10-18 01:20", "workstation · no reading yet"])
})

test("a weekly window at 75% used or more gets a second line, set in under the level", () => {
  const lines = accountUsageLines(
    usage({
      appical: {
        five_hour: reading({ utilization: 0.3, status: "allowed" }),
        seven_day: reading({ utilization: 0.81, status: "allowed", resetsAt: OCT_21 }),
      },
    }),
    NOW,
  )
  assert.deepEqual(lines.map(lineText), ["appical · 5h 70% left · resets 18:00", "          7d 19% left · 10-21 12:00"])
  assert.deepEqual(
    lines.map((line) => [line.window, line.state, line.detail]),
    [
      ["five_hour", "ok", false],
      ["seven_day", "warning", true],
    ],
  )
  assert.equal(roleOf(lines[0], "5h 70% left"), "ok", "a weekly warning does not dim the five-hour level")
  assert.equal(roleOf(lines[1], "7d 19% left"), "effort")
  // Under the warning level the weekly window adds nothing.
  const calm = accountUsageLines(
    usage({ appical: { five_hour: reading({ utilization: 0.3 }), seven_day: reading({ utilization: 0.5 }) } }),
    NOW,
  )
  assert.deepEqual(calm.map(lineText), ["appical · 5h 70% left · resets 18:00"])
})

test("a refused weekly window mutes the five-hour level, which is no room to work in", () => {
  const lines = accountUsageLines(
    usage({
      default: {
        five_hour: reading({ utilization: 0.1, status: "allowed" }),
        seven_day: reading({ utilization: null, status: "rejected", resetsAt: OCT_21 }),
      },
    }),
    NOW,
  )
  assert.deepEqual(lines.map(lineText), ["default · 5h 90% left · resets 18:00", "          7d limited · 10-21 12:00"])
  assert.equal(roleOf(lines[0], "5h 90% left"), "muted")
  assert.equal(roleOf(lines[1], "7d limited"), "error")
  assert.equal(lines[1].state, "limited")
  // The same under a five-hour window that has reset.
  const rolled = accountUsageLines(
    usage({
      default: {
        five_hour: reading({ resetsAt: NOW - 1 }),
        seven_day: reading({ utilization: null, status: "rejected", resetsAt: OCT_21 }),
      },
    }),
    NOW,
    SIDEBAR_ROW_WIDTH,
    known({ default: {} }),
  )
  assert.deepEqual(rolled.map(lineText), ["default · 5h 100% left", "          7d limited · 10-21 12:00"])
  assert.equal(roleOf(rolled[0], "5h 100% left"), "muted")
})

test("an account with no five-hour reading shows its most pressing window instead, in what is left", () => {
  const lines = accountUsageLines(usage({ appical: { seven_day: reading({ utilization: 0.9 }) } }), NOW)
  assert.deepEqual(lines.map(lineText), ["appical · 7d 10% left · resets 18:00"])
  assert.equal(lines[0].state, "warning")
  assert.equal(lines[0].detail, false)
  // A reset that does not fit takes the word `resets` with it rather than leave it hanging.
  const opus = accountUsageLines(usage({ appical: { seven_day_opus: reading({ utilization: 0.9 }) } }), NOW)
  assert.deepEqual(opus.map(lineText), ["appical · 7d opus 10% left"])
})

test("unknown utilization is `ok`, never 100% left, and 75% used or more takes the warning colour", () => {
  const lines = accountUsageLines(
    usage({
      a: { five_hour: reading({ utilization: null, status: "allowed" }) },
      b: { five_hour: reading({ utilization: 0.75 }) },
    }),
    NOW,
  )
  assert.equal(lineText(lines[0]), "a · 5h ok · resets 18:00")
  assert.equal(roleOf(lines[0], "5h ok"), "ok", "under the warning level the reading is green, the word `ok` included")
  assert.equal(lineText(lines[1]), "b · 5h 25% left · resets 18:00")
  assert.equal(lines[1].state, "warning")
  assert.equal(roleOf(lines[1], "5h 25% left"), "effort")
})

test("nothing is drawn for an account the store knows nothing about: an empty store, or an unregistered account whose reset passed", () => {
  assert.deepEqual(accountUsageLines(new Map(), NOW), [])
  assert.deepEqual(
    accountUsageLines(usage({ appical: { five_hour: reading({ resetsAt: NOW - 1 }) } }), NOW),
    [],
  )
})

test("no line runs past the sidebar's width, a long name's detail line included", () => {
  const lines = accountUsageLines(
    usage({
      "a-very-long-account-name-indeed": {
        five_hour: reading(),
        seven_day_overage_included: reading({ status: "rejected", resetsAt: OCT_21 }),
      },
    }),
    NOW,
    24,
  )
  assert.equal(lines.length, 2)
  for (const line of lines) assert.ok(Array.from(lineText(line)).length <= 24, lineText(line))
  // Set in at most twelve cells, so the detail keeps room for its level.
  assert.match(lineText(lines[1]), /^ {12}7d extra/)
})
