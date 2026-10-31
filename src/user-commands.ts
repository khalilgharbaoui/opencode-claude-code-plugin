import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Which messages run one of the operator's own Claude Code commands, so they
 * go out without `client_composed` and run as typed (h #g280, h #g281).
 *
 * `verbatimPrompts` stamps every user envelope `client_composed: true`, which
 * stops Claude Code dispatching a leading `/name` (h #g276). That keeps
 * `/model x` from switching the process, and it also stopped the operator's
 * own commands. Measured on 2.1.314: a command or skill with
 * `disable-model-invocation: true` never ran (the model answered that it had
 * no such skill), and a model-invocable one ran only because the model read
 * the text and called its `Skill` tool, three API turns where the command
 * itself takes one.
 *
 * A name is the operator's when its definition is where Claude Code reads it,
 * and that is also what keeps built-ins out:
 *  - a plain name needs `commands/<name>.md`, `commands/<name>/SKILL.md` or
 *    `skills/<name>/SKILL.md`, not marked `user-invocable: false`, under the
 *    spawn's config dir or a `.claude` on the CLI's own walk: from the
 *    workspace up to its git root, never the home dir's and nothing above it
 *    (measured on 2.1.314 through `initialize`: a command above the git root
 *    is not listed, one in an ancestor of a workspace outside any repository
 *    is). A user file beats a built-in of the same name (measured:
 *    `.claude/commands/model.md` answered and the process stayed on its
 *    model), so a file found there is the command that runs, and a built-in
 *    with no file keeps the mark.
 *  - a colon name is never a built-in (none of the 47 to 51 built-ins has
 *    one). `/a:b` is a nested command at `commands/a/b.md`, any depth. A
 *    plugin's (`/stripe:explain-error`) lives in the CLI's plugin cache behind
 *    enable state this module does not read, so for it a `claude` in this
 *    workspace listing the name in its `system`/`init` `slash_commands` is
 *    the evidence (`noteReportedCommands`), as in h #g280.
 *
 * The file decides alone wherever there is one, because no process reports
 * before it has read its first message: keyed on a report, the first message
 * in a folder after opencode started kept the mark (h #g281).
 *
 * Only a message whose whole content is one text block qualifies: that is the
 * shape measured, and an attachment or a replayed history keeps the mark.
 * Imports nothing that logs.
 */

const MAX_WORKSPACES = 64

/** The newest `slash_commands` a `claude` reported, per resolved workspace. */
const reportedByWorkspace = new Map<string, ReadonlySet<string>>()

/**
 * Feed every CLI stdout line here with the cwd that `claude` was spawned in.
 * Read only for a plugin's colon name, which has no file to check.
 */
export function noteReportedCommands(cwd: string, line: string): void {
  if (!line.includes('"slash_commands"')) return
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return
  }
  const frame = parsed as { type?: unknown; subtype?: unknown; slash_commands?: unknown } | null
  if (frame?.type !== "system" || frame.subtype !== "init") return
  if (!Array.isArray(frame.slash_commands)) return
  const names = new Set(
    frame.slash_commands.filter((name): name is string => typeof name === "string"),
  )
  const key = path.resolve(cwd)
  reportedByWorkspace.delete(key)
  reportedByWorkspace.set(key, names)
  if (reportedByWorkspace.size > MAX_WORKSPACES) {
    const oldest = reportedByWorkspace.keys().next().value
    if (oldest !== undefined) reportedByWorkspace.delete(oldest)
  }
}

export function _resetReportedCommandsForTests(): void {
  reportedByWorkspace.clear()
}

/** The `/name` a message opens with, or null. `/etc/hosts is broken` names none. */
export function leadingCommandName(text: string): string | null {
  const match = /^\/([^\s/]+)(?=\s|$)/.exec(text)
  return match ? match[1]! : null
}

export interface OwnCommandContext {
  /** The workspace the turn's `claude` runs in. */
  cwd: string
  /** The `CLAUDE_CONFIG_DIR` that `claude` reads its user commands from. */
  configDir: string | null
}

/** The operator's own command a message runs, or null when it keeps the mark. */
export function ownCommandIn(
  content: readonly unknown[],
  context: OwnCommandContext,
): string | null {
  if (content.length !== 1) return null
  const block = content[0] as { type?: unknown; text?: unknown } | null
  if (block?.type !== "text" || typeof block.text !== "string") return null
  const name = leadingCommandName(block.text)
  if (!name) return null
  if (definedOnDisk(name, context)) return name
  if (name.includes(":") && reportedByWorkspace.get(path.resolve(context.cwd))?.has(name)) {
    return name
  }
  return null
}

function definedOnDisk(name: string, context: OwnCommandContext): boolean {
  const segments = name.split(":")
  // Each segment is one path component and never a way out of the root.
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))) {
    return false
  }
  const last = segments[segments.length - 1]!
  for (const root of commandRoots(context)) {
    const files =
      segments.length === 1
        ? [
            path.join(root, "commands", `${name}.md`),
            path.join(root, "commands", name, "SKILL.md"),
            path.join(root, "skills", name, "SKILL.md"),
          ]
        : [path.join(root, "commands", ...segments.slice(0, -1), `${last}.md`)]
    if (files.some(userInvocableFile)) return true
  }
  return false
}

/**
 * The config dir, then every `.claude` from the workspace up to its git root,
 * which is the CLI's own walk: it stops at the first directory holding `.git`
 * and before the home dir, whose `.claude` is the user scope it reads under
 * whatever config dir this spawn uses (the skill bridge's rule,
 * `discoverNativeClaudeSkills`).
 */
function commandRoots(context: OwnCommandContext): string[] {
  const roots: string[] = []
  if (context.configDir) roots.push(path.resolve(context.configDir))
  const home = os.homedir()
  const homeDir = home ? path.resolve(home) : null
  let current = path.resolve(context.cwd)
  while (current !== homeDir) {
    roots.push(path.join(current, ".claude"))
    if (fs.existsSync(path.join(current, ".git"))) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return roots
}

/** A readable file whose frontmatter does not say `user-invocable: false`. */
function userInvocableFile(file: string): boolean {
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return false
  }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ""
  return !/^user-invocable:\s*false\s*$/m.test(frontmatter)
}
