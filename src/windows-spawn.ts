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
 *   - a `.cmd` / `.bat` goes through `cmd.exe /d /s /c` with the command path
 *     quoted and every argument quoted by `quoteBatchArgument`, with
 *     `windowsVerbatimArguments` so Node does not re-quote what we built.
 *
 * `quoteBatchArgument` carries the reasoning that matters: a batch shim
 * forwards `%*`, so cmd parses the line twice, and caret escaping (cross-spawn's
 * answer, and this module's first one) does not survive the second parse. The
 * quoting that does is the one Rust adopted for `.bat` after CVE-2024-27980,
 * and it is ~25 lines, which is why nothing is taken as a dependency here
 * (AGENTS.md keeps the runtime dependency list at two packages).
 *
 * ## The one hole that stays: `%`
 *
 * cmd.exe expands `%NAME%` in a parsing phase that runs before anything else
 * is considered, and no escape sequence neutralises it: `^%` would arrive as a
 * literal caret inside our quoting, and `%%` is a batch-file-only escape. An
 * argument containing `%` may therefore arrive with an environment variable
 * substituted into it. It cannot inject a command, because the substitution
 * lands inside quotes cmd has already opened. `test/windows-spawn.test.ts`
 * measures it on a real shim.
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
 *
 * This is what a `.exe` needs, and Node already does it for a direct spawn. It
 * is here because it is the oracle the batch quoting below is checked against,
 * and because it is the half of the problem most people stop at.
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
 * Quote one argument for a BATCH file, which is a harder problem than quoting
 * it for a program, and the place the obvious answer is wrong.
 *
 * A batch shim (every npm-installed `claude.cmd` is one) forwards its
 * arguments with `%*`, and cmd parses the resulting line a SECOND time before
 * the real program ever sees it. Caret-escaping, which is what cross-spawn
 * emits and what the first version of this module emitted, does not survive
 * that: the carets are consumed by the first parse, so the second parse sees
 * `"x\" & echo pwned"`, and cmd has no backslash escape, so the `\"` closes
 * the quote and the `&` starts a command. Measured on windows-latest: it
 * created the file. That is CVE-2024-27980's shape, and the reason Node
 * refuses to spawn a `.bat` without a shell at all.
 *
 * What does survive both parses is quoting with doubled quotes. Wrap the
 * argument in `"`, write an embedded quote as `""`, and double the
 * backslashes that run into one. Then:
 *
 *   - cmd keeps its quote state balanced through `""`, so every `&`, `|`,
 *     `>`, `<`, `(` and `^` in the argument stays inside quotes, where cmd
 *     treats it as ordinary text, on BOTH passes. No caret is needed, and
 *     emitting one would arrive as a literal caret in the value.
 *   - `CommandLineToArgvW` reads `""` while inside a quoted string as one
 *     literal quote, and `2n` backslashes before it as `n` literal
 *     backslashes, so the program gets the argument back exactly.
 *
 * This is the algorithm Rust adopted for `.bat` targets after the same CVE.
 *
 * Throws on a carriage return or newline: cmd ends the command line there, so
 * the argument cannot be carried at all and the failure would otherwise be a
 * silent truncation. Nothing this plugin passes contains one.
 */
export function quoteBatchArgument(arg: string): string {
  if (/[\r\n]/.test(arg)) {
    throw new Error("cmd.exe cannot carry a newline in an argument")
  }
  let out = '"'
  let backslashes = 0
  for (const char of arg) {
    if (char === "\\") {
      backslashes += 1
      continue
    }
    if (char === '"') {
      // 2n backslashes leave the quote "special", and the doubled quote is
      // then the literal one, which keeps cmd's quote state where it was.
      out += "\\".repeat(backslashes * 2) + '""'
      backslashes = 0
      continue
    }
    out += "\\".repeat(backslashes) + char
    backslashes = 0
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`
}

/**
 * Build the `cmd.exe /d /s /c "..."` invocation for a batch file.
 *
 * `/d` skips AutoRun, so a user's registry AutoRun command does not run inside
 * our spawn. `/s` makes cmd strip exactly the outer pair of quotes and take
 * the rest as written, which is what lets the command path simply be quoted
 * (a Windows path cannot contain a quote, so nothing inside it needs escaping)
 * rather than caret-escaped character by character.
 */
export function planCmdInvocation(
  file: string,
  args: string[],
  env: Record<string, string | undefined> = process.env,
): SpawnPlan {
  const comspec = envValue(env, "ComSpec") ?? "cmd.exe"
  const line = [`"${path.win32.normalize(file)}"`, ...args.map(quoteBatchArgument)]
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
