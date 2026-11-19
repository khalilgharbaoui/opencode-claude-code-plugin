/**
 * Claude Code's own commands and skills as the installed CLI lists them, kept
 * in a file, offered in opencode's `/` menu and used to send a typed command
 * the way Claude Code accepts it (h #g322).
 *
 * ## Where the list comes from
 *
 * The CLI's own `initialize` answer, read by a free probe
 * (`src/claude-command-probe.ts`): its `commands` rows name every command and
 * skill the CLI would offer in that folder under that config dir (the
 * operator's, the project's on the CLI's own walk, every ENABLED plugin's as
 * `plugin:name`, synced and managed ones) and flag the CLI's built-ins with
 * `builtin: true`. Reading the same from disk would mean re-implementing how
 * the CLI merges `enabledPlugins` over five settings scopes, reads
 * `installed_plugins.json` and each plugin's manifest paths, and where it
 * keeps synced skills, all of it undocumented and free to change. Measured on
 * 2.1.322: 211 rows for `~/.claude`, 47 built-in, 41 colon names, the project's
 * `.claude/commands/hello-probe.md` among them as `hello-probe`.
 *
 * This module is the pure half: the store, the parsing, the menu plan and the
 * short-name rule. It imports nothing that logs, so `src/user-commands.ts`
 * (which imports it) keeps that property.
 *
 * ## The store
 *
 * `claude-commands.json` under `$XDG_STATE_HOME/opencode-claude-code-plugin`,
 * one entry per (config dir, folder), the other stores' discipline:
 * merge-on-write, atomic rename, `0600` in the `0700` directory, bounded, and a
 * missing or broken file is an empty store. A command keeps its name, a
 * description capped at `MAX_DESCRIPTION_CHARS` and its built-in flag, nothing
 * else: the `initialize` answer also carries the account's email and
 * organization, which are never read.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve, sep } from "node:path"

/** One command or skill as the CLI lists it. */
export interface ClaudeCommand {
  /** What follows the slash: `hello-probe`, `stripe:test-cards`. */
  name: string
  description?: string
  /** One of the CLI's own commands (`/model`, `/compact`): never offered or rewritten. */
  builtin?: true
}

/** What one probe of one config dir in one folder said. */
export interface ClaudeCommandEntry {
  /** The config dir the CLI read, resolved (`~/.claude` for the default login). */
  configDir: string
  /** The folder it was asked in, resolved. */
  cwd: string
  probedAt: number
  cliVersion?: string
  commands: ClaudeCommand[]
}

/** Entries remembered at once: config dirs times folders the operator opens. */
export const MAX_COMMAND_ENTRIES = 32

/** Rows kept per entry. 2.1.322 listed 211 on a machine with six plugins. */
export const MAX_COMMANDS_PER_ENTRY = 600

/** A description longer than this is cut: the menu shows about fifty characters. */
export const MAX_DESCRIPTION_CHARS = 240

/**
 * A name opencode can register and a message can carry: letters, digits, `.`,
 * `_`, `-`, and `:` between segments. Anything else (a space, a slash) is
 * dropped, because it would not survive as an opencode command name.
 */
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)*$/

const MAX_NAME_CHARS = 128

let pathOverride: string | null = null

export function claudeCommandStorePath(): string {
  if (pathOverride) return pathOverride
  const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(stateRoot, "opencode-claude-code-plugin", "claude-commands.json")
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function validCommandName(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_NAME_CHARS && COMMAND_NAME.test(value)
}

function cleanDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const text = value.replace(/\s+/g, " ").trim()
  if (!text) return undefined
  return text.length > MAX_DESCRIPTION_CHARS ? `${text.slice(0, MAX_DESCRIPTION_CHARS - 3).trimEnd()}...` : text
}

function readCommand(value: unknown): ClaudeCommand | null {
  if (!isObject(value) || !validCommandName(value.name)) return null
  const command: ClaudeCommand = { name: value.name }
  const description = cleanDescription(value.description)
  if (description) command.description = description
  if (value.builtin === true) command.builtin = true
  return command
}

function readCommands(value: unknown): ClaudeCommand[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: ClaudeCommand[] = []
  for (const raw of value) {
    const command = readCommand(raw)
    if (!command || seen.has(command.name)) continue
    seen.add(command.name)
    out.push(command)
    if (out.length >= MAX_COMMANDS_PER_ENTRY) break
  }
  return out
}

/**
 * The commands an `initialize` answer lists, or null when it lists none at
 * all (a CLI without the field). Only `name`, `description` and `builtin` are
 * read.
 */
export function commandsFromInitialize(init: unknown): ClaudeCommand[] | null {
  if (!isObject(init) || !Array.isArray(init.commands)) return null
  return readCommands(init.commands)
}

function readEntry(value: unknown): ClaudeCommandEntry | null {
  if (!isObject(value)) return null
  const { configDir, cwd, probedAt, cliVersion } = value
  if (typeof configDir !== "string" || !configDir || typeof cwd !== "string" || !cwd) return null
  if (typeof probedAt !== "number" || !Number.isFinite(probedAt)) return null
  return {
    configDir,
    cwd,
    probedAt,
    ...(typeof cliVersion === "string" && /^\d+\.\d+\.\d+$/.test(cliVersion) ? { cliVersion } : {}),
    commands: readCommands(value.commands),
  }
}

/** Every remembered entry, newest first. Never throws: an unreadable file is empty. */
export function readCommandEntries(file: string = claudeCommandStorePath()): ClaudeCommandEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (!isObject(parsed) || !Array.isArray(parsed.entries)) return []
    return parsed.entries
      .map(readEntry)
      .filter((entry): entry is ClaudeCommandEntry => entry !== null)
      .sort((a, b) => b.probedAt - a.probedAt)
  } catch {
    return []
  }
}

function sameTarget(a: { configDir: string; cwd: string }, b: { configDir: string; cwd: string }): boolean {
  return resolve(a.configDir) === resolve(b.configDir) && resolve(a.cwd) === resolve(b.cwd)
}

/**
 * Record one probe, replacing what was kept for the same config dir and
 * folder. Merge-on-write, atomic rename, `0600` in the `0700` directory.
 * Returns whether the disk was written. Never throws.
 */
export function writeCommandEntry(entry: ClaudeCommandEntry, file: string = claudeCommandStorePath()): boolean {
  const clean: ClaudeCommandEntry = {
    configDir: resolve(entry.configDir),
    cwd: resolve(entry.cwd),
    probedAt: entry.probedAt,
    ...(entry.cliVersion ? { cliVersion: entry.cliVersion } : {}),
    commands: readCommands(entry.commands),
  }
  const kept = readCommandEntries(file).filter((other) => !sameTarget(other, clean))
  const entries = [clean, ...kept].slice(0, MAX_COMMAND_ENTRIES)
  try {
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, entries }), { mode: 0o600 })
    renameSync(tmp, file)
    cached = null
    return true
  } catch {
    return false
  }
}

// One parse per change to the file, because the language model asks on every
// message that opens with a slash.
let cached: { file: string; mtimeMs: number; size: number; entries: ClaudeCommandEntry[] } | null = null

function currentEntries(file: string): ClaudeCommandEntry[] {
  let stats: { mtimeMs: number; size: number }
  try {
    stats = statSync(file)
  } catch {
    return []
  }
  if (cached && cached.file === file && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.entries
  }
  const entries = readCommandEntries(file)
  cached = { file, mtimeMs: stats.mtimeMs, size: stats.size, entries }
  return entries
}

function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`
  return child.startsWith(prefix)
}

/**
 * The commands the CLI listed for `configDir` in `cwd`, or in the nearest
 * folder above it that was probed, or null when none was. A session in a
 * subfolder of the project opencode opened is in the same project, and a
 * plugin enabled for the user is enabled everywhere.
 */
export function cliCommandsFor(
  configDir: string,
  cwd: string,
  file: string = claudeCommandStorePath(),
): ClaudeCommand[] | null {
  const dir = resolve(configDir)
  const folder = resolve(cwd)
  let best: ClaudeCommandEntry | null = null
  for (const entry of currentEntries(file)) {
    if (resolve(entry.configDir) !== dir) continue
    const probed = resolve(entry.cwd)
    if (!isWithin(folder, probed)) continue
    if (!best || probed.length > resolve(best.cwd).length) best = entry
  }
  return best ? best.commands : null
}

// ---------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------

/**
 * Names opencode answers itself, which a plugin must never take. A plugin
 * command of the same name REPLACES a server built-in on both majors
 * (measured: `init` registered by a plugin showed the plugin's description in
 * place of opencode's on 1.19.4 and 2.3.2), and the TUI's own entries are
 * never in a plugin's view of the command list. Read off each TUI's `/` menu
 * on 2026-11-19, outside and inside a session.
 */
export const OPENCODE_RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set([
  // Server built-ins: 1.19.4 has `init` and `review`, 2.3.2 adds `goal`.
  "init",
  "review",
  "goal",
  // The plugin's own two.
  "btw",
  "claude-code-doctor",
  // Both TUIs.
  "agents",
  "compact",
  "connect",
  "copy",
  "debug",
  "diff",
  "editor",
  "exit",
  "export",
  "fork",
  "help",
  "mcps",
  "models",
  "new",
  "rename",
  "sessions",
  "skills",
  "status",
  "themes",
  "thinking",
  "timeline",
  "undo",
  "update",
  // opencode 1.19.4's TUI only.
  "move",
  "timestamps",
  // opencode 2.3.2's TUI only (it has a `/btw` of its own as well).
  "cd",
  "clear",
  "continue",
  "effort",
  "highlights",
  "open",
  "pair",
  "plugins",
  "project",
  "projects",
  "q",
  "quit",
  "reload",
  "resume",
  "settings",
  "stats",
  "terminal",
  "usage",
  "variants",
  "web",
  // Shown only in states not measured (after an undo, with sharing on).
  "redo",
  "share",
  "unshare",
])

/** One entry this plugin adds to opencode's `/` menu. */
export interface ClaudeMenuEntry {
  /** The name opencode lists: the short name when it is unique, else the full one. */
  name: string
  /** What the entry sends after the slash: always the name Claude Code accepts. */
  command: string
  description: string
}

export interface ClaudeMenuPlan {
  entries: ClaudeMenuEntry[]
  /** Commands left out because opencode already answers that name. */
  taken: string[]
}

/** Every colon name's last segment, counted. */
function lastSegment(name: string): string {
  const index = name.lastIndexOf(":")
  return index < 0 ? name : name.slice(index + 1)
}

const MENU_DESCRIPTION_PREFIX = "Claude Code: "
const MENU_DESCRIPTION_BARE = "Claude Code command"

/**
 * What a menu entry says: that it is Claude Code's, then the CLI's own words.
 * opencode's menu is global, so an entry picked in a session on another
 * provider sends the command to that model as text; this is what tells the
 * operator it is meant for Claude Code.
 */
export function menuDescription(command: ClaudeCommand): string {
  return command.description ? `${MENU_DESCRIPTION_PREFIX}${command.description}` : MENU_DESCRIPTION_BARE
}

/**
 * True for a description this plugin wrote. Another copy of the plugin (a
 * rebuild is set up before the old copy is disposed, h #g268) or an earlier
 * pass of the same hook may already have registered the entries, and those
 * are not opencode's names to defer to.
 */
export function isClaudeMenuDescription(description: unknown): boolean {
  return (
    typeof description === "string" &&
    (description.startsWith(MENU_DESCRIPTION_PREFIX) || description === MENU_DESCRIPTION_BARE)
  )
}

/**
 * The names opencode already answers, read off its command rows, minus the
 * ones this plugin registered itself. Accepts an array, `{data: [...]}`, or a
 * name-keyed object (opencode 1's `config.command`).
 */
export function opencodeCommandNames(listed: unknown): Set<string> {
  const names = new Set<string>()
  const rows: unknown[] = Array.isArray(listed)
    ? listed
    : isObject(listed) && Array.isArray(listed.data)
      ? listed.data
      : isObject(listed)
        ? Object.entries(listed).map(([name, value]) => ({ name, ...(isObject(value) ? value : {}) }))
        : []
  for (const row of rows) {
    if (!isObject(row) || typeof row.name !== "string") continue
    if (isClaudeMenuDescription(row.description)) continue
    names.add(row.name)
  }
  return names
}

/**
 * The `/` menu entries for the commands the CLI listed. Built-ins are never
 * offered. A colon name is offered under its last segment when exactly one
 * listed command ends in it and no listed command, opencode command or
 * reserved name is that segment; otherwise under its full name. Anything
 * whose offered name opencode already has is left out, because opencode's
 * wins (`taken` lists them).
 */
export function planClaudeMenu(
  commands: readonly ClaudeCommand[],
  opencodeNames: ReadonlySet<string>,
): ClaudeMenuPlan {
  const byName = new Map<string, ClaudeCommand>()
  for (const command of commands) {
    const known = byName.get(command.name)
    // Two config dirs can list one name; a built-in anywhere stays a built-in.
    if (!known || command.builtin) byName.set(command.name, command)
  }
  const isTaken = (name: string) => opencodeNames.has(name) || OPENCODE_RESERVED_COMMAND_NAMES.has(name)
  const segmentCounts = new Map<string, number>()
  for (const command of byName.values()) {
    if (command.builtin || !command.name.includes(":")) continue
    const segment = lastSegment(command.name)
    segmentCounts.set(segment, (segmentCounts.get(segment) ?? 0) + 1)
  }
  const entries: ClaudeMenuEntry[] = []
  const taken: string[] = []
  const offered = new Set<string>()
  for (const command of byName.values()) {
    if (command.builtin) continue
    let name = command.name
    if (name.includes(":")) {
      const segment = lastSegment(name)
      const unique = segmentCounts.get(segment) === 1 && !byName.has(segment) && !isTaken(segment)
      if (unique) name = segment
    }
    if (isTaken(name) || offered.has(name)) {
      taken.push(command.name)
      continue
    }
    offered.add(name)
    entries.push({ name, command: command.name, description: menuDescription(command) })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return { entries, taken }
}

/** What an entry sends as the session's message: `/<command> <arguments>`. */
export function claudeCommandText(command: string, args: string | undefined): string {
  const rest = (args ?? "").trim()
  return rest ? `/${command} ${rest}` : `/${command}`
}

/**
 * The one command a typed short name means, or null. `release` names
 * `appical-core:release` when that is the only listed command ending in
 * `:release` and nothing is listed as `release` itself (a user, project or
 * built-in command of that name is what Claude Code would run). A colon name,
 * an ambiguous or an unknown one is null.
 */
export function resolveShortCommandName(
  name: string,
  commands: readonly ClaudeCommand[],
): string | null {
  if (!validCommandName(name) || name.includes(":")) return null
  let match: string | null = null
  for (const command of commands) {
    if (command.name === name) return null
    if (command.builtin || !command.name.includes(":")) continue
    if (lastSegment(command.name) !== name) continue
    if (match && match !== command.name) return null
    match = command.name
  }
  return match
}

/** True when the CLI listed `name` and not as one of its built-ins. */
export function isListedCommand(name: string, commands: readonly ClaudeCommand[]): boolean {
  return commands.some((command) => command.name === name && !command.builtin)
}

export function _resetClaudeCommandStoreForTests(path: string | null = null): void {
  pathOverride = path
  cached = null
}
