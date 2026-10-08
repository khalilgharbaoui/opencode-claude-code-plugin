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

- Dropped 2026-10-07 at the maintainer's request: the GitHub fork-network detach (Support ticket
  #4818005). Maintainer: "forget the network detach also they are not going to do it i got mail".
  The repository stays a fork of unixfox/opencode-claude-code-plugin.
- Dropped 2026-10-07 at the maintainer's request: restarting the opencode windows still on an older
  plugin build (Herdr `wA:p4`, `wA:pK`, pid 14428). Maintainer: "forget the old windows ill deal with
  them later".
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

Only decisions about this plugin belong here. Items about the global opencode config
(Slack MCP auth, opencode's Linear OAuth, the unused `lmstudio` block) and the separate
`opencode-local-ollama` package were moved on 2026-09-28 to the vault note
`opencode/Open items.md`; they were recorded here only because the sessions that raised
them ran in this directory.

## Open from you


Questions the maintainer still owes an answer on. Written here the turn they are
raised, so they survive context compaction; removed when answered, done or dropped.

- 2026-10-08: maintainer: "yes do that please because the startup confuses (an keep this experimental
  thing on i like it its non blocking and freeing.. just need to know how many agents are working at a
  time to not overload)". Background subagents stay on. Found: a new `claude` waits up to ~30 s for MCP
  servers; `slack` (`op`) and `obsidian` (`zsh`) never connect in a subagent's spawn. They are bridged to
  it directly only because opencode gave `explore` no MCP tools. Maintainer: "both are good indeed but
  when subagents do need some MCPs they will be get them right?" (yes: allowed servers stay proxied).
  In progress, one lane: per server, do not bridge a server opencode has connected but withheld from
  this agent (keep the fallback for servers opencode itself is not running); doctor shows how many
  background subagents are running.
- 2026-10-08: switching the daily driver to opencode 2. Nothing in the plugin or Moshi blocks it now;
  remaining: herdr-agent-state.js (no V2 version, cosmetic), notify becomes cli.json `attention`, plugin
  path must end in `/dist`, drop `compaction.prune`. Awaiting the maintainer's decision.
- 2026-10-08: maintainer: "is it now ok to daily drive opencode 2?" Answered: this plugin yes (core
  verified on 2.0.22), but the maintainer's other plugins are V1-only (opencode-dcp, notify.ts,
  opentmux, opencode-local-ollama, herdr-agent-state, moshi-hooks) and V1 plugins do not run in V2;
  the V2 installer replaces the V1 binary. Offered: live-check accountGroups, the by-hand account carry
  and subagentDispatch on 2.0.22 (scripted CLI), and a V2 config dry run in the sandbox. Maintainer:
  "prep now and decide after". Prep **done** (v0.53.1): the three newest features pass live on 2.0.22
  after one fix (the dispatch choice never reached a V2 child, PR #108, h #g229); the config dry run
  is in `~/opencode-v2-sandbox/migration-dryrun/REPORT.md` (config runs as is with the plugin path
  ending in `/dist` and `compaction.prune` dropped; dcp is V2-ready; notify.ts, moshi-hooks.ts,
  opentmux, herdr-agent-state have no V2 version; ollama is built into V2; rollback is
  `VERSION=1.18.35 curl -fsSL https://opencode.ai/install | bash`). Awaiting: the switch decision.
- 2026-10-08: "what is next?" (1) **done**, maintainer picked "1": Claude Code 2.1.293 installed,
  measured on both transports and majors, Haiku 5.5 added, golden transcripts recorded, v0.49.0
  (PR #101, h #g222). (2) **done**, maintainer: "1 now": fork sweep of all
  27 forks, v0.50.0 (PR #102, #103; h #g223, #g224): @nic-lan's MCP OAuth bridge taken as opt-in
  `bridgeMcpOauthTokens`, @bangnh1's replay clipping taken, the rest declined with reasons. Still
  open: (3) optional: a Linux CI job for
  the whole suite, an MCP elicitation round trip into an opencode form. Needs the maintainer: a
  second non-work login, for a live two-account switch and an expired-login switch.
## Parked

Nothing parked.

## In progress

Nothing in progress.

## Done

- 2026-10-08: **done**: "let try it you set zshrc and ill restart". `export
  OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` added to `~/.zshrc` (beside the plugin's log-file
  line), so opencode 1 offers background subagents and the plugin registers task_status and task_cancel
  after a restart from a new terminal. Remove the line to switch it off.
- 2026-10-08: **done** (v0.53.2): "do we need a new release? what about the background agents etc?" then
  "ok go". Background subagents re-verified live on 2.0.22 (gate, background dispatch and push,
  task_status once, task_cancel and its parent guard, a background dispatch through subagentDispatch,
  the doctor). One fix: the `background` field and the background hint described opencode 1's envelope
  to an opencode 2 model (PR #109, h #g230). Not your opencode 1: background subagents are off there
  unless `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`.
- 2026-10-08: **done**: "port these and lets see what is next", then "go". No hand port was needed.
  Moshi upgraded 0.3.22 -> 0.4.21 (brew), daemon restarted (same host id, gateway up), opencode hook
  regenerated: one `moshi-hooks.ts` serving opencode 1 and 2 plus `moshi-hooks-tui/`; proven against a
  fake socket on scratch 1.18.35 and 2.0.22; Claude Code and Gemini settings byte-identical; backup in
  `~/.config/opencode/plugins.bak-moshi-0.3.22-20261008-150344/`. notify: retired upstream, replaced on
  opencode 2 by `attention` in cli.json (`~/opencode-v2-sandbox/migration-dryrun/cli.notify.json`).
- 2026-10-08: **done**: "does this add any value now opentmux ?" then "remove it". tmux is not installed and
  opencode runs in Ghostty under Herdr, so opentmux never had a session to open panes in; removed from
  the `plugin` list in `~/.config/opencode/opencode.json` (takes effect on the next opencode start).
- 2026-10-08: **done**: "maybe yes add the Linux CI Job now.. but also allow me to [skip-ci] to skip it
  ... and park the MCP thing for now". `ci-linux.yml` runs install, typecheck, `npm test` and build on
  every push to master and every PR (first run: 1,505 / 1,505); `[skip-ci]` in the commit message or PR
  title skips it and the Windows job, never the publish (PR #107). MCP elicitation as a form parked in
  Future Features. opencode 2: core verified on 2.0.22 (h #g222); account groups and the subagent
  dispatch form are unit-tested there but were run live on 1.18.35 only.
- 2026-10-08: **done**: "ok all this stuff provides more controle right? is that said on the site? also
  the site on mobile needs also to play those interactive parts". Landing: the "what it does" lead now
  says you choose account, model, effort and subagent runs; the accounts and subagents cards describe
  one conversation across accounts, `accountGroups` and `subagentDispatch`. The turn replay already
  played on iPhone Safari and Android Chrome (measured, Playwright WebKit and Chromium); it stood still
  only under Reduce Motion, by design. It now plays there too, line by line with no fade, rise or blink,
  pause and replay visible. Site build and link check green.
- 2026-10-08: **done** (v0.53.0): "make that also possible account choice per agent type ... same as
  last time should persist during that session ... restart or no restart should follow the session".
  `Per type…` on the dispatch's Account row, `@<account>` in a typed answer for one task, and the last
  choice persisted per opencode session (PR #106, h #g228). Live on 1.18.35 with a fake CLI, including
  a server restart. 1,505 tests.
- 2026-10-08: **done** (v0.52.0): "go for 1 ... allow distinction if agent type is diffrent ... one
  implementor to be more powerfull than the rest ... design this thoughtfull and carefully". Opt-in
  `subagentDispatch: "ask"`: one question first, then per type (plus account), then per task; account
  same-group only unless `subagentDispatchCrossGroup` (PR #105, h #g227). Live on 1.18.35 with a fake
  CLI; not live on 2.x or the PTY. Both open decisions were changed in v0.53.0.
- 2026-10-08: **done** (v0.51.0): "if i have a conversatiin in claude ... switch to claude-appical and
  continue", then "lets build the guard and make it optional ... mark which account is work account".
  A by-hand account switch now carries the conversation like a model change, and `accountGroups`
  (off unless set) keeps it inside a group; across groups nothing is sent, not even a replay
  (PR #104, h #g226). Live on 1.18.35 with a scratch second account. 1,430 tests.
- 2026-10-07: **done** (v0.46.1): Windows spawns through `cmd.exe` with no argument quoting
  (open since 2026-09-26). Fixed with a resolver and doubled-quote escaping, verified by the
  Windows CI job (PR #95, h #g217); `accounts` on Windows followed in v0.48.0 (h #g221).
- 2026-10-07: **done** (v0.46.1, v0.47.0, v0.48.0): "then carry on with the rest of the rest untill nothing is left use 2 lanes". Plan, two
  lanes per batch, each item built or closed with a measured reason:
  (1a) interactive transport reads only the appended transcript bytes; (1b) Windows spawn quoting,
  with a Windows CI job to verify it (the item was blocked only on a runner; GitHub Actions has one).
  (2a) cross-account router: measure resuming a transcript under another account's config dir, then
  switch without a replay; (2b) the open opencode 2 checks (switch form, plan-mode form) with a fake
  CLI where a real limit is needed, plus the live-only test gaps (compress reset, watchdogs,
  abort-then-interrupt). (3) evaluate and build or close: hook mirroring, structured output,
  `can_use_tool` rewriting, tool-result repair, session tools, tier labels.
  Batch 1 **done** (v0.46.1): (1a) incremental transcript reads, PR #96, h #g216; (1b) Windows spawn
  quoting with a Windows CI job, PR #95, h #g217 (accounts on Windows still need a `.cmd` wrapper).
  Batch 2 **done** (v0.47.0): (2a) cross-account carry by transcript copy, `crossAccountResume`,
  PR #97, h #g218 (a switch between two real logins still unmeasured); (2b) every live gap passed,
  PR #98, h #g219, which also closes the 2026-09-23 opencode 2 checks (moved to Done).
  Batch 3 **done** (v0.48.0): (3a) PR #99, h #g220: hook mirroring, structured output, `can_use_tool`
  rewriting and tool-result repair closed with evidence; MCP elicitation now declined with a WARN.
  (3b) PR #100, h #g221: `accounts` on Windows (no wrapper, in-process), plan tier labels, session
  tools closed, fast-mode off-state now warned from the result frame. Windows CI green on master.
- 2026-10-07: **done**: opencode 2, the checks that were not possible before release (2026-09-23).
  (1) npm-name install on 2.0.16, done 2026-09-27; (2) account failover form and switch, and the
  plan-mode form, live on 2.0.22; (3) a permission prompt in front of a proxied call, live on 2.0.22
  (h #g219, v0.47.0).
- 2026-10-07: **done** (v0.46.0): "two issues opened on github lets address them properly", in two
  lanes. #90 (PR #93): a compaction turn that errors fails as an error instead of storing the CLI's
  sentence as the summary; a limited turn finishes as `error` with its note (h #g214). #91 (PR #94):
  an effort or model change carries the Claude conversation over instead of replaying it, a crashed
  child keeps its session id, neutral replay wording, a NOTICE per replay (h #g215); restart was
  already fixed in 0.39.0. Reporter hmjBill credited. 1,290 tests.
- 2026-10-07: **done**: PDF input on both transports ("Add PDF input as TODO", then "go ahead").
  Catalog `pdf: true`, a `document` block headless, an `@<path>` mention on the TUI (h #g213). Live on
  1.18.34 and 2.0.22, both transports.
  Released as **v0.45.0** (CI publish green, registry shasum `98e9e2a6` matches the step's notice;
  GitHub release notes written).
- 2026-10-07: **done** (v0.44.0): opencode's system prompt on the interactive transport. The
  "clean root fix" (keep opencode's text, drop only the bisected environment block) was declined as
  evasion of the billing classification; the maintainer chose the offered opt-in instead ("Build the
  opt-in you proposed"). `interactiveUserInstructions` forwards only the operator's own instruction
  files and agent prompt, by provenance, verbatim (h #g212). Smoke-tested live on 1.18.34.
  Released as **v0.44.0** (CI publish green, registry shasum `6b1b79a1` matches the step's notice;
  GitHub release notes written).
- 2026-10-07: **done**: "you say: opencode's own system prompt isn't sent because it trips stuff..
  ... i mean this and the small stuff can be fixed right? and maybe find a creative solution for the
  others? to still achive parity?". System prompt: measured, the TUI trips the third-party gate on
  recognisable pieces of opencode's prompt (a bisect found its environment block, not the URL),
  headless does not; deliberately not worked around (h #g211). Fixed on the PTY: `turnStats` cost and
  duration, the usage-limit and account notes (h #g208); `forkSessions`, the fallback chain, the
  account switch, and an API-error sentence shown once on both transports (h #g209); the headless
  permission policy via `--dangerously-skip-permissions` plus `skipDangerousModePermissionPrompt`, and
  proxied calls kept in the foreground past the TUI's 120 s auto-background (h #g210). Live on 1.18.34
  and 2.0.22 except the switch (no limited account). Correction: PDFs are dropped on BOTH transports
  (catalog `pdf: false`), so not a PTY gap. 1,267 tests. Released as **v0.43.0** (CI publish green,
  registry shasum `4ae69917` matches the step's notice; GitHub release notes written).
- 2026-10-07: **done**: "5 hours have passed i switched us to default profile try the live stuff you
  did not try and im ok with your suggestion about the warning now carry on with the recommended".
  The #g205 warning stays as built. Live on the default account, A/B against a v0.42.0 worktree:
  #88 reproduced (v0.42.0 dropped the mid-call message) and fixed on 1.18.34 and 2.0.22; #89's
  precondition measured (unscoped status map empty while the session is busy in its own directory),
  the fix reads `busy`, but v0.42.0 did not misbehave under `opencode serve`, so the author's
  topology was not reproduced (h #g206). #88 now works on the PTY through the TUI's own input queue
  (h #g206). The idle-screen end signal and recorded 2.1.288 golden transcripts with a replay test
  (h #g207). 1,251 tests. Released as **v0.42.3** (CI publish green, registry shasum `ac59d146`
  matches the step's notice).
- 2026-10-06: **done** (v0.42.2): "carry on with the most recommended". The P2 "version gate the
  transport" built as a contract instead of a gate (h #g205): refusing unknown CLI versions would
  switch the PTY off on exactly the release that drops `--print`, and the cited `stop_reason: null`
  hang already ends on `turn_duration`. One WARN per CLI newer than 2.1.288, a doctor row, the
  requested transport in the startup block, a transport column per live process. Doctor live on
  1.18.34. Still open: an idle-screen turn-end signal and recorded golden files, both needing live
  turns (default account limited today). 1,239 tests.
- 2026-10-06: **done** (v0.42.1): "there a 2 PRs open if they are beneficial and good maybe we should
  consider assimilating them and of cours crediting the author properly". Both by Michael Crawford
  (@internetisalie), cherry-picked with authorship: #89 (run state read from the session's own
  directory, so opencode's routine abort stops rejecting parked calls in other workspaces) and #88
  (user messages beside a proxied tool result reach the CLI). One integration change: #88 is headless
  only, because a stdin write supersedes the parked PTY turn (h #g204). Credited in `docs/credits.md`,
  both PRs closed with a thank-you. Live probe blocked by the default account's usage limit; the
  `appical` account was deliberately not used for a private project. 1,236 tests.
- 2026-10-06: **done**: "anyway to fix/fill the gaps properly?" then "do the fixables now all of them
  if possible". Every fixable PTY gap filled, each live on opencode 1.18.34 and 2.0.22 with Claude Code
  2.1.288: (0) `transport`/auto/PTY compaction, v0.41.0 (h #g199); (1) MCP hot reload and idle eviction
  (h #g200); (2) `permissionPreset: "read-only"` as `--restricted` + `dontAsk` and (3) plan mode with the
  `ExitPlanMode` dialog parked for the operator (h #g201); (4) images as staged paths (h #g202);
  (5) `/btw` from a short-lived `--fork-session` TUI (h #g203). Not fixable properly: token-by-token
  streaming (the TUI writes whole records). Still headless-only by choice: the fallback chain and the
  failover form. 1,220 tests. Released as **v0.42.0** (CI publish green, registry shasum `087e0fa3`
  matches the step's notice).
- 2026-10-05: **done**: "do 1", the tool proxy on the interactive transport (h #g198). The interactive
  spawn now gets the same proxy server, `proxyTools` and `--disallowedTools` as headless, so opencode
  runs the tools, asks the permissions and dispatches subagents. Live on 1.18.34 and 2.0.22 (proxied
  bash, a `general` subagent). 1,194 tests. Follow-up "1 do it now?": `question` and a stop mid
  proxied call, measured live under `opencode serve` (h #g198): the form round trip answered `BLUE` in
  one TUI turn; the stop released the pending call, Esc ended the turn as `interrupted` in 300 ms, and
  the same TUI answered the next prompt.
  Released as **v0.40.0** (CI publish green, registry shasum `abb78889` matches the step's notice).
- 2026-10-05: **done**: "fix what you can fix now also consolidate what we are doing in the split above
  into this session ... and close that split". The split (`wA:p5`) had no unfinished site work (its
  last turns were the 10097 review, `375b69b`; the design passes shipped as #86 and #87); its open
  items were already here, and it was closed. Fixed in the same pass: (1) the interactive transport's
  parity work (h #g196), now verified live through opencode 1.18.34 and 2.0.22 as well, where
  `Bun.Terminal` exists in V2's plugin process; (2) V2 showed every CLI-executed tool's output as raw
  `{"output":...}` JSON on both transports, now plain text (h #g197); (3) the 2026-10-04 idea:
  `resumeAfterRestart` (default on) resumes a conversation's Claude session after an opencode restart
  instead of replaying it, live on both majors (h #g197). 1,189 tests. Released as **v0.39.0**
  (commit `375ddba`, CI publish green, registry shasum `e7cad9b2` matches the step's notice).
- 2026-10-04: **done**: reviewed `10097.patch` (maintainer: "check it out the patch whether its
  beneficial still and can be assimilated"). It is anomalyco/opencode#10097 by Dennis Krämer, the opencode
  proof of concept the first version was built from. Nothing to assimilate: every live piece is
  superseded here, its core edits do not apply to a plugin, and its session-id persistence was never
  called. Moved to `docs/history/opencode-pr-10097.patch`; Dennis credited on the Credits page and the
  landing page. The persistence idea is the open item above.
- 2026-10-04: **done** (no release): the 65 `test-*.ts` files and `test-fixtures/` moved out of the
  repository root into `test/<name>.test.ts` and `test/fixtures/`, plus the two manual scripts as
  `test/integration.ts` and `test/e2e-claude-session-bun.ts`, so the README is no longer below the
  fold on GitHub. `npm test` runs the glob `test/*.test.ts` (same 1,150 tests). (h #g195)
- 2026-10-04: **done** (PR #87, site only, designer pass): install line "tl;dr just install it,
  and support it", the pill reads "latest v0.38.0", and teal (the string token, `--occ-live`) has
  one meaning, live / current / done: the pill dot, the copied state, the replay tab while a
  finished turn holds, and the stats dot when every figure was live. Amber stays the brand.
- 2026-10-04: **done** (PR #86, site only): "keep the website up to date especially version and
  all the numbers preferably live and automatic", and the install line "too much on 1 line". The
  live page showed v0.37.1 while npm served 0.38.0, because a release pushes a tag and the docs
  workflow only ran on docs pushes and daily. `docs.yml` now also runs after every successful
  Publish (waiting until npm serves the version), on pushes to `src/**`, `test-*.ts`,
  `package.json` and `skills/**`, and every six hours. README "18 models" replaced by a
  `/badges/models.json` badge. Install block: the sentence on its own line, the snippet in a code
  window with `opencode.json`, an `npm vX` pill and the copy button in its title bar. The
  post-publish trigger is verified only at the next release. Two lanes died on the session
  limit; the maintainer session finished both.
- 2026-10-04: **done** (v0.38.0, PR #85): usage limits end the turn on one `▌ usage limit:` note
  and the account-switch form is opt-in (`accountFailover: "ask"`). Maintainer: "when a limit is hit we
  need to show a clean and simple warning in the conversation it self ... not do this failover thing
  because its failing". Root cause of the failing switch, from the raw log bytes: opencode-dcp appends
  `<dcp-message-id>` to tool outputs in flight, so every pick was refused as `unrecognised answer`
  (fixed for the form and the plan-mode bridge). The "two go's": typing while the form is open
  dismisses it and that message hits the limit again. Live-checked on the real exhausted appical
  window: one note per limited turn, local reset time, names the other account. 1,150 tests.
- 2026-10-03: **done** (v0.37.1, PR #84): plugin WARN/ERROR lines drawn over the opencode TUI
  (maintainer: "can we fix this first?"). Measured: opencode 1.18.34 runs a plugin in the TUI's
  server worker thread (`isMainThread: false`), where stderr is the terminal; `run` and `serve`
  run it on the main thread with stderr piped. Inside a TUI the logger now writes nothing to
  stderr: every surfaced line goes to `client.app.log`, warn/error also to one toast per message
  per process (at most 3 per 2 s plus a held-back summary). Off the TUI, and on opencode 2,
  unchanged. 1,130 tests; CI published 0.37.1, checksum matches.
- 2026-10-03: **done** (v0.37.0, PR #83): the stale-build notice ("do the recommended with most
  benefit"). A turn in a conversation whose opencode process runs an older plugin build than the
  one on disk starts with one `▌ restart opencode:` note (new version, or `rebuilt` for a file://
  dist), once per session, never in subagents, compaction, titles or doGenerate; a doctor row and
  one WARN per build. Review caught the baseline being taken on first use instead of at import
  (fixed, red/green test, live rebuilt-before-first-turn check). 1,107 tests; live on 1.18.34 and
  2.0.22 with Claude Code 2.1.288.
- 2026-10-03: **done**: the maintainer logged the `default` account back in ("claude is logged
  in"); verified: `claude auth status` reports claude.ai on the Max plan, and a real `-p` request on
  it answered.
- 2026-10-03: **done**: `claude update` ("go"), 2.1.280 to **2.1.288** through the native updater
  (Aikido's npm age filter does not apply to it). Verified live on 2.1.288: Claude Sonnet 5.5 with no
  `unrecognized_model` line and a 1,000,000-token context window (was 200k), and a turn through
  opencode 1.18.34 and the plugin with a CLI-run `Read` and a proxied `bash`, no new warnings.
  Same morning: the account-block note and form fired live for the first time (an expired `default`
  login, #g30); the "unrecognised answer" that followed came from an opencode process still running
  a pre-0.29.2 build, not from current code (replayed both answer paths against the source).
- 2026-10-03: **done** (v0.36.5): the compatibility sweep ("ok now what?", then "go"). PR #82
  measured Claude Code 2.1.286 (2.1.287 and 2.1.288 are blocked here by Aikido's minimum age) and
  opencode 2.0.22 (sandbox moved from 2.0.16) against 1.18.34; every live check passed on both. Two
  pre-existing bugs fixed, each with a test that fails first: a CLI-run tool in a step ending on a
  proxied call never got a result (2.0.22: "Provider did not return a tool result"; 1.x: pending),
  and output a reused child wrote between turns was replayed as unmarked text (#g189 to #g191;
  it also corrected #g104: one `-p` run can emit two `result` frames). The four unread `system`
  events and ten new ones measured, no parser for any, with a verdict each. Reviewed at merge: the
  placeholder result cannot reach the CLI as a second `tool_result`. 1,083 tests. Still with the
  maintainer: `claude update` (2.1.280 runs Claude Sonnet 5.5 on a 200k window); done 2026-10-03, see below.
- 2026-10-02: **done**: design pass 3 (PR #81, docs deploy green, live). "yes to all": the widget
  colour is the designer's #E8A33A (landed with pass 2, confirmed live). The designer's session hit
  its limit before committing pass 3; the maintainer's session reviewed the worktree (build, 0
  broken links, 0 em dashes, screenshots at 1440 dark/light and 390) and landed it unchanged.
  Still with the maintainer, both outside any API: the GitHub Support "detach fork" request (the
  form needs their login; the text is in the 2026-10-02 session report) and the repo social preview
  upload (site/public/social-preview.png, Settings > General > Social preview).
  Follow-up the same evening, on master: the replay streams each reply a word at a time and
  ends on the opencode line; lines not yet spoken are transparent, not removed, so the panel is
  full height from the first frame and nothing below it moves between turns; from 80rem the replay
  takes the wider column (11fr/13fr). Measured on the built site: at 1440x900 the whole held turn
  ends at 833px, at 1280x800 only the reply's footnote dips 29px under the fold, at 390x844 the
  fold is title, tagline, install block, actions, then the replay. No horizontal scroll at 390.
  Then, from the maintainer's own review of the fold: the tl;dr label reads "just install, then
  buy me a coffee" with the link and a relieved-face emoji (requested); the JSON snippet is
  highlighted with three hand-marked token spans in the site's own colours (no highlighter
  loaded); every `you` line in the replays is typed out character by character; every other
  line shows its speaker a beat (240 ms) before what it said. The install head is a grid so the
  version and copy button stay on the right at 390, 768 and 1440.
  Then: the caption is the pipeline ("Opencode", mark, "Plugin", mark, "Claude", in the lane
  colours, so it is the legend too); the tagline names the Claude Code CLI; the label reads "just
  install, and support with a coffee"; replay bodies are syntax-coloured at build time by a
  one-pass tokenizer (JSON keys and strings, argv flags, placeholders, numbers, punctuation)
  and the install snippet shares the same token colours, defined once per theme in custom.css
  (accent, teal, lavender; light-theme teal #0f6e66 and lavender #5b3fbf pass 4.5:1 on the panel).
  Then: the label is "just install, and support it" with coffee and relieved-face emoji (one
  line at 1440); and the page no longer jumps while a replay plays: the moving cursor was an
  inline block that wrapped a new row at the end of a full line (stage height 635 vs 617 px,
  measured), now a zero-width block via a negative end margin.
  Then ("the star history is broken", "anything cool to brag with"): the credits page's star chart
  is drawn at build time from the real stargazer dates (GitHub `star+json`, committed snapshot as
  fallback) as inline SVG in the site's type and colours, so it follows the theme toggle; the
  star-history.com picture picked dark or light by the OS, not the site, and showed a white chart
  on the dark site. GitHub's render of credits.md keeps a star-history image link. The landing grid
  is 3x3 with three new items (the bundled skill, the doctor bundle, warm-cache forks) and the
  README's What-you-get table gained the skill row. Social preview upload still needs the
  maintainer: port 9222 here is not a DevTools endpoint, so no browser automation could reach the
  logged-in GitHub session. Done later the same evening: Chrome refuses a debugging port on the
  default profile, so the login cookies and Local State were copied into a throwaway profile dir,
  a debug Chrome on 9333 drove the hidden `#repo-image-file-input`, GraphQL confirmed
  `usesCustomOpenGraphImage`, and the copy was deleted.
  Measured in the Docs workflow: the Actions GITHUB_TOKEN is refused by REST `star+json` (403) and
  by GraphQL `stargazers` ("Resource not accessible by integration"), while `repos/<r>` works, so CI
  draws the snapshot's dates padded to the live count. To get per-star dates on CI, add a repo secret
  (a fine-grained PAT with public read) and pass it as GITHUB_TOKEN to the build step; otherwise
  refresh `site/src/data/stars.snapshot.json` now and then (`gh api -H 'Accept:
  application/vnd.github.star+json' --paginate repos/<r>/stargazers --jq '.[].starred_at'`).
- 2026-10-02: **done** (site only, no release needed): design pass 2 (#80, @designer, "every factor
  of it needs to be awesome"). The transcript is the interface: the hero replays one real turn across
  opencode, the plugin and `claude --print` from real argv and frame shapes; Geist Mono (OFL, 38 KB
  subset, self-hosted, licence shipped) across the site, the README banners and a new social
  preview; an architecture drawing; a custom 404; responsive tables; reading-progress bar; widget
  recoloured to `#E8A33A`. 37 pages, 968 links checked, 0 broken, weakest contrast 5.44:1, no
  third-party request besides the coffee widget. The lane died once on its session limit with 731
  uncommitted lines and was resumed by task_id. Repo topics and the About-box website set the same
  day. Design docs copied to the vault (`Design/`).
- 2026-10-02: **done** (v0.36.4): the docs site serves at https://opencode-claude-code-plugin.dev/ ("you
  add them you have access to all", then "retry"). Nine DNS-only records added through Cloudflare's
  API with the personal 1Password item "Khalil CloudFlare PAT"; Pages custom domain set, certificate
  approved (to 2026-12-31), HTTPS enforced; PR #79 moved the site to the root with its address in
  `site/site-config.mjs`, fixed the link checker's hardcoded base and a double slash in the social
  image URL. Verified live: pages, assets, badge endpoint, widget, and one-hop redirects from http,
  www, the github.io paths and the codez.it paths. The earlier plain-http redirect item is moot.
- 2026-10-02: **done** (v0.36.3): Émilien (unixfox) credited by name as the original author, first
  row of docs/credits.md, linking his profile and no longer his repository; the "Maintained fork of"
  banner removed from the README and the docs introduction. The LICENSE now carries his copyright
  notice too, which MIT requires while his code remains (581 of 26,498 src lines on 2026-10-02).
  Measured against his final tree: src 1,515 to 24,639 lines (16x), tests 90 to 24,653 (274x), docs
  136 to 4,136 (30x), plus the 7,497-line docs site; 7 commits and 2 tags against 430 and 106.
- 2026-10-02: **done** (v0.36.2): Buy Me a Coffee, as asked ("add where appropriate like the readme
  and the website header and footer, for the website also the widget"). PR #78 by @designer: a
  badge and the yellow button in the README (served from `site/public`), a header pill in the
  site's own style plus the yellow button in the footer, the widget with the maintainer's values
  (`defer`, through Starlight `head`), `.github/FUNDING.yml` (GitHub Sponsor button, confirmed by
  the GraphQL `fundingLinks`) and `package.json` `funding`. Live and verified on the site.
- 2026-10-02: **done** (v0.36.0, v0.36.1): "go". PR #76 `forkSessions` (opt-in): a forked opencode
  session forks the Claude session (`--resume <parent> --fork-session`), first turn 8x cheaper
  (814 vs 22,355 cache-write tokens); off by default because the fork keeps the parent's system
  prompt snapshot; fixed at merge: fingerprints hash attachment bytes. The missing MIT LICENSE
  file added. PR #77, "1 and 2" plus the @designer: docs pages under `docs/`, a Starlight site in
  `site/` deployed to GitHub Pages by `docs.yml` (daily rebuild, live stats, a tests badge
  endpoint), README cut from 1,727 to 110 lines; fixed at merge: Pages permissions on the deploy
  job only. Pages enabled (Actions source, HTTPS enforced on the project); live at
  khalilgharbaoui.github.io/opencode-claude-code-plugin, which redirects to the codez.it custom
  domain of the user site. 1,078 tests.
- 2026-10-01: **done** (v0.35.1): the three follow-ups of 0.35.0 ("see if you can bump its, the
  others do what is recommended and best"). (1) Not a bump: `@ai-sdk/provider-utils` removed,
  `generateId` is local (`src/ids.ts`); its v5 line pulled `undici` 5.29.0 (13 advisories, 3 high).
  Fresh install: 3 runtime packages, `npm audit --omit=dev` 0. Dev-only `esbuild` (Windows dev
  server, under `tsup`) left, #g186. (2) Aikido not run: its MCP is Appical's org, disabled
  globally and enabled only in Appical repos, so private code is not sent to it; a local security
  review of `src/diagnostic-bundle.ts` found no leak and one honesty gap (a bundle keeps folder paths
  and account names; now stated in its preamble and the docs). (3) The four unread `system` events
  deferred to the vault backlog. Live turn under Bun on opencode 1.18.34. 1,058 tests.
- 2026-10-01: **done** (v0.35.0): the two lanes from "whats next" ("go"). PR #75: `/claude-code-doctor
  bundle`, an allowlist-redacted log tail plus the doctor report, safe to paste into an issue
  (live: no prompt, home path, key or raw session id survived). PR #74: the unread CLI stream
  events measured on 2.1.280; failing `SessionStart` hooks get a WARN and a doctor section,
  `tool_progress` is logged (the watchdog cannot misfire on it: 30 s heartbeats against 60 s),
  `tool_use_summary`, `prompt_suggestion` and `command_lifecycle` are never emitted in the
  plugin's mode and stay ignored. Fixed at merge: a bundle withholds the doctor report's free
  text (hook stderr, the CLI's MCP and plugin sentences), and table cells are escaped. 1,056 tests.
- 2026-10-01: **done** (v0.34.1): PR #73, an abort during the turn prologue is honoured (nothing
  spawned or written, the long prologue waits stop, a turn already asked for work stops as before).
  Released once 1Password signing worked again. Also done: the stale npm `next` dist-tag (0.27.0)
  was removed by the maintainer; only `latest` remains.
- 2026-10-01: **done** (v0.34.0), the two no-input items ("fix these ... what needs my input last").
  PR #72: opencode 2's `pending` MCP status no longer disables a server; the first turn waits up to
  `mcpConnectWaitMs` (3000) for it; a changed server set respawns with `--resume` only at a safe
  boundary and at most once a minute; an interactive-transport process leak fixed. PR #71: the flaky
  `/btw` test was a product bug (a `claude --version` probe killed by its 5 s deadline was cached as
  unknown for the whole process, dropping version-gated flags); now re-probed, capped at two per key
  at merge. 1,011 tests, both live- or load-verified.
- 2026-10-01: **done** (v0.33.2): "look at all of it and fix all of it" for the setup skill. PR #70 audited
  SKILL.md against the code: two contradictory process caps (the code's is 16; AGENTS.md also said 8,
  corrected in #g179), a non-existent 30-minute idle default, the opencode 2 settings key
  (`providers.claude-code.settings`, also wrong in the README), a stale "known-broken" question
  rule, missing 2.1.258 / 2.1.284 floors, and "this fix" troubleshooting rows. Six drift guards
  added to `test-configure-skill.ts`. 986 tests.
- 2026-10-01: **done** (v0.33.1): contributor PR #67 (@bangnh1) merged with credit after review:
  opencode 2 MCP configs (`mcp.servers`, `disabled`) are bridged, `providers.claude-code.settings`
  is read, and Code Mode `execute` can be proxied when allowlisted. Verified against the 2.0.16
  schema and a real sandbox config (master bridged a server named `servers`; the PR bridges `cbm`).
- 2026-09-30: **done** (v0.33.0, released 2026-10-01 once signing worked again): two lanes as picked ("opencode 2 status/cancel,
  Interactive bugs"). PR #68: the interactive transport synthesizes a headless-shaped `result`
  (`subtype: "success"`, top-level `stop_reason`), so its turns no longer end as errors and the
  stats line shows; the transcript dir uses the cwd's real path (`/tmp` is `/private/tmp`).
  PR #69: `task_status` / `task_cancel` work on opencode 2 (shim over `session.context` /
  `session.interrupt`) and the doctor gets a background-subagents section. 970 tests; both
  live-verified (Bun interactive run; V2 sandbox 2.0.16).
- 2026-09-30: **done** (v0.32.0), two implementor lanes as asked ("do 1 background agents in 1 lane
  and 2 small follow up in another"). PR #66: background subagents are opencode's own (`task`
  `background: true`, gated on 1.x by `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`); the plugin
  reads the gate off the live schema and adds `task_status` / `task_cancel`. At merge the parent
  guard was changed to fail closed (it allowed any id when the turn had no session id). PR #65:
  the interactive transport counts each API call once by message id (transcript records carry
  the final usage, unlike stream frames). 939 tests, both live-verified.
- 2026-09-30: **done** (v0.31.0). Two contributor PRs for the same bug (turn-summed usage
  made opencode auto-compact early): #63 (@broskees) merged after its three claims were
  measured against the real CLI and an A/B through opencode (193,659 vs 39,681 stored tokens);
  #62 (@bangnh1) closed as superseded with thanks, both credited. Issue #64: Claude Sonnet 5.5
  registered from Anthropic's pages, Claude Code 2.1.284 is its floor (CHANGELOG), an older CLI
  runs it on fallback limits and the plugin now warns on `unrecognized_model`. Sonnet 5 corrected
  to $2/$10 (the $3/$15 increase was cancelled). The per-agent `cacheTtl` from 0.30.0 was
  live-verified end to end (5m writes under `cacheTtl: 5m`, 1h otherwise). 907 tests.
  Follow-ups: the interactive transport sums `output_tokens` per transcript record (#63's
  note, needs a Bun run); the account-failover switch still awaits a real limit.
  `plugin_errors`/`plugin_warnings` on init shipped in v0.31.1 the same day (#g171).
- 2026-09-28: **done** (v0.29.2, v0.30.0). v0.29.2: the first real usage limit showed the
  account-failover form still could not switch (opencode's answer ends in a newline, the
  unwrapper wanted an exact suffix); both live picks were logged as `unrecognised answer`.
  Fixed by trimming, tested with the live bytes. v0.30.0, two implementor lanes that died on
  the session limit at 04:15 and were resumed in their own sessions: PR #60 (no digest turn
  exists, one `ToolSearch` per process instead; `mcp_server_errors` reported; opt-in
  `/claude-code-doctor usage`, whose spawn I moved onto `claudeSpawnEnv`) and PR #61 (the
  CLI's subagent knobs cannot reach our main-conversation spawns; per-agent `cacheTtl` and
  `defaultSubagentCacheTtl` instead). 897 tests. Open: the failover switch path is not yet
  live-verified; the `cacheTtl` turn was verified 2026-09-30.
- 2026-09-28: **done** (v0.29.1): the two deliberate refactors, one implementor lane each,
  sequential because both rewrite the language model. PR #58 routes `doGenerate` through the
  one turn implementation (4,375 to 3,832 lines; measured that opencode 1.18.32 never calls
  `doGenerate`, so a fake-CLI test holds it). PR #59 extracts `TurnState`, the controller and
  the stream parser (to 2,404 lines, shared identifiers 87 to 16), gated green after each step,
  live probe identical line for line. `package-lock.json` is now gitignored because every
  lane's `npm install` created one.
- 2026-09-27: **done** (v0.29.0): the roadmap batch. Sandbox moved to opencode 2.0.16 and
  re-probed (`V2.md`). Three implementor lanes: PR #54 comparison table and symptom-first
  troubleshooting guide, PR #55 `permissionPreset` in the doctor and startup block plus the
  measured verdict that `tombstone` is declared but never emitted on 2.1.280, PR #56 the
  `fallbackModels` chain (two exact triggers, failover form wins, live-checked). On master:
  the billing text corrected (the Agent SDK credit was paused on 2026-06-15 and never took
  effect, verified on Anthropic's page), and a partial `provider.claude-code.models` entry
  no longer throws inside the config hook. 868 tests. The first attempt at PR #55 and #56
  died on the implementor account's session limit; three concurrent lanes plus this session
  share one window, so re-dispatched after the reset.
- 2026-09-27: **done** (v0.28.1): contributor PR #46 (@acastro2) merged with credit. CLI tool
  results now carry their call's mapped name, so opencode 2.0.16 no longer aborts turns that
  use a Claude-side MCP server. Reviewed: the stored name is read only by the result emit, and
  the opencode 2 translation classifies a result by the name it carries, so call and result
  now translate alike. Conflict (test list) resolved on the contributor's branch; 834 tests.
- 2026-09-26: **done** (v0.28.0): three parallel implementor lanes, PR #53 read-only
  permission preset, PR #51 `▌ no reply` note (measured zero silent turns, so no nudge),
  PR #52 scratch-file hardening (Windows part deferred). 832 tests, live-checked on opencode
  1.18.32 and 2.0.11. The three lanes all wrote their history under `#g156`; renumbered to
  g156 to g158 at merge.
- 2026-09-26: **done**, the three accelerator lanes, each an implementor subagent: PR #47
  (AGENTS.md 182 KB to 53.6 KB, history verbatim in `docs/agents-history.md`, three dropped
  rules restored before merge), PR #49 (language model 5,383 to 4,105 lines, ten modules, no
  behaviour change), PR #48 (720 to 784 tests, bash 3.2 wrapper bug fixed). Master green at
  784, live-checked on opencode 1.18.32 and 2.0.11. Measured cost against the estimates is in
  the vault roadmap, "Cost calibration and weights".
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
