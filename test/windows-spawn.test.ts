import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  DEFAULT_PATHEXT,
  escapeCmdArgument,
  escapeCmdCommand,
  executableExtensions,
  isBatchFile,
  planClaudeSpawn,
  planCmdInvocation,
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
 * cmd.exe's caret phase, as it applies to what this module builds: because
 * every quote in our command line is itself caret-escaped, cmd never enters
 * its quoted state, so a caret always escapes exactly the next character.
 */
function stripCarets(line: string): string {
  let out = ""
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "^" && index + 1 < line.length) {
      out += line[index + 1]
      index += 1
      continue
    }
    out += line[index]
  }
  return out
}

/** `cmd /s /c "<line>"`: strip exactly the outer pair of quotes. */
function stripOuterQuotes(arg: string): string {
  assert.ok(arg.startsWith('"') && arg.endsWith('"'), "the /c payload is quoted")
  return arg.slice(1, -1)
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

describe("escapeCmdArgument", () => {
  test("carets every character cmd.exe treats specially", () => {
    for (const char of ["(", ")", "[", "]", "%", "!", "^", '"', "`", "<", ">", "&", "|", ";", ",", " ", "*", "?"]) {
      const escaped = escapeCmdArgument(`a${char}b`)
      assert.ok(escaped.includes(`^${char}`), `${char} is caret-escaped, got ${escaped}`)
    }
  })

  test("leaves nothing for cmd to parse as a command separator", () => {
    const escaped = escapeCmdArgument("a & echo pwned")
    // Every `&` in the output is preceded by a caret.
    for (let index = 0; index < escaped.length; index += 1) {
      if (escaped[index] === "&") assert.equal(escaped[index - 1], "^")
    }
  })

  test("doubleEscape adds exactly one more layer", () => {
    const once = escapeCmdArgument("a&b")
    const twice = escapeCmdArgument("a&b", true)
    assert.equal(twice, once.replace(/([()\][%!^"`<>&|;, *?])/g, "^$1"))
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

  test("the whole command line survives cmd.exe's parsing, argument for argument", () => {
    // The parts of the pipeline that are deterministic: cmd strips the outer
    // quotes (/s), removes the carets, and the target program's own CRT parses
    // what is left with CommandLineToArgvW. Two phases are deliberately not
    // modelled: `%` expansion, and cmd's own parsing of the command token
    // (which honours `^ ` as a literal space, where CommandLineToArgvW would
    // split). So this uses a space-free command path and a `%`-free argument
    // set; both of the unmodelled phases are measured live on Windows below.
    const values = ADVERSARIAL.filter((entry) => !entry.value.includes("%")).map((entry) => entry.value)
    const plan = planCmdInvocation("C:\\npm\\claude.cmd", values, env)
    const line = stripCarets(stripOuterQuotes(plan.args[3]))
    assert.deepEqual(parseCommandLineToArgv(line), ["C:\\npm\\claude.cmd", ...values])
  })
})

describe("escapeCmdCommand", () => {
  test("carets a path's spaces rather than quoting it", () => {
    assert.equal(escapeCmdCommand("C:\\Program Files\\claude.cmd"), "C:\\Program^ Files\\claude.cmd")
  })

  test("normalizes to Windows separators", () => {
    assert.equal(escapeCmdCommand("C:/npm/claude.cmd"), "C:\\npm\\claude.cmd")
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

  test("routes a .cmd shim through cmd.exe with escaped arguments", () => {
    const plan = planClaudeSpawn("claude", ["--print", "a & b"], {
      platform: "win32",
      env,
      isFile: (candidate) => candidate === "C:\\npm\\claude.cmd",
    })
    assert.equal(plan.file, "C:\\Windows\\System32\\cmd.exe")
    assert.equal(plan.windowsVerbatimArguments, true)
    assert.ok(!plan.args[3].includes(" & "), "the bare `&` is gone")
    const line = stripCarets(stripOuterQuotes(plan.args[3]))
    assert.deepEqual(parseCommandLineToArgv(line), ["C:\\npm\\claude.cmd", "--print", "a & b"])
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
        'x" & echo pwned > pwned.txt & "',
        "x | findstr /v . > pwned.txt",
        "x\r\necho pwned > pwned.txt",
      ]
      for (const attempt of attempts) {
        // A CR/LF argument is not something cmd.exe can carry; it is here to
        // prove it does not become a second command either.
        const plan = planClaudeSpawn(shim, [attempt])
        spawnSync(plan.file, plan.args, {
          cwd: dir,
          encoding: "utf8",
          windowsVerbatimArguments: plan.windowsVerbatimArguments,
        })
        assert.equal(fs.existsSync(path.join(dir, "pwned.txt")), false, attempt)
      }
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
      const delivered = runThroughShim(shim, ["%PATH%", "%NOT_A_REAL_VARIABLE_12345%"], dir)
      assert.equal(delivered.length, 2, "percent expansion must not split or add arguments")
      // Pinned from the Windows CI run: `^%` breaks the variable-name lookup
      // at cmd's command-line level, and the shim's `%*` does not re-expand a
      // value it substituted, so both arrive literal. This assertion exists to
      // catch a future cmd.exe or shim shape where that stops being true; the
      // guarantee the module documents is only the line above.
      assert.deepEqual(delivered, ["%PATH%", "%NOT_A_REAL_VARIABLE_12345%"])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
