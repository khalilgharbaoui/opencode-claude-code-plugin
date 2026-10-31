/**
 * Every way of running a test file is isolated from the operator's live data
 * (h #g283): the static rule that keeps it so, and a focused run measured
 * against a fake home in a child process, both with `test/isolate.ts` in front
 * and, as the control, without it.
 *
 * Usage: npx tsx --test test/isolation.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, sep } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(TEST_DIR)
const ISOLATE_IMPORT = 'import "./isolate.js"'

test("every file in test/ imports test/isolate.ts before anything else", () => {
  const offenders = readdirSync(TEST_DIR)
    .filter((name) => name.endsWith(".ts") && name !== "isolate.ts")
    .filter((name) => {
      const lines = readFileSync(join(TEST_DIR, name), "utf8").split("\n")
      return lines.find((line) => /^import\b/.test(line)) !== ISOLATE_IMPORT
    })
  assert.deepEqual(offenders, [], `make \`${ISOLATE_IMPORT}\` the first import of: ${offenders.join(", ")}`)
})

test("test/isolate.ts imports nothing but node builtins, so it runs before any src module", () => {
  const source = readFileSync(join(TEST_DIR, "isolate.ts"), "utf8")
  const specifiers = [...source.matchAll(/^import\s[^"']*["']([^"']+)["']/gm)].map((match) => match[1])
  assert.ok(specifiers.length > 0)
  assert.deepEqual(specifiers.filter((specifier) => !specifier.startsWith("node:")), [])
})

interface FixtureReport {
  stateHome: string | null
  cacheHome: string | null
  logFile: { path: string; enabled: boolean }
  probe: { status: string; reason?: string }
  stores: Array<{ path: string; written: boolean }>
}

/** Every file under `dir`, relative to it. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort()
}

/**
 * Run one fixture the way the maintainer's shell would: file logging exported
 * on, no XDG overrides and no model-probe switch, with a fake home standing in
 * for the real one (`USERPROFILE` too, which `os.homedir()` reads on Windows).
 */
async function runFixture(fixture: string, args: string[], home: string, report: string): Promise<FixtureReport> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OPENCODE_CLAUDE_CODE_LOG_FILE: "1",
    ISOLATION_FIXTURE_REPORT: report,
  }
  for (const name of [
    "OPENCODE_CLAUDE_CODE_LOG_DIR",
    "OPENCODE_CLAUDE_CODE_MODEL_PROBE",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    // This file runs under node's test runner; the child must not think it does.
    "NODE_TEST_CONTEXT",
  ]) {
    delete env[name]
  }
  const child = spawn(
    process.execPath,
    ["--import", "tsx", ...args, join(TEST_DIR, "fixtures", "isolation", fixture)],
    { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] },
  )
  let output = ""
  child.stdout.on("data", (chunk) => (output += chunk))
  child.stderr.on("data", (chunk) => (output += chunk))
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve))
  assert.equal(code, 0, output)
  return JSON.parse(readFileSync(report, "utf8")) as FixtureReport
}

test("a focused run, under --test or run directly, writes nothing under the home", { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "opencode-isolation-home-"))
  const reports = mkdtempSync(join(tmpdir(), "opencode-isolation-reports-"))
  try {
    for (const [mode, args] of [["test runner", ["--test"]], ["direct", []]] as const) {
      const report = await runFixture("isolated.ts", [...args], home, join(reports, `${mode}.json`))
      assert.deepEqual(filesUnder(home), [], `${mode}: the home is untouched`)
      assert.equal(report.logFile.enabled, false, `${mode}: file logging is off`)
      assert.deepEqual(report.probe, { status: "skipped", reason: "env-off" }, `${mode}: the CLI is never probed`)
      const root = dirname(report.stateHome ?? "")
      assert.ok(!root.startsWith(home), `${mode}: the scratch root is not the home`)
      assert.equal(dirname(report.cacheHome ?? ""), root, `${mode}: the wrapper cache is scratch too`)
      assert.ok(report.logFile.path.startsWith(root + sep), `${mode}: an opted-in log would land in scratch`)
      for (const store of report.stores) {
        assert.ok(store.written, `${mode}: ${store.path} was written`)
        assert.ok(store.path.startsWith(root + sep), `${mode}: ${store.path} is under the scratch root`)
      }
      assert.equal(existsSync(root), false, `${mode}: the scratch root is removed at exit`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(reports, { recursive: true, force: true })
  }
})

test("the control: the same writes without test/isolate.ts land in the home", { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "opencode-isolation-home-"))
  const reports = mkdtempSync(join(tmpdir(), "opencode-isolation-reports-"))
  try {
    const report = await runFixture("unisolated.ts", [], home, join(reports, "control.json"))
    const log = join(".local", "share", "opencode-claude-code", "plugin.log")
    const state = join(".local", "state", "opencode-claude-code-plugin")
    assert.deepEqual(
      filesUnder(home),
      [
        log,
        join(state, "claude-sessions.json"),
        join(state, "session-spawns.json"),
        join(state, "turn-history.json"),
      ].sort(),
    )
    assert.match(readFileSync(join(home, log), "utf8"), /isolation fixture line/)
    assert.deepEqual(report.probe, { status: "skipped", reason: "cli-not-found" })
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(reports, { recursive: true, force: true })
  }
})
