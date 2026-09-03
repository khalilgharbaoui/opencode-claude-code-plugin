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
 * inherited from the caller's picker (see `resolveAgentEffort`). Model and
 * effort together are what a turn costs, so both belong with the agent.
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
}

let registry: Record<string, AgentRecord> = {}
let defaultSubagentModel: string | undefined

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

export function _resetAgentRegistryForTests(): void {
  registry = {}
  defaultSubagentModel = undefined
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

  // A `forceModel` carrying its own `@account` would be forcing an account,
  // which is the thing this exists to avoid. Keep the caller's.
  const base = withoutAccountMarker(wanted)
  if (!Object.hasOwn(defaultModels, base)) {
    log.warn("agent model override refused: unknown model", {
      agent,
      wanted: base,
      keeping: modelId,
    })
    return modelId
  }

  const resolved = `${base}${accountMarker(modelId)}`
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
 * Read the four fields that matter out of an agent markdown file's YAML
 * frontmatter. Hand-parsed rather than pulling a YAML dependency in for four
 * scalars, and deliberately top-level only: `permission:` has nested keys
 * (`bash:`, `edit:`) that must not be mistaken for agent fields.
 */
export function parseAgentFrontmatter(text: string): AgentRecord {
  const record: AgentRecord = {}
  if (!text.startsWith("---")) return record

  const lines = text.split(/\r?\n/)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === "---") break

    const match = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line)
    if (!match) continue

    const key = match[1]
    if (
      key !== "mode" &&
      key !== "model" &&
      key !== "forceModel" &&
      key !== "reasoningEffort"
    )
      continue

    const value = match[2].trim().replace(/^["']|["']$/g, "")
    if (value) record[key] = value
  }

  return record
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
