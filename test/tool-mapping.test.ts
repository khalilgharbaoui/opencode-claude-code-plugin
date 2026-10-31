import "./isolate.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  _resetAllLedgersForTests,
  applyTaskCreateToolResult,
  getLedger,
} from "../src/todo-ledger.js"
import {
  mapTool,
  isWebSearchTool,
  isWebSearchHandledByCli,
  singleQuoteForShell,
} from "../src/tool-mapping.js"
import { execFileSync } from "node:child_process"

test("WebSearch with default routing is skipped, not forwarded (no opencode registry entry)", () => {
  for (const route of [undefined, "claude" as const, "disabled" as const]) {
    const result = mapTool("WebSearch", { query: "anthropic pricing" }, { webSearch: route })
    assert.equal(result.skip, true, `route=${route} should skip`)
    assert.equal(result.executed, true, `route=${route} runs inside Claude CLI`)
    assert.equal(result.name, "WebSearch")
    assert.deepEqual(result.input, { query: "anthropic pricing" })
  }
})

test("WebSearch routed to an opencode tool is forwarded for opencode to execute", () => {
  const result = mapTool(
    "web_search",
    { query: "anthropic pricing", extra: "dropped" },
    { webSearch: "websearch_web_search_exa" },
  )
  assert.equal(result.skip, undefined)
  assert.equal(result.executed, false)
  assert.equal(result.name, "websearch_web_search_exa")
  assert.deepEqual(result.input, { query: "anthropic pricing" })
})

test("isWebSearchTool / isWebSearchHandledByCli helpers", () => {
  assert.equal(isWebSearchTool("WebSearch"), true)
  assert.equal(isWebSearchTool("web_search"), true)
  assert.equal(isWebSearchTool("WebFetch"), false)
  assert.equal(isWebSearchHandledByCli(undefined), true)
  assert.equal(isWebSearchHandledByCli("claude"), true)
  assert.equal(isWebSearchHandledByCli("disabled"), true)
  assert.equal(isWebSearchHandledByCli("websearch_web_search_exa"), false)
})

test("Read-only Claude CLI Task* tools are still skipped, not forwarded", () => {
  for (const name of ["TaskList", "TaskGet", "TaskStop"]) {
    const result = mapTool(name, { foo: "bar" })
    assert.equal(result.skip, true, `${name} should be skipped`)
    assert.equal(result.executed, true, `${name} should be marked executed`)
    assert.equal(result.name, name, `${name} should preserve the original name for logging`)
  }
})

test("TaskCreate without sessionId falls back to skip (preserves pre-ledger safety)", () => {
  _resetAllLedgersForTests()
  const result = mapTool("TaskCreate", { subject: "x" })
  assert.equal(result.skip, true)
  assert.equal(result.executed, true)
  assert.equal(result.name, "TaskCreate")
})

test("TaskUpdate without sessionId falls back to skip", () => {
  _resetAllLedgersForTests()
  const result = mapTool("TaskUpdate", { taskId: "1", status: "in_progress" })
  assert.equal(result.skip, true)
  assert.equal(result.executed, true)
  assert.equal(result.name, "TaskUpdate")
})

test("TaskCreate tool_use with sessionId stashes pending and returns skip (no emission yet)", () => {
  _resetAllLedgersForTests()
  const result = mapTool(
    "TaskCreate",
    { subject: "Write tests" },
    { sessionId: "tm-1", toolUseId: "tu-1" },
  )
  assert.equal(result.skip, true)
  assert.deepEqual(getLedger("tm-1"), [], "ledger remains empty until tool_result commits")
})

test("TaskUpdate with sessionId emits todowrite when task is known", () => {
  _resetAllLedgersForTests()
  mapTool("TaskCreate", { subject: "Step one" }, { sessionId: "tm-2", toolUseId: "tu-1" })
  applyTaskCreateToolResult("tm-2", "tu-1", "Task #1 created successfully")

  const result = mapTool(
    "TaskUpdate",
    { taskId: "1", status: "in_progress" },
    { sessionId: "tm-2" },
  )
  assert.equal(result.skip, undefined)
  assert.equal(result.executed, false)
  assert.equal(result.name, "todowrite")
  assert.deepEqual(result.input, {
    todos: [{ id: "1", content: "Step one", status: "in_progress", priority: "medium" }],
  })
})

test("TaskUpdate with sessionId returns skip when task id is unknown to the ledger", () => {
  _resetAllLedgersForTests()
  const result = mapTool(
    "TaskUpdate",
    { taskId: "999", status: "completed" },
    { sessionId: "tm-3" },
  )
  assert.equal(result.skip, true)
  assert.equal(result.executed, true)
  assert.equal(result.name, "TaskUpdate")
})

test("TaskOutput is still surfaced as a bash call (not internalized)", () => {
  const result = mapTool("TaskOutput", { content: "hello" })
  assert.equal(result.skip, undefined)
  assert.equal(result.executed, false)
  assert.equal(result.name, "bash")
  assert.ok(typeof result.input?.command === "string")
  assert.ok(result.input.command.includes("hello"))
})

// Issue #27: the payload is model-controlled and opencode really runs the
// command, so anything the shell expands inside it is executed while the
// operator sees something that reads like a print.
test("TaskOutput payloads are not expanded by the shell", () => {
  const payloads = [
    "X$(id -u)Y",
    "X`id -u`Y",
    "X${HOME}Y",
    "it's got a quote",
    'and a "double" quote',
    "semi; echo pwned",
  ]

  for (const content of payloads) {
    const command = mapTool("TaskOutput", { content }).input.command as string
    const printed = execFileSync("bash", ["-c", command], {
      encoding: "utf8",
      env: { ...process.env, HOME: "/should-not-appear" },
    })
    assert.equal(
      printed,
      `TASK OUTPUT: ${content}\n`,
      `payload must reach the operator verbatim: ${content}`,
    )
  }
})

test("singleQuoteForShell survives an embedded single quote", () => {
  const quoted = singleQuoteForShell("a'b")
  const printed = execFileSync("bash", ["-c", `printf '%s' ${quoted}`], {
    encoding: "utf8",
  })
  assert.equal(printed, "a'b")
})

test("Pre-existing internal tools still skip", () => {
  for (const name of ["ToolSearch", "Agent", "AskFollowupQuestion"]) {
    const result = mapTool(name)
    assert.equal(result.skip, true, `${name} should remain skipped`)
  }
})

test("TodoWrite path is unaffected by the Task* ledger additions", () => {
  const result = mapTool("TodoWrite", { todos: [{ id: "1", content: "x", status: "pending" }] })
  assert.equal(result.skip, undefined)
  assert.equal(result.executed, false)
  assert.equal(result.name, "todowrite")
})
