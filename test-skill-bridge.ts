import assert from "node:assert/strict"
import { test } from "node:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  SKILL_PLUGIN_NAME,
  buildSkillPluginDir,
  discoverOpencodeSkills,
  resolveSkillPluginDirs,
} from "./src/skill-bridge.js"
import { buildCliArgs } from "./src/session-manager.js"

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

/** Run `fn` with a scratch tree and env isolated from the real machine. */
function withFixture<T>(
  fn: (paths: { cwd: string; projectSkills: string; globalSkills: string }) => T,
): T {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "skill-bridge-test-"))
  const cwd = path.join(base, "workspace")
  const projectSkills = path.join(cwd, ".opencode", "skills")
  const xdg = path.join(base, "xdg")
  const globalSkills = path.join(xdg, "opencode", "skills")
  fs.mkdirSync(projectSkills, { recursive: true })
  fs.mkdirSync(globalSkills, { recursive: true })

  const prevXdg = process.env.XDG_CONFIG_HOME
  const prevConfigDir = process.env.OPENCODE_CONFIG_DIR
  process.env.XDG_CONFIG_HOME = xdg
  delete process.env.OPENCODE_CONFIG_DIR
  try {
    return fn({ cwd, projectSkills, globalSkills })
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdg
    if (prevConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = prevConfigDir
    fs.rmSync(base, { recursive: true, force: true })
  }
}

const fixtures = (skills: { name: string }[]) =>
  skills.filter((s) => s.name.startsWith(P))

test("discovers skills from both project and global roots", () => {
  withFixture(({ cwd, projectSkills, globalSkills }) => {
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

test("a project skill shadows a global skill of the same name", () => {
  withFixture(({ cwd, projectSkills, globalSkills }) => {
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

test("directories without a SKILL.md are ignored", () => {
  withFixture(({ cwd, projectSkills }) => {
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

test("staged plugin dir carries a manifest and one entry per skill", () => {
  withFixture(({ cwd, projectSkills }) => {
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

test("staging is reused for an identical skill set and rekeyed when it changes", () => {
  withFixture(({ cwd, projectSkills }) => {
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

test("resolveSkillPluginDirs returns nothing when disabled", async () => {
  await withFixture(async ({ cwd, projectSkills }) => {
    makeSkill(projectSkills, `${P}off`)
    const dirs = await resolveSkillPluginDirs({
      cwd,
      cliPath: "claude",
      enabled: false,
    })
    assert.deepEqual(dirs, [], "disabled must short-circuit before probing")
  })
})

test("resolveSkillPluginDirs skips the flag probe when there are no skills", async () => {
  await withFixture(async ({ cwd }) => {
    // cliPath is deliberately bogus: if the probe ran, it would be spawned.
    const dirs = await resolveSkillPluginDirs({
      cwd,
      cliPath: "/nonexistent/claude-binary",
      enabled: true,
    })
    assert.deepEqual(dirs, [])
  })
})

test("resolveSkillPluginDirs degrades to no-op when the CLI lacks --plugin-dir", async () => {
  await withFixture(async ({ cwd, projectSkills }) => {
    makeSkill(projectSkills, `${P}unsupported`)
    const dirs = await resolveSkillPluginDirs({
      cwd,
      cliPath: "/nonexistent/claude-binary",
      enabled: true,
    })
    assert.deepEqual(dirs, [], "an unprobeable CLI must not get the flag")
  })
})

test("buildCliArgs repeats --plugin-dir per directory", () => {
  const args = buildCliArgs({
    sessionKey: "sk-plugin-dirs",
    skipPermissions: true,
    includeSessionId: false,
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
      includeSessionId: false,
      pluginDirs,
    })
    assert.ok(!args.includes("--plugin-dir"))
  }
})
