// `cleanupStaleUnscopedInstall` deletes from opencode's plugin cache, so what
// it must NOT delete matters more than what it does. Every case below runs
// under a throwaway HOME with XDG_CACHE_HOME and XDG_CONFIG_HOME redirected,
// so the real opencode cache is never a candidate root.

import assert from "node:assert/strict"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

import {
  _resetCleanupStaleState,
  cleanupStaleUnscopedInstall,
} from "./src/cleanup-stale.js"

const STALE = "opencode-claude-code-plugin"
const SCOPED = "@khalilgharbaoui/opencode-claude-code-plugin"

/** The repo root, which is also what the module computes as "us". */
const OUR_DIR = realpathSync(resolve(dirname(fileURLToPath(import.meta.url))))

interface Sandbox {
  root: string
  home: string
  cache: string
  config: string
}

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "cleanup-stale-"))
  const home = join(root, "home")
  const cache = join(root, "cache")
  const config = join(root, "config")
  mkdirSync(home, { recursive: true })
  mkdirSync(cache, { recursive: true })
  mkdirSync(config, { recursive: true })
  return { root, home, cache, config }
}

async function inSandbox(
  fn: (box: Sandbox) => void | Promise<void>,
  env: Record<string, string | undefined> = {},
): Promise<void> {
  const box = sandbox()
  const keys = [
    "HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "OPENCODE_CLAUDE_CODE_PLUGIN_NO_CLEANUP",
    ...Object.keys(env),
  ]
  const saved = new Map(keys.map((key) => [key, process.env[key]]))
  const apply = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    apply("HOME", box.home)
    apply("XDG_CACHE_HOME", box.cache)
    apply("XDG_CONFIG_HOME", box.config)
    apply("OPENCODE_CLAUDE_CODE_PLUGIN_NO_CLEANUP", undefined)
    for (const [key, value] of Object.entries(env)) apply(key, value)
    _resetCleanupStaleState()
    await fn(box)
  } finally {
    for (const [key, value] of saved) apply(key, value)
    _resetCleanupStaleState()
    rmSync(box.root, { recursive: true, force: true })
  }
}

/** The cache root cleanup reads when XDG_CACHE_HOME is set. */
function cacheRoot(box: Sandbox): string {
  return join(box.cache, "opencode")
}

function writePackage(
  dir: string,
  pkg: Record<string, unknown>,
  marker = "marker",
): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2), "utf8")
  writeFileSync(join(dir, "index.js"), `// ${marker}\n`, "utf8")
}

/** An unscoped install that matches every identity check. */
function plantStale(root: string): string {
  const dir = join(root, "node_modules", STALE)
  writePackage(dir, {
    name: STALE,
    version: "0.4.0",
    description: "Claude Code CLI provider plugin for opencode",
  })
  return dir
}

/** The scoped install, which must always survive. */
function plantScoped(root: string): string {
  const dir = join(root, "node_modules", SCOPED)
  writePackage(dir, {
    name: SCOPED,
    version: "0.27.1",
    description: "Claude Code CLI provider plugin for opencode",
  })
  return dir
}

function writeCacheManifest(root: string, dependencies: Record<string, string>): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "opencode-cache", dependencies }, null, 2),
    "utf8",
  )
}

function writeUserConfig(box: Sandbox, config: unknown): void {
  const dir = join(box.config, "opencode")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "opencode.json"),
    typeof config === "string" ? config : JSON.stringify(config, null, 2),
    "utf8",
  )
}

test("removes the unscoped install and prunes it from the cache manifest", async () => {
  await inSandbox((box) => {
    const root = cacheRoot(box)
    const stale = plantStale(root)
    const scoped = plantScoped(root)
    writeCacheManifest(root, {
      [STALE]: "0.4.0",
      [SCOPED]: "0.27.1",
      "some-other-plugin": "1.0.0",
    })

    cleanupStaleUnscopedInstall()

    assert.equal(existsSync(stale), false)
    // The scoped install is a different artifact and is never a target.
    assert.equal(existsSync(scoped), true)

    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
      SCOPED,
      "some-other-plugin",
    ])
    // Rewritten with a trailing newline so the file stays diff-friendly.
    assert.match(readFileSync(join(root, "package.json"), "utf8"), /\n$/)
  })
})

test("sweeps every candidate cache root in one pass", async () => {
  await inSandbox((box) => {
    const roots = [
      cacheRoot(box),
      join(box.home, ".cache", "opencode"),
      join(box.home, "Library", "Caches", "opencode"),
    ]
    const stale = roots.map((root) => plantStale(root))

    cleanupStaleUnscopedInstall()

    for (const dir of stale) assert.equal(existsSync(dir), false)
  })
})

test("leaves a same-named package whose description is not ours", async () => {
  await inSandbox((box) => {
    const root = cacheRoot(box)
    const dir = join(root, "node_modules", STALE)
    writePackage(dir, {
      name: STALE,
      description: "Somebody else's plugin that happens to share the name",
    })

    cleanupStaleUnscopedInstall()

    assert.equal(existsSync(dir), true)
  })
})

test("leaves a directory whose package.json names a different package", async () => {
  await inSandbox((box) => {
    const root = cacheRoot(box)
    const dir = join(root, "node_modules", STALE)
    writePackage(dir, {
      name: "something-entirely-different",
      description: "Claude Code CLI provider plugin for opencode",
    })

    cleanupStaleUnscopedInstall()

    assert.equal(existsSync(dir), true)
  })
})

test("leaves a directory with no package.json, or an unreadable one", async () => {
  await inSandbox((box) => {
    const root = cacheRoot(box)
    const bare = join(root, "node_modules", STALE)
    mkdirSync(bare, { recursive: true })
    writeFileSync(join(bare, "index.js"), "// no manifest\n", "utf8")

    cleanupStaleUnscopedInstall()
    assert.equal(existsSync(bare), true)
  })

  await inSandbox((box) => {
    const root = cacheRoot(box)
    const dir = join(root, "node_modules", STALE)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "package.json"), "{ not json", "utf8")

    cleanupStaleUnscopedInstall()
    assert.equal(existsSync(dir), true)
  })
})

test("never deletes itself when the plugin IS the unscoped install", async () => {
  await inSandbox((box) => {
    const root = cacheRoot(box)
    const nodeModules = join(root, "node_modules")
    mkdirSync(nodeModules, { recursive: true })
    // A cache entry that resolves to the very directory this module was
    // loaded from. Deleting it would delete the running plugin.
    const stale = join(nodeModules, STALE)
    symlinkSync(OUR_DIR, stale, "dir")

    cleanupStaleUnscopedInstall()

    assert.equal(existsSync(stale), true)
    assert.equal(existsSync(join(OUR_DIR, "package.json")), true)
    assert.equal(existsSync(join(OUR_DIR, "src", "cleanup-stale.ts")), true)
  })
})

test("does nothing when the user's opencode.json asks for the unscoped plugin", async () => {
  for (const entry of [STALE, `${STALE}@0.4.0`, `${STALE}@latest`]) {
    await inSandbox((box) => {
      const root = cacheRoot(box)
      const stale = plantStale(root)
      writeUserConfig(box, { plugin: ["unrelated-plugin", entry] })

      cleanupStaleUnscopedInstall()

      assert.equal(existsSync(stale), true, `entry ${entry} should opt out`)
    })
  }
})

test("the scoped name in opencode.json is not an opt-out", async () => {
  await inSandbox((box) => {
    const root = cacheRoot(box)
    const stale = plantStale(root)
    // Listing the scoped plugin is the normal configuration; it must not be
    // read as "the user wants the unscoped one".
    writeUserConfig(box, { plugin: [SCOPED, `${SCOPED}@0.27.1`] })

    cleanupStaleUnscopedInstall()

    assert.equal(existsSync(stale), false)
  })
})

test("a malformed or plugin-less opencode.json is not an opt-out", async () => {
  await inSandbox((box) => {
    const stale = plantStale(cacheRoot(box))
    writeUserConfig(box, "{ not json at all")

    cleanupStaleUnscopedInstall()

    assert.equal(existsSync(stale), false)
  })

  await inSandbox((box) => {
    const stale = plantStale(cacheRoot(box))
    writeUserConfig(box, { plugin: "not-an-array" })

    cleanupStaleUnscopedInstall()

    assert.equal(existsSync(stale), false)
  })
})

test("OPENCODE_CLAUDE_CODE_PLUGIN_NO_CLEANUP=1 disables it entirely", async () => {
  await inSandbox(
    (box) => {
      const stale = plantStale(cacheRoot(box))

      cleanupStaleUnscopedInstall()

      assert.equal(existsSync(stale), true)
    },
    { OPENCODE_CLAUDE_CODE_PLUGIN_NO_CLEANUP: "1" },
  )
})

test("runs at most once per process", async () => {
  await inSandbox((box) => {
    const root = cacheRoot(box)
    plantStale(root)
    cleanupStaleUnscopedInstall()

    // A second install appearing later in the same process is left alone:
    // opencode calls the plugin's server factory more than once.
    const second = plantStale(root)
    cleanupStaleUnscopedInstall()
    assert.equal(existsSync(second), true)
  })
})

test("a cache root that does not exist is skipped without throwing", async () => {
  await inSandbox((box) => {
    rmSync(box.cache, { recursive: true, force: true })
    rmSync(box.home, { recursive: true, force: true })

    cleanupStaleUnscopedInstall()
  })
})

test("a cache manifest without the stale dep is left byte-identical", async () => {
  await inSandbox((box) => {
    const root = cacheRoot(box)
    const stale = plantStale(root)
    const manifestPath = join(root, "package.json")
    writeCacheManifest(root, { "some-other-plugin": "1.0.0" })
    const before = readFileSync(manifestPath, "utf8")

    cleanupStaleUnscopedInstall()

    assert.equal(existsSync(stale), false)
    assert.equal(readFileSync(manifestPath, "utf8"), before)
  })
})

test("removal still happens when the cache manifest is missing or corrupt", async () => {
  await inSandbox((box) => {
    const stale = plantStale(cacheRoot(box))

    cleanupStaleUnscopedInstall()

    assert.equal(existsSync(stale), false)
  })

  await inSandbox((box) => {
    const root = cacheRoot(box)
    const stale = plantStale(root)
    writeFileSync(join(root, "package.json"), "{{{", "utf8")

    cleanupStaleUnscopedInstall()

    assert.equal(existsSync(stale), false)
  })
})
