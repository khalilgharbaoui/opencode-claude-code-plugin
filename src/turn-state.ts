import type {
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import { generateId } from "./ids.js"
import type { ClaudeStreamMessage } from "./types.js"
import type { ActiveProcess } from "./session-manager.js"
import type { ProxyMcpServer } from "./proxy-mcp.js"
import type { PendingProxyCall } from "./proxy-broker.js"
import type { AutoContinueState } from "./auto-continue.js"
import type { ModelRefusal } from "./model-fallback.js"
import type { AccountBlockKind } from "./account-failover.js"

/**
 * The turn's own mutable state, lifted out of `doStreamForHost`'s `start()`
 * closure verbatim.
 *
 * Nothing here is new. Every field was a `let` or a `const` collection shared
 * by the line handler, the close handler, the batched drain, the two
 * watchdogs, the result fallback, auto-continue, the failover and
 * fallback-chain branches and `completeResult`, all of which closed over one
 * scope. Naming that scope is the whole change: the handlers can now be read,
 * and moved, one at a time, and the comment on each field says which invariant
 * owns it so a later edit knows what it is standing on.
 *
 * One `TurnState` per turn, created inside `start()` so the env-derived
 * timings below are re-read per turn exactly as they were.
 */

/**
 * Metadata the terminal `result` frame contributes to `providerMetadata`.
 * A type alias, not an interface: the AI SDK's `JSONObject` needs an implicit
 * index signature, which TypeScript grants an anonymous object type (what this
 * was inline) and refuses an interface.
 */
export type TurnResultMeta = {
  sessionId?: string
  costUsd?: number
  durationMs?: number
  durationApiMs?: number
  numTurns?: number
  usage?: ClaudeStreamMessage["usage"]
  modelUsage?: ClaudeStreamMessage["modelUsage"]
  permissionDenials?: ClaudeStreamMessage["permission_denials"]
}

/** One entry of the content-block-index keyed tool table. */
export interface TurnToolCallEntry {
  id: string
  name: string
  inputJson: string
  started: boolean
  /**
   * The opencode-side name `tool-input-start` went out under, set only when
   * `started`. A step that ends before this block closes has to finish the
   * part itself, and a `tool-call` must carry the name its `tool-input-start`
   * did (h #g190).
   */
  mappedName?: string
}

export interface TurnState {
  // ---- Facts fixed for the whole turn -------------------------------------

  /** The stream every handler writes into. One controller per turn. */
  readonly controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>
  /** The plugin's session key (`sk`): every session-manager and broker call keys on it. */
  readonly sessionKey: string
  /** Spawn cwd, as resolved by `resolveSpawnCwdForSession`; a respawn reuses it. */
  readonly cwd: string
  /** The binary this turn spawned; a respawn must reuse it or it crosses accounts. */
  readonly cliPath: string
  /** Passed to a respawn so `claudeSpawnEnv` strips the key the same way. */
  readonly ignoreAnthropicApiKey?: boolean
  /** Bound `this.toUsage`, so a moved handler keeps the model's own conversion. */
  readonly toUsage: (raw?: ClaudeStreamMessage["usage"]) => LanguageModelV3Usage
  /** Bound `this.toFinishReason`, same reason. */
  readonly toFinishReason: (
    reason?: "stop" | "tool-calls" | "error",
  ) => LanguageModelV3FinishReason
  /** Wire-inactivity delay; `CLAUDE_CODE_RESULT_FALLBACK_MS` is the test seam. */
  readonly resultFallbackMs: number
  /** Start-watchdog delay; `CLAUDE_CODE_START_WATCHDOG_MS` is the test seam. */
  readonly startWatchdogMs: number

  // ---- Spawn slots --------------------------------------------------------
  // Filled by the spawn block before any handler is attached, and replaced
  // together by the start watchdog's respawn. Declared non-optional because
  // every reader runs after that point, exactly as the `let proc:
  // ChildProcess` they replaced did.

  /** The `ActiveProcess` this turn is attached to; a respawn swaps it. */
  activeProcess: ActiveProcess | undefined
  /** The child. Every stdin write asking for work pairs with `noteTurnStarted`. */
  proc: import("child_process").ChildProcess
  /** The child's line emitter. `cleanupTurn` must detach from this exact object. */
  lineEmitter: import("events").EventEmitter
  /** argv the child was spawned with; the respawn path appends `--resume` to it. */
  cliArgs: string[]
  /** The turn's proxy MCP server, reused across a respawn rather than rebuilt. */
  proxyServer: ProxyMcpServer | null

  // ---- Text blocks --------------------------------------------------------

  /** The open text part, or null. Every `▌` note needs a part of its own. */
  currentTextId: string | null
  /** Content-block indices that are text, so `content_block_stop` closes the part. */
  readonly textBlockIndices: Set<number>
  /** Open a text part, closing any open one first. */
  startTextBlock(): string
  /** Close the open text part, if there is one. */
  endTextBlock(): void

  // ---- Reasoning ----------------------------------------------------------

  /** Content-block index to reasoning part id. Cleared by `conversation_reset`. */
  readonly reasoningIds: Map<number, string>
  /** Whether `reasoning-start` was emitted for that index: only a non-empty `thinking_delta` starts one. */
  readonly reasoningStarted: Map<number, boolean>
  /** Whether the stream already carried thinking text, so the assistant-frame fallback stays quiet. */
  hadThinkingTextFromStream: boolean

  // ---- Turn lifecycle -----------------------------------------------------

  /**
   * This turn has asked the Claude CLI to do work: it wrote the envelope, or
   * it resolved a parked proxy call and set the CLI's turn going again. False
   * means the turn is still being prepared, which is what the abort handler
   * reads to decide that there is nothing to interrupt and nothing to release
   * (h #g182). Never true for a turn that only reused an idle process.
   */
  cliAskedForWork: boolean
  /**
   * `stream-start` has been enqueued. The abort handler is registered before
   * the spawn now, so it can be the first thing to touch the controller, and
   * enqueuing `stream-start` twice is a protocol violation rather than a
   * throw.
   */
  streamStarted: boolean
  /** A terminal `result` was seen. A close without one is a crash, not a stop. */
  turnCompleted: boolean
  /** The stream is finished. Every handler returns early on it. */
  controllerClosed: boolean
  /** `cleanupTurn` ran; it is idempotent so every exit path may call it. */
  cleanedUp: boolean
  /** A buffered `result` from between turns: its late proxy results need recovery. */
  unattendedTurnEnded: boolean
  /** What a respawn re-sends: this turn's envelope, or the late-result message. */
  watchdogMessage: string
  /** Broker subscription for this turn; `cleanupTurn` drops it. */
  pendingProxyUnsubscribe: (() => void) | null
  /** `/btw` inline sink; its unregister deletes only its own sink. */
  asideSinkUnregister: (() => void) | null

  // ---- Watchdogs ----------------------------------------------------------

  /** Wire-inactivity timer. Reset by every line; never arms before content. */
  resultFallbackTimer: ReturnType<typeof setTimeout> | null
  /** Start watchdog timer, armed only on the fresh-turn write path. */
  startWatchdog: ReturnType<typeof setTimeout> | null
  /** First fire respawns, a second ends the turn. */
  respawnAttempted: boolean

  // ---- Progress -----------------------------------------------------------

  /** The operator has seen text. Gates the inactivity watchdog and the abort grace. */
  hasReceivedContent: boolean
  /** The model did something, text or a tool block. Disarms the start watchdog. */
  hasReceivedProgress: boolean
  /** A `stream_event` envelope was seen, so the whole `assistant` frame is a duplicate. */
  gotPartialEvents: boolean

  // ---- The auto-continue window -------------------------------------------
  // `resetAutoContinueWindow` clears these on every nudge, which is why they
  // can never answer the silent-turn question.

  /** All visible text since the last nudge. */
  visibleTextSinceContinue: string
  /** Visible text of the current block only, for final-answer detection. */
  lastVisibleTextSinceContinue: string
  /** Reasoning since the last nudge. */
  hadReasoningSinceContinue: boolean
  /** CLI tool activity since the last nudge. */
  hadToolActivitySinceContinue: boolean
  /** Proxy tool activity since the last nudge; also gates the result-boundary grace. */
  hadProxyActivitySinceContinue: boolean

  // ---- Stream-scoped snapshot ---------------------------------------------
  // The same four signals for the whole stream. `isSilentTurn` reads these,
  // never the counters above.

  /** Any visible text this whole stream. */
  sawVisibleText: boolean
  /** Any reasoning this whole stream; the silent-turn note says so. */
  sawReasoning: boolean
  /** Any CLI tool activity this whole stream. */
  sawToolActivity: boolean
  /** Any proxy tool activity this whole stream. */
  sawProxyActivity: boolean

  /** The CLI's own stop reason, which `shouldAutoContinueIncompleteTurn` treats as authoritative. */
  lastStopReason: string | null
  /** Attempts, elapsed, abort and the AskUserQuestion latch. */
  readonly autoContinueState: AutoContinueState

  // ---- Tool bookkeeping ---------------------------------------------------

  /** Keyed by content-block index and MUST be deleted at `content_block_stop`. */
  readonly toolCallMap: Map<number, TurnToolCallEntry>
  /** Ids opencode runs itself, so the CLI's own `tool_result` must not be forwarded. */
  readonly skipResultForIds: Set<string>
  /** Tool call id to its MAPPED name: a `tool-result` must carry the name its `tool-call` did. */
  readonly toolCallsById: Map<string, { id: string; name: string; input: unknown }>
  /**
   * Ids a `tool-call` part has already gone out for. Three different frames
   * can be the first to need one (the block's close, the CLI's own result, the
   * end of a step that waits on a proxied call), and opencode aborts a part
   * that gets two (h #g190).
   */
  readonly toolCallEmittedIds: Set<string>
  /**
   * Ids a `tool-result` part has already gone out for. The CLI's result can
   * precede the block's close, so without this the close re-registers an id
   * that is already finished and the step's closeout answers it a second time
   * (h #g190).
   */
  readonly toolCallAnsweredIds: Set<string>

  // ---- The terminal result ------------------------------------------------

  /** Filled by the `result` frame; the close handler's finish reads it too. */
  resultMeta: TurnResultMeta
  /**
   * Usage of the newest `assistant` frame that was a real API call, for the
   * whole stream. A finish's usage is read by opencode as context occupancy,
   * and `result.usage` is summed over the turn, so every finish that reports
   * a result's usage goes through `lastCallContextUsage` with this. A
   * zero-usage (`<synthetic>`) frame must never overwrite it.
   */
  lastCallUsage: ClaudeStreamMessage["usage"]
  /** Subtype of a failing `result`, so the finish reports an error not a stop. */
  resultFailure: string | undefined
  /**
   * Set only by a REJECTED rate-limit event, the CLI's own `rate_limit` reply,
   * or a known account-limit text. The note and the switch form both read it.
   */
  accountLimitHit: { resetsAt?: number; window?: string; resetsText?: string } | null
  /**
   * The sentence of a CLI API-error reply this turn already rendered. A
   * failing `result` repeats it verbatim as `result`, and rendering both put
   * the same sentence on screen twice (measured on a refused model, h #g209).
   */
  apiErrorTextShown: string | null
  /**
   * Whether this turn ends with the `▌ **usage limit:**` note (h #g194).
   * Decided in ONE place, the `result` frame in src/stream-parser.ts, because
   * two things read it and they must never disagree: that frame suppresses the
   * CLI's own error text when the note is coming, and `completeResult` writes
   * the note itself after the switch form and the fallback chain have each had
   * their chance to take the turn instead.
   */
  usageLimitNote: boolean
  /**
   * The CLI's own sentence for the failure that ended a COMPACTION turn, or
   * null. A compaction turn's text is what opencode stores as the summary, so
   * a failed one renders none of the CLI's error prose (a usage limit became
   * the whole of a stored summary, issue #90); the sentence is carried here
   * instead, for the `error` stream part `completeResult` ends the turn on.
   * Never read outside compaction. (h #g214)
   */
  compactionFailureText: string | null
  /** Read from the `error` kind on the CLI's failure reply, never from its text. */
  accountBlock: AccountBlockKind | null
  /** Set only when a fallback is armed, so a turn with no chain is unchanged. */
  modelRefusal: ModelRefusal | null

  // ---- The batched drain --------------------------------------------------

  /** Proxy calls waiting to leave in one `tool-calls` finish. */
  readonly drainBuffer: PendingProxyCall[]
  /** Quiet timer for the drain and for the result boundary; they share it. */
  drainTimer: ReturnType<typeof setTimeout> | null
  /** The `result` whose completion the boundary is holding, or null. */
  pendingResultCompletion: (() => void) | null

  // ---- Handler slots ------------------------------------------------------
  // Assigned once the handlers exist. Held here rather than closed over so the
  // respawn path, which detaches and re-attaches all three, can read them out
  // of the state instead of out of a scope above it.

  lineHandler: (line: string) => void
  closeHandler: () => void
  procErrorHandler: (err: Error) => void
  /** Centralised per-turn teardown; idempotent. */
  cleanupTurn: () => void
}

export interface TurnStateInit {
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>
  sessionKey: string
  cwd: string
  cliPath: string
  ignoreAnthropicApiKey?: boolean
  /** This turn's envelope, which is also what a respawn re-sends. */
  userMsg: string
  /** `autoContinueEnabledFor(compactionMode, configured)`, resolved by the caller. */
  autoContinueEnabled: AutoContinueState["enabled"]
  toUsage: (raw?: ClaudeStreamMessage["usage"]) => LanguageModelV3Usage
  toFinishReason: (
    reason?: "stop" | "tool-calls" | "error",
  ) => LanguageModelV3FinishReason
}

/**
 * Wire-inactivity watchdog delay. Read per turn, because the regression test
 * sets the env var between runs.
 */
function resolveResultFallbackMs(): number {
  const env = process.env.CLAUDE_CODE_RESULT_FALLBACK_MS
  const parsed = env ? Number.parseInt(env, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000
}

/** Start watchdog delay, read per turn for the same reason. */
function resolveStartWatchdogMs(): number {
  const env = process.env.CLAUDE_CODE_START_WATCHDOG_MS
  const parsed = env ? Number.parseInt(env, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90_000
}

/**
 * A slot the spawn block fills before anything reads it. The closure this
 * replaced declared `let proc: ChildProcess` with no initialiser and relied on
 * the same guarantee, so the cast keeps every call site identical rather than
 * spreading `!` through code that was moved verbatim.
 */
function unassigned<T>(): T {
  return undefined as unknown as T
}

export function createTurnState(init: TurnStateInit): TurnState {
  const state: TurnState = {
    controller: init.controller,
    sessionKey: init.sessionKey,
    cwd: init.cwd,
    cliPath: init.cliPath,
    ignoreAnthropicApiKey: init.ignoreAnthropicApiKey,
    toUsage: init.toUsage,
    toFinishReason: init.toFinishReason,
    resultFallbackMs: resolveResultFallbackMs(),
    startWatchdogMs: resolveStartWatchdogMs(),

    activeProcess: undefined,
    proc: unassigned(),
    lineEmitter: unassigned(),
    cliArgs: unassigned(),
    proxyServer: null,

    currentTextId: null,
    textBlockIndices: new Set<number>(),
    startTextBlock(): string {
      if (state.currentTextId) {
        state.controller.enqueue({ type: "text-end", id: state.currentTextId })
      }
      const id = generateId()
      state.currentTextId = id
      state.controller.enqueue({ type: "text-start", id } as any)
      return id
    },
    endTextBlock(): void {
      if (state.currentTextId) {
        state.controller.enqueue({ type: "text-end", id: state.currentTextId })
        state.currentTextId = null
      }
    },

    reasoningIds: new Map<number, string>(),
    reasoningStarted: new Map<number, boolean>(),
    hadThinkingTextFromStream: false,

    cliAskedForWork: false,
    streamStarted: false,
    turnCompleted: false,
    controllerClosed: false,
    cleanedUp: false,
    unattendedTurnEnded: false,
    watchdogMessage: init.userMsg,
    pendingProxyUnsubscribe: null,
    asideSinkUnregister: null,

    resultFallbackTimer: null,
    startWatchdog: null,
    respawnAttempted: false,

    hasReceivedContent: false,
    hasReceivedProgress: false,
    gotPartialEvents: false,

    visibleTextSinceContinue: "",
    lastVisibleTextSinceContinue: "",
    hadReasoningSinceContinue: false,
    hadToolActivitySinceContinue: false,
    hadProxyActivitySinceContinue: false,

    sawVisibleText: false,
    sawReasoning: false,
    sawToolActivity: false,
    sawProxyActivity: false,

    lastStopReason: null,
    autoContinueState: {
      enabled: init.autoContinueEnabled,
      attempts: 0,
      startedAt: Date.now(),
      noProgressCount: 0,
    },

    toolCallMap: new Map<number, TurnToolCallEntry>(),
    skipResultForIds: new Set<string>(),
    toolCallsById: new Map<string, { id: string; name: string; input: unknown }>(),
    toolCallEmittedIds: new Set<string>(),
    toolCallAnsweredIds: new Set<string>(),

    resultMeta: {},
    lastCallUsage: undefined,
    resultFailure: undefined,
    accountLimitHit: null,
    apiErrorTextShown: null,
    usageLimitNote: false,
    compactionFailureText: null,
    accountBlock: null,
    modelRefusal: null,

    drainBuffer: [],
    drainTimer: null,
    pendingResultCompletion: null,

    lineHandler: unassigned(),
    closeHandler: unassigned(),
    procErrorHandler: unassigned(),
    cleanupTurn: unassigned(),
  }
  return state
}

/**
 * The JSON input accumulated for a CLI-executed call that is still streaming,
 * as a string, or `"{}"` when the block is gone or empty. The entry is keyed
 * by content-block index and deleted when the block closes (h #g76), so this
 * is a scan over the few blocks of one assistant message.
 */
export function cliToolCallInputJson(state: TurnState, id: string): string {
  for (const entry of state.toolCallMap.values()) {
    if (entry.id === id) return entry.inputJson || "{}"
  }
  return "{}"
}

/**
 * Emit the `tool-call` part for a CLI-executed id, at most once per turn.
 *
 * `tool-input-start` goes out at `content_block_start`, and until (h #g190)
 * the matching `tool-call` went out only at `content_block_stop`. Both the
 * CLI's own `tool_result` and the end of a step waiting on a proxied call can
 * arrive before that, and each of them needs the part completed, so all three
 * call this and the first one wins.
 */
export function emitCliToolCall(
  state: TurnState,
  id: string,
  name: string,
  inputJson: string,
  executed: boolean,
): void {
  if (state.toolCallEmittedIds.has(id)) return
  state.toolCallEmittedIds.add(id)
  state.controller.enqueue({
    type: "tool-call",
    toolCallId: id,
    toolName: name,
    input: inputJson,
    providerExecuted: executed,
  } as any)
}
