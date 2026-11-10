import "./isolate.js"
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildGenerateInput,
  isDetachedGenerateRequest,
  leanClaudeArgs,
  leanResultText,
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

test("a lean run has no tools, no MCP, no slash commands, no setting source and no session file", () => {
  const args = leanClaudeArgs("haiku", "system")
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", ""])
  for (const flag of ["--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]) {
    assert.ok(args.includes(flag), flag)
  }
  // `project` still reads every CLAUDE.md up to the root (h #g294).
  assert.deepEqual(args.slice(args.indexOf("--setting-sources"), args.indexOf("--setting-sources") + 2), [
    "--setting-sources",
    "",
  ])
  // Plain `-p` text is read as typing, so the input is a composed envelope.
  assert.equal(args[args.indexOf("--input-format") + 1], "stream-json")
  assert.equal(args[args.indexOf("--model") + 1], "haiku")
})

const frames = (...lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join("\n")

test("leanResultText returns the result's text", () => {
  const stdout = frames(
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "text", text: "PONG" }] } },
    { type: "rate_limit_event" },
    { type: "result", subtype: "success", is_error: false, result: "PONG" },
  )
  assert.equal(leanResultText(stdout), "PONG")
})

test("a refusal throws with the CLI's own reason, measured on 2.1.314", () => {
  // Logged out (an empty CLAUDE_CONFIG_DIR) and an unknown model: both are
  // `subtype: success` with `is_error`, the kind on the synthetic reply.
  assert.throws(
    () =>
      leanResultText(
        frames(
          { type: "system", subtype: "init" },
          { type: "assistant", error: "authentication_failed", message: { model: "<synthetic>" } },
          { type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" },
        ),
      ),
    /claude refused: authentication_failed: Not logged in/,
  )
  assert.throws(
    () =>
      leanResultText(
        frames(
          { type: "assistant", error: "model_not_found", message: { model: "<synthetic>" } },
          { type: "result", subtype: "success", is_error: true, result: "There's an issue with the selected model" },
        ),
      ),
    /model_not_found: There's an issue/,
  )
  assert.throws(() => leanResultText(frames({ type: "system", subtype: "init" })), /no result/)
})
