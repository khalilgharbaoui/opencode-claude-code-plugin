# Deferred Checks

## Ideas

- 2026-09-06, maintainer: "maybe someday we still want to align it with plan mode of opencode maybe".
  Deferred, not scheduled. Make `permissionMode: "plan"` follow opencode's own plan/build agent
  instead of being a static provider option.

  Cheaper than it looks, and the objection that killed it the first time does not apply:
  the opencode agent is already part of the session key
  (`...::ses_...::context=["claude-code-appical","build"]`), so plan and build turns already
  run as separate `claude` processes. A Tab back to build would spawn one without the flag,
  so a coupled design is not a one-way door the way the static option is.

  What still argues against it, and what to re-check before building:
  1. `"plan"` is only a name. Users define their own agents called plan, some of which write
     plan documents into the repo, and forcing CLI plan mode would break those silently.
     Any implementation needs an explicit opt-in rather than a name match.
  2. The two disagree about how you leave. Claude Code expects an `ExitPlanMode` tool call
     that headless `--print` never offers (measured on 2.1.258, probes recorded in AGENTS.md),
     so the model searches for a tool it cannot find and narrates confusion. Re-run those
     probes first: if a newer CLI offers `ExitPlanMode` headless, this objection dies and the
     `planModeQuestion` bridge becomes reachable at the same time.
  3. It buys little for the common config. opencode's plan mode already denies its own tools,
     and `Bash`/`Edit`/`Write` are proxied by default, so the only gap it closes is Claude's
     unproxied built-ins.

  Shape if built: an explicit option (something like `planModePermission: "follow-agent"`),
  never silent coupling. Do not start this without a user asking for it.

- 2026-09-09, maintainer: "pin to appical but if limits hit switch to default is that possible?"
  Asked while designing the `dev-support` agent, which must run on the appical account for
  its per-profile MCP servers (Linear, Aikido, Sentry) but should survive that account's
  spend limit. Today it is not possible: the account is the provider, it is fixed for the
  life of the `claude` process, and a `forceModel` agent inherits whoever invoked it. When
  the limit error arrives ("You've hit your individual spend limit", resets at a stated
  time) the turn simply fails and the human restarts on the other account.

  Shape if built: an optional `fallbackAccounts: ["default"]` per agent or per provider.
  On a recognised limit error the plugin respawns the session on the next account with
  the same model, effort and cwd, and says so in the turn. Things to check first:
  1. The failover account may lack the MCP servers the run depends on; the resumed turn
     would need to re-announce its tool list, or the option should refuse to fail over when
     the tool sets differ.
  2. Session key includes the account, so a failover is a new process and loses in-process
     state; opencode's own transcript is what carries over, which is probably enough.
  3. Detection must match the CLI's limit message exactly, not any 4xx, or a transient
     error would silently move billing to another account.

## Dropped

- Dropped 2026-09-06 at the user's request: live observation of `idleProcessTimeoutMs: 900000`. The 15-minute eviction and subsequent resume remain unverified in the user's window; no test is planned.

## Backlog

- 2026-09-23, observed from inside a plugin-driven session: every proxied tool call
  (`bash`, `edit`, `write`) reaches the model as rejected ("The user doesn't want to
  proceed with this tool use", then "[Request interrupted by user for tool use]"), yet
  the tool ran and its result arrived on the next turn as `<opencode_tool_result>` text.
  So the broker is not matching the result to the pending call, the CLI is being
  interrupted, and each call costs an extra turn. Seen before and after an account
  failover switch, with opencode-dcp loaded. Start from `plugin.log` around one call:
  `abort between proxy tool boundaries`, `interrupt sent for aborted turn`, and
  `rendering opencode-side tool result as text`. Not investigated yet.

## Deferred decisions

- 2026-09-20: The maintainer chose "later" for adding the Appical MCP project block
  to `Appical.IaC`, `Cl-nica-Aurora---Player-team`, `Manager-toolkit`,
  `NOW-player-web` and `workshop-sep-2026`.
- 2026-09-20: The maintainer chose "later" for choosing a Slack authentication
  strategy. The current global server can still pay a 30-second 1Password unlock
  timeout on startup.
- 2026-09-20: The maintainer chose "later" for completing opencode's separate,
  global Linear OAuth authentication.

## Open from you

Questions the maintainer still owes an answer on. Written here the turn they are
raised, so they survive context compaction; removed when answered, done or dropped.

No pending questions.

## Parked

- 2026-09-23: the skill-bridge native-dedup work (expanded discovery roots,
  `bridgeSkipNativeSkills`, and the README/SKILL.md/AGENTS.md copy that goes with it)
  was parked mid-flight on branch `skill-bridge-native-dedup`, commit `50df301`, so
  master could be clean for the V2 lane. It is 9 files and roughly 830 lines, it is
  **not gated** (no typecheck, test or build run since the last edits), and AGENTS.md
  already describes it as offline-verified only with no live Claude session behind it.
  To resume: `git checkout skill-bridge-native-dedup`, run the full gate, then open a PR.
  Nothing is lost by leaving it there, but note the maintainer's local `file://` install
  builds from the working tree, so master builds no longer carry these changes.

## In progress

- 2026-09-23: opencode **V2 support**. The plan lives in `V2.md` and is the active lane.
  Short version: V2 is a new major of opencode, not a second API inside 1.x, and V1
  plugin implementations do not run in it at all, so this plugin disappears the day the
  maintainer's opencode moves to 2.x. The blocking capability question is answered:
  `@opencode/plugin@2.0.11` ships an undocumented `ctx.aisdk` domain whose `language`
  hook takes a `LanguageModelV3`, which is exactly what `ClaudeCodeLanguageModel`
  already is, against the same `@ai-sdk/provider` major we already depend on. Dual V1
  and V2 support from one package is officially supported and our default export is
  already the right shape.
  2026-09-23 update: built on branch `v2-support`, one package for both majors, with a
  live table per feature in `V2.md` (V2 2.0.11 and V1 1.18.32 from the same `dist/`).
  Left before release: a live check of account failover and permission prompts on V2,
  and an npm-name install after publishing.

## Done

- 2026-09-20: two lanes, account failover (PR #41) and small cleanup (PR #42), both
  merged and shipped in v0.24.0.
