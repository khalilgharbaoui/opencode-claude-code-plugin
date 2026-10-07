/**
 * The interactive transport reads the TUI's transcript forwards only, from a
 * byte offset, instead of re-reading the whole file every `pollMs` (h #g216).
 *
 * The cases here are the ones a byte offset gets wrong if nobody writes them
 * down: a record the CLI is part way through writing, a transcript that does
 * not exist until the first prompt is accepted, a file truncated or replaced
 * under the offset, a fork's copied history, and the poll that must cost
 * nothing because nothing was appended. The first half drives
 * `TranscriptCursor` directly; the second drives a real `ClaudeSession` over a
 * scripted PTY, so the poll loop, the submit confirmation and the fork's
 * own-prompt gate all run unmodified.
 */
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import {
  ClaudeSession,
  TranscriptCursor,
  interactiveTranscriptPath,
  type ClaudeSessionOptions,
  type PtySpawner,
} from "../src/claude-session-bun.js"

const FAST = {
  bootMinMs: 0,
  bootQuietMs: 10,
  bootMaxMs: 3_000,
  pollMs: 5,
  submitMinMs: 0,
  submitConfirmMs: 200,
  stopSettleMs: 30,
  permissionQuietMs: 15,
  heartbeatMs: 1_000_000,
  turnTimeoutMs: 10_000,
} satisfies Partial<ClaudeSessionOptions>

function scratchFile(name = "session.jsonl"): { dir: string; file: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccp-cursor-")))
  return { dir, file: path.join(dir, name) }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// TranscriptCursor on its own.
// ---------------------------------------------------------------------------

test("a record written across two reads is handed on once, whole", () => {
  const { dir, file } = scratchFile()
  try {
    const cursor = new TranscriptCursor(() => file)
    const record = JSON.stringify({ type: "assistant", text: "half and half" })
    fs.writeFileSync(file, record.slice(0, 12))
    assert.deepEqual(cursor.pending(), [], "a line with no newline is not complete")
    assert.equal(cursor.lineCount(), 0)

    fs.appendFileSync(file, record.slice(12) + "\n")
    assert.deepEqual(cursor.pending(), [record], "the two halves are one line")
    cursor.take(1)
    assert.deepEqual(cursor.pending(), [], "and it is not handed on twice")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a multi-byte character split across two reads is decoded, not mangled", () => {
  const { dir, file } = scratchFile()
  try {
    const cursor = new TranscriptCursor(() => file)
    const record = JSON.stringify({ type: "assistant", text: "café ☕" })
    const bytes = Buffer.from(record + "\n", "utf8")
    // Cut inside the two-byte "é", which is exactly what a read landing
    // mid-write does to a transcript the CLI writes in UTF-8.
    const cut = bytes.indexOf(Buffer.from("é", "utf8")) + 1
    fs.writeFileSync(file, bytes.subarray(0, cut))
    assert.deepEqual(cursor.pending(), [])
    fs.appendFileSync(file, bytes.subarray(cut))
    assert.deepEqual(cursor.pending(), [record])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a poll of an unchanged file reads no bytes at all", () => {
  const { dir, file } = scratchFile()
  try {
    const cursor = new TranscriptCursor(() => file)
    fs.writeFileSync(file, "one\ntwo\n")
    assert.deepEqual(cursor.pending(), ["one", "two"])
    cursor.take(2)
    const after = { ...cursor.stats }
    assert(after.bytes > 0, "the first poll did read the file")

    for (let i = 0; i < 5; i++) assert.deepEqual(cursor.pending(), [])
    assert.equal(cursor.stats.bytes, after.bytes, "no byte is read twice")
    assert.equal(cursor.stats.reads, after.reads, "and no read syscall is made")
    assert.equal(cursor.stats.polls, after.polls + 5, "the polls did happen")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a transcript that does not exist yet is read from its start once it appears", () => {
  const { dir, file } = scratchFile()
  try {
    const cursor = new TranscriptCursor(() => file)
    // The TUI writes the transcript when it accepts the first prompt, so this
    // is the state every fresh session starts in.
    assert.deepEqual(cursor.pending(), [])
    assert.equal(cursor.lineCount(), 0)
    assert.equal(cursor.stats.bytes, 0, "a path with nothing behind it costs no read")
    cursor.skipToEnd()

    fs.writeFileSync(file, "first\nsecond\n")
    assert.deepEqual(cursor.pending(), ["first", "second"], "nothing is missed")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a truncated file is read again from zero without handing a line on twice", () => {
  const { dir, file } = scratchFile()
  try {
    const cursor = new TranscriptCursor(() => file)
    fs.writeFileSync(file, "a\nb\nc\n")
    assert.deepEqual(cursor.pending(), ["a", "b", "c"])
    cursor.take(3)

    // Shorter than the offset: the bytes the offset described are gone. The
    // read starts over and re-skips the three lines already handed on, which
    // is what a line index meant when every poll re-read the whole file.
    fs.writeFileSync(file, "A\nB\nC\nD\nE\n")
    assert.deepEqual(cursor.pending(), ["D", "E"])
    cursor.take(2)
    assert.deepEqual(cursor.pending(), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a replaced file is spotted by its inode, not only by its size", () => {
  const { dir, file } = scratchFile()
  try {
    const cursor = new TranscriptCursor(() => file)
    fs.writeFileSync(file, "a\nb\n")
    assert.deepEqual(cursor.pending(), ["a", "b"])
    cursor.take(2)

    // A new file of the SAME size: nothing about the offset says so.
    const replacement = path.join(dir, "replacement.jsonl")
    fs.writeFileSync(replacement, "x\ny\n")
    fs.renameSync(replacement, file)
    assert.notEqual(fs.statSync(file).size, 0)
    assert.deepEqual(cursor.pending(), [], "two lines were handed on already")

    fs.appendFileSync(file, "z\n")
    assert.deepEqual(cursor.pending(), ["z"], "and the file is followed again")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("skipToEnd hands on nothing that is already written", () => {
  const { dir, file } = scratchFile()
  try {
    const cursor = new TranscriptCursor(() => file)
    fs.writeFileSync(file, "old\nolder\npartial-with-no-newline")
    cursor.skipToEnd()
    assert.deepEqual(cursor.pending(), [])

    fs.appendFileSync(file, "-finished\nnew\n")
    assert.deepEqual(
      cursor.pending(),
      ["partial-with-no-newline-finished", "new"],
      "the line that was incomplete at the end is still this turn's",
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The same cases through a real session and its poll loop.
// ---------------------------------------------------------------------------

const userRecord = (text: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: text } })

const assistantRecord = (id: string, stopReason: string | null, text: string) =>
  JSON.stringify({
    type: "assistant",
    message: {
      id,
      role: "assistant",
      stop_reason: stopReason,
      content: [{ type: "text", text }],
      usage: { input_tokens: 3, cache_read_input_tokens: 100, output_tokens: 7 },
    },
  })

/**
 * A PTY that creates nothing until the prompt is submitted, then runs the
 * caller's script against the transcript the session is tailing.
 */
function scriptedTui(script: (append: (chunk: string) => void) => void) {
  let transcript = ""
  let resolveExit: (code: number | null) => void = () => {}
  let pasted = false
  let submitted = false
  const spawner: PtySpawner = (argv, opts) => {
    const at = (flag: string) => argv[argv.indexOf(flag) + 1]
    transcript = interactiveTranscriptPath({
      configDir: opts.env.CLAUDE_CONFIG_DIR,
      cwd: opts.cwd,
      sessionId: argv.includes("--fork-session") ? at("--session-id")! : at("--session-id")!,
    })
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    return {
      exited: new Promise<number | null>((resolve) => (resolveExit = resolve)),
      kill: () => resolveExit(null),
      terminal: {
        write: (data: string) => {
          if (data.startsWith("\x1b[200~")) return void (pasted = true)
          if (data !== "\r" || !pasted || submitted) return
          submitted = true
          script((chunk) => fs.appendFileSync(transcript, chunk))
        },
        close: () => {},
      },
    }
  }
  return { spawner, path: () => transcript }
}

async function runSession(
  spawner: PtySpawner,
  prompt: string,
  extra: Partial<ClaudeSessionOptions> = {},
): Promise<{ lines: string[]; result: any; session: ClaudeSession; cleanup: () => void }> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccp-cursor-run-")))
  const cwd = path.join(root, "work")
  fs.mkdirSync(cwd)
  const session = new ClaudeSession({
    ...FAST,
    cwd,
    configDir: path.join(root, "config"),
    env: {},
    spawnPty: spawner,
    ...extra,
  })
  const lines: string[] = []
  await session.start()
  const result = await session.tailTurn(prompt, (raw) => lines.push(raw))
  return {
    lines,
    result,
    session,
    cleanup: () => {
      session.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

test("a turn reads a record the TUI wrote across two polls", async () => {
  const reply = assistantRecord("msg_1", "end_turn", "split across writes")
  const { spawner } = scriptedTui((append) => {
    append(userRecord("prompt") + "\n")
    // The record and its newline do not land together.
    append(reply.slice(0, 40))
    setTimeout(() => append(reply.slice(40) + "\n"), 40)
  })
  const run = await runSession(spawner, "prompt")
  try {
    assert.equal(run.result.end, "stop")
    assert.equal(run.result.stopReason, "end_turn")
    assert.deepEqual(
      run.lines.filter((line) => line.includes("split across writes")),
      [reply],
      "the record arrives once, whole",
    )
  } finally {
    run.cleanup()
  }
})

test("a transcript that appears only when the prompt is accepted still submits and is read", async () => {
  let existedAtStart = true
  const { spawner, path: transcriptPath } = scriptedTui((append) => {
    existedAtStart = fs.existsSync(transcriptPath())
    append(userRecord("prompt") + "\n")
    append(assistantRecord("msg_1", "end_turn", "late file") + "\n")
  })
  const run = await runSession(spawner, "prompt")
  try {
    assert.equal(existedAtStart, false, "the TUI had written nothing before the prompt")
    assert.equal(run.result.end, "stop")
    assert.equal(run.lines.length, 2)
  } finally {
    run.cleanup()
  }
})

test("a fork's copied history is skipped even when it is read before the prompt", async () => {
  const parent = [
    userRecord("the parent's question"),
    assistantRecord("msg_parent", "end_turn", "the parent's answer"),
  ]
  const { spawner } = scriptedTui((append) => {
    // The CLI copies the parent conversation in first; the fork's own prompt
    // record follows, in a later read.
    append(parent.join("\n") + "\n")
    setTimeout(() => {
      append(userRecord("fork prompt") + "\n")
      append(assistantRecord("msg_fork", "end_turn", "the fork's answer") + "\n")
    }, 40)
  })
  const run = await runSession(spawner, "fork prompt", { forkOf: "parent-session-id" })
  try {
    assert.equal(run.result.end, "stop")
    assert.deepEqual(
      run.lines,
      [userRecord("fork prompt"), assistantRecord("msg_fork", "end_turn", "the fork's answer")],
      "nothing before the fork's own prompt record is this turn's",
    )
  } finally {
    run.cleanup()
  }
})

test("polls of an unchanged transcript cost a session no bytes", async () => {
  const { spawner } = scriptedTui((append) => {
    append(userRecord("prompt") + "\n")
    append(assistantRecord("msg_1", null, "working") + "\n")
    // A long quiet stretch, which is what a tool call or a thinking block
    // looks like from the transcript's side.
    setTimeout(() => append(assistantRecord("msg_2", "end_turn", "done") + "\n"), 300)
  })
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccp-cursor-quiet-")))
  const cwd = path.join(root, "work")
  fs.mkdirSync(cwd)
  const session = new ClaudeSession({
    ...FAST,
    cwd,
    configDir: path.join(root, "config"),
    env: {},
    spawnPty: spawner,
  })
  try {
    await session.start()
    let quiet: { polls: number; bytes: number } | null = null
    const turn = session.tailTurn("prompt", () => {})
    // Sample inside the quiet stretch, then again just before the turn ends.
    setTimeout(() => (quiet = { ...session.transcriptStats }), 150)
    const result = await turn
    const end = { ...session.transcriptStats }
    assert.equal(result.end, "stop")
    assert(quiet, "the sample landed inside the turn")
    assert(end.polls - quiet!.polls >= 5, `the loop kept polling (${end.polls - quiet!.polls})`)
    assert(
      end.bytes - quiet!.bytes < 1024,
      `a quiet poll reads nothing (${end.bytes - quiet!.bytes} bytes for one record)`,
    )
  } finally {
    session.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
