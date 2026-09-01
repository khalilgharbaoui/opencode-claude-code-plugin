import assert from "node:assert/strict"
import { test } from "node:test"
import {
  buildCliArgs,
  claudeSpawnEnv,
  isClaudeThinkingDisabled,
} from "./src/session-manager.js"
import {
  cliSupportsFastMode,
  cliSupportsThinking,
  cliSupportsThinkingDisplay,
} from "./src/cli-version.js"
import { parseModelId } from "./src/models.js"
import {
  reportFastModeState,
  _resetFastModeWarnings,
} from "./src/claude-code-language-model.js"
import { configureLogger, _resetLoggerForTests } from "./src/logger.js"
import {
  disallowedToolFlags,
  resolveDisallowedTools,
  type ProxyToolDef,
} from "./src/proxy-mcp.js"

function withClaudeThinkingEnv<T>(
  env: {
    disableThinking?: string
    disableAdaptiveThinking?: string
    showSummaries?: string
  },
  fn: () => T,
): T {
  const previous = {
    disableThinking: process.env.CLAUDE_CODE_DISABLE_THINKING,
    disableAdaptiveThinking: process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING,
    showSummaries: process.env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES,
  }

  try {
    if (env.disableThinking === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_THINKING
    } else {
      process.env.CLAUDE_CODE_DISABLE_THINKING = env.disableThinking
    }
    if (env.disableAdaptiveThinking === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING
    } else {
      process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = env.disableAdaptiveThinking
    }
    if (env.showSummaries === undefined) {
      delete process.env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES
    } else {
      process.env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES = env.showSummaries
    }
    return fn()
  } finally {
    if (previous.disableThinking === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_THINKING
    } else {
      process.env.CLAUDE_CODE_DISABLE_THINKING = previous.disableThinking
    }
    if (previous.disableAdaptiveThinking === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING
    } else {
      process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = previous.disableAdaptiveThinking
    }
    if (previous.showSummaries === undefined) {
      delete process.env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES
    } else {
      process.env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES = previous.showSummaries
    }
  }
}

test("thinking-display is gated on Claude Code CLI 2.1.142+", () => {
  assert.equal(cliSupportsThinkingDisplay(null), false)
  assert.equal(
    cliSupportsThinkingDisplay({ major: 2, minor: 1, patch: 141, raw: "2.1.141" }),
    false,
  )
  assert.equal(
    cliSupportsThinkingDisplay({ major: 2, minor: 1, patch: 142, raw: "2.1.142" }),
    true,
  )
  assert.equal(
    cliSupportsThinkingDisplay({ major: 2, minor: 2, patch: 0, raw: "2.2.0" }),
    true,
  )
})

test("buildCliArgs skips unsupported thinking-display flag", () => {
  const args = buildCliArgs({
    sessionKey: "test",
    skipPermissions: true,
    model: "claude-opus-4-7",
    thinking: "enabled",
    thinkingDisplay: "summarized",
    cliVersion: { major: 2, minor: 1, patch: 141, raw: "2.1.141" },
  })

  assert.equal(args.includes("--thinking"), true)
  assert.equal(args.includes("enabled"), true)
  assert.equal(args.includes("--thinking-display"), false)
  assert.equal(args.includes("summarized"), false)
})

test("cliSupportsThinking floors at 2.0.0", () => {
  assert.equal(cliSupportsThinking(null), false)
  assert.equal(
    cliSupportsThinking({ major: 1, minor: 99, patch: 99, raw: "1.99.99" }),
    false,
  )
  assert.equal(
    cliSupportsThinking({ major: 2, minor: 0, patch: 0, raw: "2.0.0" }),
    true,
  )
  assert.equal(
    cliSupportsThinking({ major: 2, minor: 1, patch: 142, raw: "2.1.142" }),
    true,
  )
})

test("buildCliArgs skips --thinking when cliVersion is unknown", () => {
  const args = buildCliArgs({
    sessionKey: "test",
    skipPermissions: true,
    model: "claude-opus-4-7",
    thinking: "enabled",
    cliVersion: null,
  })

  assert.equal(args.includes("--thinking"), false)
  assert.equal(args.includes("enabled"), false)
})

test("buildCliArgs skips --thinking on pre-2.x CLI", () => {
  const args = buildCliArgs({
    sessionKey: "test",
    skipPermissions: true,
    model: "claude-opus-4-7",
    thinking: "enabled",
    cliVersion: { major: 1, minor: 5, patch: 0, raw: "1.5.0" },
  })

  assert.equal(args.includes("--thinking"), false)
})

test("buildCliArgs emits thinking-display for supported CLI", () => {
  const args = buildCliArgs({
    sessionKey: "test",
    skipPermissions: true,
    model: "claude-opus-4-7",
    thinking: "enabled",
    thinkingDisplay: "summarized",
    cliVersion: { major: 2, minor: 1, patch: 142, raw: "2.1.142" },
  })

  assert.equal(args.includes("--thinking"), true)
  assert.equal(args.includes("enabled"), true)
  assert.equal(args.includes("--thinking-display"), true)
  assert.equal(args.includes("summarized"), true)
})

// Fast mode. There is no `--fast` flag and no fast model name the CLI still
// accepts: `--settings {"fastMode":true}` is the only headless opt-in, because
// the CLI's SDK gate reads the *flag* settings layer specifically. Verified
// live against Claude Code 2.1.245 on 2026-08-30: without it the init message
// reports `fast_mode_disabled_reason: "sdk_opt_in_required"`.
test("buildCliArgs opts into fast mode via --settings", () => {
  const args = buildCliArgs({
    sessionKey: "test",
    skipPermissions: true,
    model: "claude-opus-5",
    fastMode: true,
    cliVersion: { major: 2, minor: 1, patch: 245, raw: "2.1.245" },
  })

  const at = args.indexOf("--settings")
  assert.notEqual(at, -1)
  assert.deepEqual(JSON.parse(args[at + 1]!), { fastMode: true })
})

test("buildCliArgs omits --settings when fast mode is not requested", () => {
  const args = buildCliArgs({
    sessionKey: "test",
    skipPermissions: true,
    model: "claude-opus-5",
    cliVersion: { major: 2, minor: 1, patch: 245, raw: "2.1.245" },
  })

  assert.equal(args.includes("--settings"), false)
})

test("buildCliArgs skips the fast-mode opt-in on an unverified CLI", () => {
  for (const cliVersion of [
    null,
    { major: 2, minor: 1, patch: 219, raw: "2.1.219" },
  ]) {
    const args = buildCliArgs({
      sessionKey: "test",
      skipPermissions: true,
      model: "claude-opus-5",
      fastMode: true,
      cliVersion,
    })
    assert.equal(args.includes("--settings"), false)
  }
})

test("cliSupportsFastMode floors at 2.1.220", () => {
  assert.equal(cliSupportsFastMode(null), false)
  assert.equal(
    cliSupportsFastMode({ major: 2, minor: 1, patch: 219, raw: "2.1.219" }),
    false,
  )
  assert.equal(
    cliSupportsFastMode({ major: 2, minor: 1, patch: 220, raw: "2.1.220" }),
    true,
  )
  assert.equal(
    cliSupportsFastMode({ major: 2, minor: 2, patch: 0, raw: "2.2.0" }),
    true,
  )
})

// The `-fast` marker is ours and must never reach `--model`; the `@account`
// suffix is accounts.ts's and must survive, since the wrapper script strips it
// to pick a CLAUDE_CONFIG_DIR.
test("parseModelId strips the fast marker and keeps the account suffix", () => {
  assert.deepEqual(parseModelId("claude-opus-5-fast"), {
    model: "claude-opus-5",
    fast: true,
  })
  assert.deepEqual(parseModelId("claude-opus-4-8-fast"), {
    model: "claude-opus-4-8",
    fast: true,
  })
  assert.deepEqual(parseModelId("claude-opus-5-fast@work"), {
    model: "claude-opus-5@work",
    fast: true,
  })
})

test("parseModelId leaves standard model ids untouched", () => {
  assert.deepEqual(parseModelId("claude-opus-5"), {
    model: "claude-opus-5",
    fast: false,
  })
  assert.deepEqual(parseModelId("claude-opus-5@work"), {
    model: "claude-opus-5@work",
    fast: false,
  })
  assert.deepEqual(parseModelId("claude-haiku-4-5"), {
    model: "claude-haiku-4-5",
    fast: false,
  })
})

test("parseModelId does not claim a -fast id it never registered", () => {
  // A user-defined model that happens to end in `-fast` must pass through
  // whole. Rewriting it would hand `--model` a name the CLI cannot resolve.
  assert.deepEqual(parseModelId("some-vendor-model-fast"), {
    model: "some-vendor-model-fast",
    fast: false,
  })
  // Retired Anthropic fast ids are not registered either, so they are not
  // silently rewritten into something that looks like it worked.
  assert.deepEqual(parseModelId("claude-opus-4-6-fast"), {
    model: "claude-opus-4-6-fast",
    fast: false,
  })
})

// A downgrade must reach the TUI. `notice` is debug-mode-only in this codebase,
// so a blocked account has to warn or the 10x price tag in the picker silently
// stops matching what is actually billed.
function captureLogs(fn: () => void): string[] {
  const lines: string[] = []
  const original = console.error
  console.error = (line: unknown) => {
    lines.push(String(line))
  }
  try {
    _resetLoggerForTests()
    // `debug` mode so info/notice/debug also reach stderr and the test can
    // assert on the level actually chosen. warn/error reach it either way.
    configureLogger({ mode: "debug", level: "debug" })
    fn()
  } finally {
    console.error = original
    _resetLoggerForTests()
  }
  return lines
}

test("reportFastModeState warns when a requested fast turn was downgraded", () => {
  _resetFastModeWarnings()
  const lines = captureLogs(() => {
    reportFastModeState(
      {
        type: "system",
        subtype: "init",
        fast_mode_state: "off",
        fast_mode_disabled_reason: "extra_usage_disabled",
      },
      true,
    )
  })

  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /WARN/)
  assert.match(lines[0]!, /\/usage-credits/)
  assert.match(lines[0]!, /standard Opus rates/)
})

test("reportFastModeState warns once per reason, then drops to debug", () => {
  _resetFastModeWarnings()
  const msg = {
    type: "system",
    subtype: "init",
    fast_mode_state: "off" as const,
    fast_mode_disabled_reason: "extra_usage_disabled",
  }

  const lines = captureLogs(() => {
    reportFastModeState(msg, true)
    reportFastModeState(msg, true)
    reportFastModeState(msg, true)
  })

  // Account-level blocks persist across respawns; warning every time would
  // bury the TUI.
  assert.equal(lines.filter((l) => l.includes("WARN")).length, 1)
  assert.equal(lines.filter((l) => l.includes("DEBUG")).length, 2)
})

test("reportFastModeState stays quiet when fast mode was never requested", () => {
  _resetFastModeWarnings()
  const lines = captureLogs(() => {
    reportFastModeState(
      {
        type: "system",
        subtype: "init",
        fast_mode_state: "off",
        fast_mode_disabled_reason: "sdk_opt_in_required",
      },
      false,
    )
  })

  assert.equal(lines.filter((l) => l.includes("WARN")).length, 0)
})

test("reportFastModeState does not warn when fast mode is actually on", () => {
  _resetFastModeWarnings()
  const lines = captureLogs(() => {
    reportFastModeState(
      { type: "system", subtype: "init", fast_mode_state: "on" },
      true,
    )
  })

  assert.equal(lines.filter((l) => l.includes("WARN")).length, 0)
  assert.equal(lines.filter((l) => l.includes("INFO")).length, 1)
})

test("reportFastModeState treats cooldown as transient, not a misconfiguration", () => {
  _resetFastModeWarnings()
  const lines = captureLogs(() => {
    reportFastModeState(
      { type: "system", subtype: "init", fast_mode_state: "cooldown" },
      true,
    )
  })

  assert.equal(lines.filter((l) => l.includes("WARN")).length, 0)
  assert.equal(lines.filter((l) => l.includes("NOTICE")).length, 1)
})

test("Claude thinking env defaults preserve explicit user choices", () => {
  withClaudeThinkingEnv({}, () => {
    assert.equal(isClaudeThinkingDisabled(), false)
    assert.equal(claudeSpawnEnv().CLAUDE_CODE_SHOW_THINKING_SUMMARIES, "1")
  })

  withClaudeThinkingEnv({ showSummaries: "0" }, () => {
    assert.equal(isClaudeThinkingDisabled(), false)
    assert.equal(claudeSpawnEnv().CLAUDE_CODE_SHOW_THINKING_SUMMARIES, "0")
  })

  withClaudeThinkingEnv({ disableThinking: "1" }, () => {
    assert.equal(isClaudeThinkingDisabled(), true)
    assert.equal(claudeSpawnEnv().CLAUDE_CODE_SHOW_THINKING_SUMMARIES, undefined)
  })

  withClaudeThinkingEnv({ disableAdaptiveThinking: "false" }, () => {
    assert.equal(isClaudeThinkingDisabled(), false)
    assert.equal(claudeSpawnEnv().CLAUDE_CODE_SHOW_THINKING_SUMMARIES, "1")
  })
})

// `disallowedToolFlags` translates resolved proxy tool names into the
// Claude built-ins that must be passed to `--disallowedTools` so the
// model can only reach the proxied MCP version. The `question` row is
// the new one — it must disable Claude's built-in `AskUserQuestion` so
// the structured-questions path flows through opencode's `question` tool.
function proxyDef(name: string): ProxyToolDef {
  return {
    name,
    description: "",
    inputSchema: { type: "object", properties: {} },
  }
}

test("disallowedToolFlags maps each proxy tool to its Claude built-ins", () => {
  assert.deepEqual(
    disallowedToolFlags([proxyDef("bash")]),
    ["Bash"],
  )
  assert.deepEqual(
    disallowedToolFlags([proxyDef("write")]),
    ["Write"],
  )
  // Edit also disables MultiEdit (opencode has no batched-edit equivalent).
  assert.deepEqual(
    disallowedToolFlags([proxyDef("edit")]),
    ["Edit", "MultiEdit"],
  )
  assert.deepEqual(
    disallowedToolFlags([proxyDef("webfetch")]),
    ["WebFetch"],
  )
  assert.deepEqual(
    disallowedToolFlags([proxyDef("task")]),
    ["Agent"],
  )
})

test("disallowedToolFlags disables AskUserQuestion for the question proxy", () => {
  assert.deepEqual(
    disallowedToolFlags([proxyDef("question")]),
    ["AskUserQuestion"],
  )
})

test("disallowedToolFlags is case-insensitive on the proxy tool name", () => {
  // `resolvedProxyTools` lowercases when matching DEFAULT_PROXY_TOOLS, but
  // disallowedToolFlags must tolerate either casing since callers pass the
  // def name as-authored.
  assert.deepEqual(
    disallowedToolFlags([proxyDef("Question")]),
    ["AskUserQuestion"],
  )
  assert.deepEqual(
    disallowedToolFlags([proxyDef("TASK")]),
    ["Agent"],
  )
})

test("disallowedToolFlags dedupes and preserves order across combined defs", () => {
  // A real config typically has several proxies at once.
  const out = disallowedToolFlags([
    proxyDef("bash"),
    proxyDef("edit"),
    proxyDef("write"),
    proxyDef("task"),
    proxyDef("question"),
  ])
  assert.deepEqual(out, [
    "Bash",
    "Edit",
    "MultiEdit",
    "Write",
    "Agent",
    "AskUserQuestion",
  ])
})

test("disallowedToolFlags ignores proxy tools with no Claude equivalent", () => {
  // MCP-bridged proxy tools (server-derived names) have no entry in the
  // nameMap and must be skipped, not crash.
  assert.deepEqual(
    disallowedToolFlags([proxyDef("slack_post_message")]),
    [],
  )
  assert.deepEqual(
    disallowedToolFlags([proxyDef("bash"), proxyDef("slack_post_message")]),
    ["Bash"],
  )
})

// Issue #26: proxyTools is an allowlist by omission. A built-in the plugin
// has no proxy for (NotebookEdit today, whatever ships next) can only be
// closed by naming it directly.
test("resolveDisallowedTools merges proxy-implied and operator-named tools", () => {
  assert.deepEqual(
    resolveDisallowedTools({
      proxyTools: [proxyDef("bash"), proxyDef("edit")],
      extraDisallowedTools: ["NotebookEdit"],
    }),
    ["Bash", "Edit", "MultiEdit", "NotebookEdit"],
  )
})

test("resolveDisallowedTools works with no proxy tools at all", () => {
  assert.deepEqual(
    resolveDisallowedTools({
      proxyTools: null,
      extraDisallowedTools: ["NotebookEdit", "Skill"],
    }),
    ["NotebookEdit", "Skill"],
  )
})

test("resolveDisallowedTools does not repeat a tool the proxy already disabled", () => {
  assert.deepEqual(
    resolveDisallowedTools({
      proxyTools: [proxyDef("bash")],
      extraDisallowedTools: ["Bash", " ", "Bash"],
    }),
    ["Bash"],
  )
})

test("resolveDisallowedTools still appends WebSearch when it is disabled", () => {
  assert.deepEqual(
    resolveDisallowedTools({
      proxyTools: [proxyDef("bash")],
      extraDisallowedTools: ["NotebookEdit"],
      disableWebSearch: true,
    }),
    ["Bash", "NotebookEdit", "WebSearch"],
  )
})

test("resolveDisallowedTools is empty when nothing asks for anything", () => {
  assert.deepEqual(resolveDisallowedTools({}), [])
})
