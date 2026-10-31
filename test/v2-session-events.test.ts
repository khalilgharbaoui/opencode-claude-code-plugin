/**
 * opencode 2's session events (h #g253): the run-state map the V2 entry feeds
 * from `ctx.event.subscribe()`, what reads it (`fetchSessionRunState`, and so
 * the proxy deadline guard and the background-task checks), and the release of
 * a stopped turn's parked proxy calls. The shapes are the ones measured on a
 * live opencode 2.0.31: `session.execution.started` / `succeeded` /
 * `interrupted` (with `reason`), and no `session.status` at all.
 *
 * Usage: npx tsx --test test/v2-session-events.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { test } from "node:test"
import { isProxyCallStillServed } from "../src/claude-code-language-model.js"
import {
  getPendingProxyCalls,
  markPendingProxyCallEmitted,
  queuePendingProxyCall,
  rejectAllPendingProxyCallsForSession,
} from "../src/proxy-broker.js"
import { _setProxyDeadlineRecheckMs, type ProxyToolCall, type ProxyToolResult } from "../src/proxy-mcp.js"
import {
  _resetSessionRunEventsForTests,
  busySessionsFromEvents,
  fetchSessionRunState,
  noteSessionRunEvent,
  openSessionRunEventFeed,
  sessionRunStateFromEvents,
  setOpencodeClient,
} from "../src/runtime-status.js"
import {
  deleteActiveProcess,
  getActiveProcess,
  noteTurnLine,
  releaseParkedProxyCallsForSession,
  setActiveProcess,
  spawnClaudeProcess,
  STOPPED_TURN_MESSAGE,
  type ActiveProcess,
} from "../src/session-manager.js"
import type { V2Event } from "../src/opencode-v2-types.js"
import {
  _joinForeignRelayMemberForTests,
  _openForeignRelayFollowerForTests,
  _resetSessionEventRelayForTests,
  _sessionEventRelaySizeForTests,
  relaySessionEvent,
} from "../src/session-event-relay.js"
import { followSessionEvents, stoppedSessionIdV2 } from "../src/v2.js"

const started = (sessionID: string) => ({ type: "session.execution.started", data: { sessionID } })
const ended = (sessionID: string, how: "succeeded" | "failed" | "interrupted" = "succeeded", reason = "user") => ({
  type: `session.execution.${how}`,
  data: how === "interrupted" ? { sessionID, reason } : { sessionID },
})
const keyFor = (affinity: string) => `/tmp/v2-events::claude-haiku-4-5::tools::${affinity}::context=["claude-code","build"]`

function freshFeed(): () => void {
  _resetSessionRunEventsForTests()
  return openSessionRunEventFeed()
}

type CallHandle = { call: ProxyToolCall; promise: Promise<ProxyToolResult>; rejected?: Error }

let callCounter = 0
function makeCall(toolName = "bash"): CallHandle {
  const handle = {} as CallHandle
  handle.promise = new Promise<ProxyToolResult>((resolve, reject) => {
    handle.call = {
      id: `v2-events-call-${++callCounter}`,
      toolName,
      input: {},
      resolve,
      reject: (error) => {
        handle.rejected = error
        reject(error)
      },
    }
  })
  handle.promise.catch(() => undefined)
  return handle
}

/** A headless `claude` parked in a proxied call: no stream attached, a turn in flight. */
function parkedProcess(affinity: string): { ap: ActiveProcess; writes: string[] } {
  const writes: string[] = []
  const stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write: (chunk: string) => {
      writes.push(chunk)
      return true
    },
  })
  const proc = Object.assign(new EventEmitter(), {
    pid: 4343,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: () => true,
    stdin,
    stdout: null,
  })
  const ap: ActiveProcess = {
    proc: proc as unknown as ChildProcess,
    lineEmitter: new EventEmitter(),
    opencodeSessionID: affinity,
    turnInFlight: true,
  }
  setActiveProcess(keyFor(affinity), ap)
  return { ap, writes }
}

function dropProcess(affinity: string): void {
  try {
    deleteActiveProcess(keyFor(affinity))
  } catch {
    // the fake has no real handles
  }
}

test("with no feed open every session reads unknown, and events change nothing", () => {
  _resetSessionRunEventsForTests()
  noteSessionRunEvent(started("ses_a"))
  assert.equal(sessionRunStateFromEvents("ses_a"), "unknown")
  assert.equal(busySessionsFromEvents(), undefined)
})

test("an execution start reads busy and its end reads idle, however it ended", () => {
  const close = freshFeed()
  try {
    assert.equal(sessionRunStateFromEvents("ses_a"), "unknown", "not seen yet")
    for (const how of ["succeeded", "failed", "interrupted"] as const) {
      noteSessionRunEvent(started("ses_a"))
      assert.equal(sessionRunStateFromEvents("ses_a"), "busy")
      noteSessionRunEvent(ended("ses_a", how))
      assert.equal(sessionRunStateFromEvents("ses_a"), "idle", how)
    }
  } finally {
    close()
  }
})

test("session.status and session.idle are read too, as opencode 1's map reads them", () => {
  const close = freshFeed()
  try {
    noteSessionRunEvent({ type: "session.status", data: { sessionID: "ses_s", status: { type: "busy" } } })
    assert.equal(sessionRunStateFromEvents("ses_s"), "busy")
    noteSessionRunEvent({ type: "session.status", data: { sessionID: "ses_s", status: { type: "idle" } } })
    assert.equal(sessionRunStateFromEvents("ses_s"), "idle")
    noteSessionRunEvent({ type: "session.status", data: { sessionID: "ses_s", status: { type: "retry", attempt: 1 } } })
    assert.equal(sessionRunStateFromEvents("ses_s"), "busy", "a retry is a turn still running")
    noteSessionRunEvent({ type: "session.idle", data: { sessionID: "ses_s" } })
    assert.equal(sessionRunStateFromEvents("ses_s"), "idle")
  } finally {
    close()
  }
})

test("events with no session, the default bucket, or another type change nothing", () => {
  const close = freshFeed()
  try {
    noteSessionRunEvent({ type: "session.execution.started", data: {} })
    noteSessionRunEvent({ type: "session.execution.started", data: { sessionID: "default" } })
    noteSessionRunEvent({ type: "session.step.started", data: { sessionID: "ses_x" } })
    noteSessionRunEvent({ type: "session.status", data: { sessionID: "ses_x", status: {} } })
    noteSessionRunEvent(null)
    noteSessionRunEvent("session.execution.started")
    assert.equal(sessionRunStateFromEvents("default"), "unknown")
    assert.equal(sessionRunStateFromEvents("ses_x"), "unknown")
    assert.deepEqual(busySessionsFromEvents(), {})
  } finally {
    close()
  }
})

test("closing any feed forgets everything, because what it missed could leave a stale busy", () => {
  _resetSessionRunEventsForTests()
  const first = openSessionRunEventFeed()
  const second = openSessionRunEventFeed()
  noteSessionRunEvent(started("ses_a"))
  assert.equal(sessionRunStateFromEvents("ses_a"), "busy")
  first()
  assert.equal(sessionRunStateFromEvents("ses_a"), "unknown", "one feed is still open, but nothing is trusted")
  first()
  noteSessionRunEvent(started("ses_a"))
  assert.equal(sessionRunStateFromEvents("ses_a"), "busy", "the open feed teaches it again; closing twice is a no-op")
  second()
  assert.equal(sessionRunStateFromEvents("ses_a"), "unknown")
  noteSessionRunEvent(started("ses_a"))
  assert.equal(sessionRunStateFromEvents("ses_a"), "unknown", "no feed, no learning")
})

test("a deleted session is forgotten, not left to the cap", () => {
  const close = freshFeed()
  try {
    noteSessionRunEvent(started("ses_gone"))
    noteSessionRunEvent({ type: "session.deleted", data: { sessionID: "ses_gone" } })
    assert.equal(sessionRunStateFromEvents("ses_gone"), "unknown")
    assert.deepEqual(busySessionsFromEvents(), {})
  } finally {
    close()
  }
})

test("busySessionsFromEvents lists the busy sessions in opencode 1's status-map shape", () => {
  const close = freshFeed()
  try {
    noteSessionRunEvent(started("ses_a"))
    noteSessionRunEvent(started("ses_b"))
    noteSessionRunEvent(ended("ses_b"))
    assert.deepEqual(busySessionsFromEvents(), { ses_a: { type: "busy" } })
  } finally {
    close()
  }
})

test("fetchSessionRunState answers from the events on a client with no status route, never on one with it", async () => {
  const close = freshFeed()
  try {
    noteSessionRunEvent(started("ses_route"))
    setOpencodeClient({})
    assert.equal(await fetchSessionRunState("ses_route"), "busy")
    assert.equal(await fetchSessionRunState("ses_unseen"), "unknown")
    assert.equal(await fetchSessionRunState("default"), "unknown")
    // opencode 1: its own map wins, and it says idle.
    setOpencodeClient({ session: { status: async () => ({ data: {} }) } })
    assert.equal(await fetchSessionRunState("ses_route"), "idle")
  } finally {
    setOpencodeClient(null)
    close()
  }
})

test("the proxy deadline guard keeps a call opencode reports busy through its events, and ends it once idle", async () => {
  const close = freshFeed()
  const key = keyFor("ses_guard")
  setOpencodeClient({})
  _setProxyDeadlineRecheckMs(30)
  try {
    const handle = makeCall("bash")
    queuePendingProxyCall(key, handle.call, { bash: 40 })
    markPendingProxyCallEmitted(handle.call.id)
    assert.equal(await isProxyCallStillServed(handle.call.id), false, "unknown is not served")
    noteSessionRunEvent(started("ses_guard"))
    assert.equal(await isProxyCallStillServed(handle.call.id), true)
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(handle.rejected, undefined, "a permission prompt still open must not end the call")
    assert.equal(getPendingProxyCalls(key).length, 1)
    noteSessionRunEvent(ended("ses_guard"))
    await assert.rejects(handle.promise, /timed out after 40ms/)
    assert.equal(getPendingProxyCalls(key).length, 0)
  } finally {
    rejectAllPendingProxyCallsForSession(key, new Error("test cleanup"))
    _setProxyDeadlineRecheckMs(null)
    setOpencodeClient(null)
    close()
  }
})

test("a stopped session's parked calls are rejected and its claude turn is interrupted, once", async () => {
  const { ap, writes } = parkedProcess("ses_stop")
  const key = keyFor("ses_stop")
  try {
    const handle = makeCall("bash")
    queuePendingProxyCall(key, handle.call)
    assert.deepEqual(releaseParkedProxyCallsForSession("ses_stop"), [key])
    await assert.rejects(handle.promise, new RegExp(STOPPED_TURN_MESSAGE))
    assert.equal(getPendingProxyCalls(key).length, 0)
    assert.equal(writes.length, 1)
    assert.deepEqual(JSON.parse(writes[0]!).request, { subtype: "interrupt" })
    // The CLI answers the interrupt with a terminal result.
    noteTurnLine(ap, JSON.stringify({ type: "result", subtype: "error_during_execution" }))
    assert.deepEqual(releaseParkedProxyCallsForSession("ses_stop"), [], "the same event twice is a no-op")
    assert.equal(writes.length, 1)
    assert.ok(getActiveProcess(key), "the process stays for the next message")
  } finally {
    rejectAllPendingProxyCallsForSession(key, new Error("test cleanup"))
    dropProcess("ses_stop")
  }
})

test("a turn that is streaming owns its calls, and other sessions are never touched", () => {
  const { ap } = parkedProcess("ses_streaming")
  const other = parkedProcess("ses_other")
  const streamingKey = keyFor("ses_streaming")
  const otherKey = keyFor("ses_other")
  try {
    ap.lineEmitter.on("line", () => undefined)
    const mine = makeCall("bash")
    const theirs = makeCall("bash")
    queuePendingProxyCall(streamingKey, mine.call)
    queuePendingProxyCall(otherKey, theirs.call)
    assert.deepEqual(releaseParkedProxyCallsForSession("ses_streaming"), [])
    assert.equal(getPendingProxyCalls(streamingKey).length, 1)
    assert.equal(getPendingProxyCalls(otherKey).length, 1)
    assert.deepEqual(releaseParkedProxyCallsForSession("default"), [])
    assert.deepEqual(releaseParkedProxyCallsForSession(""), [])
    assert.equal(other.writes.length, 0)
  } finally {
    rejectAllPendingProxyCallsForSession(streamingKey, new Error("test cleanup"))
    rejectAllPendingProxyCallsForSession(otherKey, new Error("test cleanup"))
    dropProcess("ses_streaming")
    dropProcess("ses_other")
  }
})

test("stoppedSessionIdV2 reads only an operator's stop", () => {
  assert.equal(stoppedSessionIdV2(ended("ses_1", "interrupted", "user")), "ses_1")
  assert.equal(stoppedSessionIdV2(ended("ses_1", "interrupted", "shutdown")), undefined)
  assert.equal(stoppedSessionIdV2(ended("ses_1", "interrupted", "superseded")), undefined)
  assert.equal(stoppedSessionIdV2(ended("ses_1", "interrupted", "inactivity")), undefined)
  assert.equal(stoppedSessionIdV2(ended("ses_1", "succeeded")), undefined)
  assert.equal(stoppedSessionIdV2({ type: "session.execution.interrupted", data: { reason: "user" } }), undefined)
  assert.equal(stoppedSessionIdV2(undefined), undefined)
})

/** An event stream the test pushes into, ending when told to or when aborted. */
function pushableEvents() {
  const queue: V2Event[] = []
  let wake: (() => void) | undefined
  let done = false
  const subscribe = (options?: { signal?: AbortSignal }) => ({
    async *[Symbol.asyncIterator]() {
      options?.signal?.addEventListener("abort", () => {
        done = true
        wake?.()
      })
      for (;;) {
        while (queue.length > 0) yield queue.shift()!
        if (done) return
        await new Promise<void>((resolve) => (wake = resolve))
        wake = undefined
      }
    },
  })
  return {
    subscribe,
    push: (event: V2Event) => {
      queue.push(event)
      wake?.()
    },
    end: () => {
      done = true
      wake?.()
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

test("followSessionEvents feeds the map, releases stopped and deleted sessions, and forgets the map when it ends", async () => {
  _resetSessionRunEventsForTests()
  setOpencodeClient({})
  const stream = pushableEvents()
  const controller = new AbortController()
  const { ap } = parkedProcess("ses_follow")
  const key = keyFor("ses_follow")
  const following = followSessionEvents(stream.subscribe, controller.signal)
  try {
    stream.push(started("ses_follow"))
    await settle()
    assert.equal(await fetchSessionRunState("ses_follow"), "busy")

    const handle = makeCall("bash")
    queuePendingProxyCall(key, handle.call)
    stream.push(ended("ses_follow", "interrupted", "user"))
    await settle()
    await assert.rejects(handle.promise, new RegExp(STOPPED_TURN_MESSAGE))
    assert.equal(await fetchSessionRunState("ses_follow"), "idle")
    noteTurnLine(ap, JSON.stringify({ type: "result" }))

    stream.push({ type: "session.deleted", data: { sessionID: "ses_follow" } })
    await settle()
    assert.equal(getActiveProcess(key), undefined, "a deleted session's process is released")

    stream.push(started("ses_follow"))
    await settle()
    stream.end()
    await following
    assert.equal(await fetchSessionRunState("ses_follow"), "unknown", "an ended subscription is no longer trusted")
  } finally {
    controller.abort()
    rejectAllPendingProxyCallsForSession(key, new Error("test cleanup"))
    dropProcess("ses_follow")
    setOpencodeClient(null)
  }
})

// ---------------------------------------------------------------------------
// The relay across copies of the plugin (h #g268)
// ---------------------------------------------------------------------------

/** Another copy of the plugin, as the relay sees it: what it was handed and whether its feed is open. */
function foreignCopy(options: { throws?: boolean } = {}) {
  const seen: unknown[] = []
  let feed = false
  const leave = _joinForeignRelayMemberForTests({
    handle: (event) => {
      seen.push(event)
      if (options.throws) throw new Error("a broken copy")
    },
    feedOpened: () => (feed = true),
    feedClosed: () => (feed = false),
  })
  return { seen, feedOpen: () => feed, leave }
}

test("after a reload disposes this copy's subscription, another copy's still stops its parked call and feeds its run state", async () => {
  _resetSessionRunEventsForTests()
  _resetSessionEventRelayForTests()
  setOpencodeClient({})
  const stream = pushableEvents()
  const controller = new AbortController()
  const { ap, writes } = parkedProcess("ses_reload")
  const key = keyFor("ses_reload")
  const following = followSessionEvents(stream.subscribe, controller.signal)
  // opencode 2 sets the rebuilt copy up, then disposes this one's setup.
  const reloaded = _openForeignRelayFollowerForTests()
  try {
    await settle()
    controller.abort()
    stream.end()
    await following
    assert.equal(_sessionEventRelaySizeForTests().followers, 1, "only the rebuilt copy's subscription is left")
    assert.equal(_sessionEventRelaySizeForTests().members, 1, "a copy that owns a process stays")

    // What the rebuilt copy's subscription now receives.
    relaySessionEvent(started("ses_reload"))
    assert.equal(await fetchSessionRunState("ses_reload"), "busy", "this copy's deadline guard still sees the session")

    const handle = makeCall("bash")
    queuePendingProxyCall(key, handle.call)
    relaySessionEvent(ended("ses_reload", "interrupted", "user"))
    await assert.rejects(handle.promise, new RegExp(STOPPED_TURN_MESSAGE))
    assert.equal(writes.length, 1)
    assert.deepEqual(JSON.parse(writes[0]!).request, { subtype: "interrupt" }, "the claude turn is interrupted")
    noteTurnLine(ap, JSON.stringify({ type: "result", subtype: "error_during_execution" }))

    relaySessionEvent({ type: "session.deleted", data: { sessionID: "ses_reload" } })
    assert.equal(getActiveProcess(key), undefined, "a deleted session's process is released")

    reloaded()
    assert.equal(await fetchSessionRunState("ses_reload"), "unknown", "with no subscription left, nothing is trusted")
  } finally {
    reloaded()
    controller.abort()
    rejectAllPendingProxyCallsForSession(key, new Error("test cleanup"))
    dropProcess("ses_reload")
    setOpencodeClient(null)
    _resetSessionEventRelayForTests()
  }
})

test("every copy gets every event, a copy's feed follows the process's subscriptions, and a broken copy costs the others nothing", async () => {
  _resetSessionRunEventsForTests()
  _resetSessionEventRelayForTests()
  setOpencodeClient({})
  const broken = foreignCopy({ throws: true })
  const other = foreignCopy()
  const stream = pushableEvents()
  const controller = new AbortController()
  assert.equal(other.feedOpen(), false, "no subscription yet")
  const following = followSessionEvents(stream.subscribe, controller.signal)
  try {
    await settle()
    assert.equal(other.feedOpen(), true, "this copy's subscription opens every copy's feed")
    stream.push(started("ses_many"))
    await settle()
    assert.deepEqual(other.seen, [started("ses_many")])
    assert.equal(broken.seen.length, 1)
    assert.equal(await fetchSessionRunState("ses_many"), "busy", "the broken copy did not stop this one")

    const late = foreignCopy()
    assert.equal(late.feedOpen(), true, "a copy joining while a subscription is live opens at once")
    late.leave()
    assert.equal(late.feedOpen(), false)
  } finally {
    controller.abort()
    stream.end()
    await following
    assert.equal(other.feedOpen(), false, "the last subscription closes every copy's feed")
    broken.leave()
    other.leave()
    setOpencodeClient(null)
    _resetSessionEventRelayForTests()
  }
})

test("a copy that never served leaves the relay with its last subscription, and one that served stays", async () => {
  _resetSessionRunEventsForTests()
  _resetSessionEventRelayForTests()
  for (const serves of [false, true]) {
    const stream = pushableEvents()
    const controller = new AbortController()
    const following = followSessionEvents(stream.subscribe, controller.signal)
    if (serves) parkedProcess("ses_member")
    try {
      await settle()
      assert.deepEqual(_sessionEventRelaySizeForTests(), { members: 1, followers: 1 })
    } finally {
      controller.abort()
      stream.end()
      await following
    }
    assert.deepEqual(
      _sessionEventRelaySizeForTests(),
      { members: serves ? 1 : 0, followers: 0 },
      serves ? "a copy with a process stays for the copy that follows" : "a setup-only copy is not pinned",
    )
    dropProcess("ses_member")
  }
  _resetSessionEventRelayForTests()
})

test("a copy whose turn spawned its claude process stays in the relay too", async () => {
  // A real turn registers its process through `spawnClaudeProcess`, not a
  // direct `setActiveProcess`; the live reload check found that path missing.
  _resetSessionRunEventsForTests()
  _resetSessionEventRelayForTests()
  const key = keyFor("ses_spawned")
  const stream = pushableEvents()
  const controller = new AbortController()
  const following = followSessionEvents(stream.subscribe, controller.signal)
  const spawned = spawnClaudeProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], process.cwd(), key)
  try {
    await settle()
    controller.abort()
    stream.end()
    await following
    assert.deepEqual(_sessionEventRelaySizeForTests(), { members: 1, followers: 0 })
  } finally {
    deleteActiveProcess(key)
    spawned.proc.kill()
    _resetSessionEventRelayForTests()
  }
})
