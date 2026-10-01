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

- **Session key**: `(cwd, model, tool-scope, opencode-session-id)`. The opencode session id comes from the `x-session-affinity` header opencode sets on third-party provider calls. Two chats in the same project on the same model run in **separate** CLI processes, so they don't race. In account mode, model IDs are suffixed per account, so account sessions do not collide.
- **Same chat, multiple turns** → process reused, full Claude context retained.
- **New chat** → fresh process under the new session key.
- **Resumed chat after restart** → in-memory state is gone; a new process spawns and the conversation history is summarized and prepended.
- **Abort (Esc / Ctrl+C)** → the plugin sends the Claude CLI a stream-json `interrupt` control request, so the CLI actually stops generating and running tools instead of finishing the abandoned turn on your bill. The process stays alive for the next message in that chat, and any proxied call the aborted turn left behind is released when that message arrives (see [How a proxied call ends](../internals/how-a-proxied-call-ends.md)). If a turn is somehow still running when the next one starts, it is interrupted first (5 s cap). Contributed by [@broskees](https://github.com/broskees).
- **Abort during the first moment of a turn** → a turn spends a little time preparing before it asks the CLI for anything: resolving the spawn directory, probing the `claude` version, reading opencode's MCP status and tool registry. A stop pressed in that window used to be dropped, and the turn spawned, ran and billed anyway. It now ends the turn there: nothing is spawned, nothing is written, no running process is interrupted, and the reply is simply empty.
- **Idle timeout** → when `idleProcessTimeoutMs` is set, a completed headless turn arms an eviction timer (unset or `0` keeps workers until LRU eviction). Reuse cancels it, a worker found mid-turn when it fires is left alone and re-timed, and eviction preserves the session id, so the next message resumes the same conversation with `--resume`. An idle `claude --print` holds around 250 MB, which is the reason to set it if you keep many chats open.
- **Cap**: 16 active processes, LRU eviction. A process that is mid-turn is never the victim: eviction takes the oldest **idle** one, and when every process is busy it evicts nothing and warns instead, so a running answer is never truncated to make room.
- **Deleted chat** → deleting a session in opencode kills its `claude` workers at once and forgets their session ids and per-chat state; there is nothing left to resume. Other chats, and the shared fallback bucket used when no session id is known, are untouched.
- **opencode exits** → every retained worker is killed on the way out, so a hard shutdown does not leave `claude` processes reparented to init.
- **Crash** → if the CLI dies mid-turn (no terminal `result` line), the turn ends with a visible error naming the exit code or signal and the last stderr the CLI wrote, not a silent `stop` that reads as a short but finished answer. An abort you asked for is not reported this way.
