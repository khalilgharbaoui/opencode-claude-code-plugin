---
title: 'Introduction'
description: 'What the plugin is, what it does not touch, and where everything lives.'
sidebar:
  order: 1
---

Use Claude models inside [opencode](https://opencode.ai) by driving the official **Claude Code CLI** (`claude`) as a subprocess. opencode therefore inherits whatever authentication that CLI already holds: a Claude subscription login, an API key, Bedrock, or Vertex. This plugin never reads, stores, or replays an OAuth token of its own.

- **Your CLI's auth, untouched.** Because `claude` does the authenticating, there is no subscription token here to lift and replay against the Anthropic API. That replay is what proxy-style opencode plugins do, it is a practice Anthropic has disallowed for third-party tools in 2026, and it is structurally not something this plugin can do.
- **opencode stays in charge of your machine.** Bash, Edit, Write, WebFetch and subagent dispatch are executed by opencode, behind its permission prompts and audit log, rather than by Claude Code. See [Selective tool proxy](./guides/tool-proxy.md).
- **Headless by default, on your plan's ordinary usage limits.** `claude --print` usage on a subscription plan draws from the same usage limits as interactive Claude Code; the separate Agent SDK credit Anthropic announced for June 2026 was paused before it took effect. API-key authentication bills pay-as-you-go instead. See [Billing](./billing.md).

> Maintained fork of [`unixfox/opencode-claude-code-plugin`](https://github.com/unixfox/opencode-claude-code-plugin). Published as `@khalilgharbaoui/opencode-claude-code-plugin` on npm.

## What the plugin actually does

One `claude` child process per conversation, spawned headless (`claude --print --output-format stream-json`), its output streamed into opencode as an ordinary provider response. Around that:

- Claude's own built-ins (`Read`, `Grep`, `Glob`, `WebSearch`) run inside Claude Code. `Bash`, `Edit`, `Write`, `WebFetch` and `Task` are proxied by default: Claude calls an in-process MCP tool and opencode executes it. See [Selective tool proxy](./guides/tool-proxy.md).
- Your opencode MCP servers are translated into Claude's `--mcp-config`, and your opencode skills can be staged for Claude's native `Skill` tool. See [MCP bridge](./configuration/mcp.md) and [Skill bridge](./configuration/skills.md#skill-bridge).
- Models, reasoning variants, accounts and per-agent overrides are registered as ordinary opencode provider entries. See [Models](./models.md).
- The same package serves opencode 1.x and 2.x with no config change.

## Where to go next

- New here: [Getting started](./getting-started.md).
- Comparing options: [How this compares](./comparison.md).
- Changing something: the [options reference](./configuration/options.md) and the [environment variables](./configuration/environment.md).
- Something is wrong: [Start from the symptom](./troubleshooting/symptoms.md).
