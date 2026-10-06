/**
 * Named permission presets: one option that decides a safety posture, instead
 * of the operator hand-combining `permissionMode`, `skipPermissions`,
 * `proxyTools`, `extraDisallowedTools` and `controlRequestBehavior` and
 * getting one of them wrong.
 *
 * Opt-in. No preset resolves to exactly today's behaviour, byte for byte.
 *
 * ## Why `read-only` is not just a CLI flag
 *
 * Claude Code 2.1.248 added `--restricted`, which removes the built-in tools
 * that run commands or code plus WebFetch, confines the file tools to the
 * working directories, and refuses bypassPermissions. That covers the CLI's
 * own tools and nothing else, and this plugin's whole point is that it puts a
 * second execution path next to them: `proxyTools` defaults to `Bash`, `Edit`,
 * `Write`, `WebFetch` and `Task`, each an MCP tool the CLI calls and opencode
 * executes. `--restricted` never sees those. So the preset has to work at
 * three layers at once:
 *
 *   1. the CLI's own tools (`--restricted`, plus `--disallowedTools` for the
 *      same names so a CLI too old for `--restricted` still refuses them),
 *   2. the opencode proxy (the mutating defs are dropped before the proxy
 *      server is built, so they are never offered),
 *   3. everything left that would prompt (denied, because a bridged MCP
 *      server or a file tool reaching outside the cwd is neither of the
 *      above).
 *
 * ## Measured, on the CLI this was written against (2.1.280)
 *
 * `--restricted --dangerously-skip-permissions` is a hard startup error,
 * `Error: bypassPermissions not supported in restricted mode`, so dropping
 * the skip flag is a correctness requirement and not hygiene. In the binary,
 * `restrictedMode` is a `bypassImmune` circuit breaker, which is the same
 * fact from the other side. A `--restricted` run asked to write a file and
 * run a command reported one `permission_denials` entry (`Write`) and no Bash
 * attempt at all: the shell tool was not in the set to begin with.
 */
import {
  DEFAULT_PROXY_TOOL_NAMES,
  READ_ONLY_PERMISSION_MODE,
  type ClaudeCodeProviderSettings,
  type ControlRequestBehavior,
  type EffectivePermissionMode,
  type PermissionMode,
  type PermissionPreset,
} from "./types.js"

/**
 * Claude Code's own built-in tool names, read out of the 2.1.280 bundle
 * (`rg -a` for `BUILTIN_TOOL_NAMES`), so the disallow list below names real
 * tools rather than plausible ones:
 *
 * Bash, Read, Write, Edit, Glob, Grep, NotebookEdit, WebFetch, WebSearch,
 * Task, TodoWrite, TaskCreate, TaskUpdate, TaskGet, TaskList, TaskStop,
 * Skill, REPL, JavaScript, AskUserQuestion, ToolSearch, SendUserMessage.
 *
 * The ones `read-only` refuses are the four that change this machine (Bash,
 * Write, Edit, NotebookEdit), the two that run code (REPL, JavaScript) and
 * WebFetch, which `--restricted` also strips. `WebSearch` stays: it reads.
 * `Task` stays because a Claude-internal subagent inherits the same
 * restricted tool set; the `task` PROXY def is dropped instead, since an
 * opencode subagent runs in opencode under its own permissions.
 */
export const READ_ONLY_DISALLOWED_CLI_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "REPL",
  "JavaScript",
  "WebFetch",
] as const

/**
 * Proxy tool names `read-only` removes from `proxyTools`, lowercased the way
 * `resolvedProxyTools` matches them. `task_batch` rides along with `task`
 * inside that resolver, so naming `task` alone would not be enough.
 *
 * `question` and `compress` are deliberately absent: neither changes
 * anything. They are dropped anyway in practice, because the preset denies
 * every permission request and an MCP tool prompts, which is documented as a
 * limitation rather than pretended away.
 */
export const READ_ONLY_DENIED_PROXY_TOOLS = new Set([
  "bash",
  "write",
  "edit",
  "webfetch",
  "task",
  "task_batch",
])

/** The options a preset decides, resolved. */
export interface ResolvedPermissionPreset {
  preset: PermissionPreset
  permissionMode: EffectivePermissionMode
  skipPermissions: boolean
  proxyTools: string[]
  extraDisallowedTools: string[]
  controlRequestBehavior: ControlRequestBehavior
  /** Always undefined under a preset: see `overridden` below. */
  controlRequestToolBehaviors: undefined
  /**
   * Operator-set values the preset replaced, as `option: reason` lines, so
   * the caller can warn once per option rather than silently winning.
   */
  overridden: string[]
}

function dedupe(names: Iterable<string>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const trimmed = String(name).trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * What `read-only` resolves to, given the operator's other settings.
 *
 * `proxyTools` is filtered rather than emptied: a name the preset has no
 * quarrel with survives, so listing `Question` still means something.
 * Everything else is replaced outright and reported in `overridden`.
 *
 * `controlRequestToolBehaviors` is dropped rather than merged. A per-tool
 * `allow` only reaches the plugin on a CLI old enough to lack
 * `--permission-prompts none`, because on a newer one the CLI answers the
 * prompt itself and the host is never asked. Honouring it would make the
 * preset mean two different things on two CLI versions, which is the exact
 * failure a preset exists to prevent.
 */
function resolveReadOnly(
  settings: Pick<
    ClaudeCodeProviderSettings,
    | "permissionMode"
    | "skipPermissions"
    | "proxyTools"
    | "extraDisallowedTools"
    | "controlRequestBehavior"
    | "controlRequestToolBehaviors"
  >,
  defaultProxyTools: readonly string[],
): ResolvedPermissionPreset {
  const overridden: string[] = []
  if (settings.permissionMode !== undefined) {
    overridden.push(
      `permissionMode: "${settings.permissionMode}" is dropped; read-only` +
        " sends --restricted instead, which is stricter than every mode" +
        " except plan and incompatible with bypassPermissions",
    )
  }
  if (settings.skipPermissions === true) {
    overridden.push(
      "skipPermissions: forced to false; the CLI exits with" +
        ' "bypassPermissions not supported in restricted mode" when both are' +
        " passed",
    )
  }
  if (settings.controlRequestBehavior === "allow") {
    overridden.push(
      'controlRequestBehavior: forced to "deny"; read-only answers every' +
        " permission request the same way the CLI does under" +
        " --permission-prompts none",
    )
  }
  if (settings.controlRequestToolBehaviors !== undefined) {
    overridden.push(
      "controlRequestToolBehaviors: ignored; a per-tool allow would apply" +
        " only on CLIs older than 2.1.263, so the preset would mean" +
        " different things on different versions",
    )
  }

  const requested = settings.proxyTools ?? defaultProxyTools
  const proxyTools = dedupe(requested).filter(
    (name) => !READ_ONLY_DENIED_PROXY_TOOLS.has(name.toLowerCase()),
  )
  const dropped = dedupe(requested).filter((name) =>
    READ_ONLY_DENIED_PROXY_TOOLS.has(name.toLowerCase()),
  )
  if (dropped.length > 0) {
    overridden.push(
      `proxyTools: dropped ${dropped.join(", ")}; those execute in opencode,` +
        " where no Claude CLI flag reaches them",
    )
  }

  return {
    preset: "read-only",
    permissionMode: READ_ONLY_PERMISSION_MODE,
    skipPermissions: false,
    proxyTools,
    extraDisallowedTools: dedupe([
      ...READ_ONLY_DISALLOWED_CLI_TOOLS,
      ...(settings.extraDisallowedTools ?? []),
    ]),
    controlRequestBehavior: "deny",
    controlRequestToolBehaviors: undefined,
    overridden,
  }
}

/**
 * Resolve `permissionPreset` into the options it decides, or `null` when no
 * preset is configured (the default) so the caller keeps every setting
 * exactly as it found it.
 *
 * An unrecognised name is refused rather than approximated: silently running
 * a typo'd `permissionPreset: "readonly"` at full permissions is the one
 * outcome a safety option must never have. The caller turns `unknown` into a
 * WARN and leaves the settings alone.
 */
export function resolvePermissionPreset(
  settings: ClaudeCodeProviderSettings,
  defaultProxyTools: readonly string[],
): ResolvedPermissionPreset | { unknown: string } | null {
  const preset = settings.permissionPreset
  if (preset === undefined) return null
  if (preset === "read-only") return resolveReadOnly(settings, defaultProxyTools)
  return { unknown: String(preset) }
}

/** Narrow the `resolvePermissionPreset` result without repeating the shape. */
export function isUnknownPreset(
  resolved: ResolvedPermissionPreset | { unknown: string } | null,
): resolved is { unknown: string } {
  return resolved !== null && "unknown" in resolved
}

/** What the diagnostics report about one provider's `permissionPreset`. */
export interface PermissionPresetSummary {
  /** The provider id the setting was read from. */
  provider: string
  /** The configured name, or `"none"` when unset. */
  preset: string
  /** False for `none` and for an unrecognised name, which applies nothing. */
  applied: boolean
  /** Operator settings the preset replaced; empty unless one applied. */
  overrides: string[]
}

/** The name diagnostics print for a provider with no preset configured. */
export const NO_PERMISSION_PRESET = "none"

/**
 * One provider's preset, for the startup block and `/claude-code-doctor`.
 *
 * Recomputed from the provider's own options rather than recorded when
 * `applyPermissionPreset` ran, for two reasons. The doctor deliberately re-runs
 * `collectStartupDiagnostics` on demand instead of reporting a snapshot frozen
 * at startup, and `applyPermissionPreset` runs in `createClaudeCode`, which a
 * session that has not asked for a model yet has never reached: a recorded
 * snapshot would report no preset on a provider that has one configured. The
 * `overrides` strings are the same ones `applyPermissionPreset` logs at NOTICE,
 * because both come out of `resolvePermissionPreset`.
 *
 * Defensive about its input: `options` arrives as an untyped config record, so
 * a preset that is not a string lands in the unknown branch and reads as
 * "configured but not applied" rather than throwing.
 */
export function summarizePermissionPreset(
  provider: string,
  options: unknown,
  defaultProxyTools: readonly string[] = DEFAULT_PROXY_TOOL_NAMES,
): PermissionPresetSummary {
  const settings =
    options !== null && typeof options === "object" && !Array.isArray(options)
      ? (options as ClaudeCodeProviderSettings)
      : ({} as ClaudeCodeProviderSettings)
  const resolved = resolvePermissionPreset(settings, defaultProxyTools)
  if (resolved === null) {
    return { provider, preset: NO_PERMISSION_PRESET, applied: false, overrides: [] }
  }
  if (isUnknownPreset(resolved)) {
    return { provider, preset: resolved.unknown, applied: false, overrides: [] }
  }
  return {
    provider,
    preset: resolved.preset,
    applied: true,
    overrides: resolved.overridden,
  }
}

/**
 * A permission posture as the interactive TUI can hold it (h #g201).
 *
 * The TUI has no `can_use_tool` channel and `--permission-prompts` is
 * print-only, so the headless denier does not exist there. What does:
 * `--restricted` (a 2.1.288 TUI boots with it), `--disallowedTools`, the allow
 * list in `--settings`, and `--permission-mode dontAsk`, which refuses anything
 * not pre-approved WITHOUT a dialog and lets the turn go on. Measured on 2.1.288:
 * `Read` worked, `Write` was "disabled for this session", an MCP call was
 * "Permission denied in don't ask mode", and the turn ended on `end_turn`.
 * A dialog could only be answered with Esc, which ends the turn instead.
 *
 * `read-only` drops every MCP wildcard and every tool the preset refuses from
 * the allow list, so what the headless preset denies is denied here too: the
 * proxy's remaining tools and bridged MCP tools prompt there and are refused,
 * and here they are not pre-approved and are refused. Any other mode is the
 * CLI's own (`plan` included: the TUI offers `ExitPlanMode`, and its approval
 * goes to the operator). Null, never an approximation, when the CLI cannot
 * hold `read-only`: the caller refuses the turn.
 */
export function interactivePermissionPosture(input: {
  permissionMode: string | undefined
  allow: string[]
  supportsReadOnly: boolean
}): { permissionMode: string | undefined; restricted: boolean; allow: string[] } | null {
  if (!isReadOnlyPermissionMode(input.permissionMode)) {
    return { permissionMode: input.permissionMode, restricted: false, allow: input.allow }
  }
  if (!input.supportsReadOnly) return null
  const refused = new Set<string>(READ_ONLY_DISALLOWED_CLI_TOOLS)
  return {
    permissionMode: "dontAsk",
    restricted: true,
    allow: input.allow.filter(
      (rule) => !rule.startsWith("mcp__") && !refused.has(rule.split("(")[0]!.trim()),
    ),
  }
}

/**
 * Whether this spawn's permission mode is the read-only preset's internal
 * token. `buildCliArgs` uses it to decide between `--permission-mode` and the
 * restricted flag set; keeping the comparison here means the token's spelling
 * lives in one place.
 */
export function isReadOnlyPermissionMode(
  mode: string | undefined,
): mode is typeof READ_ONLY_PERMISSION_MODE {
  return mode === READ_ONLY_PERMISSION_MODE
}

/** Re-exported so callers do not have to know it is a `PermissionMode` too. */
export type { PermissionMode }
