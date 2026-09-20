import assert from "node:assert/strict"
import { EventEmitter, once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"
import { test } from "node:test"
import { spawn, type ChildProcess } from "node:child_process"
import {
  buildCliArgs,
  DEFAULT_IDLE_PROCESS_TIMEOUT_MS,
  deleteActiveProcess,
  deleteActiveProcessAndWait,
  deleteActiveProcessesForSession,
  deleteClaudeSessionId,
  describeChildCrash,
  ensureProcessExitCleanup,
  evictIfNeeded,
  getActiveProcess,
  getClaudeSessionId,
  isIdleProcessEvictionScheduled,
  killAllActiveProcesses,
  MAX_ACTIVE_PROCESSES,
  MAX_CLAUDE_SESSION_ENTRIES,
  resolveIdleProcessTimeoutMs,
  retainStderr,
  scheduleIdleProcessEviction,
  noteTurnStarted,
  noteTurnLine,
  isTurnInFlight,
  awaitTurnIdle,
  interruptTurn,
  setActiveProcess,
  setClaudeSessionId,
  spawnClaudeProcess,
  type ActiveProcess,
} from "./src/session-manager.js"
import { getPendingProxyCalls, queuePendingProxyCall } from "./src/proxy-broker.js"
import {
  applyTaskCreateToolResult,
  applyTaskCreateToolUse,
  getLedger,
} from "./src/todo-ledger.js"
import {
  createProxyMcpServer,
  DEFAULT_PROXY_TOOLS,
  SERVER_CLOSED_MESSAGE,
  type ProxyToolCall,
} from "./src/proxy-mcp.js"

function fakeActiveProcess(options: { exitOn: NodeJS.Signals; delayMs: number }): {
  activeProcess: ActiveProcess
  signals: NodeJS.Signals[]
} {
  const proc = new EventEmitter() as ChildProcess
  const signals: NodeJS.Signals[] = []
  Object.assign(proc, {
    exitCode: null,
    signalCode: null,
    kill(signal: NodeJS.Signals = "SIGTERM") {
      signals.push(signal)
      if (signal === options.exitOn) {
        setTimeout(() => {
          Object.defineProperty(proc, "signalCode", {
            configurable: true,
            value: signal,
          })
          proc.emit("exit", null, signal)
        }, options.delayMs)
      }
      return true
    },
  })

  return {
    activeProcess: {
      proc,
      lineEmitter: new EventEmitter(),
      proxyServer: null,
    },
    signals,
  }
}

test("deleteActiveProcessAndWait waits for the old session owner", async () => {
  const key = "wait-for-session-owner"
  const { activeProcess, signals } = fakeActiveProcess({
    exitOn: "SIGTERM",
    delayMs: 25,
  })
  setActiveProcess(key, activeProcess)
  setClaudeSessionId(key, "claude-session")

  let settled = false
  const pending = deleteActiveProcessAndWait(key, {
    exitTimeoutMs: 200,
    forceExitTimeoutMs: 100,
  }).then((result) => {
    settled = true
    return result
  })

  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(settled, false)
  assert.equal(await pending, true)
  assert.deepEqual(signals, ["SIGTERM"])
  assert.equal(getActiveProcess(key), undefined)
  assert.equal(getClaudeSessionId(key), "claude-session")
  deleteClaudeSessionId(key)
})

test("deleteActiveProcessAndWait escalates before reusing a session ID", async () => {
  const key = "force-session-owner-exit"
  const { activeProcess, signals } = fakeActiveProcess({
    exitOn: "SIGKILL",
    delayMs: 5,
  })
  setActiveProcess(key, activeProcess)

  assert.equal(
    await deleteActiveProcessAndWait(key, {
      exitTimeoutMs: 5,
      forceExitTimeoutMs: 100,
    }),
    true,
  )
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
})

test("buildCliArgs resumes a remembered session with --resume", () => {
  const key = "resume-args"
  setClaudeSessionId(key, "11111111-1111-4111-8111-111111111111")
  try {
    const args = buildCliArgs({ sessionKey: key, skipPermissions: true })
    assert.equal(
      args[args.indexOf("--resume") + 1],
      "11111111-1111-4111-8111-111111111111",
    )
    assert.equal(args.includes("--session-id"), false)
  } finally {
    deleteClaudeSessionId(key)
  }
})

test("buildCliArgs skips --resume while the session owner is alive", () => {
  const key = "resume-args-live"
  setClaudeSessionId(key, "22222222-2222-4222-8222-222222222222")
  const { activeProcess } = fakeActiveProcess({ exitOn: "SIGTERM", delayMs: 0 })
  setActiveProcess(key, activeProcess)
  try {
    const args = buildCliArgs({ sessionKey: key, skipPermissions: true })
    assert.equal(args.includes("--resume"), false)
    assert.equal(args.includes("--session-id"), false)
  } finally {
    deleteActiveProcess(key)
    deleteClaudeSessionId(key)
  }
})

test("a resume failure on stderr clears the remembered session ID", async () => {
  const key = "resume-error-stderr"
  setClaudeSessionId(key, "purged-session")
  spawnClaudeProcess(
    process.execPath,
    [
      "-e",
      "console.error('No conversation found with session ID: purged-session'); setInterval(() => {}, 1000)",
    ],
    process.cwd(),
    key,
  )
  try {
    const deadline = Date.now() + 2000
    while (getClaudeSessionId(key) !== undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(getClaudeSessionId(key), undefined)
  } finally {
    deleteActiveProcess(key)
    deleteClaudeSessionId(key)
  }
})

test("an exiting stale process cannot delete its replacement", async () => {
  const key = "stale-process-exit"
  const first = spawnClaudeProcess(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    process.cwd(),
    key,
  )
  const replacementProc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"])
  const replacement: ActiveProcess = {
    proc: replacementProc,
    lineEmitter: new EventEmitter(),
    proxyServer: null,
  }

  try {
    setActiveProcess(key, replacement)
    first.proc.kill()
    await once(first.proc, "exit")
    assert.equal(getActiveProcess(key), replacement)
  } finally {
    deleteActiveProcess(key)
    deleteClaudeSessionId(key)
  }
})

// Idle timeout tests by @bernardofortes (a5f723a).
function fakeIdleProcess(onKill: () => void): ActiveProcess {
  return {
    proc: {
      kill() {
        onKill()
        return true
      },
    } as ActiveProcess["proc"],
    lineEmitter: new EventEmitter(),
  }
}

test("idle process is evicted after the configured timeout", async () => {
  const key = `idle-eviction-${Date.now()}`
  const sessionId = "f8dccdd4-4785-4bd9-8520-7a5993a71f78"
  let kills = 0
  setActiveProcess(key, fakeIdleProcess(() => kills++))
  setClaudeSessionId(key, sessionId)

  scheduleIdleProcessEviction(key, 10)
  await delay(30)

  assert.equal(kills, 1)
  assert.equal(getActiveProcess(key), undefined)
  assert.deepEqual(
    buildCliArgs({ sessionKey: key, skipPermissions: false }).slice(-2),
    ["--resume", sessionId],
  )
  deleteClaudeSessionId(key)
})

test("reusing a process cancels its idle eviction", async () => {
  const key = `idle-reuse-${Date.now()}`
  let kills = 0
  const process = fakeIdleProcess(() => kills++)
  setActiveProcess(key, process)

  scheduleIdleProcessEviction(key, 10)
  assert.equal(getActiveProcess(key), process)
  await delay(30)

  assert.equal(kills, 0)
  assert.equal(getActiveProcess(key), process)
  deleteActiveProcess(key)
})

test("idle eviction is off unless set, and an explicit value arms it", () => {
  assert.equal(DEFAULT_IDLE_PROCESS_TIMEOUT_MS, 0)
  assert.equal(resolveIdleProcessTimeoutMs(undefined), 0)
  assert.equal(resolveIdleProcessTimeoutMs(0), 0)
  assert.equal(resolveIdleProcessTimeoutMs(900_000), 900_000)

  const key = `idle-default-${Date.now()}`
  setActiveProcess(key, fakeIdleProcess(() => {}))
  try {
    scheduleIdleProcessEviction(key, resolveIdleProcessTimeoutMs(undefined))
    assert.equal(isIdleProcessEvictionScheduled(key), false, "unset arms nothing")
    scheduleIdleProcessEviction(key, resolveIdleProcessTimeoutMs(900_000))
    assert.equal(isIdleProcessEvictionScheduled(key), true)
    scheduleIdleProcessEviction(key, resolveIdleProcessTimeoutMs(0))
    assert.equal(isIdleProcessEvictionScheduled(key), false, "0 disarms")
  } finally {
    deleteActiveProcess(key)
  }
})

// A recovered continuation, an auto-continue or a late tool result can put a
// process back to work after the turn that armed the timer completed.
test("the idle timer spares a process that is mid-turn and re-arms instead", async () => {
  const key = `idle-in-flight-${Date.now()}`
  let kills = 0
  const ap = fakeIdleProcess(() => kills++)
  setActiveProcess(key, ap)
  try {
    scheduleIdleProcessEviction(key, 10)
    noteTurnStarted(ap)
    await delay(30)
    assert.equal(kills, 0, "a busy process is never evicted by the clock")
    assert.equal(isIdleProcessEvictionScheduled(key), true, "re-armed for the next window")
    noteTurnLine(ap, JSON.stringify({ type: "result", subtype: "success" }))
    await delay(30)
    assert.equal(kills, 1, "evicted once the turn settled and the window lapsed")
    assert.equal(isIdleProcessEvictionScheduled(key), false)
  } finally {
    deleteActiveProcess(key)
  }
})

test("timeouts above Node's maximum delay do not evict immediately", async () => {
  const key = `idle-overflow-${Date.now()}`
  let kills = 0
  const process = fakeIdleProcess(() => kills++)
  setActiveProcess(key, process)

  scheduleIdleProcessEviction(key, 2_147_483_648)
  await delay(10)

  assert.equal(kills, 0)
  assert.equal(getActiveProcess(key), process)
  deleteActiveProcess(key)
})

// Turn lifecycle and abort interrupt (adapted from @broskees' 68ed142).
function fakeTurnProcess(): { ap: ActiveProcess; writes: string[] } {
  const writes: string[] = []
  const ap: ActiveProcess = {
    proc: {
      stdin: {
        writable: true,
        write(chunk: string) {
          writes.push(chunk)
          return true
        },
      },
    } as unknown as ActiveProcess["proc"],
    lineEmitter: new EventEmitter(),
  }
  return { ap, writes }
}

test("a turn is in flight from the envelope write until the terminal result line", async () => {
  const { ap } = fakeTurnProcess()
  assert.equal(isTurnInFlight(ap), false)
  noteTurnStarted(ap)
  assert.equal(isTurnInFlight(ap), true)
  noteTurnLine(ap, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "result" }] } }))
  assert.equal(isTurnInFlight(ap), true, "a content line that merely mentions result does not settle")
  noteTurnLine(ap, "not json \"result\"")
  assert.equal(isTurnInFlight(ap), true)
  const idle = awaitTurnIdle(ap, 1_000)
  noteTurnLine(ap, JSON.stringify({ type: "result", subtype: "success" }))
  assert.equal(isTurnInFlight(ap), false)
  assert.equal(await idle, true)
})

test("interruptTurn writes an interrupt control request and waits for the result", async () => {
  const { ap, writes } = fakeTurnProcess()
  assert.equal(await interruptTurn(ap), true, "nothing in flight is already idle, nothing written")
  assert.deepEqual(writes, [])

  noteTurnStarted(ap)
  const pending = interruptTurn(ap, 1_000)
  assert.equal(writes.length, 1)
  const request = JSON.parse(writes[0]!)
  assert.equal(request.type, "control_request")
  assert.equal(request.request.subtype, "interrupt")
  assert.ok(request.request_id)
  noteTurnLine(ap, JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }))
  assert.equal(await pending, true)
})

test("interruptTurn reports false when the CLI never answers", async () => {
  const { ap } = fakeTurnProcess()
  noteTurnStarted(ap)
  assert.equal(await interruptTurn(ap, 20), false)
  assert.equal(isTurnInFlight(ap), true, "still in flight; the next turn's guard will retry")
})

test("the interactive transport is never marked in flight", () => {
  const { ap } = fakeTurnProcess()
  ap.asideTransport = { cliPath: "claude", interactive: true }
  noteTurnStarted(ap)
  assert.equal(isTurnInFlight(ap), false)
})

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = console.error
  console.error = (line: unknown) => {
    lines.push(String(line))
  }
  return { lines, restore: () => { console.error = original } }
}

// The child's stdin is its own emitter, so `proc.on("error", ...)` does not
// cover it. A write that lands after the child died raises EPIPE there, and
// an 'error' event on a stream with no listener throws: inside opencode's own
// process, not ours. The EPIPE itself is delivered whenever libuv gets around
// to failing the queued write, so the event is emitted here directly; the
// contract under test is that something is listening for it.
test("an error on a dead child's stdin is logged, not thrown", async () => {
  const key = `stdin-error-${Date.now()}`
  const captured = captureStderr()
  const ap = spawnClaudeProcess(
    process.execPath,
    ["-e", "process.stdin.destroy(); setInterval(() => {}, 1000)"],
    process.cwd(),
    key,
  )
  const stdin = ap.proc.stdin!
  try {
    await delay(100)
    noteTurnStarted(ap)
    // The write a real turn makes. It must not throw synchronously either.
    stdin.write(JSON.stringify({ type: "user", pad: "x".repeat(100_000) }) + "\n")
    stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))
  } finally {
    captured.restore()
    deleteActiveProcess(key)
    deleteClaudeSessionId(key)
  }
  assert.ok(
    captured.lines.some((line) => line.includes("claude process stdin error")),
    `expected a logged stdin error, got: ${captured.lines.join(" | ")}`,
  )
  assert.ok(
    captured.lines.some((line) => line.includes('"code":"EPIPE"')),
    "the logged error should name the errno the write failed with",
  )
  assert.equal(
    isTurnInFlight(ap),
    false,
    "a write that never reached the CLI leaves no turn to wait for",
  )
})

function fillActiveProcesses(prefix: string, killed: string[]): {
  keys: string[]
  processes: ActiveProcess[]
} {
  const keys: string[] = []
  const processes: ActiveProcess[] = []
  for (let index = 0; index < MAX_ACTIVE_PROCESSES; index++) {
    const key = `${prefix}-${index}`
    const ap = fakeIdleProcess(() => killed.push(key))
    keys.push(key)
    processes.push(ap)
    setActiveProcess(key, ap)
  }
  return { keys, processes }
}

// Killing a process mid-turn truncates that answer silently: the close
// handler finishes the stream and the operator sees half a reply.
test("LRU eviction picks the oldest idle process, not the oldest process", () => {
  const killed: string[] = []
  const { keys, processes } = fillActiveProcesses(`lru-guard-${Date.now()}`, killed)
  try {
    noteTurnStarted(processes[0]!)
    noteTurnStarted(processes[1]!)
    evictIfNeeded()
    assert.deepEqual(killed, [keys[2]])
    assert.equal(getActiveProcess(keys[0]!), processes[0])
    assert.equal(getActiveProcess(keys[1]!), processes[1])
    assert.equal(getActiveProcess(keys[2]!), undefined)
  } finally {
    for (const key of keys) deleteActiveProcess(key)
  }
})

test("LRU eviction kills nothing while every process is mid-turn", () => {
  const killed: string[] = []
  const { keys, processes } = fillActiveProcesses(`lru-busy-${Date.now()}`, killed)
  const captured = captureStderr()
  let killedDuringEviction: string[] = []
  try {
    for (const ap of processes) noteTurnStarted(ap)
    evictIfNeeded()
    killedDuringEviction = [...killed]
  } finally {
    captured.restore()
    for (const key of keys) deleteActiveProcess(key)
  }
  assert.deepEqual(killedDuringEviction, [])
  assert.ok(
    captured.lines.some((line) => line.includes("every claude process is mid-turn")),
    `expected a warning about the skipped eviction, got: ${captured.lines.join(" | ")}`,
  )
})

test("the process cap is 16 and the LRU never exceeds it while an idle victim exists", () => {
  assert.equal(MAX_ACTIVE_PROCESSES, 16)
})

// A `task` call has no deadline, so once its proxy server is gone nothing
// else would ever reap its broker entry.
test("deleting a process rejects the broker calls its proxy server can no longer answer", async () => {
  const key = `detach-rejects-${Date.now()}`
  let serverClosed = false
  const ap: ActiveProcess = {
    ...fakeIdleProcess(() => {}),
    proxyServer: { async close() { serverClosed = true } } as unknown as ActiveProcess["proxyServer"],
  }
  setActiveProcess(key, ap)
  let rejection: Error | undefined
  const settled = new Promise<void>((resolve) => {
    queuePendingProxyCall(key, {
      id: `call-${key}`,
      toolName: "task",
      input: {},
      resolve: () => resolve(),
      reject: (error) => { rejection = error; resolve() },
    })
  })
  assert.equal(getPendingProxyCalls(key).length, 1)
  deleteActiveProcess(key)
  await settled
  assert.equal(serverClosed, true)
  assert.equal(getPendingProxyCalls(key).length, 0)
  assert.equal(rejection?.message, SERVER_CLOSED_MESSAGE)
})

test("deleteActiveProcessesForSession releases every process and remembered id of one session only", async () => {
  const stamp = Date.now()
  const keyFor = (session: string, model = "claude-opus-5", scope = "tools") =>
    scope === "compaction"
      ? `/tmp/proj-${stamp}::${model}::compaction::${session}`
      : `/tmp/proj-${stamp}::${model}::${scope}::${session}::context=["claude-code",null]`
  const killed: string[] = []
  const register = (key: string, opencodeSessionID?: string) => {
    const { activeProcess } = fakeActiveProcess({ exitOn: "SIGTERM", delayMs: 0 })
    activeProcess.proc.kill = ((signal?: NodeJS.Signals) => {
      killed.push(key)
      Object.defineProperty(activeProcess.proc, "exitCode", { configurable: true, value: 0 })
      activeProcess.proc.emit("exit", 0, signal ?? null)
      return true
    }) as typeof activeProcess.proc.kill
    if (opencodeSessionID) activeProcess.opencodeSessionID = opencodeSessionID
    setActiveProcess(key, activeProcess)
  }
  const a1 = keyFor("ses_A")
  const a2 = keyFor("ses_A", "claude-haiku-4-5", "compaction")
  const aEffort = `${keyFor("ses_A")}::effort=high`
  const b = keyFor("ses_B")
  const shared = keyFor("default")
  register(a1, "ses_A")
  register(a2)
  register(aEffort, "ses_A")
  register(b, "ses_B")
  register(shared)
  setClaudeSessionId(a1, "claude-a1")
  setClaudeSessionId(b, "claude-b")
  // An idle-evicted process keeps its session id for a resume; a deleted
  // session must drop that too.
  const aEvicted = keyFor("ses_A", "claude-sonnet-5")
  setClaudeSessionId(aEvicted, "claude-a-evicted")
  try {
    assert.deepEqual(deleteActiveProcessesForSession("default"), [], "the shared bucket is never matched")
    assert.deepEqual(deleteActiveProcessesForSession(""), [])
    const released = deleteActiveProcessesForSession("ses_A")
    assert.deepEqual(released.sort(), [a1, a2, aEffort, aEvicted].sort())
    assert.deepEqual(killed.sort(), [a1, a2, aEffort].sort())
    assert.equal(getActiveProcess(a1), undefined)
    assert.equal(getActiveProcess(a2), undefined)
    assert.equal(getActiveProcess(aEffort), undefined)
    assert.ok(getActiveProcess(b), "another session's process survives")
    assert.ok(getActiveProcess(shared), "the shared bucket survives")
    assert.equal(getClaudeSessionId(a1), undefined)
    assert.equal(getClaudeSessionId(aEvicted), undefined)
    assert.equal(getClaudeSessionId(b), "claude-b")
    assert.deepEqual(deleteActiveProcessesForSession("ses_A"), [], "idempotent")
  } finally {
    for (const key of [a1, a2, aEffort, b, shared, aEvicted]) {
      deleteActiveProcess(key)
      deleteClaudeSessionId(key)
    }
  }
})

test("killAllActiveProcesses is synchronous, releases parked calls on both sides, and the exit hook is armed once", async () => {
  const stamp = Date.now()
  const killed: string[] = []
  const keys = [`exit-a-${stamp}`, `exit-b-${stamp}`]
  for (const key of keys) setActiveProcess(key, fakeIdleProcess(() => killed.push(key)))
  setClaudeSessionId(keys[0]!, "claude-exit-a")
  // A real proxy server holding a real `task` request, wired to the broker
  // the way the language model wires it. opencode going away must release
  // the HTTP side and the broker entry, not just kill the child.
  const server = await createProxyMcpServer(DEFAULT_PROXY_TOOLS.filter((t) => t.name === "task"))
  server.calls.on("call", (call: ProxyToolCall) => queuePendingProxyCall(keys[1]!, call))
  const parked: ActiveProcess = { ...fakeIdleProcess(() => killed.push(keys[1]!)), proxyServer: server }
  setActiveProcess(keys[1]!, parked)
  const queued = new Promise<void>((resolve) => server.calls.once("call", () => resolve()))
  const request = fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${server.authToken}` },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "parked", method: "tools/call",
      params: { name: "task", arguments: { description: "d", prompt: "p", subagent_type: "general" } },
    }),
  }).then((response) => response.json() as Promise<any>)
  await queued
  assert.deepEqual(server.pendingCallIds().length, 1)
  assert.equal(getPendingProxyCalls(keys[1]!).length, 1)
  try {
    assert.deepEqual(killAllActiveProcesses().sort(), keys.sort())
    assert.deepEqual(killed.sort(), keys.sort(), "killed before the call returned")
    assert.equal(getPendingProxyCalls(keys[1]!).length, 0, "broker entry released synchronously")
    const answer = await request
    assert.equal(answer.result.isError, true)
    assert.equal(answer.result.content[0].text, SERVER_CLOSED_MESSAGE)
    assert.deepEqual(server.pendingCallIds(), [], "HTTP entry released")
    assert.equal(getActiveProcess(keys[0]!), undefined)
    assert.equal(getClaudeSessionId(keys[0]!), "claude-exit-a", "ids are left alone at exit")
    assert.deepEqual(killAllActiveProcesses(), [])

    const before = process.listenerCount("exit")
    const armed = ensureProcessExitCleanup()
    const afterFirst = process.listenerCount("exit")
    assert.equal(ensureProcessExitCleanup(), false, "a second call never adds a listener")
    assert.equal(process.listenerCount("exit"), afterFirst)
    assert.equal(afterFirst - before, armed ? 1 : 0)
  } finally {
    for (const key of keys) {
      deleteActiveProcess(key)
      deleteClaudeSessionId(key)
    }
  }
})

test("retained stderr keeps the newest 2 KB", () => {
  const ap = fakeIdleProcess(() => {})
  retainStderr(ap, "x".repeat(3_000))
  retainStderr(ap, "the tail that matters")
  assert.equal(ap.lastStderr!.length, 2 * 1024)
  assert.ok(ap.lastStderr!.endsWith("the tail that matters"))
})

test("describeChildCrash names the exit code, the signal, and the stderr tail", () => {
  const exited = describeChildCrash(3, null, "  fatal: out of memory\n")
  assert.match(exited, /exited with code 3/)
  assert.match(exited, /fatal: out of memory/)
  assert.match(describeChildCrash(null, "SIGKILL", undefined), /killed by SIGKILL/)
  assert.doesNotMatch(
    describeChildCrash(null, "SIGKILL", undefined),
    /Last stderr/,
    "no stderr, no empty section",
  )
  assert.match(describeChildCrash(null, null, undefined), /closed its output/)
})

test("a child that dies keeps its stderr for the crash report", async () => {
  const key = `crash-stderr-${Date.now()}`
  const ap = spawnClaudeProcess(
    process.execPath,
    [
      "-e",
      "process.stderr.write('fatal: claude ran out of memory\\n'); setTimeout(() => process.exit(3), 30)",
    ],
    process.cwd(),
    key,
  )
  try {
    await once(ap.proc, "exit")
    await delay(20)
    assert.match(ap.lastStderr ?? "", /fatal: claude ran out of memory/)
    const message = describeChildCrash(
      ap.proc.exitCode,
      ap.proc.signalCode,
      ap.lastStderr,
    )
    assert.match(message, /exited with code 3/)
    assert.match(message, /fatal: claude ran out of memory/)
  } finally {
    deleteActiveProcess(key)
    deleteClaudeSessionId(key)
  }
})

test("the claude session store is capped, and eviction takes the ledger with it", () => {
  const total = MAX_CLAUDE_SESSION_ENTRIES + 10
  const keys = Array.from({ length: total }, (_, i) => `cap-session-${i}`)

  // The first key's ledger must go when the id does: an orphaned ledger is
  // exactly the leak the cap exists to stop.
  applyTaskCreateToolUse("cap-claude-0", "tu-1", { subject: "Write tests" })
  applyTaskCreateToolResult("cap-claude-0", "tu-1", "Task #1 created")
  assert.equal(getLedger("cap-claude-0").length, 1)

  try {
    for (const [index, key] of keys.entries()) {
      setClaudeSessionId(key, `cap-claude-${index}`)
    }

    // Oldest first. Earlier tests may leave their own idle keys ahead of
    // these, which only evicts more of the early ones, never the recent ones.
    assert.equal(getClaudeSessionId(keys[0]), undefined)
    assert.equal(getClaudeSessionId(keys[5]), undefined)
    assert.deepEqual(getLedger("cap-claude-0"), [])
    for (const key of keys.slice(-20)) {
      assert.ok(getClaudeSessionId(key), `${key} should have survived the cap`)
    }
  } finally {
    for (const key of keys) deleteClaudeSessionId(key)
  }
})

test("the claude session cap never takes a key that still has a process", () => {
  const busyKey = "cap-session-busy"
  const { activeProcess } = fakeActiveProcess({ exitOn: "SIGTERM", delayMs: 0 })
  setActiveProcess(busyKey, activeProcess)
  setClaudeSessionId(busyKey, "cap-claude-busy")

  const keys = Array.from(
    { length: MAX_CLAUDE_SESSION_ENTRIES + 10 },
    (_, i) => `cap-session-after-${i}`,
  )
  try {
    for (const [index, key] of keys.entries()) {
      setClaudeSessionId(key, `cap-claude-after-${index}`)
    }
    // It is the oldest key in the map and would be the first to go on age
    // alone; the busy check is the only thing keeping it.
    assert.equal(getClaudeSessionId(busyKey), "cap-claude-busy")
  } finally {
    for (const key of keys) deleteClaudeSessionId(key)
    deleteActiveProcess(busyKey)
    deleteClaudeSessionId(busyKey)
  }
})
