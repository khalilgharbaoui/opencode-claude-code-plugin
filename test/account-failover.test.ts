/**
 * Account failover: the limit signal, the account-scoped override, the form,
 * the answer, and the replay.
 *
 * The unit half pins the pieces a wrong answer would silently break (the
 * detection's NEGATIVE cases above all: a transient error must never move
 * where the billing lands). The fake-CLI half drives a real `doStream` twice
 * and asserts what only the wiring can show: that the limited turn ends on a
 * `question` tool-call rather than an error, and that the answer turn spawns
 * the OTHER account with the `@` suffix off the model and the conversation
 * replayed.
 *
 * Usage: npx tsx --test test/account-failover.test.ts
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { ensureAccountRuntime } from "../src/accounts.js"
import { configDirForAccount } from "../src/account-transcript.js"
import { interactiveTranscriptPath } from "../src/claude-session-bun.js"
import {
  ACCOUNT_FAILOVER_TOOL_CALL_PREFIX,
  FAILOVER_MARKER,
  ACCOUNT_BLOCK_MARKER,
  USAGE_LIMIT_MARKER,
  _resetAccountLimitMemory,
  _resetAccountOverrides,
  accountBlockKind,
  recallAccountLimit,
  rememberAccountLimit,
  describeOtherAccounts,
  formatAccountBlockNote,
  formatUsageLimitNote,
  loginCommandFor,
  buildFailoverContinuationPrompt,
  clearAccountOverride,
  consumeAccountFailoverAnswer,
  createAccountFailoverQuestionCall,
  failoverCandidates,
  failoverUntil,
  formatFailoverNote,
  isAccountFailoverQuestionActive,
  isAccountLimitError,
  resolveAccountOverride,
  resolveFailoverSpawn,
  setAccountOverride,
  stripAccountFailoverParts,
  stripAccountSuffix,
} from "../src/account-failover.js"
import {
  RATE_LIMIT_MARKER,
  _resetRateLimitReports,
  _resetSystemInitReports,
  describeRateLimit,
  formatLocalMinute,
} from "../src/cli-events.js"
import {
  consumeExitPlanModeQuestionResult,
  createExitPlanModeQuestionCall,
} from "../src/plan-mode-question.js"
import { createClaudeCode } from "../src/index.js"
import { filterSideQuestionHistory, getClaudeUserMessage } from "../src/message-builder.js"
import { setOpencodeClient } from "../src/runtime-status.js"
import {
  deleteActiveProcess,
  killAllActiveProcesses,
  sessionKey,
} from "../src/session-manager.js"

// Every account runtime this file builds lands under a throwaway HOME, so no
// test ever writes a wrapper or a config dir into the real one.
const HOME = mkdtempSync(join(tmpdir(), "opencode-failover-home-"))
const originalHome = process.env.HOME
const originalCache = process.env.XDG_CACHE_HOME
// The default account's config dir is `CLAUDE_CONFIG_DIR` when the operator
// set one, and the cross-account carry writes into it, so an exported one in
// the runner's environment would send a transcript to the real `~/.claude`
// the redirected HOME above exists to keep out of this.
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.HOME = HOME
process.env.XDG_CACHE_HOME = join(HOME, "cache")
delete process.env.CLAUDE_CONFIG_DIR

after(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalCache === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = originalCache
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(HOME, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

test("a rejected rate-limit event is an account limit", () => {
  assert.equal(
    isAccountLimitError({ rateLimit: { status: "rejected", rateLimitType: "five_hour" } }),
    true,
  )
  assert.equal(isAccountLimitError({ rateLimit: { overageStatus: "rejected" } }), true)
})

test("both known limit error texts are recognised", () => {
  assert.equal(
    isAccountLimitError({
      resultText:
        "API Error: 400 Third-party apps now draw from your extra usage balance.",
    }),
    true,
  )
  assert.equal(
    isAccountLimitError({
      resultText: "You've hit your individual spend limit. Resets at 2026-09-20T18:00:00Z.",
    }),
    true,
  )
  // Curly apostrophe, which is what a copy-pasted CLI message often carries.
  assert.equal(
    isAccountLimitError({ resultText: "You’ve hit your individual spend limit." }),
    true,
  )
})

test("nothing else counts as an account limit", () => {
  // The whole point of matching two exact strings: a transient failure that
  // opened this form would silently move where the billing lands.
  assert.equal(
    isAccountLimitError({ rateLimit: { status: "allowed_warning", utilization: 0.9 } }),
    false,
  )
  assert.equal(isAccountLimitError({ rateLimit: { status: "allowed" } }), false)
  assert.equal(
    isAccountLimitError({ resultText: "API Error: 400 invalid model name" }),
    false,
  )
  assert.equal(
    isAccountLimitError({ resultText: "fetch failed: ECONNRESET" }),
    false,
  )
  assert.equal(isAccountLimitError({}), false)
  assert.equal(isAccountLimitError({ resultText: "" }), false)
})

// ---------------------------------------------------------------------------
// The override store
// ---------------------------------------------------------------------------

test("an override is account-scoped, expires at the reset time, and can be cleared", () => {
  _resetAccountOverrides()
  const now = 1_000_000
  setAccountOverride("appical", "default", now + 5_000, now)

  assert.equal(resolveAccountOverride("appical", now), "default")
  // Account-scoped, so every other account is untouched.
  assert.equal(resolveAccountOverride("default", now), undefined)
  // One second past the reset and the conversation goes back on its own.
  assert.equal(resolveAccountOverride("appical", now + 5_001), undefined)
  // Expiry deletes, so the next read is not a second log line.
  assert.equal(resolveAccountOverride("appical", now), undefined)

  setAccountOverride("appical", "default")
  // No reset time from the CLI means "until opencode restarts".
  assert.equal(resolveAccountOverride("appical", now + 10_000_000), "default")
  clearAccountOverride("appical")
  assert.equal(resolveAccountOverride("appical", now), undefined)

  // An override onto itself would be a spawn loop, not a failover.
  setAccountOverride("appical", "appical")
  assert.equal(resolveAccountOverride("appical", now), undefined)
  _resetAccountOverrides()
})

test("a reset time that is not in the future does not expire the switch at once", () => {
  // Found by the fake-CLI test: with `until` behind `now` (clock skew, or a
  // stale `resetsAt`), the very next read deleted the override and the turn
  // spawned the limited account again and re-hit the same limit.
  _resetAccountOverrides()
  const now = 1_000_000
  setAccountOverride("appical", "default", now - 1, now)
  assert.equal(resolveAccountOverride("appical", now), "default")
  assert.equal(resolveAccountOverride("appical", now + 10_000_000), "default")
  _resetAccountOverrides()
})

test("failoverUntil accepts the CLI's seconds and tolerates milliseconds", () => {
  assert.equal(failoverUntil(1_700_000_000), 1_700_000_000_000)
  assert.equal(failoverUntil(1_700_000_000_000), 1_700_000_000_000)
  assert.equal(failoverUntil(undefined), undefined)
})

// ---------------------------------------------------------------------------
// Resolving the spawn
// ---------------------------------------------------------------------------

test("the model's @account suffix comes off for a failover spawn", () => {
  assert.equal(stripAccountSuffix("claude-opus-5@appical"), "claude-opus-5")
  assert.equal(stripAccountSuffix("claude-opus-5"), "claude-opus-5")
})

test("resolveFailoverSpawn leaves everything alone without an override", async () => {
  _resetAccountOverrides()
  const spawn = await resolveFailoverSpawn({
    account: "appical",
    baseCliPath: "/bin/claude",
    cliPath: "/cache/claude-appical",
    modelId: "claude-opus-5@appical",
  })
  assert.deepEqual(spawn, {
    cliPath: "/cache/claude-appical",
    modelId: "claude-opus-5@appical",
    failedOver: false,
  })
})

test("a default target spawns the bare binary, a named target its wrapper", async () => {
  _resetAccountOverrides()
  setAccountOverride("appical", "default")
  const toDefault = await resolveFailoverSpawn({
    account: "appical",
    baseCliPath: "/bin/claude",
    cliPath: "/cache/claude-appical",
    modelId: "claude-opus-5@appical",
  })
  // `default` has no config dir at all, so it is the base binary itself.
  assert.equal(toDefault.cliPath, "/bin/claude")
  assert.equal(toDefault.modelId, "claude-opus-5")
  assert.equal(toDefault.target, "default")
  assert.equal(toDefault.failedOver, true)

  _resetAccountOverrides()
  setAccountOverride("default", "work")
  const toNamed = await resolveFailoverSpawn({
    account: "default",
    baseCliPath: "/bin/claude",
    cliPath: "/bin/claude",
    modelId: "claude-opus-5",
  })
  assert.equal(toNamed.target, "work")
  assert.equal(toNamed.failedOver, true)
  assert.match(toNamed.cliPath, /claude-work$/)
  assert.equal(existsSync(toNamed.cliPath), true)
  _resetAccountOverrides()
})

// ---------------------------------------------------------------------------
// The gate and the candidate list
// ---------------------------------------------------------------------------

test("candidates are every configured account except the limited one", () => {
  assert.deepEqual(failoverCandidates(["default", "work", "appical"], "work"), [
    "default",
    "appical",
  ])
  assert.deepEqual(failoverCandidates(["default"], "default"), [])
  assert.deepEqual(failoverCandidates(undefined, "default"), [])
  // Normalised and deduped, the same way accounts.ts normalises them.
  assert.deepEqual(failoverCandidates(["My Work", "my-work"], "default"), ["my-work"])
})

test("the form is gated on more than one account, a question tool, and the session", () => {
  const base = {
    configured: "ask" as const,
    candidates: ["work"],
    opencodeHasQuestion: true,
    compactionMode: false,
    childSession: false,
  }
  assert.equal(isAccountFailoverQuestionActive(base), true)
  // Opt-in: only an explicit "ask" opens the form, so an unset option and
  // "off" both leave the limited turn on the quiet note (h #g194).
  assert.equal(
    isAccountFailoverQuestionActive({ ...base, configured: undefined }),
    false,
  )
  assert.equal(isAccountFailoverQuestionActive({ ...base, configured: "off" }), false)
  assert.equal(isAccountFailoverQuestionActive({ ...base, candidates: [] }), false)
  assert.equal(
    isAccountFailoverQuestionActive({ ...base, opencodeHasQuestion: false }),
    false,
  )
  assert.equal(isAccountFailoverQuestionActive({ ...base, compactionMode: true }), false)
  // A subagent follows its parent's account for free.
  assert.equal(isAccountFailoverQuestionActive({ ...base, childSession: true }), false)
})

test("the form is off unless the provider option explicitly asks for it", () => {
  // Both entry points must agree, and neither may write a default of its own:
  // the gate above reads an explicit "ask" and nothing else.
  assert.equal(
    (createClaudeCode({})("claude-sonnet-5") as any).config.accountFailover,
    undefined,
  )
  assert.equal(
    (createClaudeCode({ accountFailover: "ask" })("claude-sonnet-5") as any).config
      .accountFailover,
    "ask",
  )
  assert.equal(
    (createClaudeCode({ accountFailover: "off" })("claude-sonnet-5") as any).config
      .accountFailover,
    "off",
  )
})

// ---------------------------------------------------------------------------
// The quiet note, which is what a default install gets
// ---------------------------------------------------------------------------

test("the usage-limit note names the account, the window, the local reset and the move", () => {
  const resetsAt = 1_791_067_800 // the real one: 2026-10-03T22:50:00Z
  const note = formatUsageLimitNote({
    sourceAccount: "appical",
    candidates: ["default"],
    resetsAt,
    window: "five_hour",
  })
  assert.ok(note.trimStart().startsWith(USAGE_LIMIT_MARKER))
  assert.match(note, /the Claude account "appical" is out of usage in the 5-hour window/)
  // Local time, not the UTC instant the old rate-limit paragraph printed.
  assert.match(note, new RegExp(`resets at ${formatLocalMinute(resetsAt * 1000)}`))
  assert.equal(note.includes("2026-10-03T22:50"), false)
  assert.match(note, /Pick a model from the "default" account and resend your message/)
  assert.match(note, /or wait for the window to reset\./)
  // Two sentences, which is the whole budget: the paragraph it replaces ran
  // to five and the operator read none of them.
  assert.equal(note.trim().split(". ").length, 2)
})

test("with no other account the note says what is left: wait, or enable extra usage", () => {
  const note = formatUsageLimitNote({
    sourceAccount: "default",
    candidates: [],
    resetsAt: 1_791_067_800,
    window: "five_hour",
  })
  assert.match(note, /Wait for the window to reset, or enable extra usage on the account\./)
  assert.equal(note.includes("Pick a model"), false)
})

test("an unknown window and a missing reset are omitted, never guessed", () => {
  const bare = formatUsageLimitNote({ sourceAccount: "appical", candidates: [] })
  assert.match(bare, /the Claude account "appical" is out of usage\. Wait for/)
  assert.equal(bare.includes("resets at"), false)
  // A rateLimitType the plugin has no friendly name for still says something.
  assert.match(
    formatUsageLimitNote({
      sourceAccount: "appical",
      candidates: [],
      window: "fortnightly_opus",
    }),
    /out of usage in fortnightly_opus\./,
  )
})

test("what a rejection said about an account outlives the turn that saw it", () => {
  // Measured live on one `opencode serve` process against an exhausted
  // five-hour window: the CLI emits `rate_limit_event` when its view of the
  // limits CHANGES, not per request, so the second limited turn on a reused
  // child carried no event and the note read "is out of usage." with nothing
  // after it. The limit belongs to the account, so the first turn's facts are
  // the right answer for the rest of the window.
  _resetAccountLimitMemory()
  const now = 1_791_060_000_000
  const resetsAt = 1_791_067_800 // 7,800 s after `now`
  assert.deepEqual(recallAccountLimit("appical", now), {})

  rememberAccountLimit("Appical", { resetsAt, window: "five_hour" })
  assert.deepEqual(recallAccountLimit("appical", now), { resetsAt, window: "five_hour" })
  // Account-scoped, exactly like the override.
  assert.deepEqual(recallAccountLimit("default", now), {})

  // Past the reset the window has turned over, so the instant is dropped
  // rather than telling the operator to wait for a time already gone. Which
  // window ran out does not expire.
  assert.deepEqual(recallAccountLimit("appical", resetsAt * 1000 + 1), {
    window: "five_hour",
  })
  _resetAccountLimitMemory()
})

test("the accounts to move to are named, normalised and joined", () => {
  assert.equal(describeOtherAccounts([]), "")
  assert.equal(describeOtherAccounts(["default"]), 'the "default" account')
  assert.equal(describeOtherAccounts(["My Work", "default"]), 'the "my-work" or "default" account')
  assert.equal(
    describeOtherAccounts(["a", "b", "c"]),
    'the "a", "b" or "c" account',
  )
  assert.match(
    formatUsageLimitNote({ sourceAccount: "appical", candidates: ["work", "default"] }),
    /Pick a model from the "work" or "default" account and resend/,
  )
})

test("the account-block note offers the hand switch only when the form is not", () => {
  const withForm = formatAccountBlockNote({
    kind: "authentication_failed",
    account: "appical",
    configDir: "/tmp/.claude-appical",
    offeringSwitch: true,
    candidates: ["default"],
  })
  assert.match(withForm, /Or pick another account below\./)
  assert.equal(withForm.includes("pick a model from"), false)

  const withoutForm = formatAccountBlockNote({
    kind: "authentication_failed",
    account: "appical",
    configDir: "/tmp/.claude-appical",
    offeringSwitch: false,
    candidates: ["default"],
  })
  assert.match(withoutForm, /Or pick a model from the "default" account and resend\./)

  const alone = formatAccountBlockNote({
    kind: "billing_error",
    account: "default",
    offeringSwitch: false,
    candidates: [],
  })
  assert.match(alone, /Check the account at claude\.ai, then resend your message\.\n/)
  assert.equal(alone.includes("pick"), false)
})

test("a rate-limit rejection is log-only now, and the warning states are unchanged", () => {
  // The paragraph this reporter used to enqueue appeared on the first limited
  // turn of a process and on none of the others, because it dedupes per
  // identity per process. The note replaces it; the WARN stays.
  const rejected = describeRateLimit({
    status: "rejected",
    rateLimitType: "five_hour",
    resetsAt: 1_791_067_800,
    overageStatus: "rejected",
    overageDisabledReason: "org_level_disabled_until",
  })
  assert.equal(rejected?.level, "warn")
  assert.equal(rejected?.transcript, null)
  assert.match(rejected!.message, /rejected this request: you are out of usage in the 5-hour window/)
  assert.match(rejected!.message, /Resets at 2026-10-03T22:50:00\.000Z\./)

  // Not-yet-blocking states were already log-only and must stay that way.
  const warning = describeRateLimit({ status: "allowed_warning", utilization: 0.9 })
  assert.equal(warning?.level, "notice")
  assert.equal(warning?.transcript, null)
  const info = describeRateLimit({ status: "allowed", rateLimitType: "five_hour" })
  assert.equal(info?.level, "info")
  assert.equal(info?.transcript, null)

  // The marker stays strippable for conversations that still hold a block.
  assert.ok(RATE_LIMIT_MARKER.startsWith("▌"))
})

test("the usage-limit note is stripped from a transcript rebuilt for the CLI", () => {
  const note = formatUsageLimitNote({
    sourceAccount: "appical",
    candidates: ["default"],
    resetsAt: 1_791_067_800,
    window: "five_hour",
  })
  const prompt = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: note }],
    },
    { role: "user", content: [{ type: "text", text: "try again" }] },
  ] as any
  const serialized = JSON.stringify(filterSideQuestionHistory(prompt))
  assert.equal(serialized.includes(USAGE_LIMIT_MARKER), false)
  assert.equal(serialized.includes("out of usage"), false)
  assert.match(serialized, /try again/)
})

// ---------------------------------------------------------------------------
// The form and its answer
// ---------------------------------------------------------------------------

test("the form offers the other accounts plus stop, and names the reset time", () => {
  const call = createAccountFailoverQuestionCall("sk-form", {
    sourceAccount: "appical",
    candidates: ["default", "work"],
    resetsAt: 1_700_000_000,
    window: "five_hour",
  })

  assert.equal(call.toolName, "question")
  assert.ok(call.toolCallId.startsWith(ACCOUNT_FAILOVER_TOOL_CALL_PREFIX))
  const question = call.input.questions[0]
  assert.equal(question.header, "Account limit")
  assert.match(question.question, /"appical" is out of usage/)
  assert.match(question.question, /five_hour/)
  assert.match(question.question, /2023-11-14/)
  assert.match(question.question, /Leaving this unanswered waits/)
  assert.deepEqual(
    question.options.map((option) => option.label),
    ["default", "work", "stop"],
  )
  // The source account is never one of its own options.
  assert.equal(
    question.options.some((option) => option.label === "appical"),
    false,
  )
  // The two costs an operator cannot see from the label alone.
  assert.match(question.options[0].description, /replayed as a fresh Claude session/)
  assert.match(question.options[0].description, /MCP server configured only in "appical"/)
  assert.equal(question.custom, true)
  assert.equal(question.multiple, false)
})

function answer(toolCallId: string, output: unknown) {
  return [
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId, toolName: "question", output }],
    },
  ]
}

test("picking an offered account switches to it", () => {
  const call = createAccountFailoverQuestionCall("sk-a", {
    sourceAccount: "appical",
    candidates: ["default", "work"],
    resetsAt: 1_700_000_000,
  })
  const result = consumeAccountFailoverAnswer(
    "sk-a",
    answer(call.toolCallId, { type: "text", value: "work" }) as any,
  )
  assert.deepEqual(result, {
    kind: "switch",
    target: "work",
    sourceAccount: "appical",
    resetsAt: 1_700_000_000,
  })
})

test("custom text naming an account switches, and the answer is consumed once", () => {
  const call = createAccountFailoverQuestionCall("sk-b", {
    sourceAccount: "default",
    candidates: ["work"],
  })
  const prompt = answer(call.toolCallId, {
    type: "text",
    // opencode wraps a picked answer in its own sentence; the unwrapper
    // handles that, and the name itself is normalised the way accounts are.
    value: "  Work  ",
  }) as any
  assert.deepEqual(consumeAccountFailoverAnswer("sk-b", prompt), {
    kind: "switch",
    target: "work",
    sourceAccount: "default",
    resetsAt: undefined,
  })
  // Consumed: a replayed prompt must not switch a second time.
  assert.equal(consumeAccountFailoverAnswer("sk-b", prompt), null)
})

test("stop, a dismissal and unrecognised text all end the turn", () => {
  for (const [label, output] of [
    ["stop", { type: "text", value: "stop" }],
    ["dismissal", { type: "execution-denied", reason: "The user dismissed this question" }],
    ["unknown text", { type: "text", value: "use my other laptop" }],
    ["an account that was not offered", { type: "text", value: "appical" }],
    ["an empty answer", { type: "text", value: "   " }],
  ] as const) {
    const call = createAccountFailoverQuestionCall(`sk-${label}`, {
      sourceAccount: "default",
      candidates: ["work"],
    })
    const result = consumeAccountFailoverAnswer(
      `sk-${label}`,
      answer(call.toolCallId, output) as any,
    )
    assert.equal(result?.kind, "stop", `${label} should stop`)
  }
})

/**
 * The sentence opencode's `question` tool actually returns, as read out of
 * the 1.18.32 binary. Every failover pick arrived in this shape; the tests
 * above feed bare labels, which is how the form shipped unable to switch.
 */
function opencodeAnswer(question: string, ...answers: string[]): string {
  const value = answers.length > 0 ? answers.join(", ") : "Unanswered"
  return `User has answered your questions: "${question}"="${value}". You can now continue with the user's answers in mind.`
}

/**
 * What the opencode-dcp plugin appends on the way to the provider. Measured on
 * 2026-10-03 from the live log, raw bytes and all: the tag follows a newline
 * AFTER opencode's own suffix, which is what made `endsWith` miss and refused
 * three picks in a row as `unrecognised answer`. opencode's database stores
 * the output without it, so nothing upstream of the unwrapper can strip it.
 */
function withDcpTag(value: string, id = "m0795"): string {
  return `${value}\n<dcp-message-id>${id}</dcp-message-id>`
}

test("opencode's own answer sentence switches, although the question has quotes", () => {
  const call = createAccountFailoverQuestionCall("sk-real", {
    sourceAccount: "appical",
    candidates: ["default"],
    resetsAt: 1_790_170_000,
  })
  const question = call.input.questions[0].question
  // The failover question quotes the account, which is what defeats a naive split.
  assert.match(question, /"appical"/)
  assert.deepEqual(
    consumeAccountFailoverAnswer(
      "sk-real",
      answer(call.toolCallId, { type: "text", value: opencodeAnswer(question, "default") }) as any,
    ),
    { kind: "switch", target: "default", sourceAccount: "appical", resetsAt: 1_790_170_000 },
  )

  // `stop`, a blank answer and a dismissal in their real shapes.
  const stopCall = createAccountFailoverQuestionCall("sk-real-stop", {
    sourceAccount: "appical",
    candidates: ["default"],
  })
  const stopQuestion = stopCall.input.questions[0].question
  assert.deepEqual(
    consumeAccountFailoverAnswer(
      "sk-real-stop",
      answer(stopCall.toolCallId, { type: "text", value: opencodeAnswer(stopQuestion, "stop") }) as any,
    ),
    { kind: "stop", reason: "the operator chose to stop" },
  )
  const blankCall = createAccountFailoverQuestionCall("sk-real-blank", {
    sourceAccount: "appical",
    candidates: ["default"],
  })
  assert.deepEqual(
    consumeAccountFailoverAnswer(
      "sk-real-blank",
      answer(blankCall.toolCallId, {
        type: "text",
        value: opencodeAnswer(blankCall.input.questions[0].question),
      }) as any,
    ),
    { kind: "stop", reason: "no answer" },
  )
  const dismissCall = createAccountFailoverQuestionCall("sk-real-dismiss", {
    sourceAccount: "appical",
    candidates: ["default"],
  })
  assert.deepEqual(
    consumeAccountFailoverAnswer(
      "sk-real-dismiss",
      answer(dismissCall.toolCallId, {
        type: "error-text",
        value: "The user dismissed this question",
      }) as any,
    ),
    { kind: "stop", reason: "The user dismissed this question" },
  )
})

test("the answer opencode really returned, trailing newline included, switches", () => {
  // Measured 2026-09-28 on opencode 1.18.32 with a real five-hour limit: the
  // result ends in "\n", so an exact `endsWith` on the suffix missed it and
  // both picks ("appical", then "stop") were refused as unrecognised.
  const call = createAccountFailoverQuestionCall("sk-live", {
    sourceAccount: "default",
    candidates: ["appical"],
    resetsAt: 1_790_577_000,
    window: "five_hour",
  })
  const question = call.input.questions[0].question
  assert.equal(
    question,
    'The Claude account "default" is out of usage in five_hour, which resets at 2026-09-28T06:30:00.000Z. Continue this task on another configured account? Leaving this unanswered waits, at no cost.',
    "the fixture must be the question the live form asked",
  )
  assert.deepEqual(
    consumeAccountFailoverAnswer(
      "sk-live",
      answer(call.toolCallId, { type: "text", value: `${opencodeAnswer(question, "appical")}\n` }) as any,
    ),
    { kind: "switch", target: "appical", sourceAccount: "default", resetsAt: 1_790_577_000 },
  )

  const stopCall = createAccountFailoverQuestionCall("sk-live-stop", {
    sourceAccount: "default",
    candidates: ["appical"],
    resetsAt: 1_790_577_000,
    window: "five_hour",
  })
  assert.deepEqual(
    consumeAccountFailoverAnswer(
      "sk-live-stop",
      answer(stopCall.toolCallId, {
        type: "text",
        value: `${opencodeAnswer(stopCall.input.questions[0].question, "stop")}\n`,
      }) as any,
    ),
    { kind: "stop", reason: "the operator chose to stop" },
  )
})

test("the answer with opencode-dcp's message-id tag on the end switches", () => {
  // Measured 2026-10-03 against a real five-hour limit on the `appical`
  // account: every pick came back with a `<dcp-message-id>` tag appended
  // after opencode's own closing sentence, the `endsWith` check missed, and
  // the whole sentence was refused as `unrecognised answer`. Three picks were
  // lost that way (`default`, `default`, `stop`) and the operator concluded
  // the failover simply did not switch.
  const call = createAccountFailoverQuestionCall("sk-dcp", {
    sourceAccount: "appical",
    candidates: ["default"],
    resetsAt: 1_791_067_800,
    window: "five_hour",
  })
  const question = call.input.questions[0].question
  assert.equal(
    question,
    'The Claude account "appical" is out of usage in five_hour, which resets at 2026-10-03T22:50:00.000Z. Continue this task on another configured account? Leaving this unanswered waits, at no cost.',
    "the fixture must be the question the live form asked",
  )
  assert.deepEqual(
    consumeAccountFailoverAnswer(
      "sk-dcp",
      answer(call.toolCallId, {
        type: "text",
        value: withDcpTag(opencodeAnswer(question, "default"), "m0795"),
      }) as any,
    ),
    { kind: "switch", target: "default", sourceAccount: "appical", resetsAt: 1_791_067_800 },
  )

  // `stop` through the same shape, which is the third pick that was lost.
  const stopCall = createAccountFailoverQuestionCall("sk-dcp-stop", {
    sourceAccount: "appical",
    candidates: ["default"],
    resetsAt: 1_791_067_800,
    window: "five_hour",
  })
  assert.deepEqual(
    consumeAccountFailoverAnswer(
      "sk-dcp-stop",
      answer(stopCall.toolCallId, {
        type: "text",
        value: withDcpTag(opencodeAnswer(stopCall.input.questions[0].question, "stop"), "m1039"),
      }) as any,
    ),
    { kind: "stop", reason: "the operator chose to stop" },
  )

  // Two tags, and trailing whitespace after them, are the same answer.
  const twiceCall = createAccountFailoverQuestionCall("sk-dcp-twice", {
    sourceAccount: "appical",
    candidates: ["default"],
  })
  assert.equal(
    consumeAccountFailoverAnswer(
      "sk-dcp-twice",
      answer(twiceCall.toolCallId, {
        type: "text",
        value: `${withDcpTag(
          withDcpTag(opencodeAnswer(twiceCall.input.questions[0].question, "default"), "m1"),
          "m2",
        )}\n  `,
      }) as any,
    )?.kind,
    "switch",
  )

  // And the tag is the ONLY thing stripped: an answer the operator typed that
  // merely mentions a tag-shaped string is still their answer, not an account.
  const customCall = createAccountFailoverQuestionCall("sk-dcp-custom", {
    sourceAccount: "appical",
    candidates: ["default"],
  })
  assert.deepEqual(
    consumeAccountFailoverAnswer(
      "sk-dcp-custom",
      answer(customCall.toolCallId, {
        type: "text",
        value: opencodeAnswer(
          customCall.input.questions[0].question,
          "<dcp-message-id>m1</dcp-message-id> please wait",
        ),
      }) as any,
    ),
    { kind: "stop", reason: 'unrecognised answer "<dcp-message-id>m1</dcp-message-id> please wait"' },
  )
})

test("the plan-mode approval reads a tagged answer too", () => {
  // The same unwrapper, the same defect: the bridge is opt-in and was not the
  // path that was measured, but a tagged `yes` would have been read as a
  // rejection with the whole sentence quoted back as the operator's feedback.
  const call = createExitPlanModeQuestionCall("sk-plan-dcp", "toolu_plan", "the plan")
  const approved = consumeExitPlanModeQuestionResult("sk-plan-dcp", answer(call.toolCallId, {
    type: "text",
    value: withDcpTag(opencodeAnswer("Do you want to proceed with this plan?", "yes")),
  }) as any)
  assert.ok(approved, "the approval must be matched")
  const parsed = JSON.parse(approved!)
  assert.equal(parsed.message.content[0].tool_use_id, "toolu_plan")
  assert.match(parsed.message.content[0].content, /User has approved your plan/)
  assert.equal(parsed.message.content[0].is_error, undefined)

  // A tagged `no` still rejects, and the feedback is the answer, not the tag.
  const noCall = createExitPlanModeQuestionCall("sk-plan-dcp-no", "toolu_plan_no", "the plan")
  const rejected = JSON.parse(
    consumeExitPlanModeQuestionResult("sk-plan-dcp-no", answer(noCall.toolCallId, {
      type: "text",
      value: withDcpTag(opencodeAnswer("Do you want to proceed with this plan?", "not yet")),
    }) as any)!,
  )
  assert.equal(rejected.message.content[0].is_error, true)
  assert.match(rejected.message.content[0].content, /not yet/)
  assert.equal(rejected.message.content[0].content.includes("dcp-message-id"), false)
})

test("an answer to a form asked before an opencode restart still switches", () => {
  // No createAccountFailoverQuestionCall here: the process that asked is gone.
  const toolCallId = `${ACCOUNT_FAILOVER_TOOL_CALL_PREFIX}fromlastrun`
  const question =
    'The Claude account "appical" is out of usage in the 5-hour window. Continue this task on another configured account? Leaving this unanswered waits, at no cost.'
  const prompt = [
    { role: "user", content: [{ type: "text", text: "build the thing" }] },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId, toolName: "question", input: {} }],
    },
    ...answer(toolCallId, { type: "text", value: opencodeAnswer(question, "default") }),
  ] as any
  const fallback = { sourceAccount: "appical", candidates: ["default"] }
  assert.deepEqual(consumeAccountFailoverAnswer("sk-restarted", prompt, fallback), {
    kind: "switch",
    target: "default",
    sourceAccount: "appical",
    resetsAt: undefined,
  })
  // An old answer further up is history, not this turn's answer.
  const later = [...prompt, { role: "user", content: [{ type: "text", text: "next" }] }] as any
  assert.equal(consumeAccountFailoverAnswer("sk-restarted", later, fallback), null)
  // A single-account install offers nothing to fall back to.
  assert.equal(
    consumeAccountFailoverAnswer("sk-restarted", prompt, { sourceAccount: "appical", candidates: [] }),
    null,
  )
})

test("the form never reaches Claude as a stray tool result on the next turn", () => {
  const toolCallId = `${ACCOUNT_FAILOVER_TOOL_CALL_PREFIX}staleform`
  const prompt = [
    { role: "user", content: [{ type: "text", text: "build the thing" }] },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId, toolName: "question", input: {} }],
    },
    ...answer(toolCallId, { type: "error-text", value: "The user dismissed this question" }),
    { role: "user", content: [{ type: "text", text: "try again please" }] },
  ] as any
  const envelope = getClaudeUserMessage(prompt, false, { cliToolCallIds: new Set() })
  assert.doesNotMatch(envelope, /opencode_tool_result|dismissed this question/)
  assert.match(envelope, /try again please/)
})

test("a tool-result for another call is not a failover answer", () => {
  createAccountFailoverQuestionCall("sk-c", {
    sourceAccount: "default",
    candidates: ["work"],
  })
  assert.equal(
    consumeAccountFailoverAnswer(
      "sk-c",
      answer("toolu_something_else", { type: "text", value: "work" }) as any,
    ),
    null,
  )
})

// ---------------------------------------------------------------------------
// Transcript handling
// ---------------------------------------------------------------------------

const dialogPrompt = [
  { role: "user", content: [{ type: "text", text: "build the thing" }] },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Working on it." },
      {
        type: "tool-call",
        toolCallId: `${ACCOUNT_FAILOVER_TOOL_CALL_PREFIX}abc123`,
        toolName: "question",
        input: {},
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: `${ACCOUNT_FAILOVER_TOOL_CALL_PREFIX}abc123`,
        toolName: "question",
        output: { type: "text", value: "work" },
      },
    ],
  },
] as any

test("the dialog is stripped from a replayed transcript, keeping real content", () => {
  const stripped = stripAccountFailoverParts(dialogPrompt) as any[]
  assert.equal(stripped.length, 2)
  // The assistant's own words survive; only the synthetic call goes.
  assert.deepEqual(stripped[1].content, [{ type: "text", text: "Working on it." }])
  // The tool message held nothing but the answer, so it is dropped entirely
  // rather than replayed as an empty message.
  assert.equal(
    stripped.some((message) => message.role === "tool"),
    false,
  )
})

test("filterSideQuestionHistory drops the dialog and the failover note", () => {
  const withNote = [
    ...dialogPrompt,
    {
      role: "assistant",
      content: [{ type: "text", text: `${FAILOVER_MARKER} moved to "work".` }],
    },
  ] as any
  const filtered = filterSideQuestionHistory(withNote) as any[]
  const serialized = JSON.stringify(filtered)
  assert.equal(serialized.includes(ACCOUNT_FAILOVER_TOOL_CALL_PREFIX), false)
  assert.equal(serialized.includes(FAILOVER_MARKER), false)
  assert.match(serialized, /build the thing/)
  assert.match(serialized, /Working on it/)
})

test("the continuation prompt replaces the dialog with a carry-on instruction", () => {
  const built = buildFailoverContinuationPrompt(dialogPrompt, "work") as any[]
  const last = built[built.length - 1]
  assert.equal(last.role, "user")
  const text = last.content[0].text
  assert.match(text, /"work" account/)
  assert.match(text, /Continue the task from where it stopped/)
  assert.match(text, /do not start over/i)
  assert.match(text, /Do not mention the account switch/)
  assert.equal(JSON.stringify(built).includes(ACCOUNT_FAILOVER_TOOL_CALL_PREFIX), false)
})

test("the failover note is a ▌ line naming both accounts", () => {
  const note = formatFailoverNote({
    sourceAccount: "appical",
    target: "work",
    resetsAt: 1_700_000_000,
  })
  assert.ok(note.trimStart().startsWith(FAILOVER_MARKER))
  assert.match(note, /"appical" is out of usage/)
  assert.match(note, /continues on "work"/)
  assert.match(note, /2023-11-14/)
})

// ---------------------------------------------------------------------------
// The wiring, through a real doStream and a fake CLI
// ---------------------------------------------------------------------------

/**
 * A fake `claude` that answers differently depending on the account it was
 * reached through: the limited one (via its wrapper, so `CLAUDE_CONFIG_DIR`
 * is set) rejects, the failover target (the bare binary) answers. Every run
 * appends what it saw, which is how the spawn's account and `--model` are
 * asserted without reaching into the plugin.
 */
function createFakeCli() {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-failover-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const record = join(cwd, "spawns.jsonl")
  const source = `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")

if (process.argv.includes("--version")) {
  process.stdout.write("2.1.263\\n")
  process.exit(0)
}

const limited = !!process.env.CLAUDE_CONFIG_DIR
// The shape a real limit has, transcribed from a live \`claude -p\` against an
// exhausted five-hour window on CLI 2.1.288 (2026-10-03, the \`appical\`
// account). Three things here are measured and load-bearing:
//
//  - the result's \`subtype\` is \`success\` and only \`is_error\` says anything
//    failed, exactly as (h #g161) records for a refused model. A non-success
//    subtype would add a \`▌ **claude code error:**\` note no real limited turn
//    produces, and the tests below count the notes.
//  - the CLI answers with its OWN \`<synthetic>\` assistant frame, flagged
//    \`is_api_error_message\` and \`error: "rate_limit"\`, and that frame is what
//    put the raw sentence in the transcript. A fixture without it passed while
//    the live turn showed two blocks.
//  - the \`rate_limit_event\` precedes the frame, so the limit is known before
//    the text arrives.
const LIMIT_TEXT =
  "You've hit your individual spend limit \\u00b7 run /usage-credits to ask your admin for a higher limit"
const LIMITED_LINES = [
  { type: "system", subtype: "init", session_id: "limited-session", tools: [] },
  {
    type: "rate_limit_event",
    session_id: "limited-session",
    rate_limit_info: {
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: 4102444800,
      isUsingOverage: false,
      overageStatus: "rejected",
      overageResetsAt: 4102444800,
      overageDisabledReason: "org_level_disabled_until",
    },
  },
  {
    type: "assistant",
    session_id: "limited-session",
    parent_tool_use_id: null,
    error: "rate_limit",
    is_api_error_message: true,
    message: {
      role: "assistant",
      model: "<synthetic>",
      stop_reason: "stop_sequence",
      content: [{ type: "text", text: LIMIT_TEXT }],
    },
  },
  {
    type: "result",
    subtype: "success",
    session_id: "limited-session",
    is_error: true,
    api_error_status: 429,
    result: LIMIT_TEXT,
    duration_ms: 10,
    num_turns: 1,
  },
]

// The gate's own case: the CLI's view of the limits changed to \`rejected\`
// during a turn it nonetheless served. \`is_error\` is what the note keys on,
// so this must produce the answer and no note at all.
const SERVED_AFTER_REJECT_LINES = [
  { type: "system", subtype: "init", session_id: "limited-session", tools: [] },
  {
    type: "rate_limit_event",
    session_id: "limited-session",
    rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 4102444800 },
  },
  {
    type: "stream_event",
    session_id: "limited-session",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "served anyway" } },
  },
  {
    type: "stream_event",
    session_id: "limited-session",
    event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
  },
  {
    type: "result",
    subtype: "success",
    session_id: "limited-session",
    is_error: false,
    result: "served anyway",
    duration_ms: 10,
    num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
]
const FAILOVER_LINES = [
  { type: "system", subtype: "init", session_id: "failover-session", tools: [] },
  {
    type: "stream_event",
    session_id: "failover-session",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "carried on" } },
  },
  {
    type: "stream_event",
    session_id: "failover-session",
    event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
  },
  {
    type: "result",
    subtype: "success",
    session_id: "failover-session",
    is_error: false,
    result: "carried on",
    duration_ms: 10,
    num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
]

// The steady state of an org with extra usage disabled, measured on CLI
// 2.1.280: the request is served, and the event still says overage is
// rejected. This must never look like a limit.
const SERVED_WITH_OVERAGE_REJECTED_LINES = [
  { type: "system", subtype: "init", session_id: "limited-session", tools: [] },
  {
    type: "rate_limit_event",
    session_id: "limited-session",
    rate_limit_info: {
      status: "allowed",
      rateLimitType: "five_hour",
      resetsAt: 4102444800,
      isUsingOverage: false,
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled",
    },
  },
  {
    type: "stream_event",
    session_id: "limited-session",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "served anyway" } },
  },
  {
    type: "stream_event",
    session_id: "limited-session",
    event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
  },
  {
    type: "result",
    subtype: "success",
    session_id: "limited-session",
    is_error: false,
    result: "served anyway",
    duration_ms: 10,
    num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
]
const overageOnly = process.env.FAKE_CLI_OVERAGE_ONLY === "1"

// What the CLI printed for every turn once the appical login expired on
// 2026-09-23: its own synthetic reply, tagged with the \`error\` kind, then a
// failed result. The text is the CLI's, the kind is from its 2.1.280 schema.
const AUTH_TEXT = "Failed to authenticate: OAuth session expired and could not be refreshed"
const AUTH_EXPIRED_LINES = [
  { type: "system", subtype: "init", session_id: "limited-session", tools: [] },
  {
    type: "assistant",
    session_id: "limited-session",
    parent_tool_use_id: null,
    error: "authentication_failed",
    message: {
      role: "assistant",
      model: "<synthetic>",
      stop_reason: "stop_sequence",
      content: [{ type: "text", text: AUTH_TEXT }],
    },
  },
  {
    type: "result",
    subtype: "success",
    session_id: "limited-session",
    is_error: true,
    result: AUTH_TEXT,
    duration_ms: 40,
    num_turns: 1,
  },
]
const authExpired = process.env.FAKE_CLI_AUTH_EXPIRED === "1"
const servedAfterReject = process.env.FAKE_CLI_SERVED_AFTER_REJECT === "1"
// One process, several turns: what a reused child does, and the only way to
// show that the note fires on the SECOND limited turn as well as the first.
const repeat = process.env.FAKE_CLI_REPEAT === "1"
// The CLI emits \`rate_limit_event\` when its view of the limits CHANGES, not
// per request, so a reused child's later turns carry none. Measured live.
const noRepeatEvent = process.env.FAKE_CLI_NO_REPEAT_EVENT === "1"
// The limited account answering normally, which is what a compaction turn
// that works looks like. Without it the control case for issue #90 cannot be
// run: the same account must be able to produce a summary.
const alwaysOk = process.env.FAKE_CLI_ALWAYS_OK === "1"
let turns = 0

const rl = readline.createInterface({ input: process.stdin })
let answered = false
rl.on("line", (line) => {
  if (answered && !repeat) return
  answered = true
  fs.appendFileSync(
    ${JSON.stringify(record)},
    JSON.stringify({
      argv: process.argv.slice(2),
      configDir: process.env.CLAUDE_CONFIG_DIR || null,
      stdin: line,
    }) + "\\n",
  )
  const lines = limited && !alwaysOk
    ? (authExpired
        ? AUTH_EXPIRED_LINES
        : servedAfterReject
          ? SERVED_AFTER_REJECT_LINES
          : overageOnly
            ? SERVED_WITH_OVERAGE_REJECTED_LINES
            : LIMITED_LINES)
    : FAILOVER_LINES
  turns += 1
  for (const l of lines) {
    if (noRepeatEvent && turns > 1 && l.type === "rate_limit_event") continue
    process.stdout.write(JSON.stringify(l) + "\\n")
  }
})
`
  writeFileSync(cliPath, source)
  chmodSync(cliPath, 0o755)
  return {
    cliPath,
    cwd,
    spawns: (): any[] =>
      existsSync(record)
        ? readFileSync(record, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
  }
}

/** opencode's registry must carry `question`, or the form is not offered. */
setOpencodeClient({
  tool: {
    list: async () => ({ data: [{ id: "question", description: "", parameters: {} }] }),
  },
})

const MODEL_ID = "claude-test-failover@appical"

/**
 * `accountFailover` is passed explicitly everywhere below, never defaulted,
 * because which of the two answers a limited turn gets is the whole subject of
 * this file: `"ask"` for the form's own tests, unset or `"off"` for the note's.
 */
async function buildFailoverModel(
  fake: ReturnType<typeof createFakeCli>,
  failoverAccounts: string[] = ["default", "appical"],
  accountFailover?: "ask" | "off",
  extra: Record<string, unknown> = {},
) {
  // The limited account is reached through its own wrapper, exactly as a real
  // account provider reaches it; `default` is the failover target and has no
  // wrapper at all.
  const runtime = await ensureAccountRuntime("appical", fake.cliPath)
  return createClaudeCode({
    cliPath: runtime.cliPath,
    baseCliPath: fake.cliPath,
    configDir: runtime.configDir,
    account: "appical",
    failoverAccounts,
    accountFailover,
    cwd: fake.cwd,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    ...extra,
  }).languageModel(MODEL_ID)
}

/** The form's tests: the opt-in that makes the switch form the answer. */
async function buildAskModel(
  fake: ReturnType<typeof createFakeCli>,
  failoverAccounts: string[] = ["default", "appical"],
  extra: Record<string, unknown> = {},
) {
  return buildFailoverModel(fake, failoverAccounts, "ask", extra)
}

const TOOLS = [
  {
    type: "function",
    name: "read",
    description: "Read a file",
    inputSchema: { type: "object", properties: {} },
  },
]

async function drain(response: any): Promise<any[]> {
  const parts: any[] = []
  for await (const part of response.stream) parts.push(part)
  return parts
}

function textOf(parts: any[]): string {
  return parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
}

function modelArg(argv: string[]): string | undefined {
  const at = argv.indexOf("--model")
  return at === -1 ? undefined : argv[at + 1]
}

const turnOnePrompt = [{ role: "user", content: [{ type: "text", text: "go" }] }]

test("with accountFailover ask, a usage limit ends the turn on a question listing the other account", async () => {
  _resetAccountOverrides()
  _resetRateLimitReports()
  _resetSystemInitReports()
  const fake = createFakeCli()
  const sk = sessionKey(
    fake.cwd,
    `${MODEL_ID}::tools::default::context=["claude-code",null]`,
  )
  try {
    const model = await buildAskModel(fake)
    const parts = await drain(
      await model.doStream({ prompt: turnOnePrompt, tools: TOOLS } as any),
    )

    const call = parts.find((part) => part.type === "tool-call")
    assert.ok(call, "the limited turn must end on a question tool-call")
    assert.equal(call.toolName, "question")
    assert.ok(call.toolCallId.startsWith(ACCOUNT_FAILOVER_TOOL_CALL_PREFIX))
    const input = JSON.parse(call.input)
    assert.deepEqual(
      input.questions[0].options.map((option: any) => option.label),
      ["default", "stop"],
    )

    // `tool-calls`, not the error finish the same result produces today:
    // opencode only runs the tool when the turn ends this way.
    const finish = parts.find((part) => part.type === "finish")
    assert.equal(finish.finishReason.unified, "tool-calls")

    // The form says why in its own question text, so the turn carries no
    // plugin note at all: not the rate-limit paragraph, which is log-only
    // now, and not the usage-limit note, which the form is taking instead.
    const body = textOf(parts)
    assert.equal(body.includes(RATE_LIMIT_MARKER), false)
    assert.equal(body.includes(USAGE_LIMIT_MARKER), false)
    assert.match(input.questions[0].question, /"appical" is out of usage/)

    // The limited account really was the one that ran.
    const spawns = fake.spawns()
    assert.equal(spawns.length, 1)
    assert.match(String(spawns[0].configDir), /\.claude-appical$/)
  } finally {
    deleteActiveProcess(sk)
    _resetAccountOverrides()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("an expired login names the account and the login command, and offers the switch", async () => {
  _resetAccountOverrides()
  _resetRateLimitReports()
  _resetSystemInitReports()
  const fake = createFakeCli()
  const sk = sessionKey(
    fake.cwd,
    `${MODEL_ID}::tools::default::context=["claude-code",null]`,
  )
  process.env.FAKE_CLI_AUTH_EXPIRED = "1"
  try {
    const model = await buildAskModel(fake)
    const parts = await drain(
      await model.doStream({ prompt: turnOnePrompt, tools: TOOLS } as any),
    )
    const body = textOf(parts)
    assert.match(body, /▌ \*\*claude account:\*\* the Claude account "appical" is not logged in/)
    assert.match(body, /CLAUDE_CONFIG_DIR=\S*\.claude-appical claude auth login/)
    assert.match(body, /Or pick another account below/)

    const call = parts.find((part) => part.type === "tool-call")
    assert.ok(call, "another configured account is offered")
    const question = JSON.parse(call.input).questions[0]
    assert.match(question.question, /"appical" is not logged in/)
    assert.doesNotMatch(question.question, /out of usage/)
    assert.deepEqual(question.options.map((option: any) => option.label), ["default", "stop"])
    assert.equal(parts.find((part) => part.type === "finish").finishReason.unified, "tool-calls")
  } finally {
    delete process.env.FAKE_CLI_AUTH_EXPIRED
    deleteActiveProcess(sk)
    _resetAccountOverrides()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("an expired login with no other account still says what to run", async () => {
  _resetAccountOverrides()
  _resetRateLimitReports()
  _resetSystemInitReports()
  const fake = createFakeCli()
  const sk = sessionKey(
    fake.cwd,
    `${MODEL_ID}::tools::default::context=["claude-code",null]`,
  )
  process.env.FAKE_CLI_AUTH_EXPIRED = "1"
  try {
    const model = await buildFailoverModel(fake, ["appical"])
    const parts = await drain(
      await model.doStream({ prompt: turnOnePrompt, tools: TOOLS } as any),
    )
    const body = textOf(parts)
    assert.match(body, /claude auth login`, then resend your message\.\n/)
    assert.doesNotMatch(body, /pick another account/)
    assert.doesNotMatch(body, /pick a model from/)
    assert.equal(parts.some((part) => part.type === "tool-call"), false)
    assert.equal(parts.find((part) => part.type === "finish").finishReason.unified, "error")
  } finally {
    delete process.env.FAKE_CLI_AUTH_EXPIRED
    deleteActiveProcess(sk)
    _resetAccountOverrides()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("an expired login with the form off still points at the other account", async () => {
  // The default posture now: no form, so the one route left is to move the
  // work by hand, and nothing else on screen would say that route exists.
  _resetAccountOverrides()
  _resetRateLimitReports()
  _resetSystemInitReports()
  const fake = createFakeCli()
  const sk = sessionKey(
    fake.cwd,
    `${MODEL_ID}::tools::default::context=["claude-code",null]`,
  )
  process.env.FAKE_CLI_AUTH_EXPIRED = "1"
  try {
    const model = await buildFailoverModel(fake)
    const parts = await drain(
      await model.doStream({ prompt: turnOnePrompt, tools: TOOLS } as any),
    )
    const body = textOf(parts)
    assert.match(body, /▌ \*\*claude account:\*\* the Claude account "appical" is not logged in/)
    assert.match(body, /CLAUDE_CONFIG_DIR=\S*\.claude-appical claude auth login/)
    assert.match(body, /Or pick a model from the "default" account and resend\./)
    assert.doesNotMatch(body, /pick another account below/)
    // An account block is not a usage limit, so it keeps its own note only.
    assert.equal(body.includes(USAGE_LIMIT_MARKER), false)
    assert.equal(parts.some((part) => part.type === "tool-call"), false)
  } finally {
    delete process.env.FAKE_CLI_AUTH_EXPIRED
    deleteActiveProcess(sk)
    _resetAccountOverrides()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("account blocks come from the CLI's error kind, and the login command names the account", () => {
  assert.equal(accountBlockKind({ type: "assistant", error: "authentication_failed" }), "authentication_failed")
  assert.equal(accountBlockKind({ type: "assistant", error: "billing_error" }), "billing_error")
  // Request-level failures would fail on any account, so they open nothing.
  assert.equal(accountBlockKind({ type: "assistant", error: "server_error" }), null)
  assert.equal(accountBlockKind({ type: "assistant", error: "rate_limit" }), null)
  assert.equal(accountBlockKind({ type: "assistant", error: "toString" }), null)
  assert.equal(accountBlockKind({ type: "result", error: "authentication_failed" }), null)
  assert.equal(accountBlockKind({ type: "assistant" }), null)

  assert.equal(loginCommandFor(undefined), "claude auth login")
  assert.equal(
    loginCommandFor("/Users/me/.claude-work", "/Users/me"),
    "CLAUDE_CONFIG_DIR=~/.claude-work claude auth login",
  )
  assert.equal(
    loginCommandFor("/srv/claude-work", "/Users/me"),
    "CLAUDE_CONFIG_DIR=/srv/claude-work claude auth login",
  )
  // The note is stripped from rebuilt transcripts like every other `▌` note.
  assert.ok(ACCOUNT_BLOCK_MARKER.startsWith("▌"))
})

test("a served turn whose limit event only rejects overage keeps its answer and asks nothing", async () => {
  _resetAccountOverrides()
  _resetRateLimitReports()
  _resetSystemInitReports()
  const fake = createFakeCli()
  const sk = sessionKey(
    fake.cwd,
    `${MODEL_ID}::tools::default::context=["claude-code",null]`,
  )
  process.env.FAKE_CLI_OVERAGE_ONLY = "1"
  try {
    const model = await buildFailoverModel(fake)
    const parts = await drain(
      await model.doStream({ prompt: turnOnePrompt, tools: TOOLS } as any),
    )

    assert.equal(
      parts.some((part) => part.type === "tool-call"),
      false,
      "a served turn must not end on the failover form",
    )
    const finish = parts.find((part) => part.type === "finish")
    assert.equal(finish.finishReason.unified, "stop")
    const body = textOf(parts)
    assert.match(body, /served anyway/)
    assert.doesNotMatch(body, /rate limit/)
    assert.equal(body.includes(USAGE_LIMIT_MARKER), false)
  } finally {
    delete process.env.FAKE_CLI_OVERAGE_ONLY
    deleteActiveProcess(sk)
    _resetAccountOverrides()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("answering with the other account continues the task on it, replayed", async () => {
  _resetAccountOverrides()
  _resetRateLimitReports()
  _resetSystemInitReports()
  const fake = createFakeCli()
  const sk = sessionKey(
    fake.cwd,
    `${MODEL_ID}::tools::default::context=["claude-code",null]`,
  )
  try {
    const model = await buildAskModel(fake)
    const first = await drain(
      await model.doStream({ prompt: turnOnePrompt, tools: TOOLS } as any),
    )
    const call = first.find((part) => part.type === "tool-call")
    assert.ok(call)

    const second = await drain(
      await model.doStream({
        prompt: [
          ...turnOnePrompt,
          {
            role: "assistant",
            content: [
              { type: "text", text: "Starting." },
              {
                type: "tool-call",
                toolCallId: call.toolCallId,
                toolName: "question",
                input: JSON.parse(call.input),
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: call.toolCallId,
                toolName: "question",
                output: {
                  type: "text",
                  // With the tag opencode-dcp really appends, which is the
                  // shape that refused every live pick until the unwrapper
                  // learned to drop it (h #g194).
                  value: withDcpTag(
                    opencodeAnswer(JSON.parse(call.input).questions[0].question, "default"),
                  ),
                },
              },
            ],
          },
        ],
        tools: TOOLS,
      } as any),
    )

    const spawns = fake.spawns()
    assert.equal(spawns.length, 2, "the switch must spawn a second process")
    const failoverSpawn = spawns[1]

    // Routed through the OTHER account: `default` has no config dir at all,
    // so the failover spawn is the bare binary.
    assert.equal(failoverSpawn.configDir, null)

    // The `@account` suffix must not reach a CLI that is not behind the
    // account's own wrapper; without the strip this is `...@appical` and the
    // CLI rejects the model outright.
    assert.equal(modelArg(failoverSpawn.argv), "claude-test-failover")
    assert.equal(String(modelArg(failoverSpawn.argv)).includes("@"), false)

    // The fake CLI writes no transcript, so there is nothing to carry across
    // (h #g218) and the switch falls back to what every switch did before:
    // a fresh session with the thread replayed as text, and no `--resume`
    // naming a conversation the target account cannot see.
    assert.match(failoverSpawn.stdin, /<conversation_history>/)
    assert.match(failoverSpawn.stdin, /Continue the task from where it stopped/)
    assert.match(failoverSpawn.stdin, /fresh Claude session/)
    assert.equal(failoverSpawn.argv.includes("--resume"), false)
    // ...and the dialog itself never reaches the fresh session.
    assert.equal(
      failoverSpawn.stdin.includes(ACCOUNT_FAILOVER_TOOL_CALL_PREFIX),
      false,
    )

    const body = textOf(second)
    assert.ok(
      body.trimStart().startsWith(FAILOVER_MARKER),
      "the note must be the first thing in the switched turn",
    )
    assert.match(body, /carried on/)
    assert.equal(
      second.find((part) => part.type === "finish").finishReason.unified,
      "stop",
    )

    // Sticky for the limited account until the limit's own reset time, which
    // is what makes the pick cover every other session on that account.
    assert.equal(resolveAccountOverride("appical"), "default")
    assert.equal(resolveAccountOverride("appical", 4_102_444_800_001), undefined)
  } finally {
    deleteActiveProcess(sk)
    _resetAccountOverrides()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

/**
 * The answer turn's prompt: the operator's message, the assistant turn
 * carrying the form, and opencode's own answer sentence picking `default`.
 */
function switchAnswerPrompt(call: any) {
  return [
    ...turnOnePrompt,
    {
      role: "assistant",
      content: [
        { type: "text", text: "Starting." },
        {
          type: "tool-call",
          toolCallId: call.toolCallId,
          toolName: "question",
          input: JSON.parse(call.input),
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: "question",
          output: {
            type: "text",
            value: opencodeAnswer(JSON.parse(call.input).questions[0].question, "default"),
          },
        },
      ],
    },
  ]
}

/** The transcript the limited account's first turn would have written. */
function plantTranscript(account: string, cwd: string, sessionId: string): string {
  const file = interactiveTranscriptPath({
    configDir: configDirForAccount(account),
    cwd,
    sessionId,
  })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `{"type":"user","sessionId":"${sessionId}"}\n`)
  return file
}

test("the switch carries the conversation when the transcript is there, instead of replaying it", async () => {
  _resetAccountOverrides()
  _resetRateLimitReports()
  _resetSystemInitReports()
  const fake = createFakeCli()
  const sk = sessionKey(
    fake.cwd,
    `${MODEL_ID}::tools::default::context=["claude-code",null]`,
  )
  try {
    const model = await buildAskModel(fake)
    const first = await drain(
      await model.doStream({ prompt: turnOnePrompt, tools: TOOLS } as any),
    )
    const call = first.find((part) => part.type === "tool-call")
    assert.ok(call)

    // The limited account's own transcript, which the fake CLI does not write
    // but a real one does. `limited-session` is the id its `system`/`init`
    // frame reported, so this is the file the plugin knows this conversation
    // by.
    const source = plantTranscript("appical", fake.cwd, "limited-session")

    const second = await drain(
      await model.doStream({ prompt: switchAnswerPrompt(call), tools: TOOLS } as any),
    )

    const spawns = fake.spawns()
    assert.equal(spawns.length, 2, "the switch must spawn a second process")
    const failoverSpawn = spawns[1]

    // The conversation moved by file, so the target account continues it
    // rather than being handed the thread again as text.
    const carried = interactiveTranscriptPath({
      configDir: configDirForAccount("default"),
      cwd: fake.cwd,
      sessionId: "limited-session",
    })
    assert.equal(existsSync(carried), true, "the transcript must be in the target account")
    assert.equal(statSync(carried).mode & 0o777, 0o600)
    assert.deepEqual(
      failoverSpawn.argv.slice(
        failoverSpawn.argv.indexOf("--resume"),
        failoverSpawn.argv.indexOf("--resume") + 2,
      ),
      ["--resume", "limited-session"],
    )
    assert.equal(
      failoverSpawn.stdin.includes("<conversation_history>"),
      false,
      "a carried conversation must not also be replayed as text",
    )
    // It is told it is the same conversation, not a fresh one, and the dialog
    // still never reaches it.
    assert.match(failoverSpawn.stdin, /This is the same conversation, continued/)
    assert.match(failoverSpawn.stdin, /Continue the task from where it stopped/)
    assert.equal(failoverSpawn.stdin.includes(ACCOUNT_FAILOVER_TOOL_CALL_PREFIX), false)

    // The source is never moved or emptied: the other account keeps its own
    // copy exactly as it was.
    assert.equal(readFileSync(source, "utf8"), '{"type":"user","sessionId":"limited-session"}\n')

    const body = textOf(second)
    assert.ok(body.trimStart().startsWith(FAILOVER_MARKER))
    assert.match(body, /carried on/)
  } finally {
    deleteActiveProcess(sk)
    _resetAccountOverrides()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("crossAccountResume false keeps the replay even with the transcript right there", async () => {
  _resetAccountOverrides()
  _resetRateLimitReports()
  _resetSystemInitReports()
  const fake = createFakeCli()
  const sk = sessionKey(
    fake.cwd,
    `${MODEL_ID}::tools::default::context=["claude-code",null]`,
  )
  try {
    const model = await buildAskModel(fake, ["default", "appical"], {
      crossAccountResume: false,
    })
    const first = await drain(
      await model.doStream({ prompt: turnOnePrompt, tools: TOOLS } as any),
    )
    const call = first.find((part) => part.type === "tool-call")
    assert.ok(call)
    plantTranscript("appical", fake.cwd, "limited-session")

    await drain(
      await model.doStream({ prompt: switchAnswerPrompt(call), tools: TOOLS } as any),
    )

    const failoverSpawn = fake.spawns()[1]
    assert.match(failoverSpawn.stdin, /<conversation_history>/)
    assert.equal(failoverSpawn.argv.includes("--resume"), false)
    // The off switch must not leave a copy behind either.
    assert.equal(
      existsSync(
        interactiveTranscriptPath({
          configDir: configDirForAccount("default"),
          cwd: fake.cwd,
          sessionId: "limited-session",
        }),
      ),
      false,
    )
    // The form promised the replay, so its wording has to say so.
    const option = JSON.parse(call.input).questions[0].options[0]
    assert.match(option.description, /replayed as a fresh Claude session/)
    assert.equal(option.description.includes("carried across"), false)
  } finally {
    deleteActiveProcess(sk)
    _resetAccountOverrides()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("answering stop ends the turn as an error and spawns nothing", async () => {
  _resetAccountOverrides()
  _resetRateLimitReports()
  _resetSystemInitReports()
  const fake = createFakeCli()
  const sk = sessionKey(
    fake.cwd,
    `${MODEL_ID}::tools::default::context=["claude-code",null]`,
  )
  try {
    const model = await buildAskModel(fake)
    const first = await drain(
      await model.doStream({ prompt: turnOnePrompt, tools: TOOLS } as any),
    )
    const call = first.find((part) => part.type === "tool-call")
    assert.ok(call)

    const second = await drain(
      await model.doStream({
        prompt: [
          ...turnOnePrompt,
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: call.toolCallId,
                toolName: "question",
                input: JSON.parse(call.input),
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: call.toolCallId,
                toolName: "question",
                output: {
                  type: "text",
                  value: opencodeAnswer(JSON.parse(call.input).questions[0].question, "stop"),
                },
              },
            ],
          },
        ],
        tools: TOOLS,
      } as any),
    )

    // Exactly the one spawn from the limited turn: declining costs nothing.
    assert.equal(fake.spawns().length, 1)
    const finish = second.find((part) => part.type === "finish")
    assert.equal(finish.finishReason.unified, "error")
    assert.ok(second.some((part) => part.type === "error"))
    assert.match(textOf(second), /▌ \*\*account failover:\*\*/)
    assert.equal(resolveAccountOverride("appical"), undefined)
  } finally {
    deleteActiveProcess(sk)
    _resetAccountOverrides()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The quiet note, through a real doStream and a fake CLI
// ---------------------------------------------------------------------------

/** Every `▌` block in a turn's text, which is how "exactly one" is checked. */
function notesIn(parts: any[]): string[] {
  return textOf(parts)
    .split("▌")
    .slice(1)
    .map((block) => `▌${block}`.trim())
}

const LIMIT_RESETS_AT = 4_102_444_800

test("a limited turn with the form off says it once, and the CLI's own text is gone", async () => {
  _resetAccountOverrides()
  _resetRateLimitReports()
  _resetSystemInitReports()
  const fake = createFakeCli()
  const sk = sessionKey(
    fake.cwd,
    `${MODEL_ID}::tools::default::context=["claude-code",null]`,
  )
  try {
    const model = await buildFailoverModel(fake)
    const parts = await drain(
      await model.doStream({ prompt: turnOnePrompt, tools: TOOLS } as any),
    )

    // One note, and it is the usage-limit one.
    const notes = notesIn(parts)
    assert.deepEqual(notes.length, 1, `expected one note, got ${JSON.stringify(notes)}`)
    assert.ok(notes[0].startsWith(USAGE_LIMIT_MARKER))
    assert.match(notes[0], /the Claude account "appical" is out of usage in the 5-hour window/)
    assert.match(notes[0], new RegExp(`resets at ${formatLocalMinute(LIMIT_RESETS_AT * 1000)}`))
    assert.match(notes[0], /Pick a model from the "default" account and resend your message/)

    const body = textOf(parts)
    // Not the CLI's own sentence, which names no account and no local time.
    assert.equal(body.includes("You've hit your individual spend limit"), false)
    // Not the rate-limit paragraph, which is log-only now.
    assert.equal(body.includes(RATE_LIMIT_MARKER), false)
    // And no form: nothing is asked, so nothing can be dismissed.
    assert.equal(parts.some((part) => part.type === "tool-call"), false)

    // The note replaced text, not flow: no form, no second note, no `return`
    // anywhere. What DID change is the finish. A limited turn served nothing,
    // and as a `stop` opencode filed it as an ordinary (very short) reply;
    // that is what let a limited compaction turn be stored as a summary at
    // all (issue #90), and the account-block path has finished as an error
    // since it was written. The two agree now (h #g214). No `error` part
    // here, though: the note is what the operator reads, and an error part
    // outside compaction would put a second account of the same failure on
    // screen.
    const finish = parts.find((part) => part.type === "finish")
    assert.equal(finish.finishReason.unified, "error")
    assert.equal(finish.finishReason.raw, "usage_limit")
    assert.equal(parts.some((part) => part.type === "error"), false)
  } finally {
    deleteActiveProcess(sk)
    _resetAccountOverrides()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("the second limited turn in one process says it again, in full", async () => {
  // Two regressions in one case. `reportRateLimitEvent` dedupes per identity
  // per process, so the paragraph appeared once and every later limited turn
  // in that opencode process showed the CLI's raw sentence only. And the CLI
  // emits `rate_limit_event` when its view CHANGES, so the second turn on a
  // reused child carries none and the note has to recall the window and the
  // reset from the first (`rememberAccountLimit`). Deliberately no
  // `_resetRateLimitReports()` or `_resetAccountLimitMemory()` between them.
  _resetAccountOverrides()
  _resetRateLimitReports()
  _resetAccountLimitMemory()
  _resetSystemInitReports()
  const fake = createFakeCli()
  const sk = sessionKey(
    fake.cwd,
    `${MODEL_ID}::tools::default::context=["claude-code",null]`,
  )
  process.env.FAKE_CLI_REPEAT = "1"
  process.env.FAKE_CLI_NO_REPEAT_EVENT = "1"
  try {
    const model = await buildFailoverModel(fake)
    const first = await drain(
      await model.doStream({ prompt: turnOnePrompt, tools: TOOLS } as any),
    )
    const second = await drain(
      await model.doStream({
        prompt: [
          ...turnOnePrompt,
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
          { role: "user", content: [{ type: "text", text: "go again" }] },
        ],
        tools: TOOLS,
      } as any),
    )

    for (const [label, parts] of [["first", first], ["second", second]] as const) {
      const notes = notesIn(parts)
      assert.equal(notes.length, 1, `${label} turn: ${JSON.stringify(notes)}`)
      assert.ok(notes[0].startsWith(USAGE_LIMIT_MARKER), `${label} turn note`)
      // The window and the reset survive on the turn that was told neither.
      assert.match(notes[0], /is out of usage in the 5-hour window/, `${label} window`)
      assert.match(
        notes[0],
        new RegExp(`resets at ${formatLocalMinute(LIMIT_RESETS_AT * 1000)}`),
        `${label} reset`,
      )
    }
  } finally {
    delete process.env.FAKE_CLI_REPEAT
    delete process.env.FAKE_CLI_NO_REPEAT_EVENT
    deleteActiveProcess(sk)
    _resetAccountOverrides()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("with one account configured the note says wait or enable extra usage", async () => {
  _resetAccountOverrides()
  _resetRateLimitReports()
  _resetSystemInitReports()
  const fake = createFakeCli()
  const sk = sessionKey(
    fake.cwd,
    `${MODEL_ID}::tools::default::context=["claude-code",null]`,
  )
  try {
    const model = await buildFailoverModel(fake, ["appical"])
    const parts = await drain(
      await model.doStream({ prompt: turnOnePrompt, tools: TOOLS } as any),
    )
    const notes = notesIn(parts)
    assert.equal(notes.length, 1, JSON.stringify(notes))
    assert.match(notes[0], /Wait for the window to reset, or enable extra usage on the account\./)
    assert.equal(notes[0].includes("Pick a model"), false)
  } finally {
    deleteActiveProcess(sk)
    _resetAccountOverrides()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a turn that was served despite a rejected limit event keeps its answer and gets no note", async () => {
  _resetAccountOverrides()
  _resetRateLimitReports()
  _resetSystemInitReports()
  const fake = createFakeCli()
  const sk = sessionKey(
    fake.cwd,
    `${MODEL_ID}::tools::default::context=["claude-code",null]`,
  )
  process.env.FAKE_CLI_SERVED_AFTER_REJECT = "1"
  try {
    const model = await buildFailoverModel(fake)
    const parts = await drain(
      await model.doStream({ prompt: turnOnePrompt, tools: TOOLS } as any),
    )
    const body = textOf(parts)
    assert.match(body, /served anyway/)
    assert.deepEqual(notesIn(parts), [])
    assert.equal(parts.find((part) => part.type === "finish").finishReason.unified, "stop")
  } finally {
    delete process.env.FAKE_CLI_SERVED_AFTER_REJECT
    deleteActiveProcess(sk)
    _resetAccountOverrides()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a limited compaction turn stores nothing and fails as an error", async () => {
  // Issue #90. A `/compact` turn's text is what opencode stores as the
  // summary, so neither the note nor the CLI's own limit sentence may be
  // written: the reporter's stored summary was that sentence, twice over, and
  // every later session started from a transcript that began with it.
  //
  // This case used to assert the opposite of its last two lines (the CLI's
  // sentence present, the turn finishing `stop`), which is exactly the bug.
  // Both were deliberate at the time: the note was the only thing being
  // suppressed, and nothing had yet asked what opencode does with the text
  // that was left. The answer is that it stores it (h #g214).
  _resetAccountOverrides()
  _resetRateLimitReports()
  _resetSystemInitReports()
  const fake = createFakeCli()
  try {
    const model = await buildFailoverModel(fake)
    const parts = await drain(
      await model.doStream({
        prompt: turnOnePrompt,
        providerOptions: { "claude-code": { opencodeAgent: "compaction" } },
      } as any),
    )
    const body = textOf(parts)
    // Nothing at all for opencode to keep: no note, no CLI prose, no text.
    assert.equal(body.includes(USAGE_LIMIT_MARKER), false)
    assert.equal(body.includes("You've hit your individual spend limit"), false)
    assert.equal(body.trim(), "")

    // And the turn fails, so opencode runs its own failure path instead of
    // filing a summary. Both halves: the error part and the finish.
    const error = parts.find((part) => part.type === "error")
    assert.ok(error, "a failed compaction ends on an error part")
    assert.match(String(error.error?.message), /could not compact this conversation \(usage_limit\)/)
    // The CLI's sentence is in the error, which is read rather than stored.
    assert.match(String(error.error?.message), /You've hit your individual spend limit/)
    const finish = parts.find((part) => part.type === "finish")
    assert.equal(finish.finishReason.unified, "error")
    assert.equal(finish.finishReason.raw, "usage_limit")
  } finally {
    killAllActiveProcesses()
    _resetAccountOverrides()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a compaction turn that works is unchanged", async () => {
  // The control for the case above: the suppression must be keyed on the
  // failure, not on compaction, or every summary would be thrown away.
  _resetAccountOverrides()
  _resetRateLimitReports()
  _resetSystemInitReports()
  const fake = createFakeCli()
  process.env.FAKE_CLI_ALWAYS_OK = "1"
  try {
    const model = await buildFailoverModel(fake)
    const parts = await drain(
      await model.doStream({
        prompt: turnOnePrompt,
        providerOptions: { "claude-code": { opencodeAgent: "compaction" } },
      } as any),
    )
    assert.equal(textOf(parts), "carried on")
    assert.equal(parts.some((part) => part.type === "error"), false)
    const finish = parts.find((part) => part.type === "finish")
    assert.equal(finish.finishReason.unified, "stop")
  } finally {
    delete process.env.FAKE_CLI_ALWAYS_OK
    killAllActiveProcesses()
    _resetAccountOverrides()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a compaction turn blocked by an expired login fails without the login note", async () => {
  // The other cause, and the one that proves this is not limit-specific: an
  // account block names its own kind, and its note is suppressed for the same
  // reason the limit's is (h #g214).
  _resetAccountOverrides()
  _resetRateLimitReports()
  _resetSystemInitReports()
  const fake = createFakeCli()
  process.env.FAKE_CLI_AUTH_EXPIRED = "1"
  try {
    const model = await buildFailoverModel(fake)
    const parts = await drain(
      await model.doStream({
        prompt: turnOnePrompt,
        providerOptions: { "claude-code": { opencodeAgent: "compaction" } },
      } as any),
    )
    assert.equal(textOf(parts).trim(), "")
    const finish = parts.find((part) => part.type === "finish")
    assert.equal(finish.finishReason.unified, "error")
    assert.equal(finish.finishReason.raw, "authentication_failed")
    assert.match(
      String(parts.find((part) => part.type === "error")?.error?.message),
      /could not compact this conversation \(authentication_failed\)/,
    )
  } finally {
    delete process.env.FAKE_CLI_AUTH_EXPIRED
    killAllActiveProcesses()
    _resetAccountOverrides()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})
