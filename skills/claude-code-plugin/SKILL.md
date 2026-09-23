---
name: claude-code-plugin
description: Configure and troubleshoot the opencode-claude-code-plugin, the opencode provider that runs Anthropic Claude models through the Claude Code CLI. Use when the user wants to install, set up, change or debug this plugin, meaning anything under provider.claude-code.options in opencode.json (accounts, proxyTools, cwd, permissions, MCP bridging, timeouts, logging), subagent model or effort, model ids and variants, /btw, the skill bridge, upgrades, or reading plugin.log. Not for opencode's own general configuration.
---

# Configuring the Claude Code plugin

This plugin is `@khalilgharbaoui/opencode-claude-code-plugin`. It registers one or more
`claude-code*` providers and routes inference through the `claude` CLI, not opencode's
native Anthropic provider. Headless `--print` is the default. Subscription headless
usage draws on Agent SDK credit/extra usage under Anthropic's billing policy, not a
promise of free or normal interactive-plan usage. API-key/cloud billing depends on
the CLI's authentication. Confirm the user's intended account and billing method.

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
   is needed; do not use the known-broken question form to configure itself.

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
Defaults below describe normal headless opencode use when the key is absent.

| Option | Type | Default | What it does |
|---|---|---|---|
| `cliPath` | string | `"claude"` | Executable, not a shell command with flags. Use an absolute path for a non-PATH install. The opencode config hook supplies this default; only direct `createClaudeCode()` use falls back to `CLAUDE_CLI_PATH`. Account providers wrap it; never select a generated wrapper yourself. |
| `accounts` | string[] | unset | Unset keeps provider `claude-code`. Any array, including `[]`, expands to `claude-code-default` plus normalized, deduplicated names. Non-default accounts use `~/.claude-<name>`; default uses the CLI's normal environment/auth. |
| `accountFailover` | `"ask"` / `"off"` | `"ask"` | When the account a conversation runs on is out of usage, end the turn on opencode's native `question` form listing the other configured accounts, and continue the task on the pick inside the same opencode turn. Only ever fires with more than one account configured, so a single-account install is unaffected by the default. The pick is sticky for the LIMITED account until the limit's reset time (or until opencode restarts when the CLI reported none), so it covers every session on that account and subagents follow their parent; child sessions are never shown the form. Leaving it unanswered waits and costs nothing. `stop`, a dismissal, or text that is not one of the offered accounts ends the turn as the rate-limit error does. Triggered only by a rejected `rate_limit_event` or the two known account-limit error texts, never by a generic failure. Never on compaction turns or the interactive transport. A switch cannot resume the Claude session (transcripts live under the account's own config dir), so the conversation is replayed into a fresh one: it costs input tokens on the new account, and MCP servers configured only in the limited account's Claude profile are gone. `"off"` keeps the plain rate-limit error. |
| `failoverAccounts` | string[] | unset/derived | Account expansion supplies the resolved account list so a limited account can offer the others. Do not hand-wire it; set `accounts` instead. |
| `baseCliPath` | string | unset/derived | The `cliPath` before the per-account wrapper substitution, so a failover can build another account's wrapper on the same binary. Supplied by the config hook. Do not hand-wire it. |
| `defaultSubagentModel` | string | unset | Seed-config default for discovered `mode: subagent` agents without a full `provider/model` pin; `forceModel` takes precedence. Keeps the caller's account. Unknown ids warn and keep the inherited model. Not independently read per expanded account. |
| `cwd` | string | automatic | Pin an absolute existing directory. Otherwise: session directory from SDK, usable `process.cwd()`, captured project directory, final `process.cwd()` fallback. Startup diagnostics cannot show the per-call session tier. |
| `skipPermissions` | boolean | `true` | Pass `--dangerously-skip-permissions` to headless Claude, even with proxies enabled. Proxied calls still use opencode permissions, but unproxied CLI tools do not. `false` removes the bypass flag; it does not by itself create human approval prompts. Ignored when `permissionMode` is `"plan"`, which always drops the flag. |
| `permissionMode` | `acceptEdits` / `auto` / `bypassPermissions` / `default` / `dontAsk` / `plan` | unset | Headless `--permission-mode`, not version-gated: verify the installed CLI supports the value. `plan` is enforced: it overrides `skipPermissions: true` and the plugin drops `--dangerously-skip-permissions` for it, so claude cannot edit or run commands. Every other value governs prompting and still passes the skip flag, so `plan` is the only one that makes a run read-only. Nothing releases plan mode mid-session (no headless `ExitPlanMode`), so leaving it means a config change and an opencode restart; the plugin warns once at startup. Not forwarded by the current interactive spawn path. |
| `controlRequestBehavior` | `allow` / `deny` | `allow` | Automatically answer CLI `can_use_tool` requests if emitted. Not an opencode permission prompt or a sandbox; bypass/pre-allowed tools may never ask. `AskUserQuestion` defaults to deny. |
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
| `hotReloadMcp` | boolean | `true` | With bridging on, compare merged MCP config/status at turn start and respawn on drift after pending proxy calls resolve. Keeps the session via headless `--resume`. Does not reload arbitrary provider options or watch explicit `mcpConfig` contents. |
| `proxyOpencodeMcpTools` | boolean | `false` | Route opencode's MCP-backed tools through opencode's executor instead of Claude's own `--mcp-config` child, so each call is permission-prompted and rendered as an opencode tool row. Default changed `true` to `false` here, with no behaviour change: at `true` it routed nothing, because discovery read opencode's tool registry, which never contains MCP tools. Discovery now reads the model tool set opencode passes the provider, verified live on opencode 1.18.31 / Claude Code 2.1.263. **Tell the user to set `strictMcpConfig: true` alongside it**: a server also present in Claude Code's own config is reached directly and the proxy is bypassed, which looks exactly like the option doing nothing. A routed call runs with the calling agent's permissions. Servers whose tools are not found stay on the direct bridge and log a warning. Do not promise exactly-once side effects across failures, retries or opencode versions; verify routing before using write-capable tools. |
| `proxyOpencodeTools` | string[] | `[]` | Forward named opencode tools through the proxy by registry id (`client.tool.list()`, matched case-insensitively). Covers tools another opencode plugin declares directly, which belong to no MCP server and so are never matched by `proxyOpencodeMcpTools`: opencode-dcp's `compress` is the motivating case. Same broker as every other proxy tool, so the same events release the call. Unknown name is skipped with a warning; a name a proxy def already holds is dropped with a warning and the existing tool keeps it. Explicit allowlist only, because a forwarded tool runs in opencode with the calling agent's permissions. |
| `stripContextReminders` | boolean | `false` | Strip opencode-dcp `<dcp-system-reminder>` blocks from user/assistant message text, including the fresh-session rebuild. Only when no `compress` is proxied via `proxyTools` or `proxyOpencodeTools`; reachable compress makes it inert. Resolved from config, so a configured-but-unregistered name still counts as reachable. Leaves opencode's own `<system-reminder>` blocks alone. |
| `multiStepContinuation` | boolean | `true` | Append a system-prompt hint to chain tool calls in one turn instead of stopping between subtasks. |
| `autoContinueIncompleteTurns` | boolean or `"smart"` | `"smart"` | `true`/`"smart"` continue a turn truncated at `max_tokens`, bounded by 8 attempts and 10 minutes, and otherwise run the keyword heuristic only when stop reason is missing. Every other stop reason, plus error, abort or latched question, stops it. Current measured CLIs always report a reason, so truncation is the only case that resumes in practice. |
| `compactionModel` | string | `"claude-haiku-4-5"` | `/compact` uses a fresh short-lived headless process without the usual bridge/proxy/skill wiring. Nonblank `CLAUDE_CODE_COMPACTION_MODEL` wins. This is inference and can be billed. |
| `ignoreAnthropicApiKey` | boolean | `false` | Strip `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from headless/interactive spawn env, allowing stored auth to be used. Does not log in, change the parent env, or guarantee subscription billing if other CLI/cloud auth is configured. Warns at startup when either nonempty variable is present, regardless of the flag. |
| `idleProcessTimeoutMs` | number | unset | Kill a conversation's idle `claude` worker this many ms after a finished turn. The timer starts when a turn completes, reuse cancels it, and a worker found mid-turn when it fires is re-timed rather than killed. The session id is kept, so the next message resumes transparently. Unset or `0` keeps workers until LRU eviction (16 processes, oldest idle first). Values above `2147483647` are ignored. Not applied to the interactive transport. Deleting a chat in opencode releases its workers and session ids immediately regardless. |
| `turnStats` | boolean | `false` | Append one `▌ **stats:**` line to each finished turn: cost, wall duration, CLI turn count, and input/output/cache-read/cache-write tokens, taken from the CLI's own `result`. Never on a compaction turn or a turn that ended in error. Its own text part, stripped from transcripts rebuilt for the CLI, so the model never sees it. The same numbers are logged at INFO regardless, and `modelUsage` plus `permission_denials` always reach `providerMetadata`. Reported cost is the CLI's figure, not a billing guarantee. |
| `bridgeOpencodeSkills` | boolean | `false` | Stage the user's opencode skills for Claude's native Skill tool as `opencode-skills:<name>`, on headless, interactive and direct `doGenerate` spawns (never compaction). Requires the CLI's `--help` to advertise `--plugin-dir`; otherwise no-op. Bridged skills are also listed in opencode's forwarded system prompt, so a large skill set costs prompt tokens twice, which is why it is off by default; `true` opts the user's skills in. Bundled skill staging ignores this option, but still requires flag support and successful discovery/staging. |
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
| `OPENCODE_CLAUDE_CODE_PLUGIN_NO_CLEANUP=1` | Skip the one-time removal of a stale unscoped `opencode-claude-code-plugin` install from opencode's package cache. |
| `ANTHROPIC_API_KEY` | CLI API authentication input, stripped when `ignoreAnthropicApiKey` is true; otherwise may change billing away from stored subscription auth. Never display it. |
| `ANTHROPIC_AUTH_TOKEN` | CLI auth-token input; same strip/warning rule. Never display it. |
| `DISABLE_AUTOUPDATER` | Set to `1` on every spawned `claude`, and only when the user has not set it. Keeps the CLI from updating mid-session, which would invalidate the cached version that gates `--thinking-display summarized`, `--plugin-dir` and fast mode. Not a provider option: a user-set value (including `0`, meaning keep updating) is never overwritten, which is the intended escape hatch. Tell a user who wants CLI autoupdates to export `DISABLE_AUTOUPDATER=0`, not to look for a config key. |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Set to `1` on every spawned `claude` under the same never-overwrite rule. Suppresses non-essential CLI network traffic and independently blocks auto-update. An empty string counts as user-set and is left alone; the CLI reads it as off. |
| `OPENCODE_CONFIG` | Explicit config file, also read by the disk MCP bridge before project layers. |
| `OPENCODE_CONFIG_DIR` | Additional `.opencode`-style config/skill root. The plugin's direct agent-file fallback does not use it; agents must reach the config hook or a supported agent directory. |
| `OPENCODE_WORKTREE` | Overrides the disk MCP bridge's project walk-up boundary. |
| `XDG_CONFIG_HOME` | Global MCP/skill/AGENTS discovery root (`<value>/opencode`); defaults to the home `.config`. Direct agent-file fallback still uses `~/.config/opencode/agent(s)`. |
| `XDG_CACHE_HOME` | Account wrapper/cache-cleanup root override; do not assume the default cache path when upgrading. |
| `HOME` | Home expansion and direct agent-file discovery (other paths also use OS homedir). Do not change it to switch accounts. |
| `USERPROFILE` | Home fallback where `HOME` is absent. |
| `OPENCODE_VERSION` | Startup diagnostics version fallback, not a capability override. |

## Recipes

### Minimum install

```json
{ "plugin": ["@khalilgharbaoui/opencode-claude-code-plugin"] }
```

Everything else is optional. Models appear in the picker without extra config.

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
- Only a rejected `rate_limit_event` or one of the two known account-limit error texts
  opens the form. A generic 4xx, a timeout or a bad flag never does.
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
---
```

Or once for every discovered subagent without a full provider/model pin:

```json
{ "provider": { "claude-code": { "options": { "defaultSubagentModel": "claude-opus-5" } } } }
```

Rules, in order: `forceModel` wins; else `mode: subagent` with `defaultSubagentModel`
set; else untouched. An agent with `model: <provider>/<id>` is left exactly as written,
account and all (`model: claude-code-work/claude-opus-5@work` pins the account too).
Undeclared built-ins are not discovered; a user definition with a built-in name can
enter the registry and is subject to these rules. This is not a built-in-name denylist.
`reasoningEffort` in the agent file beats the effort the call arrived with; compaction is
exempt. Effort and model are part of the CLI session key, so a changed agent respawns
rather than sharing a process.

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

### Route a tool through opencode, or switch one off

```json
{ "proxyTools": ["Bash", "Edit", "Write", "WebFetch", "Task"], "extraDisallowedTools": ["NotebookEdit"] }
```

Options fragments in recipes belong inside `provider.claude-code.options`, not at
the config root. Preserve other wanted proxies when changing this replacement list.
`Read`, `Glob` and `Grep` have tool mappings/disallowed-name entries but no selectable
proxy definitions in this version, just like `NotebookEdit` has no proxy. Adding them
to `proxyTools` warns and leaves the built-ins unproxied. Use `extraDisallowedTools`
only to deliberately remove a capability; omission from `proxyTools` is not denial.

The proxy's loopback endpoint has bearer, Host, Origin and Content-Type guards.
Never weaken them, publish its token or relax the generated MCP file's `0600` mode.
Restart all old processes after a security upgrade; changing files cannot patch them.

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
| `task` | `"Task"`, default; disables CLI Agent and dispatches opencode subagents under its permissions. No proxy deadline by default; a positive `proxyToolTimeoutMs` entry adds one. |
| `task_batch` | Included with Task; one MCP call fans out two or more independent task inputs concurrently. Separate task calls were measured serial on CLI 2.1.258. |
| `question` | `"Question"`, opt-in; replaces AskUserQuestion only if the live opencode registry has question. Round-trip verified on plugin 0.18.0 / CLI 2.1.258 / opencode 1.18.29, headless and as a real TUI form, with no `permission` block; grant `permission.question` only if a subagent's form is refused. Opt-in because it disables Claude's own AskUserQuestion. |
| `compress` | `"Compress"`, opt-in; in-process summary/reset interceptor, no opencode permission prompt and no built-in replacement. Discards prior CLI detail on a later eligible turn, retaining the summary, not the full transcript. Keep off unless explicitly requested. Reset round-trip verified live on CLI 2.1.263 / opencode 1.18.31. Not the same tool as a forwarded opencode `compress` (see `proxyOpencodeTools`): this one resets the Claude session, that one compresses opencode's transcript. Enabling both leaves this one holding the name. |

A proxied call is held open until an event ends it, and the plugin listens to the
`claude` process, the stream and the control protocol for those events rather than
inferring failure from elapsed time: opencode's result resolves the call; an abort
interrupts the CLI and rejects the turn's pending calls, even when it lands while
opencode is running the tool; the next user message rejects what the previous turn left pending
and tells the CLI; the process exiting, the chat being deleted, or opencode exiting
rejects the rest. That is why `task` and `task_batch` carry no default deadline and a
subagent runs to completion. Three timers remain and are distinct from that: the
optional per-tool deadlines above (a backstop the user chooses), the start and
inactivity watchdogs (for a process that is alive but silent, which emits nothing to
listen to; a CLI parked in a proxied call is exempt), and the connection keepalives
(SSE comments or JSON whitespace every 15 s, so the CLI's HTTP client does not give up
on a long call; they never extend a deadline). Do not present a raised deadline as the
fix for a long subagent; the default already waits for it. A deadline-free call is not
silent while it waits: it logs `proxy call still waiting, no deadline` at WARN after
five minutes and every five minutes after, with tool, call id and elapsed time. That
line is a status report, never a failure; it does not end the call. A call that HAS a
deadline instead logs `proxy call still waiting, deadline approaching` once, at 60% of
that deadline, carrying `remainingMs` and naming `proxyToolTimeoutMs`; deadlines under
a minute are not announced, because there the notice and the rejection would arrive
together. Neither line means something is wrong and neither ends a call. Use them, or
`/claude-code-doctor`, to tell a working subagent from a wedged one before suggesting
any timeout change.

### Let Claude load the user's opencode skills

```json
{ "bridgeOpencodeSkills": true }
```

The bridge is off by default. With it on, `Skill("<name>")` works for any skill opencode
advertises. Bridged names are `opencode-skills:<name>`, including this bundled skill as
`opencode-skills:claude-code-plugin`. The package also registers its skill directory
with opencode's `skills.paths`; older opencode versions may not support that surface.
The native Claude bridge needs `--plugin-dir` support and is wired into headless
streaming, interactive and direct `doGenerate` spawns, never compaction. Set `true`
only when the user asks for it, since a large skill set costs prompt tokens twice; the
bundled skill is staged either way. Reusing a process does not load a new skill catalog.

User roots: `.opencode/skills` walking from cwd to filesystem root, home `.opencode/skills`,
`OPENCODE_CONFIG_DIR/skills`, then `XDG_CONFIG_HOME/opencode/skills` (home `.config`
fallback). First name wins; enabled user bridging can shadow bundled names. Only immediate
`<name>/SKILL.md` directories are collected. Arbitrary `skills.paths`, `skills.urls`,
singular `skill/`, `~/.agents/skills` and `~/.claude/skills` are not scanned by this
bridge; Claude can already discover its own skills independently. Broad bridging can
duplicate advertised skill context and exposes every discovered skill, not just one.

### Change when idle workers are freed

```json
{ "idleProcessTimeoutMs": 900000 }
```

The default is thirty minutes: that long after a turn ends with no new message, the
conversation's `claude` process exits, and the next message resumes the same
conversation. This example shortens it to fifteen; `0` keeps workers until the
8-process LRU cap evicts the oldest idle one. Neither ever kills a worker mid-turn.

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

### Upgrade the plugin

A published version does not reach a running opencode. First distinguish an npm pin,
npm latest resolution, and a local `file://` install. Preserve a pin unless the user
requested changing it. Some opencode versions freeze latest in
`~/.cache/opencode/packages/@khalilgharbaoui/opencode-claude-code-plugin@latest/`.
Inspect the actual cache location/package identity and get approval before removing
only that stale package directory, never the whole cache or auth/session directories.
Respect platform/XDG paths. Then fully relaunch. A `file://` install uses the checkout's
`dist/`: rebuild with `npm run build` and restart after approval, not cache deletion.
No manual skill copy/update is needed. Do not publish or release as part of configuring.

## Models and variants

### Registered model ids

Registered ids: `claude-haiku-4-5`, `claude-sonnet-4-5`, `claude-sonnet-4-6`,
`claude-sonnet-5`, `claude-opus-4-5`, `claude-opus-4-6`, `claude-opus-4-7`,
`claude-opus-4-8`, `claude-opus-4-8-fast`, `claude-opus-5`, `claude-opus-5-fast`,
`claude-opus-5-5`, `claude-opus-5-5-fast`, `claude-fable-5`, `claude-fable-5-1`,
`claude-mythos-5`, `claude-mythos-5-1`.

### Variants and costs

- Display names end in a `(N×)` list-price multiplier relative to Haiku: 1× haiku,
  3× sonnet, 4× opus 5.5, 5× other opus, 8× fast-mode opus 5.5, 10× fable, mythos
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
`proxyTools`, `mcpServers`, `interactiveTransport`, `planModeQuestion`,
`anthropicApiKeyInEnv`, `claudeCli.path` and `.version`
(`not detected` means the binary did not answer `--version`, which also disables
version-gated flags). Cwd is a startup fallback snapshot, not the per-session spawn
directory. MCP names are disk discovery, not proof of live connectivity. Interactive
status is a preference report, not proof that Bun PTY transport was used. Check a
relevant, redacted spawn/bridge entry for actual routing after an approved normal turn.

Useful log lines to search for (redact payloads): `spawning new claude process`,
`bridged opencode skills into claude`, `interrupt sent for aborted turn`, `btw:`,
`rendering opencode-side tool result as text`, `proxy-mcp tool call received`,
`evicting idle claude process`, `fast mode` warnings.

Version requirements: Claude Code CLI 2.1.142+ recommended (thinking summaries),
2.1.220+ for fast mode, 2.1.258+ for `/btw`, 2.1.280+ for `claude-opus-5-5` (the
API rejects it from an older CLI with a 400 naming that floor). Check with
`claude --version`.

Only if a proxy security check is specifically requested: identify the exact local
proxy port first, not every opencode listener. An unauthenticated `initialize` with
the correct `127.0.0.1:<port>` Host, no Origin and JSON Content-Type should get `401`.
`200` on a confirmed proxy endpoint is unsafe; restart/upgrade. Other status codes
alone do not prove it patched. Never call `tools/call` or obtain the bearer to probe.

`/claude-code-doctor` prints the same fields as the startup block plus live runtime
state, in the chat, with no model inference and at zero tokens: plugin/opencode/CLI
versions, cwd and its resolution tier, providers, accounts, `proxyTools`, disk MCP
servers, transport, whether an `ANTHROPIC_API_KEY` is present (never its value), the
live `claude` processes (opencode session, model, pid, in flight, age, effort), pending
proxy calls with their deadlines, and one unauthenticated `initialize` against each
proxy URL (`401, good`; anything else is flagged unsafe). Prefer it over asking for
`plugin.log` for a first look. It carries no bearer token, no key value and no system
prompt. A user-defined `claude-code-doctor` command is never overwritten. The name has
no space in it: opencode would read the second word as an argument.

Claude Code stream events the plugin now surfaces without debug logging: a rate-limit
rejection, a context compaction the CLI did on its own, a `result` subtype other than
`success` (which now finishes the turn as an error, not a clean stop), and a failed
CLI-executed tool (forwarded with the error flag, so the row renders as failed). A
failed MCP server at session start and an `apiKeySource` that means API-key billing
each warn once per process. None of these are actions the plugin may take on the user's
behalf; enabling paid usage or changing auth still needs approval.

`/btw <question>` needs an existing headless Claude conversation and CLI 2.1.258+.
It asks through the side channel and keeps the answer in the conversation (inline
when possible); it is excluded from Claude's normal turn history. It is still
inference: zero reported usage for the aside does not mean free. User-defined `btw`
commands are preserved. Do not use it as an automatic diagnostic probe.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| A config change did nothing | Options are read at startup; another opencode window is still running the old process | Fully quit every opencode window and relaunch |
| New plugin version or model not in the picker after upgrading | Frozen `@latest` in opencode's package cache | Remove the cache dir (recipe "Upgrade the plugin") and relaunch |
| `/btw` shows "Queued" or "requires an idle Claude Code session" | Plugin older than 0.15.2, or a window started before the current build | Upgrade and restart. `/btw` also needs Claude Code 2.1.258+ |
| Model calls `Skill("x")` and gets `Unknown skill` | Wrong namespace (`opencode-skills:x`), a CLI without `--plugin-dir`, an unscanned root, a compaction turn, or `bridgeOpencodeSkills: false` | Check the namespace, `claude --help` and the skill root; remove the `false` only with approval |
| `Subagent failed (task_id …): Tool execution aborted` while the child finished fine | Bug fixed in 0.15.1 | Upgrade |
| A `subtask: true` command's subagent output is "lost" | Bug fixed in 0.15.4 | Upgrade |
| Two subagents run one after another | The CLI serialises MCP calls | Plugin 0.17.0+; the model must use `mcp__opencode_proxy__task_batch` |
| Esc does not stop Claude; aborted turns keep running | Plugin older than 0.16.0 | Upgrade |
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
| A CLI tool row looks successful but its output is an error | Plugin older than this release forwarded `is_error` results as successes | Upgrade; failed CLI tools now render as failed |
| Claude "forgot" the earlier part of a long conversation | Claude Code compacted its own context | Look for the `▌ **context compacted:**` note in the transcript |
| Wanting the per-turn cost in the chat | Not shown by default | Set `turnStats: true` and restart opencode |
| Turn ends with an error naming an exit code or signal and a stderr tail | The `claude` child died mid-turn without emitting its terminal `result` | Read the quoted stderr; that is the CLI's own reason. Older builds reported this as a normal stop, so a truncated answer looked finished |
| An answer is cut off with no error, in a window with many open chats | Plugin older than this fix: LRU eviction could kill a process mid-turn | Upgrade. Eviction now takes the oldest idle process and skips the round when all 8 are busy; the 30-minute idle timer spares a busy worker too |
| A `claude` worker lingers after its chat was deleted, or after opencode quit | Plugin older than this release | Upgrade. Deleting a chat now releases its workers; every retained worker is killed when opencode exits |

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
