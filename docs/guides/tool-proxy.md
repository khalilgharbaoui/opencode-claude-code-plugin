---
title: 'Selective tool proxy'
description: 'Choose, per tool, whether Claude Code or opencode executes it.'
sidebar:
  order: 1
---

This is the core feature.

By default, the plugin proxies `Bash`, `Edit`, `Write`, `WebFetch`, and `Task`. It disables Claude's corresponding built-in tool and exposes an equivalent through an in-process MCP server. Claude calls the MCP version, which blocks until opencode runs the tool through its own executor and permission system.

## Default proxied tools

| `proxyTools` value | Claude built-ins disabled | Proxy MCP tool exposed |
|---|---|---|
| `"Bash"` | `Bash` | `mcp__opencode_proxy__bash` |
| `"Edit"` | `Edit`, `MultiEdit` | `mcp__opencode_proxy__edit` |
| `"Write"` | `Write` | `mcp__opencode_proxy__write` |
| `"WebFetch"` | `WebFetch` | `mcp__opencode_proxy__webfetch` |
| `"Task"` | `Agent` | `mcp__opencode_proxy__task`, `mcp__opencode_proxy__task_batch`, and on a host that runs background subagents `mcp__opencode_proxy__task_status`, `mcp__opencode_proxy__task_cancel` |
| `"Question"` | `AskUserQuestion` | `mcp__opencode_proxy__question` |
| `"Compress"` | none | `mcp__opencode_proxy__compress` |

## OpenCode-native subagents

`Task` is proxied by default. The proxy disables Claude CLI's `Agent` tool and emits an unexecuted `task` call; it does not register a replacement task tool. OpenCode's built-in TaskTool remains responsible for permission checks, creating or resuming the child session, selecting the configured subagent, and foreground/background lifecycle.

- **Permissions:** the calling agent's `permission.task` rule applies to the target `subagent_type`. Grant `task: "allow"` on agents that should delegate without a prompt; an `ask` or `deny` rule remains authoritative. The plugin never bypasses this decision.
- **Resume:** pass the child session ID back as `task_id` to continue that subagent session. Omit it to create a fresh child.
- **Nested tasks:** current opencode defaults `subagent_depth` to `1`, so a first-level child cannot launch another child. Increase top-level `subagent_depth` to permit deeper nesting, and explicitly grant `permission.task` on every subagent that should delegate; opencode otherwise adds a task deny to spawned subagent sessions.
- **Background:** see [Background subagents](../guides/background-subagents.md) below. Foreground is the default.
- **Several at once:** `mcp__opencode_proxy__task_batch` takes a `tasks` array of ordinary task inputs and runs them concurrently. It exists because Claude Code sends MCP requests one at a time: when the model emits two `task` calls in one response, the second only leaves the CLI after the first has returned (measured live, 2026-09-06), so "launch two subagents" was always serial. The plugin turns one `task_batch` call into N opencode `task` calls inside a single tool boundary, which opencode executes in parallel, then hands the model every result together, labelled in task order. Same permissions, same no-deadline default, same `subagent_type` list. Enabled whenever `Task` is proxied. Designed and first implemented by [@broskees](https://github.com/broskees) on his fork.

**Steering models to it.** Headless Claude Code CLIs expose no `Agent`/`Task`
dispatch tool of their own (verified on 2.1.211), while they *do* expose
`TaskCreate`, a todo tool. So "use a subagent" requests get mis-resolved:
a todo appears, nothing runs, and the model may still narrate a successful
dispatch. Two spawn-time countermeasures prevent that. The plugin injects
opencode's live agent-type list into the `task` proxy description (so the model
picks a real `subagent_type` instead of guessing a Claude Code name like
`general-purpose`, and doesn't grep configs to check a subagent exists), and
appends a system-prompt note naming
`mcp__opencode_proxy__task` as the only dispatch path, with the ToolSearch
recovery step for harnesses that defer MCP tool schemas. Both apply per Claude
process at spawn, and provider options are read once at opencode startup, so
`proxyTools` changes need a full opencode restart.

Two neighbours of this section live elsewhere now: dispatching a subagent without blocking the
conversation is [Background subagents](./background-subagents.md), and the proxy's own HTTP
endpoint and the files it writes are
[Scratch files and security](../internals/scratch-files-and-security.md).

## Closing a tool with no proxy

`proxyTools` only reaches built-ins the plugin can replace. A built-in with no opencode equivalent, `NotebookEdit` today and whatever Claude Code ships next, stays enabled and unmediated no matter what you put in that list. `extraDisallowedTools` names them directly:

```json
"options": {
  "extraDisallowedTools": ["NotebookEdit"]
}
```

These go straight to `claude --disallowedTools`, so use Claude's tool names rather than opencode's. There is no replacement: the capability goes away rather than being routed through opencode, which is the point, but the model then has to work without it.

Unknown entries in `proxyTools` are logged as a warning at spawn rather than passing silently, so a typo shows up as "ignoring unknown proxyTools entries" in the plugin log instead of quietly leaving the matching built-in unmediated.

## Context compression

`"Compress"` is off by default. Add it when you run a harness that expects the model to manage its own context (opencode-dcp injects exactly those instructions), and the plugin exposes `mcp__opencode_proxy__compress`:

```json
"options": {
  "proxyTools": ["Bash", "Edit", "Write", "WebFetch", "Task", "Compress"]
}
```

It is the one proxy tool opencode never sees. The call is answered inside the plugin: the model passes a `summary`, the plugin stores it, and the turn continues normally. At the start of the **next** turn the Claude Code session is discarded and a fresh `claude` starts with that summary prepended to its system prompt, and nothing else. The earlier conversation is not replayed, so a thin summary means real lost context. The reset waits if the incoming turn is carrying tool results for the running process.

Without it, the appended system prompt tells the model that `compress` is unavailable and to ignore instructions that ask for it, which is the right answer when nothing implements it.

The round trip is verified live (Claude Code 2.1.263, opencode 1.18.31, haiku): the model called `mcp__opencode_proxy__compress` with a build identifier in its summary, the plugin logged `compress stored summary; session resets next turn`, the next turn logged `compress reset: dropped claude process and session id` and spawned a second `claude`, and that fresh process answered with the identifier it could only have read from the summary in its system prompt. Re-run unchanged on Claude Code 2.1.288 and opencode 1.18.35 (2026-10-07), with the summary confirmed at the top of the new spawn's appended system prompt under `## Summary of earlier work (context was compressed)`.

Only those seven values are actually proxied; anything else you put in `proxyTools` is ignored. Proxying `Edit` also disables `MultiEdit`, because opencode has no batched-edit equivalent, so Claude is forced to fan out into single `Edit` calls that each flow through the permission UI. The `"Question"` proxy is version-gated on opencode's built-in `question` tool: on builds that lack the registry entry the def is silently dropped (a forwarded call would otherwise render as `⚙ invalid`), so add it only on opencode versions that ship the `question` tool.

Without `"Task"` in `proxyTools`, Claude's built-in `Agent` tool stays enabled and Claude orchestrates subagents internally with no opencode child-session visibility. To opt out of all proxying, including Task, use an explicit empty list:

```json
"options": { "proxyTools": [] }
```

## Forwarding opencode's own tools

`proxyTools` names the tools this plugin ships defs for, and MCP-backed opencode tools can be routed with [`proxyOpencodeMcpTools`](../configuration/options.md). Neither covers a tool that **another opencode plugin declares directly**: it belongs to no MCP server, so the automatic match (`<server>` or `<server>_<tool>`) skips it and the model is never offered it. opencode-dcp's `compress` is the case that matters in practice, because DCP then injects "MAX CONTEXT LIMIT REACHED ... You MUST use the `compress` tool now" reminders that the model has no way to act on.

`proxyOpencodeTools` is the explicit allowlist. Empty by default:

```json
"options": {
  "proxyTools": ["Bash", "Edit", "Write", "WebFetch", "Task"],
  "proxyOpencodeTools": ["compress"]
}
```

Names are opencode's tool ids as `client.tool.list()` reports them, matched case-insensitively. An unknown name is skipped with a warning rather than failing the spawn. Forwarded tools use the same broker as every other proxy tool, so [how a proxied call ends](../internals/how-a-proxied-call-ends.md) applies to them unchanged: abort, orphan sweep, session deletion and child exit all release them.

This is deliberately not automatic. A forwarded tool executes inside opencode with the calling agent's permissions, so which ones cross over is your decision, not the plugin's.

**The `compress` name collision.** Two different tools want it: DCP's, which rewrites opencode's transcript, and [this plugin's](#context-compression), which resets the Claude Code session. They compress different windows, and after a DCP compress the live `claude` process still holds its full context until something restarts it. If you enable both, the plugin's own tool keeps the name and the forwarded one is dropped with a warning in the log:

```
WARN: proxyOpencodeTools entry dropped: a proxy tool already holds that name, and it keeps it {"collided":["compress"]}
```

Pick one. The appended system prompt describes whichever is actually reachable, so the model is told the right semantics either way.

Verified live on Claude Code 2.1.263 and opencode 1.18.31 with DCP loaded: the plugin logged `forwarding opencode tools through the proxy {"tools":["compress"]}`, started the proxy with `tools: ["bash","compress"]`, received `proxy-mcp tool call received {"toolName":"compress"}`, queued it through the normal broker, and DCP really ran, returning `Compressed 3 messages into [Compressed conversation section]`. One wrinkle worth knowing: DCP's compress rewrites opencode's message history mid-turn, which makes opencode abort the provider stream at that tool boundary. The pending call is released normally and the result still reaches the model on the next step as text, so the turn completes, but you will see one `abort between proxy tool boundaries` line in the log each time.

## Trimming unsatisfiable context reminders

DCP anchors its nudges into message text as `<dcp-system-reminder>` blocks, so each one is re-sent with every message that carries it. If no `compress` tool is reachable they are an order the model cannot follow, and the plugin already tells it to ignore them. `stripContextReminders: true` stops paying for them too:

```json
"options": { "stripContextReminders": true }
```

Off by default. It removes those blocks from user and assistant text before the transcript reaches the CLI, including the fresh-session rebuild, where every anchored reminder would otherwise replay at once. It leaves opencode's own `<system-reminder>` blocks alone: those are opencode's instructions to the model, not an unsatisfiable order.

It switches itself off whenever `compress` is named in `proxyTools` or `proxyOpencodeTools`, since the reminder is then something the model can act on. The check is on configuration, so a name that is configured but missing from opencode's registry still counts as reachable and nothing is stripped, which errs toward keeping the reminder.

## What you get with proxying on

- opencode's **permission prompts** for every Bash/Edit/Write/WebFetch call. The default `--dangerously-skip-permissions` is still passed to `claude`, but it only governs Claude's own built-in tools; a proxied call is executed by opencode and answers to opencode's rules instead. Built-ins that are neither proxied nor listed in `extraDisallowedTools` do run under that flag.
- opencode's **audit log** captures the calls.
- Per-tool **policy rules** in opencode apply.

## What you give up

- A small per-call latency hop through `127.0.0.1:<random>/mcp`.
- Batched-edit ergonomics: with `Edit` proxied, Claude can no longer use `MultiEdit`, so a refactor that would have been one tool call becomes N single `Edit` calls.
- **One extra Claude Code API call per `claude` process**, and it is a `ToolSearch`. A proxied tool reaches the model as an MCP tool, and Claude Code 2.1.280 defers MCP tools behind its own `ToolSearch` tool, so before the first proxied call of a session the model spends one request finding the tool. Claude's built-in `Bash` is never deferred, so an unproxied tool goes straight to the call.

  Measured on 2.1.280 with `claude-haiku-4-5`, three runs a side, one `echo` command: 3 CLI API calls with `Bash` proxied against 2 with the CLI running it, and roughly twice the cache reads. It is paid **once per process, not once per call**: the same task with two sequential commands measured 4 calls against 3, with a single `ToolSearch` either way. It is also not a function of how many tools you have, since a run with `strictMcpConfig: true` and 28 tools still spent it. Setting `ENABLE_TOOL_SEARCH=0` does remove it, and costs far more than it saves (all ~164 tool definitions then sit in every prompt, which measured 2.5 to 4 times the total cost and tripped a compaction), so that is not a fix and the plugin does not do it. `ToolSearch` is one of Claude's internal tools, so you never see the call, only the cost. Full numbers: `docs/agents-history.md` under `#g166`.

## Per-tool proxy timeouts

Read [How a proxied call ends](../internals/how-a-proxied-call-ends.md) first: a deadline is a
backstop on top of the events that actually end a call, not the thing that decides it.

Deadlines still exist, as an explicit backstop rather than the mechanism that decides when a call is over. If a tool with one has not been resolved within that many milliseconds, the call is rejected and Claude receives a timeout error.

A deadline does not count time opencode is still spending on the call. When it passes, the plugin asks opencode whether the session is still busy. If it is (a permission prompt waiting for your answer, or the tool itself still running), the call keeps waiting and is checked again every minute. The deadline only applies once opencode is idle, or when opencode cannot be asked. Before this, answering a permission prompt after ten minutes meant Claude had already been told the command timed out. Your late approval then cancelled Claude's next action, which it reported as you rejecting it. Resolved per tool, most-specific layer winning:

1. flat default, 10 min (matches Claude CLI's own Bash ceiling)
2. per-tool default: **`task` / `task_batch`: none**, **`question`: 30 min**, everything else: 10 min
3. your `proxyToolTimeoutMs` override (case-insensitive key; a positive value replaces the default, `0` removes the deadline, anything else is ignored)
4. for `bash` only, the call's own `input.timeout`: the proxy never undercuts a build the caller explicitly asked to run long (`max(resolved, input.timeout)`), and a positive `input.timeout` restores a deadline that `bash: 0` removed

`question` keeps 30 minutes because it blocks on a human reading a form, and a form nobody answers is not an event. A positive `task` override restores a wall-clock backstop for operators who want one; if it fires, the error tells Claude not to "schedule a wake-up": that is a Claude Code affordance which cannot fire in this headless/proxy context, so deferring silently loses the work.

Two watchdogs are a different thing again and are unchanged: the start watchdog (90 s of complete silence after a turn is written, respawn then error, see `CLAUDE_CODE_START_WATCHDOG_MS`) and the wire-inactivity watchdog (60 s of silence after content, see `CLAUDE_CODE_RESULT_FALLBACK_MS`; when it fires the reply gets a `▌ **stream timeout:**` note so the turn does not just stop). Those exist because a process that is alive but wedged emits no event to listen to, and a proxy call is never what they are waiting on: a CLI parked inside a proxied tool is producing nothing on purpose, and both watchdogs know that.

If Claude nevertheless abandons the HTTP call, the plugin preserves narration emitted while opencode was running the tool, renders it on return, and delivers the late completion as a plain-text continuation naming the original call. It tells Claude not to run the tool again. A silent post-tool continuation gets one resumed-process retry, preserving the original model, account, effort, and proxy configuration; a second failure ends with an error rather than an indefinite hang. Buffered narration is capped at 500 lines and 2 MiB, with a warning if output was dropped.

```json
"options": {
  "proxyTools": ["Bash", "Edit", "Write", "WebFetch", "Task"],
  "proxyToolTimeoutMs": { "Task": 5400000, "bash": 1800000 }
}
```

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
- Some Claude-specific tool features stay on the built-in side (notably `MultiEdit`, see the note above).
