/**
 * Unit tests for src/proxy-broker.ts — the per-session pending-call
 * registry used to coordinate proxy-mcp HTTP handlers with the language
 * model's stream lifecycle.
 *
 * Usage:
 *   bun test-broker.ts
 *   node --experimental-strip-types --test test-broker.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import {
  queuePendingProxyCall,
  getPendingProxyCalls,
  onPendingProxyCall,
  resolvePendingProxyCallById,
  rejectPendingProxyCallById,
  rejectAllPendingProxyCallsForSession,
  isPendingProxyCallChannelClosed,
  markPendingProxyCallEmitted,
  snapshotPendingProxyCalls,
  PROXY_STALL_WARNING_MS,
  PROXY_DEADLINE_WARNING_FRACTION,
  PROXY_DEADLINE_WARNING_MIN_MS,
  type PendingProxyCall,
} from "./src/proxy-broker.js"
import { configureLogger, _resetLoggerForTests } from "./src/logger.js"
import {
  _setProxyDeadlineRecheckMs,
  armProxyDeadline,
  PROXY_NO_DEADLINE_MS,
  setProxyDeadlineGuard,
  type ProxyToolCall,
  type ProxyToolResult,
} from "./src/proxy-mcp.js"

type CallHandle = {
  id: string
  promise: Promise<ProxyToolResult>
  resolved: boolean
  rejected: boolean
  call: ProxyToolCall
}

let callCounter = 0

function makeCall(toolName: string, input: Record<string, unknown> = {}): CallHandle {
  const id = `call-${++callCounter}`
  const state = {
    id,
    resolved: false,
    rejected: false,
  } as CallHandle
  state.promise = new Promise<ProxyToolResult>((resolve, reject) => {
    state.call = {
      id,
      toolName,
      input,
      resolve: (result) => {
        state.resolved = true
        resolve(result)
      },
      reject: (err) => {
        state.rejected = true
        reject(err)
      },
    }
  })
  // Swallow rejections so test runner doesn't crash on unawaited rejects.
  state.promise.catch(() => {})
  return state
}

test("queue + getPendingProxyCalls returns every queued call in order", () => {
  const sk = `sk-multi-${Date.now()}`
  const a = makeCall("bash", { command: "ls" })
  const b = makeCall("bash", { command: "pwd" })

  queuePendingProxyCall(sk, a.call)
  queuePendingProxyCall(sk, b.call)

  const pending = getPendingProxyCalls(sk)
  assert.equal(pending.length, 2)
  const ids = new Set(pending.map((p) => p.toolCallId))
  assert.ok(ids.has(a.id))
  assert.ok(ids.has(b.id))

  // Clean up
  rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
})

test("resolvePendingProxyCallById resolves only the matching call", async () => {
  const sk = `sk-resolve-${Date.now()}`
  const a = makeCall("bash")
  const b = makeCall("write")

  queuePendingProxyCall(sk, a.call)
  queuePendingProxyCall(sk, b.call)

  const ok = resolvePendingProxyCallById(a.id, { kind: "text", text: "a-result" })
  assert.equal(ok, true)

  const result = await a.promise
  assert.deepEqual(result, { kind: "text", text: "a-result" })

  // b should still be pending
  const remaining = getPendingProxyCalls(sk)
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].toolCallId, b.id)
  assert.equal(b.resolved, false)
  assert.equal(b.rejected, false)

  // Clean up
  rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
})

test("rejectPendingProxyCallById rejects only the matching call", async () => {
  const sk = `sk-reject-${Date.now()}`
  const a = makeCall("bash")
  const b = makeCall("bash")

  queuePendingProxyCall(sk, a.call)
  queuePendingProxyCall(sk, b.call)

  const ok = rejectPendingProxyCallById(a.id, new Error("a-rejected"))
  assert.equal(ok, true)

  await assert.rejects(a.promise, /a-rejected/)
  assert.equal(getPendingProxyCalls(sk).length, 1)

  // Clean up
  rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
})

test("rejectAllPendingProxyCallsForSession rejects every pending call", async () => {
  const sk = `sk-reject-all-${Date.now()}`
  const a = makeCall("bash")
  const b = makeCall("bash")
  const c = makeCall("bash")

  queuePendingProxyCall(sk, a.call)
  queuePendingProxyCall(sk, b.call)
  queuePendingProxyCall(sk, c.call)

  const count = rejectAllPendingProxyCallsForSession(sk, new Error("session gone"))
  assert.equal(count, 3)
  assert.equal(getPendingProxyCalls(sk).length, 0)

  await assert.rejects(a.promise, /session gone/)
  await assert.rejects(b.promise, /session gone/)
  await assert.rejects(c.promise, /session gone/)
})

test("onPendingProxyCall fires once per queued call for the matching session", () => {
  const sk = `sk-onevent-${Date.now()}`
  const otherSk = `sk-other-${Date.now()}`
  const fired: PendingProxyCall[] = []
  const unsubscribe = onPendingProxyCall(sk, (call) => {
    fired.push(call)
  })

  const a = makeCall("bash")
  const b = makeCall("write")
  const c = makeCall("bash") // different session — should not fire

  queuePendingProxyCall(sk, a.call)
  queuePendingProxyCall(sk, b.call)
  queuePendingProxyCall(otherSk, c.call)

  assert.equal(fired.length, 2)
  const firedIds = new Set(fired.map((f) => f.toolCallId))
  assert.ok(firedIds.has(a.id))
  assert.ok(firedIds.has(b.id))
  assert.ok(!firedIds.has(c.id))

  unsubscribe()
  rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
  rejectAllPendingProxyCallsForSession(otherSk, new Error("test cleanup"))
})

test("getPendingProxyCalls is empty for unknown session", () => {
  assert.deepEqual(getPendingProxyCalls(`sk-empty-${Date.now()}`), [])
})

test("resolve / reject on already-resolved id is a no-op returning false", () => {
  const sk = `sk-double-${Date.now()}`
  const a = makeCall("bash")
  queuePendingProxyCall(sk, a.call)

  assert.equal(resolvePendingProxyCallById(a.id, { kind: "text", text: "ok" }), true)
  assert.equal(resolvePendingProxyCallById(a.id, { kind: "text", text: "again" }), false)
  assert.equal(rejectPendingProxyCallById(a.id, new Error("late")), false)
})

test("parallel queue from same session: index reflects every callId", () => {
  const sk = `sk-parallel-${Date.now()}`
  const calls = Array.from({ length: 5 }, () => makeCall("bash"))
  for (const c of calls) queuePendingProxyCall(sk, c.call)

  const pending = getPendingProxyCalls(sk)
  assert.equal(pending.length, 5)
  const ids = new Set(pending.map((p) => p.toolCallId))
  for (const c of calls) assert.ok(ids.has(c.id))

  // Resolve a couple, reject the rest
  resolvePendingProxyCallById(calls[0].id, { kind: "text", text: "0" })
  resolvePendingProxyCallById(calls[2].id, { kind: "text", text: "2" })
  const left = getPendingProxyCalls(sk)
  assert.equal(left.length, 3)

  rejectAllPendingProxyCallsForSession(sk, new Error("cleanup"))
  assert.equal(getPendingProxyCalls(sk).length, 0)
})

// --- per-tool proxy timeouts ------------------------------------------------

test("queuePendingProxyCall honours a short per-tool override", async () => {
  const sk = `sk-timeout-${Date.now()}`
  const a = makeCall("bash")
  queuePendingProxyCall(sk, a.call, { bash: 40 })

  // The override (40ms) must beat the flat 10-min default decisively.
  const t0 = Date.now()
  await assert.rejects(a.promise, /timed out after 40ms/)
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 2000, `rejected too late: ${elapsed}ms`)

  assert.equal(getPendingProxyCalls(sk).length, 0)
})

test("queuePendingProxyCall: task timeout text warns against scheduling a wake-up", async () => {
  const sk = `sk-task-timeout-${Date.now()}`
  const a = makeCall("task")
  queuePendingProxyCall(sk, a.call, { task: 40 })

  await assert.rejects(a.promise, /wake-up/)
})

test("queuePendingProxyCall: a call with no deadline arms no timer and stays pending", async () => {
  // `task` has no default deadline. The broker must not turn 0 into a
  // zero-delay timer (which would reject on the next tick); the call waits
  // until a lifecycle event releases it.
  const sk = `sk-no-deadline-${Date.now()}`
  const a = makeCall("task")
  queuePendingProxyCall(sk, a.call)
  const b = makeCall("bash")
  queuePendingProxyCall(sk, b.call, { bash: 0 })

  await new Promise((r) => setTimeout(r, 60))
  assert.equal(a.rejected, false, "task must not time out")
  assert.equal(b.rejected, false, "a 0 override disables the bash deadline")
  const snapshot = snapshotPendingProxyCalls().filter((c) => c.sessionKey === sk)
  assert.deepEqual(
    snapshot.map((c) => c.deadlineMs),
    [PROXY_NO_DEADLINE_MS, PROXY_NO_DEADLINE_MS],
    "the doctor sees 0 as the deadline",
  )

  // The next user turn's orphan sweep is one such lifecycle event.
  assert.equal(rejectAllPendingProxyCallsForSession(sk, new Error("orphaned")), 2)
  await assert.rejects(a.promise, /orphaned/)
  await assert.rejects(b.promise, /orphaned/)
  assert.equal(getPendingProxyCalls(sk).length, 0)
})

test("queuePendingProxyCall: bash input.timeout keeps the call alive past a shorter override", async () => {
  // Override 40ms, but the caller asked for a 30s bash timeout — the
  // effective deadline is 30s, so resolving at ~80ms must succeed rather
  // than the call having already timed out.
  const sk = `sk-bash-input-${Date.now()}`
  const a = makeCall("bash", { command: "build", timeout: 30000 })
  queuePendingProxyCall(sk, a.call, { bash: 40 })

  // Wait past the override deadline to prove input.timeout governs.
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(a.rejected, false, "must not have timed out at the override")

  const ok = resolvePendingProxyCallById(a.id, { kind: "text", text: "ok" })
  assert.equal(ok, true)
  const result = await a.promise
  assert.deepEqual(result, { kind: "text", text: "ok" })
})

test("queuePendingProxyCall with a duplicate callId replaces the old entry cleanly", async () => {
  // Defensive path: a duplicate id (UUID collision / retry storm) must
  // reject the FIRST promise with "Replaced", clear its timer, and leave
  // exactly one pending entry (the new one). A leaked double-entry would
  // risk a double-fire on timeout.
  const sk = `sk-replace-${Date.now()}`
  const dupId = `dup-${Date.now()}`
  const first: CallHandle = (() => {
    const state = { id: dupId, resolved: false, rejected: false } as CallHandle
    state.promise = new Promise<ProxyToolResult>((resolve, reject) => {
      state.call = {
        id: dupId,
        toolName: "bash",
        input: {},
        resolve: (r) => {
          state.resolved = true
          resolve(r)
        },
        reject: (e) => {
          state.rejected = true
          reject(e)
        },
      }
    })
    state.promise.catch(() => {})
    return state
  })()
  const second = makeCall("bash")

  queuePendingProxyCall(sk, first.call)
  queuePendingProxyCall(sk, second.call)
  // Reuse the same id on a freshly-made call to trigger the replace path.
  const secondWithDupId = { ...makeCall("bash").call, id: dupId }
  queuePendingProxyCall(sk, secondWithDupId)

  await assert.rejects(first.promise, /Replaced pending proxy call/)

  // Exactly one pending entry for that id, and it is the latest call.
  const pending = getPendingProxyCalls(sk)
  const matching = pending.filter((p) => p.toolCallId === dupId)
  assert.equal(matching.length, 1, "only one entry for the replaced id")

  rejectAllPendingProxyCallsForSession(sk, new Error("cleanup"))
})

test("queuePendingProxyCall carries the channel and markPendingProxyCallEmitted flags the entry", () => {
  const handle = makeCall("task")
  handle.call.channel = { closed: false }
  const pending = queuePendingProxyCall("sess-channel", handle.call)
  assert.equal(isPendingProxyCallChannelClosed(pending), false)
  assert.equal(pending.emitted, undefined)
  markPendingProxyCallEmitted(handle.id)
  assert.equal(getPendingProxyCalls("sess-channel")[0].emitted, true)
  handle.call.channel.closed = true
  assert.equal(isPendingProxyCallChannelClosed(pending), true)
  resolvePendingProxyCallById(handle.id, { kind: "text", text: "ok" })
})

test("isPendingProxyCallChannelClosed treats a call without a channel as open", () => {
  const handle = makeCall("bash")
  const pending = queuePendingProxyCall("sess-no-channel", handle.call)
  assert.equal(isPendingProxyCallChannelClosed(pending), false)
  resolvePendingProxyCallById(handle.id, { kind: "text", text: "ok" })
})

// --- stall warning for calls with no deadline -----------------------------

/** Like test-cli-args.ts's helper, but it spans awaits. */
async function captureLogsAsync(
  fn: (lines: readonly string[]) => Promise<void>,
): Promise<string[]> {
  const lines: string[] = []
  const original = console.error
  console.error = (line: unknown) => {
    lines.push(String(line))
  }
  try {
    _resetLoggerForTests()
    configureLogger({ mode: "debug", level: "debug" })
    await fn(lines)
  } finally {
    console.error = original
    _resetLoggerForTests()
  }
  return lines
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

function stallLines(lines: string[]): string[] {
  return lines.filter((line) => line.includes("proxy call still waiting"))
}

test("a call with no deadline warns repeatedly while it waits", async () => {
  const handle = makeCall("task")
  const lines = await captureLogsAsync(async () => {
    const pending = queuePendingProxyCall("sess-stall", handle.call, undefined, 15)
    assert.equal(pending.deadlineMs, PROXY_NO_DEADLINE_MS, "task has no deadline")
    await pause(55)
  })
  const warnings = stallLines(lines)
  assert.ok(warnings.length >= 2, `expected repeats, got ${warnings.length}`)
  assert.match(warnings[0]!, /WARN/)
  assert.match(warnings[0]!, new RegExp(handle.id))
  assert.match(warnings[0]!, /"toolName":"task"/)
  assert.match(warnings[0]!, /waitedMs/)
  rejectAllPendingProxyCallsForSession("sess-stall", new Error("cleanup"))
})

test("resolving a call stops its stall warnings", async () => {
  const handle = makeCall("task")
  const lines = await captureLogsAsync(async () => {
    queuePendingProxyCall("sess-stall-stop", handle.call, undefined, 15)
    await pause(25)
    resolvePendingProxyCallById(handle.id, { kind: "text", text: "done" })
    await pause(60)
  })
  // One heartbeat before the result, none after: the interval was cleared
  // rather than left running against a deleted entry.
  assert.equal(stallLines(lines).length, 1, stallLines(lines).join("\n"))
  assert.equal(getPendingProxyCalls("sess-stall-stop").length, 0)
})

test("rejecting a call stops its stall warnings", async () => {
  const handle = makeCall("task_batch")
  const lines = await captureLogsAsync(async () => {
    queuePendingProxyCall("sess-stall-reject", handle.call, undefined, 15)
    await pause(25)
    rejectPendingProxyCallById(handle.id, new Error("aborted"))
    await pause(60)
  })
  assert.equal(stallLines(lines).length, 1, stallLines(lines).join("\n"))
  await handle.promise.catch(() => undefined)
})

test("a call that has a deadline is never armed, since the deadline reports it", async () => {
  const handle = makeCall("bash", { command: "sleep 1" })
  const lines = await captureLogsAsync(async () => {
    const pending = queuePendingProxyCall("sess-stall-deadline", handle.call, undefined, 15)
    assert.ok(pending.deadlineMs > PROXY_NO_DEADLINE_MS, "bash has a deadline")
    await pause(55)
  })
  assert.deepEqual(stallLines(lines), [])
  rejectAllPendingProxyCallsForSession("sess-stall-deadline", new Error("cleanup"))
})

test("stallWarningMs of 0 arms nothing", async () => {
  const handle = makeCall("task")
  const lines = await captureLogsAsync(async () => {
    queuePendingProxyCall("sess-stall-off", handle.call, undefined, 0)
    await pause(40)
  })
  assert.deepEqual(stallLines(lines), [])
  rejectAllPendingProxyCallsForSession("sess-stall-off", new Error("cleanup"))
})

test("the shipped threshold is 5 minutes", () => {
  assert.equal(PROXY_STALL_WARNING_MS, 5 * 60_000)
})

// --- one notice before a deadline takes the call --------------------------

function deadlineLines(lines: string[]): string[] {
  return lines.filter((line) => line.includes("deadline approaching"))
}

test("a deadline-bearing call warns once, before the deadline rejects it", async () => {
  const handle = makeCall("bash", {})
  const lines = await captureLogsAsync(async (live) => {
    // 200 ms deadline with the minimum lowered to 1 ms, so it arms and warns
    // at 60 percent, which is 120 ms.
    queuePendingProxyCall("sess-warn", handle.call, { bash: 200 }, 0, 1)
    await pause(160)
    // Warned, and the call is still alive: the point is a notice BEFORE
    // death, so both halves are asserted while it is still pending.
    assert.equal(deadlineLines([...live]).length, 1, "expected exactly one notice")
    assert.equal(getPendingProxyCalls("sess-warn").length, 1, "still pending")
    await pause(120)
  })
  const warnings = deadlineLines(lines)
  assert.equal(warnings.length, 1, "one-shot, never repeating")
  assert.match(warnings[0]!, /WARN/)
  assert.match(warnings[0]!, new RegExp(handle.id))
  assert.match(warnings[0]!, /"remainingMs":/)
  assert.match(warnings[0]!, /proxyToolTimeoutMs/)
  // The deadline still did its job afterwards.
  assert.equal(getPendingProxyCalls("sess-warn").length, 0)
  await handle.promise.catch(() => undefined)
})

test("resolving before the warning point means no notice at all", async () => {
  const handle = makeCall("bash", {})
  const lines = await captureLogsAsync(async () => {
    queuePendingProxyCall("sess-warn-fast", handle.call, { bash: 200 }, 0, 1)
    await pause(30)
    resolvePendingProxyCallById(handle.id, { kind: "text", text: "quick" })
    await pause(160)
  })
  assert.deepEqual(deadlineLines(lines), [])
})

test("a short deadline is not armed: the notice would arrive with the rejection", async () => {
  const handle = makeCall("bash", {})
  const lines = await captureLogsAsync(async () => {
    // Real minimum this time, so a 200 ms deadline is below the floor.
    queuePendingProxyCall("sess-warn-short", handle.call, { bash: 200 }, 0)
    await pause(280)
  })
  assert.deepEqual(deadlineLines(lines), [])
  await handle.promise.catch(() => undefined)
})

test("a call with no deadline gets the heartbeat, never this notice", async () => {
  const handle = makeCall("task")
  const lines = await captureLogsAsync(async () => {
    queuePendingProxyCall("sess-warn-none", handle.call, undefined, 15, 1)
    await pause(55)
  })
  assert.deepEqual(deadlineLines(lines), [])
  assert.ok(stallLines(lines).length >= 2, "heartbeat still runs")
  rejectAllPendingProxyCallsForSession("sess-warn-none", new Error("cleanup"))
})

test("the shipped notice point is 60 percent, with a one minute floor", () => {
  assert.equal(PROXY_DEADLINE_WARNING_FRACTION, 0.6)
  assert.equal(PROXY_DEADLINE_WARNING_MIN_MS, 60_000)
})

// ---------------------------------------------------------------------------
// Deadline guard: a call opencode is still serving outlives its deadline
// ---------------------------------------------------------------------------

test("a deadline defers to the guard while opencode is still serving the call", async () => {
  const sk = `sk-guard-${Date.now()}`
  let serving = true
  let asked = 0
  setProxyDeadlineGuard(async () => {
    asked++
    return serving
  })
  _setProxyDeadlineRecheckMs(30)
  try {
    const a = makeCall("bash")
    queuePendingProxyCall(sk, a.call, { bash: 40 })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(a.rejected, false, "a permission prompt still open must not end the call")
    assert.equal(getPendingProxyCalls(sk).length, 1)
    assert.ok(asked >= 3, `re-asked while it waits (asked ${asked} times)`)

    serving = false
    await assert.rejects(a.promise, /timed out after 40ms/)
    assert.equal(getPendingProxyCalls(sk).length, 0)
  } finally {
    setProxyDeadlineGuard(null)
    _setProxyDeadlineRecheckMs(null)
  }
})

test("a result arriving while a deadline is extended resolves and stops the rechecks", async () => {
  const sk = `sk-guard-resolve-${Date.now()}`
  let asked = 0
  setProxyDeadlineGuard(async () => {
    asked++
    return true
  })
  _setProxyDeadlineRecheckMs(20)
  try {
    const a = makeCall("bash")
    queuePendingProxyCall(sk, a.call, { bash: 20 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(resolvePendingProxyCallById(a.id, { content: [{ type: "text", text: "ok" }] } as any), true)
    await a.promise
    const after = asked
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(asked, after, "no recheck runs for a call that is gone")
  } finally {
    setProxyDeadlineGuard(null)
    _setProxyDeadlineRecheckMs(null)
  }
})

test("a guard that throws ends the call at its deadline, as with no guard", async () => {
  const sk = `sk-guard-throws-${Date.now()}`
  setProxyDeadlineGuard(async () => {
    throw new Error("status route down")
  })
  try {
    const a = makeCall("bash")
    queuePendingProxyCall(sk, a.call, { bash: 30 })
    await assert.rejects(a.promise, /timed out after 30ms/)
  } finally {
    setProxyDeadlineGuard(null)
  }
})

test("a cancelled deadline never asks and never expires", async () => {
  let asked = 0
  let expired = false
  setProxyDeadlineGuard(async () => {
    asked++
    return false
  })
  try {
    const deadline = armProxyDeadline({
      callId: "c-cancel",
      toolName: "bash",
      deadlineMs: 20,
      onExpire: () => {
        expired = true
      },
    })
    deadline.cancel()
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(asked, 0)
    assert.equal(expired, false)
  } finally {
    setProxyDeadlineGuard(null)
  }
})
