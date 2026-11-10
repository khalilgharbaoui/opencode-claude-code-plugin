---
title: 'Accounts and failover'
description: 'Run several Claude logins side by side, and keep a task moving when one runs out of usage.'
sidebar:
  order: 3
---

## Multiple Claude Code accounts

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
| `claude-code-default` | `Claude Code (Default, Max 20x)` | normal `~/.claude` |
| `claude-code-personal` | `Claude Code (Personal, Pro)` | `~/.claude-personal` |
| `claude-code-work` | `Claude Code (Work)` | `~/.claude-work` |

### The plan tier in the picker

The display name carries each account's plan when the plugin can read it: `Max 20x`, `Max 5x`, `Max`, `Pro`, `Team` or `Enterprise`. It is read from `<config dir>/.claude.json`, which Claude Code writes beside its login, and derived the way the CLI derives it: `organizationType` for the plan and `organizationRateLimitTier` for the 5x/20x split. No token is read, nothing is spawned and no request is made, and nothing else from that file is ever displayed or logged.

An account whose file is missing, unreadable, half-written, or whose plan the plugin does not recognise gets no suffix at all, like `Work` above. There is no option for this: it adds no behaviour, only a word.

Non-default accounts use `CLAUDE_CONFIG_DIR` so auth/session state stays isolated per account. On macOS and Linux that happens through a small generated wrapper script; on Windows the plugin sets the variable on the spawn itself and runs `claude` directly, which is the same contract without a script (see [how the CLI is started on Windows](../internals/scratch-files-and-security.md#how-the-cli-is-started-on-windows)). Shared capability files and folders are linked from `~/.claude` into each account dir when present:

```text
CLAUDE.md
settings.json
skills/
agents/
commands/
plugins/
```

Directories are linked, so an edit in `~/.claude` is seen by every account. Files are linked too wherever the filesystem allows it; on Windows a file link needs Developer Mode or an elevated process, so the plugin falls back to a hard link and, failing that, to a copy, which it warns about because a copy does not follow later edits. Anything that cannot be linked at all is skipped with a warning and costs the other capabilities nothing.

Identity/session state is not shared.

Login each account once:

```bash
CLAUDE_CONFIG_DIR="$HOME/.claude-personal" claude auth login
CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude auth login
```

The account model IDs are internally suffixed, for example `claude-sonnet-4-6@work`, so long-lived Claude subprocess sessions do not collide across accounts. The suffix is stripped before `claude --model` is called: by the wrapper script on macOS and Linux, by the plugin itself on Windows.

### Usage before the limit

Claude Code reports how much of a usage window an account has used whenever its view of the limits changes. The plugin keeps the last reading for every account and every window (the 5-hour one, the 7-day one, and so on), so you hear about a window filling up **before** it runs out, not at the wall. This works with one account too, where the account is called `default`.

When a served turn's reading crosses one of `usageWarnThresholds` (by default 50, 75, 90 and 95 percent), the turn ends with one line after Claude's answer:

```text
▌ **usage:** the Claude account "work" has used 76% of the 5-hour window,
which resets at 2026-10-17 18:00.
```

- Each threshold is said **once per account per window**: not again on the next turn, not by another opencode session on the same account, and not after an opencode restart. Once the window resets, its thresholds can be said again.
- The reset time is in your own time zone, to the minute.
- Never on a `/compact` turn (its text becomes the stored summary) or in a subagent's session (its reply can become the parent's `task` result). A crossing those turns could not announce is said by the next ordinary turn on that account.
- The turn is not changed: it was served, and it finishes as served.
- `"usageWarnThresholds": []` turns the notes off. The readings are still kept for the sidebar and the doctor.

**Switching before the wall.** At `usageSwitchAt` (default 90 percent) the plugin acts on it, when another account in the same [account group](#account-groups) is configured and is not itself at that level:

- With [`accountFailover: "auto"`](#automatic-failover), **new turns** move to the other account until the window resets, and the note says so: `New turns move to the "default" account until 2026-10-17 18:00.` It is the same account-wide switch a usage limit makes, so every session on the account follows, and the conversation is carried over the same way. The turn that crossed is not moved.
- With `"ask"` or `"off"`, nothing moves and no form is raised (the form only ever answers a turn that failed): the note ends with `To keep working past the limit, pick a model from the "default" account.`
- `"usageSwitchAt": false` turns the switch off. Like a limit's switch, it is held in memory and an opencode restart forgets it.

**Where you see it.** The [sidebar](../guides/subagents-sidebar.md) shows one line per configured account from its first draw: what is left of the 5-hour window (`work · 5h 24% left · resets 18:00`, the reset time in its own colour), with a second line under it when a weekly window is refused or nearly spent, or the account's plan tier and `no reading yet` until its first turn reports (`home · Max 20x · no reading yet`). [`/claude-code-doctor`](../guides/doctor.md) lists every reading with the thresholds already announced.

**Limits.** Every reading Claude Code sends carries every window's own number (the 5-hour and 7-day ones, and the extra-usage one where the account has it), and it sends one whenever a window's rounded percentage moves, so the readings follow an account turn by turn. They come only from turns this machine runs: use on claude.ai or another machine shows up with the account's next turn here. The per-window numbers are an internal field of Claude Code's (present in 2.1.288 and 2.1.293); a Claude Code without them reports an account with headroom without a number, which the sidebar shows as `ok` and which never counts as zero. The [interactive transport](../guides/interactive-transport.md) gets no reading at all: the only thing it records is a limit reply, which the sidebar shows as `limited` with the reset Claude Code named.

The readings live in `$XDG_STATE_HOME/opencode-claude-code-plugin/account-usage.json` (`0600`): account names, window names, numbers and times, nothing else.

### When an account runs out of usage

By default the turn ends with one line in the conversation and nothing else:

```text
▌ **usage limit:** the Claude account "work" is out of usage in the 5-hour window,
which resets at 2026-09-20 20:00. Pick a model from the "personal" or "default"
account and resend your message, or wait for the window to reset.
```

The reset time is in **your** time zone, to the minute, and is left out when Claude Code did not report one. With no other account configured the second half instead reads *"Wait for the window to reset, or enable extra usage on the account."* You get this line on every limited turn, not just the first one in an opencode session.

The turn also **finishes as an error**, not as a reply. Nothing was served, so filing it as a (very short) answer was wrong: opencode's own retry and failure handling never ran, and the account-block case below has always finished this way. A `doGenerate` caller (opencode does not use one today) gets the same error finish, `usage_limit`, with no line, since its text is a return value.

The account the line names is the one the turn actually ran on. That is the provider's own account, unless an earlier failover moved this conversation to another one: then it is that other account, and it is never offered as somewhere to go.

Nothing moves on its own unless you opt into [automatic failover](#automatic-failover): switching account means picking a model from another account's provider in opencode's model list and sending your message again. That carries the conversation across too, exactly as the [failover switch](#account-failover) below does: see [switching account by hand](#switching-account-by-hand).

### Switching account by hand

Picking a model under another account's provider in the same opencode session continues the conversation on that account rather than starting over. It is the same mechanism the failover switch uses: the Claude transcript is copied into the other account's `CLAUDE_CONFIG_DIR` and resumed there with `--resume`, so nothing is re-sent and nothing is paid for twice. It works on both transports, in either direction, and it composes with a model or reasoning-effort change in the same step.

What it needs, and what it refuses:

- It is the **same opencode session**, same working directory, same agent. A different opencode session continuing the same content is a fork, which is [`forkSessions`](./options.md) and is off by default.
- The thread in front of the plugin has to be the conversation that account was last asked to continue, plus Claude's own reply. An edit, a revert or an opencode compaction in between falls back to the replay.
- The other account's transcript has to still be on disk, and nothing may be writing to it.
- `"crossAccountResume": false` turns the copy off, and the switch replays the thread as text, which is what every by-hand switch did before.

Which of the two happened is one NOTICE line in the log: `continuing this conversation's claude session under the new model or effort instead of replaying it`, or `replaying the conversation as text: no claude session was available to continue` with the reason it refused on.

Measured live on opencode 1.x and opencode 2.x (2026-10-08 on 2.0.22): one session, a turn on the default account, then a turn on the second account's provider, which resumed the first account's Claude session id after the transcript was copied into its config dir. Switching back resumed it again, taking a fresh id because the first account's own path still held the older copy it left behind, and it was the longer copy (the one the second account had been writing) that came home.

If the two accounts are not meant to see each other's work, name them into separate [account groups](#account-groups).

### Account groups

**Off unless set.** `accountGroups` says which accounts may see each other's conversations. It is a map from an account name to a group name; every account you do not name, `default` included, is in one implicit group, so naming the one account that has to stay apart is the whole configuration:

```json
{
  "provider": {
    "claude-code": {
      "options": {
        "accounts": ["work", "hobby"],
        "accountGroups": { "work": "work" }
      }
    }
  }
}
```

That puts `work` in the group `work`, and `hobby` and `default` together in the implicit `default` group. With it set, the plugin only ever moves a conversation between accounts in the same group, which covers every way a conversation could move: the by-hand switch above, the account-switch form, the automatic switch, the override either one sets, and `crossAccountResume`.

A switch across groups sends the other account **nothing at all**: not the Claude transcript, and not a text replay of the thread either, because the replay is the same history by another route. The turn there starts fresh with only your latest message, and says so once:

```text
▌ **account group:** this conversation was running on the Claude account "work"
(group "work") and is now on "hobby" (group "default"), so none of it was carried
over: accountGroups keeps a conversation inside one group. This account is starting
fresh and sees only your latest message. The conversation is still on "work"; switch
back to it to continue where you stopped.
```

The note is written once, on the turn that would have sent the thread; the next turn on that account is an ordinary turn. Nothing is destroyed: the conversation is left intact on the account it was on, the transcript is not deleted, and switching back continues it where it stopped.

Switching **back** is guarded too, and that is the less obvious half. The account you started on still has its own Claude session, so the next turn there is an ordinary turn with nothing to replay, and what would otherwise send it the other group's exchange is the catch-up the plugin writes when a conversation has been running under another session key. Under `accountGroups` that catch-up is withheld: the session continues, and the turn carries only your latest message. The same holds when the thread was edited or undone in between, which normally drops the session and replays the thread as text: across groups the session is still dropped, nothing is replayed, and the note above is what you read.

The switch form offers only accounts in the limited account's own group, the automatic switch moves only to one of them, and with none left either one behaves exactly as a single-account install does (the `▌ **usage limit:**` note, with no "pick a model from ..." sentence). The "or pick a model from ..." half of the account-block note is filtered the same way.

Details worth knowing:

- An account name that is not in `accounts` is a typo, so it is ignored with one WARN rather than silently creating a group that guards nothing. Group names are compared case-insensitively, and so are account names.
- Compaction turns are exempt, as they are from every other account rule, and a child session follows its parent's account as it always did. Under [automatic failover](#automatic-failover) a child session can move itself, which moves its parent with it (the move belongs to the account), and only within the group.
- A subagent's account is chosen in one of two ways, and both stay inside the dispatching account's group. The [subagent dispatch form](subagents.md#choosing-per-dispatch-not-per-file) (`subagentDispatch: "ask"`) only offers accounts in that group, typed `@name` answers included. On opencode 2, [a model named in the conversation](subagents.md#a-model-you-name-in-the-conversation-opencode-2) that sits on another group's account is refused before the dispatch starts. `"subagentDispatchCrossGroup": true`, off by default, lifts both. Once running, a subagent can also be moved by [automatic failover](#automatic-failover), from inside its own turn, and that never leaves the group either.
- The resolved map is shown in the startup block and in `/claude-code-doctor` as `accountGroups`, names only.
- Measured live on opencode 1.x and opencode 2.x (2026-10-08 on 2.0.22): with the two accounts in different groups, the same by-hand switch spawned with no `--resume`, copied no transcript, sent an envelope holding only the latest message, and wrote the note once. The way back (the catch-up and the edited-thread replay above) is covered by a fake-CLI test that drives real turns across both accounts, added after both were found leaking.
- This is a guard on what the **plugin** moves on its own. It is not a permission system: it cannot stop you typing a secret into the other account yourself, and it does not change what either account's Claude Code can read on disk.
- The guard reads which account answered this conversation from the plugin's own session state and from the resume store. With `"resumeAfterRestart": false` **and** an opencode restart in between, this process has never seen the other account and cannot know a switch happened; nothing is carried either way in that case, because the carry reads the same record, so the worst outcome is a replay rather than a leak.

### Account failover

**Opt-in.** Set `"accountFailover": "ask"` and a usage limit ends the turn on opencode's own `question` form instead of that line:

```text
Account limit
The Claude account "work" is out of usage in the five_hour window, which resets at
2026-09-20T18:00:00.000Z. Continue this task on another configured account?
Leaving this unanswered waits, at no cost.

  personal   Run on "personal" until 2026-09-20T18:00:00.000Z. …
  default    Run on "default" until 2026-09-20T18:00:00.000Z. …
  stop       End this turn now and leave the account as it is.
```

Pick an account and the task continues on it **inside the same opencode turn**, with no new message from you. The pick is the consent: nothing moves until you choose, and leaving the form open costs nothing.

This was the default until the round trip was measured end to end against a real five-hour limit (2026-10-03) and found wanting in three ways, two of which are not the plugin's to fix:

- **Typing instead of picking dismisses the form.** opencode treats a new message while a question is open as a dismissal, and that message then runs on the still-limited account, hits the limit again and raises a second form. That is the "I had to send two messages before anything happened" shape.
- **A switch was always a full replay.** That one is fixed: a switch now carries the conversation's Claude transcript to the other account and continues it, and only falls back to the replay when it cannot (see below).
- **Every pick was refused** as `unrecognised answer`, because another plugin in the chain appends a routing tag to tool results. That half is fixed, so the form works again; it stays opt-in because the first two do not go away.

What a pick does, in full:

- **It is sticky for the limited account, not for the session.** A usage limit belongs to the account, so one pick governs every session running on `work`, and subagents follow their parent for free. It lasts until the limit's reset time, or until opencode restarts when the CLI did not report one. Child sessions never show the form themselves.
- **The conversation moves with you.** A Claude conversation is one transcript file under one account's `CLAUDE_CONFIG_DIR`, and Claude Code resumes a copy of that file placed under another account's. So the switch copies the transcript into the target account's own `projects/<encoded cwd>/` and continues it with `--resume`, instead of replaying the whole thread as text. The source file is never moved, emptied or overwritten; the other account keeps its own copy exactly as it was. Set `"crossAccountResume": false` to keep the old replay.

  When the copy cannot be made (there is no transcript to carry, or something that is not a plain file sits at the target path), the switch falls back to the replay: a fresh Claude session on the target, the thread rebuilt from opencode's history, and a note telling it to carry on. That costs input tokens on the new account, and anything the CLI held but opencode did not is gone. Which of the two happened is one NOTICE line in the log, `carried this conversation's claude transcript to the other account` or `replaying this conversation as text on the other account` with the reason.

  What was measured (Claude Code 2.1.288) is the file layout: a copied transcript resumes under another config dir with its context intact, the CLI resolves a session by filename, and it appends to the copy without touching the original. What has not been verified live is a *different* Anthropic login answering a conversation the other one produced. If that ever fails, the turn errors, the CLI's own "No conversation found" handling drops the session id, and the next turn replays.
- **It says which way the conversation arrived.** The turn that continues on the picked account starts with one `▌ **account failover:**` line naming the account that failed and the one it moved to, and ending either *"The conversation continues where it stopped."* (the transcript was carried) or *"The conversation is replayed into a fresh Claude session there."* (it was not). For an account that could not serve, the line names the reason instead of *"is out of usage"*.
- **After an earlier move, it names the account that failed.** When an earlier pick already moved the conversation from `work` to `personal` and `personal` then runs out too, the form says `personal` is out of usage and offers neither `personal` nor `work` (still out). Picking another account moves the conversation on from there.
- **Per-profile MCP servers do not come along.** A server configured only in the limited account's Claude profile is simply absent on the target.
- **`stop`, dismissing the form, or any answer that is not one of the offered accounts** ends the turn the way a limited turn ends without the form.

Only three things count as "out of usage", for the note, the form and the automatic switch alike: a `rate_limit_event` the CLI marked `rejected`, the CLI's own limit reply (an API-error reply of kind `rate_limit`, which is the only signal the interactive transport gets), and the two known account-limit error texts (`Third-party apps now draw from your extra usage…`, `You've hit your individual spend limit`). A generic 4xx, a timeout or a bad flag never does, deliberately: a transient failure must not quietly move where your usage is billed.

The form and the switch are both measured live on opencode 1.x and opencode 2.x (2026-10-07): the form renders, the pick is understood, and the next `claude` runs on the account you chose with the account marker stripped off the model name. On opencode 2 the form is one of its own `Form` surfaces rather than a question, which changes nothing you do: pick an option as usual.

The form works on both transports: on the [interactive transport](../guides/interactive-transport.md) a switch closes the limited account's TUI and starts the other account's, carrying the transcript (or replaying the thread) into it exactly as on headless, since the TUI reads and writes the same transcript file. It is not available on compaction turns, or in a child session, which follows its parent's account for free. The note is written on every limited turn except a compaction turn, which [fails outright instead](../guides/compaction-and-thinking.md#when-compaction-hits-a-usage-limit).

### Automatic failover

**Opt-in.** Set `"accountFailover": "auto"` and a limited turn moves to another configured account on its own, **inside the same opencode turn**, with no form and no new message from you. The answer you get is the other account's answer to the same request, under one note saying what happened:

```text
▌ **account failover:** "work" is out of usage, so this turn moved to "personal"
automatically and stays there until 2026-09-20T18:00:00.000Z. The conversation
continues where it stopped.
```

`"auto"` is the switch a pick in the [form](#account-failover) makes, made for you, so everything that section says about the override, the transcript carry and the replay holds here too. What is particular to it:

- **What moves it.** Exactly what opens the form, and only on a turn that failed: a usage limit (the three signals above) or an [account that cannot serve](#an-account-that-cannot-serve-at-all) (expired login, hold, verification, billing). A turn that was served stays where it is, even if a limit event arrived during it. A generic error, a timeout or a server error never moves anything, and a healthy turn never rotates between accounts.
- **Where it goes.** The next account in configured order, which is `default` first and then `accounts` as you wrote them, skipping the account that just failed, every account this request has already tried, every account outside the limited account's [group](#account-groups), and every account the plugin already knows is out: one whose own work it already moved elsewhere (until that move expires), or one whose last limit reported a reset time that is still ahead. Each comes back by itself once that time passes. The choice is made when the failure arrives, so an account that another session found out about while this turn was still running is skipped too. An account the plugin cannot start (its config dir or its wrapper script cannot be written) is skipped the same way, and the turn moves on to the next one; it never runs again on an account it already tried.
- **When nothing is left.** Each account is tried at most once per request, so the walk always ends. When no eligible account is left, the turn finishes as an error with one `▌ **usage limit:**` line naming the last account tried and offering no other, or, for an account that cannot serve, its `▌ **claude account:**` line. Each switch made on the way leaves its own `▌ **account failover:**` line above that. A `doGenerate` caller never gets an answer here either: it gets an error finish (`usage_limit`, or the block's kind). Its text is a return value, so it carries no `▌ **usage limit:**` and no `▌ **account failover:**` line; it holds at most Claude Code's own error text and, when the last account could not serve, that account's `▌ **claude account:**` line with the login command.
- **Sticky, like a pick.** The move is keyed on the account the conversation was on, not the session, so every session on it, subagents included, goes straight to the new account until the reset time the limit reported, or until opencode restarts when none was reported (an account that cannot serve reports none). It is the same override the form sets and expires the same way.
- **Billing.** Moving where the usage is billed is the point of the option: the rest of the turn, and every later turn on that account until the move expires, is billed to the account it moved to. Opting in is the consent; nothing asks again.
- **The conversation.** Carried across with the transcript copy and `--resume` when it can be, replayed into a fresh Claude session when it cannot, exactly as for a pick; the note's last sentence says which. Work the failed account already did in that turn stays done and is not re-run by the plugin. A carried transcript holds it, and the next account is told to continue rather than start over; a replay holds only what opencode has, so anything Claude Code did inside the failed turn is not in it.
- **Where it applies.** Both transports. `doGenerate` callers too; a turn that moved carries no `▌ **account failover:**` line in the returned text. A child session (a subagent) switches itself, because there is no question to put in front of anyone, and its parent then follows through the same override. Never a compaction turn, whose answer is a stored summary and which [fails outright](../guides/compaction-and-thinking.md#when-compaction-hits-a-usage-limit) instead, and never a title request, which the plugin answers without starting `claude` at all (with `titleModel` set it starts one short `claude -p` on whichever account the override points to, and falls back to the synthetic title rather than switching).
- **With a [model fallback chain](./options.md).** An available account is taken first, as with the form; the chain gets a usage limit only when no account is left.
- **Stopping the turn stops the walk**, and so does cancelling the stream the turn returned: either one stops the attempt in flight the way a stop always does, and no further account is started or switched to. (Cancelling the stream stops a turn in every mode, not only this one.)

The switch path is the one measured live for the form; the automatic walk itself is verified with a scripted `claude` only.

### An account that cannot serve at all

When Claude Code reports that an account's login expired (`authentication_failed`), or that it is on hold, unverified or has a billing problem, the plugin writes a note naming the account and what to do:

```text
▌ **claude account:** the Claude account "work" is not logged in (its login expired or
was revoked). Log in again with `CLAUDE_CONFIG_DIR=~/.claude-work claude auth login`,
then resend your message. Or pick a model from the "personal" account and resend.
```

The account and the login command are the ones the turn ran on: after an earlier failover moved the conversation, that is the account it moved to, not the provider's own. The last sentence appears only when another account is configured. With `"accountFailover": "ask"` it is replaced by the switch form, and with `"auto"` the turn moves to the next account on its own and its note names the reason instead; either way the switch then lasts until opencode restarts, so restart after logging in again to move back.
