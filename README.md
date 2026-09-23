# @khalilgharbaoui/opencode-claude-code-plugin

[![npm](https://img.shields.io/npm/v/@khalilgharbaoui/opencode-claude-code-plugin.svg)](https://www.npmjs.com/package/@khalilgharbaoui/opencode-claude-code-plugin)

Use Claude models inside [opencode](https://opencode.ai) by driving the official **Claude Code CLI** (`claude`) as a subprocess. opencode therefore inherits whatever authentication that CLI already holds: a Claude subscription login, an API key, Bedrock, or Vertex. This plugin never reads, stores, or replays an OAuth token of its own.

- **Your CLI's auth, untouched.** Because `claude` does the authenticating, there is no subscription token here to lift and replay against the Anthropic API. That replay is what proxy-style opencode plugins do, it is a practice Anthropic has disallowed for third-party tools in 2026, and it is structurally not something this plugin can do.
- **opencode stays in charge of your machine.** Bash, Edit, Write, WebFetch and subagent dispatch are executed by opencode, behind its permission prompts and audit log, rather than by Claude Code. See [Selective tool proxy](#selective-tool-proxy).
- **Headless by default, which has a billing consequence.** `claude --print` usage on a subscription plan draws from the separate Agent SDK / extra-usage allowance rather than from normal plan usage; API-key authentication is unaffected. See [Billing](#billing).

> Maintained fork of [`unixfox/opencode-claude-code-plugin`](https://github.com/unixfox/opencode-claude-code-plugin). Published as `@khalilgharbaoui/opencode-claude-code-plugin` on npm.

---

## Quickstart

### 1. Install and log in the Claude Code CLI

The plugin drives an existing [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code); it does not bundle one. Check that `claude` is on your `$PATH` and authenticated:

```bash
claude --version      # e.g. 2.1.263 (Claude Code)
claude auth status    # which account you are signed in as
claude auth login     # run this if you are not signed in yet
```

`login`, `status` and `logout` are the `claude auth` subcommands as of 2.1.263. Run `claude auth --help` if your install differs.

### 2. Add the plugin to your opencode config

opencode reads a global config at `~/.config/opencode/opencode.json` (or `$XDG_CONFIG_HOME/opencode/` when that is set). A project-level `opencode.json` in your repo overrides the global one, and `OPENCODE_CONFIG=/path/to/config.json` points opencode at one specific file instead. Put the plugin in the global config so every project gets it:

```json
{
  "plugin": ["@khalilgharbaoui/opencode-claude-code-plugin"]
}
```

That package spec is the whole install. Do **not** `npm install` the package yourself: opencode resolves and caches plugin packages on its own. You do not need a `provider` block either, unless you want to change one of the [options](#options-reference).

### 3. Restart opencode and verify

Quit opencode fully and relaunch it: plugins are loaded once, at process start, so a reload is not enough.

In the model picker you should now see a provider called **Claude Code (Default)** holding entries such as `Claude Haiku 4.5 (1×)`, `Claude Sonnet 5 (3×)` and `Claude Opus 5 (5×)`. The `(N×)` suffix is each model's list price relative to Haiku; see [Models](#models). Pick one and send a message.

If the provider does not appear, turn on the plugin's log file and look for its one startup line:

```bash
OPENCODE_CLAUDE_CODE_LOG_FILE=1 opencode
grep "plugin ready" ~/.local/share/opencode-claude-code/plugin.log
```

That single `NOTICE: claude-code plugin ready` entry reports the plugin version, the `claude` binary and version it found, the directory it will spawn in, and which providers registered. [Startup diagnostics](#startup-diagnostics) explains every field.

### Not seeing a version you just upgraded to?

opencode resolves the `@latest` plugin spec once and freezes the concrete version into its own package cache, so restarting never re-resolves the tag. Delete the cache entry and relaunch:

```bash
rm -rf ~/.cache/opencode/packages/@khalilgharbaoui/opencode-claude-code-plugin@latest
```

### Local development

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

CI installs and builds on **Node 24** (`.github/workflows/publish.yml`), which is the only version this package is built against. `package.json` declares no `engines` range, so older Node versions are untested rather than deliberately unsupported. opencode itself may run under Bun; the [interactive transport](#interactive-transport-experimental) requires that.

### opencode 2

The same package runs on opencode 1.x and 2.x, and nothing changes for 1.x. The same config works too: opencode 2's native key is `plugins`, but it still reads the 1.x `plugin` key shown above, so an existing install needs no edit. A config used only by opencode 2 can spell it natively:

```json
{
  "plugins": ["@khalilgharbaoui/opencode-claude-code-plugin"]
}
```

Your existing `provider.claude-code.options` block keeps working, because opencode 2 still reads 1.x config files. Its native spelling is `provider.claude-code.settings`, and plugin-level settings such as `accounts` may also go in the plugin entry itself: `{"package": "@khalilgharbaoui/opencode-claude-code-plugin", "options": {"accounts": ["work"]}}`.

For a local checkout, point opencode 2 at the **`dist` directory**, not the repository root. It loads `<dir>/server` or `<dir>/index` from a directory and never reads `package.json#main`:

```json
{
  "plugins": ["/absolute/path/to/opencode-claude-code-plugin/dist"]
}
```

Verified live on opencode **2.0.11** with Claude Code 2.1.280: chat turns, proxied tools running through opencode 2's own `shell`, `edit`, `write`, `webfetch` and `subagent` tools and their permission rules, Claude's own tools rendered in the transcript, subagent dispatch with the agent list, reasoning variants, compaction, account providers, `/claude-code-doctor`, `/btw`, and the bundled configuration skill. Differences from 1.x:

- **`/btw` is answered after the running turn**, not inside it. opencode 2's plugin API has no session-status route, which is what 1.x uses to write the answer into a turn that is still running. The aside is queued, so it can never swallow the turn's own continuation.
- **No todo panel.** opencode 2 has no `todowrite` tool, so Claude's task list is not mirrored into one.
- **Account failover and the plan-mode form** use opencode 2's `question` tool, which takes the same input as 1.x. Both are covered by offline tests only on 2.x, since neither can be triggered on demand.

---

## Models

The plugin auto-registers the following, and they appear in the model picker with no extra config: Haiku 4.5, Sonnet 4.5/4.6/5, Opus 4.5/4.6/4.7/4.8/5/5.5 (plus three fast-mode Opus entries), Fable 5/5.1 and Mythos 5/5.1, each except Haiku carrying `low` / `medium` / `high` / `xhigh` / `max` reasoning variants.

| ID | Display name | Context | Output | Reasoning variants | Price × |
|---|---|---|---|---|---|
| `claude-haiku-4-5` | Claude Haiku 4.5 | 200k | 64,000 | – | 1× |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 | 200k | 64,000 | low/medium/high/xhigh/max | 3× |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | 1M | 128,000 | low/medium/high/xhigh/max | 3× |
| `claude-sonnet-5` | Claude Sonnet 5 | 1M | 128,000 | low/medium/high/xhigh/max | 3× |
| `claude-opus-4-5` | Claude Opus 4.5 | 200k | 64,000 | low/medium/high/xhigh/max | 5× |
| `claude-opus-4-6` | Claude Opus 4.6 | 1M | 128,000 | low/medium/high/xhigh/max | 5× |
| `claude-opus-4-7` | Claude Opus 4.7 | 1M | 128,000 | low/medium/high/xhigh/max | 5× |
| `claude-opus-4-8` | Claude Opus 4.8 | 1M | 128,000 | low/medium/high/xhigh/max | 5× |
| `claude-opus-4-8-fast` | Claude Opus 4.8 Fast | 1M | 128,000 | low/medium/high/xhigh/max | 10× |
| `claude-opus-5` | Claude Opus 5 | 1M | 128,000 | low/medium/high/xhigh/max | 5× |
| `claude-opus-5-fast` | Claude Opus 5 Fast | 1M | 128,000 | low/medium/high/xhigh/max | 10× |
| `claude-opus-5-5` | Claude Opus 5.5 | 1M | 128,000 | low/medium/high/xhigh/max | 4× |
| `claude-opus-5-5-fast` | Claude Opus 5.5 Fast | 1M | 128,000 | low/medium/high/xhigh/max | 8× |
| `claude-fable-5` | Claude Fable 5 | 1M | 128,000 | low/medium/high/xhigh/max | 10× |
| `claude-fable-5-1` | Claude Fable 5.1 | 1M | 128,000 | low/medium/high/xhigh/max | 10× |
| `claude-mythos-5` | Claude Mythos 5 | 1M | 128,000 | low/medium/high/xhigh/max | 10× |
| `claude-mythos-5-1` | Claude Mythos 5.1 | 1M | 128,000 | low/medium/high/xhigh/max | 10× |

`claude-mythos-5` and `claude-mythos-5-1` are Mythos-class counterparts to the corresponding Fable models, but without safety classifiers, and are **limited availability via [Project Glasswing](https://anthropic.com/glasswing)**. They're registered unconditionally; if your Claude account lacks access, `claude --model` just errors. Use the corresponding generally available `claude-fable-5` or `claude-fable-5-1` otherwise.

Capabilities for every model: text + image input, text output, tool use, attachments. No temperature control, no PDF/audio/video, no interleaved streaming.

**Price ×** is each model's per-token list price relative to Haiku, the cheapest model. It's derived exactly from Anthropic's published pricing (input and output ratios both come out the same: Haiku $1/$5 = 1×, Sonnet $3/$15 = 3×, Opus 5.5 $4/$20 = 4×, Opus $5/$25 = 5×, Opus 5.5 fast mode $8/$40 = 8×, Fable/Mythos 5 and 5.1 / Opus 5 and 4.8 fast mode $10/$50 = 10×). So **Fable/Mythos 5 and 5.1, and fast-mode Opus 5 and 4.8, all cost 2× standard Opus 5**, and fast mode is 2× the standard price on every Opus that offers it. The same multiplier is shown as a `(N×)` suffix on the display name in opencode's model picker, since opencode has no dedicated multiplier field. On a flat Max/Pro subscription it doubles as a rough guide to how fast each model drains your usage limit.

Fable 5.1 and Mythos 5.1 keep the same $10/M input and $50/M output rates as 5.0, but cache reads cost $0.25/M instead of $1/M. Their cache-write rate remains $12.50/M.

Opus 5.5 is priced below the Opus line at $4/M input and $20/M output, with cache writes at $5/M and cache reads at $0.20/M (0.05× input rather than the usual 0.1×). It needs **Claude Code 2.1.280 or newer**: the API rejects it from an older CLI with a 400 naming that floor, which shows up as a failed turn.

The model ID is passed straight through to `claude --model`, so anything Claude Code accepts works. The three `-fast` IDs are the one exception, described below.

### Fast mode

`claude-opus-5-5-fast`, `claude-opus-5-fast` and `claude-opus-4-8-fast` run the same models at up to 2.5× the output tokens per second, at 2× the price ($8/M input, $40/M output for Opus 5.5, the 8× column; $10/M input, $50/M output for Opus 5 and 4.8, the 10× column). Pick them in the model selector like any other model.

The `-fast` suffix is this plugin's own marker, not a model name Anthropic serves. The plugin strips it and spawns `claude --model claude-opus-5 --settings '{"fastMode":true}'`, because that settings layer is the only way to opt a headless (`--print`) session into fast mode: there is no `--fast` flag, and the old `claude-opus-4-6-fast` style model names are retired. Requires Claude Code 2.1.220+; below that the plugin skips the opt-in and you get standard speed.

Fast mode is not available everywhere, and it **fails soft**: an ineligible account drops back to standard speed with no error. Known blockers:

- **Usage credits are off.** The most common one. Run `/usage-credits` in an interactive `claude` session to enable them.
- **Not first-party.** Fast mode is Anthropic-API-only; Bedrock, Vertex, and Foundry are excluded.
- **Free tier**, or an organization that has turned fast mode off.
- **Cooldown.** Fast mode has its own rate limit; after a hit, Claude Code falls back to standard until it clears.
- `CLAUDE_CODE_DISABLE_FAST_MODE=1` in the environment turns it off outright.

Because a downgrade is otherwise invisible, and because the picker shows these IDs at 10× regardless, the plugin logs a **warning** (once per reason) when a fast turn actually ran at standard speed, naming the reason. If you see it, switch to the non-fast ID so the picker's price matches your bill.

### Picking a variant

Variants set the underlying reasoning effort. They're regular opencode model variants — pick them in the model selector. If you'd previously declared variants in your project's `opencode.json`, they're merged on top of the defaults so nothing gets lost.

---

## Billing  

By default this plugin drives Claude Code headlessly (the Agent SDK path, `claude --print`). Since June 2026, headless usage on a Claude subscription plan draws from a separate Agent SDK credit / extra usage rather than from normal plan usage. Authenticating the CLI with an API key is unaffected by that policy and bills as ordinary API usage.

Anthropic's own page is the authoritative and current source, including the amounts, which change: <https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan>

Two things in this plugin interact with the above. [`ignoreAnthropicApiKey`](#options-reference) stops a stray `ANTHROPIC_API_KEY` in your environment from silently redirecting the CLI onto pay-as-you-go API billing. The experimental [interactive transport](#interactive-transport-experimental) drives the real `claude` TUI instead of `--print`, which bills as normal plan usage.
  
---

## Configuration

The minimum config is just the `plugin` entry above. Everything below is optional override that goes in a `provider.claude-code` block.

### Multiple Claude Code accounts

Declare account names once and the plugin expands them into separate opencode providers:

```json
{
  "plugin": ["@khalilgharbaoui/opencode-claude-code-plugin"],
  "provider": {
    "claude-code": {
      "options": {
        "accounts": ["personal", "work"]
      }
    }
  }
}
```

`default` is always implicit, so the config above creates:

| Provider ID | Display name | Claude config dir |
|---|---|---|
| `claude-code-default` | `Claude Code (Default)` | normal `~/.claude` |
| `claude-code-personal` | `Claude Code (Personal)` | `~/.claude-personal` |
| `claude-code-work` | `Claude Code (Work)` | `~/.claude-work` |

Non-default accounts use `CLAUDE_CONFIG_DIR` through a generated wrapper script, so auth/session state stays isolated per account. Shared capability files and folders are symlinked from `~/.claude` into each account dir when present:

```text
CLAUDE.md
settings.json
skills/
agents/
commands/
plugins/
```

Identity/session state is not shared.

Login each account once:

```bash
CLAUDE_CONFIG_DIR="$HOME/.claude-personal" claude auth login
CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude auth login
```

The account model IDs are internally suffixed, for example `claude-sonnet-4-6@work`, so long-lived Claude subprocess sessions do not collide across accounts. The generated wrapper strips the suffix before calling `claude --model`.

#### Account failover

With more than one account configured, an account running out of usage mid-task no longer just ends the turn. The plugin asks, using opencode's own `question` form:

```text
Account limit
The Claude account "work" is out of usage in the five_hour window, which resets at
2026-09-20T18:00:00.000Z. Continue this task on another configured account?
Leaving this unanswered waits, at no cost.

  personal   Run on "personal" until 2026-09-20T18:00:00.000Z. …
  default    Run on "default" until 2026-09-20T18:00:00.000Z. …
  stop       End this turn now and leave the account as it is.
```

Pick an account and the task continues on it **inside the same opencode turn**, with no new message from you. This is on by default because the pick is the consent: nothing moves until you choose, and leaving the form open costs nothing.

What a pick does, in full:

- **It is sticky for the limited account, not for the session.** A usage limit belongs to the account, so one pick governs every session running on `work`, and subagents follow their parent for free. It lasts until the limit's reset time, or until opencode restarts when the CLI did not report one. Child sessions never show the form themselves.
- **The conversation is replayed, not resumed.** Claude transcripts live under each account's own `CLAUDE_CONFIG_DIR`, so `--resume` cannot cross accounts. The plugin starts a fresh Claude session on the target and replays the thread from opencode's history, then tells it to carry on. That costs input tokens on the new account, and anything the CLI held but opencode did not is gone.
- **Per-profile MCP servers do not come along.** A server configured only in the limited account's Claude profile is simply absent on the target.
- **`stop`, dismissing the form, or any answer that is not one of the offered accounts** ends the turn exactly the way the rate-limit error ends it today.

Only two things open the form: a `rate_limit_event` the CLI marked `rejected`, and the two known account-limit error texts (`Third-party apps now draw from your extra usage…`, `You've hit your individual spend limit`). A generic 4xx, a timeout or a bad flag never does, deliberately: a transient failure must not quietly move where your usage is billed.

Not available on the [interactive transport](#interactive-transport-experimental) (no proxy server, TUI stdin) or on compaction turns. Set `"accountFailover": "off"` to keep the plain error.

### Subagents: your account, their model

opencode's agent config cannot express "inherit the account, choose the model". A subagent that omits `model` inherits the invoking agent's whole model string; one that pins `model` inherits neither half, so pinning Opus also pins whichever account was written into it. This plugin closes that gap, because it is the piece that knows the account is the *provider* while the model is only a `--model` flag.

Write an agent markdown file. Nothing goes in `opencode.json`.

```markdown
---
description: Designs and builds UI work
mode: subagent
---
You are a designer...
```

`@designer` now runs on **the account of the session that invoked it**, on whatever model you point it at. Which model comes from one of two places.

Per agent, in the agent's own file:

```yaml
forceModel: claude-haiku-4-5
```

Or once, for every subagent that pins nothing, in the provider options:

```json
{ "provider": { "claude-code": { "options": { "defaultSubagentModel": "claude-opus-5" } } } }
```

The rules, in order:

| The agent | Runs on |
| --- | --- |
| `forceModel: <id>` | the caller's account, that model |
| `mode: subagent`, no model, `defaultSubagentModel` set | the caller's account, that model |
| `mode: subagent`, no model, no default set | untouched, inherits the caller's model |
| `model: <provider>/<id>` | exactly that, account and all (untouched) |
| anything opencode ships (`explore`, `general`, `compaction`) | untouched |

**`defaultSubagentModel` is unset by default and nothing is overridden without it.** That is deliberate: this feature rewrites what the model picker said would run, so an existing setup that upgrades the plugin has to behave exactly as it did before. Built-ins are excluded for the same reason, since forcing Opus onto a cheap exploration agent would be an expensive surprise nobody asked for. An unknown model id is refused and the original kept, rather than spawning the CLI with a `--model` it will reject.

Two things worth knowing. The overridden model is part of the Claude session key, so a subagent forced to Opus never shares a `claude` process with a Fable parent in the same directory. And opencode still prices the turn against the model *it* routed, so a cost readout attributes the work to the caller's model, not the one that actually ran.

### The effort an agent runs at

The same file can state its own thinking budget:

```yaml
reasoningEffort: high
```

That beats whatever effort the call arrived with. It has to, because opencode resolves one effort for a session and a subagent inherits it, which is wrong in the expensive direction: a caller who picked `max` for their own turn otherwise hands `max` to every worker it dispatches, and a mechanical lane burns a weekly cap at the costliest setting available. Model and effort together are what a turn costs, so both belong with the agent rather than with whoever happened to dispatch it.

An agent that declares nothing keeps the inherited effort, so this changes nothing until a file asks for it. An unrecognised level is refused and the inherited one kept, since the CLI rejects a level it does not know. Compaction is exempt: its summary always gets the full budget.

To force an **account** rather than a model, pin the full string. This only applies if you declared [`accounts`](#multiple-claude-code-accounts) in the first place; with the default single-account setup there is nothing to pin. Both halves are needed, because the provider selects the account's config dir and the `@account` marker is what the model was registered under for that provider:

```yaml
model: claude-code-work/claude-opus-5@work
```

### Options reference

```json
{
  "plugin": ["@khalilgharbaoui/opencode-claude-code-plugin"],
  "provider": {
    "claude-code": {
      "options": {
        "cliPath": "claude",
        "proxyTools": ["Bash", "Edit", "Write", "WebFetch", "Task"],
        "skipPermissions": true,
        "permissionMode": "default",
        "bridgeOpencodeMcp": true,
        "strictMcpConfig": false,
        "idleProcessTimeoutMs": 900000
      }
    }
  }
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `cliPath` | string | `"claude"` | Path to the `claude` executable (a binary, not a shell command with flags). opencode's config hook seeds this with `"claude"`, so under opencode this default always applies; `CLAUDE_CLI_PATH` is only consulted when `createClaudeCode()` is called directly and the option is absent. Account providers wrap it with a generated script; never point it at one of those yourself. |
| `accounts` | string[] | – | **Optional.** Most setups need no accounts at all: with this unset you get a single `Claude Code (Default)` provider on your normal `~/.claude` login. Supply names only to run several Claude logins side by side; `default` stays implicit, so `["work", "personal"]` gives you `Claude Code (Default)`, `Claude Code (Work)` and `Claude Code (Personal)`. See [Multiple Claude Code accounts](#multiple-claude-code-accounts). |
| `accountFailover` | `"ask"` \| `"off"` | `"ask"` | When this account runs out of usage mid-task, show a form listing the other configured accounts and continue on the one you pick, inside the same turn. Only ever fires when more than one account is configured, so a single-account setup is unaffected. `"off"` keeps the plain rate-limit error. See [Account failover](#account-failover). |
| `cwd` | string | see description | Working directory for the spawned CLI. Resolved **lazily per request**, first match winning: this explicit value, then the opencode session's own `directory` (so `opencode serve` and the web UI spawn in the right project even though one server handles many), then `process.cwd()` when it is a real directory, then the project directory captured at plugin init (this rescues macOS GUI launches, where `process.cwd()` is `/`), and finally `process.cwd()` regardless. [Startup diagnostics](#startup-diagnostics) reports which tier won. Session tier contributed by [@galvani](https://github.com/galvani). |
| `skipPermissions` | boolean | `true` | Pass `--dangerously-skip-permissions` to `claude`. It is still passed when `proxyTools` is set: proxied calls go through opencode's permission system regardless, but unproxied CLI built-ins do not. The one case where the flag is dropped is `permissionMode: "plan"`, because the CLI lets the skip flag override plan mode outright. See [Plan mode](#plan-mode). |
| `permissionMode` | `acceptEdits` \| `auto` \| `bypassPermissions` \| `default` \| `dontAsk` \| `plan` | – | Forwarded to headless `claude --permission-mode`. `"plan"` also suppresses `--dangerously-skip-permissions` (see the row above). Not version-gated, so check that your installed CLI accepts the value. The [interactive transport](#interactive-transport-experimental) does not forward it. |
| `defaultSubagentModel` | string | – | Model that plugin-discovered `mode: subagent` agents run on when their own definition pins nothing. The caller's account is kept; only the model name changes. An agent's own `forceModel` wins over it, and an unknown id is refused rather than spawned. Unset means no implicit override at all. See [Subagents: your account, their model](#subagents-your-account-their-model). |
| `proxyTools` | string[] | `["Bash", "Edit", "Write", "WebFetch", "Task"]` | Claude built-in tools to route through opencode's executor + permission UI. Opt-in extras: `"Question"`, `"Compress"`. See [Selective tool proxy](#selective-tool-proxy). |
| `extraDisallowedTools` | string[] | – | Extra Claude built-ins to switch off with `--disallowedTools`, on top of what `proxyTools` implies. Claude's names, e.g. `["NotebookEdit"]`. See [Closing a tool with no proxy](#closing-a-tool-with-no-proxy). |
| `proxyToolTimeoutMs` | `Record<string, number>` | – | Optional wall-clock backstop per proxy tool, in ms, keyed by proxy tool name (`bash`, `task`, …). A call normally ends on an event the plugin listens for (result, abort, next message, process exit, chat deletion), not on a timer; see [How a proxied call ends](#how-a-proxied-call-ends). Defaults: 10 min flat, `task` / `task_batch` → none, `question` → 30 min. `0` disables a tool's deadline; negative or non-numeric values are ignored. For `bash`, the call's own `input.timeout` is honoured on top (`max(resolved, input.timeout)`). See [Per-tool proxy timeouts](#per-tool-proxy-timeouts). |
| `planModeQuestion` | boolean | `false` | Route `ExitPlanMode` approval through opencode's native `question` tool instead of a text "(yes/no)" prompt. Opt-in, and currently unreachable on the default headless transport, which is not offered an `ExitPlanMode` tool at all. See [Plan mode](#plan-mode). |
| `controlRequestBehavior` | `allow` \| `deny` | `allow` | Default response when `skipPermissions: false` and Claude sends a `can_use_tool` control request. |
| `controlRequestToolBehaviors` | `Record<string, "allow" \| "deny">` | – | Per-tool override for `can_use_tool`. Example: `{ "Bash": "deny", "Read": "allow" }`. |
| `controlRequestDenyMessage` | string | built-in message | Message returned to Claude on a deny. |
| `bridgeOpencodeMcp` | boolean | `true` | Auto-translate your opencode `mcp` block into Claude's `--mcp-config`. See [MCP bridge](#mcp-bridge). |
| `mcpConfig` | string \| string[] | – | Extra `--mcp-config` paths/JSON passed alongside the bridged config. |
| `strictMcpConfig` | boolean | `false` | Pass `--strict-mcp-config` so Claude loads **only** the configured servers and ignores `~/.claude/settings.json`. |
| `hotReloadMcp` | boolean | `true` | With MCP bridging on, compare the merged MCP config and runtime status at the start of each turn and respawn the `claude` process when they drifted, so a server you just enabled or disabled becomes visible without restarting opencode or opening a new chat. Eviction waits for pending proxy calls, never happening mid tool-call, and the session id is preserved for `--resume`. Set `false` to keep a cached subprocess until the chat is reset. It does not reload other provider options and does not watch the contents of files named in `mcpConfig`. |
| `proxyOpencodeMcpTools` | boolean | `false` | Route opencode's MCP-backed tools through the in-process `opencode_proxy` server instead of bridging them straight into Claude's `--mcp-config`, so each call executes once, inside opencode, with its permission prompt and its tool row. **The default changed from `true` to `false` in this release, and no behaviour changed with it:** at `true` it used to route nothing at all, because discovery read opencode's tool registry, which contains built-ins and plugin-declared tools and has never contained an MCP tool. Discovery now reads the model tool set opencode passes the provider, which is where MCP tools actually are, so the option works, and turning it on is the operator's decision rather than a silent migration of traffic that the direct bridge is handling today. Two caveats before enabling it: pair it with `strictMcpConfig: true`, because a server also registered in Claude Code's own config is reached directly and bypasses the proxy entirely; and a routed call runs in opencode with the calling agent's permissions, the same trade [`proxyOpencodeTools`](#options-reference) makes. Servers whose tools are not found stay on the direct bridge, and a warning says so, so do not treat this as an exactly-once guarantee for write-capable tools. |
| `proxyOpencodeTools` | string[] | `[]` | Forward named opencode tools through the proxy by their registry id, for tools another opencode plugin declares directly and that therefore belong to no MCP server (opencode-dcp's `compress`). Explicit allowlist; a forwarded tool runs inside opencode with the calling agent's permissions. A name already held by a proxy def is dropped with a warning rather than taking it over. See [Forwarding opencode's own tools](#forwarding-opencode-s-own-tools). |
| `stripContextReminders` | boolean | `false` | Remove opencode-dcp's `<dcp-system-reminder>` blocks from message text when no `compress` tool is proxied, so an order the model cannot follow stops being re-sent with every message that carries it. Inert as soon as `compress` is reachable. See [Trimming unsatisfiable context reminders](#trimming-unsatisfiable-context-reminders). |
| `webSearch` | `"claude"` \| `"disabled"` \| `<tool>` | `"claude"` | Routing for Claude's built-in `WebSearch`. See [WebSearch routing](#websearch-routing). |
| `multiStepContinuation` | boolean | `true` | Append a system-prompt hint nudging Claude to chain tool calls within one turn instead of pausing between subtasks. Each opencode turn boundary requires the user to manually press "continue", so for multi-step tasks this reduces friction. Set `false` to disable. |
| `autoContinueIncompleteTurns` | boolean \| `"smart"` | `"smart"` | Smartly continue incomplete Claude CLI results inside the same opencode turn. Reduces manual "continue" presses when Claude ends after reasoning/tool activity without a useful final answer. Set `false` to disable. |
| `compactionModel` | string | `"claude-haiku-4-5"` | Model used when opencode invokes `/compact`. Override per-process via the `CLAUDE_CODE_COMPACTION_MODEL` env var (env wins over config). See [Compaction](#compaction). |
| `ignoreAnthropicApiKey` | boolean | `false` | Strip `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from every spawned `claude` process so it authenticates with your logged-in subscription instead of pay-as-you-go API billing. The plugin warns once at startup whenever an API key is detected, regardless of this setting. See [Billing](#billing). |
| `idleProcessTimeoutMs` | number | – | Kill a retained headless Claude worker after this many idle milliseconds following a completed turn. The timer starts when a turn finishes, a new turn cancels it, a worker that is mid-turn when it fires is left alone and re-timed, and the session id is preserved for `--resume`. Values above Node's maximum timer delay (`2147483647`) are ignored. Omit or set `0` to retain workers until LRU eviction (16 processes). Interactive transport is excluded. Contributed by [@bernardofortes](https://github.com/bernardofortes). |
| `bridgeOpencodeSkills` | boolean | `false` | Expose your opencode skills to Claude's native `Skill` tool. Off by default because every bridged skill is also in the system prompt opencode forwards, so a large set is paid for twice per turn; the bundled configuration skill is staged either way. See [Skill bridge](#skill-bridge). Written by [@broskees](https://github.com/broskees). |
| `logging` | object | all defaults | The plugin's own logger, four independent fields: `file` (boolean, default `false`), `dir` (string, default `~/.local/share/opencode-claude-code/`), `mode` (`"silent"` \| `"debug"`, default `"silent"`) and `level` (`"debug"` \| `"info"` \| `"notice"` \| `"warn"` \| `"error"`, default `"info"`). Goes under `provider.claude-code.options` like every other row here. See [Logging](#logging). |
| `turnStats` | boolean | `false` | Append a one-line cost / duration / cache footer to each finished turn. See [Per-turn stats](#per-turn-stats). |
| `interactive` | boolean | `false` | **Experimental.** Drive the interactive `claude` TUI (subscription billing) instead of headless `--print`. Requires opencode running under Bun with PTY support; silently falls back to headless otherwise. The tool proxy, `permissionMode` and `/btw` are all unavailable on it, so read [What it does not support](#what-it-does-not-support) before enabling. Env: `CLAUDE_CODE_INTERACTIVE_TRANSPORT=1`. |
| `interactiveBypass` | boolean | `false` | Deprecated/no-op with `interactive`: Claude Code's TUI shows a manual safety confirmation for `bypassPermissions`, so the plugin intentionally does not pass it. |
| `interactiveAllowTools` | string[] | `["Bash", "Edit", "Write", "Read", "WebFetch"]` | With `interactive`: built-in tools pre-allowed without prompting (replaces the default list). MCP server wildcards (`mcp__<server>__*`) are always added from the bridged config. |
| `interactiveSystemPrompt` | boolean | `true` | With `interactive`: append this plugin's CLI/AGENTS/continuation prompt via `--append-system-prompt-file`. The transport intentionally does not forward opencode's own system prompt, because it can trigger Claude Code's third-party-app usage gate on subscription accounts. Set `false` only for diagnostics. |

### Environment variables

Every variable the plugin itself reads, in one place. Config is read once at opencode startup, so these are the way to change behaviour for a single run without editing `opencode.json`. Claude Code's own variables (`CLAUDE_CODE_DISABLE_THINKING` and friends) are passed through untouched and are listed under [Extended thinking](#extended-thinking).

| Variable | Read by | Effect |
|---|---|---|
| `CLAUDE_CLI_PATH` | provider factory | Fallback `claude` path when `cliPath` is absent. Under opencode the config hook always supplies `cliPath`, so this only applies to direct `createClaudeCode()` use. |
| `CLAUDE_CODE_COMPACTION_MODEL` | compaction spawn | Model for `/compact`. Wins over the `compactionModel` option. See [Compaction](#compaction). |
| `CLAUDE_CODE_INTERACTIVE_TRANSPORT` | transport selection | `1` turns on the experimental [interactive transport](#interactive-transport-experimental) for one process, same as `interactive: true`. |
| `CLAUDE_CODE_INTERACTIVE_BYPASS` | transport selection | Requests `bypassPermissions` in interactive mode. Deliberately ignored, with a warning, for the reason in the `interactiveBypass` row above. |
| `CLAUDE_CODE_START_WATCHDOG_MS` | start watchdog | Milliseconds a `claude` process may stay completely silent on stdout after a turn is written, or after a proxy tool result should have resumed it, before the plugin acts. First expiry respawns the process and resumes the session; a second ends the turn with an error rather than hanging. Default `90000`; a positive integer is required and anything else falls back to that. Mainly a knob for reproducing the hang. |
| `CLAUDE_CODE_RESULT_FALLBACK_MS` | wire-inactivity watchdog | Milliseconds a `claude` process that has already produced output may stay silent on stdout before the turn is closed without a `result`. The close is announced in the reply as a `▌ **stream timeout:**` note. Default `60000`; a positive integer is required and anything else falls back to that. Like the start watchdog, mainly a knob for reproducing a hang. |
| `OPENCODE_CLAUDE_CODE_LOG_FILE` | logger | `1` writes the log file, `0` forces it off even when `logging.file` is `true`. See [Logging](#logging). |
| `OPENCODE_CLAUDE_CODE_LOG_DIR` | logger | Directory for the log file, overriding `logging.dir`. |
| `OPENCODE_CLAUDE_CODE_LOG_LEVEL` | logger | Minimum level to emit, overriding `logging.level`. An unrecognised value falls through to config. |
| `DEBUG` | logger | `DEBUG=opencode-claude-code` promotes the logger to `mode: "debug"`, echoing every emitted level to opencode's TUI. |
| `OPENCODE_CLAUDE_CODE_PLUGIN_NO_CLEANUP` | startup cleanup | `1` skips the one-time removal of a stale **unscoped** `opencode-claude-code-plugin` install from opencode's plugin cache. That old package is a different artifact that shadows this scoped one when both are present; set this if you are deliberately keeping it. |
| `OPENCODE_WORKTREE` | MCP bridge | Overrides worktree-root detection, which otherwise walks up from the working directory looking for a `.git` entry. |
| `OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR` | config discovery | Where the plugin looks for your opencode config when bridging MCP and skills. See [Discovery order](#discovery-order-highest-to-lowest-priority). |
| `OPENCODE_VERSION` | startup diagnostics | Reported as the opencode version when set, sparing the plugin a `--version` spawn. Diagnostics only. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | spawn environment | Not set by the plugin: these are yours, and Claude Code authenticates with them in preference to your subscription login when present. `ignoreAnthropicApiKey: true` strips them from the spawn. See [Billing](#billing). |
| `DISABLE_AUTOUPDATER` | spawn environment | Set to `1` on every `claude` the plugin spawns, **only if you have not set it yourself**. The plugin detects your CLI version once and caches it, and gates `--thinking-display summarized`, `--plugin-dir` and fast mode on the answer, so a CLI that updates itself mid-session would leave those gates describing a binary that is no longer running. Export `DISABLE_AUTOUPDATER=0` to keep the autoupdater; your value is never overwritten, and updating the CLI between opencode restarts works normally either way. |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | spawn environment | Set to `1` on every spawned `claude` under the same never-overwrite rule. It suppresses the CLI's non-essential network calls and is a second, independent way Claude Code declines to auto-update. Export it yourself (including as an empty string, which the CLI reads as off) to take control. |

The plugin also honours the usual path conventions rather than defining its own: `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` (falling back to `~/.config` and `~/.cache`), `HOME` / `USERPROFILE`, and Claude Code's `CLAUDE_CONFIG_DIR` when the interactive transport needs to find the session transcript. Account providers set `CLAUDE_CONFIG_DIR` themselves for the process they spawn.

### Overriding model metadata

To rename a model, change a limit, or add a custom one:

```json
{
  "plugin": ["@khalilgharbaoui/opencode-claude-code-plugin"],
  "provider": {
    "claude-code": {
      "models": {
        "claude-sonnet-4-6": {
          "name": "Sonnet (custom)",
          "limit": { "context": 1000000, "output": 32768 }
        }
      }
    }
  }
}
```

Anything you supply is merged on top of the defaults; you don't need to redeclare every model.

---

## Interactive transport (experimental)

By default the plugin spawns `claude --print` (headless). From **June 15, 2026** that usage bills against the separate [Agent SDK credit](#billing) on subscription plans. The interactive transport instead drives the real interactive `claude` TUI — which bills as **normal plan usage** — under a native PTY inside opencode's Bun runtime, types your prompt into it, and streams the session transcript (`~/.claude/projects/<cwd>/<session-id>.jsonl`) back through the same pipeline the headless transport uses.

```json
"options": { "interactive": true }
```

Or per-process: `CLAUDE_CODE_INTERACTIVE_TRANSPORT=1`.

### Requirements

- opencode must be running under **Bun** with `Bun.Terminal` (PTY) support. If it isn't, the flag is ignored and the headless transport is used — nothing breaks.
- A logged-in `claude` (subscription auth). The whole point is plan billing, so API-key auth gains nothing here.

### What carries over from the headless transport

- The plugin's appended prompt (Claude CLI context, AGENTS.md guidance, continuation rules). The interactive transport intentionally does not forward opencode's own system prompt, because live testing showed that payload can trigger Claude Code's third-party-app usage gate on subscription accounts.
- The MCP bridge: bridged servers are passed via `--mcp-config` + `--strict-mcp-config`, and every bridged server is pre-allowed as `mcp__<server>__*`.
- The [skill bridge](#skill-bridge): the same `--plugin-dir` staging the headless spawn uses, so the TUI's native `Skill` tool can load your opencode skills too.
- Model selection, session reuse, and the whole streaming/usage pipeline.

Set `interactiveSystemPrompt: false` only for diagnostics. While disabled, the interactive session will not receive the plugin's CLI context, AGENTS.md guidance, or continuation hints.

### What it does not support

This is the part to read before turning it on. Three whole features of this plugin are simply absent on the interactive transport:

- **No tool proxy.** The interactive spawn starts no proxy MCP server at all, so `mcp__opencode_proxy__bash`, `edit`, `write`, `webfetch`, `task`, `task_batch`, `question` and `compress` do not exist for that session. Claude uses its own built-in tools directly, which means opencode does not execute them, does not prompt for them, and does not log them. Everything in [Selective tool proxy](#selective-tool-proxy) applies to the headless transport only.
- **No `permissionMode`.** The interactive spawn never passes your `permissionMode` to the CLI, so `"plan"` and the rest have no effect there. Permission handling is the pre-allow list described below and nothing else.
- **No [`/btw`](#side-questions-with-btw).** Side questions ride Claude Code's `side_question` control protocol over the headless process's stdio. Asking one in an interactive session returns an error telling you so.

### What else is different

- **Permissions:** the interactive TUI has no `can_use_tool` control channel, so tools can't be approved per-call through opencode. Built-in tools are pre-allowed via a settings allow list (default `Bash, Edit, Write, Read, WebFetch`; override with `interactiveAllowTools`). `bypassPermissions` is intentionally not used here because Claude Code shows a manual safety confirmation in the TUI and defaults to exit.
- **Input is text-only:** images and other non-text blocks are dropped (with a logged warning); tool results are rendered as labeled text.
- **Output granularity:** text arrives per transcript record, not token-by-token, so it can feel chunkier than headless streaming.
- **Turn timeout:** a turn that produces no terminal stop within 30 minutes is reported honestly as an error result (visible truncation), not silently ended.
- **No idle eviction:** `idleProcessTimeoutMs` does not apply to interactive sessions.
- `/compact` always uses the headless transport regardless of this setting.

---

## Selective tool proxy

This is the core feature.

By default, the plugin proxies `Bash`, `Edit`, `Write`, `WebFetch`, and `Task`. It disables Claude's corresponding built-in tool and exposes an equivalent through an in-process MCP server. Claude calls the MCP version, which blocks until opencode runs the tool through its own executor and permission system.

### Default proxied tools

| `proxyTools` value | Claude built-ins disabled | Proxy MCP tool exposed |
|---|---|---|
| `"Bash"` | `Bash` | `mcp__opencode_proxy__bash` |
| `"Edit"` | `Edit`, `MultiEdit` | `mcp__opencode_proxy__edit` |
| `"Write"` | `Write` | `mcp__opencode_proxy__write` |
| `"WebFetch"` | `WebFetch` | `mcp__opencode_proxy__webfetch` |
| `"Task"` | `Agent` | `mcp__opencode_proxy__task`, `mcp__opencode_proxy__task_batch` |
| `"Question"` | `AskUserQuestion` | `mcp__opencode_proxy__question` |
| `"Compress"` | none | `mcp__opencode_proxy__compress` |

### OpenCode-native subagents

`Task` is proxied by default. The proxy disables Claude CLI's `Agent` tool and emits an unexecuted `task` call; it does not register a replacement task tool. OpenCode's built-in TaskTool remains responsible for permission checks, creating or resuming the child session, selecting the configured subagent, and foreground/background lifecycle.

- **Permissions:** the calling agent's `permission.task` rule applies to the target `subagent_type`. Grant `task: "allow"` on agents that should delegate without a prompt; an `ask` or `deny` rule remains authoritative. The plugin never bypasses this decision.
- **Resume:** pass the child session ID back as `task_id` to continue that subagent session. Omit it to create a fresh child.
- **Nested tasks:** current opencode defaults `subagent_depth` to `1`, so a first-level child cannot launch another child. Increase top-level `subagent_depth` to permit deeper nesting, and explicitly grant `permission.task` on every subagent that should delegate; opencode otherwise adds a task deny to spawned subagent sessions.
- **Background:** `background: true` returns after starting the child and lets opencode notify the parent when it finishes. Current opencode requires `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` in the environment of the opencode process. Foreground is the default.
- **Several at once:** `mcp__opencode_proxy__task_batch` takes a `tasks` array of ordinary task inputs and runs them concurrently. It exists because Claude Code sends MCP requests one at a time: when the model emits two `task` calls in one response, the second only leaves the CLI after the first has returned (measured live, 2026-09-06), so "launch two subagents" was always serial. The plugin turns one `task_batch` call into N opencode `task` calls inside a single tool boundary, which opencode executes in parallel, then hands the model every result together, labelled in task order. Same permissions, same no-deadline default, same `subagent_type` list. Enabled whenever `Task` is proxied. Designed and first implemented by [@broskees](https://github.com/broskees) on his fork.

**Steering models to it.** Headless Claude Code CLIs expose no `Agent`/`Task`
dispatch tool of their own (verified on 2.1.211), while they *do* expose
`TaskCreate` — a todo tool. So "use a subagent" requests get mis-resolved:
a todo appears, nothing runs, and the model may still narrate a successful
dispatch. Two spawn-time countermeasures prevent that. The plugin injects
opencode's live agent-type list into the `task` proxy description (so the model
picks a real `subagent_type` instead of guessing a Claude Code name like
`general-purpose`, and doesn't grep configs to check a subagent exists), and
appends a system-prompt note naming
`mcp__opencode_proxy__task` as the only dispatch path — with the ToolSearch
recovery step for harnesses that defer MCP tool schemas. Both apply per Claude
process at spawn, and provider options are read once at opencode startup, so
`proxyTools` changes need a full opencode restart.

### Proxy endpoint security

The proxy is a small HTTP MCP server on an ephemeral loopback port, and calling it runs Bash, Edit and Write through opencode's executor. Since 0.13.2 it requires a 256-bit bearer token, generated per server and handed to Claude in the `headers` block of the `0600` MCP config file the plugin writes. Requests are also rejected unless the `Host` header matches the bound `127.0.0.1:<port>` authority, no `Origin` header is present, and the content type is `application/json`.

**Upgrade if you are on 0.13.1 or earlier.** Before this, any local process could post to that port and execute commands as you, and a web page you visited could do the same blind, without reading the response. Reported by @willmcginnis in [#28](https://github.com/khalilgharbaoui/opencode-claude-code-plugin/pull/28); tracked as [GHSA-3mxm-w7gf-3c5x](https://github.com/khalilgharbaoui/opencode-claude-code-plugin/security/advisories/GHSA-3mxm-w7gf-3c5x) (High, CVSS 7.5). No exploitation is known: it was found by code audit, not an incident.

**Restart every opencode you have running.** A plugin is read once, when the process starts, so an opencode you left open keeps the old code and keeps serving an unauthenticated proxy port for as long as it lives, however new the installed version is. Long-lived sessions are the ones to check:

```sh
lsof -nP -iTCP -sTCP:LISTEN | grep opencode
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:PORT/mcp \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

A patched process answers `401`. A `200` is a pre-0.13.2 process still running, and restarting it is the fix.

Nothing to configure. If proxied tools ever stop working after a Claude Code upgrade, check the plugin log for `proxy-mcp rejected a request`, which names which guard failed.

### Closing a tool with no proxy

`proxyTools` only reaches built-ins the plugin can replace. A built-in with no opencode equivalent, `NotebookEdit` today and whatever Claude Code ships next, stays enabled and unmediated no matter what you put in that list. `extraDisallowedTools` names them directly:

```json
"options": {
  "extraDisallowedTools": ["NotebookEdit"]
}
```

These go straight to `claude --disallowedTools`, so use Claude's tool names rather than opencode's. There is no replacement: the capability goes away rather than being routed through opencode, which is the point, but the model then has to work without it.

Unknown entries in `proxyTools` are logged as a warning at spawn rather than passing silently, so a typo shows up as "ignoring unknown proxyTools entries" in the plugin log instead of quietly leaving the matching built-in unmediated.

### Context compression

`"Compress"` is off by default. Add it when you run a harness that expects the model to manage its own context (opencode-dcp injects exactly those instructions), and the plugin exposes `mcp__opencode_proxy__compress`:

```json
"options": {
  "proxyTools": ["Bash", "Edit", "Write", "WebFetch", "Task", "Compress"]
}
```

It is the one proxy tool opencode never sees. The call is answered inside the plugin: the model passes a `summary`, the plugin stores it, and the turn continues normally. At the start of the **next** turn the Claude Code session is discarded and a fresh `claude` starts with that summary prepended to its system prompt, and nothing else. The earlier conversation is not replayed, so a thin summary means real lost context. The reset waits if the incoming turn is carrying tool results for the running process.

Without it, the appended system prompt tells the model that `compress` is unavailable and to ignore instructions that ask for it, which is the right answer when nothing implements it.

The round trip is verified live (Claude Code 2.1.263, opencode 1.18.31, haiku): the model called `mcp__opencode_proxy__compress` with a build identifier in its summary, the plugin logged `compress stored summary; session resets next turn`, the next turn logged `compress reset: dropped claude process and session id` and spawned a second `claude`, and that fresh process answered with the identifier it could only have read from the summary in its system prompt.

Only those seven values are actually proxied; anything else you put in `proxyTools` is ignored. Proxying `Edit` also disables `MultiEdit` — opencode has no batched-edit equivalent, so Claude is forced to fan out into single `Edit` calls that each flow through the permission UI. The `"Question"` proxy is version-gated on opencode's built-in `question` tool: on builds that lack the registry entry the def is silently dropped (a forwarded call would otherwise render as `⚙ invalid`), so add it only on opencode versions that ship the `question` tool.

Without `"Task"` in `proxyTools`, Claude's built-in `Agent` tool stays enabled and Claude orchestrates subagents internally with no opencode child-session visibility. To opt out of all proxying, including Task, use an explicit empty list:

```json
"options": { "proxyTools": [] }
```

### Forwarding opencode's own tools

`proxyTools` names the tools this plugin ships defs for, and MCP-backed opencode tools can be routed with [`proxyOpencodeMcpTools`](#options-reference). Neither covers a tool that **another opencode plugin declares directly**: it belongs to no MCP server, so the automatic match (`<server>` or `<server>_<tool>`) skips it and the model is never offered it. opencode-dcp's `compress` is the case that matters in practice, because DCP then injects "MAX CONTEXT LIMIT REACHED ... You MUST use the `compress` tool now" reminders that the model has no way to act on.

`proxyOpencodeTools` is the explicit allowlist. Empty by default:

```json
"options": {
  "proxyTools": ["Bash", "Edit", "Write", "WebFetch", "Task"],
  "proxyOpencodeTools": ["compress"]
}
```

Names are opencode's tool ids as `client.tool.list()` reports them, matched case-insensitively. An unknown name is skipped with a warning rather than failing the spawn. Forwarded tools use the same broker as every other proxy tool, so [how a proxied call ends](#how-a-proxied-call-ends) applies to them unchanged: abort, orphan sweep, session deletion and child exit all release them.

This is deliberately not automatic. A forwarded tool executes inside opencode with the calling agent's permissions, so which ones cross over is your decision, not the plugin's.

**The `compress` name collision.** Two different tools want it: DCP's, which rewrites opencode's transcript, and [this plugin's](#context-compression), which resets the Claude Code session. They compress different windows, and after a DCP compress the live `claude` process still holds its full context until something restarts it. If you enable both, the plugin's own tool keeps the name and the forwarded one is dropped with a warning in the log:

```
WARN: proxyOpencodeTools entry dropped: a proxy tool already holds that name, and it keeps it {"collided":["compress"]}
```

Pick one. The appended system prompt describes whichever is actually reachable, so the model is told the right semantics either way.

Verified live on Claude Code 2.1.263 and opencode 1.18.31 with DCP loaded: the plugin logged `forwarding opencode tools through the proxy {"tools":["compress"]}`, started the proxy with `tools: ["bash","compress"]`, received `proxy-mcp tool call received {"toolName":"compress"}`, queued it through the normal broker, and DCP really ran, returning `Compressed 3 messages into [Compressed conversation section]`. One wrinkle worth knowing: DCP's compress rewrites opencode's message history mid-turn, which makes opencode abort the provider stream at that tool boundary. The pending call is released normally and the result still reaches the model on the next step as text, so the turn completes, but you will see one `abort between proxy tool boundaries` line in the log each time.

### Trimming unsatisfiable context reminders

DCP anchors its nudges into message text as `<dcp-system-reminder>` blocks, so each one is re-sent with every message that carries it. If no `compress` tool is reachable they are an order the model cannot follow, and the plugin already tells it to ignore them. `stripContextReminders: true` stops paying for them too:

```json
"options": { "stripContextReminders": true }
```

Off by default. It removes those blocks from user and assistant text before the transcript reaches the CLI, including the fresh-session rebuild, where every anchored reminder would otherwise replay at once. It leaves opencode's own `<system-reminder>` blocks alone: those are opencode's instructions to the model, not an unsatisfiable order.

It switches itself off whenever `compress` is named in `proxyTools` or `proxyOpencodeTools`, since the reminder is then something the model can act on. The check is on configuration, so a name that is configured but missing from opencode's registry still counts as reachable and nothing is stripped, which errs toward keeping the reminder.

### Subagent todos

When Claude works through a multi-step task it emits `TaskCreate` / `TaskUpdate` calls. The plugin translates those into opencode's full-list `todowrite` so the todo panel populates. Inside a **subagent** that translation is blocked unless you say otherwise: opencode's task tool injects `todowrite: false` into the tools dict for any subagent without an explicit rule, so the plugin's synthetic emissions surface as `⚙ invalid todowrite` rows instead of todos. The built-in `general` subagent denies it by default.

Grant it per subagent definition in `opencode.json`:

```json
{
  "agent": {
    "multistep": {
      "description": "Multi-step worker whose progress should be visible as todos",
      "mode": "subagent",
      "model": "claude-code-default/claude-opus-5",
      "permission": {
        "todowrite": "allow",
        "todoread": "allow",
        "task": "deny"
      }
    }
  }
}
```

Notes on that example:

- `todowrite: "allow"` is the load-bearing line. Without it you get `⚙ invalid` rows, not a broken run.
- `todoread` is worth allowing too so the subagent can re-read its own list across turns.
- `task: "deny"` is explicit rather than implied. Leave it denied unless this subagent should itself delegate, in which case set `"allow"` and raise the top-level `subagent_depth` (opencode defaults it to `1`, so a child cannot spawn a grandchild).
- Provider and agent config are read at startup, so restart opencode fully after editing.

The todos render in the **subagent's own session view**, not the parent's panel. Navigate to it in the TUI with `session.child.next` (and back with `session.parent`); run `opencode --print-logs` or check the keybindings if those actions are unbound in your setup.

To confirm the data actually landed rather than trusting the UI:

```bash
sqlite3 ~/.local/share/opencode/opencode.db \
  "select id, parent_id from session order by rowid desc limit 5;"
# then, with the child session id:
sqlite3 ~/.local/share/opencode/opencode.db \
  "select tool, state from part where session_id='<child-id>' and tool='todowrite';"
```

### What you get with proxying on

- opencode's **permission prompts** for every Bash/Edit/Write/WebFetch call. The default `--dangerously-skip-permissions` is still passed to `claude`, but it only governs Claude's own built-in tools; a proxied call is executed by opencode and answers to opencode's rules instead. Built-ins that are neither proxied nor listed in `extraDisallowedTools` do run under that flag.
- opencode's **audit log** captures the calls.
- Per-tool **policy rules** in opencode apply.

### What you give up

- A small per-call latency hop through `127.0.0.1:<random>/mcp`.
- Batched-edit ergonomics: with `Edit` proxied, Claude can no longer use `MultiEdit`, so a refactor that would have been one tool call becomes N single `Edit` calls.

### How a proxied call ends

A proxied call ends when something happens to it, not when a clock runs out. The plugin holds the CLI's request open and listens to the process, the stream and the protocol for the events that actually decide the call's fate; each one releases the call on the spot, and tells the CLI where there is still a CLI to tell:

| What happens | What the plugin does |
|---|---|
| opencode returns the tool's result | resolves the call; the CLI gets the result and carries on |
| you abort the turn (Esc / Ctrl+C) | sends the CLI an `interrupt`, which answers with its own result, and rejects every call the turn had pending, whether the abort lands before content, mid-turn, or while opencode is running the tool between two stream boundaries |
| you send the next message in that chat | rejects every call the previous turn left pending as orphaned, so the CLI gets an error result and the new turn starts clean |
| the `claude` process closes its output or exits, mid-turn or between turns | rejects its pending calls; a mid-turn death also ends the turn as a visible error |
| you delete the chat in opencode, or opencode exits | kills the worker and rejects its pending calls |
| the CLI hangs up on its own request | keeps the call so a late result can still be delivered as a plain-text continuation (see below) |

Because every ending is observed rather than inferred from elapsed time, a `task` can run until it is finished: **`task` and `task_batch` have no deadline by default**. Earlier flat ceilings fired mid-subagent, Claude believed its dispatch had failed, and the eventual result was dropped because the parent turn had already ended on the timeout error; a 60-minute one did the same to anything longer. What the default gives up is only that nothing fires on the clock alone, so a chat parked in a `task` holds its `claude` worker until one of the events above happens. That is the operator's decision to make, so no timer makes it for them.

So that a call with no deadline is never silent, the plugin says it is still waiting. Five minutes in, and every five minutes after, a call without a deadline logs a warning naming the tool, the call id, how long it has waited, and what will end it. It never ends the call, it only reports one, which is the whole point: the thing a deadline used to provide was visibility, not correctness, and visibility is what is kept. Calls that do have a deadline get one notice rather than a heartbeat, at 60% of the way to it, saying how long is left and which option would extend it. Before this, a deadline reported a call only by killing it: the first thing you heard was the failure, which is no use while there is still time to react. It is one line, never repeated, because the deadline itself is the next thing that will speak, and deadlines under a minute are skipped entirely since the notice and the rejection would arrive together. The line reaches your terminal (warnings always go to stderr), so a subagent that has genuinely wedged shows up on its own instead of waiting to be noticed. `/claude-code-doctor` lists the same calls on demand.

The same events are also what let a legitimately long call complete, which is the second half of the story: the CLI's own HTTP client used to give up on a silent reply at about five minutes whatever the tool deadline said. Every held call therefore keeps its connection visibly alive. A client that advertises SSE gets immediate headers and a keepalive comment every 15 seconds (since 0.15.0); a client that only accepts JSON gets its headers immediately as well, as a chunked body carrying keepalive whitespace on the same cadence, which is still one valid JSON-RPC response when the result lands, on success and on error. Keepalives are about the connection, not the tool: they never extend or replace a deadline. Claude's MCP client timeout for the proxy server, written into the generated `--mcp-config`, is set to the largest effective deadline, and to the largest value the CLI accepts (Node's timer maximum, about 24.8 days) while any tool has no deadline, because the CLI rejects a `timeout` of `0` outright.

### Per-tool proxy timeouts

Deadlines still exist, as an explicit backstop rather than the mechanism that decides when a call is over. If a tool with one has not been resolved within that many milliseconds, the call is rejected and Claude receives a timeout error. Resolved per tool, most-specific layer winning:

1. flat default — 10 min (matches Claude CLI's own Bash ceiling)
2. per-tool default: **`task` / `task_batch`: none**, **`question`: 30 min**, everything else: 10 min
3. your `proxyToolTimeoutMs` override (case-insensitive key; a positive value replaces the default, `0` removes the deadline, anything else is ignored)
4. for `bash` only, the call's own `input.timeout`: the proxy never undercuts a build the caller explicitly asked to run long (`max(resolved, input.timeout)`), and a positive `input.timeout` restores a deadline that `bash: 0` removed

`question` keeps 30 minutes because it blocks on a human reading a form, and a form nobody answers is not an event. A positive `task` override restores a wall-clock backstop for operators who want one; if it fires, the error tells Claude not to "schedule a wake-up": that is a Claude Code affordance which cannot fire in this headless/proxy context, so deferring silently loses the work.

Two watchdogs are a different thing again and are unchanged: the start watchdog (90 s of complete silence after a turn is written, respawn then error, see `CLAUDE_CODE_START_WATCHDOG_MS`) and the wire-inactivity watchdog (60 s of silence after content, see `CLAUDE_CODE_RESULT_FALLBACK_MS`; when it fires the reply gets a `▌ **stream timeout:**` note so the turn does not just stop). Those exist because a process that is alive but wedged emits no event to listen to, and a proxy call is never what they are waiting on: a CLI parked inside a proxied tool is producing nothing on purpose, and both watchdogs know that.

If Claude nevertheless abandons the HTTP call, the plugin preserves narration emitted while opencode was running the tool, renders it on return, and delivers the late completion as a plain-text continuation naming the original call. It tells Claude not to run the tool again. A silent post-tool continuation gets one resumed-process retry, preserving the original model, account, effort, and proxy configuration; a second failure ends with an error rather than an indefinite hang. Buffered narration is capped at 500 lines and 2 MiB, with a warning if output was dropped.

```json
"options": {
  "proxyTools": ["Bash", "Edit", "Write", "WebFetch", "Task"],
  "proxyToolTimeoutMs": { "Task": 5400000, "bash": 1800000 }
}
```

---

## Side questions with /btw

After a normal Claude Code turn, at any time, including while Claude is still working:

```text
/btw Why did you choose that approach?
```

The plugin registers the command without replacing an existing user-defined `btw` command. The question goes to Claude Code's native `side_question` control protocol on the conversation's live process, using the same model, account, and context. Claude Code answers it on a separate call, concurrently with whatever the main turn is doing. Claude never sees the aside afterwards: the question never enters Claude Code's own transcript, and the plugin keeps every `/btw` exchange out of the prompt it sends the model.

Where the answer appears, in the conversation either way:

- **A receipt, straight away**, when you asked while a turn was running, in the reply you are watching, so a `/btw` typed mid-turn is visibly taken rather than looking swallowed until the answer arrives:

  ```text
  ▌ **btw:** <your question, in full>
  ▌ *sent to Claude on the side*
  ```

  It quotes the question back untruncated because the prompt box clears on submit and no `/btw` message is ever created, so this is the only place you can read back what you sent. If opencode is between two streams at that moment (it was running a tool), the receipt lands when the next one opens.
- **Inside the running turn's own reply**, as soon as the answer arrives, when you asked while Claude was working. It is written into the reply you are already watching as its own block, headed `▌ **btw:** <your question>`, so it stays there and is easy to pick out. Every line of the aside, answer included, carries that `▌` bar, so it reads as one block down its whole height. Nothing is queued and the `/btw` message itself is dropped, because the answer is already in the transcript. The turn goes on to deliver its own reply as usual.
- **As its own `/btw` message and answer** when the conversation is idle, or when the turn had no stream open to write into at that moment (opencode was running a tool between two of them). In the second case the pair lands when the turn ends; nothing is announced in the meantime, because the answer itself is what arrives.
- Follow-ups work: earlier asides in the conversation are sent along as the aside's history.

Notes:

- Requires Claude Code CLI **2.1.258 or newer**, the oldest verified version.
- Requires a live **headless** process for the conversation. Send a normal message with a Claude Code model first if the process has not started or was evicted; the answer in the transcript tells you when that is the case. Interactive transport is not supported.
- Asking immediately after starting a turn is fine. The conversation's process only exists once that turn reaches the model, so `/btw` waits for it (up to 30 seconds) instead of falling back to being queued. If no Claude Code process turns up in that window, because the running turn belongs to another provider, the question is answered when the turn ends.
- One aside per conversation at a time. A second `/btw` while one is in flight is asked once the turn ends.
- An aside costs nothing in opencode's counters: a `/btw` pair reports 0 tokens and $0, and a block written into a running turn adds nothing to that turn's usage. The control response has no usage fields, so aside usage is not counted anywhere; this does not mean the request is free.
- An aside written into a turn is marked, and the plugin strips it again if the conversation ever has to be replayed into a fresh Claude Code process. It was never Claude's own output.
- A request times out after two minutes. Abort and timeout cancel that side request without killing the main session. If the running turn is still not over after 30 minutes, the plugin gives up on that `/btw`; ask again once the turn ends.
- The answer is never delivered as a notification: it always lands in the conversation, where it stays. The only two toasts left are the cases where nothing reaches the conversation at all, a bare `/btw` (which shows the usage text) and a turn that ran past the 30 minute wait.

Fully restart opencode after upgrading to load the command and runtime changes. Other providers do not gain Claude's native side-question behavior from this command.

## Plugin health with /claude-code-doctor

```text
/claude-code-doctor
```

Prints, in the chat, what the plugin currently thinks is happening. The plugin answers it itself: no model is called, nothing is billed, and the reply reports 0 tokens. It is the thing to paste into a bug report.

It carries the startup-diagnostics fields (plugin version, opencode version, `claude` path and version, the working directory and which resolution tier picked it, providers, accounts, `proxyTools`, the on-disk MCP servers, transport, whether an `ANTHROPIC_API_KEY` is present) plus the live runtime state the startup block cannot know:

- every live `claude` child, by opencode session id and model, with its pid, whether a turn is in flight, how long it has been up, and the effort it was spawned at,
- every pending proxy call, with the tool, the call id, how long it has waited, and its deadline,
- each proxy server's URL with one unauthenticated `initialize` posted to it: `401, good` is the patched behaviour, and anything else is flagged unsafe with the fix (restart every opencode window, since a window opened before 0.13.2 keeps serving an open port). See [Proxy endpoint security](#proxy-endpoint-security).

Nothing secret goes in it: not the proxy bearer token, not the value of `ANTHROPIC_API_KEY`, not the system prompt, not a pending call's arguments. A `claude-code-doctor` command you defined yourself is never overwritten. The name has no space in it because opencode reads everything after the first space as the command's arguments. The whole exchange is kept out of any transcript replayed to the CLI, like a `/btw` pair.

## Per-turn stats

Off by default. With `turnStats: true`:

```text
▌ **stats:** $0.0123 · 4.2 s · 2 CLI turns · in 1.2k · out 812 · cache read 45.1k · cache write 2.0k
```

One line at the end of a finished turn, from the numbers the CLI already reports on its `result`. Notes:

- Never on a `/compact` turn (the footer would be appended to what opencode stores as the summary) and never on a turn that ended in error, where the error is the thing to read.
- It is its own text part led by `▌ **stats:**`, and the plugin strips it again if the conversation is ever replayed into a fresh Claude Code process. The model never reads its own accounting.
- Token counts are the turn's totals, which is what matches the cost. They are deliberately not the same numbers opencode's context gauge shows, which use the last tool-use iteration so the window is not inflated.
- The cost is what the CLI reported for the turn, not a billing guarantee.

The same numbers are logged at INFO whatever this option is set to, and `total_cost_usd`, `duration_ms`, `duration_api_ms`, `num_turns`, `usage`, `modelUsage` and `permission_denials` always reach `providerMetadata` (denials by tool name and id only, never their inputs).

## Things the CLI says that are no longer silent

Four Claude Code stream events used to reach nothing but a debug log:

- **A rate-limit rejection.** When the CLI reports `status: "rejected"` (or a rejected extra-usage state), the turn now carries a `▌ **rate limit:**` line naming the window, the reason extra usage is unavailable, when it resets, and the four things that can be done about it. Warned once per identity per process. See [Billing](#billing-change-june-15-2026-agent-sdk-credit).
- **A context compaction Claude Code did on its own.** A `▌ **context compacted:**` note says so, with the before and after token counts, so an answer that suddenly forgets the start of the conversation has a visible cause.
- **A `result` whose subtype is not `success`** (`error_max_turns`, `error_during_execution`, …). The subtype is named in the transcript and the turn finishes as an error instead of an ordinary reply.
- **A CLI-executed tool that failed.** Its result is forwarded with the AI SDK's error flag, so opencode renders the row as failed rather than as a success whose output happens to be an error message.

At session start the plugin also warns once per process for each MCP server Claude Code could not connect (its tools are simply absent otherwise) and once when the CLI's own `apiKeySource` says an API key is in effect, which is the field that tells you pay-as-you-go billing is happening. See [`ignoreAnthropicApiKey`](#options-reference).

## Configuration skill

The package includes a `claude-code-plugin` skill so your agent can configure it without asking you to navigate all its options. Ask, for example:

```text
Use the claude-code-plugin skill to configure a work account and idle worker cleanup.
```

It covers accounts, models and agent effort, proxy tools, permissions, MCP/skill bridging, timeouts, logging, upgrades and troubleshooting. It directs the agent to preserve JSONC comments, change only requested settings, validate the result, protect credentials and ask before paid probes or broader permissions.

The plugin registers the bundled directory with opencode's `skills.paths`, making it available to other providers too on supporting opencode versions. For Claude turns it also loads through Claude's native Skill tool as `opencode-skills:claude-code-plugin`, even when `bridgeOpencodeSkills` is `false`. This requires CLI `--plugin-dir` support and applies to the headless, interactive and direct `doGenerate` spawns; compaction never loads the native bridge.

No separate skill installation or copying is needed. It ships with each package version, so upgrading updates the reference. Fully restart opencode to load it. `test-configure-skill.ts` checks coverage of provider/logging options, model ids, proxy tools and environment variables; maintainers must update behavior and default guidance in the same change as the implementation.

## Skill bridge

opencode and Claude Code use the same on-disk skill format, a `<name>/SKILL.md` whose frontmatter carries `name` and `description`, but they read from different directories. opencode looks in `.opencode/skills/` and `~/.config/opencode/skills/`; the Claude CLI looks in `~/.claude/skills/` and its own plugins. So opencode advertises your skills in the system prompt it forwards, the model calls `Skill("browser-automation")`, and Claude answers `Unknown skill`.

By default the plugin discovers your opencode skills, stages a throwaway Claude Code plugin directory that links them, and passes it as `claude --plugin-dir`. They register natively, prefixed with the plugin name:

```text
opencode-skills:browser-automation
opencode-skills:rtk
```

Claude can invoke them with the Skill tool or as `/opencode-skills:<name>`. `--plugin-dir` is scoped to the spawned session, so nothing is written into your `~/.claude`.

Discovery order, first match wins: `.opencode/skills/` walking up from the working directory, then `~/.opencode/skills/`, then `$OPENCODE_CONFIG_DIR/skills/`, then `~/.config/opencode/skills/`. A project skill shadows a global one of the same name. If the skill set is unchanged the staged directory is reused between spawns.

The bridge is **off by default**: every bridged skill's name and description is also in the system prompt opencode already forwards, so a large skill set is paid for twice on every turn. Set `bridgeOpencodeSkills: true` when the model tries `Skill("<name>")` for a skill opencode advertises and gets `Unknown skill`; the bundled configuration skill is staged either way. When on, the bridge applies to the headless, interactive and direct `doGenerate` spawns alike, never to compaction, and it is skipped on a Claude CLI without `--plugin-dir` (the plugin probes `claude --help` and logs a notice).

This bridge was written by [@broskees](https://github.com/broskees) (Joseph Roberts) on his fork and absorbed here with credit; see [Credits](#credits).

## WebSearch routing

Claude Code ships a built-in `WebSearch` tool. The `webSearch` option controls who actually executes those calls:

| `webSearch` value | Behavior | When to use |
|---|---|---|
| `"claude"` (default) | Claude CLI runs WebSearch internally via Anthropic. Zero setup, no extra cost, no API key. The query is shown in the transcript as a `> Web search:` line (opencode has no `WebSearch` tool registry entry, so a raw tool row would render as `⚙ invalid`). | Most users. |
| `"<opencode-tool-name>"` (e.g. `"websearch_web_search_exa"`) | Forward to that opencode-side tool with `executed:false`. Requires the corresponding MCP server to be configured in opencode (e.g. [exa-mcp-server](https://github.com/exa-labs/exa-mcp-server)). | You want a specific search backend (Exa, Tavily, Brave) and have the MCP wired up in opencode. |
| `"disabled"` | `WebSearch` is added to `--disallowedTools` so the model can't call it. | Compliance/security scenarios where outbound search isn't allowed. |

```json
"options": { "webSearch": "websearch_web_search_exa" }
```

**Trade-offs**

- Claude-side execution: free with your Claude usage, no API key, but no opencode visibility into queries/results, no caching/rate-limit hooks.
- opencode-side execution: choose any backend, queries flow through opencode's audit/policy/cache, but costs money (search APIs are paid) and adds a network hop.
- Some Claude-specific tool features stay on the built-in side (notably `MultiEdit` — see the note above).

---

## MCP bridge

If `bridgeOpencodeMcp` is true (the default), the plugin reads your opencode config's `mcp` block, translates it into Claude's MCP schema, writes it to a temp file, and passes that to `claude --mcp-config`. So whatever MCP servers you've already configured in opencode become available to Claude with no extra setup.

### Discovery order (highest to lowest priority)

1. `OPENCODE_CONFIG` env var (file path)
2. `OPENCODE_CONFIG_DIR` env var
3. Walk up from the current `cwd` looking for `opencode.jsonc`, `opencode.json`, `config.json`, or a `.opencode/` directory
4. Global `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`

Later sources override earlier ones **by server name**, so a project-level MCP server replaces a global one with the same id.

### Translation

| opencode `type` | Claude `type` |
|---|---|
| `local` | `stdio` |
| `remote` | `http` |

If you want to manage MCP servers only via `~/.claude/settings.json`, set `bridgeOpencodeMcp: false`.

To replace (rather than augment) bridged MCP with your own:

```json
"options": {
  "bridgeOpencodeMcp": false,
  "mcpConfig": "/path/to/your/mcp.json",
  "strictMcpConfig": true
}
```

---

## Sessions

Each chat keeps a long-lived `claude` subprocess so the model retains its native context across turns.

- **Session key**: `(cwd, model, tool-scope, opencode-session-id)`. The opencode session id comes from the `x-session-affinity` header opencode sets on third-party provider calls. Two chats in the same project on the same model run in **separate** CLI processes — they don't race. In account mode, model IDs are suffixed per account, so account sessions do not collide.
- **Same chat, multiple turns** → process reused, full Claude context retained.
- **New chat** → fresh process under the new session key.
- **Resumed chat after restart** → in-memory state is gone; a new process spawns and the conversation history is summarized and prepended.
- **Abort (Esc / Ctrl+C)** → the plugin sends the Claude CLI a stream-json `interrupt` control request, so the CLI actually stops generating and running tools instead of finishing the abandoned turn on your bill. The process stays alive for the next message in that chat, and any proxied call the aborted turn left behind is released when that message arrives (see [How a proxied call ends](#how-a-proxied-call-ends)). If a turn is somehow still running when the next one starts, it is interrupted first (5 s cap). Contributed by [@broskees](https://github.com/broskees).
- **Idle timeout** → when `idleProcessTimeoutMs` is set, a completed headless turn arms an eviction timer (unset or `0` keeps workers until LRU eviction). Reuse cancels it, a worker found mid-turn when it fires is left alone and re-timed, and eviction preserves the session id, so the next message resumes the same conversation with `--resume`. An idle `claude --print` holds around 250 MB, which is the reason to set it if you keep many chats open.
- **Cap**: 16 active processes, LRU eviction. A process that is mid-turn is never the victim: eviction takes the oldest **idle** one, and when every process is busy it evicts nothing and warns instead, so a running answer is never truncated to make room.
- **Deleted chat** → deleting a session in opencode kills its `claude` workers at once and forgets their session ids and per-chat state; there is nothing left to resume. Other chats, and the shared fallback bucket used when no session id is known, are untouched.
- **opencode exits** → every retained worker is killed on the way out, so a hard shutdown does not leave `claude` processes reparented to init.
- **Crash** → if the CLI dies mid-turn (no terminal `result` line), the turn ends with a visible error naming the exit code or signal and the last stderr the CLI wrote, not a silent `stop` that reads as a short but finished answer. An abort you asked for is not reported this way.

---

## Plan mode

Set `permissionMode: "plan"` to forward `--permission-mode plan` to Claude. The plugin handles `ExitPlanMode` specially — instead of forwarding it as a tool call, it converts it to a confirmation prompt that flows through opencode normally.

> **Plan mode never permits edits, and you do not have to configure anything for that.** The CLI lets `--dangerously-skip-permissions` override `--permission-mode plan` outright, and `skipPermissions` defaults to `true`, so until this was fixed anyone asking for plan mode silently got full write access (measured on CLI 2.1.258: the run wrote a file on request without a prompt). The plugin now drops the skip flag whenever `permissionMode` is `"plan"`; every other mode governs prompting, which is what that flag is for, so those still pass it.
>
> Two things to know. Nothing releases plan mode mid-session: headless Claude Code is not offered an `ExitPlanMode` tool, so approving a plan in chat does not unlock writes, and leaving plan mode means changing the config and restarting opencode. The plugin warns about this once at startup. And the CLI still writes its own plan document under `~/.claude*/plans/`, which is its own feature and outside your workspace; your files and commands are untouched.

By default that prompt is text: the plan is rendered as markdown, followed by `**Do you want to proceed with this plan?** (yes/no)`, and you answer in your next message.

### Approval as a real form (`planModeQuestion`, opt-in)

Set `planModeQuestion: true` to route the approval through opencode's native `question` tool instead:

```json
"options": {
  "permissionMode": "plan",
  "planModeQuestion": true
}
```

The plan is still rendered, but the turn then ends on `tool-calls` and opencode runs its own `question` tool, so approval is a form rather than prose. Your answer is fed back to the CLI as the `tool_result` for the original `ExitPlanMode` call, which is what actually unlocks plan mode on the Claude side. A "yes" typed as ordinary text never does that. Anything other than picking `yes` (including custom text) comes back as rejection feedback the model is told to act on.

> **This cannot currently fire on the default headless transport, so leaving it off costs you nothing.** The form it delivers through works (see [AskUserQuestion](#askuserquestion)), but headless `--print` does not offer the model an `ExitPlanMode` tool at all on CLI 2.1.258, and the bridge keys on that tool call. Measured three ways: asked directly for its tool list in plan mode, the CLI returned `Agent, Bash, Edit, ListAgents, Read, ReportFindings, ScheduleWakeup, Skill, ToolSearch, Workflow, Write` and nothing else; asked to do work it said "I'm unable to exit plan mode from within the tool set available to me"; and a full probe through this plugin with `planModeQuestion: true` produced no `ExitPlanMode` anywhere in `plugin.log` while the model asked for approval in prose. The name is still known to the CLI (`--disallowedTools ExitPlanMode` validates silently, where a bogus name warns), so this reads as headless dormancy rather than removal, the same shape as the [`AskUserQuestion` fallback](#askuserquestion). The text path below is what you actually get, and it works. Re-run those probes on a newer CLI before assuming the bridge is reachable. On opencode builds with no `question` registry entry the plugin silently keeps the text path (look for `plan-mode question gate` in the log).

Approval bridge contributed by [@CollieIsCute](https://github.com/CollieIsCute).

---

## AskUserQuestion

opencode ships a built-in `question` tool (`packages/opencode/src/tool/question.ts`) that renders a real TUI form with options and a custom-answer field — near-identical to Claude Code's `AskUserQuestion` (`multiSelect` → `multiple`). The plugin can route `AskUserQuestion` through it so the prompt becomes an actual form instead of plain text. Two modes:

### With `"Question"` in `proxyTools` (opt-in)

> **Correction, September 6, 2026: this is no longer blocked, and earlier releases of this README were wrong about why.** The missing form was attributed to an upstream TUI regression. The real cause was local: a notification plugin awaited macOS `alerter` dismissal inside `tool.execute.before`, so the question tool never started. Native providers load that same global plugin, which is why their identical failure did not isolate the TUI. With the hook made non-blocking, the form renders, and the full path through this plugin is verified: on plugin 0.18.0 / Claude Code 2.1.258 / opencode 1.18.29, Claude called `mcp__opencode_proxy__question`, the request appeared in `GET /question`, the reply completed the tool, and Claude's answer contained a token it could only have read from the tool result. Confirmed in a real terminal too: with `"Question"` enabled and opencode relaunched, the proxied call rendered as a TUI form and the clicked answers came back into the turn.
>
> `"Question"` is still opt-in, because turning it on disables Claude's own `AskUserQuestion` (see the fallback below) and that trade should be deliberate. If your form does not render, see [question troubleshooting](#question-troubleshooting) before assuming an upstream bug.

#### Question troubleshooting

For a stalled call, inspect `GET /question` on the same opencode server and workspace. If no request exists, check awaited `tool.execute.before` hooks and custom tools replacing `question`, especially notification plugins: a hook opencode waits on runs *before* the tool, so the request cannot exist yet. If a request exists but no form appears, check session ownership, pending permissions, and event delivery. The separate detach/reattach issue [anomalyco/opencode#36604](https://github.com/anomalyco/opencode/issues/36604) remains open; [PR #36603](https://github.com/anomalyco/opencode/pull/36603) is closed without merging. Do not infer a universal platform or version failure from either symptom.

Add `"Question"` to `proxyTools`. Claude's built-in `AskUserQuestion` is disabled via `--disallowedTools`, and the plugin exposes `mcp__opencode_proxy__question` in its place. A primary agent needs no permission entry (verified on opencode 1.18.29 with no `permission` block at all); if a subagent's form is refused, grant it `permission.question: "allow"` on that agent, the same way [subagent todos](#subagent-todos) need `todowrite`. The model calls the proxy, opencode renders the form, and the operator's answers come back as arrays of selected labels. On builds that lack the `question` registry entry the def is silently dropped at spawn (version gate), and the deny/markdown fallback below applies instead.

`proxyTools` replaces the default list rather than adding to it, so repeat the defaults you still want:

```json
"options": {
  "proxyTools": ["Bash", "Edit", "Write", "WebFetch", "Task", "Question"]
}
```

To turn it back off, drop `"Question"` from the list. It is **not** in the default list, so no configuration means the deny/markdown fallback below stays in force.

The same spawn-time caveat as `"Task"` applies: provider options are read once at opencode startup, so restart opencode fully after adding it. Question calls get a 30-minute proxy deadline (raise it with `proxyToolTimeoutMs` if you expect to be AFK longer; an expired call comes back as an error, not an answer).

### Without the proxy (default fallback)

When `"Question"` is not in `proxyTools` (or the opencode version lacks the `question` tool), the plugin handles `AskUserQuestion` as follows:

1. **It renders the full question.** The tool's payload — every question, header, option label, and option description — is emitted as readable markdown into the assistant stream so the user actually sees the choices (same approach as `ExitPlanMode`).
2. **It is never auto-allowed at the CLI gate.** Allowing it would let the headless Claude CLI resolve its own question (no TTY → fabricated/empty answer) and proceed on a guess. `controlRequestBehaviorForTool` hard-denies `AskUserQuestion` and returns a message telling the model to **stop and wait for the operator's answer** — end the turn, call no further tools, and never self-answer. (Before v0.7.0 this message also offered an "if the run is non-interactive, proceed with a reasonable guess" fallback. The model could not reliably tell interactive opencode from a headless run and routinely took it, so questions appeared to be skipped — [issue #8](https://github.com/khalilgharbaoui/opencode-claude-code-plugin/issues/8). For genuinely unattended runs, use the `controlRequestToolBehaviors` override below instead.)

This hard-deny sits **below** `controlRequestToolBehaviors` in precedence but **above** the global `controlRequestBehavior`. So:

- The global `controlRequestBehavior: "allow"` does **not** override it (interactive setups stay correct by default).
- An explicit per-tool entry **does**. For a fully unattended/automated deployment that prefers "guess and continue" over "stop and wait", restore the old auto-allow:

  ```json
  "provider": {
    "claude-code": {
      "options": {
        "controlRequestToolBehaviors": { "AskUserQuestion": "allow" }
      }
    }
  }
  ```

  With `"allow"`, the Claude CLI answers its own `AskUserQuestion` internally and the run never blocks — appropriate only when no operator is watching and forward progress matters more than a correct decision.

---

## Compaction

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

---

## Extended thinking

The plugin forwards Claude's thinking blocks (`thinking_delta` stream events) to opencode as reasoning parts, so the "Thinking" row in the chat panel shows whenever the model uses extended thinking. This works across every Claude 4 family model the CLI supports.

What you see is a **summary** of the model's thinking, not the raw chain-of-thought. Anthropic [stopped exposing raw thinking on the Claude 4 family](https://platform.claude.com/docs/en/build-with-claude/extended-thinking#summarized-thinking) and ships a server-generated digest instead. For Claude Opus 4.7 specifically, [thinking content is omitted from responses by default](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7#thinking-content-omitted-by-default); the plugin opts back in by passing `--thinking-display summarized` on every spawn. Claude Code CLI 2.1.142+ is required for that flag to take effect; older CLIs skip it silently.

### Reasoning effort

Each model exposes five picker variants, `low` / `medium` / `high` / `xhigh` / `max`. An agent's own `reasoningEffort` frontmatter accepts six values: those five plus `minimal`, which maps to the CLI's `low`. The plugin hands the level to the CLI as `CLAUDE_CODE_EFFORT_LEVEL` at spawn, which Claude Code treats as the session-wide override: it beats the `effortLevel` in that account's `settings.json` and a shell export of the same variable. Effort is fixed for the life of a `claude` process, so it is part of the session key. Changing effort retires the previous effort's process and remembered transcript ID before replaying the conversation into a fresh process. Switching back cannot resume stale context; same-effort streaming turns still reuse their process. This reset is scoped to the same directory, model, provider/account, agent, and conversation. If the previous effort still has pending work (including tool results, plan approval, recovery, or `/btw`), the switch is rejected: finish that work at its original effort first. Title, compaction, and `/btw` calls do not trigger effort resets.

Earlier versions injected a thinking keyword such as `(ultrathink)` into the user message instead. Claude Code stopped recognising every keyword except `ultrathink`, so that path is gone and nothing is appended to your messages any more. Compaction skips request and agent effort overrides, but still inherits a shell-level `CLAUDE_CODE_EFFORT_LEVEL` when set.

### Env-var overrides

The plugin respects the standard Claude Code thinking env vars. If you set them in your shell, they pass through to the spawned process untouched, with the one exception in the first row.

| Env var | Effect |
|---|---|
| `CLAUDE_CODE_EFFORT_LEVEL=<level>` | Session effort override. Passes through when no effort was requested; a variant or an agent's `reasoningEffort` replaces it for that spawn. |
| `CLAUDE_CODE_DISABLE_THINKING=1` | Disable thinking entirely. |
| `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` | Disable adaptive thinking only. |
| `CLAUDE_CODE_SHOW_THINKING_SUMMARIES=0` | Suppress summaries (the plugin sets this to `1` by default when unset). |

---

## Quirks worth knowing

- **Empty text blocks are dropped.** Claude sometimes opens a `content_block_start` for text but never sends a delta. The plugin no longer emits the empty block (which was triggering Anthropic 400s like `cache_control cannot be set for empty text blocks`).
- **Smart incomplete-turn continuation.** By default, the plugin keeps the current opencode stream open and feeds Claude CLI a small internal continuation message when Claude emits a `result` after reasoning/tool activity without a useful visible answer. It still stops normally on final-looking answers, questions, blockers, errors, aborts, or internal safety-budget exhaustion. It also resumes an answer the model was cut off mid-sentence: a `max_tokens` stop means truncation rather than completion, so the turn continues instead of ending on half a sentence, capped at 8 attempts and 10 minutes. Every other stop reason is taken at face value. Disable with `"autoContinueIncompleteTurns": false`.
- **`AskUserQuestion`** from the CLI is converted into plain text content rather than forwarded as a tool call — unless `"Question"` is in `proxyTools`, in which case it is routed through opencode's native `question` tool (see [AskUserQuestion](#askuserquestion)).
- **Wire-inactivity watchdog.** Once the CLI has produced any content, the stream closes gracefully if stdout goes silent for 60 seconds without a `result` message arriving. Resets on every line received, so long mid-turn pauses (Sonnet between text-end and the next tool_use, for example) are tolerated. On a user-initiated abort, the watchdog shortens to 5 seconds.
- **Per-iteration usage.** When the CLI internally retries with tools, the plugin only counts the last iteration's usage so opencode's context accounting stays accurate.
- **Lazy `cwd`.** The working directory is re-resolved at every request, so opencode's project-aware behavior works without restarting the plugin.
- **Variants survive merge.** opencode recalculates variant lists after the plugin loads; the plugin re-injects defaults into runtime config so your variants don't disappear.

## Logging

Configure via `opencode.jsonc` (launch-method-independent) or env vars
(temporary override for a single process). The plugin has four orthogonal
knobs:

| Field | Values | Default | Effect |
|---|---|---|---|
| `file` | `true \| false` | `false` | Persist log entries to disk |
| `dir` | path string | `~/.local/share/opencode-claude-code/` | Custom file location |
| `mode` | `"silent" \| "debug"` | `"silent"` | TUI policy |
| `level` | `"debug" \| "info" \| "notice" \| "warn" \| "error"` | `"info"` | Minimum level to emit |

Rails-style threshold: anything below `level` is dropped before either
destination decides what to do. `mode: "silent"` routes DEBUG/INFO/NOTICE
to file only and lets WARN/ERROR bubble in the TUI (they always do).
`mode: "debug"` additionally echoes every emitted level to the TUI (which
opencode surfaces as warning bubbles).

`logging` is an ordinary provider option, so it goes under `provider.claude-code.options` like every other one. Keying it on the package name instead is the common mistake: opencode accepts that config without complaint and the plugin never reads it, so you get no log and no error.

**Recommended dev setup** — capture audit trail to disk, keep TUI quiet:

```jsonc
{
  "provider": {
    "claude-code": {
      "options": {
        "logging": { "file": true }
      }
    }
  }
}
```

The snippets below abbreviate to the `logging` value alone; each one belongs at that same path.

**Full firehose for deep debugging** (every DEBUG stream event captured):

```jsonc
"logging": { "file": true, "level": "debug" }
```

**Live TUI noise** (everything echoes to opencode's stderr → warning bubbles):

```jsonc
"logging": { "file": true, "mode": "debug" }
```

### Env-var overrides

Set explicitly to override config for one process — useful for one-off
debugging without editing `opencode.jsonc`:

```bash
OPENCODE_CLAUDE_CODE_LOG_FILE=1 opencode          # file on
OPENCODE_CLAUDE_CODE_LOG_FILE=0 opencode          # file off (overrides config:true)
OPENCODE_CLAUDE_CODE_LOG_DIR=/tmp/cc opencode     # custom dir
OPENCODE_CLAUDE_CODE_LOG_LEVEL=debug opencode     # capture every level
DEBUG=opencode-claude-code opencode               # promote to mode:"debug"
```

Boolean env vars accept `1/true/on/yes` for on and `0/false/no/off` for
off; empty / unset falls through to config. Invalid `level` values fall
through to config.

### Startup diagnostics

Once per process, right after the provider(s) register, the plugin logs a
single `NOTICE: claude-code plugin ready` line summarizing everything worth
knowing before you start debugging anything else:

```bash
OPENCODE_CLAUDE_CODE_LOG_FILE=1 opencode
grep "plugin ready" ~/.local/share/opencode-claude-code/plugin.log
```

```json
{
  "plugin": "0.11.1",
  "opencode": "1.18.5",
  "cwd": { "resolved": "/Users/you/code/app", "source": "process" },
  "providers": ["claude-code-default", "claude-code-work"],
  "accounts": ["default", "work"],
  "proxyTools": ["Bash", "Edit", "Write", "WebFetch", "Task"],
  "mcpServers": ["github", "slack"],
  "interactiveTransport": false,
  "anthropicApiKeyInEnv": false,
  "claudeCli": { "path": "claude", "version": "2.1.211 (Claude Code)" }
}
```

Reading it:

- **`cwd.source`** is which rule picked the working directory Claude will be
  spawned in: `configured` (you pinned `options.cwd`), `process` (normal),
  `captured` (`process.cwd()` was unusable and opencode's project directory
  rescued it, the macOS GUI-launch case), or `unresolved` (neither worked).
  The per-session tier that `opencode serve` uses is resolved per call and so
  cannot appear here; this line mirrors the synchronous order only.
- **`claudeCli.version`** reading `not detected` means the `claude` binary at
  that path didn't answer `--version`, which also disables version-gated
  flags like `--thinking-display`.
- **`mcpServers`** is the on-disk merge, before opencode's runtime toggles
  are applied (those aren't settled yet at startup).
- **`opencode`** is read from the running opencode binary (`--version`), since
  opencode still does not hand its version to plugins. It reads `unknown` when
  opencode is run from source rather than as the packaged binary.

This block is logged once, to a file that is off by default. For the same
fields plus live process and proxy state, without enabling logging, run
[`/claude-code-doctor`](#plugin-health-with-claude-code-doctor) in the session.

### Default behavior (no config, no env)

Nothing persists; only WARN and ERROR bubble in the TUI. The plugin
doesn't accrete a log file on every user's disk by default — opt in when
you need to inspect auto-continue decisions, broker state, or other
plugin internals.

## Compatibility with other opencode plugins

### [opencode-dcp](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) (Dynamic Context Pruning)

Partial support since v0.5.1. DCP runs in a useful degraded mode: its automatic strategies and slash commands work, while its own model-facing tools do not reach the model. Model-driven compression is still available, through this plugin's opt-in [`compress` proxy](#context-compression) rather than DCP's tool.

| DCP feature | Status | Notes |
|---|---|---|
| `experimental.chat.messages.transform` (compression placeholders, dedup, error purge) | ✅ Works | Transforms run inside opencode before reaching this plugin. |
| `experimental.chat.system.transform` (context-limit nudges, iteration reminders) | ✅ Works in headless | Headless spawns forward system-role content via `--append-system-prompt-file`. Interactive mode intentionally omits opencode's forwarded system prompt and keeps only this plugin's CLI/AGENTS/continuation prompt. |
| `/dcp compress`, `/dcp sweep`, `/dcp manual`, `/dcp context`, `/dcp stats` slash commands | ✅ Works | Handled by opencode's `command.execute.before` hook, not the model. |
| Automatic `deduplication` + `purgeErrors` strategies | ✅ Works | Message-transform only, no model tool calls. |
| DCP's own autonomous `compress` / `distill` / `prune` tool calls | ⚠️ Opt-in | DCP registers those as opencode-native tools rather than through an MCP server, so the automatic MCP routing never saw them. Name one in [`proxyOpencodeTools`](#forwarding-opencode-s-own-tools) and it is forwarded: `proxyOpencodeTools: ["compress"]` makes `mcp__opencode_proxy__compress` run DCP's real tool. |
| Model-driven compression through this plugin's `compress` proxy | ⚠️ Opt-in | Add `"Compress"` to `proxyTools` and the plugin exposes `mcp__opencode_proxy__compress`, which gives the model a working way to compress its own context. It is not DCP's tool and does not use DCP's strategies. See [Context compression](#context-compression). |
| DCP's `<dcp-system-reminder>` context-limit nudges when no compress tool is reachable | ⚠️ Opt-in strip | Those reminders are anchored into messages, so each one is re-sent with every message that carries it. If you run without either compress route, `stripContextReminders: true` removes them. It turns itself off as soon as a `compress` tool is proxied. |

So autonomous compression is available, and DCP's own implementation is now one of the options. Three routes, all opt-in:

- `proxyOpencodeTools: ["compress"]` forwards **DCP's** tool, which compresses opencode's transcript using DCP's strategies.
- `proxyTools: [..., "Compress"]` exposes **this plugin's** tool, which resets the Claude Code session and carries a summary into the fresh one.
- Neither, and trigger DCP by hand with `/dcp compress`.

The two compress different windows, so pick deliberately rather than enabling both; [Forwarding opencode's own tools](#forwarding-opencode-s-own-tools) explains what happens if you do. With neither enabled, the plugin's appended system prompt tells Claude that no such tool exists and to ignore instructions asking for it, which is the correct answer in that case.

---

## Known limitations

- Tool inputs stream as they are constructed (Anthropic's `input_json_delta` is forwarded as `tool-input-delta`), but only for tool calls opencode actually sees. Calls the plugin deliberately does not forward, meaning proxy tools, CLI-internal `WebSearch`, `AskUserQuestion`, `ExitPlanMode`, the todo-ledger `Task*` family and Claude's other internal tools, have their deltas suppressed, because a delta for a tool opencode never saw start renders as a permanently pending `⚙ unknown` row.
- Raw chain-of-thought is not available. Claude 4 family models ship summarized thinking only. See [Extended thinking](#extended-thinking) for the full picture.
- Recommended Claude Code CLI: **2.1.142+**. Older CLIs work for everything else but skip the `--thinking-display` flag, so Claude Opus 4.7 turns may render empty Thinking rows. If something breaks after a Claude Code update, the CLI version is the first thing to check.
- **Foreground Task calls have no proxy deadline by default.** The plugin listens for the events that end a call instead of timing it (see [How a proxied call ends](#how-a-proxied-call-ends)), so a subagent runs to completion and a chat parked in one holds its `claude` worker until you abort, send another message, delete the chat, or the process goes away. Such a call warns that it is still waiting after five minutes and every five minutes after, so it is never silent. Add a wall-clock backstop via [`proxyToolTimeoutMs`](#per-tool-proxy-timeouts) if you want one. For independent work that should not block the turn at all, use `background: true` after enabling opencode's experimental background-subagent flag.
- **Subagent todos require explicit permission.** See [Subagent todos](#subagent-todos) for the rule and a working config.

---

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun run test        # tsx --test (unit suite)
bun run build       # tsup -> dist/
```

Source layout:

```
src/
  index.ts                       # opencode plugin entry, config + provider hooks
  models.ts                      # default models + variants
  accounts.ts                    # multi-account expansion (per-account CLAUDE_CONFIG_DIR + wrapper script)
  claude-code-language-model.ts  # AI-SDK provider that drives `claude`
  message-builder.ts             # AI-SDK prompt → Claude CLI user message
  tool-mapping.ts                # Claude tool name ↔ opencode tool name mapping; internal-tool skip list
  proxy-mcp.ts                   # in-process MCP server for proxied tools
  proxy-broker.ts                # pending proxy-call broker between proxy-mcp and opencode tool execution
  mcp-bridge.ts                  # opencode → Claude --mcp-config translator
  session-manager.ts             # LRU cache of CLI subprocesses
  cli-version.ts                 # detect Claude CLI version, gate optional flags
  runtime-status.ts              # runtime introspection of opencode (MCP status, tool registry)
  logger.ts                      # DEBUG=opencode-claude-code stderr logger
  tmp.ts                         # per-plugin temp directory helper
  cleanup-stale.ts               # remove legacy unscoped install from opencode's plugin cache
  types.ts                       # public option types
  opencode-types.ts              # mirrored opencode types
```

For runtime gotchas, the release flow, and the compatibility audit (last taken against **opencode 1.18.29**), see [`AGENTS.md`](./AGENTS.md).

## Publishing (maintainers)

```bash
npm version patch   # or minor/major — bumps package.json + creates the tag
git push origin master --follow-tags
```

The GitHub Actions workflow at `.github/workflows/publish.yml` runs `npm publish --access public` on tag push. Since v0.6.2 it authenticates with **npm trusted publishing (OIDC)**, not a token: the job holds `id-token: write`, upgrades npm first because OIDC needs npm 11.5.1 or newer, and passes no `NODE_AUTH_TOKEN`. The trusted publisher is configured on npmjs.com against this repository and the `publish.yml` workflow filename, so a publish that fails on auth means that configuration, not an expired secret. There is no `NPM_TOKEN` in the workflow.

## Star History

<a href="https://www.star-history.com/?repos=khalilgharbaoui%2Fopencode-claude-code-plugin&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=khalilgharbaoui/opencode-claude-code-plugin&type=date&theme=dark&legend=top-left&sealed_token=XBPNnYotm7Eti4lpRGsbKl_dsq6XGUtRkvCxE4UpQH2HM4LifiiTNV1hqjCOsivRZ-e2hFDohid8iERSP5XO5JdkNhHcuS2bLZFIdQIWZO1NldJLD2TjaaSYK6GJcnXYZHivkbiiynG7b8-V8z9LLn8Uo2ED15OWnUd3devehrMyKJJO_dtOW1ivZ3yJ" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=khalilgharbaoui/opencode-claude-code-plugin&type=date&legend=top-left&sealed_token=XBPNnYotm7Eti4lpRGsbKl_dsq6XGUtRkvCxE4UpQH2HM4LifiiTNV1hqjCOsivRZ-e2hFDohid8iERSP5XO5JdkNhHcuS2bLZFIdQIWZO1NldJLD2TjaaSYK6GJcnXYZHivkbiiynG7b8-V8z9LLn8Uo2ED15OWnUd3devehrMyKJJO_dtOW1ivZ3yJ" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=khalilgharbaoui/opencode-claude-code-plugin&type=date&legend=top-left&sealed_token=XBPNnYotm7Eti4lpRGsbKl_dsq6XGUtRkvCxE4UpQH2HM4LifiiTNV1hqjCOsivRZ-e2hFDohid8iERSP5XO5JdkNhHcuS2bLZFIdQIWZO1NldJLD2TjaaSYK6GJcnXYZHivkbiiynG7b8-V8z9LLn8Uo2ED15OWnUd3devehrMyKJJO_dtOW1ivZ3yJ" />
 </picture>
</a>

## Credits

This plugin absorbs work from its forks directly, cherry-picked with the original authorship preserved or reimplemented with the author named in the commit, rather than waiting on pull requests. The people behind the features you are using:

| Who | What | Where |
|---|---|---|
| [@galvani](https://github.com/galvani) (Jan Kozak) | Per-session working directory for `opencode serve`, so one server spawns each project's `claude` in the right place. Also found the stale `toolCallMap` re-emission three months before it was fixed here. | `9e02ce4`, `2238ed0` |
| [@HeikoAtGitHub](https://github.com/HeikoAtGitHub) | Stopped sending `AGENTS.md` to the model twice (opencode already forwards it). Independently diagnosed the 5-minute proxy wall. | `25260a4`, `42f426d` |
| [@bernardofortes](https://github.com/bernardofortes) (Bernardo Fortes) | `idleProcessTimeoutMs`, idle eviction of retained `claude` workers. | `a5f723a` |
| [@broskees](https://github.com/broskees) (Joseph Roberts) | Task proxy default-on (PR #18), the abort `interrupt` so Esc really stops the CLI, the skill bridge, `task_batch` for concurrent subagents (and the measurement that the CLI serialises MCP calls), the undici 300 s diagnosis of the proxy wall, the lifecycle release of proxied calls that made the `task` deadline unnecessary (PR #36), and Claude Opus 5.5 with its fast-mode entry (PR #43). | PR #18, `68ed142`, PR #36, PR #43 |
| [@jknlsn](https://github.com/jknlsn) (Jake Nelson) | Per-tool proxy timeouts, subagent dispatch steering, the question proxy, the start watchdog respawn. | `84f3db9`, `94980a6`, `47501d0`, `ffefc24` |
| [@CollieIsCute](https://github.com/CollieIsCute) (Collie Tsai) | The plan-mode approval bridge. | `8c5b583` |
| [@flupkede](https://github.com/flupkede) | The compress proxy tool design and the AI-SDK v4 image-part fix. | `4ac319f`, `60a6e9a` |
| [@CNQQC](https://github.com/CNQQC) | Cost units corrected to dollars per million tokens (PR #25). | PR #25 |
| [@willmcginnis](https://github.com/willmcginnis) | The proxy endpoint authentication (PR #28, GHSA-3mxm-w7gf-3c5x). | PR #28 |
| [@nic-lan](https://github.com/nic-lan) | The issue #29 diagnosis of subagent output lost across the CLI resume boundary, and the fix for unattended output replaying as one text block per delta (PR #35). | #29, PR #35 |
| [@JWebCoder](https://github.com/JWebCoder) (joao moura) | Diagnosed that auto-continue never fires on current CLIs (PR #15). | PR #15 |

Commit hashes are on the contributors' forks where the work was cherry-picked; `git log --author` on this repo shows the preserved authorship.

## License

MIT. See [LICENSE](./LICENSE).

Original work © `unixfox`. Fork modifications © Khalil Gharbaoui.
