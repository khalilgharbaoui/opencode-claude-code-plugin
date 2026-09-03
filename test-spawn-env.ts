import assert from "node:assert/strict"
import { test } from "node:test"
import { claudeSpawnEnv, cliEffortLevel } from "./src/session-manager.js"

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
    assert.equal(env.PATH, process.env.PATH)
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
