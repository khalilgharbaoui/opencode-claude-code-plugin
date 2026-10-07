---
title: 'Interactive transport'
description: 'Experimental: drive the real claude TUI under a PTY instead of headless --print.'
sidebar:
  order: 7
---

## Interactive transport (experimental)

By default the plugin spawns `claude --print` (headless). The interactive transport instead drives the real interactive `claude` TUI under a native PTY inside opencode's Bun runtime, types your prompt into it, and streams the session transcript (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`) back through the same pipeline the headless transport uses. Claude Code names that directory from the cwd's **resolved real path** with every non-alphanumeric character replaced by `-`, so a working directory reached through a symlink (on macOS `/tmp` is a symlink to `/private/tmp`) is named after the target: `/tmp/scratch` becomes `-private-tmp-scratch`. This provides a transport alternative if a future CLI removes headless flags. Both transports currently draw from the same plan usage limits (see [Billing](../billing.md)); selecting a transport does not change billing or access restrictions.

```json
"options": { "transport": "auto" }
```

`transport` takes precedence over the legacy `interactive` option and its environment variable:

- `"headless"`: always use the headless CLI.
- `"interactive"`: require the PTY transport.
- `"auto"`: prefer headless. A cached, input-less help/argument probe selects the PTY only when the CLI definitively rejects a required headless flag or advertises help without it. A timeout, missing binary, authentication failure or inconclusive output is **unknown**, not evidence that headless disappeared. Such a turn stays headless and reports its normal failure. The plugin never retries an already submitted request on another transport.

With `transport` unset, the default remains headless. `interactive: true` or `CLAUDE_CODE_INTERACTIVE_TRANSPORT=1` retains the legacy PTY opt-in; an explicit `interactive` boolean wins over that environment variable. Fully quit and relaunch opencode after changing provider options.

### Requirements

- opencode must be running under **Bun** with `Bun.Terminal` (PTY) support. Explicit `transport: "interactive"` and an automatic PTY selection fail clearly when it is absent. The legacy `interactive` option still falls back to headless. Both opencode 1.x and 2.x provide it: verified live on 1.18.34 and 2.0.22 with Claude Code 2.1.288. On opencode 2 the option goes under `providers.claude-code.settings` instead of `provider.claude-code.options`.
- A working, authenticated `claude` using the account you intend. Transport selection cannot repair an expired login or a usage limit.
- **Measured on Claude Code 2.1.288.** The transport reads the TUI's screen and its transcript, and neither is a published contract, so a newer release can change what it relies on. A newer CLI is not refused (this transport exists for the day a new release drops `--print`); the plugin logs one warning per new version and `/claude-code-doctor` flags it. If a turn hangs or a dialog is not handled on a newer CLI, `/claude-code-doctor bundle` is the report to send.

### What carries over from the headless transport

- The plugin's appended prompt (Claude CLI context, AGENTS.md guidance, continuation rules). The interactive transport intentionally does not forward opencode's own system prompt, because live testing showed that payload can trigger Claude Code's third-party-app usage gate on subscription accounts.
- The MCP bridge: bridged servers are passed via `--mcp-config` + `--strict-mcp-config`, and every bridged server is pre-allowed as `mcp__<server>__*`.
- The [skill bridge](../configuration/skills.md#skill-bridge): the same `--plugin-dir` staging the headless spawn uses, so the TUI's native `Skill` tool can load your opencode skills too.
- The [tool proxy](../guides/tool-proxy.md): the same proxy MCP server, the same `proxyTools` and the same `--disallowedTools`, so `bash`, `edit`, `write`, `webfetch`, subagent dispatch (`task`, `task_batch`) and, when enabled, `question` and `compress` run in opencode with opencode's own permission prompts and tool rows. Verified live on opencode 1.18.34 and 2.0.22: a proxied `bash` and a `general` subagent, each round trip in the middle of one TUI turn.
- Model selection, session reuse, and the whole streaming/usage pipeline.

Set `interactiveSystemPrompt: false` only for diagnostics. While disabled, the interactive session will not receive the plugin's CLI context, AGENTS.md guidance, or continuation hints.

### What it does not support

What still differs is listed below. Everything else a headless turn does, this one does too: [`/btw`](../guides/btw.md) (answered by a short-lived fork of the conversation rather than the headless side channel), the account-switch form, the model fallback chain, `forkSessions`, the usage-limit and account notes, and the `turnStats` line with its cost and duration.

- **opencode's own system prompt is not forwarded.** On the interactive transport Claude Code treats a request carrying opencode's prompt as a third-party app's and bills it from extra usage ("Third-party apps now draw from your extra usage"), while the headless transport sends the same prompt without that effect. Measured on 2.1.288 (h #g211). The plugin's own prompt, your `AGENTS.md` files and the proxy hints still reach the TUI; the parts opencode adds itself (its agent prompt, environment block and tool guidance) do not.
- **Text arrives a block at a time.** The TUI writes a finished record to its transcript, never a partial one, so a reply cannot stream token by token.

### What else is different

- **Permissions follow the headless policy.** A tool the proxy serves runs in opencode and asks there, exactly as on headless. For the tools the TUI runs itself, headless never asked per call either: with `skipPermissions` (the default) it runs `--dangerously-skip-permissions`, and so does the TUI, together with Claude Code's own `skipDangerousModePermissionPrompt` setting so it does not stop on that mode's confirmation. With `skipPermissions: false`, `controlRequestBehavior: "allow"` keeps the skip flag and removes each tool you set to `"deny"` in `controlRequestToolBehaviors`, and `controlRequestBehavior: "deny"` runs `--permission-mode dontAsk` with only the tools you set to `"allow"`. Plan mode and the read-only preset are unchanged (below). Needs Claude Code 2.1.263 or newer; an older one keeps the `interactiveAllowTools` list.
- **A proxied call stays in the foreground.** Claude Code's TUI moves an MCP call that runs past 120 seconds, or that a message arrives during, to the background and lets the model end its turn. The plugin sets `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` for the TUI, which is what a headless session gets by default, unless you set that variable yourself. Measured live: a 130-second proxied `bash` returned its output into the same turn.
- **Images work, other attachments do not:** a PNG, JPEG, GIF or WebP is written to a private file in the plugin's scratch directory and its path pasted, which the TUI attaches as an image (`[Image #1]` in its transcript), and the file is deleted when the turn ends. Measured on Claude Code 2.1.288 through opencode 1.18.34: two images in one message, both read, in order. PDFs and other non-text blocks are dropped with a logged warning, as on headless, which does not forward them either. Tool results are rendered as labeled text.
- **Output granularity:** text arrives per transcript record, not token-by-token, so it can feel chunkier than headless streaming.
- **Token counts come from the transcript, one count per API call.** The session JSONL writes one record per content block (thinking, text, tool_use) and every record of a call repeats that call's final usage, so the transport counts each call once, keyed by its message id. The numbers then mean exactly what they do on the headless transport: [`turnStats`](../guides/turn-stats.md) gets the turn's totals and opencode gets the last call's context plus the turn's output. Before this was fixed a four-tool turn reported 1,306 output tokens against a real 653, and its input and cache counts were one call's instead of the turn's. An all-zero `<synthetic>` record (how the CLI writes "Login expired" or a session limit into the transcript) is not counted as a call.
- **How a turn finishes:** a turn that reaches a terminal stop reason (`end_turn`, `stop_sequence`, `max_tokens`) finishes exactly as a headless turn does, so it is an ordinary completed reply and [`turnStats`](../guides/turn-stats.md) applies to it. `max_tokens` is deliberately a completed turn rather than a failure: the call happened and billed, and the truncation is what auto-continue reads. Before this was fixed every interactive turn finished as an error instead, which also suppressed the stats footer.
- **Turn timeout:** a turn that produces no terminal stop within 30 minutes is reported honestly as an error result (visible truncation), not silently ended.

### Permission modes

- **`permissionMode`** is forwarded to the TUI as `--permission-mode`, except `bypassPermissions` (its confirmation screen defaults to exit).
- **`permissionPreset: "read-only"`** holds with the TUI's own controls: `--restricted`, the preset's `--disallowedTools`, an allow list of only `Read`, and `--permission-mode dontAsk`, which refuses anything else without a dialog and lets the turn go on. Needs Claude Code 2.1.263 or newer; an older CLI refuses the turn rather than weaken the posture. See [Read-only mode](../configuration/permissions.md#read-only-mode).
- **`permissionMode: "plan"`** can be left here, unlike headless: the TUI offers `ExitPlanMode` and parks on its approval dialog until you decide, by reply or by the `planModeQuestion` form. See [Plan mode on the interactive transport](../configuration/permissions.md#plan-mode-on-the-interactive-transport).

### What it answers on your behalf

The TUI has no control channel, so everything it is blocked on is drawn on the screen. The transport reads the screen for the few prompts a turn cannot get past alone, and only once the TUI has stopped drawing, so a reply that merely contains the same words is never mistaken for one:

- **Folder trust** is accepted, because `--print` never asks. On Claude Code 2.1.288 the dialog marks **"No, exit"** by default, so the transport moves the cursor to "Yes, I trust this folder" and presses Enter only once the TUI shows it marked. A dialog it cannot answer fails the start with a message naming the folder, rather than pasting your prompt into it.
- **Not logged in** and **first-run setup** fail the start with the command to run, instead of waiting out the turn.
- **A tool permission dialog** is denied with Esc, because there is nobody at that terminal to ask. The denial ends the turn as an interrupted one and is reported in the result's `permission_denials` with the tool's name and id. With the default `skipPermissions` on Claude Code 2.1.263 or newer no dialog is raised; otherwise widen `interactiveAllowTools` for a tool you want to run.
- **The usage-limit screen's "continuing automatically at <time>"** is cancelled, or the turn would rerun hours later with nobody watching.

The plan approval dialog is the one it does **not** answer: it waits for your decision, then presses the matching choice, read off the dialog itself.

### How a turn behaves

- **Stopping a reply** sends Esc, as the TUI's own key does, and keeps the session for your next message. A turn that does not acknowledge the Esc within a few seconds is abandoned, never waited out. Anything that turn queued behind itself is dropped with it, and a turn's result never lands on the turn after it.
- **A TUI that dies or is evicted** is replaced on your next message with `--resume`, so the conversation continues where it was. Before this, the next message started a blank conversation.
- **Long tool calls and long thinking** keep the turn alive: while the TUI is visibly working and the transcript is quiet, the transport reports progress every 30 seconds the way the headless CLI's own `tool_progress` heartbeat does. A slow first answer (measured: one first call took 185 seconds inside the CLI) no longer trips the start watchdog.
- **A turn ends** on a terminal stop reason once that API call's last record is in (a call is written as several records, and the reply text is the last of them), on the TUI's interrupt marker, or on the `turn_duration` record 2.1.288 writes after every turn. As a safeguard for a future Claude Code that writes neither, a turn that has its reply also ends once the TUI and its transcript have both been silent for 20 seconds; measured on 2.1.288 the TUI never stays quiet for more than about 200 ms while Claude is working. Such a turn is reported as having ended without a stop reason, not as a clean reply.
- **A message you send while a proxied tool runs** (or a notice opencode delivers then) reaches Claude in the same turn: the transport types it into the TUI's own input queue, as Claude Code does with a message typed mid-turn, and Claude answers it after the tool result.
- **The account's login is the one `claude` uses on its own.** `CLAUDE_CONFIG_DIR` reaches the TUI only for an account you configured: measured on 2.1.288, setting it even to the default `~/.claude` makes the CLI report itself logged out, which made every default-account interactive turn fail.
- **Idle eviction and MCP hot reload work as on headless:** with `idleProcessTimeoutMs` set an idle TUI is closed and your next message starts a new one with `--resume`, and with `hotReloadMcp` a server that joined or left since the spawn replaces the TUI the same way, at the same safe boundaries.
- **`/compact` uses the selected transport.** An interactive compaction gets a fresh, short-lived TUI with built-in tools disabled and an empty strict MCP configuration, no proxy or skill bridge, and the transcript plus summary instructions as text. The TUI is closed after its result; it never resumes or replaces the main conversation's TUI. Compaction still omits agent effort/cache overrides, continuation nudges and stats notes.
- **Doctor usage when headless is unavailable:** `/claude-code-doctor usage` reports that the free headless `/cost` check is unavailable and asks you to check usage in Claude directly. It does not send `/cost` as an inference prompt or scrape a PTY screen. The ordinary doctor report still works.
