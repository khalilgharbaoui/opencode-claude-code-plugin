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
  discoverBundledSkills,
  discoverOpencodeSkills,
  registerBundledSkillPath,
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
async function withFixture<T>(
  fn: (paths: { cwd: string; projectSkills: string; globalSkills: string }) => T,
): Promise<Awaited<T>> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "skill-bridge-test-"))
  const cwd = path.join(base, "workspace")
  const projectSkills = path.join(cwd, ".opencode", "skills")
  const xdg = path.join(base, "xdg")
  const globalSkills = path.join(xdg, "opencode", "skills")
  fs.mkdirSync(projectSkills, { recursive: true })
  fs.mkdirSync(globalSkills, { recursive: true })

  const prevXdg = process.env.XDG_CONFIG_HOME
  const prevConfigDir = process.env.OPENCODE_CONFIG_DIR
  const prevHome = process.env.HOME
  process.env.HOME = base
  process.env.XDG_CONFIG_HOME = xdg
  delete process.env.OPENCODE_CONFIG_DIR
  try {
    return await fn({ cwd, projectSkills, globalSkills })
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdg
    if (prevConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = prevConfigDir
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
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
