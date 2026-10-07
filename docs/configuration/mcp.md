---
title: 'MCP bridge'
description: 'Translating opencode''s MCP servers into Claude''s --mcp-config, including servers that connect late.'
sidebar:
  order: 6
---

If `bridgeOpencodeMcp` is true (the default), the plugin reads your opencode config's MCP servers, translates them into Claude's MCP schema, writes a private temp file, and passes it to `claude --mcp-config`. It accepts V1 `mcp.<server>` and V2 `mcp.servers.<server>`; V2's `servers` container and timeout defaults are not servers. `disabled: true` is supported alongside legacy `enabled: false`. Live runtime status takes precedence when available.

## Discovery and precedence

The disk bridge reads global config, then `OPENCODE_CONFIG`, then project direct files and `.opencode` files. V1 keeps its existing repo-boundary discovery, `.opencode` ordering and per-server deep merges.

On V2, project discovery walks to the filesystem root (including ancestors above the repo). Direct files are applied parent-first, then `.opencode` files parent-first: the closest file wins within each group, and all `.opencode` files override direct files. Each higher-precedence server entry **replaces the entire server object**, so repeat its type, URL/command and other required fields in an override. Both `.json` and `.jsonc` are read, with `.jsonc` winning within a directory. Runtime toggles continue to participate in the hot-reload hash.

## Servers that connect late

A server opencode has not finished connecting to when a turn is planned used to be dropped from that turn's `claude` spawn, and a reused process keeps the `--mcp-config` it was spawned with, so it stayed invisible for the rest of the conversation. Two things stop that now.

First, "still connecting" is no longer read as "not connected". opencode 2 reports such a server as `pending`, which is not a decision, so the bridge leaves its configured state alone instead of forcing it off, and the turn waits up to `mcpConnectWaitMs` (3 s by default, `0` to disable) for the host to decide. opencode 1 has no `pending` status: its own status call blocks until every server resolves, so nothing changes there and the wait costs one status call exactly as before.

Second, if the server joins later anyway, `hotReloadMcp` moves the conversation onto a `claude` process with the new config and `--resume`, at the start of a later turn. That only happens at a safe boundary: not during `/compact`, not on the interactive transport, and not while a proxied call is still in the air, a turn is still running or a plan-mode approval is outstanding. The log line names the servers:

```
INFO: opencode MCP servers changed, respawning claude {"joined":["slowmcp"],"left":[],...}
```

A server that flaps between connected and failed is capped at one respawn per minute per conversation; override with `CLAUDE_CODE_MCP_HOT_RELOAD_COOLDOWN_MS`.

This matters most where a turn can arrive before the host has started its servers: `opencode run`, scripted use and slow servers. The TUI normally connects everything before the first prompt.

## Servers that ask the operator a question (MCP elicitation)

A bridged server can send an MCP **elicitation**: a request for the operator to type or choose something mid-call. There is nobody to ask on this side, because the Claude Code session the plugin drives is headless, so the plugin answers every elicitation with `decline` and warns once per server:

```
WARN: MCP server asked for operator input and was declined: a headless Claude
Code session cannot prompt, so its elicitation can only be refused.
{"server":"<name>","mode":"form"}
```

The tool call still returns, with whatever the server does on a declined elicitation, and the turn continues normally. If you need to answer one, run that server's flow in Claude Code directly, where its own dialog can take your input, or configure the server so that path does not elicit.

This is not configurable. Accepting automatically would mean inventing the answer you were asked for.

## V2 Code Mode

V2 normally exposes MCP tools through Code Mode's `execute` and its catalog, rather than as individual server-prefixed model tools. `proxyOpencodeMcpTools` matches individual tools only; on a Code Mode-only snapshot it warns and falls back to the direct Claude MCP bridge. This fallback does **not** execute tools under opencode's permission policy.

To explicitly opt into Code Mode through opencode instead, use these provider settings (headless transport):

```json
{
  "providers": {
    "claude-code": {
      "settings": {
        "proxyOpencodeTools": ["execute"],
        "bridgeOpencodeMcp": false,
        "strictMcpConfig": true
      }
    }
  }
}
```

Preserve other entries in `proxyOpencodeTools`. `execute` is a code runner that can call **all tools in the session's Code Mode catalog**, not just MCP; opting in must be deliberate. It runs in opencode with the calling agent's permissions, and the plugin refuses it under `permissionPreset: "read-only"`. The plugin preserves the model-visible schema and tells Claude to call `mcp__opencode_proxy__execute` (discoverable via `ToolSearch`), using the original `search(...)` and `tools[...]` catalog signatures inside its code argument.

`bridgeOpencodeMcp: false` prevents a second direct MCP connection, while `strictMcpConfig: true` excludes Claude's own MCP sources. Do not add the same servers through explicit `mcpConfig` if you want Code Mode-only routing. OpenCode still owns the MCP connections; disabling the disk bridge does not disable its catalog.

For individual MCP proxies instead, set `codemode: false` on the relevant V2 MCP servers, then use `proxyOpencodeMcpTools: true` with `strictMcpConfig: true`. Neither approach guarantees exactly-once side effects across retries. Fully restart all opencode server/GUI processes after changing provider settings or plugin code; a new chat alone is insufficient. Real Claude smoke tests consume usage and run configured hooks, so request approval first.

## Translation

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
