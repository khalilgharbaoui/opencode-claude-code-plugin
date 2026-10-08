---
title: 'Environment variables'
description: 'Every variable the plugin itself reads, and the path conventions it honours.'
sidebar:
  order: 2
---

Every variable the plugin itself reads, in one place. Config is read once at opencode startup, so these are the way to change behaviour for a single run without editing `opencode.json`. Claude Code's own variables (`CLAUDE_CODE_DISABLE_THINKING` and friends) are passed through untouched and are listed under [Extended thinking](../guides/compaction-and-thinking.md#extended-thinking).

| Variable | Read by | Effect |
|---|---|---|
| `CLAUDE_CLI_PATH` | provider factory | Fallback `claude` path when `cliPath` is absent. Under opencode the config hook always supplies `cliPath`, so this only applies to direct `createClaudeCode()` use. |
| `CLAUDE_CODE_COMPACTION_MODEL` | compaction spawn | Model for `/compact`. Wins over the `compactionModel` option. See [Compaction](../guides/compaction-and-thinking.md#compaction). |
| `CLAUDE_CODE_INTERACTIVE_TRANSPORT` | transport selection | Legacy PTY opt-in when both `transport` and `interactive` are unset. `1` enables the [interactive transport](../guides/interactive-transport.md); empty, `0`, `false`, `no` and `off` disable it. |
| `CLAUDE_CODE_INTERACTIVE_BYPASS` | transport selection | Deprecated no-op, like `interactiveBypass`: `skipPermissions` governs both transports. |
| `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` | Claude Code itself | Set to `0` for the interactive TUI unless you set it, so a long proxied call is not moved to the background after 120 s (headless sessions never do this). |
| `CLAUDE_CODE_START_WATCHDOG_MS` | start watchdog | Milliseconds a `claude` process may stay completely silent on stdout after a turn is written, or after a proxy tool result should have resumed it, before the plugin acts. First expiry respawns the process and resumes the session; a second ends the turn with an error rather than hanging. Default `90000`; a positive integer is required and anything else falls back to that. Mainly a knob for reproducing the hang. |
| `CLAUDE_CODE_RESULT_FALLBACK_MS` | wire-inactivity watchdog | Milliseconds a `claude` process that has already produced output may stay silent on stdout before the turn is closed without a `result`. The close is announced in the reply as a `▌ **stream timeout:**` note. Default `60000`; a positive integer is required and anything else falls back to that. Like the start watchdog, mainly a knob for reproducing a hang. |
| `OPENCODE_CLAUDE_CODE_LOG_FILE` | logger | `1` writes the log file, `0` forces it off even when `logging.file` is `true`. See [Logging](../configuration/logging.md). |
| `OPENCODE_CLAUDE_CODE_LOG_DIR` | logger | Directory for the log file, overriding `logging.dir`. |
| `OPENCODE_CLAUDE_CODE_LOG_LEVEL` | logger | Minimum level to emit, overriding `logging.level`. An unrecognised value falls through to config. |
| `DEBUG` | logger | `DEBUG=opencode-claude-code` promotes the logger to `mode: "debug"`, echoing every emitted level to opencode's TUI. |
| `OPENCODE_CLAUDE_CODE_PLUGIN_NO_CLEANUP` | startup cleanup | `1` skips the removal of a stale **unscoped** `opencode-claude-code-plugin` install from opencode's plugin cache. That old package is a different artifact that shadows this scoped one when both are present; set this if you are deliberately keeping it. |
| `OPENCODE_CLAUDE_CODE_PLUGIN_FORCE_CLEANUP` | startup cleanup | `1` runs that cleanup even when the marker at `$XDG_STATE_HOME/opencode-claude-code-plugin/cleanup-stale.json` (default `~/.local/state/...`) records that this plugin version already swept. Without it the cleanup walks opencode's plugin cache once per installed version rather than on every launch. |
| `OPENCODE_CLAUDE_CODE_NO_TMP_SWEEP` | scratch directory | `1` skips the sweep of `<tmpdir>/opencode-claude-code-<pid>` directories left behind by plugin processes that were killed. See [Scratch files on disk](../internals/scratch-files-and-security.md#scratch-files-on-disk). |
| `OPENCODE_WORKTREE` | MCP bridge | Overrides worktree-root detection, which otherwise walks up from the working directory looking for a `.git` entry. |
| `CLAUDE_CODE_MCP_HOT_RELOAD_COOLDOWN_MS` | MCP bridge | Minimum gap between two `hotReloadMcp` respawns of one conversation, default `60000`. A server that flaps between connected and failed would otherwise cost a kill and a `--resume` spawn on every turn. `0` disables the guard; a real second change lands on the first turn after the gap. |
| `OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR` | config discovery | Where the plugin looks for your opencode config when bridging MCP and skills. See [Discovery order](../configuration/mcp.md#discovery-and-precedence). |
| `OPENCODE_VERSION` | startup diagnostics | Reported as the opencode version when set, sparing the plugin a `--version` spawn. Diagnostics only. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | spawn environment | Not set by the plugin: these are yours, and Claude Code authenticates with them in preference to your subscription login when present. `ignoreAnthropicApiKey: true` strips them from the spawn. See [Billing](../billing.md). |
| `DISABLE_AUTOUPDATER` | spawn environment | Set to `1` on every `claude` the plugin spawns, **only if you have not set it yourself**. The plugin detects your CLI version once and caches it, and gates `--thinking-display summarized`, `--plugin-dir` and fast mode on the answer, so a CLI that updates itself mid-session would leave those gates describing a binary that is no longer running. Export `DISABLE_AUTOUPDATER=0` to keep the autoupdater; your value is never overwritten, and updating the CLI between opencode restarts works normally either way. |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | spawn environment | Set to `1` on every spawned `claude` under the same never-overwrite rule. It suppresses the CLI's non-essential network calls and is a second, independent way Claude Code declines to auto-update. Export it yourself (including as an empty string, which the CLI reads as off) to take control. |
| `MCP_TIMEOUT` | spawn environment | Set to `120000` (120 s) on every spawned `claude`, **only if you have not set it yourself**. It is how long Claude Code waits for its MCP servers to start, 30 s by default. The plugin's own tool proxy runs inside opencode, and when opencode is busy for longer than that (measured: 35 s while a very long session took its next step), a subagent gave up on the proxy and started without its tools. A server that never starts now holds the first message for up to 120 s instead of 30 s. |

The plugin also honours the usual path conventions rather than defining its own: `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` (falling back to `~/.config` and `~/.cache`), `HOME` / `USERPROFILE`, and Claude Code's `CLAUDE_CONFIG_DIR` when the interactive transport needs to find the session transcript. Account providers set `CLAUDE_CONFIG_DIR` themselves for the process they spawn.
