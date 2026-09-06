import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
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
 * `description`, but they read from different roots. opencode looks in
 * `~/.config/opencode/skills/` and `.opencode/skills/`; the Claude CLI we
 * wrap looks in `~/.claude/skills/` and its own plugins. So opencode's
 * skills are invisible to the CLI, while opencode still advertises them in
 * the system prompt it forwards. The model reads that list, calls
 * `Skill("browser-automation")`, and gets `Unknown skill`.
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
  name: string
  /** Absolute path to the skill directory containing SKILL.md. */
  dir: string
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
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
 * Skill roots in opencode's own precedence order: nearest project
 * `.opencode/skills` first, then outward, then the home-dir `.opencode`,
 * then `OPENCODE_CONFIG_DIR`, then the global `~/.config/opencode`. First
 * occurrence of a given skill name wins, so a project can shadow a global
 * skill, matching how opencode resolves its own config.
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

  let current = path.resolve(cwd)
  while (true) {
    push(path.join(current, ".opencode", "skills"))
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  const home = os.homedir()
  if (home) push(path.join(home, ".opencode", "skills"))

  const envDir = process.env.OPENCODE_CONFIG_DIR
  if (envDir) push(path.join(envDir, "skills"))

  const xdg = process.env.XDG_CONFIG_HOME ?? (home ? path.join(home, ".config") : null)
  if (xdg) push(path.join(xdg, "opencode", "skills"))

  return roots
}

/**
 * Walk the skill roots and collect every `<name>/SKILL.md`. Directories
 * without a SKILL.md are skipped silently, opencode ignores them too.
 */
function collectSkills(root: string, claimed: Set<string>, found: DiscoveredSkill[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    // `withFileTypes` reports a symlinked dir as a link, not a dir.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const name = entry.name
    if (name.startsWith(".")) continue
    if (claimed.has(name)) continue
    const dir = path.join(root, name)
    if (!fileExists(path.join(dir, "SKILL.md"))) continue
    claimed.add(name)
    found.push({ name, dir })
  }
}

const byName = (a: DiscoveredSkill, b: DiscoveredSkill) => a.name.localeCompare(b.name)

export function discoverOpencodeSkills(cwd: string): DiscoveredSkill[] {
  const found: DiscoveredSkill[] = []
  const claimed = new Set<string>()
  for (const root of skillRoots(cwd)) collectSkills(root, claimed, found)
  return found.sort(byName)
}

/** The skills this package ships (see `bundledSkillsDir`). */
export function discoverBundledSkills(): DiscoveredSkill[] {
  const root = bundledSkillsDir()
  if (!root) return []
  const found: DiscoveredSkill[] = []
  collectSkills(root, new Set(), found)
  return found.sort(byName)
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
 * One-call entry point for the spawn sites: discover, stage, and return the
 * `--plugin-dir` values. The package's own skills are always staged; the
 * user's opencode skills only when `enabled` (`bridgeOpencodeSkills`). A user
 * skill with the same name as a bundled one wins, so it can be overridden.
 * Returns an empty array when the CLI is too old to accept the flag or there
 * is nothing to stage, so callers can spread the result unconditionally.
 */
export async function resolveSkillPluginDirs(opts: {
  cwd: string
  cliPath: string
  enabled: boolean
}): Promise<string[]> {
  const user = opts.enabled ? discoverOpencodeSkills(opts.cwd) : []
  const claimed = new Set(user.map((s) => s.name))
  const bundled = discoverBundledSkills().filter((s) => !claimed.has(s.name))
  const skills = [...user, ...bundled].sort(byName)
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
