---
title: '/claude-code-doctor'
description: 'What the plugin currently thinks is happening, and the redacted bundle to attach to a bug report.'
sidebar:
  order: 4
---

```text
/claude-code-doctor
```

Prints, in the chat, what the plugin currently thinks is happening. The plugin answers it itself: no model is called, nothing is billed, and the reply reports 0 tokens. It is the thing to paste into a bug report.

It carries the startup-diagnostics fields (plugin version, opencode version, `claude` path and version, the working directory and which resolution tier picked it, providers, accounts, `proxyTools`, the on-disk MCP servers, the `permissionPreset` in force per provider, the transport asked for and the one this conversation is on, whether an `ANTHROPIC_API_KEY` is present) plus the live runtime state the startup block cannot know:

- every live `claude` child, by opencode session id and model, with its pid, whether a turn is in flight, how long it has been up, and the effort it was spawned at,
- every pending proxy call, with the tool, the call id, how long it has waited, and its deadline,
- each proxy server's URL with one unauthenticated `initialize` posted to it: `401, good` is the patched behaviour, and anything else is flagged unsafe with the fix (restart every opencode window, since a window opened before 0.13.2 keeps serving an open port). See [Proxy endpoint security](../internals/scratch-files-and-security.md#proxy-endpoint-security).

Directly under the plugin version sits a **`plugin build`** row, which is the only field that says whether the version above it is the code answering you. opencode reads a plugin once, at process start, so a window that has been open since before your last upgrade is still running the old build while everything on disk says otherwise. The row re-reads the disk every time you run the command and reads `current`, `on disk <version>. Restart opencode to run it`, `the same version was rebuilt on disk at <time>. Restart opencode to run it` for a `file://` install, or `the build on disk could not be read`, which is not a verdict: a package cache mid-reinstall is unreadable and says nothing about staleness. It names no path. The same comparison writes one `▌ **restart opencode:**` note per conversation into the reply, which is what you normally see first. See [A fix you installed is not taking effect](../troubleshooting/longer-cases.md#a-fix-you-installed-is-not-taking-effect).

When Claude Code refused an entry in an `--mcp-config` it was handed, an **MCP config entries Claude Code skipped** section names each one with the CLI's own category and sentence. That section only appears when there is something in it. It matters because a skipped server is absent from the CLI's server list entirely rather than listed as broken, so the model silently does not have those tools; if the skipped name is `opencode_proxy` the report says so plainly, because then it is the plugin's own server and every proxied tool call in the session fails. The same thing is a warning in your terminal when it happens.

A **Plugins Claude Code did not load** section works the same way for Claude plugins: one the CLI demoted at load time (for example, a dependency that is not installed) is absent from its plugin list, so its skills, commands and MCP servers are silently missing. The skill bridge is such a plugin (`opencode-skills`), and a failure there is reported as the plugin's own bug rather than your config. A plugin warning only counts when its content did not load; advisory feedback about a plugin that did load stays in the log at INFO.

A **Hooks Claude Code ran that failed** section covers your own Claude Code hooks, which are the third thing that fails without leaving a trace. Claude Code runs a `SessionStart` hook on every `claude` it starts for you, and when one exits non-zero it discards the hook's contribution and answers the turn normally: the context that hook was supposed to add is simply missing, on every turn of that session, with nothing on screen. The section names the hook, the event, its exit code and its outcome, and it is a warning in your terminal the first time it happens. Only the hook's **stderr** is shown, capped: a hook's stdout is what Claude Code splices into the model's context, so it has no business in a bug report. These are your hooks in your Claude Code settings, not opencode's, and the plugin never passes `--include-hook-events`, so only the `SessionStart` family is ever reported.

A **Background subagents** section opens with `running now: N (of M started by this process)`, the number of background subagents Claude dispatched through this opencode process that are still working, read with the same test `task_status` uses and without collecting anything. The rest of it is the gate and the collect/cancel ledger; see [Background subagents](background-subagents.md).

```text
/claude-code-doctor usage
```

adds a **Plan usage** section: the CLI's own answer to `/cost`, which is the subscription-or-API-key line, how much of the 5-hour and 7-day windows is used, when each resets, and what has been contributing to them. It is measured free (`num_turns: 0`, `$0`, no API call: the CLI answers it locally), so it costs no tokens and nothing is billed. It is opt-in anyway because reading it starts a short-lived `claude` process, which runs your `SessionStart` hooks and takes a few seconds. Without the argument the section says so and the report stays instant. A CLI that cannot answer leaves one line saying why and the rest of the report is unaffected.

If the CLI definitively lacks headless output, this section reports that usage must be checked in Claude directly. It does not submit `/cost` as an interactive inference prompt. The ordinary report remains available even when `Bun.Terminal` is missing or interactive inference is refused for `plan` or `read-only` permissions. Its transport row is a request, not proof that a child started (`auto` stays headless until the CLI refuses `--print`); each live process row has its own transport column, and that is the one that says which transport is actually running. When the PTY is requested or running, a row names the newest Claude Code the interactive transport was measured on, and flags an installed CLI that is newer.

The `permissionPreset` row reads `provider: preset` for every registered provider, `none` where none is set, so two accounts configured with different postures are not collapsed into one answer. When a preset is in force, a **Permission preset overrides** block under the table lists the options it replaced, in the same words the log uses. A name the plugin does not recognise is reported as `readonly (unknown, nothing applied)` rather than shown as if it took effect: a typo'd safety option runs at full permissions, and the report is where you find that out. See [Read-only mode](../configuration/permissions.md#read-only-mode).

Nothing secret goes in it: not the proxy bearer token, not the value of `ANTHROPIC_API_KEY`, not the system prompt, not a pending call's arguments. A `claude-code-doctor` command you defined yourself is never overwritten. The name has no space in it because opencode reads everything after the first space as the command's arguments. The whole exchange is kept out of any transcript replayed to the CLI, like a `/btw` pair.

## Filing an issue: /claude-code-doctor bundle

```text
/claude-code-doctor bundle
```

**When filing an issue, paste `/claude-code-doctor bundle`.** It returns the report above plus the recent `NOTICE`, `WARN` and `ERROR` lines from this process's plugin log, redacted so the whole thing is safe to put in a public issue. It starts no process and costs no tokens, so unlike `usage` it stays instant.

The point is `plugin.log` itself. It is off by default, and when it is on it has no redaction guarantee at all: it holds spawn argv with `--settings` JSON and absolute paths, the bridged MCP config target, your skill directories, opencode and Claude session ids, and error prose the CLI wrote. Nobody can safely attach it to a GitHub issue, so bug reports arrive as screenshots and guesses instead.

The redaction is an **allowlist**, not a filter, because a filter fails silently the first time someone logs a new field. Per line, what survives is:

- the timestamp and the level,
- the message text **only** when it is one of the 147 `NOTICE`/`WARN`/`ERROR` message literals extracted from the plugin's own source. A message built at runtime, including every CLI error string the plugin re-logs, becomes `[redacted message, N chars]` and only its data fields remain,
- data fields whose key is on an explicit allowlist **and** whose value is then the kind that entry declares: versions, counts, booleans, enums, durations, exit codes, model and tool and server names, paths, and the loopback proxy URL with its query dropped. The allowlist applies at every nesting depth.

Everything else, including every key the allowlist does not name, becomes `[redacted, N chars]`, which keeps the shape so you can see a field was there without seeing it. Session ids become a short hash salted per bundle, so two lines about one conversation still correlate in the paste and nowhere else, and your home directory becomes `~` across the whole report, the table included.

Never in a bundle: prompt or reply text, system prompts or the appended prompt file, tool inputs or outputs, file contents, environment values, bearer tokens, the proxy `authToken`, API keys, `Authorization` headers, MCP server env or headers, URL credentials or query strings, or the raw spawn argv. The argv is kept as option names with every value replaced, which is what a spawn bug report actually needs.

Kept on purpose, so read it before pasting: folder paths below your home directory (project and config folder names such as `~/.claude-<account>`) and your `accounts` names. A maintainer needs both to read a cwd or an account problem, and only you can tell whether a folder or account name is something you would rather not publish.

It is capped at 120 lines and 24,000 bytes, newest first, and says how many lines it left out. With file logging off it says so, tells you how to turn it on, and still returns the report:

```sh
OPENCODE_CLAUDE_CODE_LOG_FILE=1 opencode
```

The plain `/claude-code-doctor` output is unchanged by any of this.
