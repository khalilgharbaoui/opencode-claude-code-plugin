/**
 * The file behind `Same as last time` (h #g228).
 *
 * Everything here is about the two things that make a state file safe rather
 * than about the form: that a restart reads back exactly what was written, and
 * that none of the four ways this file can be wrong (absent, garbage, written
 * by another process, grown without bound) costs a turn anything worse than one
 * unremembered form.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DISPATCH_CHOICE_MAX_AGE_MS,
  MAX_DISPATCH_CHOICES_PER_SESSION,
  MAX_DISPATCH_CHOICE_SESSIONS,
  _reloadDispatchChoiceStore,
  _setDispatchChoiceStorePath,
  dispatchChoiceStorePath,
  forgetDispatchChoices,
  readDispatchChoice,
  writeDispatchChoice,
} from "../src/dispatch-choice-store.js"

const dirs: string[] = []

function scratchStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-dispatch-store-"))
  dirs.push(dir)
  const file = join(dir, "subagent-dispatch.json")
  _setDispatchChoiceStorePath(file)
  return file
}

test.after(() => {
  _setDispatchChoiceStorePath(null)
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** What the next opencode process sees: the file, with nothing cached. */
function restart(): void {
  _reloadDispatchChoiceStore()
}

test("the store path is under the plugin's own state directory", () => {
  _setDispatchChoiceStorePath(null)
  const previous = process.env.XDG_STATE_HOME
  const root = join(tmpdir(), "state-probe")
  process.env.XDG_STATE_HOME = root
  try {
    assert.equal(
      dispatchChoiceStorePath(),
      join(root, "opencode-claude-code-plugin", "subagent-dispatch.json"),
    )
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
  }
})

test("a choice written in one process is read back in the next", () => {
  scratchStore()
  writeDispatchChoice("ses_a", "implementor", {
    model: "claude-opus-5-5",
    effort: "max",
    account: "worker",
  })
  restart()
  assert.deepEqual(readDispatchChoice("ses_a", "implementor"), {
    model: "claude-opus-5-5",
    effort: "max",
    account: "worker",
  })
  // Scoped both ways: another conversation and another agent type are empty.
  assert.equal(readDispatchChoice("ses_b", "implementor"), undefined)
  assert.equal(readDispatchChoice("ses_a", "designer"), undefined)
})

test("each agent type keeps its own account, model and effort", () => {
  scratchStore()
  writeDispatchChoice("ses_a", "implementor", { model: "claude-opus-5-5", account: "worker" })
  writeDispatchChoice("ses_a", "designer", { effort: "low", account: "default" })
  restart()
  assert.deepEqual(readDispatchChoice("ses_a", "implementor"), {
    model: "claude-opus-5-5",
    account: "worker",
  })
  assert.deepEqual(readDispatchChoice("ses_a", "designer"), {
    effort: "low",
    account: "default",
  })
})

test("a later answer for the same type replaces the earlier one", () => {
  scratchStore()
  writeDispatchChoice("ses_a", "implementor", { model: "claude-opus-5-5", effort: "max" })
  writeDispatchChoice("ses_a", "implementor", { model: "claude-haiku-5-5" })
  restart()
  assert.deepEqual(readDispatchChoice("ses_a", "implementor"), {
    model: "claude-haiku-5-5",
  })
})

test("an empty choice is never stored, so nothing is remembered as nothing", () => {
  scratchStore()
  writeDispatchChoice("ses_a", "implementor", {})
  restart()
  assert.equal(readDispatchChoice("ses_a", "implementor"), undefined)
})

test("the default affinity is never a conversation and is never stored", () => {
  scratchStore()
  writeDispatchChoice("default", "implementor", { effort: "max" })
  writeDispatchChoice("", "implementor", { effort: "max" })
  restart()
  assert.equal(readDispatchChoice("default", "implementor"), undefined)
})

test("a deleted opencode session loses its whole record", () => {
  scratchStore()
  writeDispatchChoice("ses_a", "implementor", { effort: "max" })
  writeDispatchChoice("ses_b", "implementor", { effort: "low" })
  forgetDispatchChoices("ses_a")
  restart()
  assert.equal(readDispatchChoice("ses_a", "implementor"), undefined)
  assert.deepEqual(readDispatchChoice("ses_b", "implementor"), { effort: "low" })
})

test("a second opencode process writing the same file is not erased", () => {
  const file = scratchStore()
  writeDispatchChoice("ses_mine", "implementor", { effort: "max" })

  // Another opencode process answers a form for a different conversation. It
  // merged what was on disk and wrote the whole file back, exactly as this
  // module does; this process knows nothing about it.
  const onDisk = JSON.parse(readFileSync(file, "utf8"))
  onDisk.sessions.ses_theirs = {
    choices: { designer: { model: "claude-haiku-5-5" } },
    updatedAt: Date.now(),
  }
  writeFileSync(file, JSON.stringify(onDisk))

  // Now this process answers another form. Without the read-back merge in
  // `save` it would write its stale view and drop the other conversation.
  writeDispatchChoice("ses_mine", "designer", { effort: "low" })
  restart()
  assert.deepEqual(readDispatchChoice("ses_theirs", "designer"), {
    model: "claude-haiku-5-5",
  })
  assert.deepEqual(readDispatchChoice("ses_mine", "implementor"), { effort: "max" })
  assert.deepEqual(readDispatchChoice("ses_mine", "designer"), { effort: "low" })
})

test("a malformed file is an empty store, and the next write repairs it", () => {
  const file = scratchStore()
  writeFileSync(file, "{not json at all")
  restart()
  assert.equal(readDispatchChoice("ses_a", "implementor"), undefined)
  writeDispatchChoice("ses_a", "implementor", { effort: "max" })
  restart()
  assert.deepEqual(readDispatchChoice("ses_a", "implementor"), { effort: "max" })
})

test("a record of the wrong shape is dropped and its neighbours are kept", () => {
  const file = scratchStore()
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      sessions: {
        ses_good: { choices: { implementor: { effort: "max" } }, updatedAt: Date.now() },
        ses_no_time: { choices: { implementor: { effort: "max" } } },
        ses_object_model: {
          choices: { implementor: { model: { evil: true } } },
          updatedAt: Date.now(),
        },
        ses_array: ["nope"],
        ses_null: null,
      },
    }),
  )
  restart()
  assert.deepEqual(readDispatchChoice("ses_good", "implementor"), { effort: "max" })
  assert.equal(readDispatchChoice("ses_no_time", "implementor"), undefined)
  assert.equal(readDispatchChoice("ses_object_model", "implementor"), undefined)
  assert.equal(readDispatchChoice("ses_array", "implementor"), undefined)
})

test("a record older than the maximum age is never read back", () => {
  const file = scratchStore()
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      sessions: {
        ses_old: {
          choices: { implementor: { effort: "max" } },
          updatedAt: Date.now() - DISPATCH_CHOICE_MAX_AGE_MS - 60_000,
        },
      },
    }),
  )
  restart()
  assert.equal(readDispatchChoice("ses_old", "implementor"), undefined)
})

test("the session cap drops the oldest conversations and keeps the newest", () => {
  const file = scratchStore()
  const total = MAX_DISPATCH_CHOICE_SESSIONS + 5
  for (let i = 0; i < total; i++) {
    writeDispatchChoice(`ses_${i}`, "implementor", { effort: "max" })
  }
  restart()
  const stored = JSON.parse(readFileSync(file, "utf8")).sessions
  assert.equal(Object.keys(stored).length, MAX_DISPATCH_CHOICE_SESSIONS)
  assert.equal(readDispatchChoice("ses_0", "implementor"), undefined)
  assert.deepEqual(readDispatchChoice(`ses_${total - 1}`, "implementor"), { effort: "max" })
})

test("one conversation's agent types are capped too, newest kept", () => {
  const file = scratchStore()
  const total = MAX_DISPATCH_CHOICES_PER_SESSION + 3
  for (let i = 0; i < total; i++) {
    writeDispatchChoice("ses_a", `agent-${i}`, { effort: "max" })
  }
  restart()
  const choices = JSON.parse(readFileSync(file, "utf8")).sessions.ses_a.choices
  assert.equal(Object.keys(choices).length, MAX_DISPATCH_CHOICES_PER_SESSION)
  assert.equal(readDispatchChoice("ses_a", "agent-0"), undefined)
  assert.deepEqual(readDispatchChoice("ses_a", `agent-${total - 1}`), { effort: "max" })
})

test("the file is 0600, because the state directory is shared", { skip: process.platform === "win32" }, () => {
  const file = scratchStore()
  writeDispatchChoice("ses_a", "implementor", { effort: "max" })
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test("nothing but the model, the effort and the account reaches the file", () => {
  const file = scratchStore()
  writeDispatchChoice("ses_a", "implementor", {
    model: "claude-opus-5-5",
    effort: "max",
    account: "worker",
    // A caller passing more than the three fields must not widen the file.
    ...({ prompt: "the task text nobody asked to persist" } as any),
  })
  const raw = readFileSync(file, "utf8")
  assert.ok(!raw.includes("nobody asked to persist"))
  assert.deepEqual(JSON.parse(raw).sessions.ses_a.choices.implementor, {
    model: "claude-opus-5-5",
    effort: "max",
    account: "worker",
  })
})
