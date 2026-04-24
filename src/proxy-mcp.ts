import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import * as crypto from "node:crypto"
import { EventEmitter } from "node:events"
import { log } from "./logger.js"

/**
 * Minimal MCP HTTP server embedded in-process. Exposes a set of "proxy"
 * tools (Bash, Edit, Write, etc.) that Claude CLI calls when its built-in
 * equivalents are disabled via --disallowedTools. Our handler blocks until
 * an external broker resolves the call, then responds to Claude.
 *
 * Wire protocol: JSON-RPC 2.0 over plain HTTP POST to `/mcp`. MCP spec
 * also supports SSE streaming, but Claude's HTTP transport accepts single
 * JSON responses for short-lived tool calls, so we keep it simple.
 */

export interface ProxyMcpServer {
  url: string
  serverName: string
  tools: ProxyToolDef[]
  /** Fires when Claude invokes one of our proxy tools. The handler resolves
   * the returned pending call once a result is available. */
  calls: EventEmitter
  /** Write `--mcp-config <path>`-compatible scratch file and return its path. */
  configPath(): string
  close(): Promise<void>
}

export interface ProxyToolDef {
  /** Raw name as seen by Claude once proxied: the MCP exposed tool name. */
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ProxyToolCall {
  id: string
  toolName: string
  input: Record<string, unknown>
  resolve: (result: ProxyToolResult) => void
  reject: (err: Error) => void
}

export type ProxyToolResult =
  | { kind: "text"; text: string; isError?: boolean }
  | { kind: "error"; message: string }

const PROTOCOL_VERSION = "2024-11-05"
const SERVER_NAME = "opencode_proxy"
export const PROXY_TOOL_PREFIX = `mcp__${SERVER_NAME}__`

export const DEFAULT_PROXY_TOOLS: ProxyToolDef[] = [
  {
    name: "bash",
    description:
      "Execute a shell command. Routed through opencode's bash tool so" +
      " permission prompts flow through opencode's UI.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute.",
        },
        description: {
          type: "string",
          description: "Short human-readable description of what the command does.",
        },
        timeout: {
          type: "number",
          description: "Optional timeout in milliseconds.",
        },
      },
      required: ["command"],
    },
  },
]

export async function createProxyMcpServer(
  tools: ProxyToolDef[] = DEFAULT_PROXY_TOOLS,
): Promise<ProxyMcpServer> {
  const calls = new EventEmitter()
  const pending = new Map<string, ProxyToolCall>()

  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/mcp")) {
      res.statusCode = 404
      res.end()
      return
    }
    try {
      const body = await readBody(req)
      const request = JSON.parse(body) as {
        jsonrpc?: string
        id?: number | string | null
        method?: string
        params?: Record<string, unknown>
      }

      if (request?.jsonrpc !== "2.0" || typeof request.method !== "string") {
        writeJson(res, {
          jsonrpc: "2.0",
          id: request?.id ?? null,
          error: { code: -32600, message: "Invalid request" },
        })
        return
      }

      log.debug("proxy-mcp request", {
        method: request.method,
        id: request.id,
      })

      if (request.method === "initialize") {
        writeJson(res, {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: {
              name: SERVER_NAME,
              version: "0.1.0",
            },
          },
        })
        return
      }

      if (request.method === "notifications/initialized") {
        res.statusCode = 204
        res.end()
        return
      }

      if (request.method === "tools/list") {
        writeJson(res, {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        })
        return
      }

      if (request.method === "tools/call") {
        const params = request.params ?? {}
        const toolName = String(params.name ?? "")
        const input = (params.arguments ?? {}) as Record<string, unknown>

        if (!tools.some((t) => t.name === toolName)) {
          writeJson(res, {
            jsonrpc: "2.0",
            id: request.id ?? null,
            error: {
              code: -32601,
              message: `Unknown proxy tool: ${toolName}`,
            },
          })
          return
        }

        const callId = crypto.randomUUID()
        log.info("proxy-mcp tool call received", {
          callId,
          toolName,
          hasInput: input != null,
        })

        const result = await new Promise<ProxyToolResult>(
          (resolve, reject) => {
            const entry: ProxyToolCall = {
              id: callId,
              toolName,
              input,
              resolve,
              reject,
            }
            pending.set(callId, entry)
            calls.emit("call", entry)
          },
        ).finally(() => {
          pending.delete(callId)
        })

        if (result.kind === "error") {
          writeJson(res, {
            jsonrpc: "2.0",
            id: request.id ?? null,
            error: {
              code: -32000,
              message: result.message,
            },
          })
          return
        }

        writeJson(res, {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: {
            content: [{ type: "text", text: result.text }],
            isError: result.isError === true,
          },
        })
        return
      }

      writeJson(res, {
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: { code: -32601, message: `Unknown method: ${request.method}` },
      })
    } catch (error) {
      log.warn("proxy-mcp error handling request", {
        error: error instanceof Error ? error.message : String(error),
      })
      try {
        writeJson(res, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal error",
          },
        })
      } catch {
        try {
          res.statusCode = 500
          res.end()
        } catch {}
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })

  const addr = server.address() as AddressInfo | null
  if (!addr) {
    server.close()
    throw new Error("Failed to bind proxy MCP server")
  }

  const url = `http://127.0.0.1:${addr.port}/mcp`

  log.info("proxy-mcp server started", {
    url,
    tools: tools.map((t) => t.name),
  })

  let configFilePath: string | null = null

  const api: ProxyMcpServer = {
    url,
    serverName: SERVER_NAME,
    tools,
    calls,
    configPath() {
      if (configFilePath) return configFilePath
      const body = JSON.stringify(
        {
          mcpServers: {
            [SERVER_NAME]: {
              type: "http",
              url,
            },
          },
        },
        null,
        2,
      )
      const hash = crypto
        .createHash("sha256")
        .update(body)
        .digest("hex")
        .slice(0, 12)
      const outPath = path.join(
        os.tmpdir(),
        `opencode-claude-code-proxy-${hash}.json`,
      )
      fs.writeFileSync(outPath, body, { encoding: "utf8", mode: 0o600 })
      configFilePath = outPath
      return outPath
    },
    async close() {
      for (const entry of pending.values()) {
        entry.reject(new Error("proxy MCP server closed"))
      }
      pending.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }

  return api
}

/** CLI-ready list of Claude tool names to disable, for each proxied tool. */
export function disallowedToolFlags(tools: ProxyToolDef[]): string[] {
  // Map our lowercase MCP tool names to Claude's capitalized internal names.
  const nameMap: Record<string, string> = {
    bash: "Bash",
    read: "Read",
    write: "Write",
    edit: "Edit",
    glob: "Glob",
    grep: "Grep",
    webfetch: "WebFetch",
  }
  const out: string[] = []
  for (const t of tools) {
    const mapped = nameMap[t.name.toLowerCase()]
    if (mapped) out.push(mapped)
  }
  return out
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function writeJson(res: ServerResponse, body: unknown): void {
  const payload = JSON.stringify(body)
  res.statusCode = 200
  res.setHeader("Content-Type", "application/json")
  res.setHeader("Content-Length", Buffer.byteLength(payload).toString())
  res.end(payload)
}
