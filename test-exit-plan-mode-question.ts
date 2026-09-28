import { test } from "node:test"
import assert from "node:assert/strict"

import {
  APPROVED_EXIT_PLAN_MODE_MESSAGE,
  QUESTION_TOOL_NAME,
  clearExitPlanModeQuestions,
  consumeExitPlanModeQuestionResult,
  createExitPlanModeQuestionCall,
  isPlanModeQuestionActive,
} from "./src/plan-mode-question.js"
import { ClaudeCodeLanguageModel } from "./src/claude-code-language-model.js"
import { setOpencodeClient } from "./src/runtime-status.js"
import { deleteClaudeSessionId } from "./src/session-manager.js"

test("plan-mode bridge stays off unless explicitly opted in", () => {
  for (const configured of [undefined, false] as const) {
    assert.equal(
      isPlanModeQuestionActive({
        configured,
        opencodeHasQuestion: true,
        compactionMode: false,
      }),
      false,
    )
  }

  assert.equal(
    isPlanModeQuestionActive({
      configured: true,
      opencodeHasQuestion: true,
      compactionMode: false,
    }),
    true,
  )
})

test("plan-mode bridge is gated on opencode having the question tool", () => {
  // Emitting a `question` tool-call on a build without the registry entry
  // renders `⚙ invalid` and wedges the turn, so the text path must stand.
  assert.equal(
    isPlanModeQuestionActive({
      configured: true,
      opencodeHasQuestion: false,
      compactionMode: false,
    }),
    false,
  )
})

test("plan-mode bridge never fires during compaction", () => {
  assert.equal(
    isPlanModeQuestionActive({
      configured: true,
      opencodeHasQuestion: true,
      compactionMode: true,
    }),
    false,
  )
})

test("ExitPlanMode creates a native OpenCode question tool-call", () => {
  clearExitPlanModeQuestions("session-a")

  const call = createExitPlanModeQuestionCall(
    "session-a",
    "exit-plan-1",
    "1. Inspect\n2. Patch",
    "question-1",
  )

  assert.equal(call.toolCallId, "question-1")
  assert.equal(call.toolName, QUESTION_TOOL_NAME)
  assert.deepEqual(call.input, {
    questions: [
      {
        header: "Plan approval",
        question: "Do you want to proceed with this plan?",
        options: [
          { label: "yes", description: "" },
          { label: "no", description: "" },
        ],
        multiple: false,
        custom: true,
      },
    ],
  })
  assert.equal(call.text, "\n\n1. Inspect\n2. Patch\n")
})

test("question answer yes becomes approval tool_result for the original ExitPlanMode id", () => {
  clearExitPlanModeQuestions("session-a")
  createExitPlanModeQuestionCall("session-a", "exit-plan-1", "Plan", "question-1")

  const userMessage = consumeExitPlanModeQuestionResult("session-a", [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "question-1",
          output: { type: "json", value: ["yes"] },
        },
      ],
    } as any,
  ])

  assert.ok(userMessage)
  assert.deepEqual(JSON.parse(userMessage), {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "exit-plan-1",
          content: APPROVED_EXIT_PLAN_MODE_MESSAGE,
        },
      ],
    },
  })

  assert.equal(
    consumeExitPlanModeQuestionResult("session-a", [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "question-1",
            output: { type: "json", value: ["yes"] },
          },
        ],
      } as any,
    ]),
    null,
  )
})

test("opencode's formatted question output approves the original ExitPlanMode call", () => {
  clearExitPlanModeQuestions("session-a")
  createExitPlanModeQuestionCall("session-a", "exit-plan-1", "Plan", "question-1")

  const userMessage = consumeExitPlanModeQuestionResult("session-a", [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "question-1",
          output: {
            type: "text",
            value:
              `User has answered your questions: "Do you want to proceed with this plan?"="yes". ` +
              `You can now continue with the user's answers in mind.`,
          },
        },
      ],
    } as any,
  ])

  assert.equal(
    JSON.parse(userMessage!).message.content[0].content,
    APPROVED_EXIT_PLAN_MODE_MESSAGE,
  )
})

test("a trailing newline on opencode's question output still approves", () => {
  // The same unwrapper reads the account-failover form, where opencode 1.18.32
  // was measured returning the sentence with a trailing "\n" (2026-09-28).
  clearExitPlanModeQuestions("session-a")
  createExitPlanModeQuestionCall("session-a", "exit-plan-1", "Plan", "question-1")

  const userMessage = consumeExitPlanModeQuestionResult("session-a", [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "question-1",
          output: {
            type: "text",
            value:
              `User has answered your questions: "Do you want to proceed with this plan?"="yes". ` +
              `You can now continue with the user's answers in mind.\n`,
          },
        },
      ],
    } as any,
  ])

  assert.equal(
    JSON.parse(userMessage!).message.content[0].content,
    APPROVED_EXIT_PLAN_MODE_MESSAGE,
  )
})

test("question answer no becomes rejection tool_result", () => {
  clearExitPlanModeQuestions("session-a")
  createExitPlanModeQuestionCall("session-a", "exit-plan-1", "Plan", "question-1")

  const userMessage = consumeExitPlanModeQuestionResult("session-a", [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "question-1",
          output: { type: "json", value: ["no"] },
        },
      ],
    } as any,
  ])

  const parsed = JSON.parse(userMessage!)
  assert.equal(parsed.message.content[0].tool_use_id, "exit-plan-1")
  assert.equal(parsed.message.content[0].is_error, true)
  assert.match(parsed.message.content[0].content, /tool use was rejected/)
  assert.match(parsed.message.content[0].content, /no$/)
})

test("custom question text becomes rejection feedback without semantic parsing", () => {
  clearExitPlanModeQuestions("session-a")
  createExitPlanModeQuestionCall("session-a", "exit-plan-1", "Plan", "question-1")

  const userMessage = consumeExitPlanModeQuestionResult("session-a", [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "question-1",
          output: { type: "text", value: "revise step 2 first" },
        },
      ],
    } as any,
  ])

  const parsed = JSON.parse(userMessage!)
  assert.equal(parsed.message.content[0].is_error, true)
  assert.match(parsed.message.content[0].content, /revise step 2 first$/)
})

test("opencode's formatted custom answer becomes rejection feedback", () => {
  clearExitPlanModeQuestions("session-a")
  createExitPlanModeQuestionCall("session-a", "exit-plan-1", "Plan", "question-1")

  const userMessage = consumeExitPlanModeQuestionResult("session-a", [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "question-1",
          output: {
            type: "text",
            value:
              `User has answered your questions: "Do you want to proceed with this plan?"="revise step 2 first". ` +
              `You can now continue with the user's answers in mind.`,
          },
        },
      ],
    } as any,
  ])

  const parsed = JSON.parse(userMessage!)
  assert.equal(parsed.message.content[0].is_error, true)
  assert.match(parsed.message.content[0].content, /revise step 2 first$/)
})

test("execution-denied question result becomes rejection feedback", () => {
  clearExitPlanModeQuestions("session-a")
  createExitPlanModeQuestionCall("session-a", "exit-plan-1", "Plan", "question-1")

  const userMessage = consumeExitPlanModeQuestionResult("session-a", [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "question-1",
          output: { type: "execution-denied", reason: "user rejected" },
        },
      ],
    } as any,
  ])

  const parsed = JSON.parse(userMessage!)
  assert.equal(parsed.message.content[0].is_error, true)
  assert.match(parsed.message.content[0].content, /user rejected$/)
})

test("question mappings are isolated by session and synthetic question id", () => {
  clearExitPlanModeQuestions("session-a")
  clearExitPlanModeQuestions("session-b")
  createExitPlanModeQuestionCall("session-a", "exit-plan-a", "Plan A", "question-1")
  createExitPlanModeQuestionCall("session-b", "exit-plan-b", "Plan B", "question-1")

  const ignored = consumeExitPlanModeQuestionResult("session-a", [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "unknown-question",
          output: { type: "json", value: { answers: [["yes"]] } },
        },
      ],
    } as any,
  ])
  assert.equal(ignored, null)

  const userMessage = consumeExitPlanModeQuestionResult("session-b", [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "question-1",
          output: { type: "json", value: ["yes"] },
        },
      ],
    } as any,
  ])

  assert.equal(JSON.parse(userMessage!).message.content[0].tool_use_id, "exit-plan-b")
})

test("deleting a Claude session clears its pending plan-mode question", () => {
  const sessionKey = "session-reset"
  createExitPlanModeQuestionCall(sessionKey, "exit-plan-1", "Plan", "question-1")

  deleteClaudeSessionId(sessionKey)

  assert.equal(
    consumeExitPlanModeQuestionResult(sessionKey, [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "question-1",
            output: { type: "json", value: ["yes"] },
          },
        ],
      } as any,
    ]),
    null,
  )
})

test("live tool registry is shared within a turn and refreshed next turn", async () => {
  let requests = 0
  setOpencodeClient({
    tool: {
      list: async () => {
        requests++
        return {
          data:
            requests === 1
              ? [
                  {
                    id: "question",
                    description: "Ask the user",
                    parameters: {},
                  },
                ]
              : [],
        }
      },
    },
  })

  try {
    const model = new ClaudeCodeLanguageModel("claude-haiku-4-5", {
      provider: "claude-code",
      cliPath: "claude",
      planModeQuestion: true,
    })
    const testModel = model as any
    const firstTurn = testModel.createLiveToolInfoLoader()

    assert.deepEqual(
      await Promise.all([
        testModel.resolvePlanModeQuestion(false, firstTurn),
        testModel.resolvePlanModeQuestion(false, firstTurn),
      ]),
      [true, true],
    )
    assert.equal(requests, 1)

    const nextTurn = testModel.createLiveToolInfoLoader()
    assert.equal(await testModel.resolvePlanModeQuestion(false, nextTurn), false)
    assert.equal(requests, 2)
  } finally {
    setOpencodeClient({})
  }
})
