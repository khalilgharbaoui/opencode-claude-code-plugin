// The session lookups every caller treats as advisory: a wrong answer here
// either aborts a live turn (run state) or spawns Claude in the wrong project
// (directory). All of them must degrade to "I don't know" rather than guess,
// so the failure shapes are pinned as hard as the happy paths.

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  fetchSessionDirectory,
  fetchSessionParentId,
  fetchSessionRunState,
  setOpencodeClient,
  settleSessionRunState,
} from "./src/runtime-status.js"

/**
 * `setOpencodeClient` ignores null, so "no client captured" is expressed as a
 * client with none of the routes: `client?.session?.get` is the branch under
 * test either way.
 */
const NO_ROUTES = {}

interface SessionGetCall {
  path: { id: string }
  query?: { directory?: string }
}

function clientWithSessionGet(
  handler: (call: SessionGetCall) => unknown,
): { calls: SessionGetCall[] } {
  const calls: SessionGetCall[] = []
  setOpencodeClient({
    session: {
      get: async (options: SessionGetCall) => {
        calls.push(options)
        return handler(options)
      },
    },
  })
  return { calls }
}

// ---------------------------------------------------------------------------
// fetchSessionDirectory
// ---------------------------------------------------------------------------

test("fetchSessionDirectory returns the session's own project directory", async () => {
  const probe = clientWithSessionGet(() => ({
    data: { id: "ses_1", directory: "/home/jan/proj", parentID: undefined },
  }))

  assert.equal(await fetchSessionDirectory("ses_1"), "/home/jan/proj")
  assert.deepEqual(probe.calls, [{ path: { id: "ses_1" } }])
})

test("fetchSessionDirectory refuses the ids that mean 'no session'", async () => {
  const probe = clientWithSessionGet(() => ({ data: { directory: "/x/y" } }))

  assert.equal(await fetchSessionDirectory("default"), undefined)
  assert.equal(await fetchSessionDirectory(""), undefined)
  // The route is never even called for those: the "default" bucket is the
  // plugin's own placeholder, not an opencode session id.
  assert.deepEqual(probe.calls, [])
})

test("fetchSessionDirectory falls back on an unusable or missing directory", async () => {
  for (const directory of ["/", "", "x", 42, null, undefined]) {
    clientWithSessionGet(() => ({ data: { directory } }))
    assert.equal(
      await fetchSessionDirectory("ses_1"),
      undefined,
      `directory ${JSON.stringify(directory)} should not be used`,
    )
  }
})

test("fetchSessionDirectory survives a malformed or rejected response", async () => {
  for (const data of [undefined, null, "a string", 7]) {
    clientWithSessionGet(() => ({ data }))
    assert.equal(await fetchSessionDirectory("ses_1"), undefined)
  }

  clientWithSessionGet(() => {
    throw new Error("connection refused")
  })
  assert.equal(await fetchSessionDirectory("ses_1"), undefined)

  setOpencodeClient(NO_ROUTES)
  assert.equal(await fetchSessionDirectory("ses_1"), undefined)
})

// ---------------------------------------------------------------------------
// fetchSessionParentId
// ---------------------------------------------------------------------------

test("fetchSessionParentId names the session that spawned a subagent", async () => {
  clientWithSessionGet(() => ({
    data: { id: "ses_child", parentID: "ses_parent", directory: "/p" },
  }))
  assert.equal(await fetchSessionParentId("ses_child"), "ses_parent")
})

test("fetchSessionParentId is undefined for a top-level session", async () => {
  for (const parentID of [undefined, null, "", 0, {}]) {
    clientWithSessionGet(() => ({ data: { parentID } }))
    assert.equal(
      await fetchSessionParentId("ses_1"),
      undefined,
      `parentID ${JSON.stringify(parentID)} is not a parent`,
    )
  }
})

test("fetchSessionParentId degrades quietly without a client or a route", async () => {
  assert.equal(await fetchSessionParentId("default"), undefined)
  assert.equal(await fetchSessionParentId(""), undefined)

  clientWithSessionGet(() => {
    throw new Error("boom")
  })
  assert.equal(await fetchSessionParentId("ses_1"), undefined)

  setOpencodeClient(NO_ROUTES)
  assert.equal(await fetchSessionParentId("ses_1"), undefined)
})

// ---------------------------------------------------------------------------
// fetchSessionRunState
// ---------------------------------------------------------------------------

interface StatusProbe {
  calls: number
  /** Whether every call arrived with `this` bound to `client.session`. */
  boundCorrectly: boolean
}

function clientWithStatus(
  handler: (call: number) => unknown,
): StatusProbe {
  const probe: StatusProbe = { calls: 0, boundCorrectly: true }
  const session = {
    marker: "session-object",
    status: async function (this: unknown) {
      probe.calls++
      // The call site is `status.call(client.session)`. An unbound call would
      // leave `this` undefined and break a real SDK client's own internals.
      if ((this as { marker?: string })?.marker !== "session-object") {
        probe.boundCorrectly = false
      }
      return handler(probe.calls)
    },
  }
  setOpencodeClient({ session })
  return probe
}

test("a session opencode reports as running is busy", async () => {
  const probe = clientWithStatus(() => ({
    data: { ses_1: { type: "running" }, ses_2: { type: "idle" } },
  }))

  assert.equal(await fetchSessionRunState("ses_1"), "busy")
  assert.equal(probe.boundCorrectly, true)
})

test("idle means idle, and so does absent from the status map", async () => {
  clientWithStatus(() => ({ data: { ses_1: { type: "idle" } } }))

  assert.equal(await fetchSessionRunState("ses_1"), "idle")
  // opencode only lists sessions it is tracking; a missing one is finished.
  assert.equal(await fetchSessionRunState("ses_unlisted"), "idle")
})

test("an entry with no recognizable type is treated as busy, not idle", async () => {
  // Erring towards busy is deliberate: releasing a pending proxy call on a
  // guess is the expensive mistake.
  clientWithStatus(() => ({ data: { ses_1: { type: "some-future-state" } } }))
  assert.equal(await fetchSessionRunState("ses_1"), "busy")

  clientWithStatus(() => ({ data: { ses_1: {} } }))
  assert.equal(await fetchSessionRunState("ses_1"), "busy")
})

test("no client, no route, no data or a rejection all read as unknown", async () => {
  setOpencodeClient(NO_ROUTES)
  assert.equal(await fetchSessionRunState("ses_1"), "unknown")

  for (const data of [undefined, null, "not an object"]) {
    clientWithStatus(() => ({ data }))
    assert.equal(await fetchSessionRunState("ses_1"), "unknown")
  }

  clientWithStatus(() => {
    throw new Error("socket hang up")
  })
  assert.equal(await fetchSessionRunState("ses_1"), "unknown")
})

test("the 'default' bucket has no run state to read", async () => {
  const probe = clientWithStatus(() => ({ data: { default: { type: "running" } } }))

  assert.equal(await fetchSessionRunState("default"), "unknown")
  assert.equal(await fetchSessionRunState(""), "unknown")
  assert.equal(probe.calls, 0)
})

// ---------------------------------------------------------------------------
// settleSessionRunState
// ---------------------------------------------------------------------------

test("settle returns busy the moment one reading inside the window is busy", async () => {
  // The abort arrives before opencode has updated its map: the first reads
  // look idle and the third is the truth.
  const probe = clientWithStatus((call) => ({
    data: call >= 3 ? { ses_1: { type: "running" } } : {},
  }))

  const state = await settleSessionRunState("ses_1", {
    pollMs: 1,
    windowMs: 500,
  })

  assert.equal(state, "busy")
  assert.equal(probe.calls, 3)
})

test("settle returns idle only after the whole window stayed idle", async () => {
  const probe = clientWithStatus(() => ({ data: { ses_1: { type: "idle" } } }))

  const started = Date.now()
  const state = await settleSessionRunState("ses_1", {
    pollMs: 5,
    windowMs: 60,
  })

  assert.equal(state, "idle")
  assert.ok(Date.now() - started >= 55, "should not return before the window")
  assert.ok(probe.calls > 1, "should have polled more than once")
})

test("settle keeps the last real reading rather than downgrading to unknown", async () => {
  // A route that answers once and then breaks still produced a real reading;
  // reporting `unknown` would make the caller release a live call.
  clientWithStatus((call) => {
    if (call === 1) return { data: { ses_1: { type: "idle" } } }
    throw new Error("gone")
  })

  assert.equal(
    await settleSessionRunState("ses_1", { pollMs: 1, windowMs: 20 }),
    "idle",
  )
})

test("settle reports unknown when it never got an answer at all", async () => {
  setOpencodeClient(NO_ROUTES)
  assert.equal(
    await settleSessionRunState("ses_1", { pollMs: 1, windowMs: 20 }),
    "unknown",
  )
  assert.equal(
    await settleSessionRunState("default", { pollMs: 1, windowMs: 0 }),
    "unknown",
  )
})

test("settle's defaults are a 150ms poll inside a 1.5s window", async () => {
  // Pinned because both numbers are load-bearing: the poll has to be short
  // enough to catch opencode's late map update, the window short enough not
  // to stall the end of a turn.
  const probe = clientWithStatus(() => ({ data: {} }))
  const started = Date.now()

  const state = await settleSessionRunState("ses_1")

  assert.equal(state, "idle")
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 1_500, `expected >= 1500ms, got ${elapsed}`)
  // Upper bound only: a loaded machine stretches every timer, so the floor is
  // "more than a couple of reads" rather than the ~11 an idle machine gets.
  assert.ok(probe.calls > 2 && probe.calls <= 14, `polled ${probe.calls} times`)
})
