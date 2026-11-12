---
title: 'Subagents in the sidebar'
description: 'A progress line for the session, and a live list of its subagents and background shells: what each really runs as, what it has spent, and one click to open it.'
sidebar:
  order: 9
---

The session sidebar gets a **Subagents** section at the bottom while the session you are looking at has subagents, and a [**Main Progress** line](#progress) above it while that session's turn runs. One row per subagent, running ones first:

```
Main Progress
⠋ ▰▰▰▰▰▱▱▱▱▱  2/4 · 1m03s · bash
Subagents
⠋ explore Survey docs for stale…  bg
 haiku-4.5 · alpha · $0.07
 ▰▰▰▱▱▱▱▱▱▱  45s/~2m10s · read
⠋ implementor Fix the dispatch form…
 sonnet-5.5 · high · default · $0.42
 ▰▰▰▰▰▰▰▰▱▱  3/4 · 2m10s · edit
✓ explore Summarise README        bg
 haiku-4.5 · alpha · $0.03
```

- **The glyph** is a spinner in the theme's accent colour while the subagent runs, a ✓ when it finished and a ✗ when it failed or was cancelled. A finished row is greyed out.
- **Then the agent type and the task description**, cut with an ellipsis to fit the sidebar. A dim `bg` marks a [background](./background-subagents.md) dispatch, which is the one you would otherwise lose track of.
- **The muted second line is what the subagent really runs as**: model, reasoning effort, and on a multi-account install the account. It is read from what the plugin actually spawned, not from what opencode asked for, so an agent's `forceModel` or `reasoningEffort`, a [dispatch form](../configuration/subagents.md#choosing-per-dispatch-not-per-file) answer, a model you [named in the conversation](../configuration/subagents.md#a-model-you-name-in-the-conversation-opencode-2) on opencode 2, the fallback chain and an account switch all show up here. opencode's own footer in the child session shows the model it asked for, which can differ. The effort is in colour, the theme's warning (yellow) colour, faded once the row is finished, because it is what most often differs from one subagent to the next. Effort appears once the subagent's first turn has started; a piece that is not known is left out. The line ends with **the subagent's spend so far**, `· $0.42`, in the theme's secondary colour: opencode's own cost figure for that child session, to the cent under ten dollars and five characters at most above (`$12.4`, `$123`), kept after the row finishes. When the line has no room for the dot a space stands in for it, and when it has no room for the number the number is left off: the model is never cut to make space for it.
- **A running row gets a third line**, the same [progress line](#progress) the session itself gets, measured from the subagent's own session.
- **Click a row** to open that subagent's session. opencode's own keys take you back: `up` returns to the parent, `left` and `right` step through the siblings. opencode routes to a session, never to a message, so the click opens the child session itself rather than scrolling the parent to the task.
- **Order and fading**: running rows oldest first, then the last three finished rows newest first; a finished row drops off after ten minutes. With more than two rows the heading gets a `▼` you can click to fold the list into `▶ Subagents (2 running)`, the same way opencode's own MCP and Todo sections fold. With no subagents the section is not there at all. A subagent that gets a follow-up (dispatched again by its session id) goes back to running in its own row, timed from that dispatch, until it reports again.

There is no option for any of it: it is always on, and it costs nothing while nothing runs. The spinner and the one-second tick behind the progress lines run only while a turn, a subagent or a background shell is running; with only finished rows listed the sidebar rechecks them every 1.5 seconds.

## Background shells

On opencode 2.2.6 and later, a shell command running in the background gets a row in the same section, beside the subagents:

```
Subagents
⠧ shell sleep 40; echo moved-done bg
 8s
✗ shell sh -c 'sleep 4; exit 2'   bg
 exit 2 · 4s
✓ shell sleep 90                  bg
 exit 0 · 1m30s
```

- **What counts as background**: a command you moved there with `ctrl+b` (opencode's "Background blocking session tools") while it was running, a `!command` typed in the prompt, and a command Claude started in the background itself, which the proxied `bash` tool lets it do on opencode 2 (see [Background shells](./tool-proxy.md#background-shells-opencode-2)). A command the model runs in the foreground never gets a row: while it runs it is already the tool named on the [progress line](#progress), and listing every one would bury the rows you care about.
- **The first line** is `shell` in the theme's info colour (the colour of the running tool on the progress line, so it reads apart from an agent type), the command cut to fit, and the `bg` marker.
- **The second line** is how long it has run, from the shell's own start rather than from when it was moved. Once it ends, it says how: `exit 0` and a ✓, a non-zero `exit 2`, `timed out` or `killed` and a ✗, then how long it ran. `ended` with a ✓ means opencode let go of the shell before the plugin saw its exit code.
- **Rows sort and fade like subagents'**: running ones by when they started, finished ones for ten minutes. A shell row has no session behind it, so clicking it does nothing.

opencode's own footer counts the same shells (`↓ 1 shell`), foreground ones included; this section names them and keeps the background ones in view after they end. opencode 1.x and opencode 2 before 2.2.6 hand a TUI plugin no shell list, so there the section shows subagents only.

## Progress

Above the subagents, under a **Main Progress** heading (main, as against the subagents listed under it), one line for the session you are looking at, while its turn runs and for fifteen seconds after it ends:

```
Main Progress
⠋ ▰▰▰▰▱▱▱▱▱▱  1m02s/~2m30s · bash
```

What the bar shows depends on what the session has, in this order:

- **A todo list** (Claude Code's `TaskCreate` family reaches opencode as `todowrite`; a subagent needs `permission: { todowrite: "allow" }` to keep one, and Claude Code offers that family only to the 4.x and older models unless `enableTodoTools` is on; see [Subagent todos](../configuration/subagents.md#subagent-todos)): the bar is the share of items completed, in the theme's success colour, and the line says which in bold, `2/4 · 1m03s`. It never fills before the last item is done and never empties once the first is. opencode 2 hands a TUI plugin no todo list, so there the bar is always the next kind.
- **An estimate from this install's own record.** The plugin records every served turn, per agent and model, in `$XDG_STATE_HOME/opencode-claude-code-plugin/turn-history.json`: its duration, the prompt's length, the effort, its tool calls, the output tokens it generated, whether it ended on a failed tool, a short hash of the session it ran in, and a time. No text and no session id. Once an agent has three such turns under one model, or that many across its other models, the bar is this turn's elapsed over its expected total, and the line says both: `1m02s/~2m30s`.

  The total comes from a model of how long that agent and model's turns take: a log-normal, because turn lengths vary by factors rather than by seconds, fitted to the record and weighted toward turns that resemble this one. That means a prompt of about this length, the same effort, and recent turns, whose weight halves every week. Another effort's turns count at half weight, scaled by the measured ratio between the two efforts' typical durations once two turns at each are on record, because a higher effort multiplies the thinking a turn does rather than changing what it is. A new model under a known agent borrows that agent's other models until it has turns of its own, and this session's own earlier turns pull the estimate toward themselves. As the turn runs, the estimate is conditioned on what it has done: it has lasted this long, made this many tool calls and generated this much output, so turns that ended sooner or did less stop counting, and the total rises as the turn outlasts more of the record. A turn waiting on a foreground subagent is expected to last at least as long as that subagent has left.

  The bar also shows where the turn is likely to end, as shades of the same cells: the full success colour for what is covered even if the turn runs to the late end of its band, a softer one for the rest of what is covered at the estimate, and a slightly brighter track for what is covered if it ends at the early end. The band is the middle half of where turns like this one end, and its width and shape come from how far off the estimate itself has been: every recorded turn is estimated from the rest of the record, and those misses calibrate the band, so an agent whose turns vary a lot gets a wide one. Nothing on the bar steps back within a turn. Past every recorded turn the bar is full in the warning colour and the total shown is the usual one, `3m20s/~2m18s`: this turn is over the usual by that much. A turn that ended on a failed tool is recorded but never read.
- **Neither**: no bar. The spinner says the session is working, and a bar that could not fill would say nothing the spinner does not.

Then **elapsed** since your last message (for a subagent, since its dispatch), the **tool calls** made since it (left out when a fraction or an estimate is shown), and the **tool running now** in the theme's info colour. When the line is too wide the call count goes first, then the tool's name is cut.

**When the turn ends** the bar fills in the success colour behind a ✓, or in the error colour behind a ✗ when the last reply failed, stays fifteen seconds, and goes. A subagent's line goes with its spinner. With nothing running there is no Main Progress section at all.

The estimate is honest about its basis and no more: it is this install's own past, not a reading of the task, because what a turn will do depends on what its tools return. Nothing is read from the prompt beyond its length, and no model is asked. How far to trust it is measured rather than claimed: [`/claude-code-doctor`](./doctor.md) has a **Progress estimate** section that says, per agent and model, how far off the estimate has typically been and how often turns ended inside the band. Expect a wide band and a miss by a factor of two or more on an agent whose turns range from seconds to many minutes: that is the record speaking, not the arithmetic.

The colours are the theme's own, so every theme supplies them. On opencode 1: filled cells `success` (`warning` once over the usual), the band's softer cells `success` faded toward `textMuted` and its brighter track `textMuted` with a little `success` in it, the rest of the track `textMuted` pulled halfway toward `backgroundPanel`, the fraction `text` in bold and the estimate `text`, the running tool `info`, a subagent's spend `secondary`. On opencode 2: `text.feedback.success` and `text.feedback.warning`, the band from `text.feedback.success` and `text.muted`, `text.muted` toward `background`, `text.base`, `text.feedback.info`, `hue.interactive`.

## Account usage

Under the subagents, an **Accounts** section lists every account the plugin is configured with (the one `default` account when none is), from the first draw, each with what is left of its 5-hour window once a [usage reading](../configuration/accounts.md#usage-before-the-limit) has arrived:

```
Accounts
default · 5h 100% left
          7d limited · 10-30 12:00
home · Max 20x · no reading yet
work · 5h 28% left · resets 18:00
```

- **The first line is the 5-hour window**, as the percent LEFT of it: in the theme's success colour while more than a quarter is left (under 75% used), in its warning colour from there. It moves as you work: every turn's readings carry every window, and Claude Code sends a new one whenever a window's rounded percentage moves, so the line follows the account turn by turn.
- **A second line**, set in under the first one's level, appears only when another window is refused or has a quarter or less left: `7d` is the 7-day window, `7d opus` and `7d sonnet` the per-model ones, `7d extra` the 7-day one Claude Code reports with extra usage included. While that window is refused, the 5-hour level above it is muted, because a full 5-hour window on an account whose week is spent is no room to work in.
- **`limited`** means the window is out, in the theme's error colour; on the [interactive transport](./interactive-transport.md) this is the only state there is, because it gets no readings. **`ok`** means Claude Code reported the window without a number, which is how a Claude Code without per-window numbers reports an account with headroom, and it is green too.
- **The reset** is local time, in the theme's info colour so it reads apart from the level beside it (the word `resets` stays muted): `resets 18:00` today, and on another day the date in the notation the usage-limit note uses, `2026-10-18 01:20`. That date is too wide for the word `resets` beside a window and a level, so the word goes first and then the year (`10-18 01:20`), the same way on every line so the column reads alike.
- **`5h 100% left`** with no reset is an account whose last 5-hour window has reset: until its next turn here it has all of a fresh one, as far as this machine knows. Use on claude.ai or another machine shows up with the account's next turn here.
- **`login ends by 11-19 09:39`**, set in under an account, means its claude.ai login ends within [`loginExpiryWarnDays`](../configuration/accounts.md#before-a-login-ends) (10 days by default): the date in the warning colour, and `login may have ended` in the error colour once the date has passed. Log in again to clear it.
- **No reading yet** is an account that has never reported here. Until its first turn its line shows the plan tier read off its own `.claude.json` (`Max 20x`, `Pro`, in the theme's secondary colour) and `no reading yet`. On a long account name the tier goes before the line is cut.

The accounts come from the plugin's own startup: the provider half writes the configured list into `$XDG_STATE_HOME/opencode-claude-code-plugin/account-usage.json` beside the readings, replacing the previous list, so an account removed from the config leaves the sidebar at the next opencode start. While a sidebar is on screen the TUI checks that file's size and time every 1.5 seconds and re-reads it only when it changed.

## Enabling it

**opencode 2.x**: nothing to do. opencode 2 loads the sidebar from the same `plugins` entry that loads the provider (the `<checkout>/dist` path or the package name).

**opencode 1.x**: opencode 1 loads TUI plugins from a different list than server plugins, `tui.json`'s `plugin` array, so the package needs one more line there. Next to `~/.config/opencode/opencode.json`, in `~/.config/opencode/tui.json`:

```json
{
  "plugin": ["@khalilgharbaoui/opencode-claude-code-plugin"]
}
```

Use the same spec you have in `opencode.json`, a `file://` checkout path included. If you already have a `tui.json` (a theme, keybinds), add the line to its `plugin` array. Restart opencode fully afterwards; TUI plugins load once, at start. The provider keeps working without this line: only the sidebar section is missing.

## What it reads

The list is built from opencode's own state in the TUI: the current session's child sessions, its `task` (1.x) or `subagent` (2.x) tool calls, and the message opencode adds to the parent when a background subagent ends. The model, effort and account line comes from a small file the provider half writes, `$XDG_STATE_HOME/opencode-claude-code-plugin/session-spawns.json` (`~/.local/state/...` by default): one entry per session holding a model id, an effort level, an account name and a time, and nothing else. It is rewritten only when what a session spawns as changes, and bounded to the newest 256 sessions of the last seven days.

The shell rows read opencode 2's own shell list for the session's directory, which tags each shell with the session that started it, the session's running shell calls (a shell with the same command as one of them is in the foreground), and opencode's `shell.exited` event for the exit code. The sidebar keeps the last 64 shells it has seen in memory, and writes nothing.

The progress lines read the session's messages from your last one on, their tool parts, the todo list opencode 1's TUI keeps per session, and opencode's own busy state; a subagent's spend is the `cost` on opencode's session record. The estimate reads two files the provider half writes: the turn history above, and `turn-progress.json` beside it, which holds one record per running turn (when it started, the output tokens it has generated so far, and a time, under the session's hash), rewritten as each of the turn's API calls ends. That count is the one thing the TUI cannot see in opencode's own state, because opencode reports a step's usage only once the turn's reply is in. The progress lines write nothing.
