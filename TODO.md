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
  account-wide and asks rather than switching silently. **The silent switch exists since
  2026-10-16 as the opt-in `accountFailover: "auto"`** (PR #115 by @broskees, h #g236):
  configured order, same group, each account once per request.
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

- Dropped 2026-10-22 at the maintainer's request ("recommended"): the ContextDex "Verified" README
  badge (Julian Mercer, Gmail 19 Oct 2026). A paid-placement pitch ($49 pin, $199/week sponsor)
  whose "MCP audit" does not fit this plugin. No reply, no badge.
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

Feature ideas live in the vault note `opencode-claude-code-plugin/Future Features.md`; this list is
checks and suspected defects found in passing.

- 2026-10-23: a dcp compression of a MID-THREAD range would still be read as a `rewound`
  conversation, and nothing has measured it doing so. Found while fixing the false rewinds
  of h #g262: the two large-removal verdicts in the log (`shared 4 / removed 173 /
  removedUser 15` and `70 / 131 / 6`) looked like a prune and were not one, because
  `removedUserMessages` counts the whole removed tail rather than what changed, and both
  affected sessions held zero compressed-block parts and zero `compress` tool calls
  (against 1,643 `compress` calls elsewhere in the same database). So no rule was built.
  If it is ever measured: a dcp compression is not an operator edit and must not end the
  Claude session, and the narrow signal to key on is the `b`-form reference dcp gives a
  compressed block (`<dcp-message-id>b3</dcp-message-id>`, `@b3@`), which
  `src/session-fork.ts` already recognises from h #g258 and h #g259.

## Deferred decisions

Only decisions about this plugin belong here. Items about the global opencode config
(Slack MCP auth, opencode's Linear OAuth, the unused `lmstudio` block) and the separate
`opencode-local-ollama` package were moved on 2026-09-28 to the vault note
`opencode/Open items.md`; they were recorded here only because the sessions that raised
them ran in this directory.

## Open from you


Questions the maintainer still owes an answer on. Written here the turn they are
raised, so they survive context compaction; removed when answered, done or dropped.

- 2026-10-08: subagent startup (~25 s). Maintainer: "do 1 but not fully just comment it out, 2 pin it, 3 lets
  try 1 and 2 and see if 3 is needed". Done: `slack` parked under `_parkedMcpServers` in both Claude accounts'
  `.claude.json` (pinned 1.3.0), opencode's slack pinned to 1.3.0 (backups `*.bak-slack-20261008-214042`).
  It did not fix the wait, and option 3 (`strictMcpConfig`) would not either. Measured cause: opencode's
  server worker FREEZES 30 to 35 s when the parent session takes its next step after a dispatch (probe on
  the in-process proxy: no answer 21:47:20 to 21:47:56, no plugin log line in that window; the plugin's
  next call came after). The parent here is ~1,500 messages / 10 MB, and tool round trips in it grew from
  ~4 s to 100 to 250 s over the day. The subagent's claude waits for opencode_proxy, hits Claude Code's
  30 s MCP connect timeout and starts WITHOUT its tools ("no shell tool"). Next: confirm in a fresh session;
  find whether opencode or a plugin (dcp's message transform) burns the time. Maintainer: "1". The
  plugin-side half is **done** (v0.54.2, h #g235): `MCP_TIMEOUT=120000` on every spawn unless set.
  Fresh-session comparison (ses_ee2d834cbffetpphLRGHNa8dpJ, 6 messages): dispatch 22:15:24, spawn
  +1 s, `claude` ready +3.2 s, first tool call +10 s; in the ~1,600-message session the same spawn took
  35 s to get ready. So the stall scales with the parent session's size. Whether opencode or dcp's
  message transform burns it (needs a large session with dcp disabled): maintainer, 2026-10-09: "later".

## Owed checks

Verification still owed, copied from the vault's `Future Features.md` "Next up" on 2026-10-24
(maintainer: "do the most recommended for all in 1 go"), because they are checks, not features.

- Around 2026-11-08: review the progress estimate again, once the busy keys have 30+ samples.
  The 2026-10-25 review (one week, read-only) found a forward test of 44 to 45% in band against
  a 50% target, estimates about 13% long on the median, a typical miss of x2.2, worst on
  build/fable-5-1 (x4.4) and build/plan on opus-5-5 (38% in band). A per-key calibration,
  simulated, fixed the bias but made the typical miss worse (x2.27 to x2.52), so the estimator
  stays as is. Note for next time: the doctor's in-band figure reads about 7 points above the
  forward test, because its calibration is scored on the residuals it was fitted to.
- Live checks owed by v0.55.0: `accountFailover: "auto"` (PR #115) and PR #115's v0.60.2 fixes against
  two real logins hitting real limits (needs the second login under Parked), and the #114 agent-switch
  gap replay on opencode 2.
- With the next compatibility sweep: the interactive transport's full live list on Claude Code 2.1.300
  (`INTERACTIVE_MEASURED_CLI` is still 2.1.293), and on opencode 2.1.3 the forms, the MCP bridge with a
  real server, background subagents, `/btw` and the doctor (h #g264's "not measured").
- Next fork sweep: early November.

## Parked

- 2026-10-08: switching the daily driver to opencode 2. Maintainer: "ill stay with 1 for now will
  checkout 2 somewhere next week". Prep is done (v0.53.1, v0.53.2; h #g229, #g230): the plugin is
  verified live on 2.0.22, Moshi 0.4.21 serves both majors, and the dry run with the exact config
  changes and the rollback is in `~/opencode-v2-sandbox/migration-dryrun/REPORT.md` (plugin path ends
  in `/dist`, drop `compaction.prune`, notify becomes cli.json `attention` from `cli.notify.json`,
  herdr-agent-state.js has no V2 version).
  2026-10-24: two days of real work on opencode 2.1.3 in a scratch copy of the config
  (`~/opencode-v2-sandbox/drive/run.sh`, session ses_e9ab4363dffeLkqp9VslrAFBZe) found no plugin
  defect; verdict: fit to be the daily driver. Left before switching: the OpenAI, Copilot and figma
  logins, furno-postgres's HTTP 405 on V2, and the V1-only plugins with no V2 version.
- 2026-10-08: optional, needs the maintainer: a second non-work Claude login, only to live-test a
  switch between two real logins and an expired-login switch. Every failure path falls back to the
  replay, so normal use answers it too. MCP elicitation as a form is parked in Future Features.

## In progress

## Done

- 2026-10-28: **done** (v0.63.3, PR #145, h #g272): unavailable MCP servers warn as one line per status,
  and a claude.ai connector the account never connected goes to INFO and the doctor instead of a toast.
- 2026-10-26: **done** (v0.63.2, PR #144, h #g271): a model, effort, TTL or cap change mid-turn waits for the
  turn. It finishes on the busy child under its original settings and the change applies from the next idle
  turn; `resumeAcrossModelChanges: false` now also stops the effort/TTL/cap carry, as documented.
- 2026-10-26: **done** (v0.63.1, PR #143, h #g270, issue #140): a cache TTL or CLI cap change no longer
  leaves the old `claude` running beside the new one. Keys that differ only in spawn settings are one
  conversation: the old child is ended and its Claude session carried over, refused while it is mid-turn.
- 2026-10-25: **done** (v0.63.0, PR #142, h #g269): a rebuilt plugin applies without restarting opencode 2.
  The newest copy takes over at the first quiet turn, each conversation resuming its Claude session there;
  a session with work in flight finishes on its own copy first. Takes one restart to start.
- 2026-10-25: **done** (v0.62.1, PR #141, h #g268): stops keep working after opencode 2 reloads the plugin.
  opencode 2 re-imports a rebuilt plugin but keeps serving turns from the first copy, which lost its event
  subscription, so a stop at a parked call after any rebuild released nothing. One relay per process now.
- 2026-10-25: **done** (v0.62.0, PR #139, h #g266): the sidebar shows what is left of each account's 5-hour
  window, live (`5h 28% left · resets 18:00`), from the CLI's `unifiedWindows`, with a second line for a
  weekly window that is refused or nearly spent; the 7-day window now has readings and notes of its own.
- 2026-10-25: **done** (docs only, h #g267): interrupts measured on **opencode 2.1.4**. No plugin defect:
  every stop path reaches the plugin, and the TUI's Esc Esc (`interrupt?resume=true`) restarts at once on
  a queued prompt, which reads as "the interrupt did nothing".
- 2026-10-24: **done** (v0.61.2, PR #137, h #g265): the skill-clash and V2 Code Mode WARNs fire once
  per process instead of on every spawn (614 and 307 lines, hourly toasts, over two days on opencode 2.1.3).
  The two-day trial's verdict: opencode 2.1.3 is fit to be the daily driver. The maintainer's herdr skill
  copies were synced the same turn, so the clash itself is gone.
- 2026-10-23: **done** (docs only, h #g264): compatibility check of the plugin against **opencode 2.1.3**,
  which the maintainer's opencode 2 now runs. `@opencode/plugin` publishes no 2.1.3 (the 2.1 line stops at
  2.1.2), so the declarations were diffed 2.0.31 -> 2.1.2 by `curl`'d tarball and every verdict re-checked
  against the 2.1.3 binary with `rg -a`. Additive for everything a plugin is handed: the `SessionDomain`
  `Pick` gained `list` (and `session.active` is still absent), `SessionCompactionResult.providerState`
  became `native` (which the plugin never reads), the whole `dist/tui` tree is byte-identical, and the
  `session.*` event set only gained `session.archived` / `session.unarchived`. `src/` needed no change.
  Live on 2.1.3: a text turn, a proxied `shell` plus a CLI-native `read`, process reuse, and a
  subdirectory cwd measured both over HTTP and in a live serve turn. The one thing that moved a standing
  verdict is `list`, which reopens the premise of h #g221's declined `session_list` but not its verdict;
  nothing was built. Not measured: the interactive transport, the forms, the MCP bridge with a real
  server, background subagents, `/btw` and the doctor.
- 2026-10-23: **done** (v0.61.1, PR #134, h #g262): "conversation rewound" fired 276 times in a week on
  opencode 1 (28 sessions) and never on opencode 2. Cause: opencode-dcp's context-limit reminder, added to a
  user message after it was first sent, changed that message's digest, so the turn read as an undo, ended a
  healthy Claude session and replayed the thread. The digest leaves dcp's blocks out (version 3, older
  records compared as before); real undos, edits and regenerations still trigger it. Released with PR #132,
  #133 and #135 after "do all that is recommeded and deliver the good work"; CI on the merged #133 was red
  from a lifecycle-test race, fixed in PR #135.
- 2026-10-22: **done** (v0.61.1, PR #132, h #g261): the fork sweep, and the one thing it found worth taking. 28 forks
  fetched (one new, @taylormitchell); only @bangnh1, @broskees and @taylormitchell have pushed since
  2026-10-08, and all three are resolved in the history entry. @bangnh1's `c614345` solved issue #114
  independently and checked the `accountGroups` group on EVERY catch-up, where this plugin checked it
  only on the fresh-start turn. That was a real leak, confirmed verbatim both ways by a fake CLI
  driving real turns across two accounts: the `<missed_conversation>` catch-up and a `rewound`
  thread's `<conversation_history>` replay each carried the other group's exchange back to the first
  account. One lazy lookup now serves all three paths; the module itself is superseded by `323b20e`,
  so nothing was cherry-picked and @bangnh1 is credited for the idea.
- 2026-10-22: **done** (v0.61.1, PR #133, h #g263): three `test/skill-bridge.test.ts` specs failed on the maintainer's Mac
  (31 pass / 3 fail) and passed in CI. Not a product bug: `withFixture` repoints HOME at its scratch tree,
  which moves `skillRoots`' home-dir guard off the real home, and opencode's sandbox sets `TMPDIR` inside
  that home, so the walk-up read `~/.claude/skills` and `~/.agents/skills` as ordinary project ancestors.
  The fixture now picks a scratch root with no skill root above it and asserts, per fixture, that every
  root discovery sees is inside it. 34/34 on this Mac, `src/` unchanged.
- 2026-10-20: **done** (v0.61.0, PR #131, h #g260): the todo-tools decision, after "2 do the
  recommended" and "update skill and docs as well". New provider option `enableTodoTools` (off by
  default) sets `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` on every turn spawn, both transports, never compaction,
  and never over a value already in opencode's environment. Doctor row, options table, the subagents
  page, symptoms, sidebar guide and skill updated.
- 2026-10-20: **done** (v0.61.0, PR #130, h #g259): the two backlog checks, after "2 do". The
  todo tools are gated by MODEL in Claude Code (2.1.280 to 2.1.293; 2.1.300 is not on this machine): off for
  Opus 4.8 and every 5.x model, back with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, measured off `init` and live
  through opencode 1.19.3; documented, code unchanged. dcp's `compact` form measured on opencode 2.0.31: an
  undo renumbers it across a restart (`@4@` to `@3@`), v0.60.1 replayed and this build resumed.
- 2026-10-19: **done** (v0.60.2, PR #129, h #g258): `resumeAfterRestart` refused as
  `conversation-changed`, recorded 2026-10-17. Reproduced live on opencode 1.19.3 + dcp 3.2.0 with a fake
  `claude`: an undo makes dcp renumber every later message after a restart (`m0004` became `m0003`), and its tag
  was hashed as text. The digest leaves dcp's references out, versioned so records from before still resume.
  The A/B: master started the undone conversation over, the fix resumed it.
- 2026-10-19: **done** (v0.60.2, PR #128, h #g257): the `turnStats` cost and PR #115's five
  leftovers, after "do the recommended for the rest". The footer prints the turn's delta (a resumed session's
  first footer leaves the cost out); a limited `doGenerate` turn errors in every mode; a stream cancel stops
  the turn in every mode; after a chain of overrides the form, the notes and the remembered limit name the
  account that ran and never offer it; the form's switch note says carried or replayed. Not live: needs a
  second limited login.
- 2026-10-19: **done** (v0.60.2, PR #127, h #g256): the start-watchdog fix, after "defer the til
  message do the recommended for the rest". Measured first on 2.1.293: `system`/`init` waits for every MCP
  server to connect or hit `MCP_TIMEOUT`. A child that has not written `init` now gets at least its
  `MCP_TIMEOUT` plus 30 s (150 s by default) before the first fire, then the configured 90 s from `init`.
- 2026-10-19: **done** (h #g246): the reset notation, parked on 2026-10-18 with "not sure". Shown both
  side by side, the maintainer chose "Keep year first": a reset on another day stays `2026-10-21 14:00`
  (narrowest `10-21 14:00`), not `21/10/2026 14:00`, in the sidebar and every note. No code change.
- 2026-10-19: **done** (v0.60.1, PR #126, h #g255): the guessed-provider decision. Asked what the
  plugin should do after Haiku 4.5 guessed `anthropic/claude-sonnet-5-5` for a subagent model, the
  maintainer chose "Complete bare ids" and "Release v0.60.1" for it with the docs and skill change. A bare
  registered id is now completed to the conversation's own provider and account before the account guard;
  a full reference, a foreign `@` marker and an unknown id reach opencode as written. Live on opencode
  2.0.31: Haiku's two requests ran on the first call (two and four calls before).
- 2026-10-19: **done** (h #g254): "document this also and make sure the skill is aware", after v0.60.0.
  The subagents page now says how to name the model (a table of the three reference shapes, two
  example prompts, how to check it took), the symptoms page and the skill's Troubleshooting carry
  four rows, the sidebar and tool-proxy guides point at it, and the skill's paragraph became its own
  recipe. The "Sonnet in words" claim was measured first: Opus 5.5 got the reference right, Haiku
  4.5 guessed. Docs pushed to master as `28a0c56`; the skill change shipped to npm in v0.60.1.
- 2026-10-19: **done** (v0.60.0, PR #125, h #g254): PR #123 from @taylormitchell, after "this PR
  ... whatsup with it? also why is there a workflow warning?". The maintainer chose "Approve its CI runs, 1 and
  assimilate it and improve on it and credit the user and close it" and "Fix it now" for the warning. Done: the
  PR's two CI runs approved (both green); the Docs workflow moved to Node 24 actions (`c473741`, deployed, no
  warning left); Taylor's commit cherry-picked with authorship kept; on top, the `accountGroups` guard on a
  per-call model, an explicit model and variant beating `forceModel` / `defaultSubagentModel` /
  `reasoningEffort` in the child, the dispatch form leaving named tasks out, the V1 gate read off the live
  schema; docs, SKILL.md, credits; measured live on opencode 2.0.31 against v0.59.0. #123 closed with a credit
  comment.
- 2026-10-18: **done** (v0.59.0, PR #124, h #g253): opencode 1/2 parity, after "are all functionalities now for
  opencode v1 and v2 on par?". The answer was not quite: five differences on opencode 2 (`/btw` after the turn, no
  todo panel, `bridgeMcpOauthTokens` finds nothing, the proxy deadline guard never keeps a call, warnings never
  reach the screen), the last three undocumented, plus no tool row for Claude's `EnterPlanMode`, `ExitPlanMode` and
  `NotebookEdit`. The maintainer picked all three follow-ups:
  1. "Busy/idle from V2 events": measured on 2.0.31 and 2.0.22, the stream carries `session.execution.*` (never
     `session.status`). The deadline guard, `/btw` inside the running turn, and a stop releasing its parked proxied
     calls (a sixth gap the probe found) now work on opencode 2.
  2. "Warnings on V2 screen": the plugin's RPC channel to its sidebar half; the toast rendered live on 2.0.31.
  3. "Document the gaps": `docs/opencode-2.md`, the `/btw`, logging and background-subagent pages, SKILL.md,
     AGENTS.md and V2.md. What stays different (todo panel, MCP token read, the three tool rows) is opencode 2's API.
  Also fixed on the way: an empty "between turns" block the replay wrote over frames with no reply text. Probe
  trap recorded: the V2 TUI without `--standalone` starts the background service (stopped; no login item).

- 2026-10-17: **done** (v0.57.0): the sidebar's `Progress` line and per-subagent spend (branch `progress-line`, PR #121,
  history g246, g247, g248).
  Asked as "a visual line that represents a status bar/loading bar with an estimation of how much percent the
  task is completed". Maintainer chose, in order: an honest measured line over an estimated percentage
  ("Honest line, sidebar first"), the `▰▱` glyphs over box drawing ("this is nicer: ▰▱ i want this instead"),
  no dependency for the live rig ("if we can get away with not having dependencies its better"), and the
  spend on the model line ("1 is ok just make sure we use plenty of colors and highlights and low lights to
  emphisis and distinguish the elements"). Code, tests, docs and the AGENTS.md rules are written, and the live
  rig passed on 1.19.0 and 2.0.31 (the `▰▱` glyphs one cell each, the todo fraction on 1.x, the pulse on 2.x, the
  linger, the spend on the model line, zero plugin warnings; screens in history g246). The maintainer's own-pane
  review the same evening asked for two spaces after the bar (first "a ·", then "needs to be" two spaces; asked,
  picked the spaces), a `·` before the spend, and a reset time that fits: built as `· $0.42` with the two sub-lines
  one cell in, and `2026-10-18 01:20` with the word and the year dropped in that order, the same way on every
  line; re-run on the rig, both majors. Then, with three background children running under it, "Progress should
  probably say Main Progress ?": the heading is `Main Progress` now, since right above `Subagents` a bare
  `Progress` read as theirs. Then, with the three running, the pulse was called meaningless ("it goes on and on..
  not showing a begining or an end") and an estimate asked for: the bar is now the turn's elapsed over the total
  this agent and model's own recorded turns predict (`1m02s/~2m30s`, `turn-history.json`, h #g247), no bar until
  three turns are on record, the pulse gone. The maintainer's pane shows it after a restart. Then "good now lets
  keep this and go forward with it as is" with "just 2 things before that": every configured account listed in
  `Accounts` from the first draw (its plan tier and `no reading yet` until its first turn reports, h #g248), and
  the reset time in its own colour apart from the level. **Done**: PR #121 merged as `a7f3fb5` and released as
  **v0.57.0** on 2026-10-17 (the Publish step's own tail `+ @khalilgharbaoui/opencode-claude-code-plugin@0.57.0`,
  shasum `ada756b1…` matching the registry's version document). The maintainer's call on the estimate was "lets
  keep this and go forward with it as is later go back and learn from how it behaved and improve then
  contribute": the revisit is in the Future Features note, to be read off real `turn-history.json` samples and
  the pane's bars, not re-derived. First observations, from a three-child haiku `task_batch` after the restart
  (2026-10-18, `explore/claude-haiku-5-5` at low effort on `appical`): one child called Claude's native `Bash`
  instead of the proxied one and was refused (`Bash is disabled for this session`), opencode reported
  `Subagent failed`, and that child STILL wrote a 6 s sample beside the two real ones (25.0 s, 26.5 s), because
  the CLI's own `result` was a success. So a child that failed on opencode's side skews its key's estimate low;
  candidate for the revisit: skip the sample when the turn's last tool result is an error, or weight it down.
  Second observation (2026-10-18, 01:30): the maintainer's own `Main Progress` bar did not draw after the restart
  because `build/claude-fable-5-1` stayed at two samples: the two main-session turns since wrote none. Read off
  the stores: those turns ran as the `plan` agent on `appical` at `xhigh` (a resume record exists for that key),
  the agent switch is why each turn here replays (h #g239, by design), and no `plan/claude-fable-5-1` key was
  written either. The `go` turn followed an interrupted turn that ended on CLI-native tool calls, so its prompt
  ended `tool`, `user` and `startsTurn` read it as a continuation (never marked); whether a plan turn's prompt
  shape also defeats `startsTurn` is unverified, no plugin log file is in this machine's state dir. Candidate:
  `startsTurn` should treat a trailing `tool` message that matches no pending proxy call as a turn start. A second
  haiku batch, run once the key had three samples, drew the bar on every row (20.7 s, 23.9 s, 48.2 s against a
  ~25 s estimate, the third over in the warning colour). Then (2026-10-18) "that worked", "5h ok needs to be green"
  (an under-threshold level now takes the success colour at full strength, shipped as v0.57.1), "tag the release also
  on github next time" (now a rule in AGENTS.md, h #g249) and "i think thats it for this
  feature right?": yes; what stays open is the estimate revisit in the Future Features note and the `startsTurn`
  candidate above. Then (2026-10-18) "1,2,3,4 yes if needed? 5 not sure": v0.57.0 got its GitHub Release
  backfilled, the merged `progress-line` branch was deleted locally and on origin, `/tmp/pl-rig` was removed,
  the `tui.json` plugin line stays (on 1.x it is the only thing that loads the TUI half), and the reset
  notation is under Deferred decisions. Then "all releases ok?" (2026-10-18): yes. Both v0.57.x are on npm
  (version documents with the published shasums, the `dist-tags` endpoint `latest: 0.57.1`; the package document
  from this Mac stops at 0.54.2, Aikido's filter), CI and Publish green on both tags, a GitHub Release on both.
  Two corrections from the check: v0.57.1 re-marked `--latest` (the backfilled v0.57.0 had taken the badge) and
  its notes lost a false sentence, because `gh release list` showed a Release for every tag back to v0.4.14 and
  v0.57.0 was the lone omission, not "the first since v0.9.2" as this entry, AGENTS.md and h #g249 first said.
  Then (2026-10-18) a Google AI overview of latency prediction, "is this usefull to us in any way?", then "keep
  what usefull and add it to 0.57.2": the two useful pieces shipped as v0.57.2 (h #g250), effort as the measured
  ratio between two efforts' typical durations (scaling the other effort's samples once two turns at each are on
  record) and the turn's tool-call count as a second survival condition beside the elapsed. The formula itself
  (one API call's prefill plus generation) was declined: the clock here is mostly tool time, and the output
  tokens it needs are the unknown. Still open: the estimate revisit after a week of real samples, and the
  `startsTurn` candidate above.
  Then (2026-10-18) "how accurate is this ? or does it rely on historic data always?", "what else can we do to
  improve this calculation?", "what if we do all these and also a predictive mathematical equasion that is genious
  level into the mix?", "All three in 1 PR 1 release 0.58.0 ?", "maybe we keep this in 0.58.0 and use that for a
  while", "go": every candidate went into one PR for the v0.58.0 release (h #g251). The record gained `failed`,
  `out` and a session tag, and a turn after an interrupt is now marked (the `startsTurn` candidate above, closed).
  The estimate is a calibrated log-normal (`src/turn-model.ts`) with shrinkage, recency and a session level, the
  bar draws its band, a live `turn-progress.json` carries the output a turn has generated, a parked parent is
  floored by its foreground children, and `/claude-code-doctor` has a Progress estimate section. **The estimate is
  frozen for observation**: after a week, read the doctor's section first. Known from day one: the build key ends
  in its band 33% of the time against the explore keys' 67%, because the calibration pools every key's errors, so
  a per-key calibration is the first candidate; the mid-turn conditions (calls, output, the floor) are not measured
  by the section, which assesses each turn at its start.
  Then (2026-10-18) "so npm and tags are on par?": npm yes, every tag from v0.6.2 on and v0.58.0 as `latest` (v0.1.3,
  v0.6.0 and v0.6.1 never reached npm; npm's first publish, 0.1.0, has no tag). GitHub Releases no: 17 tags had none
  (v0.9.3 to v0.13.1, v0.21.0, v0.27.1, v0.27.2, v0.41.0 to v0.42.3), so the "lone omission" above was wrong, a list's
  span read as a diff. The form was answered "Backfill all 17" and "Add a note": all 17 were created with
  `--latest=false`, v0.1.3's Release got a not-published note, and v0.6.0/v0.6.1's literal `\n` line breaks were fixed.
  Now 145 tags, 145 Releases, v0.58.0 still Latest (h #g252).

- 2026-10-17: **done**: "whatever is done is done and shipped whatever still needs work consolidate it here and do
  it and close them if they are already done and finished then like i said close and done". The three finished
  windows on this project, relaunched by Herdr's restore at 20:02, were checked against opencode's database and
  the repo: the README/funding session (`51a0aed`, pushed; `.github/FUNDING.yml` already carried the Sponsor
  key), the skill-bridge dedup session of 09-23 (shipped as PR #45, `f8d93f9`, `bridgeSkipNativeSkills`) and the
  zshrc/skill session of 09-20 (config work outside the repo, reported complete). Nothing was left to
  consolidate, so the three opencode processes were ended with SIGTERM; their pane shells were left alone.

- 2026-10-16 to 2026-10-17: **done**: research pass 2's P1 build, released as v0.56.0. Lane A: DONE, PR #117 merged as `96c33f4` (replay a rewound thread into a
  fresh session, history g242), measured live against opencode's own revert route. Lane B: DONE, PR #118 merged as
  `6cc612a` (`mapReadRules`, history g243; the first implementor died on appical's window, a second continued its
  worktree on the default account). Lanes C (usage before the wall, history g244) and D (budgets and caps, history
  g245): first dispatched 2026-10-16 23:17 CEST, but `subagentDispatch: "ask"` held both calls for the operator's
  answer overnight (`proxy call still waiting, no deadline` every five minutes in plugin.log) until the forms were
  answered at 12:44 CEST on 2026-10-17, seconds after the Mac woke from sleep (pmset: lid wake 12:44:01); every
  fresh `claude` spawn of the next three minutes (both lanes and two build sessions) stayed silent past the 90 s
  start watchdog twice and ended as an error, nothing written. Re-dispatched 2026-10-17 13:00 CEST as ONE
  `task_batch` (one form to answer), same briefs (vault `Research pass 2/briefs/`, preamble updated): lane C `ses_eb6181559ffeRDgsFuHUvyd4os`, lane D `ses_eb618154fffeOZ1EYI2dn1OoWk`.
  Both died on the "default" account's 5-hour window (resets 17:10 CEST) with uncommitted work in their worktrees
  (C: `src/account-usage.ts`, `src/account-sidebar.ts` and wiring across 11 files; D: `src/budget-ledger.ts`,
  per-agent caps and option types, not yet wired into the turn; neither had tests, docs or a history entry).
  Maintainer: "limit hit", then "go". Re-dispatched 2026-10-17 15:35 CEST as ONE `task_batch` on the appical
  window (fresh, resets 20:20), continuing the same worktrees with continuation briefs `lane-c2.md` and
  `lane-d2.md` beside the originals: lane C2 `ses_eb5eb6718ffeM0ydCnCYAx6Kau`, lane D2 `ses_eb5eb670dffeKWQnXz9ZmLVDL0`.
  Lane C2 delivered PR #119 (two Windows-only test fixes added by the parent: the stream test joined the
  fake-CLI skip list, the store test guards its POSIX mode asserts), merged as `3729af2`. Lane D2 delivered
  PR #120 (the parent merged master into it, keeping both lanes' additions side by side, added
  `budget.test.ts` to the Windows skip list, gate 1720/1720); its probes ran on the appical account because
  the default window was closed. Merged as `7d0cdf8`, but not on the first try: the main checkout had been
  switched to another session's `progress-line` branch, so that merge and the TODO.md record before it landed
  there, `git push origin master` pushed nothing, and deleting the lane branch closed PR #120 unmerged. Fixed
  from the release worktree: the branch restored, the PR reopened, master fast-forwarded to the same commits
  (GitHub then marked it merged). Lesson: a parent session commits from its own worktree on master, never from
  the shared main checkout. The lane C2 finding below was fixed as `e3b1f6a` before the release, which is one
  minor bump carrying all four P1 items (PRs #117 to #120).
  - Found by lane D2, follow-up: a headless `result`'s `total_cost_usd` is CUMULATIVE per Claude session, so
    every `turnStats` footer after a process's first shows the session's running total, not that turn's
    cost (h #g245 and the AGENTS.md `turnStats` bullet record it). Fix shape: print the turn's delta, the
    ledger's `costDelta` already computes it.
  - Found by lane C2, fixed before the release as `e3b1f6a` (one line plus a test): `src/cleanup-stale.ts:103` creates the
    shared `$XDG_STATE_HOME/opencode-claude-code-plugin` directory at startup with no mode, so it is `0755` and
    the `0700` every store's `mkdirSync` asks for applies only when a store creates it first. The files inside
    are `0600` either way, so names leak, not contents.
  - Found on the way, not built: the start watchdog (90 s) is shorter than the `MCP_TIMEOUT=120000` the plugin
    sets on every spawn (h #g235), so a fresh spawn whose MCP servers take between 90 and 120 s to answer is
    killed before its `system`/`init` frame, and right after a wake from sleep that is every spawn for a few
    minutes. Candidate: a spawn that has not emitted `init` yet gets at least `MCP_TIMEOUT` plus a margin before
    the first fire. Cause correlated, not proven: the CLI's own MCP logs were not found; a spawn at 12:47:54
    answered within seconds.

- 2026-10-16: **done** (probes, no code): "go ahead with the recommended". The eleven verify-first probes of
  research pass 2 (h #g241): headless permission mode stays `default` under the hygiene env var; that env var
  is the cause of the fast-mode init/result quirk; `/advisor` still gated headless, `/context` works headless
  at zero cost; opencode's `*.env` read rule (an `ask` by default, not a deny, read at v1.19.0) does NOT reach Claude's native Read, which read the secret with no prompt (confirmed, P1); a `Bash` hook
  matcher does not fire on a proxied call but `mcp__opencode_proxy__bash` does; `--system-prompt-snapshot off`
  makes the new appended prompt win on a plain resume (QUAIL), reopening single-session agent switches as a
  P2 decision; `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS` gave no cache gain; retry watchdog and the interactive
  billing rate read or deferred; Anthropic's monthly API credits for Max and Team are live since 2026-10-07.
- 2026-10-16: **done** (research, no code): "check other agents like cline, pi, hermes, openclaw etc.. ... assimilate as
  much as possible", then "1 go". Research pass 2: 16 background audits (Cline, Codex CLI, Gemini CLI, OpenClaw,
  Hermes, pi, Aider, Goose, oh-my-opencode, Roo/Kilo, Cursor, Copilot CLI, Amp, Zed/ACP, Continue, the
  Claude-in-opencode shims), each a scored table against the plugin's baseline, saved in the vault under
  `opencode-claude-code-plugin/Research pass 2/`, with the synthesis (landscape, eleven verify-first probes, a
  P1 to P4 Next-up table, declined items) in `Future Features.md`. Converged findings: opencode `/undo` and
  edits never reach a reused Claude session (7 audits); per-account usage before the limit (7); session and
  per-account spend caps plus `--max-turns` / `--max-budget-usd` pass-through (7); opencode's default `*.env`
  read deny does not reach Claude's native Read/Glob/Grep (2, security, probe first). Nothing built yet.
- 2026-10-16: **done**: "do the sweep now and keep the schedule as is so next sweep is on time". Compatibility
  sweep (h #g240): opencode 1.19.0's plugin API byte-identical to 1.18.35's; opencode 2.0.31 additive over
  2.0.22 (`credential`, `permission.assert`, TUI dialog actions; `session.active` still absent); Claude Code
  2.1.300 headless through 1.19.0 (text, proxied bash, native read, reuse, compact, doctor) and the PTY e2e
  (new `api-request*` transcript records tolerated). Nothing needed code. `INTERACTIVE_MEASURED_CLI` stays
  2.1.293 until the full interactive list runs on 2.1.300. The fork-sweep schedule is untouched: next due
  early November 2026 (last 2026-10-08).
- 2026-10-16: **done**: "lets first fix the issues and address the PR open on this repo". PR #115 (@broskees,
  `accountFailover: "auto"`) reviewed in full, typecheck and suite green locally, merged with credit (h #g236).
  #113: opencode 2's `subpath` is relative to the project root and was being appended to the session's own
  absolute directory, so every session below a project root spawned `claude` in a directory that does not
  exist (h #g237). #116: the text replay is bounded at 180,000 characters, newest first (h #g238). #114: a
  reused or resumed `claude` process is told what the conversation said under the other agent while it was
  away, replayed ahead of the current message, and the newest six replayed messages keep 12,000 characters
  each (h #g239). Both measured live the same day: a build/plan/plan/build codeword exchange on opencode
  1.19.0 (the build process answered the plan's word), and a 2.0.22 run from `root/pkg/a` spawning there.
  Released as **v0.55.0** (CI publish green, `+ @khalilgharbaoui/opencode-claude-code-plugin@0.55.0` in the
  step's tail, registry shasum `674e06a1`). The Windows job went red on the new fake-CLI file, which spawns
  a `.cjs` shim (`spawn EFTYPE`) like every other fake-CLI test; added to `windows-skipped-tests.txt`.
- 2026-10-08: **done** (v0.54.1): "looks good the effort however needs to be yellow then its perfect". The effort
  on a sidebar row's second line is the theme's warning colour (opencode 1 `theme.warning`, opencode 2
  `text.feedback.warning`), faded on a finished row; the second line is now one line of spans.
- 2026-10-08: **done** (v0.54.0): the Subagents section in the TUI sidebar ("a very short reference to them
  in the sidebar at the bottom ... what model/effort/account its on ... not option in but just there always").
  Always on, `dist/tui.js` serves opencode 1 and 2; model/effort/account come from `session-spawns.json`, what
  the plugin really spawned. A click opens the subagent's session (routes cannot target a message). opencode 1
  needs the plugin entry in tui.json(c): added to the maintainer's `~/.config/opencode/tui.jsonc` (backup
  beside it). PR #112, h #g234.
- 2026-10-08: **done** (v0.53.5): "1 fix it now". A `task_batch` flagged `isError` because one child failed is
  now read section by section, so the background children it did start are recorded and counted; failed and
  missing sections are skipped, a failed single `task` still records nothing (h #g233).
- 2026-10-08: **done** (v0.53.4): "2 is maybe usefull wont take too much resources build it". An accepted
  background dispatch's reply ends with `Background subagents running now: N (including this one).`, at most
  4 lookups and 500 ms, omitted on overrun or an unreadable child (PR #111, h #g232). The stall that cost the
  first attempt its tools did not recur after the relaunch onto v0.53.3 (proxy connected at once). Also
  hardened two broker stall-warning tests that flaked on Windows timer resolution.
- 2026-10-08: **done** (v0.53.3): "yes do that please because the startup confuses ... just need to know
  how many agents are working at a time to not overload". Cause measured: a new `claude` waits up to ~30 s
  for MCP servers, and `explore` got every server bridged directly (slack via `op`, obsidian via `zsh`
  never connect there). Now a server opencode has connected but withheld from the agent is left out;
  allowed servers stay proxied, servers opencode is not running keep the bridge. The doctor shows
  `running now: N (of M started by this process)`. Background subagents stay on. PR #110, h #g231.
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
