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
  getActiveProcess,
  getClaudeSessionId,
  scheduleIdleProcessEviction,
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
