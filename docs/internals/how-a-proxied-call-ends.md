---
title: 'How a proxied call ends'
description: 'Every ending is an event the plugin listens for, never a clock running out.'
sidebar:
  order: 2
---

A proxied call ends when something happens to it, not when a clock runs out. The plugin holds the CLI's request open and listens to the process, the stream and the protocol for the events that actually decide the call's fate; each one releases the call on the spot, and tells the CLI where there is still a CLI to tell:

| What happens | What the plugin does |
|---|---|
| opencode returns the tool's result | resolves the call; the CLI gets the result and carries on |
| you abort the turn (Esc / Ctrl+C) | sends the CLI an `interrupt`, which answers with its own result, and rejects every call the turn had pending, whether the abort lands before content, mid-turn, or while opencode is running the tool between two stream boundaries. A stop that lands before the turn has asked the CLI for anything is the one exception: it interrupts nothing and releases nothing, because the calls still pending there belong to the previous step and the next message orphans them as usual |
| you send the next message in that chat | rejects every call the previous turn left pending as orphaned, so the CLI gets an error result and the new turn starts clean |
| the `claude` process closes its output or exits, mid-turn or between turns | rejects its pending calls; a mid-turn death also ends the turn as a visible error |
| you delete the chat in opencode, or opencode exits | kills the worker and rejects its pending calls |
| the CLI hangs up on its own request | keeps the call so a late result can still be delivered as a plain-text continuation (see below) |

Because every ending is observed rather than inferred from elapsed time, a `task` can run until it is finished: **`task` and `task_batch` have no deadline by default**. Earlier flat ceilings fired mid-subagent, Claude believed its dispatch had failed, and the eventual result was dropped because the parent turn had already ended on the timeout error; a 60-minute one did the same to anything longer. What the default gives up is only that nothing fires on the clock alone, so a chat parked in a `task` holds its `claude` worker until one of the events above happens. That is the operator's decision to make, so no timer makes it for them.

So that a call with no deadline is never silent, the plugin says it is still waiting. Five minutes in, and every five minutes after, a call without a deadline logs a warning naming the tool, the call id, how long it has waited, and what will end it. It never ends the call, it only reports one, which is the whole point: the thing a deadline used to provide was visibility, not correctness, and visibility is what is kept. Calls that do have a deadline get one notice rather than a heartbeat, at 60% of the way to it, saying how long is left and which option would extend it. Before this, a deadline reported a call only by killing it: the first thing you heard was the failure, which is no use while there is still time to react. It is one line, never repeated, because the deadline itself is the next thing that will speak, and deadlines under a minute are skipped entirely since the notice and the rejection would arrive together. The line reaches your terminal (warnings always go to stderr), so a subagent that has genuinely wedged shows up on its own instead of waiting to be noticed. `/claude-code-doctor` lists the same calls on demand.

The same events are also what let a legitimately long call complete, which is the second half of the story: the CLI's own HTTP client used to give up on a silent reply at about five minutes whatever the tool deadline said. Every held call therefore keeps its connection visibly alive. A client that advertises SSE gets immediate headers and a keepalive comment every 15 seconds (since 0.15.0); a client that only accepts JSON gets its headers immediately as well, as a chunked body carrying keepalive whitespace on the same cadence, which is still one valid JSON-RPC response when the result lands, on success and on error. Keepalives are about the connection, not the tool: they never extend or replace a deadline. Claude's MCP client timeout for the proxy server, written into the generated `--mcp-config`, is set to the largest effective deadline, and to the largest value the CLI accepts (Node's timer maximum, about 24.8 days) while any tool has no deadline, because the CLI rejects a `timeout` of `0` outright.
