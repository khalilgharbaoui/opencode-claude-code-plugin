/**
 * Where an operator-facing log line goes when a full-screen TUI owns the
 * terminal.
 *
 * The defect: `src/logger.ts` sent every warn and error (and, in
 * `mode: "debug"`, every level) to `console.error`, and inside opencode's TUI
 * that is the terminal the TUI is drawing on. The raw `[opencode-claude-code]
 * WARN:` text sat on top of the interface until something forced a redraw.
 *
 * So the rules under test are:
 *   - outside a TUI nothing changed at all: stderr, exactly as before;
 *   - inside one, nothing reaches stderr at any level;
 *   - instead every surfaced line goes to opencode's own log, and warn/error
 *     additionally toast, at most once per message text per process;
 *   - lines emitted before the SDK client exists are buffered in order,
 *     bounded, and flushed when the sink registers;
 *   - the sink is fire-and-forget: a throwing or rejecting one never reaches
 *     the caller, and never logs (which would re-enter the logger).
 *
 * The detection itself (`isMainThread === false`) is proven against a real
 * `node:worker_threads` worker at the end.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"

import {
  _resetLoggerForTests,
  _setToastBurstForTests,
  configureLogger,
  isTuiHost,
  type LogSink,
  type LogSinkEntry,
  MAX_BUFFERED_SINK_ENTRIES,
  setLogSink,
  setTuiHostForTests,
  log,
} from "./src/logger.js"
import {
  appLogBody,
  createOpencodeLogSink,
  LOG_SERVICE_NAME,
  MAX_TOAST_CHARS,
  registerOpencodeLogSink,
  toastBody,
  TOAST_TITLE,
} from "./src/tui-log-sink.js"

function clearEnv(): void {
  delete process.env.OPENCODE_CLAUDE_CODE_LOG_FILE
  delete process.env.OPENCODE_CLAUDE_CODE_LOG_DIR
  delete process.env.OPENCODE_CLAUDE_CODE_LOG_LEVEL
  delete process.env.DEBUG
}

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = console.error
  console.error = (line: string) => {
    lines.push(line)
  }
  return {
    lines,
    restore: () => {
      console.error = original
    },
  }
}

function withTempDir(): { dir: string; cleanup: () => void; readLog: () => string } {
  const dir = mkdtempSync(join(tmpdir(), "opencode-cc-tuilog-"))
  return {
    dir,
    readLog() {
      const file = join(dir, "plugin.log")
      return existsSync(file) ? readFileSync(file, "utf8") : ""
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

interface RecordingSink extends LogSink {
  logged: LogSinkEntry[]
  toasted: LogSinkEntry[]
}

function recordingSink(): RecordingSink {
  const logged: LogSinkEntry[] = []
  const toasted: LogSinkEntry[] = []
  return {
    logged,
    toasted,
    log: (entry) => {
      logged.push(entry)
    },
    toast: (entry) => {
      toasted.push(entry)
    },
  }
}

// ---------------------------------------------------------------------------
// Outside a TUI: unchanged
// ---------------------------------------------------------------------------

test("main thread: warn still goes to stderr and never to a sink", () => {
  clearEnv()
  _resetLoggerForTests()
  const stderr = captureStderr()
  const sink = recordingSink()
  try {
    setTuiHostForTests(false)
    setLogSink(sink)
    configureLogger({ file: false, level: "debug", mode: "silent" })
    log.warn("main-thread-warn")
    log.error("main-thread-error")
    const out = stderr.lines.join("\n")
    assert.ok(out.includes("main-thread-warn"), "warn belongs on stderr off a TUI")
    assert.ok(out.includes("main-thread-error"), "error belongs on stderr off a TUI")
    assert.deepEqual(sink.logged, [], "no sink traffic outside a TUI")
    assert.deepEqual(sink.toasted, [], "no toasts outside a TUI")
  } finally {
    stderr.restore()
    _resetLoggerForTests()
  }
})

test("main thread, mode=debug: every level still goes to stderr", () => {
  clearEnv()
  _resetLoggerForTests()
  const stderr = captureStderr()
  try {
    setTuiHostForTests(false)
    configureLogger({ file: false, level: "debug", mode: "debug" })
    log.debug("plain-debug")
    log.info("plain-info")
    log.notice("plain-notice")
    const out = stderr.lines.join("\n")
    assert.ok(out.includes("plain-debug"))
    assert.ok(out.includes("plain-info"))
    assert.ok(out.includes("plain-notice"))
  } finally {
    stderr.restore()
    _resetLoggerForTests()
  }
})

// ---------------------------------------------------------------------------
// Inside a TUI: nothing on stderr, everything on the sink
// ---------------------------------------------------------------------------

test("TUI host: no console.error at any level", () => {
  clearEnv()
  _resetLoggerForTests()
  const stderr = captureStderr()
  const sink = recordingSink()
  try {
    setTuiHostForTests(true)
    setLogSink(sink)
    configureLogger({ file: false, level: "debug", mode: "debug" })
    log.debug("tui-debug")
    log.info("tui-info")
    log.notice("tui-notice")
    log.warn("tui-warn")
    log.error("tui-error")
    assert.deepEqual(stderr.lines, [], "a TUI's terminal must stay untouched")
    assert.deepEqual(
      sink.logged.map((entry) => entry.message),
      ["tui-debug", "tui-info", "tui-notice", "tui-warn", "tui-error"],
      "every surfaced line reaches opencode's log instead",
    )
  } finally {
    stderr.restore()
    _resetLoggerForTests()
  }
})

test("TUI host: warn and error toast, lower levels never do", () => {
  clearEnv()
  _resetLoggerForTests()
  const stderr = captureStderr()
  const sink = recordingSink()
  try {
    setTuiHostForTests(true)
    setLogSink(sink)
    configureLogger({ file: false, level: "debug", mode: "debug" })
    log.debug("quiet-debug")
    log.info("quiet-info")
    log.notice("quiet-notice")
    log.warn("loud-warn")
    log.error("loud-error")
    assert.deepEqual(
      sink.toasted.map((entry) => entry.message),
      ["loud-warn", "loud-error"],
      "a debug-mode echo of a lower level is not worth a toast",
    )
  } finally {
    stderr.restore()
    _resetLoggerForTests()
  }
})

test("TUI host: the same message text toasts at most once per process", () => {
  clearEnv()
  _resetLoggerForTests()
  const sink = recordingSink()
  try {
    setTuiHostForTests(true)
    setLogSink(sink)
    configureLogger({ file: false, level: "debug", mode: "silent" })
    // The measured repeater: the skill-bridge name clash warns on every spawn.
    log.warn("two different skills share a name", { skill: "a" })
    log.warn("two different skills share a name", { skill: "b" })
    log.warn("two different skills share a name", { skill: "c" })
    log.warn("a different problem")
    assert.equal(sink.logged.length, 4, "every occurrence still reaches the log")
    assert.deepEqual(
      sink.toasted.map((entry) => entry.message),
      ["two different skills share a name", "a different problem"],
    )
  } finally {
    _resetLoggerForTests()
  }
})

test("TUI host: the log file is unchanged", () => {
  clearEnv()
  _resetLoggerForTests()
  const tmp = withTempDir()
  try {
    setTuiHostForTests(true)
    setLogSink(recordingSink())
    configureLogger({ file: true, dir: tmp.dir, level: "debug", mode: "silent" })
    log.warn("still-on-disk")
    assert.ok(tmp.readLog().includes("still-on-disk"))
  } finally {
    tmp.cleanup()
    _resetLoggerForTests()
  }
})

test("TUI host: the level threshold still filters before the sink", () => {
  clearEnv()
  _resetLoggerForTests()
  const sink = recordingSink()
  try {
    setTuiHostForTests(true)
    setLogSink(sink)
    configureLogger({ file: false, level: "error", mode: "silent" })
    log.warn("below-threshold")
    log.error("at-threshold")
    assert.deepEqual(
      sink.logged.map((entry) => entry.message),
      ["at-threshold"],
    )
  } finally {
    _resetLoggerForTests()
  }
})

// ---------------------------------------------------------------------------
// The pre-capture buffer
// ---------------------------------------------------------------------------

test("TUI host: lines emitted before the sink exists flush in order", () => {
  clearEnv()
  _resetLoggerForTests()
  const stderr = captureStderr()
  const sink = recordingSink()
  try {
    setTuiHostForTests(true)
    configureLogger({ file: false, level: "debug", mode: "silent" })
    // Startup: the SDK client has not been captured yet.
    log.warn("startup-api-key-warning")
    log.error("startup-failure")
    assert.deepEqual(stderr.lines, [], "nothing leaks to the terminal while buffering")
    assert.deepEqual(sink.logged, [], "nothing is delivered before a sink exists")

    setLogSink(sink)
    assert.deepEqual(
      sink.logged.map((entry) => entry.message),
      ["startup-api-key-warning", "startup-failure"],
    )
    assert.deepEqual(
      sink.toasted.map((entry) => entry.message),
      ["startup-api-key-warning", "startup-failure"],
    )
  } finally {
    stderr.restore()
    _resetLoggerForTests()
  }
})

test("TUI host: the buffer is bounded and says how much it dropped", () => {
  clearEnv()
  _resetLoggerForTests()
  const sink = recordingSink()
  try {
    setTuiHostForTests(true)
    configureLogger({ file: false, level: "debug", mode: "silent" })
    const overflow = 7
    for (let i = 0; i < MAX_BUFFERED_SINK_ENTRIES + overflow; i += 1) {
      log.warn(`buffered-${i}`)
    }
    setLogSink(sink)
    const messages = sink.logged.map((entry) => entry.message)
    assert.equal(
      messages.length,
      MAX_BUFFERED_SINK_ENTRIES + 1,
      "the cap holds, plus one line accounting for the drops",
    )
    assert.equal(messages[0], "buffered-0", "the earliest line is the one kept")
    assert.equal(messages[MAX_BUFFERED_SINK_ENTRIES - 1], `buffered-${MAX_BUFFERED_SINK_ENTRIES - 1}`)
    assert.match(messages[MAX_BUFFERED_SINK_ENTRIES]!, new RegExp(`^${overflow} earlier log line`))
  } finally {
    _resetLoggerForTests()
  }
})

// ---------------------------------------------------------------------------
// The burst guard
// ---------------------------------------------------------------------------

test("TUI host: a burst of DIFFERENT warnings collapses into one summary toast", async () => {
  clearEnv()
  _resetLoggerForTests()
  const sink = recordingSink()
  try {
    setTuiHostForTests(true)
    _setToastBurstForTests(3, 30)
    setLogSink(sink)
    configureLogger({ file: false, level: "debug", mode: "silent" })
    // The measured shape: one turn on 1.18.34 produced 25 distinct
    // `MCP server "<name>" is needs-auth` WARNs in the same millisecond.
    for (let i = 0; i < 25; i += 1) {
      log.warn(`MCP server "server-${i}" is needs-auth in Claude Code`)
    }
    assert.equal(sink.logged.length, 25, "every one still reaches opencode's log")
    assert.equal(sink.toasted.length, 3, "only the first few reach the screen")

    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(sink.toasted.length, 4, "and one summary follows")
    assert.match(sink.toasted[3]!.message, /^22 more claude-code warning\(s\) were not shown/)
  } finally {
    _resetLoggerForTests()
  }
})

test("TUI host: a quiet process never arms the summary toast", async () => {
  clearEnv()
  _resetLoggerForTests()
  const sink = recordingSink()
  try {
    setTuiHostForTests(true)
    _setToastBurstForTests(3, 30)
    setLogSink(sink)
    configureLogger({ file: false, level: "debug", mode: "silent" })
    log.warn("one")
    log.warn("two")
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.deepEqual(
      sink.toasted.map((entry) => entry.message),
      ["one", "two"],
      "under the limit nothing is suppressed and no summary is added",
    )
  } finally {
    _resetLoggerForTests()
  }
})

test("TUI host: the burst budget refills once the window has passed", async () => {
  clearEnv()
  _resetLoggerForTests()
  const sink = recordingSink()
  try {
    setTuiHostForTests(true)
    _setToastBurstForTests(2, 25)
    setLogSink(sink)
    configureLogger({ file: false, level: "debug", mode: "silent" })
    log.warn("burst-a")
    log.warn("burst-b")
    log.warn("burst-c")
    assert.equal(sink.toasted.length, 2)
    await new Promise((resolve) => setTimeout(resolve, 70))
    log.warn("later-problem")
    assert.ok(
      sink.toasted.some((entry) => entry.message === "later-problem"),
      "a real problem after the burst is still shown",
    )
  } finally {
    _resetLoggerForTests()
  }
})

// ---------------------------------------------------------------------------
// A sink that misbehaves
// ---------------------------------------------------------------------------

test("TUI host: a throwing sink never escapes into the caller", () => {
  clearEnv()
  _resetLoggerForTests()
  const stderr = captureStderr()
  try {
    setTuiHostForTests(true)
    configureLogger({ file: false, level: "debug", mode: "silent" })
    setLogSink({
      log: () => {
        throw new Error("app.log blew up")
      },
      toast: () => {
        throw new Error("showToast blew up")
      },
    })
    assert.doesNotThrow(() => log.warn("survives-a-broken-sink"))
    assert.doesNotThrow(() => log.error("still-survives"))
    assert.deepEqual(stderr.lines, [], "and a broken sink does not fall back to the screen")
  } finally {
    stderr.restore()
    _resetLoggerForTests()
  }
})

test("TUI host: a rejecting SDK client never escapes into the caller", async () => {
  clearEnv()
  _resetLoggerForTests()
  const stderr = captureStderr()
  try {
    setTuiHostForTests(true)
    configureLogger({ file: false, level: "debug", mode: "silent" })
    const installed = registerOpencodeLogSink({
      app: { log: () => Promise.reject(new Error("no route")) },
      tui: { showToast: () => Promise.reject(new Error("no tui")) },
    })
    assert.equal(installed, true)
    assert.doesNotThrow(() => log.warn("rejecting-client"))
    // An unhandled rejection would take opencode's process down on the next tick.
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(stderr.lines, [])
  } finally {
    stderr.restore()
    _resetLoggerForTests()
  }
})

test("a sink that throws synchronously from app.log still gets the toast tried", () => {
  clearEnv()
  _resetLoggerForTests()
  const toasted: string[] = []
  try {
    setTuiHostForTests(true)
    configureLogger({ file: false, level: "debug", mode: "silent" })
    setLogSink({
      log: () => {
        throw new Error("half broken")
      },
      toast: (entry) => {
        toasted.push(entry.message)
      },
    })
    log.warn("half-broken-sink")
    assert.deepEqual(toasted, ["half-broken-sink"])
  } finally {
    _resetLoggerForTests()
  }
})

// ---------------------------------------------------------------------------
// The opencode-shaped sink
// ---------------------------------------------------------------------------

test("createOpencodeLogSink: null when the client can answer neither route", () => {
  assert.equal(createOpencodeLogSink(undefined), null)
  assert.equal(createOpencodeLogSink(null), null)
  assert.equal(createOpencodeLogSink({}), null)
  assert.equal(createOpencodeLogSink({ app: {}, tui: {} }), null)
  assert.equal(registerOpencodeLogSink({}), false)
})

test("createOpencodeLogSink: a client with only one of the two routes still works", () => {
  const logged: unknown[] = []
  const sink = createOpencodeLogSink({ app: { log: (options: unknown) => { logged.push(options); return undefined } } })
  assert.ok(sink)
  assert.doesNotThrow(() => sink!.log({ level: "warn", message: "m", line: "l" }))
  assert.doesNotThrow(() => sink!.toast({ level: "warn", message: "m", line: "l" }))
  assert.equal(logged.length, 1)
})

test("createOpencodeLogSink: the SDK methods keep their receiver", () => {
  const seen: string[] = []
  const app = {
    marker: "app",
    log(this: { marker: string }) {
      seen.push(this.marker)
      return undefined
    },
  }
  const tui = {
    marker: "tui",
    showToast(this: { marker: string }) {
      seen.push(this.marker)
      return undefined
    },
  }
  const sink = createOpencodeLogSink({ app, tui })
  sink!.log({ level: "warn", message: "m", line: "l" })
  sink!.toast({ level: "warn", message: "m", line: "l" })
  assert.deepEqual(seen, ["app", "tui"])
})

test("appLogBody: notice maps to info, because /log has no notice level", () => {
  assert.equal(appLogBody({ level: "notice", message: "m", line: "l" }).level, "info")
  assert.equal(appLogBody({ level: "debug", message: "m", line: "l" }).level, "debug")
  assert.equal(appLogBody({ level: "info", message: "m", line: "l" }).level, "info")
  assert.equal(appLogBody({ level: "warn", message: "m", line: "l" }).level, "warn")
  assert.equal(appLogBody({ level: "error", message: "m", line: "l" }).level, "error")
})

test("appLogBody: service name and extra", () => {
  const plain = appLogBody({ level: "warn", message: "m", line: "l" })
  assert.equal(plain.service, LOG_SERVICE_NAME)
  assert.equal(plain.message, "m")
  assert.equal(plain.extra, undefined, "an empty data object is not sent as extra")
  const withData = appLogBody({ level: "warn", message: "m", data: { a: 1 }, line: "l" })
  assert.deepEqual(withData.extra, { a: 1 })
  assert.equal(appLogBody({ level: "warn", message: "m", data: {}, line: "l" }).extra, undefined)
})

test("toastBody: short, titled, and the right variant", () => {
  const warn = toastBody({ level: "warn", message: "something to act on", data: { big: "x".repeat(5000) }, line: "l" })
  assert.equal(warn.variant, "warning")
  assert.equal(warn.title, TOAST_TITLE)
  assert.equal(warn.message, "something to act on", "the message, not the JSON data")
  assert.equal(toastBody({ level: "error", message: "m", line: "l" }).variant, "error")
})

test("toastBody: long text is flattened and capped", () => {
  const long = toastBody({ level: "warn", message: `start ${"y".repeat(5000)} end`, line: "l" })
  assert.equal(long.message.length, MAX_TOAST_CHARS)
  assert.ok(long.message.endsWith("…"))
  const wrapped = toastBody({ level: "warn", message: "two\nlines   here", line: "l" })
  assert.equal(wrapped.message, "two lines here")
})

// ---------------------------------------------------------------------------
// The detection itself
// ---------------------------------------------------------------------------

test("isTuiHost: false on the main thread, true off it", async () => {
  _resetLoggerForTests()
  assert.equal(isTuiHost(), false, "the test runner is the main thread")

  const loggerUrl = pathToFileURL(join(import.meta.dirname, "src", "logger.ts")).href
  const source = `
    import { parentPort } from "node:worker_threads"
    const mod = await import(${JSON.stringify(loggerUrl)})
    parentPort.postMessage({ isTuiHost: mod.isTuiHost() })
  `
  const answer = await new Promise<{ isTuiHost: boolean }>((resolve, reject) => {
    const worker = new Worker(source, { eval: true })
    worker.once("message", resolve)
    worker.once("error", reject)
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`worker exited ${code}`))
    })
  })
  assert.equal(answer.isTuiHost, true, "a worker thread is how opencode's TUI runs a plugin")
})
