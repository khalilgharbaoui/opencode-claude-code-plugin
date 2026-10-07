import assert from "node:assert/strict"
import { test } from "node:test"
import {
  READ_ONLY_DENIED_PROXY_TOOLS,
  READ_ONLY_DISALLOWED_CLI_TOOLS,
  interactivePermissionPosture,
  isReadOnlyPermissionMode,
  isUnknownPreset,
  resolvePermissionPreset,
  type ResolvedPermissionPreset,
} from "../src/permission-presets.js"
import {
  cliSupportsDontAsk,
  cliSupportsInteractiveBypass,
  cliSupportsPermissionPrompts,
  cliSupportsRestricted,
  type CliVersion,
} from "../src/cli-version.js"
import { buildCliArgs } from "../src/session-manager.js"
import { applyPermissionPreset, createClaudeCode } from "../src/index.js"
import { configureLogger, _resetLoggerForTests } from "../src/logger.js"
import { READ_ONLY_PERMISSION_MODE } from "../src/types.js"

const DEFAULTS = ["Bash", "Edit", "Write", "WebFetch", "Task"]

function version(raw: string): CliVersion {
  const [major, minor, patch] = raw.split(".").map(Number)
  return { major: major!, minor: minor!, patch: patch!, raw }
}

function readOnly(
  settings: Parameters<typeof resolvePermissionPreset>[0] = {},
): ResolvedPermissionPreset {
  const resolved = resolvePermissionPreset(
    { ...settings, permissionPreset: "read-only" },
    DEFAULTS,
  )
  assert.ok(resolved && !isUnknownPreset(resolved), "read-only must resolve")
  return resolved
}

function captureLogs(fn: () => void): string[] {
  const lines: string[] = []
  const original = console.error
  console.error = (line: unknown) => {
    lines.push(String(line))
  }
  try {
    _resetLoggerForTests()
    configureLogger({ mode: "debug", level: "debug" })
    fn()
  } finally {
    console.error = original
    _resetLoggerForTests()
  }
  return lines
}

// ---------------------------------------------------------------------------
// Opt-in: no preset must change nothing at all
// ---------------------------------------------------------------------------

test("no permissionPreset resolves to null, so nothing is overridden", () => {
  assert.equal(resolvePermissionPreset({}, DEFAULTS), null)
  assert.equal(
    resolvePermissionPreset(
      { skipPermissions: true, proxyTools: ["Bash"] },
      DEFAULTS,
    ),
    null,
  )
})

test("createClaudeCode without a preset leaves every permission setting alone", () => {
  const model: any = createClaudeCode({
    proxyTools: ["Bash", "Task"],
    permissionMode: "plan",
    controlRequestToolBehaviors: { Bash: "allow" },
    extraDisallowedTools: ["WebSearch"],
  })("claude-sonnet-5")

  assert.equal(model.config.permissionPreset, undefined)
  assert.equal(model.config.permissionMode, "plan")
  assert.equal(model.config.skipPermissions, true)
  assert.equal(model.config.controlRequestBehavior, "allow")
  assert.deepEqual(model.config.controlRequestToolBehaviors, { Bash: "allow" })
  assert.deepEqual(model.config.proxyTools, ["Bash", "Task"])
  assert.deepEqual(model.config.extraDisallowedTools, ["WebSearch"])
})

// ---------------------------------------------------------------------------
// What read-only resolves to
// ---------------------------------------------------------------------------

test("read-only forbids bypass, because the CLI refuses to start with both", () => {
  const resolved = readOnly({ skipPermissions: true })

  assert.equal(resolved.skipPermissions, false)
  assert.equal(resolved.permissionMode, READ_ONLY_PERMISSION_MODE)
  assert.ok(
    resolved.overridden.some((line) => line.startsWith("skipPermissions:")),
    "forcing skipPermissions off must be reported, not silent",
  )
})

test("read-only drops the write and command tools from the proxy", () => {
  const resolved = readOnly()

  assert.deepEqual(resolved.proxyTools, [])
  for (const name of ["bash", "edit", "write", "webfetch", "task", "task_batch"]) {
    assert.ok(
      READ_ONLY_DENIED_PROXY_TOOLS.has(name),
      `${name} must be denied on the proxy`,
    )
  }
})

test("read-only keeps a proxy tool that changes nothing", () => {
  const resolved = readOnly({ proxyTools: ["Bash", "Question", "Task"] })

  assert.deepEqual(resolved.proxyTools, ["Question"])
  assert.ok(
    resolved.overridden.some((line) => line.includes("Bash, Task")),
    `dropped names must be named: ${resolved.overridden.join(" | ")}`,
  )
})

test("read-only matches proxy tool names case-insensitively", () => {
  assert.deepEqual(readOnly({ proxyTools: ["bash", "WEBFETCH"] }).proxyTools, [])
})

test("read-only disallows the mutating CLI built-ins and keeps the reads", () => {
  const resolved = readOnly()

  for (const name of ["Bash", "Write", "Edit", "NotebookEdit", "REPL", "JavaScript", "WebFetch"]) {
    assert.ok(
      resolved.extraDisallowedTools.includes(name),
      `${name} must be disallowed`,
    )
  }
  for (const name of ["Read", "Grep", "Glob", "WebSearch"]) {
    assert.equal(
      resolved.extraDisallowedTools.includes(name),
      false,
      `${name} reads and must stay available`,
    )
  }
})

test("read-only keeps the operator's own extraDisallowedTools", () => {
  const resolved = readOnly({ extraDisallowedTools: ["WebSearch", "Bash"] })

  assert.ok(resolved.extraDisallowedTools.includes("WebSearch"))
  assert.equal(
    resolved.extraDisallowedTools.filter((name) => name === "Bash").length,
    1,
    "a name in both lists must not be duplicated onto the CLI",
  )
  assert.deepEqual(
    resolved.extraDisallowedTools.slice(0, READ_ONLY_DISALLOWED_CLI_TOOLS.length),
    [...READ_ONLY_DISALLOWED_CLI_TOOLS],
  )
})

test("read-only denies permission requests and refuses per-tool exceptions", () => {
  const resolved = readOnly({
    controlRequestBehavior: "allow",
    controlRequestToolBehaviors: { Write: "allow" },
  })

  assert.equal(resolved.controlRequestBehavior, "deny")
  assert.equal(resolved.controlRequestToolBehaviors, undefined)
  assert.ok(
    resolved.overridden.some((line) =>
      line.startsWith("controlRequestToolBehaviors:"),
    ),
    "ignoring the per-tool map must be reported",
  )
})

test("read-only replaces a configured permissionMode and says so", () => {
  const resolved = readOnly({ permissionMode: "bypassPermissions" })

  assert.equal(resolved.permissionMode, READ_ONLY_PERMISSION_MODE)
  assert.ok(
    resolved.overridden.some((line) => line.includes("bypassPermissions")),
  )
})

test("an unrecognised preset is refused rather than approximated", () => {
  const resolved = resolvePermissionPreset(
    { permissionPreset: "readonly" as any },
    DEFAULTS,
  )

  assert.ok(isUnknownPreset(resolved))
  assert.equal((resolved as { unknown: string }).unknown, "readonly")
})

test("applyPermissionPreset warns and applies nothing for an unknown name", () => {
  let result: unknown
  const lines = captureLogs(() => {
    result = applyPermissionPreset(
      { permissionPreset: "readonly" as any },
      DEFAULTS,
    )
  })

  assert.equal(result, null)
  assert.ok(lines.some((line) => /WARN/.test(line) && /unknown permissionPreset/.test(line)))
})

test("applyPermissionPreset reports each override it made", () => {
  const lines = captureLogs(() => {
    applyPermissionPreset(
      { permissionPreset: "read-only", skipPermissions: true },
      DEFAULTS,
    )
  })

  assert.ok(lines.some((line) => /permission preset "read-only" applied/.test(line)))
  assert.ok(lines.some((line) => /overrode skipPermissions/.test(line)))
})

// ---------------------------------------------------------------------------
// The spawn: which flags a read-only turn actually gets
// ---------------------------------------------------------------------------

test("read-only spawns --restricted instead of --permission-mode", () => {
  const args = buildCliArgs({
    sessionKey: "ro",
    skipPermissions: false,
    includeSessionId: false,
    cliVersion: version("2.1.280"),
    permissionMode: READ_ONLY_PERMISSION_MODE,
  })

  assert.ok(args.includes("--restricted"))
  assert.equal(args.includes("--permission-mode"), false)
  assert.equal(args.includes(READ_ONLY_PERMISSION_MODE), false)
  assert.deepEqual(
    args.slice(args.indexOf("--permission-prompts"), args.indexOf("--permission-prompts") + 2),
    ["--permission-prompts", "none"],
  )
})

test("read-only never passes --dangerously-skip-permissions", () => {
  // Measured on 2.1.280: the two together are a startup error, not an
  // override, so a spawn carrying both would not run at all.
  const args = buildCliArgs({
    sessionKey: "ro-skip",
    skipPermissions: true,
    includeSessionId: false,
    cliVersion: version("2.1.280"),
    permissionMode: READ_ONLY_PERMISSION_MODE,
  })

  assert.equal(args.includes("--dangerously-skip-permissions"), false)
})

test("a CLI without --permission-prompts gets --restricted and one WARN", () => {
  let args: string[] = []
  const lines = captureLogs(() => {
    args = buildCliArgs({
      sessionKey: "ro-258",
      skipPermissions: false,
      includeSessionId: false,
      cliVersion: version("2.1.258"),
      permissionMode: READ_ONLY_PERMISSION_MODE,
    })
  })

  assert.ok(args.includes("--restricted"))
  assert.equal(args.includes("--permission-prompts"), false)
  const warnings = lines.filter((line) => /WARN/.test(line))
  assert.equal(warnings.length, 1, warnings.join(" | "))
  assert.match(warnings[0]!, /--permission-prompts/)
  assert.match(warnings[0]!, /can_use_tool/)
})

test("a CLI with neither flag degrades to the plugin's own denial, loudly", () => {
  let args: string[] = []
  const lines = captureLogs(() => {
    args = buildCliArgs({
      sessionKey: "ro-old",
      skipPermissions: true,
      includeSessionId: false,
      cliVersion: version("2.1.200"),
      permissionMode: READ_ONLY_PERMISSION_MODE,
    })
  })

  assert.equal(args.includes("--restricted"), false)
  assert.equal(args.includes("--permission-prompts"), false)
  assert.equal(args.includes("--dangerously-skip-permissions"), false)
  assert.equal(lines.filter((line) => /WARN/.test(line)).length, 2)
})

test("an undetected CLI version skips both new flags", () => {
  const args = captureLogs(() => {}) && buildCliArgs({
    sessionKey: "ro-unknown",
    skipPermissions: false,
    includeSessionId: false,
    cliVersion: null,
    permissionMode: READ_ONLY_PERMISSION_MODE,
  })

  assert.equal(args.includes("--restricted"), false)
  assert.equal(args.includes("--permission-prompts"), false)
})

test("every other permission mode is untouched by the read-only branch", () => {
  for (const mode of ["acceptEdits", "auto", "default", "dontAsk"]) {
    const args = buildCliArgs({
      sessionKey: `mode-${mode}`,
      skipPermissions: true,
      includeSessionId: false,
      cliVersion: version("2.1.280"),
      permissionMode: mode,
    })

    const at = args.indexOf("--permission-mode")
    assert.deepEqual(args.slice(at, at + 2), ["--permission-mode", mode])
    assert.equal(args.includes("--restricted"), false)
    assert.equal(args.includes("--dangerously-skip-permissions"), true)
  }
})

test("isReadOnlyPermissionMode only matches the preset's own token", () => {
  assert.equal(isReadOnlyPermissionMode(READ_ONLY_PERMISSION_MODE), true)
  assert.equal(isReadOnlyPermissionMode("plan"), false)
  assert.equal(isReadOnlyPermissionMode(undefined), false)
})

// ---------------------------------------------------------------------------
// Version gates, at the versions they were measured at
// ---------------------------------------------------------------------------

test("cliSupportsRestricted is gated at the oldest binary it was seen in", () => {
  assert.equal(cliSupportsRestricted(version("2.1.258")), true)
  assert.equal(cliSupportsRestricted(version("2.1.280")), true)
  assert.equal(cliSupportsRestricted(version("2.1.257")), false)
  assert.equal(cliSupportsRestricted(version("3.0.0")), true)
  assert.equal(cliSupportsRestricted(null), false)
})

test("cliSupportsPermissionPrompts brackets 2.1.258 (absent) and 2.1.263 (present)", () => {
  assert.equal(cliSupportsPermissionPrompts(version("2.1.258")), false)
  assert.equal(cliSupportsPermissionPrompts(version("2.1.263")), true)
  assert.equal(cliSupportsPermissionPrompts(version("2.1.280")), true)
  assert.equal(cliSupportsPermissionPrompts(null), false)
})

// ---------------------------------------------------------------------------
// The whole way through, as opencode builds it
// ---------------------------------------------------------------------------

test("createClaudeCode applies the preset to the language model's config", () => {
  const model: any = createClaudeCode({
    permissionPreset: "read-only",
    skipPermissions: true,
    permissionMode: "acceptEdits",
    controlRequestToolBehaviors: { Bash: "allow" },
  })("claude-sonnet-5")

  assert.equal(model.config.permissionPreset, "read-only")
  assert.equal(model.config.permissionMode, READ_ONLY_PERMISSION_MODE)
  assert.equal(model.config.skipPermissions, false)
  assert.equal(model.config.controlRequestBehavior, "deny")
  assert.equal(model.config.controlRequestToolBehaviors, undefined)
  assert.deepEqual(model.config.proxyTools, [])
  assert.deepEqual(
    model.config.extraDisallowedTools,
    [...READ_ONLY_DISALLOWED_CLI_TOOLS],
  )
})

test("the preset's deny reaches the control-request handler", async () => {
  const { controlRequestBehaviorForTool } = await import("../src/control-request.js")
  const model: any = createClaudeCode({ permissionPreset: "read-only" })(
    "claude-sonnet-5",
  )

  for (const tool of ["Write", "Bash", "mcp__github__create_issue"]) {
    assert.equal(controlRequestBehaviorForTool(model.config, tool), "deny", tool)
  }
})

test("the interactive transport holds read-only with --restricted, dontAsk and a read-only allow list", () => {
  const allow = ["mcp__github__*", "mcp__opencode_proxy__*", "Bash", "Edit", "Write", "Read", "WebFetch", "Bash(git status)"]
  assert.deepEqual(
    interactivePermissionPosture({ permissionMode: READ_ONLY_PERMISSION_MODE, allow, supportsReadOnly: true }),
    { permissionMode: "dontAsk", restricted: true, allow: ["Read"], bypass: false, disallowed: [] },
  )
  // Fails closed on a CLI that cannot hold it, never an approximation.
  assert.equal(
    interactivePermissionPosture({ permissionMode: READ_ONLY_PERMISSION_MODE, allow, supportsReadOnly: false }),
    null,
  )
  // A CLI without the bypass setting keeps every other mode as the CLI's own,
  // plan included, and the list untouched.
  for (const mode of ["plan", "acceptEdits", undefined]) {
    assert.deepEqual(
      interactivePermissionPosture({ permissionMode: mode, allow, supportsReadOnly: false }),
      { permissionMode: mode, restricted: false, allow, bypass: false, disallowed: [] },
    )
  }
})

test("the interactive transport follows the headless permission policy (h #g210)", () => {
  const allow = ["mcp__opencode_proxy__*", "Read"]
  const posture = (over: Record<string, unknown>) =>
    interactivePermissionPosture({ permissionMode: undefined, allow, supportsReadOnly: true, supportsBypass: true, ...over })
  // skipPermissions unset is true, as on headless: the skip flag.
  assert.equal(posture({})!.bypass, true)
  assert.equal(posture({ skipPermissions: true, permissionMode: "acceptEdits" })!.bypass, true)
  // Plan mode drops the skip flag, as `buildCliArgs` does, and read-only never takes it.
  assert.deepEqual(posture({ permissionMode: "plan" }), {
    permissionMode: "plan", restricted: false, allow, bypass: false, disallowed: [],
  })
  assert.equal(posture({ permissionMode: READ_ONLY_PERMISSION_MODE })!.bypass, false)
  // skipPermissions false answers can_use_tool with the configured policy.
  assert.deepEqual(
    posture({ skipPermissions: false, controlRequestToolBehaviors: { Bash: "deny", Read: "allow" } }),
    { permissionMode: undefined, restricted: false, allow, bypass: true, disallowed: ["Bash"] },
  )
  assert.deepEqual(
    posture({
      skipPermissions: false,
      controlRequestBehavior: "deny",
      controlRequestToolBehaviors: { Bash: "deny", Read: "allow", "mcp__opencode_proxy__bash": "allow" },
    }),
    { permissionMode: "dontAsk", restricted: false, allow: ["Read", "mcp__opencode_proxy__bash"], bypass: false, disallowed: [] },
  )
  // An explicit bypassPermissions is the skip flag, never the mode.
  assert.deepEqual(posture({ skipPermissions: false, permissionMode: "bypassPermissions" }), {
    permissionMode: undefined, restricted: false, allow, bypass: true, disallowed: [],
  })
  // A CLI that cannot skip the confirmation keeps the allow list.
  assert.equal(posture({ supportsBypass: false })!.bypass, false)
  assert.equal(cliSupportsInteractiveBypass({ major: 2, minor: 1, patch: 262, raw: "2.1.262" } as any), false)
  assert.equal(cliSupportsInteractiveBypass({ major: 2, minor: 1, patch: 263, raw: "2.1.263" } as any), true)
})

test("dontAsk is gated at the oldest CLI measured with it", () => {
  assert.equal(cliSupportsDontAsk(null), false)
  assert.equal(cliSupportsDontAsk({ major: 2, minor: 1, patch: 262, raw: "2.1.262" } as any), false)
  assert.equal(cliSupportsDontAsk({ major: 2, minor: 1, patch: 263, raw: "2.1.263" } as any), true)
})
