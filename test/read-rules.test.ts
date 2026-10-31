/**
 * opencode's own `read` rules carried onto the Read the CLI runs itself
 * (h #g243).
 *
 * Three layers, because each one can be wrong on its own: resolving the rules
 * out of both majors' config shapes, translating one pattern into a Claude
 * rule body, and the argv a real `doStream` hands the CLI.
 *
 * Usage: npx tsx --test test/read-rules.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
  OPENCODE_DEFAULT_READ_RULES,
  describeReadPatternRefusal,
  mapReadRules,
  resolveReadRuleMapping,
  resolveReadRules,
  translateReadPattern,
  wildcardMatch,
  type ReadRule,
} from "../src/read-rules.js"
import { resolveDisallowedTools } from "../src/proxy-mcp.js"

const HOME = "/home/tester"

function denies(layers: Record<string, unknown>[], hostApi: "v1" | "v2" = "v1"): string[] {
  return mapReadRules(resolveReadRules(layers, hostApi, { home: HOME })).deny
}

// ---------------------------------------------------------------------------
// Resolving the ruleset
// ---------------------------------------------------------------------------

test("with no config at all, opencode's own defaults are the ruleset", () => {
  const rules = resolveReadRules([], "v1", { home: HOME })
  assert.deepEqual(rules, [...OPENCODE_DEFAULT_READ_RULES])
  // And the whole of it is asks, so a default install emits no deny: the
  // measured default for `*.env` is `ask`, not `deny`.
  const mapped = mapReadRules(rules)
  assert.deepEqual(mapped.deny, [])
  assert.deepEqual(mapped.ask, ["*.env", "*.env.*"])
})

test("an object-shaped `permission.read` becomes one rule per pattern, in key order", () => {
  assert.deepEqual(
    denies([{ permission: { read: { "*.env": "deny", "secrets/*": "deny", "*.md": "allow" } } }]),
    ["Read(*.env)", "Read(secrets/**)"],
  )
})

test("a string-shaped `permission` is opencode's catch-all and governs read too", () => {
  assert.deepEqual(denies([{ permission: "deny" }]), ["Read(**)"])
  assert.deepEqual(denies([{ permission: { read: "deny" } }]), ["Read(**)"])
})

test("the legacy `tools: { read: false }` spelling denies reads, and an explicit rule wins", () => {
  assert.deepEqual(denies([{ tools: { read: false } }]), ["Read(**)"])
  // opencode merges the derived permissions FIRST, so the explicit block wins.
  assert.deepEqual(denies([{ tools: { read: false }, permission: { read: "allow" } }]), [])
})

test("a later layer overrides an earlier one, as opencode's deep merge does", () => {
  assert.deepEqual(
    denies([{ permission: { read: { "*.env": "deny" } } }, { permission: { read: { "*.env": "allow" } } }]),
    [],
  )
  assert.deepEqual(
    denies([{ permission: { read: { "*.env": "allow" } } }, { permission: { read: { "*.env": "deny" } } }]),
    ["Read(*.env)"],
  )
})

test("V2's `permissions` array is read, on both majors", () => {
  const layers = [{ permissions: [{ action: "read", resource: "*.pem", effect: "deny" }] }]
  assert.deepEqual(denies(layers, "v2"), ["Read(*.pem)"])
  // A V1 host ignores an array it does not know, but the plugin reads it
  // anyway so an upgrade in either direction cannot make the mapping go quiet.
  assert.deepEqual(denies(layers, "v1"), ["Read(*.pem)"])
})

test("a V2 entry with no resource is the catch-all, and a foreign action is skipped", () => {
  assert.deepEqual(
    denies([{ permissions: [{ action: "read", effect: "deny" }] }], "v2"),
    ["Read(**)"],
  )
  assert.deepEqual(
    denies([{ permissions: [{ action: "bash", resource: "*.env", effect: "deny" }] }], "v2"),
    [],
  )
})

test("`~` and `$HOME` are expanded the way opencode expands them", () => {
  assert.deepEqual(denies([{ permission: { read: { "~/.ssh/*": "deny" } } }]), [
    `Read(/${HOME}/.ssh/**)`,
  ])
  assert.deepEqual(denies([{ permission: { read: { "$HOME/.aws/*": "deny" } } }]), [
    `Read(/${HOME}/.aws/**)`,
  ])
})

test("a wildcard permission KEY governs read, because opencode matches keys as wildcards", () => {
  assert.ok(wildcardMatch("read", "*"))
  assert.ok(wildcardMatch("read", "re*"))
  assert.ok(!wildcardMatch("read", "write"))
  assert.deepEqual(denies([{ permission: { "re*": { "*.env": "deny" } } }]), ["Read(*.env)"])
})

// ---------------------------------------------------------------------------
// Translating one pattern
// ---------------------------------------------------------------------------

test("a catch-all in any spelling becomes `**`", () => {
  for (const pattern of ["*", "**", "***"]) {
    assert.deepEqual(translateReadPattern(pattern), { rule: "**" })
  }
})

test("a slash-free pattern is emitted as-is, because it already matches at any depth", () => {
  // Measured on 2.1.293 and 2.1.300: `Read(*.env)` refuses `.env`, `sub/.env`,
  // `nested/deep/.env` and `app.env` and leaves `notes.txt` readable. Giving
  // it a `**` prefix would be redundant, and anchoring it would be WRONG.
  assert.deepEqual(translateReadPattern("*.env"), { rule: "*.env" })
  assert.deepEqual(translateReadPattern("*.env.*"), { rule: "*.env.*" })
  assert.deepEqual(translateReadPattern("id_rsa"), { rule: "id_rsa" })
})

test("a trailing `/*` is widened to `/**`, so a subtree rule stays a subtree rule", () => {
  assert.deepEqual(translateReadPattern("secrets/*"), { rule: "secrets/**" })
  assert.deepEqual(translateReadPattern("secrets/**"), { rule: "secrets/**" })
  assert.deepEqual(translateReadPattern("a/b/c.txt"), { rule: "a/b/c.txt" })
})

test("an absolute pattern gets Claude's `//` root form", () => {
  assert.deepEqual(translateReadPattern("/etc/shadow"), { rule: "//etc/shadow" })
  assert.deepEqual(translateReadPattern("/var/secrets/*"), { rule: "//var/secrets/**" })
})

test("a slash-bearing relative pattern is anchored at the worktree when it differs from the cwd", () => {
  // The expectation is DERIVED rather than written out, because the anchor is
  // `path.resolve`'s and on Windows that carries a drive letter (`/D:/repo/...`).
  // Only the POSIX spelling has been measured against a real CLI; asserting a
  // literal Windows one here would be inventing a measurement.
  const worktree = path.resolve("/repo")
  assert.deepEqual(
    translateReadPattern("secrets/*", { worktree, cwd: path.join(worktree, "packages", "app") }),
    { rule: `/${worktree.replaceAll("\\", "/")}/secrets/**` },
  )
  // Same directory: no anchor needed, and the rule stays relative.
  assert.deepEqual(translateReadPattern("secrets/*", { worktree, cwd: worktree }), {
    rule: "secrets/**",
  })
})

test("`..` is refused rather than normalised, and every refusal reason is a kebab token", () => {
  // h #g215: `reason` is allowlisted as an `enum` in a bundle and `SAFE_ENUM`
  // forbids spaces, so a sentence here would arrive redacted.
  const refused = translateReadPattern("../outside/*")
  assert.deepEqual(refused, { refused: "contains-dotdot" })
  assert.deepEqual(translateReadPattern("   "), { refused: "empty-pattern" })
  for (const reason of ["empty-pattern", "contains-dotdot"] as const) {
    assert.match(reason, /^[a-z][a-z-]*$/)
    // The prose exists, and only the doctor reads it.
    assert.ok(describeReadPatternRefusal(reason).length > 0)
  }
})

test("an unmappable deny is reported rather than dropped silently", () => {
  const mapped = mapReadRules([{ pattern: "../x/*", effect: "deny", source: "config" }])
  assert.deepEqual(mapped.deny, [])
  assert.deepEqual(mapped.unmapped, [{ pattern: "../x/*", reason: "contains-dotdot" }])
})

// ---------------------------------------------------------------------------
// The whole translation
// ---------------------------------------------------------------------------

test("an `ask` is reported, never promoted to a deny", () => {
  const mapped = mapReadRules([{ pattern: "*.env", effect: "ask", source: "default" }])
  assert.deepEqual(mapped.deny, [])
  assert.deepEqual(mapped.ask, ["*.env"])
})

test("an allow AFTER a deny is reported as shadowed, because Claude's deny beats its allow", () => {
  // opencode's own shape, with the `*.env.*` ask turned into a deny: the
  // later `*.env.example` allow carves an exception out of it there, and
  // cannot on Claude's side, where a deny wins. `*.env` is deliberately NOT
  // the deny here: `.env.example` does not match it in either matcher, so it
  // would shadow nothing.
  const mapped = mapReadRules([
    { pattern: "*.env.*", effect: "deny", source: "config" },
    { pattern: "*.env.example", effect: "allow", source: "config" },
  ])
  assert.deepEqual(mapped.deny, ["Read(*.env.*)"])
  assert.deepEqual(mapped.shadowedAllows, ["*.env.example"])
})

test("an ask the operator has since denied is not still reported as unenforced", () => {
  // The live shape of `permission: { read: { "*.env": "deny" } }`: opencode's
  // own `*.env` ask is first, the operator's deny after it. Reporting the ask
  // as "not enforced" beside the deny that enforces it describes a posture
  // the host does not have.
  const mapped = mapReadRules(
    resolveReadRules([{ permission: { read: { "*.env": "deny", "*.env.*": "deny" } } }], "v1", {
      home: HOME,
    }),
  )
  assert.deepEqual(mapped.deny, ["Read(*.env)", "Read(*.env.*)"])
  assert.deepEqual(mapped.ask, [])
})

test("an allow that overlaps nothing the deny covers is not reported as shadowed", () => {
  const mapped = mapReadRules([
    { pattern: "*.env", effect: "deny", source: "config" },
    { pattern: "*.md", effect: "allow", source: "config" },
  ])
  assert.deepEqual(mapped.deny, ["Read(*.env)"])
  assert.deepEqual(mapped.shadowedAllows, [])
})

test("a deny opencode's own findLast has already killed is not emitted", () => {
  // A later `*` allow supersedes the deny inside opencode, so emitting it
  // would make Claude stricter than the host it mirrors.
  const mapped = mapReadRules([
    { pattern: "*.env", effect: "deny", source: "config" },
    { pattern: "*", effect: "allow", source: "config" },
  ])
  assert.deepEqual(mapped.deny, [])
})

test("the same pattern twice emits one rule", () => {
  const mapped = mapReadRules([
    { pattern: "*.env", effect: "deny", source: "config" },
    { pattern: "*.env", effect: "deny", source: "config" },
  ])
  assert.deepEqual(mapped.deny, ["Read(*.env)"])
})

test("`mapReadRules: false` maps nothing and says so", () => {
  const mapping = resolveReadRuleMapping({
    layers: [{ permission: { read: { "*.env": "deny" } } }],
    enabled: false,
  })
  assert.equal(mapping.enabled, false)
  assert.deepEqual(mapping.deny, [])
})

test("a malformed layer can never fail a turn", () => {
  const hostile = { get permission(): unknown { throw new Error("boom") } }
  const mapping = resolveReadRuleMapping({ layers: [hostile as never] })
  assert.deepEqual(mapping.deny, [])
  assert.equal(mapping.enabled, true)
})

// ---------------------------------------------------------------------------
// The flag the rules ride on
// ---------------------------------------------------------------------------

test("read rules are appended to --disallowedTools after the proxy names", () => {
  assert.deepEqual(
    resolveDisallowedTools({
      extraDisallowedTools: ["Write"],
      readRules: ["Read(*.env)", "Read(secrets/**)"],
    }),
    ["Write", "Read(*.env)", "Read(secrets/**)"],
  )
  // No rules: byte-identical to before this existed.
  assert.deepEqual(resolveDisallowedTools({ extraDisallowedTools: ["Write"] }), ["Write"])
})

// ---------------------------------------------------------------------------
// The argv a real doStream produces
// ---------------------------------------------------------------------------

/** Spawn one real turn against a fake `claude` and return its argv. */
async function argvForSpawn(input: {
  id: string
  config: Record<string, unknown>
  mapReadRules?: boolean
}): Promise<string[]> {
  const { createClaudeCode } = await import("../src/index.js")
  const { sessionKey, deleteActiveProcessAndWait, deleteClaudeSessionId } = await import(
    "../src/session-manager.js"
  )

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-read-rules-"))
  const cwd = path.join(root, "project")
  fs.mkdirSync(cwd, { recursive: true })
  // A worktree marker, so the project walk-up stops here.
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true })
  fs.writeFileSync(path.join(cwd, "opencode.json"), JSON.stringify(input.config))

  const cliPath = path.join(root, `claude-${input.id}.cjs`)
  const argvPath = path.join(root, `argv-${input.id}.json`)
  fs.writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) { process.stdout.write("2.1.293\\n"); process.exit(0) }
if (process.argv.includes("--help")) { process.stdout.write("Usage: claude [options]\\n"); process.exit(0) }
fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)))
readline.createInterface({ input: process.stdin }).on("line", () => {
  const session_id = "fake-read-rules-${input.id}"
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "assistant", session_id, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id, is_error: false, duration_ms: 1, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n")
})
`,
  )
  fs.chmodSync(cliPath, 0o755)

  const saved = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    OPENCODE_WORKTREE: process.env.OPENCODE_WORKTREE,
    OPENCODE_PERMISSION: process.env.OPENCODE_PERMISSION,
    HOME: process.env.HOME,
  }
  process.env.XDG_CONFIG_HOME = path.join(root, "empty-config")
  process.env.HOME = root
  delete process.env.OPENCODE_CONFIG
  delete process.env.OPENCODE_CONFIG_DIR
  delete process.env.OPENCODE_WORKTREE
  delete process.env.OPENCODE_PERMISSION

  const modelId = `claude-test-read-rules-${input.id}`
  const sk = sessionKey(cwd, `${modelId}::tools::default::context=["claude-code",null]`)
  try {
    const model = createClaudeCode({
      cliPath,
      cwd,
      proxyTools: [],
      bridgeOpencodeSkills: false,
      autoContinueIncompleteTurns: false,
      mcpConnectWaitMs: 0,
      ...(input.mapReadRules === undefined ? {} : { mapReadRules: input.mapReadRules }),
    }).languageModel(modelId)
    const response = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Say done." }] }],
      tools: [],
    } as any)
    for await (const _ of response.stream) {
      /* drain */
    }
    return JSON.parse(fs.readFileSync(argvPath, "utf8")) as string[]
  } finally {
    await deleteActiveProcessAndWait(sk)
    deleteClaudeSessionId(sk)
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
}

/** `--disallowedTools <names...>` is variadic, like `--mcp-config`. */
function disallowedIn(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== "--disallowedTools") continue
    for (let j = i + 1; j < argv.length && !argv[j]!.startsWith("--"); j += 1) out.push(argv[j]!)
  }
  return out
}

// One test, because the helper swaps HOME and XDG_CONFIG_HOME for the
// duration of a spawn and concurrent top-level tests would read each other's.
test(
  "a real spawn carries the operator's read denies, and `mapReadRules: false` removes them",
  { skip: process.platform === "win32", timeout: 30_000 },
  async () => {
    const config = { permission: { read: { "*.env": "deny", "secrets/*": "deny" } } }

    const on = disallowedIn(await argvForSpawn({ id: "on", config }))
    assert.ok(on.includes("Read(*.env)"), `expected Read(*.env) in ${JSON.stringify(on)}`)
    assert.ok(on.includes("Read(secrets/**)"), `expected the subtree rule in ${JSON.stringify(on)}`)

    const off = disallowedIn(await argvForSpawn({ id: "off", config, mapReadRules: false }))
    assert.ok(!off.some((entry) => entry.startsWith("Read(")), JSON.stringify(off))

    // opencode's defaults alone are asks, so a default install sends nothing.
    const bare = disallowedIn(await argvForSpawn({ id: "bare", config: {} }))
    assert.ok(!bare.some((entry) => entry.startsWith("Read(")), JSON.stringify(bare))
  },
)
