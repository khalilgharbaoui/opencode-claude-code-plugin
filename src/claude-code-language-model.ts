import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3Warning,
} from "@ai-sdk/provider"
import { generateId } from "@ai-sdk/provider-utils"
import type {
  ClaudeCodeConfig,
  ControlRequestBehavior,
  ClaudeStreamMessage,
  ReasoningEffort,
} from "./types.js"
import { mapTool } from "./tool-mapping.js"
import { getClaudeUserMessage } from "./message-builder.js"
import { bridgeOpencodeMcp } from "./mcp-bridge.js"
import {
  getActiveProcess,
  spawnClaudeProcess,
  buildCliArgs,
  setClaudeSessionId,
  getClaudeSessionId,
  deleteClaudeSessionId,
  deleteActiveProcess,
  sessionKey,
} from "./session-manager.js"
import { log } from "./logger.js"
import {
  createProxyMcpServer,
  disallowedToolFlags,
  DEFAULT_PROXY_TOOLS,
  PROXY_TOOL_PREFIX,
  type ProxyMcpServer,
  type ProxyToolCall,
  type ProxyToolDef,
  type ProxyToolResult,
} from "./proxy-mcp.js"
import {
  getPendingProxyCall,
  onPendingProxyCall,
  queuePendingProxyCall,
  resolvePendingProxyCall,
  rejectPendingProxyCall,
  type PendingProxyCall,
} from "./proxy-broker.js"

export class ClaudeCodeLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  readonly modelId: string
  private readonly config: ClaudeCodeConfig

  constructor(modelId: string, config: ClaudeCodeConfig) {
    this.modelId = modelId
    this.config = config
  }

  readonly supportedUrls: Record<string, RegExp[]> = {}

  get provider(): string {
    return this.config.provider
  }

  private toUsage(rawUsage?: ClaudeStreamMessage["usage"]): LanguageModelV3Usage {
    // Prefer the last iteration's counters over cumulative totals.
    // CLI usage is the sum across all internal tool-use iterations;
    // using it directly inflates context size and triggers premature compaction.
    const iter = rawUsage?.iterations
    const effective = iter?.length ? iter[iter.length - 1] : rawUsage
    // Claude CLI reports input_tokens as non-cached input only.
    // OpenCode expects total = noCache + cacheRead + cacheWrite.
    const noCache = effective?.input_tokens ?? 0
    const cacheRead = effective?.cache_read_input_tokens ?? 0
    const cacheWrite = effective?.cache_creation_input_tokens ?? 0
    return {
      inputTokens: {
        total: noCache + cacheRead + cacheWrite,
        noCache,
        cacheRead: cacheRead || undefined,
        cacheWrite: cacheWrite || undefined,
      },
      outputTokens: {
        total: effective?.output_tokens,
        text: effective?.output_tokens,
        reasoning: undefined,
      },
      raw: rawUsage as any,
    }
  }

  private toFinishReason(
    reason: "stop" | "tool-calls" = "stop",
  ): LanguageModelV3FinishReason {
    return {
      unified: reason,
      raw: reason,
    }
  }

  private requestScope(options: { tools?: unknown }): "tools" | "no-tools" {
    const tools = options?.tools
    if (Array.isArray(tools)) return "tools"
    if (tools && typeof tools === "object") {
      return Object.keys(tools as Record<string, unknown>).length > 0
        ? "tools"
        : "no-tools"
    }
    return "no-tools"
  }

  /**
   * Build the combined `--mcp-config` list: user-configured paths plus the
   * auto-bridged opencode MCP config (when enabled and present) and the
   * proxy MCP scratch file (when proxyTools are enabled).
   */
  private effectiveMcpConfig(cwd: string, proxyConfigPath?: string): string[] {
    const user = Array.isArray(this.config.mcpConfig)
      ? this.config.mcpConfig.slice()
      : this.config.mcpConfig
        ? [this.config.mcpConfig]
        : []
    if (this.config.bridgeOpencodeMcp !== false) {
      const bridged = bridgeOpencodeMcp(cwd)
      if (bridged) user.push(bridged)
    }
    if (proxyConfigPath) user.push(proxyConfigPath)
    return user
  }

  /** Resolve ProxyToolDef[] for the configured proxyTools names. */
  private resolvedProxyTools(): ProxyToolDef[] | null {
    const names = this.config.proxyTools
    if (!names || names.length === 0) return null
    const defsByName = new Map(
      DEFAULT_PROXY_TOOLS.map((t) => [t.name.toLowerCase(), t]),
    )
    const picked: ProxyToolDef[] = []
    for (const n of names) {
      const def = defsByName.get(String(n).toLowerCase())
      if (def) picked.push(def)
    }
    return picked.length > 0 ? picked : null
  }

  /**
   * Create a proxy MCP server for a single active Claude process/session.
   * The process lifecycle owns the server lifecycle via session-manager.
   */
  private async ensureProxyServer(
    tools: ProxyToolDef[],
    sessionKeyForCalls: string,
  ): Promise<ProxyMcpServer> {
    const srv = await createProxyMcpServer(tools)
    srv.calls.on("call", (call: ProxyToolCall) => {
      queuePendingProxyCall(sessionKeyForCalls, call)
    })
    return srv
  }

  private extractPendingProxyResult(
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
   * Opencode sets `x-session-affinity: <sessionID>` on LLM calls for
   * third-party providers (packages/opencode/src/session/llm.ts). Use it so
   * two chats in the same cwd+model get separate CLI processes instead of
   * stomping on each other. Falls back to "default" when absent (older
   * opencode, direct AI-SDK use, title synthesis paths, etc).
   */
  private sessionAffinity(
    options: LanguageModelV3CallOptions,
  ): string {
    const headers = (options as any)?.headers as
      | Record<string, string | undefined>
      | undefined
    if (!headers) return "default"
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "x-session-affinity") {
        const v = headers[key]
        if (typeof v === "string" && v.length > 0) return v
      }
    }
    return "default"
  }

  private controlRequestBehaviorForTool(toolName: string): ControlRequestBehavior {
    const configured = this.config.controlRequestToolBehaviors
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

    return this.config.controlRequestBehavior ?? "allow"
  }

  private writeControlResponse(
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
  private handleControlRequest(
    msg: ClaudeStreamMessage,
    proc: import("child_process").ChildProcess,
  ): boolean {
    if (msg.type !== "control_request") return false
    const requestId = msg.request_id
    const request = msg.request
    if (!requestId || !request?.subtype) return false

    if (request.subtype === "can_use_tool") {
      const toolName = request.tool_name ?? "unknown"
      const behavior = this.controlRequestBehaviorForTool(toolName)

      if (behavior === "allow") {
        this.writeControlResponse(proc, requestId, {
          behavior: "allow",
          updatedInput: request.input ?? {},
          toolUseID: request.tool_use_id,
        })
        log.info("control request auto-allowed", {
          requestId,
          toolName,
        })
      } else {
        this.writeControlResponse(proc, requestId, {
          behavior: "deny",
          message:
            this.config.controlRequestDenyMessage ??
            `Denied by opencode-claude-code policy for tool ${toolName}`,
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
    this.writeControlResponse(proc, requestId, {})
    log.debug("control request acknowledged", {
      requestId,
      subtype: request.subtype,
    })
    return true
  }

  private getReasoningEffort(
    providerOptions?: LanguageModelV3CallOptions["providerOptions"],
  ): ReasoningEffort | undefined {
    if (!providerOptions) return undefined
    const ownKey = this.config.provider
    const bag =
      (providerOptions as any)[ownKey] ??
      (providerOptions as any)["claude-code"]
    const effort = bag?.reasoningEffort
    const valid: ReasoningEffort[] = [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]
    return valid.includes(effort) ? effort : undefined
  }

  private latestUserText(
    prompt: LanguageModelV3CallOptions["prompt"],
  ): string {
    for (let i = prompt.length - 1; i >= 0; i--) {
      const msg = prompt[i]
      if (msg.role !== "user") continue

      if (typeof msg.content === "string") {
        return String(msg.content).trim()
      }

      if (Array.isArray(msg.content)) {
        const text = (msg.content as any[])
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part: any) => String(part.text).trim())
          .filter(Boolean)
          .join(" ")
        if (text) return text
      }
    }

    return ""
  }

  private synthesizeTitle(
    prompt: LanguageModelV3CallOptions["prompt"],
  ): string {
    const source = this.latestUserText(prompt)
      .replace(/\s+/g, " ")
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .trim()

    if (!source) return "New Session"

    const stop = new Set([
      "a",
      "an",
      "the",
      "and",
      "or",
      "but",
      "to",
      "for",
      "of",
      "in",
      "on",
      "at",
      "with",
      "can",
      "could",
      "would",
      "should",
      "please",
      "hi",
      "hello",
      "hey",
      "there",
      "you",
      "your",
      "this",
      "that",
      "is",
      "are",
      "was",
      "were",
      "be",
      "do",
      "does",
      "did",
      "summarize",
      "summary",
      "project",
    ])

    const words = source
      .split(" ")
      .map((word) => word.trim())
      .filter(Boolean)
      .filter((word) => !stop.has(word.toLowerCase()))

    const picked = (words.length > 0 ? words : source.split(" ").filter(Boolean))
      .slice(0, 6)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")

    return picked || "New Session"
  }

  private async doGenerateViaStream(
    options: LanguageModelV3CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV3["doGenerate"]>>> {
    const result = await this.doStream(options)
    const reader = result.stream.getReader()

    let text = ""
    let reasoning = ""
    const toolCalls: LanguageModelV3Content[] = []
    let finishReason = this.toFinishReason("stop")
    let usage: LanguageModelV3Usage = this.toUsage()
    let providerMetadata: any

    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      switch ((value as any).type) {
        case "text-delta":
          text += (value as any).delta ?? ""
          break
        case "reasoning-delta":
          reasoning += (value as any).delta ?? ""
          break
        case "tool-call":
          toolCalls.push({
            type: "tool-call",
            toolCallId: (value as any).toolCallId,
            toolName: (value as any).toolName,
            input: (value as any).input,
            providerExecuted: (value as any).providerExecuted,
          } as any)
          break
        case "finish":
          finishReason = (value as any).finishReason ?? finishReason
          usage = (value as any).usage ?? usage
          providerMetadata = (value as any).providerMetadata ?? providerMetadata
          break
      }
    }

    const content: LanguageModelV3Content[] = []
    if (reasoning) {
      content.push({ type: "reasoning", text: reasoning } as any)
    }
    if (text) {
      content.push({ type: "text", text, providerMetadata } as any)
    }
    content.push(...toolCalls)

    return {
      content,
      finishReason,
      usage,
      request: result.request,
      response: {
        id: generateId(),
        timestamp: new Date(),
        modelId: this.modelId,
      },
      providerMetadata,
      warnings: [],
    }
  }

  async doGenerate(
    options: LanguageModelV3CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV3["doGenerate"]>>> {
    const warnings: SharedV3Warning[] = []
    const cwd = this.config.cwd ?? process.cwd()
    const scope = this.requestScope(options as any)
    const affinity = this.sessionAffinity(options)
    const sk = sessionKey(cwd, `${this.modelId}::${scope}::${affinity}`)

    // When selective proxying is enabled, doGenerate must not bypass the
    // proxy path. Reuse doStream and aggregate its events so proxied tools
    // still route through opencode permissions/execution.
    if (scope === "tools" && this.resolvedProxyTools()) {
      return this.doGenerateViaStream(options)
    }

    if (scope === "no-tools") {
      const text = this.synthesizeTitle(options.prompt)
      return {
        content: [{ type: "text", text }] as any,
        finishReason: this.toFinishReason("stop"),
        usage: this.toUsage({ input_tokens: 0, output_tokens: 0 }),
        request: { body: { text: "" } },
        response: {
          id: generateId(),
          timestamp: new Date(),
          modelId: this.modelId,
        },
        providerMetadata: {
          "claude-code": {
            synthetic: true,
            path: "no-tools",
          },
        },
        warnings,
      }
    }

    const hasPriorConversation =
      options.prompt.filter((m) => m.role === "user" || m.role === "assistant")
        .length > 1

    // New session — clear any stale state from a previous session
    if (!hasPriorConversation) {
      deleteClaudeSessionId(sk)
      deleteActiveProcess(sk)
    }

    const hasExistingSession = !!getClaudeSessionId(sk)
    const includeHistoryContext = !hasExistingSession && hasPriorConversation

    const reasoningEffort = this.getReasoningEffort(options.providerOptions)
    const userMsg = getClaudeUserMessage(
      options.prompt,
      includeHistoryContext,
      reasoningEffort,
    )

    // doGenerate always spawns a fresh process, never reuse session ID
    const cliArgs = buildCliArgs({
      sessionKey: sk,
      skipPermissions: this.config.skipPermissions !== false,
      includeSessionId: false,
      model: this.modelId,
      permissionMode: this.config.permissionMode,
      mcpConfig: this.effectiveMcpConfig(cwd),
      strictMcpConfig: this.config.strictMcpConfig,
    })

    log.info("doGenerate starting", {
      cwd,
      model: this.modelId,
      textLength: userMsg.length,
      includeHistoryContext,
    })

    const { spawn } = await import("node:child_process")
    const { createInterface } = await import("node:readline")

    const proc = spawn(this.config.cliPath, cliArgs, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "xterm-256color" },
      shell: process.platform === "win32",
    })

    const rl = createInterface({ input: proc.stdout! })

    let responseText = ""
    let thinkingText = ""
    let resultMeta: {
      sessionId?: string
      costUsd?: number
      durationMs?: number
      usage?: ClaudeStreamMessage["usage"]
    } = {}
    const toolCalls: Array<{ id: string; name: string; args: unknown }> = []

    const result = await new Promise<
      typeof resultMeta & {
        text: string
        thinking: string
        toolCalls: typeof toolCalls
      }
    >((resolve, reject) => {
      rl.on("line", (line) => {
        if (!line.trim()) return
        try {
          const msg: ClaudeStreamMessage = JSON.parse(line)

          if (this.handleControlRequest(msg, proc)) {
            return
          }

          if (msg.type === "system" && msg.subtype === "init") {
            if (msg.session_id) {
              setClaudeSessionId(sk, msg.session_id)
            }
          }

          if (msg.type === "assistant" && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text) {
                responseText += block.text
              }
              if (block.type === "thinking" && block.thinking) {
                thinkingText += block.thinking
              }
              if (block.type === "tool_use" && block.id && block.name) {
                if (
                  block.name === "AskUserQuestion" ||
                  block.name === "ask_user_question"
                ) {
                  // Emit question as text
                  const parsedInput = (block.input ?? {}) as Record<
                    string,
                    unknown
                  >
                  const question =
                    (parsedInput?.question as string) || "Question?"
                  responseText += `\n\n_Asking: ${question}_\n\n`
                  continue
                }

                if (block.name === "ExitPlanMode") {
                  const parsedInput = (block.input ?? {}) as Record<
                    string,
                    unknown
                  >
                  const plan = (parsedInput?.plan as string) || ""
                  responseText += `\n\n${plan}\n\n---\n**Do you want to proceed with this plan?** (yes/no)\n`
                  continue
                }

                toolCalls.push({
                  id: block.id,
                  name: block.name,
                  args: block.input ?? {},
                })
              }
            }
          }

          if (msg.type === "content_block_start" && msg.content_block) {
            if (
              msg.content_block.type === "tool_use" &&
              msg.content_block.id &&
              msg.content_block.name
            ) {
              toolCalls.push({
                id: msg.content_block.id,
                name: msg.content_block.name,
                args: {},
              })
            }
          }

          if (msg.type === "content_block_delta" && msg.delta) {
            if (msg.delta.type === "text_delta" && msg.delta.text) {
              responseText += msg.delta.text
            }
            if (msg.delta.type === "thinking_delta" && msg.delta.thinking) {
              thinkingText += msg.delta.thinking
            }
            if (
              msg.delta.type === "input_json_delta" &&
              msg.delta.partial_json &&
              msg.index !== undefined
            ) {
              const tc = toolCalls[msg.index]
              if (tc) {
                try {
                  tc.args = JSON.parse(msg.delta.partial_json)
                } catch {
                  // Partial JSON, accumulate
                }
              }
            }
          }

          if (msg.type === "result") {
            if (msg.session_id) {
              setClaudeSessionId(sk, msg.session_id)
            }

            // Some CLI failures only surface user-readable text on the final
            // `result` message (without prior assistant text blocks). Preserve
            // that so callers don't receive an empty response.
            if (
              !responseText &&
              msg.is_error &&
              typeof msg.result === "string" &&
              msg.result.trim().length > 0
            ) {
              responseText = msg.result
            }

            resultMeta = {
              sessionId: msg.session_id,
              costUsd: msg.total_cost_usd,
              durationMs: msg.duration_ms,
              usage: msg.usage,
            }
            resolve({
              ...resultMeta,
              text: responseText,
              thinking: thinkingText,
              toolCalls,
            })
          }
        } catch {
          // Ignore non-JSON lines
        }
      })

      rl.on("close", () => {
        resolve({
          ...resultMeta,
          text: responseText,
          thinking: thinkingText,
          toolCalls,
        })
      })

      proc.on("error", (err) => {
        log.error("process error", { error: err.message })
        reject(err)
      })

      proc.stderr?.on("data", (data: Buffer) => {
        log.debug("stderr", { data: data.toString().slice(0, 200) })
      })

      proc.stdin?.write(userMsg + "\n")
    })

    const content: LanguageModelV3Content[] = []

    if (result.thinking) {
      content.push({
        type: "reasoning",
        text: result.thinking,
      } as any)
    }

    if (result.text) {
      content.push({
        type: "text",
        text: result.text,
        providerMetadata: {
          "claude-code": {
            sessionId: result.sessionId ?? null,
            costUsd: result.costUsd ?? null,
            durationMs: result.durationMs ?? null,
          },
          ...(typeof result.usage?.cache_creation_input_tokens === "number"
            ? {
                anthropic: {
                  cacheCreationInputTokens:
                    result.usage.cache_creation_input_tokens,
                },
              }
            : {}),
        },
      })
    }

    for (const tc of result.toolCalls) {
      const {
        name: mappedName,
        input: mappedInput,
        executed,
        skip,
      } = mapTool(tc.name, tc.args)
      if (skip) continue
      content.push({
        type: "tool-call",
        toolCallId: tc.id,
        toolName: mappedName,
        input: JSON.stringify(mappedInput),
        providerExecuted: executed,
      } as any)
    }

    const usage = this.toUsage(result.usage)

    return {
      content,
      // Claude CLI's `result` message signals a fully-completed turn —
      // tools have already been executed internally and final assistant
      // text has been produced. Always report "stop" so opencode doesn't
      // loop expecting to run tools itself.
      finishReason: this.toFinishReason("stop"),
      usage,
      request: { body: { text: userMsg } },
      response: {
        id: result.sessionId ?? generateId(),
        timestamp: new Date(),
        modelId: this.modelId,
      },
      providerMetadata: {
        "claude-code": {
          sessionId: result.sessionId ?? null,
          costUsd: result.costUsd ?? null,
          durationMs: result.durationMs ?? null,
        },
        ...(typeof result.usage?.cache_creation_input_tokens === "number"
          ? {
              anthropic: {
                cacheCreationInputTokens:
                  result.usage.cache_creation_input_tokens,
              },
            }
          : {}),
      },
      warnings,
    }
  }

  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV3["doStream"]>>> {
    const warnings: SharedV3Warning[] = []
    const cwd = this.config.cwd ?? process.cwd()
    const cliPath = this.config.cliPath
    const skipPermissions = this.config.skipPermissions !== false
    const scope = this.requestScope(options as any)
    const affinity = this.sessionAffinity(options)
    const sk = sessionKey(cwd, `${this.modelId}::${scope}::${affinity}`)
    const toUsage = this.toUsage.bind(this)
    const toFinishReason = this.toFinishReason.bind(this)
    const handleControlRequest = this.handleControlRequest.bind(this)

    if (scope === "no-tools") {
      const text = this.synthesizeTitle(options.prompt)
      const textId = generateId()
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings })
          controller.enqueue({ type: "text-start", id: textId } as any)
          controller.enqueue({
            type: "text-delta",
            id: textId,
            delta: text,
          })
          controller.enqueue({ type: "text-end", id: textId })
          controller.enqueue({
            type: "finish",
            finishReason: toFinishReason("stop"),
            usage: toUsage({ input_tokens: 0, output_tokens: 0 }),
            providerMetadata: {
              "claude-code": {
                synthetic: true,
                path: "no-tools",
              },
            },
          })
          controller.close()
        },
      })

      return {
        stream,
        request: { body: { text: "" } },
      }
    }

    const hasPriorConversation =
      options.prompt.filter((m) => m.role === "user" || m.role === "assistant")
        .length > 1

    // New session — clear any stale state from a previous session
    if (!hasPriorConversation) {
      deleteClaudeSessionId(sk)
      deleteActiveProcess(sk)
    }

    const hasExistingSession = !!getClaudeSessionId(sk)
    const hasActiveProcess = !!getActiveProcess(sk)
    const includeHistoryContext =
      !hasExistingSession && !hasActiveProcess && hasPriorConversation

    const reasoningEffort = this.getReasoningEffort(options.providerOptions)
    const userMsg = getClaudeUserMessage(
      options.prompt,
      includeHistoryContext,
      reasoningEffort,
    )
    const resolvedProxy = this.resolvedProxyTools()
    const self = this

    const pendingProxyCall = getPendingProxyCall(sk)
    const pendingProxyResult = pendingProxyCall
      ? this.extractPendingProxyResult(options.prompt, pendingProxyCall.toolCallId)
      : null

    log.info("doStream starting", {
      cwd,
      model: this.modelId,
      textLength: userMsg.length,
      includeHistoryContext,
      hasActiveProcess,
      reasoningEffort,
      proxyTools: resolvedProxy?.map((t) => t.name) ?? null,
    })

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        let activeProcess = getActiveProcess(sk)
        let proc: import("child_process").ChildProcess
        let lineEmitter: import("events").EventEmitter
        let proxyServer: ProxyMcpServer | null = activeProcess?.proxyServer ?? null

        const setup = async () => {
          if (!proxyServer && resolvedProxy) {
            proxyServer = await self.ensureProxyServer(resolvedProxy, sk)
          }

          const cliArgs = buildCliArgs({
            sessionKey: sk,
            skipPermissions,
            model: self.modelId,
            permissionMode: self.config.permissionMode,
            mcpConfig: self.effectiveMcpConfig(cwd, proxyServer?.configPath()),
            strictMcpConfig: self.config.strictMcpConfig,
            disallowedTools: resolvedProxy ? disallowedToolFlags(resolvedProxy) : undefined,
          })

          if (activeProcess) {
            proc = activeProcess.proc
            lineEmitter = activeProcess.lineEmitter
            log.debug("reusing active process", { sk })
          } else {
            const ap = spawnClaudeProcess(cliPath, cliArgs, cwd, sk, proxyServer)
            proc = ap.proc
            lineEmitter = ap.lineEmitter
            activeProcess = ap
          }

          controller.enqueue({ type: "stream-start", warnings })

          let currentTextId: string | null = null
          const textBlockIndices = new Set<number>()

          const startTextBlock = (): string => {
            if (currentTextId) {
              controller.enqueue({ type: "text-end", id: currentTextId })
            }
            const id = generateId()
            currentTextId = id
            controller.enqueue({ type: "text-start", id } as any)
            return id
          }

          const endTextBlock = (): void => {
            if (currentTextId) {
              controller.enqueue({ type: "text-end", id: currentTextId })
              currentTextId = null
            }
          }

          const reasoningIds = new Map<number, string>()
          const reasoningStarted = new Map<number, boolean>()

          let turnCompleted = false
          let controllerClosed = false
          let pendingProxyUnsubscribe: (() => void) | null = null
          let resultFallbackTimer: ReturnType<typeof setTimeout> | null = null
          let hasReceivedContent = false

          const clearFallbackTimer = () => {
            if (resultFallbackTimer) {
              clearTimeout(resultFallbackTimer)
              resultFallbackTimer = null
            }
          }

          const startResultFallback = () => {
            clearFallbackTimer()
            if (!hasReceivedContent || controllerClosed) return
            resultFallbackTimer = setTimeout(() => {
              if (controllerClosed) return
              log.warn("result fallback timer fired — closing stream without result event")
              closeHandler()
            }, 5000)
          }

          const toolCallMap = new Map<
            number,
            { id: string; name: string; inputJson: string }
          >()
          // Tool calls the plugin reported as providerExecuted:false — opencode
          // will run these itself and emit its own tool-result, so we must NOT
          // forward Claude CLI's tool_result for them (would short-circuit
          // opencode's execute).
          const skipResultForIds = new Set<string>()
          const toolCallsById = new Map<
            string,
            { id: string; name: string; input: unknown }
          >()

          let resultMeta: {
            sessionId?: string
            costUsd?: number
            durationMs?: number
            usage?: ClaudeStreamMessage["usage"]
          } = {}

        const finishWithToolCall = (call: PendingProxyCall) => {
          if (controllerClosed) return
          controller.enqueue({
            type: "tool-input-start",
            id: call.toolCallId,
            toolName: call.toolName,
          } as any)
          controller.enqueue({
            type: "tool-call",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: JSON.stringify(call.input),
            providerExecuted: false,
          } as any)
          skipResultForIds.add(call.toolCallId)
          controller.enqueue({
            type: "finish",
            finishReason: toFinishReason("tool-calls"),
            usage: toUsage(resultMeta.usage),
            providerMetadata: {
              "claude-code": resultMeta,
            },
          })
          controllerClosed = true
          lineEmitter.off("line", lineHandler)
          lineEmitter.off("close", closeHandler)
          pendingProxyUnsubscribe?.()
          pendingProxyUnsubscribe = null
          try {
            controller.close()
          } catch {}
        }

        const lineHandler = (line: string) => {
          if (!line.trim()) return
          if (controllerClosed) return

          try {
            const msg: ClaudeStreamMessage = JSON.parse(line)

            if (handleControlRequest(msg, proc)) {
              return
            }

            log.debug("stream message", {
              type: msg.type,
              subtype: msg.subtype,
            })

            // Handle system init
            if (msg.type === "system" && msg.subtype === "init") {
              if (msg.session_id) {
                setClaudeSessionId(sk, msg.session_id)
                log.info("session initialized", {
                  claudeSessionId: msg.session_id,
                })
              }
            }

            // content_block_start
            if (
              msg.type === "content_block_start" &&
              msg.content_block &&
              msg.index !== undefined
            ) {
              const block = msg.content_block
              const idx = msg.index

              if (block.type === "thinking") {
                const reasoningId = generateId()
                reasoningIds.set(idx, reasoningId)
                controller.enqueue({
                  type: "reasoning-start",
                  id: reasoningId,
                } as any)
                reasoningStarted.set(idx, true)
              }

              if (block.type === "text") {
                clearFallbackTimer()
                textBlockIndices.add(idx)
                if (block.text) {
                  if (!currentTextId) startTextBlock()
                  controller.enqueue({
                    type: "text-delta",
                    id: currentTextId!,
                    delta: block.text,
                  })
                  hasReceivedContent = true
                }
              }

              if (block.type === "tool_use" && block.id && block.name) {
                clearFallbackTimer()
                toolCallMap.set(idx, {
                  id: block.id,
                  name: block.name,
                  inputJson: "",
                })

                if (
                  block.name !== "AskUserQuestion" &&
                  block.name !== "ask_user_question" &&
                  block.name !== "ExitPlanMode" &&
                  !block.name.startsWith(PROXY_TOOL_PREFIX)
                ) {
                  const { name: mappedName, skip, executed } = mapTool(block.name)
                  if (!skip) {
                    controller.enqueue({
                      type: "tool-input-start",
                      id: block.id,
                      toolName: mappedName,
                      providerExecuted: executed,
                    } as any)
                    log.info("tool started", {
                      name: block.name,
                      mappedName,
                      id: block.id,
                    })
                  }
                }
              }
            }

            // content_block_delta
            if (
              msg.type === "content_block_delta" &&
              msg.delta &&
              msg.index !== undefined
            ) {
              const delta = msg.delta
              const idx = msg.index

              if (delta.type === "thinking_delta" && delta.thinking) {
                const reasoningId = reasoningIds.get(idx)
                if (reasoningId) {
                  controller.enqueue({
                    type: "reasoning-delta",
                    id: reasoningId,
                    delta: delta.thinking,
                  } as any)
                }
              }

              if (delta.type === "text_delta" && delta.text) {
                if (!currentTextId) startTextBlock()
                controller.enqueue({
                  type: "text-delta",
                  id: currentTextId!,
                  delta: delta.text,
                })
                hasReceivedContent = true
              }

              if (delta.type === "input_json_delta" && delta.partial_json) {
                const tc = toolCallMap.get(idx)
                if (tc) {
                  tc.inputJson += delta.partial_json
                  controller.enqueue({
                    type: "tool-input-delta",
                    id: tc.id,
                    delta: delta.partial_json,
                  } as any)
                }
              }
            }

            // content_block_stop
            if (
              msg.type === "content_block_stop" &&
              msg.index !== undefined
            ) {
              const idx = msg.index

              const reasoningId = reasoningIds.get(idx)
              if (reasoningId && reasoningStarted.get(idx)) {
                controller.enqueue({
                  type: "reasoning-end",
                  id: reasoningId,
                } as any)
                reasoningStarted.delete(idx)
              }

              if (textBlockIndices.has(idx)) {
                endTextBlock()
                textBlockIndices.delete(idx)
                startResultFallback()
              }

              const tc = toolCallMap.get(idx)
              if (tc) {
                let parsedInput: any = {}
                try {
                  parsedInput = JSON.parse(tc.inputJson || "{}")
                } catch {}

                if (
                  tc.name === "AskUserQuestion" ||
                  tc.name === "ask_user_question"
                ) {
                  let question = "Question?"
                  if (
                    parsedInput?.questions &&
                    Array.isArray(parsedInput.questions) &&
                    parsedInput.questions.length > 0
                  ) {
                    question =
                      parsedInput.questions[0].question ||
                      parsedInput.questions[0].text ||
                      "Question?"
                  } else {
                    question =
                      parsedInput?.question ||
                      parsedInput?.text ||
                      "Question?"
                  }

                  const askId = startTextBlock()
                  controller.enqueue({
                    type: "text-delta",
                    id: askId,
                    delta: `\n\n_Asking: ${question}_\n\n`,
                  })
                  endTextBlock()
                } else if (tc.name === "ExitPlanMode") {
                  const plan = (parsedInput?.plan as string) || ""

                  const planId = startTextBlock()
                  controller.enqueue({
                    type: "text-delta",
                    id: planId,
                    delta: `\n\n${plan}\n\n---\n**Do you want to proceed with this plan?** (yes/no)\n`,
                  })
                  endTextBlock()
                } else if (tc.name.startsWith(PROXY_TOOL_PREFIX)) {
                  log.debug("ignoring proxy tool_use block; broker handles it", {
                    name: tc.name,
                    id: tc.id,
                  })
                } else {
                  const {
                    name: mappedName,
                    input: mappedInput,
                    executed,
                    skip,
                  } = mapTool(tc.name, parsedInput)

                  if (!skip) {
                    toolCallsById.set(tc.id, {
                      id: tc.id,
                      name: tc.name,
                      input: parsedInput,
                    })
                    if (!executed) skipResultForIds.add(tc.id)

                    controller.enqueue({
                      type: "tool-call",
                      toolCallId: tc.id,
                      toolName: mappedName,
                      input: JSON.stringify(mappedInput),
                      providerExecuted: executed,
                    } as any)
                  }
                  log.info("tool call complete", {
                    name: tc.name,
                    mappedName,
                    id: tc.id,
                    executed,
                  })
                }
              }
            }

            // assistant message (complete, not streaming)
            if (msg.type === "assistant" && msg.message?.content) {
              const hasText = msg.message.content.some(
                (b: any) => b.type === "text" && b.text,
              )
              const hasToolUse = msg.message.content.some(
                (b: any) => b.type === "tool_use",
              )

              if (hasText) {
                hasReceivedContent = true
              }

              if (hasText && !hasToolUse) {
                startResultFallback()
              }
              if (hasToolUse) {
                clearFallbackTimer()
              }

              for (const block of msg.message.content) {
                if (block.type === "text" && block.text) {
                  const blockId = startTextBlock()
                  controller.enqueue({
                    type: "text-delta",
                    id: blockId,
                    delta: block.text,
                  })
                  endTextBlock()
                  hasReceivedContent = true
                }

                if (block.type === "thinking" && block.thinking) {
                  const thinkingId = generateId()
                  controller.enqueue({
                    type: "reasoning-start",
                    id: thinkingId,
                  } as any)
                  controller.enqueue({
                    type: "reasoning-delta",
                    id: thinkingId,
                    delta: block.thinking,
                  } as any)
                  controller.enqueue({
                    type: "reasoning-end",
                    id: thinkingId,
                  } as any)
                }

                if (block.type === "tool_use" && block.id && block.name) {
                  const parsedInput = (block.input ?? {}) as Record<
                    string,
                    unknown
                  >
                  toolCallsById.set(block.id, {
                    id: block.id,
                    name: block.name,
                    input: parsedInput,
                  })

                  if (
                    block.name === "AskUserQuestion" ||
                    block.name === "ask_user_question"
                  ) {
                    let question = "Question?"
                    if (
                      parsedInput?.questions &&
                      Array.isArray(parsedInput.questions) &&
                      parsedInput.questions.length > 0
                    ) {
                      const q = parsedInput.questions[0] as any
                      question = q.question || q.text || "Question?"
                    } else {
                      question =
                        (parsedInput?.question as string) ||
                        (parsedInput?.text as string) ||
                        "Question?"
                    }

                    const askId = startTextBlock()
                    controller.enqueue({
                      type: "text-delta",
                      id: askId,
                      delta: `\n\n_Asking: ${question}_\n\n`,
                    })
                    endTextBlock()
                  } else if (block.name === "ExitPlanMode") {
                    const plan = (parsedInput?.plan as string) || ""

                    const planId = startTextBlock()
                    controller.enqueue({
                      type: "text-delta",
                      id: planId,
                      delta: `\n\n${plan}\n\n---\n**Do you want to proceed with this plan?** (yes/no)\n`,
                    })
                    endTextBlock()
                  } else if (block.name.startsWith(PROXY_TOOL_PREFIX)) {
                    log.debug("ignoring proxy tool_use from assistant message", {
                      name: block.name,
                      id: block.id,
                    })
                  } else {
                    const {
                      name: mappedName,
                      input: mappedInput,
                      executed,
                      skip,
                    } = mapTool(block.name, parsedInput)

                    if (!skip) {
                      if (!executed) skipResultForIds.add(block.id)
                      controller.enqueue({
                        type: "tool-input-start",
                        id: block.id,
                        toolName: mappedName,
                        providerExecuted: executed,
                      } as any)
                      controller.enqueue({
                        type: "tool-call",
                        toolCallId: block.id,
                        toolName: mappedName,
                        input: JSON.stringify(mappedInput),
                        providerExecuted: executed,
                      } as any)
                    }
                    log.info("tool_use from assistant message", {
                      name: block.name,
                      mappedName,
                      id: block.id,
                      executed,
                    })
                  }
                }

                if (block.type === "tool_result") {
                  log.debug("tool_result", {
                    toolUseId: block.tool_use_id,
                  })
                }
              }
            }

            // user message (tool results from Claude CLI)
            if (msg.type === "user" && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === "tool_result" && block.tool_use_id) {
                  if (skipResultForIds.has(block.tool_use_id)) {
                    log.debug("skipping tool-result (opencode runs it)", {
                      toolUseId: block.tool_use_id,
                    })
                    continue
                  }
                  const toolCall = toolCallsById.get(block.tool_use_id)
                  if (toolCall) {
                    let resultText = ""
                    if (typeof block.content === "string") {
                      resultText = block.content
                    } else if (Array.isArray(block.content)) {
                      resultText = block.content
                        .filter(
                          (
                            c,
                          ): c is { type: string; text: string } =>
                            c.type === "text" &&
                            typeof c.text === "string",
                        )
                        .map((c) => c.text)
                        .join("\n")
                    }

                    controller.enqueue({
                      type: "tool-result",
                      toolCallId: block.tool_use_id,
                      toolName: toolCall.name,
                      result: {
                        output: resultText,
                        title: toolCall.name,
                        metadata: {},
                      },
                      providerExecuted: true,
                    } as any)
                    log.info("tool result emitted", {
                      toolUseId: block.tool_use_id,
                      name: toolCall.name,
                    })
                    toolCallsById.delete(block.tool_use_id)
                  }
                }
              }
            }

            // result - end of conversation turn
            if (msg.type === "result") {
              clearFallbackTimer()

              if (msg.session_id) {
                setClaudeSessionId(sk, msg.session_id)
              }

              // Some CLI failures only include user-readable text in
              // `result.result` (no prior assistant text blocks). Emit it so
              // opencode users don't see a blank turn.
              if (
                !currentTextId &&
                msg.is_error &&
                typeof msg.result === "string" &&
                msg.result.trim().length > 0
              ) {
                const errId = startTextBlock()
                controller.enqueue({
                  type: "text-delta",
                  id: errId,
                  delta: msg.result,
                })
              }

              resultMeta = {
                sessionId: msg.session_id,
                costUsd: msg.total_cost_usd,
                durationMs: msg.duration_ms,
                usage: msg.usage,
              }

              log.info("conversation result", {
                sessionId: msg.session_id,
                durationMs: msg.duration_ms,
                numTurns: msg.num_turns,
                isError: msg.is_error,
              })

              turnCompleted = true

              endTextBlock()

              for (const [idx, reasoningId] of reasoningIds) {
                if (reasoningStarted.get(idx)) {
                  controller.enqueue({
                    type: "reasoning-end",
                    id: reasoningId,
                  } as any)
                }
              }

              controller.enqueue({
                type: "finish",
                finishReason: toFinishReason("stop"),
                usage: toUsage(msg.usage),
                providerMetadata: {
                  "claude-code": resultMeta,
                  ...(typeof msg.usage?.cache_creation_input_tokens === "number"
                    ? {
                        anthropic: {
                          cacheCreationInputTokens:
                            msg.usage.cache_creation_input_tokens,
                        },
                      }
                    : {}),
                },
              })

              controllerClosed = true
              lineEmitter.off("line", lineHandler)
              lineEmitter.off("close", closeHandler)

              try {
                controller.close()
              } catch {}
            }
          } catch (e) {
            log.debug("failed to parse line", {
              error:
                e instanceof Error ? e.message : String(e),
            })
          }
        }

        const closeHandler = () => {
          log.debug("readline closed")
          if (controllerClosed) return
          clearFallbackTimer()
          controllerClosed = true
          lineEmitter.off("line", lineHandler)
          lineEmitter.off("close", closeHandler)
          pendingProxyUnsubscribe?.()
          pendingProxyUnsubscribe = null
          endTextBlock()
          controller.enqueue({
            type: "finish",
            finishReason: toFinishReason("stop"),
            usage: toUsage(),
            providerMetadata: {
              "claude-code": resultMeta,
            },
          })
          try {
            controller.close()
          } catch {}
        }

        lineEmitter.on("line", lineHandler)
        lineEmitter.on("close", closeHandler)

        pendingProxyUnsubscribe = onPendingProxyCall(sk, (call) => {
          log.info("received pending proxy call for session", {
            sessionKey: sk,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
          })
          finishWithToolCall(call)
        })

        proc.on("error", (err: Error) => {
          log.error("process error", { error: err.message })
          clearFallbackTimer()
          if (controllerClosed) return
          controllerClosed = true
          pendingProxyUnsubscribe?.()
          pendingProxyUnsubscribe = null
          controller.enqueue({ type: "error", error: err })
          try {
            controller.close()
          } catch {}
        })

        // On abort, keep process alive for next message
        if (options.abortSignal) {
          options.abortSignal.addEventListener("abort", () => {
            if (turnCompleted || controllerClosed) return

            if (!hasReceivedContent) {
              log.info(
                "abort signal received before content, closing stream immediately",
                { cwd },
              )
              controllerClosed = true
              lineEmitter.off("line", lineHandler)
              lineEmitter.off("close", closeHandler)
              pendingProxyUnsubscribe?.()
              pendingProxyUnsubscribe = null
              try {
                controller.close()
              } catch {}
              return
            }

            log.info(
              "abort signal received mid-turn, starting grace period",
              { cwd },
            )
            startResultFallback()
          })
        }

        if (pendingProxyCall && pendingProxyResult) {
          log.info("resolving pending proxy call from tool result prompt", {
            sessionKey: sk,
            toolCallId: pendingProxyCall.toolCallId,
            toolName: pendingProxyCall.toolName,
          })
          const resolved = resolvePendingProxyCall(sk, pendingProxyResult)
          if (!resolved) {
            log.warn("failed to resolve pending proxy call; no pending state", {
              sessionKey: sk,
              toolCallId: pendingProxyCall.toolCallId,
            })
          }
          return
        }

        // Send the user message for a fresh turn.
        proc.stdin?.write(userMsg + "\n")
        log.debug("sent user message", { textLength: userMsg.length })
        }

        void setup().catch((err) => {
          log.error("failed to set up doStream", {
            error: err instanceof Error ? err.message : String(err),
          })
          controller.enqueue({
            type: "error",
            error: err instanceof Error ? err : new Error(String(err)),
          })
          try {
            controller.close()
          } catch {}
        })
      },
      cancel() {
        // Consumer cancelled the stream
      },
    })

    return {
      stream,
      request: { body: { text: userMsg } },
      response: { headers: {} },
    }
  }
}
