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

Your existing `provider.claude-code.options` block keeps working, because opencode 2 still reads 1.x config files. opencode 2's own spelling is `providers.claude-code.settings` (note the plural `providers`). All four places the plugin reads its settings from, lowest precedence first: `provider.claude-code.options`, `provider.claude-code.settings`, `providers.claude-code.settings`, and the plugin entry's own `options`, which wins over all of them. Plugin-level settings such as `accounts` usually go in that last one: `{"package": "@khalilgharbaoui/opencode-claude-code-plugin", "options": {"accounts": ["work"]}}`.

For a local checkout, point opencode 2 at the **`dist` directory**, not the repository root. It loads `<dir>/server` or `<dir>/index` from a directory and never reads `package.json#main`:

```json
{
  "plugins": ["/absolute/path/to/opencode-claude-code-plugin/dist"]
}
```

Verified live on opencode **2.0.11** with Claude Code 2.1.280: chat turns, proxied tools running through opencode 2's own `shell`, `edit`, `write`, `webfetch` and `subagent` tools and their permission rules, Claude's own tools rendered in the transcript, subagent dispatch with the agent list, reasoning variants, compaction, account providers, `/claude-code-doctor`, `/btw`, and the bundled configuration skill. Differences from 1.x:

- **`/btw` is answered after the running turn**, not inside it. opencode 2's plugin API has no session-status route, which is what 1.x uses to write the answer into a turn that is still running. The aside is queued, so it can never swallow the turn's own continuation.
- **No todo panel.** opencode 2 has no `todowrite` tool, so Claude's task list is not mirrored into one.
- **Forms are opencode 2's own `Form` surface** rather than a question tool, which changes nothing you do: pick an option as usual. The account-switch form and the plan-mode approval were measured live on 2.0.22 (2026-10-07), and the [subagent dispatch form](configuration/subagents.md#choosing-per-dispatch-not-per-file) on 2026-10-08.
- **An account switch, by hand or through the form, carries the conversation** on opencode 2 exactly as on 1.x, and [`accountGroups`](configuration/accounts.md#account-groups) blocks it exactly as on 1.x. Both measured live on 2.0.22 (2026-10-08).
