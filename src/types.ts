import type { LogLevel, LogMode } from "./logger"

export type { LogLevel, LogMode }

export interface ClaudeCodeConfig {
  provider: string
  cliPath: string
  /** Drive interactive claude (subscription) instead of headless --print. */
  interactive?: boolean
  /** Deprecated/no-op with interactive: Claude Code's TUI requires manual confirmation for bypassPermissions. */
  interactiveBypass?: boolean
  /** With interactive: built-in tools to allow without prompting (replaces
   *  the default Bash/Edit/Write/Read/WebFetch list; MCP wildcards are always
   *  derived from the bridged config). */
  interactiveAllowTools?: string[]
  /** With interactive: append this plugin's own prompts via --append-system-prompt-file. Defaults to true. */
  interactiveSystemPrompt?: boolean
  cwd?: string
  account?: string
  configDir?: string
  providerID?: string
  skipPermissions?: boolean
  permissionMode?: PermissionMode
  mcpConfig?: string | string[]
  strictMcpConfig?: boolean
  bridgeOpencodeMcp?: boolean
  controlRequestBehavior?: ControlRequestBehavior
  controlRequestToolBehaviors?: Record<string, ControlRequestBehavior>
  controlRequestDenyMessage?: string
  proxyTools?: string[]
  extraDisallowedTools?: string[]
  proxyToolTimeoutMs?: Record<string, number>
  /**
   * Route `ExitPlanMode` through opencode's native `question` tool so plan
   * approval is a real form instead of a "(yes/no)" line the operator has to
   * answer in prose. Off by default because it cannot currently fire: headless
   * `--print` is not offered an `ExitPlanMode` tool at all, and this bridge
   * keys on that tool call. See the plan-mode gotcha in AGENTS.md.
   */
  planModeQuestion?: boolean
  webSearch?: WebSearchRouting
  hotReloadMcp?: boolean
  proxyOpencodeMcpTools?: boolean
  multiStepContinuation?: boolean
  autoContinueIncompleteTurns?: boolean | "smart"
  compactionModel?: string
  ignoreAnthropicApiKey?: boolean
  /** Kill an idle headless Claude worker after this many milliseconds. */
  idleProcessTimeoutMs?: number
  /** Stage opencode skills as a `--plugin-dir` so Claude's Skill tool can run them. */
  bridgeOpencodeSkills?: boolean
  /** Append a one-line cost / duration / cache footer to each finished turn. */
  turnStats?: boolean
  logging?: LoggingConfig
}

export interface LoggingConfig {
  /**
   * Persist log activity (DEBUG / INFO / NOTICE / WARN / ERROR — those
   * passing `level`) to a file. Default: `false`. When `false`, entries
   * below WARN vanish entirely; WARN / ERROR still surface in the TUI via
   * stderr. Set to `true` to capture the audit trail to disk for review
   * via `tail` / `grep`.
   */
  file?: boolean
  /**
   * Optional custom directory for the file log. Defaults to
   * `~/.local/share/opencode-claude-code/`. Has no effect when `file:false`.
   */
  dir?: string
  /**
   * TUI policy. `"silent"` (default) routes DEBUG / INFO / NOTICE to file
   * only; WARN / ERROR still bubble in the TUI as they always do. `"debug"`
   * additionally echoes every emitted level to stderr (which opencode's TUI
   * surfaces as warning bubbles).
   */
  mode?: LogMode
  /**
   * Minimum level to emit anywhere. Anything below the threshold is dropped
   * before either destination decides what to do. Order:
   * `debug` < `info` < `notice` < `warn` < `error`. Default: `"info"`.
   */
  level?: LogLevel
}

export type WebSearchRouting = "claude" | "disabled" | (string & {})

export interface ClaudeCodeProviderSettings {
  cliPath?: string
  /** Drive interactive claude (subscription) instead of headless --print. */
  interactive?: boolean
  /** Deprecated/no-op with interactive: Claude Code's TUI requires manual confirmation for bypassPermissions. */
  interactiveBypass?: boolean
  /** With interactive: built-in tools to allow without prompting (replaces
   *  the default Bash/Edit/Write/Read/WebFetch list; MCP wildcards are always
   *  derived from the bridged config). */
  interactiveAllowTools?: string[]
  /** With interactive: append this plugin's own prompts via --append-system-prompt-file. Defaults to true. */
  interactiveSystemPrompt?: boolean
  cwd?: string
  name?: string
  providerID?: string
  account?: string
  configDir?: string
  accounts?: string[]
  /**
   * Model that subagents run on when their own definition pins nothing.
   * Unset means no implicit override at all, so an agent keeps inheriting the
   * caller's model exactly as opencode intends. See `src/agent-models.ts`.
   */
  defaultSubagentModel?: string
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

  /**
   * Proxy these Claude built-in tools through opencode instead of letting the
   * CLI execute them directly. When a tool is listed here, the plugin:
   *   - passes `--disallowedTools <ClaudeName>` to the CLI, and
   *   - exposes an equivalent tool via an in-process HTTP MCP server named
   *     `opencode_proxy`. Claude calls the MCP tool, which blocks on
   *     opencode's tool executor (with its native permission UI) and returns
   *     the result.
   *
    * Supported: `bash`, `write`, `edit`, `webfetch`, `task`, `question`. Leave empty or unset to disable proxying.
    *
    * `task` proxies Claude CLI's `Agent` (subagent dispatch) tool through
    * opencode's `task` tool, so subagent calls run under opencode's
    * configured subagent set (build/general/custom) with opencode's
    * permission and lifecycle handling, instead of Claude CLI's
    * internal-only general-purpose / Explore / Plan options. The calling
    * agent must have `permission.task: allow` for the target subagent
    * (see opencode's agent docs).
    *
    * `question` proxies Claude CLI's `AskUserQuestion` through opencode's
    * native `question` tool (TUI form with options + custom answer). The
    * calling agent must have `permission.question: allow`. Version-gated:
    * silently dropped on opencode builds that lack the `question` registry
    * entry, in which case the deny/markdown fallback applies.
    */
  proxyTools?: string[]

  /**
   * Extra Claude Code built-ins to switch off with `--disallowedTools`,
   * on top of the ones implied by `proxyTools`.
   *
   * `proxyTools` can only disable built-ins the plugin knows how to
   * replace, so a built-in with no proxy equivalent (`NotebookEdit`, and
   * anything Claude Code adds after this release) has no off switch
   * otherwise. Names are Claude's, not opencode's: `["NotebookEdit"]`.
   *
   * Disabling a tool with no replacement removes the capability rather
   * than routing it through opencode — that is the point, but it does mean
   * the model has to work without it.
   */
  extraDisallowedTools?: string[]

  /**
   * Per-tool proxy call timeouts in milliseconds, keyed by the proxy tool
   * name (`bash`, `edit`, `write`, `webfetch`, `task`, `question` —
   * case-insensitive). When a proxied tool call waits longer than its
   * deadline for opencode to resolve it, the call is rejected and Claude
   * receives a timeout error.
   *
   * Defaults (used when a tool is absent here): `bash`/`edit`/`write`/
   * `webfetch` → 10 min (matches Claude CLI's Bash ceiling); `task` →
   * 60 min (subagents routinely run 20–40 min); `question` → 30 min
   * (operator AFK). Setting a key here replaces the default for that tool.
   *
   * For `bash` specifically the call's own `input.timeout` is honoured on
   * top: the effective deadline is `max(resolved, input.timeout)`, so a
   * long build the caller explicitly asked to run is never undercut.
   */
  proxyToolTimeoutMs?: Record<string, number>

  /**
   * Route Claude's `ExitPlanMode` through opencode's native `question` tool.
   *
   * Off (default): the plan is rendered as markdown followed by
   * `**Do you want to proceed with this plan?** (yes/no)` and the operator
   * answers in prose. On: the plan is rendered, the turn ends on
   * `tool-calls`, and opencode runs its own `question` tool so approval is a
   * real form; the answer is fed back to the CLI as the `tool_result` for
   * the original `ExitPlanMode` call, which is what unlocks plan mode.
   *
   * Opt-in, and currently dormant. The delivery surface works: opencode's
   * `question` form renders and round-trips (verified 2026-09-06, correcting
   * an earlier claim here that it was broken upstream). What does not work is
   * the trigger: headless `--print` does not offer the model an
   * `ExitPlanMode` tool, measured on CLI 2.1.258, so the bridge has nothing
   * to key on and the text path is what you get. Older opencode builds also
   * have no `question` registry entry, in which case the plugin silently
   * keeps the text path. Re-run the probes in AGENTS.md on a newer CLI before
   * assuming the bridge is reachable.
   */
  planModeQuestion?: boolean

  /**
   * Strip `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from the environment of
   * every spawned `claude` process. When an API key is present, Claude Code
   * authenticates with it (pay-as-you-go Console billing) instead of the
   * logged-in Pro/Max subscription — silently bypassing the Agent SDK plan
   * credit. Set this to `true` to force the CLI to fall back to its stored
   * subscription auth. Defaults to `false` (the key is passed through, so
   * deliberate API-key users are unaffected). Regardless of this setting, the
   * plugin logs a one-time warning at startup when an API key is detected.
   */
  ignoreAnthropicApiKey?: boolean

  /**
   * Kill a retained headless Claude worker after this many milliseconds of
   * inactivity following a completed turn. Starting another turn cancels the
   * timer, and the Claude session id is retained for a transparent resume.
   * Omit or set to 0 to keep workers until LRU eviction. Interactive transport
   * is excluded because it does not currently guarantee session-id resume.
   */
  idleProcessTimeoutMs?: number
  /**
   * Expose your opencode skills (`.opencode/skills`, `~/.config/opencode/skills`)
   * to Claude Code's native Skill tool by staging them as a session-scoped
   * `--plugin-dir`. Off by default: every bridged skill is also listed in the
   * system prompt opencode already forwards, so a large skill set is paid for
   * twice per turn. Turn it on when the model tries `Skill("<name>")` and gets
   * `Unknown skill`. No-op on CLIs without `--plugin-dir`.
   */
  bridgeOpencodeSkills?: boolean

  /**
   * Append one compact line to the end of every finished (non-compaction,
   * non-error) turn with what that turn cost: dollars, wall duration, how many
   * internal CLI turns it took, and input / output / cache-read / cache-write
   * tokens. It is rendered as its own text part led by `▌ **stats:**` and is
   * stripped again from any transcript rebuilt for the CLI, so the model never
   * reads its own accounting.
   *
   * Off by default, because a cost line under every reply is a preference.
   * The same numbers are logged at INFO regardless of this setting, and
   * `total_cost_usd`, `duration_ms`, `usage`, `modelUsage` and
   * `permission_denials` always reach `providerMetadata`.
   */
  turnStats?: boolean

  /**
   * Routing for Claude's built-in `WebSearch` tool.
   *
   * - `"claude"` (default): Claude CLI runs WebSearch internally via
   *   Anthropic's web search. No MCP setup required, no extra cost.
   * - `"<opencode-tool-name>"` (e.g. `"websearch_web_search_exa"`): forward
   *   the call to that opencode-side tool with `executed:false`. Requires
   *   the corresponding MCP server to be configured in opencode.
   * - `"disabled"`: prevent the model from calling WebSearch entirely
   *   (passes `WebSearch` via `--disallowedTools`).
   */
  webSearch?: WebSearchRouting

  /**
   * Detect mid-session opencode MCP config changes and respawn the
   * underlying claude process so newly enabled / disabled MCPs become
   * visible to the model without restarting opencode or starting a new
   * chat. Eviction happens at the start of the next user turn (never mid
   * tool-call) and the session id is preserved for `--resume` so the conversation
   * continues seamlessly. Defaults to `true`.
   *
   * Set to `false` to keep the previous behavior (cached subprocess
   * survives MCP changes until the chat is reset).
   */
  hotReloadMcp?: boolean

  /**
   * Route opencode MCP server tools through the in-process `opencode_proxy`
   * MCP server instead of bridging them directly into Claude CLI's
   * `--mcp-config`. With both layers configured for the same MCP server,
   * direct bridging causes each tool invocation to execute twice — once by
   * Claude CLI's own MCP child process and once by opencode. Routing through
   * the proxy keeps a single execution site (opencode) while preserving the
   * tool-call/result surface in opencode's UI and its permission prompts.
   *
   * Defaults to `true`. Set to `false` to restore the prior direct-bridge
   * behavior (Claude CLI executes MCP tools itself; opencode also re-executes
   * — accept the duplication if you need Claude to invoke the tool without
   * an opencode round-trip).
   */
  proxyOpencodeMcpTools?: boolean

  /**
   * Append a short system-prompt hint that nudges Claude to chain
   * multiple tool calls within a single turn instead of pausing for user
   * confirmation between subtasks. Each turn boundary in opencode
   * requires the user to manually press "continue" to resume, so for
   * multi-step tasks this option reduces friction. Defaults to `true`.
   *
   * Set to `false` if you prefer the un-nudged model behavior (Claude
   * decides when to end the turn entirely on its own).
   */
  multiStepContinuation?: boolean

  /**
   * Smartly continue incomplete Claude CLI results inside the same opencode
   * turn. Claude CLI sometimes emits `result` after reasoning/tool activity
   * without a useful final answer, which makes opencode stop and wait for the
   * user to type "continue". With the default `"smart"`, the plugin detects
   * those incomplete result boundaries, feeds Claude a small continuation
   * message internally, and keeps the opencode stream open. Final answers,
   * questions, blockers, errors, aborts, and safety-budget exhaustion still
   * stop normally.
   *
   * Set to `false` to disable.
   */
  autoContinueIncompleteTurns?: boolean | "smart"

  /**
   * Model id used when opencode invokes `/compact`. Defaults to
   * `claude-haiku-4-5` — fast, cheap, strong structured summarizer. Set
   * to override per-project in `opencode.json` / `opencode.jsonc`; the
   * `CLAUDE_CODE_COMPACTION_MODEL` env var overrides this in turn for
   * one-off runs without editing config.
   */
  compactionModel?: string

  /**
   * Logger configuration. See `LoggingConfig` for fields. Env vars
   * (`OPENCODE_CLAUDE_CODE_LOG_FILE`, `OPENCODE_CLAUDE_CODE_LOG_DIR`,
   * `OPENCODE_CLAUDE_CODE_LOG_LEVEL`, `DEBUG=opencode-claude-code`) override
   * these values when explicitly set, so a developer can flip behavior for
   * one process without editing opencode.jsonc.
   */
  logging?: LoggingConfig
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

  // Fast mode, reported on both `system`/`init` and `result`. `off` with a
  // reason is how a request that asked for fast mode but did not get it shows
  // up: the CLI degrades to standard speed rather than failing, so without
  // reading these the downgrade is invisible. `cooldown` is the post-rate-limit
  // state and is temporary.
  fast_mode_state?: "on" | "off" | "cooldown"
  fast_mode_disabled_reason?: string

  // Present on `stream_event` envelopes when --include-partial-messages is on.
  // The inner event mirrors the same shape (content_block_*, message_*, etc).
  event?: ClaudeStreamMessage

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
      /** On a `tool_result` block: the CLI-executed tool failed. */
      is_error?: boolean
    }>
  }

  // `system`/`init` fields. Read by `reportSystemInit` in `cli-events.ts`;
  // shapes confirmed against the CLI's own zod schemas on 2.1.263.
  apiKeySource?: string
  permissionMode?: string
  model?: string
  claude_code_version?: string
  tools?: string[]
  mcp_servers?: Array<{ name?: string; status?: string }>

  // `system`/`compact_boundary`. The stream schema emits `compact_metadata`;
  // the CLI's own transcript reader uses `compactMetadata`.
  compact_metadata?: Record<string, unknown>
  compactMetadata?: Record<string, unknown>

  // `rate_limit_event`. See `RateLimitInfo` in `cli-events.ts`.
  rate_limit_info?: Record<string, unknown>

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
  stop_reason?: string | null

  /**
   * Per-model totals on `result`, keyed by model id: `inputTokens`,
   * `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`,
   * `webSearchRequests`, `costUSD`. All numeric, which is what makes it safe
   * to forward whole into `providerMetadata`.
   */
  modelUsage?: Record<string, Record<string, number>>
  /**
   * Tool calls the CLI's permission layer refused during the turn. Each entry
   * also carries a `tool_input` on the wire; it is deliberately not declared
   * here, because it can be a whole file's contents and must not be copied
   * into provider metadata.
   */
  permission_denials?: Array<{
    tool_name?: string
    tool_use_id?: string
  }>

  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    iterations?: Array<{
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }>
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
