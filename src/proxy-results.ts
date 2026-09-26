/**
 * Reading opencode's answer to a proxied tool call back out of the next
 * prompt, and the fallback message for a result that arrived too late to
 * go back as a `tool_result`.
 *
 * Split out of `claude-code-language-model.ts` verbatim: the two extractors
 * were private methods that never touched `this` beyond calling each other,
 * so they became free functions unchanged.
 */
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import {
  formatTaskBatchResults,
  taskBatchChildToolCallId,
  taskBatchTasks,
  TASK_BATCH_TOOL_NAME,
  type ProxyToolResult,
} from "./proxy-mcp.js"
import type { PendingProxyCall } from "./proxy-broker.js"
import { log } from "./logger.js"

/**
 * A proxy result whose HTTP reply channel Claude already abandoned cannot
 * go back as a `tool_result` (the CLI closed that tool_use with a timeout
 * error). Hand it over as a user message that names the call instead.
 */
export function makeLateProxyResultMessage(
  entries: Array<{ call: PendingProxyCall; result: ProxyToolResult }>,
): string {
  const sections = entries.map(({ call, result }) => {
    const failed = result.kind === "error" || result.isError === true
    const body = result.kind === "error" ? result.message : result.text
    return (
      `Your earlier \`${call.toolName}\` tool call (id ${call.toolCallId})` +
      ` has ${failed ? "failed" : "completed"}, but delivery or continuation was interrupted.` +
      ` Treat the following as its ${failed ? "error" : "result"} and continue from there;` +
      ` do not re-run it.\n\n${body}`
    )
  })
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
    },
  })
}

export function extractPendingProxyResult(
  prompt: LanguageModelV3CallOptions["prompt"],
  toolCallId: string,
): ProxyToolResult | null {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const msg = prompt[i]
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue

    for (const part of msg.content) {
      if (part.type !== "tool-result" || part.toolCallId !== toolCallId) continue

      const output = part.output as any
      if (!output || typeof output !== "object") {
        return {
          kind: "text",
          text: String(output ?? ""),
        }
      }

      if (output.type === "text") {
        return {
          kind: "text",
          text: String(output.value ?? ""),
        }
      }

      if (output.type === "json") {
        return {
          kind: "text",
          text: JSON.stringify(output.value),
        }
      }

      if (output.type === "content" && Array.isArray(output.value)) {
        const text = output.value
          .filter((v: any) => v?.type === "text" && typeof v.text === "string")
          .map((v: any) => v.text)
          .join("\n")
        return {
          kind: "text",
          text,
        }
      }

      return {
        kind: "text",
        text: JSON.stringify(output),
      }
    }
  }

  return null
}

/**
 * The result opencode produced for a pending proxy call, if the prompt
 * carries it. For `task_batch` that means every child's result gathered
 * back onto the parent: opencode runs the children in one step and hands
 * all their results to the next call together, so a partial set is not
 * expected. If it ever happens the batch still resolves, with the gap
 * named in the text, because leaving the parent pending would send this
 * turn down the fresh-envelope path and reject the call as orphaned.
 */
export function extractPendingProxyResultForCall(
  prompt: LanguageModelV3CallOptions["prompt"],
  call: PendingProxyCall,
): ProxyToolResult | null {
  if (call.toolName !== TASK_BATCH_TOOL_NAME) {
    return extractPendingProxyResult(prompt, call.toolCallId)
  }
  const tasks = taskBatchTasks(call.input)
  if (tasks.length === 0) {
    return { kind: "error", message: "task_batch input is not a list of task objects" }
  }
  const children = tasks.map((task, index) => ({
    task,
    result: extractPendingProxyResult(
      prompt,
      taskBatchChildToolCallId(call.toolCallId, index),
    ),
  }))
  const answered = children.filter((child) => child.result !== null).length
  if (answered === 0) return null
  if (answered < children.length) {
    log.warn("task_batch resolving with child results missing", {
      toolCallId: call.toolCallId,
      answered,
      total: children.length,
    })
  }
  return formatTaskBatchResults(children)
}
