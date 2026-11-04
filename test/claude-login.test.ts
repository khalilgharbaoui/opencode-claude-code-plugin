/**
 * The `claude auth status` check behind opencode 2's `/connect` entry
 * (src/claude-login.ts, h #g277). The parser is fed the shapes Claude Code
 * 2.1.314 printed, and `checkClaudeLogin` is driven through its real spawn
 * against fake `claude` scripts, so the exit codes, a missing binary, the
 * version gate and the timeout are the real paths.
 *
 * Usage: npx tsx --test test/claude-login.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  CLAUDE_CODE_SETUP_URL,
  checkClaudeLogin,
  describeLoginMethod,
  loginProblem,
  loginSummary,
  parseClaudeAuthStatus,
  type ClaudeLoginState,
} from "../src/claude-login.js"
import { MAX_DEADLINE_REPROBES, cliSupportsAuthStatus, detectCliVersion } from "../src/cli-version.js"

// What 2.1.314 printed, logged in with a subscription. The account fields are
// in the real output and must never be kept.
const LOGGED_IN = JSON.stringify(
  {
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    analyticsDisabled: false,
    projectsDirectory: "/Users/someone/.claude/projects",
    configDirectory: "/Users/someone/.claude",
    email: "someone@example.com",
    orgId: "11111111-2222-3333-4444-555555555555",
    orgName: "Example Org",
    subscriptionType: "max",
  },
  null,
  2,
)

// An empty config dir: logged out, exit 1.
const LOGGED_OUT = JSON.stringify({
  loggedIn: false,
  authMethod: "none",
  apiProvider: "firstParty",
  analyticsDisabled: true,
  projectsDirectory: "/tmp/empty/projects",
  configDirectory: "/tmp/empty",
})

test("only the five login fields are read out of auth status", () => {
  const auth = parseClaudeAuthStatus(LOGGED_IN)
  assert.deepEqual(auth, {
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    subscriptionType: "max",
  })
  const text = JSON.stringify(auth)
  for (const secret of ["someone@example.com", "Example Org", "11111111", "/Users/someone"]) {
    assert.doesNotMatch(text, new RegExp(secret))
  }
  assert.deepEqual(parseClaudeAuthStatus(LOGGED_OUT), {
    loggedIn: false,
    authMethod: "none",
    apiProvider: "firstParty",
  })
})

test("a line in front of the JSON is tolerated, and anything not auth status's shape is not read", () => {
  const prefixed = `Additional CA cert(s): /Library/x.pem\n${LOGGED_IN}`
  assert.equal(parseClaudeAuthStatus(prefixed)?.loggedIn, true)
  assert.equal(parseClaudeAuthStatus("Not logged in. Run claude auth login to authenticate."), undefined)
  assert.equal(parseClaudeAuthStatus("{ not json }"), undefined)
  assert.equal(parseClaudeAuthStatus(JSON.stringify({ authMethod: "claude.ai" })), undefined, "no loggedIn")
  assert.equal(parseClaudeAuthStatus("[1,2]"), undefined)
  // A value that is not a short name is dropped rather than shown.
  const odd = parseClaudeAuthStatus(
    JSON.stringify({ loggedIn: true, authMethod: "claude.ai\n<b>x</b>", subscriptionType: "x".repeat(80) }),
  )
  assert.deepEqual(odd, { loggedIn: true })
})

test("the login method is named the way an operator would say it", () => {
  const cases: Array<[Record<string, string>, string]> = [
    [{ authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }, "a Claude subscription (Max)"],
    [{ authMethod: "claude.ai", apiProvider: "firstParty" }, "a Claude subscription"],
    [{ authMethod: "api_key", apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" }, "an API key (ANTHROPIC_API_KEY)"],
    [{ authMethod: "api_key_helper", apiProvider: "firstParty" }, "an API key helper (apiKeyHelper)"],
    [{ authMethod: "oauth_token", apiProvider: "firstParty" }, "an OAuth token"],
    [{ authMethod: "third_party", apiProvider: "bedrock" }, "Amazon Bedrock"],
    [{ authMethod: "third_party", apiProvider: "vertex" }, "Google Vertex AI"],
    [{ authMethod: "third_party", apiProvider: "foundry" }, "Microsoft Foundry"],
    [{ authMethod: "third_party", apiProvider: "mantle" }, "the mantle provider"],
    [{ authMethod: "claude.ai", apiProvider: "gateway" }, "a Claude gateway"],
  ]
  for (const [fields, expected] of cases) {
    assert.equal(describeLoginMethod({ loggedIn: true, ...fields }), expected, JSON.stringify(fields))
  }
})

test("a missing or logged-out CLI is a sign-in problem, and a failed check is none", () => {
  const command = "CLAUDE_CONFIG_DIR=~/.claude-work claude auth login"
  const missing = loginProblem({ status: "missing" }, command)
  assert.equal(missing?.status, "needs_auth")
  assert.equal(missing?.url, CLAUDE_CODE_SETUP_URL)
  assert.match(missing!.message, /not installed/)

  const out = loginProblem({ status: "logged-out", auth: { loggedIn: false, authMethod: "none" } }, command)
  assert.equal(out?.message, `Claude Code is not logged in. Run \`${command}\` in a terminal.`)
  assert.equal(out?.url, undefined, "no url: reconnecting is the way back")

  const gateway = loginProblem(
    { status: "logged-out", auth: { loggedIn: false, apiProvider: "gateway" } },
    command,
  )
  assert.match(gateway!.message, /Start `claude` and sign in with \/login/)

  assert.equal(loginProblem({ status: "logged-in", auth: { loggedIn: true } }, command), undefined)
  assert.equal(loginProblem({ status: "failed", reason: "x" }, command), undefined)
})

test("the toast names the method, or the one command that fixes it", () => {
  const command = "claude auth login"
  const ok = loginSummary(
    { status: "logged-in", auth: { loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" } },
    "Claude Code",
    command,
  )
  assert.deepEqual(ok, { level: "success", message: "Claude Code: logged in with a Claude subscription (Pro)." })
  const out = loginSummary({ status: "logged-out", auth: { loggedIn: false } }, "Claude Code (Work)", command)
  assert.equal(out.level, "warn")
  assert.equal(out.message, "Claude Code (Work): not logged in. Run `claude auth login` in a terminal. Then connect again.")
  assert.match(loginSummary({ status: "missing" }, "Claude Code", command).message, /code\.claude\.com/)
  assert.match(
    loginSummary({ status: "failed", reason: "no answer within 10 s" }, "Claude Code", command).message,
    /could not check the login \(no answer within 10 s\)\. Run `claude auth status`/,
  )
})

test("the version gate sits at the oldest CLI the command was run against", () => {
  assert.equal(cliSupportsAuthStatus(null), false)
  assert.equal(cliSupportsAuthStatus({ major: 2, minor: 1, patch: 287, raw: "2.1.287" }), false)
  assert.equal(cliSupportsAuthStatus({ major: 2, minor: 1, patch: 288, raw: "2.1.288" }), true)
  assert.equal(cliSupportsAuthStatus({ major: 2, minor: 1, patch: 314, raw: "2.1.314" }), true)
})

// ---------------------------------------------------------------------------
// The real spawn, against fake CLIs
// ---------------------------------------------------------------------------

function fakeCli(options: { version?: string; mode: "in" | "out" | "hang" | "garbage" }): {
  cliPath: string
  calls: () => string[][]
} {
  const dir = mkdtempSync(join(tmpdir(), "claude-login-"))
  const cliPath = join(dir, "claude")
  const record = join(dir, "calls.jsonl")
  writeFileSync(record, "")
  // Node by its absolute path: an `env` exec costs seconds under load (h #g286).
  const source = `#!${process.execPath}
const fs = require("node:fs")
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(args) + "\\n")
if (args.includes("--version")) { process.stdout.write(${JSON.stringify(options.version ?? "2.1.314")} + " (Claude Code)\\n"); process.exit(0) }
if (args[0] !== "auth" || args[1] !== "status") process.exit(9)
const mode = ${JSON.stringify(options.mode)}
const keySource = process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : undefined
if (mode === "hang") setInterval(() => {}, 60000)
else if (mode === "garbage") { process.stdout.write("something else entirely\\n"); process.exit(0) }
else if (mode === "out") { process.stdout.write(JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" })); process.exit(1) }
else { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: keySource ? "api_key" : "claude.ai", apiProvider: "firstParty", apiKeySource: keySource, subscriptionType: keySource ? undefined : "max", email: "someone@example.com" })); process.exit(0) }
`
  writeFileSync(cliPath, source)
  chmodSync(cliPath, 0o755)
  return {
    cliPath,
    calls: () =>
      readFileSync(record, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
  }
}

/**
 * The deadline every check that is not about a deadline passes: a hang-stop
 * sized for a loaded machine, not the time the test is about (h #g286).
 */
const HANG_STOP_MS = 60_000

/**
 * A fresh fake with its `--version` probe already answered. The check awaits
 * that probe before anything it reports on, and a probe our own 5-second
 * deadline killed reads as "did not report a version", so a cold probe under
 * load failed checks that had nothing to do with the version. A killed probe
 * is forgotten and the third kill in a row is kept, so ask until the same
 * promise comes back (h #g181, h #g286).
 */
async function warmFakeCli(options: Parameters<typeof fakeCli>[0]): Promise<ReturnType<typeof fakeCli>> {
  const cli = fakeCli(options)
  for (let attempt = 0; attempt <= MAX_DEADLINE_REPROBES; attempt++) {
    const version = detectCliVersion(cli.cliPath)
    await version
    if (detectCliVersion(cli.cliPath) === version) break
  }
  return cli
}

test("a logged-in CLI answers with its method, through the real spawn", async () => {
  const cli = await warmFakeCli({ mode: "in" })
  const state = await checkClaudeLogin({ cliPath: cli.cliPath, ignoreAnthropicApiKey: true, timeoutMs: HANG_STOP_MS })
  assert.deepEqual(state, {
    status: "logged-in",
    auth: { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" },
  })
  assert.deepEqual(cli.calls().at(-1), ["auth", "status"])
})

test("the check sees the API key a turn would see, and not one the provider strips", async () => {
  const saved = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-real"
  try {
    const kept = await checkClaudeLogin({
      cliPath: (await warmFakeCli({ mode: "in" })).cliPath,
      timeoutMs: HANG_STOP_MS,
    })
    assert.equal(kept.status === "logged-in" && kept.auth.authMethod, "api_key")
    const stripped = await checkClaudeLogin({
      cliPath: (await warmFakeCli({ mode: "in" })).cliPath,
      ignoreAnthropicApiKey: true,
      timeoutMs: HANG_STOP_MS,
    })
    assert.equal(stripped.status === "logged-in" && stripped.auth.authMethod, "claude.ai")
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = saved
  }
})

test("exit 1 with auth status's JSON is logged out", async () => {
  const state = await checkClaudeLogin({ cliPath: (await warmFakeCli({ mode: "out" })).cliPath, timeoutMs: HANG_STOP_MS })
  assert.equal(state.status, "logged-out")
})

test("a binary that is not there is missing", async () => {
  const state = await checkClaudeLogin({ cliPath: join(tmpdir(), "no-such-claude-binary-v2host"), timeoutMs: HANG_STOP_MS })
  assert.deepEqual(state, { status: "missing" })
})

test("a CLI older than the gate is never asked auth status", async () => {
  const cli = await warmFakeCli({ mode: "in", version: "2.1.280" })
  const state = await checkClaudeLogin({ cliPath: cli.cliPath, timeoutMs: HANG_STOP_MS })
  assert.equal(state.status, "failed")
  assert.match((state as Extract<ClaudeLoginState, { status: "failed" }>).reason, /2\.1\.280 is older than 2\.1\.288/)
  assert.ok(cli.calls().every((args) => args[0] !== "auth"), "only the version probe ran")
})

test("a CLI that never answers is a failed check after the deadline, not a hang", async () => {
  // The fake never exits on its own, so only the check's own deadline can end
  // this. The version probe is answered first, so what is timed is the
  // `auth status` spawn alone: the deadline's reason proves it fired, and the
  // bound proves the check did not wait on the CLI. It is far above 400 ms
  // because a spawn took seconds at a load of 50 (h #g286).
  const cli = await warmFakeCli({ mode: "hang" })
  const started = Date.now()
  const state = await checkClaudeLogin({ cliPath: cli.cliPath, timeoutMs: 400 })
  assert.equal(state.status, "failed")
  assert.match((state as Extract<ClaudeLoginState, { status: "failed" }>).reason, /^no answer within /)
  assert.ok(Date.now() - started < 30_000)
})

test("output that is not auth status's is a failed check, never a login", async () => {
  const state = await checkClaudeLogin({ cliPath: (await warmFakeCli({ mode: "garbage" })).cliPath, timeoutMs: HANG_STOP_MS })
  assert.equal(state.status, "failed")
})
