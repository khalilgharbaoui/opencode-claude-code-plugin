/**
 * Reporting what actually happened to a fast-mode request.
 *
 * Split out of `claude-code-language-model.ts` verbatim. Fast mode fails
 * soft, so the downgrade has to warn rather than merely notice: the fast
 * model ids advertise fast pricing in opencode's picker, and a silent
 * downgrade leaves that price wrong for every later turn.
 */
import type { ClaudeStreamMessage } from "./types.js"
import { log } from "./logger.js"

/**
 * Human-readable explanations for the CLI's `fast_mode_disabled_reason` codes,
 * so a downgrade tells the user what to do instead of leaking an enum.
 */
const FAST_MODE_REASONS: Record<string, string> = {
  sdk_opt_in_required:
    "the CLI did not receive the headless opt-in (--settings). This is a plugin bug, please report it",
  extra_usage_disabled:
    "your account has usage credits turned off. Run /usage-credits in an interactive `claude` session to enable them",
  free: "fast mode requires a paid subscription or purchased credits",
  preference: "fast mode is turned off for your organization",
  model_not_allowed:
    "this model is not in your organization's allowed models",
  not_first_party:
    "fast mode only works against the Anthropic API directly, not Bedrock / Vertex / Foundry",
  network_error: "the CLI could not reach Anthropic to check availability",
  disabled_by_env: "CLAUDE_CODE_DISABLE_FAST_MODE is set in the environment",
  pending: "the CLI is still checking availability",
}

/** Reasons already surfaced this process, so a persistent block warns once. */
const warnedFastModeReasons = new Set<string>()

/** Test-only. */
export function _resetFastModeWarnings(): void {
  warnedFastModeReasons.clear()
}

/**
 * Report what actually happened to a fast-mode request.
 *
 * Fast mode fails soft: an ineligible account or a rate-limit cooldown drops
 * back to standard speed with no error. That silence is the problem worth
 * solving here: the fast model ids advertise fast pricing in opencode's picker,
 * so a downgrade the user cannot see means the picker is lying about cost for
 * every subsequent turn.
 *
 * A hard block is therefore a WARN, which this codebase routes to the TUI
 * unconditionally (NOTICE only surfaces in debug mode, which would defeat the
 * purpose). It is deduped per reason per process because the blocking
 * conditions are account-level and would otherwise repeat on every respawn.
 * Cooldown stays quieter: it is transient and clears on its own.
 */
export function reportFastModeState(
  msg: ClaudeStreamMessage,
  requested: boolean,
): void {
  const state = msg.fast_mode_state
  if (!state) return

  if (!requested) {
    // Nothing was asked for. Only interesting at debug level.
    log.debug("fast mode state", { state })
    return
  }

  if (state === "on") {
    log.info("fast mode active", { state })
    return
  }

  const reason = msg.fast_mode_disabled_reason
  if (state === "cooldown") {
    log.notice(
      "fast mode is in cooldown after a rate limit; this turn runs at standard speed and is billed at standard Opus rates, not the fast price shown in the model picker.",
      { state, reason: reason ?? null },
    )
    return
  }

  const key = reason ?? "unknown"
  const explanation = reason ? FAST_MODE_REASONS[reason] : undefined
  const message = `fast mode was requested but is off${
    explanation ? `: ${explanation}` : reason ? ` (${reason})` : ""
  }. Turns run at standard speed and are billed at standard Opus rates, not the fast price shown in the model picker. Switch to the non-fast model id to make the picker's price accurate.`

  if (warnedFastModeReasons.has(key)) {
    log.debug(message, { state, reason: reason ?? null })
    return
  }
  warnedFastModeReasons.add(key)
  log.warn(message, { state, reason: reason ?? null })
}
