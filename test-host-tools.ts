/**
 * Tool calls leave the plugin in opencode 1.x's vocabulary. On opencode 2.x the
 * stream is rewritten at its edge (src/host-tools.ts); on 1.x nothing changes.
 * The V2 names and schemas come from `@opencode/core@2.0.11`'s own tool
 * definitions, so a failure here after an opencode bump is a drift signal.
 *
 * Usage: npx tsx --test test-host-tools.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  createHostToolPartTranslator,
  translateStreamForHost,
  translateToolForHost,
} from "./src/host-tools.js"

test("V1 is untouched: every name and input passes through", () => {
  const input = { command: "ls", description: "List" }
  assert.deepEqual(translateToolForHost("bash", input, "v1"), { name: "bash", input })
  assert.deepEqual(translateToolForHost("todowrite", { todos: [] }, "v1"), {
    name: "todowrite",
    input: { todos: [] },
  })
})

test("V2: bash becomes shell and loses the description V2 does not take", () => {
  assert.deepEqual(
    translateToolForHost("bash", { command: "ls", description: "List", timeout: 5000 }, "v2"),
    { name: "shell", input: { command: "ls", timeout: 5000 } },
  )
})

test("V2: file tools take path, not filePath", () => {
  assert.deepEqual(
    translateToolForHost("edit", { filePath: "/a", oldString: "x", newString: "y" }, "v2"),
    { name: "edit", input: { path: "/a", oldString: "x", newString: "y" } },
  )
  assert.deepEqual(translateToolForHost("write", { filePath: "/a", content: "c" }, "v2"), {
    name: "write",
    input: { path: "/a", content: "c" },
  })
  assert.deepEqual(translateToolForHost("read", { filePath: "/a", offset: 3 }, "v2"), {
    name: "read",
    input: { path: "/a", offset: 3 },
  })
})

test("V2: task becomes subagent with its fields renamed", () => {
  assert.deepEqual(
    translateToolForHost(
      "task",
      {
        subagent_type: "general",
        description: "Look",
        prompt: "Find it",
        task_id: "ses_1",
        command: "/x",
      },
      "v2",
    ),
    {
      name: "subagent",
      input: { agent: "general", description: "Look", prompt: "Find it", sessionID: "ses_1" },
    },
  )
})

test("V2: tools with no V2 counterpart are dropped, unknown names pass", () => {
  assert.equal(translateToolForHost("todowrite", { todos: [] }, "v2"), null)
  assert.equal(translateToolForHost("plan_exit", {}, "v2"), null)
  assert.deepEqual(translateToolForHost("question", { questions: [] }, "v2"), {
    name: "question",
    input: { questions: [] },
  })
  assert.deepEqual(translateToolForHost("figma_whoami", {}, "v2"), {
    name: "figma_whoami",
    input: {},
  })
})

test("the part translator keeps a renamed tool consistent from start to result", () => {
  const translate = createHostToolPartTranslator("v2")
  assert.deepEqual(translate({ type: "tool-input-start", id: "t1", toolName: "bash" }), {
    type: "tool-input-start",
    id: "t1",
    toolName: "shell",
  })
  // Its deltas carry V1 keys, so they are held back; the final input wins.
  assert.equal(translate({ type: "tool-input-delta", id: "t1", delta: '{"command"' }), null)
  assert.deepEqual(translate({ type: "tool-input-end", id: "t1" }), {
    type: "tool-input-end",
    id: "t1",
  })
  const call = translate({
    type: "tool-call",
    toolCallId: "t1",
    toolName: "bash",
    input: JSON.stringify({ command: "ls", description: "List" }),
  })
  assert.equal(call?.toolName, "shell")
  assert.deepEqual(JSON.parse(String(call?.input)), { command: "ls" })
  assert.equal(
    translate({ type: "tool-result", toolCallId: "t1", toolName: "bash", result: "ok" })?.toolName,
    "shell",
  )
})

test("the part translator drops every part of a dropped tool", () => {
  const translate = createHostToolPartTranslator("v2")
  assert.equal(translate({ type: "tool-input-start", id: "d1", toolName: "todowrite" }), null)
  assert.equal(translate({ type: "tool-input-delta", id: "d1", delta: "{" }), null)
  assert.equal(translate({ type: "tool-input-end", id: "d1" }), null)
  assert.equal(
    translate({ type: "tool-call", toolCallId: "d1", toolName: "todowrite", input: "{}" }),
    null,
  )
  // Unrelated parts are untouched.
  const text = { type: "text-delta", id: "x", delta: "hi" }
  assert.equal(translate(text), text)
})

test("a tool whose input already matches still streams its deltas", () => {
  const translate = createHostToolPartTranslator("v2")
  translate({ type: "tool-input-start", id: "g1", toolName: "glob" })
  const delta = { type: "tool-input-delta", id: "g1", delta: '{"pattern":"*"}' }
  assert.equal(translate(delta), delta)
})

test("translateStreamForHost is the identity on V1 and rewrites on V2", async () => {
  const make = () =>
    new ReadableStream<{ type: string; [key: string]: unknown }>({
      start(controller) {
        controller.enqueue({ type: "tool-call", toolCallId: "a", toolName: "task", input: "{}" })
        controller.enqueue({ type: "tool-call", toolCallId: "b", toolName: "todowrite", input: "{}" })
        controller.close()
      },
    })
  const v1 = make()
  assert.equal(translateStreamForHost(v1, "v1"), v1)

  const parts: any[] = []
  const reader = translateStreamForHost(make(), "v2").getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    parts.push(value)
  }
  assert.deepEqual(
    parts.map((part) => part.toolName),
    ["subagent"],
  )
})
