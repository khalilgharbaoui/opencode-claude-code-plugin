import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { expandHome } from "./accounts.js"
import { detectCliSupportsFlag } from "./cli-version.js"
import { log } from "./logger.js"
import { pluginTmpDir } from "./tmp.js"

/**
 * Bridge opencode skills into Claude Code's native Skill tool.
 *
 * Written by Joseph Roberts (@broskees) on his fork, commit 68ed142, and
 * absorbed here with light edits. Opt-in via `bridgeOpencodeSkills`; see
 * README for why it is off by default upstream.
 *
 * opencode and Claude Code use the same on-disk skill format, a
 * `<name>/SKILL.md` file whose YAML frontmatter carries `name` and
 * `description`, but they read from overlapping, not identical, roots. So an
 * opencode skill the CLI cannot see produces `Unknown skill`, and a skill in
 * a root they *share* reaches one session twice.
 *
 * Fix: assemble a throwaway Claude Code *plugin* directory whose `skills/`
 * folder links each discovered opencode skill, and hand it to the CLI with
 * `--plugin-dir`. Claude registers them natively as
 * `opencode-skills:<name>`, listed by the Skill tool, invocable, and
 * usable as `/opencode-skills:<name>`.
 *
 * `--plugin-dir` is documented as "for this session only", so this never
 * writes into the user's `~/.claude`. The staging dir lives under the
 * per-process tmp dir and is removed on exit with everything else.
 *
 * ## The two root sets, and where they overlap
 *
 * opencode's own loader (read out of the `opencode` binary: `var
 * bA=".claude", xA=".agents", GA="skills/**\/SKILL.md"`) reads project
 * `.opencode/`, `.claude/` and `.agents/` walking up from the session
 * directory, the opencode config dirs, and the global `~/.claude/skills` and
 * `~/.agents/skills` (the latter two behind `OPENCODE_DISABLE_EXTERNAL_SKILLS`
 * / `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`). `skillRoots` mirrors that list, so
 * every skill opencode advertises is one the bridge can actually stage.
 *
 * Claude Code 2.1.x loads `<CLAUDE_CONFIG_DIR>/skills` (`~/.claude/skills` by
 * default), the project's own `.claude/skills`, and the `skills/` folder of
 * every installed plugin. Its managed-settings schema names the first two
 * verbatim: "Blocked: ~/.claude/{surface}/, .claude/{surface}/ (project)".
 *
 * `.claude/skills` is therefore in *both* sets, and a skill can also be
 * installed as a Claude plugin and symlinked into `~/.agents/skills`. Either
 * way the model sees the same name and description twice, on every turn.
 * `dropNativelyLoadedSkills` removes that overlap before anything is staged;
 * `bridgeSkipNativeSkills: false` turns it off.
 *
 * Known limitation: the plugin scan reads `installed_plugins.json` and does
 * not consult the CLI's own enable/blocklist state, so a skill belonging to a
 * *disabled* plugin can be treated as natively loaded. Every skip is logged
 * with both paths and its reason, which is the one line to grep when a skill
 * goes missing.
 */

/** Plugin name, and therefore the `<plugin>:<skill>` prefix Claude assigns. */
export const SKILL_PLUGIN_NAME = "opencode-skills"

/**
 * Skills shipped inside this package, at `<package>/skills/<name>/SKILL.md`.
 * Today that is `claude-code-plugin`, the skill that lets a model configure
 * this plugin from its own reference instead of the README. It reaches the
 * model two ways: `registerBundledSkillPath` adds the directory to opencode's
 * `skills.paths` so opencode lists it for every provider, and
 * `resolveSkillPluginDirs` always stages it as a `--plugin-dir` (the user's
 * own skills stay opt-in) because a Claude-routed turn cannot call opencode's
 * `skill` tool and only sees Claude's native Skill tool.
 *
 * Both `dist/index.js` (built) and `src/skill-bridge.ts` (tsx, tests) sit one
 * level below the package root, so the same relative walk finds it.
 */
export function bundledSkillsDir(): string | null {
  try {
    const here = fileURLToPath(import.meta.url)
    const dir = path.resolve(path.dirname(here), "..", "skills")
    return dirExists(dir) ? dir : null
  } catch {
    return null
  }
}

export interface DiscoveredSkill {
  /**
   * The name the skill is known by: its SKILL.md frontmatter `name` when it
   * declares a usable one, and the directory basename otherwise. opencode
   * advertises the declared name, so staging under the basename is what made
   * `Skill("defuddle")` fail for a directory called
   * `obsidian-skills--defuddle`.
   */
  name: string
  /** Absolute path to the skill directory containing SKILL.md. */
  dir: string
  /** `dir` with symlinks resolved: the identity two copies of one skill share. */
  realDir: string
  /** sha256 of SKILL.md, the only part of a skill that reaches the prompt. */
  contentHash: string
}

/** A skill the Claude Code session loads on its own, with no bridge involved. */
export interface NativeSkill extends DiscoveredSkill {
  /**
   * Where Claude reads it from. `user` and `project` skills are registered
   * under their bare name, so a bridged skill of the same name collides with
   * them; `plugin` skills are namespaced `<plugin>:<name>` and can only ever
   * duplicate *content*, never a name.
   */
  scope: "user" | "project" | "plugin"
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function realPath(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

function envEnabled(name: string): boolean {
  const value = process.env[name]
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  return normalized !== "" && normalized !== "0" && normalized !== "false"
}

/**
 * A staged skill becomes a directory name under `skills/`, so a frontmatter
 * `name` has to be a single safe path segment before it can be trusted with
 * one. Anything else falls back to the directory basename, which readdir
 * guarantees is a plain segment.
 */
const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---/
const FRONTMATTER_NAME = /^name:[ \t]*(.+?)[ \t]*$/m

/** The `name:` a SKILL.md declares, or null when it declares none we can use. */
export function declaredSkillName(source: string): string | null {
  const block = FRONTMATTER_BLOCK.exec(source)
  if (!block) return null
  const line = FRONTMATTER_NAME.exec(block[1]!)
  if (!line) return null
  const name = line[1]!.trim().replace(/^["']|["']$/g, "").trim()
  return SAFE_SKILL_NAME.test(name) ? name : null
}

/** Read one `<root>/<entry>/SKILL.md`, or null when there is nothing to read. */
function readSkill(root: string, entry: string): DiscoveredSkill | null {
  const dir = path.join(root, entry)
  let source: string
  try {
    source = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")
  } catch {
    return null
  }
  return {
    name: declaredSkillName(source) ?? entry,
    dir,
    realDir: realPath(dir),
    contentHash: crypto.createHash("sha256").update(source).digest("hex"),
  }
}

/**
 * Whether two skills are the same skill: the same directory once symlinks are
 * resolved, or byte-identical SKILL.md content. Either one means bridging both
 * would put the same text in the prompt twice with nothing to choose between.
 */
export function sameSkill(a: DiscoveredSkill, b: DiscoveredSkill): boolean {
  return a.realDir === b.realDir || a.contentHash === b.contentHash
}

/**
 * Skill roots in opencode's own precedence order: project scope nearest-first
 * (`.opencode`, `.claude`, `.agents`), then the home-dir `.opencode`, then
 * `OPENCODE_CONFIG_DIR`, then the global `~/.config/opencode`, and finally the
 * external `~/.claude/skills` and `~/.agents/skills` scans. First occurrence of
 * a given skill name wins, so a project can shadow a global skill and an
 * opencode-managed copy shadows an external one.
 */
export function skillRoots(cwd: string): string[] {
  const roots: string[] = []
  const seen = new Set<string>()
  const push = (p: string) => {
    const abs = path.resolve(p)
    if (seen.has(abs)) return
    seen.add(abs)
    if (dirExists(abs)) roots.push(abs)
  }

  const home = os.homedir()
  const homeDir = home ? path.resolve(home) : null

  let current = path.resolve(cwd)
  while (true) {
    push(path.join(current, ".opencode", "skills"))
    // `~/.claude` and `~/.agents` are the *global* external roots and are
    // pushed below under the env switches opencode honours. A workspace that
    // happens to be the home directory must not smuggle them in ahead of that.
    if (current !== homeDir) {
      push(path.join(current, ".claude", "skills"))
      push(path.join(current, ".agents", "skills"))
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  if (homeDir) push(path.join(homeDir, ".opencode", "skills"))

  // opencode accepts both spellings in its own config dirs (`{skill,skills}`).
  const envDir = process.env.OPENCODE_CONFIG_DIR
  if (envDir) {
    push(path.join(envDir, "skills"))
    push(path.join(envDir, "skill"))
  }

  const xdg = process.env.XDG_CONFIG_HOME ?? (homeDir ? path.join(homeDir, ".config") : null)
  if (xdg) {
    push(path.join(xdg, "opencode", "skills"))
    push(path.join(xdg, "opencode", "skill"))
  }

  if (homeDir && !envEnabled("OPENCODE_DISABLE_EXTERNAL_SKILLS")) {
    if (!envEnabled("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS")) {
      push(path.join(homeDir, ".claude", "skills"))
    }
    push(path.join(homeDir, ".agents", "skills"))
  }

  return roots
}

/**
 * Walk one skill root and collect every `<name>/SKILL.md`. Directories
 * without a SKILL.md are skipped silently, opencode ignores them too.
 *
 * A name already claimed by an earlier root keeps its winner, because root
 * order *is* the precedence. When the shadowed copy is a different skill
 * rather than another link to the same one, that is a genuine ambiguity and
 * gets a warning naming both paths instead of vanishing.
 */
function collectSkills(
  root: string,
  claimed: Map<string, DiscoveredSkill>,
  found: DiscoveredSkill[],
): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    // `withFileTypes` reports a symlinked dir as a link, not a dir.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith(".")) continue
    const skill = readSkill(root, entry.name)
    if (!skill) continue
    const winner = claimed.get(skill.name)
    if (winner) {
      if (!sameSkill(winner, skill)) {
        log.warn("two different skills share a name; bridging the one the nearest root claimed", {
          name: skill.name,
          bridged: winner.dir,
          ignored: skill.dir,
        })
      }
      continue
    }
    claimed.set(skill.name, skill)
    found.push(skill)
  }
}

const byName = (a: DiscoveredSkill, b: DiscoveredSkill) => a.name.localeCompare(b.name)

export function discoverOpencodeSkills(cwd: string): DiscoveredSkill[] {
  const found: DiscoveredSkill[] = []
  const claimed = new Map<string, DiscoveredSkill>()
  for (const root of skillRoots(cwd)) collectSkills(root, claimed, found)
  return found.sort(byName)
}

/** The skills this package ships (see `bundledSkillsDir`). */
export function discoverBundledSkills(): DiscoveredSkill[] {
  const root = bundledSkillsDir()
  if (!root) return []
  const found: DiscoveredSkill[] = []
  collectSkills(root, new Map(), found)
  return found.sort(byName)
}

// ---------------------------------------------------------------------------
// What Claude already loads
// ---------------------------------------------------------------------------

/**
 * The `CLAUDE_CONFIG_DIR` this spawn will run under: the account's own config
 * dir when the provider selected one, else the environment's, else `~/.claude`.
 * Accounts symlink `skills` back to `~/.claude/skills`, so in practice every
 * account resolves to the same directory, but the spawn's own value is the
 * only one guaranteed to.
 */
export function claudeConfigDir(configDir?: string): string | null {
  const explicit = configDir ?? process.env.CLAUDE_CONFIG_DIR
  if (explicit) return path.resolve(expandHome(explicit))
  const home = os.homedir()
  return home ? path.resolve(home, ".claude") : null
}

/**
 * `skills/` of every plugin `installed_plugins.json` says applies here. A
 * `user`-scope install always does; a `project` / `local` one only when its
 * `projectPath` is the workspace or an ancestor of it.
 */
function installedPluginSkillRoots(configDir: string | null, cwd: string): string[] {
  if (!configDir) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(
      fs.readFileSync(path.join(configDir, "plugins", "installed_plugins.json"), "utf8"),
    )
  } catch {
    return []
  }
  const plugins = (parsed as { plugins?: unknown } | null)?.plugins
  if (!plugins || typeof plugins !== "object") return []

  const workspace = path.resolve(cwd)
  const roots: string[] = []
  for (const installs of Object.values(plugins as Record<string, unknown>)) {
    if (!Array.isArray(installs)) continue
    for (const install of installs) {
      const entry = install as { installPath?: unknown; scope?: unknown; projectPath?: unknown }
      if (typeof entry?.installPath !== "string" || !entry.installPath) continue
      if (entry.scope !== "user" && !coversWorkspace(entry.projectPath, workspace)) continue
      roots.push(path.join(entry.installPath, "skills"))
    }
  }
  return roots
}

function coversWorkspace(projectPath: unknown, workspace: string): boolean {
  if (typeof projectPath !== "string" || !projectPath) return false
  const root = path.resolve(projectPath)
  if (root === workspace) return true
  const rel = path.relative(root, workspace)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

/**
 * Every skill the Claude Code session will load without our help: its user
 * config dir, the project `.claude/skills` directories above the workspace,
 * and each installed plugin's own `skills/`.
 */
export function discoverNativeClaudeSkills(opts: {
  cwd: string
  configDir?: string
}): NativeSkill[] {
  const found: NativeSkill[] = []
  const scanned = new Set<string>()
  const scan = (root: string, scope: NativeSkill["scope"]) => {
    const abs = path.resolve(root)
    if (scanned.has(abs)) return
    scanned.add(abs)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (entry.name.startsWith(".")) continue
      const skill = readSkill(abs, entry.name)
      if (skill) found.push({ ...skill, scope })
    }
  }

  const configDir = claudeConfigDir(opts.configDir)
  if (configDir) scan(path.join(configDir, "skills"), "user")

  const home = os.homedir()
  const homeDir = home ? path.resolve(home) : null
  let current = path.resolve(opts.cwd)
  while (true) {
    // The home dir's `.claude/skills` is the user scope, already scanned above
    // under whatever config dir this spawn actually uses.
    if (current !== homeDir) scan(path.join(current, ".claude", "skills"), "project")
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  for (const root of installedPluginSkillRoots(configDir, opts.cwd)) scan(root, "plugin")

  return found
}

export interface SkippedSkill {
  skill: DiscoveredSkill
  native: NativeSkill
  /**
   * `same-copy`: literally the same directory. `same-content`: a byte-identical
   * SKILL.md somewhere else. `name-taken`: a *different* skill Claude registers
   * under this name, so bridging ours would make the name ambiguous.
   */
  reason: "same-copy" | "same-content" | "name-taken"
}

/**
 * Drop the skills the Claude session already sees. Identity wins over name:
 * an identical copy is dropped whatever Claude loads it from, while a name
 * clash only counts against `user` / `project` skills, because a plugin skill
 * answers to `<plugin>:<name>` and cannot shadow a bridged one.
 *
 * A `name-taken` skip changes which copy answers `Skill("<name>")`, so it is
 * the one case that warns rather than just logging.
 */
export function dropNativelyLoadedSkills(
  skills: DiscoveredSkill[],
  native: NativeSkill[],
): { bridged: DiscoveredSkill[]; skipped: SkippedSkill[] } {
  if (native.length === 0) return { bridged: skills, skipped: [] }

  const bridged: DiscoveredSkill[] = []
  const skipped: SkippedSkill[] = []
  for (const skill of skills) {
    const sameCopy = native.find((n) => n.realDir === skill.realDir)
    const sameContent = sameCopy ?? native.find((n) => n.contentHash === skill.contentHash)
    const nameTaken =
      sameContent ?? native.find((n) => n.scope !== "plugin" && n.name === skill.name)
    if (!nameTaken) {
      bridged.push(skill)
      continue
    }
    const reason = sameCopy ? "same-copy" : sameContent ? "same-content" : "name-taken"
    skipped.push({ skill, native: nameTaken, reason })
    if (reason === "name-taken") {
      log.warn("claude already registers a different skill under this name; not bridging ours", {
        name: skill.name,
        claudeLoads: nameTaken.dir,
        notBridged: skill.dir,
        scope: nameTaken.scope,
      })
    }
  }
  return { bridged, skipped }
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/** opencode 2's `Skill.Info`, the fields it requires. */
export interface BundledSkillInfo {
  id: string
  name: string
  description?: string
  path: string
  content: string
}

/**
 * The bundled skills in opencode 2's `Skill.Info` shape. V2 has no config
 * hook to add a `skills.paths` entry to, so the V2 entrypoint registers them
 * through `skill.transform` instead. Parsed the way V2's own skill-file loader
 * does (`@opencode/core@2.0.11`): `name` and `description` from the
 * frontmatter, `content` is the markdown body after it, `path` is the file.
 */
export function readBundledSkillInfos(): BundledSkillInfo[] {
  return discoverBundledSkills().flatMap((skill) => {
    const file = path.join(skill.dir, "SKILL.md")
    let text: string
    try {
      text = fs.readFileSync(file, "utf8")
    } catch {
      return []
    }
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
    const frontmatter = match?.[1] ?? ""
    const field = (key: string): string | undefined => {
      const line = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter)?.[1]?.trim()
      return line ? line.replace(/^(["'])(.*)\1$/, "$2") : undefined
    }
    const description = field("description")
    return [
      {
        id: skill.name,
        name: field("name") ?? skill.name,
        ...(description ? { description } : {}),
        path: file,
        content: match ? text.slice(match[0].length) : text,
      },
    ]
  })
}

/** Link a skill dir into the staging tree, falling back to a copy. */
function linkSkill(source: string, target: string): void {
  try {
    // Windows needs an explicit junction for directory links, and even then
    // only with the right privileges, hence the copy fallback below.
    fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir")
    return
  } catch {
    fs.cpSync(source, target, { recursive: true, dereference: true })
  }
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Materialise the synthetic plugin directory. Returns its path, or null if
 * there are no skills to bridge. The path is keyed by a hash of the
 * resolved skill set, so an unchanged set reuses the existing tree instead
 * of rebuilding it on every spawn.
 */
export function buildSkillPluginDir(skills: DiscoveredSkill[]): string | null {
  if (skills.length === 0) return null

  const fingerprint = skills.map((s) => `${s.name}\0${s.dir}`).join("\n")
  const hash = crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 12)
  const root = path.join(pluginTmpDir(), `skills-${hash}`)
  const manifest = path.join(root, ".claude-plugin", "plugin.json")

  // Same skill set as a previous spawn in this process, reuse the tree.
  if (fileExists(manifest)) return root

  try {
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true })
    fs.mkdirSync(path.join(root, "skills"), { recursive: true })
    fs.writeFileSync(
      manifest,
      JSON.stringify(
        {
          name: SKILL_PLUGIN_NAME,
          description:
            "Skills discovered from this opencode installation, bridged into Claude Code.",
        },
        null,
        2,
      ),
      { encoding: "utf8", mode: 0o600 },
    )
    for (const skill of skills) {
      linkSkill(skill.dir, path.join(root, "skills", skill.name))
    }
  } catch (err) {
    log.warn("failed to stage opencode skill plugin dir", {
      root,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  return root
}

/**
 * Add the bundled skills directory to opencode's `skills.paths` (scanned for
 * nested SKILL.md files) so opencode itself lists the
 * skill for every provider and its own `skill` tool can load it. Idempotent;
 * returns whether anything was added.
 */
export function registerBundledSkillPath(config: {
  skills?: { paths?: string[]; urls?: string[] }
}): boolean {
  const dir = bundledSkillsDir()
  if (!dir) return false
  config.skills ??= {}
  const paths = (config.skills.paths ??= [])
  if (paths.some((p) => path.resolve(p) === dir)) return false
  paths.push(dir)
  return true
}

/**
 * One-call entry point for the spawn sites: discover, drop what Claude already
 * loads, stage, and return the `--plugin-dir` values. The package's own skills
 * are always staged; the user's opencode skills only when `enabled`
 * (`bridgeOpencodeSkills`). A user skill with the same name as a bundled one
 * wins, so it can be overridden. Returns an empty array when the CLI is too old
 * to accept the flag or there is nothing left to stage, so callers can spread
 * the result unconditionally.
 */
export async function resolveSkillPluginDirs(opts: {
  cwd: string
  cliPath: string
  enabled: boolean
  /** The spawn's `CLAUDE_CONFIG_DIR`, which decides what Claude loads natively. */
  configDir?: string
  /** `bridgeSkipNativeSkills`; only `false` keeps the duplicates. */
  skipNative?: boolean
}): Promise<string[]> {
  const user = opts.enabled ? discoverOpencodeSkills(opts.cwd) : []
  const claimed = new Set(user.map((s) => s.name))
  const bundled = discoverBundledSkills().filter((s) => !claimed.has(s.name))
  let skills = [...user, ...bundled].sort(byName)

  if (opts.skipNative !== false && skills.length > 0) {
    const native = discoverNativeClaudeSkills({ cwd: opts.cwd, configDir: opts.configDir })
    const { bridged, skipped } = dropNativelyLoadedSkills(skills, native)
    if (skipped.length > 0) {
      log.info("skills claude code already loads; left unbridged", {
        count: skipped.length,
        skipped: skipped.map((s) => ({
          name: s.skill.name,
          reason: s.reason,
          opencode: s.skill.dir,
          claude: s.native.dir,
        })),
      })
    }
    skills = bridged
  }
  if (skills.length === 0) return []

  // No published version marks `--plugin-dir`'s arrival, so probe the
  // binary's own help text rather than inventing a semver threshold.
  const supported = await detectCliSupportsFlag(opts.cliPath, "--plugin-dir")
  if (!supported) {
    log.notice(
      "claude cli does not support --plugin-dir; opencode skills will not be bridged. Run `npm i -g @anthropic-ai/claude-code` to upgrade.",
      { skills: skills.length },
    )
    return []
  }

  const dir = buildSkillPluginDir(skills)
  if (!dir) return []

  log.info("bridged opencode skills into claude", {
    count: skills.length,
    names: skills.map((s) => s.name),
    bundled: bundled.map((s) => s.name),
    pluginDir: dir,
  })
  return [dir]
}
