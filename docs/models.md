---
title: 'Models'
description: 'Every registered model id, its context window, its reasoning variants and its list-price multiplier.'
sidebar:
  order: 4
---

The plugin auto-registers the following, and they appear in the model picker with no extra config: Haiku 4.5/5.5, Sonnet 4.5/4.6/5/5.5, Opus 4.5/4.6/4.7/4.8/5/5.5 (plus three fast-mode Opus entries), Fable 5/5.1 and Mythos 5/5.1, each except Haiku 4.5 carrying `low` / `medium` / `high` / `xhigh` / `max` reasoning variants.

| ID | Display name | Context | Output | Reasoning variants | Price × |
|---|---|---|---|---|---|
| `claude-haiku-4-5` | Claude Haiku 4.5 | 200k | 64,000 | – | 1× |
| `claude-haiku-5-5` | Claude Haiku 5.5 | 1M | 128,000 | low/medium/high/xhigh/max | 0.1× |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 | 200k | 64,000 | low/medium/high/xhigh/max | 3× |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | 1M | 128,000 | low/medium/high/xhigh/max | 3× |
| `claude-sonnet-5` | Claude Sonnet 5 | 1M | 128,000 | low/medium/high/xhigh/max | 2× |
| `claude-sonnet-5-5` | Claude Sonnet 5.5 | 1M | 128,000 | low/medium/high/xhigh/max | 2× |
| `claude-opus-4-5` | Claude Opus 4.5 | 200k | 64,000 | low/medium/high/xhigh/max | 5× |
| `claude-opus-4-6` | Claude Opus 4.6 | 1M | 128,000 | low/medium/high/xhigh/max | 5× |
| `claude-opus-4-7` | Claude Opus 4.7 | 1M | 128,000 | low/medium/high/xhigh/max | 5× |
| `claude-opus-4-8` | Claude Opus 4.8 | 1M | 128,000 | low/medium/high/xhigh/max | 5× |
| `claude-opus-4-8-fast` | Claude Opus 4.8 Fast | 1M | 128,000 | low/medium/high/xhigh/max | 10× |
| `claude-opus-5` | Claude Opus 5 | 1M | 128,000 | low/medium/high/xhigh/max | 5× |
| `claude-opus-5-fast` | Claude Opus 5 Fast | 1M | 128,000 | low/medium/high/xhigh/max | 10× |
| `claude-opus-5-5` | Claude Opus 5.5 | 1M | 128,000 | low/medium/high/xhigh/max | 4× |
| `claude-opus-5-5-fast` | Claude Opus 5.5 Fast | 1M | 128,000 | low/medium/high/xhigh/max | 8× |
| `claude-fable-5` | Claude Fable 5 | 1M | 128,000 | low/medium/high/xhigh/max | 10× |
| `claude-fable-5-1` | Claude Fable 5.1 | 1M | 128,000 | low/medium/high/xhigh/max | 10× |
| `claude-mythos-5` | Claude Mythos 5 | 1M | 128,000 | low/medium/high/xhigh/max | 10× |
| `claude-mythos-5-1` | Claude Mythos 5.1 | 1M | 128,000 | low/medium/high/xhigh/max | 10× |

`claude-mythos-5` and `claude-mythos-5-1` are Mythos-class counterparts to the corresponding Fable models, but without safety classifiers, and are **limited availability via [Project Glasswing](https://anthropic.com/glasswing)**. They're registered unconditionally; if your Claude account lacks access, `claude --model` just errors. Use the corresponding generally available `claude-fable-5` or `claude-fable-5-1` otherwise.

Capabilities for every model: text, image and PDF input, text output, tool use, attachments. No temperature control, no audio/video, no interleaved streaming.

**Price ×** is each model's per-token list price relative to Haiku 4.5, which anchors the scale at 1×. It's derived exactly from Anthropic's published pricing (input and output ratios both come out the same: Haiku 4.5 $1/$5 = 1×, Haiku 5.5 $0.10/$0.50 = 0.1×, Sonnet 5 and 5.5 $2/$10 = 2×, Sonnet 4.5/4.6 $3/$15 = 3×, Opus 5.5 $4/$20 = 4×, Opus $5/$25 = 5×, Opus 5.5 fast mode $8/$40 = 8×, Fable/Mythos 5 and 5.1 / Opus 5 and 4.8 fast mode $10/$50 = 10×). So **Fable/Mythos 5 and 5.1, and fast-mode Opus 5 and 4.8, all cost 2× standard Opus 5**, and fast mode is 2× the standard price on every Opus that offers it. The same multiplier is shown as a `(N×)` suffix on the display name in opencode's model picker, since opencode has no dedicated multiplier field. On a flat Max/Pro subscription it doubles as a rough guide to how fast each model drains your usage limit.

Fable 5.1 and Mythos 5.1 keep the same $10/M input and $50/M output rates as 5.0, but cache reads cost $0.25/M instead of $1/M. Their cache-write rate remains $12.50/M.

Haiku 5.5 (released 2026-10-07) is a tenth of Haiku 4.5 on every axis: $0.10/M input, $0.50/M output, cache writes at $0.125/M and cache reads at $0.01/M, with a 1M context window, 128,000 output tokens and adaptive thinking, so unlike Haiku 4.5 it carries the reasoning variants. It needs **Claude Code 2.1.293 or newer**, the release that added it and made it the default Haiku; an older CLI still serves it, on fallback limits, and the plugin warns once.

Haiku 5.5 is also the one model Anthropic prices by prompt length: a request whose prompt (input plus cached read plus cache write) is over **100,000 tokens** bills every one of its tokens at five times the rate, $0.50/M input and $2.50/M output. The plugin applies that to the per-turn cost it reports on the [interactive transport](guides/interactive-transport.md), where it rebuilds the figure itself. The **Price ×** column and the cost opencode computes from the model catalog are the base (up to 100,000 tokens) rate: opencode's config schema has only a fixed 200,000-token tier field, which cannot express a 100,000-token threshold, so filling it in would be wrong between 100k and 200k while implying the tier was modelled. Budget for up to 5× the quoted price on long-prompt Haiku 5.5 turns.

Sonnet 5 and Sonnet 5.5 are $2/M input and $10/M output, with cache writes at $2.50/M and cache reads at $0.20/M. Sonnet 5's price was announced as introductory until 2026-08-31, but Anthropic cancelled the increase to $3/$15, so $2/$10 is its standard price. Sonnet 5.5 runs on any recent Claude Code, but **2.1.284 is the first release that knows it**. An older CLI still serves it, on fallback limits (a 200k context window instead of 1M, and an estimated cost). The plugin warns once when the CLI reports that, and `claude update` fixes it.

Opus 5.5 is priced below the Opus line at $4/M input and $20/M output, with cache writes at $5/M and cache reads at $0.20/M (0.05× input rather than the usual 0.1×). It needs **Claude Code 2.1.280 or newer**: the API rejects it from an older CLI with a 400 naming that floor, which shows up as a failed turn.

The model ID is passed straight through to `claude --model`, so anything Claude Code accepts works. The three `-fast` IDs are the one exception, described below.

## Fast mode

`claude-opus-5-5-fast`, `claude-opus-5-fast` and `claude-opus-4-8-fast` run the same models at up to 2.5× the output tokens per second, at 2× the price ($8/M input, $40/M output for Opus 5.5, the 8× column; $10/M input, $50/M output for Opus 5 and 4.8, the 10× column). Pick them in the model selector like any other model.

The `-fast` suffix is this plugin's own marker, not a model name Anthropic serves. The plugin strips it and spawns `claude --model claude-opus-5 --settings '{"fastMode":true}'`, because that settings layer is the only way to opt a headless (`--print`) session into fast mode: there is no `--fast` flag, and the old `claude-opus-4-6-fast` style model names are retired. Requires Claude Code 2.1.220+; below that the plugin skips the opt-in and you get standard speed.

Fast mode is not available everywhere, and it **fails soft**: an ineligible account drops back to standard speed with no error. Known blockers:

- **Usage credits are off.** The most common one. Run `/usage-credits` in an interactive `claude` session to enable them.
- **Not first-party.** Fast mode is Anthropic-API-only; Bedrock, Vertex, and Foundry are excluded.
- **Free tier**, or an organization that has turned fast mode off.
- **Cooldown.** Fast mode has its own rate limit; after a hit, Claude Code falls back to standard until it clears.
- `CLAUDE_CODE_DISABLE_FAST_MODE=1` in the environment turns it off outright.

Because a downgrade is otherwise invisible, and because the picker shows these IDs at 10× regardless, the plugin logs a **warning** (once per reason) when a fast turn actually ran at standard speed, naming the reason. If you see it, switch to the non-fast ID so the picker's price matches your bill.

The warning is read off the **end** of the turn, not the start. Claude Code answers the question twice and the two can disagree: measured on 2.1.288, an account with usage credits off is told `fast_mode_state: "on"` when the session opens and `"off"` with `extra_usage_disabled` on the terminal result, after the turn has already run and billed at standard Opus rates. Until v0.48 the plugin read only the first one, so for that account it logged "fast mode active" and never warned at all.

## Picking a variant

Variants set the underlying reasoning effort. They're regular opencode model variants, so pick them in the model selector. If you'd previously declared variants in your project's `opencode.json`, they're merged on top of the defaults so nothing gets lost.

## Overriding model metadata

To rename a model, change a limit, or add a custom one:

```json
{
  "plugin": ["@khalilgharbaoui/opencode-claude-code-plugin"],
  "provider": {
    "claude-code": {
      "models": {
        "claude-sonnet-4-6": {
          "name": "Sonnet (custom)",
          "limit": { "context": 1000000, "output": 32768 }
        }
      }
    }
  }
}
```

Anything you supply is merged on top of the defaults; you don't need to redeclare every model.
