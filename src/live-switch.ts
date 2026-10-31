import { log } from "./logger.js"
import { sendControlRequest } from "./control-channel.js"
import { rebindProxyServer } from "./spawn-planning.js"
import {
  cliEffortLevel,
  deleteActiveProcess,
  findLiveSwitchSource,
  moveActiveProcess,
  processBelongsToAnotherAccount,
  transferClaudeSession,
  type ActiveProcess,
} from "./session-manager.js"
import type { ReasoningEffort } from "./types.js"

/**
 * A model or reasoning effort change applied to the conversation's running
 * `claude` with the CLI's own control requests, instead of stopping it and
 * spawning another with `--resume` (h #g278).
 *
 * Measured on 2.1.288 and 2.1.314: `set_model` and `apply_flag_settings
 * {effortLevel}` both answer `success`, the next request goes out under the
 * new model or effort, the conversation is kept, and the prompt cache reads
 * and writes match the respawn's (a resumed child keeps its recorded tool set,
 * so both send the same prefix). The saving is the respawn: 4.6 to 6.6 s to
 * `system`/`init` on a real install, against about 25 ms for an effort change
 * and 0.5 to 0.7 s for a model change.
 */

/** How long one control request may take before the switch falls back. */
export function liveSwitchTimeoutMs(): number {
  const raw = Number(process.env.CLAUDE_CODE_LIVE_SWITCH_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000
}

export interface LiveSwitchTarget {
  /** The session key this turn is about to use. */
  sessionKey: string
  /** The model the CLI should run, without the `@account` marker or `-fast`. */
  model: string
  /** Whether this key's model id is a `-fast` one. */
  fast: boolean
  /** The `--model` value a spawn of this key passes, so a respawn keeps it. */
  spawnModelArg: string
  effort?: ReasoningEffort
  /** The binary and config dir this turn spawns with: the account guard. */
  cliPath: string
  configDir?: string
}

export type LiveSwitchPlan =
  | { kind: "switch"; setModel?: string; effortLevel?: string }
  | { kind: "refuse"; reason: string }

/**
 * What a live child needs sent to become the target, or why it cannot. Pure.
 *
 * Fast mode is a `--settings` layer read at start, so a change in it respawns.
 * An effort changes live only between two explicit levels on a child that
 * carries its effort as `--effort`: CLAUDE_CODE_EFFORT_LEVEL beats
 * `apply_flag_settings` (a `success` answer and an unchanged request, measured
 * on 2.1.314), and a level cleared with `null` falls to the model's default
 * rather than to what a respawn with no effort would inherit.
 */
export function planLiveSwitch(
  child: Pick<ActiveProcess, "liveSwitch" | "effort">,
  target: Pick<LiveSwitchTarget, "model" | "fast" | "effort">,
): LiveSwitchPlan {
  const live = child.liveSwitch
  if (!live) return { kind: "refuse", reason: "not-switchable" }
  if (live.fast !== target.fast) return { kind: "refuse", reason: "fast-mode-differs" }
  let effortLevel: string | undefined
  if (child.effort !== target.effort) {
    if (!child.effort || !target.effort) return { kind: "refuse", reason: "effort-unset" }
    if (!live.effortFlag) return { kind: "refuse", reason: "effort-not-a-flag" }
    const from = cliEffortLevel(child.effort)
    const to = cliEffortLevel(target.effort)
    if (from !== to) effortLevel = to
  }
  return {
    kind: "switch",
    ...(live.model !== target.model ? { setModel: target.model } : {}),
    ...(effortLevel ? { effortLevel } : {}),
  }
}

/** `args` with the value after `flag` replaced, when the flag is there. */
function withFlagValue(args: string[] | undefined, flag: string, value: string): string[] | undefined {
  if (!args) return args
  const at = args.indexOf(flag)
  if (at === -1 || at + 1 >= args.length) return args
  const next = [...args]
  next[at + 1] = value
  return next
}

export type LiveSwitchOutcome =
  | { switched: true; fromKey: string }
  | { switched: false; fromKey?: string; reason?: string }

/**
 * Apply this turn's model and effort to the conversation's live child when
 * one can take them, and hand the child and its conversation to this turn's
 * key. Anything short of that leaves the turn on today's path, which stops
 * the child and resumes the conversation in a new one: a child that was sent
 * a request and did not confirm it is stopped here first, because it may have
 * switched halfway. Never throws.
 */
export async function switchLiveProcess(
  target: LiveSwitchTarget,
  options: { abortSignal?: AbortSignal } = {},
): Promise<LiveSwitchOutcome> {
  const source = findLiveSwitchSource(target.sessionKey)
  if (source.kind === "none") return { switched: false }
  if (source.kind === "refused") {
    log.info("not switching the live claude process; respawning it", {
      sessionKey: target.sessionKey,
      fromKey: source.fromKey,
      reason: source.reason,
    })
    return { switched: false, fromKey: source.fromKey, reason: source.reason }
  }
  const { fromKey, process: child } = source
  const refuse = (reason: string): LiveSwitchOutcome => {
    log.info("not switching the live claude process; respawning it", {
      sessionKey: target.sessionKey,
      fromKey,
      reason,
    })
    return { switched: false, fromKey, reason }
  }
  // Never across accounts: a child speaks to the CLI and config dir it was
  // started with, and an account change moves the conversation by file
  // (h #g218), not by a control request.
  if (processBelongsToAnotherAccount(child, target.cliPath, target.configDir)) {
    return refuse("another-account")
  }
  const plan = planLiveSwitch(child, target)
  if (plan.kind === "refuse") return refuse(plan.reason)

  const startedAt = Date.now()
  const timeoutMs = liveSwitchTimeoutMs()
  const steps: { name: string; request: Record<string, unknown> }[] = []
  if (plan.setModel) steps.push({ name: "set_model", request: { subtype: "set_model", model: plan.setModel } })
  if (plan.effortLevel) {
    steps.push({
      name: "apply_flag_settings",
      request: { subtype: "apply_flag_settings", settings: { effortLevel: plan.effortLevel } },
    })
  }
  for (const step of steps) {
    const outcome = await sendControlRequest(child, step.request, {
      timeoutMs,
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    })
    if (!outcome.ok) {
      // Possibly half-switched (a timed-out request can still land), so it
      // must not be reused under either key. The conversation stays with the
      // old key, where today's respawn path picks it up.
      deleteActiveProcess(fromKey)
      log.notice("could not switch the live claude process; respawning it instead", {
        sessionKey: target.sessionKey,
        fromKey,
        step: step.name,
        reason: outcome.reason,
        ...(outcome.error ? { error: outcome.error } : {}),
      })
      return { switched: false, fromKey, reason: outcome.reason }
    }
  }

  // The conversation first, then the child. Neither should refuse, because
  // `findLiveSwitchSource` answers `none` when this key holds either; if one
  // does, the child goes and the turn is on today's path, with the
  // conversation wherever the respawn already looks for it.
  if (!transferClaudeSession(fromKey, target.sessionKey) || !moveActiveProcess(fromKey, target.sessionKey)) {
    deleteActiveProcess(fromKey)
    log.notice("could not switch the live claude process; respawning it instead", {
      sessionKey: target.sessionKey,
      fromKey,
      step: "move",
      reason: "move-refused",
    })
    return { switched: false, fromKey, reason: "move-refused" }
  }
  if (child.proxyServer) rebindProxyServer(child.proxyServer, target.sessionKey)
  // A watchdog respawn reuses `cliArgs` and `effort`, so they must say what
  // the child runs now, or the respawn would quietly switch it back.
  child.effort = target.effort
  child.cliArgs = withFlagValue(child.cliArgs, "--model", target.spawnModelArg)
  if (plan.effortLevel) child.cliArgs = withFlagValue(child.cliArgs, "--effort", plan.effortLevel)
  child.liveSwitch = { ...child.liveSwitch!, model: target.model }
  log.notice("switched the live claude process to the new model or effort instead of respawning it", {
    sessionKey: target.sessionKey,
    fromKey,
    ...(plan.setModel ? { model: plan.setModel } : {}),
    ...(plan.effortLevel ? { effort: plan.effortLevel } : {}),
    ms: Date.now() - startedAt,
  })
  return { switched: true, fromKey }
}
