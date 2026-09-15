import assert from "node:assert/strict"
import { EventEmitter, once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"
import { test } from "node:test"
import { spawn, type ChildProcess } from "node:child_process"
import {
  buildCliArgs,
  deleteActiveProcess,
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  describeChildCrash,
  evictIfNeeded,
  getActiveProcess,
  getClaudeSessionId,
  MAX_ACTIVE_PROCESSES,
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
