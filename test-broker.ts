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
  type PendingProxyCall,
} from "./src/proxy-broker.js"
import type { ProxyToolCall, ProxyToolResult } from "./src/proxy-mcp.js"

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
