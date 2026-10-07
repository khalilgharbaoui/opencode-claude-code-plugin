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

/**
 * The only honest answer a headless session can give an MCP elicitation, and
 * the Agent SDK's own default when a host registers no `onElicitation`
 * handler. `accept` would mean fabricating the operator's input.
 */
export const ELICITATION_DECLINE: Readonly<Record<string, unknown>> = { action: "decline" }

/** One warning per MCP server per process; a chatty server must not spam. */
const warnedElicitationServers = new Set<string>()

/** Test seam, mirroring `_resetRateLimitReports` in cli-events.ts. */
export function _resetElicitationReports(): void {
  warnedElicitationServers.clear()
}

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

  // An MCP server asking the operator for input arrives here, and a default
  // install can get one: measured on Claude Code 2.1.288 with a bridged stdio
  // server, a `--print` stream-json session is handed the server's
  // `elicitation/create` as this control request. There is nobody to ask on
  // this side, so the answer is the documented `{action}` shape rather than
  // the blind `{}` below, which the CLI coerced into `{action:"cancel"}`
  // (anything that fails its schema is). That coercion is what kept the turn
  // alive, so this changes the word the server receives, not whether the turn
  // survives. What it adds is the one line saying the server asked and was
  // declined: at DEBUG, in a log that is off by default, the operator saw a
  // tool quietly do nothing and had nothing to read about why.
  if (request.subtype === "elicitation") {
    const server = request.mcp_server_name || "unknown"
    writeControlResponse(proc, requestId, { ...ELICITATION_DECLINE })
    if (!warnedElicitationServers.has(server)) {
      warnedElicitationServers.add(server)
      log.warn(
        "MCP server asked for operator input and was declined: a headless" +
          " Claude Code session cannot prompt, so its elicitation can only be" +
          " refused. Run that server's flow in Claude Code directly, or" +
          " configure it not to elicit.",
        { server, mode: request.mode ?? "form" },
      )
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
