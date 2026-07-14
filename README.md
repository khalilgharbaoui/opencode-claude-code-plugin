# @khalilgharbaoui/opencode-claude-code-plugin

[![npm](https://img.shields.io/npm/v/@khalilgharbaoui/opencode-claude-code-plugin.svg)](https://www.npmjs.com/package/@khalilgharbaoui/opencode-claude-code-plugin)

An [opencode](https://opencode.ai) plugin that wraps the **Claude Code CLI** (`claude`) and routes model traffic through it instead of the Anthropic HTTP API. You get to use opencode's UI, agents, MCP, and permission system while authenticating and billing through whichever method `claude` is logged into (Pro/Max plan, Bedrock, Vertex, or API key).

> Maintained fork of [`unixfox/opencode-claude-code-plugin`](https://github.com/unixfox/opencode-claude-code-plugin). Published as `@khalilgharbaoui/opencode-claude-code-plugin` on npm.

---

## TL;DR

```bash
# 1. Make sure `claude` is installed and logged in
claude --version

# 2. Add this to your opencode.json
```

```json
{
  "plugin": ["@khalilgharbaoui/opencode-claude-code-plugin"]
}
```

That's it. Restart opencode, pick a `claude-code` model, done.

The plugin self-registers the `claude-code` provider, all current Claude Code models (Haiku 4.5, Sonnet 4.5/4.6, Opus 4.5/4.6/4.7/4.8, Fable 5, Mythos 5) with reasoning variants (`low` / `medium` / `high` / `xhigh` / `max`), and sensible defaults for tool proxying. You don't need to write a `provider` block at all unless you want to override something.

---

## Prerequisites

- [opencode](https://opencode.ai) installed
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` on your `$PATH`)
- Node 18+ / Bun

## Install

### From npm (recommended)

```bash
npm install @khalilgharbaoui/opencode-claude-code-plugin
```

Then add it to `opencode.json` as shown in the TL;DR.

### Local development

```bash
git clone https://github.com/khalilgharbaoui/opencode-claude-code-plugin
cd opencode-claude-code-plugin
bun install
bun run build
```

In your `opencode.json`, point at the local build with a `file://` URL:

```json
{
  "plugin": ["file:///absolute/path/to/opencode-claude-code-plugin"]
}
```

---

## Models

The plugin auto-registers the following. They appear in the model picker without any extra config.

| ID | Display name | Context | Output | Reasoning variants | Price × |
|---|---|---|---|---|---|
| `claude-haiku-4-5` | Claude Haiku 4.5 | 200k | 8,192 | – | 1× |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 | 1M | 16,384 | low/medium/high/xhigh/max | 3× |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | 1M | 16,384 | low/medium/high/xhigh/max | 3× |
| `claude-opus-4-5` | Claude Opus 4.5 | 1M | 16,384 | low/medium/high/xhigh/max | 5× |
| `claude-opus-4-6` | Claude Opus 4.6 | 1M | 16,384 | low/medium/high/xhigh/max | 5× |
| `claude-opus-4-7` | Claude Opus 4.7 | 1M | 16,384 | low/medium/high/xhigh/max | 5× |
| `claude-opus-4-8` | Claude Opus 4.8 | 1M | 16,384 | low/medium/high/xhigh/max | 5× |
| `claude-fable-5` | Claude Fable 5 | 1M | 16,384 | low/medium/high/xhigh/max | 10× |
| `claude-mythos-5` | Claude Mythos 5 | 1M | 16,384 | low/medium/high/xhigh/max | 10× |

`claude-mythos-5` is Mythos-class like Fable 5 but without safety classifiers, and is **limited availability via [Project Glasswing](https://anthropic.com/glasswing)**. It's registered unconditionally; if your Claude account lacks access, `claude --model claude-mythos-5` just errors. Use `claude-fable-5` (generally available) otherwise.

Capabilities for every model: text + image input, text output, tool use, attachments. No temperature control, no PDF/audio/video, no interleaved streaming.

**Price ×** is each model's per-token list price relative to Haiku, the cheapest model. It's derived exactly from Anthropic's published pricing — input and output ratios both come out the same (Haiku $1/$5 = 1×, Sonnet $3/$15 = 3×, Opus 4.8 $5/$25 = 5×, Fable 5 / Mythos 5 $10/$50 = 10×), so **Fable 5 and Mythos 5 cost 2× Opus 4.8**. The same multiplier is shown as a `(N×)` suffix on the display name in opencode's model picker, since opencode has no dedicated multiplier field. On a flat Max/Pro subscription it doubles as a rough guide to how fast each model drains your usage limit.

The model ID is passed straight through to `claude --model`, so anything Claude Code accepts works.

### Picking a variant

Variants set the underlying reasoning effort. They're regular opencode model variants — pick them in the model selector. If you'd previously declared variants in your project's `opencode.json`, they're merged on top of the defaults so nothing gets lost.

---

## Billing  

This plugin drives Claude Code headlessly (Agent SDK > `claude --print`)  
check out this page for updated information about billing: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
  
---

## Configuration

The minimum config is just the `plugin` entry above. Everything below is optional override that goes in a `provider.claude-code` block.

### Multiple Claude Code accounts

Declare account names once and the plugin expands them into separate opencode providers:

```json
{
  "plugin": ["@khalilgharbaoui/opencode-claude-code-plugin"],
  "provider": {
    "claude-code": {
      "options": {
        "accounts": ["personal", "work"]
      }
    }
  }
}
```

`default` is always implicit, so the config above creates:

| Provider ID | Display name | Claude config dir |
|---|---|---|
| `claude-code-default` | `Claude Code (Default)` | normal `~/.claude` |
| `claude-code-personal` | `Claude Code (Personal)` | `~/.claude-personal` |
| `claude-code-work` | `Claude Code (Work)` | `~/.claude-work` |

Non-default accounts use `CLAUDE_CONFIG_DIR` through a generated wrapper script, so auth/session state stays isolated per account. Shared capability files and folders are symlinked from `~/.claude` into each account dir when present:

```text
CLAUDE.md
settings.json
skills/
agents/
commands/
plugins/
```

Identity/session state is not shared.

Login each account once:

```bash
CLAUDE_CONFIG_DIR="$HOME/.claude-personal" claude auth login
CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude auth login
```

The account model IDs are internally suffixed, for example `claude-sonnet-4-6@work`, so long-lived Claude subprocess sessions do not collide across accounts. The generated wrapper strips the suffix before calling `claude --model`.

### Options reference

```json
{
  "plugin": ["@khalilgharbaoui/opencode-claude-code-plugin"],
  "provider": {
    "claude-code": {
      "options": {
        "cliPath": "claude",
        "proxyTools": ["Bash", "Edit", "Write", "WebFetch"],
        "skipPermissions": true,
        "permissionMode": "default",
        "bridgeOpencodeMcp": true,
        "strictMcpConfig": false,
        "idleProcessTimeoutMs": 900000
      }
    }
  }
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `cliPath` | string | `process.env.CLAUDE_CLI_PATH ?? "claude"` | Path to the `claude` binary. |
| `accounts` | string[] | – | Optional account list. `default` is implicit. Expands into `Claude Code (Default)`, `Claude Code (Personal)`, etc. |
| `cwd` | string | `process.cwd()` | Working directory for the spawned CLI. Resolved **lazily per request**, so opencode's project switching works. |
| `skipPermissions` | boolean | `true` | Pass `--dangerously-skip-permissions` to `claude`. Ignored when `proxyTools` is set — the proxy handles permissions through opencode instead. |
| `permissionMode` | `acceptEdits` \| `auto` \| `bypassPermissions` \| `default` \| `dontAsk` \| `plan` | – | Forwarded to `claude --permission-mode`. |
| `proxyTools` | string[] | `["Bash", "Edit", "Write", "WebFetch"]` | Claude built-in tools to route through opencode's executor + permission UI. See [Selective tool proxy](#selective-tool-proxy). |
| `controlRequestBehavior` | `allow` \| `deny` | `allow` | Default response when `skipPermissions: false` and Claude sends a `can_use_tool` control request. |
| `controlRequestToolBehaviors` | `Record<string, "allow" \| "deny">` | – | Per-tool override for `can_use_tool`. Example: `{ "Bash": "deny", "Read": "allow" }`. |
| `controlRequestDenyMessage` | string | built-in message | Message returned to Claude on a deny. |
| `bridgeOpencodeMcp` | boolean | `true` | Auto-translate your opencode `mcp` block into Claude's `--mcp-config`. See [MCP bridge](#mcp-bridge). |
| `mcpConfig` | string \| string[] | – | Extra `--mcp-config` paths/JSON passed alongside the bridged config. |
| `strictMcpConfig` | boolean | `false` | Pass `--strict-mcp-config` so Claude loads **only** the configured servers and ignores `~/.claude/settings.json`. |
| `webSearch` | `"claude"` \| `"disabled"` \| `<tool>` | `"claude"` | Routing for Claude's built-in `WebSearch`. See [WebSearch routing](#websearch-routing). |
| `multiStepContinuation` | boolean | `true` | Append a system-prompt hint nudging Claude to chain tool calls within one turn instead of pausing between subtasks. Each opencode turn boundary requires the user to manually press "continue", so for multi-step tasks this reduces friction. Set `false` to disable. |
| `autoContinueIncompleteTurns` | boolean \| `"smart"` | `"smart"` | Smartly continue incomplete Claude CLI results inside the same opencode turn. Reduces manual "continue" presses when Claude ends after reasoning/tool activity without a useful final answer. Set `false` to disable. |
| `compactionModel` | string | `"claude-haiku-4-5"` | Model used when opencode invokes `/compact`. Override per-process via the `CLAUDE_CODE_COMPACTION_MODEL` env var (env wins over config). See [Compaction](#compaction). |
| `ignoreAnthropicApiKey` | boolean | `false` | Strip `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from every spawned `claude` process so it authenticates with your logged-in subscription instead of pay-as-you-go API billing. The plugin warns once at startup whenever an API key is detected, regardless of this setting. See [Billing](#billing-change-june-15-2026-agent-sdk-credit). |
| `idleProcessTimeoutMs` | number | – | Kill a retained headless Claude worker after this many idle milliseconds following a completed turn. The session id is preserved for `--resume`; a new turn cancels the timer. Values above Node's maximum timer delay (`2147483647`) are ignored. Omit or set to `0` to retain workers until LRU eviction. Interactive transport is excluded. |
| `interactive` | boolean | `false` | **Experimental.** Drive the interactive `claude` TUI (subscription billing) instead of headless `--print`. Requires opencode running under Bun with PTY support; silently falls back to headless otherwise. Env: `CLAUDE_CODE_INTERACTIVE_TRANSPORT=1`. See [Interactive transport](#interactive-transport-experimental). |
| `interactiveBypass` | boolean | `false` | Deprecated/no-op with `interactive`: Claude Code's TUI shows a manual safety confirmation for `bypassPermissions`, so the plugin intentionally does not pass it. |
| `interactiveAllowTools` | string[] | `["Bash", "Edit", "Write", "Read", "WebFetch"]` | With `interactive`: built-in tools pre-allowed without prompting (replaces the default list). MCP server wildcards (`mcp__<server>__*`) are always added from the bridged config. |
| `interactiveSystemPrompt` | boolean | `true` | With `interactive`: append this plugin's CLI/AGENTS/continuation prompt via `--append-system-prompt-file`. The transport intentionally does not forward opencode's own system prompt, because it can trigger Claude Code's third-party-app usage gate on subscription accounts. Set `false` only for diagnostics. |

### Overriding model metadata

To rename a model, change a limit, or add a custom one:

```json
{
  "plugin": ["@khalilgharbaoui/opencode-claude-code-plugin"],
  "provider": {
    "claude-code": {
      "models": {
        "claude-sonnet-4-6": {
          "name": "Sonnet (custom)",
          "limit": { "context": 1000000, "output": 32768 }
        }
      }
    }
  }
}
```

Anything you supply is merged on top of the defaults; you don't need to redeclare every model.

---

## Interactive transport (experimental)

By default the plugin spawns `claude --print` (headless). From **June 15, 2026** that usage bills against the separate [Agent SDK credit](#billing-change-june-15-2026-agent-sdk-credit) on subscription plans. The interactive transport instead drives the real interactive `claude` TUI — which bills as **normal plan usage** — under a native PTY inside opencode's Bun runtime, types your prompt into it, and streams the session transcript (`~/.claude/projects/<cwd>/<session-id>.jsonl`) back through the same pipeline the headless transport uses.

```json
"options": { "interactive": true }
```

Or per-process: `CLAUDE_CODE_INTERACTIVE_TRANSPORT=1`.

### Requirements

- opencode must be running under **Bun** with `Bun.Terminal` (PTY) support. If it isn't, the flag is ignored and the headless transport is used — nothing breaks.
- A logged-in `claude` (subscription auth). The whole point is plan billing, so API-key auth gains nothing here.

### What carries over from the headless transport

- The plugin's appended prompt (Claude CLI context, AGENTS.md guidance, continuation rules). The interactive transport intentionally does not forward opencode's own system prompt, because live testing showed that payload can trigger Claude Code's third-party-app usage gate on subscription accounts.
- The MCP bridge: bridged servers are passed via `--mcp-config` + `--strict-mcp-config`, and every bridged server is pre-allowed as `mcp__<server>__*`.
- Model selection, session reuse, and the whole streaming/usage pipeline.

Set `interactiveSystemPrompt: false` only for diagnostics. While disabled, the interactive session will not receive the plugin's CLI context, AGENTS.md guidance, or continuation hints.

### What's different

- **Permissions:** the interactive TUI has no `can_use_tool` control channel, so tools can't be approved per-call through opencode. Built-in tools are pre-allowed via a settings allow list (default `Bash, Edit, Write, Read, WebFetch`; override with `interactiveAllowTools`). `bypassPermissions` is intentionally not used here because Claude Code shows a manual safety confirmation in the TUI and defaults to exit.
- **Input is text-only:** images and other non-text blocks are dropped (with a logged warning); tool results are rendered as labeled text.
- **Output granularity:** text arrives per transcript record, not token-by-token, so it can feel chunkier than headless streaming.
- **Turn timeout:** a turn that produces no terminal stop within 30 minutes is reported honestly as an error result (visible truncation), not silently ended.
- `/compact` always uses the headless transport regardless of this setting.

---

## Selective tool proxy

This is the core feature.

By default, when Claude Code's CLI uses `Bash`, `Edit`, `Write`, etc., it executes them itself — bypassing opencode's permission UI, audit trail, and policy rules entirely. With `proxyTools`, you tell the plugin to disable Claude's built-in version of a tool and expose an equivalent through an in-process MCP server. Claude calls the MCP version, which blocks until opencode runs the tool through its own executor.

### Default proxied tools

| `proxyTools` value | Claude built-ins disabled | Proxy MCP tool exposed |
|---|---|---|
| `"Bash"` | `Bash` | `mcp__opencode_proxy__bash` |
| `"Edit"` | `Edit`, `MultiEdit` | `mcp__opencode_proxy__edit` |
| `"Write"` | `Write` | `mcp__opencode_proxy__write` |
| `"WebFetch"` | `WebFetch` | `mcp__opencode_proxy__webfetch` |
| `"Task"` | `Agent` | `mcp__opencode_proxy__task` |

The `Task` proxy is the way to let Claude orchestrate opencode's configured subagents (`build`, `general`, custom subagents defined in `opencode.json`) instead of Claude CLI's internal-only general-purpose / Explore / Plan options. With `"Task"` in `proxyTools` and `permission.task: allow` granted to the calling agent, a Claude session can invoke `task(subagent_type="build", prompt="...")` and the subagent runs natively under opencode (with its own permission UI, lifecycle, model assignment, and Tab visibility). Without `"Task"`, Claude's built-in `Agent` tool stays enabled and Claude orchestrates subagents internally with no opencode visibility.

Only those five values are actually proxied; anything else you put in `proxyTools` is ignored. Proxying `Edit` also disables `MultiEdit` — opencode has no batched-edit equivalent, so Claude is forced to fan out into single `Edit` calls that each flow through the permission UI.

To turn off proxying entirely:

```json
"options": { "proxyTools": [] }
```

### What you get with proxying on

- opencode's **permission prompts** for every Bash/Edit/Write/WebFetch call (the default `claude --dangerously-skip-permissions` is NOT applied to proxied tools).
- opencode's **audit log** captures the calls.
- Per-tool **policy rules** in opencode apply.

### What you give up

- A small per-call latency hop through `127.0.0.1:<random>/mcp`.
- Batched-edit ergonomics: with `Edit` proxied, Claude can no longer use `MultiEdit`, so a refactor that would have been one tool call becomes N single `Edit` calls.

---

## WebSearch routing

Claude Code ships a built-in `WebSearch` tool. The `webSearch` option controls who actually executes those calls:

| `webSearch` value | Behavior | When to use |
|---|---|---|
| `"claude"` (default) | Claude CLI runs WebSearch internally via Anthropic. Zero setup, no extra cost, no API key. The query is shown in the transcript as a `> Web search:` line (opencode has no `WebSearch` tool registry entry, so a raw tool row would render as `⚙ invalid`). | Most users. |
| `"<opencode-tool-name>"` (e.g. `"websearch_web_search_exa"`) | Forward to that opencode-side tool with `executed:false`. Requires the corresponding MCP server to be configured in opencode (e.g. [exa-mcp-server](https://github.com/exa-labs/exa-mcp-server)). | You want a specific search backend (Exa, Tavily, Brave) and have the MCP wired up in opencode. |
| `"disabled"` | `WebSearch` is added to `--disallowedTools` so the model can't call it. | Compliance/security scenarios where outbound search isn't allowed. |

```json
"options": { "webSearch": "websearch_web_search_exa" }
```

**Trade-offs**

- Claude-side execution: free with your Claude usage, no API key, but no opencode visibility into queries/results, no caching/rate-limit hooks.
- opencode-side execution: choose any backend, queries flow through opencode's audit/policy/cache, but costs money (search APIs are paid) and adds a network hop.
- Some Claude-specific tool features stay on the built-in side (notably `MultiEdit` — see the note above).

---

## MCP bridge

If `bridgeOpencodeMcp` is true (the default), the plugin reads your opencode config's `mcp` block, translates it into Claude's MCP schema, writes it to a temp file, and passes that to `claude --mcp-config`. So whatever MCP servers you've already configured in opencode become available to Claude with no extra setup.

### Discovery order (highest to lowest priority)

1. `OPENCODE_CONFIG` env var (file path)
2. `OPENCODE_CONFIG_DIR` env var
3. Walk up from the current `cwd` looking for `opencode.jsonc`, `opencode.json`, `config.json`, or a `.opencode/` directory
4. Global `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`

Later sources override earlier ones **by server name**, so a project-level MCP server replaces a global one with the same id.

### Translation

| opencode `type` | Claude `type` |
|---|---|
| `local` | `stdio` |
| `remote` | `http` |

If you want to manage MCP servers only via `~/.claude/settings.json`, set `bridgeOpencodeMcp: false`.

To replace (rather than augment) bridged MCP with your own:

```json
"options": {
  "bridgeOpencodeMcp": false,
  "mcpConfig": "/path/to/your/mcp.json",
  "strictMcpConfig": true
}
```

---

## Sessions

Each chat keeps a long-lived `claude` subprocess so the model retains its native context across turns.

- **Session key**: `(cwd, model, tool-scope, opencode-session-id)`. The opencode session id comes from the `x-session-affinity` header opencode sets on third-party provider calls. Two chats in the same project on the same model run in **separate** CLI processes — they don't race. In account mode, model IDs are suffixed per account, so account sessions do not collide.
- **Same chat, multiple turns** → process reused, full Claude context retained.
- **New chat** → fresh process under the new session key.
- **Resumed chat after restart** → in-memory state is gone; a new process spawns and the conversation history is summarized and prepended.
- **Abort (Ctrl+C)** → stream closes, process stays alive for the next message in that chat.
- **Idle timeout** → when `idleProcessTimeoutMs` is configured, a completed headless turn arms an eviction timer; reuse cancels it, and eviction preserves the session id for `--resume`.
- **Cap**: 16 active processes, LRU eviction.

---

## Plan mode

Set `permissionMode: "plan"` to forward `--permission-mode plan` to Claude. The plugin handles `ExitPlanMode` specially — instead of forwarding it as a tool call, it converts it to a confirmation prompt that flows through opencode normally.

---

## AskUserQuestion

opencode has no native structured ask-question executor to proxy through (unlike `Bash`/`Task`), so the plugin handles `AskUserQuestion` specially:

1. **It renders the full question.** The tool's payload — every question, header, option label, and option description — is emitted as readable markdown into the assistant stream so the user actually sees the choices (same approach as `ExitPlanMode`).
2. **It is never auto-allowed at the CLI gate.** Allowing it would let the headless Claude CLI resolve its own question (no TTY → fabricated/empty answer) and proceed on a guess. `controlRequestBehaviorForTool` hard-denies `AskUserQuestion` and returns a message telling the model to **stop and wait for the operator's answer** — end the turn, call no further tools, and never self-answer. (Before v0.7.0 this message also offered an "if the run is non-interactive, proceed with a reasonable guess" fallback. The model could not reliably tell interactive opencode from a headless run and routinely took it, so questions appeared to be skipped — [issue #8](https://github.com/khalilgharbaoui/opencode-claude-code-plugin/issues/8). For genuinely unattended runs, use the `controlRequestToolBehaviors` override below instead.)

This hard-deny sits **below** `controlRequestToolBehaviors` in precedence but **above** the global `controlRequestBehavior`. So:

- The global `controlRequestBehavior: "allow"` does **not** override it (interactive setups stay correct by default).
- An explicit per-tool entry **does**. For a fully unattended/automated deployment that prefers "guess and continue" over "stop and wait", restore the old auto-allow:

  ```json
  "provider": {
    "claude-code": {
      "options": {
        "controlRequestToolBehaviors": { "AskUserQuestion": "allow" }
      }
    }
  }
  ```

  With `"allow"`, the Claude CLI answers its own `AskUserQuestion` internally and the run never blocks — appropriate only when no operator is watching and forward progress matters more than a correct decision.

---

## Compaction

When you run `/compact` in opencode, the plugin handles it on a short-lived dedicated Claude CLI spawn instead of routing it through your main conversation process. Three reasons:

1. **Cost.** The summarizer reads your entire transcript every time. Routing through a smaller model keeps `/compact` from burning your Opus budget.
2. **Latency.** Claude Haiku 4.5 hits ~150 tok/s with a hard 8k output cap, so compaction completes predictably (~30s for a long transcript).
3. **Cleanliness.** The compaction spawn skips MCP servers, the tool proxy, and the multi-step continuation hint. It's a one-shot text-out call; the rest is overhead.

The transcript itself is serialized rich: tool inputs and tool results are both included (each clipped at 10k chars), with oldest entries dropped first when the aggregate exceeds 180k chars. The summarizer sees actual tool activity rather than placeholders.

### Picking a different compaction model

| Source | How | Wins over |
|---|---|---|
| Env var (per-process) | `CLAUDE_CODE_COMPACTION_MODEL=claude-sonnet-4-6 opencode` | config, default |
| `opencode.json` (per-project) | `"compactionModel": "claude-sonnet-4-6"` under `provider.claude-code.options` | default |
| Default | `claude-haiku-4-5` | – |

Anything Claude Code's `--model` accepts works as a value.

---

## Extended thinking

The plugin forwards Claude's thinking blocks (`thinking_delta` stream events) to opencode as reasoning parts, so the "Thinking" row in the chat panel shows whenever the model uses extended thinking. This works across every Claude 4 family model the CLI supports.

What you see is a **summary** of the model's thinking, not the raw chain-of-thought. Anthropic [stopped exposing raw thinking on the Claude 4 family](https://platform.claude.com/docs/en/build-with-claude/extended-thinking#summarized-thinking) and ships a server-generated digest instead. For Claude Opus 4.7 specifically, [thinking content is omitted from responses by default](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7#thinking-content-omitted-by-default); the plugin opts back in by passing `--thinking-display summarized` on every spawn. Claude Code CLI 2.1.142+ is required for that flag to take effect; older CLIs skip it silently.

### Reasoning effort variants

Each model exposes `low` / `medium` / `high` / `xhigh` / `max` variants. Picking one injects the corresponding Claude CLI thinking keyword (e.g. `(ultrathink)` for `max`) into the user message. Compaction calls skip this injection so the full output budget goes to the summary.

### Env-var overrides

The plugin respects the standard Claude Code thinking env vars. If you set them in your shell, they pass through to the spawned process untouched.

| Env var | Effect |
|---|---|
| `CLAUDE_CODE_DISABLE_THINKING=1` | Disable thinking entirely. |
| `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` | Disable adaptive thinking only. |
| `CLAUDE_CODE_SHOW_THINKING_SUMMARIES=0` | Suppress summaries (the plugin sets this to `1` by default when unset). |

---

## Quirks worth knowing

- **Empty text blocks are dropped.** Claude sometimes opens a `content_block_start` for text but never sends a delta. The plugin no longer emits the empty block (which was triggering Anthropic 400s like `cache_control cannot be set for empty text blocks`).
- **Smart incomplete-turn continuation.** By default, the plugin keeps the current opencode stream open and feeds Claude CLI a small internal continuation message when Claude emits a `result` after reasoning/tool activity without a useful visible answer. It still stops normally on final-looking answers, questions, blockers, errors, aborts, or internal safety-budget exhaustion. Disable with `"autoContinueIncompleteTurns": false`.
- **`AskUserQuestion`** from the CLI is converted into plain text content rather than forwarded as a tool call.
- **Wire-inactivity watchdog.** Once the CLI has produced any content, the stream closes gracefully if stdout goes silent for 60 seconds without a `result` message arriving. Resets on every line received, so long mid-turn pauses (Sonnet between text-end and the next tool_use, for example) are tolerated. On a user-initiated abort, the watchdog shortens to 5 seconds.
- **Per-iteration usage.** When the CLI internally retries with tools, the plugin only counts the last iteration's usage so opencode's context accounting stays accurate.
- **Lazy `cwd`.** The working directory is re-resolved at every request, so opencode's project-aware behavior works without restarting the plugin.
- **Variants survive merge.** opencode recalculates variant lists after the plugin loads; the plugin re-injects defaults into runtime config so your variants don't disappear.

## Logging

Configure via `opencode.jsonc` (launch-method-independent) or env vars
(temporary override for a single process). The plugin has four orthogonal
knobs:

| Field | Values | Default | Effect |
|---|---|---|---|
| `file` | `true \| false` | `false` | Persist log entries to disk |
| `dir` | path string | `~/.local/share/opencode-claude-code/` | Custom file location |
| `mode` | `"silent" \| "debug"` | `"silent"` | TUI policy |
| `level` | `"debug" \| "info" \| "notice" \| "warn" \| "error"` | `"info"` | Minimum level to emit |

Rails-style threshold: anything below `level` is dropped before either
destination decides what to do. `mode: "silent"` routes DEBUG/INFO/NOTICE
to file only and lets WARN/ERROR bubble in the TUI (they always do).
`mode: "debug"` additionally echoes every emitted level to the TUI (which
opencode surfaces as warning bubbles).

**Recommended dev setup** — capture audit trail to disk, keep TUI quiet:

```jsonc
"@khalilgharbaoui/opencode-claude-code-plugin": {
  "logging": { "file": true }
}
```

**Full firehose for deep debugging** (every DEBUG stream event captured):

```jsonc
"logging": { "file": true, "level": "debug" }
```

**Live TUI noise** (everything echoes to opencode's stderr → warning bubbles):

```jsonc
"logging": { "file": true, "mode": "debug" }
```

### Env-var overrides

Set explicitly to override config for one process — useful for one-off
debugging without editing `opencode.jsonc`:

```bash
OPENCODE_CLAUDE_CODE_LOG_FILE=1 opencode          # file on
OPENCODE_CLAUDE_CODE_LOG_FILE=0 opencode          # file off (overrides config:true)
OPENCODE_CLAUDE_CODE_LOG_DIR=/tmp/cc opencode     # custom dir
OPENCODE_CLAUDE_CODE_LOG_LEVEL=debug opencode     # capture every level
DEBUG=opencode-claude-code opencode               # promote to mode:"debug"
```

Boolean env vars accept `1/true/on/yes` for on and `0/false/no/off` for
off; empty / unset falls through to config. Invalid `level` values fall
through to config.

### Default behavior (no config, no env)

Nothing persists; only WARN and ERROR bubble in the TUI. The plugin
doesn't accrete a log file on every user's disk by default — opt in when
you need to inspect auto-continue decisions, broker state, or other
plugin internals.

## Compatibility with other opencode plugins

### [opencode-dcp](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) (Dynamic Context Pruning)

Partial support since v0.5.1. DCP runs in a useful degraded mode: automatic strategies and slash commands work, autonomous model-driven compression does not.

| DCP feature | Status | Notes |
|---|---|---|
| `experimental.chat.messages.transform` (compression placeholders, dedup, error purge) | ✅ Works | Transforms run inside opencode before reaching this plugin. |
| `experimental.chat.system.transform` (context-limit nudges, iteration reminders) | ✅ Works in headless | Headless spawns forward system-role content via `--append-system-prompt-file`. Interactive mode intentionally omits opencode's forwarded system prompt and keeps only this plugin's CLI/AGENTS/continuation prompt. |
| `/dcp compress`, `/dcp sweep`, `/dcp manual`, `/dcp context`, `/dcp stats` slash commands | ✅ Works | Handled by opencode's `command.execute.before` hook, not the model. |
| Automatic `deduplication` + `purgeErrors` strategies | ✅ Works | Message-transform only, no model tool calls. |
| Autonomous model-driven `compress` tool calls | ❌ Not supported | DCP registers `compress` as an opencode-native tool. Claude CLI only sees its own built-ins and MCP-bridged servers, so the model never sees `compress`. The plugin prepends a runtime note instructing Claude to ignore any system instruction that asks it to call `compress`/`distill`/`prune`. |

Workaround for autonomous compression: trigger it manually with `/dcp compress` whenever you'd want the model to call it. Full autonomous support would require exposing `compress` as an MCP-bridged tool, which is upstream of this plugin.

---

## Known limitations

- No streaming of tool inputs as they're being constructed (Anthropic's `input_json_delta`); the plugin emits them once complete.
- Raw chain-of-thought is not available. Claude 4 family models ship summarized thinking only. See [Extended thinking](#extended-thinking) for the full picture.
- Recommended Claude Code CLI: **2.1.142+**. Older CLIs work for everything else but skip the `--thinking-display` flag, so Claude Opus 4.7 turns may render empty Thinking rows. If something breaks after a Claude Code update, the CLI version is the first thing to check.
- **Subagent todos require explicit permission.** opencode's task tool gates `todowrite` per subagent: without a `permission: { todowrite: "allow" }` rule on the subagent definition, opencode injects `todowrite: false` into the tools dict and the plugin's synthetic `todowrite` emissions surface as `⚙ invalid todowrite` rows. The built-in `general` subagent denies `todowrite` by default; use a custom subagent for parallel work that needs todo visibility. Subagent todos render inline in the **subagent's** session view (navigate with the TUI's `session.child.next` / `session.parent` commands), not in the parent session's panel.

---

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun run test        # tsx --test (unit suite)
bun run build       # tsup -> dist/
```

Source layout:

```
src/
  index.ts                       # opencode plugin entry, config + provider hooks
  models.ts                      # default models + variants
  accounts.ts                    # multi-account expansion (per-account CLAUDE_CONFIG_DIR + wrapper script)
  claude-code-language-model.ts  # AI-SDK provider that drives `claude`
  message-builder.ts             # AI-SDK prompt → Claude CLI user message
  tool-mapping.ts                # Claude tool name ↔ opencode tool name mapping; internal-tool skip list
  proxy-mcp.ts                   # in-process MCP server for proxied tools
  proxy-broker.ts                # pending proxy-call broker between proxy-mcp and opencode tool execution
  mcp-bridge.ts                  # opencode → Claude --mcp-config translator
  session-manager.ts             # LRU cache of CLI subprocesses
  cli-version.ts                 # detect Claude CLI version, gate optional flags
  runtime-status.ts              # runtime introspection of opencode (MCP status, tool registry)
  logger.ts                      # DEBUG=opencode-claude-code stderr logger
  tmp.ts                         # per-plugin temp directory helper
  cleanup-stale.ts               # remove legacy unscoped install from opencode's plugin cache
  types.ts                       # public option types
  opencode-types.ts              # mirrored opencode types
```

For runtime gotchas, the v1.15.0 audit waterline, and the release flow, see [`AGENTS.md`](./AGENTS.md).

## Publishing (maintainers)

```bash
npm version patch   # or minor/major — bumps package.json + creates the tag
git push origin master --follow-tags
```

The GitHub Actions workflow at `.github/workflows/publish.yml` runs `npm publish --access public` on tag push (requires `NPM_TOKEN` secret in the repo settings — use a classic automation token so 2FA isn't required at workflow time).

## Star History

<a href="https://www.star-history.com/?repos=khalilgharbaoui%2Fopencode-claude-code-plugin&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=khalilgharbaoui/opencode-claude-code-plugin&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=khalilgharbaoui/opencode-claude-code-plugin&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=khalilgharbaoui/opencode-claude-code-plugin&type=date&legend=top-left" />
 </picture>
</a>

## License

MIT. See [LICENSE](./LICENSE).

Original work © `unixfox`. Fork modifications © Khalil Gharbaoui.
