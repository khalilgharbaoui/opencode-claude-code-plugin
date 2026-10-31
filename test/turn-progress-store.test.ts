/**
 * The progress estimate's live channel (h #g251): one record per running
 * turn, keyed by the session's tag, holding its start, its output so far and
 * the last write. Its round trip and what it refuses to write, the bounds,
 * the file's modes, a second writer, and the changed-only reader the TUI
 * polls. The server half feeding it is `test/turn-history.test.ts`.
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  MAX_TURN_PROGRESS,
  TURN_PROGRESS_MAX_AGE_MS,
  _setTurnProgressStorePathForTests,
  createTurnProgressReader,
  recordTurnProgress,
  turnProgressStorePath,
} from "../src/turn-progress-store.js"

const NOW = 1_800_000_000_000
const TAG = "5c1d0f3a"

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-turn-progress-"))
  _setTurnProgressStorePathForTests(join(dir, "state", "turn-progress.json"))
  return dir
}

const onDisk = () => JSON.parse(readFileSync(turnProgressStorePath(), "utf8"))

test("a record round-trips with its three fields under the session's tag, and nothing else is written", () => {
  const dir = scratch()
  try {
    assert.equal(recordTurnProgress(TAG, { turn: NOW - 5_000, out: 5_321.4, ...({ prompt: "secret" } as object) }, NOW), true)
    assert.deepEqual(onDisk(), { version: 1, turns: { [TAG]: { turn: NOW - 5_000, out: 5_321, at: NOW } } })
    // The newest write for a tag replaces the record.
    assert.equal(recordTurnProgress(TAG, { turn: NOW - 5_000, out: 9_000 }, NOW + 1_000), true)
    assert.deepEqual(onDisk().turns[TAG], { turn: NOW - 5_000, out: 9_000, at: NOW + 1_000 })
    // A raw session id is no tag, and a count must be one.
    assert.equal(recordTurnProgress("ses_0123456789", { turn: NOW, out: 1 }, NOW), false)
    assert.equal(recordTurnProgress(TAG, { turn: NOW, out: -1 }, NOW), false)
    assert.equal(recordTurnProgress(TAG, { turn: Number.NaN, out: 1 }, NOW), false)
    assert.deepEqual(Object.keys(onDisk().turns), [TAG])
  } finally {
    _setTurnProgressStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the file is 0600 in a 0700 directory, because the state directory is shared", { skip: process.platform === "win32" }, () => {
  const dir = scratch()
  try {
    recordTurnProgress(TAG, { turn: NOW, out: 1 }, NOW)
    assert.equal(statSync(turnProgressStorePath()).mode & 0o777, 0o600)
    assert.equal(statSync(join(dir, "state")).mode & 0o777, 0o700)
  } finally {
    _setTurnProgressStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a second writer's records survive a write, and the store is bounded in turns and by age", () => {
  const dir = scratch()
  try {
    mkdirSync(join(dir, "state"), { recursive: true })
    writeFileSync(
      turnProgressStorePath(),
      JSON.stringify({
        version: 1,
        turns: {
          aaaaaaaa: { turn: NOW - 10, out: 7, at: NOW - 10 },
          bbbbbbbb: { turn: NOW, out: 7, at: NOW - TURN_PROGRESS_MAX_AGE_MS - 1 },
          "not-a-tag": { turn: NOW, out: 7, at: NOW },
          cccccccc: { turn: NOW, out: "many", at: NOW },
        },
      }),
    )
    recordTurnProgress(TAG, { turn: NOW, out: 1 }, NOW)
    assert.deepEqual(Object.keys(onDisk().turns).sort(), ["aaaaaaaa", TAG].sort())

    for (let index = 0; index < MAX_TURN_PROGRESS + 3; index += 1) {
      recordTurnProgress(index.toString(16).padStart(8, "0"), { turn: NOW, out: index }, NOW + 1 + index)
    }
    const kept = Object.keys(onDisk().turns)
    assert.equal(kept.length, MAX_TURN_PROGRESS)
    assert.ok(kept.includes((MAX_TURN_PROGRESS + 2).toString(16).padStart(8, "0")), "the turn written last is kept")
    assert.ok(!kept.includes("aaaaaaaa"), "the oldest write went first")
  } finally {
    _setTurnProgressStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the reader re-parses only a changed file, drops an old record, and treats a broken file as empty", () => {
  const dir = scratch()
  try {
    const reader = createTurnProgressReader()
    assert.equal(reader.read(NOW).size, 0, "no file yet")
    recordTurnProgress(TAG, { turn: NOW, out: 42 }, NOW)
    const first = reader.read(NOW)
    assert.deepEqual(first.get(TAG), { turn: NOW, out: 42, at: NOW })
    assert.equal(reader.read(NOW), first, "an unchanged file returns the same map")
    recordTurnProgress(TAG, { turn: NOW, out: 43 }, NOW + 1)
    assert.equal(reader.read(NOW + 1).get(TAG)?.out, 43, "every write is seen")

    writeFileSync(turnProgressStorePath(), "{ half written")
    assert.equal(reader.read(NOW).size, 0)
  } finally {
    _setTurnProgressStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
