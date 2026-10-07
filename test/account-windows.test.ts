// The `accounts` option on Windows, where there is no wrapper script.
//
// On POSIX a generated bash wrapper does three things for every spawn of a
// non-default account: export CLAUDE_CONFIG_DIR, strip the `@account` marker
// off `--model`, and pass everything else through byte for byte
// (test/account-wrapper.test.ts proves that by executing it). On Windows the
// plugin does the same three things itself, because a `.cmd` twin would have
// to forward `%*` through a third cmd.exe parse and re-quote the one argument
// it rewrites in a language with no reliable quoter (h #g217, h #g221).
//
// So this file asserts the same contract from the other side. The planning
// half runs everywhere with an injected platform; the proof runs on Windows
// only, spawning a real `.cmd` shim through the real `planClaudeSpawn` and
// reading back what the child saw.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, test } from "node:test"

import { ensureAccountRuntime } from "../src/accounts.js"
import { stripAccountSuffix } from "../src/account-failover.js"
import { parseModelId } from "../src/models.js"
import { buildCliArgs, claudeSpawnEnv } from "../src/session-manager.js"
import { planClaudeSpawn } from "../src/windows-spawn.js"

const isWindows = process.platform === "win32"

interface Sandbox {
  root: string
  home: string
  cache: string
}

function sandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "acct-win "))
  // A space in every interpolated path, which is what broke the shell version.
  const home = path.join(root, "ho me")
  const cache = path.join(root, "ca che")
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(cache, { recursive: true })
  return { root, home, cache }
}

async function withSandbox(fn: (box: Sandbox) => Promise<void>): Promise<void> {
  const box = sandbox()
  const saved = {
    home: process.env.HOME,
    profile: process.env.USERPROFILE,
    cache: process.env.XDG_CACHE_HOME,
  }
  try {
    process.env.HOME = box.home
    process.env.USERPROFILE = box.home
    process.env.XDG_CACHE_HOME = box.cache
    await fn(box)
  } finally {
    restore("HOME", saved.home)
    restore("USERPROFILE", saved.profile)
    restore("XDG_CACHE_HOME", saved.cache)
    fs.rmSync(box.root, { recursive: true, force: true })
  }
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/**
 * The two lines `doStream` runs between `ensureAccountRuntime` and the spawn,
 * composed here the same way: the account marker comes off the model id, and
 * the config dir becomes an environment variable.
 */
function spawnPlanFor(
  runtime: { cliPath: string; configDir?: string; accountInProcess?: boolean },
  modelId: string,
  extraArgs: string[],
): { args: string[]; env: Record<string, string | undefined> } {
  const { model } = parseModelId(
    runtime.accountInProcess ? stripAccountSuffix(modelId) : modelId,
  )
  const args = buildCliArgs({
    sessionKey: "sk",
    skipPermissions: true,
    includeSessionId: false,
    model,
  })
  return {
    args: [...args, ...extraArgs],
    env: claudeSpawnEnv({
      configDir: runtime.accountInProcess ? runtime.configDir : undefined,
    }),
  }
}

// ---------------------------------------------------------------------------
// Planning. Runs on every platform; the platform is injected.
// ---------------------------------------------------------------------------

test("on Windows an account runs the base CLI with no wrapper written", async () => {
  await withSandbox(async (box) => {
    const runtime = await ensureAccountRuntime("Work Account", "claude", {
      platform: "win32",
    })

    assert.equal(runtime.cliPath, "claude")
    assert.equal(runtime.accountInProcess, true)
    assert.equal(runtime.configDir, path.join(box.home, ".claude-work-account"))
    assert.equal(fs.existsSync(runtime.configDir!), true)
    // Nothing is generated and nothing is made executable: the whole point.
    assert.equal(
      fs.existsSync(path.join(box.cache, "opencode-claude-code-plugin")),
      false,
    )
  })
})

test("the default account is untouched on Windows too", async () => {
  await withSandbox(async (box) => {
    const runtime = await ensureAccountRuntime("default", "claude", {
      platform: "win32",
    })
    assert.equal(runtime.cliPath, "claude")
    assert.equal(runtime.configDir, undefined)
    assert.equal(runtime.accountInProcess, undefined)
    assert.equal(
      fs.existsSync(path.join(box.cache, "opencode-claude-code-plugin")),
      false,
    )
  })
})

test("the in-process account exports its config dir and strips the marker", async () => {
  await withSandbox(async (box) => {
    const runtime = await ensureAccountRuntime("work", "claude", {
      platform: "win32",
    })
    const plan = spawnPlanFor(runtime, "claude-opus-5@work", [])

    assert.equal(plan.env.CLAUDE_CONFIG_DIR, path.join(box.home, ".claude-work"))
    const at = plan.args.indexOf("--model")
    assert.notEqual(at, -1)
    assert.equal(plan.args[at + 1], "claude-opus-5")
  })
})

test("the fast marker still becomes --settings, with the account marker gone", async () => {
  await withSandbox(async (_box) => {
    const runtime = await ensureAccountRuntime("work", "claude", {
      platform: "win32",
    })
    // `parseModelId` reads `-fast` off the base name, so stripping the account
    // first must not change which ids it recognises.
    const { model, fast } = parseModelId(stripAccountSuffix("claude-opus-5-fast@work"))
    assert.equal(model, "claude-opus-5")
    assert.equal(fast, true)
    assert.equal(runtime.accountInProcess, true)
  })
})

test("a POSIX account still gets the wrapper and no environment variable", async () => {
  await withSandbox(async (box) => {
    const runtime = await ensureAccountRuntime("work", "claude", {
      platform: "linux",
    })
    assert.equal(runtime.accountInProcess, undefined)
    assert.equal(
      runtime.cliPath,
      path.join(box.cache, "opencode-claude-code-plugin", "claude-work"),
    )
    // The wrapper owns both jobs there, so the plugin sets neither.
    const plan = spawnPlanFor(runtime, "claude-opus-5@work", [])
    assert.equal(plan.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR)
    const at = plan.args.indexOf("--model")
    assert.equal(plan.args[at + 1], "claude-opus-5@work")
  })
})

test("shared capabilities land in the account dir under the win32 plan", async () => {
  await withSandbox(async (box) => {
    const source = path.join(box.home, ".claude")
    fs.mkdirSync(path.join(source, "skills"), { recursive: true })
    fs.writeFileSync(path.join(source, "CLAUDE.md"), "# rules\n", "utf8")

    const runtime = await ensureAccountRuntime("work", "claude", {
      platform: "win32",
    })
    const target = runtime.configDir!

    // A directory is a junction on Windows and a symlink elsewhere; either
    // way the CLI reads the same tree. A file may be a symlink, a hard link
    // or a copy depending on what the volume and the privileges allow, so
    // only its CONTENT is asserted.
    assert.equal(fs.existsSync(path.join(target, "skills")), true)
    assert.equal(fs.readFileSync(path.join(target, "CLAUDE.md"), "utf8"), "# rules\n")
    // Nothing is invented for a capability the source does not have.
    assert.equal(fs.existsSync(path.join(target, "agents")), false)
  })
})

// A link the filesystem refuses is the ORDINARY case on Windows, where a FILE
// symlink needs Developer Mode or an elevated process. Whatever the account
// cannot share, it still has to RUN: the capabilities are a convenience and
// the config dir is the account. Forced here with POSIX mode bits, which is
// the only portable way to make a link fail; Windows has no mode bits and
// `chmod` there is a no-op, so the Windows job skips it.
test(
  "an account whose capabilities cannot be linked still runs",
  { skip: isWindows ? "forced with POSIX mode bits" : false },
  async () => {
    await withSandbox(async (box) => {
      const source = path.join(box.home, ".claude")
      fs.mkdirSync(path.join(source, "skills"), { recursive: true })
      fs.writeFileSync(path.join(source, "CLAUDE.md"), "# rules\n", "utf8")

      const target = path.join(box.home, ".claude-work")
      fs.mkdirSync(target, { recursive: true })
      fs.chmodSync(target, 0o500)

      try {
        const runtime = await ensureAccountRuntime("work", "claude", {
          platform: "win32",
        })
        assert.equal(runtime.configDir, target)
        assert.equal(runtime.accountInProcess, true)
        assert.equal(fs.existsSync(path.join(target, "CLAUDE.md")), false)
        assert.equal(fs.existsSync(path.join(target, "skills")), false)
      } finally {
        fs.chmodSync(target, 0o700)
      }
    })
  },
)

// ---------------------------------------------------------------------------
// The proof. Everything above plans; this spawns.
// ---------------------------------------------------------------------------

describe("an account spawn on Windows", { skip: isWindows ? false : "Windows only" }, () => {
  /**
   * A batch shim shaped like npm's `claude.cmd`, reporting back both halves of
   * the wrapper contract: what it was handed as argv, and what
   * CLAUDE_CONFIG_DIR it inherited.
   */
  function makeShim(dir: string): string {
    fs.writeFileSync(
      path.join(dir, "argv.cjs"),
      "process.stdout.write(JSON.stringify({" +
        "argv: process.argv.slice(2)," +
        "configDir: process.env.CLAUDE_CONFIG_DIR ?? null" +
        "}))\n",
      "utf8",
    )
    const shim = path.join(dir, "claude.cmd")
    fs.writeFileSync(shim, '@echo off\r\nnode "%~dp0argv.cjs" %*\r\n', "utf8")
    return shim
  }

  function runAccountSpawn(
    shim: string,
    runtime: { cliPath: string; configDir?: string; accountInProcess?: boolean },
    modelId: string,
    extraArgs: string[],
    cwd: string,
  ): { argv: string[]; configDir: string | null } {
    const planned = spawnPlanFor({ ...runtime, cliPath: shim }, modelId, extraArgs)
    const plan = planClaudeSpawn(shim, planned.args)
    const result = spawnSync(plan.file, plan.args, {
      cwd,
      encoding: "utf8",
      env: planned.env,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, `shim failed: ${result.stderr}`)
    return JSON.parse(result.stdout) as { argv: string[]; configDir: string | null }
  }

  test("the child sees the account's config dir and the stripped model", async () => {
    await withSandbox(async (box) => {
      const shim = makeShim(box.root)
      const runtime = await ensureAccountRuntime("work", shim, { platform: "win32" })
      const seen = runAccountSpawn(shim, runtime, "claude-opus-5@work", [], box.root)

      assert.equal(seen.configDir, path.join(box.home, ".claude-work"))
      const at = seen.argv.indexOf("--model")
      assert.notEqual(at, -1)
      assert.equal(seen.argv[at + 1], "claude-opus-5")
    })
  })

  test("every other argument arrives byte-identical", async () => {
    await withSandbox(async (box) => {
      const shim = makeShim(box.root)
      const runtime = await ensureAccountRuntime("work", shim, { platform: "win32" })
      // The same adversarial shapes the escaper is measured against, minus the
      // two it cannot carry at all: `%` (cmd expands it before anything else
      // is considered) and a newline (cmd ends the command line there). Both
      // are covered in test/windows-spawn.test.ts.
      const extras = [
        "--settings",
        '{"fastMode":true}',
        "--mcp-config",
        '{"mcpServers":{"x":{"url":"http://127.0.0.1:1/"}}}',
        "--append-system-prompt",
        "a b  'c' \"d\" & | > < ^ ( ) ; , !",
        "--add-dir",
        "C:\\a path\\with space\\",
        "--append-system-prompt",
        'trailing backslash before a quote \\"',
        "--append-system-prompt",
        "",
      ]
      const seen = runAccountSpawn(shim, runtime, "claude-opus-5@work", extras, box.root)

      assert.deepEqual(seen.argv.slice(seen.argv.length - extras.length), extras)
    })
  })

  test("the account spawn runs no second command", async () => {
    await withSandbox(async (box) => {
      const shim = makeShim(box.root)
      const runtime = await ensureAccountRuntime("work", shim, { platform: "win32" })
      const attempts = [
        "x & echo pwned > pwned.txt",
        'x" & echo pwned > pwned.txt & "',
        "x | findstr /v . > pwned.txt",
      ]
      for (const attempt of attempts) {
        runAccountSpawn(
          shim,
          runtime,
          "claude-opus-5@work",
          ["--append-system-prompt", attempt],
          box.root,
        )
        assert.equal(
          fs.existsSync(path.join(box.root, "pwned.txt")),
          false,
          `injection ran: ${attempt}`,
        )
      }
    })
  })
})
