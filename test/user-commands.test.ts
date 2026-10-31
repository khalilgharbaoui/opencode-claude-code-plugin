/**
 * Which `/name` messages run the operator's own Claude Code command and so go
 * out without `client_composed` (h #g280, h #g281).
 *
 * A name qualifies when its definition is where Claude Code reads it (the
 * config dir, then every `.claude` from the workspace up to its git root,
 * never the home dir's), from the first message on: no `claude` has to have
 * reported it. A plugin's colon name has no file to check, so it qualifies
 * once a `claude` in this workspace listed it in `slash_commands`. Built-ins
 * have no file and keep the mark, and so does everything else.
 *
 * Portable on purpose: no fake CLI, only files in a scratch tree, so it runs on
 * the Windows job too. Command names carry a random suffix so nothing on the
 * machine running it can match one.
 *
 * Usage: npx tsx --test test/user-commands.test.ts
 */
import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { getClaudeUserMessage } from "../src/message-builder.js"
import {
  _resetReportedCommandsForTests,
  leadingCommandName,
  noteReportedCommands,
  ownCommandIn,
} from "../src/user-commands.js"

afterEach(() => _resetReportedCommandsForTests())

const SUFFIX = Math.random().toString(36).slice(2, 8)
const name = (base: string) => `${base}-${SUFFIX}`

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "opencode-own-commands-"))
  const workspace = join(root, "outer", "workspace")
  const configDir = join(root, "config")
  mkdirSync(workspace, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  const write = (path: string, frontmatter = "description: probe") => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `---\n${frontmatter}\n---\nReply with a codeword.\n`)
  }
  return { root, workspace, configDir, write, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const initLine = (names: string[]) =>
  JSON.stringify({ type: "system", subtype: "init", session_id: "s", slash_commands: names })
const text = (value: string) => [{ type: "text", text: value }]

test("leadingCommandName reads the /name a message opens with, and nothing else", () => {
  assert.equal(leadingCommandName("/hello-probe"), "hello-probe")
  assert.equal(leadingCommandName("/arg-probe FALCON"), "arg-probe")
  assert.equal(leadingCommandName("/stripe:explain-error card_declined"), "stripe:explain-error")
  assert.equal(leadingCommandName("/hello\nmore"), "hello")
  assert.equal(leadingCommandName("/etc/hosts is broken"), null)
  assert.equal(leadingCommandName(" /hello"), null)
  assert.equal(leadingCommandName("say /hello"), null)
  assert.equal(leadingCommandName("/"), null)
  assert.equal(leadingCommandName("@notes.txt what is in it?"), null)
})

test("a defined command qualifies on the first message, before any claude has reported", () => {
  const tree = scratch()
  try {
    const command = name("hello")
    tree.write(join(tree.workspace, ".claude", "commands", `${command}.md`))
    const context = { cwd: tree.workspace, configDir: tree.configDir }
    // h #g280 waited for a report here, so the first message in a folder kept
    // the mark; the file is what makes it the operator's (h #g281).
    assert.equal(ownCommandIn(text(`/${command}`), context), command)
    // A report from anywhere changes nothing for a name that has its file.
    noteReportedCommands(tree.configDir, initLine([]))
    assert.equal(ownCommandIn(text(`/${command}`), context), command)
  } finally {
    tree.cleanup()
  }
})

test("a plain name needs its definition in one of the places Claude Code looks, reported or not", () => {
  const tree = scratch()
  try {
    const project = name("project")
    const skillShaped = name("skillshaped")
    const skill = name("skill")
    const ancestor = name("ancestor")
    const user = name("user")
    const hidden = name("hidden")
    tree.write(join(tree.workspace, ".claude", "commands", `${project}.md`))
    tree.write(join(tree.workspace, ".claude", "commands", skillShaped, "SKILL.md"))
    tree.write(join(tree.workspace, ".claude", "skills", skill, "SKILL.md"))
    tree.write(join(tree.root, "outer", ".claude", "commands", `${ancestor}.md`))
    tree.write(join(tree.configDir, "commands", `${user}.md`))
    tree.write(
      join(tree.workspace, ".claude", "skills", hidden, "SKILL.md"),
      "description: probe\nuser-invocable: false",
    )
    noteReportedCommands(
      tree.workspace,
      initLine([project, skillShaped, skill, ancestor, user, hidden, name("gone"), "model", "cost"]),
    )
    const context = { cwd: tree.workspace, configDir: tree.configDir }
    for (const own of [project, skillShaped, skill, ancestor, user]) {
      assert.equal(ownCommandIn(text(`/${own} some arguments`), context), own)
    }
    // Built-ins are reported too, and have no file: they keep the mark.
    // So does an own name nothing defines any more, whatever was reported.
    assert.equal(ownCommandIn(text("/model claude-sonnet-5-5"), context), null)
    assert.equal(ownCommandIn(text("/cost"), context), null)
    assert.equal(ownCommandIn(text(`/${name("gone")}`), context), null)
    // Claude Code leaves a `user-invocable: false` skill out of its list; so do we.
    assert.equal(ownCommandIn(text(`/${hidden}`), context), null)
    // The user scope is the config dir this spawn reads, and only that.
    assert.equal(ownCommandIn(text(`/${user}`), { cwd: tree.workspace, configDir: null }), null)
  } finally {
    tree.cleanup()
  }
})

test("a user file named like a built-in is the operator's command, because it is what runs", () => {
  const tree = scratch()
  try {
    tree.write(join(tree.workspace, ".claude", "commands", "model.md"))
    assert.equal(
      ownCommandIn(text("/model x"), { cwd: tree.workspace, configDir: tree.configDir }),
      "model",
    )
  } finally {
    tree.cleanup()
  }
})

test("the walk stops at the git root and before the home dir, as the CLI's own does", () => {
  const tree = scratch()
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  try {
    // Measured on 2.1.314 through `initialize`: from a repository's
    // subdirectory the CLI lists the git root's commands and not the ones
    // above it (h #g281).
    const above = name("above")
    const atRoot = name("atroot")
    const repo = join(tree.workspace, "repo")
    mkdirSync(join(repo, ".git"), { recursive: true })
    tree.write(join(tree.workspace, ".claude", "commands", `${above}.md`))
    tree.write(join(repo, ".claude", "commands", `${atRoot}.md`))
    const inRepo = { cwd: join(repo, "sub"), configDir: tree.configDir }
    mkdirSync(inRepo.cwd, { recursive: true })
    assert.equal(ownCommandIn(text(`/${atRoot}`), inRepo), atRoot)
    assert.equal(ownCommandIn(text(`/${above}`), inRepo), null)

    // The home dir's `.claude` is the user scope, read through the config dir
    // only, and the walk goes no higher.
    const home = join(tree.root, "home")
    const homeOnly = name("homeonly")
    const aboveHome = name("abovehome")
    tree.write(join(home, ".claude", "commands", `${homeOnly}.md`))
    tree.write(join(tree.root, ".claude", "commands", `${aboveHome}.md`))
    process.env.HOME = home
    process.env.USERPROFILE = home
    const inHome = { cwd: join(home, "project"), configDir: tree.configDir }
    mkdirSync(inHome.cwd, { recursive: true })
    assert.equal(ownCommandIn(text(`/${homeOnly}`), inHome), null)
    assert.equal(ownCommandIn(text(`/${aboveHome}`), inHome), null)
    assert.equal(ownCommandIn(text(`/${homeOnly}`), { ...inHome, configDir: join(home, ".claude") }), homeOnly)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    tree.cleanup()
  }
})

test("a nested command qualifies by its file at any depth, before any report", () => {
  const tree = scratch()
  try {
    const nested = `ns-${SUFFIX}:${name("nested")}`
    const deeper = `ns-${SUFFIX}:deep:${name("deeper")}`
    tree.write(join(tree.workspace, ".claude", "commands", `ns-${SUFFIX}`, `${name("nested")}.md`))
    tree.write(join(tree.workspace, ".claude", "commands", `ns-${SUFFIX}`, "deep", `${name("deeper")}.md`))
    const context = { cwd: tree.workspace, configDir: tree.configDir }
    assert.equal(ownCommandIn(text(`/${nested} with arguments`), context), nested)
    assert.equal(ownCommandIn(text(`/${deeper}`), context), deeper)
    // A segment is one path component: nothing walks out of a root.
    tree.write(join(tree.workspace, ".claude", `${name("escaped")}.md`))
    assert.equal(ownCommandIn(text(`/..:${name("escaped")}`), context), null)
    assert.equal(ownCommandIn(text(`/ns-${SUFFIX}::${name("nested")}`), context), null)
  } finally {
    tree.cleanup()
  }
})

test("a plugin's colon name, which has no file to check, qualifies once a claude here reported it", () => {
  const tree = scratch()
  try {
    const plugin = `${name("plugin")}:explain`
    const context = { cwd: tree.workspace, configDir: tree.configDir }
    assert.equal(ownCommandIn(text(`/${plugin} card_declined`), context), null)
    // Another workspace's report does not count for this one.
    noteReportedCommands(tree.configDir, initLine([plugin]))
    assert.equal(ownCommandIn(text(`/${plugin} card_declined`), context), null)
    noteReportedCommands(tree.workspace, initLine([plugin]))
    assert.equal(ownCommandIn(text(`/${plugin} card_declined`), context), plugin)
    assert.equal(ownCommandIn(text(`/${name("other")}:explain`), context), null)
    // A plain name is never taken on a report alone: built-ins are reported too.
    noteReportedCommands(tree.workspace, initLine([plugin, name("plain")]))
    assert.equal(ownCommandIn(text(`/${name("plain")}`), context), null)
  } finally {
    tree.cleanup()
  }
})

test("only a message that is one text block qualifies", () => {
  const tree = scratch()
  try {
    const command = name("hello")
    tree.write(join(tree.workspace, ".claude", "commands", `${command}.md`))
    const context = { cwd: tree.workspace, configDir: tree.configDir }
    assert.equal(
      ownCommandIn([{ type: "text", text: "history" }, ...text(`/${command}`)], context),
      null,
    )
    assert.equal(
      ownCommandIn([...text(`/${command}`), { type: "image", source: {} }], context),
      null,
    )
    assert.equal(ownCommandIn([{ type: "tool_result", tool_use_id: "t", content: "x" }], context), null)
    assert.equal(ownCommandIn([], context), null)
  } finally {
    tree.cleanup()
  }
})

test("noteReportedCommands reads only init frames and keeps the newest per workspace", () => {
  const tree = scratch()
  try {
    // Plugin names, because a report is read only for a name with no file.
    const first = `${name("first")}:run`
    const second = `${name("second")}:run`
    const context = { cwd: tree.workspace, configDir: tree.configDir }
    noteReportedCommands(tree.workspace, "not json \"slash_commands\"")
    noteReportedCommands(
      tree.workspace,
      JSON.stringify({ type: "system", subtype: "status", slash_commands: [first] }),
    )
    noteReportedCommands(
      tree.workspace,
      JSON.stringify({ type: "system", subtype: "init", slash_commands: "nope" }),
    )
    assert.equal(ownCommandIn(text(`/${first}`), context), null)
    noteReportedCommands(tree.workspace, initLine([first]))
    noteReportedCommands(tree.workspace, initLine([second]))
    assert.equal(ownCommandIn(text(`/${first}`), context), null)
    assert.equal(ownCommandIn(text(`/${second}`), context), second)
  } finally {
    tree.cleanup()
  }
})

test("getClaudeUserMessage leaves an own command unstamped only while verbatimPrompts is on", () => {
  const tree = scratch()
  try {
    const command = name("hello")
    tree.write(join(tree.workspace, ".claude", "commands", `${command}.md`))
    const ownCommands = { cwd: tree.workspace, configDir: tree.configDir }
    const envelope = (value: string, verbatimPrompts: boolean) =>
      JSON.parse(
        getClaudeUserMessage([{ role: "user", content: text(value) }] as any, false, {
          verbatimPrompts,
          ownCommands,
        }),
      )
    assert.equal("client_composed" in envelope(`/${command} now`, true), false)
    assert.equal(envelope("/model claude-sonnet-5-5", true).client_composed, true)
    assert.equal(envelope("plain text", true).client_composed, true)
    assert.equal("client_composed" in envelope(`/${command}`, false), false)
    assert.equal("client_composed" in envelope("/model x", false), false)
    // Without the context the old rule holds: everything stamped.
    const unchanged = JSON.parse(
      getClaudeUserMessage([{ role: "user", content: text(`/${command}`) }] as any, false, {
        verbatimPrompts: true,
      }),
    )
    assert.equal(unchanged.client_composed, true)
  } finally {
    tree.cleanup()
  }
})
