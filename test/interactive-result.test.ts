/**
 * Two pre-existing bugs in the experimental interactive transport, both found
 * by the interactive-usage lane (PR #65) and both measured against a real
 * Claude Code 2.1.280 on macOS on 2026-09-30.
 *
 * 1. The synthesized terminal `result` put the stop reason in `subtype`, so a
 *    completed turn arrived as `subtype: "end_turn"`. Since (h #g113) any
 *    non-`success` subtype finishes as `{unified:"error"}`, EVERY interactive
 *    turn finished as an error and `turnStats` (h #g109) was suppressed. A
 *    real headless `result` was measured to keep `subtype: "success"` and
 *    carry the stop reason in a TOP-LEVEL `stop_reason` field.
 *
 * 2. `encodeCwd` named the transcript dir from `path.resolve`, which does not
 *    follow symlinks. The CLI names it from the cwd's REAL path, so on macOS
 *    (where /tmp is a symlink to /private/tmp) the interactive transport
 *    tailed a directory the CLI never writes.
 */
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { ClaudeSession, encodeCwd } from "../src/claude-session-bun.js"
import { spawnInteractiveProcess } from "../src/claude-session-wrapper.js"
import { describeResultFailure } from "../src/cli-events.js"
import { extractTurnStats } from "../src/turn-stats.js"

// ---------------------------------------------------------------------------
// Bug 1: the synthesized `result` frame.
//
// Driven through the REAL `spawnInteractiveProcess` / `runTurn` / `emitResult`
// path: only `ClaudeSession.start` (spawns a PTY) and `tailTurn` (needs one)
// are stubbed on the prototype, which is what `spawnInteractiveProcess`
// constructs internally.
// ---------------------------------------------------------------------------

/** The turn usage shape `tailTurn` returns, in a headless `result`'s layout. */
const TURN_USAGE = {
  input_tokens: 42,
  cache_read_input_tokens: 137736,
  cache_creation_input_tokens: 16696,
  output_tokens: 653,
}

async function runInteractiveTurn(stub: {
  stopReason: string | null
  /** How `tailTurn` says the turn ended; follows `stopReason` when omitted. */
  end?: "stop" | "interrupted" | "ended"
  throws?: string
}): Promise<any> {
  const realStart = ClaudeSession.prototype.start
  const realTail = (ClaudeSession.prototype as any).tailTurn
  ClaudeSession.prototype.start = async function () {}
  ;(ClaudeSession.prototype as any).tailTurn = async function () {
    if (stub.throws) throw new Error(stub.throws)
    return {
      stopReason: stub.stopReason,
      end: stub.end ?? (stub.stopReason ? "stop" : "ended"),
      usage: TURN_USAGE,
      lastCallUsage: TURN_USAGE,
      callCount: 1,
      costUsd: 0.0504726,
      durationMs: 15413,
      denied: [],
    }
  }
  try {
    const active = spawnInteractiveProcess({ cwd: process.cwd() })
    const lines: string[] = []
    active.lineEmitter.on("line", (raw: string) => lines.push(raw))
    // The wrapper installs its own "close" fallback only when no error
    // handler is registered; register one so a thrown turn cannot take the
    // emitter down before the result line is read.
    ;(active.proc as any).on("error", () => {})
    ;(active.proc as any).stdin.write(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      }) + "\n",
    )
    // runTurn is fire-and-forget; let its microtask chain settle.
    for (let i = 0; i < 20 && lines.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    ;(active.proc as any).kill()
    const result = lines.map((line) => JSON.parse(line)).find((m) => m.type === "result")
    assert.ok(result, "the turn must synthesize a terminal result frame")
    return result
  } finally {
    ClaudeSession.prototype.start = realStart
    ;(ClaudeSession.prototype as any).tailTurn = realTail
  }
}

test("a completed interactive turn synthesizes a headless-shaped success result", async () => {
  const result = await runInteractiveTurn({ stopReason: "end_turn" })

  // The measured headless shape for an `end_turn` turn on 2.1.280:
  //   "stop_reason":"end_turn", "terminal_reason":"completed",
  //   "is_error":false, "subtype":"success"
  assert.equal(result.subtype, "success")
  assert.equal(result.is_error, false)
  assert.equal(result.stop_reason, "end_turn")
  assert.equal(result.terminal_reason, "completed")

  // The regression itself: with the stop reason in `subtype` this was a
  // non-null failure description, which is what finished the turn as an error.
  assert.equal(describeResultFailure(result), null)
})

test("a completed interactive turn still carries the turn totals for turnStats", async () => {
  const result = await runInteractiveTurn({ stopReason: "end_turn" })
  // `turnStats` is skipped on a failed turn (h #g109), so the numbers only
  // reach the footer because the frame above is not a failure.
  assert.equal(result.usage.output_tokens, TURN_USAGE.output_tokens)
  const stats = extractTurnStats(result)
  assert.equal(stats?.outputTokens, TURN_USAGE.output_tokens)
  assert.equal(stats?.cacheReadTokens, TURN_USAGE.cache_read_input_tokens)
  // The cost and duration a headless result carries, rebuilt (h #g208).
  assert.equal(result.total_cost_usd, 0.0504726)
  assert.equal(result.duration_ms, 15413)
  assert.equal(stats?.costUsd, 0.0504726)
  assert.equal(stats?.durationMs, 15413)
})

test("max_tokens is a completed turn, not an error", async () => {
  const result = await runInteractiveTurn({ stopReason: "max_tokens" })
  // Deliberate: `max_tokens` is a terminal stop_reason, so the call happened
  // and billed. Marking it an error would suppress `turnStats` on a turn that
  // cost money AND skip the auto-continue nudge, whose `shouldDeferResult`
  // gate requires `!msg.is_error`. The truncation signal itself rides on the
  // assistant record's own `stop_reason` (h #g104), which `tailTurn` forwards.
  assert.equal(result.subtype, "success")
  assert.equal(result.is_error, false)
  assert.equal(result.stop_reason, "max_tokens")
  assert.equal(describeResultFailure(result), null)
})

test("stop_sequence is a completed turn too", async () => {
  const result = await runInteractiveTurn({ stopReason: "stop_sequence" })
  assert.equal(result.subtype, "success")
  assert.equal(result.is_error, false)
  assert.equal(result.stop_reason, "stop_sequence")
  assert.equal(describeResultFailure(result), null)
})

test("a turn with no terminal stop_reason stays an error result", async () => {
  // Invariant 2 of the interactive transport: a turn that never reached a
  // terminal stop_reason (turn timeout, claude exit mid-turn) must NOT be
  // cleaned up into a completed turn, or truncation becomes invisible.
  const result = await runInteractiveTurn({ stopReason: null })
  assert.equal(result.subtype, "error_during_execution")
  assert.equal(result.is_error, true)
  assert.equal(result.stop_reason, null)
  assert.ok(describeResultFailure(result))
  assert.match(result.result, /without a terminal stop_reason/)
})

test("an interrupted turn is an error result that says so", async () => {
  // Esc on a running turn (an abort) or the TUI's own interrupt marker. A
  // half-written answer must never read as a finished one.
  const result = await runInteractiveTurn({ stopReason: null, end: "interrupted" })
  assert.equal(result.subtype, "error_during_execution")
  assert.equal(result.is_error, true)
  assert.equal(result.terminal_reason, "aborted")
  assert.match(result.result, /interrupted/)
})

test("a failed turn stays an error result", async () => {
  const result = await runInteractiveTurn({
    stopReason: null,
    throws: "claude exited mid-turn",
  })
  assert.equal(result.subtype, "error_during_execution")
  assert.equal(result.is_error, true)
  assert.equal(result.stop_reason, null)
  assert.match(result.result, /Interactive transport failed: claude exited mid-turn/)
})

// ---------------------------------------------------------------------------
// Bug 2: the transcript dir name follows the cwd's REAL path.
// ---------------------------------------------------------------------------

/** A scratch dir under the OS tmpdir, plus a symlink pointing at it. */
function scratchWithSymlink(): { target: string; link: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cc-encodecwd-"))
  const target = path.join(base, "target")
  const link = path.join(base, "alias")
  fs.mkdirSync(target)
  fs.symlinkSync(target, link)
  return { target, link }
}

test("encodeCwd resolves symlinks, as the CLI does", () => {
  if (process.platform === "win32") return
  const { target, link } = scratchWithSymlink()
  // Measured on 2.1.280: a headless turn run from the symlink
  // /private/tmp/ccp-alias-a wrote its transcript to
  // ~/.claude/projects/-private-tmp-ccp-target-a, the TARGET's path.
  assert.equal(encodeCwd(link), encodeCwd(target))
  assert.ok(encodeCwd(link).endsWith("-target"))
  assert.ok(!encodeCwd(link).endsWith("-alias"))
})

test("encodeCwd names the /tmp symlink's real path on macOS", () => {
  if (process.platform !== "darwin") return
  // /tmp is a symlink to /private/tmp. Measured: a headless turn run from
  // /tmp/cc-probe-endturn wrote ~/.claude/projects/-private-tmp-cc-probe-endturn.
  // `path.resolve` alone produced `-tmp-...`, a directory the CLI never writes.
  const dir = fs.mkdtempSync(path.join("/tmp", "cc-encodecwd-tmp-"))
  const encoded = encodeCwd(dir)
  assert.ok(
    encoded.startsWith("-private-tmp-"),
    `expected a -private-tmp- prefix, got ${encoded}`,
  )
})

test("encodeCwd still replaces every non-alphanumeric char with a dash", () => {
  if (process.platform === "win32") return
  const { target } = scratchWithSymlink()
  const spaced = path.join(target, "My Project.v2")
  fs.mkdirSync(spaced)
  const encoded = encodeCwd(spaced)
  // No collapsing of runs: "My Project.v2" -> "My-Project-v2", and the
  // canonical case survives.
  assert.ok(encoded.endsWith("-My-Project-v2"), encoded)
  assert.equal(/[^a-zA-Z0-9-]/.test(encoded), false)
})

test("encodeCwd falls back to path.resolve for a path that does not exist", () => {
  if (process.platform === "win32") return
  // Nothing to realpath, so the literal resolved path is the best guess, and
  // it is what every caller assumed before symlink resolution existed.
  const missing = path.join(os.tmpdir(), "cc-encodecwd-does-not-exist-12345", "nested")
  assert.equal(encodeCwd(missing), path.resolve(missing).replace(/[^a-zA-Z0-9]/g, "-"))
})

test("the session's transcript path uses the resolved name under its configDir", () => {
  if (process.platform === "win32") return
  const { target, link } = scratchWithSymlink()
  const configDir = path.join(target, "config")
  // Invariant 5: the JSONL tail must follow the configured CLAUDE_CONFIG_DIR,
  // or opencode hangs while claude writes transcripts elsewhere.
  const session = new ClaudeSession({ cwd: link, configDir })
  assert.equal(session.configDir, configDir)
  assert.equal(
    session.jsonlPath,
    path.join(configDir, "projects", encodeCwd(target), `${session.sessionId}.jsonl`),
  )
  assert.ok(session.jsonlPath.includes("-target"))
})
