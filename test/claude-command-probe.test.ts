/**
 * The probe that asks the installed `claude` for its commands and skills, and
 * the `/` menu both opencode majors get from what it stored (h #g322).
 *
 * The fake `claude` speaks the control protocol the way 2.1.322 does: it
 * answers `initialize` with a `commands` list (and an `account` block the
 * probe must never keep), records the argv, folder and config dir it ran
 * with, and exits when its stdin closes. POSIX only: it is a script with a
 * shebang.
 *
 * Usage: npx tsx --test test/claude-command-probe.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  _resetClaudeCommandProbeForTests,
  CLAUDE_COMMAND_PROBE_ENV,
  claudeCommandProbeArgs,
  claudeCommandTargets,
  claudeMenuFor,
  probeClaudeCommands,
  refreshClaudeCommands,
} from "../src/claude-command-probe.js"
import {
  _resetClaudeCommandStoreForTests,
  claudeCommandStorePath,
  cliCommandsFor,
  writeCommandEntry,
} from "../src/claude-commands.js"
import plugin, { registerClaudeCommands } from "../src/index.js"
import { createV2Setup } from "../src/v2.js"

const SAVED = ["HOME", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", CLAUDE_COMMAND_PROBE_ENV] as const
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(SAVED.map((key) => [key, process.env[key]]))
})

afterEach(() => {
  for (const key of SAVED) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  _resetClaudeCommandProbeForTests()
  _resetClaudeCommandStoreForTests()
})

const STRIPE = { name: "stripe:test-cards", description: "(stripe) Display Stripe test card numbers", argumentHint: "scenario" }
const RELEASE = { name: "appical-core:release", description: "(appical-core) Cut a production release" }
const PROJECT = { name: "hello-probe", description: "Say hello (project)" }
const INIT_SKILL = { name: "init", description: "a user skill named like opencode's /init" }
const BUILTIN = { name: "model", description: "Set the AI model", builtin: true }

/** A scratch home with a default config dir, a project and a fake `claude`. */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "opencode-command-probe-"))
  const home = join(root, "home")
  const configDir = join(home, ".claude")
  const workspace = join(root, "project")
  for (const dir of [configDir, workspace]) mkdirSync(dir, { recursive: true })
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = configDir
  _resetClaudeCommandStoreForTests(join(root, "state", "claude-commands.json"))

  const cliPath = join(root, "fake-claude.cjs")
  const record = join(root, "spawns.jsonl")
  const answer = join(root, "answer.json")
  writeFileSync(
    cliPath,
    `#!${process.execPath}
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.322 (Claude Code)\\n")
  process.exit(0)
}
const answer = JSON.parse(fs.readFileSync(${JSON.stringify(answer)}, "utf8"))
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  apiKey: process.env.ANTHROPIC_API_KEY !== undefined,
}) + "\\n")
const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
readline.createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line)
    if (message.type !== "control_request" || answer.mode === "silent") return
    if (answer.mode === "refuse") {
      out({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "nope" } })
      return
    }
    out({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: {
          commands: answer.commands,
          claude_code_version: "2.1.322",
          account: { email: "someone@example.com", organization: "Example Org" },
        },
      },
    })
  })
  .on("close", () => process.exit(0))
`,
  )
  chmodSync(cliPath, 0o755)
  const setAnswer = (value: Record<string, unknown>) => writeFileSync(answer, JSON.stringify(value))
  setAnswer({ commands: [PROJECT, STRIPE, RELEASE, INIT_SKILL, BUILTIN] })
  return {
    root,
    home,
    configDir,
    workspace,
    cliPath,
    setAnswer,
    spawns: (): Array<{ argv: string[]; cwd: string; configDir: string | null; apiKey: boolean }> =>
      existsSync(record)
        ? readFileSync(record, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test("one target per config dir: the default login, then each account's own dir, on the base binary", () => {
  const box = scratch()
  try {
    assert.deepEqual(claudeCommandTargets({}), [{ cliPath: "claude", configDir: box.configDir }])
    assert.deepEqual(claudeCommandTargets({ accounts: ["work"], cliPath: "/opt/wrapper", baseCliPath: "/opt/claude" }), [
      { cliPath: "/opt/claude", configDir: box.configDir },
      { cliPath: "/opt/claude", configDir: join(box.home, ".claude-work"), exportConfigDir: join(box.home, ".claude-work") },
    ])
  } finally {
    box.cleanup()
  }
})

test("the probe never skips plugins, never runs hooks or MCP servers, and never names a model", () => {
  const args = claudeCommandProbeArgs()
  assert.ok(!args.includes("--bare"), "--bare skips plugins, so it cannot list a plugin's skills")
  assert.ok(!args.includes("--model"))
  assert.ok(args.includes("--strict-mcp-config"))
  assert.ok(args.includes("--no-session-persistence"))
  assert.deepEqual(JSON.parse(args[args.indexOf("--settings") + 1]!), { disableAllHooks: true })
})

test("a probe reads the list in the folder and config dir it was given, with no credential", async () => {
  const box = scratch()
  try {
    process.env.ANTHROPIC_API_KEY = "test-placeholder-not-a-key"
    const answer = await probeClaudeCommands(
      { cliPath: box.cliPath, configDir: join(box.home, ".claude-work"), exportConfigDir: join(box.home, ".claude-work") },
      box.workspace,
    )
    assert.ok(answer.ok)
    assert.deepEqual(
      answer.commands.map((command) => command.name),
      ["hello-probe", "stripe:test-cards", "appical-core:release", "init", "model"],
    )
    assert.equal(answer.cliVersion, "2.1.322")
    const [spawned] = box.spawns()
    assert.equal(realpathSync(spawned!.cwd), realpathSync(box.workspace))
    assert.equal(spawned!.configDir, join(box.home, ".claude-work"))
    assert.equal(spawned!.apiKey, false, "the env carries no Anthropic credential")
    assert.deepEqual(spawned!.argv, claudeCommandProbeArgs())

    delete process.env.CLAUDE_CONFIG_DIR
    await probeClaudeCommands({ cliPath: box.cliPath, configDir: box.configDir }, box.workspace)
    assert.equal(box.spawns()[1]!.configDir, null, "the default login gets no CLAUDE_CONFIG_DIR")
  } finally {
    box.cleanup()
  }
})

test("a probe that is refused or never answers says so and stores nothing", async () => {
  const box = scratch()
  try {
    box.setAnswer({ mode: "refuse" })
    const refused = await probeClaudeCommands({ cliPath: box.cliPath, configDir: box.configDir }, box.workspace)
    assert.deepEqual([refused.ok, !refused.ok && refused.reason], [false, "request-refused"])
    box.setAnswer({ mode: "silent" })
    const silent = await probeClaudeCommands({ cliPath: box.cliPath, configDir: box.configDir }, box.workspace, 300)
    assert.deepEqual([silent.ok, !silent.ok && silent.reason], [false, "deadline"])
    const missing = await probeClaudeCommands({ cliPath: join(box.root, "nope"), configDir: box.configDir }, box.workspace)
    assert.equal(missing.ok, false)
    assert.equal(existsSync(claudeCommandStorePath()), false)
  } finally {
    box.cleanup()
  }
})

test("a refresh stores the answer once per process and reports a change only when the list changed", async () => {
  const box = scratch()
  try {
    process.env[CLAUDE_COMMAND_PROBE_ENV] = "1"
    let changes = 0
    const settings = { cliPath: box.cliPath }
    const first = await refreshClaudeCommands(settings, box.workspace, { onChanged: () => changes++ })
    assert.equal(first.status, "done")
    assert.equal(first.status === "done" && first.changed, true)
    assert.equal(changes, 1)
    assert.deepEqual(cliCommandsFor(box.configDir, box.workspace)?.map((command) => command.name), [
      "hello-probe",
      "stripe:test-cards",
      "appical-core:release",
      "init",
      "model",
    ])
    assert.doesNotMatch(readFileSync(claudeCommandStorePath(), "utf8"), /someone@example\.com|Example Org/)

    assert.equal(await refreshClaudeCommands(settings, box.workspace), first, "once per process")
    assert.equal(box.spawns().length, 1)

    _resetClaudeCommandProbeForTests()
    const again = await refreshClaudeCommands(settings, box.workspace, { onChanged: () => changes++ })
    assert.equal(again.status === "done" && again.changed, false)
    assert.equal(changes, 1, "the same list reloads nothing")

    _resetClaudeCommandProbeForTests()
    box.setAnswer({ commands: [STRIPE] })
    const changed = await refreshClaudeCommands(settings, box.workspace, { onChanged: () => changes++ })
    assert.equal(changed.status === "done" && changed.changed, true)
    assert.equal(changes, 2)
  } finally {
    box.cleanup()
  }
})

test("a refresh asks every configured account that has a config dir, and nothing when switched off", async () => {
  const box = scratch()
  try {
    process.env[CLAUDE_COMMAND_PROBE_ENV] = "1"
    mkdirSync(join(box.home, ".claude-work"))
    const result = await refreshClaudeCommands({ cliPath: box.cliPath, accounts: ["work", "ghost"] }, box.workspace)
    assert.equal(result.status === "done" && result.probed, 2, "the ghost account has no config dir to ask")
    assert.deepEqual(
      box.spawns().map((spawn) => spawn.configDir),
      [box.configDir, join(box.home, ".claude-work")],
      "the default login keeps the CLAUDE_CONFIG_DIR opencode itself runs with; an account gets its own",
    )
    assert.equal(existsSync(join(box.home, ".claude-ghost")), false, "nothing is created")

    _resetClaudeCommandProbeForTests()
    assert.deepEqual(await refreshClaudeCommands({ cliPath: box.cliPath, claudeCommands: false }, box.workspace), {
      status: "skipped",
      reason: "option-off",
    })
    process.env[CLAUDE_COMMAND_PROBE_ENV] = "0"
    assert.deepEqual(await refreshClaudeCommands({ cliPath: box.cliPath }, box.workspace), {
      status: "skipped",
      reason: "env-off",
    })
    assert.equal(box.spawns().length, 2)
  } finally {
    box.cleanup()
  }
})

function seed(box: ReturnType<typeof scratch>, commands: unknown[] = [PROJECT, STRIPE, RELEASE, INIT_SKILL, BUILTIN]) {
  writeCommandEntry({ configDir: box.configDir, cwd: box.workspace, probedAt: 1, commands: commands as never })
}

test("opencode 1: the config hook lists the stored commands and leaves opencode's names alone", async () => {
  const box = scratch()
  try {
    seed(box)
    const config: any = {
      command: { "hello-probe": { template: "operator's own", description: "mine" } },
      provider: { "claude-code": { options: { cliPath: box.cliPath } } },
    }
    const hooks = await (plugin as any).server({ directory: box.workspace })
    await hooks.config(config)
    assert.deepEqual(config.command["test-cards"], {
      template: "/stripe:test-cards $ARGUMENTS",
      description: "Claude Code: (stripe) Display Stripe test card numbers",
    })
    assert.equal(config.command.release.template, "/appical-core:release $ARGUMENTS")
    assert.deepEqual(config.command["hello-probe"], { template: "operator's own", description: "mine" })
    assert.equal(config.command.init, undefined, "opencode's /init is never replaced")
    assert.equal(config.command.model, undefined, "a Claude Code built-in is never offered")
    assert.ok(config.command.btw && config.command["claude-code-doctor"])
    assert.equal(box.spawns().length, 0, "the test env switches the probe off")

    // A second pass over a config that already holds this plugin's entries
    // lists them again rather than deferring to them.
    assert.equal(registerClaudeCommands(config, { cliPath: box.cliPath }, box.workspace), 2)
    const off: any = { command: {} }
    assert.equal(registerClaudeCommands(off, { claudeCommands: false }, box.workspace), 0)
    assert.deepEqual(off.command, {})
  } finally {
    // The config hook's startup diagnostics ask the fake for its version in
    // the background; removing it now would only make that check warn.
    process.once("exit", box.cleanup)
  }
})

function fakeV2Context(box: ReturnType<typeof scratch>, listed: unknown) {
  const transforms: Array<(editor: any) => void> = []
  let added: any[] = []
  const prompts: any[] = []
  let reloads = 0
  const registration = { dispose: async () => undefined }
  const ctx: any = {
    app: { version: "2.3.2" },
    location: { directory: box.workspace },
    options: {},
    provider: { transform: async () => registration },
    aisdk: { hook: async () => registration },
    session: {
      hook: async () => registration,
      prompt: async (input: any) => {
        prompts.push(input)
        return {}
      },
    },
    command: {
      list: async () => listed,
      transform: async (callback: (editor: any) => void) => {
        transforms.push(callback)
        callback({ add: (definition: any) => added.push(definition) })
        return registration
      },
      reload: async () => {
        reloads++
        added = []
        for (const callback of transforms) callback({ add: (definition: any) => added.push(definition) })
      },
    },
  }
  return { ctx, added: () => added, prompts, reloads: () => reloads }
}

test("opencode 2: setup lists the stored commands, skips opencode's names, and a menu entry sends the full name", async () => {
  const box = scratch()
  try {
    seed(box)
    const fake = fakeV2Context(box, [{ name: "init", description: "create AGENTS.md" }, { name: "goal" }])
    const setup = createV2Setup({
      createProvider: () => ({ languageModel: () => ({}) as any }),
      defaultProxyTools: [],
      loadConfig: () => ({ provider: { "claude-code": { options: { cliPath: box.cliPath } } } }),
    })
    await setup(fake.ctx)
    assert.deepEqual(fake.added().map((definition) => definition.name).sort(), [
      "btw",
      "claude-code-doctor",
      "hello-probe",
      "release",
      "test-cards",
    ])
    const cards = fake.added().find((definition) => definition.name === "test-cards")
    assert.equal(cards.description, "Claude Code: (stripe) Display Stripe test card numbers")
    await cards.execute({ sessionID: "ses_1", prompt: { text: "  visa ", files: [] }, delivery: "steer" })
    assert.deepEqual(fake.prompts, [{ text: "/stripe:test-cards visa", files: [], sessionID: "ses_1", delivery: "steer" }])
  } finally {
    box.cleanup()
  }
})

test("opencode 2: a probe that learns a new command reloads the menu in the same process", async () => {
  const box = scratch()
  try {
    process.env[CLAUDE_COMMAND_PROBE_ENV] = "1"
    box.setAnswer({ commands: [STRIPE, { name: "fresh:just-installed", description: "(fresh) new" }] })
    const fake = fakeV2Context(box, { data: [] })
    const setup = createV2Setup({
      createProvider: () => ({ languageModel: () => ({}) as any }),
      defaultProxyTools: [],
      loadConfig: () => ({ provider: { "claude-code": { options: { cliPath: box.cliPath } } } }),
    })
    await setup(fake.ctx)
    assert.ok(!fake.added().some((definition) => definition.name === "just-installed"), "nothing stored yet")
    const deadline = Date.now() + 60_000
    while (fake.reloads() === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20))
    assert.equal(fake.reloads(), 1)
    assert.ok(fake.added().some((definition) => definition.name === "just-installed"))
    assert.deepEqual(
      claudeMenuFor({ cliPath: box.cliPath }, box.workspace, new Set()).entries.map((entry) => entry.command),
      ["fresh:just-installed", "stripe:test-cards"],
    )
  } finally {
    box.cleanup()
  }
})
