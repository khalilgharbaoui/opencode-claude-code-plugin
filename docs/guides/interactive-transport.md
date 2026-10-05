---
title: 'Interactive transport'
description: 'Experimental: drive the real claude TUI under a PTY instead of headless --print.'
sidebar:
  order: 7
---

## Interactive transport (experimental)

By default the plugin spawns `claude --print` (headless). The interactive transport instead drives the real interactive `claude` TUI under a native PTY inside opencode's Bun runtime, types your prompt into it, and streams the session transcript (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`) back through the same pipeline the headless transport uses. Claude Code names that directory from the cwd's **resolved real path** with every non-alphanumeric character replaced by `-`, so a working directory reached through a symlink (on macOS `/tmp` is a symlink to `/private/tmp`) is named after the target: `/tmp/scratch` becomes `-private-tmp-scratch`. It was built as insurance for the day headless usage is billed differently from interactive usage; today both draw from the same plan usage limits (see [Billing](../billing.md)), so it is not a way to change what a turn costs.

```json
"options": { "interactive": true }
```

Or per-process: `CLAUDE_CODE_INTERACTIVE_TRANSPORT=1`.

### Requirements

- opencode must be running under **Bun** with `Bun.Terminal` (PTY) support. If it isn't, the flag is ignored and the headless transport is used, and nothing breaks. Both opencode 1.x and 2.x provide it: verified live on 1.18.34 and 2.0.22 with Claude Code 2.1.288. On opencode 2 the option goes under `providers.claude-code.settings` instead of `provider.claude-code.options`.
- A logged-in `claude` (subscription auth). The whole point is plan billing, so API-key auth gains nothing here.

### What carries over from the headless transport

- The plugin's appended prompt (Claude CLI context, AGENTS.md guidance, continuation rules). The interactive transport intentionally does not forward opencode's own system prompt, because live testing showed that payload can trigger Claude Code's third-party-app usage gate on subscription accounts.
- The MCP bridge: bridged servers are passed via `--mcp-config` + `--strict-mcp-config`, and every bridged server is pre-allowed as `mcp__<server>__*`.
- The [skill bridge](../configuration/skills.md#skill-bridge): the same `--plugin-dir` staging the headless spawn uses, so the TUI's native `Skill` tool can load your opencode skills too.
- The [tool proxy](../guides/tool-proxy.md): the same proxy MCP server, the same `proxyTools` and the same `--disallowedTools`, so `bash`, `edit`, `write`, `webfetch`, subagent dispatch (`task`, `task_batch`) and, when enabled, `question` and `compress` run in opencode with opencode's own permission prompts and tool rows. Verified live on opencode 1.18.34 and 2.0.22: a proxied `bash` and a `general` subagent, each round trip in the middle of one TUI turn.
- Model selection, session reuse, and the whole streaming/usage pipeline.

Set `interactiveSystemPrompt: false` only for diagnostics. While disabled, the interactive session will not receive the plugin's CLI context, AGENTS.md guidance, or continuation hints.

### What it does not support

This is the part to read before turning it on. Two features of this plugin are absent on the interactive transport:

- **No `permissionMode`.** The interactive spawn never passes your `permissionMode` to the CLI, so `"plan"` and the rest have no effect there. Permission handling is the pre-allow list described below and nothing else.
- **No [`/btw`](../guides/btw.md).** Side questions ride Claude Code's `side_question` control protocol over the headless process's stdio. Asking one in an interactive session returns an error telling you so.

### What else is different

- **Permissions:** a tool the proxy serves runs in opencode and asks there, exactly as on headless. The TUI itself has no `can_use_tool` control channel, so the tools it runs on its own (`Read`, and any tool you take out of `proxyTools`) can't be approved per call through opencode: they are pre-allowed via a settings allow list (default `Bash, Edit, Write, Read, WebFetch`, of which the proxied ones are disabled natively anyway; override with `interactiveAllowTools`). `bypassPermissions` is intentionally not used here because Claude Code shows a manual safety confirmation in the TUI and defaults to exit.
- **Input is text-only:** images and other non-text blocks are dropped (with a logged warning); tool results are rendered as labeled text.
- **Output granularity:** text arrives per transcript record, not token-by-token, so it can feel chunkier than headless streaming.
- **Token counts come from the transcript, one count per API call.** The session JSONL writes one record per content block (thinking, text, tool_use) and every record of a call repeats that call's final usage, so the transport counts each call once, keyed by its message id. The numbers then mean exactly what they do on the headless transport: [`turnStats`](../guides/turn-stats.md) gets the turn's totals and opencode gets the last call's context plus the turn's output. Before this was fixed a four-tool turn reported 1,306 output tokens against a real 653, and its input and cache counts were one call's instead of the turn's. An all-zero `<synthetic>` record (how the CLI writes "Login expired" or a session limit into the transcript) is not counted as a call.
- **How a turn finishes:** a turn that reaches a terminal stop reason (`end_turn`, `stop_sequence`, `max_tokens`) finishes exactly as a headless turn does, so it is an ordinary completed reply and [`turnStats`](../guides/turn-stats.md) applies to it. `max_tokens` is deliberately a completed turn rather than a failure: the call happened and billed, and the truncation is what auto-continue reads. Before this was fixed every interactive turn finished as an error instead, which also suppressed the stats footer.
- **Turn timeout:** a turn that produces no terminal stop within 30 minutes is reported honestly as an error result (visible truncation), not silently ended.

### What it answers on your behalf

The TUI has no control channel, so everything it is blocked on is drawn on the screen. The transport reads the screen for the few prompts a turn cannot get past alone, and only once the TUI has stopped drawing, so a reply that merely contains the same words is never mistaken for one:

- **Folder trust** is accepted, because `--print` never asks. On Claude Code 2.1.288 the dialog marks **"No, exit"** by default, so the transport moves the cursor to "Yes, I trust this folder" and presses Enter only once the TUI shows it marked. A dialog it cannot answer fails the start with a message naming the folder, rather than pasting your prompt into it.
- **Not logged in** and **first-run setup** fail the start with the command to run, instead of waiting out the turn.
- **A tool permission dialog** is denied with Esc, because there is nobody at that terminal to ask. The denial ends the turn as an interrupted one and is reported in the result's `permission_denials` with the tool's name and id. Widen `interactiveAllowTools` for a tool you want to run.
- **The usage-limit screen's "continuing automatically at <time>"** is cancelled, or the turn would rerun hours later with nobody watching.

### How a turn behaves

- **Stopping a reply** sends Esc, as the TUI's own key does, and keeps the session for your next message. A turn that does not acknowledge the Esc within a few seconds is abandoned, never waited out. Anything that turn queued behind itself is dropped with it, and a turn's result never lands on the turn after it.
- **A TUI that dies or is evicted** is replaced on your next message with `--resume`, so the conversation continues where it was. Before this, the next message started a blank conversation.
- **Long tool calls and long thinking** keep the turn alive: while the TUI is visibly working and the transcript is quiet, the transport reports progress every 30 seconds the way the headless CLI's own `tool_progress` heartbeat does. A slow first answer (measured: one first call took 185 seconds inside the CLI) no longer trips the start watchdog.
- **A turn ends** on a terminal stop reason once that API call's last record is in (a call is written as several records, and the reply text is the last of them), on the TUI's interrupt marker, or on the `turn_duration` record 2.1.288 writes after every turn.
- **The account's login is the one `claude` uses on its own.** `CLAUDE_CONFIG_DIR` reaches the TUI only for an account you configured: measured on 2.1.288, setting it even to the default `~/.claude` makes the CLI report itself logged out, which made every default-account interactive turn fail.
- **No idle eviction:** `idleProcessTimeoutMs` does not apply to interactive sessions.
- `/compact` always uses the headless transport regardless of this setting.
