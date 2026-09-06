import assert from "node:assert/strict"
import { test } from "node:test"
import { SUBAGENT_DISPATCH_HINT, QUESTION_PROXY_HINT } from "./src/claude-code-language-model.js"
import {
  DEFAULT_PROXY_TOOLS,
  extractAgentTypeList,
  overlayTaskProxyDescription,
  overlayQuestionProxyDescription,
  filterQuestionProxyByOpencodeSupport,
  disallowedToolFlags,
  TASK_PROXY_NOTE,
  TASK_BATCH_PROXY_NOTE,
  TASK_BATCH_TOOL_NAME,
  QUESTION_PROXY_NOTE,
  type ProxyToolDef,
} from "./src/proxy-mcp.js"

// Regression guard for the 2026-07-04 "subagents only write todos" report:
// opencode's @-mention hint says "call the task tool with subagent: X", and
// models resolved that to Claude Code's native TaskCreate (a todo tool),
// created a todo, and narrated a dispatch that never happened. The system
// hint must name the exact proxy tool, the ToolSearch recovery path for
// deferred tools, and explicitly defuse the TaskCreate near-miss.
test("subagent dispatch hint names the tool and defuses TaskCreate", () => {
  assert.match(SUBAGENT_DISPATCH_HINT, /mcp__opencode_proxy__task/)
  assert.match(SUBAGENT_DISPATCH_HINT, /ToolSearch/)
  assert.match(SUBAGENT_DISPATCH_HINT, /select:mcp__opencode_proxy__task/)
  assert.match(SUBAGENT_DISPATCH_HINT, /TaskCreate/)
  assert.match(SUBAGENT_DISPATCH_HINT, /todo list/i)
  assert.match(SUBAGENT_DISPATCH_HINT, /subagent_type/)
  // The "don't grep configs to verify agents" guard (opus burned ~8 tool
  // calls doing exactly that before dispatching).
  assert.match(SUBAGENT_DISPATCH_HINT, /config files/i)
})

test("static task proxy def carries the disambiguation note", () => {
  const task = DEFAULT_PROXY_TOOLS.find((t) => t.name === "task")
  assert.ok(task, "task def missing from DEFAULT_PROXY_TOOLS")
  assert.ok(task!.description.includes(TASK_PROXY_NOTE))
  assert.match(task!.description, /TaskCreate/)
})

// Shape of opencode's live `task` description: generic delegation advice
// first, the agent list LAST. Claude Code truncates long MCP descriptions, so
// overlaying the whole thing buries the list in the cut region — which is what
// made haiku guess `general-purpose`/`code-reviewer` and fail every dispatch
// (live check 2026-07-26). Only the list is kept, and it goes first.
const LIVE_TASK_DESCRIPTION = [
  "Launch a new agent to handle complex, multistep tasks autonomously.",
  "",
  "When NOT to use the Task tool:",
  "- If you want to read a specific file path, use Read instead",
  "",
  "Usage notes:",
  "1. Launch multiple agents concurrently whenever possible",
  "",
  "Available agent types and the tools they have access to:",
  "- explore: Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns, search code for keywords, or answer questions about the codebase. Specify a thoroughness level.",
  "- glm: GLM 5.2",
].join("\n")

test("extractAgentTypeList keeps the agent names and drops the preamble", () => {
  const list = extractAgentTypeList(LIVE_TASK_DESCRIPTION)!
  assert.ok(list, "no list extracted")
  assert.match(list, /subagent_type/)
  assert.match(list, /- explore:/)
  assert.match(list, /- glm: GLM 5\.2/)
  // opencode's generic advice is not carried over.
  assert.ok(!list.includes("When NOT to use"))
  assert.ok(!list.includes("Usage notes"))
  // Long blurbs are trimmed with an ellipsis so the block stays small.
  assert.match(list, /…/)
})

test("extractAgentTypeList declines when there is no parsable list", () => {
  assert.equal(extractAgentTypeList(undefined), undefined)
  assert.equal(extractAgentTypeList("   "), undefined)
  assert.equal(extractAgentTypeList("Launch a new agent. No list here."), undefined)
  // Heading present but no entries under it.
  assert.equal(
    extractAgentTypeList("Available agent types and the tools they have access to:"),
    undefined,
  )
})

test("overlayTaskProxyDescription front-loads the agent list", () => {
  const out = overlayTaskProxyDescription(DEFAULT_PROXY_TOOLS, LIVE_TASK_DESCRIPTION)
  const task = out.find((t) => t.name === "task")!
  // The list must come first: it has to survive Claude Code truncating the
  // tail of a long MCP tool description.
  assert.match(task.description.split("\n")[0], /subagent_type/)
  assert.match(task.description, /- explore:/)
  assert.ok(task.description.endsWith(TASK_PROXY_NOTE))
  // Budget guard for the same truncation: the whole description stays small.
  assert.ok(
    task.description.length < 1600,
    `task description too long to survive truncation: ${task.description.length}`,
  )
  // Other defs untouched (same object references).
  const bashIn = DEFAULT_PROXY_TOOLS.find((t) => t.name === "bash")!
  const bashOut = out.find((t) => t.name === "bash")!
  assert.equal(bashOut, bashIn)
  // Source array not mutated.
  const original = DEFAULT_PROXY_TOOLS.find((t) => t.name === "task")!
  assert.ok(!original.description.includes("subagent_type values"))
})

test("overlayTaskProxyDescription is a no-op without a usable description", () => {
  assert.deepEqual(
    overlayTaskProxyDescription(DEFAULT_PROXY_TOOLS, undefined),
    DEFAULT_PROXY_TOOLS,
  )
  assert.deepEqual(
    overlayTaskProxyDescription(DEFAULT_PROXY_TOOLS, "   "),
    DEFAULT_PROXY_TOOLS,
  )
  // Live description with no agent list: keep the static def rather than
  // pasting opencode's preamble in front of it.
  assert.deepEqual(
    overlayTaskProxyDescription(DEFAULT_PROXY_TOOLS, "Launch a new agent."),
    DEFAULT_PROXY_TOOLS,
  )
})

// --- question proxy: static def, live overlay, version gate ----------

test("static question proxy def is present and carries the disambiguation note", () => {
  const question = DEFAULT_PROXY_TOOLS.find((t) => t.name === "question")
  assert.ok(question, "question def missing from DEFAULT_PROXY_TOOLS")
  assert.ok(question!.description.includes(QUESTION_PROXY_NOTE))
  // Schema must mirror opencode's Prompt struct: questions[].{question,header,options,multiple?}.
  assert.equal(question!.inputSchema.type, "object")
  const props = question!.inputSchema.properties as Record<string, any>
  assert.ok(props.questions, "questions property missing")
  assert.deepEqual(question!.inputSchema.required, ["questions"])
  const item = props.questions.items.properties
  assert.deepEqual(
    Object.keys(item).sort(),
    ["header", "multiple", "options", "question"],
  )
  assert.deepEqual(item.options.items.required, ["label", "description"])
})

test("overlayQuestionProxyDescription prepends live description, keeps the note", () => {
  const live =
    "Use this tool when you need to ask the user questions during execution."
  const out = overlayQuestionProxyDescription(DEFAULT_PROXY_TOOLS, live)
  const question = out.find((t) => t.name === "question")!
  assert.ok(question.description.startsWith(live))
  assert.ok(question.description.endsWith(QUESTION_PROXY_NOTE))
  // Other defs untouched (same object references).
  const bashIn = DEFAULT_PROXY_TOOLS.find((t) => t.name === "bash")!
  const bashOut = out.find((t) => t.name === "bash")!
  assert.equal(bashOut, bashIn)
  // task def untouched too — overlay is question-scoped.
  const taskOut = out.find((t) => t.name === "task")!
  assert.ok(!taskOut.description.includes(live))
  // Source array not mutated.
  const original = DEFAULT_PROXY_TOOLS.find((t) => t.name === "question")!
  assert.ok(!original.description.includes("Use this tool"))
})

test("overlayQuestionProxyDescription is a no-op without a live description", () => {
  assert.deepEqual(
    overlayQuestionProxyDescription(DEFAULT_PROXY_TOOLS, undefined),
    DEFAULT_PROXY_TOOLS,
  )
  assert.deepEqual(
    overlayQuestionProxyDescription(DEFAULT_PROXY_TOOLS, "  "),
    DEFAULT_PROXY_TOOLS,
  )
  // Only-blank live must not blow away the static note-backed description.
  const out = overlayQuestionProxyDescription(DEFAULT_PROXY_TOOLS, "  ")
  const question = out.find((t) => t.name === "question")!
  assert.ok(question.description.includes(QUESTION_PROXY_NOTE))
})

test("filterQuestionProxyByOpencodeSupport drops the def when unsupported", () => {
  // Older opencode builds lack the `question` registry entry; keeping the
  // def would render a forwarded call as `⚙ invalid`.
  const out = filterQuestionProxyByOpencodeSupport(DEFAULT_PROXY_TOOLS, false)
  assert.ok(!out.some((t) => t.name === "question"))
  // Other defs preserved (bash/task/etc. untouched).
  assert.ok(out.some((t) => t.name === "bash"))
  assert.ok(out.some((t) => t.name === "task"))
  assert.equal(out.length, DEFAULT_PROXY_TOOLS.length - 1)
})

test("filterQuestionProxyByOpencodeSupport keeps the def when supported", () => {
  assert.deepEqual(
    filterQuestionProxyByOpencodeSupport(DEFAULT_PROXY_TOOLS, true),
    DEFAULT_PROXY_TOOLS,
  )
  // Works on a filtered subset too.
  const subset: ProxyToolDef[] = [
    DEFAULT_PROXY_TOOLS.find((t) => t.name === "question")!,
    DEFAULT_PROXY_TOOLS.find((t) => t.name === "bash")!,
  ]
  assert.deepEqual(
    filterQuestionProxyByOpencodeSupport(subset, true),
    subset,
  )
})

test("filterQuestionProxyByOpencodeSupport is a no-op when no question def is present", () => {
  const noQuestion = DEFAULT_PROXY_TOOLS.filter((t) => t.name !== "question")
  assert.deepEqual(
    filterQuestionProxyByOpencodeSupport(noQuestion, false),
    noQuestion,
  )
})

// Critical regression guard: the spawn site must compute --disallowedTools
// from the POST-FILTER proxy list, not the pre-filter one. When the
// version gate drops `question` (older opencode without the registry
// entry), AskUserQuestion must NOT be disabled — otherwise the native
// tool is gone AND the proxy replacement is absent, leaving the model
// unable to ask questions at all. This test pins the invariant by
// simulating the exact filter-then-flag sequence the spawn site runs.
test("version gate + disallowedToolFlags: dropping question also drops AskUserQuestion disable", () => {
  // A config that proxies question alongside the standard tools.
  const resolved = [
    DEFAULT_PROXY_TOOLS.find((t) => t.name === "bash")!,
    DEFAULT_PROXY_TOOLS.find((t) => t.name === "question")!,
  ]

  // Supported opencode: question stays → AskUserQuestion is disabled.
  const supported = filterQuestionProxyByOpencodeSupport(resolved, true)
  assert.ok(supported.some((t) => t.name === "question"))
  const supportedFlags = disallowedToolFlags(supported)
  assert.ok(supportedFlags.includes("AskUserQuestion"))

  // Unsupported opencode: question is dropped → AskUserQuestion must NOT
  // be in the disallowed list, so the deny/markdown fallback path stays
  // reachable. The pre-filter array would still have it — the bug.
  const unsupported = filterQuestionProxyByOpencodeSupport(resolved, false)
  assert.ok(!unsupported.some((t) => t.name === "question"))
  const unsupportedFlags = disallowedToolFlags(unsupported)
  assert.ok(!unsupportedFlags.includes("AskUserQuestion"))
  // Sanity: bash is still disabled in both cases.
  assert.ok(unsupportedFlags.includes("Bash"))
})

test("no empty proxy server: combined list is empty when all defs are filtered out", () => {
  // proxyTools: ["Question"] on unsupported opencode → the version gate
  // drops the only def, leaving an empty array. The spawn site must treat
  // this as "no proxy" (null), not start a server with zero tools.
  const onlyQuestion = [DEFAULT_PROXY_TOOLS.find((t) => t.name === "question")!]
  const filtered = filterQuestionProxyByOpencodeSupport(onlyQuestion, false)
  assert.equal(filtered.length, 0)
  // The caller checks combinedList.length > 0 — pin that an empty filtered
  // array is indeed length 0, not truthy-but-empty.
  assert.equal(filtered.length > 0, false)
})

// Regression guard for the 2026-07-05 haiku test: the model's reasoning
// correctly identified mcp__opencode_proxy__question but then emitted a
// tool call for bare `question` (stripping the MCP prefix), which
// opencode rejected as "Model tried to call unavailable tool 'question'".
// The hint must name the exact full tool name and explicitly forbid the
// bare short name.
test("question proxy hint names the exact MCP tool and defuses bare 'question'", () => {
  assert.match(QUESTION_PROXY_HINT, /mcp__opencode_proxy__question/)
  assert.match(QUESTION_PROXY_HINT, /select:mcp__opencode_proxy__question/)
  // Must explicitly warn against calling bare `question`.
  assert.match(QUESTION_PROXY_HINT, /Do NOT call bare `question`/)
  // Must mention that AskUserQuestion is disabled.
  assert.match(QUESTION_PROXY_HINT, /AskUserQuestion/)
  assert.match(QUESTION_PROXY_HINT, /disabled/i)
})

// --- task_batch: the concurrency path (from @broskees' 68ed142) ----------------

test("subagent dispatch hint names task_batch as the way to run subagents concurrently", () => {
  assert.match(SUBAGENT_DISPATCH_HINT, /mcp__opencode_proxy__task_batch/)
  assert.match(SUBAGENT_DISPATCH_HINT, /one at a time|serially/)
  assert.match(SUBAGENT_DISPATCH_HINT, /`tasks` array/)
  // The single-subagent tool is still named in full, first.
  assert.ok(
    SUBAGENT_DISPATCH_HINT.indexOf("mcp__opencode_proxy__task`") < SUBAGENT_DISPATCH_HINT.indexOf("mcp__opencode_proxy__task_batch"),
  )
})

test("task and task_batch point at each other and both disable only Agent", () => {
  const task = DEFAULT_PROXY_TOOLS.find((t) => t.name === "task")!
  const batch = DEFAULT_PROXY_TOOLS.find((t) => t.name === TASK_BATCH_TOOL_NAME)!
  assert.match(task.description, /task_batch/)
  assert.ok(batch.description.endsWith(TASK_BATCH_PROXY_NOTE))
  assert.match(batch.description, /one at a time/)
  assert.deepEqual(disallowedToolFlags([task, batch]), ["Agent"], "the CLI's own Agent is disabled once, not twice")
})

test("the agent-list overlay lands on task_batch too, within the truncation budget", () => {
  const out = overlayTaskProxyDescription(DEFAULT_PROXY_TOOLS, LIVE_TASK_DESCRIPTION)
  const batch = out.find((t) => t.name === TASK_BATCH_TOOL_NAME)!
  assert.match(batch.description.split("\n")[0], /subagent_type/)
  assert.match(batch.description, /- explore:/)
  assert.ok(batch.description.endsWith(TASK_BATCH_PROXY_NOTE))
  assert.ok(
    batch.description.length < 1600,
    `task_batch description too long to survive truncation: ${batch.description.length}`,
  )
  const task = out.find((t) => t.name === "task")!
  assert.ok(task.description.length < 1600, `task description too long: ${task.description.length}`)
})
