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
        "mcpConfig": "/path/to/mcp.json",
        "strictMcpConfig": false
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
- `mcpConfig` (string | string[]): path(s) or JSON string(s) passed through as `--mcp-config`. Use this to point the CLI at the same MCP servers your opencode config references.
- `strictMcpConfig` (boolean, default `false`): pass `--strict-mcp-config` so the CLI loads **only** the servers from `mcpConfig` and ignores `~/.claude/settings.json`.

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

Sessions are managed **per working directory + model**. One active Claude CLI process is kept alive per `(cwd, model)` pair and reused across conversation turns. This means:

- **Same session, multiple turns**: The CLI process stays alive between messages. Claude retains full native context.
- **New session**: When opencode starts a new session (first message with no history), any existing process for that `(cwd, model)` is killed and a fresh one is spawned.
- **Resumed session after restart**: If opencode restarts, the in-memory session state is lost. A new CLI process is spawned, and the conversation history is summarized and prepended as context.
- **Abort (Ctrl+C)**: The stream closes but the CLI process stays alive for the next message.

### Tool handling

Claude CLI executes all tools internally (Read, Write, Edit, Bash, Glob, Grep, etc.). Tool calls and results are streamed to opencode for UI display with `providerExecuted: true`.

Tool name mapping:
- **Built-in tools**: `Edit` -> `edit`, `Write` -> `write`, `Bash` -> `bash`, etc. (lowercased)
- **MCP tools**: `mcp__server__tool` -> `server_tool` (Claude CLI format to opencode format)
- **Claude CLI internal tools**: `ToolSearch`, `Agent`, `AskFollowupQuestion` are silently skipped
- **Questions**: `AskUserQuestion` is rendered as text in the stream

### Permissions

The plugin runs with `--dangerously-skip-permissions` by default. Claude CLI handles all tool execution internally. Users control permissions via Claude Code's own `.claude/settings.json` allow/deny lists.

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

- **Per-(cwd, model) CLI state in one opencode instance**: Within a single opencode process, one active Claude CLI process is kept per `(cwd, model)` pair. Two opencode instances are separate processes with separate in-memory state, so they don't literally share a CLI process — but if they run in the same working directory against the same model, they can race on filesystem state the CLI itself keeps under `.claude/` (session files, caches). Opencode also doesn't expose its own session ID to external providers, so we can't namespace further than `(cwd, model)`.
- **MCP servers live in Claude CLI's config, not opencode's**: By default the CLI loads MCP servers from `~/.claude/settings.json`. Point it at a different config via the `mcpConfig` / `strictMcpConfig` options above (for example, the same JSON file your opencode setup references) to unify the two.
- **No opencode permission UI integration**: Permission prompts go through Claude CLI's own system, not opencode's permission dialog. The CLI runs with `--dangerously-skip-permissions` by default; control allow/deny lists via `~/.claude/settings.json`.

## Publishing

To publish a new version to npm, bump the version in `package.json` and push a tag:

```bash
git tag v0.1.1
git push origin v0.1.1
```

The GitHub Actions workflow will automatically build and publish to npm on any `v*` tag.

## License

MIT
