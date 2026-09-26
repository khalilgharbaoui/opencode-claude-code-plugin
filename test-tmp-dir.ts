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
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { test } from "node:test"

import { __test, _resetPluginTmpDir, pluginTmpDir } from "./src/tmp.js"

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
