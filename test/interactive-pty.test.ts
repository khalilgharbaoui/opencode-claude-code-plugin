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
  planApprovalKeys,
  stripTerminal,
  type ClaudeSessionOptions,
  type PtySpawner,
  type ScreenEvent,
} from "../src/claude-session-bun.js"
import {
  OpenToolCalls,
  carriesReplyText,
  heartbeatFrame,
  interactiveExtraArgs,
  interactiveResultFrame,
  planApprovalAnswer,
  streamFrameFromRecord,
  spawnInteractiveProcess,
} from "../src/claude-session-wrapper.js"
import { REJECTED_EXIT_PLAN_MODE_PREFIX } from "../src/plan-mode-question.js"
import { describeResultFailure, parseToolProgress } from "../src/cli-events.js"
import {
  deleteActiveProcess,
  getActiveProcess,
  getClaudeSessionId,
  interruptTurn,
  isTurnInFlight,
  deleteActiveProcessAndWait,
  isIdleProcessEvictionScheduled,
  noteInteractiveProcessExit,
  scheduleIdleProcessEviction,
  setActiveProcess,
  setClaudeSessionId,
  sessionKey,
  deleteClaudeSessionId,
} from "../src/session-manager.js"
import { _resetForkFingerprints } from "../src/session-fork.js"
import { _resetAgentRegistryForTests, setProviderFallbackModels } from "../src/agent-models.js"
import { _resetAccountOverrides } from "../src/account-failover.js"
import { ensureAccountRuntime } from "../src/accounts.js"
import { setOpencodeClient } from "../src/runtime-status.js"
import { armStartWatchdog } from "../src/turn-controller.js"
import { createClaudeCode } from "../src/index.js"

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
  private pastedText = ""
  /** A fork's parent transcript, copied in ahead of the first prompt as the
   *  CLI does with `--fork-session`. */
  private forkSource: string | null = null
  private submitted = 0
  private timers: ReturnType<typeof setTimeout>[] = []

  readonly spawner: PtySpawner = (argv, opts) => {
    this.argv = argv
    const at = (flag: string) => {
      const index = argv.indexOf(flag)
      return index >= 0 ? argv[index + 1] : undefined
    }
    const configDir = opts.env.CLAUDE_CONFIG_DIR ?? this.configDir
    const forking = argv.includes("--fork-session")
    this.transcript = interactiveTranscriptPath({
      configDir,
      cwd: opts.cwd,
      sessionId: (forking ? at("--session-id") : (at("--resume") ?? at("--session-id")))!,
    })
    this.forkSource = forking
      ? interactiveTranscriptPath({ configDir, cwd: opts.cwd, sessionId: at("--resume")! })
      : null
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
      this.pastedText = data.slice("\x1b[200~".length, -"\x1b[201~".length)
      return
    }
    if (data === "\r" && this.pasted) {
      this.pasted = false
      if (this.forkSource && this.submitted === 0 && fs.existsSync(this.forkSource)) {
        fs.appendFileSync(this.transcript, fs.readFileSync(this.forkSource, "utf8"))
      }
      this.append(userRecord(this.pastedText))
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

function scratch(): { root: string; cwd: string; configDir: string; cleanup: () => void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccp-pty-")))
  const cwd = path.join(root, "work")
  fs.mkdirSync(cwd)
  return {
    root,
    cwd,
    configDir: path.join(root, "config"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

test("auto survives removed print flags on both hosts, including lean compaction", async () => {
  const previousBun = Object.getOwnPropertyDescriptor(globalThis, "Bun")
  const dirs = scratch()
  const cliPath = path.join(dirs.cwd, "no-print")
  fs.writeFileSync(cliPath, "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '2.1.288\\n'; exit 0; fi\nprintf \"error: unknown option '--print'\\n\" >&2\nexit 1\n", { mode: 0o755 })
  const children: FakeTui[] = []
  Object.defineProperty(globalThis, "Bun", { configurable: true, value: {
    Terminal: function Terminal() {},
    which: (command: string) => command,
    spawn: (argv: string[], options: {
      cwd: string; env: Record<string, string | undefined>
      terminal: { cols: number; rows: number; data: (terminal: unknown, data: Uint8Array) => void }
    }) => {
      const tui = new FakeTui()
      tui.turns = [(child) => child.append(assistantRecord("reply", "end_turn", textBlock("SUMMARY")))]
      children.push(tui)
      return tui.spawner(argv, { ...options, ...options.terminal,
        onData: (text) => options.terminal.data(undefined, Buffer.from(text)),
      })
    },
  } })
  try {
    // Automatic selection keeps the requested posture on the PTY (h #g201):
    // plan mode is the CLI's own, read-only is `--restricted` plus `dontAsk`
    // with nothing but read-only tools pre-approved.
    for (const [posture, expected] of [
      [{ permissionMode: "plan" as const }, { mode: "plan", restricted: false }],
      [{ permissionPreset: "read-only" as const }, { mode: "dontAsk", restricted: true }],
    ] as const) {
      const modelId = `claude-test-no-print-posture-${expected.mode}`
      const postured = createClaudeCode({
        transport: "auto", cliPath, cwd: dirs.cwd, configDir: dirs.configDir,
        bridgeOpencodeMcp: false, proxyTools: [], resumeAfterRestart: false, ...posture,
      }).languageModel(modelId)
      const result = await postured.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "reply" }] }],
        tools: [{ type: "function", name: "read", inputSchema: { type: "object" } }],
      })
      for await (const _part of result.stream) {}
      const child = children.at(-1)!
      assert.equal(child.argv[child.argv.indexOf("--permission-mode") + 1], expected.mode)
      assert.equal(child.argv.includes("--restricted"), expected.restricted)
      const allow = JSON.parse(child.argv[child.argv.indexOf("--settings") + 1]).permissions.allow
      if (expected.restricted) {
        assert.deepEqual(allow, ["Read"], "no write tool and no MCP wildcard is pre-approved")
        const disallowed = child.argv.slice(child.argv.indexOf("--disallowedTools") + 1)
        for (const tool of ["Bash", "Write", "Edit", "WebFetch"]) assert(disallowed.includes(tool), tool)
      } else {
        assert(allow.includes("mcp__opencode_proxy__*"))
      }
      deleteActiveProcess(sessionKey(dirs.cwd, `${modelId}::tools::default::context=["claude-code",null]`))
    }
    for (const hostApi of ["v1", "v2"] as const) {
      const modelId = `claude-test-no-print-${hostApi}`
      const model = createClaudeCode({
        transport: "auto", cliPath, cwd: dirs.cwd, configDir: dirs.configDir, hostApi,
        bridgeOpencodeMcp: false, proxyTools: [], resumeAfterRestart: false,
      }).languageModel(modelId)
      const options = {
        prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "reply" }] }],
        tools: [{ type: "function" as const, name: "read", inputSchema: { type: "object" } }],
      }
      const normal = await model.doStream(options)
      const normalParts = []
      for await (const part of normal.stream) normalParts.push(part)
      assert(normalParts.some((part) => part.type === "text-delta" && part.delta === "SUMMARY"))
      const normalChild = children.at(-1)!
      assert(!normalChild.argv.includes("--print"))
      assert.equal(normalChild.exitCode, undefined, "ordinary sessions remain reusable")
      deleteActiveProcess(sessionKey(dirs.cwd, `${modelId}::tools::default::context=["claude-code",null]`))

      const compact = await model.doStream({ ...options,
        prompt: [
          { role: "system", content: "Summarize the conversation. Preserve the secret codename." },
          { role: "user", content: [{ type: "text", text: "The codename is OSPREY." }] },
          { role: "assistant", content: [{ type: "text", text: "I will remember OSPREY." }] },
        ],
        providerOptions: { "claude-code": { opencodeAgent: "compaction" } },
      })
      const compactParts = []
      for await (const part of compact.stream) compactParts.push(part)
      assert(compactParts.some((part) => part.type === "text-delta" && part.delta === "SUMMARY"))
      const child = children.at(-1)!
      assert.equal(child.argv[child.argv.indexOf("--tools") + 1], "")
      assert.equal(child.argv[child.argv.indexOf("--mcp-config") + 1], '{"mcpServers":{}}')
      assert(child.argv.includes("--strict-mcp-config"))
      assert(!child.argv.includes("--plugin-dir"))
      assert(!child.argv.includes("--resume"))
      assert.equal(child.argv[child.argv.indexOf("--model") + 1], "claude-haiku-4-5")
      const paste = child.writes.find((write) => write.startsWith("\x1b[200~"))!
      assert.match(paste, /Summarize the conversation/)
      assert.match(paste, /OSPREY/)
      assert.equal(child.exitCode, null, "compaction's temporary TUI is closed")
    }
  } finally {
    for (const child of children) child.exit(null)
    if (previousBun) Object.defineProperty(globalThis, "Bun", previousBun)
    else Reflect.deleteProperty(globalThis, "Bun")
    dirs.cleanup()
  }
})

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

// ---------------------------------------------------------------------------
// Idle eviction and MCP hot reload on the PTY (h #g200). Both replace the
// process with `deleteActiveProcess` or `deleteActiveProcessAndWait`; the
// next message spawns again with `--resume` from the kept session id.
// ---------------------------------------------------------------------------

test("idle eviction kills an idle interactive shim and keeps its Claude session", async () => {
  const dirs = scratch()
  const tui = new FakeTui()
  tui.turns.push((t) => t.append(assistantRecord("m1", "end_turn", textBlock("hello"))))
  const key = "idle-pty-key"
  try {
    const { ap, write, results } = spawnShim(tui, dirs)
    setActiveProcess(key, ap)
    setClaudeSessionId(key, "sess-idle")
    write("hi")
    await waitFor(() => results().length === 1)
    const exited = once(ap.proc as any, "exit")
    scheduleIdleProcessEviction(key, 30)
    await exited
    assert.equal(getActiveProcess(key), undefined)
    assert.equal(tui.exitCode, null, "the TUI was killed")
    assert.equal(getClaudeSessionId(key), "sess-idle", "kept for --resume")
  } finally {
    deleteActiveProcess(key)
    dirs.cleanup()
  }
})

test("idle eviction re-arms instead of killing a running interactive turn", async () => {
  const dirs = scratch()
  const tui = new FakeTui()
  tui.turns.push((t) => t.later(150, () => t.append(assistantRecord("m1", "end_turn", textBlock("slow")))))
  const key = "idle-pty-busy"
  try {
    const { ap, write, results } = spawnShim(tui, dirs)
    setActiveProcess(key, ap)
    write("hi")
    await waitFor(() => isTurnInFlight(ap))
    scheduleIdleProcessEviction(key, 20)
    await new Promise((resolve) => setTimeout(resolve, 60))
    // Checked before `getActiveProcess`, which cancels the timer by design.
    assert.equal(isIdleProcessEvictionScheduled(key), true, "re-armed")
    assert.equal(getActiveProcess(key), ap, "a running turn is never evicted")
    await waitFor(() => results().length === 1)
    assert.equal(results()[0].subtype, "success")
  } finally {
    deleteActiveProcess(key)
    dirs.cleanup()
  }
})

test("deleteActiveProcessAndWait waits for the interactive shim to exit", async () => {
  const dirs = scratch()
  const tui = new FakeTui()
  tui.turns.push((t) => t.append(assistantRecord("m1", "end_turn", textBlock("hello"))))
  const key = "reload-pty-key"
  try {
    const { ap, write, results } = spawnShim(tui, dirs)
    setActiveProcess(key, ap)
    write("hi")
    await waitFor(() => results().length === 1)
    // The hot-reload path. Before #g196 the shim had no exit code, so this
    // returned at once without ever killing the TUI.
    assert.equal(await deleteActiveProcessAndWait(key, { exitTimeoutMs: 2_000 }), true)
    assert.equal(tui.exitCode, null, "the TUI was killed")
    // A killed child: no code, a signal, which is what `hasProcessExited` reads.
    assert.equal((ap.proc as any).signalCode, "SIGTERM", "the shim reports the exit")
    assert.equal(getActiveProcess(key), undefined)
  } finally {
    dirs.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Plan mode: `ExitPlanMode`'s approval dialog is the operator's (h #g201).
// ---------------------------------------------------------------------------

/** Verbatim from Claude Code 2.1.288, as `stripTerminal` reads it. */
const PLAN_DIALOG =
  "Claude has written up a plan and is ready to execute. Would you like to proceed? " +
  "❯ 1. Yes, auto-accept edits 2. Yes, manually approve edits 3. Tell Claude what to change " +
  "shift+tab to approve with this feedback ctrl+g to edit in Sublime"

const exitPlanRecord = (id: string) =>
  assistantRecord(`m-${id}`, "tool_use", {
    type: "tool_use",
    id,
    name: "ExitPlanMode",
    input: { plan: "Create plan.txt." },
  })
const planResultRecord = (id: string, content: string, isError = false) => ({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }],
  },
})

test("the plan approval dialog is recognised, and a reply quoting it is not", () => {
  assert.equal(classifyScreen(PLAN_DIALOG)?.kind, "plan-approval")
  assert.equal(classifyScreen("Here is my plan. Would you like to proceed? Let me know."), null)
  assert.deepEqual(planApprovalKeys(PLAN_DIALOG), { approve: "2", reject: "3", rejectTakesText: true })
  // The older wording: "and", and a rejection that takes no text.
  assert.deepEqual(
    planApprovalKeys(
      "Would you like to proceed? ❯ 1. Yes, and auto-accept edits 2. Yes, and manually approve edits 3. No, keep planning",
    ),
    { approve: "2", reject: "3", rejectTakesText: false },
  )
})

test("a plan approval parks the turn until the operator decides, then the turn goes on", async () => {
  const tui = new FakeTui()
  tui.turns.push((t) => {
    t.append(exitPlanRecord("plan-1"))
    t.later(20, () => t.screen(PLAN_DIALOG))
  })
  const onWrite = tui.onWrite.bind(tui)
  tui.onWrite = (data: string) => {
    onWrite(data)
    if (data === "2") {
      tui.append(
        planResultRecord("plan-1", "User has approved your plan. You can now start coding."),
        assistantRecord("m-done", "end_turn", textBlock("done")),
      )
    }
  }
  const events: ScreenEvent[] = []
  await withSession(
    tui,
    async (session) => {
      await session.start()
      const turn = session.tailTurn("plan it", () => {})
      await waitFor(() => session.pendingPlanApproval === "plan-1")
      await waitFor(() => events.some((event) => event.action === "parked"))
      // A forwarded message must never be typed into the dialog as its answer.
      assert.equal(await session.queueInput("not an answer"), false)
      assert(!tui.writes.some((w) => w.includes("not an answer")))
      // Parked, not answered: no key and no Esc reaches the dialog on its own.
      await new Promise((resolve) => setTimeout(resolve, 60))
      assert.equal(tui.writes.includes("2"), false)
      assert.equal(tui.escCount, 0)
      assert.equal(await session.answerPlanApproval({ approved: true }), true)
      const result = await turn
      assert.equal(result.end, "stop")
      assert.equal(session.pendingPlanApproval, null)
    },
    { onScreen: (event) => events.push(event) },
  )
  assert.deepEqual(
    events.map((event) => [event.kind, event.action]),
    [["plan-approval", "parked"]],
  )
})

test("a rejected plan is answered with the operator's words, and the next dialog only once drawn", async () => {
  const tui = new FakeTui()
  tui.turns.push((t) => {
    t.append(exitPlanRecord("plan-1"))
    t.later(20, () => t.screen(PLAN_DIALOG))
  })
  let feedback: string | null = null
  let secondDrawn = false
  let answeredBeforeDraw = false
  const onWrite = tui.onWrite.bind(tui)
  tui.onWrite = (data: string) => {
    onWrite(data)
    if (data === "3") return tui.screen("❯ 3. Tell Claude what to change")
    if (data === "2") {
      if (!secondDrawn) answeredBeforeDraw = true
      tui.append(
        planResultRecord("plan-2", "User has approved your plan."),
        assistantRecord("m-done", "end_turn", textBlock("done")),
      )
      return
    }
    if (data === "\r" && feedback === null) return
    if (data === "\r") {
      tui.append(
        planResultRecord("plan-1", `${REJECTED_EXIT_PLAN_MODE_PREFIX}\n${feedback}`, true),
        exitPlanRecord("plan-2"),
      )
      tui.later(120, () => {
        secondDrawn = true
        tui.screen(PLAN_DIALOG)
      })
      return
    }
    if (!data.startsWith("\x1b") && tui.writes.includes("3")) feedback = data
  }
  await withSession(tui, async (session) => {
    await session.start()
    const turn = session.tailTurn("plan it", () => {})
    await waitFor(() => session.pendingPlanApproval === "plan-1")
    assert.equal(
      await session.answerPlanApproval({ approved: false, feedback: "Name it\nplan-b.txt" }),
      true,
    )
    // One line: a raw newline would submit the field early.
    assert.equal(feedback, "Name it plan-b.txt")
    await waitFor(() => session.pendingPlanApproval === "plan-2")
    // Asked before the second dialog is drawn: it waits for the draw.
    assert.equal(await session.answerPlanApproval({ approved: true }), true)
    assert.equal(answeredBeforeDraw, false)
    assert.equal((await turn).end, "stop")
  })
})

test("planApprovalAnswer reads the bridge's result and the operator's typed reply", () => {
  const envelope = (content: unknown) => JSON.stringify({ type: "user", message: { role: "user", content } })
  assert.deepEqual(
    planApprovalAnswer(envelope([{ type: "tool_result", tool_use_id: "p", content: "User has approved your plan." }]), "p"),
    { approved: true },
  )
  assert.deepEqual(
    planApprovalAnswer(
      envelope([{ type: "tool_result", tool_use_id: "p", is_error: true, content: `${REJECTED_EXIT_PLAN_MODE_PREFIX}\nuse b` }]),
      "p",
    ),
    { approved: false, feedback: "use b" },
  )
  // Without the bridge: only a bare yes approves; host annotations are not words.
  assert.deepEqual(
    planApprovalAnswer(envelope([{ type: "text", text: "Yes. <dcp-message-id>m0042</dcp-message-id>" }]), "p"),
    { approved: true },
  )
  assert.deepEqual(
    planApprovalAnswer(
      envelope([
        { type: "text", text: "yes, but call it b.txt" },
        { type: "text", text: "<system-reminder>be brief</system-reminder>" },
      ]),
      "p",
    ),
    { approved: false, feedback: "yes, but call it b.txt" },
  )
})

test("the shim answers a parked plan with what is written next instead of starting a turn", async () => {
  for (const [written, key] of [
    [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "plan-1", content: "ok" }] },
      }),
      "2",
    ],
    [JSON.stringify({ type: "user", message: { role: "user", content: "yes" } }), "2"],
    [JSON.stringify({ type: "user", message: { role: "user", content: "call it b.txt" } }), "3"],
  ] as const) {
    const dirs = scratch()
    const tui = new FakeTui()
    tui.turns.push((t) => {
      t.append(exitPlanRecord("plan-1"))
      t.later(20, () => t.screen(PLAN_DIALOG))
    })
    const onWrite = tui.onWrite.bind(tui)
    tui.onWrite = (data: string) => {
      onWrite(data)
      if (data === "2" || (data === "\r" && tui.writes.includes("3"))) {
        tui.append(
          planResultRecord("plan-1", data === "2" ? "approved" : `${REJECTED_EXIT_PLAN_MODE_PREFIX}\nx`, data !== "2"),
          assistantRecord("m-done", "end_turn", textBlock("done")),
        )
      }
    }
    try {
      const { ap, write, results } = spawnShim(tui, dirs)
      write("plan it")
      await waitFor(() => ap.interactiveControl?.planApprovalPending?.() === true)
      ;(ap.proc.stdin as any).write(written + "\n")
      await waitFor(() => results().length === 1)
      assert(tui.writes.includes(key), `${written} answered with ${key}`)
      assert.equal(results()[0].subtype, "success")
      // One prompt was ever pasted: the answer started no turn of its own.
      assert.equal(tui.writes.filter((w) => w.startsWith("\x1b[200~")).length, 1)
      assert.equal(ap.interactiveControl?.planApprovalPending?.(), false)
      ;(ap.proc as any).kill()
    } finally {
      dirs.cleanup()
    }
  }
})

test("the read-only posture reaches the TUI as --restricted and dontAsk", () => {
  const args = interactiveExtraArgs({ cwd: "/w", restricted: true, permissionMode: "dontAsk", permissionsAllow: ["Read"] })
  assert(args.includes("--restricted"))
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk")
  assert.equal(args[args.indexOf("--settings") + 1], JSON.stringify({ permissions: { allow: ["Read"] } }))
  assert(!interactiveExtraArgs({ cwd: "/w" }).includes("--restricted"))
})

test("a redraw of an answered dialog is never parked, and a dialog drawn before its record still is", async () => {
  const tui = new FakeTui()
  // Drawn first, recorded after, and never drawn again.
  tui.turns.push((t) => {
    t.screen(PLAN_DIALOG)
    t.later(60, () => t.append(exitPlanRecord("plan-1")))
  })
  const onWrite = tui.onWrite.bind(tui)
  tui.onWrite = (data: string) => {
    onWrite(data)
    if (data !== "2") return
    // The TUI repaints the dialog while it takes the key, then records it.
    tui.screen(PLAN_DIALOG)
    tui.later(80, () =>
      tui.append(
        planResultRecord("plan-1", "User has approved your plan."),
        assistantRecord("m-done", "end_turn", textBlock("done")),
      ),
    )
  }
  const events: ScreenEvent[] = []
  await withSession(
    tui,
    async (session) => {
      await session.start()
      const turn = session.tailTurn("plan it", () => {})
      await waitFor(() => session.pendingPlanApproval === "plan-1")
      assert.equal(await session.answerPlanApproval({ approved: true }), true)
      assert.equal((await turn).end, "stop")
    },
    { onScreen: (event) => events.push(event) },
  )
  assert.equal(events.filter((event) => event.action === "parked").length, 1)
})

test("a dialog frame larger than 16 KB of escape sequences is still read whole", async () => {
  // Measured: one redraw with a plan approval up was 15,379 raw characters,
  // and a busier frame pushed the question out of a 16 KB window.
  const styled = (text: string) => text.split(" ").map((word) => `\x1b[38;5;245m${word}\x1b[39m`).join(" ")
  const frame =
    styled("Claude has written up a plan and is ready to execute. Would you like to proceed?") +
    "\x1b[2m\x1b[22m".repeat(2_000) +
    styled("❯ 1. Yes, auto-accept edits 2. Yes, manually approve edits 3. Tell Claude what to change")
  assert(frame.length > 16 * 1024)
  const tui = new FakeTui()
  tui.turns.push((t) => {
    t.append(exitPlanRecord("plan-1"))
    t.later(20, () => t.screen(frame))
  })
  const events: ScreenEvent[] = []
  await withSession(
    tui,
    async (session) => {
      await session.start()
      void session.tailTurn("plan it", () => {}).catch(() => {})
      await waitFor(() => events.some((event) => event.action === "parked"))
    },
    { onScreen: (event) => events.push(event) },
  )
})

test("the shim pastes an image as a staged path and deletes the file after the turn", async () => {
  const dirs = scratch()
  const tui = new FakeTui()
  tui.turns.push((t) => t.later(30, () => t.append(assistantRecord("m1", "end_turn", textBlock("Red")))))
  try {
    const { ap, results } = spawnShim(tui, dirs)
    ;(ap.proc.stdin as any).write(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "What color?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("png-bytes").toString("base64") } },
          ],
        },
      }) + "\n",
    )
    await waitFor(() => tui.writes.some((w) => w.startsWith("\x1b[200~")))
    const paste = tui.writes.find((w) => w.startsWith("\x1b[200~"))!
    const [first, ...rest] = paste.slice("\x1b[200~".length, -"\x1b[201~".length).split("\n")
    assert.match(first!, /image-[0-9a-f-]+\.png$/)
    assert.equal(fs.readFileSync(first!, "utf8"), "png-bytes")
    assert.deepEqual(rest, ["What color?"])
    await waitFor(() => results().length === 1)
    await waitFor(() => !fs.existsSync(first!))
    ;(ap.proc as any).kill()
  } finally {
    dirs.cleanup()
  }
})

// ---------------------------------------------------------------------------
// /btw: a short-lived fork of the conversation (h #g203).
// ---------------------------------------------------------------------------

test("/btw on a TUI asks a fork of the conversation and never writes the main transcript", async () => {
  const dirs = scratch()
  const tuis: FakeTui[] = []
  const spawner: PtySpawner = (argv, ptyOptions) => {
    const tui = new FakeTui()
    tui.turns.push(
      tuis.length === 0
        ? (t) => t.append(assistantRecord("m1", "end_turn", textBlock("The codeword is ORCHID.")))
        : (t) => t.later(10, () => t.append(assistantRecord("a1", "end_turn", textBlock("ORCHID")))),
    )
    tuis.push(tui)
    return tui.spawner(argv, ptyOptions)
  }
  try {
    const ap = spawnInteractiveProcess({ cwd: dirs.cwd, configDir: dirs.configDir, env: {}, spawnPty: spawner, tuning: FAST })
    const lines: any[] = []
    ap.lineEmitter.on("line", (raw: string) => lines.push(JSON.parse(raw)))
    ;(ap.proc.stdin as any).write(
      JSON.stringify({ type: "user", message: { role: "user", content: "remember ORCHID" } }) + "\n",
    )
    await waitFor(() => lines.some((line) => line.type === "result"))
    const main = tuis[0]!
    const mainSessionId = main.argv[main.argv.indexOf("--session-id") + 1]
    const mainBefore = fs.readFileSync(main.transcript, "utf8")

    const answer = await ap.interactiveControl!.askAside!("what was the codeword?", {
      history: [{ question: "q0", response: "a0" }],
    })
    // The copied history ends on the main conversation's own reply; reading it
    // as the fork's answer would have returned "The codeword is ORCHID.".
    assert.equal(answer, "ORCHID")
    const fork = tuis[1]!
    assert(fork.argv.includes("--fork-session"))
    assert.equal(fork.argv[fork.argv.indexOf("--resume") + 1], mainSessionId)
    assert.notEqual(fork.argv[fork.argv.indexOf("--session-id") + 1], mainSessionId)
    assert.equal(fork.argv[fork.argv.indexOf("--permission-mode") + 1], "dontAsk")
    assert(!fork.argv.includes("--settings"), "nothing is pre-approved in the fork")
    const paste = fork.writes.find((w) => w.startsWith("\x1b[200~"))!
    assert.match(paste, /Side question/)
    assert.match(paste, /Earlier side question: q0\nYour answer: a0/)
    assert.match(paste, /what was the codeword\?/)
    assert.equal(fs.readFileSync(main.transcript, "utf8"), mainBefore, "the main conversation is never written")
    await waitFor(() => !fs.existsSync(fork.transcript))
    assert.notEqual(fork.exitCode, undefined, "the fork's TUI is closed")
    ;(ap.proc as any).kill()
  } finally {
    dirs.cleanup()
  }
})

// ---------------------------------------------------------------------------
// A message forwarded mid-call joins the running turn's input queue (h #g206).
// ---------------------------------------------------------------------------

test("queueInput types into the running turn's queue and starts no turn of its own", async () => {
  const tui = new FakeTui()
  let promptSubmitted = false
  tui.turns.push(() => {
    promptSubmitted = true
  })
  // After the prompt, a paste and Enter is what the TUI queues mid-turn:
  // measured on 2.1.288 as a `queue-operation` enqueue, not a `user` record.
  let pending = ""
  let queuedText: string | null = null
  const onWrite = tui.onWrite.bind(tui)
  tui.onWrite = (data: string) => {
    if (promptSubmitted && data.startsWith("\x1b[200~")) {
      tui.writes.push(data)
      pending = data.slice("\x1b[200~".length, -"\x1b[201~".length)
      return
    }
    if (promptSubmitted && data === "\r" && pending) {
      tui.writes.push(data)
      queuedText = pending
      pending = ""
      tui.append({ type: "queue-operation", operation: "enqueue", content: queuedText })
      return
    }
    onWrite(data)
  }
  await withSession(tui, async (session) => {
    await session.start()
    assert.equal(await session.queueInput("too early"), false, "no turn is running")
    const lines: string[] = []
    const turn = session.tailTurn("go", (raw) => lines.push(raw))
    await waitFor(() => promptSubmitted)
    assert.equal(await session.queueInput("Also say PELICAN."), true)
    assert.equal(queuedText, "Also say PELICAN.")
    assert.equal(session.turnRunning, true, "the same turn goes on")
    tui.append(assistantRecord("m1", "end_turn", textBlock("first-done. PELICAN")))
    const result = await turn
    assert.equal(result.end, "stop")
    assert(lines.some((line) => line.includes("PELICAN")))
  })
})

// ---------------------------------------------------------------------------
// The third end signal: an idle TUI after a reply (h #g207).
// ---------------------------------------------------------------------------

test("a reply with no stop signal ends once the TUI and the transcript go silent", async () => {
  const tui = new FakeTui()
  // A CLI that writes neither a terminal stop_reason nor turn_duration.
  tui.turns.push((t) => t.append(assistantRecord("m1", null as any, textBlock("answered"))))
  await withSession(
    tui,
    async (session) => {
      await session.start()
      const started = Date.now()
      const result = await session.tailTurn("go", () => {})
      assert.equal(result.end, "ended", "reported as a turn with no stop, never as a clean reply")
      assert.equal(result.stopReason, null)
      assert(Date.now() - started >= 150)
    },
    { idleEndMs: 150 },
  )
})

test("a TUI that is still drawing, or has not replied, is never ended as idle", async () => {
  const tui = new FakeTui()
  let drawing = true
  let lastDrawAt = 0
  tui.turns.push((t) => {
    t.append(assistantRecord("m1", null as any, textBlock("working")))
    // The spinner: a redraw every 20 ms for 500 ms.
    const spin = () => {
      if (!drawing) return
      lastDrawAt = Date.now()
      t.screen("✻ Working… ")
      t.later(20, spin)
    }
    spin()
    t.later(500, () => (drawing = false))
  })
  await withSession(
    tui,
    async (session) => {
      await session.start()
      const result = await session.tailTurn("go", () => {})
      assert.equal(result.end, "ended")
      // Timers land a few ms either side; the rule is silence since the last draw.
      assert(Date.now() - lastDrawAt >= 150 - 10, `ended ${Date.now() - lastDrawAt} ms after the last draw`)
    },
    { idleEndMs: 150 },
  )
  // No reply yet (a slow first call): silence alone ends nothing.
  const quiet = new FakeTui()
  quiet.turns.push(() => {})
  await withSession(
    quiet,
    async (session) => {
      await session.start()
      await assert.rejects(session.tailTurn("go", () => {}, 600), /timed out/, "only the turn timeout ends it")
    },
    { idleEndMs: 100 },
  )
})

test("a parked plan approval is a still screen, never an idle end", async () => {
  const tui = new FakeTui()
  tui.turns.push((t) => {
    t.append(exitPlanRecord("plan-1"))
    t.later(20, () => t.screen(PLAN_DIALOG))
  })
  await withSession(
    tui,
    async (session) => {
      await session.start()
      await assert.rejects(session.tailTurn("plan it", () => {}, 900), /timed out/, "still parked at the turn timeout")
    },
    { idleEndMs: 100 },
  )
})

// ---------------------------------------------------------------------------
// A turn the CLI answers with its own API error (h #g208): a usage limit, an
// expired login. The TUI writes it as a `<synthetic>` record with
// `isApiErrorMessage`; the turn must end the way a headless one does.
// ---------------------------------------------------------------------------

/** Verbatim from a 2.1.288 transcript, ids and paths dropped. */
const SESSION_LIMIT_RECORD = {
  type: "assistant",
  error: "rate_limit",
  isApiErrorMessage: true,
  apiErrorStatus: 429,
  message: {
    id: "limit-1",
    model: "<synthetic>",
    role: "assistant",
    stop_reason: "stop_sequence",
    type: "message",
    content: [{ type: "text", text: "You've hit your session limit · resets 3pm (Europe/Amsterdam)" }],
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
}

async function runFakeBunTurn(
  dirs: ReturnType<typeof scratch>,
  modelId: string,
  turn: TurnScript,
  options: Record<string, unknown> = {},
): Promise<{ parts: any[]; children: FakeTui[] }> {
  const previousBun = Object.getOwnPropertyDescriptor(globalThis, "Bun")
  const children: FakeTui[] = []
  Object.defineProperty(globalThis, "Bun", { configurable: true, value: {
    Terminal: function Terminal() {},
    which: (command: string) => command,
    spawn: (argv: string[], spawnOptions: {
      cwd: string; env: Record<string, string | undefined>
      terminal: { cols: number; rows: number; data: (terminal: unknown, data: Uint8Array) => void }
    }) => {
      const tui = new FakeTui()
      tui.turns = [turn]
      children.push(tui)
      return tui.spawner(argv, { ...spawnOptions, ...spawnOptions.terminal,
        onData: (text) => spawnOptions.terminal.data(undefined, Buffer.from(text)),
      })
    },
  } })
  try {
    const model = createClaudeCode({
      transport: "interactive", cwd: dirs.cwd, configDir: dirs.configDir,
      bridgeOpencodeMcp: false, proxyTools: [], resumeAfterRestart: false, ...options,
    }).languageModel(modelId)
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "reply" }] }],
      tools: [{ type: "function", name: "read", inputSchema: { type: "object" } }],
    })
    const parts: any[] = []
    for await (const part of result.stream) parts.push(part)
    return { parts, children }
  } finally {
    deleteActiveProcess(sessionKey(dirs.cwd, `${modelId}::tools::default::context=["claude-code",null]`))
    if (previousBun) Object.defineProperty(globalThis, "Bun", previousBun)
    else delete (globalThis as any).Bun
  }
}

const textOf = (parts: any[]) => parts.filter((part) => part.type === "text-delta").map((part) => part.delta).join("")

test("a usage limit on the PTY ends on the plugin's note, with the TUI's reset time", async () => {
  const dirs = scratch()
  try {
    const { parts } = await runFakeBunTurn(dirs, "claude-test-pty-limit", (t) => {
      t.append(SESSION_LIMIT_RECORD)
      t.append({ type: "system", subtype: "turn_duration", durationMs: 812 })
    })
    const text = textOf(parts)
    assert.match(text, /▌ \*\*usage limit:\*\*/)
    assert.match(text, /in the 5-hour window, which resets 3pm \(Europe\/Amsterdam\)\./)
    assert.doesNotMatch(text, /You've hit your session limit/, "the note replaces the CLI's sentence")
    // A failed turn is never billed in a stats line, and nothing was billed.
    assert(!parts.some((part) => part.type === "error"))
  } finally {
    dirs.cleanup()
  }
})

test("the transcript's isApiErrorMessage reaches the parser under the stream's name", () => {
  const raw = JSON.stringify(SESSION_LIMIT_RECORD)
  const frame = JSON.parse(streamFrameFromRecord(raw))
  assert.equal(frame.is_api_error_message, true)
  assert.equal(frame.error, "rate_limit")
  // Every other record passes through byte-identical.
  const plain = JSON.stringify(assistantRecord("m1", "end_turn", textBlock("hi")))
  assert.equal(streamFrameFromRecord(plain), plain)
  assert.equal(streamFrameFromRecord("not json"), "not json")
})

test("a turn that ended on the CLI's own API error is a failed result, as headless says", () => {
  const frame = JSON.parse(
    interactiveResultFrame({
      sessionId: "s",
      end: "stop",
      stopReason: "stop_sequence",
      apiError: { text: "You've hit your session limit · resets 3pm (Europe/Amsterdam)", status: 429 },
    }),
  )
  // The measured headless shape: `subtype` success, only `is_error` says it.
  assert.equal(frame.subtype, "success")
  assert.equal(frame.is_error, true)
  assert.equal(frame.result, "You've hit your session limit · resets 3pm (Europe/Amsterdam)")
  assert.equal(frame.api_error_status, 429)
  const ordinary = JSON.parse(interactiveResultFrame({ sessionId: "s", end: "stop", stopReason: "end_turn" }))
  assert.equal(ordinary.is_error, false)
  assert.equal(ordinary.result, undefined)
})

test("an expired login on the PTY gets the account note that names the login command", async () => {
  const dirs = scratch()
  try {
    const { parts } = await runFakeBunTurn(dirs, "claude-test-pty-login", (t) => {
      t.append({
        ...SESSION_LIMIT_RECORD,
        error: "authentication_failed",
        apiErrorStatus: 401,
        message: {
          ...SESSION_LIMIT_RECORD.message,
          id: "login-1",
          content: [{ type: "text", text: "Login expired · Please run /login" }],
        },
      })
      t.append({ type: "system", subtype: "turn_duration", durationMs: 300 })
    })
    const text = textOf(parts)
    assert.match(text, /▌ \*\*claude account:\*\*/)
    assert.doesNotMatch(text, /usage limit/, "a login is not a usage limit")
  } finally {
    dirs.cleanup()
  }
})

// ---------------------------------------------------------------------------
// `forkSessions` on the PTY (h #g209): a forked opencode session branches the
// parent's Claude conversation with `--fork-session` instead of replaying it.
// ---------------------------------------------------------------------------

test("a forked opencode session branches the parent's conversation on the PTY", async () => {
  _resetForkFingerprints()
  const previousBun = Object.getOwnPropertyDescriptor(globalThis, "Bun")
  const dirs = scratch()
  const cliPath = path.join(dirs.cwd, "fake-claude")
  fs.writeFileSync(
    cliPath,
    "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '2.1.288\\n'; exit 0; fi\n" +
      "if [ \"$1\" = --help ]; then printf 'Usage: claude\\n  --resume\\n  --fork-session\\n'; exit 0; fi\nexit 1\n",
    { mode: 0o755 },
  )
  const children: FakeTui[] = []
  const answers = ["Parent answer", "Forked answer"]
  Object.defineProperty(globalThis, "Bun", { configurable: true, value: {
    Terminal: function Terminal() {},
    which: (command: string) => command,
    spawn: (argv: string[], options: {
      cwd: string; env: Record<string, string | undefined>
      terminal: { cols: number; rows: number; data: (terminal: unknown, data: Uint8Array) => void }
    }) => {
      const tui = new FakeTui()
      const answer = answers[children.length]!
      tui.turns = [(child) => child.append(assistantRecord(`m-${children.length}`, "end_turn", textBlock(answer)))]
      children.push(tui)
      return tui.spawner(argv, { ...options, ...options.terminal,
        onData: (text) => options.terminal.data(undefined, Buffer.from(text)),
      })
    },
  } })
  const modelId = "claude-test-pty-fork"
  const keyOf = (affinity: string) => sessionKey(dirs.cwd, `${modelId}::tools::${affinity}::context=["claude-code",null]`)
  const model = createClaudeCode({
    transport: "interactive", cliPath, cwd: dirs.cwd, configDir: dirs.configDir,
    bridgeOpencodeMcp: false, proxyTools: [], resumeAfterRestart: false, forkSessions: true,
  }).languageModel(modelId)
  const turn = async (affinity: string, prompt: any[]) => {
    const result = await model.doStream({
      prompt,
      headers: { "x-session-affinity": affinity },
      tools: [{ type: "function", name: "read", inputSchema: { type: "object" } }],
    } as any)
    const parts: any[] = []
    for await (const part of result.stream) parts.push(part)
    return textOf(parts)
  }
  const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
  try {
    assert.equal(await turn("ses_parent", [user("The codeword is HERON.")]), "Parent answer")
    const parentId = getClaudeSessionId(keyOf("ses_parent"))!
    assert.ok(parentId)

    assert.equal(
      await turn("ses_fork", [
        user("The codeword is HERON."),
        { role: "assistant", content: [{ type: "text", text: "Parent answer" }] },
        user("Try that again but shorter."),
      ]),
      "Forked answer",
    )
    const fork = children[1]!
    const at = fork.argv.indexOf("--resume")
    assert.deepEqual(fork.argv.slice(at, at + 3), ["--resume", parentId, "--fork-session"])
    const forkId = fork.argv[fork.argv.indexOf("--session-id") + 1]!
    assert.notEqual(forkId, parentId)
    assert.equal(getClaudeSessionId(keyOf("ses_fork")), forkId, "the fork keeps its own conversation")
    assert.equal(getClaudeSessionId(keyOf("ses_parent")), parentId, "the parent keeps its own")
    // Nothing was replayed: only the new message was typed.
    const typed = fork.writes.join("")
    assert.ok(typed.includes("Try that again but shorter."))
    assert.ok(!typed.includes("conversation_history"), typed.slice(0, 300))
  } finally {
    for (const affinity of ["ses_parent", "ses_fork"]) {
      deleteActiveProcess(keyOf(affinity))
      deleteClaudeSessionId(keyOf(affinity))
    }
    if (previousBun) Object.defineProperty(globalThis, "Bun", previousBun)
    else delete (globalThis as any).Bun
    dirs.cleanup()
  }
})

// ---------------------------------------------------------------------------
// The fallback chain on the PTY (h #g209). The TUI writes a refused model as
// a `<synthetic>` reply with `error: "model_not_found"`, measured on 2.1.288.
// ---------------------------------------------------------------------------

test("a refused model on the PTY hands the turn to the next one in the chain", async () => {
  _resetAgentRegistryForTests()
  setProviderFallbackModels(["claude-opus-5", "claude-sonnet-5"])
  const previousBun = Object.getOwnPropertyDescriptor(globalThis, "Bun")
  const dirs = scratch()
  const cliPath = path.join(dirs.cwd, "fake-claude")
  fs.writeFileSync(cliPath, "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '2.1.288\\n'; exit 0; fi\nexit 1\n", { mode: 0o755 })
  const children: FakeTui[] = []
  Object.defineProperty(globalThis, "Bun", { configurable: true, value: {
    Terminal: function Terminal() {},
    which: (command: string) => command,
    spawn: (argv: string[], options: {
      cwd: string; env: Record<string, string | undefined>
      terminal: { cols: number; rows: number; data: (terminal: unknown, data: Uint8Array) => void }
    }) => {
      const tui = new FakeTui()
      const model = argv[argv.indexOf("--model") + 1]
      tui.turns = [(child) => {
        if (model === "claude-opus-5") {
          child.append({
            ...SESSION_LIMIT_RECORD,
            error: "model_not_found",
            apiErrorStatus: 404,
            message: {
              ...SESSION_LIMIT_RECORD.message,
              id: "refused-1",
              content: [{ type: "text", text: "There's an issue with the selected model (claude-opus-5). It may not exist or you may not have access to it. Run /model to pick a different model." }],
            },
          })
        } else {
          child.append(assistantRecord("served-1", "end_turn", textBlock(`served by ${model}`)))
        }
      }]
      children.push(tui)
      return tui.spawner(argv, { ...options, ...options.terminal,
        onData: (text) => options.terminal.data(undefined, Buffer.from(text)),
      })
    },
  } })
  const keyOf = (model: string) => sessionKey(dirs.cwd, `${model}::tools::default::context=["claude-code",null]`)
  try {
    const model = createClaudeCode({
      transport: "interactive", cliPath, cwd: dirs.cwd, configDir: dirs.configDir,
      bridgeOpencodeMcp: false, proxyTools: [], resumeAfterRestart: false,
    }).languageModel("claude-opus-5")
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "reply" }] }],
      tools: [{ type: "function", name: "read", inputSchema: { type: "object" } }],
    })
    const parts: any[] = []
    for await (const part of result.stream) parts.push(part)
    assert.deepEqual(children.map((child) => child.argv[child.argv.indexOf("--model") + 1]), ["claude-opus-5", "claude-sonnet-5"])
    const text = textOf(parts)
    assert.match(text, /▌ \*\*model fallback:\*\*/)
    assert.match(text, /served by claude-sonnet-5/)
    assert.doesNotMatch(text, /There's an issue with the selected model/, "the refused attempt is discarded whole")
    const finishes = parts.filter((part) => part.type === "finish")
    assert.equal(finishes.length, 1)
    assert.equal(finishes[0].finishReason.unified, "stop")
  } finally {
    for (const model of ["claude-opus-5", "claude-sonnet-5"]) deleteActiveProcess(keyOf(model))
    _resetAgentRegistryForTests()
    if (previousBun) Object.defineProperty(globalThis, "Bun", previousBun)
    else delete (globalThis as any).Bun
    dirs.cleanup()
  }
})

// ---------------------------------------------------------------------------
// The account-switch form on the PTY (h #g209). Last in this file: it gives
// the process an opencode client that advertises `question`.
// ---------------------------------------------------------------------------

test("a usage limit on the PTY asks to switch accounts, and the switch replays on the other one", async () => {
  const previousBun = Object.getOwnPropertyDescriptor(globalThis, "Bun")
  const previousHome = process.env.HOME
  const previousCache = process.env.XDG_CACHE_HOME
  const dirs = scratch()
  // Account directories and their wrappers resolve under HOME and
  // XDG_CACHE_HOME: keep every one of them in scratch, never the real ones.
  process.env.HOME = dirs.root
  process.env.XDG_CACHE_HOME = path.join(dirs.root, "cache")
  setOpencodeClient({ tool: { list: async () => ({ data: [{ id: "question", description: "", parameters: {} }] }) } })
  _resetAccountOverrides()
  const baseCli = path.join(dirs.root, "fake-claude")
  fs.writeFileSync(baseCli, "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '2.1.288\\n'; exit 0; fi\nexit 1\n", { mode: 0o755 })
  const children: FakeTui[] = []
  Object.defineProperty(globalThis, "Bun", { configurable: true, value: {
    Terminal: function Terminal() {},
    which: (command: string) => command,
    spawn: (argv: string[], options: {
      cwd: string; env: Record<string, string | undefined>
      terminal: { cols: number; rows: number; data: (terminal: unknown, data: Uint8Array) => void }
    }) => {
      const tui = new FakeTui()
      tui.configDir = path.join(dirs.root, ".claude")
      const first = children.length === 0
      tui.turns = [(child) => {
        if (first) {
          child.append(SESSION_LIMIT_RECORD)
          child.append({ type: "system", subtype: "turn_duration", durationMs: 400 })
        } else {
          child.append(assistantRecord("served-2", "end_turn", textBlock("carried on, on default")))
        }
      }]
      children.push(tui)
      return tui.spawner(argv, { ...options, ...options.terminal,
        onData: (text) => options.terminal.data(undefined, Buffer.from(text)),
      })
    },
  } })
  const modelId = "claude-test-pty-failover@appical"
  const sk = sessionKey(dirs.cwd, `${modelId}::tools::default::context=["claude-code",null]`)
  try {
    const runtime = await ensureAccountRuntime("appical", baseCli)
    assert.ok(runtime.configDir?.startsWith(dirs.root), "the account lives in scratch")
    assert.ok(runtime.cliPath.startsWith(dirs.root), "so does its wrapper")
    const model = createClaudeCode({
      transport: "interactive", cliPath: runtime.cliPath, baseCliPath: baseCli,
      configDir: runtime.configDir, account: "appical", failoverAccounts: ["default", "appical"],
      accountFailover: "ask", cwd: dirs.cwd, bridgeOpencodeMcp: false, proxyTools: [], resumeAfterRestart: false,
    }).languageModel(modelId)
    const tools = [{ type: "function", name: "read", inputSchema: { type: "object" } }]
    const prompt = [{ role: "user", content: [{ type: "text", text: "go" }] }]

    const first: any[] = []
    for await (const part of (await model.doStream({ prompt, tools } as any)).stream) first.push(part)
    const call = first.find((part) => part.type === "tool-call")
    assert.ok(call, "the limited turn ends on the switch form")
    assert.equal(call.toolName, "question")
    const question = JSON.parse(call.input).questions[0]
    assert.deepEqual(question.options.map((option: any) => option.label), ["default", "stop"])
    assert.equal(first.find((part) => part.type === "finish").finishReason.unified, "tool-calls")
    assert.equal(children[0]!.argv[0], runtime.cliPath, "the limited account's wrapper ran")

    const second: any[] = []
    const answered = await model.doStream({
      prompt: [
        ...prompt,
        { role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: "question", input: JSON.parse(call.input) }] },
        { role: "tool", content: [{
          type: "tool-result", toolCallId: call.toolCallId, toolName: "question",
          output: { type: "text", value: `User has answered your questions: "${question.question}"="default". You can now continue with the user's answers in mind.` },
        }] },
      ],
      tools,
    } as any)
    for await (const part of answered.stream) second.push(part)

    assert.equal(children.length, 2, "the switch spawns a fresh TUI")
    const switched = children[1]!
    assert.equal(switched.argv[0], baseCli, "the default account is the bare binary")
    assert.equal(switched.argv[switched.argv.indexOf("--model") + 1], "claude-test-pty-failover")
    assert.ok(!switched.argv.includes("--resume"), "a transcript cannot follow across accounts")
    const typed = switched.writes.join("")
    assert.match(typed, /<conversation_history>/)
    assert.match(typed, /Continue the task from where it stopped/)
    assert.match(textOf(second), /carried on, on default/)
    assert.equal(second.find((part) => part.type === "finish").finishReason.unified, "stop")
  } finally {
    deleteActiveProcess(sk)
    _resetAccountOverrides()
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = previousCache
    if (previousBun) Object.defineProperty(globalThis, "Bun", previousBun)
    else delete (globalThis as any).Bun
    dirs.cleanup()
  }
})
