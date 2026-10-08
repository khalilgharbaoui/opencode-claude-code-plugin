---
title: 'Credits'
description: 'The people behind the features you are using, and what each of them built.'
sidebar:
  order: 2
---

Made and maintained by [@khalilgharbaoui](https://github.com/khalilgharbaoui) (Khalil Gharbaoui). This plugin absorbs work from its forks directly, cherry-picked with the original authorship preserved or reimplemented with the author named in the commit, rather than waiting on pull requests. The people behind the features you are using:

| Who | What | Where |
|---|---|---|
| [@khalilgharbaoui](https://github.com/khalilgharbaoui) (Khalil Gharbaoui) | Maintainer. Everything after the first version: the opencode-side tool proxy and its broker, accounts and failover, the model registry, the background subagents, the skill bridge, the doctor and its bundle, the two-major support, the tests and the measurement discipline in `AGENTS.md`, this site. Reviews, merges and credits every contribution. | `git log --author` on this repository |
| [@dkraemerwork](https://github.com/dkraemerwork) (Dennis Krämer) | Wrote the proof of concept this plugin descends from: a provider built into opencode itself that drives the local `claude` CLI, January 2026. It closed upstream, and the first version of this plugin was built from its provider files, which is why `getClaudeUserMessage`, `compactConversationHistory`, `mapTool` and `mapToolInput` still carry its names. | [anomalyco/opencode#10097](https://github.com/anomalyco/opencode/pull/10097), [the patch](https://github.com/khalilgharbaoui/opencode-claude-code-plugin/blob/master/docs/history/opencode-pr-10097.patch) |
| [@unixfox](https://github.com/unixfox) (Émilien) | Wrote the first version of this plugin in March 2026, and with it the idea it still runs on: an opencode provider that drives the official `claude` CLI as a subprocess instead of calling the API. This repository began as a fork of that work, and its tool mapping, session manager and message builder still carry his code. | `b03fa8e` (the initial commit) and four more, to 2026-04-06 |
| [@galvani](https://github.com/galvani) (Jan Kozak) | Per-session working directory for `opencode serve`, so one server spawns each project's `claude` in the right place. Also found the stale `toolCallMap` re-emission three months before it was fixed here. | `9e02ce4`, `2238ed0` |
| [@HeikoAtGitHub](https://github.com/HeikoAtGitHub) | Stopped sending `AGENTS.md` to the model twice (opencode already forwards it). Independently diagnosed the 5-minute proxy wall. | `25260a4`, `42f426d` |
| [@bernardofortes](https://github.com/bernardofortes) (Bernardo Fortes) | `idleProcessTimeoutMs`, idle eviction of retained `claude` workers. | `a5f723a` |
| [@broskees](https://github.com/broskees) (Joseph Roberts) | Task proxy default-on (PR #18), the abort `interrupt` so Esc really stops the CLI, the skill bridge, `task_batch` for concurrent subagents (and the measurement that the CLI serialises MCP calls), the undici 300 s diagnosis of the proxy wall, the lifecycle release of proxied calls that made the `task` deadline unnecessary (PR #36), Claude Opus 5.5 with its fast-mode entry (PR #43), and the fix for turn-summed usage that made opencode auto-compact far below the window (PR #63). | PR #18, `68ed142`, PR #36, PR #43, PR #63 |
| [@jknlsn](https://github.com/jknlsn) (Jake Nelson) | Per-tool proxy timeouts, subagent dispatch steering, the question proxy, the start watchdog respawn. | `84f3db9`, `94980a6`, `47501d0`, `ffefc24` |
| [@CollieIsCute](https://github.com/CollieIsCute) (Collie Tsai) | The plan-mode approval bridge. | `8c5b583` |
| [@flupkede](https://github.com/flupkede) | The compress proxy tool design and the AI-SDK v4 image-part fix. | `4ac319f`, `60a6e9a` |
| [@CNQQC](https://github.com/CNQQC) | Cost units corrected to dollars per million tokens (PR #25). | PR #25 |
| [@willmcginnis](https://github.com/willmcginnis) | The proxy endpoint authentication (PR #28, GHSA-3mxm-w7gf-3c5x). | PR #28 |
| [@nic-lan](https://github.com/nic-lan) (Nicolas Languille) | The issue #29 diagnosis of subagent output lost across the CLI resume boundary, the fix for unattended output replaying as one text block per delta (PR #35), and `bridgeMcpOauthTokens`: giving a bridged remote MCP server the OAuth token opencode already holds, so a server the operator authenticated in opencode stops reporting `needs-auth` to the Claude CLI for the whole session. | #29, PR #35, `5001cff` |
| [@hmjBill](https://github.com/hmjBill) | Two precise reports from real long sessions: a usage-limited compaction stored the CLI's limit sentence as the conversation summary (issue #90), and an effort or model change, a restart or a crash dropped the Claude session into a lossy transcript replay (issue #91). | #90, #91 |
| [@acastro2](https://github.com/acastro2) (Alexandre Castro) | Found and fixed CLI tool results being emitted under a different name than their call, which made opencode 2 abort every turn that used a Claude-side MCP server (PR #46). | PR #46 |
| [@bangnh1](https://github.com/bangnh1) | Independently found and diagnosed the turn-summed usage that tripped auto-compaction after a single prompt, measured on opencode 2 (PR #62; the fix landed as PR #63), and fixed opencode 2's MCP config layout (`mcp.servers`, `disabled`, `providers.<id>.settings`) with opt-in Code Mode `execute` proxying (PR #67). | PR #62, PR #67 |
| [@JWebCoder](https://github.com/JWebCoder) (joao moura) | Diagnosed that auto-continue never fires on current CLIs (PR #15). | PR #15 |
| [@internetisalie](https://github.com/internetisalie) (Michael Crawford) | Found and fixed, each measured over days of real transcripts, two ways a proxied tool call went wrong: a session in another workspace read as idle, so opencode's routine abort at a tool boundary rejected the call and told the model the user had interrupted it (PR #89), and user messages opencode promoted beside a tool result (background-PTY notices, steered prompts) never reached the CLI (PR #88). | PR #88, PR #89 |

Commit hashes are on the contributors' forks where the work was cherry-picked; `git log --author` on this repo shows the preserved authorship.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=khalilgharbaoui/opencode-claude-code-plugin&type=Date)](https://www.star-history.com/?repos=khalilgharbaoui%2Fopencode-claude-code-plugin&type=date&legend=top-left)
