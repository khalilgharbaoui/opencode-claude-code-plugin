---
title: 'Logging'
description: 'Four orthogonal knobs, the env-var overrides, and the startup diagnostics block.'
sidebar:
  order: 8
---

Configure via `opencode.jsonc` (launch-method-independent) or env vars
(temporary override for a single process). The plugin has four orthogonal
knobs:

| Field | Values | Default | Effect |
|---|---|---|---|
| `file` | `true \| false` | `false` | Persist log entries to disk |
| `dir` | path string | `~/.local/share/opencode-claude-code/` | Custom file location |
| `mode` | `"silent" \| "debug"` | `"silent"` | How much reaches the operator |
| `level` | `"debug" \| "info" \| "notice" \| "warn" \| "error"` | `"info"` | Minimum level to emit |

Rails-style threshold: anything below `level` is dropped before either
destination decides what to do. `mode: "silent"` routes DEBUG/INFO/NOTICE
to the log file only and surfaces WARN/ERROR to the operator (they always
do). `mode: "debug"` additionally surfaces every emitted level.

## Where a surfaced line actually goes

It depends on whether a full-screen TUI owns the terminal, and the plugin
works that out on its own.

- **`opencode run`, `opencode serve`, and anything else without a full-screen
  interface:** the line is written to the plugin's stderr, prefixed
  `[opencode-claude-code] WARN:`, exactly as it always has been. Pipe it, grep
  it, redirect it.
- **Inside opencode's TUI:** nothing is written to stderr at any level, because
  there stderr *is* the terminal the TUI is drawing on and a raw line paints
  over the interface until something forces a redraw. Instead every surfaced
  line goes to opencode's own log (`POST /log`, service
  `opencode-claude-code`, so it appears in `~/.local/share/opencode/log/`
  alongside opencode's own entries), and WARN and ERROR additionally raise a
  toast titled `claude-code`.

The toast is the message only, never the JSON data, and it is rate-limited in
two ways so it cannot become the noise it replaced: the same message text
toasts at most once per process (several WARNs repeat on every spawn), and a
burst raises at most three toasts followed by one line saying how many were
held back. Nothing is held back from the log file or from opencode's log; the
limits govern the screen only.

The log file, when you turn it on, is identical in every mode.

opencode 2 is unaffected and unchanged: it runs plugins in a separate
`serve --stdio` process whose stderr is a pipe rather than the terminal, so
there was never anything to paint over.

`logging` is an ordinary provider option, so it goes under `provider.claude-code.options` like every other one. Keying it on the package name instead is the common mistake: opencode accepts that config without complaint and the plugin never reads it, so you get no log and no error.

**Recommended dev setup**, capturing an audit trail to disk while keeping the TUI quiet:

```jsonc
{
  "provider": {
    "claude-code": {
      "options": {
        "logging": { "file": true }
      }
    }
  }
}
```

The snippets below abbreviate to the `logging` value alone; each one belongs at that same path.

**Full firehose for deep debugging** (every DEBUG stream event captured):

```jsonc
"logging": { "file": true, "level": "debug" }
```

**Everything surfaced** (every emitted level reaches the operator: stderr
outside a TUI, opencode's own log inside one):

```jsonc
"logging": { "file": true, "mode": "debug" }
```

## Env-var overrides

Set explicitly to override config for one process, which is useful for one-off
debugging without editing `opencode.jsonc`:

```bash
OPENCODE_CLAUDE_CODE_LOG_FILE=1 opencode          # file on
OPENCODE_CLAUDE_CODE_LOG_FILE=0 opencode          # file off (overrides config:true)
OPENCODE_CLAUDE_CODE_LOG_DIR=/tmp/cc opencode     # custom dir
OPENCODE_CLAUDE_CODE_LOG_LEVEL=debug opencode     # capture every level
DEBUG=opencode-claude-code opencode               # promote to mode:"debug"
```

Boolean env vars accept `1/true/on/yes` for on and `0/false/no/off` for
off; empty / unset falls through to config. Invalid `level` values fall
through to config.

## Startup diagnostics

Once per process, right after the provider(s) register, the plugin logs a
single `NOTICE: claude-code plugin ready` line summarizing everything worth
knowing before you start debugging anything else:

```bash
OPENCODE_CLAUDE_CODE_LOG_FILE=1 opencode
grep "plugin ready" ~/.local/share/opencode-claude-code/plugin.log
```

```json
{
  "plugin": "0.11.1",
  "opencode": "1.18.5",
  "cwd": { "resolved": "/Users/you/code/app", "source": "process" },
  "providers": ["claude-code-default", "claude-code-work"],
  "accounts": ["default", "work"],
  "proxyTools": ["Bash", "Edit", "Write", "WebFetch", "Task"],
  "mcpServers": ["github", "slack"],
  "permissionPresets": [
    { "provider": "claude-code-default", "preset": "none", "applied": false, "overrides": [] },
    {
      "provider": "claude-code-work",
      "preset": "read-only",
      "applied": true,
      "overrides": ["skipPermissions: forced to false; ..."]
    }
  ],
  "interactiveTransport": false,
  "anthropicApiKeyInEnv": false,
  "claudeCli": { "path": "claude", "version": "2.1.211 (Claude Code)" }
}
```

Reading it:

- **`cwd.source`** is which rule picked the working directory Claude will be
  spawned in: `configured` (you pinned `options.cwd`), `process` (normal),
  `captured` (`process.cwd()` was unusable and opencode's project directory
  rescued it, the macOS GUI-launch case), or `unresolved` (neither worked).
  The per-session tier that `opencode serve` uses is resolved per call and so
  cannot appear here; this line mirrors the synchronous order only.
- **`claudeCli.version`** reading `not detected` means the `claude` binary at
  that path didn't answer `--version`, which also disables version-gated
  flags like `--thinking-display`.
- **`mcpServers`** is the on-disk merge, before opencode's runtime toggles
  are applied (those aren't settled yet at startup).
- **`permissionPresets`** is one row per provider rather than a single value,
  because a preset is a safety posture and two accounts can be configured with
  different ones. `preset` is the configured name or `none`; `applied` is false
  for `none` and for a name the plugin does not recognise, which applies
  nothing at all; `overrides` are the operator settings the preset replaced,
  the same lines logged at NOTICE when it was applied.
- **`opencode`** is read from the running opencode binary (`--version`), since
  opencode still does not hand its version to plugins. It reads `unknown` when
  opencode is run from source rather than as the packaged binary.

This block is logged once, to a file that is off by default. For the same
fields plus live process and proxy state, without enabling logging, run
[`/claude-code-doctor`](../guides/doctor.md) in the session.

## Default behavior (no config, no env)

Nothing persists; only WARN and ERROR are surfaced, as a toast plus a line
in opencode's own log inside the TUI, or on stderr outside it. The plugin
doesn't accrete a log file on every user's disk by default. Opt in when
you need to inspect auto-continue decisions, broker state, or other
plugin internals.
