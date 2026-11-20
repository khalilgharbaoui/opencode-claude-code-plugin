/**
 * The probe that lists Claude Code's own commands and skills, and the wiring
 * that offers them in opencode's `/` menu on both majors (h #g322). The pure
 * half (store, menu plan, short names) is `src/claude-commands.ts`.
 *
 * ## The probe, and why it costs nothing
 *
 * One short-lived `claude --print --input-format stream-json` per config dir
 * and folder, sent one control request, `initialize`, and never a message.
 * Measured on 2.1.322 with this Mac's `~/.claude`: 0.9 to 1.2 s, the answer's
 * `commands` rows (211, 47 flagged `builtin`, every enabled plugin's skills as
 * `plugin:name`), and zero API requests against a local server set as
 * `ANTHROPIC_BASE_URL` (a control `claude -p hi` made two).
 *
 * NOT `--bare`, which is what keeps the model probe (h #g279) free: `--bare`
 * skips plugins, so it cannot answer this. What it costs instead is hooks:
 * without `--bare`, `initialize` alone runs the operator's `SessionStart`
 * hooks (measured with a scratch config dir whose hook wrote a marker file,
 * and a plugin's SessionStart hook can start a background watcher). So the
 * probe passes `--settings {"disableAllHooks":true}`, measured to run none,
 * plus `--strict-mcp-config` (no MCP server is connected) and
 * `--no-session-persistence`. The env is the model probe's (`probeEnv`): the
 * hygiene vars filled and every Anthropic credential removed.
 *
 * ## When it runs, and where the answer goes
 *
 * In the background, once per config dir and folder per process, never
 * awaited: on opencode 1 from the `config` hook, on opencode 2 from each
 * location's `setup`. The answer goes to `claude-commands.json`
 * (`src/claude-commands.ts`); a probe killed by its deadline or refused
 * writes nothing. The menu is built from the store, and both TUIs read their
 * `/` menu when they start, so a command installed while opencode runs is
 * listed from the next start. Measured: opencode 1.19.4 reads its command list
 * once (an entry added to `config.command` three seconds after the hook never
 * appeared); on opencode 2.3.2 a changed answer calls `ctx.command.reload()`,
 * which re-lists the server's commands in the same process, but the TUI keeps
 * the menu it read at startup until opencode's own `/reload`, which also sets
 * the plugin up again and so asks the CLI again (a newly installed skill shows
 * after the second `/reload`). A typed command is resolved against the store
 * on every message, so it works as soon as a probe has seen it, on either
 * major: both pass a `/name` they do not know through as text (measured on
 * 1.19.4 and 2.3.2).
 */
import { spawn } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { createInterface } from "node:readline"
import { accountConfigDirPath, DEFAULT_ACCOUNT, resolveAccounts } from "./accounts.js"
import {
  type ClaudeCommand,
  type ClaudeMenuPlan,
  cliCommandsFor,
  commandsFromInitialize,
  planClaudeMenu,
  readCommandEntries,
  writeCommandEntry,
} from "./claude-commands.js"
import { probeEnv } from "./cli-model-catalog.js"
import { log } from "./logger.js"
import { claudeConfigDir } from "./skill-bridge.js"
import { planClaudeSpawn } from "./windows-spawn.js"

/** The env seam the test script sets to `0`, and an operator's off switch for the environment. */
export const CLAUDE_COMMAND_PROBE_ENV = "OPENCODE_CLAUDE_CODE_COMMAND_PROBE"

/** How long one probe may take before it is killed and nothing is written. */
export const CLAUDE_COMMAND_PROBE_DEADLINE_MS = 20_000

/** Whether the `claudeCommands` provider option is on. Default true. */
export function claudeCommandsEnabled(settings: Record<string, unknown> | undefined): boolean {
  return settings?.claudeCommands !== false
}

function probeEnabledByEnv(): boolean {
  const value = process.env[CLAUDE_COMMAND_PROBE_ENV]
  return value === undefined || (value !== "0" && value.toLowerCase() !== "false")
}

/** One config dir to ask: the binary, the dir it reads, and what to export for it. */
export interface CommandProbeTarget {
  cliPath: string
  /** Resolved: what the CLI reads, `~/.claude` for the default login. */
  configDir: string
  /** `CLAUDE_CONFIG_DIR` for a configured account; unset for the default login. */
  exportConfigDir?: string
}

/**
 * The config dirs this install's providers spawn `claude` with: one per
 * configured account, or the default login alone. The base binary, never an
 * account's wrapper: the wrapper only exports the account's config dir, which
 * is done here directly, on every platform.
 */
export function claudeCommandTargets(settings: Record<string, unknown> | undefined): CommandProbeTarget[] {
  const base =
    (typeof settings?.baseCliPath === "string" && settings.baseCliPath) ||
    (typeof settings?.cliPath === "string" && settings.cliPath) ||
    "claude"
  const accounts = resolveAccounts(settings?.accounts) ?? [DEFAULT_ACCOUNT]
  const seen = new Set<string>()
  const targets: CommandProbeTarget[] = []
  for (const account of accounts) {
    const exported = accountConfigDirPath(account)
    const configDir = claudeConfigDir(exported)
    if (!configDir || seen.has(configDir)) continue
    seen.add(configDir)
    targets.push({ cliPath: base, configDir, ...(exported ? { exportConfigDir: exported } : {}) })
  }
  return targets
}

/** The argv of one probe. Exported for the tests, which assert it. */
export function claudeCommandProbeArgs(): string[] {
  return [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
  ]
}

export type CommandProbeAnswer =
  | { ok: true; commands: ClaudeCommand[]; cliVersion?: string; ms: number }
  | { ok: false; reason: string; ms: number }

/** Ask one config dir in one folder. Never throws. */
export function probeClaudeCommands(
  target: CommandProbeTarget,
  cwd: string,
  deadlineMs: number = CLAUDE_COMMAND_PROBE_DEADLINE_MS,
): Promise<CommandProbeAnswer> {
  const started = Date.now()
  return new Promise((done) => {
    let settled = false
    let deadline = false
    let answer: CommandProbeAnswer | null = null
    const finish = (result: CommandProbeAnswer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(result)
    }
    const env = probeEnv()
    if (target.exportConfigDir) env.CLAUDE_CONFIG_DIR = target.exportConfigDir
    const plan = planClaudeSpawn(target.cliPath, claudeCommandProbeArgs())
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(plan.file, plan.args, {
        cwd,
        stdio: ["pipe", "pipe", "ignore"],
        env,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
      })
    } catch {
      finish({ ok: false, reason: "spawn-failed", ms: Date.now() - started })
      return
    }
    const timer = setTimeout(() => {
      deadline = true
      child.kill("SIGKILL")
    }, deadlineMs)
    timer.unref?.()
    child.stdin?.on("error", () => undefined)
    child.on("error", () => finish({ ok: false, reason: "spawn-failed", ms: Date.now() - started }))
    const lines = createInterface({ input: child.stdout! })
    lines.on("line", (line) => {
      if (!line.includes('"control_response"')) return
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      const response = (message as { type?: unknown; response?: Record<string, unknown> } | null)
      if (response?.type !== "control_response" || !response.response) return
      const body = response.response
      if (body.request_id !== "init") return
      if (body.subtype !== "success") {
        answer = { ok: false, reason: "request-refused", ms: Date.now() - started }
      } else {
        const init = body.response as Record<string, unknown> | undefined
        const commands = commandsFromInitialize(init)
        const version = typeof init?.claude_code_version === "string" ? init.claude_code_version : undefined
        answer = commands
          ? {
              ok: true,
              commands,
              ...(version && /^\d+\.\d+\.\d+$/.test(version) ? { cliVersion: version } : {}),
              ms: Date.now() - started,
            }
          : { ok: false, reason: "no-command-list", ms: Date.now() - started }
      }
      child.stdin?.end()
    })
    child.on("close", () => {
      if (answer) finish(answer)
      else finish({ ok: false, reason: deadline ? "deadline" : "no-answer", ms: Date.now() - started })
    })
    try {
      child.stdin?.write(
        `${JSON.stringify({ type: "control_request", request_id: "init", request: { subtype: "initialize" } })}\n`,
      )
    } catch {
      // The close handler reports it.
    }
  })
}

export type CommandRefreshResult =
  | { status: "skipped"; reason: string }
  | { status: "done"; probed: number; failed: string[]; changed: boolean; ms: number }

const refreshes = new Map<string, Promise<CommandRefreshResult>>()

function sameCommands(a: readonly ClaudeCommand[] | null, b: readonly ClaudeCommand[]): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b)
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

/**
 * Ask every target in `cwd` and store the answers. Once per (binary, config
 * dir, folder) per process, never throws, never awaited by registration.
 * `onChanged` runs after an answer that differs from what the store held,
 * which is where opencode 2 reloads its commands. A config dir that does not
 * exist is skipped rather than created.
 */
export function refreshClaudeCommands(
  settings: Record<string, unknown> | undefined,
  cwd: string,
  hooks: { onChanged?: () => unknown; deadlineMs?: number } = {},
): Promise<CommandRefreshResult> {
  if (!claudeCommandsEnabled(settings)) return Promise.resolve({ status: "skipped", reason: "option-off" })
  if (!probeEnabledByEnv()) return Promise.resolve({ status: "skipped", reason: "env-off" })
  const folder = resolve(cwd)
  if (!isDirectory(folder)) return Promise.resolve({ status: "skipped", reason: "no-folder" })
  const targets = claudeCommandTargets(settings).filter((target) => existsSync(target.configDir))
  if (targets.length === 0) return Promise.resolve({ status: "skipped", reason: "no-config-dir" })
  const key = JSON.stringify([folder, targets.map((target) => [target.cliPath, target.configDir])])
  const running = refreshes.get(key)
  if (running) return running
  const run = (async (): Promise<CommandRefreshResult> => {
    const started = Date.now()
    const failed: string[] = []
    let changed = false
    let probed = 0
    let listed = 0
    for (const target of targets) {
      const answer = await probeClaudeCommands(target, folder, hooks.deadlineMs)
      probed++
      if (!answer.ok) {
        failed.push(answer.reason)
        continue
      }
      listed += answer.commands.filter((command) => !command.builtin).length
      const before = cliCommandsForExactly(target.configDir, folder)
      writeCommandEntry({
        configDir: target.configDir,
        cwd: folder,
        probedAt: Date.now(),
        ...(answer.cliVersion ? { cliVersion: answer.cliVersion } : {}),
        commands: answer.commands,
      })
      if (!sameCommands(before, answer.commands)) changed = true
    }
    log.info("read claude code's own commands from the cli", {
      configDirs: targets.length,
      listed,
      failed,
      changed,
      ms: Date.now() - started,
    })
    if (changed && hooks.onChanged) {
      try {
        await hooks.onChanged()
      } catch (error) {
        log.debug("reloading commands after the claude code command probe failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { status: "done", probed, failed, changed, ms: Date.now() - started }
  })().catch(
    (error): CommandRefreshResult => ({
      status: "done",
      probed: 0,
      failed: [error instanceof Error ? error.message.slice(0, 80) : "unexpected"],
      changed: false,
      ms: 0,
    }),
  )
  refreshes.set(key, run)
  return run
}

/** The stored answer for exactly this config dir and folder, not an ancestor's. */
function cliCommandsForExactly(configDir: string, folder: string): ClaudeCommand[] | null {
  const dir = resolve(configDir)
  const entry = readCommandEntries().find((candidate) => resolve(candidate.configDir) === dir && resolve(candidate.cwd) === folder)
  return entry ? entry.commands : null
}

/**
 * The menu for the providers `settings` describes, in `cwd`, from the store.
 * Synchronous and never throws, because neither major's registration may wait
 * for a probe. Every config dir's list is merged: a command one account lists
 * is offered once.
 */
export function claudeMenuFor(
  settings: Record<string, unknown> | undefined,
  cwd: string,
  opencodeNames: ReadonlySet<string>,
): ClaudeMenuPlan {
  if (!claudeCommandsEnabled(settings)) return { entries: [], taken: [] }
  const commands: ClaudeCommand[] = []
  try {
    for (const target of claudeCommandTargets(settings)) {
      commands.push(...(cliCommandsFor(target.configDir, cwd) ?? []))
    }
  } catch {
    return { entries: [], taken: [] }
  }
  return planClaudeMenu(commands, opencodeNames)
}

const loggedMenus = new Set<string>()

/** One INFO per distinct menu per process, naming how many were left to opencode. */
export function logClaudeMenu(plan: ClaudeMenuPlan, host: "v1" | "v2"): void {
  const key = `${host}:${plan.entries.length}:${plan.taken.join(",")}`
  if (loggedMenus.has(key)) return
  loggedMenus.add(key)
  log.info("listed claude code's own commands in opencode's / menu", {
    host,
    listed: plan.entries.length,
    leftToOpencode: plan.taken.length,
  })
}

export function _resetClaudeCommandProbeForTests(): void {
  refreshes.clear()
  loggedMenus.clear()
}
