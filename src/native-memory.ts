/**
 * Claude Code's own copy of an instruction file the spawn's system prompt
 * already holds (h #g303).
 *
 * Since 2.1.277 Claude Code reads a directory's `AGENTS.md` itself when there
 * is no `CLAUDE.md` beside it, and it has always read `CLAUDE.md`. opencode
 * forwards every `AGENTS.md` it loads inside the system prompt the plugin
 * appends, so on a headless spawn the same file reached the model twice: once
 * in the system prompt and once as Claude Code's own project memory. Measured
 * on 2.1.322 with a 9 KB `AGENTS.md`: 3,008 tokens on every spawn, held in the
 * context for the whole conversation. A `CLAUDE.md` that is a copy, a symlink
 * or an `@AGENTS.md` import of it is the same duplicate under another name.
 *
 * The plugin keeps opencode's copy and tells Claude Code to skip its own, with
 * the `claudeMdExcludes` setting in the spawn's `--settings` layer. That way
 * round, because the other way (dropping the forwarded block) would bet the
 * operator's instructions on predicting Claude Code's memory loading, which a
 * server-side flag can switch off for project files: an exclusion that turns
 * out moot costs nothing, a dropped block could lose the text. A file is only
 * ever excluded when its whole text is in what the model is guaranteed to see:
 *
 *  - on a fresh spawn, the appended system prompt this spawn writes;
 *  - on a `--resume` or a fork, every `prompt_snapshot` the conversation's
 *    transcript records, because a resumed conversation answers under the
 *    system prompt of its FIRST request and ignores the new file (h #g187,
 *    measured again on 2.1.322), while Claude Code re-attaches a memory file
 *    that changed since. Excluding by the new prompt there would hide an edit.
 *
 * Every refusal is "exclude nothing", which is what the plugin did before.
 * Pure apart from file reads, which tests replace.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path"

/**
 * The names Claude Code looks for in each directory from the cwd up to the
 * filesystem root, read out of 2.1.322 (its `.claude/rules` entry is left
 * out: opencode forwards no rules files). Every one is a candidate, because
 * excluding a file Claude Code would not have loaded changes nothing.
 */
const PROJECT_MEMORY_NAMES = [
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  join(".claude", "CLAUDE.md"),
  join(".claude", "AGENTS.md"),
] as const

/** The names read from the account's config dir (user memory). */
const USER_MEMORY_NAMES = ["CLAUDE.md", "AGENTS.md"] as const

/**
 * Claude Code's own import syntax, copied from 2.1.322: `@path`, at the start
 * or after whitespace, with `\ ` for a space and `#...` dropped.
 */
const IMPORT_PATTERN = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g

/**
 * Characters `claudeMdExcludes` would read as a glob (it matches with
 * picomatch). A path holding one is never sent, rather than escaped.
 */
const GLOB_META = /[*?[\]{}()!\\]/

/** One file the spawn tells Claude Code to skip, every spelling of its path. */
export interface NativeMemoryExclude {
  /** The path built from the cwd, then any realpath spelling of it. */
  paths: string[]
  /** sha256 of the file as it was when it was judged covered. */
  digest: string
}

export interface NativeMemoryIo {
  readFile: (path: string) => string | null
  realpath: (path: string) => string | null
  exists: (path: string) => boolean
}

const defaultIo: NativeMemoryIo = {
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8")
    } catch {
      return null
    }
  },
  realpath: (path) => {
    try {
      return realpathSync.native(path)
    } catch {
      return null
    }
  },
  exists: (path) => {
    try {
      return existsSync(path)
    } catch {
      return false
    }
  },
}

export function digestOf(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

/**
 * Whether `content` imports a file that exists. Excluding such a file would
 * take the imported text with it, and that text is not in the system prompt,
 * so it is never excluded. A handle like `@someone` names no file and does not
 * count; anything that might resolve does, read both as written and with
 * trailing punctuation off.
 */
export function hasLiveImport(
  content: string,
  fileDirs: readonly string[],
  io: Pick<NativeMemoryIo, "exists"> = defaultIo,
): boolean {
  for (const match of content.matchAll(IMPORT_PATTERN)) {
    let token = match[1] ?? ""
    const hash = token.indexOf("#")
    if (hash !== -1) token = token.slice(0, hash)
    token = token.replaceAll("\\ ", " ")
    const spellings = new Set([token, token.replace(/[.,;:!?)\]}'"`]+$/, "")])
    for (const spelling of spellings) {
      if (!spelling) continue
      const targets = spelling.startsWith("~/")
        ? [join(homedir(), spelling.slice(2))]
        : isAbsolute(spelling)
          ? [spelling]
          : fileDirs.map((dir) => resolve(dir, spelling))
      if (targets.some((target) => io.exists(target))) return true
    }
  }
  return false
}

interface Candidate {
  /** The directory the name belongs to, for the CLAUDE.md / AGENTS.md pairing. */
  dir: string
  name: string
  path: string
}

function candidates(cwd: string, configDir: string | null): Candidate[] {
  const out: Candidate[] = []
  const root = parse(cwd).root
  let dir = cwd
  while (true) {
    for (const name of PROJECT_MEMORY_NAMES) out.push({ dir, name, path: join(dir, name) })
    if (dir === root) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (configDir) {
    for (const name of USER_MEMORY_NAMES) {
      out.push({ dir: `user:${configDir}`, name, path: join(configDir, name) })
    }
  }
  return out
}

/** `.claude/CLAUDE.md` and `CLAUDE.md` both count as the directory's CLAUDE.md. */
function isClaudeName(name: string): boolean {
  return basename(name) === "CLAUDE.md"
}

function isAgentsName(name: string): boolean {
  return basename(name) === "AGENTS.md"
}

/**
 * The files Claude Code should skip because the model already sees their
 * whole text in `visible`: the appended system prompt on a fresh spawn, every
 * recorded prompt snapshot on a resume. Empty `visible` (nothing guaranteed)
 * and Windows (a `\` path is a glob escape to picomatch) exclude nothing.
 *
 * Claude Code reads a directory's `AGENTS.md` only when it has no `CLAUDE.md`,
 * and measured on 2.1.322 an EXCLUDED `CLAUDE.md` counts as none: the
 * `AGENTS.md` beside it is loaded instead. So a `CLAUDE.md` is excluded only
 * when every `AGENTS.md` in the same directory is excluded too or absent,
 * or excluding it would load a file the model never saw before.
 */
export function planNativeMemoryExcludes(opts: {
  cwd: string
  configDir: string | null
  visible: readonly string[]
  platform?: NodeJS.Platform
  io?: Partial<NativeMemoryIo>
}): NativeMemoryExclude[] {
  if ((opts.platform ?? process.platform) === "win32") return []
  const visible = opts.visible.filter((text) => text.length > 0)
  if (visible.length === 0) return []
  const io: NativeMemoryIo = { ...defaultIo, ...opts.io }

  const all = candidates(opts.cwd, opts.configDir)
  const judged = new Map<string, { candidate: Candidate; digest: string } | null>()
  const present = new Set<string>()
  for (const candidate of all) {
    if (judged.has(candidate.path)) continue
    const content = io.readFile(candidate.path)
    if (content === null) {
      judged.set(candidate.path, null)
      continue
    }
    present.add(candidate.path)
    const text = content.trim()
    if (!text || GLOB_META.test(candidate.path)) {
      judged.set(candidate.path, null)
      continue
    }
    const real = io.realpath(candidate.path)
    const fileDirs = [...new Set([dirname(candidate.path), ...(real ? [dirname(real)] : [])])]
    const covered =
      visible.every((shown) => shown.includes(text)) && !hasLiveImport(content, fileDirs, io)
    judged.set(candidate.path, covered ? { candidate, digest: digestOf(content) } : null)
  }

  const out: NativeMemoryExclude[] = []
  for (const [path, verdict] of judged) {
    if (!verdict) continue
    const { candidate } = verdict
    if (isClaudeName(candidate.name)) {
      const siblingsCovered = all
        .filter((other) => other.dir === candidate.dir && isAgentsName(other.name))
        .every((other) => !present.has(other.path) || judged.get(other.path))
      if (!siblingsCovered) continue
    }
    const realDir = io.realpath(dirname(path))
    const realFile = io.realpath(path)
    const spellings = [
      path,
      ...(realDir ? [join(realDir, basename(path))] : []),
      ...(realFile ? [realFile] : []),
    ]
    const paths = [...new Set(spellings)].filter((spelling) => !GLOB_META.test(spelling))
    if (paths.length > 0) out.push({ paths, digest: verdict.digest })
  }
  return out
}

/**
 * The system prompt of every `prompt_snapshot` record in a Claude transcript,
 * each as one string. Null when the file cannot be read or holds none, which
 * the caller reads as "nothing is guaranteed visible". The record is Claude
 * Code's own (`--system-prompt-snapshot`, on by default) and is what a
 * `--resume` of the conversation answers under.
 */
export function readPromptSnapshots(
  transcriptPath: string,
  io: Pick<NativeMemoryIo, "readFile"> = defaultIo,
): string[] | null {
  const raw = io.readFile(transcriptPath)
  if (raw === null) return null
  const out: string[] = []
  for (const line of raw.split("\n")) {
    if (!line.includes('"prompt_snapshot"')) continue
    try {
      const record = JSON.parse(line) as {
        type?: unknown
        attachment?: { type?: unknown; systemPrompt?: unknown }
      }
      const prompt = record.attachment?.systemPrompt
      if (record.type !== "attachment" || record.attachment?.type !== "prompt_snapshot") continue
      if (!Array.isArray(prompt)) continue
      out.push(prompt.filter((block): block is string => typeof block === "string").join("\n"))
    } catch {
      // A torn or foreign line is not a snapshot.
    }
  }
  return out.length > 0 ? out : null
}

/**
 * The excludes that still hold: every file whose content is the one that was
 * judged covered. A watchdog respawn reuses the old child's argv with
 * `--resume` added (h #g84), so a file edited since the spawn must come off
 * the list, or the resumed conversation would never be shown the edit.
 */
export function stillCovered(
  excludes: readonly NativeMemoryExclude[],
  io: Pick<NativeMemoryIo, "readFile"> = defaultIo,
): NativeMemoryExclude[] {
  return excludes.filter((exclude) => {
    const content = io.readFile(exclude.paths[0]!)
    return content !== null && digestOf(content) === exclude.digest
  })
}

/** The `claudeMdExcludes` list for a set of excludes. */
export function excludePaths(excludes: readonly NativeMemoryExclude[]): string[] {
  return [...new Set(excludes.flatMap((exclude) => exclude.paths))]
}

/**
 * An argv reused from an earlier spawn (a watchdog respawn, a compaction
 * fork), with the excludes whose file changed since taken off. Unchanged
 * when nothing was excluded or every file is as it was.
 */
export function recheckNativeMemoryExcludes(
  args: readonly string[],
  excludes: readonly NativeMemoryExclude[] | undefined,
  io: Pick<NativeMemoryIo, "readFile"> = defaultIo,
): { args: string[]; excludes: NativeMemoryExclude[] | undefined } {
  if (!excludes || excludes.length === 0) return { args: [...args], excludes: excludes ? [] : undefined }
  const kept = stillCovered(excludes, io)
  if (kept.length === excludes.length) return { args: [...args], excludes: kept }
  return { args: withClaudeMdExcludes(args, excludePaths(kept)), excludes: kept }
}

/**
 * `args` with the `claudeMdExcludes` of its `--settings` replaced by `paths`,
 * the other flag settings kept, and the flag dropped when nothing is left.
 * An unparsable `--settings` value is left exactly as it was.
 */
export function withClaudeMdExcludes(args: readonly string[], paths: readonly string[]): string[] {
  const out = [...args]
  const at = out.indexOf("--settings")
  let settings: Record<string, unknown> = {}
  if (at !== -1) {
    try {
      const parsed = JSON.parse(out[at + 1] ?? "")
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out
      settings = { ...(parsed as Record<string, unknown>) }
    } catch {
      return out
    }
  }
  delete settings.claudeMdExcludes
  if (paths.length > 0) settings.claudeMdExcludes = [...paths]
  const value = Object.keys(settings).length > 0 ? JSON.stringify(settings) : null
  if (at !== -1) {
    if (value === null) out.splice(at, 2)
    else out[at + 1] = value
  } else if (value !== null) {
    out.push("--settings", value)
  }
  return out
}
