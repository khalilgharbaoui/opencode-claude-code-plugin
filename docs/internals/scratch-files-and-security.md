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

**Windows is not hardened here.** Both spawn sites pass `shell: true` on `win32`, so the CLI argument list goes through `cmd.exe` unquoted. Treat Windows as unsupported until that is fixed; see the note in `docs/agents-history.md`.
