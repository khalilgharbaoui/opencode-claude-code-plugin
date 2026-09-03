import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  type AgentRecord,
  _resetAgentRegistryForTests,
  agentDirectories,
  getDefaultSubagentModel,
  parseAgentFrontmatter,
  readAgentMarkdownRecords,
  resolveAgentEffort,
  resolveAgentModel,
  setAgentRegistry,
  setDefaultSubagentModel,
} from "./src/agent-models.js"

const records: Record<string, AgentRecord> = {
  implementor: { mode: "subagent" },
  designer: { mode: "subagent", forceModel: "claude-haiku-4-5" },
  pinned: { mode: "subagent", model: "claude-code-default/claude-sonnet-5" },
  primary: { mode: "primary" },
  bogus: { mode: "subagent", forceModel: "claude-does-not-exist" },
}

const withOpus = { records, defaultSubagentModel: "claude-opus-5" }
const withoutDefault = { records }

// --- the opt-in default ----------------------------------------------------

test("with no defaultSubagentModel nothing is overridden", () => {
  // The whole safety property: an existing setup that upgrades the plugin
  // must not find its cheap subagents silently running on an expensive model.
  assert.equal(
    resolveAgentModel("implementor", "claude-fable-5-1", withoutDefault),
    "claude-fable-5-1",
  )
})

test("a discovered subagent takes the default when one is set", () => {
  assert.equal(
    resolveAgentModel("implementor", "claude-fable-5-1", withOpus),
    "claude-opus-5",
  )
})

test("the account marker survives the swap", () => {
  // A Fable parent on the appical account must hand its subagent Opus ON
  // APPICAL, and `@appical` is how the spawn wrapper knows which account.
  assert.equal(
    resolveAgentModel("implementor", "claude-fable-5-1@appical", withOpus),
    "claude-opus-5@appical",
  )
})

test("forceModel wins over the default", () => {
  assert.equal(
    resolveAgentModel("designer", "claude-opus-5@work", withOpus),
    "claude-haiku-4-5@work",
  )
})

test("forceModel works with no default set at all", () => {
  assert.equal(
    resolveAgentModel("designer", "claude-fable-5-1", withoutDefault),
    "claude-haiku-4-5",
  )
})

// --- what must never be touched -------------------------------------------

test("an agent that pinned provider and model is left alone", () => {
  assert.equal(
    resolveAgentModel("pinned", "claude-sonnet-5", withOpus),
    "claude-sonnet-5",
  )
})

test("a primary agent is left alone", () => {
  assert.equal(
    resolveAgentModel("primary", "claude-fable-5-1", withOpus),
    "claude-fable-5-1",
  )
})

test("an agent the plugin never discovered is left alone", () => {
  // opencode's built-ins land here. Forcing Opus onto `explore` would make a
  // cheap agent expensive without anyone asking for it.
  assert.equal(
    resolveAgentModel("explore", "claude-haiku-4-5", withOpus),
    "claude-haiku-4-5",
  )
})

test("an untagged request is left alone", () => {
  assert.equal(
    resolveAgentModel(undefined, "claude-fable-5-1", withOpus),
    "claude-fable-5-1",
  )
})

test("an unknown model fails closed rather than spawning a bad --model", () => {
  assert.equal(
    resolveAgentModel("bogus", "claude-fable-5-1", withOpus),
    "claude-fable-5-1",
  )
})

// --- module-level state ----------------------------------------------------

test("module state is used when no overrides are passed", () => {
  _resetAgentRegistryForTests()
  setAgentRegistry({ implementor: { mode: "subagent" } })

  assert.equal(getDefaultSubagentModel(), undefined)
  assert.equal(resolveAgentModel("implementor", "claude-fable-5-1"), "claude-fable-5-1")

  setDefaultSubagentModel("claude-opus-5")
  assert.equal(resolveAgentModel("implementor", "claude-fable-5-1"), "claude-opus-5")

  // A blank setting is the same as no setting, so an empty config value
  // cannot half-enable the override.
  setDefaultSubagentModel("   ")
  assert.equal(getDefaultSubagentModel(), undefined)
  assert.equal(resolveAgentModel("implementor", "claude-fable-5-1"), "claude-fable-5-1")

  _resetAgentRegistryForTests()
})

// --- frontmatter -----------------------------------------------------------

test("parseAgentFrontmatter reads the three fields it cares about", () => {
  const record = parseAgentFrontmatter(
    [
      "---",
      "description: does things",
      "mode: subagent",
      'forceModel: "claude-haiku-4-5"',
      "---",
      "body",
    ].join("\n"),
  )
  assert.deepEqual(record, { mode: "subagent", forceModel: "claude-haiku-4-5" })
})

test("parseAgentFrontmatter ignores nested keys and stops at the fence", () => {
  const record = parseAgentFrontmatter(
    [
      "---",
      "mode: subagent",
      "permission:",
      "  bash: allow",
      "  edit: allow",
      "---",
      "model: claude-opus-5",
    ].join("\n"),
  )
  assert.deepEqual(record, { mode: "subagent" })
})

test("parseAgentFrontmatter tolerates a file with no frontmatter", () => {
  assert.deepEqual(parseAgentFrontmatter("just a prompt\n"), {})
})

test("readAgentMarkdownRecords reads a directory, project before global", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-models-"))
  try {
    const project = join(root, "project")
    const global = join(root, "global")
    mkdirSync(project, { recursive: true })
    mkdirSync(global, { recursive: true })
    writeFileSync(
      join(project, "designer.md"),
      "---\nmode: subagent\nforceModel: claude-haiku-4-5\n---\n",
    )
    writeFileSync(join(global, "designer.md"), "---\nmode: subagent\n---\n")
    writeFileSync(join(global, "notes.txt"), "ignored")

    const found = await readAgentMarkdownRecords([project, global])
    assert.deepEqual(Object.keys(found), ["designer"])
    assert.equal(found.designer.forceModel, "claude-haiku-4-5")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("readAgentMarkdownRecords skips directories that do not exist", async () => {
  assert.deepEqual(
    await readAgentMarkdownRecords([join(tmpdir(), "no-such-agent-dir")]),
    {},
  )
})

// --- effort ----------------------------------------------------------------

const effortRecords: Record<string, AgentRecord> = {
  thrifty: { mode: "subagent", reasoningEffort: "high" },
  quiet: { mode: "subagent" },
  wrong: { mode: "subagent", reasoningEffort: "enormous" },
}
const withEffort = { records: effortRecords }

test("an agent's declared effort beats the caller's inherited one", () => {
  // The cost property: a caller who picked max for their own turn must not
  // hand max to every worker it dispatches.
  assert.equal(resolveAgentEffort("thrifty", "max", withEffort), "high")
})

test("an agent that declares no effort keeps whatever it inherited", () => {
  assert.equal(resolveAgentEffort("quiet", "max", withEffort), "max")
  assert.equal(resolveAgentEffort("quiet", undefined, withEffort), undefined)
})

test("an unknown agent keeps the inherited effort", () => {
  assert.equal(resolveAgentEffort("explore", "medium", withEffort), "medium")
  assert.equal(resolveAgentEffort(undefined, "medium", withEffort), "medium")
})

test("an unknown effort level is refused, not forwarded to the CLI", () => {
  assert.equal(resolveAgentEffort("wrong", "medium", withEffort), "medium")
})

test("effort is read from the registry when no overrides are passed", () => {
  _resetAgentRegistryForTests()
  setAgentRegistry(effortRecords)
  try {
    assert.equal(resolveAgentEffort("thrifty", "max"), "high")
  } finally {
    _resetAgentRegistryForTests()
  }
})

test("parseAgentFrontmatter reads reasoningEffort", () => {
  assert.deepEqual(
    parseAgentFrontmatter(
      ["---", "mode: subagent", "reasoningEffort: xhigh", "---", "body"].join(
        "\n",
      ),
    ),
    { mode: "subagent", reasoningEffort: "xhigh" },
  )
})

test("agentDirectories covers both names, project before global", () => {
  assert.deepEqual(agentDirectories("/home/k", "/work/app"), [
    "/work/app/.opencode/agents",
    "/work/app/.opencode/agent",
    "/home/k/.config/opencode/agents",
    "/home/k/.config/opencode/agent",
  ])
})
