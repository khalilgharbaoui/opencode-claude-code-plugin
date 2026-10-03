---
title: 'Subagents'
description: 'Model, reasoning effort, prompt cache TTL and a fallback chain, declared on the agent rather than the caller.'
sidebar:
  order: 4
---

## Subagents: your account, their model

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

## The effort an agent runs at

The same file can state its own thinking budget:

```yaml
reasoningEffort: high
```

That beats whatever effort the call arrived with. It has to, because opencode resolves one effort for a session and a subagent inherits it, which is wrong in the expensive direction: a caller who picked `max` for their own turn otherwise hands `max` to every worker it dispatches, and a mechanical lane burns a weekly cap at the costliest setting available. Model and effort together are what a turn costs, so both belong with the agent rather than with whoever happened to dispatch it.

An agent that declares nothing keeps the inherited effort, so this changes nothing until a file asks for it. An unrecognised level is refused and the inherited one kept, since the CLI rejects a level it does not know. Compaction is exempt: its summary always gets the full budget.

## The prompt cache an agent writes

The third thing a turn costs is the prompt cache it writes, and the same file can state that too:

```yaml
cacheTtl: 5m
```

Or once, for every subagent that declares nothing, as `defaultSubagentCacheTtl` in the provider options. Values are `5m` and `1h`; anything else warns and leaves the CLI alone. It applies to headless spawns only: `/compact` and the experimental interactive transport keep the CLI's own default.

Claude Code's automatic default is a 1-hour cache on a subscription, and a 1-hour cache write is billed above a 5-minute one. That trade pays off for a long-lived main session, which re-reads the cache it wrote. It does not pay off for a fan-out of short workers: each one writes an hour-long cache, finishes, and never reads it again, and all of it comes out of the same weekly limit. Declaring `cacheTtl: 5m` on the workers while the main session keeps the default is the point of the knob.

**It is unset by default**, for the same reason `defaultSubagentModel` is: an upgrade must not quietly change how anybody's turns are cached.

One piece of Claude Code trivia is worth stating plainly, because it is the opposite of what the names suggest. The CLI has a per-agent `experimental.cacheTtl` and a `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, and **neither of them does anything to this plugin.** Both apply only to subagents the CLI runs itself, through its own `Task` tool, which this plugin disallows by default so that opencode runs the subagent instead. An opencode subagent arrives here as its own `doStream` and its own `claude --print` process, and the CLI counts that as a main conversation. So the knob that reaches every process this plugin spawns is the main-conversation one, `CLAUDE_CODE_PROMPT_CACHE_TTL`, which is what `cacheTtl` sets. Measured on CLI 2.1.280 by reading `usage.cache_creation` back off a real turn: the main variable moved the writes to `ephemeral_5m_input_tokens`; the subagent variable left them at 1 hour.

Like model and effort, the TTL is part of the Claude session key, so changing it respawns rather than sharing a process. Compaction is exempt.

Forking an opencode session normally throws that cache away: the fork arrives as a new session with the thread copied in and no Claude session behind it, so the whole conversation is re-rendered as text into the first message and paid for again as cache writes. Setting `forkSessions: true` in the provider options branches the parent's Claude conversation with `claude --resume <parent> --fork-session` instead. Measured on CLI 2.1.280 with haiku 4.5 over a ~13k-token thread, the forked turn wrote 814 cache tokens and read 39,710, against 22,355 written and 17,385 read for the replay: $0.0058 against $0.0467 for that one turn, with the parent's own transcript byte-identical afterwards. It is off by default because a resumed Claude conversation reuses the system prompt recorded on its first request, so a forked session answers under the parent's appended system prompt rather than the current turn's. Anything it cannot match exactly keeps today's replay: another account, an unknown or busy parent, a fork cut mid-conversation or taken mid tool call, a different cwd, model, agent, effort or cache TTL, compaction, and the interactive transport.

To force an **account** rather than a model, pin the full string. This only applies if you declared [`accounts`](../configuration/accounts.md#multiple-claude-code-accounts) in the first place; with the default single-account setup there is nothing to pin. Both halves are needed, because the provider selects the account's config dir and the `@account` marker is what the model was registered under for that provider:

```yaml
model: claude-code-work/claude-opus-5@work
```

## Fallback model chain

`forceModel` and the model picker each name exactly one model, so a model this
account cannot run today is a dead turn. The two ordinary ways to get there are
a **retired id** (Anthropic retires model names on a published schedule, and an
agent file written six months ago outlives them) and a **per-model usage cap**.
An ordered chain degrades instead of failing:

Per agent, in the agent's own file, either YAML spelling:

```yaml
forceModel: claude-opus-5
fallbackModels: [claude-sonnet-5, claude-haiku-4-5]
```

Or once, as the default for every agent that declares none:

```json
{ "provider": { "claude-code": { "options": { "fallbackModels": ["claude-sonnet-5"] } } } }
```

A per-agent list **replaces** the provider one rather than extending it, because
a merge would append the provider's expensive tail to an agent that deliberately
named two cheap models.

**Exactly two things arm it, and "an error" is not one of them:**

1. **The CLI refuses the model.** Measured on Claude Code 2.1.280: a retired,
   sunset or made-up id produces an assistant frame tagged
   `"error": "model_not_found"` and a result with `is_error: true`,
   `api_error_status: 404` and the text *"There's an issue with the selected
   model (…). It may not exist or you may not have access to it."* Note that the
   result's `subtype` is `success`, which is why a refused model used to finish
   as an ordinary reply with the CLI's error standing in for Claude's answer.
2. **A usage limit with nowhere else to go.** Only when the opt-in
   [account failover](../configuration/accounts.md#account-failover) form is not taking the turn, meaning
   it is off (the default), or a single configured account, or every other one
   already limited. **When the form is on and another account exists it wins
   and the chain does not fire**:
   moving your billing is your decision, moving to a cheaper model is not, and a
   per-model weekly cap is exactly the case a chain helps with.

An expired login, a billing hold, a network failure, a tool error and every
other CLI error kind are deliberately excluded: they fail identically on the
next model, so retrying would spend a spawn per entry to print the same message.

On a trigger the failed attempt is dropped whole (its process killed, its
session id discarded), a fresh process spawns on the next model with the **same
account, thinking budget and working directory**, the conversation replays into
it, and a note goes into the reply:

```
▌ **model fallback:** "claude-opus-5" was refused by the Claude CLI
(model_not_found: it is retired, misspelled, or this account cannot use it), so
this turn is being served by "claude-sonnet-5" instead. The account, the
thinking budget and the working directory are unchanged.
```

The refused attempt's output never reaches you and never reaches a rebuilt
transcript, and neither does the note, which the plugin wrote rather than
Claude.

The rails: **entries are model names from this plugin's own list** (an unknown
one is refused with a warning and skipped, exactly as an unknown `forceModel`
is); **the chain never crosses accounts**, since the `@account` marker is taken
from the id the turn arrived with and an entry spelling its own is ignored;
**each model is tried at most once per turn**, and **an exhausted chain surfaces
the original error unchanged**. Unset (the default) means no chain, so upgrading
never moves a turn onto a model nobody picked.

Not applied to compaction turns (a second model would rewrite the summary
opencode stores), to title stubs, or to the
[interactive transport](../guides/interactive-transport.md). A title stub never
reaches the CLI, so there is nothing there to fall back from.

## Subagent todos

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
