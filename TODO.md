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

Only decisions about this plugin belong here. Items about the global opencode config
(Slack MCP auth, opencode's Linear OAuth, the unused `lmstudio` block) and the separate
`opencode-local-ollama` package were moved on 2026-09-28 to the vault note
`opencode/Open items.md`; they were recorded here only because the sessions that raised
them ran in this directory.

## Open from you


Questions the maintainer still owes an answer on. Written here the turn they are
raised, so they survive context compaction; removed when answered, done or dropped.

- 2026-10-02: the repository is still a GitHub fork of unixfox/opencode-claude-code-plugin ("forked
  from" on every page, and that link is not nofollow, unlike README links to other sites). Only
  GitHub Support can detach it (github.com/contact, "detach a fork"; stars, issues and PRs stay).
  The maintainer's call.
- 2026-10-02: **docs site domain `opencode-claude-code-plugin.dev`** (maintainer's, on Cloudflare;
  "you add them you have access to all"). Site side ready as draft PR #79 (branch `custom-domain`).
  The DNS needs a Cloudflare credential: none on this machine besides Wrangler's OAuth login, which has
  no DNS scope; the personal 1Password account (`my.1password.com`) was tried twice and its approval
  prompt timed out both times. Next: the maintainer approves the 1Password prompt on a retry (one
  script finds a Cloudflare API credential there and adds the records), or adds the records
  themselves: four `A` @ 185.199.108-111.153, four `AAAA` @ 2606:50c0:8000-8003::153, `www` CNAME
  khalilgharbaoui.github.io, all DNS only. Then: Pages custom domain, certificate, enforce HTTPS,
  merge #79 (merge master into it first), verify, release, update the `ref_docs_site` memory.
- 2026-10-02: the widget's colour stays the maintainer's `#FF813F` (BMC orange); the designer
  suggests `#E8A33A` to match the site's amber. Change it, or keep?
- 2026-10-02: the docs site's `github.io` address redirects to **plain http** on
  `khalilgharbaoui.codez.it`, because the user site `khalilgharbaoui.github.io` (which owns that
  custom domain) has HTTPS not enforced, though its certificate is approved. Enforcing it changes
  the maintainer's personal site too. Enforce it, or leave?
- 2026-10-02: upload `site/public/social-preview.png` in Settings, General, Social preview (GitHub
  has no API for it), so links to the repo show the designed card.
- 2026-10-02: the repo has no topics and no website link in its About box. Set topics (for
  example opencode, opencode-plugin, claude-code, claude, anthropic, ai-sdk) and the website to
  the docs site, for discoverability? Both are public repo settings.
- 2026-09-26: Windows spawns go through `cmd.exe` with no argument quoting (injection with
  `& | > ^`, broken with spaces or quotes); needs a Windows CI job first, then a resolver and
  escaper. 2026-09-27: left documented until a Windows user appears (none has ever filed an
  issue). The other two follow-ups from that day shipped (v0.29.0 PR #55, v0.29.1 PR #58 and #59).

## Parked

Nothing parked.

## In progress

- 2026-09-23: opencode 2, the checks that were not possible before release. (1) **Done
  2026-09-27**: install by npm name works on 2.0.16 (`@0.27.0`, with and without a provider
  block; `@0.28.1` is still hidden from this Mac by Aikido's age filter). (2) Account
  failover and the plan-mode form on V2, which need a real usage limit and a headless
  `ExitPlanMode`. (3) Permission prompts in the V2 TUI: every probe ran with `--auto`.
  Sandbox moved to 2.0.16 the same day; evidence in `V2.md`.

## Done

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
