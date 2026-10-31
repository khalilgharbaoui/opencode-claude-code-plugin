/**
 * Which `/name` messages run the operator's own Claude Code command and so go
 * out without `client_composed` (h #g280).
 *
 * A name qualifies only when a `claude` in this workspace reported it in its
 * `system`/`init` `slash_commands` AND it is not a built-in: a colon name, or
 * a plain name with its definition where Claude Code looks (the config dir,
 * then every `.claude` from the workspace up). Everything else keeps the mark.
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

test("nothing qualifies until a claude in this workspace has reported, which is fail closed", () => {
  const tree = scratch()
  try {
    const command = name("hello")
    tree.write(join(tree.workspace, ".claude", "commands", `${command}.md`))
    const context = { cwd: tree.workspace, configDir: tree.configDir }
    assert.equal(ownCommandIn(text(`/${command}`), context), null)
    // Another workspace's report does not count for this one.
    noteReportedCommands(tree.configDir, initLine([command]))
    assert.equal(ownCommandIn(text(`/${command}`), context), null)
    noteReportedCommands(tree.workspace, initLine([command]))
    assert.equal(ownCommandIn(text(`/${command}`), context), command)
  } finally {
    tree.cleanup()
  }
})

test("a reported plain name needs its definition in one of the places Claude Code looks", () => {
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
      initLine([project, skillShaped, skill, ancestor, user, hidden, "model", "cost"]),
    )
    const context = { cwd: tree.workspace, configDir: tree.configDir }
    for (const own of [project, skillShaped, skill, ancestor, user]) {
      assert.equal(ownCommandIn(text(`/${own} some arguments`), context), own)
    }
    // Built-ins are reported too, and have no file: they keep the mark.
    assert.equal(ownCommandIn(text("/model claude-sonnet-5-5"), context), null)
    assert.equal(ownCommandIn(text("/cost"), context), null)
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
    noteReportedCommands(tree.workspace, initLine(["model"]))
    assert.equal(
      ownCommandIn(text("/model x"), { cwd: tree.workspace, configDir: tree.configDir }),
      "model",
    )
  } finally {
    tree.cleanup()
  }
})

test("a reported colon name is a plugin's or a nested command's, never a built-in", () => {
  const tree = scratch()
  try {
    const plugin = `${name("plugin")}:explain`
    noteReportedCommands(tree.workspace, initLine([plugin]))
    const context = { cwd: tree.workspace, configDir: tree.configDir }
    assert.equal(ownCommandIn(text(`/${plugin} card_declined`), context), plugin)
    assert.equal(ownCommandIn(text(`/${name("other")}:explain`), context), null)
  } finally {
    tree.cleanup()
  }
})

test("only a message that is one text block qualifies", () => {
  const tree = scratch()
  try {
    const command = name("hello")
    tree.write(join(tree.workspace, ".claude", "commands", `${command}.md`))
    noteReportedCommands(tree.workspace, initLine([command]))
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
    const first = name("first")
    const second = name("second")
    for (const command of [first, second]) {
      tree.write(join(tree.workspace, ".claude", "commands", `${command}.md`))
    }
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
    noteReportedCommands(tree.workspace, initLine([command, "model"]))
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
