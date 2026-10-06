import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { claudeCodeProviders } from "../src/index.js"
import { resolveSpawnCwdFrom } from "../src/runtime-status.js"
import {
  collectStartupDiagnostics,
  describeSpawnCwd,
  detectOpencodeVersion,
  pickOpencodeVersion,
  pluginVersion,
  resetOpencodeVersionProbe,
} from "../src/startup-diagnostics.js"

test("pluginVersion reads the real package manifest", () => {
  const version = pluginVersion()
  assert.match(version, /^\d+\.\d+\.\d+/)
})

test("V2 startup/doctor diagnostics name real servers without credential values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-v2-diagnostics-"))
  const saved = Object.fromEntries(["XDG_CONFIG_HOME", "HOME", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_WORKTREE"].map(k => [k, process.env[k]]))
  process.env.XDG_CONFIG_HOME = root
  process.env.HOME = root
  delete process.env.OPENCODE_CONFIG
  delete process.env.OPENCODE_CONFIG_DIR
  delete process.env.OPENCODE_WORKTREE
  try {
    fs.mkdirSync(path.join(root, "opencode"))
    fs.writeFileSync(path.join(root, "opencode/opencode.json"), JSON.stringify({
      mcp: { servers: {
        github: { type: "remote", url: "https://example.test", headers: { Authorization: "fixture-not-a-real-credential" } },
        off: { type: "remote", url: "https://example.test", disabled: true },
      } },
    }))
    const result = collectStartupDiagnostics({ "claude-code": { options: { cwd: root } } }, "2.0.18")
    assert.deepEqual(result.mcpServers, ["github"])
    assert.doesNotMatch(JSON.stringify(result), /fixture-not-a-real-credential|Authorization|example\.test/)
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("describeSpawnCwd reports which branch resolveSpawnCwd would take", () => {
  assert.deepEqual(describeSpawnCwd("/pinned", "/live", "/captured"), {
    resolved: "/pinned",
    source: "configured",
  })
  assert.deepEqual(describeSpawnCwd(undefined, "/live/dir", "/captured"), {
    resolved: "/live/dir",
    source: "process",
  })
  // The macOS GUI-launch fingerprint from issue #4: process.cwd() is "/".
  assert.deepEqual(describeSpawnCwd(undefined, "/", "/captured/dir"), {
    resolved: "/captured/dir",
    source: "captured",
  })
  assert.deepEqual(describeSpawnCwd(undefined, "/", undefined), {
    resolved: "/",
    source: "unresolved",
  })
})

test("describeSpawnCwd never disagrees with resolveSpawnCwd", () => {
  const cases: Array<[string | undefined, string, string | undefined]> = [
    ["/pinned", "/live", "/captured"],
    [undefined, "/live/dir", "/captured"],
    [undefined, "/", "/captured/dir"],
    [undefined, "/", undefined],
  ]
  for (const [configured, live, captured] of cases) {
    assert.equal(
      describeSpawnCwd(configured, live, captured).resolved,
      resolveSpawnCwdFrom(configured, live, captured),
    )
  }
})

test("pickOpencodeVersion probes known shapes and degrades to undefined", () => {
  assert.equal(pickOpencodeVersion({ app: { version: "1.17.0" } }), "1.17.0")
  assert.equal(pickOpencodeVersion({ version: "1.17.0" }), "1.17.0")
  assert.equal(pickOpencodeVersion({ app: {} }), undefined)
  assert.equal(pickOpencodeVersion({ app: { version: "" } }), undefined)
  assert.equal(pickOpencodeVersion(undefined), undefined)
  assert.equal(pickOpencodeVersion("nope"), undefined)
})

test("claudeCodeProviders keeps only this plugin's providers", () => {
  const providers = claudeCodeProviders({
    "claude-code": { options: { cliPath: "claude" } },
    "claude-code-work": { options: { account: "work" } },
    anthropic: { options: { cliPath: "not-ours" } },
    "github-copilot": {},
  })
  assert.deepEqual(Object.keys(providers).sort(), [
    "claude-code",
    "claude-code-work",
  ])
})

test("collectStartupDiagnostics summarizes account providers", () => {
  const diagnostics = collectStartupDiagnostics(
    {
      "claude-code-work": {
        options: {
          account: "work",
          cliPath: "/tmp/claude-work",
          cwd: "/pinned/dir",
          proxyTools: ["Bash", "Task"],
        },
      },
      "claude-code-personal": {
        options: { account: "personal", cliPath: "/tmp/claude-personal" },
      },
    },
    "1.17.0",
  )

  assert.equal(diagnostics.opencode, "1.17.0")
  assert.equal(diagnostics.claudeCliPath, "/tmp/claude-work")
  assert.deepEqual(diagnostics.accounts, ["work", "personal"])
  assert.deepEqual(diagnostics.proxyTools, ["Bash", "Task"])
  assert.deepEqual(diagnostics.cwd, {
    resolved: "/pinned/dir",
    source: "configured",
  })
  assert.deepEqual(diagnostics.providers, [
    "claude-code-work",
    "claude-code-personal",
  ])
  assert.ok(Array.isArray(diagnostics.mcpServers))
})

test("collectStartupDiagnostics reports permissionPreset per provider", () => {
  const diagnostics = collectStartupDiagnostics({
    "claude-code-work": {
      options: { account: "work", permissionPreset: "read-only" },
    },
    "claude-code-personal": { options: { account: "personal" } },
  })

  // Per provider, not first-wins: one account restricted and one not is a
  // configuration a single value would report wrongly.
  assert.deepEqual(
    diagnostics.permissionPresets.map((row) => [row.provider, row.preset, row.applied]),
    [
      ["claude-code-work", "read-only", true],
      ["claude-code-personal", "none", false],
    ],
  )
})

test("collectStartupDiagnostics carries the options a preset replaced", () => {
  const [row] = collectStartupDiagnostics({
    "claude-code": {
      options: {
        permissionPreset: "read-only",
        permissionMode: "acceptEdits",
        skipPermissions: true,
        controlRequestBehavior: "allow",
      },
    },
  }).permissionPresets

  assert.equal(row.applied, true)
  // The same facts applyPermissionPreset logs at NOTICE, one line per option.
  const joined = row.overrides.join("\n")
  assert.match(joined, /permissionMode: "acceptEdits" is dropped/)
  assert.match(joined, /skipPermissions: forced to false/)
  assert.match(joined, /controlRequestBehavior: forced to "deny"/)
  // No proxyTools of its own, so the default list is what got filtered.
  assert.match(joined, /proxyTools: dropped Bash, Edit, Write, WebFetch, Task/)
})

test("collectStartupDiagnostics calls out an unrecognised preset", () => {
  const [row] = collectStartupDiagnostics({
    "claude-code": { options: { permissionPreset: "readonly" } },
  }).permissionPresets

  // A typo'd safety option runs at full permissions, so it must never read as
  // if it took effect.
  assert.equal(row.preset, "readonly")
  assert.equal(row.applied, false)
  assert.deepEqual(row.overrides, [])
})

test("collectStartupDiagnostics falls back when options are absent", () => {
  const diagnostics = collectStartupDiagnostics({ "claude-code": {} })

  assert.equal(diagnostics.claudeCliPath, "claude")
  assert.deepEqual(diagnostics.accounts, [])
  assert.deepEqual(diagnostics.proxyTools, [])
  assert.deepEqual(diagnostics.permissionPresets, [
    { provider: "claude-code", preset: "none", applied: false, overrides: [] },
  ])
  assert.equal(diagnostics.cwd.source, "process")
  // No opencode version handed in and none in the env → explicit "unknown",
  // never a fabricated number.
  if (!process.env.OPENCODE_VERSION) {
    assert.equal(diagnostics.opencode, "unknown")
  }
})

test("collectStartupDiagnostics reports interactive transport from env", () => {
  const previous = process.env.CLAUDE_CODE_INTERACTIVE_TRANSPORT
  try {
    delete process.env.CLAUDE_CODE_INTERACTIVE_TRANSPORT
    assert.equal(
      collectStartupDiagnostics({ "claude-code": {} }).interactiveTransport,
      false,
    )
    assert.equal(
      collectStartupDiagnostics({
        "claude-code": { options: { interactive: true } },
      }).interactiveTransport,
      true,
    )
    process.env.CLAUDE_CODE_INTERACTIVE_TRANSPORT = "1"
    assert.equal(
      collectStartupDiagnostics({ "claude-code": {} }).interactiveTransport,
      true,
    )
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_INTERACTIVE_TRANSPORT
    else process.env.CLAUDE_CODE_INTERACTIVE_TRANSPORT = previous
  }
})

test("detectOpencodeVersion reads the version from the opencode binary", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-version-probe-"))
  const fake = path.join(dir, "opencode")
  fs.writeFileSync(fake, '#!/bin/sh\necho "1.18.5"\n')
  fs.chmodSync(fake, 0o755)
  try {
    // The probe spawns under a 5s deadline and caches whatever it got, so on
    // a loaded machine a killed spawn reads as "unknown" and this spec would
    // be deciding a race rather than what the probe reports (measured
    // 2026-10-01: a 5s overrun is reachable at a load average of 66+). Ask
    // again, from a clean probe, until the script answers.
    let version: string | undefined
    for (let attempt = 1; attempt <= 4 && version === undefined; attempt++) {
      resetOpencodeVersionProbe()
      version = await detectOpencodeVersion(fake)
    }
    assert.equal(version, "1.18.5")
    // Cached: a second call with a different path reuses the first probe.
    assert.equal(await detectOpencodeVersion("/nonexistent/opencode"), "1.18.5")
  } finally {
    resetOpencodeVersionProbe()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("detectOpencodeVersion refuses to report a non-opencode execPath", async () => {
  try {
    // Running from source means execPath is Bun; reporting Bun's version as
    // opencode's would be actively misleading, so the probe declines.
    resetOpencodeVersionProbe()
    assert.equal(await detectOpencodeVersion("/opt/homebrew/bin/bun"), undefined)
  } finally {
    resetOpencodeVersionProbe()
  }
})

test("detectOpencodeVersion returns undefined when the binary fails", async () => {
  try {
    resetOpencodeVersionProbe()
    assert.equal(await detectOpencodeVersion("/nonexistent/dir/opencode"), undefined)
  } finally {
    resetOpencodeVersionProbe()
  }
})

test("collectStartupDiagnostics reports the requested transport, by either spelling", () => {
  const previous = process.env.CLAUDE_CODE_INTERACTIVE_TRANSPORT
  try {
    delete process.env.CLAUDE_CODE_INTERACTIVE_TRANSPORT
    const of = (options: Record<string, unknown>) => collectStartupDiagnostics({ "claude-code": { options } })
    assert.equal(of({}).transport, "headless")
    assert.equal(of({ transport: "auto" }).transport, "auto")
    assert.equal(of({ transport: "auto" }).interactiveTransport, false, "auto is a request, not a route")
    assert.equal(of({ transport: "interactive" }).transport, "interactive")
    assert.equal(of({ transport: "interactive" }).interactiveTransport, true)
    // An explicit transport wins over the legacy flag.
    assert.equal(of({ transport: "headless", interactive: true }).transport, "headless")
    assert.equal(of({ transport: "pty" }).transport, "invalid")
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_INTERACTIVE_TRANSPORT
    else process.env.CLAUDE_CODE_INTERACTIVE_TRANSPORT = previous
  }
})
