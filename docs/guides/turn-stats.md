---
title: 'Per-turn stats'
description: 'The optional cost footer, and the CLI events that are no longer silent.'
sidebar:
  order: 5
---

Off by default. With `turnStats: true`:

```text
▌ **stats:** $0.0123 · 4.2 s · 2 CLI turns · in 1.2k · out 812 · cache read 45.1k · cache write 2.0k
```

One line at the end of a finished turn, from the numbers the CLI already reports on its `result`. Notes:

- Never on a `/compact` turn (the footer would be appended to what opencode stores as the summary) and never on a turn that ended in error, where the error is the thing to read.
- It is its own text part led by `▌ **stats:**`, and the plugin strips it again if the conversation is ever replayed into a fresh Claude Code process. The model never reads its own accounting.
- Token counts are the turn's totals, which is what matches the cost. They are deliberately not what opencode records for the message: opencode reads that as context occupancy (its context gauge and its auto-compaction), so it gets the input and cache counts of the turn's last API call, plus the whole turn's output. opencode's own cost figure for a multi-call turn therefore counts only the last call's input and cache; the CLI's real cost is this line and `providerMetadata["claude-code"].costUsd`.
- The cost is what the CLI reported for the turn, not a billing guarantee.

The same numbers are logged at INFO whatever this option is set to, and `total_cost_usd`, `duration_ms`, `duration_api_ms`, `num_turns`, `usage`, `modelUsage` and `permission_denials` always reach `providerMetadata` (denials by tool name and id only, never their inputs).

## Display-only context snapshots

A proxied tool can leave Claude waiting for its result before the CLI emits a
terminal `result`. At that boundary the finish's normal `usage` deliberately
stays empty: opencode also uses those counters to decide when to compact, and
compacting while a proxied call is parked has not been verified safe.

For clients that need a context gauge while tools or subagents are running, the
finish now carries a separate snapshot when an assistant frame supplied real
per-call input counters:

```json
{
  "providerMetadata": {
    "claude-code": {
      "contextUsage": {
        "source": "last-api-call",
        "inputTokens": 91900,
        "nonCachedInputTokens": 2,
        "cacheReadInputTokens": 90566,
        "cacheWriteInputTokens": 1332
      }
    }
  }
}
```

`inputTokens` includes cache reads and writes. It is the **last measured API
call's input**, not a sum of the turn, not a token-by-token live count, and not
exact current input-plus-output occupancy. Output is deliberately absent because
per-frame `output_tokens` is a placeholder. Zero-usage synthetic frames do not
erase the last real snapshot; no measured call means no `contextUsage` field.
The last server-side `iterations` entry is used when the call provides one.

The snapshot also accompanies terminal finishes. The CLI's aggregate `usage`,
`costUsd` and the optional stats footer remain unchanged. **Clients must consume
`contextUsage` only for display**, never add it to billed totals or substitute it
for the finish's normal `usage` when making compaction decisions. Clients that
only read normal usage will still have no live value at a parked tool boundary;
they need to explicitly read this metadata. There is no new option, CLI call or
inference request.

## Things the CLI says that are no longer silent

Four Claude Code stream events used to reach nothing but a debug log:

- **A rate-limit rejection.** When the CLI reports `status: "rejected"` (or a rejected extra-usage state) and the turn fails because of it, the turn carries a `▌ **usage limit:**` line naming the account, the window, the local reset time and which other configured account to pick a model from. On every limited turn, not once per process. The detail the CLI sent (the reason extra usage is unavailable, the UTC reset instant, the four levers) is warned once per identity per process into the log. See [When an account runs out of usage](../configuration/accounts.md#when-an-account-runs-out-of-usage), [Billing](../billing.md) and [which login bills what](../troubleshooting/which-login-bills-what.md).
- **A context compaction Claude Code did on its own.** A `▌ **context compacted:**` note says so, with the before and after token counts, so an answer that suddenly forgets the start of the conversation has a visible cause.
- **A conversation Claude Code cleared.** Sending `/clear` as a message, or a plan-mode exit that clears context, makes Claude Code start a fresh conversation while opencode still shows the old messages. A `▌ **claude code reset:**` note says so. The plugin deliberately does not replay the earlier messages, since that would undo the clear. Start a new opencode session if you want the two to match.
- **A `result` whose subtype is not `success`** (`error_max_turns`, `error_during_execution`, …). The subtype is named in the transcript and the turn finishes as an error instead of an ordinary reply.
- **A CLI-executed tool that failed.** Its result is forwarded with the AI SDK's error flag, so opencode renders the row as failed rather than as a success whose output happens to be an error message.
- **A turn that finished cleanly without saying anything.** No text, no tool call, no error: opencode files it as an ordinary reply, so what you get is a blank message with nothing to distinguish it from a crash. A `▌ **no reply:**` note now says which of the two shapes it was, thinking-with-no-answer or nothing at all, and that nothing failed and nothing is pending. It is its own text part and is stripped from any transcript rebuilt for the CLI. Never on a compaction turn, a failed turn, an aborted one, or one that ended on a question, and suppressed entirely by `"autoContinueIncompleteTurns": false`. There is deliberately no automatic retry: measured across the whole retained plugin log, every finished turn carried between 940 and 5,080 characters of reply and none was silent.

- **Something Claude Code wrote after a turn had already ended.** A reused `claude` process can keep talking once the plugin has closed the turn: most often after a tool call ran in opencode and the CLI finished its thought, or when a background command it started reports back and the CLI answers that on its own. The next turn replays whatever it said, led by a `▌ **between turns:**` note that says it is not an answer to the message you just sent. It is its own text part and is stripped from any transcript rebuilt for the CLI, so Claude is never told it said that in reply to the wrong message.

At session start the plugin also warns once per process for each MCP server Claude Code could not connect (its tools are simply absent otherwise) and once when the CLI's own `apiKeySource` says an API key is in effect, which is the field that tells you pay-as-you-go billing is happening. See [`ignoreAnthropicApiKey`](../configuration/options.md).
