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

### Account failover

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
- **An account that cannot serve at all gets the same form.** When Claude Code reports that an account's login expired (`authentication_failed`), or that it is on hold, unverified or has a billing problem, the plugin writes a note naming the account and what to do, and offers the switch if another account is configured. For an expired login the note gives the exact command, for example `CLAUDE_CONFIG_DIR=~/.claude-work claude auth login`. The switch lasts until opencode restarts, so restart after logging in again to move back. With a single account you get the note alone.

Only two things open the form: a `rate_limit_event` the CLI marked `rejected`, and the two known account-limit error texts (`Third-party apps now draw from your extra usage…`, `You've hit your individual spend limit`). A generic 4xx, a timeout or a bad flag never does, deliberately: a transient failure must not quietly move where your usage is billed.

Not available on the [interactive transport](../guides/interactive-transport.md) (no proxy server, TUI stdin) or on compaction turns. Set `"accountFailover": "off"` to keep the plain error.
