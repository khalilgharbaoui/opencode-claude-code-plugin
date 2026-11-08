import "./isolate.js"
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildGenerateInput,
  isDetachedGenerateRequest,
  leanClaudeArgs,
} from "../src/lean-generate.js"

test("a call with no session, no agent and no compaction is a detached generate call", () => {
  assert.equal(
    isDetachedGenerateRequest({ affinity: "default", opencodeAgent: undefined, compactionMode: false }),
    true,
  )
})

test("a chat turn, a title request and compaction are not", () => {
  assert.equal(
    isDetachedGenerateRequest({ affinity: "ses_abc", opencodeAgent: undefined, compactionMode: false }),
    false,
  )
  assert.equal(
    isDetachedGenerateRequest({ affinity: "default", opencodeAgent: "title", compactionMode: false }),
    false,
  )
  assert.equal(
    isDetachedGenerateRequest({ affinity: "default", opencodeAgent: undefined, compactionMode: true }),
    false,
  )
})

test("the generate input keeps the host's instructions and prompt in order", () => {
  const input = buildGenerateInput([
    { role: "system", content: "Be brief." },
    { role: "user", content: [{ type: "text", text: "Name it.\n\n**Current title:** x" }] },
    { role: "assistant", content: [{ type: "text", text: "ignored" }] },
  ])
  assert.equal(input, "Be brief.\n\nName it.\n\n**Current title:** x")
})

test("a lean run has no tools, no MCP, no slash commands and no session file", () => {
  const args = leanClaudeArgs("haiku", "system")
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", ""])
  for (const flag of ["--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]) {
    assert.ok(args.includes(flag), flag)
  }
  assert.deepEqual(args.slice(args.indexOf("--setting-sources"), args.indexOf("--setting-sources") + 2), [
    "--setting-sources",
    "project",
  ])
  assert.equal(args[args.indexOf("--model") + 1], "haiku")
})
