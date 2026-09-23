/**
 * Tool names and inputs in the shape the opencode host expects.
 *
 * Every tool call this plugin hands opencode, whether a proxied call opencode
 * must run (`bash`, `task`, ...) or a Claude CLI tool it only renders
 * (`read`, `glob`, ...), is built in opencode 1.x's vocabulary. opencode 2.x
 * renamed several tools and fields, and rejects a name it does not know with
 * `No tool named "bash" is currently available` (measured on 2.0.11). So on V2,
 * and only on V2, the stream is rewritten once at its edge rather than at each
 * of the dozen places a tool part is built. On V1 nothing here runs.
 *
 * The V2 table was read off `@opencode/core@2.0.11`'s own tool definitions
 * (`dist/tool/plugin/*.js`): each tool's registered `name` and input schema.
 */

export type HostToolDialect = "v1" | "v2"

let hostDialect: HostToolDialect = "v1"

/** Set once by the V2 entrypoint's `setup`. V1 never calls it. */
export function setHostToolDialect(dialect: HostToolDialect): void {
  hostDialect = dialect
}

export function getHostToolDialect(): HostToolDialect {
  return hostDialect
}

type Input = Record<string, unknown>

interface HostTool {
  name: string
  /** Absent when the input already matches, so its deltas can stream as-is. */
  input?: (input: Input) => Input
}

/** Drops keys whose value is undefined, so optional V2 fields stay optional. */
function defined(input: Input): Input {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}

/**
 * V1 name to its V2 counterpart. `null` means V2 has no such tool: the part is
 * dropped, because an unknown name is an error there, not a harmless row.
 */
const V2_TOOLS: Record<string, HostTool | null> = {
  bash: {
    name: "shell",
    // V2's shell takes no `description`; `workdir`, `timeout` and
    // `background` keep their names.
    input: (input) =>
      defined({
        command: input.command,
        workdir: input.workdir,
        timeout: input.timeout,
        background: input.background,
      }),
  },
  edit: {
    name: "edit",
    input: (input) =>
      defined({
        path: input.filePath ?? input.path,
        oldString: input.oldString,
        newString: input.newString,
        replaceAll: input.replaceAll,
      }),
  },
  write: {
    name: "write",
    input: (input) => defined({ path: input.filePath ?? input.path, content: input.content }),
  },
  read: {
    name: "read",
    input: (input) =>
      defined({ path: input.filePath ?? input.path, offset: input.offset, limit: input.limit }),
  },
  glob: { name: "glob" },
  grep: { name: "grep" },
  webfetch: { name: "webfetch" },
  websearch: { name: "websearch" },
  question: { name: "question" },
  task: {
    name: "subagent",
    input: (input) =>
      defined({
        agent: input.subagent_type ?? input.agent,
        description: input.description,
        prompt: input.prompt,
        sessionID: input.task_id ?? input.sessionID,
        background: input.background,
      }),
  },
  todowrite: null,
  plan_enter: null,
  plan_exit: null,
  notebookedit: null,
}

/**
 * The host's name and input for a tool call, `null` to drop it, or the call
 * unchanged when the host needs no translation or the tool is not in the table.
 */
export function translateToolForHost(
  name: string,
  input: Input,
  dialect: HostToolDialect = hostDialect,
): { name: string; input: Input } | null {
  if (dialect !== "v2") return { name, input }
  const tool = V2_TOOLS[name]
  if (tool === null) return null
  if (tool === undefined) return { name, input }
  return { name: tool.name, input: tool.input ? tool.input(input) : input }
}

type StreamPart = { type: string; [key: string]: unknown }

function parseInput(raw: unknown): Input {
  if (typeof raw !== "string") return (raw as Input) ?? {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as Input) : {}
  } catch {
    return {}
  }
}

/**
 * A per-stream rewriter for tool parts. Stateful because opencode ties a
 * tool's start, deltas, call and result together by id, so a tool that is
 * renamed or dropped at its start must be treated the same way to the end.
 * Returns `null` for a part to drop.
 */
export function createHostToolPartTranslator(
  dialect: HostToolDialect = hostDialect,
): (part: StreamPart) => StreamPart | null {
  if (dialect !== "v2") return (part) => part

  const dropped = new Set<string>()
  const translated = new Map<string, HostTool>()

  const classify = (id: string, name: unknown): HostTool | null | undefined => {
    if (dropped.has(id)) return null
    const known = translated.get(id)
    if (known) return known
    if (typeof name !== "string") return undefined
    const tool = V2_TOOLS[name]
    if (tool === null) {
      dropped.add(id)
      return null
    }
    if (tool) translated.set(id, tool)
    return tool
  }

  return (part) => {
    switch (part.type) {
      case "tool-input-start": {
        const tool = classify(String(part.id), part.toolName)
        if (tool === null) return null
        return tool ? { ...part, toolName: tool.name } : part
      }
      case "tool-input-delta": {
        const tool = classify(String(part.id), undefined)
        if (tool === null) return null
        // A translated input would stream the V1 keys and then arrive with
        // the V2 ones; opencode takes the final `tool-call` input anyway.
        return tool?.input ? null : part
      }
      case "tool-input-end": {
        return classify(String(part.id), undefined) === null ? null : part
      }
      case "tool-call": {
        const tool = classify(String(part.toolCallId), part.toolName)
        if (tool === null) return null
        if (!tool) return part
        const input = tool.input ? tool.input(parseInput(part.input)) : parseInput(part.input)
        return {
          ...part,
          toolName: tool.name,
          input: typeof part.input === "string" ? JSON.stringify(input) : input,
        }
      }
      case "tool-result": {
        const tool = classify(String(part.toolCallId), part.toolName)
        if (tool === null) return null
        return tool ? { ...part, toolName: tool.name } : part
      }
      default:
        return part
    }
  }
}

/** Applies the translator to a whole stream; the identity on V1. */
export function translateStreamForHost<T extends StreamPart>(
  stream: ReadableStream<T>,
  dialect: HostToolDialect = hostDialect,
): ReadableStream<T> {
  if (dialect !== "v2") return stream
  const translate = createHostToolPartTranslator(dialect)
  return stream.pipeThrough(
    new TransformStream<T, T>({
      transform(part, controller) {
        const next = translate(part)
        if (next) controller.enqueue(next as T)
      },
    }),
  )
}
