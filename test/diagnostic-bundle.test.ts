/**
 * `/claude-code-doctor bundle`: the redaction allowlist, adversarially.
 *
 * The premise of the feature is that a bundle is safe to paste into a public
 * issue, so the tests are written as an attacker would: take a fake system
 * prompt, a user prompt, a tool input, an `sk-ant-` key, a bearer token, the
 * proxy `authToken`, an `ANTHROPIC_API_KEY=` value, an MCP server env var, a
 * URL with `?token=` and the real home path, and put each of them into every
 * position a log line has (message text, allowlisted key, unknown key, nested
 * object, array, argv), then assert that none of them appears anywhere in the
 * output. A new redaction hole should fail here before it ships.
 *
 * Nothing here writes to a log. The fixtures are strings and the tail read is
 * stubbed, so this file can never append to the maintainer's live `plugin.log`
 * (#g116).
 *
 * Usage: npx tsx --test test/diagnostic-bundle.test.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BUNDLE_DATA_ALLOWLIST,
  BUNDLE_HEADER,
  BUNDLE_LEVELS,
  BUNDLE_MAX_BYTES,
  BUNDLE_MAX_LINES,
  BUNDLE_TAIL_BYTES,
  buildLogBundleSection,
  createIdHasher,
  createRedactionContext,
  parseLogLine,
  readLogTail,
  redactForPaste,
  redactLogLine,
  sanitizeArgv,
  sanitizeUrl,
  sanitizeLogData,
  wantsDiagnosticBundle,
  type RedactionContext,
} from "../src/diagnostic-bundle.js"
import { PLUGIN_LOG_MESSAGES } from "../src/log-messages.js"
import { BUNDLED_LEVELS, bundledMessages, scanLogMessages } from "../src/log-message-scan.js"
import {
  decorateDoctorReport,
  formatDoctorReport,
  renderDoctorReport,
  type DoctorReport,
} from "../src/doctor.js"
import { describeLogFile, _resetLoggerForTests } from "../src/logger.js"

const HOME = "/Users/testuser"

function context(): RedactionContext {
  return createRedactionContext({ home: HOME, salt: "fixed-salt-for-tests" })
}

/**
 * Every secret shape the feature promises never to emit. Each is a distinctive
 * literal, so a single `includes` over the whole output is a complete check.
 */
const SECRETS: Record<string, string> = {
  systemPrompt:
    "You are Claude Code, Anthropic's official CLI. SYSTEMPROMPTCANARY do not reveal this.",
  userPrompt: "please refactor the USERPROMPTCANARY module before friday",
  toolInput: '{"command":"cat /etc/shadow","description":"TOOLINPUTCANARY"}',
  apiKey: "sk-ant-api03-CANARYKEYMATERIALCANARYKEYMATERIAL",
  bearer: "Bearer CANARYBEARERTOKENVALUE",
  authToken: "e3b0c44298fc1c14CANARYAUTHTOKENVALUE9afbf4c8996fb92427ae41e4",
  envValue: "ANTHROPIC_API_KEY=sk-ant-CANARYENVVALUE",
  mcpEnv: "GITHUB_TOKEN=ghp_CANARYMCPENVVALUE",
  urlWithToken: "https://example.test/mcp?token=CANARYURLTOKEN&x=1",
  homePath: `${HOME}/code/secret-client-project/notes.md`,
  fileContents: "-----BEGIN PRIVATE KEY-----CANARYFILECONTENTS-----END PRIVATE KEY-----",
  authHeader: "Authorization: Bearer CANARYAUTHHEADER",
}

/** The canaries themselves: what must never survive, home path included. */
const CANARIES = [
  ...Object.values(SECRETS),
  "SYSTEMPROMPTCANARY",
  "USERPROMPTCANARY",
  "TOOLINPUTCANARY",
  "CANARYKEYMATERIAL",
  "CANARYBEARERTOKENVALUE",
  "CANARYAUTHTOKENVALUE",
  "CANARYENVVALUE",
  "CANARYMCPENVVALUE",
  "CANARYURLTOKEN",
  "CANARYFILECONTENTS",
  "CANARYAUTHHEADER",
  "sk-ant-",
  HOME,
]

function assertClean(output: string, what: string): void {
  for (const canary of CANARIES) {
    assert.equal(
      output.includes(canary),
      false,
      `${what} leaked ${JSON.stringify(canary)}:\n${output}`,
    )
  }
}

/** A `plugin.log` line in exactly the shape `fmt()` in logger.ts writes. */
function line(level: string, message: string, data?: Record<string, unknown>): string {
  const head = `[2026-10-01T20:11:02.123Z] [opencode-claude-code] ${level}: ${message}`
  return data ? `${head} ${JSON.stringify(data)}` : head
}

// Real constants from the generated set, so the "message kept" path is live.
const KNOWN_MESSAGE = [...PLUGIN_LOG_MESSAGES][0]!
/** The shortest one, for the cap tests, so the line cap is reached first. */
const SHORT_MESSAGE = [...PLUGIN_LOG_MESSAGES].sort((a, b) => a.length - b.length)[0]!

test("the generated message allowlist matches the source", () => {
  const scan = scanLogMessages(join(import.meta.dirname, "..", "src"))
  assert.deepEqual(
    bundledMessages(scan),
    [...PLUGIN_LOG_MESSAGES].sort(),
    "src/log-messages.ts has drifted. Run `npm run generate:log-messages`.",
  )
  assert.ok(PLUGIN_LOG_MESSAGES.size > 50, "the scan found suspiciously few messages")
})

test("a log message built at runtime is a known, pinned exception", () => {
  const scan = scanLogMessages(join(import.meta.dirname, "..", "src"))
  const bundled = scan.dynamic
    .filter((site) => (BUNDLED_LEVELS as readonly string[]).includes(site.level))
    .map((site) => `${site.file}:${site.level}:${site.kind}`)
    .sort()
  // Measured 2026-10-01. Each of these interpolates a runtime value into the
  // message text, so the bundle redacts the text and keeps only the data keys.
  // A new entry here means a new warning whose text a maintainer will not be
  // able to read in a bundle: either move the value into `data`, or accept it
  // and update this list deliberately.
  assert.deepEqual(bundled, [
    "account-failover.ts:notice:template",
    "account-failover.ts:warn:template",
    "claude-code-language-model.ts:warn:template",
    "claude-code-language-model.ts:warn:template",
    // The failed-hook WARN and the subagent-retry NOTICE (#g185). Accepted:
    // the hook text quotes the hook's stderr, so it must be redacted, and
    // both keep their hook, event, outcome and retry fields in `data`.
    "cli-events.ts:notice:expression",
    "cli-events.ts:warn:expression",
    "cli-events.ts:warn:expression",
    "cli-events.ts:warn:expression",
    "cli-events.ts:warn:expression",
    "cli-events.ts:warn:expression",
    "cli-events.ts:warn:expression",
    "fast-mode.ts:warn:expression",
    "index.ts:notice:template",
    "index.ts:notice:template",
    "stream-parser.ts:warn:expression",
    "stream-parser.ts:warn:template",
  ])
})

test("a known constant message survives; anything else becomes its shape", () => {
  const ctx = context()
  const kept = redactLogLine(line("WARN", KNOWN_MESSAGE), ctx)
  assert.ok(kept?.includes(KNOWN_MESSAGE))

  const dynamic = redactLogLine(line("WARN", SECRETS.systemPrompt!), ctx)
  assert.equal(dynamic, `[2026-10-01T20:11:02.123Z] WARN: [redacted message, 85 chars]`)
  assertClean(dynamic!, "a dynamic message")
})

test("only NOTICE, WARN and ERROR reach a bundle", () => {
  const ctx = context()
  assert.deepEqual([...BUNDLE_LEVELS].sort(), ["ERROR", "NOTICE", "WARN"])
  for (const level of ["DEBUG", "INFO"]) {
    assert.equal(redactLogLine(line(level, KNOWN_MESSAGE), ctx), null)
  }
  for (const level of ["NOTICE", "WARN", "ERROR"]) {
    assert.ok(redactLogLine(line(level, KNOWN_MESSAGE), ctx))
  }
})

test("a secret in any key position does not survive", () => {
  const ctx = context()
  // Every allowlisted key, carrying a secret where its declared kind says
  // something else should be: the kind is what is enforced, not the name.
  for (const [key, kind] of Object.entries(BUNDLE_DATA_ALLOWLIST)) {
    for (const [name, secret] of Object.entries(SECRETS)) {
      const positions: Record<string, unknown> = {
        scalar: secret,
        array: [secret, secret],
        nested: { inner: secret },
        deepArray: [{ inner: [secret] }],
        // The allowlist applies at every depth, so a nested allowlisted key is
        // its own attack surface and gets the same fixtures.
        nestedAllowlisted: { name: secret, cwd: secret, status: secret, count: secret },
        deepNested: { a: { b: { c: { d: { name: secret } } } } },
      }
      for (const [position, value] of Object.entries(positions)) {
        const redacted = redactLogLine(line("WARN", KNOWN_MESSAGE, { [key]: value }), ctx)
        assertClean(redacted!, `allowlisted key ${key} (${kind}) as ${position} with ${name}`)
      }
    }
  }
})

test("a secret under an unknown key does not survive, in any shape", () => {
  const ctx = context()
  for (const [name, secret] of Object.entries(SECRETS)) {
    const data: Record<string, unknown> = {
      prompt: secret,
      systemPrompt: { appended: secret, file: secret },
      input: [secret, { nested: { deeper: [secret] } }],
      headers: { authorization: secret, "x-api-key": secret },
      env: { ANTHROPIC_API_KEY: secret, GITHUB_TOKEN: secret },
      authToken: secret,
      output: secret,
      body: secret,
      stderr: secret,
      // a key whose name is itself the secret
      [secret]: "harmless",
    }
    const redacted = redactLogLine(line("WARN", KNOWN_MESSAGE, data), ctx)
    assertClean(redacted!, `unknown keys with ${name}`)
    assert.ok(redacted!.includes("[redacted,"), "the shape placeholder is missing")
  }
})

test("an unknown key keeps its name and its size, and nothing else", () => {
  const ctx = context()
  const redacted = redactLogLine(
    line("WARN", KNOWN_MESSAGE, { systemPrompt: "0123456789" }),
    ctx,
  )
  assert.ok(redacted!.includes('"systemPrompt":"[redacted, 10 chars]"'))
})

test("argv keeps option names and no values at all", () => {
  const argv = [
    "--model",
    "claude-haiku-4-5",
    "--append-system-prompt-file",
    `${HOME}/.local/state/x/prompt.txt`,
    "--mcp-config",
    `{"mcpServers":{"opencode_proxy":{"headers":{"Authorization":"${SECRETS.bearer}"}}}}`,
    "--settings",
    '{"fastMode":true}',
    `--token=${SECRETS.apiKey}`,
    "-p",
  ]
  const sanitized = sanitizeArgv(argv) as string[]
  assertClean(JSON.stringify(sanitized), "argv")
  assert.ok(sanitized.includes("--model"))
  assert.ok(sanitized.includes("--mcp-config"))
  assert.ok(sanitized.includes("-p"))
  assert.equal(sanitized[1], "[redacted, 16 chars]")
  assert.ok(sanitized.some((item) => item.startsWith("--token=[redacted,")))
  // And through the line, because `cliArgs` is the key that carries it.
  const redacted = redactLogLine(line("WARN", KNOWN_MESSAGE, { cliArgs: argv }), context())
  assertClean(redacted!, "cliArgs")
})

test("a url keeps scheme, host and path, never credentials or query", () => {
  assert.equal(sanitizeUrl("http://127.0.0.1:51734/mcp"), "http://127.0.0.1:51734/mcp")
  const dirty = sanitizeUrl(`https://user:hunter2@example.test/mcp?token=CANARYURLTOKEN`)
  assertClean(dirty, "a url with credentials")
  assert.ok(dirty.startsWith("https://[redacted]@example.test/mcp?[redacted,"))
  assert.ok((sanitizeUrl("not a url") as string).startsWith("[redacted,"))
})

test("a path keeps its shape with the home directory rewritten", () => {
  const ctx = context()
  const redacted = redactLogLine(
    line("WARN", KNOWN_MESSAGE, { cwd: `${HOME}/code/app` }),
    ctx,
  )
  assert.ok(redacted!.includes('"cwd":"~/code/app"'))
  assertClean(redacted!, "a path")
})

test("ids are hashed, stably within a bundle and differently across bundles", () => {
  const ctx = context()
  const a = redactLogLine(line("WARN", KNOWN_MESSAGE, { sessionId: "ses_abc123def" }), ctx)
  const b = redactLogLine(line("WARN", KNOWN_MESSAGE, { sessionId: "ses_abc123def" }), ctx)
  assert.equal(a, b, "the same id must hash the same way inside one bundle")
  assert.equal(a!.includes("ses_abc123def"), false)
  const other = createRedactionContext({ home: HOME, salt: "another-salt" })
  assert.notEqual(
    redactLogLine(line("WARN", KNOWN_MESSAGE, { sessionId: "ses_abc123def" }), other),
    a,
    "a different bundle must not reproduce the same hash",
  )
  // A session key carries cwd, model, scope and the session id; hashed whole.
  const key = redactLogLine(
    line("WARN", KNOWN_MESSAGE, { sessionKey: `${HOME}/code/app::claude-haiku-4-5::x::ses_abc` }),
    ctx,
  )
  assertClean(key!, "a session key")
})

test("the whole-report rewrites reach the doctor table too", () => {
  const ctx = context()
  const text = `cwd ${HOME}/code/app, session ses_01JQZ9ABCDEF, claude 3f2504e0-4f89-11d3-9a0c-0305e82c3301`
  const out = redactForPaste(text, ctx)
  assert.ok(out.includes("~/code/app"))
  assert.equal(out.includes("ses_01JQZ9ABCDEF"), false)
  assert.equal(out.includes("3f2504e0-4f89-11d3-9a0c-0305e82c3301"), false)
  assert.ok(/ses_[0-9a-f]{8}/.test(out))
  assert.ok(/uuid_[0-9a-f]{8}/.test(out))
  assertClean(out, "the whole-report rewrite")
})

test("an id hasher is deterministic for a given salt", () => {
  const hash = createIdHasher("salt")
  assert.equal(hash("ses_x"), createIdHasher("salt")("ses_x"))
  assert.equal(hash("ses_x").length, 8)
  assert.notEqual(hash("ses_x"), hash("ses_y"))
})

test("a message containing its own JSON still redacts", () => {
  const ctx = context()
  const raw = line("ERROR", `failed: {"prompt":"${SECRETS.userPrompt}"}`)
  const parsed = parseLogLine(raw)
  assert.ok(parsed)
  assertClean(redactLogLine(raw, ctx)!, "a message with embedded JSON")
})

test("the bundle section caps its lines and its bytes", () => {
  const ctx = context()
  const many = Array.from({ length: BUNDLE_MAX_LINES * 3 }, (_unused, index) =>
    line("WARN", SHORT_MESSAGE, { count: index }),
  ).join("\n")
  const section = buildLogBundleSection({
    logPath: `${HOME}/.local/share/opencode-claude-code/plugin.log`,
    fileLogging: true,
    context: ctx,
    readTailImpl: () => many,
  })
  const fenced = section.split("```text\n")[1]!.split("\n```")[0]!.split("\n")
  assert.equal(fenced.length, BUNDLE_MAX_LINES)
  assert.ok(section.includes("not included."))
  // Newest kept, oldest dropped, and still in chronological order.
  assert.ok(fenced.at(-1)!.includes(`"count":${BUNDLE_MAX_LINES * 3 - 1}`))
  assert.ok(fenced[0]!.includes(`"count":${BUNDLE_MAX_LINES * 2}`))
  assertClean(section, "a capped section")
})

test("the byte cap wins when lines are long", () => {
  const ctx = context()
  const fat = Array.from({ length: BUNDLE_MAX_LINES }, () =>
    line("WARN", KNOWN_MESSAGE, { names: Array.from({ length: 20 }, () => "a".repeat(190)) }),
  ).join("\n")
  const section = buildLogBundleSection({
    logPath: "/tmp/x.log",
    fileLogging: true,
    context: ctx,
    readTailImpl: () => fat,
  })
  const fenced = section.split("```text\n")[1]!.split("\n```")[0]!
  assert.ok(fenced.length <= BUNDLE_MAX_BYTES, `fenced block was ${fenced.length} bytes`)
  assert.ok(fenced.split("\n").length < BUNDLE_MAX_LINES)
})

test("every secret in every position, through the whole section", () => {
  const ctx = context()
  const fixture: string[] = []
  for (const [name, secret] of Object.entries(SECRETS)) {
    fixture.push(line("INFO", `an info line nobody should see: ${secret}`))
    fixture.push(line("WARN", `${name}: ${secret}`))
    fixture.push(line("ERROR", KNOWN_MESSAGE, { toolName: secret, model: secret, count: secret }))
    fixture.push(line("WARN", KNOWN_MESSAGE, { prompt: secret, env: { KEY: secret } }))
    fixture.push(line("NOTICE", KNOWN_MESSAGE, { cliArgs: ["--settings", secret, secret] }))
    fixture.push(line("WARN", KNOWN_MESSAGE, { url: `https://x.test/a?token=${secret}` }))
    fixture.push(line("WARN", KNOWN_MESSAGE, { names: [secret], skipped: [{ deep: secret }] }))
    fixture.push(line("ERROR", KNOWN_MESSAGE, { sessionKey: secret, cwd: secret }))
    // not a log line at all: a raw continuation, as a multi-line value writes
    fixture.push(secret)
  }
  const section = buildLogBundleSection({
    logPath: `${HOME}/.local/share/opencode-claude-code/plugin.log`,
    fileLogging: true,
    context: ctx,
    readTailImpl: () => fixture.join("\n"),
  })
  assertClean(section, "the full fixture through buildLogBundleSection")
  assert.ok(section.includes(BUNDLE_HEADER))
})

test("file logging off still answers, and says how to turn it on", () => {
  const section = buildLogBundleSection({
    logPath: `${HOME}/.local/share/opencode-claude-code/plugin.log`,
    fileLogging: false,
    context: context(),
    readTailImpl: () => {
      throw new Error("must not read the log when logging is off")
    },
  })
  assert.ok(section.includes("File logging is **off**"))
  assert.ok(section.includes("OPENCODE_CLAUDE_CODE_LOG_FILE=1"))
  assert.ok(section.includes('"logging": { "file": true }'))
  assert.equal(section.includes("```text"), false)
  assertClean(section, "the logging-off section")
})

test("an unreadable log is reported, not thrown", () => {
  const section = buildLogBundleSection({
    logPath: `${HOME}/nope/plugin.log`,
    fileLogging: true,
    context: context(),
    readTailImpl: () => {
      throw new Error(`ENOENT: no such file, open '${HOME}/nope/plugin.log'`)
    },
  })
  assert.ok(section.includes("could not be read"))
  assertClean(section, "an unreadable log")
})

test("readLogTail takes the end of the file and drops a split line", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccp-bundle-"))
  const path = join(dir, "plugin.log")
  const body = Array.from({ length: 50 }, (_unused, index) => `line-${index}`).join("\n") + "\n"
  writeFileSync(path, body)
  assert.equal(readLogTail(path, 1024 * 1024), body)
  const tail = readLogTail(path, 30)
  assert.equal(tail.includes("line-0\n"), false, "a split first line must be dropped")
  assert.ok(tail.endsWith("line-49\n"))
  assert.ok(BUNDLE_TAIL_BYTES >= 512 * 1024)
})

const report: DoctorReport = {
  plugin: "0.34.1",
  // The stale case on purpose: the row has to be printable in a bundle, and
  // the entry path it is built from must never reach one.
  build: {
    loaded: {
      version: "0.34.1",
      entryPath: `${HOME}/code/plugin/dist/index.js`,
      mtimeMs: 1_000,
      size: 100,
      loadedAt: new Date(2026, 8, 22, 20, 56).getTime(),
    },
    onDisk: { version: "0.36.5", mtimeMs: 2_000, size: 120 },
    stale: {
      kind: "version",
      loadedVersion: "0.34.1",
      onDiskVersion: "0.36.5",
      loadedAt: new Date(2026, 8, 22, 20, 56).getTime(),
    },
    verdict: "version",
  },
  opencode: "1.18.33",
  claudeCli: { path: `${HOME}/.local/bin/claude`, version: "2.1.280 (Claude Code)" },
  cwd: { resolved: `${HOME}/code/app`, source: "process" },
  providers: ["claude-code"],
  accounts: [],
  accountGroups: [],
  proxyTools: ["Bash", "Task"],
  mcpServers: ["linear"],
  permissionPresets: [{ provider: "claude-code", preset: "none", applied: false, overrides: [] }],
  transport: "headless",
  planModeQuestion: false,
  turnStats: false,
  anthropicApiKeyInEnv: false,
  processes: [],
  pendingCalls: [],
  proxyServers: [],
  mcpServerErrors: [],
  pluginLoadFailures: [],
  hookFailures: [],
  planUsage: { status: "not-requested" },
  backgroundSubagents: { gate: undefined, ledgers: [] },
}

test("the plain doctor report is byte-identical, with every bundle seam set", () => {
  const plain = formatDoctorReport(report)
  const seams = {
    cliPath: "claude",
    interactive: false,
    turnStats: false,
    redactionContextImpl: context(),
    logFileImpl: () => ({ path: "/tmp/plugin.log", enabled: true }),
    readLogTailImpl: () => line("WARN", KNOWN_MESSAGE),
  }
  for (const argument of [undefined, "", "   ", "usage", "nonsense"]) {
    assert.equal(
      decorateDoctorReport(plain, { ...seams, argument }),
      plain,
      `argument ${JSON.stringify(argument)} must not change the report`,
    )
  }
  assert.equal(plain.includes(BUNDLE_HEADER), false)
  assert.ok(plain.includes(`${HOME}/code/app`), "the plain report keeps the real path")
})

test("the bundle argument appends the section and rewrites the whole report", () => {
  const plain = formatDoctorReport(report)
  for (const argument of ["bundle", "BUNDLE", " bundle ", "issue", "report", "paste"]) {
    assert.ok(wantsDiagnosticBundle(argument), argument)
  }
  const out = decorateDoctorReport(plain, {
    cliPath: "claude",
    interactive: false,
    turnStats: false,
    argument: "bundle",
    redactionContextImpl: context(),
    logFileImpl: () => ({ path: `${HOME}/.local/share/opencode-claude-code/plugin.log`, enabled: true }),
    readLogTailImpl: () =>
      [
        line("WARN", KNOWN_MESSAGE, { cwd: `${HOME}/code/app`, prompt: SECRETS.userPrompt }),
        line("INFO", SECRETS.systemPrompt!),
      ].join("\n"),
  })
  assert.ok(out.includes(BUNDLE_HEADER))
  assert.ok(out.startsWith("▌ **claude-code doctor**"))
  // The doctor table's own home path is rewritten, because the whole thing is
  // what gets pasted.
  assert.ok(out.includes("~/code/app"))
  // The stale-build row is plugin-authored text about two version strings and
  // two timestamps, so it survives a bundle whole. What it must never carry is
  // the entry file it was built from: the row names no path at all, and the
  // fixture puts that path under the home directory so a regression shows up
  // here as well as in `assertClean`.
  assert.ok(out.includes("| plugin build | 0.34.1, loaded "))
  assert.ok(out.includes("on disk 0.36.5. Restart opencode to run it |"))
  assert.equal(out.includes("dist/index.js"), false)
  assertClean(out, "the bundled doctor report")
})

// The report's free text is not plugin-authored: a hook's stderr and Claude
// Code's own sentences can carry anything, and the whole-report rewrites only
// reach the home directory and session ids. Merged together with the hook
// section (#74), so this goes through the function the command calls.
test("a bundle withholds the report's free text; a plain report keeps it, one row per line", () => {
  const withFreeText: DoctorReport = {
    ...report,
    mcpServerErrors: [
      { name: "github", type: "invalid_config", message: `bad url ${SECRETS.urlWithToken}` },
    ],
    pluginLoadFailures: [
      {
        plugin: "probe@inline",
        kind: "error",
        type: "dependency-unsatisfied",
        message: `cannot read ${SECRETS.homePath}`,
      },
    ],
    hookFailures: [
      {
        hookName: "SessionStart:startup",
        hookEvent: "SessionStart",
        exitCode: 3,
        outcome: "error",
        stderr: `line one | ${SECRETS.apiKey}\nline two ${SECRETS.bearer}`,
      },
    ],
  }
  const seams = {
    cliPath: "claude",
    interactive: false,
    turnStats: false,
    redactionContextImpl: context(),
    logFileImpl: () => ({ path: "/tmp/plugin.log", enabled: false }),
    readLogTailImpl: () => "",
  }

  const plain = renderDoctorReport(withFreeText, seams)
  assert.ok(plain.includes(SECRETS.apiKey!), "the plain report is the user's own screen")
  const hookRow = plain.split("\n").find((row) => row.startsWith("| SessionStart:startup |"))
  assert.ok(hookRow, plain)
  assert.ok(hookRow.includes("line one \\| "), "a pipe in the text is escaped")
  assert.ok(hookRow.includes(" line two "), "a newline in the text stays in the row")

  const bundled = renderDoctorReport(withFreeText, { ...seams, argument: "bundle" })
  assert.ok(bundled.includes("| github | `invalid_config` | [redacted, "), bundled)
  assert.ok(bundled.includes("| probe@inline | error | `dependency-unsatisfied` | [redacted, "), bundled)
  assert.ok(bundled.includes("| SessionStart:startup | SessionStart | 3 | error | [redacted, "), bundled)
  assertClean(bundled, "a bundle with free text in the doctor report")
})

test("describeLogFile reports the path without touching it", () => {
  _resetLoggerForTests()
  const described = describeLogFile()
  assert.ok(described.path.endsWith("plugin.log"))
  // The suite forces OPENCODE_CLAUDE_CODE_LOG_FILE=0, so this must read off.
  assert.equal(described.enabled, false)
})

test("sanitizeLogData never drops a key, so the shape is always visible", () => {
  const ctx = context()
  const data = { toolName: "bash", mystery: SECRETS.toolInput, count: 3 }
  const out = sanitizeLogData(data, ctx)
  assert.deepEqual(Object.keys(out), ["toolName", "mystery", "count"])
  assert.equal(out.toolName, "bash")
  assert.equal(out.count, 3)
  assert.equal(out.mystery, `[redacted, ${SECRETS.toolInput!.length} chars]`)
})

test("the MCP OAuth WARN reaches a bundle as a name, never as a credential", () => {
  // `bridgeMcpOauthTokens` is the one feature that reads a secret out of
  // opencode's own store, so the line it can write is pinned here by hand as
  // well as by the generic sweep above. What an operator needs is which
  // server; what must never appear is anything that could be the token.
  const ctx = context()
  const message =
    "opencode's stored OAuth token for this MCP server has expired, so the bridged server carries no credential; re-authenticate it in opencode"
  assert.ok(
    PLUGIN_LOG_MESSAGES.has(message),
    "regenerate src/log-messages.ts: this WARN would arrive fully redacted",
  )
  const real = redactLogLine(line("WARN", message, { server: "github" }), ctx)
  assert.ok(real?.includes(message))
  assert.ok(real.includes("github"), "the server name is the whole point of the line")

  // The same line with a token wherever one could be smuggled.
  for (const [name, secret] of Object.entries(SECRETS)) {
    for (const data of [
      { server: secret },
      { server: "github", token: secret },
      { server: "github", headers: { Authorization: secret } },
    ]) {
      assertClean(redactLogLine(line("WARN", message, data), ctx)!, `the OAuth WARN with ${name}`)
    }
  }
})
