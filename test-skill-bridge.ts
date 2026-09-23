import assert from "node:assert/strict"
import { test } from "node:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as crypto from "node:crypto"
import {
  SKILL_PLUGIN_NAME,
  buildSkillPluginDir,
  bundledSkillsDir,
  declaredSkillName,
  discoverBundledSkills,
  discoverNativeClaudeSkills,
  discoverOpencodeSkills,
  dropNativelyLoadedSkills,
  registerBundledSkillPath,
  resolveSkillPluginDirs,
  skillRoots,
} from "./src/skill-bridge.js"
import {
  buildCliArgs,
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  sessionKey,
} from "./src/session-manager.js"
import { createClaudeCode } from "./src/index.js"

/**
 * Skill names are prefixed so a stray `~/.opencode/skills` on the machine
 * running the suite can't collide with the fixtures.
 */
const P = "zz-fixture-"

function makeSkill(root: string, name: string, body = "# body\n"): void {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: fixture ${name}\n---\n\n${body}`,
  )
}

interface FixturePaths {
  /** The workspace the spawn runs in. */
  cwd: string
  /** `<cwd>/.opencode/skills` — opencode's own project root. */
  projectSkills: string
  /** `<xdg>/opencode/skills` — opencode's own global root. */
  globalSkills: string
  /** `<cwd>/.claude/skills` — read by opencode AND natively by Claude. */
  projectClaudeSkills: string
  /** `<cwd>/.agents/skills` — read by opencode only. */
  projectAgentsSkills: string
  /** `~/.claude/skills` — opencode's external scan, and Claude's user scope. */
  homeClaudeSkills: string
  /** `~/.agents/skills` — opencode's external scan, invisible to Claude. */
  homeAgentsSkills: string
  /** `CLAUDE_CONFIG_DIR`, i.e. `~/.claude`. */
  claudeConfig: string
}

/** Run `fn` with a scratch tree and env isolated from the real machine. */
async function withFixture<T>(fn: (paths: FixturePaths) => T): Promise<Awaited<T>> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "skill-bridge-test-"))
  const cwd = path.join(base, "workspace")
  const xdg = path.join(base, "xdg")
  const claudeConfig = path.join(base, ".claude")
  const paths: FixturePaths = {
    cwd,
    projectSkills: path.join(cwd, ".opencode", "skills"),
    globalSkills: path.join(xdg, "opencode", "skills"),
    projectClaudeSkills: path.join(cwd, ".claude", "skills"),
    projectAgentsSkills: path.join(cwd, ".agents", "skills"),
    homeClaudeSkills: path.join(claudeConfig, "skills"),
    homeAgentsSkills: path.join(base, ".agents", "skills"),
    claudeConfig,
  }
  for (const [key, dir] of Object.entries(paths)) {
    if (key !== "cwd" && key !== "claudeConfig") fs.mkdirSync(dir, { recursive: true })
  }

  const saved = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    OPENCODE_DISABLE_EXTERNAL_SKILLS: process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS,
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS,
    // Pinned, not merely saved: an ambient CLAUDE_CONFIG_DIR would send the
    // native scan at the real machine's `~/.claude/skills`.
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    HOME: process.env.HOME,
  }
  process.env.HOME = base
  process.env.XDG_CONFIG_HOME = xdg
  process.env.CLAUDE_CONFIG_DIR = claudeConfig
  delete process.env.OPENCODE_CONFIG_DIR
  delete process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS
  delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS
  try {
    return await fn(paths)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(base, { recursive: true, force: true })
  }
}

const fixtures = (skills: { name: string }[]) =>
  skills.filter((s) => s.name.startsWith(P))

/**
 * A stand-in `claude` whose `--help` output is under the test's control, so
 * the flag probe is deterministic and never touches the real binary. Its
 * path is unique per call, which also defeats the probe's per-path cache.
 */
function fakeCli(base: string, help: string, exitCode = 0): string {
  const file = path.join(base, `fake-claude-${crypto.randomUUID()}.cjs`)
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
if (process.argv.includes("--help")) { process.stdout.write(${JSON.stringify(help)}); process.exit(${exitCode}) }
process.exit(0)
`,
  )
  fs.chmodSync(file, 0o755)
  return file
}

const skillNames = (dir: string) =>
  fs.readdirSync(path.join(dir, "skills")).sort()

test("discovers skills from both project and global roots", async () => {
  await withFixture(({ cwd, projectSkills, globalSkills }) => {
    makeSkill(projectSkills, `${P}local`)
    makeSkill(globalSkills, `${P}global`)

    const found = fixtures(discoverOpencodeSkills(cwd))
    assert.deepEqual(
      found.map((s) => s.name),
      [`${P}global`, `${P}local`],
      "results are sorted by name",
    )
  })
})

test("a project skill shadows a global skill of the same name", async () => {
  await withFixture(({ cwd, projectSkills, globalSkills }) => {
    makeSkill(projectSkills, `${P}dup`, "project wins\n")
    makeSkill(globalSkills, `${P}dup`, "global loses\n")

    const found = fixtures(discoverOpencodeSkills(cwd))
    assert.equal(found.length, 1, "the name is claimed exactly once")
    assert.ok(
      found[0]!.dir.startsWith(path.resolve(cwd)),
      `expected the project copy to win, got ${found[0]!.dir}`,
    )
  })
})

test("directories without a SKILL.md are ignored", async () => {
  await withFixture(({ cwd, projectSkills }) => {
    fs.mkdirSync(path.join(projectSkills, `${P}empty`), { recursive: true })
    fs.mkdirSync(path.join(projectSkills, ".hidden"), { recursive: true })
    makeSkill(projectSkills, `${P}real`)

    const found = fixtures(discoverOpencodeSkills(cwd))
    assert.deepEqual(
      found.map((s) => s.name),
      [`${P}real`],
    )
  })
})

test("staged plugin dir carries a manifest and one entry per skill", async () => {
  await withFixture(({ cwd, projectSkills }) => {
    makeSkill(projectSkills, `${P}alpha`, "alpha body\n")
    makeSkill(projectSkills, `${P}beta`)

    const skills = fixtures(discoverOpencodeSkills(cwd))
    const dir = buildSkillPluginDir(skills)
    assert.ok(dir, "expected a staged plugin dir")

    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir!, ".claude-plugin", "plugin.json"), "utf8"),
    )
    assert.equal(manifest.name, SKILL_PLUGIN_NAME)
    assert.ok(manifest.description, "manifest needs a description")

    // The skill must be readable through the staged tree, whether it was
    // linked (posix) or copied (windows fallback).
    const staged = path.join(dir!, "skills", `${P}alpha`, "SKILL.md")
    assert.match(fs.readFileSync(staged, "utf8"), /alpha body/)
    assert.deepEqual(
      fs.readdirSync(path.join(dir!, "skills")).sort(),
      [`${P}alpha`, `${P}beta`],
    )
  })
})

test("staging is reused for an identical skill set and rekeyed when it changes", async () => {
  await withFixture(({ cwd, projectSkills }) => {
    makeSkill(projectSkills, `${P}one`)
    const first = buildSkillPluginDir(fixtures(discoverOpencodeSkills(cwd)))
    const again = buildSkillPluginDir(fixtures(discoverOpencodeSkills(cwd)))
    assert.equal(first, again, "same set must not restage")

    makeSkill(projectSkills, `${P}two`)
    const grown = buildSkillPluginDir(fixtures(discoverOpencodeSkills(cwd)))
    assert.notEqual(first, grown, "a changed set must get its own dir")
  })
})

test("no skills means no plugin dir", () => {
  assert.equal(buildSkillPluginDir([]), null)
})

// --- opencode's real roots ---------------------------------------------------
//
// opencode reads `.claude/` and `.agents/` as well as its own `.opencode/`,
// project-scoped walking up and globally from the home dir. The bridge used to
// read only `.opencode/`, so everything a user kept in `~/.agents/skills` was
// advertised by opencode and unreachable from a Claude turn.

test("discovery covers every root opencode itself reads", async () => {
  await withFixture(({ cwd, projectSkills, projectClaudeSkills, projectAgentsSkills, globalSkills, homeClaudeSkills, homeAgentsSkills }) => {
    makeSkill(projectSkills, `${P}p-opencode`)
    makeSkill(projectClaudeSkills, `${P}p-claude`)
    makeSkill(projectAgentsSkills, `${P}p-agents`)
    makeSkill(globalSkills, `${P}g-opencode`)
    makeSkill(homeClaudeSkills, `${P}g-claude`)
    makeSkill(homeAgentsSkills, `${P}g-agents`)

    assert.deepEqual(
      fixtures(discoverOpencodeSkills(cwd)).map((s) => s.name),
      [`${P}g-agents`, `${P}g-claude`, `${P}g-opencode`, `${P}p-agents`, `${P}p-claude`, `${P}p-opencode`],
    )
  })
})

test("the external roots honour opencode's own kill switches", async () => {
  await withFixture(({ cwd, homeClaudeSkills, homeAgentsSkills }) => {
    makeSkill(homeClaudeSkills, `${P}ext-claude`)
    makeSkill(homeAgentsSkills, `${P}ext-agents`)
    const names = () => fixtures(discoverOpencodeSkills(cwd)).map((s) => s.name)
    assert.deepEqual(names(), [`${P}ext-agents`, `${P}ext-claude`])

    process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1"
    assert.deepEqual(names(), [`${P}ext-agents`], "~/.claude is the claude-code scan")

    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1"
    assert.deepEqual(names(), [], "and this one covers both")
  })
})

test("the home dir's own .claude and .agents arrive as global roots, not project ones", async () => {
  await withFixture(({ cwd }) => {
    // The walk-up passes through HOME on the way to `/`. Reaching the external
    // roots that way would sail straight past the kill switches above.
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1"
    const home = path.resolve(process.env.HOME!)
    const roots = skillRoots(cwd)
    assert.ok(!roots.includes(path.join(home, ".claude", "skills")), roots.join("\n"))
    assert.ok(!roots.includes(path.join(home, ".agents", "skills")), roots.join("\n"))
  })
})

// --- identity ----------------------------------------------------------------

test("a skill is known by the name its frontmatter declares", async () => {
  await withFixture(({ cwd, projectSkills }) => {
    // Real case: the obsidian skill pack ships `obsidian-skills--defuddle/`
    // whose SKILL.md declares `name: defuddle`. opencode advertises `defuddle`,
    // so staging the basename made `Skill("defuddle")` fail.
    const dir = path.join(projectSkills, `${P}pack--inner`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${P}inner\ndescription: renamed\n---\n\nbody\n`,
    )
    const [found] = fixtures(discoverOpencodeSkills(cwd))
    assert.equal(found!.name, `${P}inner`)
    assert.equal(found!.dir, dir)

    const staged = buildSkillPluginDir([found!])
    assert.deepEqual(fs.readdirSync(path.join(staged!, "skills")), [`${P}inner`])
  })
})

test("declaredSkillName refuses anything that is not one safe path segment", () => {
  const fm = (name: string) => `---\nname: ${name}\ndescription: x\n---\n`
  assert.equal(declaredSkillName(fm("good-name_1.2")), "good-name_1.2")
  assert.equal(declaredSkillName(fm('"quoted"')), "quoted")
  // A staged name becomes a directory under `skills/`; these must not.
  for (const bad of ["../escape", "a/b", ".hidden", "-leading", ""]) {
    assert.equal(declaredSkillName(fm(bad)), null, bad)
  }
  assert.equal(declaredSkillName("no frontmatter at all"), null)
  assert.equal(declaredSkillName("---\ndescription: x\n---\n"), null)
  // Only a top-level key counts; an indented one belongs to something else.
  assert.equal(declaredSkillName("---\nmeta:\n  name: nested\n---\n"), null)
})

test("a skill reached through two roots is one skill, and only a real divergence warns", async () => {
  await withFixture(({ cwd, projectSkills, globalSkills, homeAgentsSkills }) => {
    // Byte-identical copies in two roots, plus a symlink to a third.
    makeSkill(projectSkills, `${P}twin`, "same body\n")
    makeSkill(globalSkills, `${P}twin`, "same body\n")
    makeSkill(homeAgentsSkills, `${P}linked`)
    fs.symlinkSync(
      path.join(homeAgentsSkills, `${P}linked`),
      path.join(projectSkills, `${P}linked`),
      "dir",
    )

    const found = fixtures(discoverOpencodeSkills(cwd))
    assert.deepEqual(found.map((s) => s.name), [`${P}linked`, `${P}twin`])
    const linked = found.find((s) => s.name === `${P}linked`)!
    assert.equal(
      linked.realDir,
      fs.realpathSync(path.join(homeAgentsSkills, `${P}linked`)),
      "a symlink is the same skill as its target",
    )
  })
})

// --- what Claude already loads -----------------------------------------------

const nativeOf = (skills: ReturnType<typeof discoverNativeClaudeSkills>) =>
  skills.filter((s) => s.name.startsWith(P))

test("native discovery finds user, project and installed-plugin skills", async () => {
  await withFixture(({ cwd, claudeConfig, homeClaudeSkills, projectClaudeSkills }) => {
    makeSkill(homeClaudeSkills, `${P}user`)
    makeSkill(projectClaudeSkills, `${P}project`)

    const installPath = path.join(claudeConfig, "plugins", "cache", "market", "pack", "1.0.0")
    makeSkill(path.join(installPath, "skills"), `${P}plugin`)
    const elsewhere = path.join(claudeConfig, "plugins", "cache", "market", "other", "1.0.0")
    makeSkill(path.join(elsewhere, "skills"), `${P}other-project`)
    fs.writeFileSync(
      path.join(claudeConfig, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "pack@market": [{ scope: "user", installPath }],
          "other@market": [
            { scope: "project", projectPath: path.join(cwd, "..", "somewhere-else"), installPath: elsewhere },
          ],
        },
      }),
    )

    const native = nativeOf(discoverNativeClaudeSkills({ cwd }))
    assert.deepEqual(
      native.map((s) => [s.name, s.scope]).sort(),
      [[`${P}plugin`, "plugin"], [`${P}project`, "project"], [`${P}user`, "user"]],
      "a plugin installed for another project is not loaded here",
    )
  })
})

test("identical copies are dropped whatever Claude loads them from; a name clash warns", () => {
  const skill = (over: Partial<{ name: string; dir: string; realDir: string; contentHash: string }>) => ({
    name: "s",
    dir: "/oc/s",
    realDir: "/oc/s",
    contentHash: "hash-a",
    ...over,
  })
  const native = [
    { ...skill({ name: "shared", dir: "/claude/shared", realDir: "/claude/shared" }), scope: "user" as const },
    { ...skill({ name: "copied", dir: "/claude/copied", realDir: "/claude/copied", contentHash: "hash-copy" }), scope: "plugin" as const },
    { ...skill({ name: "diverged", dir: "/claude/diverged", realDir: "/claude/diverged", contentHash: "hash-theirs" }), scope: "user" as const },
    { ...skill({ name: "plugin-only", dir: "/claude/plugin-only", realDir: "/claude/plugin-only", contentHash: "hash-theirs" }), scope: "plugin" as const },
  ]
  const { bridged, skipped } = dropNativelyLoadedSkills(
    [
      skill({ name: "shared", dir: "/oc/shared", realDir: "/claude/shared" }),
      skill({ name: "copied-elsewhere", dir: "/oc/copied", realDir: "/oc/copied", contentHash: "hash-copy" }),
      skill({ name: "diverged", dir: "/oc/diverged", realDir: "/oc/diverged", contentHash: "hash-mine" }),
      skill({ name: "plugin-only", dir: "/oc/plugin-only", realDir: "/oc/plugin-only", contentHash: "hash-mine" }),
      skill({ name: "untouched", dir: "/oc/untouched", realDir: "/oc/untouched", contentHash: "hash-new" }),
    ],
    native,
  )

  assert.deepEqual(
    bridged.map((s) => s.name),
    ["plugin-only", "untouched"],
    "a plugin skill answers to <plugin>:<name>, so it cannot take a bridged name",
  )
  assert.deepEqual(
    skipped.map((s) => [s.skill.name, s.reason]),
    [["shared", "same-copy"], ["copied-elsewhere", "same-content"], ["diverged", "name-taken"]],
  )
  assert.equal(skipped[2]!.native.dir, "/claude/diverged", "the warning has to name both sides")
})

test("no native skills at all is a pass-through, not a filter", () => {
  const skills = [{ name: "a", dir: "/a", realDir: "/a", contentHash: "h" }]
  const { bridged, skipped } = dropNativelyLoadedSkills(skills, [])
  assert.equal(bridged, skills)
  assert.deepEqual(skipped, [])
})

test("a skill Claude already loads is not bridged, and the opt-out brings it back", async () => {
  await withFixture(async ({ cwd, claudeConfig, projectSkills, homeClaudeSkills, projectClaudeSkills }) => {
    // Scenario 1: `~/.claude/skills` is an opencode root and Claude's user scope.
    makeSkill(homeClaudeSkills, `${P}both`)
    // Scenario 2: installed as a Claude plugin and copied into an opencode
    // root under a different directory name. Byte-identical SKILL.md, so the
    // declared name is the same and only the hash can tell they are one skill.
    const body = `---\nname: ${P}copy\ndescription: two homes\n---\n\nidentical\n`
    const installPath = path.join(claudeConfig, "plugins", "cache", "m", "pack", "1.0.0")
    for (const dir of [
      path.join(projectSkills, `${P}copy`),
      path.join(installPath, "skills", `${P}copy-as-installed`),
    ]) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "SKILL.md"), body)
    }
    fs.writeFileSync(
      path.join(claudeConfig, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "pack@m": [{ scope: "user", installPath }] } }),
    )
    // Only reachable through the bridge.
    makeSkill(projectSkills, `${P}mine`)
    // Same name, different content: Claude's copy wins and the bridge warns.
    makeSkill(projectClaudeSkills, `${P}clash`, "claude's\n")
    makeSkill(projectSkills, `${P}clash`, "opencode's\n")

    const cliPath = fakeCli(path.dirname(cwd), "--plugin-dir <path>")
    const staged = async (skipNative?: boolean) => {
      const dirs = await resolveSkillPluginDirs({ cwd, cliPath, enabled: true, skipNative })
      return skillNames(dirs[0]!).filter((n) => n.startsWith(P))
    }

    assert.deepEqual(await staged(), [`${P}mine`])
    assert.deepEqual(
      await staged(false),
      [`${P}both`, `${P}clash`, `${P}copy`, `${P}mine`],
      "bridgeSkipNativeSkills: false keeps every duplicate",
    )
  })
})

test("the native scan follows the account's own CLAUDE_CONFIG_DIR", async () => {
  await withFixture(async ({ cwd, projectSkills, homeClaudeSkills }) => {
    makeSkill(projectSkills, `${P}acct`)
    // The default config dir has it; an account's does not, so a spawn routed
    // to that account still needs it bridged.
    makeSkill(homeClaudeSkills, `${P}acct`)
    const account = path.join(path.dirname(cwd), ".claude-other")
    fs.mkdirSync(path.join(account, "skills"), { recursive: true })

    const cliPath = fakeCli(path.dirname(cwd), "--plugin-dir <path>")
    const staged = async (configDir?: string) => {
      const dirs = await resolveSkillPluginDirs({ cwd, cliPath, enabled: true, configDir })
      return skillNames(dirs[0]!).filter((n) => n.startsWith(P))
    }
    assert.deepEqual(await staged(), [])
    assert.deepEqual(await staged(account), [`${P}acct`])
  })
})

// --- the bundled skill -------------------------------------------------------
//
// The package ships `skills/claude-code-plugin/SKILL.md`, the skill a model
// uses to configure this plugin. It is always bridged, because a Claude-routed
// turn only sees Claude's native Skill tool; the user's own skills stay behind
// `bridgeOpencodeSkills`.

test("finds the bundled skill relative to the source module", () => {
  const dir = bundledSkillsDir()
  assert.ok(dir, "skills/ must exist next to src/ and dist/")
  assert.equal(path.basename(dir!), "skills")
  const bundled = discoverBundledSkills()
  assert.deepEqual(bundled.map((s) => s.name), ["claude-code-plugin"])
  assert.ok(fs.existsSync(path.join(bundled[0]!.dir, "SKILL.md")))
})

test("registerBundledSkillPath adds the directory to skills.paths exactly once", () => {
  const config: { skills?: { paths?: string[] } } = {}
  assert.equal(registerBundledSkillPath(config), true)
  assert.deepEqual(config.skills?.paths, [bundledSkillsDir()])
  assert.equal(registerBundledSkillPath(config), false, "idempotent")
  assert.equal(config.skills?.paths?.length, 1)

  // A user's own entries are kept, and a differently written spelling of the
  // same directory is recognised as already present.
  const withUser = { skills: { paths: ["~/my-skills", `${bundledSkillsDir()}/../skills`] } }
  assert.equal(registerBundledSkillPath(withUser), false)
  assert.equal(withUser.skills.paths.length, 2)
})

test("resolveSkillPluginDirs stages only the bundled skill when the user bridge is off", async () => {
  await withFixture(async ({ cwd, projectSkills }) => {
    makeSkill(projectSkills, `${P}off`)
    const dirs = await resolveSkillPluginDirs({
      cwd,
      cliPath: fakeCli(path.dirname(cwd), "--plugin-dir <path>  Load a plugin"),
      enabled: false,
    })
    assert.equal(dirs.length, 1, "the bundled skill is bridged regardless of the opt-in")
    assert.deepEqual(skillNames(dirs[0]!), ["claude-code-plugin"], "the user's skill is not")
  })
})

test("resolveSkillPluginDirs stages user skills next to the bundled one when enabled", async () => {
  await withFixture(async ({ cwd, projectSkills }) => {
    makeSkill(projectSkills, `${P}on`)
    const dirs = await resolveSkillPluginDirs({
      cwd,
      cliPath: fakeCli(path.dirname(cwd), "--plugin-dir <path>  Load a plugin"),
      enabled: true,
    })
    assert.equal(dirs.length, 1)
    assert.deepEqual(skillNames(dirs[0]!), ["claude-code-plugin", `${P}on`])
  })
})

test("a user skill named like the bundled one wins, so it can be overridden", async () => {
  await withFixture(async ({ cwd, projectSkills }) => {
    makeSkill(projectSkills, "claude-code-plugin", "# user override\n")
    const dirs = await resolveSkillPluginDirs({
      cwd,
      cliPath: fakeCli(path.dirname(cwd), "--plugin-dir <path>"),
      enabled: true,
    })
    assert.equal(dirs.length, 1)
    const staged = fs.realpathSync(path.join(dirs[0]!, "skills", "claude-code-plugin"))
    assert.equal(staged, fs.realpathSync(path.join(projectSkills, "claude-code-plugin")))
  })
})

test("resolveSkillPluginDirs degrades to no-op when the CLI lacks --plugin-dir", async () => {
  await withFixture(async ({ cwd, projectSkills }) => {
    makeSkill(projectSkills, `${P}unsupported`)
    for (const cliPath of [
      fakeCli(path.dirname(cwd), "Usage: claude [options]\n  --model <model>"),
      fakeCli(path.dirname(cwd), "--plugin-dir", 1),
      "/nonexistent/claude-binary",
    ]) {
      const dirs = await resolveSkillPluginDirs({ cwd, cliPath, enabled: true })
      assert.deepEqual(dirs, [], `an unsupporting or unprobeable CLI must not get the flag: ${cliPath}`)
    }
  })
})

test("the flag probe closes the child's stdin, so a binary that reads it still exits", async () => {
  await withFixture(async ({ cwd }) => {
    // Sits on stdin like the suite's fake CLIs do; without EOF it would hang
    // until the probe's 5 s timeout.
    const file = path.join(path.dirname(cwd), "stdin-reader.cjs")
    fs.writeFileSync(
      file,
      `#!/usr/bin/env node
require("node:readline").createInterface({ input: process.stdin }).on("close", () => {
  process.stdout.write("--plugin-dir");
  process.exit(0)
})
`,
    )
    fs.chmodSync(file, 0o755)
    const started = Date.now()
    const dirs = await resolveSkillPluginDirs({ cwd, cliPath: file, enabled: false })
    assert.ok(Date.now() - started < 4000, "must not wait out the probe timeout")
    assert.equal(dirs.length, 1)
  })
})

// --- the spawn itself -----------------------------------------------------------
//
// Helper coverage above proves the pieces exist; these prove the `claude`
// that actually gets spawned carries `--plugin-dir`, on both headless paths,
// with the user's skills by default and without them on the explicit opt-out.

/**
 * A stand-in `claude` that records its argv, advertises `--plugin-dir` in
 * `--help` (or not), and answers one turn with a text reply so both
 * `doStream` and `doGenerate` complete.
 */
function recordingCli(dir: string, help: string): { cliPath: string; argvPath: string } {
  const cliPath = path.join(dir, `recording-claude-${crypto.randomUUID()}.cjs`)
  const argvPath = path.join(dir, `argv-${crypto.randomUUID()}.json`)
  fs.writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) { process.stdout.write("2.1.258\\n"); process.exit(0) }
if (process.argv.includes("--help")) { process.stdout.write(${JSON.stringify(help)}); process.exit(0) }
fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)))
readline.createInterface({ input: process.stdin }).on("line", () => {
  const session_id = "fake-session"
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id }) + "\\n")
  process.stdout.write(JSON.stringify({
    type: "assistant", session_id,
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
  }) + "\\n")
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", session_id, is_error: false, duration_ms: 1, num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
  }) + "\\n")
})
`,
  )
  fs.chmodSync(cliPath, 0o755)
  return { cliPath, argvPath }
}

const pluginDirsIn = (argv: string[]) =>
  argv.reduce<string[]>((acc, arg, i) => {
    if (arg === "--plugin-dir") acc.push(argv[i + 1]!)
    return acc
  }, [])

const CALL = {
  prompt: [{ role: "user", content: [{ type: "text", text: "Say done." }] }],
  tools: [{ type: "function", name: "bash", description: "Run", inputSchema: { type: "object", properties: {} } }],
} as any

async function spawnArgsFor(
  transport: "doStream" | "doGenerate",
  settings: { bridgeOpencodeSkills?: boolean },
  help = "--plugin-dir <path>  Load a plugin",
): Promise<string[]> {
  return withFixture(async ({ cwd, projectSkills }) => {
    makeSkill(projectSkills, `${P}spawned`)
    const cli = recordingCli(path.dirname(cwd), help)
    const modelId = `claude-test-skills-${transport}`
    const sk = sessionKey(cwd, `${modelId}::tools::default::context=["claude-code",null]`)
    try {
      const model = createClaudeCode({
        cliPath: cli.cliPath,
        cwd,
        bridgeOpencodeMcp: false,
        proxyOpencodeMcpTools: false,
        proxyTools: [],
        autoContinueIncompleteTurns: false,
        ...settings,
      }).languageModel(modelId)
      if (transport === "doStream") {
        const response = await model.doStream(CALL)
        for await (const _ of response.stream) { /* drain */ }
      } else {
        const result = await model.doGenerate(CALL)
        assert.equal(result.finishReason.unified, "stop")
      }
      return JSON.parse(fs.readFileSync(cli.argvPath, "utf8")) as string[]
    } finally {
      await deleteActiveProcessAndWait(sk)
      deleteClaudeSessionId(sk)
    }
  })
}

test("createClaudeCode leaves the user's skills unbridged unless asked", () => {
  const configOf = (settings: Record<string, unknown>) =>
    (createClaudeCode(settings).languageModel("claude-haiku-4-5") as any).config
  assert.equal(configOf({}).bridgeOpencodeSkills, false)
  assert.equal(configOf({ bridgeOpencodeSkills: true }).bridgeOpencodeSkills, true)
  assert.equal(configOf({ bridgeOpencodeSkills: false }).bridgeOpencodeSkills, false)

  // Dropping what Claude already loads is the other way round: on unless the
  // operator asks for the duplicates back.
  assert.equal(configOf({}).bridgeSkipNativeSkills, true)
  assert.equal(configOf({ bridgeSkipNativeSkills: true }).bridgeSkipNativeSkills, true)
  assert.equal(configOf({ bridgeSkipNativeSkills: false }).bridgeSkipNativeSkills, false)
})

for (const transport of ["doStream", "doGenerate"] as const) {
  test(`${transport} with bridgeOpencodeSkills: true spawns claude with --plugin-dir carrying the user's skills`, async () => {
    const argv = await spawnArgsFor(transport, { bridgeOpencodeSkills: true })
    const dirs = pluginDirsIn(argv)
    assert.equal(dirs.length, 1, `expected one --plugin-dir in ${argv.join(" ")}`)
    assert.deepEqual(skillNames(dirs[0]!), ["claude-code-plugin", `${P}spawned`])
  })

  test(`${transport} stages only the bundled skill by default`, async () => {
    const argv = await spawnArgsFor(transport, {})
    const dirs = pluginDirsIn(argv)
    assert.equal(dirs.length, 1)
    assert.deepEqual(skillNames(dirs[0]!), ["claude-code-plugin"])
  })

  test(`${transport} passes no --plugin-dir to a CLI whose --help does not know the flag`, async () => {
    const argv = await spawnArgsFor(transport, { bridgeOpencodeSkills: true }, "Usage: claude [options]\n  --model <model>")
    assert.equal(argv.includes("--plugin-dir"), false, argv.join(" "))
  })
}

test("buildCliArgs repeats --plugin-dir per directory", () => {
  const args = buildCliArgs({
    sessionKey: "sk-plugin-dirs",
    skipPermissions: true,
    includeSessionResume: false,
    pluginDirs: ["/tmp/a", "/tmp/b"],
  })
  const flags = args.reduce<string[]>((acc, arg, i) => {
    if (arg === "--plugin-dir") acc.push(args[i + 1]!)
    return acc
  }, [])
  assert.deepEqual(flags, ["/tmp/a", "/tmp/b"])
})

test("buildCliArgs omits --plugin-dir when there is nothing to bridge", () => {
  for (const pluginDirs of [undefined, [] as string[]]) {
    const args = buildCliArgs({
      sessionKey: "sk-no-plugin-dirs",
      skipPermissions: true,
      includeSessionResume: false,
      pluginDirs,
    })
    assert.ok(!args.includes("--plugin-dir"))
  }
})
