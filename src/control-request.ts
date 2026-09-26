/**
 * Claude stream-json control requests: deciding allow or deny per tool, and
 * writing the matching `control_response` back down the child's stdin.
 *
 * Split out of `claude-code-language-model.ts` verbatim. The three were
 * private methods whose only use of `this` was `this.config`, so they take
 * the config as their first argument now and the class delegates to them.
 */
import type {
  ClaudeCodeConfig,
  ClaudeStreamMessage,
  ControlRequestBehavior,
} from "./types.js"
import { denyMessageForTool, isAskUserQuestionTool } from "./ask-user-question.js"
import { log } from "./logger.js"

export function controlRequestBehaviorForTool(
  config: ClaudeCodeConfig,
  toolName: string,
): ControlRequestBehavior {
  const configured = config.controlRequestToolBehaviors
  if (configured && toolName) {
    const direct = configured[toolName] ?? configured[toolName.toLowerCase()]
    if (direct === "allow" || direct === "deny") return direct

    const lower = toolName.toLowerCase()
    for (const [key, behavior] of Object.entries(configured)) {
      if (key.toLowerCase() === lower && (behavior === "allow" || behavior === "deny")) {
        return behavior
      }
    }
  }

  // AskUserQuestion must never be auto-allowed. Allowing it lets the
  // Claude CLI resolve its own question internally — in headless mode
  // there is no TTY, so the CLI fabricates/empties the answer and the
  // model proceeds on a guess. Deny so the CLI cannot self-answer; the
  // tool_use is still streamed and rendered to the opencode user by
  // formatAskUserQuestion, and the turn stops for a real reply. An
  // explicit controlRequestToolBehaviors entry above can still override.
  if (isAskUserQuestionTool(toolName)) return "deny"

  return config.controlRequestBehavior ?? "allow"
}

export function writeControlResponse(
  proc: import("child_process").ChildProcess,
  requestId: string,
  response?: Record<string, unknown>,
): void {
  const payload = {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response,
    },
  }

  try {
    proc.stdin?.write(JSON.stringify(payload) + "\n")
  } catch (error) {
    log.warn("failed to write control response", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Handle Claude stream-json control requests (`can_use_tool`, etc.) and
 * respond via stdin with a matching `control_response`.
 */
export function handleControlRequest(
  config: ClaudeCodeConfig,
  msg: ClaudeStreamMessage,
  proc: import("child_process").ChildProcess,
): boolean {
  if (msg.type !== "control_request") return false
  const requestId = msg.request_id
  const request = msg.request
  if (!requestId || !request?.subtype) return false

  if (request.subtype === "can_use_tool") {
    const toolName = request.tool_name ?? "unknown"
    const behavior = controlRequestBehaviorForTool(config, toolName)

    if (behavior === "allow") {
      writeControlResponse(proc, requestId, {
        behavior: "allow",
        updatedInput: request.input ?? {},
        toolUseID: request.tool_use_id,
      })
      log.info("control request auto-allowed", {
        requestId,
        toolName,
      })
    } else {
      const denyMessage = denyMessageForTool(
        toolName,
        config.controlRequestDenyMessage,
      )
      writeControlResponse(proc, requestId, {
        behavior: "deny",
        message: denyMessage,
        toolUseID: request.tool_use_id,
      })
      log.info("control request auto-denied", {
        requestId,
        toolName,
      })
    }

    return true
  }

  // For control request subtypes we don't actively handle yet, acknowledge
  // with an empty success so the CLI stream does not stall.
  writeControlResponse(proc, requestId, {})
  log.debug("control request acknowledged", {
    requestId,
    subtype: request.subtype,
  })
  return true
}
