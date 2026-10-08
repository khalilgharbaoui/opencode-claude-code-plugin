/**
 * The subagent dispatch form: ask the operator, once, how the subagents a turn
 * is about to dispatch should run, and apply that answer to each child's own
 * `claude` spawn.
 *
 * ## Why this exists
 *
 * A subagent inherits whatever the dispatching session was running: the model
 * opencode routed the call to, the effort its picker resolved, and the account
 * behind its provider. The only way to change any of that was static, written
 * in an agent definition (`forceModel`, `reasoningEffort`) or in a provider
 * option (`defaultSubagentModel`). There was no way to say, for this fan-out,
 * "run the two implementors on Opus at max and the designer on Sonnet", and no
 * way at all to run a subagent on another Claude account.
 *
 * ## What it does, and what it must never do
 *
 * Opt-in (`subagentDispatch: "ask"`, off by default). With it on, a proxied
 * `task` or `task_batch` call is held at the drain, the operator is asked, and
 * only then are the real `task` tool calls released to opencode. The whole
 * exchange happens inside one opencode turn, on the mechanism the plan-approval
 * bridge and the account-switch form already use: a step ends on a synthetic
 * `question` tool call, and the answer arrives on the next `doStream` as a
 * `tool-result` carrying the same id (`finishWithQuestionCall`).
 *
 * Three invariants, each of which is why a piece of this looks the way it does:
 *
 * 1. **A choice must never land on the wrong child.** A dispatch records one
 *    claim per task, keyed on the dispatching session, the subagent type and
 *    the task prompt, and a child claims it only when `fetchSessionParentId`
 *    confirms the parent. Measured on opencode 1.18.35 (h #g227): a child
 *    session's first user envelope is the task `prompt` verbatim, its
 *    `parentID` is the dispatching session, and two concurrent children of the
 *    same type each carry their own prompt. Two byte-identical tasks are
 *    interchangeable by construction, so they consume one claim each in
 *    dispatch order and either order is correct.
 * 2. **The dispatch must never be lost silently.** A dismissed or unanswered
 *    form releases the dispatch with today's defaults and says so in one note,
 *    rather than ending the step and leaving the parked MCP call for the next
 *    message's orphan sweep, which the model reports as a denied tool.
 * 3. **Off changes nothing.** With the option unset nothing here is reached:
 *    the drain emits the `task` calls exactly as it does today, no claim is
 *    recorded, and no child prologue looks anything up.
 *
 * ## Accounts
 *
 * An account is offered only when it is in the dispatching account's own
 * `accountGroups` group (h #g226). A subagent is handed the task text the main
 * agent writes, which can quote the conversation, and it reads the repository,
 * so sending one to another group is sending that group the conversation by
 * another route, which is the exact thing the guard exists to stop. The
 * separate `subagentDispatchCrossGroup: true` is the explicit override, and it
 * is off by default and never implied by anything else.
 */
import { DEFAULT_ACCOUNT, ensureAccountRuntime, normalizeAccountName } from "./accounts.js"
import { accountsShareGroup, type AccountGroups } from "./account-groups.js"
import { REASONING_EFFORTS } from "./agent-models.js"
import { defaultModels } from "./models.js"
import {
  parseQuestionAnswers,
  QUESTION_TOOL_NAME,
  type QuestionToolCall,
} from "./plan-mode-question.js"
import { log } from "./logger.js"

/** Leading text of the `▌` note a dispatch can end up writing. */
export const SUBAGENT_DISPATCH_MARKER = "▌ **subagent dispatch:**"

/** Prefix of every tool call id this module emits, so a transcript can strip it. */
export const SUBAGENT_DISPATCH_TOOL_CALL_PREFIX = "subagent_dispatch_"

const KEY_SEPARATOR = "\u0000"

/** Answer label for "whatever would have happened without this form". */
export const DEFAULT_ANSWER = "Default"
/** Answer label for the remembered choice. Suffixed with what it resolves to. */
export const LAST_ANSWER_PREFIX = "Same as last time"
/** Answer label that opens the next, more detailed form. */
export const CUSTOMISE_ANSWER = "Customise…"
/** Per-type answer label that opens the per-task form for that type. */
export const PER_TASK_ANSWER = "Per task…"

/**
 * The curated model and effort pairs the form offers.
 *
 * Deliberately four, and deliberately not generated from the catalog: a list of
 * every model times every effort is twenty-two times six options, which is a
 * form nobody reads. These are the three rungs an operator actually picks
 * between plus the deep-thinking one, and anything else is typed into the
 * custom field, which is measured working (h #g227).
 *
 * An entry whose model is not in the catalog is dropped rather than offered,
 * for the reason `qualifyModelName` refuses one: the alternative is spawning
 * the CLI with a `--model` it rejects, on a turn someone is waiting for.
 */
export const DISPATCH_COMBOS: ReadonlyArray<{
  model: string
  effort: string
  description: string
}> = [
  {
    model: "claude-haiku-5-5",
    effort: "low",
    description: "Cheapest and fastest. Mechanical work with a clear spec.",
  },
  {
    model: "claude-sonnet-5-5",
    effort: "medium",
    description: "Balanced. The usual choice for ordinary implementation work.",
  },
  {
    model: "claude-opus-5-5",
    effort: "high",
    description: "Most capable. Design work, tricky debugging, wide blast radius.",
  },
  {
    model: "claude-opus-5-5",
    effort: "max",
    description: "Most capable, deepest thinking. Slowest and most expensive.",
  },
]

/** What a subagent should actually run as. Every field is optional. */
export interface SubagentChoice {
  /** Model NAME without an account marker; the child reattaches its own. */
  model?: string
  effort?: string
  /** Account name, or undefined to stay on the dispatching session's. */
  account?: string
}

/** One subagent a dispatch is about to start. */
export interface DispatchTask {
  /** The broker call id this task is released under. */
  callId: string
  /** Index inside a `task_batch`, or null for a single `task`. */
  batchIndex: number | null
  agent: string
  prompt: string
  description: string
}

type DispatchStage = "summary" | "types" | "tasks"

/** What a question in a raised form is asking about. */
type FormField =
  | { kind: "all" }
  | { kind: "type"; agent: string }
  | { kind: "task"; taskIndex: number }
  | { kind: "account" }

interface PendingDispatch {
  sessionKey: string
  stage: DispatchStage
  /**
   * Every proxy call the drain was holding when the form went up, in order,
   * dispatch calls and any ordinary call that happened to be in the same
   * batch. The whole batch is held and the whole batch is released, because a
   * step that emitted half of it would leave the other half unemitted with
   * nothing left to drain it.
   */
  heldCallIds: string[]
  tasks: DispatchTask[]
  /** The question texts in order, which is how the answer sentence is read. */
  questions: string[]
  fields: FormField[]
  /** Resolved so far, by task index. Later stages narrow these. */
  choices: Map<number, SubagentChoice>
  account: string | undefined
  context: DispatchContext
}

/** Everything the form needs to describe the choices it is offering. */
export interface DispatchContext {
  /** The dispatching opencode session, which is what a claim is keyed on. */
  parentSessionId: string
  /** The account the dispatching session runs on. */
  sourceAccount: string
  /** Every configured account, including `default`. */
  accounts: readonly string[]
  /** The resolved `accountGroups` guard, or null. */
  groups: AccountGroups | null
  /** Whether an account outside the source's group may be offered. */
  crossGroup: boolean
  /** What this agent type would run as today, with no form at all. */
  describeDefault: (agent: string) => { model: string; effort?: string }
}

const pending = new Map<string, PendingDispatch>()

function pendingKey(sessionKey: string, toolCallId: string): string {
  return `${sessionKey}${KEY_SEPARATOR}${toolCallId}`
}

/** Called from `deleteClaudeSessionId`, the one destructive session boundary. */
export function clearSubagentDispatchQuestions(sessionKey: string): void {
  const prefix = `${sessionKey}${KEY_SEPARATOR}`
  for (const key of pending.keys()) {
    if (key.startsWith(prefix)) pending.delete(key)
  }
}

export function hasPendingSubagentDispatch(sessionKey: string): boolean {
  const prefix = `${sessionKey}${KEY_SEPARATOR}`
  return [...pending.keys()].some((key) => key.startsWith(prefix))
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Whether a dispatch from this turn should raise the form.
 *
 * Mirrors `isAccountFailoverQuestionActive` field for field, and every refusal
 * is there for the same reason it is there:
 *
 * - `compactionMode`: a `/compact` turn has no proxy tools at all, and its text
 *   is what opencode stores as the summary.
 * - `childSession`: a subagent that dispatches subagents of its own follows the
 *   choice its own parent made for it (`lookupSessionChoice`), and asking would
 *   put a form in a session the operator is usually not even looking at.
 * - `opencodeHasQuestion`: without the registry entry the emitted `question`
 *   call renders as `⚙ invalid` and wedges the turn.
 */
export function isSubagentDispatchActive(input: {
  configured: "ask" | "off" | undefined
  opencodeHasQuestion: boolean
  compactionMode: boolean
  childSession: boolean
}): boolean {
  if (input.compactionMode) return false
  if (input.childSession) return false
  if (input.configured !== "ask") return false
  return input.opencodeHasQuestion
}

// ---------------------------------------------------------------------------
// Remembering the last choice
// ---------------------------------------------------------------------------

/**
 * The last choice made for an agent type in one opencode conversation.
 *
 * In memory only, and that is deliberate rather than unfinished: it is a
 * preference about one conversation's fan-out, the two other per-conversation
 * dialogs (the plan approval and the failover override) are in memory for the
 * same reason, and persisting it would mean a file under `XDG_STATE_HOME` whose
 * staleness nobody can see. After an opencode restart the first dispatch offers
 * `Default` where it would have offered `Same as last time`, which is one extra
 * read of a form the operator was going to look at anyway.
 */
const lastChoices = new Map<string, SubagentChoice>()
const MAX_REMEMBERED_CHOICES = 256

function lastChoiceKey(parentSessionId: string, agent: string): string {
  return `${parentSessionId}${KEY_SEPARATOR}${agent}`
}

export function rememberDispatchChoice(
  parentSessionId: string,
  agent: string,
  choice: SubagentChoice,
): void {
  if (!parentSessionId || parentSessionId === "default") return
  const key = lastChoiceKey(parentSessionId, agent)
  lastChoices.delete(key)
  lastChoices.set(key, { ...choice })
  while (lastChoices.size > MAX_REMEMBERED_CHOICES) {
    const oldest = lastChoices.keys().next().value
    if (oldest === undefined) break
    lastChoices.delete(oldest)
  }
}

export function recallDispatchChoice(
  parentSessionId: string,
  agent: string,
): SubagentChoice | undefined {
  return lastChoices.get(lastChoiceKey(parentSessionId, agent))
}

// ---------------------------------------------------------------------------
// Claims: which child gets which choice
// ---------------------------------------------------------------------------

interface DispatchClaim {
  parentSessionId: string
  agent: string
  prompt: string
  choice: SubagentChoice
  createdAt: number
}

/**
 * How long an unclaimed dispatch claim is worth keeping.
 *
 * A dispatch whose child never arrives (opencode refused the agent type, the
 * turn was aborted between the release and the child's first call) must not
 * leave a claim that a later, unrelated child with the same prompt could pick
 * up. Fifteen minutes is far longer than the gap between a release and the
 * child's first `doStream`, which is milliseconds, and far shorter than the
 * life of a conversation.
 */
const CLAIM_TTL_MS = 15 * 60_000
const MAX_CLAIMS = 512

const claims: DispatchClaim[] = []
/** Claimed choices by child session id, so a child's later turns are free. */
const sessionChoices = new Map<string, SubagentChoice>()
const MAX_SESSION_CHOICES = 512

export function _resetSubagentDispatchForTests(): void {
  pending.clear()
  lastChoices.clear()
  claims.length = 0
  sessionChoices.clear()
}

function pruneClaims(now: number): void {
  for (let i = claims.length - 1; i >= 0; i--) {
    if (now - claims[i].createdAt > CLAIM_TTL_MS) claims.splice(i, 1)
  }
  while (claims.length > MAX_CLAIMS) claims.shift()
}

/**
 * Record what each task of a released dispatch should run as.
 *
 * A choice with nothing set is not recorded at all: it is today's behaviour,
 * and an empty claim would only make a child pay for a parent lookup to learn
 * that nothing changed.
 */
export function recordDispatchClaims(
  parentSessionId: string,
  tasks: readonly DispatchTask[],
  choices: ReadonlyMap<number, SubagentChoice>,
  now = Date.now(),
): number {
  if (!parentSessionId || parentSessionId === "default") return 0
  pruneClaims(now)
  let recorded = 0
  for (const [index, task] of tasks.entries()) {
    const choice = choices.get(index)
    if (!choice || (!choice.model && !choice.effort && !choice.account)) continue
    claims.push({
      parentSessionId,
      agent: task.agent,
      prompt: task.prompt,
      choice: { ...choice },
      createdAt: now,
    })
    recorded++
  }
  return recorded
}

/** The choice a child session already claimed, for its second turn onwards. */
export function lookupSessionChoice(sessionId: string): SubagentChoice | undefined {
  return sessionChoices.get(sessionId)
}

/**
 * Whether any recorded claim could belong to a session with this agent and
 * first user message. Synchronous and cheap, and it is what keeps the parent
 * lookup off every turn: only a child that actually looks like a dispatch pays
 * for the `fetchSessionParentId` call.
 */
export function hasCandidateClaim(
  agent: string | undefined,
  prompt: string | undefined,
  now = Date.now(),
): boolean {
  if (!agent || prompt === undefined) return false
  pruneClaims(now)
  return claims.some((claim) => claim.agent === agent && claim.prompt === prompt)
}

/**
 * Take the claim for a child session, or undefined.
 *
 * The parent is checked last and only against candidates, so a session that is
 * not a child of the dispatcher can never take one. Two byte-identical tasks
 * produce two identical claims and the child takes the first; see the module
 * note for why either order is correct.
 */
export function claimDispatchChoice(input: {
  sessionId: string
  agent: string | undefined
  prompt: string | undefined
  parentSessionId: string | undefined
  now?: number
}): SubagentChoice | undefined {
  const existing = sessionChoices.get(input.sessionId)
  if (existing) return existing
  if (!input.agent || input.prompt === undefined || !input.parentSessionId) {
    return undefined
  }
  pruneClaims(input.now ?? Date.now())
  const index = claims.findIndex(
    (claim) =>
      claim.parentSessionId === input.parentSessionId &&
      claim.agent === input.agent &&
      claim.prompt === input.prompt,
  )
  if (index === -1) return undefined
  const [claim] = claims.splice(index, 1)
  sessionChoices.set(input.sessionId, claim.choice)
  while (sessionChoices.size > MAX_SESSION_CHOICES) {
    const oldest = sessionChoices.keys().next().value
    if (oldest === undefined) break
    sessionChoices.delete(oldest)
  }
  log.info("subagent dispatch choice claimed by its child session", {
    sessionId: input.sessionId,
    agent: input.agent,
    model: claim.choice.model ?? null,
    effort: claim.choice.effort ?? null,
    account: claim.choice.account ?? null,
  })
  return claim.choice
}

/** Drop a child session's claimed choice, from `session.deleted`. */
export function forgetSessionChoice(sessionId: string): void {
  sessionChoices.delete(sessionId)
}

/**
 * The text of the FIRST user message of a prompt, which for a subagent session
 * is the task prompt the dispatch wrote, verbatim.
 *
 * Measured on opencode 1.18.35 (h #g227): a child session's first envelope is
 * `{"role":"user","content":[{"type":"text","text":"<the task prompt>"}]}` with
 * nothing added. It stays the first user message for the rest of that session,
 * which is why a late claim still finds the right entry.
 */
export function firstUserText(
  prompt: ReadonlyArray<{ role: string; content?: unknown }>,
): string | undefined {
  for (const message of prompt) {
    if (message.role !== "user") continue
    const content = message.content
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return undefined
    const text = content
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text as string)
      .join("")
    return text
  }
  return undefined
}

/**
 * The spawn a subagent sent to another account needs: that account's wrapper
 * (or the base binary for `default`), and the model id with the `@<account>`
 * marker taken off, which is the same pair `resolveFailoverSpawn` builds and
 * for the same reason (the other account's wrapper does not know this one's
 * marker).
 *
 * A wrapper that cannot be written is not a reason to spawn nothing: the
 * subagent stays on the dispatching account, which is where it would have run
 * without the form at all.
 */
export async function resolveDispatchAccountSpawn(input: {
  account: string
  baseCliPath: string
  modelId: string
  ensureRuntime?: (
    account: string,
    baseCliPath: string,
  ) => Promise<{ cliPath: string }>
}): Promise<{
  cliPath: string
  modelId: string
  target: string
  failedOver: true
} | null> {
  const account = normalizeAccountName(input.account || DEFAULT_ACCOUNT)
  try {
    const cliPath =
      account === DEFAULT_ACCOUNT
        ? input.baseCliPath
        : (await (input.ensureRuntime ?? ensureAccountRuntime)(account, input.baseCliPath))
            .cliPath
    const at = input.modelId.indexOf("@")
    return {
      cliPath,
      modelId: at === -1 ? input.modelId : input.modelId.slice(0, at),
      target: account,
      failedOver: true,
    }
  } catch (err) {
    log.error("failed to prepare the dispatched subagent's account; staying put", {
      account,
      error: String(err),
    })
    return null
  }
}

// ---------------------------------------------------------------------------
// Reading a dispatch out of the calls the drain is holding
// ---------------------------------------------------------------------------

/** Pull the tasks out of the `task` / `task_batch` calls a drain is holding. */
export function dispatchTasksFromCalls(
  calls: ReadonlyArray<{
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
  }>,
  batchTasks: (input: Record<string, unknown>) => Record<string, unknown>[],
): DispatchTask[] {
  const out: DispatchTask[] = []
  for (const call of calls) {
    if (call.toolName === "task") {
      out.push(taskFromInput(call.toolCallId, null, call.input))
      continue
    }
    if (call.toolName === "task_batch") {
      for (const [index, task] of batchTasks(call.input).entries()) {
        out.push(taskFromInput(call.toolCallId, index, task))
      }
    }
  }
  return out
}

function taskFromInput(
  callId: string,
  batchIndex: number | null,
  input: Record<string, unknown>,
): DispatchTask {
  return {
    callId,
    batchIndex,
    agent: typeof input.subagent_type === "string" ? input.subagent_type : "general",
    prompt: typeof input.prompt === "string" ? input.prompt : "",
    description: typeof input.description === "string" ? input.description : "",
  }
}

/** The agent types in a dispatch, in first-seen order. */
export function dispatchAgentTypes(tasks: readonly DispatchTask[]): string[] {
  const out: string[] = []
  for (const task of tasks) if (!out.includes(task.agent)) out.push(task.agent)
  return out
}

// ---------------------------------------------------------------------------
// Building the forms
// ---------------------------------------------------------------------------

function comboLabel(model: string, effort?: string): string {
  return effort ? `${model} / ${effort}` : model
}

function describeChoice(
  choice: SubagentChoice,
  fallback: { model: string; effort?: string },
): string {
  return comboLabel(choice.model ?? fallback.model, choice.effort ?? fallback.effort)
}

/** The combos whose model this install actually knows. */
function availableCombos(): typeof DISPATCH_COMBOS {
  return DISPATCH_COMBOS.filter((combo) => Object.hasOwn(defaultModels, combo.model))
}

/**
 * Accounts a subagent may be sent to. Same group only, unless the operator
 * turned `subagentDispatchCrossGroup` on; the source account is always first,
 * because staying put is the default and a default belongs at the top.
 */
export function dispatchAccountCandidates(context: DispatchContext): string[] {
  const source = normalizeAccountName(context.sourceAccount || DEFAULT_ACCOUNT)
  const out = [source]
  for (const raw of context.accounts) {
    const name = normalizeAccountName(String(raw))
    if (!name || out.includes(name)) continue
    if (!context.crossGroup && !accountsShareGroup(source, name, context.groups)) {
      continue
    }
    out.push(name)
  }
  return out
}

function accountQuestion(context: DispatchContext): {
  question: string
  options: Array<{ label: string; description: string }>
} | null {
  const candidates = dispatchAccountCandidates(context)
  if (candidates.length < 2) return null
  const source = candidates[0]
  return {
    question: "Which Claude account should these subagents run on?",
    options: candidates.map((account) => ({
      label: account,
      description:
        account === source
          ? `Stay on this conversation's own account. This is what happens today.`
          : `Spawn each subagent with "${account}"'s Claude config dir, so its work draws on that account's usage window.`,
    })),
  }
}

function summaryQuestion(
  tasks: readonly DispatchTask[],
  context: DispatchContext,
): { question: string; options: Array<{ label: string; description: string }> } {
  const types = dispatchAgentTypes(tasks)
  const counts = types.map((agent) => {
    const n = tasks.filter((task) => task.agent === agent).length
    return n > 1 ? `${n} ${agent}` : agent
  })
  const question =
    tasks.length === 1
      ? `About to dispatch the "${tasks[0].agent}" subagent (${
          tasks[0].description || "no description"
        }). How should it run?`
      : `About to dispatch ${tasks.length} subagents (${counts.join(", ")}). How should they run?`

  const options: Array<{ label: string; description: string }> = []
  const remembered = types.map((agent) => recallDispatchChoice(context.parentSessionId, agent))
  if (remembered.every((choice) => choice !== undefined)) {
    options.push({
      label: LAST_ANSWER_PREFIX,
      description: types
        .map(
          (agent, index) =>
            `${agent}: ${describeChoice(remembered[index]!, context.describeDefault(agent))}`,
        )
        .join(". "),
    })
  }
  options.push({
    label: DEFAULT_ANSWER,
    description: types
      .map((agent) => {
        const fallback = context.describeDefault(agent)
        return `${agent}: ${comboLabel(fallback.model, fallback.effort)}`
      })
      .join(". "),
  })
  for (const combo of availableCombos()) {
    options.push({
      label: comboLabel(combo.model, combo.effort),
      description: `Every subagent in this dispatch. ${combo.description}`,
    })
  }
  options.push({
    label: CUSTOMISE_ANSWER,
    description:
      tasks.length === 1
        ? "Choose the account, or type a model and effort of your own."
        : "Choose per agent type on the next screen, and per task after that.",
  })
  return { question, options }
}

function typeQuestion(
  agent: string,
  tasks: readonly DispatchTask[],
  context: DispatchContext,
): { question: string; options: Array<{ label: string; description: string }> } {
  const mine = tasks.filter((task) => task.agent === agent)
  const fallback = context.describeDefault(agent)
  const question =
    mine.length === 1
      ? `"${agent}" (${mine[0].description || "no description"}): how should it run?`
      : `"${agent}" (${mine.length} subagents): how should they run?`

  const options: Array<{ label: string; description: string }> = []
  const remembered = recallDispatchChoice(context.parentSessionId, agent)
  if (remembered) {
    options.push({
      label: LAST_ANSWER_PREFIX,
      description: `${describeChoice(remembered, fallback)}, the last thing you picked for "${agent}" in this conversation.`,
    })
  }
  options.push({
    label: DEFAULT_ANSWER,
    description: `${comboLabel(fallback.model, fallback.effort)}, from the agent definition and the provider options.`,
  })
  for (const combo of availableCombos()) {
    options.push({
      label: comboLabel(combo.model, combo.effort),
      description: combo.description,
    })
  }
  if (mine.length > 1) {
    options.push({
      label: PER_TASK_ANSWER,
      description: `Give each of these ${mine.length} "${agent}" subagents its own model and effort on the next screen.`,
    })
  }
  return { question, options }
}

function taskQuestion(
  task: DispatchTask,
  typeChoice: SubagentChoice | undefined,
  context: DispatchContext,
): { question: string; options: Array<{ label: string; description: string }> } {
  const fallback = context.describeDefault(task.agent)
  const options: Array<{ label: string; description: string }> = []
  if (typeChoice && (typeChoice.model || typeChoice.effort)) {
    options.push({
      label: `Same as the rest (${describeChoice(typeChoice, fallback)})`,
      description: `What you picked for every "${task.agent}" subagent in this dispatch.`,
    })
  }
  options.push({
    label: DEFAULT_ANSWER,
    description: `${comboLabel(fallback.model, fallback.effort)}, from the agent definition and the provider options.`,
  })
  for (const combo of availableCombos()) {
    options.push({ label: comboLabel(combo.model, combo.effort), description: combo.description })
  }
  return {
    question: `"${task.agent}": ${task.description || task.prompt.slice(0, 60)}`,
    options,
  }
}

/**
 * The header opencode shows beside a question. Documented as "max 30 chars", so
 * it is cut here rather than left to whatever the TUI does with a long one.
 */
function header(text: string): string {
  return text.length <= 30 ? text : `${text.slice(0, 29)}…`
}

function questionCallId(suffix: string): string {
  return `${SUBAGENT_DISPATCH_TOOL_CALL_PREFIX}${suffix}_${Math.random()
    .toString(36)
    .slice(2, 10)}`
}

function buildCall(
  entry: PendingDispatch,
  prompts: Array<{ header: string; question: string; options: Array<{ label: string; description: string }> }>,
  toolCallId: string,
): QuestionToolCall {
  entry.questions = prompts.map((prompt) => prompt.question)
  pending.set(pendingKey(entry.sessionKey, toolCallId), entry)
  return {
    toolCallId,
    toolName: QUESTION_TOOL_NAME,
    input: {
      questions: prompts.map((prompt) => ({
        header: header(prompt.header),
        question: prompt.question,
        options: prompt.options,
        multiple: false,
        custom: true,
      })),
    },
    text: "",
  }
}

/**
 * The first form of a dispatch: always exactly one question, so the common case
 * is one click. Everything else is behind `Customise…`.
 */
export function createSubagentDispatchQuestion(
  sessionKey: string,
  heldCallIds: string[],
  tasks: DispatchTask[],
  context: DispatchContext,
  toolCallId = questionCallId("summary"),
): QuestionToolCall {
  const entry: PendingDispatch = {
    sessionKey,
    stage: "summary",
    heldCallIds,
    tasks,
    questions: [],
    fields: [{ kind: "all" }],
    choices: new Map(),
    account: undefined,
    context,
  }
  const summary = summaryQuestion(tasks, context)
  return buildCall(entry, [{ header: "Subagents", ...summary }], toolCallId)
}

// ---------------------------------------------------------------------------
// Reading an answer
// ---------------------------------------------------------------------------

/**
 * A model and effort typed by hand.
 *
 * Forgiving about the separator because an operator writes `opus 5.5 / max`,
 * `claude-opus-5-5 max` and `claude-opus-5-5, max` interchangeably, and strict
 * about the values: an unknown model or effort level is refused here rather
 * than forwarded to a spawn that would reject it. Either half alone is a valid
 * answer, so `max` on its own changes the effort and leaves the model.
 */
export function parseCustomChoice(answer: string): SubagentChoice | null {
  const words = answer
    .trim()
    .split(/[\s,/]+/)
    .map((word) => word.trim())
    .filter(Boolean)
  if (words.length === 0) return null

  const choice: SubagentChoice = {}
  for (const word of words) {
    const lower = word.toLowerCase()
    if (REASONING_EFFORTS.includes(lower)) {
      choice.effort = lower
      continue
    }
    if (Object.hasOwn(defaultModels, lower)) {
      choice.model = lower
      continue
    }
    return null
  }
  return choice.model || choice.effort ? choice : null
}

/** A combo label (`claude-opus-5-5 / max`) back to a choice, or null. */
function parseComboLabel(answer: string): SubagentChoice | null {
  for (const combo of availableCombos()) {
    if (comboLabel(combo.model, combo.effort) === answer) {
      return { model: combo.model, effort: combo.effort }
    }
  }
  return null
}

type AnswerKind =
  | { kind: "default" }
  | { kind: "last" }
  | { kind: "customise" }
  | { kind: "perTask" }
  | { kind: "sameAsRest" }
  | { kind: "choice"; choice: SubagentChoice }
  | { kind: "unknown"; answer: string }

function classifyAnswer(answer: string): AnswerKind {
  const trimmed = answer.trim()
  if (!trimmed) return { kind: "default" }
  if (trimmed === DEFAULT_ANSWER) return { kind: "default" }
  if (trimmed === LAST_ANSWER_PREFIX) return { kind: "last" }
  if (trimmed === CUSTOMISE_ANSWER) return { kind: "customise" }
  if (trimmed === PER_TASK_ANSWER) return { kind: "perTask" }
  if (trimmed.startsWith("Same as the rest")) return { kind: "sameAsRest" }
  const combo = parseComboLabel(trimmed)
  if (combo) return { kind: "choice", choice: combo }
  const custom = parseCustomChoice(trimmed)
  if (custom) return { kind: "choice", choice: custom }
  return { kind: "unknown", answer: trimmed }
}

/** What the caller should do after this turn's prompt was read. */
export type SubagentDispatchStep =
  | { kind: "form"; call: QuestionToolCall }
  | {
      kind: "release"
      /** Every call the drain was holding, in order; see `heldCallIds`. */
      heldCallIds: string[]
      tasks: DispatchTask[]
      choices: Map<number, SubagentChoice>
      parentSessionId: string
      /** One `▌` note to write before the tool calls, or null. */
      note: string | null
    }

/**
 * Take the operator's answer to a dispatch form out of this turn's prompt, and
 * say whether the next thing is another form or the release.
 *
 * A dismissed form, a denied one and an answer nothing recognises all end the
 * same way: release with whatever is already resolved, which for a dismissal at
 * the first form is today's behaviour exactly, plus the note that says so.
 * Invariant 2 of the module note is the whole reason this never returns null
 * once a pending entry matched.
 */
export function consumeSubagentDispatchAnswer(
  sessionKey: string,
  prompt: Array<{ role: string; content?: unknown }>,
): SubagentDispatchStep | null {
  // Called on every turn, so the common case (no form is up anywhere) must not
  // walk a long conversation's tool results looking for one.
  if (pending.size === 0) return null
  for (let i = prompt.length - 1; i >= 0; i--) {
    const msg = prompt[i]
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as any[]) {
      if (part?.type !== "tool-result" || typeof part.toolCallId !== "string") continue
      const key = pendingKey(sessionKey, part.toolCallId)
      const entry = pending.get(key)
      if (!entry) continue
      pending.delete(key)
      return advance(entry, part)
    }
  }
  return null
}

function dismissedNote(reason: string): string {
  return (
    `\n${SUBAGENT_DISPATCH_MARKER} ${reason}, so these subagents run exactly as they` +
    ` would have without the form: the model, effort and account their agent` +
    ` definition and this conversation already give them. Nothing was lost.\n`
  )
}

function advance(entry: PendingDispatch, part: any): SubagentDispatchStep {
  const answers = parseQuestionAnswers(part, entry.questions)
  if (!answers) {
    log.notice("subagent dispatch form was dismissed; dispatching with the defaults", {
      sessionKey: entry.sessionKey,
      stage: entry.stage,
      tasks: entry.tasks.length,
    })
    return release(entry, dismissedNote("The dispatch form was dismissed"))
  }

  switch (entry.stage) {
    case "summary":
      return advanceSummary(entry, answers)
    case "types":
      return advanceTypes(entry, answers)
    default:
      return advanceTasks(entry, answers)
  }
}

function applyToAll(entry: PendingDispatch, choice: SubagentChoice): void {
  for (const index of entry.tasks.keys()) entry.choices.set(index, { ...choice })
}

function advanceSummary(
  entry: PendingDispatch,
  answers: Map<string, string>,
): SubagentDispatchStep {
  const answer = classifyAnswer(answers.get(entry.questions[0]) ?? "")

  if (answer.kind === "customise") return typesForm(entry)

  if (answer.kind === "last") {
    for (const [index, task] of entry.tasks.entries()) {
      const remembered = recallDispatchChoice(entry.context.parentSessionId, task.agent)
      if (remembered) entry.choices.set(index, { ...remembered })
    }
    return release(entry, null)
  }

  if (answer.kind === "choice") {
    applyToAll(entry, answer.choice)
    return release(entry, null)
  }

  if (answer.kind === "unknown") {
    log.notice("subagent dispatch answer was not recognised; dispatching with the defaults", {
      sessionKey: entry.sessionKey,
      answer: answer.answer,
    })
    return release(
      entry,
      dismissedNote(`"${answer.answer}" is not a model or effort level this plugin knows`),
    )
  }

  // `default` and `perTask` (which the summary never offers) both mean "leave
  // everything as it is".
  return release(entry, null)
}

function typesForm(entry: PendingDispatch): SubagentDispatchStep {
  const types = dispatchAgentTypes(entry.tasks)
  const prompts = types.map((agent) => ({
    header: agent,
    ...typeQuestion(agent, entry.tasks, entry.context),
  }))
  const fields: FormField[] = types.map((agent) => ({ kind: "type", agent }))
  const account = accountQuestion(entry.context)
  if (account) {
    prompts.push({ header: "Account", ...account })
    fields.push({ kind: "account" })
  }
  entry.stage = "types"
  entry.fields = fields
  return {
    kind: "form",
    call: buildCall(entry, prompts, questionCallId("types")),
  }
}

function advanceTypes(
  entry: PendingDispatch,
  answers: Map<string, string>,
): SubagentDispatchStep {
  const perTask: string[] = []
  const typeChoices = new Map<string, SubagentChoice>()

  for (const [position, field] of entry.fields.entries()) {
    const raw = answers.get(entry.questions[position]) ?? ""
    const answer = classifyAnswer(raw)

    if (field.kind === "account") {
      if (answer.kind === "unknown") {
        const picked = normalizeAccountName(answer.answer)
        const candidates = dispatchAccountCandidates(entry.context)
        if (candidates.includes(picked)) entry.account = picked
        else {
          log.notice("subagent dispatch account answer refused", {
            sessionKey: entry.sessionKey,
            answer: answer.answer,
            candidates,
          })
        }
      }
      continue
    }
    if (field.kind !== "type") continue

    if (answer.kind === "perTask") {
      perTask.push(field.agent)
      continue
    }
    if (answer.kind === "last") {
      const remembered = recallDispatchChoice(entry.context.parentSessionId, field.agent)
      if (remembered) typeChoices.set(field.agent, { ...remembered })
      continue
    }
    if (answer.kind === "choice") {
      typeChoices.set(field.agent, answer.choice)
      continue
    }
    if (answer.kind === "unknown") {
      log.notice("subagent dispatch answer was not recognised; keeping the default", {
        sessionKey: entry.sessionKey,
        agent: field.agent,
        answer: answer.answer,
      })
    }
  }

  for (const [index, task] of entry.tasks.entries()) {
    const choice = typeChoices.get(task.agent)
    if (choice) entry.choices.set(index, { ...choice })
  }

  if (perTask.length > 0) return tasksForm(entry, perTask, typeChoices)
  return release(entry, null)
}

function tasksForm(
  entry: PendingDispatch,
  agents: string[],
  typeChoices: Map<string, SubagentChoice>,
): SubagentDispatchStep {
  const prompts: Array<{
    header: string
    question: string
    options: Array<{ label: string; description: string }>
  }> = []
  const fields: FormField[] = []
  for (const [index, task] of entry.tasks.entries()) {
    if (!agents.includes(task.agent)) continue
    prompts.push({
      header: task.description || task.agent,
      ...taskQuestion(task, typeChoices.get(task.agent), entry.context),
    })
    fields.push({ kind: "task", taskIndex: index })
  }
  entry.stage = "tasks"
  entry.fields = fields
  return { kind: "form", call: buildCall(entry, prompts, questionCallId("tasks")) }
}

function advanceTasks(
  entry: PendingDispatch,
  answers: Map<string, string>,
): SubagentDispatchStep {
  for (const [position, field] of entry.fields.entries()) {
    if (field.kind !== "task") continue
    const answer = classifyAnswer(answers.get(entry.questions[position]) ?? "")
    if (answer.kind === "choice") {
      entry.choices.set(field.taskIndex, answer.choice)
      continue
    }
    if (answer.kind === "default") {
      entry.choices.delete(field.taskIndex)
      continue
    }
    if (answer.kind === "unknown") {
      log.notice("subagent dispatch answer was not recognised; keeping the default", {
        sessionKey: entry.sessionKey,
        taskIndex: field.taskIndex,
        answer: answer.answer,
      })
      entry.choices.delete(field.taskIndex)
    }
    // `sameAsRest` keeps whatever the type form already wrote.
  }
  return release(entry, null)
}

function release(entry: PendingDispatch, note: string | null): SubagentDispatchStep {
  if (entry.account) {
    for (const [index, task] of entry.tasks.entries()) {
      const current = entry.choices.get(index) ?? {}
      entry.choices.set(index, { ...current, account: entry.account })
      void task
    }
  }
  // Remembered per agent type, from the first task of that type that resolved
  // to anything: a per-task override is about one task, not about the type.
  const seen = new Set<string>()
  for (const [index, task] of entry.tasks.entries()) {
    if (seen.has(task.agent)) continue
    const choice = entry.choices.get(index)
    if (!choice || (!choice.model && !choice.effort && !choice.account)) continue
    seen.add(task.agent)
    rememberDispatchChoice(entry.context.parentSessionId, task.agent, choice)
  }
  return {
    kind: "release",
    heldCallIds: entry.heldCallIds,
    tasks: entry.tasks,
    choices: entry.choices,
    parentSessionId: entry.context.parentSessionId,
    note,
  }
}

// ---------------------------------------------------------------------------
// Transcript handling
// ---------------------------------------------------------------------------

function isDispatchPart(part: any): boolean {
  if (!part || typeof part.toolCallId !== "string") return false
  if (part.type !== "tool-call" && part.type !== "tool-result") return false
  return part.toolCallId.startsWith(SUBAGENT_DISPATCH_TOOL_CALL_PREFIX)
}

/**
 * Remove the dispatch forms from a transcript: the synthetic `question` tool
 * calls and the `tool-result`s carrying their answers. Claude never issued
 * those calls and never saw those results, so replaying either would hand a
 * fresh session a conversation it cannot make sense of. Same shape, and the
 * same reasons, as `stripAccountFailoverParts`.
 */
export function stripSubagentDispatchParts<T extends Array<{ content?: unknown }>>(
  prompt: T,
): T {
  let changed = false
  const out: Array<{ content?: unknown }> = []
  for (const message of prompt) {
    const content = message.content
    if (!Array.isArray(content) || !content.some(isDispatchPart)) {
      out.push(message)
      continue
    }
    changed = true
    const kept = content.filter((part: any) => !isDispatchPart(part))
    if (kept.length === 0) continue
    out.push({ ...message, content: kept })
  }
  return (changed ? out : prompt) as T
}
