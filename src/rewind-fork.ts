import { readFileSync } from "node:fs"
import type { RewoundConversation, ConversationCheckpoint } from "./conversation-gap.js"
import { cliSupportsResumeSessionAt, type CliVersion } from "./cli-version.js"

/**
 * Whether a rewound thread (an opencode undo, an edited message, a
 * regenerated reply; h #g242) can continue a copy of its Claude session cut
 * at the last turn both versions share, instead of a fresh session the
 * thread is replayed into as text (h #g282).
 *
 * The cut is the CLI's own: `--resume <id> --resume-session-at <uuid>
 * --fork-session` writes a NEW session holding the old one's conversation up
 * to and including that transcript entry, and leaves the old transcript
 * byte-identical. Measured on 2.1.288, 2.1.293 and 2.1.314 on a four-turn
 * thread cut after its second turn: the fork read the kept turns from the
 * prompt cache (38 to 121 tokens written against the replay's 11,152 to
 * 20,659), answered faster, and kept the document and the tool output the
 * replay's clipping dropped.
 *
 * Every answer but `fork` is a kebab token naming why the turn replays
 * instead, for the NOTICE (`/claude-code-doctor bundle` allowlists it as an
 * enum, so a sentence would arrive redacted). Pure apart from reading one
 * transcript, and it never throws: an unreadable file is a refusal.
 */
export type RewindForkPlan =
  | {
      kind: "fork"
      claudeSessionId: string
      messageUuid: string
      /** History entries the fork keeps, for the NOTICE. */
      keptMessages: number
      /** The checkpoints that survive the cut, for `restoreConversationCheckpoints`. */
      kept: ConversationCheckpoint[]
    }
  | { kind: "replay"; reason: RewindForkRefusal }

export type RewindForkRefusal =
  | "option-off"
  | "interactive-transport"
  | "no-checkpoint"
  | "cli-too-old"
  | "transcript-gone"
  | "entry-gone"

export async function planRewindFork(options: {
  change: RewoundConversation
  /** `forkOnRewind`. */
  enabled: boolean
  /**
   * The interactive transport stays on the replay: the CLI takes
   * `--resume-session-at` in print mode only ("Ignored outside print mode").
   */
  interactive: boolean
  /** Only awaited once a checkpoint exists, so a refused turn waits for nothing. */
  cliVersion: () => Promise<CliVersion | null>
  /** Where this turn's spawn would find a Claude session's transcript. */
  transcriptPath: (claudeSessionId: string) => string
}): Promise<RewindForkPlan> {
  if (!options.enabled) return { kind: "replay", reason: "option-off" }
  if (options.interactive) return { kind: "replay", reason: "interactive-transport" }
  const checkpoint = options.change.checkpoint
  if (!checkpoint) return { kind: "replay", reason: "no-checkpoint" }
  if (!cliSupportsResumeSessionAt(await options.cliVersion())) {
    return { kind: "replay", reason: "cli-too-old" }
  }
  // Checked here rather than left to the CLI: a cut it cannot find ends the
  // spawn with "No message found with message.uuid" and nothing written, which
  // would cost the operator a failed turn where the replay would have served.
  const holds = transcriptHoldsEntry(
    options.transcriptPath(checkpoint.claudeSessionId),
    checkpoint.messageUuid,
  )
  if (holds === null) return { kind: "replay", reason: "transcript-gone" }
  if (!holds) return { kind: "replay", reason: "entry-gone" }
  return {
    kind: "fork",
    claudeSessionId: checkpoint.claudeSessionId,
    messageUuid: checkpoint.messageUuid,
    keptMessages: checkpoint.anchor,
    kept: checkpoint.kept,
  }
}

/**
 * Whether the transcript at `path` has a record with this uuid: null when the
 * file cannot be read. A plain search for the record's own `"uuid"` key: a
 * `parentUuid` naming it does not match, and the CLI writes compact JSON.
 * One read per rewind, which is rare enough not to need a streaming scan.
 */
export function transcriptHoldsEntry(path: string, uuid: string): boolean | null {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return null
  }
  return text.includes(`"uuid":"${uuid}"`)
}
