---
name: claude-code-plugin
description: Configure and troubleshoot the opencode-claude-code-plugin, the opencode provider that runs Anthropic Claude models through the Claude Code CLI. Use when the user wants to install, set up, change or debug this plugin, meaning anything under provider.claude-code.options in opencode.json (accounts, proxyTools, cwd, permissions, MCP bridging, timeouts, logging), subagent model or effort, model ids and variants, /btw, the skill bridge, upgrades, or reading plugin.log. Not for opencode's own general configuration.
---

# Configuring the Claude Code plugin

This plugin is `@khalilgharbaoui/opencode-claude-code-plugin`. It registers one or more
`claude-code*` providers and routes inference through the `claude` CLI, not opencode's
native Anthropic provider. Headless `--print` is the default, which is the Agent SDK
path. Never promise a user what subscription headless usage draws from: Anthropic's
policy page is the only authority and it changes (fetched 2026-09-27 it carries a June 15
update pausing the announced Agent SDK credit, so that usage still draws from plan usage
limits and the monthly credit is unavailable). API-key/cloud billing depends on the CLI's
authentication. Confirm the user's intended account and billing method.

## How this differs from the alternatives

Three routes reach Claude from opencode, and they are not interchangeable:

1. **opencode's native `anthropic` provider**: an Anthropic Platform API key in
   opencode's auth store, pay as you go, everything running in opencode's own runtime.
2. **This plugin**: the official `claude` CLI authenticates, so opencode inherits
   whatever that CLI holds (subscription login, API key, Bedrock, Vertex). It never
   reads, stores or replays a token, which is why it is a sanctioned route. What it
   costs: a `claude` child per conversation, Claude Code's own context compaction and
   clearing happening behind opencode's back, a locally synthesised session title
   instead of a model-written one, `/compact` on its own short-lived spawn, no todo
   panel on opencode 2, and opencode's native reasoning features bypassed by design.
3. **Proxy or token-reuse plugins** (`opencode-with-claude`/Meridian,
   `opencode-claude-auth`, `opencode-claude-plan`): they reuse the Claude OAuth session
   outside the official client. Anthropic disallowed that for third-party use in
   February 2026, and each of those projects says so in its own README (a "community
   workaround", "no claims regarding compliance", "could be suspended or terminated").

Never recommend route 3, never help migrate a user onto it, and never enable
`interactive: true` to dodge a billing or access restriction. If a user asks why this
plugin is slower or heavier than a proxy, the answer is route 2's cost list above, plus
the tool mediation: proxied `Bash`/`Edit`/`Write`/`WebFetch`/`Task` execute in opencode
under its permissions instead of inside the CLI.

This file ships with the package, so upgrading that package updates the bundled
reference without a separate skill install. Do not copy it into a personal skill
directory: a user override can shadow the bundled version. Match guidance to the
version actually loaded, not a newer checkout. `test-configure-skill.ts` checks name
coverage against source declarations; it does not verify defaults or runtime
semantics or regenerate prose. For behavior, inspect the matching version's
`src/types.ts`, consumers in `src/index.ts` / `src/claude-code-language-model.ts`, and
the relevant module. Comments and README can lag the implementation.

## Ground rules

1. **Config lives in opencode's config, not in a plugin file.** Start at
   `provider.claude-code.options`. Global defaults usually live in
   `~/.config/opencode/opencode.json[c]`; project `opencode.json[c]` and `.opencode/`
   files can override them. Check `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR` and
   `XDG_CONFIG_HOME` before selecting a file. With `accounts`, the seed options are
   inherited; an existing `provider.claude-code-<account>.options` can override them.
2. **Provider options are read once, at opencode startup.** After any change the user must fully
   quit and relaunch opencode. A plain `/new` session is not enough, and every other
   opencode window still open keeps running the old configuration and the old plugin
   code. Include serve/GUI processes. Say this every time you change something.
   Bridged MCP config has a limited next-turn hot reload, not general config reload.
3. **Edit minimally.** Keep the user's comments in `.jsonc`, keep key order, change only
   the keys asked for, and re-parse afterwards. Use surgical text edits or a
   JSONC-aware edit API. This package already depends on `jsonc-parser`: its `modify`
   and `applyEdits` preserve unrelated text; `parse` must be checked for errors
   (`allowTrailingComma: true` for JSONC). Never strip comments with regex or round-trip
   JSONC through `JSON.stringify`; that can corrupt URLs or erase comments.
4. **Never edit `dist/`, `node_modules/`, or `~/.cache/opencode/packages/`** to change
   behavior. Build output and installer caches are not configuration.
5. **No credentials exposure.** Never read or print auth files, tokens, keys, a full
   environment dump, or generated MCP configs. Check credential presence only, not
   values. Config, diffs and logs can contain secrets or private prompts; inspect only
   relevant fields and redact before displaying or sharing. Leave secret references
   such as `{env:NAME}` intact. Do not initiate login/account switching without approval.
6. **No paid probes or risky changes without explicit approval.** Do not run inference
   (`claude -p`, `opencode run`, `/btw`), enable extra usage, change billing, grant broad
   tool permissions, or enable experimental flags as a routine verification step.
   Explain consequences first, including `Question`, `planModeQuestion`, `Compress`,
   `interactive`, skill/MCP bridging and fast models. Ask in ordinary text if a decision
   is needed. Do not enable the `Question` proxy in order to ask one: it is opt-in
   precisely because it disables Claude's own `AskUserQuestion`.

## Procedure

1. Identify install source/version, config scope, account/provider and requested change.
   Inspect relevant config layers without exposing secrets. Preserve unrelated work.
2. If installation is requested, add the scoped package to the existing `plugin` array,
   not a replacement array. Preserve pins and `file://` installs unless upgrading was
   requested. A local checkout entry is `file:///abs/path/to/opencode-claude-code-plugin`.
3. Edit only the needed options/agent keys. Do not populate every default or invent
   plugin-level options, `apiKey`, model metadata, or derived account fields.
4. Validate syntax and the opencode schema (`https://opencode.ai/config.json` when
   needed). Schema validation alone does not validate this plugin's free-form options;
   check this reference and source for names, types, units and enums.
5. Review the minimal, redacted diff. Report what changed and any unverified behavior.
6. Tell the user to fully restart opencode. Prefer offline checks below; get approval
   before launching another opencode process, which may also start configured MCPs.

## Options reference

Use `provider.claude-code.options` unless intentionally overriding an expanded account.
That key is read by both opencode majors; opencode 2's own spelling is
`providers.claude-code.settings`, and the full precedence is in the opencode 2 recipe.
Defaults below describe normal headless opencode use when the key is absent.

| Option | Type | Default | What it does |
|---|---|---|---|
| `cliPath` | string | `"claude"` | Executable, not a shell command with flags. Use an absolute path for a non-PATH install. The opencode config hook supplies this default; only direct `createClaudeCode()` use falls back to `CLAUDE_CLI_PATH`. Account providers wrap it; never select a generated wrapper yourself. |
| `accounts` | string[] | unset | Unset keeps provider `claude-code`. Any array, including `[]`, expands to `claude-code-default` plus normalized, deduplicated names. Non-default accounts use `~/.claude-<name>`; default uses the CLI's normal environment/auth. |
| `accountFailover` | `"ask"` / `"off"` | `"ask"` | When the account a conversation runs on is out of usage, end the turn on opencode's native `question` form listing the other configured accounts, and continue the task on the pick inside the same opencode turn. Only ever fires with more than one account configured, so a single-account install is unaffected by the default. The pick is sticky for the LIMITED account until the limit's reset time (or until opencode restarts when the CLI reported none), so it covers every session on that account and subagents follow their parent; child sessions are never shown the form. Leaving it unanswered waits and costs nothing. `stop`, a dismissal, or text that is not one of the offered accounts ends the turn as the rate-limit error does. Triggered only by a rejected `rate_limit_event`, one of the two known account-limit error texts, or one of the five account-level failure kinds the CLI names on its own error reply (`authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `verification_required`, `billing_error`); never by a generic failure. Never on compaction turns or the interactive transport. A switch cannot resume the Claude session (transcripts live under the account's own config dir), so the conversation is replayed into a fresh one: it costs input tokens on the new account, and MCP servers configured only in the limited account's Claude profile are gone. `"off"` keeps the plain rate-limit error. |
| `failoverAccounts` | string[] | unset/derived | Account expansion supplies the resolved account list so a limited account can offer the others. Do not hand-wire it; set `accounts` instead. |
| `baseCliPath` | string | unset/derived | The `cliPath` before the per-account wrapper substitution, so a failover can build another account's wrapper on the same binary. Supplied by the config hook. Do not hand-wire it. |
| `defaultSubagentModel` | string | unset | Seed-config default for discovered `mode: subagent` agents without a full `provider/model` pin; `forceModel` takes precedence. Keeps the caller's account. Unknown ids warn and keep the inherited model. Not independently read per expanded account. |
| `defaultSubagentCacheTtl` | string | unset | Prompt cache TTL (`5m` / `1h`) for discovered `mode: subagent` agents that declare no `cacheTtl`; the agent's own value takes precedence. Unset leaves the CLI's default (1 hour on a subscription). Unknown values warn and change nothing. Headless spawns only (not compaction, not the interactive transport). |
| `fallbackModels` | string[] | unset | Ordered models to try when the model a turn would run on is refused. Default for agents declaring no `fallbackModels`; a per-agent list replaces it rather than extending it. Same account throughout, never a switch. Armed only by the CLI refusing the model (`model_not_found`) or by a usage limit when `accountFailover` has no other account to offer; with another account the switch form wins. Entries must be registered model ids, unknown ones warn and are skipped, the current model is dropped from its own chain, each entry is tried at most once per turn, and an exhausted chain surfaces the original error. Never on compaction, title stubs or the interactive transport. Writes a `▌ **model fallback:**` note that transcript rebuilds strip. Not independently read per expanded account. |
| `cwd` | string | automatic | Pin an absolute existing directory. Otherwise: session directory from SDK, usable `process.cwd()`, captured project directory, final `process.cwd()` fallback. Startup diagnostics cannot show the per-call session tier. |
| `skipPermissions` | boolean | `true` | Pass `--dangerously-skip-permissions` to headless Claude, even with proxies enabled. Proxied calls still use opencode permissions, but unproxied CLI tools do not. `false` removes the bypass flag; it does not by itself create human approval prompts. Ignored when `permissionMode` is `"plan"`, which always drops the flag. |
| `permissionMode` | `acceptEdits` / `auto` / `bypassPermissions` / `default` / `dontAsk` / `plan` | unset | Headless `--permission-mode`, not version-gated: verify the installed CLI supports the value. `plan` is enforced: it overrides `skipPermissions: true` and the plugin drops `--dangerously-skip-permissions` for it, so claude cannot edit or run commands. Every other value governs prompting and still passes the skip flag, so `plan` is the only one that makes a run read-only. Nothing releases plan mode mid-session (no headless `ExitPlanMode`), so leaving it means a config change and an opencode restart; the plugin warns once at startup. Not forwarded by the current interactive spawn path. |
| `permissionPreset` | `"read-only"` | unset | One named posture instead of hand-combining the options around it. Unset changes nothing. An applied preset replaces `permissionMode`, `skipPermissions`, `controlRequestBehavior` and `controlRequestToolBehaviors` outright, filters `proxyTools`, and unions its own names into `extraDisallowedTools`. `read-only` forces `skipPermissions: false` (the CLI exits with `bypassPermissions not supported in restricted mode` if both are passed), replaces any `permissionMode` with `--restricted` (CLI 2.1.258+: no Bash, REPL or other code runners, no WebFetch, file tools confined to the working directories, bypass refused), adds `--permission-prompts none` (CLI 2.1.263+), disallows `Bash`, `Write`, `Edit`, `NotebookEdit`, `REPL`, `JavaScript` and `WebFetch` via `--disallowedTools`, drops `bash`/`write`/`edit`/`webfetch`/`task`/`task_batch` from `proxyTools`, forces `controlRequestBehavior: "deny"` and ignores `controlRequestToolBehaviors` entirely. Every override is logged at NOTICE. An unknown preset name applies nothing and WARNs rather than guessing. On a CLI below either flag gate the preset still holds through `--disallowedTools` plus the plugin's own deny, with a WARN naming what is lost. Reads (`Read`, `Grep`, `Glob`, `WebSearch`) still work; anything else that would prompt, including bridged MCP tools and the `question` proxy, is denied. |
| `controlRequestBehavior` | `allow` / `deny` | `allow` | Automatically answer CLI `can_use_tool` requests if emitted. Forced to `deny` by `permissionPreset: "read-only"`. Not an opencode permission prompt or a sandbox; bypass/pre-allowed tools may never ask. `AskUserQuestion` defaults to deny. |
| `controlRequestToolBehaviors` | object of tool name to `allow`/`deny` | unset | Case-insensitive per-tool override of the above (`Bash`, `Read`, `mcp__github__list_prs`). Do not allow `AskUserQuestion`: that can let headless Claude self-answer. |
| `controlRequestDenyMessage` | string | built-in text | Override ordinary deny text. `AskUserQuestion` always uses its own stop-and-wait message. |
| `proxyTools` | string[] | `["Bash", "Edit", "Write", "WebFetch", "Task"]` | Case-insensitive replacement list, not additive and not a capability allowlist. Known entries expose `mcp__opencode_proxy__<name>`; omitted/unknown tools are not disabled. `Task` also brings `task_batch`; `[]` disables this list, not MCP proxying. See the proxy table for exceptions. |
| `extraDisallowedTools` | string[] | unset | Claude built-ins to switch off outright with `--disallowedTools`, for tools that have no proxy (`["NotebookEdit"]`). Removes the capability rather than routing it. |
| `proxyToolTimeoutMs` | object of proxy tool name to ms | unset | Optional wall-clock backstop per tool, in ms, case-insensitive keys. A proxied call normally ends on an event the plugin listens for, not on a timer: opencode's result, an abort (the CLI is interrupted), the next user message (calls the previous turn left pending are rejected as orphaned), the `claude` process exiting, the chat being deleted, or opencode exiting. Fallback 10 min (including dynamic MCP tools); `task` and `task_batch` have no deadline, so a subagent runs to completion and a chat parked in one holds its worker until one of those events; `question` 30 min. Set both task keys to cover both. A positive value replaces the default, `0` removes that tool's deadline, negative or non-numeric values are ignored, and values above 2147483647 are clamped. Bash `input.timeout` raises the resolved deadline (and restores one after `bash: 0`); executor ceilings still apply. The generated MCP client timeout is the largest effective deadline, or the CLI's maximum while any tool has none. `compress` is intercepted without a deadline. |
| `planModeQuestion` | boolean | `false` | Bridge `ExitPlanMode` approval to opencode's `question` and return a real CLI tool result. Requires a live question registry entry; otherwise keeps text fallback. Cannot fire on the headless transport: CLI 2.1.258 does not offer `ExitPlanMode` under `--print`, measured directly and through a full plugin probe, so the text path is what runs. Prose yes/no is not a verified CLI plan-mode unlock. |
| `webSearch` | `"claude"` / `"disabled"` / `"<opencode tool name>"` | `"claude"` | Default: CLI search with the query rendered as text. Custom target forwards a tool call to an existing opencode tool accepting `query`; this is mapping, not the authenticated proxy replacement, so do not assume CLI search is suppressed. `"disabled"` disallows headless `WebSearch`. |
| `bridgeOpencodeMcp` | boolean | `true` | Discover/translate disk MCP config plus runtime enabled status. False stops this bridge, not explicit `mcpConfig`, the built-in-tool proxy, or Claude's own MCP settings. Only bridge trusted servers. |
| `mcpConfig` | string or string[] | unset | Extra `--mcp-config` paths or inline JSON passed alongside the bridged config. |
| `strictMcpConfig` | boolean | `false` | Headless `--strict-mcp-config`: use only explicitly supplied MCP configs, ignoring other MCP sources, not all settings/credentials/hooks. The interactive wrapper adds it whenever it passes MCP paths, independently of this option. |
| `hotReloadMcp` | boolean | `true` | With bridging on, compare merged MCP config/status at turn start and respawn on drift, so a server enabled, disabled or finished connecting since the spawn reaches the model. Keeps the session via headless `--resume`. Acts only at a safe boundary: never during compaction, never on the interactive transport, and never while a proxied call is pending, a turn is in flight or a plan-mode approval is outstanding. Logs the joined and left server names at INFO. One respawn per conversation per `CLAUDE_CODE_MCP_HOT_RELOAD_COOLDOWN_MS` (default 60000) so a flapping server cannot respawn every turn. Does not reload arbitrary provider options or watch explicit `mcpConfig` contents. |
| `mcpConnectWaitMs` | number | `3000` | How long the first turn waits for MCP servers the host reports as still connecting before planning the spawn without them. Only opencode 2 reports that state (`pending`); opencode 1's status call blocks until every server decides, so this is a no-op there and costs one status call as before. `0` disables the wait; negative or non-numeric values fall back to the default. Aborting the turn ends the wait at once, and the turn then spawns nothing. A server slower than the budget is still bridged (pending is not read as disabled) and `hotReloadMcp` brings a later one in on the next turn. |
| `proxyOpencodeMcpTools` | boolean | `false` | Route opencode's MCP-backed tools through opencode's executor instead of Claude's own `--mcp-config` child, so each call is permission-prompted and rendered as an opencode tool row. Default changed `true` to `false` here, with no behaviour change: at `true` it routed nothing, because discovery read opencode's tool registry, which never contains MCP tools. Discovery now reads the model tool set opencode passes the provider, verified live on opencode 1.18.31 / Claude Code 2.1.263. **Tell the user to set `strictMcpConfig: true` alongside it**: a server also present in Claude Code's own config is reached directly and the proxy is bypassed, which looks exactly like the option doing nothing. A routed call runs with the calling agent's permissions. Servers whose tools are not found stay on the direct bridge and log a warning. Inert with `bridgeOpencodeMcp: false`, which leaves no bridged server list to match names against. Do not promise exactly-once side effects across failures, retries or opencode versions; verify routing before using write-capable tools. |
| `proxyOpencodeTools` | string[] | `[]` | Forward explicitly named opencode tools (case-insensitive): V1 resolves registry ids; V2 resolves the current model tool snapshot and its actual JSON Schema, including synthesized Code Mode `execute`, without re-exposing tools absent from that snapshot. Covers plugin-declared tools such as DCP's `compress` and V2 Code Mode. Same broker as other proxies; collisions and unknown names warn. Explicit allowlist only, because calls run in opencode with the agent's permissions. `execute` grants access to the session's whole Code Mode catalog, not just MCP, and is refused by the read-only preset. |
| `stripContextReminders` | boolean | `false` | Strip opencode-dcp `<dcp-system-reminder>` blocks from user/assistant message text, including the fresh-session rebuild. Only when no `compress` is proxied via `proxyTools` or `proxyOpencodeTools`; reachable compress makes it inert. Resolved from config, so a configured-but-unregistered name still counts as reachable. Leaves opencode's own `<system-reminder>` blocks alone. |
| `multiStepContinuation` | boolean | `true` | Append a system-prompt hint to chain tool calls in one turn instead of stopping between subtasks. |
| `autoContinueIncompleteTurns` | boolean or `"smart"` | `"smart"` | `true`/`"smart"` continue a turn truncated at `max_tokens`, bounded by 8 attempts and 10 minutes, and otherwise run the keyword heuristic only when stop reason is missing. Every other stop reason, plus error, abort or latched question, stops it. Current measured CLIs always report a reason, so truncation is the only case that resumes in practice. Also gates the `▌ **no reply:**` note written when a turn finishes cleanly with no text and no tool call; `false` turns off the note as well as the continuation. |
| `compactionModel` | string | `"claude-haiku-4-5"` | `/compact` uses a fresh short-lived headless process without the usual bridge/proxy/skill wiring. Nonblank `CLAUDE_CODE_COMPACTION_MODEL` wins. This is inference and can be billed. |
| `ignoreAnthropicApiKey` | boolean | `false` | Strip `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from headless/interactive spawn env, allowing stored auth to be used. Does not log in, change the parent env, or guarantee subscription billing if other CLI/cloud auth is configured. Warns at startup when either nonempty variable is present, regardless of the flag. |
| `idleProcessTimeoutMs` | number | unset | Kill a conversation's idle `claude` worker this many ms after a finished turn. The timer starts when a turn completes, reuse cancels it, and a worker found mid-turn when it fires is re-timed rather than killed. The session id is kept, so the next message resumes transparently. Unset or `0` keeps workers until LRU eviction (16 processes, oldest idle first). Values above `2147483647` are ignored. Not applied to the interactive transport. Deleting a chat in opencode releases its workers and session ids immediately regardless. |
| `turnStats` | boolean | `false` | Append one `▌ **stats:**` line to each finished turn: cost, wall duration, CLI turn count, input/output/cache-read/cache-write tokens, and a permission-denial count when the turn had any, taken from the CLI's own `result`. Never on a compaction turn or a turn that ended in error. Its own text part, stripped from transcripts rebuilt for the CLI, so the model never sees it. The same numbers are logged at INFO regardless, and `modelUsage` plus `permission_denials` always reach `providerMetadata`. Reported cost is the CLI's figure, not a billing guarantee. |
| `forkSessions` | boolean | `false` | When a new opencode session turns out to be a fork of one this provider already served, branch the parent's Claude conversation with `claude --resume <parent> --fork-session` instead of re-rendering the whole thread as text into the first message. Measured on CLI 2.1.280 with haiku 4.5 over a ~13k-token thread: 814 cache tokens written and 39,710 read, against 22,355 written and 17,385 read for the replay, so $0.0058 against $0.0467 for that turn; the parent's transcript is byte-identical afterwards. Neither opencode major tells a provider that a session is a fork, so the parent is found by matching this prompt's history against what each sibling session key was last asked to continue. Off by default because a resumed Claude conversation reuses the system prompt recorded on its FIRST request (`--system-prompt-snapshot`, default `on`), so a forked session answers under the parent's appended system prompt rather than this turn's; measured directly, a parent seeded with codename ZEBRA and forked while passing QUAIL answered ZEBRA. Falls back to the replay, unchanged, for: another account, an unknown or released parent session id, a busy parent (live process, proxied call in flight, unanswered plan-mode question), a fork cut mid-conversation, a fork taken mid tool round trip, a different cwd / model / agent / effort / prompt-cache TTL, compaction, the interactive transport, an account-failover switch, and a `claude` whose `--help` does not advertise `--fork-session`. Recording costs nothing while the option is off. |
| `bridgeOpencodeSkills` | boolean | `false` | Stage the user's opencode skills for Claude's native Skill tool as `opencode-skills:<name>`, on the headless and interactive spawns (never compaction). Covers every root opencode reads: project `.opencode/`, `.claude/`, `.agents/` walking up, the opencode config dirs (`skill/` and `skills/`), and global `~/.claude/skills` and `~/.agents/skills` under opencode's own `OPENCODE_DISABLE_EXTERNAL_SKILLS` / `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` switches. Requires the CLI's `--help` to advertise `--plugin-dir`; otherwise no-op. Bridged skills are also listed in opencode's forwarded system prompt, so a large skill set costs prompt tokens twice, which is why it is off by default; `true` opts the user's skills in. Bundled skill staging ignores this option, but still requires flag support and successful discovery/staging. |
| `bridgeSkipNativeSkills` | boolean | `true` | Leave a skill unbridged when the Claude session already loads it: from `<CLAUDE_CONFIG_DIR>/skills`, the project's `.claude/skills`, or an installed plugin's `skills/`. Matched by resolved directory, by byte-identical SKILL.md, or (user/project scope only, since plugin skills are namespaced `<plugin>:<name>`) by name. A name match means `Skill("<name>")` answers from Claude's copy, not opencode's, so it is logged at WARN with both paths. The plugin scan reads `installed_plugins.json` and does not check whether the plugin is enabled. `false` bridges everything and reinstates the duplicates. |
| `interactive` | boolean | unset (headless) | Experimental PTY transport; explicit boolean wins over `CLAUDE_CODE_INTERACTIVE_TRANSPORT`. Needs `Bun.Terminal`; otherwise headless fallback. Compaction stays headless. Does not wire the headless proxy server or disallowed-tools controls; no equivalent opencode permission guarantee or `/btw`. The skill bridge does apply. Never enable to bypass a billing/access restriction. |
| `interactiveBypass` | boolean | `false` | Deprecated no-op. The TUI asks for a manual safety confirmation on `bypassPermissions`, so the plugin never passes it. |
| `interactiveAllowTools` | string[] | `["Bash", "Edit", "Write", "Read", "WebFetch"]` | With `interactive`: replaces the built-in pre-allow list. MCP wildcards from discovered bridge names plus `mcp__opencode_proxy__*` are added even with `[]`. Not a capability denylist; review permissions before enabling. |
| `interactiveSystemPrompt` | boolean | `true` | With `interactive`: append the plugin's own prompt. opencode's forwarded system prompt is deliberately not sent on this transport (it can trip Claude's third-party usage gate). `false` is for diagnostics only. |
| `logging` | object | see below | File and TUI logging policy. |
| `name` | string | unset | Low-level `createClaudeCode()` provider identity fallback after `providerID`, not the opencode display-name setting. Display name lives at `provider.<id>.name`; account expansion supplies its own label. Leave this option unset. |
| `providerID` | string | derived | Config hook writes the actual provider id (`claude-code` or `claude-code-work`). Do not override manually. |
| `hostApi` | `"v1"` \| `"v2"` | derived | Which opencode major created the model, which decides the tool names its stream uses (`bash` on 1.x, `shell` on 2.x). Set only by the opencode 2 entrypoint. Do not set it: forcing `"v2"` under opencode 1.x makes every proxied tool call fail as an unavailable tool. |
| `account` | string | unset/derived | Account expansion supplies this to generate its runtime wrapper. Prefer `accounts` over hand-wiring it. |
| `configDir` | string | unset/derived | Generated account directory, also used for interactive env/transcript lookup. Not a standalone headless auth switch: headless account selection comes from the wrapper's env. Do not hand-wire it. |

### `logging` object

| Key | Values | Default | Effect |
|---|---|---|---|
| `file` | boolean | `false` | Persist entries that pass `level`. Logs can contain prompts/tool data/CLI arguments; enable temporarily with consent, not as a credential dump. |
| `dir` | path | `~/.local/share/opencode-claude-code/` | Where `plugin.log` goes. |
| `mode` | `"silent"` / `"debug"` | `"silent"` | After level filtering: silent routes lower levels only to the file if enabled; WARN/ERROR go to stderr/TUI too. Debug echoes all emitted levels to stderr, but does not lower the threshold. |
| `level` | `debug` / `info` / `notice` / `warn` / `error` | `"info"` | Minimum level emitted anywhere. |

## Environment variables

Set variables in the environment that launches opencode, then fully restart it.
Precedence is per variable, not a blanket env-over-config rule. CLI-owned variables
are passed through; their final effect depends on the installed CLI. Never print
their secret values. Arbitrary MCP `{env:NAME}` placeholders are outside this list.

| Variable | Effect |
|---|---|
| `CLAUDE_CLI_PATH` | Direct factory fallback for absent `cliPath`. Normal opencode registration supplies `"claude"`; set the option explicitly there. |
| `CLAUDE_CONFIG_DIR` | CLI auth/settings/session directory. Non-default account wrappers override it; default headless account inherits it if set. Login is a user-approved interactive action, never a diagnostic probe. |
| `CLAUDE_CODE_EFFORT_LEVEL` | Shell-level CLI effort. Request variant/agent effort wins on a normal spawn. Compaction omits request/agent effort, but still inherits the shell env. |
| `CLAUDE_CODE_PROMPT_CACHE_TTL` | Shell-level CLI prompt cache TTL for the main conversation. An agent's `cacheTtl` (or `defaultSubagentCacheTtl`) wins on that agent's spawn; with neither set the plugin writes nothing and the shell value, or the CLI's own default, stands. |
| `CLAUDE_CODE_DISABLE_THINKING` | CLI-owned, conventionally `1` to disable thinking. Plugin leaves it intact and suppresses its own thinking flags/summary defaults if enabled. |
| `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` | CLI-owned adaptive-thinking control. Either disable variable suppresses the plugin's own thinking flags/summary defaults, not just adaptive flags. Empty/`0`/`false`/`no`/`off` are false, case-insensitive. |
| `CLAUDE_CODE_SHOW_THINKING_SUMMARIES` | Headless spawn fills in `1` only if unset and neither disable flag is enabled. Any explicit value is preserved and suppresses the plugin's `--thinking-display` override; `0` requests suppression from the CLI. |
| `CLAUDE_CODE_COMPACTION_MODEL` | Nonblank, trimmed value wins over `compactionModel`. |
| `CLAUDE_CODE_DISABLE_FAST_MODE` | CLI-owned kill switch, conventionally `1`; plugin does not interpret it or change picker prices. Use the non-fast id if fast mode is disabled. |
| `CLAUDE_CODE_INTERACTIVE_TRANSPORT` | Fallback when `interactive` is absent: `1` enables; empty/`0`/`false`/`no`/`off` disable (case-insensitive). Explicit `interactive: false` wins. |
| `CLAUDE_CODE_INTERACTIVE_BYPASS` | Deprecated no-op, like `interactiveBypass`. |
| `CLAUDE_CODE_START_WATCHDOG_MS` | Positive integer ms before a headless start or proxy-result continuation is considered silent; default 90000 for missing/invalid/nonpositive values. First expiry respawns, second errors. Bookkeeping-only output is not progress. Keep within timer range; do not lower for routine config checks. |
| `CLAUDE_CODE_RESULT_FALLBACK_MS` | Positive integer ms of stdout silence, after the CLI has produced output, before the turn is closed with no `result`; default 60000 for missing/invalid/nonpositive values. The close is announced in the reply as a `▌ **stream timeout:**` note, which is stripped from any rebuilt transcript. An aborted turn gets no note. |
| `OPENCODE_CLAUDE_CODE_LOG_FILE` | Overrides `logging.file`: trimmed `0/false/no/off` are false; any other nonempty value is true; empty falls back to config. Prefer `1` or `0`. |
| `OPENCODE_CLAUDE_CODE_LOG_DIR` | Overrides `logging.dir`. |
| `OPENCODE_CLAUDE_CODE_LOG_LEVEL` | Overrides `logging.level`. Invalid values fall through to config. |
| `DEBUG` | A value containing `opencode-claude-code` promotes `logging.mode` to debug, not `logging.level`. Preserve other debug namespaces. |
| `OPENCODE_CLAUDE_CODE_PLUGIN_NO_CLEANUP=1` | Skip the removal of a stale unscoped `opencode-claude-code-plugin` install from opencode's package cache. |
| `OPENCODE_CLAUDE_CODE_PLUGIN_FORCE_CLEANUP=1` | Run that cleanup even when the marker at `$XDG_STATE_HOME/opencode-claude-code-plugin/cleanup-stale.json` says this plugin version already swept. Without it the sweep happens once per installed version, not once per opencode launch. |
| `OPENCODE_CLAUDE_CODE_NO_TMP_SWEEP=1` | Skip the startup sweep of `<tmpdir>/opencode-claude-code-<pid>` scratch directories whose pid is dead and which the current user owns. The sweep exists because `SIGKILL` skips the exit hook, leaving the `0600` bridged MCP config (which can hold `{env:VAR}`-substituted secrets) behind. |
| `ANTHROPIC_API_KEY` | CLI API authentication input, stripped when `ignoreAnthropicApiKey` is true; otherwise may change billing away from stored subscription auth. Never display it. |
| `ANTHROPIC_AUTH_TOKEN` | CLI auth-token input; same strip/warning rule. Never display it. |
| `DISABLE_AUTOUPDATER` | Set to `1` on every spawned `claude`, and only when the user has not set it. Keeps the CLI from updating mid-session, which would invalidate the cached version that gates `--thinking-display summarized`, `--plugin-dir` and fast mode. Not a provider option: a user-set value (including `0`, meaning keep updating) is never overwritten, which is the intended escape hatch. Tell a user who wants CLI autoupdates to export `DISABLE_AUTOUPDATER=0`, not to look for a config key. |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Set to `1` on every spawned `claude` under the same never-overwrite rule. Suppresses non-essential CLI network traffic and independently blocks auto-update. An empty string counts as user-set and is left alone; the CLI reads it as off. |
| `OPENCODE_CONFIG` | Explicit config file, also read by the disk MCP bridge before project layers. |
| `OPENCODE_CONFIG_DIR` | Additional `.opencode`-style config/skill root. The plugin's direct agent-file fallback does not use it; agents must reach the config hook or a supported agent directory. |
| `OPENCODE_WORKTREE` | Overrides the disk MCP bridge's project walk-up boundary. opencode 1.x layering only: the opencode 2 layering walks to the filesystem root and applies no worktree boundary at all. |
| `CLAUDE_CODE_MCP_HOT_RELOAD_COOLDOWN_MS` | Minimum gap in ms between two `hotReloadMcp` respawns of one conversation; default 60000 for missing, non-numeric or negative values. A server flapping between connected and failed would otherwise cost a kill and a `--resume` spawn every turn. `0` disables the guard. A real second change is not lost, it lands on the first turn after the gap. |
| `XDG_CONFIG_HOME` | Global MCP/skill/AGENTS discovery root (`<value>/opencode`); defaults to the home `.config`. Direct agent-file fallback still uses `~/.config/opencode/agent(s)`. |
| `XDG_CACHE_HOME` | Account wrapper/cache-cleanup root override; do not assume the default cache path when upgrading. |
| `HOME` | Home expansion and direct agent-file discovery (other paths also use OS homedir). Do not change it to switch accounts. |
| `USERPROFILE` | Home fallback where `HOME` is absent. |
| `OPENCODE_VERSION` | Startup diagnostics version fallback, not a capability override. |
| `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` | opencode's own flag, read by opencode and never by this plugin. On opencode 1.x it is what makes opencode advertise `background` on its `task` tool, and that advertised schema is the only thing the plugin reads. `OPENCODE_EXPERIMENTAL` turns it on as a blanket. It must be in the environment that launches opencode. Unconditional on opencode 2. |
| `OPENCODE_DISABLE_EXTERNAL_SKILLS` | opencode's own switch, honoured by the skill bridge: any value other than empty / `0` / `false` drops both `~/.claude/skills` and `~/.agents/skills` from discovery. |
| `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` | The same switch for `~/.claude/skills` alone; `~/.agents/skills` is unaffected by it. |

## Recipes

**Which major each recipe is for.** Every options fragment below is written in the
opencode 1.x spelling, `provider.claude-code.options`, which opencode 2 also reads. On a
config that only ever serves opencode 2, put the same fragment under
`providers.claude-code.settings` instead. Fragments belong inside that options object,
never at the config root. The opencode 2 recipe has the full precedence list.

### Minimum install

```json
{ "plugin": ["@khalilgharbaoui/opencode-claude-code-plugin"] }
```

Everything else is optional. Models appear in the picker without extra config. The
`plugin` key is read by both opencode majors, so this block needs no edit after an
opencode 2 upgrade.

### opencode 2

Same package, same config. 2.x's native key is `plugins` (plural), but it still reads 1.x's `plugin` key, so an existing install needs no edit:

```json
{ "plugins": ["@khalilgharbaoui/opencode-claude-code-plugin"] }
```

- Check the major first with `opencode --version`. `plugin` is read by both majors (recorded in `docs/agents-history.md` #g39); `plugins` is read by 2.x only.
- Provider settings, lowest precedence first: `provider.claude-code.options` (1.x's spelling, still read on 2.x), `provider.claude-code.settings`, `providers.claude-code.settings` (2.x's own), and the plugin entry's own `options`, which wins over all three. Any option of this plugin can sit in any of them; the plugin entry is the usual home for `accounts`: `{"package": "@khalilgharbaoui/opencode-claude-code-plugin", "options": {"accounts": ["work"]}}`.
- A local checkout is loaded by pointing `plugins` at its **`dist`** directory, never the repository root: 2.x resolves a configured plugin path as `<dir>/server` or `<dir>/index`.
- Known 2.x differences: `/btw` is answered after the running turn rather than inside it, and there is no todo panel (2.x has no `todowrite` tool). Do not set `hostApi`; the 2.x entrypoint sets it, and forcing it on 1.x breaks every proxied tool call.

#### V2 MCP and Code Mode

V2 MCP config is `mcp.servers.<name>`, with `disabled` rather than `enabled`.
The disk bridge accepts both shapes. V2 discovery includes ancestors above the
repo, and nearest `.opencode` config wins after all direct configs. Higher
precedence server entries replace the entire spec; repeat required fields.
Doctor must report actual names, never the container name `servers`.

V2 defaults to Code Mode, where MCP functions are behind `execute` rather than
individual tools. `proxyOpencodeMcpTools` cannot prefix-match that tool and
warns before leaving servers on the direct bridge. Two deliberate choices:

- Individual proxies: set `codemode: false` on selected MCP servers and pair
  `proxyOpencodeMcpTools: true` with `strictMcpConfig: true`.
- Preserve Code Mode: after explaining that `execute` can invoke **all tools
  in the session catalog**, add it to `proxyOpencodeTools`, set
  `bridgeOpencodeMcp: false` and `strictMcpConfig: true`. In native V2 config
  these belong under `providers.claude-code.settings`; preserve other
  allowlisted entries. Do not also pass those servers through `mcpConfig`.

The headless proxy exposes `mcp__opencode_proxy__execute` using the actual
per-turn schema and catalog. Claude uses ToolSearch to discover that full name,
then the original `search(...)` and `tools[...]` signatures inside its code.
No execute proxy is automatic; the read-only preset refuses this code runner.
With the bridge off, OpenCode still owns MCP connections and catalog updates,
but the plugin's disk-MCP hot-reload mechanism does not apply. This path is
verified offline with a fake CLI, not a paid live Claude probe. Fully restart
all opencode processes after provider/plugin changes; ask before live probes.

### Two accounts

```json
{
  "provider": { "claude-code": { "options": { "accounts": ["personal", "work"] } } }
}
```

Creates `claude-code-default`, `claude-code-personal`, `claude-code-work`; default
models have no suffix, other accounts have `@<account>` (`claude-opus-5@work`). Names
normalize to lowercase hyphen-separated ids, so choose distinct simple names.
After the user approves login, they authenticate each non-default account interactively,
for example `CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude auth login`, using the chosen
binary. Never copy credentials between accounts. The generated wrapper strips the model
suffix and sets the config dir. Existing `CLAUDE.md`, `settings.json`, `skills/`,
`agents/`, `commands/`, `plugins/` in `~/.claude` are symlinked only when targets are
missing; existing targets stay untouched. This shares capabilities/settings, not an
isolation boundary. Auth/session files are not part of the shared list.

### Account failover

With more than one account configured, `accountFailover` is `"ask"` by default. When a
turn is rejected for usage, the turn ends on opencode's `question` form instead of an
error: one option per other configured account, plus `stop`. Picking an account applies
it inside the same opencode turn, with no new user message, and the task carries on.
Leaving the form unanswered waits and costs nothing.

Tell the user what a pick actually does before recommending one:

- It is sticky for the **limited account** until that limit's reset time, or until
  opencode restarts when the CLI reported no reset time. Every session on the limited
  account follows the same pick, and subagents follow their parent. Child sessions are
  never shown the form themselves.
- A switch **cannot resume the Claude session**, because transcripts live under each
  account's own `CLAUDE_CONFIG_DIR`. The conversation is replayed into a fresh session
  on the target account, which costs input tokens there and loses anything the CLI held
  but opencode did not.
- MCP servers configured only in the limited account's Claude profile will be **missing**
  on the target account.
- `stop`, dismissing the form, or answering with anything that is not one of the offered
  accounts ends the turn exactly as the rate-limit error does today. The limit is
  unchanged either way; failover moves the work, it does not create usage.
- Only a rejected `rate_limit_event`, one of the two known account-limit error texts, or
  an account-level failure the CLI reports on its own error reply opens the form. The
  account-level kinds are `authentication_failed`, `oauth_org_not_allowed`,
  `account_on_hold`, `verification_required` and `billing_error`. A generic 4xx, a
  timeout or a bad flag never does.
- An expired login also writes a `▌ **claude account:**` note naming the account and the
  command to fix it: `claude auth login` for the default account, or
  `CLAUDE_CONFIG_DIR=<that account's config dir> claude auth login` for a named one. When
  a user reports "Failed to authenticate: OAuth session expired", that command is the
  fix; a switch made from that form lasts until opencode restarts.
- Not available on the interactive transport or on compaction turns.

`{ "accountFailover": "off" }` keeps the plain rate-limit error.

### Subagents on one model, on the caller's account

opencode's agent config cannot say "inherit the account, change the model", because the
account is the provider and the model is only a `--model` flag. The plugin closes that gap.

Per agent, in `~/.config/opencode/agents/<name>.md` or `.opencode/agents/<name>.md`
(`agent/` singular also works), no `model:` key:

```yaml
---
description: Designs and builds UI work
mode: subagent
forceModel: claude-haiku-4-5
reasoningEffort: high
cacheTtl: 5m
---
```

Or once for every discovered subagent without a full provider/model pin:

```json
{ "provider": { "claude-code": { "options": {
  "defaultSubagentModel": "claude-opus-5",
  "defaultSubagentCacheTtl": "5m"
} } } }
```

Rules, in order: `forceModel` wins; else `mode: subagent` with `defaultSubagentModel`
set; else untouched. An agent with `model: <provider>/<id>` is left exactly as written,
account and all (`model: claude-code-work/claude-opus-5@work` pins the account too).
Undeclared built-ins are not discovered; a user definition with a built-in name can
enter the registry and is subject to these rules. This is not a built-in-name denylist.
`reasoningEffort` in the agent file beats the effort the call arrived with; compaction is
exempt. Effort, model and cache TTL are part of the CLI session key, so a changed agent
respawns rather than sharing a process.

`cacheTtl` sets the prompt cache TTL of that agent's own `claude` process, as
`CLAUDE_CODE_PROMPT_CACHE_TTL` at spawn. Unset (the default) leaves the CLI deciding,
which is 1 hour on a subscription. Claude Code also has a per-agent
`experimental.cacheTtl` and a `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`: neither does
anything here, because both apply only to subagents the CLI runs through its own `Task`
tool, and this plugin disallows that tool by default so opencode runs the subagent
instead. An opencode subagent is a separate `claude --print` process, which the CLI
counts as a main conversation. Use `cacheTtl: 5m` on short-lived workers that never
re-read the cache they wrote, since a 1-hour write is billed above a 5-minute one and
both come out of the same usage limit; leave a long-lived main session at the default.

Only grant `permission.task` for approved target agents if delegation is wanted.
`permission.todowrite: "allow"` is needed for subagent todos; opencode otherwise denies
them by default. Ask before broadening permissions. Use the singular `agent` config
object for inline definitions, with `forceModel`/`reasoningEffort` under `options` if
the opencode schema requires it. Markdown fallback reads top-level scalar fields only.

### Agent keys

| Key | Behavior |
|---|---|
| `mode` | Only exactly `subagent` qualifies for `defaultSubagentModel`; `primary`/`all` do not. |
| `model` | Full `provider/model` pins bypass plugin model overrides, not the separate effort override. |
| `forceModel` | Registered bare model id, preserving the caller's account even if an account suffix is supplied. Works for any discovered agent mode. |
| `reasoningEffort` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; invalid declarations warn and keep inherited effort. `minimal` maps to CLI `low`. Compaction skips this override. |
| `cacheTtl` | `5m` or `1h`; anything else warns and leaves the CLI's default alone. Exported as `CLAUDE_CODE_PROMPT_CACHE_TTL`, beating a shell export of the same name. Works for any discovered agent mode; compaction skips it. |
| `fallbackModels` | Ordered registered bare model ids to try when this agent's model is refused. Both YAML spellings (`[a, b]` or a `- ` block). Replaces the provider-level `fallbackModels` rather than extending it. Keeps the caller's account; an entry carrying `@account` has it stripped. Unknown ids warn and are skipped. |

### Degrade to another model instead of failing

```yaml
forceModel: claude-opus-5
fallbackModels: [claude-sonnet-5, claude-haiku-4-5]
```

Or as the default for every agent that declares none:

```json
{ "provider": { "claude-code": { "options": { "fallbackModels": ["claude-sonnet-5"] } } } }
```

Per-agent replaces provider-level; it never merges. Unset means no chain, which is
the default. Two triggers only, never a generic error: the CLI refusing the model
(assistant `error: "model_not_found"`, or a failed result whose text is *"There's an
issue with the selected model"*, measured on CLI 2.1.280, where the result `subtype`
is misleadingly `success`), and a usage limit **only when `accountFailover` has no
other account to offer**. With another account configured the switch form wins and
the chain stays out of it: model is a capability choice, account is a billing choice.
An expired login, a billing hold and every other error kind are excluded because they
fail the same way on the next model.

On a trigger the failed process is killed, its session id dropped, a fresh process
spawns on the next model with the same account, effort and cwd, the conversation
replays, and a `▌ **model fallback:**` note names the failed model, the reason and the
serving model. The failed attempt's output is discarded entirely. Each model is tried
at most once per turn; an exhausted chain surfaces the original error unchanged.
Never on compaction turns, title stubs, or the interactive transport.

### Route a tool through opencode, or switch one off

```json
{ "proxyTools": ["Bash", "Edit", "Write", "WebFetch", "Task"], "extraDisallowedTools": ["NotebookEdit"] }
```

Preserve other wanted proxies when changing this replacement list.
`Read`, `Glob` and `Grep` have tool mappings/disallowed-name entries but no selectable
proxy definitions in this version, just like `NotebookEdit` has no proxy. Adding them
to `proxyTools` warns and leaves the built-ins unproxied. Use `extraDisallowedTools`
only to deliberately remove a capability; omission from `proxyTools` is not denial.

The proxy's loopback endpoint has bearer, Host, Origin and Content-Type guards.
Never weaken them, publish its token or relax the generated MCP file's `0600` mode.
Restart all old processes after a security upgrade; changing files cannot patch them.

Proxying a tool costs **one extra Claude Code API call per `claude` process**: a proxied
tool is an MCP tool, Claude Code 2.1.280 defers MCP tools behind `ToolSearch`, so the
model spends a request finding it before the first proxied call. Built-ins are never
deferred. Measured on 2.1.280 (`docs/agents-history.md`, `#g166`): 3 API calls with
`Bash` proxied against 2 without, and it is paid once per process, not per call (two
commands measured 4 against 3, one `ToolSearch` either way). It is not caused by a large
tool list. Never suggest `ENABLE_TOOL_SEARCH=0` to avoid it: that inlines every tool
definition into each prompt and measured 2.5 to 4 times the cost. Say the extra call is
inherent to the CLI's MCP flow and weigh it against the permission prompts and audit log
proxying buys.

### Make a provider read-only

```json
{ "permissionPreset": "read-only" }
```

That one line is the whole posture. Do not also set `skipPermissions`,
`permissionMode`, `controlRequestBehavior` or `controlRequestToolBehaviors`
alongside it: the preset replaces all four and logs each value it dropped.
`proxyTools` is filtered rather than replaced, so a list naming `Question`
keeps it while `Bash`, `Edit`, `Write`, `WebFetch` and `Task` go, and
`extraDisallowedTools` is added to rather than replaced, so names already
listed there survive.

Read-only is enforced at three layers because no single one covers the plugin:
`--restricted` removes the CLI's own command and code-running tools, the
`--disallowedTools` list covers CLIs older than 2.1.258, and the proxy defs are
dropped before the MCP server is built because a proxied `bash` executes in
opencode where no CLI flag reaches it. Anything left that would prompt is
denied, so bridged MCP tools and the `question` proxy do not work under the
preset; Claude's own `AskUserQuestion` still renders its stop-and-wait markdown.

Pair it with a second provider entry when only some sessions should be
read-only: `accounts` or `providerID` gives each its own model list.

### Let the model satisfy an opencode-dcp compress nudge

DCP injects "MAX CONTEXT LIMIT REACHED ... You MUST use the `compress` tool now"
reminders. DCP declares `compress` directly rather than through an MCP server, so
automatic MCP routing never offers it and the model cannot obey. Two choices, and
they are different tools, so choose one rather than both:

```json
{ "proxyOpencodeTools": ["compress"] }
```

forwards DCP's real tool, which compresses opencode's transcript with DCP's
strategies. The live `claude` process keeps its own context until it restarts.

```json
{ "proxyTools": ["Bash", "Edit", "Write", "WebFetch", "Task", "Compress"] }
```

uses this plugin's tool instead, which resets the Claude session and carries a
summary forward. Setting both leaves this one holding the `compress` name and logs
`proxyOpencodeTools entry dropped`. If neither is wanted, `stripContextReminders: true`
removes the reminders the model cannot act on.

### Proxy tool names

Names below become `mcp__opencode_proxy__<name>`; input config is case-insensitive.

| Tool | Selection and behavior |
|---|---|
| `bash` | `"Bash"`, default; replaces CLI Bash with opencode execution. |
| `edit` | `"Edit"`, default; replaces CLI Edit. |
| `write` | `"Write"`, default; replaces CLI Write. |
| `webfetch` | `"WebFetch"`, default; replaces CLI WebFetch. |
| `task` | `"Task"`, default; disables CLI Agent and dispatches opencode subagents under its permissions. No proxy deadline by default; a positive `proxyToolTimeoutMs` entry adds one. Takes `background: true` only on a host that runs background subagents (see below). |
| `task_batch` | Included with Task; one MCP call fans out two or more independent task inputs concurrently. Separate task calls were measured serial (2026-09-06, two 8-second calls: the second MCP request left the CLI 7 ms after the first resolved). The input must be a `tasks` array of at least two items, each with `description`, `prompt` and `subagent_type`; anything else is refused before the calls are queued. |
| `task_status` | Included with Task, and only on a host that runs background subagents. Reads a background subagent's state by `task_id` and collects its result. A recovery path for a completion notification that never arrived, not a progress poll; a result is handed over once. Answered in-process (opencode has no such tool) and refuses any session that is not this conversation's subagent. Not nameable in `proxyTools`. |
| `task_cancel` | Included with Task, same host gate as `task_status`. Aborts a background subagent's child session; a cancelled subagent sends no completion notification. |
| `question` | `"Question"`, opt-in; replaces AskUserQuestion only if the live opencode registry has question. Round-trip verified on plugin 0.18.0 / CLI 2.1.258 / opencode 1.18.29, headless and as a real TUI form, with no `permission` block; grant `permission.question` only if a subagent's form is refused. Opt-in because it disables Claude's own AskUserQuestion. |
| `compress` | `"Compress"`, opt-in; in-process summary/reset interceptor, no opencode permission prompt and no built-in replacement. Discards prior CLI detail on a later eligible turn, retaining the summary, not the full transcript. Keep off unless explicitly requested. Reset round-trip verified live on CLI 2.1.263 / opencode 1.18.31. Not the same tool as a forwarded opencode `compress` (see `proxyOpencodeTools`): this one resets the Claude session, that one compresses opencode's transcript. Enabling both leaves this one holding the name. |

### How a proxied call ends

A proxied call is held open until an event ends it, and the plugin listens to the
`claude` process, the stream and the control protocol for those events rather than
inferring failure from elapsed time. opencode's result resolves the call. An abort
interrupts the CLI and rejects the turn's pending calls, unless opencode still reports
the session busy (opencode 1.18 aborts the signal of every tool step while it runs the
tool, so busy means the call is being served, not refused). The next user message
rejects what the previous turn left pending and tells the CLI. The process exiting, the
chat being deleted, or opencode exiting rejects the rest. That is why `task` and
`task_batch` carry no default deadline and a subagent runs to completion.

Three timers remain and are distinct from that: the optional per-tool deadlines
(`proxyToolTimeoutMs`, a backstop the user chooses), the start and inactivity
watchdogs (for a process that is alive but silent, which emits nothing to listen to; a
CLI parked in a proxied call is exempt), and the connection keepalives (SSE comments or
JSON whitespace every 15 s, so the CLI's HTTP client does not give up on a long call;
they never extend a deadline).

A deadline that passes while opencode still reports the session busy (a permission
prompt the user has not answered, or the tool still running) does not end the call: it
logs `proxy call past its deadline, but opencode is still serving it; waiting` at WARN
once and rechecks every minute. So an unanswered permission prompt is not a reason to
raise `proxyToolTimeoutMs`, and a raised deadline is never the fix for a long subagent,
because the default already waits for it.

Two log lines report a call that is simply taking a while, and neither is a failure or
ends a call:

- `proxy call still waiting, no deadline`, WARN, after five minutes and every five
  minutes after, with tool, call id and elapsed time. Only a call whose resolved
  deadline is `0` reaches it, which by default means `task` and `task_batch`, and also
  any tool the user set to `0` in `proxyToolTimeoutMs`.
- `proxy call still waiting, deadline approaching`, WARN, once, at 60% of that call's
  deadline, carrying `remainingMs` and naming `proxyToolTimeoutMs`. Deadlines under a
  minute are not announced, because there the notice and the rejection would arrive
  together.

Use them, or `/claude-code-doctor`, to tell a working subagent from a wedged one
before suggesting any timeout change.

### Background subagents (fire-and-collect)

Off unless the **opencode process** has `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`
(or `OPENCODE_EXPERIMENTAL=true`) in its environment on opencode 1.x; unconditional on
opencode 2.x. It is opencode's feature, not this plugin's: the plugin only surfaces it.
There is no provider option, and nothing in `opencode.json` can turn it on, because the
flag is read by opencode itself at startup.

```sh
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode
```

With it set, `task` takes `background: true` and returns at once with
`<task id="ses_..." state="running">` instead of the subagent's answer. The model keeps
working and ends its turn; when the child finishes, opencode prompts the same
conversation with `<task ... state="completed"><task_result>...</task_result></task>` as
a new message. Delivery is automatic, so polling is wrong and the tool descriptions say
so. `task_status` and `task_cancel` join the tool list, keyed on the `id` from that
envelope (the child's opencode session id).

opencode 2 uses different envelopes and the plugin's tool descriptions follow the host:
there a background dispatch answers in prose,
`The subagent is working in the background (sessionID: ses_...)`, and the completion
arrives as `<subagent sessionID="..." state="completed" description="...">`. The
`sessionID` is the `task_id`. Both extra tools work on both majors (on opencode 2 over
`session.context` and `session.interrupt`, the session routes a plugin is given there);
verified live on 2.0.16.

Without it, opencode rejects a `background: true` call outright
(`Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`), losing
the dispatch, so the plugin strips `background` from the `task` and `task_batch` schemas
on such a host and registers neither extra tool. The plugin never reads that variable
itself: it reads whether opencode's own advertised `task` schema carries a `background`
property, which is how a 1.x host publishes the flag, and on opencode 2 it does not ask
at all. Which way it went is in `plugin.log`:

```
background subagent gate {"supported":false,"registryResolved":true,"hostApi":"v1","note":"`background` stripped ..."}
```

Troubleshooting: `background` missing from the tool schema, or a refusal naming the env
var, means the flag is not set on the opencode process (setting it in a shell after
opencode started does nothing, and a plugin upgrade cannot change it). A `task_status`
that answers `not a subagent of this conversation` means the id came from a different
conversation.

`/claude-code-doctor` has a **Background subagents** section answering the same question
without reading the log: whether `background` was offered and the two tools registered,
the opencode major, what decided it (the live `task` schema, a registry that did not
answer, or opencode 2 offering it unconditionally), and the background tasks this
process has collected or cancelled. The gate is read while a turn plans its proxy tools,
so a fresh process reports `Not read yet this process` until one message has been sent.

### Let Claude load the user's opencode skills

```json
{ "bridgeOpencodeSkills": true }
```

The bridge is off by default. With it on, `Skill("<name>")` works for any skill opencode
advertises. Bridged names are `opencode-skills:<name>`, including this bundled skill as
`opencode-skills:claude-code-plugin`. The package also makes opencode itself list the
bundled skill: on opencode 1.x by adding its directory to `skills.paths` in the config
hook, on opencode 2 by registering it through the `skill` domain (a skill opencode
already found under the same id is left alone). Older opencode versions may not support
either surface.
The native Claude bridge needs `--plugin-dir` support and is wired into the headless
streaming and interactive spawns, never compaction. Set `true`
only when the user asks for it, since a large skill set costs prompt tokens twice; the
bundled skill is staged either way. Reusing a process does not load a new skill catalog.

User roots, in precedence order: walking from cwd to filesystem root, `.opencode/skills`
then `.claude/skills` then `.agents/skills` at each level; home `.opencode/skills`;
`OPENCODE_CONFIG_DIR/{skills,skill}`; `XDG_CONFIG_HOME/opencode/{skills,skill}` (home
`.config` fallback); then `~/.claude/skills` and `~/.agents/skills`. Those last two are
opencode's external scans: `OPENCODE_DISABLE_EXTERNAL_SKILLS` drops both and
`OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` drops `~/.claude/skills` alone. Neither is ever
reached through the walk-up, and a workspace that happens to BE the home directory does
not smuggle them in early. First name wins, so a project shadows a global and an opencode-managed copy
shadows an external one; enabled user bridging can shadow bundled names. A skill is known
by the `name:` its SKILL.md frontmatter declares (directory basename when it declares
none or an unusable one), which is the name opencode advertises. Only immediate
`<name>/SKILL.md` directories are collected; arbitrary `skills.paths` and `skills.urls`
are not scanned.

Those roots overlap Claude's own, so `bridgeSkipNativeSkills` (on by default) drops
anything the session already loads rather than advertising it twice. If the user reports
a skill that went missing, grep `plugin.log` for `skills claude code already loads` (one
line naming both paths and the reason) or the `claude already registers a different
skill under this name` warning, and only then consider `bridgeSkipNativeSkills: false`.
Broad bridging can duplicate advertised skill context and exposes every discovered skill,
not just one.

### Change when idle workers are freed

```json
{ "idleProcessTimeoutMs": 900000 }
```

Idle eviction is **off by default**. With the option unset, or set to `0`, a
conversation's `claude` process is kept until the LRU cap evicts it, which is why many
open chats cost memory: an idle `claude --print` holds roughly 250 MB. This example
frees a worker fifteen minutes after its last turn ends; the session id is retained, so
the next message resumes the same conversation through `--resume` and only pays for the
spawn. The cap is 16 live processes, oldest idle first. Neither the timer nor the cap
ever takes a worker mid-turn: a process found in flight when the timer fires is re-timed
instead of killed, and a round where all 16 are busy evicts nothing and warns.

### Different `/compact` model

```json
{ "compactionModel": "claude-sonnet-5" }
```

This is more expensive per token than the Haiku default, not a cost-saving recipe.

### Debug logging

```json
{ "logging": { "file": true } }
```

Default destination: `~/.local/share/opencode-claude-code/plugin.log` (respect the
configured/env directory). INFO is enough for startup diagnostics. Add
`"level": "debug"` only if needed for lower-level events; `mode: "debug"` alone does
not do that. Capture a bounded, redacted excerpt, then disable temporary logging and
restart. Logs rotate above 5 MB to `plugin.log.1`, which can also contain private data.
Never hand either file to anyone: for anything shared, use `/claude-code-doctor bundle`,
which is redacted by allowlist (see "Filing an issue" below).

### Upgrade the plugin

A published version does not reach a running opencode. First distinguish an npm pin,
npm latest resolution, and a local `file://` install. Preserve a pin unless the user
requested changing it. An `@latest` install is frozen in opencode's package cache at
`~/.cache/opencode/packages/@khalilgharbaoui/opencode-claude-code-plugin@latest/`, and a
plain restart never re-resolves it: removing that one directory and then fully
relaunching is what picks a new version up. Inspect the actual cache location and
package identity and get approval before removing only that stale package directory,
never the whole cache or auth/session directories. Respect platform/XDG paths
(`XDG_CACHE_HOME` moves it). Then fully relaunch every opencode window, including serve
and GUI processes. A `file://` install uses the checkout's
`dist/`: rebuild with `npm run build` and restart after approval, not cache deletion.
No manual skill copy/update is needed. Do not publish or release as part of configuring.

## Models and variants

### Registered model ids

Registered ids: `claude-haiku-4-5`, `claude-sonnet-4-5`, `claude-sonnet-4-6`,
`claude-sonnet-5`, `claude-sonnet-5-5`, `claude-opus-4-5`, `claude-opus-4-6`,
`claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-4-8-fast`, `claude-opus-5`,
`claude-opus-5-fast`, `claude-opus-5-5`, `claude-opus-5-5-fast`, `claude-fable-5`,
`claude-fable-5-1`, `claude-mythos-5`, `claude-mythos-5-1`.

### Variants and costs

- Display names end in a `(N×)` list-price multiplier relative to Haiku: 1× haiku,
  2× sonnet 5 and 5.5, 3× sonnet 4.5/4.6, 4× opus 5.5, 5× other opus, 8× fast-mode opus 5.5, 10× fable, mythos
  and fast-mode opus 5 / 4.8. It is display only.
- Every model except Haiku has reasoning variants `low`, `medium`, `high`, `xhigh`,
  `max`, picked in opencode's model selector. A variant becomes
  `CLAUDE_CODE_EFFORT_LEVEL` on the spawned CLI unless an agent effort wins. For direct
  AI-SDK calls, `ClaudeCodeCallOptions.reasoningEffort` supports the same levels plus
  `minimal` (mapped to `low`); it is not a provider startup option.
- The `-fast` ids are this plugin's own markers. They spawn the base model with
  `--settings '{"fastMode":true}'` (Claude Code 2.1.220+). Fast mode fails soft: an
  ineligible account runs at standard speed and the plugin logs a warning naming the
  reason. Switch to a non-fast id rather than silently enabling paid usage credits.
  Review eligibility/billing with the user; the enabled state needs live verification
  on their account. CLI floors are gates, not proof of model access.
- `claude-sonnet-5-5` needs Claude Code 2.1.284+ to run on its real limits. An older CLI
  still serves it on fallback limits (200k context, an estimated cost), and the plugin
  logs a WARN naming the model and the floor: the fix is `claude update`.
- `claude-mythos-5` and `claude-mythos-5-1` are limited availability (Project Glasswing).
  Without access `claude --model` errors; use the corresponding `claude-fable-*`.
- Ordinary calls can pass through unregistered ids; availability and opencode model
  registration still need checking. `forceModel`/`defaultSubagentModel` reject those ids.
- Registry costs are USD per million tokens, not subscription quota or a billing
  guarantee. Fast entries have fast pricing; other entries use standard rates. There
  is no above-200K tier in this registry; do not invent `cost.tiers` or
  `cost.experimentalOver200K`. 4.5 models have 200K context/64K output, later registered
  models have 1M/128K. Recheck vendor pricing/access separately when changing models.

## Verify and diagnose

Offline first: validate edited JSON/JSONC without starting opencode; inspect installed
package metadata. `claude --version` / `claude --help` on the trusted configured binary
and `opencode --version` do not request model inference. Do not invoke a model merely
to test configuration. A paid smoke test requires explicit approval and a bounded task.

If diagnostic logging was approved, find the newest matching
`NOTICE: claude-code plugin ready` entry for the restarted process (INFO threshold
includes NOTICE). Do not paste the entire log or raw spawn arguments.

Fields: `plugin` (version actually loaded), `opencode`, `cwd.resolved` and `cwd.source`
(`configured`, `process`, `captured`, `unresolved`), `providers`, `accounts`,
`proxyTools`, `mcpServers`, `permissionPresets` (one row per provider:
`{provider, preset, applied, overrides}`, `preset: "none"` where unset,
`applied: false` for `none` and for an unrecognised name, `overrides` naming the
options an applied preset replaced), `interactiveTransport`, `planModeQuestion`,
`anthropicApiKeyInEnv`, `claudeCli.path` and `.version`
(`not detected` means the binary did not answer `--version`, which also disables
version-gated flags). Cwd is a startup fallback snapshot, not the per-session spawn
directory. MCP names are disk discovery, not proof of live connectivity. Interactive
status is a preference report, not proof that Bun PTY transport was used. Check a
relevant, redacted spawn/bridge entry for actual routing after an approved normal turn.

Useful log lines to search for (redact payloads): `spawning new claude process`,
`bridged opencode skills into claude`, `interrupt sent for aborted turn`, `btw:`,
`rendering opencode-side tool result as text`, `proxy-mcp tool call received`,
`evicting idle claude process`, `evicting LRU claude process`, `background subagent gate`,
`proxy call still waiting`, `fast mode` warnings.

Version requirements. The first four are flag gates in `src/cli-version.ts`; the last two
are model floors enforced outside the plugin. Check with `claude --version`; a binary
that does not answer it disables every gated flag.

| Claude Code CLI | What it gates |
|---|---|
| 2.1.142+ | `--thinking-display summarized`, so Opus 4.7 thinking summaries |
| 2.1.220+ | fast mode, which is `--settings '{"fastMode":true}'` |
| 2.1.258+ | `--restricted` (the first layer of `permissionPreset: "read-only"`) and the `side_question` control request behind `/btw` |
| 2.1.263+ | `--permission-prompts none` (the second read-only layer) |
| 2.1.280+ | `claude-opus-5-5`; the API rejects it from an older CLI with a 400 naming that floor |
| 2.1.284+ | `claude-sonnet-5-5` on its real limits; an older CLI still runs it, on fallback limits, and the plugin warns |

Below a flag gate the plugin drops the flag rather than failing the spawn, and says so
at WARN. `--plugin-dir` (the skill bridge) has no published version marker, so it is
probed through the binary's own `--help` instead of a semver threshold.

Only if a proxy security check is specifically requested: identify the exact local
proxy port first, not every opencode listener. An unauthenticated `initialize` with
the correct `127.0.0.1:<port>` Host, no Origin and JSON Content-Type should get `401`.
`200` on a confirmed proxy endpoint is unsafe; restart/upgrade. Other status codes
alone do not prove it patched. Never call `tools/call` or obtain the bearer to probe.

`/claude-code-doctor` prints the same fields as the startup block plus live runtime
state, in the chat, with no model inference and at zero tokens: plugin/opencode/CLI
versions, cwd and its resolution tier, providers, accounts, `proxyTools`, disk MCP
servers, the `permissionPreset` in force per provider (`provider: preset`, `none` where
unset, an unknown name marked `(unknown, nothing applied)`, plus a
**Permission preset overrides** block listing what an applied preset replaced),
transport, `planModeQuestion`, `turnStats`, whether an `ANTHROPIC_API_KEY` is present
(never its value), the live `claude` processes (opencode session, model, pid, in flight,
age, effort), pending proxy calls with their deadlines (`none` for a deadline-free
`task`), one unauthenticated `initialize` against each proxy URL (`401, good`; anything
else is flagged unsafe), and the last stderr of any child that produced some. Prefer it over asking for
`plugin.log` for a first look. It carries no bearer token, no key value and no system
prompt. A user-defined `claude-code-doctor` command is never overwritten. The name has
no space in it: opencode would read the second word as an argument.

It also prints an **MCP config entries Claude Code skipped** section, but only when the
CLI refused an entry in an `--mcp-config` it was given. Read it whenever MCP tools are
missing: a skipped server is absent from the CLI's server list rather than listed
broken, so nothing else hints at it. A skipped `opencode_proxy` is the plugin's own
server, not the user's config, and means every proxied tool call in the session fails.

A **Plugins Claude Code did not load** section appears the same way, only when the CLI
demoted a Claude plugin at load time (`plugin_errors`, e.g. `dependency-unsatisfied`) or
warned about content that did not load. Read it whenever bridged skills are missing: an
`opencode-skills@...` row is the skill bridge itself, which is a plugin bug to report,
not something to fix in the user's config.

A **Hooks Claude Code ran that failed** section appears only when one did. These are the
user's own Claude Code hooks (`hook_response` with `outcome: "error"` or a non-zero
`exit_code`), not opencode's. A failing `SessionStart` hook is otherwise invisible: the
CLI drops its contribution and the turn succeeds, so the context it was meant to add is
missing from every turn on that process. Read it whenever a hook's effect is absent. The
first failure is also a WARN in the terminal. Only the hook's `stderr` is shown, capped
at 200 characters, because its stdout is spliced into the model's context. The plugin
never passes `--include-hook-events`, so only `SessionStart` (and `Setup`) hooks are
reported at all; `cancelled` is not a failure, since an abort produces it.

A **Background subagents** section is always printed: whether `background` was offered
to Claude and `task_status` / `task_cancel` registered, the opencode major, what decided
it, and the background tasks this process collected or cancelled. It reads
`Not read yet this process` until a turn has planned its proxy tools, which is not the
same as "no": on a fresh process, send a message and run it again before concluding
anything. Only a 1.x host that said no is told about
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`.

A **Plan usage** section is always printed, but it is empty unless asked for: the plain
command prints one line saying how to fill it. `/claude-code-doctor usage` fills it with
the CLI's own `/cost` answer (subscription vs API key, 5-hour and 7-day window use,
reset times, what is driving them), quoted rather than reinterpreted. Measured free on
2.1.280 (`num_turns: 0`, `$0`, no API call), so suggest it for "how much have I used"
and limit questions. It is opt-in only because it starts a short-lived `claude`, which
runs the user's `SessionStart` hooks and takes a few seconds; say that when suggesting
it. Do not propose `--bare` to skip the hooks: it never reads OAuth, so it reports
nothing about a subscription.

### Filing an issue: /claude-code-doctor bundle

`/claude-code-doctor bundle` is what to tell a user to paste into a GitHub issue. It
returns the normal report plus this process's recent `NOTICE`/`WARN`/`ERROR` lines from
`plugin.log`, redacted. Unlike `usage` it starts no process, so it stays instant.
**Never ask a user to attach `plugin.log` itself**: it has no redaction guarantee and
can hold whole system prompts, spawn argv with `--settings` JSON, bridged MCP config
paths and session ids. The same applies to the rotated `plugin.log.1`.
A bundle still keeps folder paths below home (as `~/...`) and the `accounts` names, so
tell the user to read it before pasting it publicly.

The redaction is an allowlist, not a filter. Per line it keeps the timestamp, the level,
the message **only** when it is one of the message literals extracted from the plugin's
own source (`src/log-messages.ts`, generated by `npm run generate:log-messages`), and
only data fields whose key is on an explicit allowlist and whose value is then the kind
that entry declares: versions, counts, booleans, enums, durations, exit codes, model /
tool / server names, paths and the loopback proxy URL. The allowlist applies at every
nesting depth. Everything else, every unknown key included, becomes
`[redacted, N chars]`, which keeps the shape without the content. Session ids become a
per-bundle salted hash, so lines correlate inside one paste and nowhere else, and the
home directory becomes `~` across the whole report including the table.

Never in a bundle: prompt or reply text, system prompts, tool inputs or outputs, file
contents, environment values, bearer tokens, the proxy `authToken`, API keys,
`Authorization` headers, MCP server env or headers, URL credentials or query strings,
or the raw spawn argv (option names are kept, every value is replaced).

Capped at 120 lines and 24,000 bytes, newest first, with a line saying how many were
left out. With file logging off the section says so, tells the user to relaunch under
`OPENCODE_CLAUDE_CODE_LOG_FILE=1` or set `logging.file`, and the report is still
returned. A message a maintainer cannot read in a bundle means that warning's text is
built at runtime; its data fields still carry the diagnosis.

Claude Code stream events the plugin now surfaces without debug logging: a rate-limit
rejection, a context compaction the CLI did on its own, a `result` subtype other than
`success` (which now finishes the turn as an error, not a clean stop), and a failed
CLI-executed tool (forwarded with the error flag, so the row renders as failed). A
failed MCP server at session start, an `--mcp-config` entry the CLI skipped, and an
`apiKeySource` that means API-key billing each warn once per identity per process.
None of these are actions the plugin may take on the user's behalf; enabling paid
usage or changing auth still needs approval.

`/btw <question>` needs an existing headless Claude conversation and CLI 2.1.258+.
It asks through the side channel and keeps the answer in the conversation (inline
when possible); it is excluded from Claude's normal turn history. It is still
inference: zero reported usage for the aside does not mean free. User-defined `btw`
commands are preserved. Do not use it as an automatic diagnostic probe.

## Troubleshooting

Key a diagnosis on the FIRST symptom the user reports, and name the ONE check that
settles it before proposing a fix. The four checks, in order of preference:
`/claude-code-doctor` in the session (no inference, no billing, reports the loaded
plugin version, the CLI path and version, providers, accounts, `proxyTools`, cwd and its
tier, live `claude` children and pending proxy calls); `OPENCODE_CLAUDE_CODE_LOG_FILE=1`
plus a grep of `plugin.log` for the named line; `claude --version` for a version gate;
and `claude auth status` (with `CLAUDE_CONFIG_DIR` for a named account) for a login.
Prefer the doctor: it needs no logging change and no restart.

| Symptom | Cause | Fix |
|---|---|---|
| A config change did nothing | Options are read at startup; another opencode window is still running the old process | Fully quit every opencode window and relaunch |
| New plugin version or model not in the picker after upgrading | Frozen `@latest` in opencode's package cache | Remove the cache dir (recipe "Upgrade the plugin") and relaunch |
| No `claude-code` provider or model in the picker at all | The plugin never loaded, or it loaded and the CLI was not usable | Check for a `plugin ready` line first: absent means not loaded (wrong `plugin`/`plugins` key, a 2.x local install not pointing at `dist/`, or no full relaunch), present with `claudeCli.version: not detected` means the binary did not answer `--version`, which also disables every version-gated flag |
| `Model unavailable` for a model id the user typed | The provider id is not what they assumed | Use the id the ready block's `providers` field lists. With no `accounts` configured on opencode 2 the id is `claude-code`, so `claude-code-default/<model>` fails while the plugin is healthy (measured on opencode 2.0.16, 2026-09-27). Declaring `accounts` is what creates `claude-code-default`; on 1.x with accounts the ids are `claude-code-default` / `claude-code-<name>` and never a bare `claude-code` |
| `Tool result name changed`, turn aborts, on opencode 2 | Before 0.28.1 a CLI-executed tool's result reached opencode under a different name than its call, and 2.0.16 aborts the turn on the mismatch, breaking every Claude-side MCP server call | Upgrade to 0.28.1+ **and fully relaunch every opencode window**; plugin code is read once at process start, so upgrading the package under a running window changes nothing |
| A `SessionStart` hook the user configured has no visible effect | It exited non-zero and Claude Code discarded its contribution; the turn still succeeded | Read the **Hooks Claude Code ran that failed** section of `/claude-code-doctor` for the exit code and the hook's stderr. It is their Claude Code settings to fix, not the plugin's |
| `plugin ready` missing from the log | Logging is off (the default), or the plugin genuinely did not load | Confirm `OPENCODE_CLAUDE_CODE_LOG_FILE=1` and a relaunch before concluding anything. `/claude-code-doctor` answers the same questions with no logging change |
| "Failed to authenticate: OAuth session expired", one account, turns failing in milliseconds | That account's CLI login lapsed | `claude auth status` for it, then log in again with the command the `▌ **claude account:**` note prints (`CLAUDE_CONFIG_DIR=<that account's dir> claude auth login`). Restart opencode after: a switch taken from the failover form lasts until restart. Login is a user action, never a diagnostic probe |
| A tool call reported as rejected although it ran | Two fixed causes: opencode 1.18.32 aborts the provider signal of every step ending in tool calls, read as an operator stop (0.26.1); and a call waiting on an unanswered permission prompt was rejected at the flat 10-minute deadline, after which the late approval cancelled Claude's next call (0.26.2) | Upgrade to 0.26.2+ and relaunch. Do NOT raise `proxyToolTimeoutMs` for this: a deadline now waits while opencode reports the session busy |
| `proxy call still waiting` in the log, or a `task` that looks stuck | Expected: `task`/`task_batch` carry no default deadline, and the line is a status report | `/claude-code-doctor` lists pending calls with tool, age and deadline. Tell a working subagent from a wedged one there before proposing any timeout change; see the note under "Proxy tool names" |
| An MCP server's tools are simply absent | Claude Code could not connect that server | Read the once-per-process WARN at session start, and the doctor's **MCP config entries Claude Code skipped** section for one the CLI refused outright. `mcpServers` in the ready block is disk discovery, not live connectivity; fix the server where it is configured |
| An MCP server opencode has configured is missing on the FIRST turn of a fresh `opencode run`, but present in the TUI | Not a config fault, and mostly fixed. The bridge reads opencode's live MCP status when the turn plans its spawn. On opencode 2 a server still connecting is reported `pending`, which the bridge no longer reads as disabled, and the turn waits up to `mcpConnectWaitMs` (3 s) for the host to decide; opencode 1 cannot reach this state, because its own status call blocks until every server resolves. If the server is slower than the budget it is still bridged, and if it genuinely joins later `hotReloadMcp` moves the conversation onto a process that has it on the next turn, logging `opencode MCP servers changed, respawning claude` with the joined names | Nothing, usually. For a very slow server raise `mcpConnectWaitMs`. Check `plugin.log` for `waited for opencode MCP servers to finish connecting` and for the respawn line; if neither appears and the server is still absent, the status the host reported was a real refusal (`failed`, `needs_auth`), which is opencode's to fix |
| `permissionPreset` set but nothing about the session looks restricted | The option never reached that provider, or the name is not one the plugin knows (only `read-only` exists) | Read the `permissionPreset` row in `/claude-code-doctor`, or `permissionPresets` in the ready block, for the provider the conversation is on: `none` means it is not configured there (each account is its own provider id), `applied: false` with a name means an unrecognised name applied nothing, and `overrides` lists what an applied preset replaced |
| `permissionPreset: "read-only"` set, but reads are unconfined or something still prompts | `--restricted` needs CLI 2.1.258 and `--permission-prompts none` needs 2.1.263; below those the preset falls back to `--disallowedTools` plus the plugin's own deny and WARNs naming what is lost | `claude --version`. Below 2.1.258 the working-directory confinement on reads is gone; below 2.1.263 the denial happens in the plugin instead of the CLI. The preset still holds, with one layer fewer |
| `/btw` shows "Queued" or "requires an idle Claude Code session" | Plugin older than 0.15.2, or a window started before the current build | Upgrade and restart. `/btw` also needs Claude Code 2.1.258+ |
| Model calls `Skill("x")` and gets `Unknown skill` | Wrong namespace (`opencode-skills:x`), a CLI without `--plugin-dir`, a compaction turn, or `bridgeOpencodeSkills: false` | Check the namespace and `claude --help`; remove the `false` only with approval |
| One skill's name and description appear twice in a session | Plugin predates `bridgeSkipNativeSkills`, or it is set to `false` | Upgrade, or drop the `false` |
| A skill opencode lists is bridged under neither name nor namespace | `bridgeSkipNativeSkills` treated it as natively loaded (most often a plugin that is installed but disabled) | Grep `plugin.log` for `skills claude code already loads`; the line names both paths and the reason. `bridgeSkipNativeSkills: false` is the escape hatch |
| `Subagent failed (task_id …): Tool execution aborted` while the child finished fine | Bug fixed in 0.15.1 | Upgrade |
| A `subtask: true` command's subagent output is "lost" | Bug fixed in 0.15.4 | Upgrade |
| Two subagents run one after another | The CLI serialises MCP calls | Plugin 0.17.0+; the model must use `mcp__opencode_proxy__task_batch` |
| Esc does not stop Claude; aborted turns keep running | Plugin older than 0.16.0 | Upgrade |
| Esc pressed in the first moment of a turn does nothing, and the turn runs and bills anyway | A turn prepares before it asks the CLI for anything (spawn directory, `claude --version`, opencode's MCP status and tool registry), and a stop that landed in that window used to be dropped. Fixed: the turn ends there, spawning nothing and writing nothing, and the reply is empty | Upgrade and fully relaunch every opencode window. Grep `plugin.log` for `abort while the turn was still being prepared` |
| Under `opencode serve` or the web UI every project spawns Claude in the server's launch dir | Plugin older than 0.16.0 | Upgrade, or pin `cwd` |
| 400 `Third-party apps now draw from your extra usage…` | Subscription/account usage gate, including disabled extra usage or an exhausted window | Explain waiting, account choice and billing options; do not enable paid usage, switch auth or change transport without approval |
| Warning that a fast turn ran at standard speed | Fast mode ineligible (usage credits off, cooldown, not first-party) | Prefer non-fast id; paid usage changes require approval |
| `claude --model claude-mythos-*` errors | Limited-availability model | Use `claude-fable-5` or `claude-fable-5-1` |
| Startup warning about `ANTHROPIC_API_KEY` | CLI may prefer env credentials | Confirm billing intent; strip only with approval, without displaying the key |
| A question form never renders and the turn hangs | Blocking notification/tool hooks, or a pending request not reaching the visible session | Check `GET /question` on the same server/workspace: absent means investigate pre-tool hooks or replacement tools; present means inspect session ownership, permission priority and event delivery. On the maintainer's Mac, awaiting `alerter` dismissal in `tool.execute.before` blocked the tool itself. Native providers load global plugins too. The separate detach/reattach issue #36604 remains open; #36603 closed unmerged. |
| No thinking summary | CLI version, explicit disable/summary env, or no thinking text emitted | Check version and nonsecret flag presence; do not override deliberate user suppression |
| `⚙ invalid` rows for `todowrite` inside a subagent | Subagent lacks `permission.todowrite: "allow"` | Grant it on the agent definition with approval |
| Other `⚙ invalid` or `⚙ unknown` tool rows | A Claude tool the plugin does not map for this version | Note plugin version, CLI version and the tool name; upgrade or report |
| `AGENTS.md` appears twice in Claude's system prompt | Plugin older than 0.16.0 | Upgrade |
| "What does the plugin actually think is going on?" | Startup diagnostics go to a log that is off by default | Run `/claude-code-doctor` in the session; paste that instead of the log |
| A turn ended with no answer and nothing said why | The CLI's `result` carried a failure subtype, or a rate limit was rejected | Both are now written into the transcript as `▌` lines; read the subtype or the limit reason there |
| The reply is empty and there is no error either | Claude finished the turn without writing anything or calling a tool | A `▌ **no reply:**` note says so, and says whether it thought first. Nothing failed and nothing is pending: send the message again. There is no automatic retry, and `"autoContinueIncompleteTurns": false` removes the note too |
| A CLI tool row looks successful but its output is an error | Plugin older than 0.19.0 forwarded `is_error` results as successes | Upgrade; failed CLI tools now render as failed |
| Claude "forgot" the earlier part of a long conversation | Claude Code compacted its own context | Look for the `▌ **context compacted:**` note in the transcript |
| Claude forgot the whole conversation at once | Claude Code cleared it (`/clear` sent as a message, or a plan-mode exit that clears context) | Look for the `▌ **claude code reset:**` note. The plugin does not replay history there on purpose; a new opencode session gets a clean slate |
| Wanting the per-turn cost in the chat | Not shown by default | Set `turnStats: true` and restart opencode |
| On the interactive transport, every turn ends with a `▌ **claude code error:**` note naming `end_turn` (or `stop_sequence` / `max_tokens`), and `turnStats` never prints | Plugin older than 0.33.0 put the stop reason in the synthesized `result`'s `subtype`, and any non-`success` subtype finishes the turn as an error, which also suppresses the stats footer | Upgrade and relaunch. A turn that reaches a terminal stop reason now synthesizes the shape a headless turn emits (`subtype: "success"`, the stop reason in a top-level `stop_reason`), so it finishes as an ordinary reply. A turn that reaches NO terminal stop reason is still an error on purpose, so truncation stays visible |
| On the interactive transport with a working directory under `/tmp` (or any symlinked path), the turn hangs until the 30-minute turn timeout and then reports no terminal stop reason | Plugin older than 0.33.0 named the transcript directory from `path.resolve`, which does not follow symlinks, so it tailed a file Claude Code never writes. On macOS `/tmp` is a symlink to `/private/tmp` | Upgrade and relaunch. The directory is now named from the cwd's resolved real path, which is what the CLI uses (`/tmp/scratch` is `~/.claude/projects/-private-tmp-scratch`). Check the `jsonlPath` in the `prepared interactive claude session` log line against the directory that actually exists under `<CLAUDE_CONFIG_DIR>/projects/` |
| On the interactive transport, a turn's output tokens look about double, and `turnStats` shows one call's input where the turn used many | Plugin older than 0.32.0 summed the session transcript's usage per RECORD, and the JSONL writes one record per content block with the call's usage repeated on each | Upgrade and relaunch. Counting is now once per API call: a four-tool turn that reported 1,306 output tokens reports its real 653, and the stats line carries the turn's totals as it does headlessly. Headless turns were never affected by this one |
| opencode auto-compacts a Claude session far below the model's window, often several times in a row after tool-heavy turns | Plugin older than 0.31.0 reported the CLI's turn-summed usage (every API call's cache reads added up) as the context size | Upgrade and relaunch. opencode's per-message tokens are now the last call's context, so its cost figure for a multi-call turn is lower than the real one; the real cost is in `turnStats` and `providerMetadata["claude-code"].costUsd` |
| Turn ends with an error naming an exit code or signal and a stderr tail | The `claude` child died mid-turn without emitting its terminal `result` | Read the quoted stderr; that is the CLI's own reason. Older builds reported this as a normal stop, so a truncated answer looked finished |
| An answer is cut off with no error, in a window with many open chats | Plugin older than 0.20.0: LRU eviction could kill a process mid-turn | Upgrade. Eviction now takes the oldest idle process and skips the round entirely when all 16 are busy; a configured `idleProcessTimeoutMs` re-times a busy worker rather than killing it |
| A `claude` worker lingers after its chat was deleted, or after opencode quit | Plugin older than 0.20.0 | Upgrade. Deleting a chat now releases its workers; every retained worker is killed when opencode exits |

## Which login bills what

The CLI decides; the plugin only reports. Never state which of these is in effect from
`process.env` alone, and never read or print a key's value.

- **OAuth subscription login** (`claude auth login`): turns run on the user's plan.
  Headless `--print` is the Agent SDK path; see the note at the top of this file before
  telling a user what that draws from. The interactive transport draws from the same
  plan usage limits, so it is not a way to change what a turn costs.
- **`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` in the launching environment**: the CLI
  prefers these over the subscription login and bills Platform pay-as-you-go. This is the
  only route `ignoreAnthropicApiKey: true` strips, and the plugin warns at startup
  whenever either is present regardless of the flag.
- **A key the CLI found itself**, from its own `user`, `project` or `org` settings scopes
  or an `apiKeyHelper`. That is CLI configuration, so no plugin option removes it. Do not
  claim `ignoreAnthropicApiKey` fixes it.
- **`apiKeySource` on the CLI's `system` init event is the field that tells the truth**:
  anything other than `oauth` (the subscription) or `none` means a key is in effect, and
  the plugin warns once per process. An absent env var proves nothing.
- **Bedrock and Vertex**: if the CLI authenticates against either, neither a subscription
  nor an Anthropic key is in play for that turn, and fast mode is excluded there (and on
  Foundry), because it is first-party only.

Changing any of this is the user's decision: explain the consequence and get approval
before stripping a key, switching accounts, enabling usage credits or changing transport.

## Do not

- Do not enable `planModeQuestion` or `"Question"` without the user asking. `"Question"`
  works (round-trip verified headless and as a real TUI form) but disables Claude's own
  AskUserQuestion; `planModeQuestion` cannot fire at all on the headless transport,
  because CLI 2.1.258 does not offer `ExitPlanMode` under `--print`. The historical
  blanket TUI diagnosis was confounded by a local macOS notification hook; do not
  repeat it as established fact.
- Do not make `--dangerously-skip-permissions` unconditional again. The CLI lets it
  override plan mode, so the plugin drops it for `permissionMode: "plan"` on purpose;
  without that, asking for plan mode silently grants full write access.
- Do not "fix" the `-fast` model ids by passing Anthropic-looking names; the real ones are
  retired and the `--settings` opt-in is the only headless path.
- Do not add long-context `cost.tiers` to a model; Claude 4.6+ bills the full 1M window
  at standard rates.
- Do not set `name`, `providerID`, `account` or `configDir` by hand when `accounts` is
  in use; expansion writes them.
- Do not point `cliPath` at the generated account wrapper in
  `~/.cache/opencode-claude-code-plugin/`; the plugin generates and selects it.
