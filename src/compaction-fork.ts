import { existsSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { findServedConversation } from "./conversation-gap.js"
import { log } from "./logger.js"
import { recheckNativeMemoryExcludes, type NativeMemoryExclude } from "./native-memory.js"
import {
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  getClaudeSessionId,
  peekActiveProcess,
} from "./session-manager.js"

type Prompt = Parameters<LanguageModelV3["doGenerate"]>[0]["prompt"]

/**
 * Compaction on a fork of the conversation's own Claude session (h #g284),
 * opt-in through `forkCompaction`.
 *
 * Today's `/compact` renders the thread as text (180,000 characters, newest
 * first) and asks a fresh process on the compaction model for a summary. A
 * fork instead resumes the conversation's Claude session with
 * `--fork-session` and asks for the summary inside it, so the summary is
 * written by the conversation's own model over the whole, unclipped
 * conversation, read from that model's prompt cache.
 *
 * What the cache keys on was measured on 2.1.314, against a 65,734-token
 * conversation: the model and the built-in tool set. A fork with the same
 * `--disallowedTools` read all of it; one with a different list, or with
 * `--tools ""`, read none. A different appended system prompt, no MCP config
 * at all, `--permission-mode dontAsk` in place of the skip flag and another
 * effort level all still read all of it. So the fork takes the conversation's
 * own spawn args, drops what would let it act (every MCP server, so no
 * proxied call can reach opencode, and the skip flag) and what belongs to the
 * conversation's process alone (its session, its prompt file, its caps and
 * effort), and keeps the rest.
 *
 * Pure apart from one `existsSync`, and every refusal is a reason token the
 * caller logs before taking today's path.
 */

/**
 * Appended after opencode's own compaction instruction. The fork still has the
 * conversation's tools, so it is told not to use them; with no MCP server and
 * `dontAsk`, nothing it could call reaches opencode or writes anything.
 */
export const COMPACTION_FORK_INSTRUCTION =
  "Answer with the summary text only. Do not call any tools: everything you need is in this conversation."

export interface CompactionFork {
  /** The conversation's own session key. */
  sourceKey: string
  /** The Claude session the fork branches off. */
  claudeSessionId: string
  /** The model the conversation runs on, read off its spawn. */
  model: string
  /** The fork's argv, `--resume <id> --fork-session` included. */
  cliArgs: string[]
}

export type CompactionForkPlan = { fork: CompactionFork } | { refused: string }

/** Flags the fork drops, by how many values each takes (`-1`: up to the next flag). */
const DROPPED_FLAGS: Record<string, number> = {
  "--resume": 1,
  "--session-id": 1,
  "--resume-session-at": 1,
  "--fork-session": 0,
  "--mcp-config": -1,
  "--strict-mcp-config": 0,
  "--dangerously-skip-permissions": 0,
  "--permission-mode": 1,
  "--append-system-prompt-file": 1,
  "--max-turns": 1,
  "--max-budget-usd": 1,
  "--effort": 1,
}

/** The value after `flag` in an argv, or undefined. */
export function argValue(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag)
  return at >= 0 && at + 1 < args.length ? args[at + 1] : undefined
}

/**
 * The fork's argv: the conversation's spawn args with the dropped flags taken
 * out, no MCP server at all, permission prompts refused rather than skipped
 * (a read-only spawn keeps its own `--restricted` posture), then the fork.
 */
export function compactionForkArgs(
  conversationArgs: readonly string[],
  claudeSessionId: string,
): string[] {
  const out: string[] = []
  for (let i = 0; i < conversationArgs.length; i++) {
    const arg = conversationArgs[i]
    const arity = DROPPED_FLAGS[arg]
    if (arity === undefined) {
      out.push(arg)
      continue
    }
    if (arity === -1) {
      while (i + 1 < conversationArgs.length && !conversationArgs[i + 1].startsWith("--")) i++
    } else {
      i += arity
    }
  }
  out.push("--strict-mcp-config")
  if (!out.includes("--restricted")) out.push("--permission-mode", "dontAsk")
  out.push("--resume", claudeSessionId, "--fork-session")
  return out
}

/** `<cwd>::<model>::<scope>::<affinity>::...`, the parts a compaction compares. */
function keyParts(sessionKey: string): { cwd: string; scope: string; affinity: string } | null {
  const parts = sessionKey.split("::")
  if (parts.length < 5) return null
  return { cwd: parts[0], scope: parts[2], affinity: parts[3] }
}

export interface ConversationProcessView {
  cliPath?: string
  cliArgs?: string[]
  /** What those args told Claude Code not to load itself (h #g303). */
  nativeMemoryExcludes?: NativeMemoryExclude[]
}

/**
 * Which conversation this compaction can fork, or why none.
 *
 * Every refusal keeps today's transcript path:
 *
 *  - the option is off, or this is the interactive transport, whose compaction
 *    runs in a tool-free TUI of its own (h #g199),
 *  - the request has no opencode session to tie it to (`default`),
 *  - no key in this cwd and session was last asked to continue exactly this
 *    conversation (the shape chain, `findServedConversation`),
 *  - that key has no Claude session, or its process is gone (its spawn args
 *    are what keep the cache, and a process long gone has a cold one),
 *  - the transcript may still be written to (a turn or a proxied call in
 *    flight): a fork of a transcript mid-write is not measured,
 *  - the process runs another binary (another account, h #g98),
 *  - its transcript is not where this account would resume it from,
 *  - the CLI lacks `--fork-session` or `dontAsk`.
 */
export async function planCompactionFork(opts: {
  enabled: boolean
  interactive: boolean
  cwd: string
  affinity: string
  prompt: Prompt
  cliPath: string
  /** `<configDir>/projects/<encodeCwd(cwd)>`, where the transcript must be. */
  transcriptDir: string
  lookupClaudeSessionId: (key: string) => string | undefined
  /** The key's live process, read without touching LRU order. */
  lookupProcess: (key: string) => ConversationProcessView | undefined
  isWriting: (key: string) => boolean
  /** `--fork-session` and `dontAsk` both supported. */
  cliSupportsFork: () => Promise<boolean>
}): Promise<CompactionForkPlan> {
  if (!opts.enabled) return { refused: "option-off" }
  if (opts.interactive) return { refused: "interactive-transport" }
  if (opts.affinity === "default") return { refused: "no-opencode-session" }

  const sourceKey = findServedConversation(opts.prompt, (key) => {
    const parts = keyParts(key)
    return (
      !!parts &&
      parts.scope !== "compaction" &&
      parts.cwd === opts.cwd &&
      parts.affinity === opts.affinity
    )
  })
  if (!sourceKey) return { refused: "no-matching-conversation" }

  const claudeSessionId = opts.lookupClaudeSessionId(sourceKey)
  if (!claudeSessionId) return { refused: "no-claude-session" }
  const process = opts.lookupProcess(sourceKey)
  if (!process?.cliArgs || process.cliArgs.length === 0) return { refused: "conversation-process-gone" }
  if (opts.isWriting(sourceKey)) return { refused: "conversation-still-writing" }
  if (process.cliPath && process.cliPath !== opts.cliPath) return { refused: "another-claude-binary" }
  const model = argValue(process.cliArgs, "--model")
  if (!model) return { refused: "conversation-model-unknown" }
  if (!existsSync(join(opts.transcriptDir, `${claudeSessionId}.jsonl`))) {
    return { refused: "transcript-gone" }
  }
  if (!(await opts.cliSupportsFork())) return { refused: "cli-too-old" }

  return {
    fork: {
      sourceKey,
      claudeSessionId,
      model,
      // The conversation's flag settings ride along, so an instruction file
      // edited since its spawn comes off their exclude list (h #g303).
      cliArgs: recheckNativeMemoryExcludes(
        compactionForkArgs(process.cliArgs, claudeSessionId),
        process.nativeMemoryExcludes,
      ).args,
    },
  }
}

/**
 * Says once per compaction which way it went. `reason` is a kebab token so a
 * diagnostic bundle keeps it (h #g215).
 */
export function logCompactionForkPlan(plan: CompactionForkPlan, sessionKey: string): void {
  if ("fork" in plan) {
    log.info("compacting on a fork of the conversation's claude session", {
      sessionKey,
      sourceKey: plan.fork.sourceKey,
      model: plan.fork.model,
    })
    return
  }
  if (plan.refused === "option-off") return
  log.info("compacting from a transcript instead of a fork", { sessionKey, reason: plan.refused })
}

/**
 * End a compaction fork once its turn is over: stop its process, forget its
 * id (only this compaction key ever held it) and delete its transcript, a
 * full copy of the conversation's. The conversation's own transcript is never
 * touched: an id equal to the source's is refused outright. Never throws.
 */
export async function retireCompactionFork(
  compactionKey: string,
  fork: CompactionFork,
  transcriptDir: string,
): Promise<void> {
  try {
    const forkId = getClaudeSessionId(compactionKey)
    if (peekActiveProcess(compactionKey)) await deleteActiveProcessAndWait(compactionKey)
    deleteClaudeSessionId(compactionKey)
    if (!forkId || forkId === fork.claudeSessionId || !transcriptDir) return
    try {
      unlinkSync(join(transcriptDir, `${forkId}.jsonl`))
    } catch {
      // Already gone, or never written: nothing to take back.
    }
  } catch (error) {
    log.info("could not retire a compaction fork", {
      sessionKey: compactionKey,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
