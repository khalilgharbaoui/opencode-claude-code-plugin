import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

/**
 * Which `log.*()` messages in this package are plugin-authored constants.
 *
 * `/claude-code-doctor bundle` prints log lines verbatim, so it has to know
 * which message texts can carry runtime data. Measured over the maintainer's
 * real `plugin.log` (2026-10-01): of 4,526 retained lines, the message text of
 * a `MCP server "<name>" is needs-auth`, an account-limit warning and a
 * `describeResultFailure` line are all built at runtime, so "the message text
 * is plugin-authored" is NOT true in general and cannot be assumed.
 *
 * Rather than guess at runtime, the set is extracted from the source here and
 * frozen into `src/log-messages.ts` by `scripts/generate-log-messages.ts`. A
 * test re-runs this scan and compares, so a new warning whose text interpolates
 * a value is a failing test rather than a silent leak: until someone
 * regenerates, that message is redacted in the bundle and only its (separately
 * allowlisted) data keys survive.
 *
 * This module is a build and test tool. Nothing on a turn path may import it:
 * it reads `src/` off disk, which does not exist in a published install.
 */

export type LogLevel = "debug" | "info" | "notice" | "warn" | "error"

/** A `log.*()` call whose message is not a constant, with enough to find it. */
export interface DynamicLogMessage {
  file: string
  line: number
  level: LogLevel
  /** `template` (backticks with `${}`), `concat` (literal + expression), or `expression`. */
  kind: "template" | "concat" | "expression"
  /** The first 80 characters of whatever stands in for the message, for the diff. */
  detail: string
}

export interface LogMessageScan {
  /** Constant message literals, per level. */
  constants: Record<LogLevel, string[]>
  dynamic: DynamicLogMessage[]
}

const LEVELS: LogLevel[] = ["debug", "info", "notice", "warn", "error"]
const CALL = /\blog\.(debug|info|notice|warn|error)\(/g

/** Files that talk about log calls rather than making them. */
const SKIP_FILES = new Set(["log-message-scan.ts", "log-messages.ts"])

function isLevel(value: string): value is LogLevel {
  return (LEVELS as string[]).includes(value)
}

/** Read a single-, double- or back-quoted literal starting at `start`. */
function readLiteral(
  source: string,
  start: number,
): { text: string; end: number; interpolated: boolean } | null {
  const quote = source[start]
  if (quote !== '"' && quote !== "'" && quote !== "`") return null
  let index = start + 1
  let text = ""
  let interpolated = false
  while (index < source.length && source[index] !== quote) {
    if (source[index] === "\\") {
      // Only the escapes this codebase actually uses in log messages.
      const next = source[index + 1]
      text += next === "n" ? "\n" : next === "t" ? "\t" : (next ?? "")
      index += 2
      continue
    }
    if (quote === "`" && source[index] === "$" && source[index + 1] === "{") interpolated = true
    text += source[index]
    index++
  }
  return { text, end: index + 1, interpolated }
}

function skipSpace(source: string, index: number): number {
  let cursor = index
  while (cursor < source.length && /\s/.test(source[cursor]!)) cursor++
  return cursor
}

/**
 * Classify one call's first argument.
 *
 * A chain of adjacent string literals joined by `+` is still a constant: the
 * codebase wraps long warnings that way and they are the most useful lines in
 * a bundle. A chain that reaches any non-literal is `concat` and is dropped,
 * which is why `proxyOpencodeMcpTools is on but no MCP tool was found...`
 * (spawn-planning.ts, one arm of a ternary) does not survive into a bundle.
 */
function classify(
  source: string,
  argumentStart: number,
): { constant: string } | { dynamic: Omit<DynamicLogMessage, "file" | "line" | "level"> } {
  const first = readLiteral(source, argumentStart)
  if (!first) {
    let index = argumentStart
    let identifier = ""
    while (index < source.length && /[\w.$]/.test(source[index]!)) identifier += source[index++]
    return { dynamic: { kind: "expression", detail: identifier || "(expression)" } }
  }
  if (first.interpolated) {
    return { dynamic: { kind: "template", detail: first.text.slice(0, 80) } }
  }
  let text = first.text
  let cursor = skipSpace(source, first.end)
  while (source[cursor] === "+") {
    cursor = skipSpace(source, cursor + 1)
    const next = readLiteral(source, cursor)
    if (!next || next.interpolated) {
      return { dynamic: { kind: "concat", detail: text.slice(0, 80) } }
    }
    text += next.text
    cursor = skipSpace(source, next.end)
  }
  return { constant: text }
}

/** Scan every `.ts` file directly in `dir`. Sorted, so the output is stable. */
export function scanLogMessages(dir: string): LogMessageScan {
  const constants: Record<LogLevel, Set<string>> = {
    debug: new Set(),
    info: new Set(),
    notice: new Set(),
    warn: new Set(),
    error: new Set(),
  }
  const dynamic: DynamicLogMessage[] = []

  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".ts") || SKIP_FILES.has(file)) continue
    const source = readFileSync(join(dir, file), "utf8")
    CALL.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = CALL.exec(source))) {
      const level = match[1]!
      if (!isLevel(level)) continue
      const argumentStart = skipSpace(source, match.index + match[0].length)
      const line = source.slice(0, match.index).split("\n").length
      const verdict = classify(source, argumentStart)
      if ("constant" in verdict) constants[level].add(verdict.constant)
      else dynamic.push({ file, line, level, ...verdict.dynamic })
    }
  }

  return {
    constants: {
      debug: [...constants.debug].sort(),
      info: [...constants.info].sort(),
      notice: [...constants.notice].sort(),
      warn: [...constants.warn].sort(),
      error: [...constants.error].sort(),
    },
    dynamic: dynamic.sort((a, b) =>
      a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
    ),
  }
}

/**
 * The levels a bundle prints, and therefore the only levels whose message
 * literals are frozen. Keeping `info` and `debug` out of the generated set is
 * deliberate: those are the churning ones, and including them would fire the
 * drift test on changes that can never reach a bundle.
 */
export const BUNDLED_LEVELS: readonly LogLevel[] = ["notice", "warn", "error"]

/** The flat, deduplicated set the bundle checks a message against. */
export function bundledMessages(scan: LogMessageScan): string[] {
  const out = new Set<string>()
  for (const level of BUNDLED_LEVELS) for (const message of scan.constants[level]) out.add(message)
  return [...out].sort()
}
