# opencode-claude-code

A standalone [opencode](https://github.com/opencodeco/opencode) provider plugin that uses [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) as a backend. It spawns `claude` as a subprocess with `--output-format stream-json --input-format stream-json`, implements the AI SDK `LanguageModelV2` interface, and streams responses back to opencode.

This is a **standalone npm package** that opencode loads dynamically via its external provider system -- no modifications to opencode's source code required.

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` available in your PATH)
- [opencode](https://github.com/opencodeco/opencode) installed

## Installation

### Local development

```bash
git clone <this-repo>
cd opencode-claude-code
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
      "npm": "opencode-claude-code-plugin",
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
        "skipPermissions": false,
        "permissionMode": "default",
        "controlRequestBehavior": "allow",
        "controlRequestToolBehaviors": {
          "Bash": "deny",
          "Read": "allow"
        }
      }
    }
  }
}
```

Replace `"opencode-claude-code-plugin"` with a `file://` path if you're using a local build.

The model IDs (`haiku`, `sonnet`, `opus`) are passed directly to `claude --model`, which accepts these aliases natively.

### Options

- `cliPath` (string, default `"claude"`): path to the Claude Code CLI binary.
- `cwd` (string, default `process.cwd()`): working directory for the spawned CLI.
- `skipPermissions` (boolean, default `true`): pass `--dangerously-skip-permissions` to the CLI.
- `permissionMode` (string, optional): pass Claude CLI `--permission-mode` (`acceptEdits`, `auto`, `bypassPermissions`, `default`, `dontAsk`, `plan`).
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
                                        v
                                  ReadableStream<LanguageModelV2StreamPart>
                                        |
                                        v
                                  opencode processor (UI)
```

### Session management

Sessions are keyed by `(cwd, model, opencode-session-id)`. One active Claude CLI process is kept alive per key and reused across conversation turns within that chat. The opencode session ID comes from the `x-session-affinity` header opencode sets on LLM calls to third-party providers (see `packages/opencode/src/session/llm.ts`), so two chats opened simultaneously in the same project against the same model get separate CLI processes instead of racing on one.

- **Same chat, multiple turns**: the CLI process stays alive between messages. Claude retains full native context.
- **New chat**: a first message with no prior history spawns a fresh process under the new session key.
- **Resumed chat after restart**: in-memory session state is lost; a new CLI process is spawned and the conversation history is summarized and prepended as context.
- **Abort (Ctrl+C)**: the stream closes but the CLI process stays alive for the next message in that chat.
- **Eviction**: live CLI processes are capped at 16 with LRU eviction to avoid accumulating one subprocess per chat indefinitely.

### Tool handling

Claude CLI executes all tools internally (Read, Write, Edit, Bash, Glob, Grep, etc.). Tool calls and results are streamed to opencode for UI display with `providerExecuted: true`.

Tool name mapping:
- **Built-in tools**: `Edit` -> `edit`, `Write` -> `write`, `Bash` -> `bash`, etc. (lowercased)
- **MCP tools**: `mcp__server__tool` -> `server_tool` (Claude CLI format to opencode format)
- **Claude CLI internal tools**: `ToolSearch`, `Agent`, `AskFollowupQuestion` are silently skipped
- **Questions**: `AskUserQuestion` is rendered as text in the stream

### Permissions

By default, the plugin runs with `--dangerously-skip-permissions` (`skipPermissions: true`) for maximum compatibility.

If you set `skipPermissions: false`, the plugin now handles Claude stream-json control requests (`type: control_request`, `subtype: can_use_tool`) and replies with `control_response` messages automatically. This prevents stream deadlocks in print/stream-json mode and follows the same allow/deny fallback pattern used by opencode's `permission.ask` hook work (PR #19470).

Behavior is configurable with:

- `controlRequestBehavior` - global default allow/deny
- `controlRequestToolBehaviors` - per-tool allow/deny overrides
- `controlRequestDenyMessage` - message returned on denied requests

Example (deny shell, allow file reads):

```json
{
  "provider": {
    "claude-code": {
      "npm": "opencode-claude-code-plugin",
      "options": {
        "skipPermissions": false,
        "permissionMode": "default",
        "controlRequestBehavior": "allow",
        "controlRequestToolBehaviors": {
          "Bash": "deny",
          "Read": "allow"
        },
        "controlRequestDenyMessage": "Shell access is disabled by project policy"
      }
    }
  }
}
```

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

- **No native opencode permission dialog for CLI-initiated asks**: when `skipPermissions: false`, this provider now handles Claude `can_use_tool` control requests itself (auto allow/deny). That prevents deadlocks and enables policy control, but it still does not open opencode's built-in permission modal. Full parity requires opencode core exposing a provider-facing permission bridge plus a CLI control-request adapter.

## Publishing

To publish a new version to npm, bump the version in `package.json` and push a tag:

```bash
git tag v0.1.1
git push origin v0.1.1
```

The GitHub Actions workflow will automatically build and publish to npm on any `v*` tag.

## License

MIT
