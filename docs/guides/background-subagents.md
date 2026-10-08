---
title: 'Background subagents'
description: 'Start a subagent, keep working, collect the result later.'
sidebar:
  order: 2
---

A foreground `task` call blocks the conversation until the subagent finishes, and so does `task_batch`. Background dispatch is the other shape: start a subagent, keep working, collect the result later. opencode owns it, this plugin surfaces it, and it is **off unless the opencode process has `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`** (or the blanket `OPENCODE_EXPERIMENTAL=true`) in its environment on opencode 1.x. On opencode 2.x it is unconditional.

```sh
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode
```

With it set, `mcp__opencode_proxy__task` takes `background: true` and the call comes straight back:

```xml
<task id="ses_f10789724ffes9OfQApCB04IRe" state="running">
<summary>Background task started</summary>
<task_result>
The task is working in the background. You will be notified automatically when it finishes.
</task_result>
</task>
```

Claude keeps working. When the subagent finishes, opencode prompts the same conversation with the result as a new message, so it arrives as its own turn rather than as that call's result. Measured end to end on opencode 1.18.33 with claude-haiku-4-5: the dispatch returned in 14 s while the child's 30-second command was still running, Claude ran another tool and ended its turn 18 s in, and the `<task ... state="completed">` message landed 43 s later. That notification is automatic, so the right thing after a background dispatch is to end the turn, not to wait or poll.

**opencode 2 uses different envelopes for the same thing**, so the plugin tells the model about its own host's. There a background dispatch answers in prose rather than XML:

```text
The subagent is working in the background (sessionID: ses_f0cb9005fffekrDPNa1Px8Jp0J). You will be notified automatically when it finishes.
```

and the completion arrives as `<subagent sessionID="…" state="completed" description="…">`, which opencode writes into the parent session as its own turn. A cancel pushes the same envelope with `state="cancelled"`. That `sessionID` is the `task_id` for the two tools below. Measured on opencode 2.0.16 and re-measured end to end on **2.0.22**.

**The gate is enforced at the schema, not at the call.** On a host without the flag opencode rejects `background: true` outright with `Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`, which costs a whole dispatch. So the plugin reads the host's own `task` schema (the same registry fetch that supplies the agent-type list) and, when it has no `background` property, strips the field before Claude ever sees it. Nothing about a default install changes: the model is shown exactly `description`, `prompt`, `subagent_type`, `task_id`, `command`. Either way `plugin.log` says which:

```
background subagent gate {"supported":true,"registryResolved":true,"hostApi":"v1", ...}
```

**Collect and cancel.** opencode delivers a background result by pushing it into the conversation and offers nothing else: no route reads a result back, and nothing stops a background child. A notification that never lands (an interrupted turn, an errored turn, a compaction across it) would lose the work, and a subagent running away could only be stopped from another pane. So on a host that runs background subagents, and only there, two more proxy tools ride along with `Task` in the same way `task_batch` does:

| Tool | What it does |
| --- | --- |
| `mcp__opencode_proxy__task_status` | Reads the state of a background subagent by its `task_id` and returns its result if it has finished. A recovery path, not a progress poll: a healthy background task delivers its own result. A result is handed over once, so asking again reports the state without repeating the output. |
| `mcp__opencode_proxy__task_cancel` | Stops a background subagent. A cancelled subagent sends no completion notification. |

The `task_id` is the child's own opencode session id: the `id` in the `<task …>` envelope on opencode 1.x, the `sessionID` the dispatch reported on opencode 2. Both tools are answered inside the plugin rather than executed by opencode, because opencode has no tools of these names, and both refuse any session whose parent is not the conversation doing the asking. Neither can be named in `proxyTools`: they appear only when the host advertises background support, so upgrading changes nothing about what the model can do or spend on a default install.

Both work on opencode 1.x and on opencode 2. On opencode 2 they run over the session routes a plugin is actually given there (`session.context` and `session.interrupt`); opencode 2 gives a plugin no all-sessions run-state map, so "still running" is read off the child's own transcript instead. Verified live on **2.0.22** (and before that on 2.0.16): start, `task_status` answering `running`, a finished child collected once and reported as already delivered on the second ask, `task_cancel` answering `Stopped.` on a running child and refusing outright on a finished one, and both tools refusing a session that is not this conversation's subagent.

**Picking the model, the effort and the account.** With `subagentDispatch: "ask"` a background dispatch is held for the same form a foreground one is, and the answer reaches the background child's own spawn. Nothing else about the dispatch changes: the same immediate envelope, the same automatic completion. Verified live on opencode 2.0.22.

**What `/claude-code-doctor` says about it.** The report has a **Background subagents** section: whether `background` was offered to Claude and the two tools registered, which opencode major, and what decided it (the live `task` schema, a registry that did not answer, or opencode 2 offering it unconditionally), plus the background tasks this process has collected or cancelled. The gate is read while a turn plans its proxy tools, so in a fresh process the section reads `Not read yet this process`: send one message and run it again.

The section opens with how many are working right now:

```text
running now: 2 (of 5 started by this process)
```

That is the number to watch if you dispatch several at once and do not want to overload the machine or the account's usage window. It counts the background dispatches Claude made through this opencode process (a subagent a native model or another opencode window started is not in it), and asks opencode about each one with the same test `task_status` uses: opencode's run state where it answers, the child's own transcript where it does not (opencode 2). It is read-only: it never collects a result, so a result is still handed over exactly once, and a task this process cancelled is not asked about. A child opencode could not tell it about is reported on its own line rather than counted as running. Verified live on opencode 1.18.35 with a scripted `claude`: `running now: 1 (of 1 started by this process)` while a 20-second background child ran, `running now: 0 (of 1 ...)` after it finished.

**Claude sees the same number.** A background dispatch's result reaches Claude with one line appended after opencode's own text:

```text
<task id="ses_..." state="running">
...
</task>

Background subagents running now: 3 (including this one).
```

A `task_batch` that started several gets one line for the whole batch, `(including the 2 just started)`. The count is the doctor's, with the same test and the same scope, so Claude knows the load before it starts more; the tool descriptions and the system prompt say it is for information and never a reason to poll or wait. It is added only to an accepted background dispatch, on both majors' envelopes: a foreground answer, a failed `task` and every other tool reach Claude unchanged. A `task_batch` where one subagent failed is still reported as an error, but the subagents it did start are counted and the line is added, and the `id` or `sessionID` still parses because the line comes after it. It is cheap and never delays a dispatch: the other started subagents are asked about at most four at a time, the whole lookup has 500 ms, and when it runs over, or opencode cannot tell it about one of them, the line is left out rather than showing a number that may be too low. The subagents this result just started are not asked about (opencode has just said they are running), so a child that has not been scheduled yet still counts. Like the doctor's count, it never collects a result.
