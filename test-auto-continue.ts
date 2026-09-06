/**
 * Unit tests for smart auto-continuation policy in
 * src/claude-code-language-model.ts.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import {
  shouldAutoContinueIncompleteTurn,
  autoContinueEnabledFor,
} from "./src/claude-code-language-model.js"

function state(overrides: Record<string, unknown> = {}) {
  return {
    enabled: "smart" as const,
    attempts: 0,
    startedAt: 1_000,
    noProgressCount: 0,
    ...overrides,
  } as any
}

function snap(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    text: "",
    lastVisibleText: "",
    hadReasoning: false,
    hadToolActivity: false,
    hadProxyActivity: false,
    now: 1_500,
    ...overrides,
  }
  // Default lastVisibleText to mirror text unless explicitly overridden, so
  // legacy single-block test cases keep working.
  if (
    overrides.text !== undefined &&
    overrides.lastVisibleText === undefined
  ) {
    base.lastVisibleText = overrides.text
  }
  return base as any
}

test("smart auto-continue is disabled by false", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state({ enabled: false }),
    snap({ hadReasoning: true }),
  )
  assert.deepEqual(result, { continue: false, reason: "disabled" })
})

test("continues reasoning-only result with no visible answer", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({ hadReasoning: true }),
  )
  assert.equal(result.continue, true)
  assert.equal(result.reason, "activity-without-visible-answer")
})

test("continues tool activity without visible answer", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({ hadToolActivity: true }),
  )
  assert.equal(result.continue, true)
})

test("continues non-final visible progress", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({ text: "I found the relevant files and am checking the tests.", hadToolActivity: true }),
  )
  assert.deepEqual(result, { continue: true, reason: "non-final-progress" })
})

test("stops for final-looking visible answer", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({ text: "Done. Implemented the fix and tests passed successfully.", hadToolActivity: true }),
  )
  assert.deepEqual(result, { continue: false, reason: "final-answer" })
})

test("stops for question", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({ text: "Which option do you want me to use?", hadReasoning: true }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

test("stops for blocker", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({ text: "I cannot proceed because the required token is missing.", hadToolActivity: true }),
  )
  assert.deepEqual(result, { continue: false, reason: "blocker" })
})

test("stops for errors", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({ isError: true, hadToolActivity: true }),
  )
  assert.deepEqual(result, { continue: false, reason: "error" })
})

test("stops at max attempts", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state({ attempts: 8 }),
    snap({ hadReasoning: true }),
  )
  assert.deepEqual(result, { continue: false, reason: "max-attempts" })
})

test("stops when elapsed budget is exhausted", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state({ startedAt: 0 }),
    snap({ hadReasoning: true, now: 10 * 60 * 1000 + 1 }),
  )
  assert.deepEqual(result, { continue: false, reason: "max-elapsed" })
})

test("stops on repeated no-progress continuation", () => {
  const snapshot = snap({ hadReasoning: true })
  const first = shouldAutoContinueIncompleteTurn(state(), snapshot)
  assert.equal(first.continue, true)

  const second = shouldAutoContinueIncompleteTurn(
    state({
      lastSignature: JSON.stringify({
        text: "",
        reasoning: true,
        tools: false,
        proxy: false,
      }),
      noProgressCount: 1,
    }),
    snapshot,
  )
  assert.deepEqual(second, { continue: false, reason: "no-progress" })
})

test("stops when there was no activity", () => {
  const result = shouldAutoContinueIncompleteTurn(state(), snap())
  assert.deepEqual(result, { continue: false, reason: "no-activity" })
})

test("ignores final-answer keywords in earlier text blocks", () => {
  // Earlier mid-task narration contains keywords like 'implemented' and
  // 'updated' — but the LAST text block is a mid-task pause. Should still
  // continue.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text:
        "I implemented the helper. Updated the search index. " +
        "Now checking the next set of files.",
      lastVisibleText: "Now checking the next set of files.",
      hadToolActivity: true,
    }),
  )
  assert.equal(result.continue, true)
  assert.equal(result.reason, "non-final-progress")
})

test("stops when the last text block looks like a final answer", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text:
        "Let me check the files. " +
        "Found three matches. " +
        "Done. Implemented the fix and tests passed successfully.",
      lastVisibleText:
        "Done. Implemented the fix and tests passed successfully.",
      hadToolActivity: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "final-answer" })
})

test("question in any earlier text block still stops continuation", () => {
  // Even if the last block looks mid-task, a question raised earlier in the
  // turn should still block auto-continue — answering a question is the
  // user's job.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text:
        "Which option do you want me to use? Continuing with the first one for now.",
      lastVisibleText: "Continuing with the first one for now.",
      hadToolActivity: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

// ─── v0.4.10 regression tests for tweaks 2, 3, 4, 5 ────────────────────────

test("v0.4.10 tweak 2: 'let me know if you'd like' stops as question", () => {
  // Indirect offer of next steps without literal '?'. C03 in the sim corpus.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text:
        "Let me know if you'd like me to proceed with the cleanup phase or stop here.",
      hadReasoning: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

test("v0.4.10 tweak 3: 'needs your approval' stops as blocker", () => {
  // 'needs your' is intent-equivalent to 'requires your' but slipped past
  // the regex pre-0.4.10. D03 in the sim corpus.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text:
        "Needs your approval before I push the tag — auto-push is not enabled.",
      hadReasoning: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "blocker" })
})

test("v0.4.10 tweak 4: short completion (36 chars) stops as final-answer", () => {
  // Pre-0.4.10 floor of 40 chars let "Task is now completely done. Pushed."
  // through as non-final-progress. Floor lowered to 30. I01 in the sim corpus.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "Task is now completely done. Pushed.",
      hadToolActivity: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "final-answer" })
})

test("v0.4.10 tweak 5a: '?' anywhere in last block stops as question", () => {
  // Real fire shape from 2026-05-14T03:31 — long answer that asks a
  // question early then lists options and ends in a period.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text:
        "Here's the plan. Want me to proceed with that? Concretely: 1. Do X. 2. Do Y. 3. Do Z. Say 'go' or push back on any step.",
      hadReasoning: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

test("v0.4.10 tweak 5b: 'say go or push back' (no '?') stops as question", () => {
  // Pure soft-proceed phrasing with no '?' anywhere. Tests that the
  // phrase-based half of tweak 5 fires independently of the '?' check.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text:
        "Pick the option you want. Say 'go' to ship as planned, or push back on any specific step.",
      hadReasoning: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

test("v0.4.10 tweak 5c: 'if you want to' stops as question", () => {
  // Reconstruction of 02:48:11-style fire — long analysis ending in a
  // conditional action offer with no '?'.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text:
        "Three options are on the table. The recommendation is to leave DEBUG off. Consider option C if you want to re-enable DEBUG without UI noise.",
      hadReasoning: true, hadToolActivity: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

test("v0.4.10 tweak 5d: A-class continues unaffected (no '?' or soft-proceed phrase)", () => {
  // Sanity check: mid-task narration without question signals should still
  // continue. Catches regressions where '?' or phrase regex accidentally
  // expands.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "Now I'll read the file. Then I'll diff against previous. Then summarize.",
      hadReasoning: true,
    }),
  )
  assert.deepEqual(result, { continue: true, reason: "non-final-progress" })
})

// ─── v0.4.11 regression tests ──────────────────────────────────────────────

test("v0.4.11 'ready when you are' stops as question", () => {
  // Real fire from 2026-05-14T04:00:41 — short answer ending in this
  // canonical 'your move' phrase fired 4-δ inappropriately on v0.4.10.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "The standing-by stub lives in training, not just the CLI's empty-turn behavior. Ready when you are.",
      hadReasoning: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

test("v0.4.11 'standing by' stops as question (the meta-irony stub)", () => {
  // Commit 49345e3 originally fought 'No input received. Standing by.' at
  // the message-builder layer (suppressing the CLI stub on empty turns).
  // This test guards against the model organically producing the same
  // idiom at the response layer.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "All done on my side; the rest is on you. Standing by.",
      hadReasoning: true, hadToolActivity: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

test("v0.4.11 'let me know when' stops as question", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "I've staged everything for the release. Let me know when you've reviewed.",
      hadReasoning: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

// ─── v0.4.12 regression tests ──────────────────────────────────────────────

test("v0.4.12 'over to you' stops as question", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "I've prepared the patch and tests are green. Over to you.",
      hadReasoning: true, hadToolActivity: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

test("v0.4.12 'your turn' stops as question", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "Reviewed the diff and flagged three concerns. Your turn to pick a direction.",
      hadReasoning: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

test("v0.4.12 'all yours' stops as question", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "Branch is rebased and the PR template filled. The rest is all yours.",
      hadReasoning: true, hadToolActivity: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

test("v0.4.12 'let me know how' stops as question", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "Three viable paths surfaced. Let me know how you'd like to proceed.",
      hadReasoning: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

test("v0.4.12 'i'm here' stops as question", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "All staged for the release. I'm here when you're ready to ship.",
      hadReasoning: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

// ─── v0.4.15 regression tests ──────────────────────────────────────────────

test("v0.4.15 'shipped' as final-answer keyword", () => {
  // Real fire shape from 03:31 — long completion narrative ending with
  // 'shipped'-style verbs that weren't in the v0.4.14 keyword list.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "v0.4.15 on npm, pin matches, 78/78 tests pass, sim corpus preserved as future leverage. Shipped.",
      hadReasoning: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "final-answer" })
})

test("v0.4.15 'deployed/merged/tagged' as keywords", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "Patch merged to master, tagged v0.4.15, deployed via CI. Restart at your convenience.",
      hadReasoning: true, hadToolActivity: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "final-answer" })
})

test("v0.4.15 'pinned' as keyword", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "Plugin pinned at @0.4.15 in opencode.jsonc. Restart loads it.",
      hadReasoning: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "final-answer" })
})

test("v0.4.15 short 'We're done.' bypasses length floor", () => {
  // 11 chars — would have been below the 30-char threshold and missed
  // pre-v0.4.15. The strong-completion phrase override catches it.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "We're done.",
      hadReasoning: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "final-answer" })
})

test("v0.4.15 short 'All set.' bypasses length floor", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "All set.",
      hadReasoning: true, hadToolActivity: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "final-answer" })
})

test("v0.4.15 'tests pass' (present tense) stops as final-answer", () => {
  // Real fire 03:31 ended in "78/78 tests pass" — the v0.4.14 regex
  // matched only past tense ("tests passed") so the fire was missed.
  // This case is the actual 03:31 message text.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "v0.4.13 on npm, pin matches, 78/78 tests pass, sim corpus + regression bench preserved as future leverage.",
      hadReasoning: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "final-answer" })
})

test("v0.4.16 end_turn stop_reason short-circuits heuristic", () => {
  // Even a long ambiguous mid-task narration with no completion keywords
  // and visible tool activity gets stopped immediately when Claude CLI
  // signals end_turn. This is the architectural alternative to chasing
  // soft-proceed idioms via regex (v0.4.10-15).
  const ambiguous =
    "Running the next probe to inspect the build output and confirm bundle sizes are roughly equal."
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: ambiguous,
      hadReasoning: true,
      hadToolActivity: true,
      stopReason: "end_turn",
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "end-turn" })
})

test("v0.4.16 end_turn beats max-attempts (decided last)", () => {
  // End-turn wins over budget guards too — once the model says it's done,
  // there's no value in burning more attempts.
  const result = shouldAutoContinueIncompleteTurn(
    state({ attempts: 999 }),
    snap({ stopReason: "end_turn", hadReasoning: true }),
  )
  assert.deepEqual(result, { continue: false, reason: "end-turn" })
})

test("v0.4.16 end_turn does NOT beat genuine error", () => {
  // is_error still wins. Defensive: we don't want to silently treat a CLI
  // error as a clean stop.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({ stopReason: "end_turn", isError: true }),
  )
  assert.deepEqual(result, { continue: false, reason: "error" })
})

test("v0.4.16 end_turn does NOT beat abort", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state({ aborted: true }),
    snap({ stopReason: "end_turn" }),
  )
  assert.deepEqual(result, { continue: false, reason: "aborted" })
})

test("max_tokens continues: truncation is not a finished turn", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "Working on it",
      hadReasoning: true,
      hadToolActivity: true,
      stopReason: "max_tokens",
    }),
  )
  assert.deepEqual(result, { continue: true, reason: "truncated" })
})

test("truncated prose continues even with no tool or reasoning activity", () => {
  // The common truncation case: one long answer, cut off mid-sentence. This
  // is why truncation cannot simply fall through to the keyword heuristic —
  // it would stop at the no-activity gate.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "The migration works by first taking the old rows and",
      lastVisibleText: "The migration works by first taking the old rows and",
      stopReason: "max_tokens",
    }),
  )
  assert.deepEqual(result, { continue: true, reason: "truncated" })
})

test("max_output_tokens is treated as truncation too", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({ stopReason: "max_output_tokens" }),
  )
  assert.deepEqual(result, { continue: true, reason: "truncated" })
})

// Mirrors the module-private caps: 8 attempts, 10 minutes.
const MAX_ATTEMPTS = 8
const MAX_ELAPSED_MS = 10 * 60 * 1000

test("truncation still respects the attempt cap", () => {
  const result = shouldAutoContinueIncompleteTurn(
    { ...state(), attempts: MAX_ATTEMPTS },
    snap({ stopReason: "max_tokens" }),
  )
  assert.deepEqual(result, { continue: false, reason: "max-attempts" })
})

test("truncation still respects the elapsed cap", () => {
  const started = 1_000
  const result = shouldAutoContinueIncompleteTurn(
    { ...state(), startedAt: started },
    snap({
      stopReason: "max_tokens",
      now: started + MAX_ELAPSED_MS + 1,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "max-elapsed" })
})

test("truncation does not override an abort or an error", () => {
  assert.deepEqual(
    shouldAutoContinueIncompleteTurn(
      { ...state(), aborted: true },
      snap({ stopReason: "max_tokens" }),
    ),
    { continue: false, reason: "aborted" },
  )
  assert.deepEqual(
    shouldAutoContinueIncompleteTurn(
      state(),
      snap({ stopReason: "max_tokens", isError: true }),
    ),
    { continue: false, reason: "error" },
  )
})

test("truncation does not override a pending operator question", () => {
  const result = shouldAutoContinueIncompleteTurn(
    { ...state(), sawAskUserQuestion: true },
    snap({ stopReason: "max_tokens" }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

test("v0.4.17 stop_sequence stops via protocol signal", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({ stopReason: "stop_sequence", hadReasoning: true }),
  )
  assert.deepEqual(result, { continue: false, reason: "stop-sequence" })
})

test("v0.4.17 refusal stops via protocol signal", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({ stopReason: "refusal" }),
  )
  assert.deepEqual(result, { continue: false, reason: "refusal" })
})

test("v0.4.17 pause_turn stops via protocol signal", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({ stopReason: "pause_turn", hadReasoning: true }),
  )
  assert.deepEqual(result, { continue: false, reason: "pause-turn" })
})

test("v0.4.17 tool_use stops via protocol signal", () => {
  // Defensive: tool_use shouldn't normally reach the result boundary
  // (drain timer closes the stream first), but if it does we honor it.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({ stopReason: "tool_use", hadToolActivity: true }),
  )
  assert.deepEqual(result, { continue: false, reason: "tool-use" })
})

test("v0.4.17 unknown stop_reason still stops (forward-compat)", () => {
  // If Anthropic adds a new stop_reason value, we trust it as authoritative
  // and stop. Safer than running the keyword heuristic on unknown shape.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({ stopReason: "future_value_we_dont_know" }),
  )
  assert.deepEqual(result, {
    continue: false,
    reason: "future-value-we-dont-know",
  })
})

test("v0.4.17 empty-string stop_reason falls through (falsy)", () => {
  // Empty string is falsy — fall back to heuristic, same as null/undefined.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "We're done.",
      hadReasoning: true,
      stopReason: "",
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "final-answer" })
})

test("v0.4.16 missing stop_reason falls through (back-compat)", () => {
  // When stop_reason is undefined or null, the heuristic must still run
  // unchanged. Protects against CLI versions / paths that don't surface it.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "We're done.",
      hadReasoning: true,
      stopReason: null,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "final-answer" })
})

test("sawAskUserQuestion latch blocks auto-continue even with non-question trailing text", () => {
  // After AskUserQuestion the model may emit a short trailing line that does
  // not read as a question (no '?'). Without the latch, that would look like
  // an incomplete turn and trigger a nudge that makes the model proceed on
  // its own. The latch must stop it regardless.
  const result = shouldAutoContinueIncompleteTurn(
    state({ sawAskUserQuestion: true }),
    snap({
      text: "I'll go with the first option.",
      hadToolActivity: true,
      stopReason: null,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

test("a compaction turn never continues, not even on truncation", () => {
  // doStream builds the state with `enabled: false` for compaction turns.
  // AUTO_CONTINUE_PROMPT says "Do not summarize; keep working", so nudging a
  // /compact turn would append non-summary text to the session summary.
  const result = shouldAutoContinueIncompleteTurn(
    { ...state(), enabled: false },
    snap({ stopReason: "max_tokens" }),
  )
  assert.deepEqual(result, { continue: false, reason: "disabled" })
})

test("doStream disables auto-continue for compaction turns", () => {
  // The wiring doStream uses. A compaction turn is off regardless of config;
  // every other turn passes the configured value through untouched.
  assert.equal(autoContinueEnabledFor(true, "smart"), false)
  assert.equal(autoContinueEnabledFor(true, true), false)
  assert.equal(autoContinueEnabledFor(false, "smart"), "smart")
  assert.equal(autoContinueEnabledFor(false, true), true)
  assert.equal(autoContinueEnabledFor(false, false), false)
  assert.equal(autoContinueEnabledFor(false, undefined), undefined)
})
