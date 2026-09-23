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
  /**
   * Every account the provider expansion produced, so a limited account can
   * offer the others. Set by `providerConfig`, not by the user.
   */
  failoverAccounts?: string[]
  /**
   * The CLI path BEFORE the per-account wrapper substitution, so a failover
   * can build another account's wrapper on top of the same binary. Set by
   * `providerConfig`, not by the user.
   */
  baseCliPath?: string
  accountFailover?: AccountFailoverMode
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
  proxyOpencodeTools?: string[]
  stripContextReminders?: boolean
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
  /** Leave out the skills the Claude session already loads natively. Default true. */
  bridgeSkipNativeSkills?: boolean
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

/**
 * What happens when the account a conversation runs on is out of usage.
 * `"ask"` (default) shows the operator a form listing the other configured
 * accounts and applies the pick inside the same turn; `"off"` keeps today's
 * behaviour, where the turn ends with the rate-limit error.
 */
export type AccountFailoverMode = "ask" | "off"

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
   * Every account the provider expansion produced. Written by the config
   * hook; setting it by hand only limits what a limited account may offer.
   */
  failoverAccounts?: string[]
  /** The CLI path before the per-account wrapper substitution. */
  baseCliPath?: string
  /**
   * When this account is out of usage, show the operator a form listing the
   * other configured accounts and continue the task on the pick, inside the
   * same opencode turn. `"ask"` by default, which only does anything when
   * more than one account is configured. `"off"` keeps the plain rate-limit
   * error. See README "Account failover".
   */
  accountFailover?: AccountFailoverMode
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
   * opencode tools to forward through the proxy by name, on top of the
   * built-in `proxyTools` defs. Empty by default.
   *
   * MCP-backed opencode tools are already routed automatically (see
   * `proxyOpencodeMcpTools`), but that match is `<server>` or
   * `<server>_<tool>`, so a tool another opencode plugin declares directly
   * belongs to no server and is never offered to Claude. opencode-dcp's
   * `compress` is the motivating case: dcp injects "MAX CONTEXT LIMIT
   * REACHED ... You MUST use the `compress` tool now" reminders that the
   * model could not act on, because the tool was never in its list.
   *
   * Names are opencode's tool ids as `client.tool.list()` reports them
   * (matched case-insensitively): `["compress"]`. An unknown name is
   * skipped with a warning. This is an explicit allowlist and never
   * automatic: a forwarded tool executes inside opencode with the calling
   * agent's permissions.
   *
   * A name already held by a proxy def is NOT taken over. Listing
   * `"compress"` here while `proxyTools` also contains `"Compress"` leaves
   * the plugin's own in-process compress in charge and drops the forwarded
   * one with a warning, because the two do different things: the plugin's
   * resets the Claude Code session, opencode's compresses opencode's
   * transcript. Pick one.
   */
  proxyOpencodeTools?: string[]

  /**
   * Remove `<dcp-system-reminder>` blocks from message text when no
   * `compress` tool is being proxied. Off by default.
   *
   * opencode-dcp anchors those reminders into messages, so they are re-sent
   * with every message that carries one. When compress is not reachable
   * they are an instruction the model cannot follow, and the plugin already
   * tells it to ignore them in the appended system prompt. Turning this on
   * stops paying for them as well. It is inert whenever `compress` is
   * proxied (via either `proxyTools` or `proxyOpencodeTools`), since the
   * reminder is then something the model can actually act on.
   */
  stripContextReminders?: boolean

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
   * `webfetch` → 10 min (matches Claude CLI's Bash ceiling); `task` and
   * `task_batch` → no deadline (the call waits for the subagent; abandoned
   * calls are released by aborts, the next user turn, and the process going
   * away); `question` → 30 min (operator AFK). A positive value here replaces
   * the default for that tool, `0` disables its deadline, and a negative or
   * non-finite value is ignored.
   *
   * For `bash` specifically the call's own `input.timeout` is honoured on
   * top: the effective deadline is `max(resolved, input.timeout)`, so a
   * long build the caller explicitly asked to run is never undercut, and a
   * positive `input.timeout` restores a deadline that `bash: 0` disabled.
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
   * inactivity following a completed turn. Off unless set. The timer
   * starts when a turn completes (not at spawn), starting another turn cancels
   * it, a worker found mid-turn when it fires is left alone and re-timed, and
   * the Claude session id is retained for a transparent resume. Omit or set 0
   * to keep workers until LRU eviction (16 processes). Interactive transport is
   * excluded because it does not currently guarantee session-id resume.
   */
  idleProcessTimeoutMs?: number
  /**
   * Expose your opencode skills to Claude Code's native Skill tool by staging
   * them as a session-scoped `--plugin-dir`, so a `Skill("<name>")` call for a
   * skill opencode advertises does not fail with `Unknown skill`. Covers every
   * root opencode itself reads: project `.opencode/`, `.claude/` and `.agents/`
   * walking up from the workspace, the opencode config dirs, and the global
   * `~/.claude/skills` and `~/.agents/skills` (those last two behind the same
   * `OPENCODE_DISABLE_EXTERNAL_SKILLS` / `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`
   * switches opencode honours).
   *
   * Off by default: every bridged skill is also listed in the system prompt
   * opencode forwards, so a large skill set costs prompt tokens twice per turn.
   * When on it applies to the headless, interactive and direct `doGenerate`
   * spawns alike; compaction never loads it, and the bundled configuration
   * skill is staged either way. No-op on CLIs without `--plugin-dir`.
   */
  bridgeOpencodeSkills?: boolean

  /**
   * Leave a skill unbridged when the Claude Code session already loads it:
   * from `<CLAUDE_CONFIG_DIR>/skills` (`~/.claude/skills` by default), from the
   * project's own `.claude/skills`, or from an installed plugin's `skills/`.
   * On by default, because those roots overlap opencode's and the duplicate
   * costs prompt tokens on every turn for nothing.
   *
   * A skill is treated as already loaded when it is literally the same
   * directory (symlinks resolved), when its SKILL.md is byte-identical to a
   * native one, or when a *different* skill of the same name is registered
   * under user or project scope. That last case is the only one that changes
   * behaviour, because `Skill("<name>")` then answers from Claude's copy
   * rather than opencode's, so it is logged at WARN naming both paths. Plugin
   * skills are namespaced `<plugin>:<name>` and so only ever match by content.
   *
   * Set `false` to bridge everything regardless, which restores the pre-0.25
   * behaviour of advertising a shared skill twice.
   */
  bridgeSkipNativeSkills?: boolean

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
   * `--mcp-config`. Routing through the proxy keeps a single execution site
   * (opencode), so the call is permission-prompted and rendered as an
   * opencode tool call instead of running inside Claude CLI's own MCP child.
   *
   * Defaults to `false`, and that is a change of default rather than of
   * behaviour. It used to default to `true` while routing nothing at all:
   * discovery read `client.tool.list()`, which enumerates opencode's tool
   * registry (built-ins plus plugin-declared tools) and has never contained
   * an MCP tool, so no def was ever built. Discovery now reads the model tool
   * set opencode passes the provider, which is where MCP tools actually live,
   * so the option works. Leaving it on by default would then have silently
   * moved every existing user's MCP traffic off the direct bridge that is
   * carrying it today, so switching over is the operator's call.
   *
   * Two things to know before enabling it:
   *
   * - It only affects the servers this plugin bridges. If the same server is
   *   also registered in Claude Code's own config, Claude reaches it directly
   *   and the proxy is bypassed. Pair this with `strictMcpConfig: true` so
   *   Claude sees only the config this plugin writes.
   * - A routed call executes inside opencode with the calling agent's
   *   permissions, the same trade `proxyOpencodeTools` makes.
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
