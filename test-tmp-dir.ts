// The per-process scratch directory three modules build paths under: the
// bridged MCP config (mcp-bridge), the proxy server's 0600 --mcp-config
// (proxy-mcp) and the staged skill plugin dirs (skill-bridge). Its name and
// its exit cleanup are the contract, so both are pinned here.

import assert from "node:assert/strict"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { test } from "node:test"

import { pluginTmpDir } from "./src/tmp.js"

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
