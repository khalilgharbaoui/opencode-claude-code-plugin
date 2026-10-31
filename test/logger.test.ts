/**
 * Unit tests for the logger module:
 *   - level threshold (debug < info < notice < warn < error)
 *   - mode policy (silent vs debug) for TUI routing
 *   - env-var precedence over config
 *   - boolean / level parsing edge cases
 *
 * File-write side effects are exercised by pointing `dir` at a temp dir and
 * inspecting the file after each test.
 */
import "./isolate.js"
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  _resetLoggerForTests,
  configureLogger,
  getLoggerConfig,
  log,
} from "../src/logger.js"

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
  const dir = mkdtempSync(join(tmpdir(), "opencode-cc-logtest-"))
  return {
    dir,
    readLog() {
      const f = join(dir, "plugin.log")
      return existsSync(f) ? readFileSync(f, "utf8") : ""
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function clearEnv(): void {
  delete process.env.OPENCODE_CLAUDE_CODE_LOG_FILE
  delete process.env.OPENCODE_CLAUDE_CODE_LOG_DIR
  delete process.env.OPENCODE_CLAUDE_CODE_LOG_LEVEL
  delete process.env.DEBUG
}

test("default config: file=false, mode=silent, level=info", () => {
  clearEnv()
  _resetLoggerForTests()
  const c = getLoggerConfig()
  assert.equal(c.file, false)
  assert.equal(c.mode, "silent")
  assert.equal(c.level, "info")
  assert.equal(c.dir, null)
})

test("level threshold: debug dropped at level=info", () => {
  clearEnv()
  const tmp = withTempDir()
  try {
    configureLogger({ file: true, dir: tmp.dir, level: "info", mode: "silent" })
    log.debug("dropped-debug")
    log.info("kept-info")
    const out = tmp.readLog()
    assert.ok(!out.includes("dropped-debug"))
    assert.ok(out.includes("kept-info"))
  } finally {
    tmp.cleanup()
    _resetLoggerForTests()
  }
})

test("level=error drops warn entirely (no file, no TUI)", () => {
  clearEnv()
  const tmp = withTempDir()
  const stderr = captureStderr()
  try {
    configureLogger({ file: true, dir: tmp.dir, level: "error", mode: "silent" })
    log.warn("dropped-warn")
    log.error("kept-error")
    const out = tmp.readLog()
    assert.ok(!out.includes("dropped-warn"), "warn should not reach file")
    assert.ok(out.includes("kept-error"), "error should reach file")
    const tui = stderr.lines.join("\n")
    assert.ok(!tui.includes("dropped-warn"), "warn should not reach TUI")
    assert.ok(tui.includes("kept-error"), "error should reach TUI")
  } finally {
    stderr.restore()
    tmp.cleanup()
    _resetLoggerForTests()
  }
})

test("mode=silent: only warn/error reach TUI", () => {
  clearEnv()
  const tmp = withTempDir()
  const stderr = captureStderr()
  try {
    configureLogger({ file: true, dir: tmp.dir, level: "debug", mode: "silent" })
    log.info("silent-info")
    log.notice("silent-notice")
    log.warn("silent-warn")
    log.error("silent-error")
    const tui = stderr.lines.join("\n")
    assert.ok(!tui.includes("silent-info"))
    assert.ok(!tui.includes("silent-notice"))
    assert.ok(tui.includes("silent-warn"))
    assert.ok(tui.includes("silent-error"))
  } finally {
    stderr.restore()
    tmp.cleanup()
    _resetLoggerForTests()
  }
})

test("mode=debug: all emitted levels reach TUI", () => {
  clearEnv()
  const tmp = withTempDir()
  const stderr = captureStderr()
  try {
    configureLogger({ file: true, dir: tmp.dir, level: "debug", mode: "debug" })
    log.debug("loud-debug")
    log.info("loud-info")
    log.notice("loud-notice")
    log.warn("loud-warn")
    log.error("loud-error")
    const tui = stderr.lines.join("\n")
    assert.ok(tui.includes("loud-debug"))
    assert.ok(tui.includes("loud-info"))
    assert.ok(tui.includes("loud-notice"))
    assert.ok(tui.includes("loud-warn"))
    assert.ok(tui.includes("loud-error"))
  } finally {
    stderr.restore()
    tmp.cleanup()
    _resetLoggerForTests()
  }
})

test("file=false: debug/info/notice vanish entirely, warn/error still in TUI", () => {
  clearEnv()
  _resetLoggerForTests()
  const tmp = withTempDir()
  const stderr = captureStderr()
  try {
    configureLogger({ file: false, dir: tmp.dir, level: "debug", mode: "silent" })
    log.info("no-file-info")
    log.warn("no-file-warn")
    assert.equal(tmp.readLog(), "", "no file should be written")
    const tui = stderr.lines.join("\n")
    assert.ok(!tui.includes("no-file-info"))
    assert.ok(tui.includes("no-file-warn"))
  } finally {
    stderr.restore()
    tmp.cleanup()
    _resetLoggerForTests()
  }
})

test("env var OPENCODE_CLAUDE_CODE_LOG_FILE overrides config", () => {
  clearEnv()
  process.env.OPENCODE_CLAUDE_CODE_LOG_FILE = "0"
  const tmp = withTempDir()
  try {
    configureLogger({ file: true, dir: tmp.dir, level: "info" })
    log.info("attempted")
    assert.equal(tmp.readLog(), "", "env explicit-off should win over config:true")
  } finally {
    delete process.env.OPENCODE_CLAUDE_CODE_LOG_FILE
    tmp.cleanup()
    _resetLoggerForTests()
  }
})

test("env var OPENCODE_CLAUDE_CODE_LOG_LEVEL overrides config", () => {
  clearEnv()
  process.env.OPENCODE_CLAUDE_CODE_LOG_LEVEL = "warn"
  const tmp = withTempDir()
  try {
    configureLogger({ file: true, dir: tmp.dir, level: "info" })
    log.info("dropped-by-env")
    log.warn("kept-by-env")
    const out = tmp.readLog()
    assert.ok(!out.includes("dropped-by-env"))
    assert.ok(out.includes("kept-by-env"))
  } finally {
    delete process.env.OPENCODE_CLAUDE_CODE_LOG_LEVEL
    tmp.cleanup()
    _resetLoggerForTests()
  }
})

test("env var DEBUG=opencode-claude-code sets mode=debug", () => {
  clearEnv()
  process.env.DEBUG = "opencode-claude-code"
  const stderr = captureStderr()
  const tmp = withTempDir()
  try {
    configureLogger({ file: true, dir: tmp.dir, level: "debug", mode: "silent" })
    log.info("piped-to-tui")
    const tui = stderr.lines.join("\n")
    assert.ok(tui.includes("piped-to-tui"), "DEBUG env should promote mode to debug")
  } finally {
    stderr.restore()
    delete process.env.DEBUG
    tmp.cleanup()
    _resetLoggerForTests()
  }
})

test("env var OPENCODE_CLAUDE_CODE_LOG_DIR overrides config dir", () => {
  clearEnv()
  const tmpEnv = withTempDir()
  const tmpCfg = withTempDir()
  process.env.OPENCODE_CLAUDE_CODE_LOG_DIR = tmpEnv.dir
  try {
    configureLogger({ file: true, dir: tmpCfg.dir, level: "info" })
    log.info("env-wins")
    assert.ok(tmpEnv.readLog().includes("env-wins"), "env dir should receive the log")
    assert.equal(tmpCfg.readLog(), "", "config dir should be ignored")
  } finally {
    delete process.env.OPENCODE_CLAUDE_CODE_LOG_DIR
    tmpEnv.cleanup()
    tmpCfg.cleanup()
    _resetLoggerForTests()
  }
})

test("boolean env parsing: 1/true/on/yes → on; 0/false/no/off → off; '' → unset", () => {
  clearEnv()
  const cases: Array<[string, boolean]> = [
    ["1", true],
    ["true", true],
    ["on", true],
    ["yes", true],
    ["0", false],
    ["false", false],
    ["no", false],
    ["off", false],
  ]
  for (const [v, expected] of cases) {
    process.env.OPENCODE_CLAUDE_CODE_LOG_FILE = v
    _resetLoggerForTests()
    const c = getLoggerConfig()
    assert.equal(c.file, expected, `value "${v}" should produce file=${expected}`)
  }
  // empty string: unset → fall through to default
  process.env.OPENCODE_CLAUDE_CODE_LOG_FILE = ""
  _resetLoggerForTests()
  assert.equal(getLoggerConfig().file, false, "empty string should be treated as unset")
  delete process.env.OPENCODE_CLAUDE_CODE_LOG_FILE
})

test("invalid OPENCODE_CLAUDE_CODE_LOG_LEVEL is ignored, config wins", () => {
  clearEnv()
  process.env.OPENCODE_CLAUDE_CODE_LOG_LEVEL = "lolnope"
  try {
    configureLogger({ file: false, level: "warn" })
    assert.equal(getLoggerConfig().level, "warn", "invalid env should fall through")
  } finally {
    delete process.env.OPENCODE_CLAUDE_CODE_LOG_LEVEL
    _resetLoggerForTests()
  }
})
