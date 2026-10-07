---
title: 'Compaction and thinking'
description: 'How /compact is run, and how Claude''s summarized thinking reaches opencode.'
sidebar:
  order: 6
---

## Compaction

Compaction uses the selected `transport`. With `transport: "auto"`, a CLI that definitively lacks the required headless flags uses a fresh interactive TUI instead. That TUI has no built-in tools, MCP servers, proxy, skill bridge or resumed session. The transcript and summary instructions are submitted as text, and the process is closed after its answer. The default remains headless.

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

## Extended thinking

The plugin forwards Claude's thinking blocks (`thinking_delta` stream events) to opencode as reasoning parts, so the "Thinking" row in the chat panel shows whenever the model uses extended thinking. This works across every Claude 4 family model the CLI supports.

What you see is a **summary** of the model's thinking, not the raw chain-of-thought. Anthropic [stopped exposing raw thinking on the Claude 4 family](https://platform.claude.com/docs/en/build-with-claude/extended-thinking#summarized-thinking) and ships a server-generated digest instead. For Claude Opus 4.7 specifically, [thinking content is omitted from responses by default](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7#thinking-content-omitted-by-default); the plugin opts back in by passing `--thinking-display summarized` on every spawn. Claude Code CLI 2.1.142+ is required for that flag to take effect; older CLIs skip it silently.

### Reasoning effort

Each model exposes five picker variants, `low` / `medium` / `high` / `xhigh` / `max`. An agent's own `reasoningEffort` frontmatter accepts six values: those five plus `minimal`, which maps to the CLI's `low`. The plugin hands the level to the CLI as `CLAUDE_CODE_EFFORT_LEVEL` at spawn, which Claude Code treats as the session-wide override: it beats the `effortLevel` in that account's `settings.json` and a shell export of the same variable. Effort is fixed for the life of a `claude` process, so it is part of the session key. Changing effort retires the previous effort's process, but not the conversation: the Claude session is carried over to the new effort's key and the fresh process resumes it with `--resume`, so the thread is not replayed as text. It is a move, not a copy, so switching back carries it again rather than resuming anything stale; same-effort streaming turns still reuse their process. Set `resumeAcrossModelChanges: false` to go back to replaying. This reset is scoped to the same directory, model, provider/account, agent, and conversation. If the previous effort still has pending work (including tool results, plan approval, recovery, or `/btw`), the switch is rejected: finish that work at its original effort first. Title, compaction, and `/btw` calls do not trigger effort resets.

Earlier versions injected a thinking keyword such as `(ultrathink)` into the user message instead. Claude Code stopped recognising every keyword except `ultrathink`, so that path is gone and nothing is appended to your messages any more. Compaction skips request and agent effort overrides, but still inherits a shell-level `CLAUDE_CODE_EFFORT_LEVEL` when set.

### Env-var overrides

The plugin respects the standard Claude Code thinking env vars. If you set them in your shell, they pass through to the spawned process untouched, with the one exception in the first row.

| Env var | Effect |
|---|---|
| `CLAUDE_CODE_EFFORT_LEVEL=<level>` | Session effort override. Passes through when no effort was requested; a variant or an agent's `reasoningEffort` replaces it for that spawn. |
| `CLAUDE_CODE_PROMPT_CACHE_TTL=5m\|1h` | Prompt cache TTL for the whole machine. Passes through when no agent asked; an agent's `cacheTtl` or `defaultSubagentCacheTtl` replaces it for that spawn. |
| `CLAUDE_CODE_DISABLE_THINKING=1` | Disable thinking entirely. |
| `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` | Disable adaptive thinking only. |
| `CLAUDE_CODE_SHOW_THINKING_SUMMARIES=0` | Suppress summaries (the plugin sets this to `1` by default when unset). |
