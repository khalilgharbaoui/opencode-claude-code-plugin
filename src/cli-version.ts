import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { log } from "./logger.js"

const execFileAsync = promisify(execFile)

export interface CliVersion {
  major: number
  minor: number
  patch: number
  raw: string
}

const cache = new Map<string, Promise<CliVersion | null>>()

/** How long a probe spawn may take before we stop waiting for it. */
const PROBE_TIMEOUT_MS = 5000

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
 * copies of `test-side-question.ts`: 6 of 40 `claude --version` probes were
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
    if (killed() && entries.get(key) === probe) entries.delete(key)
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
      const { stdout } = await execFileAsync(cliPath, ["--version"], {
        timeout: PROBE_TIMEOUT_MS,
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
      const execution = execFileAsync(cliPath, ["--help"], {
        timeout: PROBE_TIMEOUT_MS,
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
  flagSupport.clear()
  cache.clear()
}
