import { log } from "./logger.js"

/**
 * Map Claude CLI tool input (snake_case) to OpenCode tool input (camelCase)
 */
function mapToolInput(name: string, input: any): any {
  if (!input) return input

  switch (name) {
    case "Write":
      return {
        filePath: input.file_path ?? input.filePath,
        content: input.content,
      }
    case "Edit":
      return {
        filePath: input.file_path ?? input.filePath,
        oldString: input.old_string ?? input.oldString,
        newString: input.new_string ?? input.newString,
        replaceAll: input.replace_all ?? input.replaceAll,
      }
    case "Read":
      return {
        filePath: input.file_path ?? input.filePath,
        offset: input.offset,
        limit: input.limit,
      }
    case "Bash":
      return {
        command: input.command,
        description:
          input.description ||
          `Execute: ${String(input.command || "").slice(0, 50)}${String(input.command || "").length > 50 ? "..." : ""}`,
        timeout: input.timeout,
      }
    case "NotebookEdit":
      return {
        notebookPath: input.notebook_path ?? input.notebookPath,
        cellNumber: input.cell_number ?? input.cellNumber,
        newSource: input.new_source ?? input.newSource,
        cellType: input.cell_type ?? input.cellType,
        editMode: input.edit_mode ?? input.editMode,
      }
    case "Glob":
      return {
        pattern: input.pattern,
        path: input.path,
      }
    case "Grep":
      return {
        pattern: input.pattern,
        path: input.path,
        include: input.include,
      }
    case "TodoWrite":
      if (Array.isArray(input.todos)) {
        const mappedTodos = input.todos.map((todo: any, index: number) => ({
          content: todo.content,
          status: todo.status || "pending",
          priority: todo.priority || "medium",
          id: todo.id || `todo_${Date.now()}_${index}`,
        }))
        return { todos: mappedTodos }
      }
      return input
    default:
      return input
  }
}

// Tools that Claude CLI executes internally but we report to opencode for UI display
const OPENCODE_HANDLED_TOOLS = new Set([
  "Edit",
  "Write",
  "Bash",
  "NotebookEdit",
  "Read",
  "Glob",
  "Grep",
])

// Claude CLI internal tools that should not be forwarded to opencode.
// These are part of Claude Code's own system and have no opencode equivalent.
const CLAUDE_INTERNAL_TOOLS = new Set([
  "ToolSearch",
  "Agent",
  "AskFollowupQuestion",
])

export function mapTool(
  name: string,
  input?: any,
): { name: string; input?: any; executed: boolean; skip?: boolean } {
  // Claude CLI internal tools — skip entirely
  if (CLAUDE_INTERNAL_TOOLS.has(name)) {
    log.debug("skipping Claude CLI internal tool", { name })
    return { name, input, executed: true, skip: true }
  }
  // Plan mode tools
  if (name === "EnterPlanMode") return { name: "plan_enter", input: {}, executed: false }
  if (name === "ExitPlanMode") return { name: "plan_exit", input, executed: false }

  // TodoWrite needs opencode to run it locally so Todo.Service (and the UI
  // widget backed by it) gets populated. Reporting as provider-executed would
  // short-circuit opencode's own execute and leave the todo panel empty.
  if (name === "TodoWrite") {
    const mappedInput = mapToolInput(name, input)
    return { name: "todowrite", input: mappedInput, executed: false }
  }

  // WebSearch
  if (name === "WebSearch" || name === "web_search") {
    const mappedInput = input?.query ? { query: input.query } : input
    log.debug("mapping WebSearch", { originalInput: input, mappedInput })
    return { name: "websearch_web_search_exa", input: mappedInput, executed: false }
  }

  // TaskOutput -> bash echo
  if (name === "TaskOutput") {
    if (!input) return { name: "bash", executed: false }
    const output = input?.content || input?.output || JSON.stringify(input)
    return {
      name: "bash",
      input: {
        command: `echo "TASK OUTPUT: ${String(output).replace(/"/g, '\\"')}"`,
        description: "Displaying task output",
      },
      executed: false,
    }
  }

  // MCP tools: mcp__<server>__<tool> -> <server>_<tool>
  if (name.startsWith("mcp__")) {
    const parts = name.slice(5).split("__")
    if (parts.length >= 2) {
      const serverName = parts[0]
      const toolName = parts.slice(1).join("_")
      const openCodeName = `${serverName}_${toolName}`
      log.debug("mapping MCP tool", { original: name, mapped: openCodeName })
      return { name: openCodeName, input, executed: false }
    }
  }

  // Tools executed by Claude CLI internally - map to lowercase for opencode
  if (OPENCODE_HANDLED_TOOLS.has(name)) {
    const mappedInput = mapToolInput(name, input)
    const openCodeName = name.toLowerCase()
    log.debug("mapping CLI-executed tool", { name, openCodeName })
    return { name: openCodeName, input: mappedInput, executed: true }
  }

  // Unknown tools - treated as provider-executed
  return { name, input, executed: true }
}
