export const QUESTION_TOOL_NAME = "question"

export const APPROVED_EXIT_PLAN_MODE_MESSAGE =
  "User has approved your plan. You can now start coding. Start with updating your todo list if applicable."

const REJECTED_EXIT_PLAN_MODE_PREFIX =
  "The user doesn't want to proceed with this tool use. The tool use was rejected. To tell you how to proceed, the user said:"

const PLAN_MODE_APPROVAL_QUESTION = "Do you want to proceed with this plan?"
const OPENCODE_QUESTION_RESULT_PREFIX =
  `User has answered your questions: "${PLAN_MODE_APPROVAL_QUESTION}"="`
const OPENCODE_QUESTION_RESULT_SUFFIX =
  `". You can now continue with the user's answers in mind.`

const KEY_SEPARATOR = "\u0000"

/**
 * A synthetic call to opencode's native `question` tool, emitted so the turn
 * ends on `tool-calls` and the operator's answer arrives on the next
 * `doStream` as a `tool-result` with the same id. Shared with the account
 * failover form (`src/account-failover.ts`), which uses the identical
 * mechanism for a different question.
 */
export interface QuestionToolCall {
  toolCallId: string
  toolName: typeof QUESTION_TOOL_NAME
  input: {
    questions: Array<{
      header: string
      question: string
      options: Array<{ label: string; description: string }>
      multiple: boolean
      custom: boolean
    }>
  }
  text: string
}

export type ExitPlanModeQuestionCall = QuestionToolCall

/**
 * Whether to bridge `ExitPlanMode` into opencode's native `question` tool
 * this turn.
 *
 * Opt-in (`planModeQuestion`) because opencode's question form does not
 * currently render (anomalyco/opencode#36604), so an enabled bridge hangs the
 * turn until the operator interrupts, where the text path still works.
 * Gated on the live registry because emitting a `question` tool-call on a
 * build without that entry renders `⚙ invalid` and wedges the turn just the
 * same. Never bridged during compaction: that turn is text-only and its
 * answer would have nowhere to go.
 */
export function isPlanModeQuestionActive(input: {
  configured: boolean | undefined
  opencodeHasQuestion: boolean
  compactionMode: boolean
}): boolean {
  if (input.compactionMode) return false
  if (input.configured !== true) return false
  return input.opencodeHasQuestion
}

const pendingQuestions = new Map<string, string>()

function pendingKey(sessionKey: string, questionToolCallId: string): string {
  return `${sessionKey}${KEY_SEPARATOR}${questionToolCallId}`
}

export function clearExitPlanModeQuestions(sessionKey: string): void {
  const prefix = `${sessionKey}${KEY_SEPARATOR}`
  for (const key of pendingQuestions.keys()) {
    if (key.startsWith(prefix)) pendingQuestions.delete(key)
  }
}

export function hasExitPlanModeQuestions(sessionKey: string): boolean {
  const prefix = `${sessionKey}${KEY_SEPARATOR}`
  return [...pendingQuestions.keys()].some((key) => key.startsWith(prefix))
}

export function createExitPlanModeQuestionCall(
  sessionKey: string,
  exitPlanModeToolUseId: string,
  plan: string,
  questionToolCallId = `exit_plan_question_${exitPlanModeToolUseId}`,
): ExitPlanModeQuestionCall {
  pendingQuestions.set(pendingKey(sessionKey, questionToolCallId), exitPlanModeToolUseId)

  return {
    toolCallId: questionToolCallId,
    toolName: QUESTION_TOOL_NAME,
    input: {
      questions: [
        {
          header: "Plan approval",
          question: PLAN_MODE_APPROVAL_QUESTION,
          options: [
            { label: "yes", description: "" },
            { label: "no", description: "" },
          ],
          multiple: false,
          custom: true,
        },
      ],
    },
    text: plan ? `\n\n${plan}\n` : "\n\n",
  }
}

function buildToolResultMessage(input: {
  toolUseId: string
  approved: boolean
  feedback: string
}): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        input.approved
          ? {
              type: "tool_result",
              tool_use_id: input.toolUseId,
              content: APPROVED_EXIT_PLAN_MODE_MESSAGE,
            }
          : {
              type: "tool_result",
              tool_use_id: input.toolUseId,
              content: `${REJECTED_EXIT_PLAN_MODE_PREFIX}\n${input.feedback || "no"}`,
              is_error: true,
            },
      ],
    },
  })
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Pull the operator's answer out of whatever shape opencode wrapped the
 * `question` tool result in. Exported because the account failover form reads
 * the same results through the same tool; a second copy of this would drift.
 */
export function unwrapToolOutput(part: any): unknown {
  const output = part?.output ?? part?.result
  if (typeof output === "string") return tryParseJson(output)
  if (!output || typeof output !== "object") return output

  switch (output.type) {
    case "json":
    case "error-json":
      return output.value
    case "text":
    case "error-text":
      return tryParseJson(String(output.value ?? ""))
    case "execution-denied":
      return {
        denied: true,
        reason: String(output.reason ?? "question rejected"),
      }
    case "content":
      return Array.isArray(output.value)
        ? output.value
            .map((item: any) => {
              if (item?.type === "text") return item.text
              return JSON.stringify(item)
            })
            .join("\n")
        : output.value
    default:
      return output
  }
}

function unwrapOpencodeQuestionResult(value: string): string {
  if (
    value.startsWith(OPENCODE_QUESTION_RESULT_PREFIX) &&
    value.endsWith(OPENCODE_QUESTION_RESULT_SUFFIX)
  ) {
    return value.slice(
      OPENCODE_QUESTION_RESULT_PREFIX.length,
      -OPENCODE_QUESTION_RESULT_SUFFIX.length,
    )
  }
  return value
}

/** Flatten an unwrapped `question` result into the answer strings it holds. */
export function collectAnswerStrings(value: unknown): string[] {
  if (typeof value === "string") return [unwrapOpencodeQuestionResult(value)]
  if (Array.isArray(value)) return value.flatMap(collectAnswerStrings)
  if (!value || typeof value !== "object") return []

  const obj = value as Record<string, unknown>
  if (obj.denied === true) return [String(obj.reason ?? "question rejected")]

  for (const key of ["answers", "answer", "selected", "selection", "value"]) {
    if (key in obj) return collectAnswerStrings(obj[key])
  }

  return []
}

function classifyQuestionResult(part: any): { approved: boolean; feedback: string } {
  const output = unwrapToolOutput(part)
  const answers = collectAnswerStrings(output)
    .map((answer) => answer.trim())
    .filter(Boolean)

  if (answers.length === 1 && answers[0].toLowerCase() === "yes") {
    return { approved: true, feedback: "" }
  }

  return {
    approved: false,
    feedback: answers.length > 0 ? answers.join("\n") : "no",
  }
}

export function consumeExitPlanModeQuestionResult(
  sessionKey: string,
  prompt: Array<{ role: string; content?: unknown }>,
): string | null {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const msg = prompt[i]
    if (!Array.isArray(msg.content)) continue

    for (const part of msg.content as any[]) {
      if (part?.type !== "tool-result" || typeof part.toolCallId !== "string") {
        continue
      }

      const key = pendingKey(sessionKey, part.toolCallId)
      const exitPlanModeToolUseId = pendingQuestions.get(key)
      if (!exitPlanModeToolUseId) continue

      pendingQuestions.delete(key)
      const result = classifyQuestionResult(part)
      return buildToolResultMessage({
        toolUseId: exitPlanModeToolUseId,
        approved: result.approved,
        feedback: result.feedback,
      })
    }
  }

  return null
}
