// The per-account wrapper is a generated bash script that every spawn of a
// non-default account goes through. Its three jobs are stripping the
// `@account` marker off `--model`, exporting CLAUDE_CONFIG_DIR and passing
// everything else through byte for byte. All of that is shell quoting, which
// only a real execution can prove, so these tests run the generated script
// against a fake `claude` that prints its argv and env.

import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"

import {
  DEFAULT_ACCOUNT,
  accountConfigDir,
  accountConfigDirPath,
  accountDisplayName,
  accountModelSuffix,
  accountProviderId,
  ensureAccountRuntime,
  expandHome,
  normalizeAccountName,
  resolveAccounts,
} from "./src/accounts.js"

const run = promisify(execFile)

const ARGV_SENTINEL = "ARGV:"
const ENV_SENTINEL = "CONFIG_DIR:"
/** ASCII record separator: arguments may contain newlines, so lines won't do. */
const RECORD = "\u001e"

interface Sandbox {
  root: string
  /** Deliberately awkward: a space, a quote and a dollar sign. */
  home: string
  cache: string
  fakeCli: string
}

const sandboxes: string[] = []

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "acct-wrapper-"))
  sandboxes.push(root)
  // Every path the wrapper interpolates gets characters that break naive
  // quoting: a space, a single quote and a `$`.
  const home = join(root, "ho me's $dir")
  const cache = join(root, "ca che")
  const cliDir = join(root, "cli 's bin")
  mkdirSync(home, { recursive: true })
  mkdirSync(cache, { recursive: true })
  mkdirSync(cliDir, { recursive: true })

  const fakeCli = join(cliDir, "claude fake")
  writeFileSync(
    fakeCli,
    `#!/usr/bin/env bash
printf '${ENV_SENTINEL}%s\\036' "\${CLAUDE_CONFIG_DIR-<unset>}"
for arg in "$@"; do
  printf '${ARGV_SENTINEL}%s\\036' "$arg"
done
`,
    "utf8",
  )
  chmodSync(fakeCli, 0o755)

  return { root, home, cache, fakeCli }
}

async function withSandbox(
  fn: (box: Sandbox) => Promise<void>,
): Promise<void> {
  const box = sandbox()
  const savedHome = process.env.HOME
  const savedCache = process.env.XDG_CACHE_HOME
  try {
    process.env.HOME = box.home
    process.env.XDG_CACHE_HOME = box.cache
    await fn(box)
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = savedCache
    rmSync(box.root, { recursive: true, force: true })
    sandboxes.splice(sandboxes.indexOf(box.root), 1)
  }
}

interface WrapperResult {
  argv: string[]
  configDir: string
  stdout: string
}

async function callWrapper(
  wrapperPath: string,
  args: string[],
): Promise<WrapperResult> {
  const { stdout } = await run(wrapperPath, args, { env: process.env })
  const records = stdout.split(RECORD)
  return {
    argv: records
      .filter((record) => record.startsWith(ARGV_SENTINEL))
      .map((record) => record.slice(ARGV_SENTINEL.length)),
    configDir:
      records
        .find((record) => record.startsWith(ENV_SENTINEL))
        ?.slice(ENV_SENTINEL.length) ?? "<missing>",
    stdout,
  }
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

test("account names normalize to a slug, whatever the operator typed", () => {
  assert.equal(normalizeAccountName("  Work Account  "), "work-account")
  assert.equal(normalizeAccountName("Appical"), "appical")
  assert.equal(normalizeAccountName("me@example.com"), "me-example-com")
  assert.equal(normalizeAccountName("--weird--"), "weird")
  // Non-ASCII collapses to separators, so the slug stays filesystem-safe.
  assert.equal(normalizeAccountName("Ünïcode"), "n-code")
  assert.equal(normalizeAccountName("!!!"), "")
})

test("resolveAccounts always leads with default and de-duplicates", () => {
  assert.deepEqual(resolveAccounts(["Work", "work", "Appical"]), [
    "default",
    "work",
    "appical",
  ])
  // An explicit `default` is not duplicated, and junk entries drop out.
  assert.deepEqual(resolveAccounts(["default", "!!!", "Work"]), [
    "default",
    "work",
  ])
  // Not an array: the caller must treat accounts as unconfigured, not empty.
  assert.equal(resolveAccounts(undefined), null)
  assert.equal(resolveAccounts("work"), null)
  assert.deepEqual(resolveAccounts([]), ["default"])
})

test("the default account has no suffix, no config dir and no wrapper", async () => {
  assert.equal(accountModelSuffix(DEFAULT_ACCOUNT), undefined)
  assert.equal(accountConfigDir(DEFAULT_ACCOUNT), undefined)
  assert.equal(accountConfigDirPath(DEFAULT_ACCOUNT), undefined)
  assert.equal(accountProviderId(DEFAULT_ACCOUNT), "claude-code-default")
  assert.equal(accountDisplayName("work account"), "Claude Code (Work Account)")
  assert.equal(accountConfigDir("Work Account"), "~/.claude-work-account")

  await withSandbox(async (box) => {
    const runtime = await ensureAccountRuntime("Default", box.fakeCli)
    // Unchanged CLI path, no config dir: the default account stays on the
    // CLI's own ~/.claude.
    assert.equal(runtime.cliPath, box.fakeCli)
    assert.equal(runtime.configDir, undefined)
    assert.equal(existsSync(join(box.cache, "opencode-claude-code-plugin")), false)
  })
})

test("expandHome only expands a leading ~", () => {
  const saved = process.env.HOME
  try {
    process.env.HOME = "/tmp/home"
    assert.equal(expandHome("~"), "/tmp/home")
    assert.equal(expandHome("~/.claude-work"), "/tmp/home/.claude-work")
    assert.equal(expandHome("/absolute/~/path"), "/absolute/~/path")
    assert.equal(expandHome("~notmyhome/x"), "~notmyhome/x")
  } finally {
    if (saved === undefined) delete process.env.HOME
    else process.env.HOME = saved
  }
})

// ---------------------------------------------------------------------------
// The generated wrapper, executed
// ---------------------------------------------------------------------------

test("the wrapper exports CLAUDE_CONFIG_DIR and execs the base CLI", async () => {
  await withSandbox(async (box) => {
    const runtime = await ensureAccountRuntime("Work Account", box.fakeCli)

    assert.equal(
      runtime.cliPath,
      join(box.cache, "opencode-claude-code-plugin", "claude-work-account"),
    )
    assert.equal(runtime.configDir, join(box.home, ".claude-work-account"))
    assert.equal(existsSync(runtime.configDir!), true)

    const result = await callWrapper(runtime.cliPath, ["--version"])
    // A HOME with a space, a quote and a `$` still arrives intact.
    assert.equal(result.configDir, join(box.home, ".claude-work-account"))
    assert.deepEqual(result.argv, ["--version"])
  })
})

test("the wrapper strips its own @account marker from --model", async () => {
  await withSandbox(async (box) => {
    const runtime = await ensureAccountRuntime("work", box.fakeCli)

    const result = await callWrapper(runtime.cliPath, [
      "--print",
      "--model",
      "claude-opus-5@work",
      "--settings",
      '{"fastMode":true}',
    ])

    assert.deepEqual(result.argv, [
      "--print",
      "--model",
      "claude-opus-5",
      "--settings",
      '{"fastMode":true}',
    ])
  })
})

test("a model with no marker, or another account's marker, is untouched", async () => {
  await withSandbox(async (box) => {
    const runtime = await ensureAccountRuntime("work", box.fakeCli)

    assert.deepEqual(
      (await callWrapper(runtime.cliPath, ["--model", "claude-opus-5"])).argv,
      ["--model", "claude-opus-5"],
    )
    // Only this wrapper's own account is stripped; another one would be a
    // model id the CLI is meant to reject.
    assert.deepEqual(
      (await callWrapper(runtime.cliPath, ["--model", "claude-opus-5@other"]))
        .argv,
      ["--model", "claude-opus-5@other"],
    )
    // The marker is a suffix, not a substring.
    assert.deepEqual(
      (await callWrapper(runtime.cliPath, ["--model", "claude@work-5"])).argv,
      ["--model", "claude@work-5"],
    )
  })
})

test("only the value after --model is rewritten, and only that occurrence", async () => {
  await withSandbox(async (box) => {
    const runtime = await ensureAccountRuntime("work", box.fakeCli)

    const result = await callWrapper(runtime.cliPath, [
      "--append-system-prompt",
      "mention claude-opus-5@work verbatim",
      "--model",
      "claude-opus-5@work",
      "--model",
      "claude-haiku-4-5@work",
    ])

    assert.deepEqual(result.argv, [
      "--append-system-prompt",
      "mention claude-opus-5@work verbatim",
      "--model",
      "claude-opus-5",
      "--model",
      "claude-haiku-4-5",
    ])
  })
})

test("a trailing bare --model is passed through rather than eaten", async () => {
  await withSandbox(async (box) => {
    const runtime = await ensureAccountRuntime("work", box.fakeCli)
    assert.deepEqual((await callWrapper(runtime.cliPath, ["--model"])).argv, [
      "--model",
    ])
  })
})

test("arguments keep their spaces, quotes, globs and newlines", async () => {
  await withSandbox(async (box) => {
    const runtime = await ensureAccountRuntime("work", box.fakeCli)

    const awkward = [
      "--append-system-prompt",
      "a b  'c' \"d\" $HOME `whoami` *",
      "--mcp-config",
      '{"mcpServers":{"x":{"url":"http://127.0.0.1:1/"}}}',
      "--settings",
      "line one\nline two",
    ]

    assert.deepEqual((await callWrapper(runtime.cliPath, awkward)).argv, awkward)
  })
})

test("the wrapper runs with no arguments at all", async () => {
  await withSandbox(async (box) => {
    const runtime = await ensureAccountRuntime("work", box.fakeCli)
    // macOS ships bash 3.2, where `"${args[@]}"` on an empty array is an
    // unbound-variable error under `set -u`. A bare invocation has to work.
    const result = await callWrapper(runtime.cliPath, [])
    assert.deepEqual(result.argv, [])
    assert.equal(result.configDir, join(box.home, ".claude-work"))
  })
})

test("the wrapper is executable and rewritten on every run", async () => {
  await withSandbox(async (box) => {
    const first = await ensureAccountRuntime("work", box.fakeCli)
    assert.equal(lstatSync(first.cliPath).mode & 0o111, 0o111)

    // A changed base CLI path must be picked up, not left pointing at the old
    // binary: account failover rebuilds a wrapper over the same base.
    const otherCli = join(box.root, "other claude")
    writeFileSync(otherCli, readFileSync(box.fakeCli, "utf8"), "utf8")
    chmodSync(otherCli, 0o755)

    const second = await ensureAccountRuntime("work", otherCli)
    assert.equal(second.cliPath, first.cliPath)
    assert.match(readFileSync(second.cliPath, "utf8"), /other claude/)
  })
})

// ---------------------------------------------------------------------------
// Shared capabilities
// ---------------------------------------------------------------------------

test("shared Claude capabilities are symlinked into the account config dir", async () => {
  await withSandbox(async (box) => {
    const source = join(box.home, ".claude")
    mkdirSync(join(source, "skills"), { recursive: true })
    writeFileSync(join(source, "CLAUDE.md"), "# rules\n", "utf8")
    writeFileSync(join(source, "settings.json"), "{}", "utf8")

    const runtime = await ensureAccountRuntime("work", box.fakeCli)
    const target = runtime.configDir!

    assert.equal(lstatSync(join(target, "CLAUDE.md")).isSymbolicLink(), true)
    assert.equal(readlinkSync(join(target, "CLAUDE.md")), join(source, "CLAUDE.md"))
    assert.equal(lstatSync(join(target, "skills")).isSymbolicLink(), true)
    // Nothing is invented for a capability the source does not have.
    assert.equal(existsSync(join(target, "agents")), false)

    // Idempotent: a second run leaves the existing links alone.
    await ensureAccountRuntime("work", box.fakeCli)
    assert.equal(readlinkSync(join(target, "settings.json")), join(source, "settings.json"))
  })
})

test("a real file already in the account config dir is never replaced", async () => {
  await withSandbox(async (box) => {
    const source = join(box.home, ".claude")
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, "settings.json"), '{"from":"shared"}', "utf8")

    const target = join(box.home, ".claude-work")
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, "settings.json"), '{"from":"account"}', "utf8")

    await ensureAccountRuntime("work", box.fakeCli)

    // The account's own settings win: symlinking over them would silently
    // discard a per-account login or permission set.
    assert.equal(lstatSync(join(target, "settings.json")).isSymbolicLink(), false)
    assert.equal(readFileSync(join(target, "settings.json"), "utf8"), '{"from":"account"}')
  })
})
