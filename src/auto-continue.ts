/**
 * Auto-continue: whether a turn that ended without finishing should be
 * nudged to keep going, and the nudge itself.
 *
 * Split out of `claude-code-language-model.ts` verbatim. The decision is
 * pure (state plus a snapshot of the turn in, a verdict out), which is why
 * it moved first: `shouldAutoContinueIncompleteTurn` is exercised directly
 * by `test-auto-continue.ts` and by the corpus runner under `sim/`.
 */

const AUTO_CONTINUE_MAX_ATTEMPTS = 8
const AUTO_CONTINUE_MAX_ELAPSED_MS = 10 * 60 * 1000
const AUTO_CONTINUE_NO_PROGRESS_LIMIT = 2

const AUTO_CONTINUE_PROMPT =
  "Continue the task from where you stopped. Do not summarize; keep working until the requested task is complete, you need clarification, or you hit a real blocker."

export interface AutoContinueState {
  enabled: boolean | "smart" | undefined
  attempts: number
  startedAt: number
  noProgressCount: number
  lastSignature?: string
  aborted?: boolean
  /**
   * Latched true once AskUserQuestion is rendered this turn. Auto-continue
   * must never fire afterwards: the model has handed control to the operator
   * and is waiting for a real reply. Without this, a short trailing text after
   * the question (one that doesn't trip looksLikeQuestion) would let the turn
   * look "incomplete", and the auto-continue nudge would make the model
   * proceed on its own — which the operator sees as the question being
   * answered/cancelled without them ever interacting.
   */
  sawAskUserQuestion?: boolean
}

export interface AutoContinueSnapshot {
  text: string
  /**
   * Text of the most recent assistant text block only. Used for final-answer
   * detection so mid-task narration like "Implementing now. Updated the
   * search index." in an earlier block doesn't trip the keyword regex.
   */
  lastVisibleText: string
  hadReasoning: boolean
  hadToolActivity: boolean
  hadProxyActivity: boolean
  isError?: boolean
  /**
   * Protocol-level stop signal from the Claude API (forwarded by Claude
   * CLI). When present and non-empty, we trust it as authoritative — the
   * model itself signaled why the turn ended (`end_turn`, `max_tokens`,
   * `stop_sequence`, `refusal`, `pause_turn`, `tool_use`, etc.) — and stop
   * without running the keyword regex. The heuristic only runs as a
   * fallback when `stop_reason` is missing (older CLI versions, abrupt
   * termination).
   */
  stopReason?: string | null
  now?: number
}

/**
 * A compaction turn must never be nudged to continue. `AUTO_CONTINUE_PROMPT`
 * says "Do not summarize; keep working", the exact inverse of what `/compact`
 * is for, and continuation reopens the same stream rather than closing it, so
 * the non-summary text would land inside what opencode stores as the session
 * summary. This was unreachable while every `stop_reason` ended the turn;
 * truncation-continue made a summary that hits the output cap reach it.
 * Exported so the wiring is testable, since the state itself is built inline
 * in `doStream`.
 */
export function autoContinueEnabledFor(
  compactionMode: boolean,
  configured: boolean | "smart" | undefined,
): boolean | "smart" | undefined {
  return compactionMode ? false : configured
}

/**
 * Stop reasons that mean "cut off", not "done". Anthropic sends `max_tokens`;
 * `max_output_tokens` is accepted as a defensive alias so a rename upstream
 * degrades to today's behaviour rather than silently mis-reading a real stop.
 */
function isTruncationStopReason(stopReason: string): boolean {
  return stopReason === "max_tokens" || stopReason === "max_output_tokens"
}

export interface AutoContinueDecision {
  continue: boolean
  reason: string
}

function normalizeVisibleText(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function looksLikeQuestion(text: string): boolean {
  const normalized = normalizeVisibleText(text).toLowerCase()
  if (!normalized) return false
  // v0.4.10 tweak 5a: '?' anywhere in the last block, not just trailing.
  // Catches long answers that pose a question mid-text then list options
  // and end with a period. FP risk on inline code (`result?.value`) is
  // accepted — cost is one extra "continue" press, in the safe direction.
  if (normalized.includes("?")) return true
  // v0.4.11 additions: ready when you are / standing by / i'll stand by /
  // let me know when. These are awaiting-input idioms with no '?'. The
  // "standing by" addition has historical significance — it's the exact
  // stub phrase Claude CLI emits on empty turns that commit 49345e3 was
  // designed to suppress at the message-builder layer. This adds a second
  // line of defense at the model-output layer for cases where the model
  // organically produces the same idiom.
  //
  // v0.4.12 additions: over to you / your turn / all yours / let me know
  // how / i'm here. Defensive coverage of soft-proceed idioms in the
  // model's vocabulary. "i'm here" has the highest FP risk ("I'm here to
  // help with X" is a conversational opener) but cost of FP is one extra
  // continue press — safe direction.
  return /\b(please confirm|can you confirm|should i|would you like|do you want|which option|choose|pick one|need your|need you to|what would you like|let me know if|let me know whether|let me know what|let me know when|let me know how|if you'?d like|if you want to|tell me if|tell me which|tell me whether|say (?:go|yes|no)|push back|sign off|sounds? (?:good|right)|your call|your move|your turn|over to you|all yours|up to you|ready to (?:ship|go|proceed|merge)|ready (?:when|whenever|once|if) you|standing by|i'?ll stand ?by|i'?m here|happy to (?:ship|go|proceed|merge))\b/.test(normalized)
}

function looksLikeBlocker(text: string): boolean {
  const normalized = normalizeVisibleText(text).toLowerCase()
  if (!normalized) return false
  // v0.4.10 tweak 3: 'needs your' / 'needs you to' / 'action required'
  // are intent-equivalent to 'requires your' but use the verb-with-s form.
  return /\b(blocked|blocker|cannot proceed|can't proceed|unable to proceed|need clarification|need more information|permission denied|failed and needs|requires your|needs your|needs you to|action required|manual step|required from you)\b/.test(normalized)
}

function looksLikeFinalAnswer(text: string): boolean {
  const normalized = normalizeVisibleText(text).toLowerCase()
  if (looksLikeQuestion(normalized) || looksLikeBlocker(normalized)) return false
  // v0.4.15: strong-completion phrases bypass the 30-char length floor.
  // These are unambiguous end-of-turn signals at any text length — even
  // a short standalone "We're done." should stop.
  if (/\b(we'?re done|we are done|all done|all set)\b/.test(normalized)) {
    return true
  }
  // v0.4.10 tweak 4: floor lowered 40 → 30 chars. Catches short clean
  // completions like "Task is now completely done. Pushed." (36 chars)
  // while keeping a buffer against ambiguous short narration.
  if (normalized.length < 30) return false
  // v0.4.15: keyword list extended with deploy/ship verbs the model
  // routinely uses at turn end (shipped, deployed, merged, tagged, live,
  // pinned). FP risk highest on "live" — "live data" mid-turn could match
  // — but cost of FP is one extra continue press, safe direction.
  return /\b(done|completed|fixed|implemented|verified|published|released|sent|delivered|updated|shipped|deployed|merged|tagged|live|pinned)\b/.test(normalized) ||
    // v0.4.15: also accept present-tense "tests pass" / "checks pass".
    // Real fire 03:31 ended in "78/78 tests pass" — past-tense-only regex
    // missed it.
    /\b(checks?|tests?) (?:pass|passes|passed)\b/.test(normalized) ||
    /\b(summary|what changed|verification)\b/.test(normalized)
}

export function continuationSignature(snapshot: AutoContinueSnapshot): string {
  const text = normalizeVisibleText(snapshot.text).slice(-500)
  return JSON.stringify({
    text,
    reasoning: snapshot.hadReasoning,
    tools: snapshot.hadToolActivity,
    proxy: snapshot.hadProxyActivity,
  })
}

export function shouldAutoContinueIncompleteTurn(
  state: AutoContinueState,
  snapshot: AutoContinueSnapshot,
): AutoContinueDecision {
  if (state.enabled === false) return { continue: false, reason: "disabled" }
  if (snapshot.isError) return { continue: false, reason: "error" }
  if (state.aborted) return { continue: false, reason: "aborted" }
  // Once the model asked the operator a question this turn, never nudge it to
  // continue — it is waiting for a reply, not stalled. Latched so it holds
  // even when the trailing text after the question doesn't read as a question.
  if (state.sawAskUserQuestion) return { continue: false, reason: "question" }
  // v0.4.17: trust ANY protocol-level stop_reason as authoritative. If
  // Claude CLI emitted a stop_reason value at all, the model has signaled
  // a stop — honor it without consulting the keyword heuristic. The
  // heuristic only runs as a fallback when stop_reason is missing (older
  // CLI versions / edge cases). Maps snake_case → kebab-case for reason
  // label consistency with other reasons.
  if (snapshot.stopReason) {
    // ...with one exception, which is the narrow half of @JWebCoder's PR #15
    // worth keeping. Truncation is the single stop_reason that does NOT mean
    // the model finished: the response hit the output cap mid-sentence. The
    // old guard read it as a stop, so a cut-off answer was silently accepted
    // as complete. Falling through to the keyword heuristic below would not
    // fix it either, because a truncated prose answer has no tool or
    // reasoning activity and would die at the `no-activity` gate. So
    // truncation is authoritative in the opposite direction: continue, still
    // bounded by the attempt and elapsed rails. PR #15 itself deleted the
    // whole guard, which would have handed every turn back to the regex that
    // v0.4.17 deliberately demoted; that is why it was closed.
    if (isTruncationStopReason(snapshot.stopReason)) {
      if (state.attempts >= AUTO_CONTINUE_MAX_ATTEMPTS) {
        return { continue: false, reason: "max-attempts" }
      }
      const truncatedAt = snapshot.now ?? Date.now()
      if (truncatedAt - state.startedAt > AUTO_CONTINUE_MAX_ELAPSED_MS) {
        return { continue: false, reason: "max-elapsed" }
      }
      return { continue: true, reason: "truncated" }
    }
    return {
      continue: false,
      reason: snapshot.stopReason.replace(/_/g, "-"),
    }
  }
  if (state.attempts >= AUTO_CONTINUE_MAX_ATTEMPTS) {
    return { continue: false, reason: "max-attempts" }
  }
  const now = snapshot.now ?? Date.now()
  if (now - state.startedAt > AUTO_CONTINUE_MAX_ELAPSED_MS) {
    return { continue: false, reason: "max-elapsed" }
  }

  const text = normalizeVisibleText(snapshot.text)
  const lastText = normalizeVisibleText(snapshot.lastVisibleText)
  if (looksLikeQuestion(text)) return { continue: false, reason: "question" }
  if (looksLikeBlocker(text)) return { continue: false, reason: "blocker" }
  // Final-answer detection runs on the most recent text block only. Earlier
  // blocks may contain mid-task narration that would false-positive the
  // keyword regex; the model's actual "I'm done" sentence is in the last
  // block before result/end_turn.
  if (looksLikeFinalAnswer(lastText)) {
    return { continue: false, reason: "final-answer" }
  }

  const hadActivity =
    snapshot.hadReasoning || snapshot.hadToolActivity || snapshot.hadProxyActivity
  if (!hadActivity) return { continue: false, reason: "no-activity" }

  const signature = continuationSignature(snapshot)
  const noProgress = signature === state.lastSignature
  if (noProgress && state.noProgressCount + 1 >= AUTO_CONTINUE_NO_PROGRESS_LIMIT) {
    return { continue: false, reason: "no-progress" }
  }

  if (!text) {
    return { continue: true, reason: "activity-without-visible-answer" }
  }

  return { continue: true, reason: "non-final-progress" }
}

export function makeAutoContinueMessage(): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: AUTO_CONTINUE_PROMPT }],
    },
  })
}
