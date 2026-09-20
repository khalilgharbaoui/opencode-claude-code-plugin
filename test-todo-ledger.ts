import assert from "node:assert/strict"
import { test } from "node:test"
import {
  _resetAllLedgersForTests,
  applyTaskCreateToolResult,
  applyTaskCreateToolUse,
  applyTaskUpdate,
  clearLedger,
  getLedger,
  MAX_LEDGER_SESSIONS,
} from "./src/todo-ledger.js"

test("empty ledger for new sessionId", () => {
  _resetAllLedgersForTests()
  assert.deepEqual(getLedger("s-empty"), [])
})

test("TaskCreate tool_use stashes pending; ledger stays empty until result", () => {
  _resetAllLedgersForTests()
  applyTaskCreateToolUse("s1", "tu-1", { subject: "Write tests" })
  assert.deepEqual(getLedger("s1"), [])
})

test("TaskCreate tool_result commits entry with parsed claude id and returns full list", () => {
  _resetAllLedgersForTests()
  applyTaskCreateToolUse("s2", "tu-1", { subject: "Write tests" })
  const list = applyTaskCreateToolResult("s2", "tu-1", "Task #1 created successfully: Write tests")
  assert.deepEqual(list, [{ id: "1", content: "Write tests", status: "pending" }])
  assert.deepEqual(getLedger("s2"), [{ id: "1", content: "Write tests", status: "pending" }])
})

test("TaskCreate tool_result with unknown tool_use_id returns null and does not mutate", () => {
  _resetAllLedgersForTests()
  applyTaskCreateToolUse("s3", "tu-1", { subject: "Write tests" })
  const list = applyTaskCreateToolResult("s3", "tu-unknown", "Task #1 created successfully")
  assert.equal(list, null)
  assert.deepEqual(getLedger("s3"), [])
})

test("TaskCreate tool_result with malformed text returns null and drops pending", () => {
  _resetAllLedgersForTests()
  applyTaskCreateToolUse("s4", "tu-1", { subject: "Write tests" })
  const list = applyTaskCreateToolResult("s4", "tu-1", "unrelated output text")
  assert.equal(list, null)
  assert.deepEqual(getLedger("s4"), [])
})

test("multiple TaskCreate calls accumulate in insertion order", () => {
  _resetAllLedgersForTests()
  applyTaskCreateToolUse("s5", "tu-a", { subject: "First" })
  applyTaskCreateToolResult("s5", "tu-a", "Task #1 created successfully")
  applyTaskCreateToolUse("s5", "tu-b", { subject: "Second" })
  applyTaskCreateToolResult("s5", "tu-b", "Task #2 created successfully")
  applyTaskCreateToolUse("s5", "tu-c", { subject: "Third" })
  applyTaskCreateToolResult("s5", "tu-c", "Task #3 created successfully")
  assert.deepEqual(
    getLedger("s5").map((t) => `${t.id}:${t.content}`),
    ["1:First", "2:Second", "3:Third"],
  )
})

test("TaskUpdate flips status and preserves content", () => {
  _resetAllLedgersForTests()
  applyTaskCreateToolUse("s6", "tu-1", { subject: "Write tests" })
  applyTaskCreateToolResult("s6", "tu-1", "Task #1 created successfully")
  const list = applyTaskUpdate("s6", { taskId: "1", status: "in_progress" })
  assert.deepEqual(list, [{ id: "1", content: "Write tests", status: "in_progress" }])
})

test("TaskUpdate with subject overrides content", () => {
  _resetAllLedgersForTests()
  applyTaskCreateToolUse("s7", "tu-1", { subject: "Old" })
  applyTaskCreateToolResult("s7", "tu-1", "Task #1 created successfully")
  applyTaskUpdate("s7", { taskId: "1", subject: "New" })
  assert.deepEqual(getLedger("s7"), [{ id: "1", content: "New", status: "pending" }])
})

test("TaskUpdate(status='deleted') removes the entry", () => {
  _resetAllLedgersForTests()
  applyTaskCreateToolUse("s8", "tu-1", { subject: "Keep" })
  applyTaskCreateToolResult("s8", "tu-1", "Task #1 created successfully")
  applyTaskCreateToolUse("s8", "tu-2", { subject: "Drop" })
  applyTaskCreateToolResult("s8", "tu-2", "Task #2 created successfully")
  const list = applyTaskUpdate("s8", { taskId: "2", status: "deleted" })
  assert.deepEqual(list, [{ id: "1", content: "Keep", status: "pending" }])
})

test("TaskUpdate for unknown taskId returns null without crashing", () => {
  _resetAllLedgersForTests()
  const list = applyTaskUpdate("s9", { taskId: "99", status: "completed" })
  assert.equal(list, null)
  assert.deepEqual(getLedger("s9"), [])
})

test("TaskUpdate with invalid status is ignored (status unchanged, no crash)", () => {
  _resetAllLedgersForTests()
  applyTaskCreateToolUse("s10", "tu-1", { subject: "Stay pending" })
  applyTaskCreateToolResult("s10", "tu-1", "Task #1 created successfully")
  const list = applyTaskUpdate("s10", { taskId: "1", status: "nonsense" })
  assert.deepEqual(list, [{ id: "1", content: "Stay pending", status: "pending" }])
})

test("two sessionIds are isolated", () => {
  _resetAllLedgersForTests()
  applyTaskCreateToolUse("alpha", "tu-1", { subject: "Alpha-1" })
  applyTaskCreateToolResult("alpha", "tu-1", "Task #1 created successfully")
  applyTaskCreateToolUse("beta", "tu-1", { subject: "Beta-1" })
  applyTaskCreateToolResult("beta", "tu-1", "Task #1 created successfully")
  assert.deepEqual(getLedger("alpha"), [{ id: "1", content: "Alpha-1", status: "pending" }])
  assert.deepEqual(getLedger("beta"), [{ id: "1", content: "Beta-1", status: "pending" }])
})

test("clearLedger wipes one session, leaves others intact", () => {
  _resetAllLedgersForTests()
  applyTaskCreateToolUse("keep", "tu-1", { subject: "Keep me" })
  applyTaskCreateToolResult("keep", "tu-1", "Task #1 created successfully")
  applyTaskCreateToolUse("toss", "tu-1", { subject: "Toss me" })
  applyTaskCreateToolResult("toss", "tu-1", "Task #1 created successfully")
  clearLedger("toss")
  assert.deepEqual(getLedger("toss"), [])
  assert.deepEqual(getLedger("keep"), [{ id: "1", content: "Keep me", status: "pending" }])
})

test("subject fallback: empty subject → description → '(no subject)'", () => {
  _resetAllLedgersForTests()
  applyTaskCreateToolUse("fb1", "tu-1", { subject: "", description: "Has desc" })
  applyTaskCreateToolResult("fb1", "tu-1", "Task #1 created successfully")
  assert.equal(getLedger("fb1")[0]?.content, "Has desc")

  applyTaskCreateToolUse("fb2", "tu-1", { subject: "   ", description: "  " })
  applyTaskCreateToolResult("fb2", "tu-1", "Task #1 created successfully")
  assert.equal(getLedger("fb2")[0]?.content, "(no subject)")

  applyTaskCreateToolUse("fb3", "tu-1", undefined)
  applyTaskCreateToolResult("fb3", "tu-1", "Task #1 created successfully")
  assert.equal(getLedger("fb3")[0]?.content, "(no subject)")
})

test("regex tolerates spacing variants (Task #N / Task N / Task#N)", () => {
  _resetAllLedgersForTests()
  applyTaskCreateToolUse("rx", "tu-a", { subject: "A" })
  assert.ok(applyTaskCreateToolResult("rx", "tu-a", "Task #7 created successfully"))
  applyTaskCreateToolUse("rx", "tu-b", { subject: "B" })
  assert.ok(applyTaskCreateToolResult("rx", "tu-b", "Task 8 created"))
  applyTaskCreateToolUse("rx", "tu-c", { subject: "C" })
  assert.ok(applyTaskCreateToolResult("rx", "tu-c", "Task#9 created successfully"))
  assert.deepEqual(
    getLedger("rx").map((t) => t.id),
    ["7", "8", "9"],
  )
})

test("stale pendingCreates are pruned on next applyTaskCreateToolUse", async () => {
  _resetAllLedgersForTests()
  const realNow = Date.now
  let fakeNow = 1_000_000
  Date.now = () => fakeNow

  try {
    applyTaskCreateToolUse("ttl", "tu-stale", { subject: "Stale" })
    fakeNow += 120_000
    applyTaskCreateToolUse("ttl", "tu-fresh", { subject: "Fresh" })
    const list = applyTaskCreateToolResult("ttl", "tu-stale", "Task #1 created successfully")
    assert.equal(list, null, "stale tool_use should have been pruned before result arrived")
    const freshList = applyTaskCreateToolResult("ttl", "tu-fresh", "Task #2 created successfully")
    assert.deepEqual(freshList, [{ id: "2", content: "Fresh", status: "pending" }])
  } finally {
    Date.now = realNow
  }
})

test("the ledger map is capped, dropping the oldest session first", () => {
  _resetAllLedgersForTests()
  const total = MAX_LEDGER_SESSIONS + 10
  for (let i = 0; i < total; i++) {
    applyTaskCreateToolUse(`cap-${i}`, "tu-1", { subject: `Task ${i}` })
    applyTaskCreateToolResult(`cap-${i}`, "tu-1", `Task #${i + 1} created`)
  }

  // The first ten are gone; the rest are all still there, so the cap sheds
  // in insertion order rather than clearing the map.
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(getLedger(`cap-${i}`), [], `cap-${i} should have been evicted`)
  }
  for (let i = 10; i < total; i++) {
    assert.equal(getLedger(`cap-${i}`).length, 1, `cap-${i} should have survived`)
  }
})
