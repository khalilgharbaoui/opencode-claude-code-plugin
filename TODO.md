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
  **Superseded:** built as account failover (0.24.0; the form first actually switched in
  0.26.2). The per-agent `fallbackAccounts` shape below was not built; failover is
  account-wide and asks rather than switching silently.
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

- Dropped 2026-09-26 at the maintainer's request ("ok do it"): branch `disable-thinking`
  (tip `b80cf54`, a `disableThinking` provider option from 2026-05-29). It worked around a
  CLI bug that corrupted thinking blocks across turns (API 400 "thinking or
  redacted_thinking blocks ... cannot be modified"), last seen in August. If it returns,
  `CLAUDE_CODE_DISABLE_THINKING=1` is the switch, and the plugin already respects it.
- Dropped 2026-09-06 at the user's request: live observation of `idleProcessTimeoutMs: 900000`. The 15-minute eviction and subsequent resume remain unverified in the user's window; no test is planned.

## Backlog

Nothing queued here; the working backlog is the vault note
`opencode-claude-code-plugin/Future Features.md`.

## Deferred decisions

- 2026-09-20: The maintainer chose "later" for adding the Appical MCP project block
  to `Appical.IaC`, `Cl-nica-Aurora---Player-team`, `Manager-toolkit`,
  `NOW-player-web` and `workshop-sep-2026`.
- 2026-09-20: The maintainer chose "later" for choosing a Slack authentication
  strategy. The current global server can still pay a 30-second 1Password unlock
  timeout on startup.
- 2026-09-20: The maintainer chose "later" for completing opencode's separate,
  global Linear OAuth authentication.
- 2026-09-23: The maintainer parked `opencode-local-ollama` ("forget the
  opencode-local-ollama we will get to it later or not because it dying"). State when
  parked: it stays in the global config and cannot collide on either major (checked
  live: opencode 2.0.11 refuses to load it and its built-in Ollama provider lists the
  same models either way; 1.x has no built-in `ollama`). Release prep sits unmerged as
  local-ollama PR #1 (`release-0.1.2`, OIDC publishing); publishing it still needs the
  npm trusted publisher added on npmjs.com. The stale `v0.1.1` GitHub release is untouched.
- 2026-09-23: global plugin cleanup, done: simple-memory, gemini-auth, grok-auth and
  quota removed from `~/.config/opencode/opencode.json` (quota also from `tui.json`
  and `tui.jsonc`, backups `*.bak-20260923-195510`), and the Google and xAI logins
  deleted from opencode's `auth.json`. The unused `lmstudio` provider block is still
  in the config; nobody asked to remove it.

## Open from you

Questions the maintainer still owes an answer on. Written here the turn they are
raised, so they survive context compaction; removed when answered, done or dropped.

No pending questions.

## Parked

Nothing parked.

## In progress

- 2026-09-26: **accelerator lanes, delegated to implementor subagents** (maintainer: "maybe
  we can start delegating some of these to the implementor agent ... do the ones that will
  help us accelerate faster first"). Order and why, with measured costs and per-item token
  estimates in the vault note `opencode-claude-code-plugin/Future Features.md`, section
  "Cost calibration and weights": (1) condense AGENTS.md, 182 KB / about 45k tokens sent with
  every reply of every session; (2) split `src/claude-code-language-model.ts` (5,383 lines),
  behaviour-preserving; (3) tests for modules no test covers (`tmp.ts`, `cleanup-stale.ts`,
  and the other gaps listed in the roadmap). Lanes 2 and 3 run in parallel and leave AGENTS.md
  alone (their doc notes go in the PR body); lane 1 runs after they merge, so it condenses
  the final text. Measured baseline: tasks this week cost 12M to 29M tokens each in a
  session carrying 450k to 650k context; a fresh session is about a third of that.
- 2026-09-23: opencode 2, the checks that were not possible before release. (1) Install
  by npm name (it failed from this Mac because Aikido's age filter hid the new version): `plugins: ["@khalilgharbaoui/opencode-claude-code-plugin@0.26.0"]` failed
  with `NpmInstallFail` right after publishing, because the registry's aggregate
  packument still listed `latest: 0.24.0`; retry once it lists 0.26.0. (2) Account
  failover and the plan-mode form on V2, which need a real usage limit and a headless
  `ExitPlanMode`. (3) Permission prompts in the V2 TUI: every probe ran with `--auto`.

## Done

- 2026-09-24: **closed, not an npm bug.** The "stuck npm record" was Aikido Endpoint
  Protection on the maintainer's Mac (org-2542): its minimum-package-age policy strips
  too-new versions from the npm package document and resets `latest`, confirmed by its
  event log (it listed exactly the missing versions) and by the TLS chain ending at
  "Aikido Endpoint Protection Root CA - org-2542". npm and every user off this machine
  were fine; the support ticket was deleted unsent, the registry check removed from
  `publish.yml` (npm version print kept), and AGENTS.md corrected. The harmless `next`
  dist-tag added during diagnosis can stay, or go with `npm dist-tag rm
  @khalilgharbaoui/opencode-claude-code-plugin next`.
- 2026-09-23: **done** (v0.27.0, PR #45): the parked skill-bridge work. Merged with
  master, em dashes removed, 720 tests, measured on the real machine (14 bridged, 100
  skipped as already loaded by Claude, `herdr` answered by Claude's own copy) and
  live-verified: a turn loaded `git-archeology`, reachable only through the new roots.
- 2026-09-23: **done** (v0.27.0): `conversation_reset` is announced with a note and
  clears the index-keyed stream bookkeeping. History is deliberately not replayed.
- 2026-09-23: **done**: branch cleanup (seven merged local branches, two stale remote
  ones) and the unused `lmstudio` provider block removed from the global config
  (backup `opencode.json.bak-20260923-232635`). `publish.yml` now prints its npm
  version and warns when npm does not list a fresh release.
- 2026-09-23: **done**, shipped in v0.26.1. Proxied tool calls reached the model as
  rejected while the tool actually ran: opencode 1.18.32 aborts the provider signal of
  every step that ends in tool calls, and the plugin read that as the operator pressing
  stop. Diagnosis and the session-status test in AGENTS.md's first runtime gotcha.
- 2026-09-23: **done** (v0.26.2). A proxied call waiting on an opencode permission
  prompt was rejected at the plugin's 10-minute deadline, and the late approval then
  cancelled Claude's next call ("rejected" though nobody rejected anything). The
  deadline now extends while opencode reports the session busy. AGENTS.md, second
  runtime gotcha.
- 2026-09-23: **done** (v0.26.2), reported by the maintainer as "the switch form does
  not work failed from day 1". It never switched: opencode returns the pick inside a
  sentence the parser only recognised for the plan-approval question. Also fixed: an
  answer after an opencode restart, and the answer leaking to Claude as text on the
  next turn. AGENTS.md, third runtime gotcha. Still not tried against a real limit.
- 2026-09-23: the `appical` Claude Code login expired (CLI: "Failed to authenticate:
  OAuth session expired and could not be refreshed"; `claude-appical auth status` says
  `loggedIn: false`). Every appical turn from 19:00 failed in about 40 ms; `default` is
  fine. Fixed by the maintainer the same evening: `claude-appical auth login`, and
  `auth status` now reports `loggedIn: true`, org Appical, team plan. The follow-up
  is **done** (v0.26.3): an account the CLI reports as blocked now gets a note naming
  it with the login command, and the switch form when another account exists.

- 2026-09-23: opencode **V2 support**, alongside V1, from one package: PR #44, squash
  commit `ed815c9`, shipped in v0.26.0 with the account-failover false-rejection fix
  (`65379ea`). Per-feature live evidence for both majors is in `V2.md`.

- 2026-09-20: two lanes, account failover (PR #41) and small cleanup (PR #42), both
  merged and shipped in v0.24.0.
