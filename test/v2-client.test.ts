/**
 * The V1-shaped client the opencode 2 entrypoint installs (src/v2-client.ts).
 * Each assertion is the V1 response shape a real caller in this package reads,
 * built from V2's shapes as `@opencode/client@2.0.11` declares them.
 *
 * Usage: npx tsx --test test/v2-client.test.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import * as path from "node:path"
import { extractAgentTypeList } from "../src/proxy-mcp.js"
import {
  createV1ClientShim,
  formatAgentTypeList,
  toV1Messages,
  toV1Session,
} from "../src/v2-client.js"
import { abortSession, fetchSessionReplies, setOpencodeClient } from "../src/runtime-status.js"

test("a V2 session becomes a V1 one with directory and parentID", () => {
  assert.deepEqual(
    toV1Session({ id: "ses_1", parentID: "ses_0", location: { directory: "/repo" } }),
    { id: "ses_1", parentID: "ses_0", location: { directory: "/repo" }, directory: "/repo" },
  )
  assert.equal(
    toV1Session({ id: "ses_1", location: { directory: "/repo" }, subpath: "pkg/a" })?.directory,
    path.resolve("/repo", "pkg/a"),
  )
  assert.equal(toV1Session(undefined), undefined)
})

test("mcp.status answers V1's name-to-status map", async () => {
  const client: any = createV1ClientShim({
    mcp: {
      list: async () => ({
        data: [
          { name: "figma", status: { status: "connected" } },
          { name: "slack", status: { status: "failed", error: "timeout" } } as any,
        ],
      }),
    },
  })
  assert.deepEqual(await client.mcp.status(), {
    data: { figma: { status: "connected" }, slack: { status: "failed" } },
  })
})

test("tool.list answers V1's shape and aliases subagent as task, with the agents", async () => {
  const client: any = createV1ClientShim({
    tool: {
      list: async () => [
        { id: "question", description: "Ask the user" },
        { id: "subagent", description: () => "Launch a subagent." },
      ],
    },
    agent: {
      list: async () => ({
        data: [
          { id: "general", description: "General work", mode: "subagent", hidden: false },
          { id: "build", description: "Primary agent", mode: "primary", hidden: false },
          { id: "compaction", description: "Internal", mode: "all", hidden: true },
          { id: "explore", description: "Reads code", mode: "all", hidden: false },
        ],
      }),
    },
  })
  const { data } = await client.tool.list({ query: { provider: "claude-code", model: "m" } })
  assert.deepEqual(
    data.map((tool: any) => tool.id),
    ["question", "subagent", "task"],
  )
  assert.deepEqual(data[0], { id: "question", description: "Ask the user", parameters: {} })
  const task = data.find((tool: any) => tool.id === "task")
  assert.match(task.description, /^Launch a subagent\./)
  // The overlay's own extractor must be able to read what the shim wrote.
  const extracted = extractAgentTypeList(task.description)
  assert.ok(extracted, "the agent list must be extractable")
  assert.match(extracted!, /general: General work/)
  assert.match(extracted!, /explore: Reads code/)
  assert.doesNotMatch(extracted!, /build:|compaction:/)
})

test("the agent list leaves out primary and hidden agents, and may be empty", () => {
  assert.equal(formatAgentTypeList([{ id: "build", mode: "primary" }]), undefined)
  assert.equal(
    formatAgentTypeList([{ id: "general", mode: "subagent" }]),
    "Available agent types and the tools they have access to:\n- general: (no description)",
  )
})

test("session.get calls V2 with its sessionID input and returns a V1 envelope", async () => {
  const seen: unknown[] = []
  const client: any = createV1ClientShim({
    session: {
      get: async (input) => {
        seen.push(input)
        return { id: input.sessionID, location: { directory: "/repo" } }
      },
    },
  })
  const result = await client.session.get({ path: { id: "ses_9" } })
  assert.deepEqual(seen, [{ sessionID: "ses_9" }])
  assert.equal(result.data.directory, "/repo")
})

test("domains V2 does not offer stay absent, so callers take their no-client path", () => {
  assert.deepEqual(createV1ClientShim({}), {})
})

// --- session.context / session.interrupt, for background subagents -------

// V2 has no `role`: the message kind IS the discriminator, and an assistant's
// text lives in `content` rather than in `parts`.
test("V2 context messages become V1 `{ info, parts }` records", () => {
  assert.deepEqual(
    toV1Messages([
      { id: "msg_1", type: "user", time: { created: 1 }, text: "go" },
      {
        id: "msg_2",
        type: "assistant",
        time: { created: 2, completed: 3 },
        content: [
          { type: "reasoning", text: "hmm" },
          { type: "text", text: "done" },
          { type: "tool", tool: "read" },
        ],
      },
    ]),
    [
      { info: { role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "go" }] },
      {
        info: { role: "assistant", time: { created: 2, completed: 3 } },
        parts: [{ type: "text", text: "done" }],
      },
    ],
  )
  assert.deepEqual(toV1Messages(undefined), [])
  assert.deepEqual(toV1Messages("nope"), [])
})

test("a V2 structured error lands where fetchSessionReplies looks for it", async () => {
  const client: any = createV1ClientShim({
    session: {
      context: async () => [
        {
          id: "msg_1",
          type: "assistant",
          time: { created: 1 },
          content: [],
          error: { type: "ProviderError", message: "boom", status: 500 },
        },
      ],
    },
  })
  setOpencodeClient(client)
  const replies = await fetchSessionReplies("ses_child")
  assert.deepEqual(replies, [
    { role: "assistant", completed: false, error: "boom", text: "" },
  ])
})

// V2's synthetic messages are their own kind, so V1's synthetic-part filter
// needs no counterpart: they simply never match an assistant lookup.
test("a V2 synthetic message is not an assistant reply", () => {
  const [record] = toV1Messages([
    { id: "msg_1", type: "synthetic", time: { created: 1 }, text: "<subagent .../>" },
  ])
  assert.equal((record!.info as { role: string }).role, "synthetic")
})

test("session.messages and session.abort ride on V2's context and interrupt", async () => {
  const seen: unknown[] = []
  const client: any = createV1ClientShim({
    session: {
      context: async (input) => {
        seen.push(["context", input])
        return [{ id: "m", type: "assistant", time: { created: 1, completed: 2 }, content: [] }]
      },
      interrupt: async (input) => {
        seen.push(["interrupt", input])
        return { interrupted: true }
      },
    },
  })
  assert.equal(typeof client.session.messages, "function")
  await client.session.messages({ path: { id: "ses_child" } })
  assert.deepEqual(await client.session.abort({ path: { id: "ses_child" } }), { data: true })
  assert.deepEqual(seen, [
    ["context", { sessionID: "ses_child" }],
    ["interrupt", { sessionID: "ses_child" }],
  ])
  // V2's session domain has no `get` unless it offers one; the shim must still
  // publish the two routes it can answer.
  assert.equal(client.session.get, undefined)
})

// `interrupted: false` is opencode saying nothing was stopped. A cancel that
// did not happen must never read as one that did.
test("an interrupt that stopped nothing is reported as a refused abort", async () => {
  const client: any = createV1ClientShim({
    session: { interrupt: async () => ({ interrupted: false }) },
  })
  setOpencodeClient(client)
  assert.equal(await abortSession("ses_child"), false)

  setOpencodeClient(
    createV1ClientShim({ session: { interrupt: async () => ({ interrupted: true }) } }),
  )
  assert.equal(await abortSession("ses_child"), true)

  // A build that answers with no body at all keeps the old reading.
  setOpencodeClient(createV1ClientShim({ session: { interrupt: async () => undefined } }))
  assert.equal(await abortSession("ses_child"), true)
})
