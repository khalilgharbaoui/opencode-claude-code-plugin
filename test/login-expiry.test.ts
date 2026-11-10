/**
 * When each account's stored claude.ai login ends (h #g301): the date Claude
 * Code 2.1.318+ puts on every `result` as `credential_expires_at`, kept per
 * account in the account usage store, and the one `▌ **login:**` note a served
 * turn ends with when that date is close.
 *
 * The parser, the store (write-on-change, the note's dedup across processes
 * and across a new login, the age cutoff, a broken file, the usage writers
 * keeping it), the option's resolver, the note's three wordings and its
 * transcript strip. The same through a real `doStream` is in
 * `test/login-expiry-stream.test.ts`, the sidebar line in
 * `test/account-sidebar.test.ts`, the doctor section in `test/doctor.test.ts`.
 *
 * Usage: npx tsx --test test/login-expiry.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import {
  DAY_MS,
  DEFAULT_LOGIN_EXPIRY_WARN_DAYS,
  LOGIN_EARLY_END_DAYS,
  LOGIN_RECORD_MAX_AGE_MS,
  LOGIN_RECORD_REFRESH_MS,
  _setAccountUsageStorePathForTests,
  createAccountUsageReader,
  isLoginExpiryDue,
  isLoginNoted,
  markLoginNoted,
  pendingLoginNote,
  recordLoginExpiry,
  recordRateLimitObservation,
  registerKnownAccounts,
  resolveLoginExpiryWarnDays,
  snapshotLoginExpiries,
} from "../src/account-usage.js"
import { LOGIN_MARKER, formatLoginExpiryNote, loginCommandFor } from "../src/account-failover.js"
import { parseCredentialExpiresAt } from "../src/cli-events.js"
import { filterSideQuestionHistory } from "../src/message-builder.js"

const ROOT = mkdtempSync(join(tmpdir(), "opencode-login-expiry-"))
let storeFile = ""
let counter = 0

beforeEach(() => {
  storeFile = join(ROOT, `case-${counter++}`, "account-usage.json")
  _setAccountUsageStorePathForTests(storeFile)
})

after(() => {
  _setAccountUsageStorePathForTests(null)
  rmSync(ROOT, { recursive: true, force: true })
})

const NOW = Date.UTC(2026, 10, 10, 12, 0)
const IN_9_DAYS = NOW + 9 * DAY_MS
const IN_20_DAYS = NOW + 20 * DAY_MS

const onDisk = () => JSON.parse(readFileSync(storeFile, "utf8"))

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

test("credential_expires_at is read off a result as epoch ms, and nothing else carries it", () => {
  // Verbatim shape of a 2.1.322 result on a claude.ai login (2026-11-10).
  const result = {
    type: "result",
    subtype: "success",
    result_index: 0,
    credential_expires_at: "2026-11-30T14:43:52.761Z",
    fast_mode_state: "off",
  }
  assert.equal(parseCredentialExpiresAt(result as any), Date.parse("2026-11-30T14:43:52.761Z"))
  // An API key, an older CLI: no field.
  assert.equal(parseCredentialExpiresAt({ type: "result", subtype: "success" } as any), undefined)
  // `system`/`init` never has it; a frame that did would not be a result.
  assert.equal(
    parseCredentialExpiresAt({ type: "system", subtype: "init", credential_expires_at: "2026-11-30T14:43:52.761Z" } as any),
    undefined,
  )
  assert.equal(parseCredentialExpiresAt({ type: "result", credential_expires_at: "soon" } as any), undefined)
  assert.equal(parseCredentialExpiresAt({ type: "result", credential_expires_at: 1795000000 } as any), undefined)
})

// ---------------------------------------------------------------------------
// The option
// ---------------------------------------------------------------------------

test("loginExpiryWarnDays: unset is 10, false and 0 are off, past 30 or unusable is the default", () => {
  assert.equal(DEFAULT_LOGIN_EXPIRY_WARN_DAYS, 10)
  assert.equal(resolveLoginExpiryWarnDays(undefined), 10)
  assert.equal(resolveLoginExpiryWarnDays(false), 0)
  assert.equal(resolveLoginExpiryWarnDays(0), 0)
  assert.equal(resolveLoginExpiryWarnDays(14), 14)
  assert.equal(resolveLoginExpiryWarnDays(0.5), 0.5)
  assert.equal(resolveLoginExpiryWarnDays(31), 10)
  assert.equal(resolveLoginExpiryWarnDays(-1), 10)
  assert.equal(resolveLoginExpiryWarnDays("7"), 10)
})

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

test("a login's end is recorded per account, as a date and nothing else", () => {
  const record = recordLoginExpiry("appical", IN_9_DAYS, 10, NOW)
  assert.deepEqual(record, { expiresAt: IN_9_DAYS, observedAt: NOW, warnDays: 10 })
  const file = onDisk()
  assert.deepEqual(file.logins, { appical: { expiresAt: IN_9_DAYS, observedAt: NOW, warnDays: 10 } })
  if (process.platform !== "win32") {
    assert.equal(statSync(storeFile).mode & 0o777, 0o600)
    assert.equal(statSync(join(storeFile, "..")).mode & 0o777, 0o700)
  }
  assert.deepEqual([...snapshotLoginExpiries(NOW).keys()], ["appical"])
  // An unusable name or date records nothing.
  assert.equal(recordLoginExpiry("../etc", IN_9_DAYS, 10, NOW), null)
  assert.equal(recordLoginExpiry("appical", Number.NaN, 10, NOW), null)
})

test("an unchanged date is not rewritten on every turn, only once an hour", () => {
  recordLoginExpiry("appical", IN_9_DAYS, 10, NOW)
  rmSync(storeFile)
  // The same date inside the hour: answered from this process's view, no write.
  recordLoginExpiry("appical", IN_9_DAYS, 10, NOW + 60_000)
  assert.throws(() => statSync(storeFile), /ENOENT/)
  // An hour on, it is written again with the new observation.
  const later = recordLoginExpiry("appical", IN_9_DAYS, 10, NOW + LOGIN_RECORD_REFRESH_MS)
  assert.equal(later?.observedAt, NOW + LOGIN_RECORD_REFRESH_MS)
  assert.equal(onDisk().logins.appical.observedAt, NOW + LOGIN_RECORD_REFRESH_MS)
})

test("a changed date or warning window is written at once", () => {
  recordLoginExpiry("appical", IN_9_DAYS, 10, NOW)
  recordLoginExpiry("appical", IN_20_DAYS, 10, NOW + 1000)
  assert.equal(onDisk().logins.appical.expiresAt, IN_20_DAYS)
  recordLoginExpiry("appical", IN_20_DAYS, 25, NOW + 2000)
  assert.equal(onDisk().logins.appical.warnDays, 25)
})

test("the note is due inside the window, once per login, and again for a new login", () => {
  recordLoginExpiry("appical", IN_20_DAYS, 10, NOW)
  assert.equal(pendingLoginNote("appical", NOW), undefined, "20 days out is outside a 10-day window")

  recordLoginExpiry("appical", IN_9_DAYS, 10, NOW)
  const due = pendingLoginNote("appical", NOW)
  assert.equal(due?.expiresAt, IN_9_DAYS)
  assert.equal(markLoginNoted("appical", IN_9_DAYS, NOW), true)
  assert.equal(pendingLoginNote("appical", NOW), undefined)
  assert.equal(onDisk().logins.appical.notedFor, IN_9_DAYS)

  // The same login re-reported keeps its note said.
  recordLoginExpiry("appical", IN_9_DAYS, 10, NOW + LOGIN_RECORD_REFRESH_MS)
  assert.equal(pendingLoginNote("appical", NOW + LOGIN_RECORD_REFRESH_MS), undefined)

  // A new login is a new date: due again once IT is inside the window.
  const relogin = NOW + 30 * DAY_MS
  recordLoginExpiry("appical", relogin, 10, NOW + 2 * LOGIN_RECORD_REFRESH_MS)
  assert.equal(pendingLoginNote("appical", NOW + 2 * LOGIN_RECORD_REFRESH_MS), undefined)
  assert.equal(pendingLoginNote("appical", relogin - 5 * DAY_MS)?.expiresAt, relogin)
})

test("a note another opencode process already wrote is not written twice", () => {
  recordLoginExpiry("appical", IN_9_DAYS, 10, NOW)
  assert.ok(pendingLoginNote("appical", NOW))
  // Another process marks it in the file; this one's view still says due.
  const file = onDisk()
  file.logins.appical.notedFor = IN_9_DAYS
  writeFileSync(storeFile, JSON.stringify(file))
  assert.equal(pendingLoginNote("appical", NOW), undefined)
})

test("a warning window of 0 is never due, and a passed date is due until said", () => {
  recordLoginExpiry("appical", IN_9_DAYS, 0, NOW)
  assert.equal(pendingLoginNote("appical", NOW), undefined)
  const past = { expiresAt: NOW - DAY_MS, observedAt: NOW, warnDays: 10 }
  assert.equal(isLoginExpiryDue(past, NOW), true)
  assert.equal(isLoginNoted(past), false)
  assert.equal(isLoginNoted({ ...past, notedFor: NOW - DAY_MS + 60_000 }), true, "an hour's slack")
  assert.equal(isLoginNoted({ ...past, notedFor: NOW - 31 * DAY_MS }), false)
})

test("the usage writers and the startup registration keep the logins they did not write", () => {
  recordLoginExpiry("appical", IN_9_DAYS, 10, NOW)
  recordRateLimitObservation("appical", { window: "five_hour", status: "allowed", utilization: 0.4 }, NOW)
  registerKnownAccounts([{ account: "appical" }, { account: "default" }], NOW)
  const file = onDisk()
  assert.equal(file.logins.appical.expiresAt, IN_9_DAYS)
  assert.equal(file.accounts.appical.five_hour.utilization, 0.4)
  assert.deepEqual(Object.keys(file.known).sort(), ["appical", "default"])
})

test("a record not refreshed in 30 days is dropped, and a malformed one is ignored", () => {
  mkdirSync(join(storeFile, ".."), { recursive: true })
  writeFileSync(
    storeFile,
    JSON.stringify({
      version: 1,
      accounts: {},
      logins: {
        appical: { expiresAt: IN_9_DAYS, observedAt: NOW - LOGIN_RECORD_MAX_AGE_MS - 1, warnDays: 10 },
        default: { expiresAt: IN_9_DAYS, observedAt: NOW, warnDays: 10, notedFor: IN_9_DAYS },
        work: { expiresAt: "2026-11-19", observedAt: NOW },
        "../x": { expiresAt: IN_9_DAYS, observedAt: NOW, warnDays: 10 },
        old: { expiresAt: IN_9_DAYS, observedAt: NOW },
      },
    }),
  )
  const logins = snapshotLoginExpiries(NOW)
  assert.deepEqual([...logins.keys()].sort(), ["default", "old"])
  assert.equal(logins.get("default")?.notedFor, IN_9_DAYS)
  // A record from before the window was stored reads with the default window.
  assert.equal(logins.get("old")?.warnDays, DEFAULT_LOGIN_EXPIRY_WARN_DAYS)

  writeFileSync(storeFile, "{not json")
  assert.equal(snapshotLoginExpiries(NOW).size, 0)
})

test("the TUI's reader hands back the logins, the same map while the file is unchanged", () => {
  const reader = createAccountUsageReader(() => storeFile, () => NOW)
  assert.equal(reader.logins().size, 0)
  recordLoginExpiry("appical", IN_9_DAYS, 10, NOW)
  const first = reader.logins()
  assert.equal(first.get("appical")?.expiresAt, IN_9_DAYS)
  assert.equal(reader.logins(), first)
})

// ---------------------------------------------------------------------------
// The note
// ---------------------------------------------------------------------------

const localMinute = (ms: number) => {
  const when = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`
}

test("the note names the account, the local date, the early end and the login command", () => {
  const configDir = join(homedir(), ".claude-appical")
  const note = formatLoginExpiryNote({
    account: "appical",
    configDir,
    expiresAt: IN_9_DAYS,
    now: NOW,
    earlyDays: LOGIN_EARLY_END_DAYS,
  })
  assert.ok(note.trimStart().startsWith(LOGIN_MARKER))
  // The account-block note's own command, whatever the platform spells it as.
  const command = loginCommandFor(configDir)
  if (process.platform !== "win32") assert.equal(command, "CLAUDE_CONFIG_DIR=~/.claude-appical claude auth login")
  assert.equal(
    note,
    `\n${LOGIN_MARKER} the Claude account "appical" stays signed in until about ${localMinute(IN_9_DAYS)}, in 9 days, ` +
      `and the login can end up to 3 days sooner. Log in again with \`${command}\` before then, so no turn fails on it.\n`,
  )
  assert.doesNotMatch(note, /\u2014/)
})

test("inside the early-end window it says any day now, and once past it says the next turn may be refused", () => {
  const soon = formatLoginExpiryNote({ account: "default", expiresAt: NOW + 2 * DAY_MS, now: NOW, earlyDays: 3 })
  assert.match(soon, /"default" can be signed out any day now, by \d{4}-\d\d-\d\d \d\d:\d\d at the latest\./)
  assert.match(soon, /`claude auth login` now/)
  const past = formatLoginExpiryNote({ account: "default", expiresAt: NOW - DAY_MS, now: NOW, earlyDays: 3 })
  assert.match(past, /"default" was due to be signed out at \d{4}-\d\d-\d\d \d\d:\d\d\. This turn was still served/)
  assert.match(past, /log in again with `claude auth login`\./)
})

test("the note is stripped from a replayed transcript like every other plugin note", () => {
  const prompt = [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "answered" },
        { type: "text", text: formatLoginExpiryNote({ account: "default", expiresAt: IN_9_DAYS, now: NOW, earlyDays: 3 }) },
      ],
    },
  ] as any
  const serialized = JSON.stringify(filterSideQuestionHistory(prompt))
  assert.equal(serialized.includes(LOGIN_MARKER), false)
  assert.match(serialized, /answered/)
})
