import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import * as crypto from "node:crypto"
import { log } from "./logger.js"

/**
 * Bridge opencode's `mcp` config block into a Claude CLI `--mcp-config` file.
 *
 * Opencode core schema (packages/opencode/src/config/mcp.ts):
 *   {
 *     "mcp": {
 *       "name": {
 *         "type": "local" | "remote",
 *         "command"?: string[],          // local
 *         "environment"?: Record<string,string>,
 *         "url"?: string,                // remote
 *         "headers"?: Record<string,string>,
 *         "oauth"?: object | false,      // remote — NOT bridged (Claude --mcp-config has no slot)
 *         "timeout"?: number,            // NOT bridged (Claude --mcp-config has no slot)
 *         "enabled"?: boolean
 *       }
 *     }
 *   }
 *
 * Claude CLI `--mcp-config` schema:
 *   {
 *     "mcpServers": {
 *       "name": {
 *         "type": "stdio" | "http",
 *         "command"?: string, "args"?: string[], "env"?: Record<string,string>,
 *         "url"?: string, "headers"?: Record<string,string>
 *       }
 *     }
 *   }
 *
 * Discovery + merge are aligned with opencode core's `loadInstanceState`
 * (packages/opencode/src/config/config.ts). In merge order (last wins),
 * opencode loads:
 *
 *   1. Auth `.well-known` remote configs              ← NOT bridged
 *   2. Global: ~/.config/opencode/{config.json,opencode.json,opencode.jsonc}
 *      — all three deep-merged, jsonc highest priority
 *   3. OPENCODE_CONFIG env var (single file)
 *   4. Project walk-up: opencode.json[c] in each dir from cwd up to (not past)
 *      worktree, both extensions per dir, parent-most first
 *   5. .opencode/ siblings: from cwd up + home dir + OPENCODE_CONFIG_DIR,
 *      both extensions per dir, opencode-iteration order (cwd-most first
 *      in walk-up — so parent-most `.opencode/` wins, matching upstream)
 *   6. OPENCODE_CONFIG_CONTENT env var (inline JSON)  ← NOT bridged
 *   7. Active org remote config                       ← NOT bridged
 *   8. Managed config dir / macOS MDM                 ← NOT bridged
 *
 * Sources marked NOT bridged are niche and would require live opencode
 * runtime state (auth tokens, account context, MDM access). Document them
 * here so the gap is explicit; functionality of the common path is intact.
 *
 * Per-server merge is deep-merge (matching opencode's `mergeConfigConcatArrays`
 * → `mergeDeep`), so a project layer can override one field of a global server
 * spec — e.g. `{ "linear": { "enabled": true } }` lifts global linear's URL.
 */

const FILE_NAMES = ["opencode.jsonc", "opencode.json", "config.json"] as const
const PROJECT_FILE_NAMES = ["opencode.json", "opencode.jsonc"] as const

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
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
 * Deep merge two plain-object trees. Arrays and primitives are replaced
 * (not concatenated). Matches the effective behavior of opencode's
 * `mergeDeep` from `remeda` for the MCP block — opencode does not special
 * case array fields inside `mcp.<server>` (its only special case is
 * `instructions`, which is concat-deduped at the config root).
 */
function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x)
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target }
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue
    const existing = out[k]
    if (isPlainObject(existing) && isPlainObject(v)) {
      out[k] = deepMerge(existing, v)
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * Walk up from `start` toward filesystem root (or `stop` if provided),
 * collecting paths where each `target` exists. Mirrors opencode core's
 * `FileSystem.up` (packages/core/src/filesystem.ts): cwd-most first,
 * parent-most last.
 */
function walkUp(opts: {
  start: string
  stop?: string
  targets: readonly string[]
  predicate: (p: string) => boolean
}): string[] {
  const out: string[] = []
  let current = path.resolve(opts.start)
  while (true) {
    for (const target of opts.targets) {
      const candidate = path.join(current, target)
      if (opts.predicate(candidate)) out.push(candidate)
    }
    if (opts.stop && current === path.resolve(opts.stop)) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return out
}

/**
 * Find the worktree root by walking up from `cwd` looking for a `.git`
 * entry (file or directory — submodules use a file). If no `.git` is
 * found, walk to filesystem root. Honors OPENCODE_WORKTREE override.
 */
function detectWorktree(cwd: string): string | undefined {
  const override = process.env.OPENCODE_WORKTREE
  if (override) return path.resolve(override)
  let current = path.resolve(cwd)
  while (true) {
    const gitPath = path.join(current, ".git")
    try {
      if (fs.existsSync(gitPath)) return current
    } catch {
      // ignore
    }
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function globalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
  return path.join(xdg, "opencode")
}

/**
 * Load the merged global config from `~/.config/opencode/`. Mirrors
 * opencode core's `loadGlobal`: deep-merges config.json → opencode.json
 * → opencode.jsonc in that order (jsonc wins).
 */
function loadGlobalConfig(): Record<string, unknown> {
  const dir = globalConfigDir()
  let merged: Record<string, unknown> = {}
  for (const name of FILE_NAMES.slice().reverse()) {
    // FILE_NAMES is jsonc-first; reverse to get config.json-first order.
    const file = path.join(dir, name)
    if (!fileExists(file)) continue
    const parsed = readAndParse(file)
    if (parsed) merged = deepMerge(merged, parsed)
  }
  return merged
}

/** Load both `opencode.json` and `opencode.jsonc` in `dir`, deep-merged. */
function loadProjectFilesInDir(dir: string): Record<string, unknown> {
  let merged: Record<string, unknown> = {}
  for (const name of PROJECT_FILE_NAMES) {
    const file = path.join(dir, name)
    if (!fileExists(file)) continue
    const parsed = readAndParse(file)
    if (parsed) merged = deepMerge(merged, parsed)
  }
  return merged
}

/**
 * Build the list of `.opencode/` directories to consider, in opencode core's
 * order (matching `ConfigPaths.directories`):
 *   project walk-up (cwd-most first) → home-dir `.opencode/` → OPENCODE_CONFIG_DIR
 */
function dotOpencodeDirs(cwd: string, worktree?: string): string[] {
  const dirs: string[] = []
  const seen = new Set<string>()
  const push = (p: string) => {
    const abs = path.resolve(p)
    if (!seen.has(abs) && dirExists(abs)) {
      seen.add(abs)
      dirs.push(abs)
    }
  }

  for (const dir of walkUp({
    start: cwd,
    stop: worktree,
    targets: [".opencode"],
    predicate: dirExists,
  })) {
    push(dir)
  }

  const home = os.homedir()
  if (home) {
    const homeDot = path.join(home, ".opencode")
    if (dirExists(homeDot)) push(homeDot)
  }

  const envDir = process.env.OPENCODE_CONFIG_DIR
  if (envDir && dirExists(envDir)) push(envDir)

  return dirs
}

interface OpencodeLocalServer {
  type?: "local"
  command?: string[]
  environment?: Record<string, string>
  enabled?: boolean
}

interface OpencodeRemoteServer {
  type?: "remote"
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
}

type OpencodeServer = OpencodeLocalServer | OpencodeRemoteServer | { enabled?: boolean }

function translateServer(
  name: string,
  spec: Record<string, unknown>,
): Record<string, unknown> | null {
  if (spec.enabled === false) return null

  const type = spec.type
  if (type === "local") {
    const cmd = spec.command
    if (!Array.isArray(cmd) || cmd.length === 0) {
      log.warn("skipping local MCP server with no command", { name })
      return null
    }
    const out: Record<string, unknown> = {
      type: "stdio",
      command: String(cmd[0]),
    }
    if (cmd.length > 1) out.args = cmd.slice(1).map((s) => String(s))
    if (spec.environment && typeof spec.environment === "object") {
      out.env = spec.environment
    }
    return out
  }

  if (type === "remote") {
    if (typeof spec.url !== "string" || !spec.url) {
      log.warn("skipping remote MCP server with no url", { name })
      return null
    }
    const out: Record<string, unknown> = {
      type: "http",
      url: spec.url,
    }
    if (spec.headers && typeof spec.headers === "object") {
      out.headers = spec.headers
    }
    return out
  }

  log.warn("skipping MCP server with unknown type", {
    name,
    type: type ?? null,
  })
  return null
}

function extractMcpBlock(
  config: Record<string, unknown>,
): Record<string, OpencodeServer> {
  const mcp = config.mcp
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return {}
  return mcp as Record<string, OpencodeServer>
}

/**
 * Deep-merge per-server specs from `source` into `target`. Mirrors opencode's
 * `mergeDeep` semantics for the `mcp` record: each server entry is recursively
 * merged so a partial layer (e.g. `{ "linear": { "enabled": true } }`) can
 * override one field without dropping the rest.
 */
function mergeMcp(
  target: Record<string, OpencodeServer>,
  source: Record<string, OpencodeServer>,
): Record<string, OpencodeServer> {
  const out: Record<string, OpencodeServer> = { ...target }
  for (const [name, spec] of Object.entries(source)) {
    if (!spec || typeof spec !== "object") continue
    const existing = out[name]
    if (existing && typeof existing === "object") {
      out[name] = deepMerge(
        existing as Record<string, unknown>,
        spec as Record<string, unknown>,
      ) as OpencodeServer
    } else {
      out[name] = spec
    }
  }
  return out
}

export interface BridgedMcp {
  /** Path to the temp file containing the translated `--mcp-config`. */
  path: string
  /** Stable hash of the merged opencode mcp block (pre-translation). */
  hash: string
}

/**
 * Per-server runtime status from opencode's `client.mcp.status()`. Used as
 * an overlay on top of the on-disk merged config so opencode's UI-toggled
 * state — which lives only in-memory; `connect()`/`disconnect()` never
 * touch disk — propagates to the bridged claude subprocess.
 *
 * Treatment per server:
 *   - "connected"      → force `enabled: true` (mirror opencode)
 *   - any other status → force `enabled: false` (don't ship a server
 *     opencode can't run; user fixes it in opencode first)
 *   - missing entry    → leave disk value
 *
 * Omit the overlay and the bridge falls back to disk-only.
 */
export type RuntimeMcpStatus = Record<string, string>

/**
 * Read opencode config layers, deep-merge their `mcp` blocks per opencode's
 * own semantics, optionally apply an opencode runtime-status overlay, then
 * translate each server to Claude CLI format, write a scratch file, and
 * return its path + a stable hash. Returns null when no enabled MCP servers
 * remain after the merge + overlay.
 */
export function bridgeOpencodeMcp(
  cwd: string,
  runtimeStatus?: RuntimeMcpStatus,
): BridgedMcp | null {
  const worktree = detectWorktree(cwd)

  // Layer 1: global merged
  let merged: Record<string, OpencodeServer> = {}
  merged = mergeMcp(merged, extractMcpBlock(loadGlobalConfig()))

  // Layer 2: OPENCODE_CONFIG (single file, applied before project walk-up)
  const explicitConfig = process.env.OPENCODE_CONFIG
  if (explicitConfig && fileExists(explicitConfig)) {
    const parsed = readAndParse(explicitConfig)
    if (parsed) merged = mergeMcp(merged, extractMcpBlock(parsed))
  }

  // Layer 3: project walk-up — opencode.json[c] in each dir from cwd to
  // (not past) worktree, both extensions per dir. walkUp returns cwd-most
  // first; collect distinct dirs in that order then reverse for merge so
  // cwd-most wins under last-merge-wins.
  const projectFiles = walkUp({
    start: cwd,
    stop: worktree,
    targets: PROJECT_FILE_NAMES,
    predicate: fileExists,
  })
  const projectDirs: string[] = []
  const seenProjectDirs = new Set<string>()
  for (const f of projectFiles) {
    const d = path.dirname(f)
    if (!seenProjectDirs.has(d)) {
      seenProjectDirs.add(d)
      projectDirs.push(d)
    }
  }
  for (const dir of projectDirs.slice().reverse()) {
    merged = mergeMcp(merged, extractMcpBlock(loadProjectFilesInDir(dir)))
  }

  // Layer 4: `.opencode/` siblings — project walk-up then home-dir then
  // OPENCODE_CONFIG_DIR, in that order. Iteration order matches opencode's
  // (cwd-most first within walk-up), so under deep-merge "later wins"
  // parent-most `.opencode/` overrides cwd-most. This is upstream's
  // behavior, surprising though it is.
  for (const dir of dotOpencodeDirs(cwd, worktree)) {
    merged = mergeMcp(merged, extractMcpBlock(loadProjectFilesInDir(dir)))
  }

  // Layer 5: opencode runtime overlay. opencode's `/mcps` UI toggle calls
  // `mcp.connect()` / `mcp.disconnect()` which only mutate in-memory state,
  // never the on-disk config. Without this overlay the bridge can't see
  // those toggles and claude misses servers the user just enabled.
  if (runtimeStatus) {
    for (const name of Object.keys(merged)) {
      const status = runtimeStatus[name]
      if (status === undefined) continue
      const existing = merged[name]
      const base =
        existing && typeof existing === "object"
          ? (existing as Record<string, unknown>)
          : {}
      merged[name] = { ...base, enabled: status === "connected" } as OpencodeServer
    }
  }

  // Translate every still-enabled server.
  const servers: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(merged)) {
    if (!spec || typeof spec !== "object") continue
    const translated = translateServer(name, spec as Record<string, unknown>)
    if (translated) servers[name] = translated
  }

  if (Object.keys(servers).length === 0) return null

  const body = JSON.stringify({ mcpServers: servers }, null, 2)
  const hash = crypto.createHash("sha256").update(body).digest("hex").slice(0, 12)
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
    target: outPath,
    hash,
    servers: Object.keys(servers),
  })
  return { path: outPath, hash }
}

// Internal helpers exported for tests only.
export const __test = {
  deepMerge,
  mergeMcp,
  translateServer,
  detectWorktree,
  loadGlobalConfig,
  loadProjectFilesInDir,
  dotOpencodeDirs,
}
