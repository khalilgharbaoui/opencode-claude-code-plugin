---
title: 'Subagents in the sidebar'
description: 'A live list of the current session''s subagents, what each really runs as, and one click to open it.'
sidebar:
  order: 9
---

The session sidebar gets a **Subagents** section at the bottom while the session you are looking at has subagents. One row per subagent, running ones first:

```
Subagents
⠋ explore Survey docs for stale…  bg
  haiku-4.5 · alpha
⠋ implementor Fix the dispatch form…
  sonnet-5.5 · high · default
✓ explore Summarise README        bg
  haiku-4.5 · alpha
```

- **The glyph** is a spinner in the theme's accent colour while the subagent runs, a ✓ when it finished and a ✗ when it failed or was cancelled. A finished row is greyed out.
- **Then the agent type and the task description**, cut with an ellipsis to fit the sidebar. A dim `bg` marks a [background](./background-subagents.md) dispatch, which is the one you would otherwise lose track of.
- **The muted second line is what the subagent really runs as**: model, reasoning effort, and on a multi-account install the account. It is read from what the plugin actually spawned, not from what opencode asked for, so an agent's `forceModel` or `reasoningEffort`, a [dispatch form](../configuration/subagents.md#choosing-per-dispatch-not-per-file) answer, the fallback chain and an account switch all show up here. opencode's own footer in the child session shows the model it asked for, which can differ. The effort is the one piece in colour, the theme's warning (yellow) colour, faded once the row is finished, because it is what most often differs from one subagent to the next. Effort appears once the subagent's first turn has started; a piece that is not known is left out.
- **Click a row** to open that subagent's session. opencode's own keys take you back: `up` returns to the parent, `left` and `right` step through the siblings. opencode routes to a session, never to a message, so the click opens the child session itself rather than scrolling the parent to the task.
- **Order and fading**: running rows oldest first, then the last three finished rows newest first; a finished row drops off after ten minutes. With more than two rows the heading gets a `▼` you can click to fold the list into `▶ Subagents (2 running)`, the same way opencode's own MCP and Todo sections fold. With no subagents the section is not there at all.

There is no option for it: it is always on, and it costs nothing while no subagent is listed (its clocks only run while a row is showing).

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
