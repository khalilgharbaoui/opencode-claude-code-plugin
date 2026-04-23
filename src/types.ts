export interface ClaudeCodeConfig {
  provider: string
  cliPath: string
  cwd?: string
  skipPermissions?: boolean
  permissionMode?: PermissionMode
  mcpConfig?: string | string[]
  strictMcpConfig?: boolean
  bridgeOpencodeMcp?: boolean
  controlRequestBehavior?: ControlRequestBehavior
  controlRequestToolBehaviors?: Record<string, ControlRequestBehavior>
  controlRequestDenyMessage?: string
}

export interface ClaudeCodeProviderSettings {
  cliPath?: string
  cwd?: string
  name?: string
  skipPermissions?: boolean
  permissionMode?: PermissionMode
  mcpConfig?: string | string[]
  strictMcpConfig?: boolean
  /**
   * Auto-translate opencode's `mcp` config block (from opencode.json/jsonc
   * discovered via cwd/OPENCODE_CONFIG/XDG) into a Claude CLI `--mcp-config`
   * file and pass it through on spawn. Defaults to `true` so the CLI sees
   * the same MCP servers opencode is configured with.
   */
  bridgeOpencodeMcp?: boolean
  /**
   * Behavior for Claude CLI `control_request` permission checks
   * (`subtype: can_use_tool`) when `skipPermissions` is false.
   *
   * - allow: approve tool use requests automatically.
   * - deny: reject tool use requests automatically.
   *
   * Defaults to `allow`.
   */
  controlRequestBehavior?: ControlRequestBehavior

  /**
   * Optional per-tool overrides for control-request behavior.
   * Keys are Claude tool names (eg. `Bash`, `Read`, `mcp__github__list_prs`) and
   * values are `allow` or `deny`.
   */
  controlRequestToolBehaviors?: Record<string, ControlRequestBehavior>

  /**
   * Custom deny message sent back to Claude CLI when behavior resolves to deny.
   */
  controlRequestDenyMessage?: string
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

export type PermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "default"
  | "dontAsk"
  | "plan"

export type ControlRequestBehavior = "allow" | "deny"

export interface ClaudeCodeCallOptions {
  reasoningEffort?: ReasoningEffort
}

/**
 * Claude CLI stream-json message types.
 */
export interface ClaudeStreamMessage {
  type: string
  subtype?: string
  request_id?: string

  request?: {
    subtype?: string
    tool_name?: string
    input?: Record<string, unknown>
    tool_use_id?: string
    permission_suggestions?: unknown[]
    blocked_path?: string
    decision_reason?: string
    title?: string
    display_name?: string
    agent_id?: string
    description?: string
  }

  message?: {
    role?: string
    model?: string
    content?: Array<{
      type: string
      text?: string
      name?: string
      input?: unknown
      id?: string
      tool_use_id?: string
      content?: string | Array<{ type: string; text?: string }>
      thinking?: string
    }>
  }

  tool?: {
    name?: string
    id?: string
    input?: unknown
  }

  tool_result?: {
    tool_use_id?: string
    content?: string | Array<{ type: string; text?: string }>
    is_error?: boolean
  }

  session_id?: string
  total_cost_usd?: number
  duration_ms?: number
  duration_api_ms?: number
  id?: string
  result?: string
  is_error?: boolean
  num_turns?: number

  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }

  content_block?: {
    type: string
    text?: string
    id?: string
    name?: string
    input?: string
    thinking?: string
  }

  delta?: {
    type: string
    text?: string
    partial_json?: string
    thinking?: string
  }

  index?: number
}
