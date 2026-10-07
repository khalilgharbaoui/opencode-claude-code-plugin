import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import { log } from "./logger.js"

export const BASE_PROVIDER_ID = "claude-code"
export const DEFAULT_ACCOUNT = "default"

const SHARED_CAPABILITY_ITEMS = [
  "CLAUDE.md",
  "settings.json",
  "skills",
  "agents",
  "commands",
  "plugins",
]

export function normalizeAccountName(account: string): string {
  return account
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function resolveAccounts(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null

  const accounts = value
    .map((account) => normalizeAccountName(String(account)))
    .filter(Boolean)

  return Array.from(new Set([DEFAULT_ACCOUNT, ...accounts]))
}

export function accountProviderId(account: string): string {
  return `${BASE_PROVIDER_ID}-${normalizeAccountName(account)}`
}

export function accountDisplayName(account: string, tier?: string): string {
  const name = titleizeAccount(account)
  // `Claude Code (Work, Max 20x)`. The tier is omitted whenever it cannot be
  // read, so an account the plugin knows nothing about is named exactly as it
  // always was. See `src/account-tier.ts` for where it comes from and for the
  // fields that must never reach here.
  return `Claude Code (${tier ? `${name}, ${tier}` : name})`
}

export function accountModelSuffix(account: string): string | undefined {
  const normalized = normalizeAccountName(account)
  return normalized === DEFAULT_ACCOUNT ? undefined : normalized
}

export function accountConfigDir(account: string): string | undefined {
  const normalized = normalizeAccountName(account)

  if (!normalized || normalized === DEFAULT_ACCOUNT) return undefined

  return `~/.claude-${normalized}`
}

/**
 * Absolute `CLAUDE_CONFIG_DIR` for an account, or undefined for the default
 * account, which leaves the CLI on its own `~/.claude`. Used where a caller
 * needs to know what the *spawn* will read (skills, plugins) rather than to
 * set the variable itself.
 */
export function accountConfigDirPath(account: string): string | undefined {
  const dir = accountConfigDir(account)
  return dir ? expandHome(dir) : undefined
}

export function expandHome(value: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE

  if (value === "~") return home ?? value

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return home ? path.join(home, value.slice(2)) : value
  }

  return value
}

/**
 * What a spawn needs to run as one account.
 *
 * On POSIX `cliPath` is the generated wrapper script and it does everything:
 * the caller spawns it and the account is applied inside. On Windows there is
 * no script (see `writeAccountWrapper`), so `cliPath` is the base CLI and
 * `accountInProcess` tells the caller it owns the two jobs the wrapper would
 * have done: export `CLAUDE_CONFIG_DIR` and take the `@<account>` marker off
 * the `--model` value.
 */
export interface AccountRuntime {
  cliPath: string
  configDir?: string
  /** See `AccountRuntime`. Set on Windows only, and never for `default`. */
  accountInProcess?: boolean
}

export interface AccountRuntimeDeps {
  /** Defaults to `process.platform`. Injected so the plan is testable off Windows. */
  platform?: string
}

export async function ensureAccountRuntime(
  account: string,
  baseCliPath: string,
  deps: AccountRuntimeDeps = {},
): Promise<AccountRuntime> {
  const platform = deps.platform ?? process.platform
  const configDir = accountConfigDir(account)

  if (!configDir) return { cliPath: baseCliPath }

  const expandedConfigDir = expandHome(configDir)
  await mkdir(expandedConfigDir, { recursive: true })

  try {
    await ensureSharedCapabilities(expandedConfigDir, platform)
  } catch (err) {
    log.warn("failed to symlink shared capabilities; continuing anyway", {
      account,
      configDir: expandedConfigDir,
      error: String(err),
    })
  }

  // Windows gets no wrapper at all, and that is the safe answer rather than
  // the lazy one (h #g221). A `.cmd` twin of the bash script would have to
  // forward its arguments with `%*`, which is a THIRD cmd.exe parse on top of
  // the two `quoteBatchArgument` is proven against (our `cmd /c` line, then
  // the npm `claude.cmd` shim's own `%*`), and it would have to re-quote the
  // one argument it rewrites, in batch, where there is no reliable quoter.
  // Everything the wrapper does is two lines of JavaScript, so it is done
  // here instead of in a language that was measured injectable (h #g217).
  if (platform === "win32") {
    return {
      cliPath: baseCliPath,
      configDir: expandedConfigDir,
      accountInProcess: true,
    }
  }

  const cliPath = await writeAccountWrapper(
    normalizeAccountName(account),
    baseCliPath,
    expandedConfigDir,
  )

  return { cliPath, configDir: expandedConfigDir }
}

async function ensureSharedCapabilities(
  targetRoot: string,
  platform: string,
): Promise<void> {
  const sourceRoot = expandHome("~/.claude")

  for (const item of SHARED_CAPABILITY_ITEMS) {
    // One capability that cannot be shared must not cost the others theirs.
    // On Windows a file symlink needs Developer Mode or an elevated process,
    // so `CLAUDE.md` failing is the ordinary case and `skills` has nothing to
    // do with it.
    try {
      await ensureSharedCapabilityItem(sourceRoot, targetRoot, item, platform)
    } catch (err) {
      log.warn("could not share a Claude capability with the account", {
        item,
        target: path.join(targetRoot, item),
        error: String(err),
      })
    }
  }
}

async function ensureSharedCapabilityItem(
  sourceRoot: string,
  targetRoot: string,
  item: string,
  platform: string,
): Promise<void> {
  const source = path.join(sourceRoot, item)
  const target = path.join(targetRoot, item)

  let sourceStat
  try {
    sourceStat = await lstat(source)
  } catch {
    return
  }

  try {
    const targetStat = await lstat(target)

    if (targetStat.isSymbolicLink()) {
      const current = await readlink(target)
      const resolvedCurrent = path.resolve(path.dirname(target), current)
      const resolvedSource = path.resolve(source)

      if (resolvedCurrent === resolvedSource) return
    }

    log.warn("shared Claude capability already exists; leaving untouched", {
      item,
      target,
      source,
    })

    return
  } catch {
    // Missing target is expected.
  }

  if (sourceStat.isDirectory()) {
    // A junction is the one Windows link an unprivileged process may always
    // create, and it behaves like a directory symlink for everything the CLI
    // does with these trees.
    await symlink(source, target, platform === "win32" ? "junction" : "dir")
    return
  }

  if (platform !== "win32") {
    await symlink(source, target, "file")
    return
  }

  // A FILE link on Windows is the privileged one. A hard link is the next
  // best thing and needs no privilege on NTFS: the account dir and `~/.claude`
  // are the same bytes, so an in-place edit to either is seen by both. An
  // editor that writes a replacement file instead breaks the link, which is
  // why the copy below is last rather than first: it is a point-in-time
  // snapshot and silently goes stale.
  try {
    await symlink(source, target, "file")
    return
  } catch {
    // Developer Mode is off, or the volume refuses symlinks.
  }
  try {
    await link(source, target)
    return
  } catch {
    // Different volume, or a filesystem with no hard links.
  }
  await copyFile(source, target)
  log.warn(
    "copied a shared Claude capability into the account config dir instead of linking it; later edits to the original will not be picked up",
    { item, target },
  )
}

/**
 * The POSIX half of `ensureAccountRuntime`: a bash script that exports the
 * account's `CLAUDE_CONFIG_DIR`, strips the `@<account>` marker off the
 * `--model` value and execs the base CLI with everything else untouched.
 *
 * Deliberately not ported to Windows. See the `win32` branch above for why a
 * `.cmd` twin is the wrong shape there, and `src/windows-spawn.ts` for what
 * cmd.exe does to an argument that is parsed twice.
 */
async function writeAccountWrapper(
  account: string,
  baseCliPath: string,
  configDir: string,
): Promise<string> {
  const cacheRoot = path.join(
    process.env.XDG_CACHE_HOME ?? expandHome("~/.cache"),
    "opencode-claude-code-plugin",
  )
  const wrapperPath = path.join(cacheRoot, `claude-${account}`)
  const suffix = `@${account}`

  await mkdir(cacheRoot, { recursive: true })

  const script = `#!/usr/bin/env bash
set -euo pipefail

args=()
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--model" && $# -ge 2 ]]; then
    model="$2"
    if [[ "$model" == *${shellDoubleQuote(suffix)} ]]; then
      model="\${model%${shellDoubleQuote(suffix)}}"
    fi
    args+=("$1" "$model")
    shift 2
  else
    args+=("$1")
    shift
  fi
done

export CLAUDE_CONFIG_DIR=${shellSingleQuote(configDir)}
# \${args[@]+...} keeps an empty array legal under \`set -u\` on bash 3.2,
# which is the bash macOS ships and \`/usr/bin/env bash\` usually finds.
exec ${shellSingleQuote(baseCliPath)} \${args[@]+"\${args[@]}"}
`

  await writeFile(wrapperPath, script, "utf8")
  await chmod(wrapperPath, 0o755)

  return wrapperPath
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function shellDoubleQuote(value: string): string {
  return value.replace(/[$`"\\]/g, "\\$&")
}

function titleizeAccount(account: string): string {
  return normalizeAccountName(account)
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}
