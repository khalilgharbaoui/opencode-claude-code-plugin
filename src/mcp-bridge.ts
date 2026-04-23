import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import * as crypto from "node:crypto"
import { log } from "./logger.js"

/**
 * Bridge opencode's `mcp` config block into a Claude CLI `--mcp-config` file.
 *
 * Opencode's schema (packages/opencode/src/config/mcp.ts):
 *   {
 *     "mcp": {
 *       "name": {
 *         "type": "local" | "remote",
 *         "command"?: string[],
 *         "environment"?: Record<string,string>,
 *         "enabled"?: boolean,
 *         "url"?: string,
 *         "headers"?: Record<string,string>,
 *       }
 *     }
 *   }
 *
 * Claude CLI's schema (--mcp-config):
 *   {
 *     "mcpServers": {
 *       "name": {
 *         "command"?: string, "args"?: string[], "env"?: Record<string,string>,
 *         "url"?: string, "headers"?: Record<string,string>,
 *       }
 *     }
 *   }
 */

const CONFIG_NAMES = ["opencode.jsonc", "opencode.json", "config.json"]

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function findConfigInDir(dir: string): string | null {
  for (const name of CONFIG_NAMES) {
    const p = path.join(dir, name)
    if (fileExists(p)) return p
  }
  return null
}

function walkUpForConfig(startDir: string): string[] {
  // Collect from cwd upward, then reverse so root-most is first and
  // cwd-most is last — i.e. files closer to cwd override ancestors
  // when merged.
  const closestFirst: string[] = []
  let dir = path.resolve(startDir)
  while (true) {
    const hit = findConfigInDir(dir)
    if (hit) closestFirst.push(hit)
    // Also honor `.opencode/` sibling convention used by opencode.
    const dotdir = path.join(dir, ".opencode")
    const dothit = findConfigInDir(dotdir)
    if (dothit) closestFirst.push(dothit)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return closestFirst.reverse()
}

function globalConfigs(): string[] {
  const out: string[] = []
  const xdg =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
  const dir = path.join(xdg, "opencode")
  const hit = findConfigInDir(dir)
  if (hit) out.push(hit)
  return out
}

/** Strip `//` and `/* *\/` comments so JSONC parses via JSON.parse. */
function stripJsonComments(text: string): string {
  let out = ""
  let i = 0
  let inString: string | null = null
  while (i < text.length) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === "\\" && i + 1 < text.length) {
        out += text[i + 1]
        i += 2
        continue
      }
      if (c === inString) inString = null
      i++
      continue
    }
    if (c === '"' || c === "'") {
      inString = c
      out += c
      i++
      continue
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2
      while (
        i < text.length &&
        !(text[i] === "*" && text[i + 1] === "/")
      )
        i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

function discoverConfigFiles(cwd: string): string[] {
  // Merge order: earliest = lowest priority, latest = highest priority.
  // We want project (walked from cwd) to override global, and the explicit
  // OPENCODE_CONFIG / OPENCODE_CONFIG_DIR env vars to override everything.
  const files: string[] = []

  files.push(...globalConfigs())
  files.push(...walkUpForConfig(cwd))

  const dir = process.env.OPENCODE_CONFIG_DIR
  if (dir) {
    const hit = findConfigInDir(dir)
    if (hit) files.push(hit)
  }

  const explicit = process.env.OPENCODE_CONFIG
  if (explicit && fileExists(explicit)) files.push(explicit)

  // Dedupe, keeping the *last* occurrence (highest-priority spot).
  const resolvedOrder: string[] = files.map((f) => path.resolve(f))
  const lastIndex = new Map<string, number>()
  resolvedOrder.forEach((f, i) => lastIndex.set(f, i))
  return resolvedOrder.filter((f, i) => lastIndex.get(f) === i)
}

interface OpencodeLocalServer {
  type: "local"
  command?: string[]
  environment?: Record<string, string>
  enabled?: boolean
}

interface OpencodeRemoteServer {
  type: "remote"
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
}

type OpencodeServer = OpencodeLocalServer | OpencodeRemoteServer

function translateServer(
  name: string,
  spec: OpencodeServer,
): Record<string, unknown> | null {
  if (!spec || typeof spec !== "object") return null
  if (spec.enabled === false) return null

  if (spec.type === "local") {
    const cmd = spec.command
    if (!Array.isArray(cmd) || cmd.length === 0) {
      log.warn("skipping local MCP server with no command", { name })
      return null
    }
    const out: Record<string, unknown> = {
      command: String(cmd[0]),
    }
    if (cmd.length > 1) out.args = cmd.slice(1).map((s) => String(s))
    if (spec.environment && typeof spec.environment === "object") {
      out.env = spec.environment
    }
    return out
  }

  if (spec.type === "remote") {
    if (!spec.url || typeof spec.url !== "string") {
      log.warn("skipping remote MCP server with no url", { name })
      return null
    }
    const out: Record<string, unknown> = { url: spec.url }
    if (spec.headers && typeof spec.headers === "object") {
      out.headers = spec.headers
    }
    return out
  }

  log.warn("skipping MCP server with unknown type", {
    name,
    type: (spec as any)?.type,
  })
  return null
}

function readAndParse(file: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(file, "utf8")
    return JSON.parse(stripJsonComments(raw)) as Record<string, unknown>
  } catch (e) {
    log.warn("failed to parse opencode config", {
      file,
      error: e instanceof Error ? e.message : String(e),
    })
    return null
  }
}

/**
 * Read opencode config file(s), translate their `mcp` block to Claude CLI
 * format, write a scratch file, and return its path. Later files override
 * earlier files per server-name (matching opencode's own merge semantics).
 *
 * Returns null when no opencode config with MCP servers is found — callers
 * should treat that as "nothing to bridge" and carry on.
 */
export function bridgeOpencodeMcp(cwd: string): string | null {
  const files = discoverConfigFiles(cwd)
  if (files.length === 0) return null

  const merged: Record<string, OpencodeServer> = {}
  for (const file of files) {
    const parsed = readAndParse(file)
    const mcp = (parsed?.mcp ?? null) as
      | Record<string, OpencodeServer>
      | null
    if (!mcp || typeof mcp !== "object") continue
    for (const [name, spec] of Object.entries(mcp)) {
      merged[name] = spec
    }
  }

  const servers: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(merged)) {
    const translated = translateServer(name, spec)
    if (translated) servers[name] = translated
  }
  if (Object.keys(servers).length === 0) return null

  const body = JSON.stringify({ mcpServers: servers }, null, 2)
  const hash = crypto
    .createHash("sha256")
    .update(body)
    .digest("hex")
    .slice(0, 12)
  const outPath = path.join(
    os.tmpdir(),
    `opencode-claude-code-mcp-${hash}.json`,
  )
  try {
    if (!fileExists(outPath)) {
      fs.writeFileSync(outPath, body, { encoding: "utf8", mode: 0o600 })
    }
  } catch (e) {
    log.warn("failed to write bridged MCP config", {
      error: e instanceof Error ? e.message : String(e),
    })
    return null
  }

  log.info("bridged opencode MCP config", {
    sources: files,
    target: outPath,
    servers: Object.keys(servers),
  })
  return outPath
}
