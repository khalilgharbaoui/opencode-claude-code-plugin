/**
 * One conversation across any account and model, and the `accountGroups` guard
 * that decides how far it may travel (h #g226).
 *
 * The unit half drives `resolveAccountGroups`, the session-key helpers,
 * `modelSiblingSignature` with an account-provider map, both store lookups and
 * `failoverCandidates`. The end-to-end half drives real `doStream` turns
 * through a fake CLI with two account providers over one opencode session,
 * switching by hand between them, and reads the second spawn's argv, the
 * envelope written to its stdin and the parts the stream emitted.
 *
 * Every account runtime here lands under a throwaway HOME and
 * `XDG_CACHE_HOME`, so nothing writes a wrapper or a config dir into the real
 * ones, and the account names are this file's own.
 *
 * Usage: npx tsx --test test/account-groups.test.ts
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"

const HOME = mkdtempSync(join(tmpdir(), "opencode-account-groups-home-"))
const originalHome = process.env.HOME
const originalCache = process.env.XDG_CACHE_HOME
// The default account's config dir is `CLAUDE_CONFIG_DIR` when the operator
// exported one, and the cross-account carry writes into it, so an exported one
// in the runner's environment would send a transcript outside the scratch HOME.
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.HOME = HOME
process.env.XDG_CACHE_HOME = join(HOME, "cache")
delete process.env.CLAUDE_CONFIG_DIR

const { ensureAccountRuntime } = await import("../src/accounts.js")
const {
  ACCOUNT_GROUP_MARKER,
  _resetAccountGroupWarnings,
  accountGroup,
  accountProviderMap,
  accountsInGroupOf,
  accountsShareGroup,
  blankAccountProvider,
  describeAccountGroups,
  formatAccountGroupNote,
  resolveAccountGroups,
  sessionKeyAccount,
  sessionKeyProvider,
} = await import("../src/account-groups.js")
const { failoverCandidates } = await import("../src/account-failover.js")
const { modelSiblingSignature } = await import("../src/session-fork.js")
const {
  _setResumeStorePath,
  findForeignAccountSibling,
  findSiblingResumePoint,
  recordResumePoint,
} = await import("../src/session-resume-store.js")
const { encodeCwd } = await import("../src/claude-session-bun.js")
const { filterSideQuestionHistory } = await import("../src/message-builder.js")
const {
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  getClaudeSessionId,
  sessionKey,
} = await import("../src/session-manager.js")
const { detectCliVersion } = await import("../src/cli-version.js")
const { createClaudeCode } = await import("../src/index.js")

after(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalCache === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = originalCache
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(HOME, { recursive: true, force: true })
})

const ACCOUNTS = ["alpha", "beta"]
const CLI_ALPHA = "/opt/claude/claude-alpha"
const CLI_BETA = "/opt/claude/claude-beta"

const userText = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as any
const assistantText = (text: string) =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as any

const BEFORE = [
  { role: "system", content: "You are a helpful assistant." },
  userText("The project codename is MARLIN. Reply OK."),
] as any
const AFTER = [...BEFORE, assistantText("OK"), userText("What is the codename?")] as any

const contextFor = (provider: string) => `context=${JSON.stringify([provider, null])}`
const keyFor = (
  account: string,
  model = "claude-haiku-4-5",
  affinity = "ses_groups",
  cwd = "/work",
) => sessionKey(cwd, `${model}::tools::${affinity}::${contextFor(`claude-code-${account}`)}`)

// ---------------------------------------------------------------------------
// resolveAccountGroups
// ---------------------------------------------------------------------------

test("accountGroups is off unless set, and every refusal leaves it off", () => {
  _resetAccountGroupWarnings()
  // Unset, empty and every wrong shape all mean "no guard", never a throw.
  assert.equal(resolveAccountGroups(undefined, ACCOUNTS), null)
  assert.equal(resolveAccountGroups(null, ACCOUNTS), null)
  assert.equal(resolveAccountGroups({}, ACCOUNTS), null)
  assert.equal(resolveAccountGroups(["alpha", "work"], ACCOUNTS), null)
  assert.equal(resolveAccountGroups("work", ACCOUNTS), null)
  // A non-string group, an empty group and an account nobody configured are
  // each dropped on their own, leaving the rest of the map in force.
  assert.deepEqual(
    resolveAccountGroups(
      { alpha: "work", beta: 7, gamma: "private", "   ": "x", delta: "" },
      ACCOUNTS,
    ),
    { alpha: "work" },
  )
  // Names are normalized on both sides, so configuration spelling is not a trap.
  assert.deepEqual(resolveAccountGroups({ ALPHA: "  Work " }, ACCOUNTS), { alpha: "work" })
  // With no known list to check against, only the shape is validated.
  assert.deepEqual(resolveAccountGroups({ gamma: "private" }), { gamma: "private" })
})

test("an account is in the implicit default group until a map says otherwise", () => {
  const groups = resolveAccountGroups({ beta: "work" }, ACCOUNTS)!
  assert.equal(accountGroup("beta", groups), "work")
  assert.equal(accountGroup("alpha", groups), "default")
  assert.equal(accountGroup(undefined, groups), "default")
  assert.equal(accountGroup("beta", null), "default", "no map means one group")

  assert.equal(accountsShareGroup("alpha", "beta", null), true, "the guard is opt-in")
  assert.equal(accountsShareGroup("alpha", "beta", groups), false)
  assert.equal(accountsShareGroup("beta", "beta", groups), true)

  assert.deepEqual(accountsInGroupOf("alpha", ACCOUNTS, groups), ["alpha"])
  assert.deepEqual(accountsInGroupOf("alpha", ACCOUNTS, null), ["alpha", "beta"])
  assert.deepEqual(describeAccountGroups(groups), ["beta=work"])
  assert.deepEqual(describeAccountGroups(null), [])
})

// ---------------------------------------------------------------------------
// Session keys
// ---------------------------------------------------------------------------

test("only this install's own account providers are read out of a session key", () => {
  const providers = accountProviderMap(ACCOUNTS)
  assert.deepEqual([...providers.entries()].sort(), [
    ["claude-code-alpha", "alpha"],
    ["claude-code-beta", "beta"],
  ])

  assert.equal(sessionKeyProvider(keyFor("alpha")), "claude-code-alpha")
  assert.equal(sessionKeyAccount(keyFor("beta"), providers), "beta")
  // A provider this install never expanded is nobody's account, however much
  // its id looks like one.
  assert.equal(sessionKeyAccount(keyFor("gamma"), providers), undefined)
  assert.equal(
    sessionKeyAccount(sessionKey("/work", "m::compaction::ses_groups"), providers),
    undefined,
    "a compaction key has no context blob",
  )
  assert.equal(sessionKeyProvider("/work::model"), undefined)

  // Blanking is keyed on the map, so an empty one leaves every key untouched:
  // that is what makes a single-account install byte-identical.
  assert.equal(blankAccountProvider(keyFor("alpha"), new Map()), keyFor("alpha"))
  assert.equal(blankAccountProvider(keyFor("gamma"), providers), keyFor("gamma"))
  assert.notEqual(blankAccountProvider(keyFor("alpha"), providers), keyFor("alpha"))
  assert.equal(
    blankAccountProvider(keyFor("alpha"), providers),
    blankAccountProvider(keyFor("beta"), providers),
  )
})

test("modelSiblingSignature treats a model, an effort and an account as one conversation", () => {
  const providers = accountProviderMap(ACCOUNTS)
  const alpha = keyFor("alpha")
  const beta = keyFor("beta")
  const betaSonnet = keyFor("beta", "claude-sonnet-4-5")
  const betaHigh = `${beta}::effort=high`

  // Without the map the account is still strict, which is the behaviour every
  // caller had before this existed.
  assert.notEqual(modelSiblingSignature(alpha), modelSiblingSignature(beta))

  for (const other of [beta, betaSonnet, betaHigh]) {
    assert.equal(
      modelSiblingSignature(alpha, providers),
      modelSiblingSignature(other, providers),
      other,
    )
  }
  // Everything else still has to match exactly.
  for (const other of [
    keyFor("beta", "claude-haiku-4-5", "ses_other"),
    keyFor("beta", "claude-haiku-4-5", "ses_groups", "/elsewhere"),
    sessionKey("/work", `claude-haiku-4-5::no-tools::ses_groups::${contextFor("claude-code-beta")}`),
    sessionKey(
      "/work",
      `claude-haiku-4-5::tools::ses_groups::context=${JSON.stringify(["claude-code-beta", "worker"])}`,
    ),
  ]) {
    assert.notEqual(modelSiblingSignature(other, providers), modelSiblingSignature(alpha, providers), other)
  }
})

// ---------------------------------------------------------------------------
// The store lookups
// ---------------------------------------------------------------------------

function scratchStore(): { dir: string; transcriptIn: (id: string, configDir?: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), "opencode-account-groups-"))
  _setResumeStorePath(join(dir, "state", "claude-sessions.json"))
  return {
    dir,
    transcriptIn: (id, configDir) => join(configDir ?? join(dir, "own"), `${id}.jsonl`),
  }
}

function sibling(
  key: string,
  prompt: any,
  transcriptIn: (id: string, configDir?: string) => string,
  overrides: {
    cliPath?: string
    allowAccount?: (account: string) => boolean
    providers?: ReadonlyMap<string, string>
  } = {},
) {
  const refusals: string[] = []
  const found = findSiblingResumePoint({
    sessionKey: key,
    prompt,
    cliPath: overrides.cliPath ?? CLI_BETA,
    transcriptPath: transcriptIn,
    isBusy: () => false,
    accountProviders: overrides.providers ?? accountProviderMap(ACCOUNTS),
    allowAccount: overrides.allowAccount,
    onRefused: (reason) => refusals.push(reason),
  })
  return { found, refusals }
}

test("a sibling on another account is found, carried from ITS config dir, and refused by group", () => {
  const { dir, transcriptIn } = scratchStore()
  const alphaDir = join(dir, "alpha-config")
  try {
    mkdirSync(alphaDir, { recursive: true })
    recordResumePoint(keyFor("alpha"), "claude-1", BEFORE, CLI_ALPHA, {
      configDir: alphaDir,
      account: "alpha",
    })
    // The transcript is under ALPHA's directory, which is the whole point: a
    // lookup that only knew this account's own directory would refuse it.
    writeFileSync(transcriptIn("claude-1", alphaDir), "")

    const hit = sibling(keyFor("beta"), AFTER, transcriptIn)
    assert.equal(hit.found?.claudeSessionId, "claude-1")
    assert.equal(hit.found?.siblingAccount, "alpha")
    assert.equal(hit.found?.siblingConfigDir, alphaDir)

    // The group guard is the caller's answer, and it is reported by name.
    const refused = sibling(keyFor("beta"), AFTER, transcriptIn, {
      allowAccount: () => false,
    })
    assert.equal(refused.found, undefined)
    assert.deepEqual(refused.refusals, ["sibling-another-account-group"])

    // No account-provider map means the account stays strict, so the differing
    // binary is what refuses: the pre-(h #g226) answer, unchanged.
    const strict = sibling(keyFor("beta"), AFTER, transcriptIn, { providers: new Map() })
    assert.equal(strict.found, undefined)
  } finally {
    _setResumeStorePath(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a cross-account sibling with no recorded config dir is refused, not guessed at", () => {
  const { dir, transcriptIn } = scratchStore()
  try {
    // What a record written before (h #g226) looks like: no `configDir`, so
    // there is no file to carry and the account name alone cannot name one.
    recordResumePoint(keyFor("alpha"), "claude-1", BEFORE, CLI_ALPHA)
    mkdirSync(join(dir, "own"), { recursive: true })
    writeFileSync(transcriptIn("claude-1"), "")
    const hit = sibling(keyFor("beta"), AFTER, transcriptIn)
    assert.equal(hit.found, undefined)
    assert.deepEqual(hit.refusals, ["sibling-account-dir-unknown"])
  } finally {
    _setResumeStorePath(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a same-account sibling still demands the same binary", () => {
  const { dir, transcriptIn } = scratchStore()
  const betaDir = join(dir, "beta-config")
  try {
    mkdirSync(betaDir, { recursive: true })
    recordResumePoint(keyFor("beta", "claude-haiku-4-5"), "claude-1", BEFORE, CLI_ALPHA, {
      configDir: betaDir,
      account: "beta",
    })
    writeFileSync(transcriptIn("claude-1", betaDir), "")
    const hit = sibling(keyFor("beta", "claude-sonnet-4-5"), AFTER, transcriptIn, {
      cliPath: CLI_BETA,
    })
    assert.equal(hit.found, undefined)
    assert.deepEqual(hit.refusals, ["sibling-another-claude-binary"])
  } finally {
    _setResumeStorePath(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the group guard's detector ignores content, binaries and transcripts", () => {
  const { dir } = scratchStore()
  const providers = accountProviderMap(ACCOUNTS)
  try {
    // A record whose conversation no longer matches at all. The carry would
    // refuse it; the guard must still see that another account answered this
    // conversation, because the replay is exactly what happens then.
    recordResumePoint(keyFor("alpha"), "claude-1", BEFORE, CLI_ALPHA, {
      configDir: join(dir, "alpha-config"),
      account: "alpha",
    })
    assert.deepEqual(
      findForeignAccountSibling({ sessionKey: keyFor("beta"), accountProviders: providers }),
      { siblingKey: keyFor("alpha"), account: "alpha" },
    )
    // Not this key, not another opencode session, and nothing at all without
    // an account-provider map.
    assert.equal(
      findForeignAccountSibling({ sessionKey: keyFor("alpha"), accountProviders: providers }),
      undefined,
    )
    assert.equal(
      findForeignAccountSibling({
        sessionKey: keyFor("beta", "claude-haiku-4-5", "ses_other"),
        accountProviders: providers,
      }),
      undefined,
    )
    assert.equal(
      findForeignAccountSibling({ sessionKey: keyFor("beta"), accountProviders: new Map() }),
      undefined,
    )
    // The in-memory keys are consulted too, so the guard holds with
    // `resumeAfterRestart: false`, where nothing is ever written to the store.
    _setResumeStorePath(join(dir, "empty", "claude-sessions.json"))
    assert.equal(
      findForeignAccountSibling({ sessionKey: keyFor("beta"), accountProviders: providers }),
      undefined,
    )
    assert.deepEqual(
      findForeignAccountSibling({
        sessionKey: keyFor("beta"),
        accountProviders: providers,
        extraKeys: [keyFor("alpha")],
      }),
      { siblingKey: keyFor("alpha"), account: "alpha" },
    )
  } finally {
    _setResumeStorePath(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The form and the notes
// ---------------------------------------------------------------------------

test("the switch form and both notes offer only same-group accounts", () => {
  const all = ["default", "alpha", "beta"]
  assert.deepEqual(failoverCandidates(all, "default"), ["alpha", "beta"])
  assert.deepEqual(failoverCandidates(all, "default", null), ["alpha", "beta"])

  const groups = resolveAccountGroups({ beta: "work" }, all)!
  assert.deepEqual(failoverCandidates(all, "default", groups), ["alpha"])
  assert.deepEqual(failoverCandidates(all, "alpha", groups), ["default"])
  // Nothing left in the group behaves exactly as a single-account install:
  // `isAccountFailoverQuestionActive` refuses an empty candidate list and the
  // usage-limit note drops its "pick a model from ..." sentence.
  assert.deepEqual(failoverCandidates(all, "beta", groups), [])
})

test("the account-group note names both accounts and both groups, and is stripped on replay", () => {
  const note = formatAccountGroupNote({
    sourceAccount: "alpha",
    sourceGroup: "private",
    targetAccount: "beta",
    targetGroup: "work",
  })
  assert.ok(note.trimStart().startsWith(ACCOUNT_GROUP_MARKER))
  for (const fragment of ['"alpha"', '"beta"', '"private"', '"work"', "accountGroups"]) {
    assert.ok(note.includes(fragment), fragment)
  }

  // Registered in `PLUGIN_NOTE_MARKERS`: the plugin wrote it, so a rebuilt
  // transcript must never hand it back as something Claude said.
  const rebuilt = filterSideQuestionHistory([
    userText("hello"),
    {
      role: "assistant",
      content: [{ type: "text", text: note }, { type: "text", text: "Claude's own reply" }],
    },
  ] as any) as any[]
  assert.deepEqual(rebuilt[1].content, [{ type: "text", text: "Claude's own reply" }])
})

// ---------------------------------------------------------------------------
// End to end: two account providers, one opencode session, a by-hand switch
// ---------------------------------------------------------------------------

async function createSwitchFixture(
  accountGroups?: Record<string, string>,
  extra: Record<string, unknown> = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-account-groups-e2e-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const eventsPath = join(cwd, "events.jsonl")
  writeFileSync(eventsPath, "")
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
const args = process.argv.slice(2)
const record = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + "\\n")
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
if (args.includes("--version")) {
  process.stdout.write("2.1.288\\n")
  process.exit(0)
}
if (args.includes("--help")) {
  process.exit(0)
}
const at = args.indexOf("--resume")
const sessionId = at >= 0 ? args[at + 1] : "claude-on-alpha"
record({
  type: "spawn",
  args,
  sessionId,
  configDir: process.env.CLAUDE_CONFIG_DIR || null,
})
emit({ type: "system", subtype: "init", session_id: sessionId })
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const envelope = JSON.parse(line)
  if (envelope.type !== "user") return
  record({ type: "input", sessionId, envelope })
  emit({ type: "assistant", session_id: sessionId, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "MARLIN" }] } })
  emit({ type: "result", subtype: "success", session_id: sessionId, is_error: false, usage: { input_tokens: 9, output_tokens: 4 } })
})
`,
    { mode: 0o755 },
  )
  _setResumeStorePath(join(cwd, "state", "claude-sessions.json"))

  const runtimes: Record<string, { cliPath: string; configDir: string }> = {}
  const providers: Record<string, ReturnType<typeof createClaudeCode>> = {}
  for (const account of ACCOUNTS) {
    const runtime = await ensureAccountRuntime(account, cliPath)
    runtimes[account] = { cliPath: runtime.cliPath, configDir: runtime.configDir! }
    providers[account] = createClaudeCode({
      cliPath: runtime.cliPath,
      baseCliPath: cliPath,
      configDir: runtime.configDir,
      providerID: `claude-code-${account}`,
      account,
      failoverAccounts: [...ACCOUNTS],
      ...(accountGroups ? { accountGroups } : {}),
      cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: [],
      interactive: false,
      autoContinueIncompleteTurns: false,
      ...extra,
    } as any)
  }

  const keys: string[] = []
  const key = (account: string, modelId: string, affinity = "ses_groups") => {
    const k = sessionKey(
      cwd,
      `${modelId}::tools::${affinity}::${contextFor(`claude-code-${account}`)}`,
    )
    if (!keys.includes(k)) keys.push(k)
    return k
  }

  const events = () =>
    readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as any)

  return {
    cwd,
    key,
    configDir: (account: string) => runtimes[account]!.configDir,
    spawns: () => events().filter((event) => event.type === "spawn"),
    lastInput: () => JSON.stringify(events().filter((e) => e.type === "input").at(-1)?.envelope),
    transcriptPath: (account: string, id: string) =>
      join(runtimes[account]!.configDir, "projects", encodeCwd(cwd), `${id}.jsonl`),
    writeTranscript(account: string, id: string) {
      const dir = join(runtimes[account]!.configDir, "projects", encodeCwd(cwd))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${id}.jsonl`), '{"type":"user"}\n')
    },
    /** What the CLI itself would do to a transcript it was handed: append. */
    appendTranscript(account: string, id: string, line: string) {
      const file = join(runtimes[account]!.configDir, "projects", encodeCwd(cwd), `${id}.jsonl`)
      writeFileSync(file, readFileSync(file, "utf8") + line)
    },
    async turn(account: string, modelId: string, prompt: any[], affinity = "ses_groups") {
      key(account, modelId, affinity)
      const call: LanguageModelV3CallOptions = {
        prompt,
        headers: { "x-session-affinity": affinity },
        tools: [{ type: "function", name: "read", inputSchema: { type: "object", properties: {} } }],
        abortSignal: AbortSignal.timeout(30_000),
      } as any
      const response = await providers[account]!.languageModel(modelId).doStream(call)
      const parts: LanguageModelV3StreamPart[] = []
      for await (const part of response.stream) {
        if (part.type === "error") throw (part as any).error
        parts.push(part)
      }
      return parts
    },
    async warm() {
      for (const account of ACCOUNTS) {
        let ok = false
        for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
          ok = !!(await detectCliVersion(runtimes[account]!.cliPath))
        }
        if (!ok) throw new Error(`the fake CLI never answered --version for ${account}`)
      }
    },
    async cleanup() {
      for (const k of keys) {
        await deleteActiveProcessAndWait(k)
        deleteClaudeSessionId(k)
      }
      _setResumeStorePath(null)
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

const MODEL = "claude-test-groups"

const deltas = (parts: LanguageModelV3StreamPart[]) =>
  parts
    .filter((part) => part.type === "text-delta")
    .map((part) => (part as { delta: string }).delta)
    .join("")

test("a by-hand account switch carries the conversation instead of replaying it", {
  timeout: 60_000,
}, async () => {
  const fake = await createSwitchFixture()
  try {
    await fake.warm()
    await fake.turn("alpha", MODEL, [...BEFORE])
    assert.equal(getClaudeSessionId(fake.key("alpha", MODEL)), "claude-on-alpha")
    fake.writeTranscript("alpha", "claude-on-alpha")

    const parts = await fake.turn("beta", MODEL, [...AFTER])

    const spawns = fake.spawns()
    assert.equal(spawns.length, 2)
    const args: string[] = spawns[1].args
    const at = args.indexOf("--resume")
    assert.deepEqual(
      args.slice(at, at + 2),
      ["--resume", "claude-on-alpha"],
      `the second account resumes the first account's conversation: ${JSON.stringify(args)}`,
    )
    // The spawn ran as beta, and the file is now under beta's own config dir.
    assert.equal(spawns[1].configDir, fake.configDir("beta"))
    assert.ok(existsSync(fake.transcriptPath("beta", "claude-on-alpha")))
    // The source is never moved or deleted, so switching back has something
    // to come back to.
    assert.ok(existsSync(fake.transcriptPath("alpha", "claude-on-alpha")))

    const sent = fake.lastInput()
    assert.ok(!sent.includes("conversation_history"), sent.slice(0, 400))
    assert.ok(sent.includes("What is the codename?"))
    // Nothing was blocked, so nothing is said about groups.
    assert.ok(!deltas(parts).includes(ACCOUNT_GROUP_MARKER))

    // A move, not a copy: one conversation has exactly one owner.
    assert.equal(getClaudeSessionId(fake.key("alpha", MODEL)), undefined)
  } finally {
    await fake.cleanup()
  }
})

test("switching back carries the conversation home again", { timeout: 60_000 }, async () => {
  const fake = await createSwitchFixture()
  try {
    await fake.warm()
    await fake.turn("alpha", MODEL, [...BEFORE])
    fake.writeTranscript("alpha", "claude-on-alpha")
    await fake.turn("beta", MODEL, [...AFTER])
    // What the CLI did on beta: it appended to the copy it was given. That is
    // what makes beta's copy the live one, and alpha's original the stale one
    // a carry back must not resume (the SIZE rule, h #g218).
    fake.appendTranscript("beta", "claude-on-alpha", '{"type":"assistant"}\n')

    const AFTER_BETA = [...AFTER, assistantText("MARLIN"), userText("And again?")] as any
    await fake.turn("alpha", MODEL, AFTER_BETA)

    const args: string[] = fake.spawns()[2]!.args
    const at = args.indexOf("--resume")
    assert.ok(at >= 0, `the way back resumes too: ${JSON.stringify(args)}`)
    // Alpha's own path still holds the stale original from before the first
    // switch, so the carry back never overwrites it and takes a fresh id.
    assert.notEqual(args[at + 1], "claude-on-alpha")
    assert.equal(
      readFileSync(fake.transcriptPath("alpha", args[at + 1]!), "utf8"),
      readFileSync(fake.transcriptPath("beta", "claude-on-alpha"), "utf8"),
      "and it is beta's longer copy that came back, not alpha's stale one",
    )
    assert.equal(getClaudeSessionId(fake.key("alpha", MODEL)), args[at + 1])
    assert.equal(getClaudeSessionId(fake.key("beta", MODEL)), undefined)
    assert.ok(!fake.lastInput().includes("conversation_history"))
  } finally {
    await fake.cleanup()
  }
})

test("accountGroups blocks the carry AND the replay, and says so once", {
  timeout: 60_000,
}, async () => {
  const fake = await createSwitchFixture({ beta: "work" })
  try {
    await fake.warm()
    await fake.turn("alpha", MODEL, [...BEFORE])
    fake.writeTranscript("alpha", "claude-on-alpha")

    const parts = await fake.turn("beta", MODEL, [...AFTER])

    const args: string[] = fake.spawns()[1]!.args
    assert.ok(!args.includes("--resume"), `nothing is resumed: ${JSON.stringify(args)}`)
    assert.ok(
      !existsSync(fake.transcriptPath("beta", "claude-on-alpha")),
      "and no transcript was copied across",
    )

    // The replay is the same history by another route, so it is out too: the
    // envelope carries this turn's message and nothing of what came before.
    const sent = fake.lastInput()
    assert.ok(!sent.includes("conversation_history"), sent.slice(0, 400))
    assert.ok(!sent.includes("MARLIN"), `no earlier message text: ${sent.slice(0, 600)}`)
    assert.ok(!sent.includes("Reply OK"), sent.slice(0, 600))
    assert.ok(sent.includes("What is the codename?"))

    const text = deltas(parts)
    assert.ok(text.includes(ACCOUNT_GROUP_MARKER), text.slice(0, 400))
    assert.ok(text.includes('"alpha"') && text.includes('"beta"'), text.slice(0, 400))
    // Its own text part, so the strip is exact.
    assert.ok(
      parts.some(
        (part) => part.type === "text-delta" &&
          (part as { delta: string }).delta.trimStart().startsWith(ACCOUNT_GROUP_MARKER),
      ),
    )

    // The conversation is left intact on the account it was on.
    assert.equal(getClaudeSessionId(fake.key("alpha", MODEL)), "claude-on-alpha")
    assert.ok(existsSync(fake.transcriptPath("alpha", "claude-on-alpha")))
  } finally {
    await fake.cleanup()
  }
})

test("crossAccountResume: false replays a by-hand switch, as before", {
  timeout: 60_000,
}, async () => {
  const fake = await createSwitchFixture(undefined, { crossAccountResume: false })
  try {
    await fake.warm()
    await fake.turn("alpha", MODEL, [...BEFORE])
    fake.writeTranscript("alpha", "claude-on-alpha")
    const parts = await fake.turn("beta", MODEL, [...AFTER])

    const args: string[] = fake.spawns()[1]!.args
    assert.ok(!args.includes("--resume"), JSON.stringify(args))
    assert.ok(fake.lastInput().includes("conversation_history"), "the thread is replayed")
    // A replay is not a guard, so it says nothing about groups.
    assert.ok(!deltas(parts).includes(ACCOUNT_GROUP_MARKER))
    assert.equal(getClaudeSessionId(fake.key("alpha", MODEL)), "claude-on-alpha", "untouched")
  } finally {
    await fake.cleanup()
  }
})

test("a same-group switch under accountGroups still carries, and says nothing", {
  timeout: 60_000,
}, async () => {
  // Both accounts named into ONE group: the guard is configured and the switch
  // is still an ordinary carry, which is what stops the option reading as an
  // on/off switch for the feature itself.
  const fake = await createSwitchFixture({ alpha: "work", beta: "work" })
  try {
    await fake.warm()
    await fake.turn("alpha", MODEL, [...BEFORE])
    fake.writeTranscript("alpha", "claude-on-alpha")
    const parts = await fake.turn("beta", MODEL, [...AFTER])

    const args: string[] = fake.spawns()[1]!.args
    assert.ok(args.includes("--resume"), JSON.stringify(args))
    assert.ok(!deltas(parts).includes(ACCOUNT_GROUP_MARKER))
  } finally {
    await fake.cleanup()
  }
})
