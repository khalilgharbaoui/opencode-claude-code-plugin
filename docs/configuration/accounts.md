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

### When an account runs out of usage

By default the turn ends with one line in the conversation and nothing else:

```text
▌ **usage limit:** the Claude account "work" is out of usage in the 5-hour window,
which resets at 2026-09-20 20:00. Pick a model from the "personal" or "default"
account and resend your message, or wait for the window to reset.
```

The reset time is in **your** time zone, to the minute, and is left out when Claude Code did not report one. With no other account configured the second half instead reads *"Wait for the window to reset, or enable extra usage on the account."* You get this line on every limited turn, not just the first one in an opencode session.

The turn also **finishes as an error**, not as a reply. Nothing was served, so filing it as a (very short) answer was wrong: opencode's own retry and failure handling never ran, and the account-block case below has always finished this way.

Nothing moves on its own: switching account means picking a model from another account's provider in opencode's model list and sending your message again. Doing it that way starts a fresh Claude session on the new account, because the session key changes with the model; the automatic switch below carries the conversation across instead.

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
- **Per-profile MCP servers do not come along.** A server configured only in the limited account's Claude profile is simply absent on the target.
- **`stop`, dismissing the form, or any answer that is not one of the offered accounts** ends the turn the way a limited turn ends without the form.

Only three things count as "out of usage", for the note and for the form alike: a `rate_limit_event` the CLI marked `rejected`, the CLI's own limit reply (an API-error reply of kind `rate_limit`, which is the only signal the interactive transport gets), and the two known account-limit error texts (`Third-party apps now draw from your extra usage…`, `You've hit your individual spend limit`). A generic 4xx, a timeout or a bad flag never does, deliberately: a transient failure must not quietly move where your usage is billed.

The form and the switch are both measured live on opencode 1.x and opencode 2.x (2026-10-07): the form renders, the pick is understood, and the next `claude` runs on the account you chose with the account marker stripped off the model name. On opencode 2 the form is one of its own `Form` surfaces rather than a question, which changes nothing you do: pick an option as usual.

The form works on both transports: on the [interactive transport](../guides/interactive-transport.md) a switch closes the limited account's TUI and starts the other account's, carrying the transcript (or replaying the thread) into it exactly as on headless, since the TUI reads and writes the same transcript file. It is not available on compaction turns, or in a child session, which follows its parent's account for free. The note is written on every limited turn except a compaction turn, which [fails outright instead](../guides/compaction-and-thinking.md#when-compaction-hits-a-usage-limit).

### An account that cannot serve at all

When Claude Code reports that an account's login expired (`authentication_failed`), or that it is on hold, unverified or has a billing problem, the plugin writes a note naming the account and what to do:

```text
▌ **claude account:** the Claude account "work" is not logged in (its login expired or
was revoked). Log in again with `CLAUDE_CONFIG_DIR=~/.claude-work claude auth login`,
then resend your message. Or pick a model from the "personal" account and resend.
```

The last sentence appears only when another account is configured. With `"accountFailover": "ask"` it is replaced by the switch form, and the switch then lasts until opencode restarts, so restart after logging in again to move back.
