---
title: 'Other opencode plugins'
description: 'What works, what degrades and what is opt-in when another plugin is loaded.'
sidebar:
  order: 8
---

## [opencode-dcp](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) (Dynamic Context Pruning)

Partial support since v0.5.1. DCP runs in a useful degraded mode: its automatic strategies and slash commands work, while its own model-facing tools do not reach the model. Model-driven compression is still available, through this plugin's opt-in [`compress` proxy](../guides/tool-proxy.md#context-compression) rather than DCP's tool.

| DCP feature | Status | Notes |
|---|---|---|
| `experimental.chat.messages.transform` (compression placeholders, dedup, error purge) | ✅ Works | Transforms run inside opencode before reaching this plugin. |
| `experimental.chat.system.transform` (context-limit nudges, iteration reminders) | ✅ Works in headless | Headless spawns forward system-role content via `--append-system-prompt-file`. Interactive mode intentionally omits opencode's forwarded system prompt and keeps only this plugin's CLI/AGENTS/continuation prompt. |
| `/dcp compress`, `/dcp sweep`, `/dcp manual`, `/dcp context`, `/dcp stats` slash commands | ✅ Works | Handled by opencode's `command.execute.before` hook, not the model. |
| Automatic `deduplication` + `purgeErrors` strategies | ✅ Works | Message-transform only, no model tool calls. |
| DCP's own autonomous `compress` / `distill` / `prune` tool calls | ⚠️ Opt-in | DCP registers those as opencode-native tools rather than through an MCP server, so the automatic MCP routing never saw them. Name one in [`proxyOpencodeTools`](../guides/tool-proxy.md#forwarding-opencodes-own-tools) and it is forwarded: `proxyOpencodeTools: ["compress"]` makes `mcp__opencode_proxy__compress` run DCP's real tool. |
| Model-driven compression through this plugin's `compress` proxy | ⚠️ Opt-in | Add `"Compress"` to `proxyTools` and the plugin exposes `mcp__opencode_proxy__compress`, which gives the model a working way to compress its own context. It is not DCP's tool and does not use DCP's strategies. See [Context compression](../guides/tool-proxy.md#context-compression). |
| DCP's `<dcp-system-reminder>` context-limit nudges when no compress tool is reachable | ⚠️ Opt-in strip | Those reminders are anchored into messages, so each one is re-sent with every message that carries it. If you run without either compress route, `stripContextReminders: true` removes them. It turns itself off as soon as a `compress` tool is proxied. |

So autonomous compression is available, and DCP's own implementation is now one of the options. Three routes, all opt-in:

- `proxyOpencodeTools: ["compress"]` forwards **DCP's** tool, which compresses opencode's transcript using DCP's strategies.
- `proxyTools: [..., "Compress"]` exposes **this plugin's** tool, which resets the Claude Code session and carries a summary into the fresh one.
- Neither, and trigger DCP by hand with `/dcp compress`.

The two compress different windows, so pick deliberately rather than enabling both; [Forwarding opencode's own tools](../guides/tool-proxy.md#forwarding-opencodes-own-tools) explains what happens if you do. With neither enabled, the plugin's appended system prompt tells Claude that no such tool exists and to ignore instructions asking for it, which is the correct answer in that case.
