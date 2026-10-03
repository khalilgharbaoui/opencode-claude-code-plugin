---
title: 'Development'
description: 'Build, typecheck and test the plugin from a checkout.'
sidebar:
  order: 6
---

```bash
bun install
bun run typecheck   # tsc --noEmit
bun run test        # tsx --test (unit suite)
bun run build       # tsup -> dist/
```

Source layout, grouped by what each file owns. `AGENTS.md`'s "Project Shape" is the
authoritative version of this and explains why several of these files exist at all.

```text
src/
  index.ts                       opencode 1.x entry: config, provider and command hooks
  v2.ts                          opencode 2.x entry (setup), registered only on a V2 host
  v2-client.ts                   answers live-state calls in 1.x shapes on a V2 host
  opencode-types.ts              hand-written mirror of the opencode 1.x API slice
  opencode-v2-types.ts           the same for opencode 2.x
  host-tools.ts                  renames tool calls into opencode 2's vocabulary
  types.ts                       public option types

  models.ts                      the registered models, their limits and their costs
  agent-models.ts                per-agent model, effort and cache TTL resolution
  model-fallback.ts              the fallback model chain
  accounts.ts                    multi-account expansion and the per-account wrapper script
  account-failover.ts            the usage-limit note, the opt-in switch form and the override
  fast-mode.ts                   the -fast markers and the downgrade warning

  claude-code-language-model.ts  the AI SDK provider class
  turn-state.ts                  the per-turn state object
  turn-controller.ts             watchdogs, late results, the drain, the auto-continue nudge
  turn-abort.ts                  the one watch on this turn's abort signal
  stream-parser.ts               the CLI's stream-json lines to AI SDK parts
  spawn-planning.ts              proxy defs, MCP config, the skill and plan-mode gates
  call-options.ts                session affinity, agent, compaction model
  message-builder.ts             AI SDK prompt to Claude CLI stream-json messages
  prompts.ts                     the appended system prompt
  auto-continue.ts               the continue-or-stop decision
  usage.ts  title.ts  ids.ts     usage accounting, the title stub, local id generation

  session-manager.ts             the LRU of claude subprocesses, session ids, CLI args,
                                 and claudeSpawnEnv (hygiene vars, API-key stripping)
  session-fork.ts                whether a new opencode session forks one already served
  cli-version.ts                 version probe and the optional-flag gates

  proxy-mcp.ts                   the authenticated in-process MCP server
  proxy-broker.ts                the pending-call broker and its deadlines
  proxy-results.ts               reading opencode's answer back out of the next prompt
  control-request.ts             can_use_tool allow/deny
  tool-mapping.ts                Claude tool names to opencode's, and the skip list
  todo-ledger.ts                 Claude's Task* family to opencode's todowrite
  background-tasks.ts            task_status and task_cancel
  compression-store.ts           the opt-in compress proxy tool's summaries
  ask-user-question.ts           AskUserQuestion rendering and its deny message
  plan-mode-question.ts          the ExitPlanMode approval bridge
  permission-presets.ts          the read-only posture, applied at three layers

  mcp-bridge.ts                  opencode's MCP config to Claude's --mcp-config
  mcp-hot-reload.ts              respawn when the bridged servers changed
  skill-bridge.ts                staging opencode skills as a throwaway Claude plugin
  runtime-status.ts              introspection of opencode (MCP status, tool registry)

  logger.ts                      the plugin's own logger
  cli-events.ts                  the CLI's stream events, parsed and reported
  startup-diagnostics.ts         the one "plugin ready" block per process
  doctor.ts                      /claude-code-doctor
  diagnostic-bundle.ts           the allowlist redactor behind its bundle form
  log-messages.ts                the generated message allowlist that redactor uses
  log-message-scan.ts            the extractor that generates it (never on a turn path)
  plan-usage.ts                  /claude-code-doctor usage, the CLI's own /cost
  turn-stats.ts                  the optional per-turn cost footer
  side-question.ts  btw-command.ts  the /btw control request and its command

  claude-session-bun.ts          the experimental interactive transport under a Bun PTY
  claude-session-wrapper.ts      its ActiveProcess-shaped shim
  bun-terminal.d.ts              its type declarations

  tmp.ts                         the per-process 0700 scratch directory
  cleanup-stale.ts               removing a stale unscoped install from opencode's cache
```


For runtime gotchas, the release flow, and the compatibility audit (last taken against **opencode 1.18.29**), see [`AGENTS.md`](../../AGENTS.md). The evidence behind every rule there is in [`docs/agents-history.md`](../agents-history.md).

## Local development

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

CI installs and builds on **Node 24** (`.github/workflows/publish.yml`), which is the only version this package is built against. `package.json` declares no `engines` range, so older Node versions are untested rather than deliberately unsupported. opencode itself may run under Bun; the [interactive transport](../guides/interactive-transport.md) requires that.
