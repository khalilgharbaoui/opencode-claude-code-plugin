import "./isolate.js"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  type AgentRecord,
  AGENT_REGISTRY_RECHECK_MS,
  _resetAgentRegistryForTests,
  agentDirectories,
  getAgentRegistry,
  installAgentRegistry,
  mergeAgentRecords,
  refreshAgentRegistry,
  getDefaultSubagentModel,
  parseAgentFrontmatter,
  readAgentMarkdownRecords,
  resolveAgentCacheTtl,
  resolveAgentCliCaps,
  setDefaultSubagentCliCaps,
  getDefaultSubagentCliCaps,
  resolveAgentEffort,
  resolveAgentModel,
  setAgentRegistry,
  setDefaultSubagentCacheTtl,
  setDefaultSubagentModel,
} from "../src/agent-models.js"
import { buildAgentRegistry } from "../src/index.js"
import { configureLogger, _resetLoggerForTests } from "../src/logger.js"
import { setOpencodeProjectDirectory } from "../src/runtime-status.js"

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

// --- prompt cache TTL ------------------------------------------------------

const ttlRecords: Record<string, AgentRecord> = {
  worker: { mode: "subagent" },
  thrifty: { mode: "subagent", cacheTtl: "5m" },
  patient: { mode: "subagent", cacheTtl: "1h" },
  typo: { mode: "subagent", cacheTtl: "1hr" },
  boss: { mode: "primary" },
}

test("with no cacheTtl anywhere the CLI keeps deciding", () => {
  // Same safety property as defaultSubagentModel: an upgrade must not start
  // changing how anybody's turns are cached without being asked.
  assert.equal(resolveAgentCacheTtl("worker", { records: ttlRecords }), undefined)
})

test("an agent's own cacheTtl wins", () => {
  assert.equal(
    resolveAgentCacheTtl("thrifty", {
      records: ttlRecords,
      defaultSubagentCacheTtl: "1h",
    }),
    "5m",
  )
  assert.equal(
    resolveAgentCacheTtl("patient", {
      records: ttlRecords,
      defaultSubagentCacheTtl: "5m",
    }),
    "1h",
  )
})

test("defaultSubagentCacheTtl covers discovered subagents only", () => {
  const withFiveMinutes = {
    records: ttlRecords,
    defaultSubagentCacheTtl: "5m",
  }
  assert.equal(resolveAgentCacheTtl("worker", withFiveMinutes), "5m")
  // A primary agent is not a worker, so the budget argument does not apply.
  assert.equal(resolveAgentCacheTtl("boss", withFiveMinutes), undefined)
  // An agent this plugin never discovered is never rewritten.
  assert.equal(resolveAgentCacheTtl("explore", withFiveMinutes), undefined)
  assert.equal(resolveAgentCacheTtl(undefined, withFiveMinutes), undefined)
})

test("an unknown cacheTtl is refused, not forwarded", () => {
  // Measured on CLI 2.1.280: the CLI accepts a bogus value silently and falls
  // back to its automatic default, so refusing here is what makes the typo
  // visible. Either way the spawn must not carry it.
  assert.equal(resolveAgentCacheTtl("typo", { records: ttlRecords }), undefined)
  assert.equal(
    resolveAgentCacheTtl("typo", {
      records: ttlRecords,
      defaultSubagentCacheTtl: "5m",
    }),
    undefined,
  )
})

test("cacheTtl resolves off the module registry too", () => {
  try {
    setAgentRegistry(ttlRecords)
    setDefaultSubagentCacheTtl("1h")
    assert.equal(resolveAgentCacheTtl("worker"), "1h")
    assert.equal(resolveAgentCacheTtl("thrifty"), "5m")
    setDefaultSubagentCacheTtl(undefined)
    assert.equal(resolveAgentCacheTtl("worker"), undefined)
  } finally {
    _resetAgentRegistryForTests()
  }
})

test("parseAgentFrontmatter reads cacheTtl", () => {
  assert.deepEqual(
    parseAgentFrontmatter(
      ["---", "mode: subagent", "cacheTtl: 5m", "---", "body"].join("\n"),
    ),
    { mode: "subagent", cacheTtl: "5m" },
  )
})

test("agentDirectories covers both names, project before global", () => {
  assert.deepEqual(agentDirectories("/home/k", "/work/app"), [
    join("/work/app", ".opencode", "agents"),
    join("/work/app", ".opencode", "agent"),
    join("/home/k", ".config", "opencode", "agents"),
    join("/home/k", ".config", "opencode", "agent"),
  ])
})

// --- per-agent CLI caps (h #g245) -----------------------------------------

test("an agent's own caps win, and a discovered subagent falls back to the defaults", () => {
  const records = {
    scout: { mode: "subagent", maxTurns: "5", maxBudgetUsd: "0.4" },
    helper: { mode: "subagent" },
    build: { mode: "primary" },
  }
  const defaults = { maxTurns: 12, maxBudgetUsd: 1 }
  assert.deepEqual(resolveAgentCliCaps("scout", { records, defaults }), {
    maxTurns: 5,
    maxBudgetUsd: 0.4,
  })
  assert.deepEqual(resolveAgentCliCaps("helper", { records, defaults }), {
    maxTurns: 12,
    maxBudgetUsd: 1,
  })
  // The defaults are for subagents only: a main agent declaring nothing gets nothing.
  assert.deepEqual(resolveAgentCliCaps("build", { records, defaults }), {})
  assert.deepEqual(resolveAgentCliCaps(undefined, { records, defaults }), {})
  assert.deepEqual(resolveAgentCliCaps("unknown", { records, defaults }), {})
})

test("a main agent keeps maxTurns but its maxBudgetUsd is refused", () => {
  // --max-turns is counted per user message, --max-budget-usd over the whole
  // reused process (measured on 2.1.293).
  const records = { build: { mode: "primary", maxTurns: 20, maxBudgetUsd: 5 } }
  assert.deepEqual(resolveAgentCliCaps("build", { records }), { maxTurns: 20 })
})

test("a cap that is not a positive number is refused rather than forwarded", () => {
  const records = {
    bad: { mode: "subagent", maxTurns: "2.5", maxBudgetUsd: "free" },
    zero: { mode: "subagent", maxTurns: 0, maxBudgetUsd: -1 },
  }
  const defaults = { maxTurns: 3 }
  // A refused own value falls back to the default, like an unknown cacheTtl.
  assert.deepEqual(resolveAgentCliCaps("bad", { records, defaults }), { maxTurns: 3 })
  assert.deepEqual(resolveAgentCliCaps("zero", { records, defaults: {} }), {})
})

test("frontmatter carries maxTurns and maxBudgetUsd", () => {
  const record = parseAgentFrontmatter(
    ["---", "mode: subagent", "maxTurns: 7", "maxBudgetUsd: 0.75", "---", "body"].join("\n"),
  )
  assert.equal(record.maxTurns, "7")
  assert.equal(record.maxBudgetUsd, "0.75")
})

test("the subagent defaults are kept only when set", () => {
  _resetAgentRegistryForTests()
  assert.deepEqual(getDefaultSubagentCliCaps(), {})
  setDefaultSubagentCliCaps({ maxTurns: 9, maxBudgetUsd: undefined })
  assert.deepEqual(getDefaultSubagentCliCaps(), { maxTurns: 9 })
  _resetAgentRegistryForTests()
  assert.deepEqual(getDefaultSubagentCliCaps(), {})
})

// --- keeping the registry current with the agent files (h #g313) ------------

/** Everything the logger writes while `fn` runs, debug included. */
async function captureLogs(fn: () => unknown): Promise<string[]> {
  const lines: string[] = []
  const original = console.error
  console.error = (line: unknown) => {
    lines.push(String(line))
  }
  try {
    _resetLoggerForTests()
    configureLogger({ mode: "debug", level: "debug" })
    await fn()
  } finally {
    console.error = original
    _resetLoggerForTests()
  }
  return lines
}

function agentFile(fields: string[], body = "Design things."): string {
  return ["---", ...fields, "---", body, ""].join("\n")
}

let mtimeBump = 0

/**
 * Write an agent file with an mtime no earlier write in this file shares. Two
 * of these edits keep the file's size (`haiku-4-5` and `fable-5-2`), and a
 * filesystem's clock can be a few milliseconds coarse, so the fingerprint is
 * given a change it cannot miss rather than one a fast machine might.
 */
function writeAgent(file: string, text: string): void {
  writeFileSync(file, text)
  const at = Math.floor(Date.now() / 1000) + ++mtimeBump * 10
  utimesSync(file, at, at)
}

/** A scratch agent directory, removed by the returned cleanup. */
function scratchAgents(): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "agent-refresh-"))
  const dir = join(root, "agents")
  mkdirSync(dir, { recursive: true })
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test("an edited agent file applies on the next look, and not before the recheck window", async () => {
  _resetAgentRegistryForTests()
  const { dir, cleanup } = scratchAgents()
  try {
    writeAgent(join(dir, "designer.md"), agentFile(["mode: subagent", "forceModel: claude-haiku-4-5"]))
    const start = Date.now()
    await installAgentRegistry({ directories: [dir], overlay: {}, now: start })
    assert.equal(resolveAgentModel("designer", "claude-opus-5-5"), "claude-haiku-4-5")

    writeAgent(join(dir, "designer.md"), agentFile(["mode: subagent", "forceModel: claude-fable-5-2"]))
    assert.equal(await refreshAgentRegistry(start + 1), false, "inside the window nothing is looked at")
    assert.equal(getAgentRegistry().designer.forceModel, "claude-haiku-4-5")

    assert.equal(await refreshAgentRegistry(start + AGENT_REGISTRY_RECHECK_MS), true)
    assert.equal(resolveAgentModel("designer", "claude-opus-5-5"), "claude-fable-5-2")
    assert.equal(
      await refreshAgentRegistry(start + 2 * AGENT_REGISTRY_RECHECK_MS),
      false,
      "a look that finds nothing new changes nothing",
    )
  } finally {
    cleanup()
    _resetAgentRegistryForTests()
  }
})

test("a value opencode 1 only copied out of the file follows the file", async () => {
  // opencode 1 spreads every agent file's frontmatter into `config.agent`, so
  // the config overlay echoes the file as it was when the plugin was set up.
  _resetAgentRegistryForTests()
  const { dir, cleanup } = scratchAgents()
  try {
    writeAgent(join(dir, "designer.md"), agentFile(["mode: subagent", "forceModel: claude-haiku-4-5", "maxTurns: 4"]))
    const start = Date.now()
    await installAgentRegistry({
      directories: [dir],
      overlay: {
        designer: { mode: "subagent", forceModel: "claude-haiku-4-5", maxTurns: 4, prompt: "Design things." },
      },
      now: start,
    })
    writeAgent(join(dir, "designer.md"), agentFile(["mode: subagent", "forceModel: claude-fable-5-2", "maxTurns: 6"]))
    assert.equal(await refreshAgentRegistry(start + AGENT_REGISTRY_RECHECK_MS), true)
    assert.equal(getAgentRegistry().designer.forceModel, "claude-fable-5-2")
    assert.equal(getAgentRegistry().designer.maxTurns, "6", "a number echoing a string is still an echo")
  } finally {
    cleanup()
    _resetAgentRegistryForTests()
  }
})

test("a value opencode.json sets itself still wins, and the refresh says so once", async () => {
  _resetAgentRegistryForTests()
  const { dir, cleanup } = scratchAgents()
  try {
    writeAgent(join(dir, "designer.md"), agentFile(["mode: subagent", "forceModel: claude-haiku-4-5"]))
    const start = Date.now()
    await installAgentRegistry({
      directories: [dir],
      overlay: { designer: { forceModel: "claude-sonnet-5-5" } },
      now: start,
    })
    assert.equal(getAgentRegistry().designer.forceModel, "claude-sonnet-5-5")

    writeAgent(join(dir, "designer.md"), agentFile(["mode: subagent", "forceModel: claude-fable-5-2"]))
    let lines = await captureLogs(() => refreshAgentRegistry(start + AGENT_REGISTRY_RECHECK_MS))
    assert.equal(getAgentRegistry().designer.forceModel, "claude-sonnet-5-5")
    const held = lines.filter((line) => /opencode's config also sets for that agent/.test(line))
    assert.equal(held.length, 1)
    assert.match(held[0]!, /"agent":"designer","key":"forceModel"/)

    // Another file changing does not repeat it.
    writeAgent(join(dir, "writer.md"), agentFile(["mode: subagent"]))
    lines = await captureLogs(() => refreshAgentRegistry(start + 2 * AGENT_REGISTRY_RECHECK_MS))
    assert.equal(lines.filter((line) => /opencode's config also sets/.test(line)).length, 0)
  } finally {
    cleanup()
    _resetAgentRegistryForTests()
  }
})

test("only the plugin's own keys move; opencode's mode, model and prompt stay as set up", async () => {
  _resetAgentRegistryForTests()
  const { dir, cleanup } = scratchAgents()
  try {
    writeAgent(join(dir, "designer.md"), agentFile(["mode: subagent", "reasoningEffort: low"]))
    const start = Date.now()
    await installAgentRegistry({ directories: [dir], overlay: {}, now: start })
    writeFileSync(
      join(dir, "designer.md"),
      agentFile(
        ["mode: primary", "model: claude-code/claude-opus-5-5", "reasoningEffort: high", "cacheTtl: 1h", "fallbackModels: [claude-haiku-5-5]"],
        "A different prompt.",
      ),
    )
    const lines = await captureLogs(() => refreshAgentRegistry(start + AGENT_REGISTRY_RECHECK_MS))
    const record = getAgentRegistry().designer
    assert.equal(record.mode, "subagent")
    assert.equal(record.model, undefined)
    assert.equal(record.prompt, "Design things.")
    assert.equal(record.reasoningEffort, "high")
    assert.equal(record.cacheTtl, "1h")
    assert.deepEqual(record.fallbackModels, ["claude-haiku-5-5"])
    const notice = lines.find((line) => /agent files changed on disk/.test(line))
    assert.ok(notice, "the change is said")
    assert.match(notice!, /"key":"reasoningEffort","from":"low","to":"high"/)
    assert.doesNotMatch(notice!, /A different prompt/, "a prompt is never logged")
  } finally {
    cleanup()
    _resetAgentRegistryForTests()
  }
})

test("a key taken out of a file and a file taken away both stop applying; a new file starts", async () => {
  _resetAgentRegistryForTests()
  const { dir, cleanup } = scratchAgents()
  try {
    writeAgent(join(dir, "designer.md"), agentFile(["mode: subagent", "forceModel: claude-haiku-4-5"]))
    writeAgent(join(dir, "writer.md"), agentFile(["mode: subagent", "forceModel: claude-sonnet-5-5"]))
    const start = Date.now()
    await installAgentRegistry({ directories: [dir], overlay: {}, now: start })

    writeAgent(join(dir, "designer.md"), agentFile(["mode: subagent"]))
    unlinkSync(join(dir, "writer.md"))
    writeAgent(join(dir, "scout.md"), agentFile(["mode: subagent", "forceModel: claude-haiku-5-5"]))
    assert.equal(await refreshAgentRegistry(start + AGENT_REGISTRY_RECHECK_MS), true)
    assert.equal(resolveAgentModel("designer", "claude-opus-5-5"), "claude-opus-5-5")
    assert.equal(getAgentRegistry().writer, undefined)
    assert.equal(resolveAgentModel("scout", "claude-opus-5-5"), "claude-haiku-5-5")
    assert.equal(getAgentRegistry().scout.mode, "subagent", "a new agent takes all of its file")
  } finally {
    cleanup()
    _resetAgentRegistryForTests()
  }
})

test("a forceModel this install does not have is warned about when the file is read", async () => {
  _resetAgentRegistryForTests()
  const { dir, cleanup } = scratchAgents()
  try {
    writeAgent(join(dir, "designer.md"), agentFile(["mode: subagent", "forceModel: claude-haiku-4-5"]))
    const start = Date.now()
    await installAgentRegistry({ directories: [dir], overlay: {}, now: start })
    writeAgent(join(dir, "designer.md"), agentFile(["mode: subagent", "forceModel: claude-fable-9-9"]))
    const lines = await captureLogs(() => refreshAgentRegistry(start + AGENT_REGISTRY_RECHECK_MS))
    const warned = lines.filter((line) => /WARN/.test(line) && /forceModel this install does not have/.test(line))
    assert.equal(warned.length, 1)
    assert.match(warned[0]!, /claude-fable-9-9/)
    // And the turn keeps what opencode asked for, as an unknown forceModel
    // always has.
    assert.equal(resolveAgentModel("designer", "claude-opus-5-5"), "claude-opus-5-5")
  } finally {
    cleanup()
    _resetAgentRegistryForTests()
  }
})

test("a registry set by hand is never replaced by a look at the files", async () => {
  _resetAgentRegistryForTests()
  const { dir, cleanup } = scratchAgents()
  try {
    writeAgent(join(dir, "designer.md"), agentFile(["mode: subagent", "forceModel: claude-haiku-4-5"]))
    const start = Date.now()
    await installAgentRegistry({ directories: [dir], overlay: {}, now: start })
    setAgentRegistry({ designer: { mode: "subagent", forceModel: "claude-sonnet-5-5" } })
    writeAgent(join(dir, "designer.md"), agentFile(["mode: subagent", "forceModel: claude-fable-5-2"]))
    assert.equal(await refreshAgentRegistry(start + AGENT_REGISTRY_RECHECK_MS), false)
    assert.equal(getAgentRegistry().designer.forceModel, "claude-sonnet-5-5")
  } finally {
    cleanup()
    _resetAgentRegistryForTests()
  }
})

test("at build time the merge is the overlay the builder always did", () => {
  const markdown = {
    designer: { mode: "subagent", forceModel: "claude-haiku-4-5", maxTurns: "4" },
    writer: { mode: "subagent" },
  }
  const merged = mergeAgentRecords(markdown, {
    designer: { forceModel: "claude-sonnet-5-5", maxTurns: 4, fallbackModels: undefined },
    build: { mode: "primary", reasoningEffort: "high" },
  })
  assert.equal(merged.designer.forceModel, "claude-sonnet-5-5", "the config wins")
  assert.equal(merged.designer.mode, "subagent", "the file fills what the config leaves out")
  assert.equal(merged.designer.maxTurns, "4")
  assert.deepEqual(merged.writer, { mode: "subagent" }, "an agent only on disk is kept as read")
  assert.equal(merged.build.mode, "primary", "an agent only in the config is taken from it")
  assert.equal(merged.build.reasoningEffort, "high")
})

test("buildAgentRegistry, then an edited file, through the config hook's own builder", async () => {
  // The opencode 1 path end to end: `config.agent` echoes the file's
  // frontmatter (in `options`, where opencode 1 puts unknown keys), and the
  // registry follows the file when it changes.
  _resetAgentRegistryForTests()
  const root = mkdtempSync(join(tmpdir(), "agent-refresh-home-"))
  const dir = join(root, ".config", "opencode", "agents")
  mkdirSync(dir, { recursive: true })
  const savedHome = process.env.HOME
  process.env.HOME = root
  setOpencodeProjectDirectory(undefined)
  try {
    writeAgent(join(dir, "designer.md"), agentFile(["mode: subagent", "forceModel: claude-haiku-4-5"]))
    await buildAgentRegistry({
      agent: { designer: { mode: "subagent", options: { forceModel: "claude-haiku-4-5" }, prompt: "Design things." } },
    } as never)
    assert.equal(resolveAgentModel("designer", "claude-opus-5-5"), "claude-haiku-4-5")
    writeAgent(join(dir, "designer.md"), agentFile(["mode: subagent", "forceModel: claude-fable-5-2"]))
    assert.equal(await refreshAgentRegistry(Date.now() + AGENT_REGISTRY_RECHECK_MS), true)
    assert.equal(resolveAgentModel("designer", "claude-opus-5-5"), "claude-fable-5-2")
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    rmSync(root, { recursive: true, force: true })
    _resetAgentRegistryForTests()
  }
})
