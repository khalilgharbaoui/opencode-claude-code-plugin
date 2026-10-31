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

For a local checkout, point opencode 2 at the **`dist` directory**, not the repository root. It loads `<dir>/server` or `<dir>/index` from a directory and never reads `package.json#main`:

```json
{
  "plugins": ["/absolute/path/to/opencode-claude-code-plugin/dist"]
}
```

Last checked on opencode **2.1.3** (2026-10-23): a chat turn, a proxied `shell` call, one of Claude's own tools, a session opened in a subdirectory of a project, and a second prompt reusing the same `claude` process. First verified live on opencode **2.0.11** with Claude Code 2.1.280: chat turns, proxied tools running through opencode 2's own `shell`, `edit`, `write`, `webfetch` and `subagent` tools and their permission rules, Claude's own tools rendered in the transcript, subagent dispatch with the agent list, reasoning variants, compaction, account providers, `/claude-code-doctor`, `/btw`, and the bundled configuration skill.

opencode 2 gives a plugin no way to ask whether a session is busy and no toast of its own, so the plugin reads opencode 2's event stream for the first and uses the channel opencode 2 gives a plugin between its two halves for the second. With those, these work as they do on 1.x (measured on 2.0.22 and 2.0.31):

- **`/btw` is answered inside the running turn.** opencode 2 runs the command the moment you type it, so the aside goes to Claude at once and the answer lands in the reply you are watching. Only when the turn has nothing open to write into does a `/btw` message follow, queued, once the turn ends. See [`/btw`](guides/btw.md).
- **A permission prompt does not count against a proxied call's deadline.** While opencode is still running the turn, because it is waiting on you or the tool is still working, a proxied call that passes its deadline is kept.
- **Stopping a turn releases the proxied calls it was waiting on**, and interrupts Claude's own turn, instead of leaving them until your next message.
- **The plugin's warnings appear as toasts** titled `claude-code`, raised by the sidebar half. See [Logging](configuration/logging.md).

Differences from 1.x:

- **A subagent can be given its own model in the conversation.** opencode 2's `subagent` tool takes a `model`, so "run the reviewer on Sonnet" reaches it, and the plugin keeps that choice over an agent's `forceModel`, its `reasoningEffort` (for a named variant) and the dispatch form. opencode 1's `task` tool has no such field. See [A model you name in the conversation](configuration/subagents.md#a-model-you-name-in-the-conversation-opencode-2).
- **No todo panel.** opencode 2 has no `todowrite` tool, so Claude's task list is not mirrored into one, and the sidebar's progress bar is always the time estimate, never a share of todos done.
- **`bridgeMcpOauthTokens` finds nothing.** opencode 2 keeps MCP OAuth tokens in its database, and the plugin API can activate a stored credential but not read one, so a server you signed into through opencode still reports `needs-auth` to the Claude CLI. See [MCP bridge](configuration/mcp.md).
- **Claude's `EnterPlanMode`, `ExitPlanMode` and `NotebookEdit` calls get no tool row.** opencode 2 has no tools of those names and rejects an unknown one, so the plugin leaves the row out. The call itself still runs.
- **Forms are opencode 2's own `Form` surface** rather than a question tool, which changes nothing you do: pick an option as usual. The account-switch form and the plan-mode approval were measured live on 2.0.22 (2026-10-07), and the [subagent dispatch form](configuration/subagents.md#choosing-per-dispatch-not-per-file) on 2026-10-08.
- **An account switch, by hand or through the form, carries the conversation** on opencode 2 exactly as on 1.x, and [`accountGroups`](configuration/accounts.md#account-groups) blocks it exactly as on 1.x. Both measured live on 2.0.22 (2026-10-08).
- **A session opened below the project root spawns `claude` in that directory.** Before 0.55.0 the plugin appended opencode 2's project-relative `subpath` to the session's own directory and spawned in a path that does not exist, so every turn of such a session failed with `ENOENT ... posix_spawn` while a session at the root worked (issue #113). A `cwd` set only to work around that can go.
