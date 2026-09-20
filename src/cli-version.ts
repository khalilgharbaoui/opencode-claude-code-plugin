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

/**
 * Env vars set on every `claude` child so the binary we detected stays the
 * binary we run.
 *
 * `detectCliVersion` resolves once per cliPath and caches that answer for the
 * life of the opencode process, and several flags are gated on it:
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
 */
export function detectCliVersion(cliPath: string): Promise<CliVersion | null> {
  const cached = cache.get(cliPath)
  if (cached) return cached
  const promise = (async (): Promise<CliVersion | null> => {
    try {
      const { stdout } = await execFileAsync(cliPath, ["--version"], {
        timeout: 5000,
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
      log.warn("failed to detect claude cli version", {
        cliPath,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  })()
  cache.set(cliPath, promise)
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
 * the process lifetime. Any failure is false, so the caller skips the flag
 * rather than risking a parse error on spawn. (From @broskees' 68ed142.)
 */
export function detectCliSupportsFlag(cliPath: string, flag: string): Promise<boolean> {
  const key = `${cliPath}\x00${flag}`
  const cached = flagSupport.get(key)
  if (cached) return cached
  const promise = (async (): Promise<boolean> => {
    try {
      const execution = execFileAsync(cliPath, ["--help"], {
        timeout: 5000,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
      })
      // A wrapper may wait for stdin EOF even when asked for help.
      execution.child.stdin?.end()
      const { stdout } = await execution
      return stdout.includes(flag)
    } catch (err) {
      log.warn("failed to probe claude cli flag support", {
        cliPath,
        flag,
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  })()
  flagSupport.set(key, promise)
  return promise
}

export function _clearCache(): void {
  flagSupport.clear()
  cache.clear()
}
