---
title: 'Which login bills what'
description: 'The CLI decides this, not the plugin, and apiKeySource is the field that tells the truth.'
sidebar:
  order: 3
---

The `claude` CLI decides this, not the plugin, and the plugin only reports it.

- **An OAuth subscription login** (`claude auth login`) is the normal case: turns run on your Claude plan. The default transport here is headless `--print`, which is the Agent SDK path, and what that draws from is Anthropic's policy to set: read the dated note under [Billing](../billing.md) rather than assuming. The [interactive transport](../guides/interactive-transport.md) drives the real TUI instead and bills as normal plan usage.
- **An API key in the environment.** `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` in the environment that launched opencode reaches the CLI, which prefers it over your subscription login and bills the Platform account pay as you go. This is the one route [`ignoreAnthropicApiKey`](../configuration/options.md) can strip, and the plugin warns at startup whenever it sees one, whatever that option is set to.
- **An API key the CLI found by itself**, from its own `user`, `project` or `org` settings scopes or from an `apiKeyHelper`. That is the CLI's configuration rather than opencode's, so no plugin option removes it.
- **`apiKeySource` is the field that tells the truth.** The CLI reports it on the `system` init event of every session, and anything other than `oauth` (the subscription) or `none` means a key is in effect. The plugin warns once per process when that happens. An absent `ANTHROPIC_API_KEY` does not prove pay-as-you-go is off, because of the route above; `apiKeySource` does.
- **Bedrock and Vertex** are the other two things the CLI's authentication can be, and if it is one of them then neither a Claude subscription nor an Anthropic key is in play for that turn. Fast mode is first-party only, so it is excluded on Bedrock, on Vertex and on Foundry.

An account that runs out mid-task ends the turn on one [`▌ **usage limit:**` line](../configuration/accounts.md#when-an-account-runs-out-of-usage) naming the account, the window, the local reset time and which other configured account to pick a model from. Opt into [Account failover](../configuration/accounts.md#account-failover) with `"accountFailover": "ask"` and it offers the switch as a form instead, sticky for the limited account until its reset time. The switch itself carries the conversation: a Claude transcript is one file under each account's own `CLAUDE_CONFIG_DIR`, and the plugin copies it into the target's and resumes it there, falling back to replaying the thread as text when it cannot ([`crossAccountResume`](../configuration/options.md)). Picking another account's model by hand instead always starts a fresh session there, because the model is part of the session key.
