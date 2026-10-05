/**
 * The interactive transport against a scripted TUI.
 *
 * `ClaudeSession` takes a `spawnPty` seam, so everything above the PTY (boot,
 * paste and submit, the transcript tail, the screen reader, Esc interrupts,
 * the heartbeat, `--resume`) runs unmodified here under Node. `FakeTui` plays
 * the CLI's part: it writes transcript records where the real TUI writes them
 * (the prompt record on Enter, an interrupt marker on Esc) and draws the
 * screens the session has to answer.
 *
 * None of this replaces a live run: `test/e2e-claude-session-bun.ts` under
 * Bun against a logged-in `claude` is still the proof that the TUI behaves
 * the way these scripts say it does.
 */
import assert from "node:assert/strict"
import { once } from "node:events"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import {
  ClaudeSession,
  classifyScreen,
  highlightedChoice,
  interactiveTranscriptPath,
  isInterruptRecord,
  isTurnDurationRecord,
  stripTerminal,
  type ClaudeSessionOptions,
  type PtySpawner,
  type ScreenEvent,
} from "../src/claude-session-bun.js"
import {
  OpenToolCalls,
  carriesReplyText,
  heartbeatFrame,
  interactiveResultFrame,
  spawnInteractiveProcess,
} from "../src/claude-session-wrapper.js"
import { describeResultFailure, parseToolProgress } from "../src/cli-events.js"
import {
  deleteActiveProcess,
  getActiveProcess,
  getClaudeSessionId,
  interruptTurn,
  isTurnInFlight,
  noteInteractiveProcessExit,
  setActiveProcess,
  setClaudeSessionId,
} from "../src/session-manager.js"
import { armStartWatchdog } from "../src/turn-controller.js"

// ---------------------------------------------------------------------------
// The scripted TUI.
// ---------------------------------------------------------------------------

const USAGE = { input_tokens: 3, cache_read_input_tokens: 100, output_tokens: 7 }

function userRecord(text: string): any {
  return { type: "user", message: { role: "user", content: text } }
}

function assistantRecord(id: string, stopReason: string, block: any): any {
  return {
    type: "assistant",
    message: { id, role: "assistant", stop_reason: stopReason, content: [block], usage: USAGE },
  }
}

const textBlock = (text: string) => ({ type: "text", text })
const toolBlock = (id: string, name: string) => ({ type: "tool_use", id, name, input: {} })

type TurnScript = (tui: FakeTui) => void

class FakeTui {
  argv: string[] = []
  writes: string[] = []
  /** Where a child with no `CLAUDE_CONFIG_DIR` keeps its transcripts. */
  configDir?: string
  transcript = ""
  /** One script per submitted prompt, in order. */
  turns: TurnScript[] = []
  /** What Esc does. Default: the TUI's own interrupt marker. */
  onEsc: (tui: FakeTui) => void = (tui) =>
    tui.append(userRecord("[Request interrupted by user]"))
  /** Drawn the moment the child starts. */
  bootScreen = ""
  exitCode: number | null | undefined = undefined
  private draw: (text: string) => void = () => {}
  private resolveExit: (code: number | null) => void = () => {}
  private pasted = false
  private submitted = 0
  private timers: ReturnType<typeof setTimeout>[] = []

  readonly spawner: PtySpawner = (argv, opts) => {
    this.argv = argv
    const at = (flag: string) => {
      const index = argv.indexOf(flag)
      return index >= 0 ? argv[index + 1] : undefined
    }
    this.transcript = interactiveTranscriptPath({
      configDir: opts.env.CLAUDE_CONFIG_DIR ?? this.configDir,
      cwd: opts.cwd,
      sessionId: (at("--resume") ?? at("--session-id"))!,
    })
    fs.mkdirSync(path.dirname(this.transcript), { recursive: true })
    if (!fs.existsSync(this.transcript)) fs.writeFileSync(this.transcript, "")
    this.draw = opts.onData
    const exited = new Promise<number | null>((resolve) => (this.resolveExit = resolve))
    if (this.bootScreen) this.later(5, () => this.draw(this.bootScreen))
    return {
      exited,
      kill: () => this.exit(null),
      terminal: {
        write: (data: string) => this.onWrite(data),
        close: () => {},
      },
    }
  }

  onWrite(data: string): void {
    this.writes.push(data)
    if (data.startsWith("\x1b[200~")) {
      this.pasted = true
      return
    }
    if (data === "\r" && this.pasted) {
      this.pasted = false
      this.append(userRecord(`prompt ${this.submitted + 1}`))
      this.turns[this.submitted++]?.(this)
      return
    }
    if (data === "\x1b") this.onEsc(this)
  }

  append(...records: any[]): void {
    fs.appendFileSync(this.transcript, records.map((r) => JSON.stringify(r) + "\n").join(""))
  }

  screen(text: string): void {
    this.draw(text)
  }

  later(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms))
  }

  exit(code: number | null): void {
    for (const timer of this.timers) clearTimeout(timer)
    if (this.exitCode !== undefined) return
    this.exitCode = code
    this.resolveExit(code)
  }

  get escCount(): number {
    return this.writes.filter((w) => w === "\x1b").length
  }
}

/** Every delay short enough that a whole scripted turn takes milliseconds. */
const FAST = {
  bootMinMs: 0,
  bootQuietMs: 10,
  bootMaxMs: 3_000,
  pollMs: 5,
  submitMinMs: 0,
  submitConfirmMs: 100,
  stopSettleMs: 30,
  heartbeatMs: 40,
  interruptGraceMs: 150,
  permissionQuietMs: 15,
} satisfies Partial<ClaudeSessionOptions>

function scratch(): { cwd: string; configDir: string; cleanup: () => void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccp-pty-")))
  const cwd = path.join(root, "work")
  fs.mkdirSync(cwd)
  return {
    cwd,
    configDir: path.join(root, "config"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

async function withSession(
  tui: FakeTui,
  fn: (session: ClaudeSession) => Promise<void>,
  extra: Partial<ClaudeSessionOptions> = {},
): Promise<void> {
  const dirs = scratch()
  const session = new ClaudeSession({
    ...FAST,
    cwd: dirs.cwd,
    configDir: dirs.configDir,
    env: {},
    spawnPty: tui.spawner,
    ...extra,
  })
  try {
    await fn(session)
  } finally {
    session.dispose()
    dirs.cleanup()
  }
}

async function waitFor(check: () => boolean, ms = 2_000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error("condition not met in time")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

// ---------------------------------------------------------------------------
// Pure pieces.
// ---------------------------------------------------------------------------

test("stripTerminal turns cursor-forward into spaces and drops escapes", () => {
  assert.equal(stripTerminal("Do\x1b[1Cyou\x1b[2Ctrust\x1b[0m"), "Do you trust")
  assert.equal(stripTerminal("\x1b]0;title\x07ready"), "ready")
})

test("classifyScreen recognises the screens the TUI blocks on", () => {
  assert.equal(classifyScreen("Do you trust the files in this folder?")?.kind, "trust")
  assert.equal(classifyScreen("Please run /login")?.kind, "login")
  assert.equal(
    classifyScreen("Bash command\n echo hi\nDo you want to proceed?\n❯ 1. Yes\n  2. No")?.kind,
    "permission",
  )
  assert.equal(
    classifyScreen("Usage limit reached · continuing automatically at 4:20am · esc to cancel")
      ?.kind,
    "auto-continue",
  )
})

test("classifyScreen does not take a reply's own question for a dialog", () => {
  // The dialog always numbers its options; prose that asks the same thing
  // must never be answered with Esc.
  assert.equal(classifyScreen("I can refactor this next. Do you want to proceed?"), null)
  assert.equal(classifyScreen("plain reply text"), null)
})

test("interrupt and turn_duration records are recognised in both content shapes", () => {
  assert.ok(isInterruptRecord(userRecord("[Request interrupted by user]")))
  assert.ok(
    isInterruptRecord({
      type: "user",
      message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] },
    }),
  )
  assert.ok(!isInterruptRecord(userRecord("please interrupt nothing")))
  assert.ok(isTurnDurationRecord({ type: "system", subtype: "turn_duration", durationMs: 1 }))
  assert.ok(!isTurnDurationRecord({ type: "system", subtype: "init" }))
})

test("a heartbeat while a tool is open is a tool_progress the parser reads as that tool", () => {
  const calls = new OpenToolCalls()
  calls.add(assistantRecord("m1", "tool_use", toolBlock("toolu_1", "Bash")), 1_000)
  const frame = JSON.parse(heartbeatFrame("sess", calls.newest(), 31_000))
  const progress = parseToolProgress(frame)
  assert.equal(progress?.toolUseId, "toolu_1")
  assert.equal(progress?.toolName, "Bash")
  assert.equal(progress?.elapsedSeconds, 30)
  assert.equal(progress?.heartbeat, true)

  calls.add({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1" }] } })
  assert.equal(calls.newest(), null)
  assert.equal(JSON.parse(heartbeatFrame("sess", null)).type, "system")
})

test("the synthesized result is a success only on a terminal stop", () => {
  const done = JSON.parse(
    interactiveResultFrame({ sessionId: "s", end: "stop", stopReason: "end_turn" }),
  )
  assert.equal(describeResultFailure(done), null)
  assert.equal(done.session_id, "s")

  for (const end of ["interrupted", "ended", "failed"] as const) {
    const frame = JSON.parse(interactiveResultFrame({ sessionId: "s", end, stopReason: null }))
    assert.equal(frame.is_error, true, end)
    assert.ok(describeResultFailure(frame), end)
  }
  const denied = JSON.parse(
    interactiveResultFrame({
      end: "stop",
      stopReason: "end_turn",
      denials: [{ tool_name: "Bash", tool_use_id: "toolu_1" }],
    }),
  )
  assert.deepEqual(denied.permission_denials, [{ tool_name: "Bash", tool_use_id: "toolu_1" }])
  assert.equal(denied.session_id, undefined)
})

// ---------------------------------------------------------------------------
// ClaudeSession over the scripted TUI.
// ---------------------------------------------------------------------------

test("a turn waits for the last record of its final call", async () => {
  // One call, two records, both carrying `end_turn`; the reply text is the
  // second. Ending on the first dropped the answer.
  const tui = new FakeTui()
  tui.turns.push((t) => {
    t.append(assistantRecord("m1", "end_turn", { type: "thinking", thinking: "" }))
    t.later(15, () => t.append(assistantRecord("m1", "end_turn", textBlock("the answer"))))
  })
  await withSession(tui, async (session) => {
    await session.start()
    const lines: string[] = []
    const result = await session.tailTurn("hi", (raw) => lines.push(raw))
    assert.equal(result.end, "stop")
    assert.equal(result.stopReason, "end_turn")
    assert.ok(lines.some((line) => line.includes("the answer")))
    assert.equal(result.callCount, 1)
  })
})

test("a terminal stop followed by more work is not the end of the turn", async () => {
  // A Stop hook can send the model on after `end_turn`.
  const tui = new FakeTui()
  tui.turns.push((t) => {
    t.append(assistantRecord("m1", "end_turn", textBlock("first")))
    t.later(10, () => t.append(assistantRecord("m2", "tool_use", toolBlock("toolu_9", "Read"))))
    t.later(60, () => t.append(assistantRecord("m3", "end_turn", textBlock("second"))))
  }, () => {})
  await withSession(
    tui,
    async (session) => {
      await session.start()
      const lines: string[] = []
      const result = await session.tailTurn("hi", (raw) => lines.push(raw))
      assert.equal(result.end, "stop")
      assert.ok(lines.some((line) => line.includes("second")))
      assert.equal(result.callCount, 3)
    },
    { stopSettleMs: 30 },
  )
})

test("turn_duration ends a turn that never wrote a terminal stop", async () => {
  const tui = new FakeTui()
  tui.turns.push((t) => t.later(10, () => t.append({ type: "system", subtype: "turn_duration" })))
  await withSession(tui, async (session) => {
    await session.start()
    const result = await session.tailTurn("hi", () => {})
    assert.equal(result.end, "ended")
    assert.equal(result.stopReason, null)
  })
})

test("records left over from the previous turn never end the next one", async () => {
  const tui = new FakeTui()
  tui.turns.push((t) => {
    t.append(assistantRecord("m1", "end_turn", textBlock("one")))
    // Written after the first turn already ended.
    t.later(80, () => t.append({ type: "system", subtype: "turn_duration" }))
  })
  tui.turns.push((t) => t.later(20, () => t.append(assistantRecord("m2", "end_turn", textBlock("two")))))
  await withSession(tui, async (session) => {
    await session.start()
    await session.tailTurn("one", () => {})
    await new Promise((resolve) => setTimeout(resolve, 120))
    const lines: string[] = []
    const second = await session.tailTurn("two", (raw) => lines.push(raw))
    assert.equal(second.end, "stop")
    assert.ok(lines.some((line) => line.includes('"two"')))
    assert.ok(!lines.some((line) => line.includes("turn_duration")))
  })
})

test("Esc interrupts a running turn and the session takes the next one", async () => {
  const tui = new FakeTui()
  tui.turns.push((t) => t.append(assistantRecord("m1", "tool_use", toolBlock("toolu_1", "Bash"))))
  tui.turns.push((t) => t.append(assistantRecord("m2", "end_turn", textBlock("after"))))
  await withSession(tui, async (session) => {
    await session.start()
    const turn = session.tailTurn("long", () => {})
    await waitFor(() => session.turnRunning && tui.transcript !== "" && fs.readFileSync(tui.transcript, "utf8").includes("toolu_1"))
    assert.equal(await session.interrupt(), true)
    const result = await turn
    assert.equal(result.end, "interrupted")
    assert.equal(session.turnRunning, false)
    assert.equal(session.hasExited, false)

    const next = await session.tailTurn("again", () => {})
    assert.equal(next.end, "stop")
  })
})

test("an interrupt the TUI never acknowledges abandons the turn instead of hanging", async () => {
  const tui = new FakeTui()
  tui.onEsc = () => {}
  tui.turns.push(() => {})
  await withSession(tui, async (session) => {
    await session.start()
    const turn = session.tailTurn("stuck", () => {})
    await waitFor(() => session.turnRunning)
    const started = Date.now()
    assert.equal(await session.interrupt(50), false)
    const result = await turn
    assert.equal(result.end, "interrupted")
    assert.ok(Date.now() - started < 1_000)
    assert.equal(tui.escCount, 2)
  })
})

test("a permission dialog is denied with Esc and reported", async () => {
  const tui = new FakeTui()
  const screens: ScreenEvent[] = []
  tui.onEsc = (t) => t.append(userRecord("[Request interrupted by user for tool use]"))
  tui.turns.push((t) => {
    t.append(assistantRecord("m1", "tool_use", toolBlock("toolu_1", "Write")))
    t.later(10, () =>
      t.screen("Create file\n x.txt\nDo you want to create x.txt?\n❯ 1. Yes\n  2. No"),
    )
  })
  await withSession(
    tui,
    async (session) => {
      await session.start()
      const result = await session.tailTurn("write it", () => {})
      assert.equal(result.end, "interrupted")
      assert.equal(result.denied.length, 1)
      assert.equal(result.denied[0]!.kind, "permission")
      assert.ok(screens.some((s) => s.kind === "permission" && s.action === "denied"))
    },
    { onScreen: (event) => screens.push(event) },
  )
})

/** The 2.1.288 dialog, which marks "No, exit" until the cursor moves. */
const TRUST_SCREEN =
  "Accessing workspace: /tmp/x\nQuick safety check: Is this a project you created or one you trust?\n"

test("highlightedChoice reads the newest marked choice", () => {
  assert.equal(highlightedChoice("❯ No, exit\n  Yes, I trust this folder"), "no")
  assert.equal(
    highlightedChoice("❯ No, exit\n  Yes, I trust\n  No, exit\n❯ Yes, I trust this folder"),
    "yes",
  )
  assert.equal(highlightedChoice("❯ 1. Yes, I trust this folder"), "yes")
  assert.equal(highlightedChoice("Is this a project you trust?"), null)
})

test("the folder trust dialog is accepted at boot, never by pressing Enter on No", async () => {
  // Measured on 2.1.288: Enter on the default choice exits the CLI with 1.
  const tui = new FakeTui()
  tui.bootScreen = `${TRUST_SCREEN}❯ No, exit\n  Yes, I trust this folder\nEnter to confirm`
  const realWrite = (tui as any).onWrite.bind(tui)
  ;(tui as any).onWrite = (data: string) => {
    realWrite(data)
    if (data === "\x1b[B") tui.later(5, () => tui.screen("  No, exit\n❯ Yes, I trust this folder"))
    if (data === "\r" && tui.writes.indexOf("\x1b[B") < 0) tui.exit(1)
  }
  const screens: ScreenEvent[] = []
  await withSession(
    tui,
    async (session) => {
      await session.start()
      const down = tui.writes.indexOf("\x1b[B")
      assert.ok(down >= 0, "moved off No")
      assert.ok(tui.writes.indexOf("\r") > down, "confirmed only after the move")
      assert.equal(session.hasExited, false)
      assert.deepEqual(
        screens.map((s) => [s.kind, s.action]),
        [["trust", "accepted"]],
      )
    },
    { onScreen: (event) => screens.push(event) },
  )
})

test("a trust dialog that already marks Yes is confirmed directly", async () => {
  const tui = new FakeTui()
  tui.bootScreen = "Do you trust the files in this folder?\n❯ 1. Yes, I trust this folder\n  2. No"
  await withSession(tui, async (session) => {
    await session.start()
    assert.ok(tui.writes.includes("\r"))
    assert.ok(!tui.writes.includes("\x1b[B"))
  })
})

test("a trust dialog that cannot be answered fails boot instead of eating the prompt", async () => {
  const tui = new FakeTui()
  tui.bootScreen = `${TRUST_SCREEN}❯ No, exit\n  Yes, I trust this folder`
  // The cursor never moves.
  ;(tui as any).onWrite = (data: string) => {
    tui.writes.push(data)
    if (data === "\x1b[B") tui.later(5, () => tui.screen("❯ No, exit"))
  }
  await withSession(tui, async (session) => {
    await assert.rejects(session.start(), /folder trust dialog/)
  })
})

test("a login screen at boot fails the start with something the operator can act on", async () => {
  const tui = new FakeTui()
  tui.bootScreen = "Select login method:\n❯ 1. Claude account"
  await withSession(tui, async (session) => {
    await assert.rejects(session.start(), /not logged in/)
    assert.equal(tui.exitCode, null)
  })
})

test("a heartbeat fires while the TUI is drawing and the transcript is quiet", async () => {
  const tui = new FakeTui()
  tui.turns.push((t) => {
    t.append(assistantRecord("m1", "tool_use", toolBlock("toolu_1", "Bash")))
    for (let ms = 10; ms < 200; ms += 10) t.later(ms, () => t.screen("✻ Running…"))
    t.later(200, () => t.append(assistantRecord("m2", "end_turn", textBlock("done"))))
  })
  await withSession(tui, async (session) => {
    await session.start()
    let beats = 0
    const result = await session.tailTurn("go", () => {}, undefined, () => beats++)
    assert.equal(result.end, "stop")
    assert.ok(beats >= 2, `expected heartbeats, got ${beats}`)
  })
})

test("CLAUDE_CONFIG_DIR reaches the child only when a config dir was configured", async () => {
  // Measured on 2.1.288: setting it, even to the default ~/.claude, makes the
  // CLI report itself logged out.
  const seen: Array<string | undefined> = []
  const dirs = scratch()
  try {
    for (const configDir of [undefined, dirs.configDir]) {
      const tui = new FakeTui()
      tui.configDir = dirs.configDir
      const spawner: PtySpawner = (argv, opts) => {
        seen.push(opts.env.CLAUDE_CONFIG_DIR)
        return tui.spawner(argv, opts)
      }
      const session = new ClaudeSession({
        ...FAST,
        cwd: dirs.cwd,
        configDir,
        env: { CLAUDE_CONFIG_DIR: undefined },
        spawnPty: spawner,
      })
      await session.start()
      session.dispose()
    }
    assert.deepEqual(seen, [undefined, dirs.configDir])
  } finally {
    dirs.cleanup()
  }
})

test("a resumed session spawns with --resume and keeps its id", async () => {
  const tui = new FakeTui()
  await withSession(
    tui,
    async (session) => {
      assert.equal(session.sessionId, "11111111-2222-3333-4444-555555555555")
      await session.start()
      assert.deepEqual(tui.argv.slice(1, 3), ["--resume", "11111111-2222-3333-4444-555555555555"])
      assert.ok(!tui.argv.includes("--session-id"))
    },
    { resumeSessionId: "11111111-2222-3333-4444-555555555555" },
  )
})

// ---------------------------------------------------------------------------
// The ActiveProcess shim.
// ---------------------------------------------------------------------------

function spawnShim(tui: FakeTui, dirs: { cwd: string; configDir: string }) {
  const ap = spawnInteractiveProcess({
    cwd: dirs.cwd,
    configDir: dirs.configDir,
    env: {},
    spawnPty: tui.spawner,
    tuning: FAST,
  })
  const lines: any[] = []
  ap.lineEmitter.on("line", (raw: string) => lines.push(JSON.parse(raw)))
  const write = (text: string) =>
    (ap.proc.stdin as any).write(
      JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n",
    )
  return { ap, lines, write, results: () => lines.filter((line) => line.type === "result") }
}

test("the shim forwards records, then a success result, and reports exit like a child", async () => {
  const dirs = scratch()
  const tui = new FakeTui()
  tui.turns.push((t) => t.append(assistantRecord("m1", "end_turn", textBlock("hello"))))
  try {
    const { ap, lines, write, results } = spawnShim(tui, dirs)
    const proc = ap.proc as any
    assert.equal(proc.exitCode, null)
    assert.equal(ap.interactiveControl?.turnRunning(), false)
    write("hi")
    assert.equal(isTurnInFlight(ap), true)
    await waitFor(() => results().length === 1)
    assert.ok(lines.some((line) => line.type === "assistant"))
    assert.equal(results()[0].subtype, "success")
    assert.equal(isTurnInFlight(ap), false)

    const exited = once(proc, "exit")
    proc.kill()
    await exited
    assert.ok(proc.exitCode !== null || proc.signalCode !== null)
  } finally {
    dirs.cleanup()
  }
})

test("killing a shim that never started still reports an exit", async () => {
  const dirs = scratch()
  try {
    const { ap } = spawnShim(new FakeTui(), dirs)
    const exited = once(ap.proc as any, "exit")
    ap.proc.kill()
    await exited
    assert.equal((ap.proc as any).signalCode, "SIGTERM")
  } finally {
    dirs.cleanup()
  }
})

test("an aborted turn is interrupted with Esc, and its queued successor is dropped", async () => {
  const dirs = scratch()
  const tui = new FakeTui()
  tui.turns.push((t) => t.append(assistantRecord("m1", "tool_use", toolBlock("toolu_1", "Bash"))))
  tui.turns.push((t) => t.append(assistantRecord("m3", "end_turn", textBlock("third"))))
  try {
    const { ap, write, results } = spawnShim(tui, dirs)
    write("first")
    await waitFor(() => fs.existsSync(tui.transcript) && fs.readFileSync(tui.transcript, "utf8").includes("toolu_1"))
    // A second write from the same aborted turn (an auto-continue, say)
    // queues behind the first; the interrupt covers both.
    write("second")
    assert.equal(await interruptTurn(ap, 1_000), true)
    await waitFor(() => !ap.interactiveControl!.turnRunning())
    // The first turn was superseded by the second write, and the second
    // never ran, so no result reached a listener.
    assert.equal(results().length, 0)

    write("third")
    await waitFor(() => results().length === 1)
    assert.equal(results()[0].subtype, "success")
    ap.proc.kill()
  } finally {
    dirs.cleanup()
  }
})

test("a turn superseded by a newer write keeps its result off the newer turn", async () => {
  const dirs = scratch()
  const tui = new FakeTui()
  tui.turns.push((t) => t.later(20, () => t.append(assistantRecord("m1", "end_turn", textBlock("old")))))
  tui.turns.push((t) => t.append(assistantRecord("m2", "end_turn", textBlock("new"))))
  try {
    const { ap, lines, write, results } = spawnShim(tui, dirs)
    write("old")
    write("new")
    await waitFor(() => results().length === 1)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(results().length, 1)
    assert.ok(lines.some((line) => JSON.stringify(line).includes('"new"')))
    assert.ok(!lines.some((line) => JSON.stringify(line).includes('"old"')))
    ap.proc.kill()
  } finally {
    dirs.cleanup()
  }
})

test("a TUI that dies between turns stops being reused, and keeps its session id for --resume", () => {
  const key = "interactive-exit-test"
  const ap = { proc: {}, lineEmitter: {} } as any
  setActiveProcess(key, ap)
  setClaudeSessionId(key, "sess-1")
  noteInteractiveProcessExit(key, { ...ap }, 1)
  assert.equal(getActiveProcess(key), ap, "another process object never clears the key")
  noteInteractiveProcessExit(key, ap, null)
  assert.equal(getActiveProcess(key), undefined)
  assert.equal(getClaudeSessionId(key), "sess-1")

  setActiveProcess(key, ap)
  noteInteractiveProcessExit(key, ap, 1)
  assert.equal(getClaudeSessionId(key), undefined, "a failed child does not resume")
  deleteActiveProcess(key)
})

test("the start watchdog waits on an interactive turn instead of respawning it", async () => {
  let running = true
  const state: any = {
    startWatchdog: null,
    startWatchdogMs: 10,
    controllerClosed: false,
    hasReceivedContent: false,
    hasReceivedProgress: false,
    activeProcess: { interactiveControl: { turnRunning: () => running } },
  }
  armStartWatchdog(state)
  await new Promise((resolve) => setTimeout(resolve, 35))
  // Still re-arming, never respawned (a respawn would have thrown on the
  // missing lineEmitter and cliArgs).
  assert.ok(state.startWatchdog, "re-armed while the turn runs")
  running = false
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(state.startWatchdog, null)
})

// ---------------------------------------------------------------------------
// The proxy: a proxied call ends a step in the middle of a TUI turn.
// ---------------------------------------------------------------------------

test("flushTranscript hands the running turn what the TUI already wrote", async () => {
  const tui = new FakeTui()
  // After the prompt is accepted, as the real TUI writes a reply: a proxied
  // call needs a whole API call first, so it can never beat the submit.
  tui.turns.push((t) => t.later(150, () => t.append(assistantRecord("m1", "tool_use", textBlock("led the call")))))
  await withSession(
    tui,
    async (session) => {
      await session.start()
      const lines: string[] = []
      const turn = session.tailTurn("go", (raw) => lines.push(raw))
      await waitFor(() => fs.existsSync(tui.transcript) && fs.readFileSync(tui.transcript, "utf8").includes("led the call"))
      // Synchronous: by the time it returns the record has reached the turn,
      // whichever of the flush and the poll got there first.
      session.flushTranscript()
      assert.ok(lines.some((line) => line.includes("led the call")))
      tui.append(assistantRecord("m2", "end_turn", textBlock("done")))
      const result = await turn
      assert.equal(result.end, "stop")
      // Read once, never twice.
      assert.equal(lines.filter((line) => line.includes("led the call")).length, 1)
    },
    // A slow poll, so the flush is what a waiting caller depends on.
    { pollMs: 200 },
  )
  // Between turns it reads nothing and throws nothing.
  await withSession(new FakeTui(), async (session) => {
    await session.start()
    session.flushTranscript()
  })
})

test("a detached shim keeps reply text and nothing else", async () => {
  const dirs = scratch()
  const tui = new FakeTui()
  tui.turns.push((t) => {
    t.append({ type: "attachment", attachment: { type: "hook" } })
    t.append(assistantRecord("m1", "end_turn", textBlock("said while nobody listened")))
  })
  try {
    // No `line` listener: the state between a proxied call ending a step and
    // the next step attaching.
    const ap = spawnInteractiveProcess({ cwd: dirs.cwd, configDir: dirs.configDir, env: {}, spawnPty: tui.spawner, tuning: FAST })
    ;(ap.proc.stdin as any).write(JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n")
    await waitFor(() => !ap.interactiveControl!.turnRunning())
    assert.equal(ap.unattendedLines?.length, 1)
    assert.match(ap.unattendedLines![0], /said while nobody listened/)
    ap.proc.kill()
  } finally {
    dirs.cleanup()
  }
})

test("carriesReplyText is true only for an assistant record with text", () => {
  assert.equal(carriesReplyText(JSON.stringify(assistantRecord("m", "end_turn", textBlock("hi")))), true)
  assert.equal(carriesReplyText(JSON.stringify(assistantRecord("m", "end_turn", textBlock("  ")))), false)
  assert.equal(carriesReplyText(JSON.stringify(assistantRecord("m", "tool_use", toolBlock("t", "Bash")))), false)
  assert.equal(carriesReplyText(heartbeatFrame("s", { id: "t", name: "Bash", startedAt: 0 }, 1_000)), false)
  assert.equal(carriesReplyText(JSON.stringify({ type: "attachment" })), false)
  assert.equal(carriesReplyText("not json"), false)
})

test("the shim owns its proxy server and closes it once", async () => {
  const dirs = scratch()
  let closed = 0
  const proxyServer = { close: async () => { closed++ } } as any
  try {
    const ap = spawnInteractiveProcess({ cwd: dirs.cwd, configDir: dirs.configDir, env: {}, spawnPty: new FakeTui().spawner, tuning: FAST, proxyServer })
    assert.equal(ap.proxyServer, proxyServer)
    const exited = once(ap.proc as any, "exit")
    ap.proc.kill()
    ap.proc.kill()
    await exited
    assert.equal(closed, 1)
  } finally {
    dirs.cleanup()
  }
})
