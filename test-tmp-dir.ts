// The per-process scratch directory three modules build paths under: the
// bridged MCP config (mcp-bridge), the proxy server's 0600 --mcp-config
// (proxy-mcp) and the staged skill plugin dirs (skill-bridge). Its name and
// its exit cleanup are the contract, so both are pinned here.

import assert from "node:assert/strict"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { test } from "node:test"

import {
  __test,
  _resetPluginTmpDir,
  pluginTmpDir,
  sweepStalePluginTmpDirs,
} from "./src/tmp.js"

// Read before anything calls pluginTmpDir(): the module registers its exit
// hook lazily on first use, not at import, so this is the clean baseline.
const exitListenersAtImport = process.listeners("exit")

function pluginExitHook(): () => void {
  const added = process
    .listeners("exit")
    .filter((listener) => !exitListenersAtImport.includes(listener))
  assert.equal(added.length, 1, "expected exactly one exit hook from tmp.ts")
  return added[0] as () => void
}

test("the scratch directory is pid-isolated and lives under the OS tmpdir", () => {
  const dir = pluginTmpDir()

  // PID isolation is what keeps two concurrent opencode processes from racing
  // on the same proxy/MCP config files.
  assert.equal(basename(dir), `opencode-claude-code-${process.pid}`)
  assert.equal(dirname(dir), tmpdir())
  assert.equal(existsSync(dir), true)
  assert.equal(statSync(dir).isDirectory(), true)
})

test("repeated calls reuse the directory and arm exactly one exit hook", () => {
  const first = pluginTmpDir()
  const second = pluginTmpDir()
  const third = pluginTmpDir()

  assert.equal(second, first)
  assert.equal(third, first)
  assert.equal(process.listenerCount("exit"), exitListenersAtImport.length + 1)
})

test("the directory is recreated when something removed it underneath", () => {
  const dir = pluginTmpDir()
  rmSync(dir, { recursive: true, force: true })
  assert.equal(existsSync(dir), false)

  // Same path, existing again: callers hold onto the string and write into it
  // long after the first call.
  assert.equal(pluginTmpDir(), dir)
  assert.equal(existsSync(dir), true)
})

test("files written through it land inside the scratch directory", () => {
  const dir = pluginTmpDir()
  const file = join(dir, "mcp-config.json")
  writeFileSync(file, JSON.stringify({ mcpServers: {} }), "utf8")

  assert.equal(readFileSync(file, "utf8"), '{"mcpServers":{}}')
  assert.equal(dirname(file), dir)
})

test("the registered exit hook removes the whole tree, nested dirs included", () => {
  const dir = pluginTmpDir()
  const nested = join(dir, "skills-abc123")
  writeFileSync(join(dir, "proxy.json"), "{}", "utf8")
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, "SKILL.md"), "# skill", "utf8")

  // Run the real handler rather than waiting for process exit.
  const hook = pluginExitHook()
  hook()
  assert.equal(existsSync(dir), false)

  // Idempotent: the handler must not throw when the tree is already gone.
  hook()

  // Restore for anything later in this process.
  assert.equal(pluginTmpDir(), dir)
  assert.equal(existsSync(dir), true)
})

// The OS tmpdir is world-writable on a shared host and the pid name is
// guessable, so the two tests below are the ones that keep another user from
// reading the bridged MCP config or swapping it for their own.

test("the scratch directory is created 0700, not the umask default", () => {
  const dir = pluginTmpDir()
  assert.equal(statSync(dir).mode & 0o777, 0o700)

  // Loosened underneath: the next call re-asserts the mode rather than
  // trusting whatever it finds.
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true, mode: 0o755 })
  assert.equal(statSync(pluginTmpDir()).mode & 0o777, 0o700)
})

test("a symlink squatting on the pid name is refused for a fresh directory", () => {
  const pidPath = __test.PID_TMP_DIR
  const decoy = mkdtempSync(join(tmpdir(), "tmp-dir-decoy-"))
  rmSync(pidPath, { recursive: true, force: true })
  symlinkSync(decoy, pidPath, "dir")

  try {
    _resetPluginTmpDir()
    const dir = pluginTmpDir()

    // Not the squatted path, and nothing was written through the symlink.
    assert.notEqual(dir, pidPath)
    assert.equal(lstatSync(pidPath).isSymbolicLink(), true)
    assert.deepEqual(readdirSync(decoy), [])

    // Still a scratch directory of ours, and still 0700.
    assert.equal(dirname(dir), tmpdir())
    assert.equal(basename(dir).startsWith("opencode-claude-code-"), true)
    assert.equal(statSync(dir).mode & 0o777, 0o700)

    writeFileSync(join(dir, "mcp-config.json"), "{}", "utf8")
    assert.deepEqual(readdirSync(decoy), [])
    rmSync(dir, { recursive: true, force: true })
  } finally {
    rmSync(pidPath, { force: true })
    rmSync(decoy, { recursive: true, force: true })
    _resetPluginTmpDir()
  }

  // Back to the pid name once the squatter is gone.
  assert.equal(pluginTmpDir(), pidPath)
})

test("an existing path that is not ours, or not a directory, is untrustworthy", () => {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined

  // `/` exists on every POSIX host and is owned by root. Skip when running as
  // root, where "owned by another user" cannot be staged.
  if (uid !== undefined && uid !== 0) {
    assert.match(
      String(__test.untrustworthyReason("/")),
      /owned by uid 0/,
    )
  }

  const file = join(tmpdir(), `tmp-dir-file-${process.pid}`)
  writeFileSync(file, "", "utf8")
  try {
    assert.equal(__test.untrustworthyReason(file), "path is not a directory")
  } finally {
    rmSync(file, { force: true })
  }

  // Absent is fine: we create it ourselves.
  assert.equal(
    __test.untrustworthyReason(join(tmpdir(), `tmp-dir-absent-${process.pid}`)),
    null,
  )
  // Our own directory is fine.
  assert.equal(__test.untrustworthyReason(pluginTmpDir()), null)
})

// The exit hook never runs under SIGKILL, so a killed opencode leaves its
// mcp-<hash>.json (which can hold {env:VAR}-substituted secrets) on disk.
// The sweep is what eventually removes those, and what it must NOT remove is
// the part that matters: a live process's directory, or anyone else's.

/** A pid that has certainly exited and been reaped. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" })
  assert.equal(result.error, undefined)
  assert.ok(result.pid && result.pid > 0)
  return result.pid
}

function withTmpRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "tmp-sweep-"))
  const saved = process.env.TMPDIR
  try {
    process.env.TMPDIR = root
    // os.tmpdir() re-reads TMPDIR on every call, so this redirects the sweep.
    // Hand the callback what os.tmpdir() reports, not the realpath: on macOS
    // those differ (/var vs /private/var) and the sweep reports the former.
    assert.equal(realpathSync(tmpdir()), realpathSync(root))
    fn(tmpdir())
  } finally {
    if (saved === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = saved
    rmSync(root, { recursive: true, force: true })
  }
}

test("the sweep removes dead-pid scratch dirs and nothing else", () => {
  withTmpRoot((root) => {
    const dead = deadPid()
    const deadDir = join(root, `opencode-claude-code-${dead}`)
    mkdirSync(deadDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(deadDir, "mcp-abc123.json"), '{"secret":"x"}', "utf8")

    // Our own directory: swept only when the process that owns it is gone.
    const ownDir = join(root, `opencode-claude-code-${process.pid}`)
    mkdirSync(ownDir, { recursive: true, mode: 0o700 })

    // A different, still-running process.
    const liveDir =
      process.ppid > 1 ? join(root, `opencode-claude-code-${process.ppid}`) : null
    if (liveDir) mkdirSync(liveDir, { recursive: true, mode: 0o700 })

    // A name that is not ours, and a mkdtemp-style fallback name whose owner
    // cannot be determined from the name.
    const foreign = join(root, "opencode-claude-code-plugin-cache")
    const fallbackNamed = join(root, "opencode-claude-code-A1b2C3")
    mkdirSync(foreign, { recursive: true })
    mkdirSync(fallbackNamed, { recursive: true })

    // A symlink wearing a dead pid's name, pointing somewhere valuable.
    const decoy = join(root, "decoy")
    mkdirSync(decoy, { recursive: true })
    writeFileSync(join(decoy, "keep-me"), "precious", "utf8")
    const symlinked = join(root, `opencode-claude-code-${deadPid()}`)
    symlinkSync(decoy, symlinked, "dir")

    const removed = sweepStalePluginTmpDirs()

    assert.deepEqual(removed, [deadDir])
    assert.equal(existsSync(deadDir), false)
    assert.equal(existsSync(ownDir), true)
    if (liveDir) assert.equal(existsSync(liveDir), true)
    assert.equal(existsSync(foreign), true)
    assert.equal(existsSync(fallbackNamed), true)
    // The symlink is left in place and its target is untouched.
    assert.equal(lstatSync(symlinked).isSymbolicLink(), true)
    assert.equal(readFileSync(join(decoy, "keep-me"), "utf8"), "precious")
  })
})

test("the sweep skips the directory it is told to keep, and honours the opt-out", () => {
  withTmpRoot((root) => {
    const dead = deadPid()
    const deadDir = join(root, `opencode-claude-code-${dead}`)
    mkdirSync(deadDir, { recursive: true, mode: 0o700 })

    assert.deepEqual(sweepStalePluginTmpDirs(deadDir), [])
    assert.equal(existsSync(deadDir), true)
  })

  withTmpRoot((root) => {
    const deadDir = join(root, `opencode-claude-code-${deadPid()}`)
    mkdirSync(deadDir, { recursive: true, mode: 0o700 })

    const saved = process.env.OPENCODE_CLAUDE_CODE_NO_TMP_SWEEP
    try {
      process.env.OPENCODE_CLAUDE_CODE_NO_TMP_SWEEP = "1"
      assert.deepEqual(sweepStalePluginTmpDirs(), [])
      assert.equal(existsSync(deadDir), true)
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_CLAUDE_CODE_NO_TMP_SWEEP
      else process.env.OPENCODE_CLAUDE_CODE_NO_TMP_SWEEP = saved
    }
  })
})
