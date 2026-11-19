/**
 * Claude Code's own commands and skills in opencode (h #g322): the list the
 * CLI's `initialize` answer carries, the store it is kept in, the `/` menu
 * planned from it, the short-name rule, and what a message that runs one of
 * them looks like when it leaves for the CLI.
 *
 * Portable on purpose: no fake CLI, only a scratch store and scratch files,
 * so it runs on the Windows job too. The probe and both majors' wiring are
 * `test/claude-command-probe.test.ts`; the stdin line a real `doStream`
 * writes is `test/claude-commands-stream.test.ts`.
 *
 * Usage: npx tsx --test test/claude-commands.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  _resetClaudeCommandStoreForTests,
  type ClaudeCommand,
  claudeCommandStorePath,
  claudeCommandText,
  cliCommandsFor,
  commandsFromInitialize,
  isClaudeMenuDescription,
  MAX_COMMAND_ENTRIES,
  MAX_DESCRIPTION_CHARS,
  menuDescription,
  OPENCODE_RESERVED_COMMAND_NAMES,
  opencodeCommandNames,
  planClaudeMenu,
  readCommandEntries,
  resolveShortCommandName,
  writeCommandEntry,
} from "../src/claude-commands.js"
import { getClaudeUserMessage } from "../src/message-builder.js"
import { _resetReportedCommandsForTests, expandShortCommand, ownCommandIn } from "../src/user-commands.js"

afterEach(() => {
  _resetClaudeCommandStoreForTests()
  _resetReportedCommandsForTests()
})

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "opencode-claude-commands-"))
  const store = join(root, "state", "claude-commands.json")
  _resetClaudeCommandStoreForTests(store)
  const workspace = join(root, "project")
  const configDir = join(root, "config")
  mkdirSync(workspace, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  return { root, store, workspace, configDir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const SUFFIX = Math.random().toString(36).slice(2, 8)
const name = (base: string) => `${base}-${SUFFIX}`

/** Rows shaped exactly like 2.1.322's `initialize` answer. */
const INITIALIZE = {
  commands: [
    { name: "hello-probe", description: "Say hello from a probe command (project)", argumentHint: "" },
    {
      name: "stripe:test-cards",
      description: "(stripe) Display Stripe test card numbers for various testing scenarios",
      argumentHint: "scenario",
      builtin: null,
    },
    {
      name: "appical-core:release",
      description: "(appical-core) Cut a production release of the current repo: planned, filtered or hotfix.",
      argumentHint: "",
    },
    { name: "compact", description: "Free up context by summarizing the conversation so far", builtin: true },
    { name: "model", description: "Set the AI model for Claude Code", argumentHint: "<model>", builtin: true },
    { name: "has space", description: "dropped" },
    { name: "../escape", description: "dropped" },
    { name: "hello-probe", description: "a second row of one name is dropped" },
  ],
  account: { email: "someone@example.com", organization: "Example Org", subscriptionType: "max" },
}

const text = (value: string) => [{ type: "text", text: value }]

test("commandsFromInitialize keeps name, description and the built-in flag, and nothing else", () => {
  const commands = commandsFromInitialize(INITIALIZE)
  assert.deepEqual(commands, [
    { name: "hello-probe", description: "Say hello from a probe command (project)" },
    {
      name: "stripe:test-cards",
      description: "(stripe) Display Stripe test card numbers for various testing scenarios",
    },
    {
      name: "appical-core:release",
      description: "(appical-core) Cut a production release of the current repo: planned, filtered or hotfix.",
    },
    { name: "compact", description: "Free up context by summarizing the conversation so far", builtin: true },
    { name: "model", description: "Set the AI model for Claude Code", builtin: true },
  ])
  assert.equal(commandsFromInitialize({ models: [] }), null, "a CLI without the field lists nothing")
  assert.equal(commandsFromInitialize(null), null)
  const long = commandsFromInitialize({ commands: [{ name: "long", description: `a  \n${"x".repeat(500)}` }] })
  assert.ok(long![0]!.description!.length <= MAX_DESCRIPTION_CHARS)
  assert.ok(long![0]!.description!.startsWith("a x"), "whitespace is folded")
  assert.ok(long![0]!.description!.endsWith("..."))
})

test("the store keeps one entry per config dir and folder, merges writers, and never holds the account", () => {
  const box = scratch()
  try {
    const commands = commandsFromInitialize(INITIALIZE)!
    assert.equal(writeCommandEntry({ configDir: box.configDir, cwd: box.workspace, probedAt: 1, commands }), true)
    const other = join(box.root, "other-config")
    writeCommandEntry({ configDir: other, cwd: box.workspace, probedAt: 2, commands: [{ name: "solo" }] })
    writeCommandEntry({ configDir: box.configDir, cwd: box.workspace, probedAt: 3, commands: [{ name: "replaced" }] })
    const entries = readCommandEntries(box.store)
    assert.deepEqual(
      entries.map((entry) => [entry.configDir, entry.probedAt, entry.commands.map((command) => command.name)]),
      [
        [box.configDir, 3, ["replaced"]],
        [other, 2, ["solo"]],
      ],
    )
    const raw = readFileSync(box.store, "utf8")
    assert.doesNotMatch(raw, /someone@example\.com|Example Org|argumentHint/)
    if (process.platform !== "win32") {
      assert.equal(statSync(box.store).mode & 0o777, 0o600)
      assert.equal(statSync(dirname(box.store)).mode & 0o777, 0o700)
    }
  } finally {
    box.cleanup()
  }
})

test("the store is bounded, and a broken or wrongly shaped file is an empty store", () => {
  const box = scratch()
  try {
    for (let index = 0; index < MAX_COMMAND_ENTRIES + 5; index++) {
      writeCommandEntry({ configDir: box.configDir, cwd: join(box.root, `folder-${index}`), probedAt: index, commands: [] })
    }
    assert.equal(readCommandEntries(box.store).length, MAX_COMMAND_ENTRIES)
    writeFileSync(box.store, "{ not json")
    assert.deepEqual(readCommandEntries(box.store), [])
    writeFileSync(box.store, JSON.stringify({ entries: [{ configDir: 1 }, { configDir: "x", cwd: "y" }] }))
    assert.deepEqual(readCommandEntries(box.store), [])
    assert.equal(claudeCommandStorePath(), box.store)
  } finally {
    box.cleanup()
  }
})

test("cliCommandsFor answers for the folder or the nearest probed folder above it, per config dir", () => {
  const box = scratch()
  try {
    const sub = join(box.workspace, "packages", "app")
    mkdirSync(sub, { recursive: true })
    writeCommandEntry({ configDir: box.configDir, cwd: box.root, probedAt: 1, commands: [{ name: "root-level" }] })
    writeCommandEntry({ configDir: box.configDir, cwd: box.workspace, probedAt: 2, commands: [{ name: "project-level" }] })
    assert.deepEqual(cliCommandsFor(box.configDir, sub)?.map((command) => command.name), ["project-level"])
    assert.deepEqual(cliCommandsFor(box.configDir, box.workspace)?.map((command) => command.name), ["project-level"])
    assert.deepEqual(cliCommandsFor(box.configDir, join(box.root, "elsewhere"))?.map((command) => command.name), [
      "root-level",
    ])
    assert.equal(cliCommandsFor(join(box.root, "another-config"), sub), null, "another config dir's list is not this one's")
    assert.equal(cliCommandsFor(box.configDir, tmpdir()), null, "a folder nothing above was probed")
    assert.equal(cliCommandsFor(box.configDir, `${box.workspace}-sibling`)?.[0]?.name, "root-level", "a prefix is not a parent")
  } finally {
    box.cleanup()
  }
})

const plugin = (full: string, description?: string): ClaudeCommand => ({
  name: full,
  ...(description ? { description } : {}),
})

test("the menu offers a unique plugin skill under its short name and never a built-in", () => {
  const plan = planClaudeMenu(commandsFromInitialize(INITIALIZE)!, new Set())
  assert.deepEqual(
    plan.entries.map((entry) => [entry.name, entry.command]),
    [
      ["hello-probe", "hello-probe"],
      ["release", "appical-core:release"],
      ["test-cards", "stripe:test-cards"],
    ],
  )
  assert.equal(
    plan.entries.find((entry) => entry.name === "test-cards")?.description,
    "Claude Code: (stripe) Display Stripe test card numbers for various testing scenarios",
  )
  assert.deepEqual(plan.taken, [])
})

test("a short name two plugins share, or one a listed command already is, stays a full name", () => {
  const plan = planClaudeMenu(
    [plugin("one:release"), plugin("two:release"), plugin("notes"), plugin("docs:notes"), plugin("solo:verify")],
    new Set(),
  )
  assert.deepEqual(
    plan.entries.map((entry) => [entry.name, entry.command]),
    [
      ["docs:notes", "docs:notes"],
      ["notes", "notes"],
      ["one:release", "one:release"],
      ["two:release", "two:release"],
      ["verify", "solo:verify"],
    ],
  )
  const builtinNamed = planClaudeMenu([plugin("x:verify"), { name: "verify", builtin: true }], new Set())
  assert.deepEqual(builtinNamed.entries.map((entry) => entry.name), ["x:verify"], "a built-in's name is never taken over")
})

test("a name opencode already answers is opencode's: the short name falls back, a full name is left out", () => {
  const plan = planClaudeMenu(
    [plugin("stripe:test-cards"), plugin("tools:init"), plugin("mytpl"), plugin("status"), plugin("x:mytpl")],
    new Set(["test-cards", "mytpl"]),
  )
  assert.deepEqual(
    plan.entries.map((entry) => [entry.name, entry.command]),
    [
      ["stripe:test-cards", "stripe:test-cards"],
      ["tools:init", "tools:init"],
      ["x:mytpl", "x:mytpl"],
    ],
  )
  assert.deepEqual(plan.taken.sort(), ["mytpl", "status"])
  for (const reserved of ["init", "review", "goal", "btw", "status", "models", "help", "compact", "undo"]) {
    assert.ok(OPENCODE_RESERVED_COMMAND_NAMES.has(reserved), reserved)
  }
})

test("two config dirs listing one command offer it once, and a built-in anywhere stays a built-in", () => {
  const plan = planClaudeMenu(
    [plugin("stripe:test-cards"), plugin("stripe:test-cards"), plugin("odd"), { name: "odd", builtin: true }],
    new Set(),
  )
  assert.deepEqual(plan.entries.map((entry) => entry.name), ["test-cards"])
})

test("menu descriptions say Claude Code, and opencode's names never count this plugin's own entries", () => {
  assert.equal(menuDescription({ name: "x" }), "Claude Code command")
  assert.equal(menuDescription({ name: "x", description: "Does x" }), "Claude Code: Does x")
  assert.ok(isClaudeMenuDescription("Claude Code: Does x"))
  assert.ok(isClaudeMenuDescription("Claude Code command"))
  assert.ok(!isClaudeMenuDescription("Claude Code plugin doctor"))
  assert.deepEqual(
    [...opencodeCommandNames([
      { name: "init", description: "create AGENTS.md" },
      { name: "test-cards", description: "Claude Code: (stripe) cards" },
      { name: "nameless" , description: undefined },
    ])].sort(),
    ["init", "nameless"],
  )
  assert.deepEqual([...opencodeCommandNames({ data: [{ name: "goal" }] })], ["goal"])
  assert.deepEqual(
    [...opencodeCommandNames({ mytpl: { template: "x" }, release: { description: "Claude Code: y" } })],
    ["mytpl"],
  )
  assert.deepEqual([...opencodeCommandNames(undefined)], [])
  assert.equal(claudeCommandText("stripe:test-cards", "  visa  "), "/stripe:test-cards visa")
  assert.equal(claudeCommandText("stripe:test-cards", undefined), "/stripe:test-cards")
})

test("resolveShortCommandName finds the one plugin command a short name means, else nothing", () => {
  const listed = commandsFromInitialize(INITIALIZE)!
  assert.equal(resolveShortCommandName("release", listed), "appical-core:release")
  assert.equal(resolveShortCommandName("test-cards", listed), "stripe:test-cards")
  assert.equal(resolveShortCommandName("hello-probe", listed), null, "listed under that name: it runs as itself")
  assert.equal(resolveShortCommandName("model", listed), null, "a built-in")
  assert.equal(resolveShortCommandName("stripe:test-cards", listed), null, "already a full name")
  assert.equal(resolveShortCommandName("unknown", listed), null)
  assert.equal(resolveShortCommandName("release", [...listed, plugin("other:release")]), null, "ambiguous")
  assert.equal(resolveShortCommandName("release", [...listed, { name: "release", builtin: true }]), null)
})

test("a listed command is the operator's own without any report; a built-in and an unlisted one are not", () => {
  const box = scratch()
  try {
    const context = { cwd: box.workspace, configDir: box.configDir }
    const listed = name("plug") + ":run"
    assert.equal(ownCommandIn(text(`/${listed} now`), context), null, "nothing listed yet: h #g281's rule")
    writeCommandEntry({
      configDir: box.configDir,
      cwd: box.workspace,
      probedAt: 1,
      commands: [{ name: listed }, { name: name("synced") }, { name: "model", builtin: true }],
    })
    assert.equal(ownCommandIn(text(`/${listed} now`), context), listed)
    assert.equal(ownCommandIn(text(`/${name("synced")}`), context), name("synced"), "a skill with no file this module reads")
    assert.equal(ownCommandIn(text("/model claude-sonnet-5-5"), context), null)
    assert.equal(ownCommandIn(text(`/${name("absent")}:run`), context), null)
    assert.equal(ownCommandIn([...text(`/${listed}`), ...text("more")], context), null, "only a lone text block")
    assert.equal(
      ownCommandIn(text(`/${listed}`), { ...context, cliCommands: null }),
      null,
      "claudeCommands: false leaves the list out",
    )
    assert.equal(ownCommandIn(text(`/${listed}`), { ...context, cliCommands: [{ name: listed }] }), listed)
  } finally {
    box.cleanup()
  }
})

test("expandShortCommand rewrites a unique short name to its full name and keeps what followed it", () => {
  const box = scratch()
  try {
    const context = { cwd: box.workspace, configDir: box.configDir }
    const short = name("release")
    const full = `appical-x:${short}`
    writeCommandEntry({
      configDir: box.configDir,
      cwd: box.workspace,
      probedAt: 1,
      commands: [
        { name: full },
        { name: `one:${name("shared")}` },
        { name: `two:${name("shared")}` },
        { name: `p:${name("mine")}` },
      ],
    })
    const typed = expandShortCommand(text(`/${short} planned\nwith notes`), context)
    assert.deepEqual(typed.content, text(`/${full} planned\nwith notes`))
    assert.equal(typed.from, short)
    assert.equal(typed.to, full)
    assert.deepEqual(expandShortCommand(text(`/${short}`), context).content, text(`/${full}`))

    const unchanged = (value: unknown[]) => assert.equal(expandShortCommand(value, context).content, value)
    unchanged(text(`/${name("shared")}`))
    unchanged(text(`/${name("unknown")} x`))
    unchanged(text(`/${full} x`))
    unchanged(text(`hello /${short}`))
    unchanged([...text(`/${short}`), { type: "image", source: {} }])
    assert.equal(expandShortCommand(text(`/${short}`), { ...context, cliCommands: null }).to, undefined)

    // A user command of the short name is what Claude Code runs: never rewritten.
    const own = join(box.configDir, "commands", `${name("mine")}.md`)
    mkdirSync(dirname(own), { recursive: true })
    writeFileSync(own, "---\ndescription: mine\n---\nmine\n")
    unchanged(text(`/${name("mine")}`))
  } finally {
    box.cleanup()
  }
})

test("getClaudeUserMessage sends a typed short name under its full name, unstamped", () => {
  const box = scratch()
  try {
    const short = name("cards")
    const full = `stripe-x:${short}`
    writeCommandEntry({
      configDir: box.configDir,
      cwd: box.workspace,
      probedAt: 1,
      commands: [{ name: full }, { name: "model", builtin: true }],
    })
    const prompt = (value: string) => [{ role: "user", content: [{ type: "text", text: value }] }] as any
    const ownCommands = { cwd: box.workspace, configDir: box.configDir }
    const send = (value: string, verbatimPrompts: boolean) =>
      JSON.parse(getClaudeUserMessage(prompt(value), false, { verbatimPrompts, ownCommands }))

    const typed = send(`/${short} visa`, true)
    assert.equal("client_composed" in typed, false)
    assert.equal(typed.message.content.at(-1).text, `/${full} visa`)

    const picked = send(`/${full} visa `, true)
    assert.equal("client_composed" in picked, false, "a menu entry's text runs on the first message")

    const builtin = send("/model claude-sonnet-5-5", true)
    assert.equal(builtin.client_composed, true)
    assert.equal(builtin.message.content.at(-1).text, "/model claude-sonnet-5-5")

    const plain = send(`/${short} visa`, false)
    assert.equal(plain.message.content.at(-1).text, `/${full} visa`, "rewritten with verbatimPrompts off too")

    const without = JSON.parse(getClaudeUserMessage(prompt(`/${short} visa`), false, { verbatimPrompts: true }))
    assert.equal(without.message.content.at(-1).text, `/${short} visa`, "no context, no rewrite")
    assert.equal(without.client_composed, true)
  } finally {
    box.cleanup()
  }
})
