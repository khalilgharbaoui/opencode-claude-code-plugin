/**
 * Per-agent model resolution.
 *
 * opencode's agent config cannot express "inherit the account, choose the
 * model". A subagent that omits `model` inherits the invoking agent's WHOLE
 * model string, and one that pins `model` inherits neither half, so pinning
 * Opus also pins the account it was written with. That is the wrong trade on a
 * machine with more than one Claude account: the worker should follow whoever
 * invoked it and still run on the model the job needs.
 *
 * The account is not part of the model id this class sees. It lives in the
 * provider (`claude-code-<account>`), which selects CLAUDE_CONFIG_DIR at spawn
 * time, and in an `@<account>` marker riding on the id for non-default
 * accounts (see `parseModelId` in models.ts). So swapping the model NAME while
 * preserving that marker changes the model and nothing else, which is exactly
 * the gap in the config schema.
 *
 * Declaring it: an agent markdown file says `forceModel: <id>`, or the
 * `defaultSubagentModel` provider option covers every subagent at once.
 * Nothing needs a per-agent entry in opencode.json.
 *
 * The same file can state `reasoningEffort:`, which beats the effort opencode
 * inherited from the caller's picker (see `resolveAgentEffort`), and
 * `cacheTtl:`, which sets the prompt cache TTL of the agent's own `claude`
 * process (see `resolveAgentCacheTtl`). Model, effort and cache TTL together
 * are what a turn costs, so all three belong with the agent.
 *
 * Two deliberate silences, because this rewrites what a user's model picker
 * said it would run:
 *
 *   - With `defaultSubagentModel` unset there is NO implicit override. An
 *     existing setup upgrading the plugin behaves exactly as before, instead
 *     of quietly moving somebody's cheap subagent onto an expensive model.
 *   - Only agents this plugin discovered are eligible. opencode's built-ins
 *     (`explore`, `general`, `compaction`, ...) are never in the registry, so
 *     they are never rewritten.
 */
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { log } from "./logger.js"
import { defaultModels } from "./models.js"

/** Directory names opencode reads agent markdown from, current form first. */
export const AGENT_DIR_NAMES = ["agents", "agent"]

/**
 * Prompt cache TTLs the Claude CLI accepts for the main conversation.
 *
 * Measured on 2.1.280: an unrecognised value is not an error, the CLI just
 * falls back to its automatic default, so a typo would be silent. Refusing it
 * here buys the operator a WARN naming the agent instead.
 */
const PROMPT_CACHE_TTLS = ["5m", "1h"]

/** Levels the Claude CLI accepts; anything else is refused, not forwarded. */
const REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

export type AgentRecord = {
  mode?: string
  /** A fully-qualified `provider/model` the agent pinned for itself. */
  model?: string
  /** Model NAME this agent wants, on whatever account the caller is using. */
  forceModel?: string
  /** Thinking budget this agent wants, whatever the caller's picker says. */
  reasoningEffort?: string
  /**
   * Prompt cache TTL for this agent's own `claude` process, `5m` or `1h`.
   * See `resolveAgentCacheTtl` for why this is a main-conversation setting
   * and not the CLI's per-agent `experimental.cacheTtl`.
   */
  cacheTtl?: string
  /**
   * Models to try, in order, when the one this agent would have run is
   * refused. Same account throughout; see `src/model-fallback.ts`.
   */
  fallbackModels?: string[]
  /**
   * The agent's own prompt as the operator wrote it: the markdown body, or
   * `prompt` in opencode.json. Read only by `interactiveUserInstructions`.
   */
  prompt?: string
}

let registry: Record<string, AgentRecord> = {}
let defaultSubagentModel: string | undefined
let defaultSubagentCacheTtl: string | undefined
let providerFallbackModels: string[] = []

export function setAgentRegistry(records: Record<string, AgentRecord>): void {
  registry = records
}

export function getAgentRegistry(): Record<string, AgentRecord> {
  return registry
}

/** `undefined` (the default) means no implicit override for any agent. */
export function setDefaultSubagentModel(model: string | undefined): void {
  defaultSubagentModel = model?.trim() || undefined
}

export function getDefaultSubagentModel(): string | undefined {
  return defaultSubagentModel
}

/**
 * The prompt cache TTL every discovered subagent falls back to. `undefined`
 * (the default) means the plugin sets nothing and the CLI keeps deciding.
 */
export function setDefaultSubagentCacheTtl(ttl: string | undefined): void {
  defaultSubagentCacheTtl = ttl?.trim() || undefined
}

export function getDefaultSubagentCacheTtl(): string | undefined {
  return defaultSubagentCacheTtl
}

/**
 * The chain every agent that declares none falls back along. Empty (the
 * default) means no chain at all, for the same reason `defaultSubagentModel`
 * is unset by default: an upgrade must not silently start running somebody's
 * turns on a model they did not pick.
 */
export function setProviderFallbackModels(models: string[] | undefined): void {
  providerFallbackModels = models ?? []
}

export function getProviderFallbackModels(): string[] {
  return providerFallbackModels
}

export function _resetAgentRegistryForTests(): void {
  registry = {}
  defaultSubagentModel = undefined
  defaultSubagentCacheTtl = undefined
  providerFallbackModels = []
}

/** `claude-opus-5-fast@work` -> `@work`; a default-account id has none. */
function accountMarker(modelId: string): string {
  const at = modelId.indexOf("@")
  return at === -1 ? "" : modelId.slice(at)
}

function withoutAccountMarker(modelId: string): string {
  const at = modelId.indexOf("@")
  return at === -1 ? modelId : modelId.slice(0, at)
}

/**
 * A declared model NAME, turned into an id that can be spawned on the
 * caller's account, or null when the plugin does not know that model.
 *
 * The two halves are the whole contract every declaration in this file obeys.
 * A name carrying its own `@account` would be forcing an account, which is
 * the thing these overrides exist to avoid, so the marker is taken from the
 * id the request arrived with and never from the declaration. And a name that
 * is not in the model registry is refused rather than forwarded, because the
 * alternative is spawning the CLI with a `--model` it rejects on a turn
 * someone is waiting for.
 *
 * Shared with `src/model-fallback.ts`: a fallback chain entry has exactly the
 * same two requirements as a `forceModel`, and one of them failing silently
 * in only one of the two places is how they would drift.
 */
export function qualifyModelName(
  wanted: string,
  referenceModelId: string,
): string | null {
  const base = withoutAccountMarker(wanted.trim())
  if (!base || !Object.hasOwn(defaultModels, base)) return null
  return `${base}${accountMarker(referenceModelId)}`
}

/**
 * The model a request should actually spawn with.
 *
 * Order, first match wins:
 *   1. The agent declared `forceModel`.
 *   2. The agent is a discovered subagent and `defaultSubagentModel` is set.
 *   3. Anything else: the id opencode asked for, untouched.
 *
 * An agent that pinned a full `provider/model` is out of scope entirely:
 * opencode already routed the call to that provider, and second-guessing it
 * here would silently undo a choice the user made explicitly.
 *
 * Fails closed. An id that is not in the model registry is refused and the
 * original kept, because the alternative is spawning the CLI with a `--model`
 * it will reject, on a turn someone is waiting for.
 */
export function resolveAgentModel(
  agent: string | undefined,
  modelId: string,
  overrides?: {
    records?: Record<string, AgentRecord>
    defaultSubagentModel?: string
  },
): string {
  if (!agent) return modelId

  const record = (overrides?.records ?? registry)[agent]
  if (!record) return modelId
  if (record.model?.includes("/")) return modelId

  const fallback = overrides
    ? overrides.defaultSubagentModel
    : defaultSubagentModel
  const declared = record.forceModel?.trim()
  const wanted =
    declared || (record.mode === "subagent" ? fallback : undefined)
  if (!wanted) return modelId

  const resolved = qualifyModelName(wanted, modelId)
  if (!resolved) {
    log.warn("agent model override refused: unknown model", {
      agent,
      wanted: withoutAccountMarker(wanted),
      keeping: modelId,
    })
    return modelId
  }

  if (resolved !== modelId) {
    log.debug("agent model override", { agent, from: modelId, to: resolved })
  }
  return resolved
}

/**
 * The thinking budget a request should actually spawn with.
 *
 * opencode resolves one effort for the whole session (the model picker's
 * selector, or a variant), and a subagent inherits it. That inheritance is
 * wrong in the expensive direction: a caller who picked `max` for their own
 * turn silently hands `max` to every worker it dispatches, so a mechanical
 * lane runs at the most costly setting available and burns a weekly cap that
 * the caller never spent on the work in front of them.
 *
 * An agent that states its own budget wins. Same reasoning as `forceModel`:
 * the declaration lives with the agent, so a file on disk is the whole
 * configuration and the caller's picker stays a choice about the caller.
 *
 * Unknown values are ignored rather than passed on, since the CLI refuses a
 * level it does not recognise and the turn would die at spawn.
 */
export function resolveAgentEffort(
  agent: string | undefined,
  inherited: string | undefined,
  overrides?: { records?: Record<string, AgentRecord> },
): string | undefined {
  if (!agent) return inherited

  const record = (overrides?.records ?? registry)[agent]
  const declared = record?.reasoningEffort?.trim()
  if (!declared) return inherited

  if (!REASONING_EFFORTS.includes(declared)) {
    log.warn("agent effort override refused: unknown level", {
      agent,
      wanted: declared,
      keeping: inherited,
    })
    return inherited
  }

  if (declared !== inherited) {
    log.debug("agent effort override", {
      agent,
      from: inherited,
      to: declared,
    })
  }
  return declared
}

/**
 * The prompt cache TTL a request should actually spawn with, or `undefined`
 * to leave the CLI's own default alone.
 *
 * Why this is a MAIN-conversation setting. Claude Code has a per-agent
 * `experimental.cacheTtl` in agent-definition frontmatter, and it is useless
 * here: it only applies to subagents the CLI itself runs through its `Task`
 * tool, and this plugin disallows that tool by default (`Task` is in
 * `DEFAULT_PROXY_TOOL_NAMES`) so opencode can run the subagent instead. An
 * opencode subagent arrives as its own `doStream` and its own `claude
 * --print` process, which the CLI counts as a main conversation, not a
 * subagent. Measured on 2.1.280: `CLAUDE_CODE_PROMPT_CACHE_TTL=5m` moves a
 * `-p` turn's writes to `ephemeral_5m_input_tokens`, while
 * `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=5m` leaves them at 1h. So the
 * main-conversation knob is the one that reaches every process this plugin
 * spawns, and the subagent knob reaches none of them.
 *
 * Why an operator wants it per agent. The CLI's automatic default is 1 hour
 * on a subscription, and a 1-hour cache write is billed above a 5-minute one.
 * A long-lived main session re-reads that cache and comes out ahead; a fan-out
 * of short subagents writes a 1-hour cache each and never reads it again,
 * which is pure cost against the same weekly limit. Declaring `cacheTtl: 5m`
 * on the workers while the main session keeps 1h is the whole point.
 *
 * Order, first match wins, mirroring `resolveAgentModel`:
 *   1. The agent declared `cacheTtl`.
 *   2. The agent is a discovered subagent and `defaultSubagentCacheTtl` is set.
 *   3. Anything else: nothing, and the CLI decides as it always did.
 *
 * Unknown values are refused rather than forwarded, for the same reason as
 * `resolveAgentEffort`: see `PROMPT_CACHE_TTLS`.
 */
export function resolveAgentCacheTtl(
  agent: string | undefined,
  overrides?: {
    records?: Record<string, AgentRecord>
    defaultSubagentCacheTtl?: string
  },
): string | undefined {
  if (!agent) return undefined

  const record = (overrides?.records ?? registry)[agent]
  if (!record) return undefined

  const fallback = overrides
    ? overrides.defaultSubagentCacheTtl
    : defaultSubagentCacheTtl
  const declared = record.cacheTtl?.trim()
  const wanted =
    declared || (record.mode === "subagent" ? fallback?.trim() : undefined)
  if (!wanted) return undefined

  if (!PROMPT_CACHE_TTLS.includes(wanted)) {
    log.warn("agent prompt cache ttl refused: unknown value", {
      agent,
      wanted,
      allowed: PROMPT_CACHE_TTLS.join(", "),
    })
    return undefined
  }

  log.debug("agent prompt cache ttl", { agent, ttl: wanted })
  return wanted
}

/**
 * Read the fields that matter out of an agent markdown file's YAML
 * frontmatter. Hand-parsed rather than pulling a YAML dependency in for four
 * scalars and one list, and deliberately top-level only: `permission:` has
 * nested keys (`bash:`, `edit:`) that must not be mistaken for agent fields.
 *
 * `fallbackModels` is the one list, and it accepts both YAML spellings,
 * because a person writing an agent file will reach for either:
 *
 *   fallbackModels: [claude-opus-5, claude-sonnet-5]
 *   fallbackModels:
 *     - claude-opus-5
 *     - claude-sonnet-5
 *
 * The block form is the reason this loop tracks a key across lines at all.
 * Its items are consumed only while they keep the `- item` shape, so the
 * next `key:` line ends the list exactly as YAML would.
 */
export function parseAgentFrontmatter(text: string): AgentRecord {
  const record: AgentRecord = {}
  if (!text.startsWith("---")) return record

  const lines = text.split(/\r?\n/)
  let listKey: "fallbackModels" | null = null
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === "---") break

    if (listKey) {
      const item = /^[ \t]*-[ \t]+(.*)$/.exec(line)
      if (item) {
        const value = item[1].trim().replace(/^["']|["']$/g, "")
        if (value) (record[listKey] ??= []).push(value)
        continue
      }
      listKey = null
    }

    const match = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line)
    if (!match) continue

    const key = match[1]
    const value = match[2].trim().replace(/^["']|["']$/g, "")

    if (key === "fallbackModels") {
      if (value) record.fallbackModels = parseFallbackModelList(value)
      else listKey = "fallbackModels"
      continue
    }

    if (!value) continue
    if (key === "mode") record.mode = value
    else if (key === "model") record.model = value
    else if (key === "forceModel") record.forceModel = value
    else if (key === "reasoningEffort") record.reasoningEffort = value
    else if (key === "cacheTtl") record.cacheTtl = value
  }

  return record
}

/**
 * An agent file's body, which opencode uses as that agent's prompt: what
 * follows the frontmatter, trimmed, or undefined when there is none.
 */
export function agentMarkdownBody(text: string): string | undefined {
  if (!text.startsWith("---")) return text.trim() || undefined
  const lines = text.split(/\r?\n/)
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (close === -1) return undefined
  return lines.slice(close + 1).join("\n").trim() || undefined
}

/**
 * A declared fallback list, from frontmatter, from opencode.json's `agent`
 * block, or from the provider options. Accepts the three shapes a person
 * actually writes: a YAML/JSON array, a comma or whitespace separated string,
 * and the inline bracket form `[a, b]`, which the line-based frontmatter
 * parser above hands over as one string.
 */
export function parseFallbackModelList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean)
  }
  if (typeof value !== "string") return []
  return value
    .trim()
    .replace(/^\[|\]$/g, "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
}

/**
 * Discover agents from markdown on disk. opencode merges these into its own
 * registry, but whether they reach a plugin's config hook is not documented,
 * so they are read directly rather than assumed.
 */
export async function readAgentMarkdownRecords(
  directories: string[],
): Promise<Record<string, AgentRecord>> {
  const records: Record<string, AgentRecord> = {}

  for (const directory of directories) {
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue

      const name = entry.slice(0, -3)
      if (records[name]) continue

      try {
        const text = await readFile(path.join(directory, entry), "utf8")
        records[name] = parseAgentFrontmatter(text)
        const prompt = agentMarkdownBody(text)
        if (prompt) records[name].prompt = prompt
      } catch (err) {
        log.debug("failed to read agent markdown", {
          file: path.join(directory, entry),
          error: String(err),
        })
      }
    }
  }

  return records
}

/**
 * Every directory opencode would read agent markdown from, project before
 * global so a project agent of the same name wins, as opencode resolves them.
 */
export function agentDirectories(
  home: string | undefined,
  projectDirectory: string | undefined,
): string[] {
  const directories: string[] = []

  if (projectDirectory) {
    for (const name of AGENT_DIR_NAMES) {
      directories.push(path.join(projectDirectory, ".opencode", name))
    }
  }
  if (home) {
    for (const name of AGENT_DIR_NAMES) {
      directories.push(path.join(home, ".config", "opencode", name))
    }
  }

  return directories
}
