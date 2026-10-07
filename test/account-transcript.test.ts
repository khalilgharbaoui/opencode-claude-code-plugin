/**
 * Carrying a Claude transcript between account config dirs.
 *
 * The CLI half of this is measured, not asserted here (h #g218): 2.1.288
 * resumes a copied transcript under another config dir with its context
 * intact, resolves a session by FILENAME rather than by the `sessionId` in the
 * records, and appends to the copy it found rather than to the path the cwd
 * implies. What this file pins is the half that is ours: that the copy lands
 * where the target account's own spawn will look for it, that nothing is ever
 * overwritten or followed through a symlink, and that the stale copy an
 * earlier switch left behind can never be resumed in place of the live one.
 *
 * Usage: npx tsx --test test/account-transcript.test.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { carryTranscriptToAccount } from "../src/account-transcript.js"
import { encodeCwd, interactiveTranscriptPath } from "../src/claude-session-bun.js"

const SESSION = "11111111-2222-3333-4444-555555555555"

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "opencode-xacct-"))
  const cwd = join(root, "work")
  mkdirSync(cwd)
  return {
    root,
    cwd,
    source: join(root, ".claude-source"),
    target: join(root, ".claude-target"),
    /** Where an account's spawn will look for a session, and only there. */
    path: (configDir: string, sessionId = SESSION) =>
      interactiveTranscriptPath({ configDir, cwd, sessionId }),
    write: (configDir: string, body: string, sessionId = SESSION) => {
      const file = interactiveTranscriptPath({ configDir, cwd, sessionId })
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, body)
      return file
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test("a conversation is copied into the target account's own projects dir", async () => {
  const s = scratch()
  try {
    const source = s.write(s.source, '{"type":"user"}\n{"type":"assistant"}\n')

    const carry = await carryTranscriptToAccount({
      sessionId: SESSION,
      cwd: s.cwd,
      targetConfigDir: s.target,
      accountConfigDirs: [s.source, s.target],
    })

    assert.equal(carry.kind, "carried")
    if (carry.kind !== "carried") return
    // The id is unchanged, so the `--resume` both transports already build
    // needs nothing new, and the path is the one the target's own spawn and
    // the interactive transport's tail compute from the cwd.
    assert.equal(carry.sessionId, SESSION)
    assert.equal(carry.renamed, false)
    assert.equal(carry.to, s.path(s.target))
    assert.ok(carry.to.includes(encodeCwd(s.cwd)))
    assert.equal(readFileSync(carry.to, "utf8"), readFileSync(source, "utf8"))
    // The operator's conversations are not world-readable, and the directory
    // the plugin had to create for them is not either.
    // Windows has no POSIX modes (every file reads 0o666), the same reason
    // the other mode assertions in this suite are guarded (h #g217).
    if (process.platform !== "win32") {
      assert.equal(statSync(carry.to).mode & 0o777, 0o600)
      assert.equal(statSync(dirname(carry.to)).mode & 0o777, 0o700)
    }
    // A copy, never a link: two accounts appending to one inode would
    // interleave two conversations into one transcript.
    assert.notEqual(statSync(carry.to).ino, statSync(source).ino)
  } finally {
    s.cleanup()
  }
})

test("the source transcript is never moved, emptied or written to", async () => {
  const s = scratch()
  try {
    const body = '{"type":"user"}\n'
    const source = s.write(s.source, body)
    const before = statSync(source)

    await carryTranscriptToAccount({
      sessionId: SESSION,
      cwd: s.cwd,
      targetConfigDir: s.target,
      accountConfigDirs: [s.source, s.target],
    })

    assert.equal(readFileSync(source, "utf8"), body)
    assert.equal(statSync(source).ino, before.ino)
    assert.equal(statSync(source).mtimeMs, before.mtimeMs)
  } finally {
    s.cleanup()
  }
})

test("a conversation already under the target account is left alone", async () => {
  const s = scratch()
  try {
    const target = s.write(s.target, '{"a":1}\n{"a":2}\n')
    // An older copy the other account still holds from an earlier switch.
    s.write(s.source, '{"a":1}\n')

    const carry = await carryTranscriptToAccount({
      sessionId: SESSION,
      cwd: s.cwd,
      targetConfigDir: s.target,
      accountConfigDirs: [s.source, s.target],
    })

    assert.deepEqual(carry, { kind: "already-there", sessionId: SESSION })
    assert.equal(readFileSync(target, "utf8"), '{"a":1}\n{"a":2}\n')
  } finally {
    s.cleanup()
  }
})

test("a stale copy at the target is never resumed in place of the live one", async () => {
  const s = scratch()
  try {
    // The shape of a switch back: A sent the conversation to B, B grew it,
    // and A's own original is still sitting at the path A would resume.
    const stale = s.write(s.target, '{"a":1}\n')
    const live = s.write(s.source, '{"a":1}\n{"a":2}\n{"a":3}\n')

    const carry = await carryTranscriptToAccount({
      sessionId: SESSION,
      cwd: s.cwd,
      targetConfigDir: s.target,
      accountConfigDirs: [s.source, s.target],
      newSessionId: () => "99999999-0000-0000-0000-000000000000",
    })

    assert.equal(carry.kind, "carried")
    if (carry.kind !== "carried") return
    // The CLI resolves a session by filename, so the live conversation is
    // carried under a new id rather than overwriting the stale file.
    assert.equal(carry.renamed, true)
    assert.equal(carry.sessionId, "99999999-0000-0000-0000-000000000000")
    assert.equal(carry.from, live)
    assert.equal(carry.to, s.path(s.target, "99999999-0000-0000-0000-000000000000"))
    assert.equal(readFileSync(carry.to, "utf8"), '{"a":1}\n{"a":2}\n{"a":3}\n')
    assert.equal(readFileSync(stale, "utf8"), '{"a":1}\n', "the stale file is not touched")
  } finally {
    s.cleanup()
  }
})

test("the live copy is the longest one, whichever account holds it", async () => {
  const s = scratch()
  try {
    const third = join(s.root, ".claude-third")
    s.write(s.source, '{"a":1}\n')
    const live = s.write(third, '{"a":1}\n{"a":2}\n{"a":3}\n')

    const carry = await carryTranscriptToAccount({
      sessionId: SESSION,
      cwd: s.cwd,
      targetConfigDir: s.target,
      accountConfigDirs: [s.source, third, s.target],
    })

    assert.equal(carry.kind, "carried")
    if (carry.kind !== "carried") return
    assert.equal(carry.from, live)
  } finally {
    s.cleanup()
  }
})

test("nothing to carry is a refusal, not an empty file", async () => {
  const s = scratch()
  try {
    const carry = await carryTranscriptToAccount({
      sessionId: SESSION,
      cwd: s.cwd,
      targetConfigDir: s.target,
      accountConfigDirs: [s.source, s.target],
    })

    assert.deepEqual(carry, { kind: "refused", reason: "no-transcript-anywhere" })
    // A refusal replays instead, so it must not have left a transcript behind
    // for the next turn to resume into.
    assert.equal(
      readdirSync(s.root).includes(".claude-target"),
      false,
      "a refusal creates nothing under the target account",
    )
  } finally {
    s.cleanup()
  }
})

test("a symlink at the target path is refused, never written through", async () => {
  const s = scratch()
  try {
    s.write(s.source, '{"a":1}\n')
    const elsewhere = join(s.root, "somebody-elses-file")
    writeFileSync(elsewhere, "do not touch\n")
    const targetPath = s.path(s.target)
    mkdirSync(dirname(targetPath), { recursive: true })
    symlinkSync(elsewhere, targetPath)

    const carry = await carryTranscriptToAccount({
      sessionId: SESSION,
      cwd: s.cwd,
      targetConfigDir: s.target,
      accountConfigDirs: [s.source, s.target],
    })

    assert.equal(carry.kind, "refused")
    if (carry.kind !== "refused") return
    assert.equal(carry.reason, "target-not-a-file")
    assert.equal(readFileSync(elsewhere, "utf8"), "do not touch\n")
    assert.equal(lstatSync(targetPath).isSymbolicLink(), true)
  } finally {
    s.cleanup()
  }
})

test("a directory where a transcript belongs is no candidate and no target", async () => {
  const s = scratch()
  try {
    // A source that is a directory is skipped rather than refused: another
    // account's odd directory is not a reason to refuse the whole carry.
    mkdirSync(s.path(s.source), { recursive: true })
    const third = join(s.root, ".claude-third")
    s.write(third, '{"a":1}\n')

    const carried = await carryTranscriptToAccount({
      sessionId: SESSION,
      cwd: s.cwd,
      targetConfigDir: s.target,
      accountConfigDirs: [s.source, third, s.target],
    })
    assert.equal(carried.kind, "carried")

    // A target that is a directory is refused, because a copy there cannot
    // mean what the CLI will read.
    const blocked = scratch()
    try {
      blocked.write(blocked.source, '{"a":1}\n')
      mkdirSync(blocked.path(blocked.target), { recursive: true })
      const carry = await carryTranscriptToAccount({
        sessionId: SESSION,
        cwd: blocked.cwd,
        targetConfigDir: blocked.target,
        accountConfigDirs: [blocked.source, blocked.target],
      })
      assert.equal(carry.kind, "refused")
      if (carry.kind !== "refused") return
      assert.equal(carry.reason, "target-not-a-file")
    } finally {
      blocked.cleanup()
    }
  } finally {
    s.cleanup()
  }
})

test("a copy that cannot be made is a refusal, not a throw", async () => {
  const s = scratch()
  try {
    s.write(s.source, '{"a":1}\n')
    // A target config dir nested under a plain file, so `mkdir` fails. Any
    // filesystem refusal (a full disk, a directory another user owns) lands
    // here, and it has to fall back to the replay rather than take the turn
    // down with it.
    const notADir = join(s.root, "a-file")
    writeFileSync(notADir, "")

    const carry = await carryTranscriptToAccount({
      sessionId: SESSION,
      cwd: s.cwd,
      targetConfigDir: join(notADir, "config"),
      accountConfigDirs: [s.source],
    })

    assert.equal(carry.kind, "refused")
    if (carry.kind !== "refused") return
    assert.equal(carry.reason, "copy-failed")
  } finally {
    s.cleanup()
  }
})
