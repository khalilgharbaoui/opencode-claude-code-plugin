/**
 * Claude Code's `AskUserQuestion`: recognising it, rendering it to the
 * operator, and the message the model gets back when it is denied.
 *
 * Split out of `claude-code-language-model.ts` verbatim. The deny path is
 * load-bearing (issue #8): the message must tell the model to stop and wait
 * unconditionally, and must never offer a proceed-anyway escape hatch.
 */

/** Tool names that mean "ask the human a question" (CLI casing variants). */
export function isAskUserQuestionTool(name: string | undefined): boolean {
  if (!name) return false
  const n = name.toLowerCase()
  return n === "askuserquestion" || n === "ask_user_question"
}

/**
 * Deny message returned to the model when it invokes AskUserQuestion.
 *
 * AskUserQuestion is denied (see controlRequestBehaviorForTool) so the
 * headless CLI cannot self-answer against an empty TTY. The question is
 * already rendered to the operator by formatAskUserQuestion, so this text
 * tells the model to stop and wait — unconditionally. Earlier versions
 * offered an "if this is non-interactive, proceed with a reasonable guess"
 * escape hatch, but the model could not reliably tell interactive opencode
 * from a headless run and routinely took it, so questions appeared to be
 * skipped (issue #8). Stopping is the correct default for opencode; a
 * headless run simply ends the turn with the question as its final output.
 */
const ASK_USER_QUESTION_DENY_MESSAGE =
  "Your question and its options have already been presented to the" +
  " operator verbatim. This is NOT a cancellation or a refusal — the" +
  " operator simply has not answered yet. Stop now: end your turn without" +
  " calling any more tools and without answering the question yourself. Do" +
  " not say the question was cancelled, skipped, or declined, and do not" +
  " guess, assume, or proceed on their behalf. Wait for the operator's" +
  " reply, which arrives as the next user message."

/** Build the deny message for an auto-denied control request. */
export function denyMessageForTool(
  toolName: string | undefined,
  configuredDenyMessage?: string,
): string {
  if (isAskUserQuestionTool(toolName)) return ASK_USER_QUESTION_DENY_MESSAGE
  return (
    configuredDenyMessage ??
    `Denied by opencode-claude-code policy for tool ${toolName}`
  )
}

/**
 * Render Claude Code's `AskUserQuestion` tool input as visible markdown.
 *
 * This is the fallback path used when the `Question` proxy is off or the
 * opencode build lacks the `question` registry entry. When the proxy is
 * enabled, `AskUserQuestion` is disabled via `--disallowedTools` and the
 * model calls `mcp__opencode_proxy__question` instead (opencode's native
 * `question` tool renders the TUI form). Here, the question + every
 * option is rendered as readable assistant text and the user answers in
 * the next turn — same approach as the `ExitPlanMode` handling. The
 * previous behavior collapsed the whole payload to a single faint
 * `_Asking: <q>_` line, dropping all options and any question past the
 * first.
 */
export function formatAskUserQuestion(input: Record<string, unknown>): string {
  const anyInput = input as any
  const questions: any[] = Array.isArray(anyInput?.questions)
    ? anyInput.questions
    : []

  if (questions.length === 0) {
    const single = anyInput?.question ?? anyInput?.text
    const q =
      typeof single === "string" && single.trim() ? single.trim() : "Question?"
    return `\n\n**${q}**\n\n_Reply with your answer to continue._\n\n`
  }

  const out: string[] = ["\n\n"]
  const multiQ = questions.length > 1
  questions.forEach((q, i) => {
    const text =
      (typeof q?.question === "string" && q.question.trim()) ||
      (typeof q?.text === "string" && q.text.trim()) ||
      "Question?"
    const header =
      typeof q?.header === "string" && q.header.trim() ? q.header.trim() : ""
    out.push(`**${multiQ ? `${i + 1}. ` : ""}${text}**`)
    if (header) out.push(` _(${header})_`)
    out.push("\n\n")

    const options: any[] = Array.isArray(q?.options) ? q.options : []
    options.forEach((opt, j) => {
      const label =
        (typeof opt?.label === "string" && opt.label.trim()) ||
        (typeof opt === "string" && opt.trim()) ||
        `Option ${j + 1}`
      const desc =
        typeof opt?.description === "string" && opt.description.trim()
          ? ` — ${opt.description.trim()}`
          : ""
      out.push(`${j + 1}. **${label}**${desc}\n`)
    })

    out.push(
      q?.multiSelect === true
        ? "\n_Select one or more — reply with the numbers or labels._\n\n"
        : "\n_Reply with your choice (the number or label)._\n\n",
    )
  })
  return out.join("")
}
