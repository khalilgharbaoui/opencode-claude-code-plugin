/**
 * The synthetic session title, which is what names a session when
 * `titleModel` is unset (the default), read off the title requests real
 * opencode builds send (h #g296).
 *
 * opencode 2 wraps the user's first message in a `<message>` element behind a
 * lead-in, and the stub used to title the lead-in: every opencode 2 session
 * was "Here First Message Conversation Message ...". opencode 1 sends the
 * message as its own user message and must keep its title.
 *
 * Usage: npx tsx --test test/default-title.test.ts
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClaudeCode } from "../src/index.js"
import { setOpencodeClient } from "../src/runtime-status.js"
import { killAllActiveProcesses } from "../src/session-manager.js"
import { synthesizeTitle, titleSubject } from "../src/title.js"

setOpencodeClient({ tool: { list: async () => ({ data: [] }) } })
after(() => killAllActiveProcesses())

const FIRST_MESSAGE =
  "Why does my Rust borrow checker reject this closure that mutates a vector? Reply in one short sentence."

/**
 * The prompt opencode 2.2.6 handed the provider for a new session's title,
 * captured from `doStream` on 2026-11-10 (`opencode run`, model
 * `claude-code/claude-haiku-5-5`). The user message is verbatim; the title
 * agent's system prompt is cut to its first sentence. Headers carried
 * `x-opencode-agent: title`, and the call carried the whole tool set.
 */
const V2_FIRST_MESSAGE_PROMPT = [
  {
    role: "system",
    content:
      "You name conversations so the user can find them later in a list of past sessions.",
  },
  {
    role: "user",
    content: [
      {
        type: "text",
        text: `Here is the first message of the conversation:\n\n<message>\n${FIRST_MESSAGE}\n</message>\n\nReply with only the title.`,
      },
    ],
  },
] as any

/**
 * What opencode 2.2.6 sends when an existing session's title is regenerated
 * (`PATCH /api/session/:id` with an empty title), read out of its binary
 * (`SessionTitle.generate`): the first message under `Original request:`,
 * then the recent exchange. Not captured live: the PATCH answered 204 and no
 * title request reached the provider.
 */
const V2_REGENERATE_PROMPT = [
  {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          "Here is the conversation so far:",
          "<conversation>",
          "Original request:",
          FIRST_MESSAGE,
          "Recent conversation:",
          "Assistant: The closure takes a mutable borrow of the vector.",
          "User: And how do I fix it?",
          "</conversation>",
          "Reply with only the title.",
        ].join("\n"),
      },
    ],
  },
] as any

/**
 * The prompt opencode 1.19.4 handed the provider for the same first message,
 * captured the same way (no tools, `opencodeAgent: "title"` in the provider
 * options). Its own lead-in is a user message of its own, and the user's
 * message follows it, quoted as opencode stored it. opencode titled that
 * session "Why My Rust Borrow Checker Reject".
 */
const V1_PROMPT = [
  {
    role: "system",
    content: "You are a title generator. You output ONLY a thread title. Nothing else.",
  },
  { role: "user", content: [{ type: "text", text: "Generate a title for this conversation:\n" }] },
  { role: "user", content: [{ type: "text", text: `"${FIRST_MESSAGE}"` }] },
] as any

test("an opencode 2 title names the user's message, not the lead-in", () => {
  assert.equal(synthesizeTitle(V2_FIRST_MESSAGE_PROMPT), "Why My Rust Borrow Checker Reject")
})

test("an opencode 2 regenerated title names the original request", () => {
  assert.equal(synthesizeTitle(V2_REGENERATE_PROMPT), "Why My Rust Borrow Checker Reject")
})

test("an opencode 1 title is unchanged", () => {
  assert.equal(synthesizeTitle(V1_PROMPT), "Why My Rust Borrow Checker Reject")
})

test("titleSubject keeps a message that itself mentions the element", () => {
  const text =
    "Here is the first message of the conversation:\n\n<message>\nwrap it in <message> and </message> tags\n</message>\n\nReply with only the title."
  assert.equal(titleSubject(text), "wrap it in <message> and </message> tags")
})

test("titleSubject keeps the whole conversation when it has no Original request label", () => {
  const text = "Here is the conversation so far:\n<conversation>\nUser: fix the build\n</conversation>"
  assert.equal(titleSubject(text), "User: fix the build")
})

test("titleSubject leaves anything without the element shape alone", () => {
  for (const text of [
    FIRST_MESSAGE,
    // More than one line before the element is a message, not a lead-in.
    "Look at this.\nThen this:\n<message>\nquoted\n</message>",
    // Never closed.
    "Here is the first message of the conversation:\n<message>\nhalf of it",
    // Another element.
    "Here is something:\n<note>\nx\n</note>",
    "",
  ]) {
    assert.equal(titleSubject(text), text)
  }
})

test("an empty first message is a New Session, not the lead-in", () => {
  const prompt = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Here is the first message of the conversation:\n\n<message>\n\n</message>\n\nReply with only the title.",
        },
      ],
    },
  ] as any
  assert.equal(synthesizeTitle(prompt), "New Session")
})

test("an opencode 2 title request through doStream gets the user's title and spawns nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-default-title-"))
  const cliPath = join(dir, "fake-claude.cjs")
  const record = join(dir, "launches.jsonl")
  // Records every launch but the version and help probes.
  writeFileSync(
    cliPath,
    `#!${process.execPath}
if (process.argv.includes("--version")) { process.stdout.write("2.1.314\\n"); process.exit(0) }
if (process.argv.includes("--help")) { process.stdout.write("Usage: claude [options]\\n"); process.exit(0) }
require("node:fs").appendFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)) + "\\n")
process.exit(1)
`,
  )
  chmodSync(cliPath, 0o755)
  try {
    const model = createClaudeCode({
      cliPath,
      baseCliPath: cliPath,
      cwd: dir,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: [],
      hostApi: "v2",
    } as any).languageModel("claude-haiku-5-5")
    const result = await model.doStream({
      prompt: V2_FIRST_MESSAGE_PROMPT,
      tools: [
        {
          type: "function",
          name: "shell",
          description: "Run a command",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      headers: { "x-session-affinity": "ses_redacted", "x-opencode-agent": "title" },
    } as any)
    const parts: any[] = []
    const reader = result.stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }
    const text = parts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("")
    assert.equal(text, "Why My Rust Borrow Checker Reject")
    const finish = parts.find((part) => part.type === "finish")
    assert.equal(finish.providerMetadata["claude-code"].synthetic, true)
    assert.equal(existsSync(record) ? readFileSync(record, "utf8") : "", "")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
