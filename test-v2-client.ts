/**
 * The V1-shaped client the opencode 2 entrypoint installs (src/v2-client.ts).
 * Each assertion is the V1 response shape a real caller in this package reads,
 * built from V2's shapes as `@opencode/client@2.0.11` declares them.
 *
 * Usage: npx tsx --test test-v2-client.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { extractAgentTypeList } from "./src/proxy-mcp.js"
import { createV1ClientShim, formatAgentTypeList, toV1Session } from "./src/v2-client.js"

test("a V2 session becomes a V1 one with directory and parentID", () => {
  assert.deepEqual(
    toV1Session({ id: "ses_1", parentID: "ses_0", location: { directory: "/repo" } }),
    { id: "ses_1", parentID: "ses_0", location: { directory: "/repo" }, directory: "/repo" },
  )
  assert.equal(
    toV1Session({ id: "ses_1", location: { directory: "/repo" }, subpath: "pkg/a" })?.directory,
    "/repo/pkg/a",
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
