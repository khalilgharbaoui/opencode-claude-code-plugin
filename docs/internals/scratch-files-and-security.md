---
title: 'Scratch files and security'
description: 'The authenticated proxy endpoint, and every file the plugin writes for the CLI to read.'
sidebar:
  order: 3
---

## Proxy endpoint security

The proxy is a small HTTP MCP server on an ephemeral loopback port, and calling it runs Bash, Edit and Write through opencode's executor. Since 0.13.2 it requires a 256-bit bearer token, generated per server and handed to Claude in the `headers` block of the `0600` MCP config file the plugin writes. Requests are also rejected unless the `Host` header matches the bound `127.0.0.1:<port>` authority, no `Origin` header is present, and the content type is `application/json`.

**Upgrade if you are on 0.13.1 or earlier.** Before this, any local process could post to that port and execute commands as you, and a web page you visited could do the same blind, without reading the response. Reported by @willmcginnis in [#28](https://github.com/khalilgharbaoui/opencode-claude-code-plugin/pull/28); tracked as [GHSA-3mxm-w7gf-3c5x](https://github.com/khalilgharbaoui/opencode-claude-code-plugin/security/advisories/GHSA-3mxm-w7gf-3c5x) (High, CVSS 7.5). No exploitation is known: it was found by code audit, not an incident.

**Restart every opencode you have running.** A plugin is read once, when the process starts, so an opencode you left open keeps the old code and keeps serving an unauthenticated proxy port for as long as it lives, however new the installed version is. Long-lived sessions are the ones to check:

```sh
lsof -nP -iTCP -sTCP:LISTEN | grep opencode
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:PORT/mcp \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

A patched process answers `401`. A `200` is a pre-0.13.2 process still running, and restarting it is the fix.

Nothing to configure. If proxied tools ever stop working after a Claude Code upgrade, check the plugin log for `proxy-mcp rejected a request`, which names which guard failed.

## Scratch files on disk

Everything the plugin writes for the Claude CLI to read goes into one per-process directory, `<tmpdir>/opencode-claude-code-<pid>`, created `0700`:

| File | Mode | Holds |
| --- | --- | --- |
| `mcp-<hash>.json` | `0600` | the bridged MCP config, including any `{env:VAR}` values substituted from your environment |
| `proxy-<hash>.json` | `0600` | the proxy endpoint's bearer token |
| `opencode-cc-sys-<uuid>.md` | `0600` | the full appended system prompt, forwarded opencode instructions and AGENTS.md included |
| `skills-<hash>/` | inherits | staged skill plugin dirs for the skill bridge; the `0700` parent is what keeps them private |

On a shared host the OS tmpdir is world-writable and the pid name is guessable, so the plugin refuses a path that already exists but is a symlink, is not a directory, or is not owned by you: it falls back to a fresh `mkdtemp` name and logs a warning naming both paths.

The directory is removed on normal exit. `SIGKILL` skips that, so on first use each run the plugin also sweeps `<tmpdir>/opencode-claude-code-<pid>` directories whose pid is no longer running and which you own. Anything else, another user's directory, a live process's, a symlink, a name that is not exactly that pattern, is left alone. Set `OPENCODE_CLAUDE_CODE_NO_TMP_SWEEP=1` to turn the sweep off.

## How the CLI is started on Windows

Until v0.46 every spawn of `claude` passed `shell: true` on `win32`, which hands the whole command line to `cmd.exe` with no quoting at all: an argument containing `&`, `|`, `>`, `<`, `^` or `(` ran as a second command, and an argument containing a space or a quote arrived as several broken ones. The shell was there for a real reason, since `claude` on Windows is normally `claude.cmd`, an npm shim, and `CreateProcess` cannot start a `.cmd` at all.

The shell is gone. The plugin now resolves the command itself and speaks cmd.exe's language deliberately:

- The command is resolved against `PATH` and `PATHEXT` before anything is spawned, so the plugin knows what it is about to run. The current directory is deliberately **not** searched, even though `CreateProcess` would: a `claude.exe` dropped into a workspace must never win over the installed one.
- A `.exe` or `.com` is spawned with `shell: false`, where Node builds the command line itself and nothing parses `&`.
- A `.cmd` or `.bat` goes through `cmd.exe /d /s /c` with the command path quoted and every argument wrapped in quotes, with an embedded quote written as `""` and the backslashes before one doubled, passed with `windowsVerbatimArguments` so Node does not re-quote what the plugin built. `/d` also skips a user's registry AutoRun command.

The quoting is deliberately not caret escaping, and that is the part most tools get wrong. A batch shim forwards its arguments with `%*`, so cmd parses the composed line a second time before the real program starts, and carets are spent on the first pass. Doubled quotes keep cmd's quote state balanced through both passes, so every `&`, `|`, `>`, `<`, `(` and `^` in an argument stays inside quotes, where cmd treats it as ordinary text, and `CommandLineToArgvW` reads the value back exactly. It is the approach Rust adopted for `.bat` targets after CVE-2024-27980. An argument containing a newline is refused rather than silently truncated, because cmd ends the command line there.

One hole stays: **`%` cannot be neutralised.** cmd expands `%NAME%` in a parsing phase that runs before anything else is considered, `^%` is unavailable (inside the quoting a caret arrives as a literal caret in the value) and `%%` is a batch-file-only escape. An argument containing `%` may therefore arrive with an environment variable substituted into it. It cannot inject a command or become a second argument, because the substitution lands inside quotes cmd has already opened. Avoid `%` in paths you point the plugin at.

This is verified by a Windows CI job on every pull request (`.github/workflows/ci-windows.yml`), which spawns a real `.cmd` shim that echoes its argv back and asserts that spaces, quotes, `&`, `|`, `>`, `<`, `^`, `!`, parentheses, trailing backslashes, an empty argument and a `--settings` JSON blob all arrive byte-identical, and that a set of injection attempts runs nothing.

### Accounts without a wrapper script

[Multiple accounts](../configuration/accounts.md) work on Windows, and they work by not generating a script at all. The bash wrapper the plugin writes on macOS and Linux does exactly two things: export the account's `CLAUDE_CONFIG_DIR`, and strip the `@<account>` marker off the `--model` value. A `.cmd` twin of it would have to forward its own arguments with `%*`, which is a **third** cmd.exe parse on top of the two the quoting above is measured against, and it would have to re-quote the one argument it rewrites, in batch, where there is no reliable quoter. So on Windows the plugin does both jobs itself, in process, before the spawn: the environment variable is set on the child and the model id is rewritten before the command line is built. Nothing is written to disk, and the argument quoting is unchanged.

Shared capabilities are linked rather than copied wherever Windows allows it. A directory becomes a junction, which an unprivileged process may always create; a file is tried as a symlink (which needs Developer Mode), then as a hard link, and only then copied, with a warning, because a copy does not follow later edits to the original.

One Windows gap is known and not closed: the experimental interactive (PTY) transport refuses a `.cmd` shim rather than running one, because `cmd.exe /c` would own the terminal the TUI needs.
