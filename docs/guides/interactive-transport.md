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

- opencode must be running under **Bun** with `Bun.Terminal` (PTY) support. If it isn't, the flag is ignored and the headless transport is used, and nothing breaks.
- A logged-in `claude` (subscription auth). The whole point is plan billing, so API-key auth gains nothing here.

### What carries over from the headless transport

- The plugin's appended prompt (Claude CLI context, AGENTS.md guidance, continuation rules). The interactive transport intentionally does not forward opencode's own system prompt, because live testing showed that payload can trigger Claude Code's third-party-app usage gate on subscription accounts.
- The MCP bridge: bridged servers are passed via `--mcp-config` + `--strict-mcp-config`, and every bridged server is pre-allowed as `mcp__<server>__*`.
- The [skill bridge](../configuration/skills.md#skill-bridge): the same `--plugin-dir` staging the headless spawn uses, so the TUI's native `Skill` tool can load your opencode skills too.
- Model selection, session reuse, and the whole streaming/usage pipeline.

Set `interactiveSystemPrompt: false` only for diagnostics. While disabled, the interactive session will not receive the plugin's CLI context, AGENTS.md guidance, or continuation hints.

### What it does not support

This is the part to read before turning it on. Three whole features of this plugin are simply absent on the interactive transport:

- **No tool proxy.** The interactive spawn starts no proxy MCP server at all, so `mcp__opencode_proxy__bash`, `edit`, `write`, `webfetch`, `task`, `task_batch`, `question` and `compress` do not exist for that session. Claude uses its own built-in tools directly, which means opencode does not execute them, does not prompt for them, and does not log them. Everything in [Selective tool proxy](../guides/tool-proxy.md) applies to the headless transport only.
- **No `permissionMode`.** The interactive spawn never passes your `permissionMode` to the CLI, so `"plan"` and the rest have no effect there. Permission handling is the pre-allow list described below and nothing else.
- **No [`/btw`](../guides/btw.md).** Side questions ride Claude Code's `side_question` control protocol over the headless process's stdio. Asking one in an interactive session returns an error telling you so.

### What else is different

- **Permissions:** the interactive TUI has no `can_use_tool` control channel, so tools can't be approved per-call through opencode. Built-in tools are pre-allowed via a settings allow list (default `Bash, Edit, Write, Read, WebFetch`; override with `interactiveAllowTools`). `bypassPermissions` is intentionally not used here because Claude Code shows a manual safety confirmation in the TUI and defaults to exit.
- **Input is text-only:** images and other non-text blocks are dropped (with a logged warning); tool results are rendered as labeled text.
- **Output granularity:** text arrives per transcript record, not token-by-token, so it can feel chunkier than headless streaming.
- **Token counts come from the transcript, one count per API call.** The session JSONL writes one record per content block (thinking, text, tool_use) and every record of a call repeats that call's final usage, so the transport counts each call once, keyed by its message id. The numbers then mean exactly what they do on the headless transport: [`turnStats`](../guides/turn-stats.md) gets the turn's totals and opencode gets the last call's context plus the turn's output. Before this was fixed a four-tool turn reported 1,306 output tokens against a real 653, and its input and cache counts were one call's instead of the turn's. An all-zero `<synthetic>` record (how the CLI writes "Login expired" or a session limit into the transcript) is not counted as a call.
- **How a turn finishes:** a turn that reaches a terminal stop reason (`end_turn`, `stop_sequence`, `max_tokens`) finishes exactly as a headless turn does, so it is an ordinary completed reply and [`turnStats`](../guides/turn-stats.md) applies to it. `max_tokens` is deliberately a completed turn rather than a failure: the call happened and billed, and the truncation is what auto-continue reads. Before this was fixed every interactive turn finished as an error instead, which also suppressed the stats footer.
- **Turn timeout:** a turn that produces no terminal stop within 30 minutes is reported honestly as an error result (visible truncation), not silently ended.
- **No idle eviction:** `idleProcessTimeoutMs` does not apply to interactive sessions.
- `/compact` always uses the headless transport regardless of this setting.
