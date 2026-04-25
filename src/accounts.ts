import { chmod, lstat, mkdir, readlink, symlink, writeFile } from "node:fs/promises"
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

export function accountDisplayName(account: string): string {
  return `Claude Code (${titleizeAccount(account)})`
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

export function expandHome(value: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE

  if (value === "~") return home ?? value

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return home ? path.join(home, value.slice(2)) : value
  }

  return value
}

export async function ensureAccountRuntime(
  account: string,
  baseCliPath: string,
): Promise<{ cliPath: string; configDir?: string }> {
  const configDir = accountConfigDir(account)

  if (!configDir) return { cliPath: baseCliPath }

  const expandedConfigDir = expandHome(configDir)
  await mkdir(expandedConfigDir, { recursive: true })
  await ensureSharedCapabilities(expandedConfigDir)

  const cliPath = await writeAccountWrapper(
    normalizeAccountName(account),
    baseCliPath,
    expandedConfigDir,
  )

  return { cliPath, configDir }
}

async function ensureSharedCapabilities(targetRoot: string): Promise<void> {
  const sourceRoot = expandHome("~/.claude")

  for (const item of SHARED_CAPABILITY_ITEMS) {
    await ensureSharedCapabilityItem(sourceRoot, targetRoot, item)
  }
}

async function ensureSharedCapabilityItem(
  sourceRoot: string,
  targetRoot: string,
  item: string,
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

  const type = sourceStat.isDirectory()
    ? process.platform === "win32"
      ? "junction"
      : "dir"
    : "file"

  await symlink(source, target, type)
}

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
exec ${shellSingleQuote(baseCliPath)} "\${args[@]}"
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
