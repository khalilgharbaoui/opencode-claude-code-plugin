import * as fs from "node:fs"
import * as path from "node:path"

/**
 * How this plugin starts `claude` on Windows.
 *
 * Until v0.46 every spawn of the CLI passed `shell: process.platform ===
 * "win32"`, which hands the whole command line to `cmd.exe` with NO quoting at
 * all: Node documents that `shell: true` means the caller owns the escaping,
 * and nothing here escaped anything. An argument containing `&`, `|`, `>`,
 * `<`, `^` or `(` ran as a second command, and an argument containing a space
 * or a quote simply arrived as several broken arguments. Every argument this
 * plugin passes is attacker-reachable in the ordinary sense: model ids and
 * `--settings` JSON come from config, `--append-system-prompt-file` and
 * `--mcp-config` are paths under a scratch dir, and `--add-dir` is the
 * workspace path.
 *
 * `shell: true` was there for a real reason: `claude` on Windows is normally
 * `claude.cmd`, an npm shim, and `CreateProcess` cannot run a `.cmd` at all.
 * So the fix is not to drop the shell, it is to resolve the command first and
 * then speak cmd.exe's language deliberately:
 *
 *   - resolve the command against PATH + PATHEXT ourselves, so we know what we
 *     are about to run rather than letting a shell guess,
 *   - a `.exe` / `.com` is spawned directly with `shell: false`, where Node's
 *     own `CommandLineToArgvW` quoting is correct and nothing parses `&`,
 *   - a `.cmd` / `.bat` goes through `cmd.exe /d /s /c` with every argument
 *     quoted for `CommandLineToArgvW` and then caret-escaped for cmd, with
 *     `windowsVerbatimArguments` so Node does not re-quote what we built.
 *
 * The escaping is the algorithm cross-spawn uses, reimplemented here rather
 * than taken as a dependency (AGENTS.md keeps the runtime dependency list at
 * two packages, and this is ~60 lines).
 *
 * ## The one hole that stays: `%`
 *
 * cmd.exe expands `%NAME%` during a parsing phase that runs BEFORE carets are
 * processed, so no escape sequence fully neutralises a percent sign. `^%` gets
 * most of the way (it breaks the variable-name lookup at the command-line
 * level), and a batch shim that forwards `%*` can expand a second time. An
 * argument containing `%` may therefore arrive with an environment variable
 * substituted into it. It cannot, however, inject a command: substitution
 * happens into a position that is already inside our caret-escaped quoting.
 * `test/windows-spawn.test.ts` pins the measured behaviour.
 *
 * Nothing in this module is platform-gated at import time: `planClaudeSpawn`
 * returns the command unchanged on every non-Windows platform, and every
 * helper is pure so the whole file is unit-tested on macOS and Linux too.
 */

/** What a caller passes to `spawn` / `execFile`. */
export interface SpawnPlan {
  file: string
  args: string[]
  /** Set only when we built the command line ourselves; Node must not re-quote it. */
  windowsVerbatimArguments?: boolean
}

export interface WindowsSpawnDeps {
  /** Defaults to `process.platform`. Injected so the plan is testable off Windows. */
  platform?: string
  /** Defaults to `process.env`. Read for PATH, PATHEXT and ComSpec. */
  env?: Record<string, string | undefined>
  /** Defaults to a real `statSync().isFile()`. Injected so resolution is testable. */
  isFile?: (candidate: string) => boolean
}

/** PATHEXT's own default, used when the variable is missing from the env. */
export const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD"

/**
 * The characters cmd.exe treats specially. `,` and `;` are in the set because
 * cmd also splits arguments on them, and `%` and `!` are in it so the escaper
 * does what it can about expansion even though it cannot win outright.
 */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const direct = env[name]
  if (direct !== undefined) return direct
  // Windows env vars are case-insensitive, and a plain object from a test (or
  // from a non-Windows process) is not.
  const match = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase())
  return match === undefined ? undefined : env[match]
}

function defaultIsFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

/** The executable extensions PATHEXT names, lowercased, `.`-prefixed. */
export function executableExtensions(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = envValue(env, "PATHEXT") ?? DEFAULT_PATHEXT
  return raw
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean)
    .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`))
}

/** True for the two extensions `CreateProcess` cannot run and cmd.exe must. */
export function isBatchFile(file: string): boolean {
  const ext = path.win32.extname(file).toLowerCase()
  return ext === ".cmd" || ext === ".bat"
}

/**
 * Find the real file a Windows command name refers to, searching PATH and
 * PATHEXT exactly as `where` does, and deliberately NOT searching the current
 * directory: `CreateProcess` does search it, and a `claude.exe` dropped into a
 * workspace should never win over the installed one.
 *
 * Returns null when nothing matches, so the caller can pass the original
 * string through and get a normal spawn error instead of a silent surprise.
 */
export function resolveWindowsCommand(
  command: string,
  deps: WindowsSpawnDeps = {},
): string | null {
  const env = deps.env ?? process.env
  const isFile = deps.isFile ?? defaultIsFile
  const extensions = executableExtensions(env)

  const candidatesFor = (base: string): string[] => {
    const ext = path.win32.extname(base).toLowerCase()
    // An explicit known extension is taken as written; anything else (no
    // extension, or something like `claude.js`) still gets the PATHEXT sweep,
    // because `claude.1.2` would otherwise look like it had an extension.
    if (ext && extensions.includes(ext)) return [base]
    return [...extensions.map((candidate) => base + candidate), base]
  }

  // A command with any separator in it is a path, not a PATH lookup. Windows
  // accepts both separators, so both count.
  if (command.includes("\\") || command.includes("/")) {
    for (const candidate of candidatesFor(command)) {
      if (isFile(candidate)) return candidate
    }
    return null
  }

  const pathValue = envValue(env, "PATH") ?? ""
  for (const entry of pathValue.split(path.win32.delimiter)) {
    // Windows PATH entries may be quoted; an empty entry means "current
    // directory", which this resolver deliberately does not honour.
    const directory = entry.trim().replace(/^"(.*)"$/, "$1")
    if (!directory) continue
    for (const candidate of candidatesFor(path.win32.join(directory, command))) {
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

/**
 * Quote one argument the way `CommandLineToArgvW` parses it back: always
 * wrapped in quotes, backslashes doubled only where they precede a quote or
 * end the argument, and every embedded quote backslash-escaped. The MSDN
 * algorithm, written out rather than compressed into a regex so the invariant
 * is readable.
 */
export function quoteWindowsArgument(arg: string): string {
  let out = '"'
  let backslashes = 0
  for (const char of arg) {
    if (char === "\\") {
      backslashes += 1
      continue
    }
    if (char === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    out += "\\".repeat(backslashes) + char
    backslashes = 0
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`
}

/**
 * Caret-escape the command's own path. The path is not quoted (cmd would then
 * need the quotes escaped too and nothing is gained): every metacharacter,
 * the space included, is carried by a caret instead.
 */
export function escapeCmdCommand(command: string): string {
  return path.win32.normalize(command).replace(CMD_META, "^$1")
}

/**
 * Quote an argument for the program, then caret-escape it for cmd.exe.
 *
 * `doubleEscape` is for the one case where the program being run is itself
 * cmd.exe, which strips a second layer. Nothing in this plugin runs cmd.exe
 * through cmd.exe, but the flag is here because leaving it out is the usual
 * way this function is got wrong.
 */
export function escapeCmdArgument(arg: string, doubleEscape = false): string {
  const quoted = quoteWindowsArgument(arg).replace(CMD_META, "^$1")
  return doubleEscape ? quoted.replace(CMD_META, "^$1") : quoted
}

/**
 * Build the `cmd.exe /d /s /c "..."` invocation for a batch file.
 *
 * `/d` skips AutoRun (a user's registry AutoRun command must not run inside
 * our spawn), `/s` makes cmd strip exactly the outer pair of quotes and treat
 * the rest verbatim, and `/c` runs and exits.
 */
export function planCmdInvocation(
  file: string,
  args: string[],
  env: Record<string, string | undefined> = process.env,
): SpawnPlan {
  const comspec = envValue(env, "ComSpec") ?? "cmd.exe"
  const doubleEscape = /^(?:.*[\\/])?cmd(?:\.exe)?$/i.test(file)
  const line = [escapeCmdCommand(file), ...args.map((arg) => escapeCmdArgument(arg, doubleEscape))]
  return {
    file: comspec,
    args: ["/d", "/s", "/c", `"${line.join(" ")}"`],
    windowsVerbatimArguments: true,
  }
}

/**
 * The one entry point callers use. On every platform but Windows it returns
 * the command untouched, so no POSIX behaviour changes and no POSIX test has
 * anything new to assert.
 */
export function planClaudeSpawn(
  command: string,
  args: string[],
  deps: WindowsSpawnDeps = {},
): SpawnPlan {
  const platform = deps.platform ?? process.platform
  if (platform !== "win32") return { file: command, args: [...args] }

  const env = deps.env ?? process.env
  const resolved = resolveWindowsCommand(command, deps) ?? command
  if (isBatchFile(resolved)) return planCmdInvocation(resolved, args, env)
  // A `.exe` (or an unresolvable name, which spawns and fails honestly) runs
  // with `shell: false`, where Node builds the command line itself.
  return { file: resolved, args: [...args] }
}
