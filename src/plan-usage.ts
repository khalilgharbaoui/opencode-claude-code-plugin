import { execFile } from "node:child_process"
import { log } from "./logger.js"

/**
 * The Claude CLI's own plan-usage report, read for `/claude-code-doctor`.
 *
 * `/cost` (canonical name `/usage`, aliases `cost` and `stats`) exists in two
 * definitions in the 2.1.280 bundle: a `local-jsx` one with `requires:{ink:true}`
 * for the TUI, and a `local` one with `supportsNonInteractive:true` whose
 * `isEnabled` is `!isInteractive()`. So the headless variant is enabled exactly
 * where the plugin runs, and measured on 2.1.280 it is genuinely free:
 * `claude -p /cost --output-format json` answered in 371 ms with
 * `num_turns: 0`, `duration_api_ms: 0`, `total_cost_usd: 0` and every usage
 * counter at zero. No API call happens; the CLI answers it locally.
 *
 * It is still opt-in, as `/claude-code-doctor usage`, for one reason that is not
 * about tokens: a spawn runs the user's `SessionStart` hooks, which on the
 * machine this was measured on took the wall time from 371 ms to 4.6 s. The
 * doctor's default answer stays as fast as it was. `--bare` would skip the
 * hooks but never reads OAuth, so it reports nothing about a subscription and
 * is useless here.
 *
 * Nothing secret goes in the report, following the same rule as the rest of
 * `doctor.ts`: this is the CLI's own prose about plan windows and reset times,
 * quoted rather than reinterpreted, and no credential is ever part of it.
 */

/** The argument that asks for it: `/claude-code-doctor usage`. */
export const PLAN_USAGE_ARGUMENTS = new Set(["usage", "cost", "stats", "limits"])

export function wantsPlanUsage(argument: string): boolean {
  return PLAN_USAGE_ARGUMENTS.has(argument.trim().toLowerCase())
}

/** How the doctor renders it: the text, or why there is none. */
export type PlanUsage =
  | { status: "ok"; text: string; costUsd: number; numTurns: number }
  | { status: "failed"; error: string }
  | { status: "not-requested" }

/**
 * Longest prose kept. The measured reply was about 1.3 KB; the cap is there so
 * a future CLI that decides to print a year of history cannot turn the doctor
 * report into a wall.
 */
export const PLAN_USAGE_MAX_CHARS = 4000

function truncate(text: string): string {
  return text.length <= PLAN_USAGE_MAX_CHARS
    ? text
    : `${text.slice(0, PLAN_USAGE_MAX_CHARS)}\n[truncated]`
}

/**
 * Pull the answer out of `--output-format json`.
 *
 * Parsed defensively for the same reason every parser in `cli-events.ts` is: a
 * diagnostic that throws is worse than one that stays quiet. The only thing
 * asserted is that a `result` object with string `result` text came back, and
 * `is_error` is honoured. `local_command` is read when present (`"cost"` on the
 * measured reply) but not required, because it is an `@internal` field and a
 * rename must not cost the whole section.
 */
export function parsePlanUsage(stdout: string): PlanUsage {
  const trimmed = stdout.trim()
  if (!trimmed) return { status: "failed", error: "the CLI printed nothing" }
  // Tolerate leading non-JSON noise by trying whole lines from the end: the
  // result object is the last thing printed.
  const candidates = trimmed.split("\n").reverse()
  for (const line of candidates) {
    const start = line.indexOf("{")
    if (start === -1) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line.slice(start))
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue
    const record = parsed as Record<string, unknown>
    if (record.type !== undefined && record.type !== "result") continue
    const text = typeof record.result === "string" ? record.result.trim() : ""
    if (record.is_error === true) {
      return { status: "failed", error: text || "the CLI reported an error" }
    }
    if (!text) continue
    return {
      status: "ok",
      text: truncate(text),
      costUsd: typeof record.total_cost_usd === "number" ? record.total_cost_usd : 0,
      numTurns: typeof record.num_turns === "number" ? record.num_turns : 0,
    }
  }
  return { status: "failed", error: "no result object in the CLI's reply" }
}

export interface FetchPlanUsageOptions {
  timeoutMs?: number
  /** Seam for tests; defaults to spawning the real CLI. */
  runImpl?: (cliPath: string, args: string[], timeoutMs: number) => Promise<string>
}

function runCli(cliPath: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cliPath,
      args,
      // `killSignal` so a CLI wedged on a hook is actually gone, and a generous
      // buffer because the reply is prose of unbounded length.
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        // A non-zero exit that still printed a result is usable, so stdout wins
        // over the exit code and only an empty failure rejects.
        if (stdout && stdout.trim()) return resolve(stdout)
        if (error) return reject(error)
        resolve(stdout ?? "")
      },
    )
  })
}

/**
 * Ask the CLI for the plan picture. Never throws: a failure is a `failed` row
 * in the report, because a doctor that dies on its newest section is worse than
 * one that prints most of it.
 */
export async function fetchPlanUsage(
  cliPath: string,
  options: FetchPlanUsageOptions = {},
): Promise<PlanUsage> {
  const timeoutMs = options.timeoutMs ?? 20_000
  const run = options.runImpl ?? runCli
  try {
    const stdout = await run(cliPath, ["-p", "/cost", "--output-format", "json"], timeoutMs)
    const usage = parsePlanUsage(stdout)
    if (usage.status === "ok") {
      log.info("read claude plan usage", { costUsd: usage.costUsd, numTurns: usage.numTurns })
    } else if (usage.status === "failed") {
      log.debug("could not read claude plan usage", { error: usage.error })
    }
    return usage
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.debug("could not read claude plan usage", { error: message })
    return { status: "failed", error: message }
  }
}
