---
title: 'opencode 2'
description: 'The same package on opencode 2.x: config spellings, a local checkout, and what differs from 1.x.'
sidebar:
  order: 3
---

The same package runs on opencode 1.x and 2.x, and nothing changes for 1.x. The same config works too: opencode 2's native key is `plugins`, but it still reads the 1.x `plugin` key shown above, so an existing install needs no edit. A config used only by opencode 2 can spell it natively:

```json
{
  "plugins": ["@khalilgharbaoui/opencode-claude-code-plugin"]
}
```

`opencode plugin add @khalilgharbaoui/opencode-claude-code-plugin` writes that entry and installs the package for you. With no `accounts` the provider is named **Claude Code**, id `claude-code`, so a model's full id is `claude-code/claude-haiku-5-5`. On opencode 2.1.4, `opencode plugin list` prints `No plugins found` even while the plugin is loaded, and `opencode plugin check` and `opencode plugin update` do not see it; `/claude-code-doctor` or `opencode models | grep claude-code` is the check, and the package cache to clear after a release is `~/.cache/opencode/npm/@khalilgharbaoui/opencode-claude-code-plugin@latest` (see [Longer cases](troubleshooting/longer-cases.md#nothing-in-the-picker-or-a-version-you-just-upgraded-to-is-missing)).

Your existing `provider.claude-code.options` block keeps working, because opencode 2 still reads 1.x config files. opencode 2's own spelling is `providers.claude-code.settings` (note the plural `providers`). All four places the plugin reads its settings from, lowest precedence first: `provider.claude-code.options`, `provider.claude-code.settings`, `providers.claude-code.settings`, and the plugin entry's own `options`, which wins over all of them. Plugin-level settings such as `accounts` usually go in that last one: `{"package": "@khalilgharbaoui/opencode-claude-code-plugin", "options": {"accounts": ["work"]}}`.

**One setting must not go in the provider block on opencode 2: `transport`.** opencode 2 has a provider setting of that name for itself (`http` or `websocket`), so `provider.claude-code.options.transport` set to `"interactive"`, `"auto"` or `"headless"` stops opencode from loading its config (every command fails with `UnexpectedStatus: 500`, measured on 2.1.4, 2.2.0 and 2.2.5), and under `providers.claude-code.settings` opencode drops the whole block as malformed. Put `transport` in the plugin entry's own `options`, or use `"interactive": true` or `CLAUDE_CODE_INTERACTIVE_TRANSPORT=1`. See [Interactive transport](guides/interactive-transport.md).

For a local checkout, point opencode 2 at the **`dist` directory**, not the repository root. It loads `<dir>/server` or `<dir>/index` from a directory and never reads `package.json#main`:

```json
{
  "plugins": ["/absolute/path/to/opencode-claude-code-plugin/dist"]
}
```

Last checked on opencode **2.2.5** (2026-11-04) with Claude Code 2.1.314: on the default transport a chat turn, a proxied `shell` call with one of Claude's own tools, a second prompt reusing the same `claude` process, `/compact`, `/claude-code-doctor` and `/btw` during a running turn; on the [interactive transport](guides/interactive-transport.md) the same plus images, a 130-second proxied call and the plan-mode approval. `/connect` and the retry opt-out were measured on 2.2.5 on 2026-10-31. On opencode **2.1.3** (2026-10-23): a session opened in a subdirectory of a project. First verified live on opencode **2.0.11** with Claude Code 2.1.280: chat turns, proxied tools running through opencode 2's own `shell`, `edit`, `write`, `webfetch` and `subagent` tools and their permission rules, Claude's own tools rendered in the transcript, subagent dispatch with the agent list, reasoning variants, compaction, account providers, `/claude-code-doctor`, `/btw`, and the bundled configuration skill.

opencode 2 gives a plugin no way to ask whether a session is busy and no toast of its own, so the plugin reads opencode 2's event stream for the first and uses the channel opencode 2 gives a plugin between its two halves for the second. With those, these work as they do on 1.x (measured on 2.0.22 and 2.0.31):

- **`/btw` is answered inside the running turn.** opencode 2 runs the command the moment you type it, so the aside goes to Claude at once and the answer lands in the reply you are watching. Only when the turn has nothing open to write into does a `/btw` message follow, queued, once the turn ends. See [`/btw`](guides/btw.md).
- **A permission prompt does not count against a proxied call's deadline.** While opencode is still running the turn, because it is waiting on you or the tool is still working, a proxied call that passes its deadline is kept.
- **Stopping a turn releases the proxied calls it was waiting on**, and interrupts Claude's own turn, instead of leaving them until your next message.
- **The plugin's warnings appear as toasts** titled `claude-code`, raised by the sidebar half. See [Logging](configuration/logging.md).

opencode 2.2.3 and later ship their own **Claude Agent** provider (id `claude-agent`). It and this plugin share no provider id, model id, setting or `/connect` entry, and both can be used in one opencode (measured on 2.2.5). Moving a chat from one to the other replays the conversation to the new one as text, because neither can continue the other's Claude session.

To hide Claude Agent, use opencode's own settings; this plugin has no option for it, because it is opencode's provider. Two rules in your opencode config do it:

```json
{
  "disabled_providers": ["claude-agent"],
  "policies": [
    { "action": "integration.connect", "resource": "claude-agent", "effect": "deny" }
  ]
}
```

The `policies` rule is what removes **Claude Agent** from `/connect`; `disabled_providers` alone leaves it there, and keeps it out of the model list (it is the same as a `provider.use` deny). A Claude Agent connection you already made stays listed in `/connect`, so you can still delete it. Measured on opencode 2.2.6: with both rules the integrations list no longer had `claude-agent`, and every other entry stayed.

opencode 2 also has four things 1.x has no counterpart for:

- **`/connect` checks the Claude Code login.** Each provider (**Claude Code**, or one per account) is listed under its own name with one method, *Claude Code login*. Connecting stores nothing, not even a token: the plugin runs `claude auth status` the way a turn would run `claude`, and a toast says how Claude Code is logged in (a Claude subscription, an API key, Amazon Bedrock, Google Vertex AI, ...) or gives the one command that fixes it, `claude auth login`, or `CLAUDE_CONFIG_DIR=~/.claude-work claude auth login` for an account named `work`. A missing or logged-out CLI also marks the connection *Sign in required*; log in in a terminal, then connect again. Connecting is optional, the models work without it, and every connect adds one entry to that provider's list of connections, which you can delete from the same dialog. A connection made earlier is checked again when opencode starts.
- **A failed turn is not retried.** opencode 2 runs a turn that failed again, up to ten more times. For this provider each retry started a new `claude`, resumed the conversation and sent your message again: one CLI killed mid-turn cost eleven API requests and left the message in the conversation twelve times. The plugin declines those retries, so the error shows once and you resend when you are ready. The Claude CLI already retries API errors (overloaded, server errors, rate limits) itself, and a usage limit was never retried.
- **One-shot generate calls can skip the turn.** opencode 2's `experimental.generate.text` sends one prompt with no session and no agent; OpenChamber uses it for its AI session rename, walkthroughs and dictation clean-up. By default the plugin runs it as a full turn, tools and `CLAUDE.md` included, where the model tends to answer the material instead of doing the job. With [`leanGenerate`](configuration/options.md) on it gets one lean `claude -p` instead, and any failure falls back to the full turn.
- **Session warming and `/goal` stay out of the conversation.** opencode 2's `session.generate` asks a question about a session and never stores it: session warming (`warming` in opencode's config, off by default) sends a keep-alive every 4 minutes for 30 minutes after a session's last request, and `/goal` asks whether the goal is met each time the session goes idle. The plugin answers both with Claude Code's side question, the mechanism behind [`/btw`](guides/btw.md), on the conversation's running `claude`: the question and its answer never enter the Claude conversation, nothing respawns, and the conversation's prompt cache is read, which is what keeps it warm (measured on 2.2.6 with Claude Code 2.1.322: with a five-minute cache, a turn eight minutes after the last one read the whole conversation from the cache after a ping at four minutes, and 11,287 of 28,580 tokens without one). Served as a turn, each ping used to land in the conversation, and your next message carried a *conversation rewound* note for an edit nobody made. With no running `claude` for that conversation (after a restart, or once [`idleProcessTimeoutMs`](configuration/options.md) ended it) the request is refused and opencode logs that it could not warm the session; your next message resumes the conversation as usual. On a Claude subscription Claude Code writes one-hour cache entries, so during a session's first idle hour a ping changes nothing your next message reads, and each ping still counts toward your usage. `{ "interval": "55 minutes", "duration": "3 hours" }` keeps a one-hour cache warm with one ping an hour.

Differences from 1.x:

- **A subagent can be given its own model in the conversation.** opencode 2's `subagent` tool takes a `model`, so "run the reviewer on Sonnet" reaches it, and the plugin keeps that choice over an agent's `forceModel`, its `reasoningEffort` (for a named variant) and the dispatch form. opencode 1's `task` tool has no such field. See [A model you name in the conversation](configuration/subagents.md#a-model-you-name-in-the-conversation-opencode-2).
- **No todo panel.** opencode 2 has no `todowrite` tool, so Claude's task list is not mirrored into one, and the sidebar's progress bar is always the time estimate, never a share of todos done.
- **`bridgeMcpOauthTokens` finds nothing.** opencode 2 keeps MCP OAuth tokens in its database, and the plugin API can activate a stored credential but not read one, so a server you signed into through opencode still reports `needs-auth` to the Claude CLI. See [MCP bridge](configuration/mcp.md).
- **Claude's `EnterPlanMode`, `ExitPlanMode` and `NotebookEdit` calls get no tool row.** opencode 2 has no tools of those names and rejects an unknown one, so the plugin leaves the row out. The call itself still runs.
- **Forms are opencode 2's own `Form` surface** rather than a question tool, which changes nothing you do: pick an option as usual. The account-switch form and the plan-mode approval were measured live on 2.0.22 (2026-10-07), and the [subagent dispatch form](configuration/subagents.md#choosing-per-dispatch-not-per-file) on 2026-10-08.
- **An account switch, by hand or through the form, carries the conversation** on opencode 2 exactly as on 1.x, and [`accountGroups`](configuration/accounts.md#account-groups) blocks it exactly as on 1.x. Both measured live on 2.0.22 (2026-10-08).
- **A session opened below the project root spawns `claude` in that directory.** Before 0.55.0 the plugin appended opencode 2's project-relative `subpath` to the session's own directory and spawned in a path that does not exist, so every turn of such a session failed with `ENOENT ... posix_spawn` while a session at the root worked (issue #113). A `cwd` set only to work around that can go.
