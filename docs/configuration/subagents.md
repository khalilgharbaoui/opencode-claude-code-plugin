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

Forking an opencode session normally throws that cache away: the fork arrives as a new session with the thread copied in and no Claude session behind it, so the whole conversation is re-rendered as text into the first message and paid for again as cache writes. Setting `forkSessions: true` in the provider options branches the parent's Claude conversation with `claude --resume <parent> --fork-session` instead. Measured on CLI 2.1.280 with haiku 4.5 over a ~13k-token thread, the forked turn wrote 814 cache tokens and read 39,710, against 22,355 written and 17,385 read for the replay: $0.0058 against $0.0467 for that one turn, with the parent's own transcript byte-identical afterwards. It is off by default because a resumed Claude conversation reuses the system prompt recorded on its first request, so a forked session answers under the parent's appended system prompt rather than the current turn's. Anything it cannot match exactly keeps today's replay: another account, an unknown or busy parent, a fork cut mid-conversation or taken mid tool call, a different cwd, model, agent, effort or cache TTL, and compaction. It works on both transports: on the interactive one the new TUI starts with `--resume <parent> --fork-session` (measured on 2.1.288: the forked session knew the parent's last output with 102 cache tokens written).

To force an **account** rather than a model, pin the full string. This only applies if you declared [`accounts`](../configuration/accounts.md#multiple-claude-code-accounts) in the first place; with the default single-account setup there is nothing to pin. Both halves are needed, because the provider selects the account's config dir and the `@account` marker is what the model was registered under for that provider:

```yaml
model: claude-code-work/claude-opus-5@work
```

## Choosing per dispatch, not per file

Everything above is static: it lives in an agent file or a provider option and it answers the question "how does a `designer` always run". It cannot answer "how should *these three* subagents run, right now", and that is the question you actually have in front of you when a fan-out is about to start: two implementors on a mechanical change and one designer on something subtle, or one worker that needs Opus while the other two are fine on Haiku, or a batch you would rather bill to the other account so this one's window survives the afternoon.

`subagentDispatch: "ask"` turns that into a question. **It is off by default**, and with it off nothing here is reached at all: a proxied `task` or `task_batch` call is handed to opencode exactly as it is today.

```json
{ "provider": { "claude-code": { "options": { "subagentDispatch": "ask" } } } }
```

With it on, the dispatch is held at the point it would have left for opencode, and the turn ends on opencode's own `question` form. **There is always exactly one question first**, so the common answer is one click:

```
About to dispatch 3 subagents (2 implementor, designer). How should they run?

  Same as last time      implementor: claude-sonnet-5-5 / medium. designer: claude-opus-5-5 / high
  Default                implementor: claude-opus-5 / high. designer: claude-opus-5 / high
  claude-haiku-5-5 / low Every subagent in this dispatch. Cheapest and fastest.
  claude-sonnet-5-5 / medium  Every subagent in this dispatch. Balanced.
  claude-opus-5-5 / high Every subagent in this dispatch. Most capable.
  claude-opus-5-5 / max  Every subagent in this dispatch. Deepest thinking.
  Customise…             Choose per agent type on the next screen, and per account or per task after that.
```

`Default` is today's behaviour, spelled out: whatever the agent definition, `defaultSubagentModel` and the inherited effort already give each type. `Same as last time` only appears once this conversation has answered for every type in the dispatch. Both of them, and each combo, release the dispatch immediately.

`Customise…` opens a second form with **one row per agent type**, plus one `Account` row when more than one account is on offer:

```
"implementor" (2 subagents): how should they run? Add "@worker" to a typed
answer to send it to that account.
  Default / claude-haiku-5-5 / low / claude-sonnet-5-5 / medium / … / Per task…

"designer" (draw the screen): how should it run? Add "@worker" to a typed
answer to send it to that account.
  Default / claude-haiku-5-5 / low / …

Which Claude account should these subagents run on?
  default   Stay on this conversation's own account. This is what happens today.
  worker    Spawn these subagents with "worker"'s Claude config dir, …
  Per type… Choose the account separately for each of these 2 agent types on
            the next screen.
```

`Per task…` is offered only on a row whose type has more than one task. `Per type…` is offered only on the account row, and only when the dispatch has more than one agent type, since with one type that row already *is* the per-type choice. Either one opens a third form, and if you ask for both you get one third form carrying both:

```
implementor account   default / worker / spare
designer account      default / worker / spare
first                 Same as the rest (…) / Default / claude-haiku-5-5 / low / …
second                Same as the rest (…) / Default / …
```

So one implementor can be given Opus while the other two stay on the default, and the implementors can run on one account while the designer runs on another. **Customisation you do not ask for costs nothing**: a dispatch answered at the first screen never builds the second or the third, and a single-account install never sees an account row, a `Per type…` option or the `@` hint at all.

Every row also takes a typed answer, because opencode's form has a custom-answer field. A model id, an effort level, an `@account`, or any combination, in whichever order and with whatever separator you reach for: `claude-opus-5-5 max`, `claude-opus-5-5 / max`, `xhigh`, `@worker`, `claude-opus-5-5 max @worker`. That is how a **single task** gets its own account: type `@worker` into its row on the third form. Anything the plugin does not recognise as one of its registered models, as a CLI effort level, or as an account this conversation may reach keeps that row's default and logs a NOTICE, rather than being forwarded to a spawn that would reject it.

**The account is choosable at three widths, and the narrower one wins**: the whole dispatch (the `Account` row), one agent type (`Per type…`, or `@name` typed into that type's row) and one task (`@name` typed into its row on the third form). A task that names none of the three runs on the account it would have run on anyway.

**What the answer actually changes.** Each subagent opencode starts gets its own `claude` process, and the answer reaches that process directly: the model as `--model`, the effort as `CLAUDE_CODE_EFFORT_LEVEL`, and the account as that account's wrapper and `CLAUDE_CONFIG_DIR`. A dispatch answer beats `forceModel`, `defaultSubagentModel` and the inherited effort, because it is about this dispatch and a file on disk could not have known about it. It stays with that subagent session for the whole of its life, so its later turns do not change model halfway through.

**How a choice finds its child.** opencode starts each subagent as a new session whose first user message is the task prompt the dispatch wrote, verbatim, with `parentID` set to the dispatching session. The plugin records one claim per task keyed on those three things (the dispatching session, the subagent type, the task prompt) and a child takes a claim only when its own `parentID` confirms the parent. Two concurrent subagents of the same type are told apart by their prompts; two tasks whose prompt and type are byte-identical are interchangeable, and take one claim each.

**Dismissing the form never loses the dispatch.** A dismissed, unanswered or unrecognised form releases the subagents with the defaults, which is exactly what would have happened without the option, and writes one line saying so:

```
▌ **subagent dispatch:** The dispatch form was dismissed, so these subagents run
exactly as they would have without the form: the model, effort and account their
agent definition and this conversation already give them. Nothing was lost.
```

**Every account answer only ever offers same-group accounts, typed ones included.** A subagent is handed the task text the main agent writes, which can quote the conversation, and it reads the repository, so offering an account from another [`accountGroups`](../configuration/accounts.md) group would be handing that group the conversation by another route. The dispatch-wide row, the per-type rows and a typed `@name` on any row all go through one list, so an account outside the group is neither offered nor accepted when you type it. `subagentDispatchCrossGroup: true` is the explicit opt-in, it is `false` by default and nothing else implies it, and it does nothing at all when `accountGroups` is unset (where every account is already one group).

**`Same as last time` follows the session, not the process.** It is remembered per opencode session and per agent type, and it is kept in a small file under your state directory (`$XDG_STATE_HOME/opencode-claude-code-plugin/subagent-dispatch.json`, `0600`), so restarting opencode does not forget it: the conversation on the other side of the restart is the same conversation. Only the model id, the effort level and the account name are written, never a prompt or a working directory. Records are capped and pruned (128 conversations, 32 agent types each, 30 days), two opencode processes merge rather than overwrite each other, a malformed file simply reads as empty, and deleting the opencode session deletes its record.

If the remembered choice has gone stale it is not acted on: a model id this install no longer registers falls back to what the agent runs today, and **an account that is no longer configured, or no longer in your group, is dropped**. The row says so, and the release writes one line:

```
▌ **subagent dispatch:** The account you last picked for "implementor" (was
"worker") is no longer configured for this conversation, or no longer in its
account group, so that work stays on the account you are on. Everything else you
picked still applies.
```

**The rest of the rails.** Never on compaction turns. Never inside a child session: a subagent that dispatches subagents of its own follows the choice its parent made for it, so a form never appears in a session you are not looking at. Only where opencode's registry actually has the `question` entry, since a `question` call on a build without it renders as `⚙ invalid`. Both transports, both opencode majors.

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
opencode stores) or to title stubs. It works on both transports: the
[interactive transport](../guides/interactive-transport.md)'s TUI writes a
refused model as the same `model_not_found` reply headless streams. A title
stub never reaches the CLI, so there is nothing there to fall back from.

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
