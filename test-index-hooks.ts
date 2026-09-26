// The two hooks the plugin hangs off opencode's V1 plugin API, driven through
// the real `server()` factory rather than by calling their bodies directly.
// `chat.params` is where the agent name reaches the language model, and the
// shape it writes is easy to get subtly wrong: opencode nests the whole
// options bag under the provider id afterwards.

import assert from "node:assert/strict"
import { test } from "node:test"

// Set before anything calls `server()`: the factory runs the stale-install
// cleanup, which deletes from the real opencode plugin cache.
process.env.OPENCODE_CLAUDE_CODE_PLUGIN_NO_CLEANUP = "1"

import { BtwHandledError } from "./src/btw-command.js"
import plugin, {
  registerDoctorCommand,
  registerSideQuestionCommand,
} from "./src/index.js"
import type { OpenCodeConfig } from "./src/opencode-types.js"
import {
  getOpencodeClient,
  getOpencodeProjectDirectory,
} from "./src/runtime-status.js"
import { SIDE_QUESTION_USAGE } from "./src/side-question.js"

type Hooks = Awaited<ReturnType<typeof plugin.server>>

interface ToastRecord {
  title?: string
  message?: string
  variant?: string
}

function fakeClient(toasts: ToastRecord[] = []) {
  return {
    toasts,
    tui: {
      showToast: async (options: { body: ToastRecord }) => {
        toasts.push(options.body)
        return {}
      },
    },
    session: {
      status: async () => ({ data: {} }),
    },
  }
}

async function buildHooks(
  input: Record<string, unknown> = {},
): Promise<Hooks> {
  return await plugin.server({
    client: fakeClient(),
    directory: "/tmp/opencode-hooks-project",
    ...input,
  })
}

async function chatParams(
  hooks: Hooks,
  input: Record<string, unknown>,
  output: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  await hooks["chat.params"]!(input as never, output as never)
  return output
}

// ---------------------------------------------------------------------------
// server()
// ---------------------------------------------------------------------------

test("server() captures the SDK client and opencode's project directory", async () => {
  const client = fakeClient()
  await plugin.server({
    client,
    directory: "/Users/jan/projects/app",
    worktree: "/Users/jan/projects",
  })

  assert.equal(getOpencodeClient(), client)
  assert.equal(getOpencodeProjectDirectory(), "/Users/jan/projects/app")
})

test("server() falls back to worktree, then to nothing, for the directory", async () => {
  await plugin.server({ client: fakeClient(), directory: "/", worktree: "/Users/jan/wt" })
  assert.equal(getOpencodeProjectDirectory(), "/Users/jan/wt")

  // Neither usable: the captured fallback must stay empty rather than pin the
  // spawn to "/".
  await plugin.server({ client: fakeClient(), directory: "/", worktree: "/" })
  assert.equal(getOpencodeProjectDirectory(), undefined)
})

test("server() exposes the hooks opencode 1.x looks for", async () => {
  const hooks = await buildHooks()
  assert.equal(typeof hooks["chat.params"], "function")
  assert.equal(typeof hooks["command.execute.before"], "function")
  assert.equal(typeof hooks.config, "function")
  assert.equal(typeof hooks.event, "function")
  assert.equal(hooks.provider?.id, "claude-code")
})

// ---------------------------------------------------------------------------
// chat.params
// ---------------------------------------------------------------------------

test("chat.params writes opencodeAgent at the TOP LEVEL of output.options", async () => {
  const hooks = await buildHooks()
  const output = await chatParams(hooks, {
    agent: "build",
    sessionID: "ses_1",
    model: { providerID: "claude-code" },
  })

  assert.deepEqual(output, {
    options: { opencodeSessionID: "ses_1", opencodeAgent: "build" },
  })
  // opencode wraps the whole bag as `{ [providerID]: options }` before the
  // language model sees it, so a pre-nested copy would arrive as
  // providerOptions["claude-code"]["claude-code"].opencodeAgent.
  assert.equal(
    (output.options as Record<string, unknown>)["claude-code"],
    undefined,
  )
})

test("chat.params reads the provider id from either shape opencode sends", async () => {
  const hooks = await buildHooks()

  const fromModel = await chatParams(hooks, {
    agent: "plan",
    model: { providerID: "claude-code" },
  })
  assert.equal((fromModel.options as Record<string, unknown>).opencodeAgent, "plan")

  const fromProvider = await chatParams(hooks, {
    agent: "plan",
    provider: { info: { id: "claude-code" } },
  })
  assert.equal((fromProvider.options as Record<string, unknown>).opencodeAgent, "plan")
})

test("chat.params accepts an account-expanded provider id", async () => {
  const hooks = await buildHooks()
  const output = await chatParams(hooks, {
    agent: "compaction",
    sessionID: "ses_9",
    model: { providerID: "claude-code-appical" },
  })

  assert.deepEqual(output.options, {
    opencodeSessionID: "ses_9",
    opencodeAgent: "compaction",
  })
})

test("chat.params ignores providers that merely look like ours", async () => {
  const hooks = await buildHooks()

  for (const providerID of [
    "anthropic",
    "opencode",
    // Prefix without the separator: a different provider, not an account.
    "claude-codex",
    undefined,
    42,
  ]) {
    const output = await chatParams(hooks, {
      agent: "build",
      sessionID: "ses_1",
      model: { providerID },
    })
    assert.deepEqual(output, {}, `${String(providerID)} must be left alone`)
  }
})

test("chat.params injects the session id even when there is no agent", async () => {
  const hooks = await buildHooks()
  // Older opencode and a few provider-switch paths send no agent; session
  // isolation still has to work, so the id is written before that guard.
  const output = await chatParams(hooks, {
    sessionID: "ses_42",
    model: { providerID: "claude-code" },
  })

  assert.deepEqual(output, { options: { opencodeSessionID: "ses_42" } })
})

test("chat.params writes no session id when opencode sends none", async () => {
  const hooks = await buildHooks()

  assert.deepEqual(
    await chatParams(hooks, { agent: "build", model: { providerID: "claude-code" } }),
    { options: { opencodeAgent: "build" } },
  )
  assert.deepEqual(
    await chatParams(hooks, {
      agent: "build",
      sessionID: "",
      model: { providerID: "claude-code" },
    }),
    { options: { opencodeAgent: "build" } },
  )
})

test("chat.params preserves options another plugin already wrote", async () => {
  const hooks = await buildHooks()
  const output = await chatParams(
    hooks,
    { agent: "build", sessionID: "ses_1", model: { providerID: "claude-code" } },
    { temperature: 0.2, options: { topP: 0.9 } },
  )

  assert.deepEqual(output, {
    temperature: 0.2,
    options: { topP: 0.9, opencodeSessionID: "ses_1", opencodeAgent: "build" },
  })
})

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

test("/btw and the doctor register only when the user has not", () => {
  const empty: OpenCodeConfig = {}
  assert.equal(registerSideQuestionCommand(empty), true)
  assert.equal(empty.command?.btw?.template, "/btw $ARGUMENTS")
  assert.equal(registerDoctorCommand(empty), true)
  assert.equal(
    empty.command?.["claude-code-doctor"]?.template,
    "/claude-code-doctor $ARGUMENTS",
  )

  const mine: OpenCodeConfig = {
    command: {
      btw: { template: "my own btw" },
      "claude-code-doctor": { template: "my own doctor" },
    },
  }
  assert.equal(registerSideQuestionCommand(mine), false)
  assert.equal(registerDoctorCommand(mine), false)
  assert.equal(mine.command?.btw?.template, "my own btw")
  assert.equal(mine.command?.["claude-code-doctor"]?.template, "my own doctor")
})

// ---------------------------------------------------------------------------
// command.execute.before
//
// Order matters below: the hook only intercepts `btw` once the `config` hook
// has registered OUR `/btw`, and that flag is module state for the process.
// ---------------------------------------------------------------------------

test("a user-defined /btw is left entirely to opencode", async () => {
  const toasts: ToastRecord[] = []
  const client = fakeClient(toasts)
  const hooks = await plugin.server({
    client,
    directory: "/tmp/opencode-hooks-project",
  })

  // The user owns the command, so the config hook declines it and the
  // execute hook must not take it over.
  await hooks.config!({ command: { btw: { template: "my own btw" } } })

  await hooks["command.execute.before"]!(
    { command: "btw", sessionID: "ses_1", arguments: "" },
    { parts: [] },
  )

  assert.deepEqual(toasts, [])
})

test("a command that is not /btw is never intercepted", async () => {
  const toasts: ToastRecord[] = []
  const hooks = await plugin.server({
    client: fakeClient(toasts),
    directory: "/tmp/opencode-hooks-project",
  })

  await hooks.config!({})

  for (const command of ["init", "claude-code-doctor", "btw-later", ""]) {
    await hooks["command.execute.before"]!(
      { command, sessionID: "ses_1", arguments: "anything" },
      { parts: [] },
    )
  }

  assert.deepEqual(toasts, [])
})

test("our own /btw is handled by the plugin, not sent on as a message", async () => {
  const toasts: ToastRecord[] = []
  const hooks = await plugin.server({
    client: fakeClient(toasts),
    directory: "/tmp/opencode-hooks-project",
  })

  // Registered by a previous test in this file; re-running the config hook
  // keeps the flag set.
  await hooks.config!({})

  // A bare `/btw` is the one path that resolves without touching a claude
  // process: it toasts the usage and throws so opencode drops the prompt.
  await assert.rejects(
    () =>
      hooks["command.execute.before"]!(
        { command: "btw", sessionID: "ses_1", arguments: "   " },
        { parts: [] },
      ),
    (err: unknown) => {
      assert.ok(err instanceof BtwHandledError)
      return true
    },
  )

  assert.equal(toasts.length, 1)
  assert.equal(toasts[0]?.title, "btw")
  assert.equal(toasts[0]?.message, SIDE_QUESTION_USAGE)
  assert.equal(toasts[0]?.variant, "warning")
})
