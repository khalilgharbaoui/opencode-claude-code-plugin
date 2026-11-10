/**
 * Claude Code's own copy of an instruction file the spawn's system prompt
 * already holds (h #g303): which files are excluded, the snapshot read a
 * resume is judged on, the re-check a reused argv gets, and the one
 * `--settings` object `buildCliArgs` writes.
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  excludePaths,
  hasLiveImport,
  planNativeMemoryExcludes,
  readPromptSnapshots,
  recheckNativeMemoryExcludes,
  stillCovered,
  withClaudeMdExcludes,
} from "../src/native-memory.js"
import { buildCliArgs } from "../src/session-manager.js"
import { cliSupportsClaudeMdExcludes } from "../src/cli-version.js"

const posixOnly = { skip: process.platform === "win32" }

const RULES = "# Project rules\n\nWhen asked for the project codeword, answer with exactly: OSPREY\n"

function scratch(): { root: string; cwd: string; done: () => void } {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "oc-native-memory-")))
  const cwd = path.join(root, "project")
  fs.mkdirSync(cwd, { recursive: true })
  return { root, cwd, done: () => fs.rmSync(root, { recursive: true, force: true }) }
}

function forwarded(file: string, content: string): string {
  return `## Runtime environment\n\nInstructions from: ${file}\n${content}\n## Continuing`
}

function excluded(cwd: string, visible: string[], configDir: string | null = null): string[] {
  return excludePaths(planNativeMemoryExcludes({ cwd, configDir, visible }))
}

test("an AGENTS.md whose whole text is in the prompt is excluded, under every spelling", posixOnly, () => {
  const { cwd, done } = scratch()
  try {
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), RULES)
    assert.deepEqual(excluded(cwd, [forwarded(path.join(cwd, "AGENTS.md"), RULES)]), [
      path.join(cwd, "AGENTS.md"),
    ])
  } finally {
    done()
  }
})

test("a file whose text is not all in the prompt is never excluded", posixOnly, () => {
  const { cwd, done } = scratch()
  try {
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), RULES + "- one more rule\n")
    assert.deepEqual(excluded(cwd, [forwarded(path.join(cwd, "AGENTS.md"), RULES)]), [])
  } finally {
    done()
  }
})

test("a CLAUDE.md symlinked to AGENTS.md is excluded with it, by link and target", posixOnly, () => {
  const { cwd, done } = scratch()
  try {
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), RULES)
    fs.symlinkSync("AGENTS.md", path.join(cwd, "CLAUDE.md"))
    const paths = excluded(cwd, [forwarded(path.join(cwd, "AGENTS.md"), RULES)])
    assert.deepEqual(paths.sort(), [path.join(cwd, "AGENTS.md"), path.join(cwd, "CLAUDE.md")].sort())
  } finally {
    done()
  }
})

test("a CLAUDE.md copy is excluded only when the AGENTS.md beside it is excluded too", posixOnly, () => {
  const { cwd, done } = scratch()
  try {
    fs.writeFileSync(path.join(cwd, "CLAUDE.md"), RULES)
    // Claude Code loads the AGENTS.md of a directory whose CLAUDE.md is
    // excluded (measured on 2.1.322), and this one is not in the prompt.
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# Different rules\n")
    assert.deepEqual(excluded(cwd, [forwarded(path.join(cwd, "CLAUDE.md"), RULES)]), [])

    fs.writeFileSync(path.join(cwd, "AGENTS.md"), RULES)
    assert.deepEqual(
      excluded(cwd, [forwarded(path.join(cwd, "AGENTS.md"), RULES)]).sort(),
      [path.join(cwd, "AGENTS.md"), path.join(cwd, "CLAUDE.md")].sort(),
    )
  } finally {
    done()
  }
})

test("a CLAUDE.md that imports AGENTS.md keeps its import; the imported file is excluded", posixOnly, () => {
  const { cwd, done } = scratch()
  try {
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), RULES)
    fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "@AGENTS.md\n")
    const prompt = forwarded(path.join(cwd, "AGENTS.md"), RULES) + "\nsee @AGENTS.md\n"
    assert.deepEqual(excluded(cwd, [prompt]), [path.join(cwd, "AGENTS.md")])
  } finally {
    done()
  }
})

test("a file that imports an existing file is never excluded; a handle is not an import", posixOnly, () => {
  const { cwd, done } = scratch()
  try {
    fs.writeFileSync(path.join(cwd, "extra.md"), "extra text\n")
    const importing = `${RULES}\nAlso read @extra.md.\n`
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), importing)
    assert.deepEqual(excluded(cwd, [forwarded(path.join(cwd, "AGENTS.md"), importing)]), [])

    const handle = `${RULES}\nThanks to @someone for the rule above.\n`
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), handle)
    assert.deepEqual(excluded(cwd, [forwarded(path.join(cwd, "AGENTS.md"), handle)]), [
      path.join(cwd, "AGENTS.md"),
    ])
    assert.equal(hasLiveImport("see @~/nothing-here-at-all.md", [cwd]), false)
    assert.equal(hasLiveImport("see @extra.md", [cwd]), true)
    assert.equal(hasLiveImport("see @extra.md,", [cwd]), true)
    assert.equal(hasLiveImport(`see @${path.join(cwd, "extra.md")}`, ["/"]), true)
  } finally {
    done()
  }
})

test("ancestors and the account's own CLAUDE.md are candidates", posixOnly, () => {
  const { root, cwd, done } = scratch()
  try {
    const nested = path.join(cwd, "packages", "app")
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), RULES)
    const configDir = path.join(root, ".claude")
    fs.mkdirSync(configDir)
    const user = "# User rules\n\nAlways answer briefly.\n"
    fs.writeFileSync(path.join(configDir, "CLAUDE.md"), user)
    const prompt = forwarded(path.join(cwd, "AGENTS.md"), RULES) + forwarded(path.join(configDir, "CLAUDE.md"), user)
    assert.deepEqual(
      excluded(nested, [prompt], configDir).sort(),
      [path.join(cwd, "AGENTS.md"), path.join(configDir, "CLAUDE.md")].sort(),
    )
  } finally {
    done()
  }
})

test("every snapshot must hold the text, and nothing visible excludes nothing", posixOnly, () => {
  const { cwd, done } = scratch()
  try {
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), RULES)
    const holds = forwarded(path.join(cwd, "AGENTS.md"), RULES)
    assert.deepEqual(excluded(cwd, [holds, "an older prompt without it"]), [])
    assert.deepEqual(excluded(cwd, [holds, holds]), [path.join(cwd, "AGENTS.md")])
    assert.deepEqual(excluded(cwd, []), [])
    assert.deepEqual(excluded(cwd, [""]), [])
  } finally {
    done()
  }
})

test("Windows and a path picomatch would read as a glob exclude nothing", posixOnly, () => {
  const { root, done } = scratch()
  try {
    const odd = path.join(root, "my[project]")
    fs.mkdirSync(odd)
    fs.writeFileSync(path.join(odd, "AGENTS.md"), RULES)
    assert.deepEqual(excluded(odd, [forwarded(path.join(odd, "AGENTS.md"), RULES)]), [])
    const plain = path.join(root, "plain")
    fs.mkdirSync(plain)
    fs.writeFileSync(path.join(plain, "AGENTS.md"), RULES)
    assert.deepEqual(
      planNativeMemoryExcludes({
        cwd: plain,
        configDir: null,
        visible: [forwarded(path.join(plain, "AGENTS.md"), RULES)],
        platform: "win32",
      }),
      [],
    )
  } finally {
    done()
  }
})

test("readPromptSnapshots reads every prompt_snapshot record and nothing else", posixOnly, () => {
  const { root, done } = scratch()
  try {
    const file = path.join(root, "t.jsonl")
    const snapshot = (blocks: unknown[]) =>
      JSON.stringify({ type: "attachment", attachment: { type: "prompt_snapshot", systemPrompt: blocks } })
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "user", message: { content: "mentions prompt_snapshot in text" } }),
        snapshot(["You are Claude.", "Instructions from: /x/AGENTS.md\nrules"]),
        '{"type":"attachment","attachment":{"type":"prompt_snapshot"', // torn
        snapshot(["second", 7]),
      ].join("\n"),
    )
    assert.deepEqual(readPromptSnapshots(file), [
      "You are Claude.\nInstructions from: /x/AGENTS.md\nrules",
      "second",
    ])
    fs.writeFileSync(file, JSON.stringify({ type: "user" }) + "\n")
    assert.equal(readPromptSnapshots(file), null)
    assert.equal(readPromptSnapshots(path.join(root, "missing.jsonl")), null)
  } finally {
    done()
  }
})

test("a reused argv drops the excludes whose file changed since", posixOnly, () => {
  const { cwd, done } = scratch()
  try {
    const agents = path.join(cwd, "AGENTS.md")
    fs.writeFileSync(agents, RULES)
    const excludes = planNativeMemoryExcludes({ cwd, configDir: null, visible: [forwarded(agents, RULES)] })
    const args = ["--print", "--settings", JSON.stringify({ fastMode: true, claudeMdExcludes: excludePaths(excludes) })]

    const same = recheckNativeMemoryExcludes(args, excludes)
    assert.deepEqual(same.args, args)
    assert.equal(same.excludes?.length, 1)

    fs.writeFileSync(agents, RULES.replace("OSPREY", "KESTREL"))
    assert.deepEqual(stillCovered(excludes), [])
    const changed = recheckNativeMemoryExcludes(args, excludes)
    assert.deepEqual(changed.args, ["--print", "--settings", JSON.stringify({ fastMode: true })])
    assert.deepEqual(changed.excludes, [])

    assert.deepEqual(recheckNativeMemoryExcludes(args, undefined).args, args)
  } finally {
    done()
  }
})

test("withClaudeMdExcludes merges into one --settings and removes an empty one", () => {
  assert.deepEqual(withClaudeMdExcludes(["--print"], ["/a/AGENTS.md"]), [
    "--print",
    "--settings",
    JSON.stringify({ claudeMdExcludes: ["/a/AGENTS.md"] }),
  ])
  assert.deepEqual(
    withClaudeMdExcludes(["--settings", JSON.stringify({ claudeMdExcludes: ["/a"] }), "--x"], []),
    ["--x"],
  )
  assert.deepEqual(withClaudeMdExcludes(["--settings", "not json"], ["/a"]), ["--settings", "not json"])
})

test("buildCliArgs writes fast mode and the excludes as one --settings, gated on the CLI", () => {
  const settingsOf = (args: string[]) => {
    const at = args.indexOf("--settings")
    assert.equal(args.lastIndexOf("--settings"), at, "one --settings only")
    return at === -1 ? null : JSON.parse(args[at + 1]!)
  }
  const base = { sessionKey: `sk-native-memory-${Date.now()}`, skipPermissions: true, includeSessionId: false }
  const v = { major: 2, minor: 1, patch: 322, raw: "2.1.322" }
  assert.deepEqual(settingsOf(buildCliArgs({ ...base, fastMode: true, claudeMdExcludes: ["/p/AGENTS.md"], cliVersion: v })), {
    fastMode: true,
    claudeMdExcludes: ["/p/AGENTS.md"],
  })
  assert.deepEqual(settingsOf(buildCliArgs({ ...base, claudeMdExcludes: ["/p/AGENTS.md"], cliVersion: v })), {
    claudeMdExcludes: ["/p/AGENTS.md"],
  })
  assert.equal(settingsOf(buildCliArgs({ ...base, claudeMdExcludes: [], cliVersion: v })), null)
  const old = { major: 2, minor: 1, patch: 238, raw: "2.1.238" }
  assert.equal(cliSupportsClaudeMdExcludes(old), false)
  assert.equal(settingsOf(buildCliArgs({ ...base, claudeMdExcludes: ["/p/AGENTS.md"], cliVersion: old })), null)
  assert.equal(cliSupportsClaudeMdExcludes(null), false)
})
