---
title: 'How a turn works'
description: 'One claude process per conversation, and what the plugin does between the prompt and the reply.'
sidebar:
  order: 1
---

A turn is one `doStream` call. There is one turn implementation: `doGenerate` is
`doGenerateViaStream`, which aggregates the same stream's parts, so nothing below has a
second copy anywhere.

## The prologue

Before the plugin asks the CLI for anything it resolves the spawn directory, probes the
`claude` version (the answer is cached per binary and gates every optional flag), reads
opencode's MCP status and its tool registry, and plans the proxy tools for this turn.
That window is real time, and a stop pressed inside it used to be dropped, so the abort
watch (`src/turn-abort.ts`) is created before the prologue's first `await`: a signal that
has already aborted never fires an `addEventListener("abort")` registered later.

## The spawn

If the conversation has no live process, one is spawned:

```text
claude --print --output-format stream-json --input-format stream-json --model <id> ...
```

plus whatever this turn's configuration adds: `--mcp-config` for the bridged servers and
the proxy endpoint, `--append-system-prompt-file`, `--plugin-dir` for staged skills,
`--disallowedTools` for everything proxied or closed, and `--resume <session-id>` when the
conversation already has one. If a process is already there it is reused and only the new
user message is written to its stdin.

## Your message reaches Claude as written

A headless `claude` reads the last text block of each user message the way it reads typing:
a leading `/` runs one of its own commands and an `@path` attaches that file. Measured on
Claude Code 2.1.314, a message `/model claude-sonnet-5-5` switched the running process to
Sonnet without a model call while opencode still showed the model it had picked, `/cost`
answered with Claude Code's usage screen, and a message starting with a path such as
`/etc/hosts is broken` reached the model without the environment, deferred-tool, agent and
skill context of its turn (11,887 fewer prompt tokens).

So every user message the plugin writes carries `client_composed: true`, the field the Agent
SDK's `verbatimPrompts` sets. The text then reaches Claude unchanged. Measured: hooks
(`UserPromptSubmit` context included), `CLAUDE.md` and the skill listing still arrive; the
only per-turn note that does not is the `ultrathink` keyword's reminder, so use an effort
variant instead. An envelope answering a tool call is left as it was. `/btw` and
`/claude-code-doctor` are opencode commands the plugin answers before Claude Code sees
anything, so they are unaffected. Turn it off with `verbatimPrompts: false`. The interactive
transport types into Claude Code's own input instead and is not covered.

Your own Claude Code commands and skills are the exception. A message that starts with
`/name`, where `name` is a command or skill you defined (in `.claude/commands` or
`.claude/skills` of the project or a folder above it, in your Claude config dir, or in a
Claude Code plugin you installed), goes out without the mark, so Claude Code runs it as you
typed it. Measured: with the mark, a command marked `disable-model-invocation: true` did not
run at all, and any other one ran only because the model chose to call its `Skill` tool,
three API calls instead of one. Built-ins such as `/model` and `/cost` keep the mark. The
plugin learns which names exist from the command list a `claude` in the same folder reports
when it starts a turn, so the first message in a folder after opencode starts keeps the mark;
from the next one on, your commands run as typed. A command file named like a built-in (`model.md`)
replaces the built-in in Claude Code, so it runs too. A message that carries an attachment
keeps the mark.

## The stream

`src/stream-parser.ts` turns the CLI's stream-json lines into AI SDK parts: text,
reasoning, tool calls and tool results, the `result` frame that ends the turn, and the CLI's
own events (rate limits, compaction boundaries, MCP servers it skipped, hooks that failed).
`src/turn-controller.ts` holds what happens around that: the two watchdogs, late-result
delivery, the batched drain of proxied calls, both tool-call finishes and the auto-continue
nudge. The state they share is one `TurnState` object per turn (`src/turn-state.ts`), with
a comment on each field naming the invariant that owns it.

A proxied tool call leaves the stream as a `tool-call` part, opencode executes it, and the
result is handed back to the CLI's held HTTP request. Nothing about that is on a clock: see
[How a proxied call ends](./how-a-proxied-call-ends.md).

## Sessions

Each chat keeps a long-lived `claude` subprocess so the model retains its native context across turns.

- **Session key**: `(cwd, model, tool-scope, opencode-session-id, provider, agent, spawn settings, effort)`, where the spawn settings are an agent's prompt cache TTL, `maxTurns` and `maxBudgetUsd`, each only when set. Changing effort or a spawn setting ends the old process and resumes its Claude conversation in the new one, so one chat on one model and agent never runs two processes. A change of effort, spawn setting or model that lands mid-turn lets the old process finish that turn first and applies from the next one. The opencode session id comes from the `x-session-affinity` header opencode sets on third-party provider calls. Two chats in the same project on the same model run in **separate** CLI processes, so they don't race. In account mode, model IDs are suffixed per account, so account sessions do not collide. The opencode agent is in the key too, so one chat that moves between the plan and build agents runs on two processes: a Claude session answers under the system prompt of its first request, and the plan agent's instructions must not follow the conversation into build.
- **Same chat, multiple turns** → process reused, full Claude context retained.
- **Same chat, back from another agent** → the process is reused, and it is first told what was said while it was away. A build turn after a plan exchange used to send the build process only your newest message, so it carried on from its own last reply with no idea the plan existed. Now the messages between its last reply and your current one are replayed as text ahead of your message, under a `<missed_conversation>` tag, on the same budget as a full replay; the log says `replaying the messages this claude session missed`. An ordinary turn, whose only new content is the process's own reply, carries nothing extra.
- **Same chat, after an undo or an edit** → the process is dropped and the thread as it stands now is replayed into a fresh one. A `claude` session cannot have messages taken back out of its context, so after an `/undo`, an edited message or a regenerated reply the old process still held the turns you removed and would act on them. The reply opens with a `▌ **conversation rewound:**` note and the log says `replaying the conversation as text: the thread was edited or undone`. One shape is deliberately not recognised: an undo back to the very first message, or an edit of it, leaves nothing of the old thread in place, which is exactly what an opencode compaction looks like from here, and a compacted chat has to keep its process.
- **New chat** → fresh process under the new session key.
- **Resumed chat after restart** → in-memory state is gone; a new process spawns and the conversation history is summarized and prepended. Each message in that replay is clipped from the **middle**, so the answer a message ends on survives: Claude Code runs its own tools without ending a step, so a reply's tool calls and their output sit in the same message ahead of the prose, and keeping only the first 2,000 characters used to keep the tool output and drop the answer. The newest six messages keep 12,000 characters each, because what a follow-up points into is often two exchanges back, not only the newest reply; everything older keeps 2,000. The whole replay is capped at 180,000 characters, newest first, and says `[N earlier messages omitted ...]` at the top when a long session needed it: without the cap a long session rebuilt a multi-megabyte first message that the API refused. Contributed in part by [@bangnh1](https://github.com/bangnh1).
- **Abort (Esc / Ctrl+C)** → the plugin sends the Claude CLI a stream-json `interrupt` control request, so the CLI actually stops generating and running tools instead of finishing the abandoned turn on your bill. The process stays alive for the next message in that chat, and any proxied call the aborted turn left behind is released when that message arrives (see [How a proxied call ends](../internals/how-a-proxied-call-ends.md)). If a turn is somehow still running when the next one starts, it is interrupted first (5 s cap). Contributed by [@broskees](https://github.com/broskees).
- **Abort during the first moment of a turn** → a turn spends a little time preparing before it asks the CLI for anything: resolving the spawn directory, probing the `claude` version, reading opencode's MCP status and tool registry. A stop pressed in that window used to be dropped, and the turn spawned, ran and billed anyway. It now ends the turn there: nothing is spawned, nothing is written, no running process is interrupted, and the reply is simply empty.
- **Idle timeout** → when `idleProcessTimeoutMs` is set, a completed headless turn arms an eviction timer (unset or `0` keeps workers until LRU eviction). Reuse cancels it, a worker found mid-turn when it fires is left alone and re-timed, and eviction preserves the session id, so the next message resumes the same conversation with `--resume`. An idle `claude --print` holds around 250 MB, which is the reason to set it if you keep many chats open.
- **Cap**: 16 active processes, LRU eviction. A process that is mid-turn is never the victim: eviction takes the oldest **idle** one, and when every process is busy it evicts nothing and warns instead, so a running answer is never truncated to make room.
- **Deleted chat** → deleting a session in opencode kills its `claude` workers at once and forgets their session ids and per-chat state; there is nothing left to resume. Other chats, and the shared fallback bucket used when no session id is known, are untouched.
- **opencode exits** → every retained worker is killed on the way out, so a hard shutdown does not leave `claude` processes reparented to init.
- **Crash** → if the CLI dies mid-turn (no terminal `result` line), the turn ends with a visible error naming the exit code or signal and the last stderr the CLI wrote, not a silent `stop` that reads as a short but finished answer. An abort you asked for is not reported this way.
