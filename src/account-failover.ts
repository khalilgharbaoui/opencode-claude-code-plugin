import { homedir } from "node:os"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import {
  DEFAULT_ACCOUNT,
  ensureAccountRuntime,
  normalizeAccountName,
} from "./accounts.js"
import {
  formatResetsAt,
  isRateLimitRejected,
  resetsAtToMs,
  type RateLimitInfo,
} from "./cli-events.js"
import { log } from "./logger.js"
import {
  QUESTION_TOOL_NAME,
  collectAnswerStrings,
  unwrapToolOutput,
  type QuestionToolCall,
} from "./plan-mode-question.js"

/**
 * Account failover.
 *
 * When the account a conversation is running on is out of usage, the turn
 * fails and the only remedy is the operator's: wait, pay, or move to another
 * account. The last one is the only one the plugin can help with, because the
 * accounts are already configured and each is just another `CLAUDE_CONFIG_DIR`
 * behind a wrapper script (`src/accounts.ts`).
 *
 * So the limit ends the turn with a form instead of an error: one option per
 * other configured account, plus `stop`. The form is opencode's own `question`
 * tool, reached exactly the way the plan-mode bridge reaches it, which means
 * the answer arrives on the next `doStream` call as a `tool-result` and the
 * switch happens inside the same opencode turn, with no new user message.
 * Leaving it unanswered waits, and waiting costs nothing.
 *
 * Three things about the design are deliberate and load-bearing:
 *
 * 1. **The override is scoped to the limited ACCOUNT, not the session.** A
 *    rate limit is a property of the account, so one pick governs every
 *    session running on it, and a subagent follows its parent for free
 *    without needing its own form (child sessions are never asked).
 * 2. **A switch is always a fresh Claude session with the conversation
 *    replayed.** Transcripts live under the account's own config dir, so
 *    `--resume` can never cross accounts. The caller drops the active process
 *    and the stored Claude session id, which makes `includeHistoryContext`
 *    true and rebuilds the thread from opencode's prompt.
 * 3. **The `@account` suffix must come off the model id.** `parseModelId`
 *    keeps it on purpose because the source account's own wrapper strips it,
 *    but a failover spawn goes through a DIFFERENT wrapper (or the bare
 *    binary for `default`), which would pass `--model claude-opus-5@appical`
 *    straight to a CLI that rejects it.
 */

type Prompt = Parameters<LanguageModelV3["doGenerate"]>[0]["prompt"]

/** Leading text of the `▌` note the plugin writes when a switch happens. */
export const FAILOVER_MARKER = "▌ **account failover:**"

/**
 * Prefix of every synthetic `question` tool-call id this module mints. The
 * transcript rebuild keys on it to drop the dialog, so a replayed history
 * never hands Claude a form it never saw.
 */
export const ACCOUNT_FAILOVER_TOOL_CALL_PREFIX = "account_failover_"

// Escaped rather than a literal NUL byte: one raw \0 anywhere in the file
// makes git treat this TypeScript source as binary, so it has no diff, no
// line-level merge and no review. Same string value, text file.
const KEY_SEPARATOR = "\u0000"

/** The option that ends the turn instead of switching. */
export const STOP_ANSWER = "stop"

/**
 * The only error texts that count as "this account is out of usage".
 *
 * Deliberately not "any 4xx" and not "any error": a transient network failure
 * or a bad flag must never open a form that moves where the billing lands.
 * Both strings are the ones observed in production and recorded in AGENTS.md;
 * the apostrophe class covers the straight and curly forms.
 */
export const ACCOUNT_LIMIT_PATTERNS: RegExp[] = [
  /third-party apps now draw from your extra usage/i,
  /you[’'`]?ve hit your individual spend limit/i,
]

/** Leading text of the `▌` note naming an account that cannot serve requests. */
export const ACCOUNT_BLOCK_MARKER = "▌ **claude account:**"

/**
 * The CLI's failure kinds that belong to the ACCOUNT rather than to this
 * request, each with what the operator can do about it. Read off the
 * `error` enum on the assistant message in Claude Code 2.1.280's own schema;
 * `rate_limit` is left out because the limit path above already covers it,
 * and the request-level kinds (`invalid_request`, `server_error`, ...) are
 * left out because another account would fail the same way.
 *
 * `authentication_failed` is the one measured in production: on 2026-09-23
 * the `appical` login expired, every turn on it failed in about 40 ms, and all
 * the operator saw was the CLI's own reply "Failed to authenticate: OAuth
 * session expired and could not be refreshed", with no hint of which account
 * or what to run.
 */
const ACCOUNT_BLOCKS = {
  authentication_failed: { what: "is not logged in (its login expired or was revoked)", login: true },
  oauth_org_not_allowed: { what: "belongs to an organization that does not allow this login", login: false },
  account_on_hold: { what: "is on hold", login: false },
  verification_required: { what: "needs to be verified at claude.ai", login: false },
  billing_error: { what: "has a billing problem", login: false },
} as const

export type AccountBlockKind = keyof typeof ACCOUNT_BLOCKS

/** The account-level failure an assistant message reports, if any. */
export function accountBlockKind(msg: { type?: string; error?: unknown }): AccountBlockKind | null {
  if (msg.type !== "assistant" || typeof msg.error !== "string") return null
  return Object.prototype.hasOwnProperty.call(ACCOUNT_BLOCKS, msg.error)
    ? (msg.error as AccountBlockKind)
    : null
}

/** What the switch form says about the account, in place of "out of usage". */
export function describeAccountBlock(kind: AccountBlockKind): string {
  return ACCOUNT_BLOCKS[kind].what
}

/**
 * The command that logs this account in again. An account provider is only a
 * `CLAUDE_CONFIG_DIR` (the wrapper script sets nothing else), so naming the
 * directory is the whole instruction, and it works without the wrapper.
 */
export function loginCommandFor(configDir: string | undefined, home = homedir()): string {
  if (!configDir) return "claude auth login"
  const shown = configDir === home || configDir.startsWith(`${home}/`) ? `~${configDir.slice(home.length)}` : configDir
  return `CLAUDE_CONFIG_DIR=${shown} claude auth login`
}

export function formatAccountBlockNote(input: {
  kind: AccountBlockKind
  account: string
  configDir?: string
  offeringSwitch: boolean
}): string {
  const block = ACCOUNT_BLOCKS[input.kind]
  const account = normalizeAccountName(input.account || DEFAULT_ACCOUNT)
  const fix = block.login
    ? `Log in again with \`${loginCommandFor(input.configDir)}\`, then resend your message.`
    : "Check the account at claude.ai, then resend your message."
  const then = input.offeringSwitch ? " Or pick another account below." : ""
  return `\n${ACCOUNT_BLOCK_MARKER} the Claude account "${account}" ${block.what}. ${fix}${then}\n`
}

export function isAccountLimitError(input: {
  rateLimit?: RateLimitInfo | null
  resultText?: string | null
}): boolean {
  if (input.rateLimit && isRateLimitRejected(input.rateLimit)) return true
  const text = input.resultText
  if (typeof text !== "string" || text.length === 0) return false
  return ACCOUNT_LIMIT_PATTERNS.some((pattern) => pattern.test(text))
}

// ---------------------------------------------------------------------------
// The override store: which account replaces which, and until when
// ---------------------------------------------------------------------------

interface AccountOverride {
  target: string
  /** Epoch ms the limit resets at, or undefined for "until opencode restarts". */
  until?: number
}

const accountOverrides = new Map<string, AccountOverride>()

/** Test-only. */
export function _resetAccountOverrides(): void {
  accountOverrides.clear()
}

export function setAccountOverride(
  source: string,
  target: string,
  until?: number,
  now = Date.now(),
): void {
  const from = normalizeAccountName(source || DEFAULT_ACCOUNT)
  const to = normalizeAccountName(target)
  if (!to || to === from) return
  // A reset time that is not in the future would expire the override on the
  // very next read, so the switch the operator just asked for would be
  // undone before it ran and the turn would re-hit the same limit. Clock
  // skew and a stale `resetsAt` both produce that, so anything not ahead of
  // now degrades to "until opencode restarts" rather than to nothing.
  if (until !== undefined && until <= now) {
    log.notice("ignoring a failover reset time that is not in the future", {
      source: from,
      target: to,
      until,
    })
    until = undefined
  }
  accountOverrides.set(from, { target: to, until })
  log.warn(
    `Claude account "${from}" is out of usage; this and every other session on it now runs on "${to}"${
      until ? ` until ${new Date(until).toISOString()}` : " until opencode restarts"
    }.`,
    { source: from, target: to, until: until ?? null },
  )
}

/**
 * The account to run on instead of `source`, or undefined when there is no
 * override. An expired one is deleted here (and logged once, because the
 * deletion is what silently sends the next turn back to the original account
 * and replays the conversation again).
 */
export function resolveAccountOverride(
  source: string,
  now = Date.now(),
): string | undefined {
  const from = normalizeAccountName(source || DEFAULT_ACCOUNT)
  const entry = accountOverrides.get(from)
  if (!entry) return undefined
  if (entry.until !== undefined && entry.until <= now) {
    accountOverrides.delete(from)
    log.notice(
      `Claude account "${from}" should have usage again; switching back from "${entry.target}".`,
      { source: from, target: entry.target, until: entry.until },
    )
    return undefined
  }
  return entry.target
}

export function clearAccountOverride(source: string): void {
  accountOverrides.delete(normalizeAccountName(source || DEFAULT_ACCOUNT))
}

/** Read-only view for `/claude-code-doctor` and tests. */
export function snapshotAccountOverrides(): Array<{
  source: string
  target: string
  until?: number
}> {
  return [...accountOverrides.entries()].map(([source, entry]) => ({
    source,
    target: entry.target,
    ...(entry.until === undefined ? {} : { until: entry.until }),
  }))
}

// ---------------------------------------------------------------------------
// Resolving the spawn
// ---------------------------------------------------------------------------

/** `claude-opus-5@appical` -> `claude-opus-5`. See the module note (3). */
export function stripAccountSuffix(modelId: string): string {
  const at = modelId.indexOf("@")
  return at === -1 ? modelId : modelId.slice(0, at)
}

export interface FailoverSpawn {
  cliPath: string
  modelId: string
  target?: string
  failedOver: boolean
}

/**
 * The CLI path and model id this turn should actually spawn with. Without an
 * override the inputs come back untouched, which is what keeps every
 * single-account install on exactly today's code path.
 */
export async function resolveFailoverSpawn(input: {
  account: string | undefined
  baseCliPath: string
  cliPath: string
  modelId: string
  now?: number
}): Promise<FailoverSpawn> {
  const unchanged: FailoverSpawn = {
    cliPath: input.cliPath,
    modelId: input.modelId,
    failedOver: false,
  }
  const source = normalizeAccountName(input.account || DEFAULT_ACCOUNT)
  const target = resolveAccountOverride(source, input.now)
  if (!target) return unchanged

  try {
    const cliPath =
      target === DEFAULT_ACCOUNT
        ? input.baseCliPath
        : (await ensureAccountRuntime(target, input.baseCliPath)).cliPath
    return {
      cliPath,
      modelId: stripAccountSuffix(input.modelId),
      target,
      failedOver: true,
    }
  } catch (err) {
    // A wrapper we cannot write is not a reason to spawn nothing: fall back
    // to the limited account and let its own error speak, rather than
    // spawning a path that does not exist.
    log.error("failed to prepare the failover account runtime; staying put", {
      source,
      target,
      error: String(err),
    })
    return unchanged
  }
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

/**
 * On by default whenever more than one account is configured: the operator's
 * pick is the consent, and with no other account there is nothing to offer.
 * Never on a compaction turn (its answer would have nowhere to go), never on
 * the interactive transport (a TUI stdin and no proxy server), never in a
 * child session (a subagent follows its parent's account for free), and never
 * without opencode's `question` entry, where the emitted call renders as
 * `⚙ invalid` and wedges the turn.
 */
export function isAccountFailoverQuestionActive(input: {
  configured: "ask" | "off" | undefined
  candidates: readonly string[]
  opencodeHasQuestion: boolean
  compactionMode: boolean
  interactive: boolean
  childSession: boolean
}): boolean {
  if (input.compactionMode) return false
  if (input.interactive) return false
  if (input.childSession) return false
  if (input.configured === "off") return false
  if (input.candidates.length === 0) return false
  return input.opencodeHasQuestion
}

/** Every configured account except the one that just hit its limit. */
export function failoverCandidates(
  accounts: readonly string[] | undefined,
  source: string,
): string[] {
  const from = normalizeAccountName(source || DEFAULT_ACCOUNT)
  const out: string[] = []
  for (const raw of accounts ?? []) {
    const name = normalizeAccountName(String(raw))
    if (!name || name === from || out.includes(name)) continue
    out.push(name)
  }
  return out
}

interface PendingFailoverQuestion {
  sourceAccount: string
  candidates: string[]
  resetsAt?: number
  /** The question as asked, needed to read opencode's answer sentence. */
  question?: string
}

const pendingQuestions = new Map<string, PendingFailoverQuestion>()

function pendingKey(sessionKey: string, toolCallId: string): string {
  return `${sessionKey}${KEY_SEPARATOR}${toolCallId}`
}

/**
 * Called from `deleteClaudeSessionId`, the one destructive session boundary.
 * A pending id that outlives its session would route the next answer at a
 * dialog nobody can act on.
 */
export function clearAccountFailoverQuestions(sessionKey: string): void {
  const prefix = `${sessionKey}${KEY_SEPARATOR}`
  for (const key of pendingQuestions.keys()) {
    if (key.startsWith(prefix)) pendingQuestions.delete(key)
  }
}

function describeReset(resetsAt: number | undefined): string | undefined {
  return formatResetsAt(resetsAt)
}

export function createAccountFailoverQuestionCall(
  sessionKey: string,
  input: {
    sourceAccount: string
    candidates: readonly string[]
    resetsAt?: number
    window?: string
    /**
     * Why the account cannot serve, when it is not a usage limit
     * (`describeAccountBlock`). Replaces "is out of usage" in the question.
     */
    reason?: string
  },
  toolCallId = `${ACCOUNT_FAILOVER_TOOL_CALL_PREFIX}${Math.random()
    .toString(36)
    .slice(2, 10)}`,
): QuestionToolCall {
  const source = normalizeAccountName(input.sourceAccount || DEFAULT_ACCOUNT)
  const candidates = input.candidates.map((c) => normalizeAccountName(c))
  const resets = describeReset(input.resetsAt)
  const until = resets ?? "opencode restarts"

  const question = input.reason
    ? `The Claude account "${source}" ${input.reason}. Continue this task on another configured account? Leaving this unanswered waits, at no cost.`
    : [
        `The Claude account "${source}" is out of usage`,
        input.window ? ` in ${input.window}` : "",
        resets ? `, which resets at ${resets}` : "",
        ". Continue this task on another configured account? Leaving this unanswered waits, at no cost.",
      ].join("")

  pendingQuestions.set(pendingKey(sessionKey, toolCallId), {
    sourceAccount: source,
    candidates: [...candidates],
    resetsAt: input.resetsAt,
    question,
  })

  return {
    toolCallId,
    toolName: QUESTION_TOOL_NAME,
    input: {
      questions: [
        {
          header: "Account limit",
          question,
          options: [
            ...candidates.map((candidate) => ({
              label: candidate,
              description: `Run on "${candidate}" until ${until}. The conversation is replayed as a fresh Claude session (a session cannot resume across accounts), and any MCP server configured only in "${source}"'s Claude profile will be missing.`,
            })),
            {
              label: STOP_ANSWER,
              description: "End this turn now and leave the account as it is.",
            },
          ],
          multiple: false,
          custom: true,
        },
      ],
    },
    text: "",
  }
}

export type AccountFailoverAnswer =
  | { kind: "switch"; target: string; sourceAccount: string; resetsAt?: number }
  | { kind: "stop"; reason: string }

function isDenied(output: unknown): output is { reason?: unknown } {
  return (
    !!output &&
    typeof output === "object" &&
    (output as { denied?: unknown }).denied === true
  )
}

function classify(
  pending: PendingFailoverQuestion,
  part: any,
): AccountFailoverAnswer {
  const output = unwrapToolOutput(part)
  if (isDenied(output)) {
    return {
      kind: "stop",
      reason: String((output as { reason?: unknown }).reason ?? "question rejected"),
    }
  }
  // A dismissed form reaches the model as a failed tool call ("The user
  // dismissed this question"), not as an answer that happens to be unknown.
  const outputType = part?.output?.type
  if (outputType === "error-text" || outputType === "error-json") {
    return { kind: "stop", reason: String(output ?? "the form was dismissed") }
  }

  const answers = collectAnswerStrings(output, pending.question)
    .map((answer) => answer.trim())
    .filter(Boolean)
  if (answers.length === 0) return { kind: "stop", reason: "no answer" }

  const picked = normalizeAccountName(answers[0])
  if (picked === STOP_ANSWER) {
    return { kind: "stop", reason: "the operator chose to stop" }
  }
  const target = pending.candidates.find((candidate) => candidate === picked)
  if (!target) {
    return { kind: "stop", reason: `unrecognised answer "${answers[0]}"` }
  }
  return {
    kind: "switch",
    target,
    sourceAccount: pending.sourceAccount,
    resetsAt: pending.resetsAt,
  }
}

/**
 * Take the operator's answer to a failover form out of this turn's prompt.
 * Anything that is not one of the offered accounts, including a dismissal and
 * unrecognised custom text, is a `stop`: the turn then ends the way the
 * rate-limit error ends it today.
 */
export function consumeAccountFailoverAnswer(
  sessionKey: string,
  prompt: Array<{ role: string; content?: unknown }>,
  /**
   * The form this model would offer now, for an answer whose form was asked
   * by an earlier opencode process. The pending entry lives in memory, so a
   * restart between the form and the answer lost it and the pick was replayed
   * to Claude as stray text (measured 2026-09-23). Only the newest message is
   * read with it, so an old answer further up the history never fires again.
   */
  fallback?: { sourceAccount: string; candidates: readonly string[] },
): AccountFailoverAnswer | null {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const msg = prompt[i]
    if (!Array.isArray(msg.content)) continue

    for (const part of msg.content as any[]) {
      if (part?.type !== "tool-result" || typeof part.toolCallId !== "string") {
        continue
      }
      const key = pendingKey(sessionKey, part.toolCallId)
      const pending = pendingQuestions.get(key)
      if (!pending) continue

      pendingQuestions.delete(key)
      return classify(pending, part)
    }
  }

  const last = prompt[prompt.length - 1]
  if (fallback && fallback.candidates.length > 0 && Array.isArray(last?.content)) {
    const orphan = (last.content as any[]).find(
      (part) =>
        part?.type === "tool-result" &&
        typeof part.toolCallId === "string" &&
        part.toolCallId.startsWith(ACCOUNT_FAILOVER_TOOL_CALL_PREFIX),
    )
    if (orphan) {
      return classify(
        {
          sourceAccount: normalizeAccountName(fallback.sourceAccount || DEFAULT_ACCOUNT),
          candidates: fallback.candidates.map((c) => normalizeAccountName(c)),
        },
        orphan,
      )
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Transcript handling
// ---------------------------------------------------------------------------

export function formatFailoverNote(input: {
  sourceAccount: string
  target: string
  resetsAt?: number
}): string {
  const resets = describeReset(input.resetsAt)
  return `\n${FAILOVER_MARKER} "${input.sourceAccount}" is out of usage, so this conversation continues on "${
    input.target
  }" ${
    resets ? `until ${resets}` : "until opencode restarts"
  }. Claude cannot resume a session across accounts, so the thread is being replayed into a fresh one.\n`
}

export function formatFailoverStopNote(reason: string): string {
  return `\n${FAILOVER_MARKER} Staying on this account (${reason}). The turn ends here; the usage limit is unchanged.\n`
}

function isFailoverPart(part: any): boolean {
  if (!part || typeof part.toolCallId !== "string") return false
  if (part.type !== "tool-call" && part.type !== "tool-result") return false
  return part.toolCallId.startsWith(ACCOUNT_FAILOVER_TOOL_CALL_PREFIX)
}

/**
 * Remove the failover dialog from a transcript: the synthetic `question`
 * tool-call and the `tool-result` carrying the answer. Claude never issued
 * that call and never saw that result, so replaying either would hand a
 * fresh session a conversation it cannot make sense of. Messages left with no
 * content at all are dropped rather than replayed empty.
 */
export function stripAccountFailoverParts(prompt: Prompt): Prompt {
  let changed = false
  const out = [] as unknown as Prompt

  for (const message of prompt) {
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content) || !content.some(isFailoverPart)) {
      out.push(message)
      continue
    }
    changed = true
    const kept = content.filter((part: any) => !isFailoverPart(part))
    if (kept.length === 0) continue
    out.push({ ...message, content: kept } as typeof message)
  }

  return changed ? out : prompt
}

export function failoverContinuationText(target: string): string {
  return [
    `The Claude account this conversation was running on hit its usage limit, so it has been moved to the "${target}" account and you are now in a fresh Claude session.`,
    "The conversation so far is above. Continue the task from where it stopped: do not start over, do not re-plan, and do not repeat work that is already done.",
    "Do not mention the account switch unless you are asked about it.",
  ].join(" ")
}

/**
 * The prompt to replay into the target account: the conversation with the
 * failover dialog removed, plus one user message telling the fresh session
 * what happened and to carry on.
 */
export function buildFailoverContinuationPrompt(
  prompt: Prompt,
  target: string,
): Prompt {
  const stripped = stripAccountFailoverParts(prompt)
  return [
    ...stripped,
    {
      role: "user",
      content: [{ type: "text", text: failoverContinuationText(target) }],
    },
  ] as Prompt
}

/** Epoch ms a limit resets at, from whichever field the CLI filled in. */
export function failoverUntil(
  resetsAt: number | undefined,
): number | undefined {
  return resetsAtToMs(resetsAt)
}
