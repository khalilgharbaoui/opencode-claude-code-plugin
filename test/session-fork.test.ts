/**
 * Forking an opencode session onto the parent's Claude conversation.
 *
 * Two halves. The pure matcher in `src/session-fork.ts` is exercised
 * directly, because every fallback this feature has is a case where it must
 * return null and a unit test is the only way to cover all of them. Then a
 * fake CLI drives two real `doStream` turns over two session affinities, so
 * the argv of the forked spawn, the session-id mapping afterwards and the
 * replay fallback are checked against the code that actually runs.
 *
 * Usage:
 *   npx tsx --test test/session-fork.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"

import {
  _resetForkFingerprints,
  conversationDigests,
  findForkParent,
  forkSiblingSignature,
  recordForkFingerprint,
  splitForkHistory,
} from "../src/session-fork.js"
import {
  appendResumeIfNeeded,
  buildCliArgs,
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  getClaudeSessionId,
  sessionKey,
  setClaudeSessionId,
} from "../src/session-manager.js"
import { detectCliVersion } from "../src/cli-version.js"
import { createClaudeCode } from "../src/index.js"

const CLI_A = "/opt/claude-accounts/default/claude"
const CLI_B = "/opt/claude-accounts/appical/claude"

const CONTEXT = 'context=["claude-code",null]'
const keyFor = (affinity: string, opts: { cwd?: string; model?: string } = {}) =>
  sessionKey(
    opts.cwd ?? "/work/repo",
    `${opts.model ?? "claude-sonnet-5"}::tools::${affinity}::${CONTEXT}`,
  )

const userText = (text: string) =>
  ({ role: "user", content: [{ type: "text", text }] }) as any
const assistantText = (text: string) =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as any

/** The conversation a parent key was last asked to continue. */
const PARENT_PROMPT = [
  { role: "system", content: "You are a helpful assistant." },
  userText("Explain the cache."),
  assistantText("The cache stores the prompt prefix."),
  userText("Now explain forking."),
] as any

/** The same thread as a fork sees it: plus the parent's reply, plus new input. */
const FORK_PROMPT = [
  { role: "system", content: "You are a helpful assistant." },
  userText("Explain the cache."),
  assistantText("The cache stores the prompt prefix."),
  userText("Now explain forking."),
  assistantText("A fork branches the conversation."),
  userText("Try that again but shorter."),
] as any

function findParent(
  sessionKeyValue: string,
  prompt: any,
  cliPath: string,
  overrides: {
    lookupClaudeSessionId?: (key: string) => string | undefined
    isBusy?: (key: string) => boolean
  } = {},
) {
  return findForkParent({
    sessionKey: sessionKeyValue,
    prompt,
    cliPath,
    lookupClaudeSessionId:
      overrides.lookupClaudeSessionId ?? ((key) => `claude-${key}`),
    isBusy: overrides.isBusy ?? (() => false),
  })
}

test("forkSiblingSignature blanks the affinity and refuses compaction keys", () => {
  assert.equal(
    forkSiblingSignature(keyFor("ses_a")),
    `/work/repo::claude-sonnet-5::tools::*::${CONTEXT}`,
  )
  assert.equal(forkSiblingSignature(keyFor("ses_a")), forkSiblingSignature(keyFor("ses_b")))
  assert.notEqual(
    forkSiblingSignature(keyFor("ses_a")),
    forkSiblingSignature(keyFor("ses_b", { model: "claude-haiku-4-5" })),
  )
  assert.notEqual(
    forkSiblingSignature(keyFor("ses_a")),
    forkSiblingSignature(keyFor("ses_b", { cwd: "/work/other" })),
  )
  // An effort tail is part of the signature, so two efforts never cross.
  assert.notEqual(
    forkSiblingSignature(keyFor("ses_a")),
    forkSiblingSignature(`${keyFor("ses_b")}::effort=high`),
  )
  // `<cwd>::<model>::compaction::<affinity>` has no fifth segment.
  assert.equal(
    forkSiblingSignature(sessionKey("/work/repo", "claude-sonnet-5::compaction::ses_a")),
    null,
  )
})

test("splitForkHistory refuses a prompt that is mid tool round trip", () => {
  const { history, forkable } = splitForkHistory(FORK_PROMPT)
  assert.equal(forkable, true)
  assert.deepEqual(
    history.map((entry) => entry.role),
    ["user", "assistant", "user", "assistant"],
  )

  // A tool-role message after the last assistant: the parent's CLI is parked
  // inside a proxy call and its transcript ends on an unanswered tool_use.
  const midToolCall = [
    userText("Run it."),
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "t1", toolName: "bash", input: {} }],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "t1", toolName: "bash", output: "ok" }],
    },
  ] as any
  assert.equal(splitForkHistory(midToolCall).forkable, false)

  // The same thing delivered as a tool-result part on a user message.
  const userToolResult = [
    userText("Run it."),
    assistantText("Running."),
    {
      role: "user",
      content: [{ type: "tool-result", toolCallId: "t1", toolName: "bash", output: "ok" }],
    },
  ] as any
  assert.equal(splitForkHistory(userToolResult).forkable, false)

  // Nothing to fork from before the first reply.
  assert.equal(splitForkHistory([userText("First message.")] as any).forkable, false)
})

test("conversationDigests tells two attachments with the same media type apart", () => {
  // Hashing only the media type made these two fingerprint alike, so a fork
  // could have answered from the parent's image.
  const withImage = (data: unknown) =>
    [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this picture?" },
          { type: "file", mediaType: "image/png", data },
        ],
      },
    ] as any
  const cat = conversationDigests(withImage("iVBORw0KGgoCAT"))
  const dog = conversationDigests(withImage("iVBORw0KGgoDOG"))
  assert.notDeepEqual(cat, dog)
  assert.deepEqual(cat, conversationDigests(withImage("iVBORw0KGgoCAT")), "same bytes, same digest")
  assert.notDeepEqual(
    conversationDigests(withImage(new Uint8Array([1, 2, 3]))),
    conversationDigests(withImage(new Uint8Array([1, 2, 4]))),
  )
  assert.notDeepEqual(
    conversationDigests(withImage(new URL("https://example.test/a.png"))),
    conversationDigests(withImage(new URL("https://example.test/b.png"))),
  )
})

test("conversationDigests ignores ids, which opencode re-keys on a fork", () => {
  const withIds = [
    userText("Run it."),
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call_111", toolName: "bash", input: { cmd: "ls" } }],
    },
  ] as any
  const reKeyed = [
    userText("Run it."),
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call_999", toolName: "bash", input: { cmd: "ls" } }],
    },
  ] as any
  assert.deepEqual(conversationDigests(withIds), conversationDigests(reKeyed))

  // Key order inside a tool input must not change the digest either.
  const sorted = [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "x", toolName: "bash", input: { a: 1, b: 2 } }],
    },
  ] as any
  const unsorted = [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "x", toolName: "bash", input: { b: 2, a: 1 } }],
    },
  ] as any
  assert.deepEqual(conversationDigests(sorted), conversationDigests(unsorted))

  // Different content must not collide.
  assert.notDeepEqual(
    conversationDigests([userText("one")] as any),
    conversationDigests([userText("two")] as any),
  )
})

/** opencode-dcp's reference as it appends one to a text part or a tool output. */
const dcpTag = (ref: string, attributes = "") =>
  `<dcp-message-id${attributes}>${ref}</dcp-message-id>`
const toolResult = (value: string) =>
  ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "call_1", toolName: "bash", output: { type: "text", value } }],
  }) as any

test("conversationDigests ignores dcp's message references, which it renumbers on a restart (h #g258)", () => {
  // The measured case: the same message as m0004 before a restart and m0003 after it.
  assert.deepEqual(
    conversationDigests([userText(`Third message.\n\n${dcpTag("m0004")}`)] as any),
    conversationDigests([userText(`Third message.\n\n${dcpTag("m0003")}`)] as any),
  )
  // A tool output carries one too, inside the result's value.
  assert.deepEqual(
    conversationDigests([toolResult(`total 0\n${dcpTag("m0007")}`)] as any),
    conversationDigests([toolResult(`total 0\n${dcpTag("m0005")}`)] as any),
  )
  // And the forms dcp also writes: a compressed block, a protected message, a
  // priority attribute (its `message` compress mode), and the `compact` id
  // format of its opencode 2 path.
  const same = (a: string, b: string) =>
    assert.deepEqual(
      conversationDigests([userText(a)] as any),
      conversationDigests([userText(b)] as any),
      `${a} | ${b}`,
    )
  same(`Summary.\n\n${dcpTag("b3")}`, `Summary.\n\n${dcpTag("b1")}`)
  same(`Keep this.\n\n${dcpTag("BLOCKED")}`, `Keep this.\n\n${dcpTag("m0002")}`)
  same(`Old output.\n\n${dcpTag("m0009", ' priority="high"')}`, `Old output.\n\n${dcpTag("m0004", ' priority="low"')}`)
  same("Third message.\n\n@4@", "Third message.\n\n@3@")
  same("Old output.\n\n@9@ [high]", "Old output.\n\n@2@")
  same("Keep this.\n\n@blocked@", "Keep this.\n\n@b2@")

  // What is not a reference stays content.
  assert.notDeepEqual(
    conversationDigests([userText(`Third message.\n\n${dcpTag("m0004")}`)] as any),
    conversationDigests([userText(`Edited message.\n\n${dcpTag("m0004")}`)] as any),
  )
  assert.notDeepEqual(
    conversationDigests([userText("Mail me at team@")] as any),
    conversationDigests([userText("Mail me at")] as any),
  )
  assert.notDeepEqual(
    conversationDigests([userText("Line one\n@handle@ said so")] as any),
    conversationDigests([userText("Line one")] as any),
  )
})

test("version 1 hashes dcp's references as text, and a message without one hashes the same either way (h #g258)", () => {
  const tagged = (ref: string) => [userText(`Third message.\n\n${dcpTag(ref)}`)] as any
  assert.notDeepEqual(
    conversationDigests(tagged("m0004"), { version: 1 }),
    conversationDigests(tagged("m0003"), { version: 1 }),
    "version 1 is what every record written before h #g258 was built with",
  )
  // So a record an install without dcp wrote before the upgrade is the same
  // record after it.
  const plain = [userText("Explain the cache."), assistantText("It stores the prefix."), toolResult("total 0")] as any
  assert.deepEqual(conversationDigests(plain, { version: 1 }), conversationDigests(plain))
})

/** dcp's MAX CONTEXT LIMIT warning, shortened; the real block is 1,091 chars. */
const dcpWarning =
  "<dcp-system-reminder>\nCRITICAL WARNING: MAX CONTEXT LIMIT REACHED\n\n" +
  "You MUST use the `compress` tool now.\n</dcp-system-reminder>"

test("conversationDigests ignores dcp's context-limit warning, which it appends to a message later (h #g262)", () => {
  // The measured pair: the same message, sent on its own turn and seen again
  // on the next one after dcp tagged it and renumbered.
  assert.deepEqual(
    conversationDigests([userText(`Second message.\n\n${dcpTag("m0003")}`)] as any),
    conversationDigests(
      [userText(`Second message.\n\n${dcpWarning}\n\n${dcpTag("m0004")}`)] as any,
    ),
  )
  // dcp's opencode 2 reference form, same shape.
  assert.deepEqual(
    conversationDigests([userText("Second message.\n\n@3@")] as any),
    conversationDigests([userText(`Second message.\n\n${dcpWarning}\n\n@4@`)] as any),
  )
  // It appends to an assistant message too, and there it carries no reference
  // of its own, so the gap it leaves has to be levelled on that side as well.
  assert.deepEqual(
    conversationDigests([assistantText("It stores the prefix.")] as any),
    conversationDigests([assistantText(`It stores the prefix.\n\n${dcpWarning}`)] as any),
  )
  // And it can arrive in front of the text rather than behind it.
  assert.deepEqual(
    conversationDigests([assistantText("It stores the prefix.")] as any),
    conversationDigests([assistantText(`${dcpWarning}\n\nIt stores the prefix.`)] as any),
  )
  // A tool output carries it the same way.
  assert.deepEqual(
    conversationDigests([toolResult(`total 0\n${dcpTag("m0007")}`)] as any),
    conversationDigests([toolResult(`total 0\n${dcpWarning}\n${dcpTag("m0005")}`)] as any),
  )

  // What the warning sits next to is still content: it may never hide an edit.
  assert.notDeepEqual(
    conversationDigests([userText(`Second message.\n\n${dcpWarning}`)] as any),
    conversationDigests([userText(`Edited message.\n\n${dcpWarning}`)] as any),
  )
  // opencode's own system-reminder is stored with the message, so it is
  // content and stays in the digest.
  assert.notDeepEqual(
    conversationDigests([userText("Second message.\n<system-reminder>a</system-reminder>")] as any),
    conversationDigests([userText("Second message.\n<system-reminder>b</system-reminder>")] as any),
  )
})

test("version 2 hashes dcp's context-limit warning as text, so a version 2 record keeps its meaning (h #g262)", () => {
  const warned = [userText(`Second message.\n\n${dcpWarning}\n\n${dcpTag("m0004")}`)] as any
  const plainer = [userText(`Second message.\n\n${dcpTag("m0003")}`)] as any
  assert.notDeepEqual(
    conversationDigests(warned, { version: 2 }),
    conversationDigests(plainer, { version: 2 }),
    "version 2 is what every record written between h #g258 and h #g262 was built with",
  )
  // A message carrying no dcp block at all hashes the same under both, so an
  // install without dcp keeps its resume records across the upgrade.
  const plain = [userText("Explain the cache."), assistantText("It stores the prefix."), toolResult("total 0")] as any
  assert.deepEqual(conversationDigests(plain, { version: 2 }), conversationDigests(plain))
})

test("findForkParent matches a fork taken at the parent's end", () => {
  _resetForkFingerprints()
  recordForkFingerprint(keyFor("ses_parent"), PARENT_PROMPT, CLI_A)
  const parent = findParent(keyFor("ses_fork"), FORK_PROMPT, CLI_A)
  assert.ok(parent)
  assert.equal(parent.parentKey, keyFor("ses_parent"))
  assert.equal(parent.claudeSessionId, `claude-${keyFor("ses_parent")}`)
  assert.equal(parent.matched, 3)
})

test("findForkParent refuses a parent recorded on another account", () => {
  _resetForkFingerprints()
  recordForkFingerprint(keyFor("ses_parent"), PARENT_PROMPT, CLI_A)
  assert.equal(findParent(keyFor("ses_fork"), FORK_PROMPT, CLI_B), null)
})

test("findForkParent refuses a mid-conversation fork", () => {
  _resetForkFingerprints()
  // The parent went two turns further than the point the operator cut at, so
  // its recorded chain is longer than the fork's history.
  recordForkFingerprint(
    keyFor("ses_parent"),
    [...FORK_PROMPT, assistantText("Shorter."), userText("And again.")] as any,
    CLI_A,
  )
  assert.equal(findParent(keyFor("ses_fork"), FORK_PROMPT, CLI_A), null)
})

test("findForkParent refuses a conversation that diverged", () => {
  _resetForkFingerprints()
  recordForkFingerprint(
    keyFor("ses_parent"),
    [userText("Explain the cache."), assistantText("Something else entirely."), userText("Now explain forking.")] as any,
    CLI_A,
  )
  assert.equal(findParent(keyFor("ses_fork"), FORK_PROMPT, CLI_A), null)
})

test("findForkParent refuses a parent with user content past the match", () => {
  _resetForkFingerprints()
  // Only the parent's own reply may be extra. A user message past the
  // recorded chain means this history is not that conversation's end.
  recordForkFingerprint(
    keyFor("ses_parent"),
    [userText("Explain the cache."), assistantText("The cache stores the prompt prefix.")] as any,
    CLI_A,
  )
  assert.equal(findParent(keyFor("ses_fork"), FORK_PROMPT, CLI_A), null)
})

test("findForkParent refuses a busy parent and one with no session id", () => {
  _resetForkFingerprints()
  recordForkFingerprint(keyFor("ses_parent"), PARENT_PROMPT, CLI_A)
  assert.equal(
    findParent(keyFor("ses_fork"), FORK_PROMPT, CLI_A, { isBusy: () => true }),
    null,
  )
  assert.equal(
    findParent(keyFor("ses_fork"), FORK_PROMPT, CLI_A, {
      lookupClaudeSessionId: () => undefined,
    }),
    null,
  )
})

test("findForkParent refuses a sibling on another model, cwd or effort", () => {
  for (const other of [
    keyFor("ses_parent", { model: "claude-haiku-4-5" }),
    keyFor("ses_parent", { cwd: "/work/other" }),
    `${keyFor("ses_parent")}::effort=high`,
  ]) {
    _resetForkFingerprints()
    recordForkFingerprint(other, PARENT_PROMPT, CLI_A)
    assert.equal(findParent(keyFor("ses_fork"), FORK_PROMPT, CLI_A), null, other)
  }
})

test("findForkParent never forks a compaction key and never forks into one", () => {
  _resetForkFingerprints()
  const compactionKey = sessionKey(
    "/work/repo",
    "claude-sonnet-5::compaction::ses_parent",
  )
  recordForkFingerprint(compactionKey, PARENT_PROMPT, CLI_A)
  assert.equal(findParent(keyFor("ses_fork"), FORK_PROMPT, CLI_A), null)

  _resetForkFingerprints()
  recordForkFingerprint(keyFor("ses_parent"), PARENT_PROMPT, CLI_A)
  assert.equal(findParent(compactionKey, FORK_PROMPT, CLI_A), null)
})

test("findForkParent prefers the longest matching chain", () => {
  _resetForkFingerprints()
  // An earlier fork of the same thread matches a shorter prefix; the parent
  // that was asked to continue the whole thing is the better branch point.
  recordForkFingerprint(
    keyFor("ses_grandparent"),
    [userText("Explain the cache.")] as any,
    CLI_A,
  )
  recordForkFingerprint(keyFor("ses_parent"), PARENT_PROMPT, CLI_A)
  const parent = findParent(keyFor("ses_fork"), FORK_PROMPT, CLI_A)
  assert.equal(parent?.parentKey, keyFor("ses_parent"))
  assert.equal(parent?.matched, 3)
})

test("buildCliArgs turns a fork parent into --resume <id> --fork-session", () => {
  const sk = `sk-fork-args-${Date.now()}`
  deleteClaudeSessionId(sk)
  const args = buildCliArgs({
    sessionKey: sk,
    skipPermissions: false,
    forkFromClaudeSessionId: "parent-claude-session",
  })
  const at = args.indexOf("--resume")
  assert.ok(at > 0)
  assert.deepEqual(args.slice(at, at + 3), [
    "--resume",
    "parent-claude-session",
    "--fork-session",
  ])
})

test("buildCliArgs keeps its own --resume over a fork parent", () => {
  const sk = `sk-fork-own-${Date.now()}`
  setClaudeSessionId(sk, "own-claude-session")
  try {
    const args = buildCliArgs({
      sessionKey: sk,
      skipPermissions: false,
      forkFromClaudeSessionId: "parent-claude-session",
    })
    assert.ok(!args.includes("--fork-session"))
    assert.deepEqual(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2), [
      "--resume",
      "own-claude-session",
    ])
  } finally {
    deleteClaudeSessionId(sk)
  }
})

test("appendResumeIfNeeded re-points a respawned fork at its own conversation", () => {
  const sk = `sk-fork-respawn-${Date.now()}`
  const forkArgs = [
    "--print",
    "--resume",
    "parent-claude-session",
    "--fork-session",
    "--model",
    "claude-haiku-4-5",
  ]
  // Before the init frame nothing was written, so re-forking the parent is
  // the right recovery and the args are left exactly as they were.
  deleteClaudeSessionId(sk)
  assert.deepEqual(appendResumeIfNeeded(sk, forkArgs), forkArgs)

  setClaudeSessionId(sk, "forked-claude-session")
  try {
    assert.deepEqual(appendResumeIfNeeded(sk, forkArgs), [
      "--print",
      "--resume",
      "forked-claude-session",
      "--model",
      "claude-haiku-4-5",
    ])
  } finally {
    deleteClaudeSessionId(sk)
  }
})

/**
 * A fake CLI that records its argv and every envelope it is handed, and
 * answers each turn with a session id derived from whether it was forked.
 * Two affinities over one fixture is the whole point: the second is the fork.
 */
function createForkCli(options: { forkSessions: boolean }) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-session-fork-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const eventsPath = join(cwd, "events.jsonl")
  writeFileSync(eventsPath, "")
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
const args = process.argv.slice(2)
const record = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + "\\n")
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
if (args.includes("--version")) {
  process.stdout.write("2.1.280\\n")
  process.exit(0)
}
if (args.includes("--help")) {
  process.stdout.write("  --fork-session   When resuming, create a new session ID\\n")
  process.stdout.write("  --plugin-dir <path>\\n")
  process.exit(0)
}
const forked = args.includes("--fork-session")
const sessionId = forked ? "claude-forked-session" : "claude-parent-session"
record({ type: "spawn", args, forked, sessionId })
emit({ type: "system", subtype: "init", session_id: sessionId })
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const envelope = JSON.parse(line)
  if (envelope.type !== "user") return
  record({ type: "input", sessionId, envelope })
  emit({
    type: "assistant",
    session_id: sessionId,
    message: {
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text", text: forked ? "Forked answer" : "Parent answer" }],
    },
  })
  emit({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    is_error: false,
    usage: { input_tokens: 9, output_tokens: 4 },
  })
})
`,
    { mode: 0o755 },
  )

  const modelId = "claude-test-session-fork"
  const model = createClaudeCode({
    cliPath,
    cwd,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    interactive: false,
    autoContinueIncompleteTurns: false,
    forkSessions: options.forkSessions,
  }).languageModel(modelId)

  const keyOf = (affinity: string) =>
    sessionKey(cwd, `${modelId}::tools::${affinity}::${CONTEXT}`)

  return {
    cwd,
    cliPath,
    keyOf,
    events: () =>
      readFileSync(eventsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as any),
    async turn(affinity: string, prompt: any[]) {
      const call: LanguageModelV3CallOptions = {
        prompt,
        headers: { "x-session-affinity": affinity },
        tools: [
          { type: "function", name: "read", inputSchema: { type: "object", properties: {} } },
        ],
        abortSignal: AbortSignal.timeout(30_000),
      } as any
      const response = await model.doStream(call)
      const parts: LanguageModelV3StreamPart[] = []
      for await (const part of response.stream) parts.push(part)
      return parts
        .filter((part) => part.type === "text-delta")
        .map((part) => (part as any).delta)
        .join("")
    },
    /** Resolve the version probe before any turn depends on it (h #g181). */
    async warmCliVersion() {
      for (let attempt = 1; attempt <= 4; attempt++) {
        const version = await detectCliVersion(cliPath)
        if (version) return version
      }
      throw new Error("the fake CLI never answered --version")
    },
    async cleanup() {
      for (const affinity of ["ses_parent", "ses_fork"]) {
        await deleteActiveProcessAndWait(keyOf(affinity))
        deleteClaudeSessionId(keyOf(affinity))
      }
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

test("a forked opencode session resumes the parent's claude conversation", {
  timeout: 60_000,
}, async () => {
  _resetForkFingerprints()
  const fake = createForkCli({ forkSessions: true })
  try {
    assert.equal((await fake.warmCliVersion()).raw, "2.1.280")

    assert.equal(await fake.turn("ses_parent", [...PARENT_PROMPT]), "Parent answer")
    assert.equal(getClaudeSessionId(fake.keyOf("ses_parent")), "claude-parent-session")

    // Evicted here only so the two spawns in `events()` are unambiguous; the
    // test below covers the ordinary case where the parent is still alive.
    await deleteActiveProcessAndWait(fake.keyOf("ses_parent"))

    assert.equal(await fake.turn("ses_fork", [...FORK_PROMPT]), "Forked answer")

    const spawns = fake.events().filter((event) => event.type === "spawn")
    assert.equal(spawns.length, 2)
    const forkArgs: string[] = spawns[1].args
    const at = forkArgs.indexOf("--resume")
    assert.deepEqual(forkArgs.slice(at, at + 3), [
      "--resume",
      "claude-parent-session",
      "--fork-session",
    ])

    // The new opencode session is mapped to the id the CLI reported for the
    // fork, and the parent still owns its own.
    assert.equal(getClaudeSessionId(fake.keyOf("ses_fork")), "claude-forked-session")
    assert.equal(getClaudeSessionId(fake.keyOf("ses_parent")), "claude-parent-session")

    // Nothing was replayed: the forked turn's envelope is the new message.
    const forkInput = fake.events().filter((event) => event.type === "input").at(-1)
    const sent = JSON.stringify(forkInput.envelope)
    assert.ok(!sent.includes("conversation_history"), sent.slice(0, 400))
    assert.ok(sent.includes("Try that again but shorter."))
  } finally {
    await fake.cleanup()
  }
})

test("without forkSessions the same fork replays its history as text", {
  timeout: 60_000,
}, async () => {
  _resetForkFingerprints()
  const fake = createForkCli({ forkSessions: false })
  try {
    assert.equal((await fake.warmCliVersion()).raw, "2.1.280")
    assert.equal(await fake.turn("ses_parent", [...PARENT_PROMPT]), "Parent answer")
    await deleteActiveProcessAndWait(fake.keyOf("ses_parent"))
    assert.equal(await fake.turn("ses_fork", [...FORK_PROMPT]), "Parent answer")

    const spawns = fake.events().filter((event) => event.type === "spawn")
    assert.equal(spawns.length, 2)
    assert.ok(!spawns[1].args.includes("--fork-session"))
    assert.ok(!spawns[1].args.includes("--resume"))

    const forkInput = fake.events().filter((event) => event.type === "input").at(-1)
    const sent = JSON.stringify(forkInput.envelope)
    assert.ok(sent.includes("conversation_history"), sent.slice(0, 400))
  } finally {
    await fake.cleanup()
  }
})

test("an idle live parent is still forkable, which is the ordinary case", {
  timeout: 60_000,
}, async () => {
  _resetForkFingerprints()
  const fake = createForkCli({ forkSessions: true })
  try {
    assert.equal((await fake.warmCliVersion()).raw, "2.1.280")
    assert.equal(await fake.turn("ses_parent", [...PARENT_PROMPT]), "Parent answer")
    // No `deleteActiveProcessAndWait` here on purpose. Idle eviction is off
    // by default, so after a fork the parent's worker is normally still
    // alive; refusing those would make this feature fire almost never. What
    // is refused is a transcript mid-write, which `claudeSessionIsWriting`
    // and the unit tests above cover.
    assert.equal(await fake.turn("ses_fork", [...FORK_PROMPT]), "Forked answer")

    const spawns = fake.events().filter((event) => event.type === "spawn")
    assert.equal(spawns.length, 2)
    assert.ok(spawns[1].args.includes("--fork-session"))
    assert.equal(getClaudeSessionId(fake.keyOf("ses_fork")), "claude-forked-session")
  } finally {
    await fake.cleanup()
  }
})

test("a parent whose turn is still in flight is not forked", () => {
  _resetForkFingerprints()
  recordForkFingerprint(keyFor("ses_parent"), PARENT_PROMPT, CLI_A)
  // `claudeSessionIsWriting` is what the real call site injects; here the
  // predicate stands in for a turn in flight, a proxied call in the air or
  // an unanswered plan-mode question, which are its three true cases.
  assert.equal(
    findParent(keyFor("ses_fork"), FORK_PROMPT, CLI_A, {
      isBusy: (key) => key === keyFor("ses_parent"),
    }),
    null,
  )
})
