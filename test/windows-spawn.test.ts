import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  DEFAULT_PATHEXT,
  executableExtensions,
  isBatchFile,
  planClaudeSpawn,
  planCmdInvocation,
  quoteBatchArgument,
  quoteWindowsArgument,
  resolveWindowsCommand,
} from "../src/windows-spawn.js"

const isWindows = process.platform === "win32"

/**
 * The adversarial set. Every one of these is something the plugin really
 * passes: `--settings` JSON, a scratch-dir path, a model id, a workspace path
 * the operator chose, or the shape of an injection attempt against the old
 * `shell: true` spawn.
 */
const ADVERSARIAL: Array<{ name: string; value: string }> = [
  { name: "plain", value: "--version" },
  { name: "empty string", value: "" },
  { name: "space", value: "C:\\Program Files\\claude\\prompt.txt" },
  { name: "double quotes", value: 'say "hello"' },
  { name: "ampersand", value: "a & echo pwned" },
  { name: "pipe", value: "a | echo pwned" },
  { name: "redirect out", value: "a > pwned.txt" },
  { name: "redirect in", value: "a < pwned.txt" },
  { name: "caret", value: "a ^ b ^^ c" },
  { name: "percent", value: "%PATH%" },
  { name: "bang", value: "!PATH!" },
  { name: "parens", value: "(a) (b)" },
  { name: "semicolon and comma", value: "a;b,c" },
  { name: "trailing backslash", value: "C:\\scratch\\dir\\" },
  { name: "backslashes before quote", value: 'C:\\a\\\\"b' },
  { name: "many trailing backslashes", value: "x\\\\\\" },
  { name: "settings json", value: '{"fastMode":true,"note":"a&b|c>d"}' },
  { name: "every metacharacter", value: "()[]%!^\"`<>&|;, *?" },
  { name: "multi-line path", value: "/tmp/scratch\nline two/system-prompt.txt" },
]

// ---------------------------------------------------------------------------
// Reference implementations of what Windows does to a command line. They are
// the oracle the escaper is checked against, so they are written from the
// documented algorithms rather than from the escaper.
// ---------------------------------------------------------------------------

/** The `CommandLineToArgvW` parser, applied to an argument list (no argv[0]). */
function parseCommandLineToArgv(line: string): string[] {
  const argv: string[] = []
  let current = ""
  let inQuotes = false
  let started = false
  let index = 0

  while (index < line.length) {
    const char = line[index]
    if (!inQuotes && (char === " " || char === "\t")) {
      if (started) {
        argv.push(current)
        current = ""
        started = false
      }
      index += 1
      continue
    }
    if (char === "\\") {
      let backslashes = 0
      while (line[index] === "\\") {
        backslashes += 1
        index += 1
      }
      if (line[index] === '"') {
        current += "\\".repeat(Math.floor(backslashes / 2))
        started = true
        if (backslashes % 2 === 1) {
          current += '"'
          index += 1
        }
      } else {
        current += "\\".repeat(backslashes)
        started = true
      }
      continue
    }
    if (char === '"') {
      started = true
      if (inQuotes && line[index + 1] === '"') {
        // The "" inside quotes means a literal quote.
        current += '"'
        index += 2
        continue
      }
      inQuotes = !inQuotes
      index += 1
      continue
    }
    current += char
    started = true
    index += 1
  }
  if (started) argv.push(current)
  return argv
}

/**
 * cmd.exe's own parse of a command line, as far as this module depends on it.
 * cmd toggles its quote state on `"`, has NO backslash escape, and treats
 * `& | < > ( )` as special only outside quotes. It passes the text on with the
 * quotes still in it, which is why the program's own `CommandLineToArgvW`
 * parse comes afterwards.
 *
 * Returns the text cmd would hand on, and the metacharacters it saw outside
 * quotes: anything in that second list is an injection.
 */
function parseAsCmd(line: string): { passedOn: string; unquotedMeta: string[] } {
  let inQuotes = false
  const unquotedMeta: string[] = []
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (!inQuotes && "&|<>()^".includes(char)) unquotedMeta.push(char)
  }
  assert.equal(inQuotes, false, `unbalanced quotes would leave cmd parsing into the next argument: ${line}`)
  return { passedOn: line, unquotedMeta }
}

/** `cmd /s /c "<line>"`: strip exactly the outer pair of quotes. */
function stripOuterQuotes(arg: string): string {
  assert.ok(arg.startsWith('"') && arg.endsWith('"'), "the /c payload is quoted")
  return arg.slice(1, -1)
}

/**
 * The whole pipeline a batch shim puts an argument through: cmd's parse of our
 * `/c` payload, the shim's `%*` substitution (verbatim), cmd's parse of the
 * shim's own line, and finally the program's `CommandLineToArgvW`. Percent
 * expansion is the one phase not modelled; it is measured live below.
 */
function throughBatchShim(payload: string): string[] {
  const first = parseAsCmd(stripOuterQuotes(payload))
  assert.deepEqual(first.unquotedMeta, [], "nothing is special to cmd on the first pass")
  // `%*` hands the argument text on with its quotes intact, and the shim's own
  // line (`node "argv.cjs" %*`) is parsed by cmd a second time.
  const commandEnd = first.passedOn.indexOf('" ')
  const argumentText = commandEnd === -1 ? "" : first.passedOn.slice(commandEnd + 2)
  const second = parseAsCmd(argumentText)
  assert.deepEqual(second.unquotedMeta, [], "nothing is special to cmd on the second pass either")
  return parseCommandLineToArgv(second.passedOn)
}

describe("quoteWindowsArgument", () => {
  for (const { name, value } of ADVERSARIAL) {
    test(`round-trips through CommandLineToArgvW: ${name}`, () => {
      assert.deepEqual(parseCommandLineToArgv(quoteWindowsArgument(value)), value === "" ? [""] : [value])
    })
  }

  test("round-trips a whole argument list at once", () => {
    const values = ADVERSARIAL.map((entry) => entry.value)
    const line = values.map(quoteWindowsArgument).join(" ")
    assert.deepEqual(parseCommandLineToArgv(line), values)
  })

  test("always quotes, so an empty argument survives", () => {
    assert.equal(quoteWindowsArgument(""), '""')
  })

  test("doubles backslashes only where they meet a quote or the end", () => {
    assert.equal(quoteWindowsArgument("a\\b"), '"a\\b"')
    assert.equal(quoteWindowsArgument("a\\"), '"a\\\\"')
    assert.equal(quoteWindowsArgument('a\\"'), '"a\\\\\\""')
  })
})

describe("quoteBatchArgument", () => {
  test("keeps cmd's quote state balanced, so no metacharacter is ever outside quotes", () => {
    for (const { name, value } of ADVERSARIAL) {
      if (/[\r\n]/.test(value)) continue
      const { unquotedMeta } = parseAsCmd(quoteBatchArgument(value))
      assert.deepEqual(unquotedMeta, [], name)
    }
  })

  test("writes an embedded quote as the doubled form cmd counts and the CRT reads", () => {
    assert.equal(quoteBatchArgument('a"b'), '"a""b"')
    assert.equal(quoteBatchArgument('a\\"b'), '"a\\\\""b"')
    assert.equal(quoteBatchArgument("a\\"), '"a\\\\"')
    assert.equal(quoteBatchArgument(""), '""')
  })

  test("never emits a caret, which inside quotes would arrive as a literal one", () => {
    assert.equal(quoteBatchArgument("a & b").includes("^"), false)
    assert.equal(quoteBatchArgument("a ^ b"), '"a ^ b"')
  })

  test("refuses a newline rather than letting cmd truncate the command line", () => {
    assert.throws(() => quoteBatchArgument("a\nb"), /newline/)
    assert.throws(() => quoteBatchArgument("a\rb"), /newline/)
  })

  test("round-trips through CommandLineToArgvW on its own", () => {
    for (const { name, value } of ADVERSARIAL) {
      if (/[\r\n]/.test(value)) continue
      assert.deepEqual(parseCommandLineToArgv(quoteBatchArgument(value)), [value], name)
    }
  })
})

describe("planCmdInvocation", () => {
  const env = { ComSpec: "C:\\Windows\\System32\\cmd.exe", PATHEXT: DEFAULT_PATHEXT }

  test("uses /d /s /c, ComSpec and verbatim arguments", () => {
    const plan = planCmdInvocation("C:\\npm\\claude.cmd", ["--version"], env)
    assert.equal(plan.file, "C:\\Windows\\System32\\cmd.exe")
    assert.equal(plan.args[0], "/d")
    assert.equal(plan.args[1], "/s")
    assert.equal(plan.args[2], "/c")
    assert.equal(plan.windowsVerbatimArguments, true)
    assert.equal(plan.args.length, 4)
  })

  test("falls back to cmd.exe when ComSpec is unset", () => {
    assert.equal(planCmdInvocation("C:\\npm\\claude.cmd", [], {}).file, "cmd.exe")
  })

  test("quotes the command path rather than escaping it, and normalizes separators", () => {
    const plan = planCmdInvocation("C:/Program Files/npm/claude.cmd", [], env)
    assert.equal(plan.args[3], '""C:\\Program Files\\npm\\claude.cmd""')
  })

  test("the whole command line survives both of cmd's parses, argument for argument", () => {
    // `%` expansion is the one phase the model does not cover; it is measured
    // live on Windows below. A newline cannot be carried at all.
    const values = ADVERSARIAL.filter(
      (entry) => !entry.value.includes("%") && !/[\r\n]/.test(entry.value),
    ).map((entry) => entry.value)
    const plan = planCmdInvocation("C:\\npm dir\\claude.cmd", values, env)
    assert.deepEqual(throughBatchShim(plan.args[3]), values)
  })

  test("an argument that tries to close the quoting cannot reach a second pass", () => {
    const plan = planCmdInvocation("C:\\npm\\claude.cmd", ['x" & echo pwned > pwned.txt & "'], env)
    assert.deepEqual(throughBatchShim(plan.args[3]), ['x" & echo pwned > pwned.txt & "'])
  })
})

describe("isBatchFile", () => {
  test("is true for .cmd and .bat only", () => {
    assert.equal(isBatchFile("C:\\x\\claude.cmd"), true)
    assert.equal(isBatchFile("C:\\x\\claude.BAT"), true)
    assert.equal(isBatchFile("C:\\x\\claude.exe"), false)
    assert.equal(isBatchFile("/usr/local/bin/claude"), false)
  })
})

describe("executableExtensions", () => {
  test("reads PATHEXT, case-insensitively, and defaults when it is absent", () => {
    assert.deepEqual(executableExtensions({ PATHEXT: ".EXE;.CMD" }), [".exe", ".cmd"])
    assert.deepEqual(executableExtensions({ pathext: ".EXE" }), [".exe"])
    assert.deepEqual(executableExtensions({}), [".com", ".exe", ".bat", ".cmd"])
  })

  test("tolerates entries without a leading dot and empty entries", () => {
    assert.deepEqual(executableExtensions({ PATHEXT: "EXE;;.CMD;" }), [".exe", ".cmd"])
  })
})

describe("resolveWindowsCommand", () => {
  const env = { PATH: "C:\\bin;C:\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD" }
  const present = (...files: string[]) => (candidate: string) => files.includes(candidate)

  test("finds a .cmd shim on PATH", () => {
    assert.equal(
      resolveWindowsCommand("claude", { env, isFile: present("C:\\npm\\claude.cmd") }),
      "C:\\npm\\claude.cmd",
    )
  })

  test("prefers PATHEXT order, so a .exe beats a .cmd in the same directory", () => {
    assert.equal(
      resolveWindowsCommand("claude", {
        env,
        isFile: present("C:\\npm\\claude.exe", "C:\\npm\\claude.cmd"),
      }),
      "C:\\npm\\claude.exe",
    )
  })

  test("takes PATH entries in order", () => {
    assert.equal(
      resolveWindowsCommand("claude", {
        env,
        isFile: present("C:\\bin\\claude.cmd", "C:\\npm\\claude.exe"),
      }),
      "C:\\bin\\claude.cmd",
    )
  })

  test("never searches the current directory", () => {
    assert.equal(resolveWindowsCommand("claude", { env, isFile: present("claude.exe") }), null)
  })

  test("ignores an empty PATH entry, which would mean the current directory", () => {
    assert.equal(
      resolveWindowsCommand("claude", {
        env: { PATH: ";C:\\npm", PATHEXT: env.PATHEXT },
        isFile: present("claude.cmd", "C:\\npm\\claude.cmd"),
      }),
      "C:\\npm\\claude.cmd",
    )
  })

  test("unquotes a quoted PATH entry", () => {
    assert.equal(
      resolveWindowsCommand("claude", {
        env: { PATH: '"C:\\Program Files\\npm"', PATHEXT: env.PATHEXT },
        isFile: present("C:\\Program Files\\npm\\claude.cmd"),
      }),
      "C:\\Program Files\\npm\\claude.cmd",
    )
  })

  test("a path with a separator is resolved as a path, not a PATH lookup", () => {
    assert.equal(
      resolveWindowsCommand("C:\\custom\\claude", { env, isFile: present("C:\\custom\\claude.cmd") }),
      "C:\\custom\\claude.cmd",
    )
    assert.equal(
      resolveWindowsCommand("C:/custom/claude.exe", { env, isFile: present("C:/custom/claude.exe") }),
      "C:/custom/claude.exe",
    )
  })

  test("an explicit extension that PATHEXT does not know still resolves as written", () => {
    assert.equal(
      resolveWindowsCommand("C:\\custom\\claude.ps1", { env, isFile: present("C:\\custom\\claude.ps1") }),
      "C:\\custom\\claude.ps1",
    )
  })

  test("returns null when nothing matches", () => {
    assert.equal(resolveWindowsCommand("claude", { env, isFile: () => false }), null)
  })
})

describe("planClaudeSpawn", () => {
  const env = { PATH: "C:\\npm", PATHEXT: DEFAULT_PATHEXT, ComSpec: "C:\\Windows\\System32\\cmd.exe" }

  test("changes nothing off Windows", () => {
    for (const platform of ["darwin", "linux", "freebsd"]) {
      const plan = planClaudeSpawn("/usr/local/bin/claude", ["--print", "a & b"], { platform })
      assert.equal(plan.file, "/usr/local/bin/claude")
      assert.deepEqual(plan.args, ["--print", "a & b"])
      assert.equal(plan.windowsVerbatimArguments, undefined)
    }
  })

  test("runs a .exe directly, with no cmd.exe and no verbatim arguments", () => {
    const plan = planClaudeSpawn("claude", ["--print", "a & b"], {
      platform: "win32",
      env,
      isFile: (candidate) => candidate === "C:\\npm\\claude.exe",
    })
    assert.equal(plan.file, "C:\\npm\\claude.exe")
    assert.deepEqual(plan.args, ["--print", "a & b"])
    assert.equal(plan.windowsVerbatimArguments, undefined)
  })

  test("routes a .cmd shim through cmd.exe with quoted arguments", () => {
    const plan = planClaudeSpawn("claude", ["--print", "a & b"], {
      platform: "win32",
      env,
      isFile: (candidate) => candidate === "C:\\npm\\claude.cmd",
    })
    assert.equal(plan.file, "C:\\Windows\\System32\\cmd.exe")
    assert.equal(plan.windowsVerbatimArguments, true)
    assert.deepEqual(throughBatchShim(plan.args[3]), ["--print", "a & b"])
  })

  test("an unresolvable command is passed through so the spawn fails honestly", () => {
    const plan = planClaudeSpawn("claude", ["--version"], {
      platform: "win32",
      env,
      isFile: () => false,
    })
    assert.equal(plan.file, "claude")
    assert.deepEqual(plan.args, ["--version"])
  })

  test("copies the argument array rather than aliasing the caller's", () => {
    const args = ["--version"]
    const plan = planClaudeSpawn("/usr/local/bin/claude", args, { platform: "darwin" })
    plan.args.push("--mutated")
    assert.deepEqual(args, ["--version"])
  })
})

// ---------------------------------------------------------------------------
// The proof. Everything above models what Windows does; this runs it.
// ---------------------------------------------------------------------------

describe("a real .cmd shim on Windows", { skip: isWindows ? false : "Windows only" }, () => {
  /**
   * A batch shim shaped like the one npm installs for `claude`: it forwards
   * `%*` to a node script, which prints its own argv back as JSON. The
   * directory name has a space in it on purpose.
   */
  function makeShim(): { dir: string; shim: string } {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "win spawn "))
    fs.writeFileSync(
      path.join(dir, "argv.cjs"),
      "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n",
      "utf8",
    )
    const shim = path.join(dir, "claude.cmd")
    fs.writeFileSync(shim, '@echo off\r\nnode "%~dp0argv.cjs" %*\r\n', "utf8")
    return { dir, shim }
  }

  function runThroughShim(shim: string, args: string[], cwd: string): string[] {
    const plan = planClaudeSpawn(shim, args)
    const result = spawnSync(plan.file, plan.args, {
      cwd,
      encoding: "utf8",
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, `shim failed: ${result.stderr}`)
    return JSON.parse(result.stdout) as string[]
  }

  test("every argument arrives byte-identical", () => {
    const { dir, shim } = makeShim()
    try {
      // `%` is excluded and measured on its own below; a newline cannot be in
      // a Windows path (NTFS rejects control characters) and cmd.exe ends the
      // command line at one, so neither is a case this can prove.
      const values = ADVERSARIAL.filter(
        (entry) => !entry.value.includes("%") && !entry.value.includes("\n"),
      ).map((entry) => entry.value)
      assert.deepEqual(runThroughShim(shim, values, dir), values)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("one argument at a time, so a failure names itself", () => {
    const { dir, shim } = makeShim()
    try {
      for (const { name, value } of ADVERSARIAL) {
        if (value.includes("%") || value.includes("\n")) continue
        assert.deepEqual(runThroughShim(shim, [value], dir), [value], name)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an injection attempt runs nothing", () => {
    const { dir, shim } = makeShim()
    try {
      const attempts = [
        "x & echo pwned > pwned.txt",
        "x && echo pwned > pwned.txt",
        // This one is the whole reason the quoting is not caret-based: it got
        // through the caret version, on this runner, and created the file.
        'x" & echo pwned > pwned.txt & "',
        'x"" & echo pwned > pwned.txt & ""',
        "x | findstr /v . > pwned.txt",
        "x\" ^& echo pwned > pwned.txt ^& \"",
        "(x) & echo pwned > pwned.txt",
        "%COMSPEC% /c echo pwned > pwned.txt",
      ]
      for (const attempt of attempts) {
        const plan = planClaudeSpawn(shim, [attempt])
        spawnSync(plan.file, plan.args, {
          cwd: dir,
          encoding: "utf8",
          windowsVerbatimArguments: plan.windowsVerbatimArguments,
        })
        assert.equal(fs.existsSync(path.join(dir, "pwned.txt")), false, attempt)
      }
      // A CR/LF cannot be carried at all, so it is refused rather than
      // truncated into whatever cmd would make of the remainder.
      assert.throws(() => planClaudeSpawn(shim, ["x\r\necho pwned > pwned.txt"]), /newline/)
      assert.equal(fs.existsSync(path.join(dir, "pwned.txt")), false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("resolves a .cmd shim off PATH, with a space in the directory", () => {
    const { dir, shim } = makeShim()
    try {
      const plan = planClaudeSpawn("claude", ["--version"], {
        env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` },
      })
      assert.equal(plan.windowsVerbatimArguments, true)
      assert.ok(plan.args[3].includes(path.basename(shim)), plan.args[3])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a `%` argument is lossy but never a second command", () => {
    const { dir, shim } = makeShim()
    try {
      const delivered = runThroughShim(shim, ["%PATH%", "%NOT_A_REAL_VARIABLE_12345%", "100%"], dir)
      // This is the whole guarantee: expansion may change a value, and can
      // never split it, add one, or start a command.
      assert.equal(delivered.length, 3, "percent expansion must not split or add arguments")
      assert.equal(fs.existsSync(path.join(dir, "pwned.txt")), false)
      // A name that does not exist is left alone by cmd, on both passes, so
      // these two are not lossy and are pinned as a regression guard.
      assert.equal(delivered[1], "%NOT_A_REAL_VARIABLE_12345%")
      assert.equal(delivered[2], "100%")
      // `%PATH%` does exist, so it is the lossy case the docs warn about.
      assert.notEqual(delivered[0], "")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
