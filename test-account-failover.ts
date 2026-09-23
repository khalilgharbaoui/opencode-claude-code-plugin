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
 * Usage: npx tsx --test test-account-failover.ts
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ensureAccountRuntime } from "./src/accounts.js"
import {
  ACCOUNT_FAILOVER_TOOL_CALL_PREFIX,
  FAILOVER_MARKER,
  ACCOUNT_BLOCK_MARKER,
  _resetAccountOverrides,
  accountBlockKind,
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
} from "./src/account-failover.js"
import { _resetRateLimitReports, _resetSystemInitReports } from "./src/cli-events.js"
import { createClaudeCode } from "./src/index.js"
import { filterSideQuestionHistory, getClaudeUserMessage } from "./src/message-builder.js"
import { setOpencodeClient } from "./src/runtime-status.js"
import { deleteActiveProcess, sessionKey } from "./src/session-manager.js"

// Every account runtime this file builds lands under a throwaway HOME, so no
// test ever writes a wrapper or a config dir into the real one.
const HOME = mkdtempSync(join(tmpdir(), "opencode-failover-home-"))
const originalHome = process.env.HOME
const originalCache = process.env.XDG_CACHE_HOME
process.env.HOME = HOME
process.env.XDG_CACHE_HOME = join(HOME, "cache")

after(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalCache === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = originalCache
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

test("the form is gated on more than one account, a question tool, and the transport", () => {
  const base = {
    configured: "ask" as const,
    candidates: ["work"],
    opencodeHasQuestion: true,
    compactionMode: false,
    interactive: false,
    childSession: false,
  }
  assert.equal(isAccountFailoverQuestionActive(base), true)
  // On by default: an unset option behaves as "ask".
  assert.equal(
    isAccountFailoverQuestionActive({ ...base, configured: undefined }),
    true,
  )
  assert.equal(isAccountFailoverQuestionActive({ ...base, configured: "off" }), false)
  assert.equal(isAccountFailoverQuestionActive({ ...base, candidates: [] }), false)
  assert.equal(
    isAccountFailoverQuestionActive({ ...base, opencodeHasQuestion: false }),
    false,
  )
  assert.equal(isAccountFailoverQuestionActive({ ...base, compactionMode: true }), false)
  assert.equal(isAccountFailoverQuestionActive({ ...base, interactive: true }), false)
  // A subagent follows its parent's account for free.
  assert.equal(isAccountFailoverQuestionActive({ ...base, childSession: true }), false)
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
const LIMITED_LINES = [
  { type: "system", subtype: "init", session_id: "limited-session", tools: [] },
  {
    type: "rate_limit_event",
    session_id: "limited-session",
    rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 4102444800 },
  },
  {
    type: "result",
    subtype: "error_during_execution",
    session_id: "limited-session",
    is_error: true,
    result: "You've hit your individual spend limit.",
    duration_ms: 10,
    num_turns: 1,
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

const rl = readline.createInterface({ input: process.stdin })
let answered = false
rl.on("line", (line) => {
  if (answered) return
  answered = true
  fs.appendFileSync(
    ${JSON.stringify(record)},
    JSON.stringify({
      argv: process.argv.slice(2),
      configDir: process.env.CLAUDE_CONFIG_DIR || null,
      stdin: line,
    }) + "\\n",
  )
  const lines = limited
    ? (authExpired ? AUTH_EXPIRED_LINES : overageOnly ? SERVED_WITH_OVERAGE_REJECTED_LINES : LIMITED_LINES)
    : FAILOVER_LINES
  for (const l of lines) {
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

async function buildFailoverModel(
  fake: ReturnType<typeof createFakeCli>,
  failoverAccounts: string[] = ["default", "appical"],
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
    cwd: fake.cwd,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
  }).languageModel(MODEL_ID)
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

test("a usage limit ends the turn on a question listing the other account", async () => {
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

    // The operator still sees why, from the existing rate-limit note.
    assert.match(textOf(parts), /▌ \*\*rate limit:\*\*/)

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
    const model = await buildFailoverModel(fake)
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
    assert.equal(parts.some((part) => part.type === "tool-call"), false)
    assert.equal(parts.find((part) => part.type === "finish").finishReason.unified, "error")
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
    const model = await buildFailoverModel(fake)
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
                  value: opencodeAnswer(JSON.parse(call.input).questions[0].question, "default"),
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

    // A transcript cannot resume across accounts, so the thread is replayed.
    assert.match(failoverSpawn.stdin, /<conversation_history>/)
    assert.match(failoverSpawn.stdin, /Continue the task from where it stopped/)
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
    const model = await buildFailoverModel(fake)
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
