import { execFile, type ExecFileOptions } from "node:child_process"
import { promisify } from "node:util"
import { log } from "./logger.js"
import { planClaudeSpawn } from "./windows-spawn.js"

const execFileAsync = promisify(execFile)

/**
 * Every probe spawn goes through the Windows plan.
 *
 * `execFile` is `CreateProcess`, which cannot start a `.cmd` at all, and
 * `claude` on Windows is normally the `claude.cmd` npm shim. So before this
 * the three probes below failed on every such install, which withheld every
 * version-gated flag, the skill bridge and `/btw` for the whole process: the
 * exact failure (h #g181) went to such lengths to make temporary.
 */
function probeExec(cliPath: string, args: string[], options: ExecFileOptions) {
  const plan = planClaudeSpawn(cliPath, args)
  return execFileAsync(plan.file, plan.args, {
    ...options,
    // utf8 is already `execFile`'s default; naming it is what keeps the
    // promisified overload returning strings rather than Buffers.
    encoding: "utf8",
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  })
}

export interface CliVersion {
  major: number
  minor: number
  patch: number
  raw: string
}

const cache = new Map<string, Promise<CliVersion | null>>()

/** How long a probe spawn may take before we stop waiting for it. */
const PROBE_TIMEOUT_MS = 5000
let probeTimeoutMs = PROBE_TIMEOUT_MS

/**
 * How many times in a row a probe killed by its own deadline is forgotten and
 * asked again, per probe key. The third consecutive kill is cached like any
 * other failure: a `claude` (or a wrapper) that is always slower than the
 * deadline would otherwise make every turn wait the full five seconds again.
 * A probe that answers resets the count.
 */
export const MAX_DEADLINE_REPROBES = 2
const deadlineReprobes = new Map<string, number>()

/**
 * True when our own deadline killed the probe rather than the binary
 * answering. That distinction decides whether the answer may be cached: every
 * other failure (missing binary, non-zero exit, output we cannot parse) is a
 * property of the binary and will repeat, so caching it saves a spawn per
 * turn. A deadline kill is a property of how busy the machine was for those
 * five seconds and says nothing about the binary at all.
 *
 * `killed` is true only when this process killed the child, which for
 * `execFile` means the timeout or `maxBuffer` did it. A `maxBuffer` overflow
 * carries a string `code` (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) and a plain
 * non-zero exit carries a numeric one, so a deadline kill is the case with a
 * signal and no code at all.
 */
function killedByDeadline(error: unknown): boolean {
  const failure = error as { killed?: boolean; signal?: unknown; code?: unknown } | null
  return (
    failure?.killed === true &&
    typeof failure.signal === "string" &&
    typeof failure.code !== "string"
  )
}

/**
 * Drop a cached answer that only described how loaded the machine was.
 *
 * Measured on 2026-10-01 at a load average of 66 to 76, with 40 concurrent
 * copies of `test/side-question.test.ts`: 6 of 40 `claude --version` probes were
 * killed by the deadline. Each `null` was then cached for the life of the
 * opencode process, and because every version gate reads that one answer, a
 * single busy moment during the first turn silently and permanently withheld
 * `--thinking-display summarized`, fast mode, `--restricted`,
 * `--permission-prompts` and `/btw` from the whole session. Forgetting the
 * entry costs at most one more spawn on a later turn and restores all of them.
 *
 * The entry is only removed while it is still ours: a caller that already
 * re-probed owns the slot now.
 */
function forgetDeadlineKill<T>(
  entries: Map<string, Promise<T>>,
  key: string,
  probe: Promise<T>,
  killed: () => boolean,
): void {
  void probe.then(() => {
    if (entries.get(key) !== probe) return
    if (!killed()) {
      deadlineReprobes.delete(key)
      return
    }
    const reprobes = deadlineReprobes.get(key) ?? 0
    if (reprobes >= MAX_DEADLINE_REPROBES) {
      log.warn("claude kept missing the probe deadline; keeping the conservative answer for this process", {
        key: key.replace("\x00", " "),
        deadlineMs: probeTimeoutMs,
        attempts: reprobes + 1,
      })
      return
    }
    deadlineReprobes.set(key, reprobes + 1)
    entries.delete(key)
  })
}

/**
 * Env vars set on every `claude` child so the binary we detected stays the
 * binary we run.
 *
 * `detectCliVersion` resolves once per cliPath and caches that answer (unless
 * its own deadline killed the probe) for the life of the opencode process,
 * and several flags are gated on it:
 * `--thinking-display summarized`, `--plugin-dir`, and fast mode via
 * `--settings`. If the CLI autoupdates underneath a long-running opencode the
 * cached version stops describing the binary actually being spawned, so a gated
 * flag can be passed to a CLI that rejects it or withheld from one that
 * supports it. A binary swapped mid-session is a plain correctness hazard
 * besides.
 *
 * Both names were read out of the Claude Code 2.1.263 bundle rather than
 * assumed (`rg -a` over the Mach-O, the technique AGENTS.md records for the CLI
 * stream events). `DISABLE_AUTOUPDATER` is read as an update blocker, and
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` both suppresses non-essential
 * network traffic and counts as a second, independent update blocker.
 * Anthropic's own runner sets `DISABLE_AUTOUPDATER: "1"` on the children it
 * spawns, which is the same use we are putting it to here.
 */
export const CLI_HYGIENE_ENV_VARS = [
  "DISABLE_AUTOUPDATER",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
] as const

/**
 * The hygiene vars that are missing from `inherited`, each set to "1".
 *
 * Only ever fills a gap: a var the user exported themselves is left exactly as
 * they set it, including an empty string, which both vars read as off. That is
 * the same rule the thinking vars follow in `claudeSpawnEnv`, and it is the
 * escape hatch for anyone who deliberately wants the autoupdater, so this needs
 * no provider option of its own.
 */
export function cliHygieneEnv(
  inherited: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const filled: Record<string, string> = {}
  for (const name of CLI_HYGIENE_ENV_VARS) {
    if (inherited[name] === undefined) filled[name] = "1"
  }
  return filled
}

/**
 * Run `claude --version` once per cliPath and parse the leading semver.
 * Returns null on any failure (binary missing, unparseable output, etc.)
 * so callers can fall back to the most conservative flag set.
 *
 * A probe our own deadline killed is the one failure that is not cached, so
 * the next caller re-probes rather than inheriting a busy moment forever. See
 * `forgetDeadlineKill`.
 */
export function detectCliVersion(cliPath: string): Promise<CliVersion | null> {
  const cached = cache.get(cliPath)
  if (cached) return cached
  let deadlineKill = false
  const promise = (async (): Promise<CliVersion | null> => {
    try {
      const { stdout } = await probeExec(cliPath, ["--version"], {
        timeout: probeTimeoutMs,
      })
      const match = /(\d+)\.(\d+)\.(\d+)/.exec(stdout.trim())
      if (!match) {
        log.warn("claude --version output unparseable", { stdout: stdout.trim() })
        return null
      }
      const v: CliVersion = {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        raw: stdout.trim(),
      }
      log.info("detected claude cli version", { cliPath, version: v.raw })
      if (!cliSupportsThinkingDisplay(v)) {
        log.notice(
          "claude cli < 2.1.142 detected; Opus 4.7 thinking summaries unavailable. Run `npm i -g @anthropic-ai/claude-code` to upgrade.",
          { version: v.raw },
        )
      }
      return v
    } catch (err) {
      deadlineKill = killedByDeadline(err)
      log.warn("failed to detect claude cli version", {
        cliPath,
        error: err instanceof Error ? err.message : String(err),
        deadlineKill,
      })
      return null
    }
  })()
  cache.set(cliPath, promise)
  forgetDeadlineKill(cache, cliPath, promise, () => deadlineKill)
  return promise
}

function gte(v: CliVersion, target: { major: number; minor: number; patch: number }): boolean {
  if (v.major !== target.major) return v.major > target.major
  if (v.minor !== target.minor) return v.minor > target.minor
  return v.patch >= target.patch
}

/**
 * `--thinking-display` was introduced in Claude Code 2.1.142 alongside
 * Opus 4.7's "omitted by default" thinking behavior. Older CLIs reject
 * the flag with a parse error, so we gate it. Unknown version → return
 * false so we don't risk crashing the spawn.
 */
export function cliSupportsThinkingDisplay(v: CliVersion | null): boolean {
  if (!v) return false
  return gte(v, { major: 2, minor: 1, patch: 142 })
}

/**
 * Fast mode's headless opt-in. In print mode the CLI reports
 * `fast_mode_disabled_reason: "sdk_opt_in_required"` unless the *flag* settings
 * layer carries `fastMode: true`, which only `--settings` populates (there is
 * no `--fast` flag, and no fast-mode model name the CLI still accepts).
 *
 * 2.1.220 is the floor because it is the oldest binary the opt-in path was
 * confirmed present in, not because 2.1.219 is known to lack it. An unknown
 * settings key is ignored rather than fatal, so the downside of gating too
 * high is only that fast mode stays off.
 */
export function cliSupportsFastMode(v: CliVersion | null): boolean {
  if (!v) return false
  return gte(v, { major: 2, minor: 1, patch: 220 })
}

/**
 * `--restricted` (removes the command and code-running built-ins plus
 * WebFetch, confines the file tools to the working directories, refuses
 * bypassPermissions). Claude Code's changelog puts it at 2.1.248; 2.1.258 is
 * the oldest binary on hand whose `--help` was checked and has it, and 2.1.248
 * itself could not be checked, so the gate sits at what was measured. Gating
 * one release line too high costs nothing but the flag; gating too low would
 * hand an older CLI an argument it exits on.
 */
export function cliSupportsRestricted(v: CliVersion | null): boolean {
  if (!v) return false
  return gte(v, { major: 2, minor: 1, patch: 258 })
}

/**
 * `--permission-prompts <host|none>`. Measured absent from 2.1.258's `--help`
 * and present in 2.1.263's, so the introduction is somewhere in between
 * (the changelog says 2.1.259) and the gate again sits at the verified side.
 * Below it the plugin's own `can_use_tool` handler is the only denier, which
 * is why the read-only preset sets `controlRequestBehavior` as well.
 */
export function cliSupportsPermissionPrompts(v: CliVersion | null): boolean {
  if (!v) return false
  return gte(v, { major: 2, minor: 1, patch: 263 })
}

/**
 * `--permission-mode dontAsk`: deny anything not pre-approved, without a
 * prompt. Present in the `--help` of every binary on hand (2.1.263, 2.1.280,
 * 2.1.288), so the gate sits at the oldest. The interactive transport's
 * read-only preset needs it (h #g201): a TUI permission dialog can only be
 * answered with Esc, which ends the whole turn.
 */
export function cliSupportsDontAsk(v: CliVersion | null): boolean {
  if (!v) return false
  return gte(v, { major: 2, minor: 1, patch: 263 })
}

/**
 * The CLI reads `skipDangerousModePermissionPrompt` from the `--settings`
 * layer, so the TUI can run `--dangerously-skip-permissions` without its
 * confirmation dialog. Read out of every binary on hand: 2.1.263, 2.1.280 and
 * 2.1.288 (h #g210), so the gate sits at the oldest.
 */
export function cliSupportsInteractiveBypass(v: CliVersion | null): boolean {
  if (!v) return false
  return gte(v, { major: 2, minor: 1, patch: 263 })
}

/**
 * The newest Claude Code the interactive transport was measured on end to end
 * (h #g205). The PTY reads the TUI's screen and its transcript, and neither is
 * a published contract, so a newer CLI is reported, never refused: the
 * transport exists for the day a new CLI drops `--print`, and refusing
 * unmeasured versions would switch it off exactly then.
 */
export const INTERACTIVE_MEASURED_CLI = "2.1.288"

const INTERACTIVE_MEASURED = { major: 2, minor: 1, patch: 288 }

/** True when `v` is known and newer than `INTERACTIVE_MEASURED_CLI`. */
export function isUnmeasuredInteractiveCli(v: CliVersion | null): boolean {
  if (!v) return false
  return gte(v, INTERACTIVE_MEASURED) && !(
    v.major === INTERACTIVE_MEASURED.major &&
    v.minor === INTERACTIVE_MEASURED.minor &&
    v.patch === INTERACTIVE_MEASURED.patch
  )
}

const warnedUnmeasuredInteractive = new Set<string>()

/**
 * One WARN per CLI version per process when the interactive transport runs on
 * a Claude Code newer than it was measured on. The turn goes ahead.
 */
export function reportUnmeasuredInteractiveCli(v: CliVersion | null): void {
  if (!v || !isUnmeasuredInteractiveCli(v) || warnedUnmeasuredInteractive.has(v.raw)) return
  warnedUnmeasuredInteractive.add(v.raw)
  log.warn(
    "the interactive transport has not been measured on this Claude Code version; it reads the TUI's screen and transcript, which a new release can change. If a turn hangs or a dialog is not handled, run /claude-code-doctor bundle and report it",
    { cliVersion: v.raw, measuredCli: INTERACTIVE_MEASURED_CLI },
  )
}

/** Test seam. */
export function _resetUnmeasuredInteractiveWarnings(): void {
  warnedUnmeasuredInteractive.clear()
}

/** 2.1.258 is the oldest verified side_question control protocol, not its introduction date. */
export function cliSupportsSideQuestion(v: CliVersion | null): boolean {
  if (!v) return false
  return gte(v, { major: 2, minor: 1, patch: 258 })
}

/**
 * `--thinking` has been part of Claude Code's CLI since the 2.x line.
 * We require a detected 2.0.0+ before passing it; unknown version → skip
 * to avoid crashing a pre-flag binary. Anyone on the 1.x line should
 * upgrade.
 */
export function cliSupportsThinking(v: CliVersion | null): boolean {
  if (!v) return false
  return gte(v, { major: 2, minor: 0, patch: 0 })
}

/** For tests. */
const flagSupport = new Map<string, Promise<boolean>>()

export type HeadlessSupport = "supported" | "unsupported" | "unknown"
const headlessSupport = new Map<string, Promise<HeadlessSupport>>()

/** A free, input-less parse probe. Never retry a submitted model request. */
export function detectHeadlessSupport(cliPath: string): Promise<HeadlessSupport> {
  const key = `${cliPath}\x00headless`
  const cached = headlessSupport.get(key)
  if (cached) return cached
  let deadlineKill = false
  const promise = (async (): Promise<HeadlessSupport> => {
    try {
      const execution = probeExec(cliPath, [
        "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--help",
      ], { timeout: probeTimeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 })
      execution.child.stdin?.end()
      const { stdout } = await execution
      // Empty, garbled or diagnostic output is not proof of removed flags.
      if (!/^\s*Usage:/im.test(stdout) || !/^\s*Options:/im.test(stdout)) return "unknown"
      const flags = ["--print", "--input-format", "--output-format"]
      if (!flags.every((flag) => new RegExp(`^\\s+(?:-[A-Za-z],\\s+)?${flag}(?:\\s|,|$)`, "m").test(stdout))) {
        return "unsupported"
      }
      return stdout.includes("stream-json") ? "supported" : "unknown"
    } catch (error) {
      deadlineKill = killedByDeadline(error)
      const stderr = (error as { stderr?: unknown })?.stderr
      // Accept only a parser's explicit refusal of one of our required flags.
      if (typeof stderr === "string" && /^(?:error: )?(?:unknown|unrecognized|unsupported) option ['"]?--(?:print|input-format|output-format)(?:['"\s]|$)/im.test(stderr)) {
        return "unsupported"
      }
      return "unknown"
    }
  })()
  headlessSupport.set(key, promise)
  forgetDeadlineKill(headlessSupport, key, promise, () => deadlineKill)
  return promise
}

/**
 * Probe whether the binary's own `--help` mentions a flag. For flags with no
 * published version marker (`--plugin-dir`), where an invented semver
 * threshold would be a guess. One `--help` spawn per cliPath+flag, cached for
 * the process lifetime unless our own deadline killed it, in which case the
 * next caller re-probes (`forgetDeadlineKill`: a timed-out probe would
 * otherwise turn the skill bridge off for the whole session). Any failure is
 * false, so the caller skips the flag rather than risking a parse error on
 * spawn. (From @broskees' 68ed142.)
 */
export function detectCliSupportsFlag(cliPath: string, flag: string): Promise<boolean> {
  const key = `${cliPath}\x00${flag}`
  const cached = flagSupport.get(key)
  if (cached) return cached
  let deadlineKill = false
  const promise = (async (): Promise<boolean> => {
    try {
      const execution = probeExec(cliPath, ["--help"], {
        timeout: probeTimeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
      })
      // A wrapper may wait for stdin EOF even when asked for help.
      execution.child.stdin?.end()
      const { stdout } = await execution
      return stdout.includes(flag)
    } catch (err) {
      deadlineKill = killedByDeadline(err)
      log.warn("failed to probe claude cli flag support", {
        cliPath,
        flag,
        error: err instanceof Error ? err.message : String(err),
        deadlineKill,
      })
      return false
    }
  })()
  flagSupport.set(key, promise)
  forgetDeadlineKill(flagSupport, key, promise, () => deadlineKill)
  return promise
}

export function _clearCache(): void {
  headlessSupport.clear()
  flagSupport.clear()
  cache.clear()
  deadlineReprobes.clear()
  probeTimeoutMs = PROBE_TIMEOUT_MS
}

/** Test-only: forget the consecutive-kill counts without dropping answers. */
export function _resetDeadlineReprobes(): void {
  deadlineReprobes.clear()
}

/** Test-only: a shorter deadline, so the cap can be exercised in milliseconds. */
export function _setProbeTimeoutMs(ms: number): void {
  probeTimeoutMs = ms
}
