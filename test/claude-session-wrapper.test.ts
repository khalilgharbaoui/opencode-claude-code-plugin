import assert from "node:assert/strict"
import * as path from "node:path"
import { test } from "node:test"
import * as fs from "node:fs"
import {
  decodeUserEnvelope,
  interactiveExtraArgs,
  spawnInteractiveProcess,
  stageImage,
} from "../src/claude-session-wrapper.js"
import { ClaudeSession, encodeCwd } from "../src/claude-session-bun.js"

// ---------------------------------------------------------------------------
// decodeUserEnvelope — doStream writes stream-json envelopes to stdin; the
// interactive TUI must receive plain typed text, never raw JSON or base64.
// ---------------------------------------------------------------------------

test("decodeUserEnvelope extracts text blocks from a stream-json envelope", () => {
  const envelope = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: "Hello there" },
        { type: "text", text: "(think)" },
      ],
    },
  })
  assert.equal(decodeUserEnvelope(envelope), "Hello there\n\n(think)")
})

test("decodeUserEnvelope passes string message content through", () => {
  const envelope = JSON.stringify({
    type: "user",
    message: { role: "user", content: "plain string content" },
  })
  assert.equal(decodeUserEnvelope(envelope), "plain string content")
})

test("decodeUserEnvelope drops image blocks but keeps text", () => {
  const envelope = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AAAA" },
        },
      ],
    },
  })
  const decoded = decodeUserEnvelope(envelope)
  assert.equal(decoded, "look at this")
  assert.ok(!decoded.includes("AAAA"), "base64 must never reach the TUI")
})

test("decodeUserEnvelope pastes a staged path for each image, ahead of the text", () => {
  const envelope = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: "compare these" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        { type: "image", source: { type: "base64", media_type: "IMAGE/JPEG", data: "BBBB" } },
        // Not an image the TUI attaches: dropped, never pasted.
        { type: "image", source: { type: "base64", media_type: "image/tiff", data: "CCCC" } },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "DDDD" } },
      ],
    },
  })
  const staged: Array<[string, string]> = []
  const decoded = decodeUserEnvelope(envelope, (data, extension) => {
    staged.push([data.toString("base64"), extension])
    return `/scratch/image-${staged.length}.${extension}`
  })
  assert.deepEqual(staged, [["AAAA", "png"], ["BBBB", "jpg"]])
  assert.equal(decoded, "/scratch/image-1.png\n/scratch/image-2.jpg\ncompare these")
  // A saver that fails drops the image like any other block.
  assert.equal(decodeUserEnvelope(envelope, () => null), "compare these")
})

test("stageImage writes a private file in the plugin's scratch dir", () => {
  const file = stageImage(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "png")!
  try {
    assert.match(path.basename(file), /^image-[0-9a-f-]+\.png$/)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.deepEqual([...fs.readFileSync(file)], [0x89, 0x50, 0x4e, 0x47])
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test("decodeUserEnvelope renders tool_result blocks as labeled text", () => {
  const envelope = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: [{ type: "text", text: "exit code 0" }],
        },
      ],
    },
  })
  const decoded = decodeUserEnvelope(envelope)
  assert.ok(decoded.includes("[Tool result tu_1]"))
  assert.ok(decoded.includes("exit code 0"))
})

test("decodeUserEnvelope passes non-JSON input through verbatim", () => {
  assert.equal(decodeUserEnvelope("just plain text"), "just plain text")
})

test("decodeUserEnvelope passes non-user JSON through verbatim", () => {
  const control = JSON.stringify({ type: "control_response", response: {} })
  assert.equal(decodeUserEnvelope(control), control)
})

// ---------------------------------------------------------------------------
// encodeCwd — transcript dir name: every non-alphanumeric char becomes "-".
// Symlink resolution (the other half of the rule) lives in
// test/interactive-result.test.ts, which needs real directories on disk.
// ---------------------------------------------------------------------------

test("encodeCwd replaces every non-alphanumeric char with a dash", () => {
  // These paths do not exist, so there is nothing to realpath and the
  // character rule is what is under test. Absolute, so path.resolve is a
  // no-op on POSIX.
  if (process.platform === "win32") {
    assert.equal(encodeCwd("C:\\dev\\My Project"), "C--dev-My-Project")
  } else {
    assert.equal(encodeCwd("/Users/me/does-not-exist-my-app"), "-Users-me-does-not-exist-my-app")
    assert.equal(encodeCwd("/tmp/does-not-exist/My Project"), "-tmp-does-not-exist-My-Project")
  }
})

test("ClaudeSession uses configDir for the transcript path", () => {
  const configDir = path.join(process.cwd(), ".tmp-claude-config")
  const cwd = path.join(process.cwd(), "workspace")
  const session = new ClaudeSession({ cwd, configDir })
  assert.equal(session.configDir, configDir)
  assert.equal(
    session.jsonlPath,
    path.join(configDir, "projects", encodeCwd(cwd), `${session.sessionId}.jsonl`),
  )
})

// ---------------------------------------------------------------------------
// spawnInteractiveProcess — ActiveProcess shim shape. No claude is spawned
// until the first stdin.write, so constructing + killing is offline-safe.
// ---------------------------------------------------------------------------

test("spawnInteractiveProcess returns an ActiveProcess-shaped shim", () => {
  const ap = spawnInteractiveProcess({ cwd: process.cwd() })
  const proc = ap.proc as any
  assert.equal(typeof proc.stdin.write, "function")
  assert.equal(typeof proc.kill, "function")
  assert.equal(typeof proc.on, "function")
  assert.equal(typeof proc.off, "function")
  assert.equal(ap.proxyServer, null)
  assert.equal(ap.mcpHash, undefined)
  // kill() before any turn must be safe (no session started yet).
  assert.equal(proc.kill(), true)
  assert.equal(proc.killed, true)
})

test("spawnInteractiveProcess threads systemPromptFile into ActiveProcess", () => {
  const ap = spawnInteractiveProcess({
    cwd: process.cwd(),
    systemPromptFile: "/tmp/nonexistent-system-prompt.txt",
  })
  assert.equal(ap.systemPromptFile, "/tmp/nonexistent-system-prompt.txt")
  ;(ap.proc as any).kill()
})

// The skill bridge reaches the TUI through the same `--plugin-dir` flag as
// the headless spawn. `interactiveExtraArgs` is exactly what ClaudeSession
// appends to its argv, so this is the spawn argument list without a PTY.
test("interactiveExtraArgs passes one --plugin-dir per staged directory, keeping the single --settings payload", () => {
  const args = interactiveExtraArgs({
    cwd: process.cwd(),
    mcpConfigPaths: ["/tmp/mcp.json"],
    pluginDirs: ["/tmp/skills-a", "/tmp/skills-b"],
    permissionsAllow: ["Bash"],
    fastMode: true,
  })
  assert.deepEqual(args.slice(0, 3), ["--mcp-config", "/tmp/mcp.json", "--strict-mcp-config"])
  const dirs = args.reduce<string[]>((acc, arg, i) => {
    if (arg === "--plugin-dir") acc.push(args[i + 1]!)
    return acc
  }, [])
  assert.deepEqual(dirs, ["/tmp/skills-a", "/tmp/skills-b"])
  assert.equal(args.filter((arg) => arg === "--settings").length, 1, "the CLI takes --settings once")
  assert.deepEqual(JSON.parse(args[args.indexOf("--settings") + 1]!), {
    permissions: { allow: ["Bash"] },
    fastMode: true,
  })
})

test("interactiveExtraArgs omits --plugin-dir when nothing was staged", () => {
  for (const pluginDirs of [undefined, [] as string[]]) {
    const args = interactiveExtraArgs({ cwd: process.cwd(), pluginDirs })
    assert.equal(args.includes("--plugin-dir"), false)
  }
})

test("error handler registration is add/remove symmetric", () => {
  const ap = spawnInteractiveProcess({ cwd: process.cwd() })
  const proc = ap.proc as any
  const handler = () => {}
  proc.on("error", handler)
  proc.off("error", handler)
  proc.kill()
})

test("interactiveExtraArgs disallows the native tools the proxy serves, as one variadic flag", () => {
  const args = interactiveExtraArgs({ cwd: process.cwd(), disallowedTools: ["Bash", "Edit", "Task"] })
  const at = args.indexOf("--disallowedTools")
  assert.deepEqual(args.slice(at, at + 4), ["--disallowedTools", "Bash", "Edit", "Task"])
  assert.equal(args.filter((arg) => arg === "--disallowedTools").length, 1)
  assert.equal(interactiveExtraArgs({ cwd: process.cwd(), disallowedTools: [] }).includes("--disallowedTools"), false)
})
