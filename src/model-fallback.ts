/**
 * A fallback model chain.
 *
 * `forceModel` and the model picker both name exactly one model, so a model
 * that the account cannot run today is a dead turn: the CLI answers with its
 * own synthetic error, the plugin renders that text, and the operator has to
 * go and edit config before anything works again. A retired id is the ordinary
 * way to get there (Anthropic retires model names on a published schedule and
 * an agent file written six months ago outlives them), and a per-model usage
 * cap is the other.
 *
 * So an agent, or the provider, may name an ordered list of models to try
 * instead. The chain is deliberately narrow:
 *
 *   - **Two triggers, never "an error".** Same rule as `isAccountLimitError`:
 *     a transient network failure, a bad flag or a tool error must not move
 *     the turn onto a different (usually more expensive, or cheaper and less
 *     capable) model behind the operator's back. The two are the CLI refusing
 *     the model outright, and a usage limit the account cannot escape by
 *     switching accounts.
 *   - **The chain never crosses accounts.** Entries are model NAMES; the
 *     `@<account>` marker is reattached from the id the turn arrived with,
 *     exactly as `resolveAgentModel` does it. Moving a turn to another model
 *     is a capability decision, moving it to another account is a billing
 *     decision, and only the second one asks the operator first
 *     (`src/account-failover.ts`).
 *   - **Each model is tried at most once per turn**, and an exhausted chain
 *     surfaces the original error unchanged. A chain cannot turn one failed
 *     turn into an unbounded spend.
 *
 * ## What the CLI actually emits for a model it will not run
 *
 * Measured on Claude Code 2.1.280, 2026-09-27, with
 * `claude -p --output-format stream-json --verbose --model <id> "hi"` for a
 * retired id (`claude-3-opus-20240229`), a sunset one
 * (`claude-3-5-sonnet-20240620`) and a made-up one
 * (`claude-not-a-real-model-9`). All three produce byte-identical shapes:
 *
 *   {"type":"assistant","message":{"model":"<synthetic>","stop_reason":"stop_sequence",
 *    "content":[{"type":"text","text":"There's an issue with the selected model
 *    (<id>). It may not exist or you may not have access to it. Run --model to
 *    pick a different model."}]},"error":"model_not_found",
 *    "is_api_error_message":true}
 *   {"type":"result","subtype":"success","is_error":true,"api_error_status":404,
 *    "terminal_reason":"api_error","result":"There's an issue with the selected
 *    model (<id>). ...","num_turns":1,"total_cost_usd":0}
 *
 * Two things in there are traps. The result's `subtype` is **`success`**, so
 * `describeResultFailure` says nothing and the turn finishes as an ordinary
 * `stop` with the CLI's error text standing in for Claude's answer: that is
 * the bug this module exists to fix, and it is why the subtype can never be
 * the signal. And an id the CLI knows but the caller spelled with an older
 * name is silently ALIASED rather than refused (`claude-opus-4-20250514`
 * served normally, reporting `model: "claude-opus-5-5"`), so a chain is only
 * ever reached by a name the API genuinely rejects.
 *
 * `model_not_found` is a member of the CLI's own assistant-error enum, read
 * out of the 2.1.280 binary's zod schemas the way `accountBlockKind`'s list
 * was: `["authentication_failed","oauth_org_not_allowed","account_on_hold",
 * "verification_required","billing_error","rate_limit","overloaded",
 * "invalid_request","model_not_found","server_error","unknown",
 * "max_output_tokens","cloud_credential_error"]`. Only `model_not_found` is a
 * statement about the MODEL; every other kind either belongs to the account
 * (and `src/account-failover.ts` owns it) or would fail the same way on any
 * model in the chain.
 */
import { log } from "./logger.js"
import {
  getAgentRegistry,
  getProviderFallbackModels,
  qualifyModelName,
} from "./agent-models.js"

// Declaring a chain is config parsing, so the parser lives next to the
// frontmatter reader that needs it; re-exported here so a caller only has to
// know about one module.
export { parseFallbackModelList } from "./agent-models.js"

/** Leading text of the `▌` note written when the chain moves a turn. */
export const MODEL_FALLBACK_MARKER = "▌ **model fallback:**"

/** Why the chain moved. Both are measured signals, not categories of error. */
export type ModelRefusalKind = "model_not_found" | "account_limit"

export interface ModelRefusal {
  kind: ModelRefusalKind
  /** The CLI's own words, for the log and the note. */
  detail?: string
}

/**
 * The assistant-error kinds that mean "not this model". Exactly one, and it
 * is a member of the CLI's enum rather than a string we invented.
 */
const MODEL_REFUSAL_ERROR_KINDS: readonly string[] = ["model_not_found"]

/**
 * The refusal sentence, for the terminal `result` frame, which carries no
 * `error` kind of its own. The apostrophe class covers the straight and curly
 * forms, as `ACCOUNT_LIMIT_PATTERNS` does, because a CLI message copied
 * through a terminal can arrive either way.
 */
export const MODEL_REFUSAL_PATTERNS: RegExp[] = [
  /There[’'`]?s an issue with the selected model/i,
]

function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  for (const block of content as Array<{ type?: string; text?: unknown }>) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      return block.text.trim()
    }
  }
  return undefined
}

/**
 * The model refusal an assistant message reports, if any. Read off the CLI's
 * `error` kind, never off the reply's text: the text is a sentence Anthropic
 * can reword, the enum is part of the wire schema.
 */
export function modelRefusalFromAssistant(msg: {
  type?: string
  error?: unknown
  message?: { content?: unknown }
}): ModelRefusal | null {
  if (msg.type !== "assistant" || typeof msg.error !== "string") return null
  if (!MODEL_REFUSAL_ERROR_KINDS.includes(msg.error)) return null
  return { kind: "model_not_found", detail: firstText(msg.message?.content) }
}

/**
 * The same refusal seen on the terminal `result`, for a CLI that reported no
 * assistant frame. Gated on `is_error`, so the sentence appearing inside a
 * served answer (a model explaining this very error, say) can never fire it.
 */
export function modelRefusalFromResult(msg: {
  type?: string
  is_error?: unknown
  result?: unknown
}): ModelRefusal | null {
  if (msg.type !== "result" || msg.is_error !== true) return null
  const text = typeof msg.result === "string" ? msg.result : ""
  if (!text || !MODEL_REFUSAL_PATTERNS.some((pattern) => pattern.test(text))) {
    return null
  }
  return { kind: "model_not_found", detail: text.trim() }
}

/**
 * Whether a stream message proves the model is actually serving this turn.
 *
 * This is the discriminator that lets one attempt be thrown away whole. Until
 * it is true the caller withholds the attempt's parts, so a refused model
 * never puts its error text in front of the operator; once it is true the
 * attempt is committed and nothing can retry it, which is the rail that keeps
 * a half-streamed answer from being replaced by a second one.
 *
 * An `assistant` frame with `is_api_error_message` is the CLI talking, not the
 * model: that is the exact frame a refusal arrives on, so it must not count.
 */
export function provesModelServing(msg: {
  type?: string
  is_api_error_message?: unknown
  message?: { content?: unknown }
}): boolean {
  if (msg.type === "content_block_start" || msg.type === "content_block_delta") {
    return true
  }
  if (msg.type !== "assistant") return false
  if (msg.is_api_error_message === true) return false
  return Array.isArray(msg.message?.content) && msg.message.content.length > 0
}

/**
 * The per-attempt channel between the chain runner in `doStream` and the one
 * turn it is running. Deliberately a mutable bag rather than a return value:
 * the signals are written by a synchronous readline handler deep inside the
 * stream body, long after `doStreamForHost` returned its `ReadableStream`.
 */
export interface ModelFallbackAttempt {
  /** Spawn this instead of the model the agent or the picker resolved. */
  modelOverride?: string
  /** The caller has another model queued and will discard a refused attempt. */
  armed: boolean
  /** The effective model id this attempt spawned with. */
  modelId?: string
  /** Set once `provesModelServing` saw output; the attempt is then committed. */
  serving?: boolean
  /** Set when this attempt's model was refused and the caller should move on. */
  refusal?: ModelRefusal | null
}

// ---------------------------------------------------------------------------
// Declaring a chain
// ---------------------------------------------------------------------------

export interface FallbackChainOverrides {
  records?: Record<string, { fallbackModels?: string[]; model?: string }>
  providerFallbackModels?: string[]
}

/**
 * The ordered models this request may fall back to, fully qualified with the
 * caller's account marker.
 *
 * Precedence, first non-empty declaration wins outright rather than merging:
 *   1. The agent's own `fallbackModels`.
 *   2. The provider's `fallbackModels`, the default for agents declaring none.
 *
 * Not merged, because a merge would append the provider's expensive tail to an
 * agent that deliberately named two cheap models, which is the opposite of
 * what declaring a list means.
 *
 * An agent that pinned a full `provider/model` is out of scope for the same
 * reason it is in `resolveAgentModel`: opencode already routed that call
 * deliberately.
 *
 * Fails closed per entry. An id that is not in the plugin's model registry is
 * dropped with a WARN, exactly as an unknown `forceModel` is, because the
 * alternative is falling back onto a `--model` the CLI will reject in turn.
 */
export function resolveFallbackChain(
  agent: string | undefined,
  modelId: string,
  overrides?: FallbackChainOverrides,
): string[] {
  const record = agent ? (overrides?.records ?? getAgentRegistry())[agent] : undefined
  if (record?.model?.includes("/")) return []

  const declared = record?.fallbackModels?.length
    ? record.fallbackModels
    : (overrides ? overrides.providerFallbackModels : getProviderFallbackModels()) ?? []
  if (declared.length === 0) return []

  const source = record?.fallbackModels?.length ? `agent "${agent}"` : "provider"
  const chain: string[] = []
  for (const wanted of declared) {
    const resolved = qualifyModelName(wanted, modelId)
    if (!resolved) {
      log.warn("fallback model refused: unknown model", {
        source,
        wanted,
        modelId,
      })
      continue
    }
    // Falling back onto the model that just failed is the one certainty in
    // the list, so it never enters the chain.
    if (resolved === modelId || chain.includes(resolved)) continue
    chain.push(resolved)
  }
  return chain
}

/** The next model to try, or undefined when the chain is spent. */
export function nextFallbackModel(
  chain: readonly string[],
  tried: ReadonlySet<string>,
): string | undefined {
  return chain.find((candidate) => !tried.has(candidate))
}

// ---------------------------------------------------------------------------
// The note
// ---------------------------------------------------------------------------

function describeRefusal(refusal: ModelRefusal): string {
  return refusal.kind === "account_limit"
    ? "is out of usage on this account and no other account is configured"
    : "was refused by the Claude CLI (model_not_found: it is retired, misspelled, or this account cannot use it)"
}

/**
 * The `▌` note the operator reads. Its own text part, registered in
 * `PLUGIN_NOTE_MARKERS`, so a transcript rebuilt for a fresh CLI process
 * strips it: the plugin wrote it, Claude never said it.
 */
export function formatModelFallbackNote(input: {
  failed: string
  serving: string
  refusal: ModelRefusal
}): string {
  return `\n${MODEL_FALLBACK_MARKER} "${input.failed}" ${describeRefusal(
    input.refusal,
  )}, so this turn is being served by "${input.serving}" instead. The account, the thinking budget and the working directory are unchanged.\n`
}
