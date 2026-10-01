---
title: 'Billing'
description: 'What a turn draws from, which field says so, and the dated source for the policy.'
sidebar:
  order: 5
---

By default this plugin drives Claude Code headlessly (the Agent SDK path, `claude --print`). On a Claude subscription plan that usage draws from your plan's ordinary usage limits, the same pool as interactive Claude Code. Authenticating the CLI with an API key instead bills as ordinary pay-as-you-go API usage.

Anthropic's own page is the authoritative source and it changes: <https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan>

> **The history, so older text does not mislead you.** Anthropic announced a separate monthly Agent SDK credit for headless and third-party usage, to start on June 15, 2026, and paused it the same day. The page, fetched on 2026-09-27, opens with that June 15 update: nothing has changed, Agent SDK usage, `claude -p` and third-party apps still draw from subscription usage limits, and the credit is not available. Earlier versions of this page, and some third-party write-ups, describe the credit as if it were in effect. Re-read the page rather than this section when it matters. The mechanism the plugin exposes is the same either way: `apiKeySource` is what tells you whether a turn is on the subscription or on pay-as-you-go.

One thing in this plugin interacts with the above: [`ignoreAnthropicApiKey`](./configuration/options.md) stops a stray `ANTHROPIC_API_KEY` in your environment from silently redirecting the CLI onto pay-as-you-go API billing. The experimental [interactive transport](./guides/interactive-transport.md) drives the real `claude` TUI instead of `--print`; it does not change what a turn draws from.
