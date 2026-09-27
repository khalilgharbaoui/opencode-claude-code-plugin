/**
 * The fallback model chain: what counts as a refusal, how a chain is
 * declared and resolved, and the wiring that actually moves a turn.
 *
 * The unit half pins the NEGATIVE cases hardest, for the same reason
 * `test-account-failover.ts` does: a chain that fires on "an error" would
 * quietly re-run somebody's turn on a different model, at a different price,
 * with no trace but a log line. The two positive signals are the frames Claude
 * Code 2.1.280 actually emitted on 2026-09-27 (see the module comment in
 * `src/model-fallback.ts`), pasted here verbatim.
 *
 * The fake-CLI half drives a real `doStream` against a `claude` that refuses
 * the first model and serves the second, and asserts the three things only the
 * wiring can show: the second spawn's `--model`, the `▌` note, and that the
 * refused attempt's error text never reaches the operator.
 *
 * Usage: npx tsx --test test-model-fallback.ts
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  _resetAgentRegistryForTests,
  parseAgentFrontmatter,
  parseFallbackModelList,
  setAgentRegistry,
  setProviderFallbackModels,
} from "./src/agent-models.js"
import { createClaudeCode } from "./src/index.js"
import { filterSideQuestionHistory } from "./src/message-builder.js"
import {
  MODEL_FALLBACK_MARKER,
  formatModelFallbackNote,
  modelRefusalFromAssistant,
  modelRefusalFromResult,
  nextFallbackModel,
  provesModelServing,
  resolveFallbackChain,
} from "./src/model-fallback.js"
import { setOpencodeClient } from "./src/runtime-status.js"
import { deleteActiveProcess, sessionKey } from "./src/session-manager.js"

// ---------------------------------------------------------------------------
// Detection: the two measured frames, and everything that must not fire
// ---------------------------------------------------------------------------

/** Verbatim from `claude -p --model claude-3-opus-20240229 "hi"`, 2.1.280. */
const REFUSAL_TEXT =
  "There's an issue with the selected model (claude-3-opus-20240229). It may not exist or you may not have access to it. Run --model to pick a different model."

const REFUSAL_ASSISTANT = {
  type: "assistant",
  error: "model_not_found",
  is_api_error_message: true,
  message: {
    role: "assistant",
    model: "<synthetic>",
    stop_reason: "stop_sequence",
    content: [{ type: "text", text: REFUSAL_TEXT }],
  },
}

const REFUSAL_RESULT = {
  type: "result",
  subtype: "success",
  is_error: true,
  api_error_status: 404,
  terminal_reason: "api_error",
  result: REFUSAL_TEXT,
  num_turns: 1,
  total_cost_usd: 0,
}

test("the CLI's model_not_found kind is a refusal", () => {
  const refusal = modelRefusalFromAssistant(REFUSAL_ASSISTANT)
  assert.equal(refusal?.kind, "model_not_found")
  assert.equal(refusal?.detail, REFUSAL_TEXT)
})

test("the terminal result carries the same refusal", () => {
  assert.equal(modelRefusalFromResult(REFUSAL_RESULT)?.kind, "model_not_found")
})

test("the result's subtype is `success`, so it can never be the signal", () => {
  // The trap this whole module exists for: nothing in the subtype says the
  // turn failed, which is why a refused model used to finish as a clean stop
  // with the CLI's error text standing in for Claude's answer.
  assert.equal(REFUSAL_RESULT.subtype, "success")
})

test("no other account-level error kind is a model refusal", () => {
  // Every one of these is in the CLI's assistant-error enum and every one of
  // them fails identically on the next model, so retrying would spend a spawn
  // per chain entry to print the same message.
  for (const error of [
    "authentication_failed",
    "oauth_org_not_allowed",
    "account_on_hold",
    "verification_required",
    "billing_error",
    "rate_limit",
    "overloaded",
    "invalid_request",
    "server_error",
    "unknown",
    "max_output_tokens",
    "cloud_credential_error",
  ]) {
    assert.equal(
      modelRefusalFromAssistant({ ...REFUSAL_ASSISTANT, error }),
      null,
      `${error} must not be a model refusal`,
    )
  }
})

test("nothing but the two signals counts as a refusal", () => {
  assert.equal(modelRefusalFromAssistant({ type: "assistant" }), null)
  assert.equal(modelRefusalFromAssistant({ type: "result", error: "model_not_found" }), null)
  assert.equal(modelRefusalFromResult({ type: "result", is_error: true, result: "fetch failed: ECONNRESET" }), null)
  assert.equal(modelRefusalFromResult({ type: "result", is_error: true, result: "API Error: 400 invalid request" }), null)
  // A served turn whose answer happens to quote the sentence: `is_error` is
  // what keeps the chain out of it.
  assert.equal(
    modelRefusalFromResult({ type: "result", is_error: false, result: REFUSAL_TEXT }),
    null,
  )
})

test("the curly apostrophe form is recognised too", () => {
  assert.equal(
    modelRefusalFromResult({
      type: "result",
      is_error: true,
      result: "There’s an issue with the selected model (claude-x).",
    })?.kind,
    "model_not_found",
  )
})

// ---------------------------------------------------------------------------
// Committing an attempt
// ---------------------------------------------------------------------------

test("real content commits an attempt, the CLI's own error reply does not", () => {
  assert.equal(provesModelServing({ type: "content_block_start" }), true)
  assert.equal(provesModelServing({ type: "content_block_delta" }), true)
  assert.equal(
    provesModelServing({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
    true,
  )
  // The refusal frame is an `assistant` message WITH content, so without the
  // `is_api_error_message` check it would commit the very attempt it refuses
  // and the chain would never move.
  assert.equal(provesModelServing(REFUSAL_ASSISTANT), false)
  assert.equal(provesModelServing({ type: "system", subtype: "init" }), false)
  assert.equal(provesModelServing({ type: "result", subtype: "success" }), false)
  assert.equal(provesModelServing({ type: "assistant", message: { content: [] } }), false)
})

// ---------------------------------------------------------------------------
// Declaring a chain
// ---------------------------------------------------------------------------

test("a declared list is read in every shape a person writes it", () => {
  assert.deepEqual(parseFallbackModelList(["claude-opus-5", " claude-sonnet-5 "]), [
    "claude-opus-5",
    "claude-sonnet-5",
  ])
  assert.deepEqual(parseFallbackModelList("claude-opus-5, claude-sonnet-5"), [
    "claude-opus-5",
    "claude-sonnet-5",
  ])
  assert.deepEqual(parseFallbackModelList("[claude-opus-5, claude-sonnet-5]"), [
    "claude-opus-5",
    "claude-sonnet-5",
  ])
  assert.deepEqual(parseFallbackModelList(undefined), [])
  assert.deepEqual(parseFallbackModelList(""), [])
  assert.deepEqual(parseFallbackModelList(42), [])
})

test("frontmatter reads both YAML spellings of the list", () => {
  assert.deepEqual(
    parseAgentFrontmatter(
      ["---", "mode: subagent", "fallbackModels: [claude-opus-5, claude-sonnet-5]", "---", "body"].join("\n"),
    ),
    { mode: "subagent", fallbackModels: ["claude-opus-5", "claude-sonnet-5"] },
  )
  assert.deepEqual(
    parseAgentFrontmatter(
      [
        "---",
        "fallbackModels:",
        "  - claude-opus-5",
        "  - claude-sonnet-5",
        "reasoningEffort: low",
        "---",
      ].join("\n"),
    ),
    { fallbackModels: ["claude-opus-5", "claude-sonnet-5"], reasoningEffort: "low" },
  )
})

test("a block list ends at the next key, not at the next blank line", () => {
  // The whole reason the parser tracks a key across lines: `reasoningEffort`
  // below must not be swallowed into the list, and `permission:`'s nested
  // keys must stay out of the record as they always have.
  const record = parseAgentFrontmatter(
    [
      "---",
      "fallbackModels:",
      "  - claude-opus-5",
      "forceModel: claude-fable-5-1",
      "permission:",
      "  bash: allow",
      "---",
    ].join("\n"),
  )
  assert.deepEqual(record, {
    fallbackModels: ["claude-opus-5"],
    forceModel: "claude-fable-5-1",
  })
})

// ---------------------------------------------------------------------------
// Resolving a chain
// ---------------------------------------------------------------------------

test("a per-agent chain replaces the provider one rather than extending it", () => {
  assert.deepEqual(
    resolveFallbackChain("worker", "claude-fable-5-1", {
      records: { worker: { fallbackModels: ["claude-sonnet-5"] } },
      providerFallbackModels: ["claude-opus-5", "claude-haiku-4-5"],
    }),
    ["claude-sonnet-5"],
  )
})

test("an agent that declares nothing takes the provider chain", () => {
  assert.deepEqual(
    resolveFallbackChain("worker", "claude-fable-5-1", {
      records: { worker: { fallbackModels: [] } },
      providerFallbackModels: ["claude-opus-5", "claude-sonnet-5"],
    }),
    ["claude-opus-5", "claude-sonnet-5"],
  )
  // And so does a request with no agent at all.
  assert.deepEqual(
    resolveFallbackChain(undefined, "claude-fable-5-1", {
      providerFallbackModels: ["claude-opus-5"],
    }),
    ["claude-opus-5"],
  )
})

test("no declaration anywhere means no chain", () => {
  assert.deepEqual(resolveFallbackChain("worker", "claude-opus-5", { records: {} }), [])
  assert.deepEqual(resolveFallbackChain(undefined, "claude-opus-5", {}), [])
})

test("the account marker rides along and is never taken from the entry", () => {
  // The chain must not move billing. An entry spelling its own account is
  // ignored the same way a `forceModel` carrying one is.
  assert.deepEqual(
    resolveFallbackChain(undefined, "claude-fable-5-1@appical", {
      providerFallbackModels: ["claude-opus-5", "claude-sonnet-5@work"],
    }),
    ["claude-opus-5@appical", "claude-sonnet-5@appical"],
  )
})

test("an unknown id is refused and skipped, and the rest of the chain survives", () => {
  assert.deepEqual(
    resolveFallbackChain(undefined, "claude-fable-5-1", {
      providerFallbackModels: ["claude-3-opus-20240229", "not-a-model", "claude-sonnet-5"],
    }),
    ["claude-sonnet-5"],
  )
})

test("the model that just failed and any duplicate come out of the chain", () => {
  assert.deepEqual(
    resolveFallbackChain(undefined, "claude-opus-5", {
      providerFallbackModels: ["claude-opus-5", "claude-sonnet-5", "claude-sonnet-5"],
    }),
    ["claude-sonnet-5"],
  )
})

test("an agent that pinned a whole provider/model is left alone", () => {
  assert.deepEqual(
    resolveFallbackChain("worker", "claude-opus-5", {
      records: { worker: { model: "openai/gpt-5", fallbackModels: ["claude-sonnet-5"] } },
      providerFallbackModels: ["claude-sonnet-5"],
    }),
    [],
  )
})

test("each model is offered once and then the chain is spent", () => {
  const chain = ["claude-opus-5", "claude-sonnet-5"]
  assert.equal(nextFallbackModel(chain, new Set()), "claude-opus-5")
  assert.equal(nextFallbackModel(chain, new Set(["claude-opus-5"])), "claude-sonnet-5")
  assert.equal(nextFallbackModel(chain, new Set(chain)), undefined)
})

test("the registry setters feed the no-override resolution path", () => {
  _resetAgentRegistryForTests()
  assert.deepEqual(resolveFallbackChain("worker", "claude-opus-5"), [])
  setProviderFallbackModels(["claude-sonnet-5"])
  setAgentRegistry({ worker: { mode: "subagent", fallbackModels: ["claude-haiku-4-5"] } })
  assert.deepEqual(resolveFallbackChain("worker", "claude-opus-5"), ["claude-haiku-4-5"])
  assert.deepEqual(resolveFallbackChain("other", "claude-opus-5"), ["claude-sonnet-5"])
  _resetAgentRegistryForTests()
  assert.deepEqual(resolveFallbackChain("worker", "claude-opus-5"), [])
})

// ---------------------------------------------------------------------------
// The note
// ---------------------------------------------------------------------------

test("the note names the model that failed, why, and the one now serving", () => {
  const note = formatModelFallbackNote({
    failed: "claude-opus-5",
    serving: "claude-sonnet-5",
    refusal: { kind: "model_not_found" },
  })
  assert.ok(note.trimStart().startsWith(MODEL_FALLBACK_MARKER))
  assert.match(note, /claude-opus-5/)
  assert.match(note, /claude-sonnet-5/)
  assert.match(note, /model_not_found/)
})

test("a usage-limit fallback says so instead of blaming the model", () => {
  const note = formatModelFallbackNote({
    failed: "claude-opus-5",
    serving: "claude-haiku-4-5",
    refusal: { kind: "account_limit" },
  })
  assert.match(note, /out of usage on this account/)
  assert.doesNotMatch(note, /model_not_found/)
})

test("the note is stripped from a transcript replayed to the CLI", () => {
  // It was never Claude's output, so a rebuilt transcript must not hand it
  // back as something Claude said (AGENTS.md, PLUGIN_NOTE_MARKERS).
  const note = formatModelFallbackNote({
    failed: "claude-opus-5",
    serving: "claude-sonnet-5",
    refusal: { kind: "model_not_found" },
  })
  const filtered = filterSideQuestionHistory([
    { role: "user", content: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: note },
        { type: "text", text: "the real answer" },
      ],
    },
  ] as any)
  const kept = (filtered[1] as any).content.map((part: any) => part.text)
  assert.deepEqual(kept, ["the real answer"])
})

// ---------------------------------------------------------------------------
// The wiring, through a real doStream and a fake CLI
// ---------------------------------------------------------------------------

/**
 * A fake `claude` that refuses one model by name and serves anything else,
 * reproducing the 2.1.280 frames byte for byte. Every run appends its argv, so
 * which model each spawn asked for is asserted without reaching into the
 * plugin.
 */
function createFakeCli(refusedModel: string) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-model-fallback-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const record = join(cwd, "spawns.jsonl")
  const source = `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")

if (process.argv.includes("--version")) {
  process.stdout.write("2.1.280\\n")
  process.exit(0)
}

const REFUSED = ${JSON.stringify(refusedModel)}
const at = process.argv.indexOf("--model")
const model = at === -1 ? "" : process.argv[at + 1]
const refused = model === REFUSED

const REFUSAL_TEXT =
  "There's an issue with the selected model (" + model + "). It may not exist or you may not have access to it. Run --model to pick a different model."

const REFUSED_LINES = [
  { type: "system", subtype: "init", session_id: "refused-session", tools: [] },
  {
    type: "assistant",
    session_id: "refused-session",
    parent_tool_use_id: null,
    error: "model_not_found",
    is_api_error_message: true,
    message: {
      role: "assistant",
      model: "<synthetic>",
      stop_reason: "stop_sequence",
      content: [{ type: "text", text: REFUSAL_TEXT }],
    },
  },
  {
    type: "result",
    subtype: "success",
    session_id: "refused-session",
    is_error: true,
    api_error_status: 404,
    terminal_reason: "api_error",
    result: REFUSAL_TEXT,
    duration_ms: 7,
    num_turns: 1,
  },
]

const SERVED_LINES = [
  { type: "system", subtype: "init", session_id: "served-session", tools: [] },
  {
    type: "stream_event",
    session_id: "served-session",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "served by " + model } },
  },
  {
    type: "stream_event",
    session_id: "served-session",
    event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
  },
  {
    type: "result",
    subtype: "success",
    session_id: "served-session",
    is_error: false,
    result: "served by " + model,
    duration_ms: 9,
    num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
]

const rl = readline.createInterface({ input: process.stdin })
let answered = false
rl.on("line", (line) => {
  if (answered) return
  answered = true
  fs.appendFileSync(
    ${JSON.stringify(record)},
    JSON.stringify({ argv: process.argv.slice(2), stdin: line }) + "\\n",
  )
  for (const l of refused ? REFUSED_LINES : SERVED_LINES) {
    process.stdout.write(JSON.stringify(l) + "\\n")
  }
})
`
  writeFileSync(cliPath, source)
  chmodSync(cliPath, 0o755)
  return {
    cliPath,
    cwd,
    spawns: (): any[] =>
      existsSync(record)
        ? readFileSync(record, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [],
  }
}

/** The MCP status lookup runs on every turn; give it something to answer with. */
setOpencodeClient({
  tool: { list: async () => ({ data: [] }) },
})

const FIRST_MODEL = "claude-opus-5"
const SECOND_MODEL = "claude-sonnet-5"

function buildModel(fake: ReturnType<typeof createFakeCli>, modelId = FIRST_MODEL) {
  return createClaudeCode({
    cliPath: fake.cliPath,
    baseCliPath: fake.cliPath,
    cwd: fake.cwd,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
  }).languageModel(modelId)
}

const TOOLS = [
  {
    type: "function",
    name: "read",
    description: "Read a file",
    inputSchema: { type: "object", properties: {} },
  },
]

async function drain(response: any): Promise<any[]> {
  const parts: any[] = []
  for await (const part of response.stream) parts.push(part)
  return parts
}

function textOf(parts: any[]): string {
  return parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
}

function modelArg(argv: string[]): string | undefined {
  const at = argv.indexOf("--model")
  return at === -1 ? undefined : argv[at + 1]
}

function keysFor(cwd: string, ...models: string[]): string[] {
  return models.map((model) =>
    sessionKey(cwd, `${model}::tools::default::context=["claude-code",null]`),
  )
}

const prompt = [{ role: "user", content: [{ type: "text", text: "go" }] }]

after(() => _resetAgentRegistryForTests())

test("a refused model hands the turn to the next one in the chain", async () => {
  _resetAgentRegistryForTests()
  // `claude-opus-5` is in the declared list AND is what the turn starts on,
  // so this also proves the failed model is dropped from its own chain
  // instead of being retried.
  setProviderFallbackModels([FIRST_MODEL, SECOND_MODEL])
  const fake = createFakeCli(FIRST_MODEL)
  try {
    const parts = await drain(
      await buildModel(fake).doStream({ prompt, tools: TOOLS } as any),
    )

    const spawns = fake.spawns()
    assert.equal(spawns.length, 2, "the refused model and then the fallback")
    assert.equal(modelArg(spawns[0].argv), FIRST_MODEL)
    assert.equal(modelArg(spawns[1].argv), SECOND_MODEL)

    const text = textOf(parts)
    assert.match(text, /▌ \*\*model fallback:\*\*/)
    assert.match(text, new RegExp(`served by ${SECOND_MODEL}`))
    // The refused attempt is discarded whole: the CLI's error never reaches
    // the operator and never lands in the transcript.
    assert.doesNotMatch(text, /There's an issue with the selected model/)

    // The note is its own text part, or the marker strip cannot remove it.
    const noteParts = parts.filter(
      (part) => part.type === "text-delta" && String(part.delta).trimStart().startsWith(MODEL_FALLBACK_MARKER),
    )
    assert.equal(noteParts.length, 1)
    // Claude's own answer is a different part, so the marker strip removes the
    // note without taking the reply with it.
    assert.doesNotMatch(String(noteParts[0].delta), new RegExp(`served by ${SECOND_MODEL}$`, "m"))
    assert.ok(
      parts.some(
        (part) => part.type === "text-delta" && String(part.delta) === `served by ${SECOND_MODEL}`,
      ),
      "the answer must arrive in its own part",
    )

    // One `stream-start`, one `finish`, and the turn is a clean stop.
    assert.equal(parts.filter((part) => part.type === "stream-start").length, 1)
    const finishes = parts.filter((part) => part.type === "finish")
    assert.equal(finishes.length, 1)
    assert.equal(finishes[0].finishReason.unified, "stop")
  } finally {
    for (const key of keysFor(fake.cwd, FIRST_MODEL, SECOND_MODEL)) deleteActiveProcess(key)
    _resetAgentRegistryForTests()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("an exhausted chain surfaces the original error unchanged", async () => {
  _resetAgentRegistryForTests()
  // The only entry is the model the turn already runs on, so the chain
  // resolves empty and nothing is retried.
  setProviderFallbackModels([SECOND_MODEL])
  const fake = createFakeCli(SECOND_MODEL)
  try {
    const parts = await drain(
      await buildModel(fake, SECOND_MODEL).doStream({ prompt, tools: TOOLS } as any),
    )
    assert.equal(fake.spawns().length, 1)
    const text = textOf(parts)
    assert.match(text, /There's an issue with the selected model/)
    assert.doesNotMatch(text, /▌ \*\*model fallback:\*\*/)
  } finally {
    for (const key of keysFor(fake.cwd, SECOND_MODEL)) deleteActiveProcess(key)
    _resetAgentRegistryForTests()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("one bad entry in the chain does not stop the good one serving", async () => {
  _resetAgentRegistryForTests()
  setProviderFallbackModels(["claude-3-opus-20240229", SECOND_MODEL])
  const fake = createFakeCli(FIRST_MODEL)
  try {
    const parts = await drain(
      await buildModel(fake).doStream({ prompt, tools: TOOLS } as any),
    )
    const spawns = fake.spawns()
    // The retired id never reaches a spawn: it was refused at resolution.
    assert.equal(spawns.length, 2)
    assert.equal(modelArg(spawns[1].argv), SECOND_MODEL)
    assert.match(textOf(parts), new RegExp(`served by ${SECOND_MODEL}`))
  } finally {
    for (const key of keysFor(fake.cwd, FIRST_MODEL, SECOND_MODEL)) deleteActiveProcess(key)
    _resetAgentRegistryForTests()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a served turn is untouched by a configured chain", async () => {
  _resetAgentRegistryForTests()
  setProviderFallbackModels([SECOND_MODEL])
  const fake = createFakeCli("something-else-entirely")
  try {
    const parts = await drain(
      await buildModel(fake).doStream({ prompt, tools: TOOLS } as any),
    )
    assert.equal(fake.spawns().length, 1)
    assert.equal(modelArg(fake.spawns()[0].argv), FIRST_MODEL)
    const text = textOf(parts)
    assert.match(text, new RegExp(`served by ${FIRST_MODEL}`))
    assert.doesNotMatch(text, /▌ \*\*model fallback:\*\*/)
  } finally {
    for (const key of keysFor(fake.cwd, FIRST_MODEL)) deleteActiveProcess(key)
    _resetAgentRegistryForTests()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a compaction turn never falls back", async () => {
  _resetAgentRegistryForTests()
  setProviderFallbackModels([SECOND_MODEL])
  // Compaction resolves its own model (`claude-haiku-4-5` by default), so the
  // fake refuses that one: if the chain were live the turn would move, and
  // the summary opencode stores would be written by a model nobody chose.
  const fake = createFakeCli("claude-haiku-4-5")
  try {
    const parts = await drain(
      await buildModel(fake).doStream({
        prompt,
        tools: TOOLS,
        providerOptions: { "claude-code": { opencodeAgent: "compaction" } },
      } as any),
    )
    assert.equal(fake.spawns().length, 1)
    assert.equal(modelArg(fake.spawns()[0].argv), "claude-haiku-4-5")
    assert.doesNotMatch(textOf(parts), /▌ \*\*model fallback:\*\*/)
  } finally {
    for (const key of keysFor(fake.cwd, FIRST_MODEL)) deleteActiveProcess(key)
    deleteActiveProcess(sessionKey(fake.cwd, "claude-haiku-4-5::compaction::default"))
    _resetAgentRegistryForTests()
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})
