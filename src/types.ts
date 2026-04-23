export interface ClaudeCodeConfig {
  provider: string
  cliPath: string
  cwd?: string
  skipPermissions?: boolean
  mcpConfig?: string | string[]
  strictMcpConfig?: boolean
  bridgeOpencodeMcp?: boolean
}

export interface ClaudeCodeProviderSettings {
  cliPath?: string
  cwd?: string
  name?: string
  skipPermissions?: boolean
  mcpConfig?: string | string[]
  strictMcpConfig?: boolean
  /**
   * Auto-translate opencode's `mcp` config block (from opencode.json/jsonc
   * discovered via cwd/OPENCODE_CONFIG/XDG) into a Claude CLI `--mcp-config`
   * file and pass it through on spawn. Defaults to `true` so the CLI sees
   * the same MCP servers opencode is configured with.
   */
  bridgeOpencodeMcp?: boolean
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

export interface ClaudeCodeCallOptions {
  reasoningEffort?: ReasoningEffort
}

/**
 * Claude CLI stream-json message types.
 */
export interface ClaudeStreamMessage {
  type: string
  subtype?: string

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
  request_id?: string
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
