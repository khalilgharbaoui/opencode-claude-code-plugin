# @khalilgharbaoui/opencode-claude-plugin

A standalone [opencode](https://github.com/opencodeco/opencode) provider plugin that uses [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) as a backend. It spawns `claude` as a subprocess with `--output-format stream-json --input-format stream-json`, implements the AI SDK `LanguageModelV2` interface, and streams responses back to opencode.

> Maintained fork of [`unixfox/opencode-claude-code-plugin`](https://github.com/unixfox/opencode-claude-code-plugin), published as `@khalilgharbaoui/opencode-claude-plugin` on npm.

This is a **standalone npm package** that opencode loads dynamically via its external provider system -- no modifications to opencode's source code required.

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` available in your PATH)
- [opencode](https://github.com/opencodeco/opencode) installed

## Installation

### From npm

```bash
npm install @khalilgharbaoui/opencode-claude-plugin
```

### Local development

```bash
git clone https://github.com/khalilgharbaoui/opencode-claude-code-plugin
cd opencode-claude-code-plugin
bun install
bun run build
```

Then reference it via `file://` in your `opencode.json`.

## Configuration

Add this to your project's `opencode.json`:

```json
{
  "provider": {
    "claude-code": {
      "npm": "@khalilgharbaoui/opencode-claude-plugin",
      "models": {
        "haiku": {
          "name": "Claude Code Haiku",
          "attachment": false,
          "limit": { "context": 200000, "output": 8192 },
          "capabilities": { "reasoning": false, "toolcall": true }
        },
        "sonnet": {
          "name": "Claude Code Sonnet",
          "attachment": false,
          "limit": { "context": 1000000, "output": 16384 },
          "capabilities": { "reasoning": true, "toolcall": true }
        },
        "opus": {
          "name": "Claude Code Opus",
          "attachment": false,
          "limit": { "context": 1000000, "output": 16384 },
          "capabilities": { "reasoning": true, "toolcall": true }
        }
      },
      "options": {
        "cliPath": "claude",
        "proxyTools": ["Bash", "Edit", "Write", "WebFetch"]
      }
    }
  }
}
```

Replace `"@khalilgharbaoui/opencode-claude-plugin"` with a `file://` path if you're using a local build.

The model IDs (`haiku`, `sonnet`, `opus`) are passed directly to `claude --model`, which accepts these aliases natively.

### Options

- `cliPath` (string, default `"claude"`): path to the Claude Code CLI binary.
- `cwd` (string, default `process.cwd()`): working directory for the spawned CLI.
- `skipPermissions` (boolean, default `true`): pass `--dangerously-skip-permissions` to the CLI. Ignored when `proxyTools` is set (the proxy handles permissions instead).
- `permissionMode` (string, optional): pass Claude CLI `--permission-mode` (`acceptEdits`, `auto`, `bypassPermissions`, `default`, `dontAsk`, `plan`).
- `proxyTools` (string[], optional): list of Claude built-in tools to route through opencode instead of letting the CLI execute them directly. See [Selective Tool Proxy](#selective-tool-proxy) below.
- `controlRequestBehavior` (`allow` | `deny`, default `allow`): default behavior for Claude stream-json `control_request` messages with subtype `can_use_tool` when `skipPermissions` is `false`.
- `controlRequestToolBehaviors` (`Record<string, "allow" | "deny">`, optional): per-tool overrides for `can_use_tool` requests (eg. `{ "Bash": "deny", "Read": "allow" }`).
- `controlRequestDenyMessage` (string, optional): custom deny message returned to Claude for denied `can_use_tool` requests.
- `bridgeOpencodeMcp` (boolean, default `true`): auto-translate the `mcp` block from your opencode config (`opencode.jsonc` / `opencode.json`, discovered via `cwd`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, and `$XDG_CONFIG_HOME/opencode`) into Claude CLI's `--mcp-config` format. Set to `false` to disable the bridge and manage MCP servers only via `~/.claude/settings.json`.
- `mcpConfig` (string | string[]): extra `--mcp-config` file path(s) or JSON string(s) passed through alongside the bridged config.
- `strictMcpConfig` (boolean, default `false`): pass `--strict-mcp-config` so the CLI loads **only** the servers from `--mcp-config` and ignores `~/.claude/settings.json` / user MCP registrations.

## How it works

### Architecture

```
opencode  -->  streamText()  -->  ClaudeCodeLanguageModel.doStream()
                                        |
                                        v
                                  claude CLI subprocess
                                  (stream-json mode)
                                        |
                          +-------------+-------------+
                          |                           |
                    native tools              proxy MCP server
                   (Read, Glob, Grep,         (127.0.0.1:random)
                    TodoWrite, etc.)                  |
                          |                           v
                    executed by CLI           opencode tool executor
                                            (bash, edit, write)
                                                     |
                                                     v
                                            opencode permission UI
```

### Session management

Sessions are keyed by `(cwd, model, opencode-session-id)`. One active Claude CLI process is kept alive per key and reused across conversation turns within that chat. The opencode session ID comes from the `x-session-affinity` header opencode sets on LLM calls to third-party providers (see `packages/opencode/src/session/llm.ts`), so two chats opened simultaneously in the same project against the same model get separate CLI processes instead of racing on one.

- **Same chat, multiple turns**: the CLI process stays alive between messages. Claude retains full native context.
- **New chat**: a first message with no prior history spawns a fresh process under the new session key.
- **Resumed chat after restart**: in-memory session state is lost; a new CLI process is spawned and the conversation history is summarized and prepended as context.
- **Abort (Ctrl+C)**: the stream closes but the CLI process stays alive for the next message in that chat.
- **Eviction**: live CLI processes are capped at 16 with LRU eviction to avoid accumulating one subprocess per chat indefinitely.

### Selective Tool Proxy

The key feature of this plugin is the ability to selectively route Claude's built-in tools through opencode's own tool execution and permission system.

**Why this exists**: Claude CLI normally executes tools (Bash, Edit, Write, etc.) internally, bypassing opencode's permission UI entirely. By proxying selected tools, you get opencode's native permission prompts, audit trail, and policy rules for dangerous operations while keeping Claude CLI for authentication and model access.

**How it works**:

1. The plugin starts an in-process HTTP MCP server on `127.0.0.1` (random port).
2. For each tool listed in `proxyTools`, the plugin:
   - Passes `--disallowedTools <ToolName>` to the CLI, disabling Claude's built-in version.
   - Exposes an equivalent tool via the MCP server (e.g. `mcp__opencode_proxy__bash`).
3. When Claude decides to use a proxied tool, the MCP call blocks.
4. The plugin emits a client-executed `tool-call` to opencode.
5. Opencode runs the tool through its own executor (with permission checks, UI prompts, etc.).
6. The tool result flows back into the blocked MCP call, and Claude continues.

**Supported proxy tools**:

| `proxyTools` value | Claude built-in disabled | Proxy MCP tool exposed |
|---|---|---|
| `"Bash"` | `Bash` | `mcp__opencode_proxy__bash` |
| `"Edit"` | `Edit` | `mcp__opencode_proxy__edit` |
| `"Write"` | `Write` | `mcp__opencode_proxy__write` |
| `"WebFetch"` | `WebFetch` | `mcp__opencode_proxy__webfetch` |

Tools not listed in `proxyTools` remain fully native to Claude CLI (fast, no permission overhead).

**Example configuration**:

```json
{
  "provider": {
    "claude-code": {
      "npm": "@khalilgharbaoui/opencode-claude-plugin",
      "options": {
        "cliPath": "claude",
        "proxyTools": ["Bash", "Edit", "Write", "WebFetch"]
      }
    }
  }
}
```

**What Claude keeps doing**:
- All LLM reasoning, planning, and tool selection
- System prompts, conversation state, multi-turn continuation
- Native execution of non-proxied tools (Read, Glob, Grep, TodoWrite, etc.)
- Authentication via your Claude CLI subscription

**What opencode now handles**:
- Executing the proxied tools (bash commands, file writes, file edits)
- Permission prompts for those tools through opencode's native UI
- Policy enforcement via opencode's permission rules

### Tool handling

Claude CLI executes non-proxied tools internally (Read, Glob, Grep, etc.). Tool calls and results are streamed to opencode for UI display with `providerExecuted: true`.

Proxied tools follow a different path: Claude calls the MCP proxy, the plugin pauses the stream, opencode executes the tool, and the result is fed back to Claude on the next turn.

Tool name mapping:
- **Built-in tools**: `Edit` -> `edit`, `Write` -> `write`, `Bash` -> `bash`, etc. (lowercased)
- **MCP tools**: `mcp__server__tool` -> `server_tool` (Claude CLI format to opencode format)
- **Proxy tools**: `mcp__opencode_proxy__bash` -> `bash` (proxy prefix stripped)
- **Claude CLI internal tools**: `ToolSearch`, `Agent`, `AskFollowupQuestion` are silently skipped
- **Questions**: `AskUserQuestion` is rendered as text in the stream

### Permissions

When `proxyTools` is configured (recommended), permission handling is straightforward: proxied tools go through opencode's native permission system, and non-proxied tools are handled by Claude CLI directly.

When `proxyTools` is not set and `skipPermissions` is `false`, the plugin handles Claude stream-json control requests (`type: control_request`, `subtype: can_use_tool`) with auto allow/deny based on config. This prevents stream deadlocks but does not open opencode's permission UI.

Control request behavior is configurable with:

- `controlRequestBehavior` - global default allow/deny
- `controlRequestToolBehaviors` - per-tool allow/deny overrides
- `controlRequestDenyMessage` - message returned on denied requests

### Stream sequencing

The plugin ensures proper event ordering for opencode's processor:
- `text-start` -> `text-delta`* -> `text-end`
- `reasoning-start` -> `reasoning-delta`* -> `reasoning-end`
- `tool-input-start` -> `tool-input-delta`* -> `tool-call` -> `tool-result`

## Package structure

```
src/
  index.ts                        # Factory: createClaudeCode()
  claude-code-language-model.ts   # LanguageModelV2 impl (doGenerate + doStream)
  types.ts                        # Type definitions
  tool-mapping.ts                 # Tool name/input conversion
  message-builder.ts              # AI SDK prompt -> Claude CLI JSON messages
  session-manager.ts              # CLI process lifecycle (spawn, reuse, cleanup)
  proxy-mcp.ts                    # In-process HTTP MCP server for tool proxying
  proxy-broker.ts                 # Pause/resume broker for proxied tool calls
  mcp-bridge.ts                   # Opencode MCP config -> Claude CLI translation
  logger.ts                       # Debug logging
```

## Development

```bash
bun install
bun run build        # Build with tsup
bun run dev          # Build in watch mode
bun run typecheck    # Type check without emitting
```

### Debug logging

Set `DEBUG=opencode-claude-code` to enable verbose logging to stderr:

```bash
DEBUG=opencode-claude-code opencode
```

### Running tests

```bash
bun run test.ts
```

Requires the `claude` CLI to be installed and authenticated.

## Plan mode

When Claude finishes planning, the plugin does **not** automatically exit plan mode (since a plugin cannot switch opencode's mode). Instead, the plan is displayed as text with a confirmation prompt.

To proceed after reviewing the plan:
1. Switch to **build mode** using `Tab`
2. Enter `yes` (or `no` to reject) into the prompt

## Known limitations

- **Proxy tool set is currently limited**: only `Bash`, `Edit`, `Write`, and `WebFetch` are supported as proxy targets. More tools can be added when opencode gains matching built-in executors (e.g. `NotebookEdit`).
- **Non-proxied tools bypass opencode permissions**: tools that remain native to Claude CLI (Read, Glob, Grep, etc.) are executed by the CLI directly without opencode permission checks. This is by design for performance, but means those tools are not subject to opencode's permission rules.
- **Claude upstream bug [#34046](https://github.com/anthropics/claude-code/issues/34046)**: Claude CLI does not reliably emit `can_use_tool` control requests for built-in tools even when `--permission-prompt-tool` is set. The selective proxy approach works around this entirely by disabling the built-in tools and replacing them with MCP equivalents.

## Publishing

To publish a new version to npm, bump the version in `package.json` and push a tag:

```bash
git tag v0.1.1
git push origin v0.1.1
```

The GitHub Actions workflow will automatically build and publish to npm on any `v*` tag.

## License

MIT
