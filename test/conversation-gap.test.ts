/**
 * The messages a reused Claude session missed while the conversation ran under
 * another session key (issue #114, h #g239): `src/conversation-gap.ts` on its
 * own, then a fake CLI driving real `doStream` turns over two opencode agents
 * in one conversation.
 *
 * Usage: npx tsx --test test/conversation-gap.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import {
  _resetServedConversations,
  classifyConversationChange,
  CONVERSATION_REWOUND_MARKER,
  findMissedMessages,
  forgetServedConversation,
  MAX_SERVED_CONVERSATIONS,
  moveServedConversation,
  recordServedConversation,
} from "../src/conversation-gap.js"
import { createClaudeCode } from "../src/index.js"
import {
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  getClaudeSessionId,
  killAllActiveProcesses,
  sessionKey,
  setClaudeSessionId,
  transferClaudeSession,
} from "../src/session-manager.js"

const u = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] })
const a = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
})
const p = (messages: unknown[]) => messages as any

// ---------------------------------------------------------------------------
// The finder on its own
// ---------------------------------------------------------------------------

test("a tail of nothing but the session's own reply is not a gap", () => {
  _resetServedConversations()
  recordServedConversation("k", p([u("one")]))
  assert.equal(findMissedMessages("k", p([u("one"), a("reply"), u("two")])), null)

  // A reply that ran tools: assistant and tool content past the chain, no
  // user message, so still the session's own reply.
  recordServedConversation("k", p([u("one")]))
  assert.equal(
    findMissedMessages(
      "k",
      p([
        u("one"),
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: { filePath: "/x" } }],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output: { type: "text", value: "x" } }],
        },
        a("done"),
        u("two"),
      ]),
    ),
    null,
  )
})

test("user messages past the recorded chain are the missed stretch, up to the last reply", () => {
  _resetServedConversations()
  recordServedConversation("k", p([u("one")]))
  const prompt = p([u("one"), a("A1"), u("two"), a("A2"), u("three"), a("A3"), u("four")])
  const missed = findMissedMessages("k", prompt)
  assert.ok(missed)
  // The prompt's own objects, from the first foreign user message to the last
  // reply, never the trailing message the envelope sends anyway.
  assert.deepEqual(
    missed.messages.map((m: any) => m.content[0].text),
    ["two", "A2", "three", "A3"],
  )
  assert.equal(missed.messages[0], prompt[2])
  assert.equal(missed.userMessages, 2)

  // Once this key's session has been asked the whole thread, nothing is missed.
  recordServedConversation("k", prompt)
  assert.equal(findMissedMessages("k", p([...prompt, a("A4"), u("five")])), null)
})

test("nothing is invented for a session never asked, or one with no reply behind it", () => {
  _resetServedConversations()
  assert.equal(findMissedMessages("k", p([u("one"), a("A1"), u("two"), a("A2"), u("three")])), null)
  assert.equal(
    classifyConversationChange("k", p([u("one"), a("A1"), u("two"), a("A2"), u("three")])),
    null,
  )

  // No reply at all yet: there is nothing before the current message to miss,
  // and nothing to compare a rewind against either.
  recordServedConversation("k", p([u("one")]))
  assert.equal(classifyConversationChange("k", p([u("one")])), null)
})

// ---------------------------------------------------------------------------
// A rewound thread (h #g242)
// ---------------------------------------------------------------------------

test("a regenerated reply is a rewind: the session holds the message being resent", () => {
  _resetServedConversations()
  // The session was asked to answer "two" and did.
  recordServedConversation("k", p([u("one"), a("A1"), u("two")]))
  // opencode drops that answer and sends the same thread again: the history up
  // to the last reply is [one, A1], one message short of the chain.
  const change = classifyConversationChange("k", p([u("one"), a("A1"), u("two")]))
  assert.deepEqual(change, {
    kind: "rewound",
    sharedMessages: 2,
    removedMessages: 1,
    removedUserMessages: 1,
  })
  // It is never read as a gap to replay.
  assert.equal(findMissedMessages("k", p([u("one"), a("A1"), u("two")])), null)
})

test("a mid-thread edit is a rewind from the message that changed", () => {
  _resetServedConversations()
  recordServedConversation("k", p([u("one"), a("A1"), u("two"), a("A2"), u("three")]))
  const change = classifyConversationChange(
    "k",
    p([u("one"), a("A1"), u("TWO, edited"), a("A2b"), u("four")]),
  )
  assert.deepEqual(change, {
    kind: "rewound",
    sharedMessages: 2,
    removedMessages: 3,
    removedUserMessages: 2,
  })
})

test("an undo of one exchange and of several are both rewinds", () => {
  _resetServedConversations()
  const served = p([u("one"), a("A1"), u("two"), a("A2"), u("three")])

  // One exchange undone: "three" is gone and a new message takes its place.
  recordServedConversation("k", served)
  assert.deepEqual(classifyConversationChange("k", p([u("one"), a("A1"), u("two"), a("A2"), u("three prime")])), {
    kind: "rewound",
    sharedMessages: 4,
    removedMessages: 1,
    removedUserMessages: 1,
  })

  // Several undone, back to the first reply.
  recordServedConversation("k", served)
  assert.deepEqual(classifyConversationChange("k", p([u("one"), a("A1"), u("two prime")])), {
    kind: "rewound",
    sharedMessages: 2,
    removedMessages: 3,
    removedUserMessages: 2,
  })
})

test("a shared prefix of zero is never a rewind, so a compaction is not one", () => {
  _resetServedConversations()
  const served = p([u("one"), a("A1"), u("two"), a("A2"), u("three")])

  // An edit of the FIRST message diverges at index 0. The limitation is
  // deliberate: it is the same shape opencode's own compaction has.
  recordServedConversation("k", served)
  assert.equal(
    classifyConversationChange("k", p([u("ONE, edited"), a("A1"), u("two"), a("A2"), u("three")])),
    null,
  )

  // opencode compaction: the head of the thread replaced by a summary message,
  // so nothing of the chain survives in place and a reused session must keep
  // working exactly as it did before.
  recordServedConversation("k", served)
  assert.equal(
    classifyConversationChange("k", p([u("summary of the earlier conversation"), a("A2"), u("four")])),
    null,
  )

  // And an undo back to the very first message, which leaves no reply at all.
  recordServedConversation("k", served)
  assert.equal(classifyConversationChange("k", p([u("one again")])), null)
})

// opencode-dcp's context-limit warning, shortened. The real block is 1,091
// characters; nothing here depends on its length, only on where it sits.
const DCP_WARNING =
  "<dcp-system-reminder>\nCRITICAL WARNING: MAX CONTEXT LIMIT REACHED\n\n" +
  "You MUST use the `compress` tool now.\n</dcp-system-reminder>"

test("a dcp context-limit warning appearing on a message it was sent without is not a rewind", () => {
  _resetServedConversations()
  // Turn N. The newest message goes out as the operator wrote it, with only
  // dcp's message reference appended.
  recordServedConversation(
    "k",
    p([u("one"), a("A1"), u("two\n\n<dcp-message-id>m0003</dcp-message-id>")]),
  )

  // Turn N+1. dcp has since tagged "two" with its warning, and renumbered.
  // Not one word of the conversation changed.
  assert.equal(
    classifyConversationChange(
      "k",
      p([
        u("one"),
        a("A1"),
        u(`two\n\n${DCP_WARNING}\n\n<dcp-message-id>m0004</dcp-message-id>`),
        a("A2"),
        u("three"),
      ]),
    ),
    null,
  )
})

test("a dcp warning landing early in the thread is not a rewind either", () => {
  _resetServedConversations()
  // The shape behind the large-removal outliers: dcp tags a message near the
  // head, so the first mismatch is early and the whole tail reads as removed.
  const served = p([
    u("one"),
    a("A1"),
    u("two"),
    a("A2"),
    u("three"),
    a("A3"),
    u("four"),
  ])
  recordServedConversation("k", served)
  assert.equal(
    classifyConversationChange(
      "k",
      p([
        u("one"),
        a("A1"),
        u(`two\n\n${DCP_WARNING}`),
        a("A2"),
        u("three"),
        a("A3"),
        u("four"),
        a("A4"),
        u("five"),
      ]),
    ),
    null,
  )
})

test("a dcp warning on an assistant message does not hide a real edit under it", () => {
  _resetServedConversations()
  // Stripping the warning must not make two different conversations match.
  recordServedConversation("k", p([u("one"), a("A1"), u("two")]))
  const change = classifyConversationChange(
    "k",
    p([u("one"), a("A1"), u(`TWO, edited\n\n${DCP_WARNING}`), a("A2"), u("three")]),
  )
  assert.equal(change?.kind, "rewound")
})

test("opencode's own system-reminder is part of the message and still catches an edit", () => {
  _resetServedConversations()
  // opencode stores these blocks with the message (measured: 1,982 stored
  // parts carry one), so they are content, not a per-request injection, and
  // the digest must keep reading them.
  const reminder =
    '<system-reminder>Note: The user selected line 248 from "src/a.ts". ```x```</system-reminder>'
  recordServedConversation("k", p([u("one"), a("A1"), u(`two\n${reminder}`)]))
  const change = classifyConversationChange(
    "k",
    p([u("one"), a("A1"), u("two\n<system-reminder>Note: something else</system-reminder>"), a("A2"), u("three")]),
  )
  assert.equal(change?.kind, "rewound", "an opencode reminder is never stripped")
})

test("a removed stretch with no user message in it is never a rewind", () => {
  _resetServedConversations()
  // The chain a tool-result turn records: the call, then its result.
  recordServedConversation(
    "k",
    p([
      u("one"),
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: { filePath: "/x" } }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output: { type: "text", value: "x" } }],
      },
    ]),
  )
  // The next turn can re-render that one opencode message's halves as a single
  // assistant message, which leaves the chain's `tool` entry unaccounted for.
  // Killing a healthy session there would be worse than the bug this finds.
  assert.equal(
    classifyConversationChange(
      "k",
      p([
        u("one"),
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "c1", toolName: "read", input: { filePath: "/x" } },
            { type: "text", text: "A1" },
          ],
        },
        u("two"),
      ]),
    ),
    null,
  )
})

test("the chain is the conversation's shape, so a reply flattened for another model still matches", () => {
  _resetServedConversations()
  // Recorded with the reply's reasoning as a `reasoning` part, as opencode
  // hands it to the model that produced it ...
  recordServedConversation(
    "k",
    p([
      u("one"),
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking about it" },
          { type: "text", text: "A1" },
        ],
      },
      u("two"),
    ]),
  )
  // ... and asked again with it flattened into a leading text part, as every
  // other model gets it (h #g215). Still a prefix: assistant by position.
  const missed = findMissedMessages(
    "k",
    p([
      u("one"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "thinking about it" },
          { type: "text", text: "A1" },
        ],
      },
      u("two"),
      a("A2"),
      u("three"),
      a("A3"),
      u("four"),
    ]),
  )
  assert.ok(missed)
  assert.deepEqual(
    missed.messages.map((m: any) => m.content[0].text),
    ["three", "A3"],
  )
})

test("the record is forgotten, moved with the session, and capped", () => {
  _resetServedConversations()
  const thread = p([u("one"), a("A1"), u("two"), a("A2"), u("three")])
  recordServedConversation("from", p([u("one")]))
  moveServedConversation("from", "to")
  assert.equal(findMissedMessages("from", thread), null)
  assert.ok(findMissedMessages("to", thread))
  forgetServedConversation("to")
  assert.equal(findMissedMessages("to", thread), null)

  // `transferClaudeSession` carries it with the id.
  setClaudeSessionId("sm-from", "sid")
  recordServedConversation("sm-from", p([u("one")]))
  try {
    assert.equal(transferClaudeSession("sm-from", "sm-to"), "sid")
    assert.ok(findMissedMessages("sm-to", thread))
    assert.equal(findMissedMessages("sm-from", thread), null)
    // And `deleteClaudeSessionId` drops it with the id.
    deleteClaudeSessionId("sm-to")
    assert.equal(findMissedMessages("sm-to", thread), null)
  } finally {
    deleteClaudeSessionId("sm-from")
    deleteClaudeSessionId("sm-to")
  }

  _resetServedConversations()
  for (let i = 0; i <= MAX_SERVED_CONVERSATIONS; i++) {
    recordServedConversation(`cap-${i}`, p([u("one")]))
  }
  assert.equal(findMissedMessages("cap-0", thread), null, "the quietest key is shed")
  assert.ok(findMissedMessages(`cap-${MAX_SERVED_CONVERSATIONS}`, thread))
})

// ---------------------------------------------------------------------------
// Through a real doStream: two opencode agents, one conversation
// ---------------------------------------------------------------------------

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-gap-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const record = join(cwd, "envelopes.jsonl")
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) {
  console.log("2.1.258")
  process.exit(0)
}
const emit = (message) => console.log(JSON.stringify(message))
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const envelope = JSON.parse(line)
  if (envelope.type !== "user") return
  fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({
    pid: process.pid, argv: process.argv.slice(2), stdin: line,
  }) + "\\n")
  emit({ type: "assistant", session_id: "session-" + process.pid, message: {
    role: "assistant", stop_reason: "end_turn",
    content: [{ type: "text", text: "answered by " + process.pid }],
  } })
  emit({ type: "result", subtype: "success", session_id: "session-" + process.pid,
    is_error: false, usage: { input_tokens: 1, output_tokens: 1 } })
})
`,
    { mode: 0o755 },
  )
  const modelId = "claude-haiku-4-5"
  const provider = createClaudeCode({
    cwd,
    cliPath,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    interactive: false,
    autoContinueIncompleteTurns: false,
    // Nothing here depends on the store, and a single-file run must not
    // write the operator's.
    resumeAfterRestart: false,
  })
  const keyFor = (agent: string) =>
    sessionKey(cwd, `${modelId}::tools::conversation::context=["claude-code","${agent}"]`)
  const turn = async (agent: string, prompt: unknown[]) => {
    const options: LanguageModelV3CallOptions = {
      tools: [{ type: "function", name: "read", inputSchema: { type: "object" } }],
      providerOptions: {
        "claude-code": { opencodeSessionID: "conversation", opencodeAgent: agent },
      },
      prompt: p(prompt),
    }
    const response = await provider.languageModel(modelId).doStream(options)
    let text = ""
    for await (const part of response.stream) {
      if (part.type === "error") throw part.error
      if (part.type === "text-delta") text += part.delta
    }
    return { text }
  }
  const envelopes = (): Array<{ pid: number; argv: string[]; stdin: string }> =>
    existsSync(record)
      ? readFileSync(record, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
  const cleanup = async () => {
    killAllActiveProcesses()
    for (const agent of ["build", "plan"]) deleteClaudeSessionId(keyFor(agent))
    _resetServedConversations()
    rmSync(cwd, { recursive: true, force: true })
  }
  return { cwd, keyFor, turn, envelopes, cleanup }
}

const missedBlock = (stdin: string): string | null => {
  const start = stdin.indexOf("<missed_conversation>")
  if (start < 0) return null
  return stdin.slice(start, stdin.indexOf("</missed_conversation>"))
}

test("a reused claude process is told what the other agent said in between", async () => {
  _resetServedConversations()
  const f = fixture()
  try {
    // build -> plan -> plan -> build, one opencode conversation.
    await f.turn("build", [u("one")])
    await f.turn("plan", [u("one"), a("A1"), u("two")])
    await f.turn("plan", [u("one"), a("A1"), u("two"), a("A2"), u("three")])
    await f.turn("build", [u("one"), a("A1"), u("two"), a("A2"), u("three"), a("A3"), u("four")])

    const sent = f.envelopes()
    assert.equal(sent.length, 4)
    const [build1, plan1, plan2, build2] = sent
    // Two processes: the plan agent's own key spawned once and was reused;
    // the build agent's process answered its first and fourth turn.
    assert.notEqual(plan1.pid, build1.pid)
    assert.equal(plan2.pid, plan1.pid)
    assert.equal(build2.pid, build1.pid, "the build process was reused, not respawned")

    // The plan key had no session: the whole thread so far was replayed.
    assert.match(plan1.stdin, /<conversation_history>/)
    // Its second turn was its own continuation: just the message.
    assert.equal(missedBlock(plan2.stdin), null)
    assert.doesNotMatch(plan2.stdin, /conversation_history/)

    // The build process never saw the plan exchange, so it gets exactly that,
    // ahead of the current message, and not its own first exchange again.
    const block = missedBlock(build2.stdin)
    assert.ok(block, build2.stdin.slice(0, 400))
    assert.match(block, /User: two/)
    assert.match(block, /Assistant: A2/)
    assert.match(block, /User: three/)
    assert.match(block, /Assistant: A3/)
    assert.doesNotMatch(block, /User: one/)
    assert.doesNotMatch(block, /Assistant: A1/)
    assert.match(block, /continued under another opencode agent or model/)
    assert.doesNotMatch(build2.stdin, /<conversation_history>/)
    const envelope = JSON.parse(build2.stdin)
    const texts = envelope.message.content.map((c: any) => c.text)
    assert.equal(texts[texts.length - 1], "four", "the current message follows the replay")

    // Back on build with nothing in between: an ordinary turn again.
    await f.turn("build", [
      u("one"), a("A1"), u("two"), a("A2"), u("three"), a("A3"), u("four"), a("A4"), u("five"),
    ])
    const build3 = f.envelopes()[4]
    assert.equal(build3.pid, build1.pid)
    assert.equal(missedBlock(build3.stdin), null)
    assert.match(build3.stdin, /"five"/)
  } finally {
    await f.cleanup()
  }
})

test("a session resumed with --resume after its process was evicted gets the same replay", async () => {
  _resetServedConversations()
  const f = fixture()
  try {
    await f.turn("build", [u("one")])
    await f.turn("plan", [u("one"), a("A1"), u("two")])
    const buildKey = f.keyFor("build")
    const buildSession = getClaudeSessionId(buildKey)
    assert.ok(buildSession)
    // Idle eviction, the LRU cap: the process goes, the id stays.
    await deleteActiveProcessAndWait(buildKey)

    await f.turn("build", [u("one"), a("A1"), u("two"), a("A2"), u("three")])
    const sent = f.envelopes()
    assert.equal(sent.length, 3)
    const resumed = sent[2]
    assert.notEqual(resumed.pid, sent[0].pid, "a fresh process")
    assert.deepEqual(
      resumed.argv.slice(resumed.argv.indexOf("--resume"), resumed.argv.indexOf("--resume") + 2),
      ["--resume", buildSession],
    )
    const block = missedBlock(resumed.stdin)
    assert.ok(block, resumed.stdin.slice(0, 400))
    assert.match(block, /User: two/)
    assert.match(block, /Assistant: A2/)
    assert.doesNotMatch(block, /User: one/)
    assert.doesNotMatch(resumed.stdin, /<conversation_history>/)
  } finally {
    await f.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Through a real doStream: a thread that was edited, undone or regenerated
// ---------------------------------------------------------------------------

const historyBlock = (stdin: string): string | null => {
  const start = stdin.indexOf("<conversation_history>")
  if (start < 0) return null
  return stdin.slice(start, stdin.indexOf("</conversation_history>"))
}

const countNotes = (text: string): number =>
  text.split(CONVERSATION_REWOUND_MARKER).length - 1

test("an edited message starts a fresh claude session and replays the thread that remains", async () => {
  _resetServedConversations()
  const f = fixture()
  try {
    await f.turn("build", [u("first message")])
    await f.turn("build", [u("first message"), a("A1"), u("banana")])

    // The operator edits the second message. What comes back shares only the
    // first exchange with what this session was answering, and the session
    // still holds "banana".
    const third = await f.turn("build", [
      u("first message"), a("A1"), u("cherry"), a("A2"), u("third message"),
    ])

    const sent = f.envelopes()
    assert.equal(sent.length, 3)
    const [one, two, rewound] = sent
    assert.equal(two.pid, one.pid, "the first two turns share a process")
    assert.notEqual(rewound.pid, one.pid, "the rewound turn spawned a fresh one")
    assert.ok(!rewound.argv.includes("--resume"), rewound.argv.join(" "))

    // The whole thread as it stands now, and nothing of the message that was
    // edited away.
    const block = historyBlock(rewound.stdin)
    assert.ok(block, rewound.stdin.slice(0, 400))
    assert.match(block, /User: first message/)
    assert.match(block, /User: cherry/)
    assert.match(block, /Assistant: A2/)
    assert.doesNotMatch(block, /banana/)
    assert.equal(missedBlock(rewound.stdin), null)

    // One note, in the reply, and only on the turn that reset the session.
    assert.equal(countNotes(third.text), 1, third.text)
    assert.match(third.text, /edited or undone/)
    const fourth = await f.turn("build", [
      u("first message"), a("A1"), u("cherry"), a("A2"), u("third message"), a("A3"), u("fourth"),
    ])
    assert.equal(countNotes(fourth.text), 0)
    const after = f.envelopes()[3]
    assert.equal(after.pid, rewound.pid, "the fresh session is reused like any other")
    assert.equal(historyBlock(after.stdin), null)
  } finally {
    await f.cleanup()
  }
})

test("a regenerated reply resets the session that already answered the message", async () => {
  _resetServedConversations()
  const f = fixture()
  try {
    await f.turn("build", [u("one")])
    await f.turn("build", [u("one"), a("A1"), u("two")])
    // opencode drops that answer and asks the same thread again.
    const again = await f.turn("build", [u("one"), a("A1"), u("two")])

    const sent = f.envelopes()
    assert.equal(sent.length, 3)
    assert.notEqual(sent[2].pid, sent[0].pid)
    assert.ok(!sent[2].argv.includes("--resume"), sent[2].argv.join(" "))
    const block = historyBlock(sent[2].stdin)
    assert.ok(block, sent[2].stdin.slice(0, 400))
    assert.match(block, /User: one/)
    assert.match(block, /Assistant: A1/)
    assert.equal(countNotes(again.text), 1, again.text)
  } finally {
    await f.cleanup()
  }
})

test("a dcp warning moving onto an earlier message keeps the process and writes no note", async () => {
  _resetServedConversations()
  const f = fixture()
  try {
    await f.turn("build", [u("first message\n\n<dcp-message-id>m0001</dcp-message-id>")])
    await f.turn("build", [
      u("first message\n\n<dcp-message-id>m0001</dcp-message-id>"),
      a("A1"),
      u("second message\n\n<dcp-message-id>m0003</dcp-message-id>"),
    ])

    // Third turn: dcp has tagged the second message with its context-limit
    // warning and renumbered every reference. The operator changed nothing.
    const third = await f.turn("build", [
      u("first message\n\n<dcp-message-id>m0002</dcp-message-id>"),
      a("A1"),
      u(`second message\n\n${DCP_WARNING}\n\n<dcp-message-id>m0004</dcp-message-id>`),
      a("A2"),
      u(`third message\n\n${DCP_WARNING}\n\n<dcp-message-id>m0005</dcp-message-id>`),
    ])

    const sent = f.envelopes()
    assert.equal(sent.length, 3)
    const [one, two, three] = sent
    assert.equal(two.pid, one.pid, "the first two turns share a process")
    assert.equal(three.pid, one.pid, "the third turn kept the same claude process")
    assert.equal(historyBlock(three.stdin), null, "nothing was replayed as text")
    assert.equal(missedBlock(three.stdin), null)
    assert.equal(countNotes(third.text), 0, third.text)
  } finally {
    await f.cleanup()
  }
})

test("a compacted thread keeps its process: a shared prefix of zero is not a rewind", async () => {
  _resetServedConversations()
  const f = fixture()
  try {
    await f.turn("build", [u("one")])
    await f.turn("build", [u("one"), a("A1"), u("two")])
    // opencode compacted: the head of the thread is now a summary message, so
    // nothing of what this session was asked survives in place.
    const after = await f.turn("build", [
      u("summary of the earlier conversation"), a("A2"), u("three"),
    ])

    const sent = f.envelopes()
    assert.equal(sent.length, 3)
    assert.equal(sent[2].pid, sent[0].pid, "the same process answered it")
    assert.equal(historyBlock(sent[2].stdin), null)
    assert.equal(missedBlock(sent[2].stdin), null)
    assert.equal(countNotes(after.text), 0, after.text)
  } finally {
    await f.cleanup()
  }
})
