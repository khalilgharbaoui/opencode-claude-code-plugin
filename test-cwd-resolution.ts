import assert from "node:assert/strict"
import { test } from "node:test"
import {
  getOpencodeProjectDirectory,
  isUsableDirectory,
  resolveSpawnCwd,
  resolveSpawnCwdFrom,
  setOpencodeProjectDirectory,
} from "./src/runtime-status.js"

function withCapturedDirectory<T>(value: string | undefined, fn: () => T): T {
  const previous = getOpencodeProjectDirectory()
  try {
    setOpencodeProjectDirectory(value)
    return fn()
  } finally {
    setOpencodeProjectDirectory(previous)
  }
}

test("isUsableDirectory rejects /, empty, single chars, and non-strings", () => {
  assert.equal(isUsableDirectory("/"), false)
  assert.equal(isUsableDirectory(""), false)
  assert.equal(isUsableDirectory("x"), false)
  assert.equal(isUsableDirectory(undefined), false)
  assert.equal(isUsableDirectory(null), false)
  assert.equal(isUsableDirectory(42), false)
  assert.equal(isUsableDirectory("/x"), true)
  assert.equal(isUsableDirectory("/Users/jessie/projects/foo"), true)
})

test("explicit configured value wins over live and captured", () => {
  assert.equal(
    resolveSpawnCwdFrom("/explicit", "/Users/me/proj", "/Users/me/other"),
    "/explicit",
  )
  // User override remains absolute even when it's "/". They asked for it.
  assert.equal(resolveSpawnCwdFrom("/", "/Users/me/proj", "/Users/me/other"), "/")
})

test("live process.cwd() preferred when it's a usable directory", () => {
  // Terminal launch: process.cwd() is the project dir, no captured needed.
  assert.equal(
    resolveSpawnCwdFrom(undefined, "/Users/me/proj", undefined),
    "/Users/me/proj",
  )
  // Live wins over a captured value too — lazy resolution honors opencode
  // workspace switches via chdir, even when we have a stale captured init dir.
  assert.equal(
    resolveSpawnCwdFrom(undefined, "/Users/me/now", "/Users/me/then"),
    "/Users/me/now",
  )
})

test("captured directory rescues macOS GUI launches at /", () => {
  assert.equal(
    resolveSpawnCwdFrom(undefined, "/", "/Users/jessie/projects/svelte-monorepo"),
    "/Users/jessie/projects/svelte-monorepo",
  )
})

test("session directory overrides live cwd (opencode serve / web-UI fix)", () => {
  // The bug: `opencode serve` is one long-lived process whose
  // process.cwd() is the server's launch dir (e.g. systemd
  // WorkingDirectory=/home/jan), not the web session's project. The
  // session's own directory must win over that usable-but-wrong live cwd.
  assert.equal(
    resolveSpawnCwdFrom(undefined, "/home/jan", undefined, "/home/jan/proj"),
    "/home/jan/proj",
  )
  // Explicit pin still beats the session directory.
  assert.equal(
    resolveSpawnCwdFrom("/explicit", "/home/jan", undefined, "/home/jan/proj"),
    "/explicit",
  )
  // Unusable session dir is ignored — fall back to the existing chain.
  assert.equal(
    resolveSpawnCwdFrom(undefined, "/home/jan/proj", undefined, "/"),
    "/home/jan/proj",
  )
  // Absent session dir (TUI / direct AI-SDK / no SDK client) is a no-op:
  // behavior is identical to the pre-fix 3-arg resolution.
  assert.equal(
    resolveSpawnCwdFrom(undefined, "/home/jan/proj", "/cap", undefined),
    "/home/jan/proj",
  )
})

test("falls through to live when neither configured nor captured is usable", () => {
  // Both unavailable: degrade gracefully to live, even if that's "/".
  // Caller sees the same value process.cwd() would have returned, so nothing
  // worse than pre-fix behavior.
  assert.equal(resolveSpawnCwdFrom(undefined, "/", undefined), "/")
  assert.equal(resolveSpawnCwdFrom(undefined, "", undefined), "")
})

test("empty configured string falls through to the rest of the chain", () => {
  // Defensive: a corrupt or empty options.cwd shouldn't pin Claude to ""
  // when a real live cwd is available.
  assert.equal(
    resolveSpawnCwdFrom("", "/Users/me/proj", "/Users/me/captured"),
    "/Users/me/proj",
  )
  assert.equal(
    resolveSpawnCwdFrom("", "/", "/Users/me/captured"),
    "/Users/me/captured",
  )
})

test("resolveSpawnCwd reads module-level captured state via the setter", () => {
  withCapturedDirectory("/Users/jessie/projects/svelte-monorepo", () => {
    // Stub process.cwd() temporarily to simulate the GUI-launch case.
    const originalCwd = process.cwd
    process.cwd = () => "/"
    try {
      assert.equal(
        resolveSpawnCwd(undefined),
        "/Users/jessie/projects/svelte-monorepo",
      )
      // Explicit config still wins.
      assert.equal(resolveSpawnCwd("/explicit/override"), "/explicit/override")
    } finally {
      process.cwd = originalCwd
    }
  })
})

test("resolveSpawnCwd returns live cwd when usable, regardless of captured", () => {
  withCapturedDirectory("/Users/jessie/projects/captured-at-init", () => {
    // Terminal-launched opencode: process.cwd() is the active project.
    // Captured value must not override the live one (workspace switching
    // depends on this; baking captured into config is what broke #4).
    const live = process.cwd()
    if (!isUsableDirectory(live)) return // skip if test runner started at /
    assert.equal(resolveSpawnCwd(undefined), live)
  })
})

test("setter accepts undefined to clear the captured directory", () => {
  setOpencodeProjectDirectory("/Users/me/captured")
  assert.equal(getOpencodeProjectDirectory(), "/Users/me/captured")
  setOpencodeProjectDirectory(undefined)
  assert.equal(getOpencodeProjectDirectory(), undefined)
})
