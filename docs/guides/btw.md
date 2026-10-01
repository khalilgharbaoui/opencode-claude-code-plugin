---
title: 'Side questions with /btw'
description: 'Ask Claude something on the side, including while it is still working.'
sidebar:
  order: 3
---

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
