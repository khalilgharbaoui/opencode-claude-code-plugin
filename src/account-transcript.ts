/**
 * Carrying one Claude conversation across accounts.
 *
 * Accounts are separate `CLAUDE_CONFIG_DIR`s, and a conversation's whole state
 * is one file inside one of them: `<configDir>/projects/<encodeCwd(cwd)>/
 * <sessionId>.jsonl`. Until (h #g218) the plugin treated that as a wall and an
 * account switch replayed the entire thread as text into a fresh session on
 * the other account. Measured on Claude Code 2.1.288, the wall is not there:
 *
 *  - A config dir holding a copied transcript resumes it. The conversation
 *    kept its context (a codeword set before the copy was answered after it),
 *    the session kept its id, and the CLI appended to the copy rather than
 *    rewriting it: the first 42 records stayed byte-identical and the source
 *    transcript came out of the whole exchange byte-identical too.
 *  - **The FILENAME is the id the CLI resolves.** The `sessionId` recorded
 *    inside the records is not consulted: the same transcript saved under a
 *    new uuid resumed under that new uuid, while `--resume <original id>` in a
 *    config dir holding only the renamed copy answered "No conversation found
 *    with session ID: ...". That is what lets a carry take a fresh id when the
 *    target already holds a file at the original one.
 *  - **The CLI appends where it FOUND the file, not where the cwd says it
 *    should be.** A transcript placed under the wrong encoded cwd still
 *    resumed, and the CLI kept writing it there, which the interactive
 *    transport (it tails the path it computes from the cwd) would never see.
 *    So a carry writes the target's own encoded cwd and nothing else.
 *  - Nothing in a transcript record is account-specific: the union of record
 *    keys over a real conversation holds `sessionId`, `cwd`, `uuid`,
 *    `parentUuid`, `userType` and `version`, and no user, org or account id.
 *    There is nothing for a carry to rewrite.
 *
 * What is NOT measured is the other half: whether a DIFFERENT Anthropic
 * account's token answers a conversation produced under another one. Only one
 * account was logged in on the machine this was measured on, so the second
 * config dir was a scratch one holding a copy of the same credentials, which
 * isolates the file-layout question exactly and leaves the identity question
 * open. The API is stateless (each turn posts the whole message list, and a
 * transcript carries no server-side conversation handle), so there is no known
 * mechanism for it to fail; if it does, the turn errors, the CLI's own "No
 * conversation found" backstop forgets the id, and the next turn replays. That
 * is why every refusal here falls back to the replay rather than throwing, and
 * why `crossAccountResume` exists as an off switch.
 *
 * The copy is a COPY, never a link: two accounts appending to one inode would
 * interleave two conversations into one transcript. The source is never moved,
 * deleted or written to.
 */

import { randomUUID } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import { chmod, copyFile, lstat, mkdir } from "node:fs/promises"
import path from "node:path"

import { DEFAULT_ACCOUNT, accountConfigDirPath, normalizeAccountName } from "./accounts.js"
import { interactiveTranscriptPath, resolveConfigDir } from "./claude-session-bun.js"

/**
 * Where Claude Code keeps a session's transcript. Named for the transport that
 * needed it first; both write the same layout, which is what makes a carried
 * file resumable by either (measured on 2.1.288 with headless `--print`).
 */
const transcriptPath = interactiveTranscriptPath

/** The absolute config dir of an account, the default account included. */
export function configDirForAccount(account: string | undefined): string {
  const normalized = normalizeAccountName(account || DEFAULT_ACCOUNT)
  return resolveConfigDir(
    normalized === DEFAULT_ACCOUNT ? undefined : accountConfigDirPath(normalized),
  )
}

/**
 * Why a conversation was not carried. A kebab TOKEN rather than a sentence,
 * for the (h #g215) reason: `/claude-code-doctor bundle` allowlists `reason`
 * as an enum and `SAFE_ENUM` forbids spaces, so a sentence arrives redacted.
 */
export type TranscriptCarryRefusal =
  | "no-transcript-anywhere"
  | "target-not-a-file"
  | "copy-failed"

export type TranscriptCarry =
  /** The live transcript is already the target account's own. */
  | { kind: "already-there"; sessionId: string }
  /** Copied in. `sessionId` is what the target spawn must `--resume`. */
  | { kind: "carried"; sessionId: string; from: string; to: string; renamed: boolean }
  | { kind: "refused"; reason: TranscriptCarryRefusal; detail?: string }

export interface CarryTranscriptInput {
  /** The Claude session id the conversation is known by today. */
  sessionId: string
  /** The working directory both spawns run in; it names the projects dir. */
  cwd: string
  /** Absolute config dir the turn is about to spawn against. */
  targetConfigDir: string
  /** Every configured account's absolute config dir, the target's included. */
  accountConfigDirs: readonly string[]
  /** Test seam: the id a renamed copy takes. */
  newSessionId?: () => string
}

/**
 * Put this conversation's transcript under the account the turn is about to
 * spawn, and answer with the session id that spawn should resume.
 *
 * Which copy is live is decided by SIZE, because a transcript is append-only:
 * every copy of one conversation shares a prefix with every other, so the
 * longest is the one that has been written to most recently. It matters on the
 * way back. A switch from A to B leaves A's now-stale original in place, and a
 * later switch back to A finds both; resuming the one that happens to sit at
 * the target path would silently drop everything that happened on B.
 *
 * Never overwrites. A file already at the target path is some older copy of
 * this same conversation, and which of two files wins is not a question a copy
 * gets to answer, so the carry takes a fresh id instead, which the CLI
 * resolves by filename.
 */
export async function carryTranscriptToAccount(
  input: CarryTranscriptInput,
): Promise<TranscriptCarry> {
  const { sessionId, cwd, targetConfigDir } = input

  const targetOwn = transcriptPath({ configDir: targetConfigDir, cwd, sessionId })
  const targetOwnStat = await statTranscript(targetOwn)
  // Anything at the target path that is not a plain file (a symlink, above
  // all) would make `copyFile` write through it to somewhere this has no
  // business touching, so it is refused outright rather than worked around.
  if (targetOwnStat.kind === "other") {
    return { kind: "refused", reason: "target-not-a-file", detail: targetOwn }
  }

  let live: { file: string; size: number } | undefined
  for (const dir of dedupe([targetConfigDir, ...input.accountConfigDirs])) {
    const candidate = transcriptPath({ configDir: dir, cwd, sessionId })
    const stat =
      candidate === targetOwn ? targetOwnStat : await statTranscript(candidate)
    // A directory or a symlink where a transcript belongs is not a
    // conversation this plugin wrote, so it is no candidate either.
    if (stat.kind !== "file") continue
    if (!live || stat.size > live.size) live = { file: candidate, size: stat.size }
  }

  if (!live) return { kind: "refused", reason: "no-transcript-anywhere" }
  if (live.file === targetOwn) return { kind: "already-there", sessionId }

  const renamed = targetOwnStat.kind === "file"
  const carriedId = renamed ? (input.newSessionId ?? randomUUID)() : sessionId
  const target = renamed
    ? transcriptPath({ configDir: targetConfigDir, cwd, sessionId: carriedId })
    : targetOwn

  try {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    // COPYFILE_EXCL is the whole never-overwrite guarantee: the `lstat` above
    // narrows the failure modes, this closes the race between them.
    await copyFile(live.file, target, fsConstants.COPYFILE_EXCL)
    await chmod(target, 0o600)
  } catch (err) {
    return { kind: "refused", reason: "copy-failed", detail: String(err) }
  }

  return { kind: "carried", sessionId: carriedId, from: live.file, to: target, renamed }
}

/**
 * `file` plus its size for a plain file, `other` for anything else that exists
 * (a symlink, a directory), `none` for nothing there. `lstat`, never `stat`:
 * the point is to see a symlink rather than what it points at.
 */
async function statTranscript(
  file: string,
): Promise<{ kind: "file"; size: number } | { kind: "other" | "none"; size: 0 }> {
  try {
    const stat = await lstat(file)
    return stat.isFile() ? { kind: "file", size: stat.size } : { kind: "other", size: 0 }
  } catch {
    return { kind: "none", size: 0 }
  }
}

function dedupe(dirs: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const dir of dirs) {
    const resolved = path.resolve(dir)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    out.push(resolved)
  }
  return out
}
