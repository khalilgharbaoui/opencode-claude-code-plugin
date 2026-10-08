import { test } from "node:test"
import assert from "node:assert/strict"

import {
  CUSTOMISE_ANSWER,
  DEFAULT_ANSWER,
  LAST_ANSWER_PREFIX,
  PER_TASK_ANSWER,
  SUBAGENT_DISPATCH_MARKER,
  SUBAGENT_DISPATCH_TOOL_CALL_PREFIX,
  _resetSubagentDispatchForTests,
  claimDispatchChoice,
  clearSubagentDispatchQuestions,
  consumeSubagentDispatchAnswer,
  createSubagentDispatchQuestion,
  dispatchAccountCandidates,
  dispatchAgentTypes,
  dispatchTasksFromCalls,
  firstUserText,
  hasCandidateClaim,
  isSubagentDispatchActive,
  lookupSessionChoice,
  forgetSessionChoice,
  parseCustomChoice,
  recallDispatchChoice,
  recordDispatchClaims,
  resolveDispatchAccountSpawn,
  stripSubagentDispatchParts,
  type DispatchContext,
  type DispatchTask,
  type SubagentChoice,
} from "../src/subagent-dispatch.js"
import { parseQuestionAnswers } from "../src/plan-mode-question.js"
import { taskBatchTasks } from "../src/proxy-mcp.js"

const SK = "/work::claude-opus-5::tools::ses_parent::context=[\"claude-code\",\"build\"]"

function context(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    parentSessionId: "ses_parent",
    sourceAccount: "default",
    accounts: [],
    groups: null,
    crossGroup: false,
    describeDefault: () => ({ model: "claude-opus-5", effort: "high" }),
    ...overrides,
  }
}

function task(overrides: Partial<DispatchTask> = {}): DispatchTask {
  return {
    callId: "call-1",
    batchIndex: null,
    agent: "implementor",
    prompt: "do the thing",
    description: "do thing",
    ...overrides,
  }
}

/** The sentence opencode's `question` tool writes, measured live (h #g227). */
function answerPart(
  toolCallId: string,
  pairs: Array<[string, string]>,
): Record<string, unknown> {
  const body = pairs.map(([q, a]) => `"${q}"="${a}"`).join(", ")
  return {
    type: "tool-result",
    toolCallId,
    output: {
      type: "text",
      value: `User has answered your questions: ${body}. You can now continue with the user's answers in mind.`,
    },
  }
}

function promptWith(part: Record<string, unknown>) {
  return [{ role: "tool", content: [part] }]
}

/** Drive one form: ask, answer, and hand back whatever the module decided. */
function answerForm(
  call: { toolCallId: string; input: { questions: Array<{ question: string }> } },
  answers: string[],
) {
  const pairs = call.input.questions.map(
    (question, index) => [question.question, answers[index] ?? ""] as [string, string],
  )
  return consumeSubagentDispatchAnswer(SK, promptWith(answerPart(call.toolCallId, pairs)))
}

test("the gate is off unless the operator asked for it", () => {
  const base = {
    opencodeHasQuestion: true,
    compactionMode: false,
    childSession: false,
  }
  assert.equal(isSubagentDispatchActive({ ...base, configured: undefined }), false)
  assert.equal(isSubagentDispatchActive({ ...base, configured: "off" }), false)
  assert.equal(isSubagentDispatchActive({ ...base, configured: "ask" }), true)
})

test("the gate refuses compaction, a child session and a host with no question tool", () => {
  const base = { configured: "ask" as const, opencodeHasQuestion: true }
  assert.equal(
    isSubagentDispatchActive({ ...base, compactionMode: true, childSession: false }),
    false,
  )
  assert.equal(
    isSubagentDispatchActive({ ...base, compactionMode: false, childSession: true }),
    false,
  )
  assert.equal(
    isSubagentDispatchActive({
      configured: "ask",
      opencodeHasQuestion: false,
      compactionMode: false,
      childSession: false,
    }),
    false,
  )
})

test("tasks are read out of a single task and out of a batch", () => {
  const tasks = dispatchTasksFromCalls(
    [
      {
        toolCallId: "one",
        toolName: "task",
        input: { prompt: "alpha", subagent_type: "implementor", description: "a" },
      },
      {
        toolCallId: "two",
        toolName: "task_batch",
        input: {
          tasks: [
            { prompt: "beta", subagent_type: "designer", description: "b" },
            { prompt: "gamma", subagent_type: "implementor", description: "c" },
          ],
        },
      },
      { toolCallId: "three", toolName: "bash", input: { command: "ls" } },
    ],
    taskBatchTasks,
  )
  assert.deepEqual(
    tasks.map((entry) => [entry.callId, entry.batchIndex, entry.agent, entry.prompt]),
    [
      ["one", null, "implementor", "alpha"],
      ["two", 0, "designer", "beta"],
      ["two", 1, "implementor", "gamma"],
    ],
  )
  assert.deepEqual(dispatchAgentTypes(tasks), ["implementor", "designer"])
})

test("the first form is always exactly one question", () => {
  _resetSubagentDispatchForTests()
  const tasks = [
    task({ agent: "implementor", prompt: "a" }),
    task({ agent: "designer", prompt: "b" }),
    task({ agent: "implementor", prompt: "c" }),
  ]
  const call = createSubagentDispatchQuestion(SK, ["call-1"], tasks, context())
  assert.equal(call.input.questions.length, 1)
  assert.ok(call.toolCallId.startsWith(SUBAGENT_DISPATCH_TOOL_CALL_PREFIX))
  const labels = call.input.questions[0].options.map((option) => option.label)
  assert.equal(labels[0], DEFAULT_ANSWER)
  assert.ok(labels.includes(CUSTOMISE_ANSWER))
  assert.ok(labels.includes("claude-sonnet-5-5 / medium"))
  // The counts an operator needs to recognise their own dispatch.
  assert.match(call.input.questions[0].question, /3 subagents/)
  assert.match(call.input.questions[0].question, /2 implementor/)
  // A header longer than opencode's documented 30 characters is cut here.
  assert.ok(call.input.questions[0].header.length <= 30)
})

test("Default releases with no choice at all, which is today's behaviour", () => {
  _resetSubagentDispatchForTests()
  const tasks = [task()]
  const call = createSubagentDispatchQuestion(SK, ["call-1"], tasks, context())
  const step = answerForm(call, [DEFAULT_ANSWER])
  assert.equal(step?.kind, "release")
  assert.equal(step.kind === "release" && step.choices.size, 0)
  assert.deepEqual(step.kind === "release" ? step.heldCallIds : null, ["call-1"])
})

test("a combo picked at the summary applies to every task", () => {
  _resetSubagentDispatchForTests()
  const tasks = [task({ prompt: "a" }), task({ agent: "designer", prompt: "b" })]
  const call = createSubagentDispatchQuestion(SK, ["call-1"], tasks, context())
  const step = answerForm(call, ["claude-haiku-5-5 / low"])
  assert.equal(step?.kind, "release")
  if (step?.kind !== "release") return
  assert.deepEqual(step.choices.get(0), { model: "claude-haiku-5-5", effort: "low" })
  assert.deepEqual(step.choices.get(1), { model: "claude-haiku-5-5", effort: "low" })
})

test("Customise opens one row per agent type, and a multi-task row offers per task", () => {
  _resetSubagentDispatchForTests()
  const tasks = [
    task({ agent: "implementor", prompt: "a" }),
    task({ agent: "implementor", prompt: "b" }),
    task({ agent: "designer", prompt: "c" }),
  ]
  const first = createSubagentDispatchQuestion(SK, ["call-1"], tasks, context())
  const step = answerForm(first, [CUSTOMISE_ANSWER])
  assert.equal(step?.kind, "form")
  if (step?.kind !== "form") return
  const questions = step.call.input.questions
  assert.equal(questions.length, 2)
  assert.deepEqual(
    questions.map((question) => question.header),
    ["implementor", "designer"],
  )
  // Only the type with more than one task may ask for a per-task form.
  assert.ok(questions[0].options.some((option) => option.label === PER_TASK_ANSWER))
  assert.ok(!questions[1].options.some((option) => option.label === PER_TASK_ANSWER))
})

test("a per-type answer lands on every task of that type and nothing else", () => {
  _resetSubagentDispatchForTests()
  const tasks = [
    task({ agent: "implementor", prompt: "a" }),
    task({ agent: "implementor", prompt: "b" }),
    task({ agent: "designer", prompt: "c" }),
  ]
  const first = createSubagentDispatchQuestion(SK, ["call-1"], tasks, context())
  const second = answerForm(first, [CUSTOMISE_ANSWER])
  assert.equal(second?.kind, "form")
  if (second?.kind !== "form") return
  const step = answerForm(second.call, ["claude-opus-5-5 / max", DEFAULT_ANSWER])
  assert.equal(step?.kind, "release")
  if (step?.kind !== "release") return
  assert.deepEqual(step.choices.get(0), { model: "claude-opus-5-5", effort: "max" })
  assert.deepEqual(step.choices.get(1), { model: "claude-opus-5-5", effort: "max" })
  assert.equal(step.choices.get(2), undefined)
})

test("one task in a group can be given its own setting, and the rest keep the type's", () => {
  _resetSubagentDispatchForTests()
  const tasks = [
    task({ agent: "implementor", prompt: "a", description: "first" }),
    task({ agent: "implementor", prompt: "b", description: "second" }),
    task({ agent: "implementor", prompt: "c", description: "third" }),
  ]
  const first = createSubagentDispatchQuestion(SK, ["call-1"], tasks, context())
  const second = answerForm(first, [CUSTOMISE_ANSWER])
  assert.equal(second?.kind, "form")
  if (second?.kind !== "form") return
  const third = answerForm(second.call, [PER_TASK_ANSWER])
  assert.equal(third?.kind, "form")
  if (third?.kind !== "form") return
  assert.equal(third.call.input.questions.length, 3)
  const step = answerForm(third.call, [
    "claude-opus-5-5 / max",
    DEFAULT_ANSWER,
    DEFAULT_ANSWER,
  ])
  assert.equal(step?.kind, "release")
  if (step?.kind !== "release") return
  assert.deepEqual(step.choices.get(0), { model: "claude-opus-5-5", effort: "max" })
  assert.equal(step.choices.get(1), undefined)
  assert.equal(step.choices.get(2), undefined)
})

test("a per-task row can keep what the type picked", () => {
  _resetSubagentDispatchForTests()
  const tasks = [
    task({ agent: "implementor", prompt: "a" }),
    task({ agent: "implementor", prompt: "b" }),
  ]
  const first = createSubagentDispatchQuestion(SK, ["call-1"], tasks, context())
  const second = answerForm(first, [CUSTOMISE_ANSWER])
  if (second?.kind !== "form") throw new Error("expected the type form")
  const third = answerForm(second.call, ["claude-sonnet-5-5 / medium"])
  // The type row asked for a combo, not per task, so this already released.
  assert.equal(third?.kind, "release")
  if (third?.kind !== "release") return
  assert.deepEqual(third.choices.get(0), { model: "claude-sonnet-5-5", effort: "medium" })
  assert.deepEqual(third.choices.get(1), { model: "claude-sonnet-5-5", effort: "medium" })
})

test("the account row is offered only when there is more than one candidate", () => {
  const one = context({ accounts: ["default"] })
  assert.deepEqual(dispatchAccountCandidates(one), ["default"])
  const two = context({ accounts: ["default", "work"] })
  assert.deepEqual(dispatchAccountCandidates(two), ["default", "work"])
})

test("an account in another group is not offered unless the cross-group flag is on", () => {
  const groups = { work: "work" }
  const guarded = context({ accounts: ["default", "work"], groups })
  assert.deepEqual(dispatchAccountCandidates(guarded), ["default"])
  const opened = context({ accounts: ["default", "work"], groups, crossGroup: true })
  assert.deepEqual(dispatchAccountCandidates(opened), ["default", "work"])
})

test("the account the operator picks reaches every task of the dispatch", () => {
  _resetSubagentDispatchForTests()
  const tasks = [task({ prompt: "a" }), task({ agent: "designer", prompt: "b" })]
  const ctx = context({ accounts: ["default", "work"] })
  const first = createSubagentDispatchQuestion(SK, ["call-1"], tasks, ctx)
  const second = answerForm(first, [CUSTOMISE_ANSWER])
  if (second?.kind !== "form") throw new Error("expected the type form")
  assert.equal(second.call.input.questions.length, 3)
  assert.equal(second.call.input.questions[2].header, "Account")
  const step = answerForm(second.call, [DEFAULT_ANSWER, DEFAULT_ANSWER, "work"])
  assert.equal(step?.kind, "release")
  if (step?.kind !== "release") return
  assert.equal(step.choices.get(0)?.account, "work")
  assert.equal(step.choices.get(1)?.account, "work")
})

test("an account answer that is not a candidate is refused and the dispatch stays put", () => {
  _resetSubagentDispatchForTests()
  const tasks = [task()]
  const ctx = context({ accounts: ["default", "work"], groups: { work: "work" } })
  const first = createSubagentDispatchQuestion(SK, ["call-1"], tasks, ctx)
  const second = answerForm(first, [CUSTOMISE_ANSWER])
  if (second?.kind !== "form") throw new Error("expected the type form")
  // With the guard on, the account row is not even offered.
  assert.equal(second.call.input.questions.length, 1)
  const step = answerForm(second.call, [DEFAULT_ANSWER])
  assert.equal(step?.kind, "release")
  if (step?.kind !== "release") return
  assert.equal(step.choices.get(0)?.account, undefined)
})

test("a typed account outside the group is refused even when the row exists", () => {
  _resetSubagentDispatchForTests()
  const tasks = [task()]
  // `secret` is in another group, so it is never a candidate; `work` is.
  const ctx = context({
    accounts: ["default", "work", "secret"],
    groups: { secret: "locked" },
  })
  const first = createSubagentDispatchQuestion(SK, ["call-1"], tasks, ctx)
  const second = answerForm(first, [CUSTOMISE_ANSWER])
  if (second?.kind !== "form") throw new Error("expected the type form")
  assert.deepEqual(
    second.call.input.questions[1].options.map((option) => option.label),
    ["default", "work"],
  )
  const step = answerForm(second.call, [DEFAULT_ANSWER, "secret"])
  assert.equal(step?.kind, "release")
  if (step?.kind !== "release") return
  assert.equal(step.choices.get(0)?.account, undefined)
})

test("same as last time is remembered per conversation and per agent type", () => {
  _resetSubagentDispatchForTests()
  const tasks = [task({ agent: "implementor" })]
  const first = createSubagentDispatchQuestion(SK, ["call-1"], tasks, context())
  assert.ok(
    !first.input.questions[0].options.some((option) => option.label === LAST_ANSWER_PREFIX),
    "nothing is remembered yet",
  )
  answerForm(first, ["claude-haiku-5-5 / low"])
  assert.deepEqual(recallDispatchChoice("ses_parent", "implementor"), {
    model: "claude-haiku-5-5",
    effort: "low",
  })
  assert.equal(recallDispatchChoice("ses_other", "implementor"), undefined)
  assert.equal(recallDispatchChoice("ses_parent", "designer"), undefined)

  const second = createSubagentDispatchQuestion(SK, ["call-2"], tasks, context())
  const labels = second.input.questions[0].options.map((option) => option.label)
  assert.equal(labels[0], LAST_ANSWER_PREFIX)
  const step = answerForm(second, [LAST_ANSWER_PREFIX])
  assert.equal(step?.kind, "release")
  if (step?.kind !== "release") return
  assert.deepEqual(step.choices.get(0), { model: "claude-haiku-5-5", effort: "low" })
})

test("a dismissed form dispatches with the defaults and says so", () => {
  _resetSubagentDispatchForTests()
  const tasks = [task()]
  const call = createSubagentDispatchQuestion(SK, ["call-1"], tasks, context())
  const step = consumeSubagentDispatchAnswer(
    SK,
    promptWith({
      type: "tool-result",
      toolCallId: call.toolCallId,
      output: { type: "error-text", value: "The user dismissed this question" },
    }),
  )
  assert.equal(step?.kind, "release")
  if (step?.kind !== "release") return
  assert.equal(step.choices.size, 0)
  assert.ok(step.note?.startsWith(`\n${SUBAGENT_DISPATCH_MARKER}`))
  assert.match(step.note!, /dismissed/)
})

test("an unrecognised answer dispatches with the defaults and says so", () => {
  _resetSubagentDispatchForTests()
  const tasks = [task()]
  const call = createSubagentDispatchQuestion(SK, ["call-1"], tasks, context())
  const step = answerForm(call, ["run them on the good one please"])
  assert.equal(step?.kind, "release")
  if (step?.kind !== "release") return
  assert.equal(step.choices.size, 0)
  assert.ok(step.note?.includes(SUBAGENT_DISPATCH_MARKER))
})

test("a typed model, a typed effort and both are accepted; anything else is not", () => {
  assert.deepEqual(parseCustomChoice("claude-opus-5-5"), { model: "claude-opus-5-5" })
  assert.deepEqual(parseCustomChoice("max"), { effort: "max" })
  assert.deepEqual(parseCustomChoice("claude-opus-5-5 max"), {
    model: "claude-opus-5-5",
    effort: "max",
  })
  assert.deepEqual(parseCustomChoice("claude-opus-5-5 / max"), {
    model: "claude-opus-5-5",
    effort: "max",
  })
  assert.deepEqual(parseCustomChoice("claude-opus-5-5, max"), {
    model: "claude-opus-5-5",
    effort: "max",
  })
  assert.equal(parseCustomChoice("gpt-5"), null)
  assert.equal(parseCustomChoice("claude-opus-5-5 turbo"), null)
  assert.equal(parseCustomChoice("   "), null)
})

test("a typed custom answer round-trips through the form", () => {
  _resetSubagentDispatchForTests()
  const tasks = [task()]
  const call = createSubagentDispatchQuestion(SK, ["call-1"], tasks, context())
  const step = answerForm(call, ["claude-sonnet-4-6 xhigh"])
  assert.equal(step?.kind, "release")
  if (step?.kind !== "release") return
  assert.deepEqual(step.choices.get(0), { model: "claude-sonnet-4-6", effort: "xhigh" })
})

test("a pending form is dropped at the session boundary", () => {
  _resetSubagentDispatchForTests()
  const call = createSubagentDispatchQuestion(SK, ["call-1"], [task()], context())
  clearSubagentDispatchQuestions(SK)
  assert.equal(answerForm(call, [DEFAULT_ANSWER]), null)
})

// ---------------------------------------------------------------------------
// Matching a child to its dispatch
// ---------------------------------------------------------------------------

function claims(entries: Array<[DispatchTask, SubagentChoice]>): DispatchTask[] {
  const tasks = entries.map(([entry]) => entry)
  const choices = new Map<number, SubagentChoice>()
  for (const [index, [, choice]] of entries.entries()) choices.set(index, choice)
  recordDispatchClaims("ses_parent", tasks, choices)
  return tasks
}

test("two concurrent children of the same type each take their own choice", () => {
  _resetSubagentDispatchForTests()
  claims([
    [task({ agent: "implementor", prompt: "ALPHA" }), { model: "claude-opus-5-5" }],
    [task({ agent: "implementor", prompt: "BETA" }), { model: "claude-haiku-5-5" }],
  ])
  // Deliberately claimed in the reverse of dispatch order: opencode runs them
  // concurrently and nothing promises which one reaches doStream first.
  const beta = claimDispatchChoice({
    sessionId: "ses_beta",
    agent: "implementor",
    prompt: "BETA",
    parentSessionId: "ses_parent",
  })
  const alpha = claimDispatchChoice({
    sessionId: "ses_alpha",
    agent: "implementor",
    prompt: "ALPHA",
    parentSessionId: "ses_parent",
  })
  assert.deepEqual(beta, { model: "claude-haiku-5-5" })
  assert.deepEqual(alpha, { model: "claude-opus-5-5" })
})

test("a claim is consumed once, and the child keeps it for its later turns", () => {
  _resetSubagentDispatchForTests()
  claims([[task({ prompt: "ALPHA" }), { effort: "max" }]])
  const ask = {
    agent: "implementor",
    prompt: "ALPHA",
    parentSessionId: "ses_parent",
  }
  assert.deepEqual(claimDispatchChoice({ sessionId: "ses_a", ...ask }), { effort: "max" })
  // A second, different child with the same prompt finds nothing left.
  assert.equal(claimDispatchChoice({ sessionId: "ses_b", ...ask }), undefined)
  // The first child's later turns answer from the session map, with no parent.
  assert.deepEqual(lookupSessionChoice("ses_a"), { effort: "max" })
  assert.deepEqual(
    claimDispatchChoice({ sessionId: "ses_a", agent: undefined, prompt: undefined, parentSessionId: undefined }),
    { effort: "max" },
  )
})

test("a session that is not the dispatcher's child can never take a claim", () => {
  _resetSubagentDispatchForTests()
  claims([[task({ prompt: "ALPHA" }), { effort: "max" }]])
  assert.equal(
    claimDispatchChoice({
      sessionId: "ses_stranger",
      agent: "implementor",
      prompt: "ALPHA",
      parentSessionId: "ses_somebody_else",
    }),
    undefined,
  )
  assert.equal(
    claimDispatchChoice({
      sessionId: "ses_root",
      agent: "implementor",
      prompt: "ALPHA",
      parentSessionId: undefined,
    }),
    undefined,
  )
  // Still there for the child it was recorded for.
  assert.deepEqual(
    claimDispatchChoice({
      sessionId: "ses_child",
      agent: "implementor",
      prompt: "ALPHA",
      parentSessionId: "ses_parent",
    }),
    { effort: "max" },
  )
})

test("the wrong agent type never takes another type's claim", () => {
  _resetSubagentDispatchForTests()
  claims([[task({ agent: "designer", prompt: "SHARED" }), { model: "claude-opus-5-5" }]])
  assert.equal(
    claimDispatchChoice({
      sessionId: "ses_a",
      agent: "implementor",
      prompt: "SHARED",
      parentSessionId: "ses_parent",
    }),
    undefined,
  )
})

test("an empty choice records no claim, so a default dispatch costs a child nothing", () => {
  _resetSubagentDispatchForTests()
  const recorded = recordDispatchClaims(
    "ses_parent",
    [task({ prompt: "ALPHA" })],
    new Map([[0, {}]]),
  )
  assert.equal(recorded, 0)
  assert.equal(hasCandidateClaim("implementor", "ALPHA"), false)
})

test("a claim older than its TTL is never taken", () => {
  _resetSubagentDispatchForTests()
  const old = Date.now() - 20 * 60_000
  recordDispatchClaims(
    "ses_parent",
    [task({ prompt: "ALPHA" })],
    new Map([[0, { effort: "max" }]]),
    old,
  )
  assert.equal(hasCandidateClaim("implementor", "ALPHA"), false)
  assert.equal(
    claimDispatchChoice({
      sessionId: "ses_a",
      agent: "implementor",
      prompt: "ALPHA",
      parentSessionId: "ses_parent",
    }),
    undefined,
  )
})

test("a deleted session forgets the choice it claimed", () => {
  _resetSubagentDispatchForTests()
  claims([[task({ prompt: "ALPHA" }), { effort: "max" }]])
  claimDispatchChoice({
    sessionId: "ses_a",
    agent: "implementor",
    prompt: "ALPHA",
    parentSessionId: "ses_parent",
  })
  forgetSessionChoice("ses_a")
  assert.equal(lookupSessionChoice("ses_a"), undefined)
})

test("the first user text is the task prompt, verbatim", () => {
  assert.equal(
    firstUserText([
      { role: "system", content: "ignored" },
      { role: "user", content: [{ type: "text", text: "CHILD-ALPHA: do it." }] },
      { role: "assistant", content: [{ type: "text", text: "later" }] },
    ]),
    "CHILD-ALPHA: do it.",
  )
  assert.equal(firstUserText([{ role: "user", content: "plain" }]), "plain")
  assert.equal(firstUserText([{ role: "assistant", content: [] }]), undefined)
})

// ---------------------------------------------------------------------------
// The account spawn
// ---------------------------------------------------------------------------

test("a dispatched account spawns its own wrapper with the marker off the model", async () => {
  const spawn = await resolveDispatchAccountSpawn({
    account: "work",
    baseCliPath: "/usr/local/bin/claude",
    modelId: "claude-opus-5-5@work",
    ensureRuntime: async (account, baseCliPath) => {
      assert.equal(account, "work")
      assert.equal(baseCliPath, "/usr/local/bin/claude")
      return { cliPath: "/cache/claude-work" }
    },
  })
  assert.deepEqual(spawn, {
    cliPath: "/cache/claude-work",
    modelId: "claude-opus-5-5",
    target: "work",
    failedOver: true,
  })
})

test("the default account spawns the base binary and never a wrapper", async () => {
  const spawn = await resolveDispatchAccountSpawn({
    account: "default",
    baseCliPath: "/usr/local/bin/claude",
    modelId: "claude-opus-5-5@work",
    ensureRuntime: async () => {
      throw new Error("the default account must not build a wrapper")
    },
  })
  assert.equal(spawn?.cliPath, "/usr/local/bin/claude")
  assert.equal(spawn?.modelId, "claude-opus-5-5")
})

test("a wrapper that cannot be written leaves the subagent where it was", async () => {
  const spawn = await resolveDispatchAccountSpawn({
    account: "work",
    baseCliPath: "/usr/local/bin/claude",
    modelId: "claude-opus-5-5",
    ensureRuntime: async () => {
      throw new Error("read-only filesystem")
    },
  })
  assert.equal(spawn, null)
})

// ---------------------------------------------------------------------------
// The answer sentence, and the transcript
// ---------------------------------------------------------------------------

test("the multi-question answer sentence survives commas, slashes and quotes", () => {
  const questions = ["Pick a model", "Which extras?", "Anything else?"]
  const part = answerPart("x", [
    [questions[0], "claude-opus-5 and effort xhigh, please"],
    [questions[1], "alpha, gamma"],
    [questions[2], 'he said "no"'],
  ])
  const answers = parseQuestionAnswers(part, questions)
  assert.deepEqual(answers?.get(questions[0]), "claude-opus-5 and effort xhigh, please")
  assert.deepEqual(answers?.get(questions[1]), "alpha, gamma")
  assert.deepEqual(answers?.get(questions[2]), 'he said "no"')
})

test("an unanswered question comes back as empty, and a dismissal as null", () => {
  const questions = ["Pick a model", "Which extras?"]
  const answers = parseQuestionAnswers(
    answerPart("x", [[questions[0], "Unanswered"], [questions[1], "alpha"]]),
    questions,
  )
  assert.equal(answers?.get(questions[0]), "")
  assert.equal(answers?.get(questions[1]), "alpha")
  assert.equal(
    parseQuestionAnswers(
      { type: "tool-result", toolCallId: "x", output: { type: "error-text", value: "dismissed" } },
      questions,
    ),
    null,
  )
})

test("opencode-dcp's trailing message-id tag comes off the sentence", () => {
  const questions = ["Pick a model"]
  const part = {
    type: "tool-result",
    toolCallId: "x",
    output: {
      type: "text",
      value:
        'User has answered your questions: "Pick a model"="claude-opus-5-5 / max".' +
        " You can now continue with the user's answers in mind.\n" +
        "<dcp-message-id>m0795</dcp-message-id>",
    },
  }
  assert.equal(
    parseQuestionAnswers(part, questions)?.get("Pick a model"),
    "claude-opus-5-5 / max",
  )
})

test("the dispatch dialog never reaches a rebuilt transcript", () => {
  const prompt = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "thinking" },
        { type: "tool-call", toolCallId: `${SUBAGENT_DISPATCH_TOOL_CALL_PREFIX}summary_a`, toolName: "question" },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: `${SUBAGENT_DISPATCH_TOOL_CALL_PREFIX}summary_a`, output: {} },
      ],
    },
  ]
  const stripped = stripSubagentDispatchParts(prompt as any)
  assert.equal(stripped.length, 2)
  assert.deepEqual((stripped[1] as any).content, [{ type: "text", text: "thinking" }])
  // A prompt with nothing of ours in it comes back as the same object.
  const clean = [{ role: "user", content: [{ type: "text", text: "go" }] }]
  assert.equal(stripSubagentDispatchParts(clean as any), clean)
})
