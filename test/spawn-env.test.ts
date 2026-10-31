import "./isolate.js"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import {
  claudeSpawnEnv,
  cliEffortLevel,
  killAllActiveProcesses,
  todoToolsEnv,
} from "../src/session-manager.js"
import { createClaudeCode } from "../src/index.js"
import {
  CLI_HYGIENE_ENV_VARS,
  cliHygieneEnv,
  effectiveSpawnMcpTimeoutMs,
  SPAWN_MCP_TIMEOUT_MS,
  spawnMcpTimeoutEnv,
} from "../src/cli-version.js"
import { interactiveSpawnEnv } from "../src/claude-session-bun.js"

/** Every hygiene var absent, which is the ordinary case for a user shell. */
const noHygieneVars = Object.fromEntries(
  CLI_HYGIENE_ENV_VARS.map((name) => [name, undefined]),
) as Record<string, string | undefined>

function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T,
): T {
  const previous: Record<string, string | undefined> = {}
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key]
    if (vars[key] === undefined) delete process.env[key]
    else process.env[key] = vars[key]
  }
  try {
    return fn()
  } finally {
    for (const key of Object.keys(vars)) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

test("claudeSpawnEnv passes ANTHROPIC_API_KEY through by default", () => {
  withEnv(
    { ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_AUTH_TOKEN: "tok-test" },
    () => {
      const env = claudeSpawnEnv()
      assert.equal(env.ANTHROPIC_API_KEY, "sk-test")
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, "tok-test")
    },
  )
})

test("claudeSpawnEnv strips API key/token when ignoreAnthropicApiKey is true", () => {
  withEnv(
    { ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_AUTH_TOKEN: "tok-test" },
    () => {
      const env = claudeSpawnEnv({ ignoreAnthropicApiKey: true })
      assert.equal("ANTHROPIC_API_KEY" in env, false)
      assert.equal("ANTHROPIC_AUTH_TOKEN" in env, false)
    },
  )
})

test("claudeSpawnEnv with ignore flag leaves other env vars intact", () => {
  withEnv({ ANTHROPIC_API_KEY: "sk-test", PATH: process.env.PATH }, () => {
    const env = claudeSpawnEnv({ ignoreAnthropicApiKey: true })
    assert.equal("ANTHROPIC_API_KEY" in env, false)
    // Windows spells it `Path`, and a spread of process.env keeps that casing.
    assert.equal(env.PATH ?? env.Path, process.env.PATH)
    assert.equal(env.TERM, "xterm-256color")
  })
})

test("claudeSpawnEnv exports a requested effort as CLAUDE_CODE_EFFORT_LEVEL", () => {
  withEnv({ CLAUDE_CODE_EFFORT_LEVEL: undefined }, () => {
    assert.equal(claudeSpawnEnv({ effort: "xhigh" }).CLAUDE_CODE_EFFORT_LEVEL, "xhigh")
    assert.equal(claudeSpawnEnv({ effort: "max" }).CLAUDE_CODE_EFFORT_LEVEL, "max")
    assert.equal("CLAUDE_CODE_EFFORT_LEVEL" in claudeSpawnEnv(), false)
  })
})

test("claudeSpawnEnv maps the provider's minimal onto the CLI's low", () => {
  withEnv({ CLAUDE_CODE_EFFORT_LEVEL: undefined }, () => {
    assert.equal(cliEffortLevel("minimal"), "low")
    assert.equal(claudeSpawnEnv({ effort: "minimal" }).CLAUDE_CODE_EFFORT_LEVEL, "low")
  })
})

test("a requested effort wins over a shell-level CLAUDE_CODE_EFFORT_LEVEL", () => {
  withEnv({ CLAUDE_CODE_EFFORT_LEVEL: "low" }, () => {
    assert.equal(claudeSpawnEnv({ effort: "max" }).CLAUDE_CODE_EFFORT_LEVEL, "max")
    // No request-level effort: the shell value passes through untouched.
    assert.equal(claudeSpawnEnv().CLAUDE_CODE_EFFORT_LEVEL, "low")
  })
})

// Prompt cache TTL. CLAUDE_CODE_PROMPT_CACHE_TTL is the CLI's MAIN-conversation
// setting, and that is the one this plugin needs: a `claude --print` spawn is a
// main conversation even when it is serving an opencode subagent. Measured on
// 2.1.280 by reading `usage.cache_creation` back off a real turn: the main var
// moved the writes to `ephemeral_5m_input_tokens`, while the sibling
// CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL left them at 1h.

test("claudeSpawnEnv exports a requested TTL as CLAUDE_CODE_PROMPT_CACHE_TTL", () => {
  withEnv({ CLAUDE_CODE_PROMPT_CACHE_TTL: undefined }, () => {
    assert.equal(
      claudeSpawnEnv({ promptCacheTtl: "5m" }).CLAUDE_CODE_PROMPT_CACHE_TTL,
      "5m",
    )
    assert.equal(
      claudeSpawnEnv({ promptCacheTtl: "1h" }).CLAUDE_CODE_PROMPT_CACHE_TTL,
      "1h",
    )
    // Nothing requested: the var is absent and the CLI's own default stands.
    assert.equal("CLAUDE_CODE_PROMPT_CACHE_TTL" in claudeSpawnEnv(), false)
  })
})

test("a requested TTL wins over a shell-level CLAUDE_CODE_PROMPT_CACHE_TTL", () => {
  withEnv({ CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" }, () => {
    // An agent's declaration is a per-request choice; a shell export is not.
    assert.equal(
      claudeSpawnEnv({ promptCacheTtl: "5m" }).CLAUDE_CODE_PROMPT_CACHE_TTL,
      "5m",
    )
    assert.equal(claudeSpawnEnv().CLAUDE_CODE_PROMPT_CACHE_TTL, "1h")
  })
})

test("the subagent-only cache TTL var is never written", () => {
  // It exists on the CLI and does nothing for us, because none of our spawns
  // is a CLI subagent. Writing it would only look like it worked.
  withEnv({ CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: undefined }, () => {
    assert.equal(
      "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL" in
        claudeSpawnEnv({ promptCacheTtl: "5m" }),
      false,
    )
  })
})

// CLI hygiene. Both names were verified against the Claude Code 2.1.263 bundle;
// the point is to stop the CLI autoupdating out from under the version
// `detectCliVersion` cached, which several flag gates are keyed on.

test("the hygiene list is the two vars verified against the CLI bundle", () => {
  assert.deepEqual(
    [...CLI_HYGIENE_ENV_VARS],
    ["DISABLE_AUTOUPDATER", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"],
  )
})

test("claudeSpawnEnv disables the autoupdater and non-essential traffic", () => {
  withEnv(noHygieneVars, () => {
    const env = claudeSpawnEnv()
    assert.equal(env.DISABLE_AUTOUPDATER, "1")
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1")
  })
})

test("claudeSpawnEnv never overrides a hygiene var the user set", () => {
  withEnv(
    {
      DISABLE_AUTOUPDATER: "0",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "",
    },
    () => {
      const env = claudeSpawnEnv()
      // "0" is how the CLI is told to keep autoupdating; we must not stomp it.
      assert.equal(env.DISABLE_AUTOUPDATER, "0")
      // An empty string reads as off to the CLI, so it is a real choice too.
      assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "")
    },
  )
})

test("claudeSpawnEnv gives MCP servers 120 s to start, not the CLI's 30 s (h #g235)", () => {
  withEnv({ MCP_TIMEOUT: undefined }, () => {
    assert.equal(SPAWN_MCP_TIMEOUT_MS, 120_000)
    assert.equal(claudeSpawnEnv().MCP_TIMEOUT, "120000")
    // The interactive transport's own env builder applies it too.
    assert.equal(interactiveSpawnEnv({}).MCP_TIMEOUT, "120000")
  })
})

test("an MCP_TIMEOUT the user set is kept on both transports, empty included", () => {
  for (const value of ["45000", ""]) {
    withEnv({ MCP_TIMEOUT: value }, () => {
      assert.equal(claudeSpawnEnv().MCP_TIMEOUT, value)
      assert.equal(interactiveSpawnEnv({}).MCP_TIMEOUT, value)
    })
  }
  assert.deepEqual(spawnMcpTimeoutEnv({ MCP_TIMEOUT: "1" }), {})
})

test("the MCP timeout a child runs with is read the way Claude Code reads it (h #g256)", () => {
  assert.equal(effectiveSpawnMcpTimeoutMs({}), 120_000, "the plugin's fill")
  assert.equal(effectiveSpawnMcpTimeoutMs({ MCP_TIMEOUT: "300000" }), 300_000, "the user's own value")
  // Anything that is not a positive number is the CLI's own 30 s default.
  for (const value of ["", "0", "-5", "soon"]) {
    assert.equal(effectiveSpawnMcpTimeoutMs({ MCP_TIMEOUT: value }), 30_000, JSON.stringify(value))
  }
  assert.equal(effectiveSpawnMcpTimeoutMs({ MCP_TIMEOUT: "99999999999" }), 2_147_483_647, "capped like a timer")
})

test("cliHygieneEnv fills only the vars missing from the inherited env", () => {
  assert.deepEqual(cliHygieneEnv({}), {
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  })
  assert.deepEqual(cliHygieneEnv({ DISABLE_AUTOUPDATER: "0" }), {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  })
  assert.deepEqual(
    cliHygieneEnv({
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    }),
    {},
  )
})

test("the interactive transport gets the same hygiene as the headless spawn", () => {
  withEnv(noHygieneVars, () => {
    const env = interactiveSpawnEnv({ configDir: "/tmp/cfg" })
    for (const name of CLI_HYGIENE_ENV_VARS) {
      assert.equal(env[name], "1", `interactive spawn is missing ${name}`)
    }
    // The env it already built is untouched.
    assert.equal(env.CLAUDE_CONFIG_DIR, "/tmp/cfg")
    assert.equal(env.TERM, "xterm-256color")
  })
})

test("the interactive transport also respects a hygiene var the user set", () => {
  withEnv({ DISABLE_AUTOUPDATER: "0" }, () => {
    const env = interactiveSpawnEnv({ configDir: "/tmp/cfg" })
    assert.equal(env.DISABLE_AUTOUPDATER, "0")
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1")
  })
})

test("enableTodoTools turns the CLI's todo tools on, filling a gap only (h #g260)", () => {
  withEnv({ CLAUDE_CODE_ENABLE_TODO_TOOLS: undefined }, () => {
    assert.deepEqual(todoToolsEnv(true), { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" })
    assert.equal(claudeSpawnEnv({ enableTodoTools: true }).CLAUDE_CODE_ENABLE_TODO_TOOLS, "1")
    // Off, which is the default: the variable is absent and the CLI's own
    // per-model choice stands.
    assert.deepEqual(todoToolsEnv(false), {})
    assert.equal("CLAUDE_CODE_ENABLE_TODO_TOOLS" in claudeSpawnEnv(), false)
    assert.equal("CLAUDE_CODE_ENABLE_TODO_TOOLS" in claudeSpawnEnv({ enableTodoTools: false }), false)
  })
  // A value already in opencode's environment is the operator's, `0` included.
  for (const value of ["0", "1", ""]) {
    withEnv({ CLAUDE_CODE_ENABLE_TODO_TOOLS: value }, () => {
      assert.deepEqual(todoToolsEnv(true), {})
      assert.equal(claudeSpawnEnv({ enableTodoTools: true }).CLAUDE_CODE_ENABLE_TODO_TOOLS, value)
    })
  }
})

// The fake CLI is a shebang script made executable by its file mode, which
// means nothing on Windows (.github/windows-skipped-tests.txt).
const POSIX_ONLY = process.platform === "win32" ? "the fake-CLI harness is POSIX-only" : false

test("enableTodoTools reaches a real spawn, and never a compaction spawn (h #g260)", { skip: POSIX_ONLY, timeout: 30_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-todo-tools-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  writeFileSync(cliPath, `#!/usr/bin/env node
const readline = require("node:readline")
if (process.argv.includes("--version")) {
  console.log("2.1.293")
  process.exit(0)
}
const emit = (message) => console.log(JSON.stringify(message))
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const envelope = JSON.parse(line)
  if (envelope.type !== "user") return
  emit({ type: "assistant", session_id: String(process.pid), message: {
    role: "assistant", stop_reason: "end_turn",
    content: [{ type: "text", text: "todo=" + (process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS ?? "unset") }],
  } })
  emit({ type: "result", subtype: "success", session_id: String(process.pid),
    is_error: false, usage: { input_tokens: 1, output_tokens: 1 } })
})
`, { mode: 0o755 })

  const answer = async (enableTodoTools: boolean | undefined, session: string, agent = "build") => {
    const provider = createClaudeCode({
      cwd, cliPath, bridgeOpencodeMcp: false, proxyOpencodeMcpTools: false,
      proxyTools: [], interactive: false, autoContinueIncompleteTurns: false,
      ...(enableTodoTools === undefined ? {} : { enableTodoTools }),
    })
    const options: LanguageModelV3CallOptions = {
      tools: [{ type: "function", name: "read", inputSchema: { type: "object" } }],
      providerOptions: { "claude-code": { opencodeSessionID: session, opencodeAgent: agent } },
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }
    const { stream } = await provider.languageModel("claude-haiku-4-5").doStream(options)
    let text = ""
    for await (const part of stream) {
      if (part.type === "error") throw part.error
      if (part.type === "text-delta") text += part.delta
    }
    return text
  }

  try {
    await withEnvAsync({ CLAUDE_CODE_ENABLE_TODO_TOOLS: undefined }, async () => {
      assert.equal(await answer(true, "todo-on"), "todo=1")
      assert.equal(await answer(undefined, "todo-default"), "todo=unset")
      assert.equal(await answer(false, "todo-off"), "todo=unset")
      // A compaction spawn runs no tools, so it never asks for them.
      assert.match(await answer(true, "todo-compaction", "compaction"), /todo=unset/)
    })
    // The operator's own value decides, even with the option on.
    await withEnvAsync({ CLAUDE_CODE_ENABLE_TODO_TOOLS: "0" }, async () => {
      assert.equal(await answer(true, "todo-shell"), "todo=0")
    })
  } finally {
    killAllActiveProcesses()
    rmSync(cwd, { recursive: true, force: true })
  }
})

async function withEnvAsync(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous: Record<string, string | undefined> = {}
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key]
    if (vars[key] === undefined) delete process.env[key]
    else process.env[key] = vars[key]
  }
  try {
    await fn()
  } finally {
    for (const key of Object.keys(vars)) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}
