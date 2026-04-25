# @khalilgharbaoui/opencode-claude-code-plugin

An [opencode](https://opencode.ai) provider plugin that wraps the **Claude Code CLI** (`claude`) and routes model traffic through it instead of the Anthropic HTTP API. You get to use opencode's UI, agents, MCP, and permission system while authenticating and billing through whichever method `claude` is logged into (Pro/Max plan, Bedrock, Vertex, or API key).

> Maintained fork of [`unixfox/opencode-claude-code-plugin`](https://github.com/unixfox/opencode-claude-code-plugin). Published as `@khalilgharbaoui/opencode-claude-code-plugin` on npm.

---

## TL;DR

```bash
# 1. Make sure `claude` is installed and logged in
claude --version

# 2. Add the plugin to your opencode.json
```

```json
{
  "provider": {
    "claude-code": {
      "npm": "@khalilgharbaoui/opencode-claude-code-plugin"
    }
  }
}
```

That's it. Restart opencode, pick a `claude-code` model, done.

The plugin auto-registers all current Claude Code models (Haiku 4.5, Sonnet 4.5/4.6, Opus 4.5/4.6/4.7) with reasoning variants (`low` / `medium` / `high` / `xhigh` / `max`) and sensible defaults for tool proxying.

---

## Prerequisites

- [opencode](https://opencode.ai) installed
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` on your `$PATH`)
- Node 18+ / Bun

## Install

### From npm (recommended)

```bash
npm install @khalilgharbaoui/opencode-claude-code-plugin
```

Then reference it in `opencode.json` as shown in the TL;DR.

### Local development

```bash
git clone https://github.com/khalilgharbaoui/opencode-claude-code-plugin
cd opencode-claude-code-plugin
bun install
bun run build
```

In your `opencode.json`, point `npm` at the local build:

```json
{
  "provider": {
    "claude-code": {
      "npm": "file:///absolute/path/to/opencode-claude-code-plugin"
    }
  }
}
```

---

## Models

The plugin auto-registers the following. You don't need to declare any of these — they appear in the model picker automatically.

| ID | Display name | Context | Output | Reasoning variants |
|---|---|---|---|---|
| `claude-haiku-4-5` | Claude Code Haiku 4.5 | 200k | 8,192 | – |
| `claude-sonnet-4-5` | Claude Code Sonnet 4.5 | 1M | 16,384 | low/medium/high/xhigh/max |
| `claude-sonnet-4-6` | Claude Code Sonnet 4.6 | 1M | 16,384 | low/medium/high/xhigh/max |
| `claude-opus-4-5` | Claude Code Opus 4.5 | 1M | 16,384 | low/medium/high/xhigh/max |
| `claude-opus-4-6` | Claude Code Opus 4.6 | 1M | 16,384 | low/medium/high/xhigh/max |
| `claude-opus-4-7` | Claude Code Opus 4.7 | 1M | 16,384 | low/medium/high/xhigh/max |

Capabilities for every model: text + image input, text output, tool use, attachments. No temperature control, no PDF/audio/video, no interleaved streaming.

The model ID is passed straight through to `claude --model`, so anything Claude Code accepts works.

### Picking a variant

Variants set the underlying reasoning effort. They're regular opencode model variants — pick them in the model selector. If you'd previously declared variants in your project's `opencode.json`, they're merged on top of the defaults so nothing gets lost.

---

## Configuration

The minimum config is just the `npm` reference (see TL;DR). Anything below is optional override.

### Options reference

```json
{
  "provider": {
    "claude-code": {
      "npm": "@khalilgharbaoui/opencode-claude-code-plugin",
      "options": {
        "cliPath": "claude",
        "proxyTools": ["Bash", "Edit", "Write", "WebFetch"],
        "skipPermissions": true,
        "permissionMode": "default",
        "bridgeOpencodeMcp": true,
        "strictMcpConfig": false
      }
    }
  }
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `cliPath` | string | `process.env.CLAUDE_CLI_PATH ?? "claude"` | Path to the `claude` binary. |
| `cwd` | string | `process.cwd()` | Working directory for the spawned CLI. Resolved **lazily per request**, so opencode's project switching works. |
| `skipPermissions` | boolean | `true` | Pass `--dangerously-skip-permissions` to `claude`. Ignored when `proxyTools` is set — the proxy handles permissions through opencode instead. |
| `permissionMode` | `acceptEdits` \| `auto` \| `bypassPermissions` \| `default` \| `dontAsk` \| `plan` | – | Forwarded to `claude --permission-mode`. |
| `proxyTools` | string[] | `["Bash", "Edit", "Write", "WebFetch"]` | Claude built-in tools to route through opencode's executor + permission UI. See [Selective tool proxy](#selective-tool-proxy). |
| `controlRequestBehavior` | `allow` \| `deny` | `allow` | Default response when `skipPermissions: false` and Claude sends a `can_use_tool` control request. |
| `controlRequestToolBehaviors` | `Record<string, "allow" \| "deny">` | – | Per-tool override for `can_use_tool`. Example: `{ "Bash": "deny", "Read": "allow" }`. |
| `controlRequestDenyMessage` | string | built-in message | Message returned to Claude on a deny. |
| `bridgeOpencodeMcp` | boolean | `true` | Auto-translate your opencode `mcp` block into Claude's `--mcp-config`. See [MCP bridge](#mcp-bridge). |
| `mcpConfig` | string \| string[] | – | Extra `--mcp-config` paths/JSON passed alongside the bridged config. |
| `strictMcpConfig` | boolean | `false` | Pass `--strict-mcp-config` so Claude loads **only** the configured servers and ignores `~/.claude/settings.json`. |

---

## Selective tool proxy

This is the core feature.

By default, when Claude Code's CLI uses `Bash`, `Edit`, `Write`, etc., it executes them itself — bypassing opencode's permission UI, audit trail, and policy rules entirely. With `proxyTools`, you tell the plugin to disable Claude's built-in version of a tool and expose an equivalent through an in-process MCP server. Claude calls the MCP version, which blocks until opencode runs the tool through its own executor.

### Default proxied tools

| `proxyTools` value | Claude built-in disabled | Proxy MCP tool exposed |
|---|---|---|
| `"Bash"` | `Bash` | `mcp__opencode_proxy__bash` |
| `"Edit"` | `Edit`, `MultiEdit` | `mcp__opencode_proxy__edit` |
| `"Write"` | `Write` | `mcp__opencode_proxy__write` |
| `"WebFetch"` | `WebFetch` | `mcp__opencode_proxy__webfetch` |

To turn off proxying entirely:

```json
"options": { "proxyTools": [] }
```

### What you get with proxying on

- opencode's **permission prompts** for every Bash/Edit/Write/WebFetch call (the default `claude --dangerously-skip-permissions` is NOT applied to proxied tools).
- opencode's **audit log** captures the calls.
- Per-tool **policy rules** in opencode apply.

### What you give up

- A small per-call latency hop through `127.0.0.1:<random>/mcp`.
- Some Claude-specific tool features only exist in the built-in (e.g. `MultiEdit` is collapsed into a sequence of edits via the proxy).

---

## MCP bridge

If `bridgeOpencodeMcp` is true (the default), the plugin reads your opencode config's `mcp` block, translates it into Claude's MCP schema, writes it to a temp file, and passes that to `claude --mcp-config`. So whatever MCP servers you've already configured in opencode become available to Claude with no extra setup.

### Discovery order (highest to lowest priority)

1. `OPENCODE_CONFIG` env var (file path)
2. `OPENCODE_CONFIG_DIR` env var
3. Walk up from the current `cwd` looking for `opencode.jsonc`, `opencode.json`, `config.json`, or a `.opencode/` directory
4. Global `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`

Later sources override earlier ones **by server name**, so a project-level MCP server replaces a global one with the same id.

### Translation

| opencode `type` | Claude `type` |
|---|---|
| `local` | `stdio` |
| `remote` | `http` |

If you want to manage MCP servers only via `~/.claude/settings.json`, set `bridgeOpencodeMcp: false`.

To replace (rather than augment) bridged MCP with your own:

```json
"options": {
  "bridgeOpencodeMcp": false,
  "mcpConfig": "/path/to/your/mcp.json",
  "strictMcpConfig": true
}
```

---

## Sessions

Each chat keeps a long-lived `claude` subprocess so the model retains its native context across turns.

- **Session key**: `(cwd, model, tool-scope, opencode-session-id)`. The opencode session id comes from the `x-session-affinity` header opencode sets on third-party provider calls. Two chats in the same project on the same model run in **separate** CLI processes — they don't race.
- **Same chat, multiple turns** → process reused, full Claude context retained.
- **New chat** → fresh process under the new session key.
- **Resumed chat after restart** → in-memory state is gone; a new process spawns and the conversation history is summarized and prepended.
- **Abort (Ctrl+C)** → stream closes, process stays alive for the next message in that chat.
- **Cap**: 16 active processes, LRU eviction.

---

## Plan mode

Set `permissionMode: "plan"` to forward `--permission-mode plan` to Claude. The plugin handles `ExitPlanMode` specially — instead of forwarding it as a tool call, it converts it to a confirmation prompt that flows through opencode normally.

---

## Quirks worth knowing

- **Empty text blocks are dropped.** Claude sometimes opens a `content_block_start` for text but never sends a delta. The plugin no longer emits the empty block (which was triggering Anthropic 400s like `cache_control cannot be set for empty text blocks`).
- **`AskUserQuestion`** from the CLI is converted into plain text content rather than forwarded as a tool call.
- **Result fallback timer.** If the CLI finishes a text block but never sends a `result` message, the stream closes gracefully after 5 seconds rather than hanging.
- **Per-iteration usage.** When the CLI internally retries with tools, the plugin only counts the last iteration's usage so opencode's context accounting stays accurate.
- **Lazy `cwd`.** The working directory is re-resolved at every request, so opencode's project-aware behavior works without restarting the plugin.
- **Variants survive merge.** opencode recalculates variant lists after the plugin loads; the plugin re-injects defaults into runtime config so your variants don't disappear.

## Debug logging

```bash
DEBUG=opencode-claude-code opencode
```

Goes to stderr.

## Known limitations

- No streaming of tool inputs as they're being constructed (Anthropic's `input_json_delta`); the plugin emits them once complete.
- No interleaved thinking — Claude Code CLI doesn't expose reasoning tokens to the SDK.
- The CLI must be a recent enough version to support `--mcp-config` and `--disallowedTools`. If something breaks after a Claude Code update, that's the first thing to check.

---

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun run build       # tsup -> dist/
bun test            # if tests are added
```

Source layout:

```
src/
  index.ts                       # opencode plugin entry, config + provider hooks
  models.ts                      # default models + variants
  claude-code-language-model.ts  # AI-SDK provider that drives `claude`
  proxy-mcp.ts                   # in-process MCP server for proxied tools
  mcp-bridge.ts                  # opencode → Claude --mcp-config translator
  session-manager.ts             # LRU cache of CLI subprocesses
  logger.ts                      # DEBUG=opencode-claude-code stderr logger
  types.ts                       # public option types
  opencode-types.ts              # mirrored opencode types
```

## Publishing (maintainers)

```bash
git tag v0.1.0
git push origin v0.1.0
```

The GitHub Actions workflow at `.github/workflows/publish.yml` runs `npm publish --access public` on tag push (requires `NPM_TOKEN` secret).

## License

MIT. See [LICENSE](./LICENSE).

Original work © `unixfox`. Fork modifications © Khalil Gharbaoui.
